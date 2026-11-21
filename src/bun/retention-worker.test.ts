/**
 * Archived-history retention and Compact over a REAL database worker thread
 * (`AGETOR_DB_MODE=worker`), the way production runs them, compared with the
 * same scenario in in-process mode (the `bun test` default). The pass, its
 * chunk writes (`retention.writeChunk`), the sweep record, the stats
 * (`retention.fileStats`) and Compact (`retention.compact`) must come out the
 * same in both modes.
 *
 * `retention.ts` uses the process-wide client, so each phase swaps it with
 * `resetDbRpcForTests()` after setting `AGETOR_DB_MODE`. Both modes open the
 * same file (`$AGETOR_DATA_DIR/agetor.sqlite`): the in-process one through the
 * `db.ts` singleton, the worker one on its own connection.
 *
 * Every seeded task is archived in 2001, and every pass runs with `now` a few
 * weeks after that, so tasks other test files left in the shared database are
 * never candidates.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeRun, makeTask } from "./db-rpc-test-util.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-retention-worker-"));

const savedEnv = {
  AGETOR_DB_MODE: process.env.AGETOR_DB_MODE,
  AGETOR_CORE_WORKER_ENTRY: process.env.AGETOR_CORE_WORKER_ENTRY,
  AGETOR_ARCHIVED_HISTORY_RETENTION: process.env.AGETOR_ARCHIVED_HISTORY_RETENTION,
};
delete process.env.AGETOR_ARCHIVED_HISTORY_RETENTION;

const DAY = 86_400_000;
const T0 = Date.UTC(2001, 0, 1);
const NOW = T0 + 40 * DAY;
const MARKER = '{"retention":';

type Facade = typeof import("./db-async.ts");
type Rpc = typeof import("./db-rpc.ts");
type Retention = typeof import("./retention.ts");

async function load(): Promise<{ fa: Facade; rpcm: Rpc; ret: Retention }> {
  return {
    fa: await import("./db-async.ts"),
    rpcm: await import("./db-rpc.ts"),
    ret: await import("./retention.ts"),
  };
}

/** Point the process-wide client at `mode` (closing the previous one). */
async function useMode(mode: "inprocess" | "worker"): Promise<void> {
  const { rpcm } = await load();
  await rpcm.getDbRpc().closeDb({ timeoutMs: 2000 }).catch(() => {});
  process.env.AGETOR_DB_MODE = mode;
  if (mode === "worker") process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "core-worker.ts");
  rpcm.resetDbRpcForTests();
  expect(rpcm.getDbRpc().mode).toBe(mode);
  await rpcm.dbReady();
}

afterAll(async () => {
  const { rpcm } = await load();
  await rpcm.getDbRpc().closeDb({ timeoutMs: 2000 }).catch(() => {});
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rpcm.resetDbRpcForTests();
});

const toolResult = (toolUseId: string, content: unknown) => JSON.stringify({ toolUseId, content, isError: false });
const big = (tag: string, bytes = 64 * 1024) => toolResult(`toolu_${tag}`, `${tag} `.repeat(Math.ceil(bytes / (tag.length + 1))));

interface Seeded {
  taskId: string;
  runIds: string[];
  /** Event ids in seeding order: big main rows, big subagent rows, small rows,
   *  a big non-JSON row, a big assistant row. */
  ids: number[];
}

/** One archived task: two runs, the rows spread round-robin. Same content in
 *  both modes, so the trimmed payloads must match byte for byte. */
async function seed(archivedAt: number | null): Promise<Seeded> {
  const { fa } = await load();
  const task = makeTask({ archivedAt, column: "done" });
  await fa.tasks.insert(task);
  const runIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const run = makeRun(task.id, { status: "succeeded", endedAt: T0 + i, exitCode: 0, tmuxSession: null });
    await fa.runs.insert(run);
    runIds.push(run.id);
  }
  const rows: Array<[string, string, string | null]> = [];
  for (let i = 0; i < 40; i++) rows.push(["tool_result", big(`m${i}`), null]);
  for (let i = 0; i < 10; i++) rows.push(["tool_result", big(`s${i}`), "sub-retention-worker"]);
  for (let i = 0; i < 5; i++) rows.push(["tool_result", toolResult(`toolu_small${i}`, "ok ".repeat(100)), null]);
  rows.push(["tool_result", "not json at all ".repeat(4096), null]);
  rows.push(["assistant", "assistant text ".repeat(5000), null]);
  const ids: number[] = [];
  let rr = 0;
  for (const [stream, data, subagent] of rows) {
    const row = await fa.runs.appendEvent(runIds[rr++ % runIds.length]!, stream as "tool_result", data, `ln-${randomUUID()}`, subagent);
    if (!row) throw new Error("seed row was deduped");
    ids.push(row.id);
  }
  return { taskId: task.id, runIds, ids };
}

interface PhaseOutcome {
  pass: { scannedTasks: number; scannedRuns: number; trimmedRows: number; freedBytes: number; aborted: boolean };
  /** The stored payload of every seeded row (see `payloadsOf`). */
  payloads: string[];
  recorded: boolean;
  unarchivedTrimmed: number;
  secondPass: { scannedTasks: number; trimmedRows: number };
  bookkeeping: { lastTrimmedRows: number | null; lastFreedBytes: number | null };
  freelistBeforeCompact: number;
  compact: { shrank: boolean; durationNonNegative: boolean };
  afterCompact: { freelistCount: number; walBytes: number; reclaimableBytes: number; eventsIntact: boolean; writable: boolean };
}

/** Every stored payload of the task's runs, run by run in id order. The
 *  seeding is identical in both modes, so the lists line up row for row. */
async function payloadsOf(seeded: Seeded): Promise<string[]> {
  const { fa } = await load();
  const out: string[] = [];
  for (const runId of seeded.runIds) for (const e of await fa.runs.events(runId)) out.push(e.data);
  expect(out).toHaveLength(seeded.ids.length);
  return out;
}

async function runPhase(): Promise<PhaseOutcome> {
  const { fa, ret } = await load();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const old = await seed(T0);
    // Not archived: never a candidate, never touched.
    const live = await seed(null);

    const pass = await ret.runArchivedHistoryRetentionPass({ now: NOW, days: 30 });
    const payloads = await payloadsOf(old);
    const livePayloads = await payloadsOf(live);
    const recorded = (await fa.retentionSweeps.all()).has(old.taskId);
    const stats = await ret.dbStats(0);
    const second = await ret.runArchivedHistoryRetentionPass({ now: NOW, days: 30 });

    const eventsBefore = (await fa.runs.events(old.runIds[0]!)).length;
    const compact = await ret.compactDatabase();
    const after = await ret.dbStats(0);
    const eventsAfter = await fa.runs.events(old.runIds[0]!);
    const appended = await fa.runs.appendEvent(old.runIds[0]!, "status", "after compact");
    // Out of every later pass's candidate list (its sweep key just changed).
    await fa.tasks.update(old.taskId, { archivedAt: null });

    return {
      pass: {
        scannedTasks: pass.scannedTasks,
        scannedRuns: pass.scannedRuns,
        trimmedRows: pass.trimmedRows,
        freedBytes: pass.freedBytes,
        aborted: pass.aborted,
      },
      payloads,
      recorded,
      unarchivedTrimmed: livePayloads.filter((d) => d.startsWith(MARKER)).length,
      secondPass: { scannedTasks: second.scannedTasks, trimmedRows: second.trimmedRows },
      bookkeeping: { lastTrimmedRows: stats.retention.lastTrimmedRows, lastFreedBytes: stats.retention.lastFreedBytes },
      freelistBeforeCompact: stats.freelistCount,
      compact: { shrank: compact.afterBytes < compact.beforeBytes, durationNonNegative: compact.durationMs >= 0 },
      afterCompact: {
        freelistCount: after.freelistCount,
        walBytes: after.walBytes,
        reclaimableBytes: after.reclaimableBytes,
        eventsIntact: eventsAfter.length === eventsBefore,
        writable: appended !== null,
      },
    };
  } finally {
    log.mockRestore();
  }
}

describe("retention in worker mode matches in-process mode", () => {
  test("the sweep, its record, the stats and Compact", async () => {
    await useMode("inprocess");
    const inprocess = await runPhase();
    await useMode("worker");
    const worker = await runPhase();

    // The scenario did what it is meant to (so equality is not two empties).
    expect(inprocess.pass.trimmedRows).toBe(50);
    expect(inprocess.pass.scannedTasks).toBe(1);
    expect(inprocess.pass.freedBytes).toBeGreaterThan(0);
    expect(inprocess.payloads.filter((d) => d.startsWith(MARKER))).toHaveLength(50);
    expect(inprocess.recorded).toBe(true);
    expect(inprocess.secondPass).toEqual({ scannedTasks: 0, trimmedRows: 0 });
    expect(inprocess.freelistBeforeCompact).toBeGreaterThan(0);
    expect(inprocess.compact.shrank).toBe(true);
    expect(inprocess.afterCompact).toEqual({ freelistCount: 0, walBytes: 0, reclaimableBytes: 0, eventsIntact: true, writable: true });

    // And the worker did exactly the same.
    expect(worker.pass).toEqual(inprocess.pass);
    expect(worker.payloads).toEqual(inprocess.payloads);
    expect(worker.recorded).toBe(inprocess.recorded);
    expect(worker.unarchivedTrimmed).toBe(0);
    expect(inprocess.unarchivedTrimmed).toBe(0);
    expect(worker.secondPass).toEqual(inprocess.secondPass);
    expect(worker.bookkeeping).toEqual({ lastTrimmedRows: 50, lastFreedBytes: inprocess.pass.freedBytes });
    expect(worker.bookkeeping).toEqual(inprocess.bookkeeping);
    expect(worker.freelistBeforeCompact).toBeGreaterThan(0);
    expect(worker.compact).toEqual(inprocess.compact);
    expect(worker.afterCompact).toEqual(inprocess.afterCompact);
  }, 60_000);

  test("Compact refuses while a pass is running, before anything reaches the worker", async () => {
    await useMode("worker");
    const { ret } = await load();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const seeded = await seed(T0);
      const pass = ret.runArchivedHistoryRetentionPass({ now: NOW, days: 30, sliceMs: 0 });
      expect(ret.isRetentionRunning()).toBe(true);
      await expect(ret.compactDatabase()).rejects.toThrow(/retention pass is running/);
      const result = await pass;
      expect(result.trimmedRows).toBe(50);
      await (await load()).fa.tasks.update(seeded.taskId, { archivedAt: null });
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
