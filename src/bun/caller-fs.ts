// Caller-aware filesystem checks (docs/plans/master-token-agent-read.md, D24/P10).
//
// The problem. A CLI-token caller can name any path ("workdir", "path", "dir",
// "dest"), and the handlers behind those routes stat, list or read it from the
// core process. The core process is Agetor.app, so macOS answers for it with
// Agetor's own TCC grants (Documents, Desktop, Full Disk Access, "files from
// other apps"…). A CLI-token caller is, by design, no more trusted than a
// program an agent can run — it must not be able to borrow those grants just by
// naming a path.
//
// The fix. For a CLI caller every filesystem question about a caller-named path
// is answered by a DISCLAIMED CHILD OF APPLE SYSTEM TOOLS (`/bin/sh`,
// `/usr/bin/stat`, `/usr/bin/tar`), never by the core. A disclaimed child is
// its own TCC-responsible process, so it has exactly the access any
// self-responsible process of this user has — which is what an agent can already
// get by running the disclaim helper itself. Nothing is gained over what the
// agent has; nothing of Agetor's is lent. The app (master token) keeps today's
// in-process behavior, because the desktop UI is the user acting directly.
//
// All children go through `coreSpawn` (core-spawn.ts), so they are disclaimed
// whenever the one disclaim switch is on, and run undisclaimed — same as the
// in-process path — when it is off or the helper is unavailable (D7).
//
// Answers never echo a path back: the probe script prints one fixed token per
// line and the caller matches tokens to its own list by position, so a hostile
// file name cannot inject output. Paths reach the child only as argv, never
// interpolated into script text.

import { statSync } from "node:fs";
import path from "node:path";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { diskProjectTree, refProjectTree, type ProjectTree } from "./ref-tree.ts";
import type { ApiCaller } from "./route-policy.ts";
import { parseTar } from "./tar-read.ts";

export type ProbeKind = "dir" | "file" | "other" | "missing" | "denied";

const PROBE_KINDS: ReadonlySet<string> = new Set<ProbeKind>(["dir", "file", "other", "missing", "denied"]);

/** Paths per probe child. argv has a size limit (ARG_MAX ~1 MB); 256 paths of
 *  up to PATH_MAX stay far below it, and chunks run in parallel. */
const PROBE_CHUNK = 256;
const PROBE_TIMEOUT_MS = 10_000;

/** Max bytes of `tar` output read for a project tree (D24, plan §7 risk 2). */
export const PROJECT_TREE_TAR_MAX_BYTES = 8 * 1024 * 1024;
const TREE_TIMEOUT_MS = 15_000;

/** Absolute tool paths only — a CLI caller must not be able to influence which
 *  `stat`/`tar` runs through PATH. */
const SH = "/bin/sh";
const STAT = "/usr/bin/stat";
const TAR = "/usr/bin/tar";

/**
 * Probe script (argv: sh -c SCRIPT sh path1 path2 …). One token per path, in
 * order. `stat -L` follows symlinks, matching `statSync`. Classification comes
 * from stat's exit status and the TAIL of its message (`stat: <path>: …:
 * <strerror>`): the path is attacker-chosen text in the middle of the message,
 * but the strerror suffix is not, so suffix matching cannot be spoofed by a file
 * name. Unknown failures fail CLOSED (`denied`).
 *
 * `stat` alone is not enough, measured on macOS 26.6.2: stat(2) on
 * ~/Library/Mail, ~/Library/Messages/chat.db or ~/Library/Safari succeeds even
 * for a disclaimed process without Full Disk Access, while opening or listing
 * them fails with EPERM ("Operation not permitted"). access(R_OK) — the shell's
 * `[ -r ]`, run by this same disclaimed `sh` — fails for those paths too, so
 * an existing dir/file the child cannot read is `denied`. That read-access
 * answer is the one the gate needs: it is what the handler's own in-process
 * read would be allowed to do only because the core is Agetor.app.
 */
const PROBE_SCRIPT = `
for p in "$@"; do
  out=$(${STAT} -L -f %HT -- "$p" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    case "$out" in
      "Directory") if [ -r "$p" ]; then echo dir; else echo denied; fi ;;
      "Regular File") if [ -r "$p" ]; then echo file; else echo denied; fi ;;
      # BSD stat -L falls back to lstat on a dangling link and reports the link
      # itself; statSync would say ENOENT, so a link that survives -L is missing.
      "Symbolic Link") echo missing ;;
      *) echo other ;;
    esac
  else
    case "$out" in
      *": No such file or directory"|*": Not a directory"|*": File name too long"|*": Too many levels of symbolic links") echo missing ;;
      *) echo denied ;;
    esac
  fi
done
`;

function classifyInProcess(p: string): ProbeKind {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG" || code === "ELOOP") return "missing";
    return "denied";
  }
}

async function readAll(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream).text();
}

/** Run one probe child over at most PROBE_CHUNK paths. Unanswered entries
 *  (timeout, spawn failure, short output) are `denied`: fail closed. */
async function probeChunk(paths: readonly string[], timeoutMs: number): Promise<ProbeKind[]> {
  const result: ProbeKind[] = paths.map(() => "denied");
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn([SH, "-c", PROBE_SCRIPT, "sh", ...paths], {
      env: { ...childEnv(), LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return result;
  }
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  const timer = setTimeout(kill, timeoutMs);
  // Backstop: if the pipe somehow stays open after the kill, don't wait for it.
  let backstop: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      readAll(proc.stdout as ReadableStream<Uint8Array>),
      new Promise<string>((resolve) => {
        backstop = setTimeout(() => resolve(""), timeoutMs + 1000);
      }),
    ]);
    const lines = text.split("\n");
    for (let i = 0; i < paths.length; i++) {
      const tok = lines[i];
      // Only complete lines count: a token cut by the kill is not an answer.
      if (tok !== undefined && i < lines.length - 1 && PROBE_KINDS.has(tok)) result[i] = tok as ProbeKind;
    }
  } catch {
    // leave whatever was not answered as `denied`
  } finally {
    clearTimeout(timer);
    if (backstop) clearTimeout(backstop);
    kill();
  }
  return result;
}

/**
 * Classify each path as dir/file/other/missing/denied, in order.
 *
 *  - `app` caller: in-process `statSync` (follows symlinks), the user acting
 *    directly through the desktop UI.
 *  - `cli` caller: a disclaimed `/usr/bin/stat` child; see the file header.
 *
 * `missing` covers ENOENT/ENOTDIR (and name-too-long/symlink-loop); `denied`
 * covers EPERM/EACCES, a timeout (a pending TCC prompt blocks the child), and
 * anything the classifier does not recognize.
 */
export async function probePaths(
  paths: readonly string[],
  caller: ApiCaller,
  opts?: { timeoutMs?: number },
): Promise<ProbeKind[]> {
  if (caller === "app") return paths.map(classifyInProcess);

  const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const out: ProbeKind[] = paths.map(() => "denied");
  const jobs: Array<Promise<void>> = [];
  for (let start = 0; start < paths.length; start += PROBE_CHUNK) {
    const slice = paths.slice(start, start + PROBE_CHUNK);
    // A NUL byte cannot travel in argv (and no real file name has one); such a
    // path can't exist, so answer `missing` without spawning for it.
    const idx: number[] = [];
    const real: string[] = [];
    slice.forEach((p, i) => {
      if (p.includes("\0")) out[start + i] = "missing";
      else {
        idx.push(start + i);
        real.push(p);
      }
    });
    if (real.length === 0) continue;
    jobs.push(
      probeChunk(real, timeoutMs).then((kinds) => {
        kinds.forEach((k, i) => {
          out[idx[i]!] = k;
        });
      }),
    );
  }
  await Promise.all(jobs);
  return out;
}

export const PATH_NOT_ACCESSIBLE_MESSAGE =
  "This path isn't accessible to Agetor's CLI token (macOS protects it for other apps, or a permission prompt is waiting — answer it and try again).";

/** Parent of `p` by string operation only (no `..` collapsing, which would
 *  disagree with the kernel when a symlink is involved). null at the root. */
function parentOf(p: string): string | null {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (trimmed === "/" || trimmed === "" || trimmed === ".") return null;
  const cut = trimmed.lastIndexOf("/");
  if (cut === -1) return ".";
  if (cut === 0) return "/";
  return trimmed.slice(0, cut);
}

export type PathGateRefusal = { status: 403; error: string; code: "path-not-accessible" };

/**
 * Gate one caller-named path for a route (P10).
 *
 *  - `exists`: probe the path itself.
 *  - `nearest-ancestor`: probe the path; when it does not exist yet (a clone
 *    destination), probe the nearest existing ancestor instead — creating the
 *    path would touch that ancestor.
 *
 * Refuses ONLY on `denied`. A missing path passes so the handler keeps its own
 * not-found answer (and the response can't be used to tell "missing" from
 * "protected" beyond what the refusal already says). The app caller is never
 * gated and nothing is spawned for it.
 */
export async function gateCallerPath(
  p: string,
  caller: ApiCaller,
  mode: "exists" | "nearest-ancestor",
): Promise<null | PathGateRefusal> {
  if (caller === "app") return null;

  const candidates = [p];
  if (mode === "nearest-ancestor") {
    // Bounded: a path has a few dozen components at most; the cap just keeps a
    // pathological string from producing a huge argv.
    let cur: string | null = parentOf(p);
    while (cur !== null && candidates.length < PROBE_CHUNK) {
      candidates.push(cur);
      cur = parentOf(cur);
    }
  }
  const kinds = await probePaths(candidates, "cli");
  // The first candidate that is not `missing` decides (for `exists` that is
  // always candidate 0, and a missing one simply passes).
  for (const kind of kinds) {
    if (kind === "missing") {
      if (mode === "exists") return null;
      continue;
    }
    if (kind === "denied") return { status: 403, error: PATH_NOT_ACCESSIBLE_MESSAGE, code: "path-not-accessible" };
    return null;
  }
  return null;
}

/** Read a child's stdout up to `maxBytes`, then stop. `truncated` is true when
 *  the cap cut the stream. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!stream || typeof stream === "number") return { bytes: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { bytes, truncated };
}

/**
 * A `ProjectTree` over `root` for capability discovery.
 *
 *  - `app` caller: the live disk (`diskProjectTree`), read lazily in-process.
 *  - `cli` caller: one disclaimed `/usr/bin/tar` child archives the existing
 *    `relRoots` (symlinks followed, `.git` and `node_modules` excluded), at
 *    most 8 MB of its output is read (then the child is killed and whatever
 *    parsed is used), and the archive becomes an in-memory tree. Every regular
 *    file appears in `list()`; only files passing `shouldRead` keep content
 *    (the rest read as null, like `loadRefProjectTree` does for a git ref).
 *    Empty directories do not appear (an archive of files has no use for them).
 *
 * `relRoots` is `PROJECT_CAPABILITY_PATHSPECS` in production. Roots that don't
 * exist (or are denied) are dropped before the call because tar errors on a
 * missing operand and would otherwise lose the whole archive.
 */
export async function callerProjectTree(
  root: string,
  caller: ApiCaller,
  relRoots: readonly string[],
  shouldRead: (rel: string) => boolean,
): Promise<ProjectTree> {
  if (caller === "app") return diskProjectTree(root);

  const kinds = await probePaths(
    relRoots.map((r) => path.join(root, r)),
    "cli",
  );
  const existing = relRoots.filter((_, i) => kinds[i] === "dir" || kinds[i] === "file" || kinds[i] === "other");
  const files = new Map<string, string | null>();
  if (existing.length === 0) return refProjectTree(files);

  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(
      [TAR, "-c", "-f", "-", "--format=pax", "-L", "--exclude", ".git", "--exclude", "node_modules", "-C", root, "--", ...existing],
      {
        // COPYFILE_DISABLE: without it bsdtar adds an AppleDouble `._name`
        // sibling for every file that carries an xattr (macOS stamps
        // `com.apple.provenance` on most downloaded/created files).
        env: { ...childEnv(), LC_ALL: "C", COPYFILE_DISABLE: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  } catch {
    return refProjectTree(files);
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, TREE_TIMEOUT_MS);
  let bytes: Uint8Array = new Uint8Array(0);
  let truncated = false;
  try {
    ({ bytes, truncated } = await readCapped(proc.stdout as ReadableStream<Uint8Array>, PROJECT_TREE_TAR_MAX_BYTES));
    if (truncated) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    await proc.exited;
  } catch {
    // use whatever was read
  } finally {
    clearTimeout(timer);
  }

  for (const entry of parseTar(bytes)) {
    const rel = entry.path;
    // `Buffer.toString("utf8")` keeps a leading BOM, like `readFileSync(…, "utf8")`.
    files.set(rel, shouldRead(rel) ? Buffer.from(entry.data).toString("utf8") : null);
  }
  return refProjectTree(files);
}
