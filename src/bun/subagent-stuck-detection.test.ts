/* ────────────────────────────────────────────────────────────────────────── *
 * Regression tests for the "stuck subagent stays running forever" fix
 * (docs/plans/fix-stuck-subagent-running-detection.md). Four compounding
 * defects (D1-D3 in the plan) let a subagent row wedge at `status='running'`
 * even after its agent had genuinely finished, holding the parent task's card
 * in `running` forever. Four fixes close the gap, each pinned here:
 *
 *   W1 — replay floor: a batch that starts BELOW `FileState.replayFloor`
 *        (the source file's size at attach/rehydration) can never flip a
 *        settled row back to `running` — it's replayed history, not a
 *        genuine resume. Bytes at/beyond the floor behave exactly as before.
 *   W2 — async-stub guard: `Agent(run_in_background:true)`'s immediate
 *        `tool_result` (`toolUseResult.status === "async_launched"`) is a
 *        launch acknowledgement, not a completion — `scanLineForToolResult`
 *        must not settle on it, only mark the row async and retire its
 *        `toolUseId`.
 *   W3 — generalized notification backstop: `scanLineForTaskNotification`
 *        also settles an ordinary tracked (`files`) row, not just a workflow
 *        container — the only restart-safe path left for an async agent once
 *        claude-tmux's one-shot live dispatch is gone.
 *   W4 — staleness backstop: a `running` row that never latched
 *        `sawEndOfTurn` and has produced no new bytes for
 *        `AGETOR_SUBAGENT_STALE_MS` (default 10 min) settles `completed` as
 *        a last resort; a genuine later append flips it back via W1.
 *
 * Harness mirrors subagent-toolresult-settle.test.ts exactly: mkdtemp
 * AGETOR_DATA_DIR before importing db.ts, save/restore the process-wide
 * emitter/settle/parked hooks (bun test shares one process across files),
 * per-test `seed()`, and `attachSubagentWatcher({ manual: true })` driven by
 * `w.pump(t)` so timing is deterministic instead of racing real timers.
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-stuck-detection-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Save/restore the process-wide injected hooks (bun test shares one process
// across files — see claude-subagents.test.ts for the full rationale).
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;
let originalParkedHandler: ((taskId: string) => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { setSubagentEmitter, setSubagentSettleHook, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
  originalSettleHook = setSubagentSettleHook(null);
  setSubagentSettleHook(originalSettleHook);
  originalParkedHandler = setParkedDiscoveryHandler(null);
  setParkedDiscoveryHandler(originalParkedHandler);
});

const createdTaskIds: string[] = [];

afterEach(async () => {
  const { detachWatcherFor, setSubagentEmitter, setSubagentSettleHook, setParkedDiscoveryHandler } =
    await import("./claude-subagents.ts");
  setSubagentEmitter(originalEmitter);
  setSubagentSettleHook(originalSettleHook);
  setParkedDiscoveryHandler(originalParkedHandler);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try { detachWatcherFor(id); } catch { /* best-effort */ }
    try { tasks.delete(id); } catch { /* best-effort */ }
  }
  createdTaskIds.length = 0;
});

/** Temp `<sessionId>/subagents/` layout + seeded task/run (run pre-terminal so
 *  a leaked row can't pollute reconcile.test.ts's global scan — same trap as
 *  claude-subagents.test.ts documents on its own `seed`). */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-sd-${randomUUID()}`;
  const runId = `run-sd-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, geminiSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/** The real-world stuck shape: a transcript whose LAST line is an assistant
 *  text block with stop_reason:null — no terminal end_turn line, ever (the
 *  claude flush-loss class the whole plan is about). */
function stuckSidechainLines(): string {
  return [
    JSON.stringify({ type: "user", isSidechain: true, uuid: `u-${randomUUID()}`, message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: `a-${randomUUID()}`, message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "final answer, but the terminal line never flushed" }] } }),
  ].join("\n") + "\n";
}

/** An assistant line representing a genuinely-still-alive agent continuing to
 *  work — fresh uuid, no end_turn, used to prove a resume flips a settled row
 *  back to `running` without itself re-settling anything. */
function continuingTurnLine(): string {
  return JSON.stringify({
    type: "assistant", isSidechain: true, uuid: `c-${randomUUID()}`,
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${randomUUID()}`, name: "Bash", input: { command: "ls" } }] },
  }) + "\n";
}

function writeSubagent(subagentsDir: string, agentId: string, toolUseId: string | null): string {
  const meta: Record<string, unknown> = { agentType: "general-purpose", description: "work", spawnDepth: 1 };
  if (toolUseId !== null) meta.toolUseId = toolUseId;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(file, stuckSidechainLines());
  return file;
}

/** The `Agent(run_in_background:true)` immediate launch acknowledgement — NOT
 *  a completion (W2's target shape). */
function asyncStubLine(toolUseId: string, agentId: string): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-stub-${randomUUID()}`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "Async agent launched successfully." }] }],
    },
    toolUseResult: { isAsync: true, status: "async_launched", agentId },
  }) + "\n";
}

/** A main-session line carrying the REAL tool_result for `toolUseId` — full
 *  content, no `toolUseResult` async-stub marker (signal (3), synchronous
 *  subagent path). */
function toolResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: "user", uuid: `u-tr-${randomUUID()}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "done" }] }] },
  }) + "\n";
}

/** A `<task-notification>` completion receipt naming `id` — either a workflow
 *  container id or (post-W3) an ordinary tracked subagent id. */
function notificationLine(id: string): string {
  return JSON.stringify({
    type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
  }) + "\n";
}

test("W2: an async-launch tool_result stub does not settle the row (only a real tool_result may)", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `async-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  writeSubagent(subagentsDir, agentId, toolUseId);

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // discovers the file — row starts running
  expect(subagents.get(agentId)!.status).toBe("running");

  appendFileSync(jsonlPath, asyncStubLine(toolUseId, agentId));
  w.pump(t0 + 1);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(settleCalls.length).toBe(0);

  // Even well past the classic idle window, the stub alone must never settle it.
  w.pump(t0 + 60_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(settleCalls.length).toBe(0);

  w.detach();
});

test("W2 + W3: after the async stub retires the tool_result key, a queue-operation notification settles the row and stays settled", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `lifecycle-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  writeSubagent(subagentsDir, agentId, toolUseId);

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(agentId)!.status).toBe("running");

  appendFileSync(jsonlPath, asyncStubLine(toolUseId, agentId));
  w.pump(t0 + 1);
  expect(subagents.get(agentId)!.status).toBe("running");

  // The queue-operation notification is the async agent's real completion
  // receipt — AID matches the subagent row's own id.
  appendFileSync(jsonlPath, notificationLine(agentId));
  w.pump(t0 + 2);
  const settled = subagents.get(agentId)!;
  expect(settled.status).toBe("completed");
  expect(settled.endedAt).not.toBeNull();
  expect(settleCalls).toEqual([taskId]);
  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(1);
  expect(finished[0]!.subagentId).toBe(agentId);

  // Further pumps must not re-settle or re-emit.
  w.pump(t0 + 60_000);
  w.pump(t0 + 120_000);
  expect(subagents.get(agentId)!.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);
  expect(captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished").length).toBe(1);

  w.detach();
});

test("W3 restart-safe: a notification already on disk before attach settles a pre-existing running row on the first pump", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `restart-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  const file = writeSubagent(subagentsDir, agentId, toolUseId);

  // Row already `running` as of a prior process (boot reattach scenario) —
  // async stub already resolved, real toolUseId already retired in that
  // prior process too, so only the notification backstop can close it.
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "work", spawnDepth: 1,
    sourcePath: file, status: "running", startedAt: Date.now() - 60_000, endedAt: null,
  });

  // The completion receipt already landed in the main transcript before
  // agetor restarted — nothing live is around to have dispatched it.
  writeFileSync(jsonlPath, notificationLine(agentId));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);

  // Idempotent on later pumps too.
  w.pump(Date.now() + 1);
  expect(subagents.get(agentId)!.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);

  w.detach();
});

test("W1: a completed row's pre-existing unseen-uuid line does not resurrect it on rehydration", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const agentId = `w1-noresurrect-${randomUUID()}`;
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "work", spawnDepth: 1 }));
  // The transcript already has content with uuids run_events never persisted
  // (this row was never tailed by this process before) — the exact shape of
  // the D2 "mapper-silent line" resurrection bug.
  writeFileSync(file, stuckSidechainLines());

  const now = Date.now();
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "work", spawnDepth: 1,
    sourcePath: file, status: "completed", startedAt: now - 120_000, endedAt: now - 60_000,
  });

  // Fresh attach = rehydration path: replayFloor is pinned to the file's
  // CURRENT size, so everything already on disk reads as replay.
  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  w.pump(t0 + 5_000);
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  const started = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "started");
  expect(started.length).toBe(0);

  w.detach();
});

test("W1: bytes appended AFTER attach (beyond the replay floor) still flip a completed row back to running", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const agentId = `w1-resume-${randomUUID()}`;
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "work", spawnDepth: 1 }));
  writeFileSync(file, stuckSidechainLines());

  const now = Date.now();
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "work", spawnDepth: 1,
    sourcePath: file, status: "completed", startedAt: now - 120_000, endedAt: now - 60_000,
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // pure replay — stays completed (pinned by the previous test too)
  expect(subagents.get(agentId)!.status).toBe("completed");

  // Genuinely new bytes, appended after the watcher's offset already caught
  // up to the replay floor. Deterministic via a plain `pump()` (fix 3's poll
  // backstop): a non-`running` file-backed row gets a cheap `statSync` check
  // every cycle, so resume detection no longer depends on the real
  // `fs.watch` dir watcher firing its async callback.
  appendFileSync(file, continuingTurnLine());
  w.pump(t0 + 1);
  expect(subagents.get(agentId)!.status).toBe("running");
  const started = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "started");
  expect(started.length).toBe(1);
  expect(started[0]!.subagentId).toBe(agentId);

  w.detach();
});

test("W4: a running row with no end_turn and no signals on disk settles completed after the stale threshold, then self-corrects on a genuine later append", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `stale-${randomUUID()}`;
  // No toolUseId — no async/sync tool_result fallback either; and no main
  // JSONL content at all — no notification. Staleness is the ONLY signal
  // left that can ever close this row.
  const file = writeSubagent(subagentsDir, agentId, null);

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // discovers the file, running
  expect(subagents.get(agentId)!.status).toBe("running");

  w.pump(t0 + 11 * 60_000);
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);

  // Self-correction: the agent turns out to still be alive after all.
  // Deterministic via a plain `pump()` (fix 3's poll backstop) instead of
  // waiting on the real directory watcher. Pumped with the REAL current time
  // (no synthetic huge offset) rather than continuing to advance the
  // synthetic clock: `checkStale` runs in the same `cycle()` pass as the
  // tail that flips this row back to `running`, and `lastAppendAt` is always
  // stamped with the real wall clock (see `tailFile`) — so pumping with a
  // `now` still 11 synthetic minutes ahead of real time would make the row
  // look stale again the instant it flips, undoing the very resume this
  // assertion is checking for.
  appendFileSync(file, continuingTurnLine());
  w.pump();
  expect(subagents.get(agentId)!.status).toBe("running");

  w.detach();
});

test("W4: does not fire before the stale threshold", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `notyet-${randomUUID()}`;
  writeSubagent(subagentsDir, agentId, null);

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(agentId)!.status).toBe("running");

  w.pump(t0 + 5 * 60_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(settleCalls.length).toBe(0);

  w.detach();
});

test("end-to-end T4 scenario: a stuck sync subagent settles via the real tool_result signal and stays settled across a second fresh reattach (no oscillation)", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `t4-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  const file = writeSubagent(subagentsDir, agentId, toolUseId);

  // Pre-existing running row — the exact shape of the reported prod tasks:
  // discovered by a prior process, own transcript never got end_turn
  // (stop_reason:null), no async marker anywhere.
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "work", spawnDepth: 1,
    sourcePath: file, status: "running", startedAt: Date.now() - 120_000, endedAt: null,
    toolUseId,
  });

  // The real completion tool_result already sits in the main transcript
  // since before this attach — full content, no toolUseResult stub marker.
  writeFileSync(jsonlPath, toolResultLine(toolUseId));

  const w1 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w1.pump(Date.now());
  expect(subagents.get(agentId)!.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);
  w1.detach();

  // A SECOND fresh watcher attach (agetor restarts again) must not resurrect
  // it — this is the regression test for the prod bug: replayed history read
  // from offset 0 on every reattach used to flip a completed row back to
  // running via `tailFile`'s resume-detection (D2 in the plan doc).
  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t1 = Date.now();
  w2.pump(t1);
  w2.pump(t1 + 1_000);
  w2.pump(t1 + 60_000);
  expect(subagents.get(agentId)!.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]); // never re-fired
  w2.detach();
});
