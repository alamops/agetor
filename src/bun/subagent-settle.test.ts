import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

// Only AGETOR_DATA_DIR belongs at module top level — db.ts captures it at
// first import, and the value is unique per file (see the module CLAUDE.md /
// claude-subagents.test.ts / subagent-hold.test.ts for the same convention).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-subagent-settle-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

/*
 * Covers TT4 (docs/plans/fix-stream-list-stalls-with-bg-agents.md, section 4
 * T3/T4, section 5 TT4):
 *   1. db.ts `subagents.markSettledById` idempotency/edge cases.
 *   2. claude-subagents.ts `settleSubagentById` settling a row AND driving the
 *      real orchestrator release path (`maybeReleaseHeldTask`), observed via
 *      the subagent-emitter seam.
 *   3. `settleSubagentById` on an agentId with no matching row: clean no-op.
 *   4. orchestrator.ts `pullBackParkedTask`, reached through the
 *      `setParkedDiscoveryHandler` seam (not exported directly).
 *   5. `runs.origin` round-trip through `insert`/`get`/`listForTask`
 *      (migration 023 compat: an old row with no `origin` reads back null).
 *
 * Importing orchestrator.ts (below) is what installs the REAL
 * `setSubagentSettleHook(maybeReleaseHeldTask)` and
 * `setParkedDiscoveryHandler(pullBackParkedTask)` wiring at module load —
 * exactly like subagent-hold.test.ts relies on for `maybeReleaseHeldTask`.
 * This file never overrides either hook; it only swaps the subagent EMITTER
 * (to observe lifecycle events) and restores it every time, following the
 * read-modify-restore idiom from claude-subagents.test.ts's beforeAll — a
 * test that forgot to restore it would silently un-wire the orchestrator's
 * SSE fan-out for every test file that runs after this one in the same `bun
 * test` process.
 */

let originalEmitter: ((e: RunEvent) => void) | null = null;

beforeAll(async () => {
  await import("./orchestrator.ts"); // installs the real settle / parked-discovery hooks
  const { setSubagentEmitter } = await import("./claude-subagents.ts");
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
});

// Every task this file creates is tracked and hard-deleted in `afterEach`
// (FK ON DELETE CASCADE covers runs/subagents/run_events) so no `running`
// row leaks into a sibling file's `reconcileOrphans()` sweep — same hygiene
// as subagent-hold.test.ts / claude-subagents.test.ts.
const createdTaskIds: string[] = [];

afterEach(async () => {
  const { setSubagentEmitter } = await import("./claude-subagents.ts");
  setSubagentEmitter(originalEmitter);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    try {
      tasks.delete(id);
    } catch {
      /* best-effort */
    }
  }
});

/** Seed a task + a terminal run, mirroring claude-subagents.test.ts's
 *  `seed()` helper. `column`/`runStatus` are parameterized so callers can
 *  build the exact held/parked/error shapes each test needs. */
async function seedTask(opts: {
  column: "running" | "review" | "done" | "blocked" | "ready" | "backlog";
  runStatus: "succeeded" | "failed" | "running";
}): Promise<{ taskId: string; runId: string }> {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-settle-${randomUUID()}`;
  const runId = `run-settle-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: opts.column, agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], runId,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: opts.runStatus, startedAt: now,
    endedAt: opts.runStatus === "running" ? null : now,
    exitCode: opts.runStatus === "succeeded" ? 0 : opts.runStatus === "failed" ? 1 : null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });
  return { taskId, runId };
}

async function insertRunningSubagent(taskId: string, runId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `agent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "subagent", agentType: "Explore",
    description: "test subagent", spawnDepth: 1, sourcePath: `/tmp/${id}.jsonl`,
    status: "running", startedAt: Date.now(), endedAt: null,
  });
  return id;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. subagents.markSettledById
 * ────────────────────────────────────────────────────────────────────────── */

test("markSettledById flips a running row to completed, sets ended_at, returns {changed:true, taskId}", async () => {
  const { subagents } = await import("./db.ts");
  const { taskId, runId } = await seedTask({ column: "running", runStatus: "succeeded" });
  const agentId = await insertRunningSubagent(taskId, runId);

  const result = subagents.markSettledById(agentId, "completed");
  expect(result).toEqual({ changed: true, taskId });

  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  expect(row.endedAt).not.toBeNull();
});

test("markSettledById is a no-op on a second call for the same (now-settled) row", async () => {
  const { subagents } = await import("./db.ts");
  const { taskId, runId } = await seedTask({ column: "running", runStatus: "succeeded" });
  const agentId = await insertRunningSubagent(taskId, runId);

  const first = subagents.markSettledById(agentId, "completed");
  expect(first.changed).toBe(true);
  const endedAtAfterFirst = subagents.get(agentId)!.endedAt;

  const second = subagents.markSettledById(agentId, "completed");
  expect(second).toEqual({ changed: false, taskId: null });
  // Untouched by the no-op call.
  expect(subagents.get(agentId)!.endedAt).toBe(endedAtAfterFirst);
});

test("markSettledById on an unknown id returns {changed:false, taskId:null}", async () => {
  const { subagents } = await import("./db.ts");
  const result = subagents.markSettledById(`no-such-agent-${randomUUID()}`, "completed");
  expect(result).toEqual({ changed: false, taskId: null });
});

test("markSettledById leaves an already-completed row untouched", async () => {
  const { subagents } = await import("./db.ts");
  const { taskId, runId } = await seedTask({ column: "review", runStatus: "succeeded" });
  const id = `agent-${randomUUID()}`;
  const endedAt = Date.now() - 5_000;
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "subagent", agentType: "Explore",
    description: "already done", spawnDepth: 1, sourcePath: `/tmp/${id}.jsonl`,
    status: "completed", startedAt: Date.now() - 10_000, endedAt,
  });

  const result = subagents.markSettledById(id, "completed");
  expect(result).toEqual({ changed: false, taskId: null });
  const row = subagents.get(id)!;
  expect(row.status).toBe("completed");
  expect(row.endedAt).toBe(endedAt); // untouched, not bumped to "now"
});

test("markSettledById leaves an already-orphaned row untouched", async () => {
  const { subagents } = await import("./db.ts");
  const { taskId, runId } = await seedTask({ column: "review", runStatus: "succeeded" });
  const id = `agent-${randomUUID()}`;
  const endedAt = Date.now() - 5_000;
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "subagent", agentType: "Explore",
    description: "already orphaned", spawnDepth: 1, sourcePath: `/tmp/${id}.jsonl`,
    status: "orphaned", startedAt: Date.now() - 10_000, endedAt,
  });

  const result = subagents.markSettledById(id, "orphaned");
  expect(result).toEqual({ changed: false, taskId: null });
  const row = subagents.get(id)!;
  expect(row.status).toBe("orphaned");
  expect(row.endedAt).toBe(endedAt);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2 & 3. claude-subagents.ts settleSubagentById
 * ────────────────────────────────────────────────────────────────────────── */

test("settleSubagentById settles the row, emits the lifecycle event, and releases a held task to review", async () => {
  const { subagents, tasks } = await import("./db.ts");
  const { setSubagentEmitter, settleSubagentById } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seedTask({ column: "running", runStatus: "succeeded" });
  const agentId = await insertRunningSubagent(taskId, runId);

  // Sanity: this is the held shape (column running, terminal run succeeded,
  // one running subagent) that maybeReleaseHeldTask requires.
  expect(subagents.hasRunning(taskId)).toBe(true);

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const changed = settleSubagentById(agentId, "completed");
  expect(changed).toBe(true);

  // DB half: row settled.
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  expect(row.endedAt).not.toBeNull();

  // Lifecycle event emitted via the real subagent-emitter seam.
  const lifecycle = captured.filter((e) => e.stream === "subagent");
  expect(lifecycle.length).toBe(1);
  const payload = JSON.parse(lifecycle[0]!.data);
  expect(payload.phase).toBe("finished");
  expect(payload.subagent.id).toBe(agentId);
  expect(lifecycle[0]!.taskId).toBe(taskId);

  // Settle path: the last running subagent leaving running fires the real
  // maybeReleaseHeldTask hook (wired by orchestrator.ts at module load),
  // which releases the held task to review.
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)!.column).toBe("review");
});

test("settleSubagentById is idempotent on repeat: second call is a no-op, task stays released", async () => {
  const { subagents, tasks } = await import("./db.ts");
  const { setSubagentEmitter, settleSubagentById } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seedTask({ column: "running", runStatus: "succeeded" });
  const agentId = await insertRunningSubagent(taskId, runId);

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  expect(settleSubagentById(agentId, "completed")).toBe(true);
  expect(tasks.get(taskId)!.column).toBe("review");
  const eventCountAfterFirst = captured.length;

  // Manually move the card back to running to prove the repeat call truly
  // doesn't re-drive the settle/release path (if it did, this would flip
  // straight back to review).
  tasks.update(taskId, { column: "running" });

  expect(settleSubagentById(agentId, "completed")).toBe(false);
  expect(captured.length).toBe(eventCountAfterFirst); // no new lifecycle event
  expect(tasks.get(taskId)!.column).toBe("running"); // untouched by the no-op
});

test("settleSubagentById on an agentId matching no subagent row is a clean no-op", async () => {
  const { setSubagentEmitter, settleSubagentById } = await import("./claude-subagents.ts");
  const { tasks } = await import("./db.ts");
  const { taskId } = await seedTask({ column: "running", runStatus: "succeeded" });

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  let changed: boolean | undefined;
  expect(() => {
    changed = settleSubagentById(`no-such-background-agent-${randomUUID()}`, "completed");
  }).not.toThrow();
  expect(changed).toBe(false);
  expect(captured.length).toBe(0); // no lifecycle event
  expect(tasks.get(taskId)!.column).toBe("running"); // no release fired
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. orchestrator.ts pullBackParkedTask (via setParkedDiscoveryHandler)
 * ────────────────────────────────────────────────────────────────────────── */

/** `pullBackParkedTask` isn't exported directly — it's installed once, at
 *  orchestrator.ts module load, via `setParkedDiscoveryHandler`. Capture the
 *  currently-registered (real) handler with the same read-modify-restore
 *  dance the module itself documents for tests (`setSubagentEmitter` /
 *  `setSubagentSettleHook`): swap in a throwaway, read back the previous
 *  value (the real handler), then immediately put it back so no other test
 *  file in this shared process ever observes the wiring changed. */
async function getRealParkedDiscoveryHandler(): Promise<(taskId: string) => void> {
  const { setParkedDiscoveryHandler } = await import("./claude-subagents.ts");
  const real = setParkedDiscoveryHandler(() => {});
  setParkedDiscoveryHandler(real);
  if (!real) throw new Error("expected orchestrator.ts to have installed a real parked-discovery handler");
  return real;
}

test("pullBackParkedTask: a review card whose latest run succeeded is pulled back to running with a status event", async () => {
  const { tasks, runs } = await import("./db.ts");
  const { taskId, runId } = await seedTask({ column: "review", runStatus: "succeeded" });
  const pullBackParkedTask = await getRealParkedDiscoveryHandler();

  pullBackParkedTask(taskId);

  expect(tasks.get(taskId)!.column).toBe("running");
  const events = runs.events(runId);
  const statusEvents = events.filter((e) => e.stream === "status");
  expect(statusEvents.length).toBe(1);
  expect(statusEvents[0]!.data).toContain("running");
});

for (const column of ["done", "blocked", "ready", "backlog"] as const) {
  test(`pullBackParkedTask: a ${column} card is left untouched (only review is pulled back)`, async () => {
    const { tasks } = await import("./db.ts");
    const { taskId } = await seedTask({ column, runStatus: "succeeded" });
    const pullBackParkedTask = await getRealParkedDiscoveryHandler();

    pullBackParkedTask(taskId);

    expect(tasks.get(taskId)!.column).toBe(column);
  });
}

test("pullBackParkedTask: a review card whose latest run FAILED is left untouched", async () => {
  const { tasks } = await import("./db.ts");
  const { taskId } = await seedTask({ column: "review", runStatus: "failed" });
  const pullBackParkedTask = await getRealParkedDiscoveryHandler();

  pullBackParkedTask(taskId);

  expect(tasks.get(taskId)!.column).toBe("review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. runs.origin round-trip (migration 023 compat)
 * ────────────────────────────────────────────────────────────────────────── */

test("runs.origin round-trips through insert/get/listForTask", async () => {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-origin-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });

  const contRunId = `run-origin-cont-${randomUUID()}`;
  runs.insert({
    id: contRunId, taskId, agent: "claude-code", status: "running", startedAt: now,
    endedAt: null, exitCode: null, tmuxSession: null, claudeSessionId: "sess-1",
    codexSessionId: null, origin: "continuation",
  });

  const plainRunId = `run-origin-plain-${randomUUID()}`;
  runs.insert({
    id: plainRunId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    // origin intentionally omitted — the pre-migration-023 shape.
  });

  expect(runs.get(contRunId)!.origin).toBe("continuation");
  expect(runs.get(plainRunId)!.origin ?? null).toBeNull();

  const list = runs.listForTask(taskId);
  const contFromList = list.find((r) => r.id === contRunId)!;
  const plainFromList = list.find((r) => r.id === plainRunId)!;
  expect(contFromList.origin).toBe("continuation");
  expect(plainFromList.origin ?? null).toBeNull();
});
