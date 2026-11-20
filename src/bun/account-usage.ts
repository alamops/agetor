import { close as closeFd, read as readFd } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import * as path from "node:path";
import type { AccountUsageSummary, TokenTotals } from "../shared/types.ts";
import { db } from "./db.ts";
import { isPlainDirBelow, openReadNoFollow } from "./no-follow.ts";

const readFdAsync = promisify(readFd);
const closeFdAsync = promisify(closeFd);

/**
 * Local, deterministic per-account token-usage rollups (SDD: "plane A").
 *
 * Source of truth is each Claude account's own transcript tree — every
 * `.jsonl` file under `<configDir>/projects/`. Every assistant line carries
 * `message.usage` (verified shape: input/output plus the two cache token
 * classes), `message.model`, `message.id`, `requestId`, `timestamp`. The
 * tree is account-global, so the numbers include the user's direct CLI
 * sessions outside agetor. That is intended: the budget displayed is the
 * account's, not agetor's.
 *
 * Incremental by construction: a per-file byte cursor (`usage_files`) means
 * a scan is a stat per file plus a read of only the appended bytes.
 * Correctness does NOT rest on the cursor — claude rewrites an assistant
 * line as it streams and reattach re-reads files from offset 0, so the same
 * response appears many times; `usage_seen` (`message.id:requestId`) makes
 * every re-read idempotent. Rollups in `usage_daily` therefore survive both
 * re-scans and claude's own transcript retention deleting old files.
 *
 * No LLM, no network. Cost estimation is deliberately absent: token counts
 * are the honest unit for subscription accounts.
 */

const MIN_SCAN_INTERVAL_MS = 15_000;
const lastScanAt = new Map<string, number>();

/**
 * Per-pass byte budget. Bun.serve is single-threaded, so an unbounded first
 * pass over a large history (100MB+ of JSONL is normal) would hold every
 * concurrent request for seconds. The budget caps one pass; cursors carry the
 * progress, so the 15s `/harnesses` poll converges on the full history within
 * a few polls and every later pass is just appended bytes. Not a silent cap:
 * `budgetExhausted` reports it.
 */
const SCAN_BUDGET_BYTES = 16 * 1024 * 1024;

/** One file read never allocates more than this; a bigger span is read as
 *  several consecutive slices, each applied (and its cursor persisted) before
 *  the next is read, with the event loop free in between. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** A single transcript line this long (or as long as the pass budget, when
 *  that is smaller) is not buffered further: the line is dropped (counted as
 *  a parse error once) and scanning resumes after its newline. The cap must
 *  not exceed the per-pass budget, or a pass could never accumulate enough to
 *  trigger it. Real assistant lines are far below it. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Files whose cursor currently sits inside an oversized line being skipped:
 *  filePath -> the cursor offset the skip resumes at. Lets a later pass keep
 *  discarding up to the line's newline instead of re-reading it or counting
 *  its tail as another parse error. In-memory: after a restart the tail of
 *  such a line costs at most one extra parse error. */
const skipResume = new Map<string, number>();

export interface ScanResult {
  filesScanned: number;
  /** Usage events counted for the first time (post-dedupe). */
  eventsCounted: number;
  /** Lines that failed to parse as JSON — skipped, never thrown. */
  parseErrors: number;
  /** True when the pass stopped early on the byte budget — the next scan
   *  continues from the persisted cursors. */
  budgetExhausted: boolean;
}

// Lazy statements — db.ts has already migrated by the time this module is
// imported (both live behind the same module graph), but preparing lazily
// keeps import order irrelevant.
let stmts: {
  getCursor: ReturnType<typeof db.prepare>;
  putCursor: ReturnType<typeof db.prepare>;
  markSeen: ReturnType<typeof db.prepare>;
  addDaily: ReturnType<typeof db.prepare>;
  sumSince: ReturnType<typeof db.prepare>;
  daysSince: ReturnType<typeof db.prepare>;
} | null = null;

function s() {
  if (stmts) return stmts;
  stmts = {
    getCursor: db.prepare("SELECT mtime_ms, size, offset FROM usage_files WHERE path = ?"),
    putCursor: db.prepare(
      `INSERT INTO usage_files (path, config_dir, mtime_ms, size, offset) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET config_dir = excluded.config_dir,
         mtime_ms = excluded.mtime_ms, size = excluded.size, offset = excluded.offset`,
    ),
    markSeen: db.prepare("INSERT OR IGNORE INTO usage_seen (config_dir, key) VALUES (?, ?)"),
    addDaily: db.prepare(
      `INSERT INTO usage_daily (config_dir, day, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(config_dir, day, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         message_count = message_count + 1`,
    ),
    sumSince: db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite, COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
              COALESCE(SUM(message_count), 0) AS messages
       FROM usage_daily WHERE config_dir = ? AND day >= ?`,
    ),
    daysSince: db.prepare(
      `SELECT day, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
              message_count AS messageCount
       FROM usage_daily WHERE config_dir = ? AND day >= ?
       ORDER BY day DESC, model ASC`,
    ),
  };
  return stmts;
}

/** One parsed usage event, exported shape for the pure parser below. */
export interface UsageEvent {
  key: string;
  day: string; // UTC YYYY-MM-DD
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract a usage event from one JSONL line, or null for non-usage lines
 * (user/system/tool lines, summaries…). Pure; the unit under test.
 * Requires `message.id` — a usage block with no id can't be deduped, and
 * every real assistant API response carries one.
 */
export function parseUsageLine(line: string): UsageEvent | { error: true } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let d: any;
  try { d = JSON.parse(trimmed); } catch { return { error: true }; }
  const msg = d?.message;
  const usage = msg?.usage;
  if (!usage || typeof usage !== "object" || typeof msg.id !== "string" || !msg.id) return null;
  const ts = typeof d.timestamp === "string" ? d.timestamp : "";
  // A malformed/absent timestamp can't be bucketed into a day — skip rather
  // than invent one (Date.now-style stamping would make re-scans non-idempotent).
  if (!/^\d{4}-\d{2}-\d{2}/.test(ts)) return null;
  return {
    key: `${msg.id}:${typeof d.requestId === "string" ? d.requestId : ""}`,
    day: ts.slice(0, 10),
    model: typeof msg.model === "string" && msg.model ? msg.model : "unknown",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

async function listJsonlFiles(root: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) await listJsonlFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Read bytes [offset, end) of a file, at most MAX_READ_BYTES of them (the
 *  caller continues from where the returned buffer ends). Returns null when
 *  unreadable. A short buffer means the file ended early (truncated). */
async function readSlice(p: string, offset: number, end: number): Promise<Buffer | null> {
  const want = Math.min(end - offset, MAX_READ_BYTES);
  if (want <= 0) return Buffer.alloc(0);
  let fd: number;
  try { fd = openReadNoFollow(p); } catch { return null; }
  try {
    const buf = Buffer.alloc(want);
    let got = 0;
    // A read may return fewer bytes than asked; loop until the slice is full
    // or the file ends. Bounded: each pass either advances or breaks.
    while (got < want) {
      const { bytesRead } = await readFdAsync(fd, buf, got, want - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === want ? buf : buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    await closeFdAsync(fd).catch(() => {});
  }
}

/** Scan one file's new bytes, up to `budget`. Returns bytes consumed. */
async function scanFile(
  configDir: string,
  filePath: string,
  result: ScanResult,
  budget: number,
  maxLine: number,
): Promise<number> {
  let st;
  try { st = await stat(filePath); } catch { return 0; }
  const cursor = s().getCursor.get(filePath) as { mtime_ms: number; size: number; offset: number } | null;
  // Skip only when the file is unchanged AND fully consumed — a budget-
  // truncated pass leaves offset < size with matching stat, and must resume.
  if (cursor && cursor.mtime_ms === st.mtimeMs && cursor.size === st.size && cursor.offset >= st.size) return 0;
  // A shrunken file was rewritten/truncated out from under us — restart.
  // Re-reading is safe: usage_seen makes recounting a no-op.
  let offset = cursor && st.size >= cursor.offset ? cursor.offset : 0;
  const limit = Math.min(st.size, offset + budget);
  let skipping = skipResume.get(filePath) === offset;
  if (!skipping) skipResume.delete(filePath);

  // Slices of at most MAX_READ_BYTES are read one after another. Only
  // complete lines are processed and the cursor offset never advances past the
  // last newline, so a partially-flushed (or budget-cut) line is re-read on
  // the next scan; the tail of a slice that ends mid-line is carried into the
  // next slice instead.
  let readPos = offset;
  let consumed = 0;
  let carry: Buffer = Buffer.alloc(0);
  while (readPos < limit) {
    const slice = await readSlice(filePath, readPos, limit);
    if (slice === null) {
      if (consumed === 0) return 0;
      break;
    }
    if (slice.length === 0) break; // file shrank under us; next scan restarts
    readPos += slice.length;
    consumed += slice.length;
    let chunk: Buffer = slice;
    if (skipping) {
      // Inside an oversized line: drop bytes up to and including its newline.
      const nl = chunk.indexOf(0x0a);
      if (nl < 0) {
        offset += chunk.length;
        s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
        skipResume.set(filePath, offset);
        continue;
      }
      offset += nl + 1;
      skipping = false;
      skipResume.delete(filePath);
      chunk = chunk.subarray(nl + 1);
      s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
      if (chunk.length === 0) continue;
    }
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      const complete = buf.subarray(0, lastNewline + 1);
      const advance = lastNewline + 1;
      const apply = db.transaction(() => {
        for (const lineBuf of splitLines(complete)) {
          const parsed = parseUsageLine(lineBuf.toString("utf8"));
          if (!parsed) continue;
          if ("error" in parsed) { result.parseErrors++; continue; }
          const inserted = s().markSeen.run(configDir, parsed.key);
          if (inserted.changes === 0) continue; // already counted
          s().addDaily.run(
            configDir, parsed.day, parsed.model,
            parsed.inputTokens, parsed.outputTokens, parsed.cacheWriteTokens, parsed.cacheReadTokens,
          );
          result.eventsCounted++;
        }
        offset += advance;
        s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
      });
      apply();
      // Copy the tail so the (up to 8 MB) slice buffer can be freed.
      carry = Buffer.from(buf.subarray(lastNewline + 1));
    } else {
      carry = buf;
    }
    if (carry.length >= maxLine) {
      // One line larger than any real transcript line: drop it rather than
      // buffer without bound or re-read it every pass. Persist the skip so
      // the next pass resumes after the line's newline.
      offset += carry.length;
      carry = Buffer.alloc(0);
      result.parseErrors++;
      skipping = true;
      skipResume.set(filePath, offset);
      s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
    }
  }
  // Always save the cursor, even when nothing new was consumed, so an
  // unchanged file is skipped next time and later files are reached.
  s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
  result.filesScanned++;
  return consumed;
}

function* splitLines(buf: Buffer): Generator<Buffer> {
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    yield buf.subarray(start, end);
    if (nl === -1) return;
    start = nl + 1;
  }
}

/** Incrementally fold new transcript bytes for one account into the rollups. */
export async function scanAccountUsage(configDir: string, budgetBytes = SCAN_BUDGET_BYTES): Promise<ScanResult> {
  const result: ScanResult = { filesScanned: 0, eventsCounted: 0, parseErrors: 0, budgetExhausted: false };
  let remaining = budgetBytes;
  const projects = path.join(configDir, "projects");
  // `projects/` is agent-writable: never list it once it has been swapped for
  // a symlink into a protected folder (no-follow.ts). Dirents below it carry
  // their own type, so nested symlinks are never followed either.
  if (!isPlainDirBelow(configDir, projects)) return result;
  for (const f of await listJsonlFiles(projects)) {
    if (remaining <= 0) {
      result.budgetExhausted = true;
      break;
    }
    remaining -= await scanFile(configDir, f, result, remaining, Math.min(MAX_LINE_BYTES, budgetBytes));
  }
  if (remaining <= 0) result.budgetExhausted = true;
  return result;
}

/** In-flight throttled scans by account, so two callers (the `/harnesses`
 *  poll and the drill-down) share one pass instead of interleaving two. */
const scansInFlight = new Map<string, Promise<unknown>>();

/** Run a scan when the account's last one is older than MIN_SCAN_INTERVAL_MS;
 *  otherwise wait for the one already running, if any. A failing scan never
 *  rejects the caller: the rollups it already folded in are still served. */
async function scanThrottled(configDir: string): Promise<void> {
  const running = scansInFlight.get(configDir);
  if (running) {
    await running;
    return;
  }
  const last = lastScanAt.get(configDir) ?? 0;
  if (Date.now() - last < MIN_SCAN_INTERVAL_MS) return;
  lastScanAt.set(configDir, Date.now());
  const pass = scanAccountUsage(configDir).catch((err) => {
    console.error("[agetor] account usage scan failed:", err);
  });
  scansInFlight.set(configDir, pass);
  try {
    await pass;
  } finally {
    scansInFlight.delete(configDir);
  }
}

function utcDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function totalsSince(configDir: string, day: string): TokenTotals {
  const row = s().sumSince.get(configDir, day) as {
    input: number; output: number; cacheWrite: number; cacheRead: number; messages: number;
  };
  return {
    inputTokens: row.input,
    outputTokens: row.output,
    cacheWriteTokens: row.cacheWrite,
    cacheReadTokens: row.cacheRead,
    messageCount: row.messages,
  };
}

/**
 * Scan (throttled — `/harnesses` is polled, and each unthrottled scan is a
 * stat per transcript file) and summarize an account for `HarnessStatus`.
 * Purely local/historical — live limit-utilization percentages are a
 * separate concern, covered by `src/bun/usage/*`'s per-harness-kind quota
 * pollers (claude-code/codex/cursor), not this module.
 */
export async function accountUsageSummary(configDir: string): Promise<AccountUsageSummary> {
  await scanThrottled(configDir);
  return {
    configDir,
    today: totalsSince(configDir, utcDay(0)),
    last7d: totalsSince(configDir, utcDay(6)),
  };
}

export interface UsageDayRow {
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
}

/** Daily per-model rows for the Settings drill-down (default: last 30 days). */
export async function accountUsageDays(configDir: string, days = 30): Promise<UsageDayRow[]> {
  await scanThrottled(configDir);
  return s().daysSince.all(configDir, utcDay(days - 1)) as UsageDayRow[];
}
