/**
 * Discover OpenCode sessions started outside Agetor
 * (`docs/plans/add-opencode-harness.md` D-13, spike Q10/A8). The OpenCode
 * counterpart of `claude-session-scan.ts`, but OpenCode keeps its sessions in
 * its own database, so the list comes from the CLI rather than a disk walk:
 * for each ENABLED `opencode` harness and each registered project folder that
 * still exists, `opencode session list --format json` runs with the project
 * as its cwd (OpenCode scopes the list to the cwd's project) and the
 * harness's own bin and env. On OpenCode 2 the call passes `--standalone`:
 * without it the CLI starts the shared background service (A8d).
 *
 * Neither line's list carries a busy field (Q10). The busy signal is the
 * session export (`info.outcome === null` on v2, an unfinished last
 * assistant on v1), and a hard-killed session stays "unfinished" forever
 * (Q14). So the scan probes only sessions updated within the last
 * {@link OPENCODE_BUSY_WINDOW_MS}, and a session is refused only while both
 * hold (owner decision on G14a); an older unfinished one imports with a
 * status line instead. A probe that fails marks the row `busyUnknown`,
 * a warning rather than a block.
 *
 * Every spawn is bounded ({@link LIST_TIMEOUT_MS}), at most
 * {@link SCAN_CONCURRENCY} run at once, and a `(harness, dir)` answer is
 * reused for {@link SCAN_CACHE_TTL_MS}. Failures are never fatal: a list
 * that can't run contributes no rows.
 */
import { statSync } from "node:fs";
import type { Harness, OpencodeSessionListItem } from "../shared/types.ts";
import { OPENCODE_SESSION_ID_RE, opencodeMajor } from "../shared/opencode.ts";
import { harnesses, hiddenOpencodeSessionIds, projects } from "./db.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import { cachedCliVersion } from "./agent-status.ts";
import { exportIsComplete, exportSummary, runOpencodeExport } from "./opencode-export.ts";

/** A session updated within this window that OpenCode reports unfinished is
 *  refused as busy; an older one is importable (owner decision on G14a). */
export const OPENCODE_BUSY_WINDOW_MS = 10 * 60_000;
/** Per `session list` / busy-probe export call. */
export const LIST_TIMEOUT_MS = 5_000;
/** CLI calls in flight at once across the whole scan. */
export const SCAN_CONCURRENCY = 4;
/** How long one `(harness, dir)` answer is reused. */
export const SCAN_CACHE_TTL_MS = 10_000;

/** One listed session plus what the import path needs and the list DTO
 *  doesn't carry. */
export interface OpencodeSessionRecord extends OpencodeSessionListItem {
  /** The OpenCode line of the harness that listed it. */
  major: 1 | 2;
  /** Whether that harness's calls run with `--standalone` (v2 only). */
  standalone: boolean;
}

/** A raw `session list --format json` row (v1 and v2 share the keys; v2
 *  omits `title` when the session has none). */
interface ListedSession {
  id: string;
  title: string | null;
  updated: number;
  created: number;
  directory: string;
}

interface CachedList {
  at: number;
  /** Rows plus their busy verdict as of `at`. Owned-id hiding and the folder
   *  check are applied fresh on every read. */
  rows: Array<ListedSession & { busy: boolean; busyUnknown: boolean }>;
  major: 1 | 2;
  standalone: boolean;
  /** The list call failed (not installed, timed out, unparsable exit). Cached
   *  like an answer so a broken harness costs one bounded call per window. */
  failed: boolean;
}

const listCache = new Map<string, CachedList>();

/** Test seam: drop every cached `(harness, dir)` answer. */
export function clearOpencodeSessionScanCache(): void {
  listCache.clear();
}

function cacheKey(harnessId: string, dir: string): string {
  return `${harnessId}\0${dir}`;
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Parse `session list --format json`. Tolerates chatter around the array
 *  (a v1 banner on stdout) and skips rows missing an id or directory. */
export function parseOpencodeSessionList(text: string): ListedSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: ListedSession[] = [];
  for (const r of raw) {
    if (!isRec(r)) continue;
    const id = typeof r.id === "string" ? r.id : "";
    const directory = typeof r.directory === "string" ? r.directory : "";
    if (!OPENCODE_SESSION_ID_RE.test(id) || !directory) continue;
    const updated = typeof r.updated === "number" && Number.isFinite(r.updated) ? r.updated : 0;
    const created = typeof r.created === "number" && Number.isFinite(r.created) ? r.created : updated;
    const title = typeof r.title === "string" && r.title.trim() ? r.title : null;
    out.push({ id, title, updated, created, directory });
  }
  return out;
}

/** The list command line for each OpenCode line (A8d: `--standalone` on v2). */
export function opencodeSessionListArgv(bin: string, standalone: boolean): string[] {
  return [bin, "session", "list", ...(standalone ? ["--standalone"] : []), "--format", "json"];
}

/** Run one bounded CLI call; stdout on exit 0, else null. Races the read
 *  against the deadline so a grandchild holding the pipe can't outlive it. */
async function runBounded(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string | null> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  merged.OPENCODE_DISABLE_AUTOUPDATE ??= "1";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd, env: merged, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(null);
    }, timeoutMs);
  });
  const read = (async (): Promise<string | null> => {
    const [out] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    return (await proc.exited) === 0 ? out : null;
  })().catch(() => null);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `jobs` with at most `limit` in flight. */
async function inPool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

/** Whether a session updated at `updatedAt` is recent enough for its
 *  unfinished state to mean "OpenCode is still working on it". */
export function withinBusyWindow(updatedAt: number | null, now: number = Date.now()): boolean {
  return updatedAt != null && now - updatedAt < OPENCODE_BUSY_WINDOW_MS;
}

interface ScanTarget {
  harness: Harness;
  dir: string;
}

async function listTarget(
  t: ScanTarget,
  version: string | null,
  force: boolean,
): Promise<CachedList | null> {
  const key = cacheKey(t.harness.id, t.dir);
  const hit = listCache.get(key);
  if (!force && hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return hit.failed ? null : hit;
  const major = opencodeMajor(version);
  const standalone = major === 2;
  const bin = resolveBin(t.harness);
  const env = harnessEnv(t.harness);
  const out = await runBounded(opencodeSessionListArgv(bin, standalone), t.dir, env, LIST_TIMEOUT_MS);
  if (out === null) {
    listCache.set(key, { at: Date.now(), rows: [], major, standalone, failed: true });
    return null;
  }
  const rows = parseOpencodeSessionList(out).map((r) => ({ ...r, busy: false, busyUnknown: false }));
  // Busy probe (A8c): only for recent rows whose folder still exists — a
  // missing folder blocks on its own, and an old unfinished session imports.
  const now = Date.now();
  const probes = rows
    .filter((r) => withinBusyWindow(r.updated, now) && isDirectory(r.directory))
    .map((r) => async () => {
      const exp = await runOpencodeExport({
        sessionId: r.id,
        bin,
        env,
        cwd: r.directory,
        major,
        standalone,
        timeoutMs: LIST_TIMEOUT_MS,
      });
      if (!exp) {
        r.busyUnknown = true;
        return;
      }
      // The export's own `updated` is fresher than the list's.
      const updated = exportSummary(exp).updatedAt ?? r.updated;
      r.busy = !exportIsComplete(exp) && withinBusyWindow(updated, Date.now());
    });
  await inPool(probes, SCAN_CONCURRENCY);
  const entry: CachedList = { at: Date.now(), rows, major, standalone, failed: false };
  listCache.set(key, entry);
  return entry;
}

/**
 * Every OpenCode session the enabled OpenCode harnesses report for the
 * registered projects, minus the ids Agetor owns (a run's
 * `opencode_session_id` or an import claim), newest first, with the
 * import-only fields. `force` bypasses the 10 s cache.
 */
export async function scanOpencodeSessionRecords(opts?: { force?: boolean }): Promise<OpencodeSessionRecord[]> {
  const enabled = harnesses.list().filter((h) => h.kind === "opencode" && h.enabled);
  if (enabled.length === 0) return [];
  const dirs = [...new Set(projects.list().map((p) => p.path))].filter(isDirectory);
  if (dirs.length === 0) return [];
  const versions = new Map<string, string | null>();
  await Promise.all(enabled.map(async (h) => {
    try {
      versions.set(h.id, await cachedCliVersion(h));
    } catch {
      versions.set(h.id, null);
    }
  }));
  const targets: ScanTarget[] = enabled.flatMap((harness) => dirs.map((dir) => ({ harness, dir })));
  const lists = await inPool(
    targets.map((t) => () => listTarget(t, versions.get(t.harness.id) ?? null, opts?.force === true).catch(() => null)),
    SCAN_CONCURRENCY,
  );
  const owned = hiddenOpencodeSessionIds();
  const seen = new Set<string>();
  const out: OpencodeSessionRecord[] = [];
  lists.forEach((list, i) => {
    if (!list) return;
    const harness = targets[i]!.harness;
    for (const r of list.rows) {
      if (owned.has(r.id)) continue;
      // Two projects inside one repo share OpenCode's project id and list the
      // same sessions; keep one row per (harness, session).
      const key = `${harness.id}\0${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blockedReason: OpencodeSessionListItem["blockedReason"] = !isDirectory(r.directory)
        ? "missing-folder"
        : r.busy
          ? "busy"
          : null;
      out.push({
        sessionId: r.id,
        harnessId: harness.id,
        harnessLabel: harness.label,
        directory: r.directory,
        title: r.title,
        updatedAt: r.updated,
        createdAt: r.created,
        importable: blockedReason === null,
        blockedReason,
        ...(blockedReason === null && r.busyUnknown ? { busyUnknown: true } : {}),
        // Imported sessions are owned and hidden above, like Claude's list.
        importedTaskId: null,
        major: list.major,
        standalone: list.standalone,
      });
    }
  });
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  return out;
}

/** The `GET /opencode-sessions` rows (D-13). `force` bypasses the 10 s cache. */
export async function scanOpencodeSessions(opts?: { force?: boolean }): Promise<OpencodeSessionListItem[]> {
  const records = await scanOpencodeSessionRecords(opts);
  return records.map(({ major: _major, standalone: _standalone, ...item }) => item);
}
