import { closeSync, readdirSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import type { AccountUsageSummary, TokenTotals } from "../shared/types.ts";
import { db } from "./db.ts";
import { openReadNoFollow } from "./no-follow.ts";

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
 * Per-pass byte budget. Bun.serve is single-threaded and this scan is
 * synchronous, so an unbounded first pass over a large history (100MB+ of
 * JSONL is normal) would stall every concurrent request for seconds. The
 * budget caps one pass; cursors carry the progress, so the 15s `/harnesses`
 * poll converges on the full history within a few polls and every later
 * pass is just appended bytes. Not a silent cap: `budgetExhausted` reports it.
 */
const SCAN_BUDGET_BYTES = 16 * 1024 * 1024;

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

function listJsonlFiles(root: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) listJsonlFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Read bytes [offset, size) of a file. Returns null when unreadable. */
function readSlice(p: string, offset: number, size: number): Buffer | null {
  if (size <= offset) return Buffer.alloc(0);
  let fd: number;
  try { fd = openReadNoFollow(p); } catch { return null; }
  try {
    const buf = Buffer.alloc(size - offset);
    const n = readSync(fd, buf, 0, buf.length, offset);
    return n === buf.length ? buf : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Scan one file's new bytes, up to `budget`. Returns bytes consumed. */
function scanFile(configDir: string, filePath: string, result: ScanResult, budget: number): number {
  let st;
  try { st = statSync(filePath); } catch { return 0; }
  const cursor = s().getCursor.get(filePath) as { mtime_ms: number; size: number; offset: number } | null;
  // Skip only when the file is unchanged AND fully consumed — a budget-
  // truncated pass leaves offset < size with matching stat, and must resume.
  if (cursor && cursor.mtime_ms === st.mtimeMs && cursor.size === st.size && cursor.offset >= st.size) return 0;
  // A shrunken file was rewritten/truncated out from under us — restart.
  // Re-reading is safe: usage_seen makes recounting a no-op.
  let offset = cursor && st.size >= cursor.offset ? cursor.offset : 0;
  const end = Math.min(st.size, offset + budget);
  const buf = readSlice(filePath, offset, end);
  if (buf === null) return 0;

  // Only complete lines are processed; the offset never advances past the
  // last newline, so a partially-flushed (or budget-cut) line is re-read on
  // the next scan.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    const complete = buf.subarray(0, lastNewline + 1);
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
      offset += lastNewline + 1;
      s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
    });
    apply();
  } else {
    // No complete line in the new bytes — just refresh the stat cursor so an
    // unchanged file is skipped next time (offset untouched).
    s().putCursor.run(filePath, configDir, st.mtimeMs, st.size, offset);
  }
  result.filesScanned++;
  return buf.length;
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
export function scanAccountUsage(configDir: string, budgetBytes = SCAN_BUDGET_BYTES): ScanResult {
  const result: ScanResult = { filesScanned: 0, eventsCounted: 0, parseErrors: 0, budgetExhausted: false };
  let remaining = budgetBytes;
  for (const f of listJsonlFiles(path.join(configDir, "projects"))) {
    if (remaining <= 0) {
      result.budgetExhausted = true;
      break;
    }
    remaining -= scanFile(configDir, f, result, remaining);
  }
  if (remaining <= 0) result.budgetExhausted = true;
  return result;
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
export function accountUsageSummary(configDir: string): AccountUsageSummary {
  const last = lastScanAt.get(configDir) ?? 0;
  if (Date.now() - last >= MIN_SCAN_INTERVAL_MS) {
    lastScanAt.set(configDir, Date.now());
    scanAccountUsage(configDir);
  }
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
export function accountUsageDays(configDir: string, days = 30): UsageDayRow[] {
  const last = lastScanAt.get(configDir) ?? 0;
  if (Date.now() - last >= MIN_SCAN_INTERVAL_MS) {
    lastScanAt.set(configDir, Date.now());
    scanAccountUsage(configDir);
  }
  return s().daysSince.all(configDir, utcDay(days - 1)) as UsageDayRow[];
}
