/**
 * Archived-history retention pass (docs/plans/non-blocking-session-restore.md,
 * TT3): what it trims, what it must never touch, idempotency, abort, the
 * "unarchived mid-pass" race, the debounced re-run queue, the event-loop drift
 * budget, and the stats/compact helpers behind Settings → General.
 *
 * The db is a process-wide singleton shared with every other test file in the
 * run, so every row below carries a fresh uuid and `afterEach` removes exactly
 * what this file inserted — nothing assumes an empty table, and nothing is left
 * behind for a sibling file that counts rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-retention-"));

// Read at CALL time by `requestRetentionPass` (see `envMs` in retention.ts), but
// set before the import anyway so the seam can't be missed if that changes.
const savedEnv = {
  debounce: process.env.AGETOR_RETENTION_DEBOUNCE_MS,
  kill: process.env.AGETOR_ARCHIVED_HISTORY_RETENTION,
};
process.env.AGETOR_RETENTION_DEBOUNCE_MS = "1";
delete process.env.AGETOR_ARCHIVED_HISTORY_RETENTION;

type DbModule = typeof import("./db.ts");
type RetentionModule = typeof import("./retention.ts");
let dbm: DbModule;
let ret: RetentionModule;
let ARCHIVED_HISTORY_RETENTION_PREF: string;

beforeAll(async () => {
  dbm = await import("./db.ts");
  ret = await import("./retention.ts");
  ({ ARCHIVED_HISTORY_RETENTION_PREF } = await import("../shared/types.ts"));
});

const DAY = 86_400_000;
const BIG = 64 * 1024;
const MARKER = '{"retention":';

const seededTaskIds: string[] = [];
const seededRunIds: string[] = [];

afterEach(() => {
  ret.stopRetentionTimers();
  const { db } = dbm;
  for (const runId of seededRunIds.splice(0)) {
    db.run(`DELETE FROM run_events WHERE run_id = ?`, [runId]);
    db.run(`DELETE FROM runs WHERE id = ?`, [runId]);
  }
  for (const taskId of seededTaskIds.splice(0)) db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  for (const key of ["retention:lastRunAt", "retention:lastFreedBytes", "retention:lastTrimmedRows", ARCHIVED_HISTORY_RETENTION_PREF]) {
    db.run(`DELETE FROM preferences WHERE key = ?`, [key]);
  }
  delete process.env.AGETOR_ARCHIVED_HISTORY_RETENTION;
});

afterAll(() => {
  for (const [name, value] of [
    ["AGETOR_RETENTION_DEBOUNCE_MS", savedEnv.debounce],
    ["AGETOR_ARCHIVED_HISTORY_RETENTION", savedEnv.kill],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function makeTaskRow(taskId: string, archivedAt: number | null): Task {
  return {
    id: taskId,
    title: "retention",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt,
  };
}

const toolResult = (toolUseId: string, content: unknown) => JSON.stringify({ toolUseId, content, isError: false });

/** A tool_result payload of roughly `bytes` bytes: a long text. */
const bigToolResult = (tag: string, bytes = BIG) => toolResult(`toolu_${tag}`, `${tag} `.repeat(Math.ceil(bytes / (tag.length + 1))));

/** A tool_result whose parse + re-serialize is deliberately expensive (a large
 *  nested object content), so a pass over a few dozen of them spans many
 *  20 ms slices. */
const heavyToolResult = (tag: string) =>
  toolResult(`toolu_${tag}`, { items: Array.from({ length: 15_000 }, (_, i) => ({ i, s: "abc", tag })) });

type Kind =
  | "bigMain"
  | "bigSub"
  | "small"
  | "smallSub"
  | "bigAssistant"
  | "bigToolUse"
  | "bigGarbage"
  | "heavy";
type SeedSpec = Partial<Record<Kind, number>> & { runs?: number; bigBytes?: number };
type Seeded = {
  taskId: string;
  runIds: string[];
  ids: Record<Kind, number[]>;
  all: number[];
};

const emptyIds = (): Record<Kind, number[]> => ({
  bigMain: [], bigSub: [], small: [], smallSub: [], bigAssistant: [], bigToolUse: [], bigGarbage: [], heavy: [],
});

/** Inserts one task (archived `archivedAt` or live) with `spec.runs` runs, the
 *  rows of each kind spread round-robin over its runs. Subagent-tagged kinds
 *  carry a `subagent_id`. Every row gets a unique `line_uuid`. */
function seedTask(archivedAt: number | null, spec: SeedSpec): Seeded {
  const { tasks, runs, db } = dbm;
  const taskId = randomUUID();
  seededTaskIds.push(taskId);
  tasks.insert(makeTaskRow(taskId, archivedAt));
  const runCount = spec.runs ?? 1;
  const runIds: string[] = [];
  const base = Date.now();
  for (let i = 0; i < runCount; i++) {
    const runId = randomUUID();
    runIds.push(runId);
    seededRunIds.push(runId);
    runs.insert({
      id: runId, taskId, agent: "claude-code", status: "succeeded",
      startedAt: base + i, endedAt: base + i + 1, exitCode: 0,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
      geminiSessionId: null, fxSessionId: null,
    });
  }
  const bytes = spec.bigBytes ?? BIG;
  const ids = emptyIds();
  const all: number[] = [];
  const subagentId = `sub-${randomUUID().slice(0, 8)}`;
  let rr = 0;
  const add = (kind: Kind, stream: "tool_result" | "assistant" | "tool_use", data: string, subagent: string | null) => {
    const runId = runIds[rr++ % runIds.length]!;
    const id = dbm.runs.appendEvent(runId, stream, data, `ln-${randomUUID()}`, subagent);
    if (id === null) throw new Error("seed row was deduped");
    ids[kind].push(id);
    all.push(id);
  };
  db.transaction(() => {
    for (let i = 0; i < (spec.bigMain ?? 0); i++) add("bigMain", "tool_result", bigToolResult(`m${i}`, bytes), null);
    for (let i = 0; i < (spec.bigSub ?? 0); i++) add("bigSub", "tool_result", bigToolResult(`s${i}`, bytes), subagentId);
    for (let i = 0; i < (spec.small ?? 0); i++) add("small", "tool_result", toolResult(`toolu_sm${i}`, "ok ".repeat(100)), null);
    for (let i = 0; i < (spec.smallSub ?? 0); i++) add("smallSub", "tool_result", toolResult(`toolu_ss${i}`, "ok ".repeat(100)), subagentId);
    for (let i = 0; i < (spec.bigAssistant ?? 0); i++) add("bigAssistant", "assistant", `assistant ${i} `.repeat(Math.ceil(bytes / 12)), null);
    for (let i = 0; i < (spec.bigToolUse ?? 0); i++) {
      add("bigToolUse", "tool_use", JSON.stringify({ id: `toolu_u${i}`, name: "Write", input: { text: "w".repeat(bytes) } }), null);
    }
    // A big tool_result row that is not JSON at all: selected by the SQL
    // prefilter, declined by the trimmer, so it must survive byte-identical.
    for (let i = 0; i < (spec.bigGarbage ?? 0); i++) add("bigGarbage", "tool_result", "not json at all ".repeat(Math.ceil(bytes / 16)), null);
    for (let i = 0; i < (spec.heavy ?? 0); i++) add("heavy", "tool_result", heavyToolResult(`h${i}`), null);
  })();
  return { taskId, runIds, ids, all };
}

type RowSnapshot = {
  id: number; run_id: string; stream: string; ts: number; line_uuid: string | null; subagent_id: string | null;
  data: string; bytes: number;
};

function snapshot(ids: number[]): Map<number, RowSnapshot> {
  const out = new Map<number, RowSnapshot>();
  const stmt = dbm.db.query<RowSnapshot, [number]>(
    `SELECT id, run_id, stream, ts, line_uuid, subagent_id, data, LENGTH(CAST(data AS BLOB)) AS bytes FROM run_events WHERE id = ?`,
  );
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) out.set(id, row);
  }
  return out;
}

const isTrimmed = (row: RowSnapshot) => row.data.startsWith(MARKER);

function trimmedCount(runIds: string[]): number {
  const marks = runIds.map(() => "?").join(",");
  return dbm.db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM run_events WHERE run_id IN (${marks}) AND substr(data, 1, 13) = '${MARKER}'`,
    )
    .get(...runIds)!.n;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

function silenceLog() {
  return spyOn(console, "log").mockImplementation(() => {});
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

describe("runArchivedHistoryRetentionPass", () => {
  const spec: SeedSpec = {
    runs: 2,
    bigMain: 4,
    bigSub: 3,
    small: 3,
    smallSub: 2,
    bigAssistant: 2,
    bigToolUse: 2,
    bigGarbage: 1,
  };

  test("trims only the archived-old big tool_result rows, keeps identity columns, accounts bytes exactly", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, spec);
    const recent = seedTask(now - 5 * DAY, spec);
    const live = seedTask(null, spec);
    const before = snapshot([...old.all, ...recent.all, ...live.all]);

    const result = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();

    const after = snapshot([...old.all, ...recent.all, ...live.all]);
    const expectedTrimmed = [...old.ids.bigMain, ...old.ids.bigSub];
    expect(expectedTrimmed).toHaveLength(7);

    // Counts and bytes: Σ(original − new) over exactly the expected rows.
    let freed = 0;
    for (const id of expectedTrimmed) {
      const b = before.get(id)!;
      const a = after.get(id)!;
      expect(isTrimmed(a), `row ${id} (${b.subagent_id ? "subagent" : "main"}) should be trimmed`).toBe(true);
      expect(a.bytes).toBeLessThan(b.bytes);
      freed += b.bytes - a.bytes;
    }
    expect(result.trimmedRows).toBe(expectedTrimmed.length);
    expect(result.freedBytes).toBe(freed);
    expect(result.freedBytes).toBeGreaterThan(expectedTrimmed.length * (BIG - 8 * 1024));
    expect(result.scannedTasks).toBe(1);
    expect(result.scannedRuns).toBe(2);
    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Every other row is byte-identical: small rows, non-tool_result streams,
    // the non-JSON big row, recent-archived and live tasks.
    for (const [id, b] of before) {
      const a = after.get(id)!;
      // The identity columns never move, trimmed or not.
      expect(a.run_id).toBe(b.run_id);
      expect(a.stream).toBe(b.stream);
      expect(a.ts).toBe(b.ts);
      expect(a.line_uuid).toBe(b.line_uuid);
      expect(a.subagent_id).toBe(b.subagent_id);
      if (!expectedTrimmed.includes(id)) expect(a.data, `row ${id} must be untouched`).toBe(b.data);
    }

    // The trimmed payload is still the same tool_result envelope.
    const sample = JSON.parse(after.get(old.ids.bigSub[0]!)!.data);
    expect(sample.toolUseId).toBe("toolu_s0");
    expect(sample.retention.trimmed).toBe(true);
    expect(sample.retention.originalBytes).toBe(before.get(old.ids.bigSub[0]!)!.bytes);
    expect(sample.retention.trimmedAt).toBe(now);
  });

  test("a second pass trims nothing — the marker prefilter alone excludes trimmed rows", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { ...spec });
    const first = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    expect(first.trimmedRows).toBe(old.ids.bigMain.length + old.ids.bigSub.length);
    const afterFirst = snapshot(old.all);

    const second = await ret.runArchivedHistoryRetentionPass({ now: now + 1000, days: 30 });
    log.mockRestore();
    expect(second.trimmedRows).toBe(0);
    expect(second.freedBytes).toBe(0);
    expect(second.aborted).toBe(false);
    for (const [id, row] of snapshot(old.all)) expect(row.data).toBe(afterFirst.get(id)!.data);

    // The candidate query itself no longer returns any trimmed row (they are
    // still > 4 KB, so only the substr prefilter can be excluding them).
    for (const runId of old.runIds) {
      const candidates = dbm.runs.toolResultRowsForTrim(runId, 4096, 0, 1000);
      for (const row of candidates) expect(row.data.startsWith(MARKER)).toBe(false);
    }
    expect(afterFirst.get(old.ids.bigMain[0]!)!.bytes).toBeGreaterThan(4096);
  });

  test("a completed sweep is recorded: an unchanged task (even one holding untrimmable big rows) is skipped next time", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 2, bigGarbage: 2 });
    const first = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    expect(first.scannedTasks).toBe(1);
    expect(first.trimmedRows).toBe(2);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(true);
    // The record lives in its own table, never in the preferences store that
    // GET /preferences and `agetor config ls` return.
    expect(Object.keys(dbm.preferences.list()).filter((k) => k.toLowerCase().includes("swept"))).toEqual([]);

    // The two garbage rows still match the candidate query (big, unmarked)…
    const leftovers = old.runIds.flatMap((r) => dbm.runs.toolResultRowsForTrim(r, 4096, 0, 1000));
    expect(leftovers.map((r) => r.id).sort()).toEqual([...old.ids.bigGarbage].sort());
    // …but the next pass no longer re-reads them.
    const second = await ret.runArchivedHistoryRetentionPass({ now: now + 1000, days: 30 });
    log.mockRestore();
    expect(second.scannedTasks).toBe(0);
    expect(second.scannedRuns).toBe(0);
    expect(second.trimmedRows).toBe(0);
  });

  test("a swept task is swept again when it gains events, is re-archived, or the threshold changes", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 1 });
    expect((await ret.runArchivedHistoryRetentionPass({ now, days: 30 })).trimmedRows).toBe(1);

    // New rows (a JSONL rebuild of the archived task) → swept and trimmed.
    const late = dbm.runs.appendEvent(old.runIds[0]!, "tool_result", bigToolResult("late", BIG), `ln-${randomUUID()}`, null);
    expect(late).not.toBeNull();
    const afterRebuild = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    expect(afterRebuild.scannedTasks).toBe(1);
    expect(afterRebuild.trimmedRows).toBe(1);
    expect((await ret.runArchivedHistoryRetentionPass({ now, days: 30 })).scannedTasks).toBe(0);

    // A different threshold is a different sweep.
    expect((await ret.runArchivedHistoryRetentionPass({ now, days: 30, maxBytes: 8192 })).scannedTasks).toBe(1);

    // Re-archived (still past the cutoff) → archived_at moved → swept again.
    dbm.db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [now - 35 * DAY, old.taskId]);
    expect((await ret.runArchivedHistoryRetentionPass({ now, days: 30 })).scannedTasks).toBe(1);

    // Unarchived → dropped from the record.
    dbm.db.run(`UPDATE tasks SET archived_at = NULL WHERE id = ?`, [old.taskId]);
    await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);
  });

  test("a deleted task's sweep record goes with it", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 1 });
    await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(true);
    for (const runId of old.runIds) {
      dbm.db.run(`DELETE FROM run_events WHERE run_id = ?`, [runId]);
      dbm.db.run(`DELETE FROM runs WHERE id = ?`, [runId]);
    }
    dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [old.taskId]);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);
    // Recording a sweep for a task that no longer exists is a silent no-op.
    dbm.retentionSweeps.set(old.taskId, "0:0:0");
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);
  });

  test("a steady-state pass that skips every already-swept task still yields between tasks", async () => {
    const log = silenceLog();
    const now = Date.now();
    const count = 25;
    const seeded = Array.from({ length: count }, () => seedTask(now - 40 * DAY, { bigMain: 1 }));
    expect((await ret.runArchivedHistoryRetentionPass({ now, days: 30 })).scannedTasks).toBeGreaterThanOrEqual(count);
    const sweeps = dbm.retentionSweeps.all();
    for (const s of seeded) expect(sweeps.has(s.taskId)).toBe(true);

    // sliceMs: 0 → any slice is spent, so every loop iteration must yield.
    let settled = false;
    const pass = ret.runArchivedHistoryRetentionPass({ now: now + 1000, days: 30, sliceMs: 0 }).then((r) => {
      settled = true;
      return r;
    });
    let ticksWhileRunning = 0;
    while (!settled) {
      await tick();
      if (!settled && ret.isRetentionRunning()) ticksWhileRunning++;
    }
    const second = await pass;
    log.mockRestore();
    expect(second.scannedTasks).toBe(0);
    expect(second.aborted).toBe(false);
    // One yield per skipped task (before the fix: zero — the whole skip loop
    // ran without ever returning to the event loop).
    expect(ticksWhileRunning).toBeGreaterThanOrEqual(count - 1);
  });

  test("days: null is a no-op that writes no bookkeeping", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 400 * DAY, spec);
    const before = snapshot(old.all);
    const result = await ret.runArchivedHistoryRetentionPass({ now, days: null });
    log.mockRestore();
    expect(result).toEqual({ scannedTasks: 0, scannedRuns: 0, trimmedRows: 0, freedBytes: 0, durationMs: 0, aborted: false });
    for (const [id, row] of snapshot(old.all)) expect(row.data).toBe(before.get(id)!.data);
    expect(dbm.preferences.get("retention:lastRunAt")).toBeNull();
  });

  test("a completed pass writes the three retention:* preferences; values mirror the result", async () => {
    const log = silenceLog();
    const now = Date.now();
    seedTask(now - 40 * DAY, spec);
    const startedAt = Date.now();
    const result = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(Number(dbm.preferences.get("retention:lastRunAt"))).toBeGreaterThanOrEqual(startedAt);
    expect(dbm.preferences.get("retention:lastFreedBytes")).toBe(String(result.freedBytes));
    expect(dbm.preferences.get("retention:lastTrimmedRows")).toBe(String(result.trimmedRows));
    expect(result.trimmedRows).toBeGreaterThan(0);
  });

  test("the cutoff is inclusive: archived exactly N days ago is trimmed, one ms newer is not", async () => {
    const log = silenceLog();
    const now = Date.now();
    const exact = seedTask(now - 30 * DAY, { bigMain: 1 });
    const justInside = seedTask(now - 30 * DAY + 1, { bigMain: 1 });
    const result = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(result.trimmedRows).toBe(1);
    expect(isTrimmed(snapshot(exact.all).get(exact.ids.bigMain[0]!)!)).toBe(true);
    expect(isTrimmed(snapshot(justInside.all).get(justInside.ids.bigMain[0]!)!)).toBe(false);
  });

  test("maxBytes raises the candidate threshold", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 3 });
    const result = await ret.runArchivedHistoryRetentionPass({ now, days: 30, maxBytes: BIG * 4 });
    log.mockRestore();
    expect(result.trimmedRows).toBe(0);
    expect(trimmedCount(old.runIds)).toBe(0);
  });

  test("stopRetentionTimers() mid-pass aborts at a chunk boundary: aborted true, no bookkeeping, rest resumable", async () => {
    const log = silenceLog();
    const now = Date.now();
    const total = 300;
    const old = seedTask(now - 40 * DAY, { bigMain: total });

    // sliceMs: 0 → the pass yields to the event loop after every row.
    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    expect(ret.isRetentionRunning()).toBe(true);
    await until(() => trimmedCount(old.runIds) > 0, "the first chunk to commit");
    ret.stopRetentionTimers();
    const result = await pass;

    expect(result.aborted).toBe(true);
    expect(ret.isRetentionRunning()).toBe(false);
    expect(dbm.preferences.get("retention:lastRunAt")).toBeNull();
    const done = trimmedCount(old.runIds);
    expect(done).toBe(result.trimmedRows);
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(total);
    // An aborted sweep is never recorded as complete.
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);

    // The next pass resumes via the marker prefilter and finishes the job.
    const resumed = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(resumed.aborted).toBe(false);
    expect(resumed.trimmedRows).toBe(total - done);
    expect(trimmedCount(old.runIds)).toBe(total);
  });

  test("unarchiving a task between chunks stops trimming it", async () => {
    const log = silenceLog();
    const now = Date.now();
    const total = 300;
    const old = seedTask(now - 40 * DAY, { bigMain: total });
    const control = seedTask(now - 40 * DAY, { bigMain: 5 });

    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    await until(() => trimmedCount(old.runIds) > 0, "the first chunk to commit");
    // Synchronous from the poll above through the UPDATE below: no chunk can
    // commit in between, so `atFlip` is exactly what was trimmed before the flip.
    const atFlip = trimmedCount(old.runIds);
    dbm.db.run(`UPDATE tasks SET archived_at = NULL WHERE id = ?`, [old.taskId]);
    const result = await pass;
    log.mockRestore();

    expect(atFlip).toBeGreaterThan(0);
    expect(atFlip).toBeLessThan(total);
    // Nothing was trimmed after the flip: the in-transaction re-check dropped
    // every later chunk for the unarchived task.
    expect(trimmedCount(old.runIds)).toBe(atFlip);
    const stillBig = old.ids.bigMain.filter((id) => !isTrimmed(snapshot([id]).get(id)!));
    expect(stillBig.length).toBe(total - atFlip);
    // Rows past the flip point are fully intact (not partially rewritten).
    for (const id of stillBig.slice(0, 5)) expect(snapshot([id]).get(id)!.bytes).toBeGreaterThan(BIG - 1024);
    // The pass moved on to (or had already finished) the other archived task
    // and completed normally.
    expect(result.aborted).toBe(false);
    expect(trimmedCount(control.runIds)).toBe(5);
    expect(result.trimmedRows).toBe(atFlip + 5);
  });

  test("a second concurrent pass is a no-op returning a zero result", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { heavy: 40 });
    const first = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    expect(ret.isRetentionRunning()).toBe(true);
    const second = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    expect(second).toEqual({ scannedTasks: 0, scannedRuns: 0, trimmedRows: 0, freedBytes: 0, durationMs: 0, aborted: false });
    expect(ret.isRetentionRunning()).toBe(true);
    const firstResult = await first;
    log.mockRestore();
    expect(firstResult.trimmedRows).toBe(40);
    expect(trimmedCount(old.runIds)).toBe(40);
  });

  test("event-loop drift stays under 150 ms while a pass trims ~5k big rows", async () => {
    const log = silenceLog();
    const now = Date.now();
    const rowsPerRun = 1000;
    const runCount = 5;
    // One archived-old task with five runs of 1000 ~8 KB rows each.
    seedTask(now - 40 * DAY, { runs: runCount, bigMain: rowsPerRun * runCount, bigBytes: 8 * 1024 });

    let last = performance.now();
    let maxGap = 0;
    const sampler = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 5);
    let result: Awaited<ReturnType<typeof ret.runArchivedHistoryRetentionPass>>;
    try {
      result = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    } finally {
      clearInterval(sampler);
      log.mockRestore();
    }
    expect(result.trimmedRows).toBe(rowsPerRun * runCount);
    expect(result.aborted).toBe(false);
    expect(maxGap, `max event-loop gap was ${maxGap.toFixed(1)} ms`).toBeLessThan(150);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The swept-task record vs. writes that race a pass
// ---------------------------------------------------------------------------

describe("retention_swept_tasks record under concurrent task changes", () => {
  test("runs.maxEventIdForRun is 0 for a run with no events and the newest id otherwise", () => {
    const empty = seedTask(null, {});
    expect(dbm.runs.maxEventIdForRun(empty.runIds[0]!)).toBe(0);
    expect(dbm.runs.maxEventIdForRun(`missing-${randomUUID()}`)).toBe(0);
    const two = seedTask(null, { runs: 2, small: 4 });
    for (const runId of two.runIds) {
      const ids = dbm.db
        .query<{ id: number }, [string]>(`SELECT id FROM run_events WHERE run_id = ?`)
        .all(runId)
        .map((r) => r.id);
      expect(dbm.runs.maxEventIdForRun(runId)).toBe(Math.max(...ids));
    }
  });

  test("a task unarchived mid-sweep is not recorded (other tasks are); re-archived, it is swept to completion", async () => {
    const log = silenceLog();
    const now = Date.now();
    const total = 300;
    // `control` archived earlier → swept first (candidates are archived_at ASC).
    const control = seedTask(now - 45 * DAY, { bigMain: 3 });
    const old = seedTask(now - 40 * DAY, { bigMain: total });

    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    await until(() => trimmedCount(old.runIds) > 0, "the first chunk of the big task to commit");
    dbm.db.run(`UPDATE tasks SET archived_at = NULL WHERE id = ?`, [old.taskId]);
    const result = await pass;
    expect(result.aborted).toBe(false);

    const sweeps = dbm.retentionSweeps.all();
    expect(sweeps.has(control.taskId)).toBe(true);
    expect(sweeps.has(old.taskId)).toBe(false);
    const partial = trimmedCount(old.runIds);
    expect(partial).toBeLessThan(total);

    // Re-archived past the cutoff: the missing record means the next pass
    // sweeps it (rather than skipping it as done) and finishes the job.
    dbm.db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [now - 40 * DAY, old.taskId]);
    const again = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(again.scannedTasks).toBe(1); // control is skipped as already swept
    expect(again.trimmedRows).toBe(total - partial);
    expect(trimmedCount(old.runIds)).toBe(total);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(true);
  });

  test("a task deleted mid-sweep ends its sweep quietly: no error, no record, the pass carries on", async () => {
    const log = silenceLog();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const total = 300;
    const old = seedTask(now - 45 * DAY, { bigMain: total });
    const later = seedTask(now - 40 * DAY, { bigMain: 4 });

    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    await until(() => trimmedCount(old.runIds) > 0, "the first chunk of the doomed task to commit");
    // What deleteTask does at the db layer: events, runs, then the task row.
    dbm.db.transaction(() => {
      for (const runId of old.runIds) {
        dbm.db.run(`DELETE FROM run_events WHERE run_id = ?`, [runId]);
        dbm.db.run(`DELETE FROM runs WHERE id = ?`, [runId]);
      }
      dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [old.taskId]);
    })();
    let result: Awaited<ReturnType<typeof ret.runArchivedHistoryRetentionPass>>;
    let warned: unknown[][] = [];
    try {
      result = await pass;
    } finally {
      warned = [...warn.mock.calls];
      log.mockRestore();
      warn.mockRestore();
    }
    expect(result.aborted).toBe(false);
    expect(warned.filter((c) => String(c[0]).includes("retention"))).toEqual([]);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);
    expect(dbm.retentionSweeps.all().has(later.taskId)).toBe(true);
    expect(trimmedCount(later.runIds)).toBe(4);
  });

  test("rows appended to an already-scanned run during a sweep are picked up by the next pass", async () => {
    const log = silenceLog();
    const now = Date.now();
    // Two runs, rows round-robin: run 0 (started first) is fully scanned
    // before run 1's first row is trimmed.
    const old = seedTask(now - 40 * DAY, { runs: 2, bigMain: 300 });
    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    await until(() => trimmedCount([old.runIds[1]!]) > 0, "the sweep to reach the second run");
    // A JSONL rebuild landing behind the sweep's keyset cursor.
    const late = dbm.runs.appendEvent(old.runIds[0]!, "tool_result", bigToolResult("late"), `ln-${randomUUID()}`, null);
    expect(late).not.toBeNull();
    const first = await pass;
    expect(first.aborted).toBe(false);
    expect(first.trimmedRows).toBe(300);
    expect(isTrimmed(snapshot([late!]).get(late!)!)).toBe(false);

    // The record holds the key computed BEFORE the append, so it no longer
    // matches: the task is swept again and the late row trimmed.
    const second = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(second.scannedTasks).toBe(1);
    expect(second.trimmedRows).toBe(1);
    expect(isTrimmed(snapshot([late!]).get(late!)!)).toBe(true);
  });

  test("a task that falls out of the age window (retention days raised) loses its record", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 1 });
    const older = seedTask(now - 90 * DAY, { bigMain: 1 });
    await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(true);
    expect(dbm.retentionSweeps.all().has(older.taskId)).toBe(true);
    const wider = await ret.runArchivedHistoryRetentionPass({ now, days: 60 });
    log.mockRestore();
    // `older` is still a candidate with an unchanged key → skipped, kept.
    expect(wider.scannedTasks).toBe(0);
    const sweeps = dbm.retentionSweeps.all();
    expect(sweeps.has(old.taskId)).toBe(false);
    expect(sweeps.has(older.taskId)).toBe(true);
  });

  test("a failed record write only warns: the pass completes and the task is swept again next time", async () => {
    const log = silenceLog();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const set = spyOn(dbm.retentionSweeps, "set").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 2 });
    let first: Awaited<ReturnType<typeof ret.runArchivedHistoryRetentionPass>>;
    let warned: unknown[][] = [];
    try {
      first = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    } finally {
      warned = [...warn.mock.calls];
      set.mockRestore();
      warn.mockRestore();
    }
    expect(first.aborted).toBe(false);
    expect(first.trimmedRows).toBe(2);
    expect(dbm.preferences.get("retention:lastRunAt")).not.toBeNull();
    expect(warned.some((c) => String(c[0]).includes("could not record swept task"))).toBe(true);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(false);

    const second = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();
    expect(second.scannedTasks).toBe(1);
    expect(second.trimmedRows).toBe(0);
    expect(dbm.retentionSweeps.all().has(old.taskId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe("requestRetentionPass / configuredRetentionDays", () => {
  test("configuredRetentionDays follows the preference and the env kill switch", () => {
    expect(ret.configuredRetentionDays()).toBe(30); // absent → default
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "off");
    expect(ret.configuredRetentionDays()).toBeNull();
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "OFF");
    expect(ret.configuredRetentionDays()).toBeNull();
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "45");
    expect(ret.configuredRetentionDays()).toBe(45);
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "garbage");
    expect(ret.configuredRetentionDays()).toBeNull(); // unparsable → off (fail closed)
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "0");
    expect(ret.configuredRetentionDays()).toBeNull(); // an off-word, never the default
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "45");
    process.env.AGETOR_ARCHIVED_HISTORY_RETENTION = "0";
    expect(ret.configuredRetentionDays()).toBeNull(); // env wins over the pref
    delete process.env.AGETOR_ARCHIVED_HISTORY_RETENTION;
    expect(ret.configuredRetentionDays()).toBe(45);
  });

  test("a request while a pass is running queues exactly one re-run", async () => {
    const log = silenceLog();
    const passLines = () =>
      log.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith("[agetor] retention: trimmed")).map((c) => c[0] as string);
    const now = Date.now();
    const heavyRows = 60;
    const old = seedTask(now - 40 * DAY, { heavy: heavyRows });
    // Fresh rows aged by the real clock: startPass uses Date.now(), not our `now`.
    dbm.db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [Date.now() - 40 * DAY, old.taskId]);

    ret.requestRetentionPass();
    await until(() => ret.isRetentionRunning(), "the debounced pass to start");
    // Two more requests, spaced beyond the 1 ms debounce, both land while the
    // first pass is still working through its ~60 heavy rows.
    ret.requestRetentionPass();
    await sleep(15);
    expect(ret.isRetentionRunning()).toBe(true);
    ret.requestRetentionPass();
    await sleep(15);

    // Wait for the first pass AND its single queued re-run to finish, then
    // make sure nothing else starts.
    await until(() => passLines().length >= 2 && !ret.isRetentionRunning(), "the queued re-run to finish", 20_000);
    await sleep(100);
    const lines = passLines();
    log.mockRestore();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`trimmed ${heavyRows} rows`);
    expect(lines[1]).toContain("trimmed 0 rows");
    expect(trimmedCount(old.runIds)).toBe(heavyRows);
  }, 60_000);

  test("a request with retention off starts nothing", async () => {
    const log = silenceLog();
    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "off");
    const old = seedTask(Date.now() - 400 * DAY, { bigMain: 2 });
    ret.requestRetentionPass();
    await sleep(40);
    log.mockRestore();
    expect(ret.isRetentionRunning()).toBe(false);
    expect(trimmedCount(old.runIds)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stats + compact
// ---------------------------------------------------------------------------

describe("dbStats / compactDatabase", () => {
  test("dbStats reports a consistent snapshot", async () => {
    const log = silenceLog();
    const now = Date.now();
    seedTask(now - 40 * DAY, { bigMain: 4 });
    const result = await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();

    const stats = ret.dbStats(3);
    expect(Object.keys(stats).sort()).toEqual(
      ["activeRunCount", "compactEstimateSec", "fileBytes", "freelistCount", "pageCount", "pageSize", "reclaimableBytes", "retention", "walBytes"],
    );
    expect(stats.activeRunCount).toBe(3);
    expect(stats.pageSize).toBeGreaterThan(0);
    expect(stats.pageCount).toBeGreaterThan(0);
    expect(stats.fileBytes).toBeGreaterThan(0);
    expect(stats.walBytes).toBeGreaterThanOrEqual(0);
    expect(stats.reclaimableBytes).toBe(stats.freelistCount * stats.pageSize);
    expect(stats.compactEstimateSec).toBeGreaterThanOrEqual(1);
    expect(Object.keys(stats.retention).sort()).toEqual(["days", "lastFreedBytes", "lastRunAt", "lastTrimmedRows", "running"]);
    expect(stats.retention.days).toBe(30);
    expect(stats.retention.running).toBe(false);
    expect(stats.retention.lastTrimmedRows).toBe(result.trimmedRows);
    expect(stats.retention.lastFreedBytes).toBe(result.freedBytes);
    expect(stats.retention.lastRunAt).toBeGreaterThan(0);

    dbm.preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "off");
    expect(ret.dbStats(0).retention.days).toBeNull();
  });

  test("dbStats reports running while a pass is in flight", async () => {
    const log = silenceLog();
    const now = Date.now();
    seedTask(now - 40 * DAY, { heavy: 20 });
    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    expect(ret.dbStats(0).retention.running).toBe(true);
    await pass;
    log.mockRestore();
    expect(ret.dbStats(0).retention.running).toBe(false);
  });

  test("compactDatabase refuses while a pass is running", async () => {
    const log = silenceLog();
    const now = Date.now();
    seedTask(now - 40 * DAY, { heavy: 20 });
    const pass = ret.runArchivedHistoryRetentionPass({ now, days: 30, sliceMs: 0 });
    expect(() => ret.compactDatabase()).toThrow(/retention pass is running/);
    await pass;
    log.mockRestore();
  });

  test("compactDatabase shrinks the files after a pass and the db keeps answering", async () => {
    const log = silenceLog();
    const now = Date.now();
    const old = seedTask(now - 40 * DAY, { bigMain: 60, bigSub: 20, small: 5 });
    const live = seedTask(null, { bigMain: 3 });
    await ret.runArchivedHistoryRetentionPass({ now, days: 30 });
    log.mockRestore();

    const eventsBefore = dbm.runs.events(old.runIds[0]!).length;
    expect(ret.dbStats(0).freelistCount).toBeGreaterThan(0); // trimming freed overflow pages

    const result = ret.compactDatabase();
    expect(result.beforeBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const stats = ret.dbStats(0);
    expect(stats.freelistCount).toBe(0);
    expect(stats.reclaimableBytes).toBe(0);
    expect(stats.walBytes).toBe(0);

    // Still readable and writable, trimmed rows intact.
    expect(dbm.runs.events(old.runIds[0]!)).toHaveLength(eventsBefore);
    expect(trimmedCount(old.runIds)).toBe(80);
    expect(trimmedCount(live.runIds)).toBe(0);
    expect(dbm.runs.appendEvent(old.runIds[0]!, "status", "after compact")).not.toBeNull();
    expect(dbm.tasks.get(old.taskId)?.id).toBe(old.taskId);
  });
});
