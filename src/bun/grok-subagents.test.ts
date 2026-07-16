import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent, RunEventStream, SubagentEvent } from "../shared/types.ts";
import type { GrokSubagentLineCtx } from "./grok-tmux.ts";

// db.ts captures AGETOR_DATA_DIR at first import; grok-subagents.ts pulls in
// db.ts transitively. Set a temp dir before importing anything (mirrors
// grok-tmux.test.ts / claude-subagents.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-grok-subagents-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

type LineHook = (update: Record<string, unknown>, ctx: GrokSubagentLineCtx) => void;

// Whatever the orchestrator (or an earlier test file) registered at module
// load — bun test shares one process across files, so hard-resetting these
// to `null` in afterEach would leave every later file with no sink. Capture
// by read-modify-restore and put the originals back (same contract as
// claude-subagents.test.ts).
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;
let originalParkedHook: ((taskId: string) => void) | null = null;
// The real module's registered line hook (`routeSubagentLine`), captured once
// the module has attached at least one manager (which is what registers it
// into grok-tmux.ts's injected slot). Tests dispatch synthetic parsed update
// objects straight through this — the exact same call grok-tmux.ts's
// `dispatchGrokUpdateLine` makes for a `subagent_spawned`/`subagent_finished`
// tag — without ever touching real tmux or a real grok binary.
let dispatchLine: LineHook | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const {
    setGrokSubagentEmitter,
    setGrokSubagentSettleHook,
    setGrokParkedDiscoveryHandler,
    attachGrokSubagentManager,
  } = await import("./grok-subagents.ts");
  const { setGrokSubagentLineHook } = await import("./grok-tmux.ts");

  originalEmitter = setGrokSubagentEmitter(null);
  setGrokSubagentEmitter(originalEmitter);
  originalSettleHook = setGrokSubagentSettleHook(null);
  setGrokSubagentSettleHook(originalSettleHook);
  originalParkedHook = setGrokParkedDiscoveryHandler(null);
  setGrokParkedDiscoveryHandler(originalParkedHook);

  // Force the hook registration (idempotent, once-per-module-instance) via a
  // throwaway attach/dispose against a task id nothing else uses, then
  // capture the now-registered hook by read-modify-restore.
  const warm = attachGrokSubagentManager({
    taskId: `warmup-${randomUUID()}`,
    runId: "warmup-run",
    cwd: "/tmp",
    env: {},
    grokHome: "/tmp",
  });
  warm.dispose();
  const hook = setGrokSubagentLineHook(null);
  setGrokSubagentLineHook(hook);
  dispatchLine = hook as LineHook;
});

const createdTaskIds: string[] = [];
const openHandles: Array<{ dispose(): void }> = [];

afterEach(async () => {
  const { setGrokSubagentEmitter, setGrokSubagentSettleHook, setGrokParkedDiscoveryHandler } =
    await import("./grok-subagents.ts");
  setGrokSubagentEmitter(originalEmitter);
  setGrokSubagentSettleHook(originalSettleHook);
  setGrokParkedDiscoveryHandler(originalParkedHook);
  // Restore the shared grok-tmux.ts hook slot too, in case a test (the kill
  // switch / reattach-after-restart cases) re-imported the module and
  // overwrote it with a throwaway instance's routeSubagentLine.
  const { setGrokSubagentLineHook } = await import("./grok-tmux.ts");
  setGrokSubagentLineHook(dispatchLine);

  for (const h of openHandles.splice(0)) {
    try {
      h.dispose();
    } catch {
      /* best-effort */
    }
  }
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    try {
      tasks.delete(id); // FK ON DELETE CASCADE removes runs/subagents/run_events too
    } catch {
      /* best-effort */
    }
  }
});

/** Seed a task + terminal run row (mirrors claude-subagents.test.ts's `seed()`
 *  — the run is inserted already-`succeeded` so a lingering row can't pollute
 *  reconcile.test.ts's global `runs WHERE status='running'` scan) plus a
 *  fresh temp cwd/GROK_HOME pair for path resolution. */
async function seedGrokTask() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-grok-sub-${randomUUID()}`;
  const runId = `run-grok-sub-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "grok",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], runId,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "grok", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, grokSessionId: null,
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-grok-sub-cwd-"));
  const grokHome = mkdtempSync(path.join(tmpdir(), "agetor-grok-sub-home-"));
  const ctx: GrokSubagentLineCtx = { taskId, runId, cwd, env: {}, grokHome };
  return { taskId, runId, cwd, grokHome, ctx };
}

function updateLine(sessionId: string, update: Record<string, unknown>, timestamp = 1): string {
  return JSON.stringify({ timestamp, method: "session/update", params: { sessionId, update } });
}

async function writeChildUpdatesFile(
  grokHome: string,
  cwd: string,
  childSessionId: string,
  lines: string[],
): Promise<string> {
  const { encodeGrokCwd } = await import("./grok-tmux.ts");
  const encoded = encodeGrokCwd(cwd);
  if (!encoded) throw new Error("test setup: cwd must encode to a short path");
  const dir = path.join(grokHome, "sessions", encoded, childSessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "updates.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * mapGrokUpdateEvent — includeText / keyScope contract used by the child
 * transcript tailer (D3 in the plan).
 * ────────────────────────────────────────────────────────────────────────── */

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function collect() {
  const chunks: Chunk[] = [];
  const onChunk = (stream: RunEventStream, data: string, lineUuid?: string) =>
    chunks.push({ stream, data, lineUuid });
  return { chunks, onChunk };
}

test("mapGrokUpdateEvent: includeText true maps agent_message_chunk -> assistant and agent_thought_chunk -> thinking, keyed am:/at:<keyScope>:<n>", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent(
    { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
    3, onChunk, { includeText: true, keyScope: "child-1" },
  );
  mapGrokUpdateEvent(
    { sessionUpdate: "agent_thought_chunk", text: "pondering" },
    4, onChunk, { includeText: true, keyScope: "child-1" },
  );
  expect(chunks).toEqual([
    { stream: "assistant", data: "hi", lineUuid: "am:child-1:3" },
    { stream: "thinking", data: "pondering", lineUuid: "at:child-1:4" },
  ]);
});

test("mapGrokUpdateEvent: includeText true with empty/missing text emits no chunk", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { text: "" } }, 0, onChunk, { includeText: true });
  mapGrokUpdateEvent({ sessionUpdate: "agent_thought_chunk" }, 0, onChunk, { includeText: true });
  expect(chunks).toHaveLength(0);
});

test("mapGrokUpdateEvent: includeText false (parent stream's call) does NOT emit assistant/thinking for message/thought chunks", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }, 0, onChunk, { includeText: false });
  mapGrokUpdateEvent({ sessionUpdate: "agent_thought_chunk", text: "hmm" }, 0, onChunk);
  expect(chunks).toHaveLength(0);
});

test("mapGrokUpdateEvent: tool_call -> tool_use (+ tool_result when rawOutput present), keys carry the keyScope prefix", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent(
    { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read file", kind: "read", rawInput: { path: "a.txt" }, rawOutput: "contents" },
    0, onChunk, { keyScope: "scope-a" },
  );
  expect(chunks.map((c) => c.lineUuid)).toEqual(["scope-a:tc:tc-1", "scope-a:tcr:tc-1"]);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "Read file", kind: "read", input: { path: "a.txt" } });
  expect(chunks[1]?.stream).toBe("tool_result");
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ content: "contents" });
});

test("mapGrokUpdateEvent: tool_call_update completed/failed -> tool_result with isError from status, keyScope prefixed", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" }, 0, onChunk, { keyScope: "s" });
  mapGrokUpdateEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: "boom" }, 1, onChunk, { keyScope: "s" });
  expect(chunks.map((c) => c.lineUuid)).toEqual(["s:tcu:tc-1:completed", "s:tcu:tc-2:failed"]);
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ content: "ok", isError: false });
  expect(JSON.parse(chunks[1]!.data)).toMatchObject({ content: "boom", isError: true });
});

test("mapGrokUpdateEvent: plan -> tool_use keyed <keyScope>:plan:<lineIndex>", async () => {
  const { mapGrokUpdateEvent } = await import("./grok-tmux.ts");
  const { chunks, onChunk } = collect();
  mapGrokUpdateEvent({ sessionUpdate: "plan", entries: [{ content: "step1" }] }, 7, onChunk, { keyScope: "s" });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.stream).toBe("tool_use");
  expect(chunks[0]?.lineUuid).toBe("s:plan:7");
  expect(JSON.parse(chunks[0]!.data)).toMatchObject({ name: "plan", input: [{ content: "step1" }] });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * subagent_spawned lifecycle
 * ────────────────────────────────────────────────────────────────────────── */

test("subagent_spawned creates a subagents row (fields from payload), emits a 'started' SubagentEvent, and fires parked-discovery", async () => {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, setGrokParkedDiscoveryHandler, attachGrokSubagentManager } =
    await import("./grok-subagents.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  const parkedCalls: string[] = [];
  setGrokParkedDiscoveryHandler((tid) => parkedCalls.push(tid));

  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  const childSessionId = randomUUID(); // no file written yet — sourcePath stays unresolved
  dispatchLine!({
    sessionUpdate: "subagent_spawned",
    subagent_id: subagentId,
    child_session_id: childSessionId,
    subagent_type: "explore",
    description: "look around the repo",
  }, ctx);

  const row = subagents.get(subagentId);
  expect(row).not.toBeNull();
  expect(row!.taskId).toBe(taskId);
  expect(row!.runId).toBe(runId);
  expect(row!.parentKind).toBe("subagent");
  expect(row!.agentType).toBe("explore");
  expect(row!.description).toBe("look around the repo");
  expect(row!.spawnDepth).toBe(1);
  expect(row!.status).toBe("running");
  expect(row!.endedAt).toBeNull();
  expect(row!.sourcePath).toBe(`<unresolved:${childSessionId}>`);

  const started = captured.filter((e) => e.stream === "subagent");
  expect(started.length).toBe(1);
  const payload: SubagentEvent = JSON.parse(started[0]!.data);
  expect(payload.phase).toBe("started");
  expect(payload.subagent.id).toBe(subagentId);
  expect(started[0]!.taskId).toBe(taskId);
  expect(started[0]!.subagentId).toBe(subagentId);

  expect(parkedCalls).toEqual([taskId]);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Child transcript tailer
 * ────────────────────────────────────────────────────────────────────────── */

test("child transcript: tool_call/agent_message_chunk lines tail, persist tagged with subagentId, and emit tagged (malformed lines tolerated)", async () => {
  const { subagents, runs } = await import("./db.ts");
  const { setGrokSubagentEmitter, attachGrokSubagentManager } = await import("./grok-subagents.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  const childSessionId = randomUUID();
  await writeChildUpdatesFile(ctx.grokHome, ctx.cwd, childSessionId, [
    updateLine(childSessionId, { sessionUpdate: "agent_message_chunk", content: { text: "hi from child" } }, 1),
    "{not valid json",
    updateLine(childSessionId, { sessionUpdate: "tool_call", toolCallId: "ctc-1", title: "Read", kind: "read", rawInput: { path: "x" } }, 2),
  ]);

  dispatchLine!({
    sessionUpdate: "subagent_spawned",
    subagent_id: subagentId,
    child_session_id: childSessionId,
    subagent_type: "general-purpose",
    description: "child work",
  }, ctx);

  const row = subagents.get(subagentId)!;
  expect(row.sourcePath.endsWith(path.join(childSessionId, "updates.jsonl"))).toBe(true);

  const persisted = runs.events(runId).filter((e) => e.subagentId === subagentId);
  expect(persisted.map((e) => e.stream)).toEqual(["assistant", "tool_use"]);
  expect(persisted[0]!.data).toBe("hi from child");
  expect(JSON.parse(persisted[1]!.data)).toMatchObject({ name: "Read", kind: "read" });

  const emittedContent = captured.filter((e) => e.stream === "assistant" || e.stream === "tool_use");
  expect(emittedContent.length).toBe(2);
  expect(emittedContent.every((e) => e.subagentId === subagentId && e.runId === runId)).toBe(true);
});

test("child transcript: a re-attach after a simulated process restart re-tails from offset 0 but dedups already-persisted content (still-running row)", async () => {
  const { subagents, runs } = await import("./db.ts");
  const { setGrokSubagentEmitter, attachGrokSubagentManager } = await import("./grok-subagents.ts");
  const { setGrokSubagentLineHook } = await import("./grok-tmux.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  const childSessionId = randomUUID();
  await writeChildUpdatesFile(ctx.grokHome, ctx.cwd, childSessionId, [
    updateLine(childSessionId, { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }, 1),
    updateLine(childSessionId, { sessionUpdate: "tool_call", toolCallId: "ctc-1", title: "Read" }, 2),
  ]);
  const spawnEvt = {
    sessionUpdate: "subagent_spawned", subagent_id: subagentId, child_session_id: childSessionId,
    subagent_type: "explore", description: "d",
  };
  dispatchLine!(spawnEvt, ctx);

  const before = runs.events(runId).filter((e) => e.subagentId === subagentId);
  expect(before.length).toBe(2);
  expect(subagents.get(subagentId)!.status).toBe("running");

  // Simulate an agetor restart: a FRESH module instance (empty in-memory
  // managers map — nothing to detach/orphan), against the SAME shared DB, so
  // the still-`running` row (and its persisted line_uuids) survive.
  const fresh = await import(`./grok-subagents.ts?reattach=${randomUUID()}`);
  const capturedFresh: RunEvent[] = [];
  fresh.setGrokSubagentEmitter((e: RunEvent) => capturedFresh.push(e));
  openHandles.push(fresh.attachGrokSubagentManager(ctx));
  const freshHook = setGrokSubagentLineHook(null);
  setGrokSubagentLineHook(freshHook); // read-modify-restore: capture without changing it
  freshHook!(spawnEvt, ctx); // replay the same spawn line, as the parent tailer would from offset 0

  const after = runs.events(runId).filter((e) => e.subagentId === subagentId);
  expect(after.length).toBe(2); // no duplicate persisted rows

  // A still-running row's guard only blocks a TERMINAL re-spawn (see the
  // idempotency test below) — a "started" lifecycle re-fires here, but no
  // content chunk does (DB-seeded dedup set already has both keys).
  expect(capturedFresh.some((e) => e.stream === "subagent")).toBe(true);
  expect(capturedFresh.filter((e) => e.stream !== "subagent").length).toBe(0);

  fresh.setGrokSubagentEmitter(null);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * subagent_finished — status mapping + settle
 * ────────────────────────────────────────────────────────────────────────── */

async function spawnThenFinish(rawStatus: string | undefined) {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, setGrokSubagentSettleHook, attachGrokSubagentManager } =
    await import("./grok-subagents.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setGrokSubagentSettleHook((tid) => settleCalls.push(tid));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  dispatchLine!({
    sessionUpdate: "subagent_spawned", subagent_id: subagentId, child_session_id: null,
    subagent_type: "explore", description: "d",
  }, ctx);
  expect(subagents.get(subagentId)!.status).toBe("running");

  const finishEvt: Record<string, unknown> = { sessionUpdate: "subagent_finished", subagent_id: subagentId };
  if (rawStatus !== undefined) finishEvt.status = rawStatus;
  dispatchLine!(finishEvt, ctx);

  const row = subagents.get(subagentId)!;
  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  return { row, finished, settleCalls, taskId, subagentId };
}

test("subagent_finished status='completed' settles the row completed, emits 'finished', and fires the settle hook", async () => {
  const { row, finished, settleCalls, taskId } = await spawnThenFinish("completed");
  expect(row.status).toBe("completed");
  expect(row.endedAt).not.toBeNull();
  expect(finished.length).toBe(1);
  expect(settleCalls).toEqual([taskId]);
});

test("subagent_finished status='cancelled' settles the row cancelled", async () => {
  const { row } = await spawnThenFinish("cancelled");
  expect(row.status).toBe("cancelled");
});

test("subagent_finished status='failed' settles the row failed", async () => {
  const { row } = await spawnThenFinish("failed");
  expect(row.status).toBe("failed");
});

test("subagent_finished with an unrecognized/missing status settles conservatively as 'failed' (D6)", async () => {
  const unknown = await spawnThenFinish("something-new-xai-invented");
  expect(unknown.row.status).toBe("failed");
  const missing = await spawnThenFinish(undefined);
  expect(missing.row.status).toBe("failed");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Reattach idempotency (the review fix) — a finished subagent must not be
 * resurrected by a replayed spawn line.
 * ────────────────────────────────────────────────────────────────────────── */

test("re-dispatching subagent_spawned for an already-finished subagent does not re-emit 'started' or flip the row back to running", async () => {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, attachGrokSubagentManager } = await import("./grok-subagents.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  const spawnEvt = {
    sessionUpdate: "subagent_spawned", subagent_id: subagentId, child_session_id: null,
    subagent_type: "explore", description: "d",
  };
  dispatchLine!(spawnEvt, ctx);
  dispatchLine!({ sessionUpdate: "subagent_finished", subagent_id: subagentId, status: "completed" }, ctx);
  expect(subagents.get(subagentId)!.status).toBe("completed");
  const endedAtAfterFinish = subagents.get(subagentId)!.endedAt;

  const startedBefore = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "started").length;
  expect(startedBefore).toBe(1);

  // Reattach replay: the parent's spawn line re-dispatches (offset-0 tail).
  dispatchLine!(spawnEvt, ctx);

  const startedAfter = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "started").length;
  expect(startedAfter).toBe(startedBefore); // no second "started"
  const row = subagents.get(subagentId)!;
  expect(row.status).toBe("completed"); // not flipped back to running
  expect(row.endedAt).toBe(endedAtAfterFinish);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Defensive parsing (D6)
 * ────────────────────────────────────────────────────────────────────────── */

test("a spawn/finish line missing subagent_id is a silent no-op (no row, no event, no throw)", async () => {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, attachGrokSubagentManager } = await import("./grok-subagents.ts");
  const { taskId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  openHandles.push(attachGrokSubagentManager(ctx));

  expect(() => dispatchLine!({ sessionUpdate: "subagent_spawned", child_session_id: randomUUID(), subagent_type: "explore" }, ctx)).not.toThrow();
  expect(() => dispatchLine!({ sessionUpdate: "subagent_finished", status: "completed" }, ctx)).not.toThrow();

  expect(subagents.listForTask(taskId).length).toBe(0);
  expect(captured.length).toBe(0);
});

test("a spawn line missing child_session_id creates a row with a placeholder sourcePath and never starts a child tail", async () => {
  const { subagents, runs } = await import("./db.ts");
  const { setGrokSubagentEmitter, attachGrokSubagentManager } = await import("./grok-subagents.ts");
  const { taskId, runId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  expect(() => dispatchLine!({
    sessionUpdate: "subagent_spawned", subagent_id: subagentId,
    subagent_type: "explore", description: "no child session",
  }, ctx)).not.toThrow();

  const row = subagents.get(subagentId)!;
  expect(row.status).toBe("running");
  expect(row.sourcePath).toBe("<unresolved:no-child-session-id>");
  expect(runs.events(runId).filter((e) => e.subagentId === subagentId).length).toBe(0);

  // Finishing it afterward must not throw either (no tailer was ever armed).
  expect(() => dispatchLine!({ sessionUpdate: "subagent_finished", subagent_id: subagentId, status: "completed" }, ctx)).not.toThrow();
  expect(subagents.get(subagentId)!.status).toBe("completed");
});

test("a subagent_finished with no prior spawn settles idempotently without throwing (and creates no row)", async () => {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, setGrokSubagentSettleHook, attachGrokSubagentManager } =
    await import("./grok-subagents.ts");
  const { taskId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setGrokSubagentSettleHook((tid) => settleCalls.push(tid));
  openHandles.push(attachGrokSubagentManager(ctx));

  const subagentId = randomUUID();
  expect(() => dispatchLine!({ sessionUpdate: "subagent_finished", subagent_id: subagentId, status: "completed" }, ctx)).not.toThrow();

  expect(subagents.get(subagentId)).toBeNull();
  expect(captured.length).toBe(0);
  expect(settleCalls.length).toBe(0);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Teardown parity: disposing a manager orphans its still-running children.
 * ────────────────────────────────────────────────────────────────────────── */

test("disposing a manager orphans any still-running subagent rows and fires the settle hook once", async () => {
  const { subagents } = await import("./db.ts");
  const { setGrokSubagentEmitter, setGrokSubagentSettleHook, attachGrokSubagentManager } =
    await import("./grok-subagents.ts");
  const { taskId, ctx } = await seedGrokTask();

  const captured: RunEvent[] = [];
  setGrokSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setGrokSubagentSettleHook((tid) => settleCalls.push(tid));

  const handle = attachGrokSubagentManager(ctx);
  const subagentId = randomUUID();
  dispatchLine!({
    sessionUpdate: "subagent_spawned", subagent_id: subagentId, child_session_id: null,
    subagent_type: "explore", description: "still running at teardown",
  }, ctx);
  expect(subagents.get(subagentId)!.status).toBe("running");

  handle.dispose(); // task's turn ended without a subagent_finished ever arriving

  const row = subagents.get(subagentId)!;
  expect(row.status).toBe("orphaned");
  expect(row.endedAt).not.toBeNull();
  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(1);
  expect(settleCalls).toEqual([taskId]);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Kill switch
 * ────────────────────────────────────────────────────────────────────────── */

test("AGETOR_GROK_TRACK_SUBAGENTS=0 yields a no-op attach: no rows, no events", async () => {
  const prev = process.env.AGETOR_GROK_TRACK_SUBAGENTS;
  process.env.AGETOR_GROK_TRACK_SUBAGENTS = "0";
  try {
    const mod = await import(`./grok-subagents.ts?killswitch=${randomUUID()}`);
    const { setGrokSubagentLineHook } = await import("./grok-tmux.ts");
    const { subagents } = await import("./db.ts");
    const { taskId, ctx } = await seedGrokTask();

    const captured: RunEvent[] = [];
    mod.setGrokSubagentEmitter((e: RunEvent) => captured.push(e));

    const handle = mod.attachGrokSubagentManager(ctx);
    openHandles.push(handle);

    // Dispatch through whatever hook is now registered (this module's own
    // `ensureLineHookRegistered` ran during attach, even though tracking is
    // disabled) — its managers map was never populated, so this is a no-op.
    const hookNow = setGrokSubagentLineHook(null);
    setGrokSubagentLineHook(hookNow);
    hookNow!({
      sessionUpdate: "subagent_spawned", subagent_id: randomUUID(), child_session_id: null,
      subagent_type: "explore", description: "should never land",
    }, ctx);

    expect(subagents.listForTask(taskId).length).toBe(0);
    expect(captured.length).toBe(0);

    mod.setGrokSubagentEmitter(null);
  } finally {
    if (prev === undefined) delete process.env.AGETOR_GROK_TRACK_SUBAGENTS;
    else process.env.AGETOR_GROK_TRACK_SUBAGENTS = prev;
    // Restore the shared hook back to the real module's routeSubagentLine —
    // this re-import's own ensureLineHookRegistered() call overwrote it.
    const { setGrokSubagentLineHook } = await import("./grok-tmux.ts");
    setGrokSubagentLineHook(dispatchLine);
  }
});
