import { beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR BEFORE importing account-usage.ts (it imports db.ts,
// which opens + migrates on module load).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-usage-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let mod: typeof import("./account-usage.ts");
beforeAll(async () => {
  mod = await import("./account-usage.ts");
});

const TODAY = new Date().toISOString();
const NINE_DAYS_AGO = new Date(Date.now() - 9 * 86_400_000).toISOString();

/** A real-shape assistant JSONL line (verified against live transcripts:
 *  nested `cache_creation` object present alongside the flat token fields). */
function assistantLine(opts: {
  id: string; requestId?: string; ts?: string; model?: string;
  input?: number; output?: number; cacheWrite?: number; cacheRead?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts ?? TODAY,
    requestId: opts.requestId ?? "req_1",
    message: {
      id: opts.id,
      role: "assistant",
      model: opts.model ?? "claude-opus-5",
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 20,
        cache_creation_input_tokens: opts.cacheWrite ?? 5,
        cache_read_input_tokens: opts.cacheRead ?? 100,
        cache_creation: { ephemeral_5m_input_tokens: opts.cacheWrite ?? 5 },
        service_tier: "standard",
      },
    },
  }) + "\n";
}

function makeAccount(): { configDir: string; file: string } {
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-usage-acct-"));
  const proj = path.join(configDir, "projects", "-home-u-repo");
  mkdirSync(proj, { recursive: true });
  return { configDir, file: path.join(proj, "session-1.jsonl") };
}

// --- parseUsageLine (pure) -----------------------------------------------------

test("parseUsageLine extracts tokens, model, day, and the dedupe key", () => {
  const parsed = mod.parseUsageLine(assistantLine({ id: "msg_a", requestId: "req_9", ts: "2026-08-14T10:00:00.000Z" }));
  expect(parsed).toEqual({
    key: "msg_a:req_9",
    day: "2026-08-14",
    model: "claude-opus-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 5,
    cacheReadTokens: 100,
  });
});

test("parseUsageLine returns null for non-usage lines and blank lines", () => {
  expect(mod.parseUsageLine(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }))).toBeNull();
  expect(mod.parseUsageLine("")).toBeNull();
  // Usage without a message id can't be deduped — skipped by design.
  expect(mod.parseUsageLine(JSON.stringify({ timestamp: TODAY, message: { usage: { input_tokens: 1 } } }))).toBeNull();
  // No parseable timestamp → no day bucket → skipped rather than invented.
  expect(mod.parseUsageLine(JSON.stringify({ message: { id: "m", usage: { input_tokens: 1 } } }))).toBeNull();
});

test("parseUsageLine flags malformed JSON as an error, not a throw", () => {
  expect(mod.parseUsageLine("{oops")).toEqual({ error: true });
});

// --- scan + rollups --------------------------------------------------------------

test("scan counts usage lines once, skips noise, and reports parse errors", () => {
  const { configDir, file } = makeAccount();
  writeFileSync(
    file,
    assistantLine({ id: "m1", requestId: "r1" }) +
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n" +
      "{malformed\n" +
      // Streaming rewrite of m1: same id+requestId, higher counts — must NOT double-count.
      assistantLine({ id: "m1", requestId: "r1", output: 999 }) +
      assistantLine({ id: "m2", requestId: "r2", input: 7, output: 3 }),
  );
  const result = mod.scanAccountUsage(configDir);
  expect(result.eventsCounted).toBe(2);
  expect(result.parseErrors).toBe(1);

  const summary = mod.accountUsageSummary(configDir);
  expect(summary.configDir).toBe(configDir);
  expect(summary.today).toEqual({
    inputTokens: 17,
    outputTokens: 23,
    cacheWriteTokens: 10,
    cacheReadTokens: 200,
    messageCount: 2,
  });
});

test("re-scanning is idempotent (cursor) and a full re-read is idempotent too (usage_seen)", () => {
  const { configDir, file } = makeAccount();
  writeFileSync(file, assistantLine({ id: "m1" }));
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(1);
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(0);
  // Truncate/rewrite: size < offset resets the cursor to 0; recounting the
  // same message is absorbed by the dedupe table.
  writeFileSync(file, assistantLine({ id: "m1" }));
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(0);
  expect(mod.accountUsageSummary(configDir).today.messageCount).toBe(1);
});

test("a partially-flushed line is not consumed until its newline arrives", () => {
  const { configDir, file } = makeAccount();
  const full = assistantLine({ id: "m1" });
  writeFileSync(file, full.slice(0, 40)); // no trailing newline
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(0);
  appendFileSync(file, full.slice(40));
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(1);
});

test("appended lines are picked up incrementally", () => {
  const { configDir, file } = makeAccount();
  writeFileSync(file, assistantLine({ id: "m1" }));
  mod.scanAccountUsage(configDir);
  appendFileSync(file, assistantLine({ id: "m2" }));
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(1);
});

test("rollups survive the raw transcript being deleted (retention)", () => {
  const { configDir, file } = makeAccount();
  writeFileSync(file, assistantLine({ id: "m1", input: 42 }));
  mod.scanAccountUsage(configDir);
  rmSync(file);
  const summary = mod.accountUsageSummary(configDir);
  expect(summary.today.inputTokens).toBe(42);
});

test("time windows: an old event lands in neither today nor last7d; per-day rows keep it", () => {
  const { configDir, file } = makeAccount();
  writeFileSync(
    file,
    assistantLine({ id: "old", ts: NINE_DAYS_AGO, input: 1000, model: "claude-sonnet-5" }) +
      assistantLine({ id: "new", input: 1 }),
  );
  mod.scanAccountUsage(configDir);
  const summary = mod.accountUsageSummary(configDir);
  expect(summary.today.inputTokens).toBe(1);
  expect(summary.last7d.inputTokens).toBe(1);
  const days = mod.accountUsageDays(configDir, 30);
  expect(days.some((d) => d.model === "claude-sonnet-5" && d.inputTokens === 1000)).toBe(true);
});

test("unknown model ids aggregate under 'unknown' instead of being dropped", () => {
  const { configDir, file } = makeAccount();
  const line = JSON.parse(assistantLine({ id: "m1" }));
  delete line.message.model;
  writeFileSync(file, JSON.stringify(line) + "\n");
  mod.scanAccountUsage(configDir);
  expect(mod.accountUsageDays(configDir).some((d) => d.model === "unknown")).toBe(true);
});

test("subdirectories (subagent transcripts) are included in the scan", () => {
  const { configDir } = makeAccount();
  const sub = path.join(configDir, "projects", "-home-u-repo", "session-1", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, "agent-1.jsonl"), assistantLine({ id: "sub1" }));
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(1);
});

test("a missing projects dir is a clean no-op", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-usage-empty-"));
  const result = mod.scanAccountUsage(configDir);
  expect(result).toEqual({ filesScanned: 0, eventsCounted: 0, parseErrors: 0, budgetExhausted: false });
});

test("the byte budget truncates a pass and the next pass resumes from the cursor", () => {
  const { configDir, file } = makeAccount();
  const lineA = assistantLine({ id: "b1" });
  const lineB = assistantLine({ id: "b2" });
  writeFileSync(file, lineA + lineB);
  // Budget covers line A but cuts into line B: only A is counted, the pass
  // reports exhaustion, and the cursor stops at A's newline.
  const first = mod.scanAccountUsage(configDir, lineA.length + 10);
  expect(first.eventsCounted).toBe(1);
  expect(first.budgetExhausted).toBe(true);
  // Unbudgeted follow-up picks up line B exactly once.
  const second = mod.scanAccountUsage(configDir);
  expect(second.eventsCounted).toBe(1);
  expect(second.budgetExhausted).toBe(false);
  expect(mod.scanAccountUsage(configDir).eventsCounted).toBe(0);
  expect(mod.accountUsageSummary(configDir).today.messageCount).toBe(2);
});

test("a projects/ folder swapped for a symlink is never listed", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-usage-acct-"));
  const elsewhere = mkdtempSync(path.join(tmpdir(), "agetor-usage-target-"));
  const proj = path.join(elsewhere, "-home-u-repo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, "session-1.jsonl"), assistantLine({ id: "linked-m1" }));
  symlinkSync(elsewhere, path.join(configDir, "projects"));
  expect(mod.scanAccountUsage(configDir)).toMatchObject({ filesScanned: 0, eventsCounted: 0 });
});
