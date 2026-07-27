/* ────────────────────────────────────────────────────────────────────────── *
 * Third settle signal: parent-transcript tool_result correlation.
 *
 * A synchronous top-level subagent can finish WITHOUT claude ever writing the
 * terminal `stop_reason:"end_turn"` line to its own JSONL (observed live on
 * claude 2.1.210 under concurrent subagent load), and it gets no
 * <task-notification> either — so both classic settle signals no-op and the
 * row wedged at `running` forever. `scanMainForToolResults` closes that gap
 * by matching the MAIN session JSONL's `tool_result` blocks against each
 * tracked subagent's `toolUseId` (from its meta sidecar). These tests pin the
 * scan's settle path, the boot-time backfill repair, its false-positive
 * guards, and the offset-rewind for late-discovered agents.
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-toolresult-settle-"));
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
  const taskId = `task-trs-${randomUUID()}`;
  const runId = `run-trs-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], draft: null, runId,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/** The real-world stuck shape: a transcript whose LAST line is an assistant
 *  text block with stop_reason:null — no terminal end_turn line, ever. */
function stuckSidechainLines(): string {
  return [
    JSON.stringify({ type: "user", isSidechain: true, uuid: `u-${randomUUID()}`, message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: `a-${randomUUID()}`, message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "final answer, but the terminal line never flushed" }] } }),
  ].join("\n") + "\n";
}

function writeSubagent(subagentsDir: string, agentId: string, toolUseId: string | null): string {
  const meta: Record<string, unknown> = { agentType: "general-purpose", description: "work", spawnDepth: 1 };
  if (toolUseId !== null) meta.toolUseId = toolUseId;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(file, stuckSidechainLines());
  return file;
}

/** A main-session user line carrying the tool_result for `toolUseId`. */
function toolResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: "user", uuid: `u-tr-${randomUUID()}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "done" }] }] },
  }) + "\n";
}

/** A main-session assistant line LAUNCHING the agent — contains the id string
 *  but must never settle anything. */
function toolUseLaunchLine(toolUseId: string): string {
  return JSON.stringify({
    type: "assistant", uuid: `a-tu-${randomUUID()}`,
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "work", prompt: "go" } }] },
  }) + "\n";
}

/** A queue-operation notification whose <tool-use-id> tag contains the id
 *  string — the other substring false-positive the strict parse must reject. */
function notificationLine(toolUseId: string): string {
  return JSON.stringify({
    type: "queue-operation", operation: "enqueue", uuid: null,
    content: `<task-notification>\n<task-id>someotheragent</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  }) + "\n";
}

test("settles a subagent whose own file never got end_turn once the main JSONL shows its tool_result; replay pumps stay idempotent", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `stuck-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  writeSubagent(subagentsDir, agentId, toolUseId);
  writeFileSync(jsonlPath, toolUseLaunchLine(toolUseId));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  // No end_turn in its own file, no tool_result yet — must stay running even
  // way past the idle threshold (this is exactly the pre-fix wedged state).
  w.pump(t0 + 60_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(settleCalls.length).toBe(0);

  // The parent's completion receipt lands in the MAIN transcript.
  appendFileSync(jsonlPath, toolResultLine(toolUseId));
  w.pump(t0 + 60_001);
  const settled = subagents.get(agentId)!;
  expect(settled.status).toBe("completed");
  expect(settled.endedAt).not.toBeNull();
  expect(settleCalls).toEqual([taskId]);
  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(1);
  expect(finished[0]!.subagentId).toBe(agentId);

  // Idempotency: further pumps re-read nothing and must not re-settle/re-emit.
  w.pump(t0 + 120_000);
  w.pump(t0 + 180_000);
  expect(settleCalls).toEqual([taskId]);
  expect(captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished").length).toBe(1);

  w.detach();
});

test("boot repair: a pre-fix running row with NULL tool_use_id is backfilled from the meta sidecar and settled by the offset-0 scan", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `bootfix-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  const file = writeSubagent(subagentsDir, agentId, toolUseId);

  // Simulate a row created by a pre-027 build: running, no tool_use_id.
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "work", spawnDepth: 1,
    sourcePath: file, status: "running", startedAt: Date.now() - 60_000, endedAt: null,
  });
  expect(subagents.get(agentId)!.toolUseId ?? null).toBeNull();

  // The completion receipt is ALREADY in the main transcript (it arrived while
  // the old build was running — and was ignored).
  writeFileSync(jsonlPath, toolUseLaunchLine(toolUseId) + toolResultLine(toolUseId));

  // Fresh attach = the boot path (orchestrator's held-task pass arms exactly
  // this): rehydrate → backfill from meta → first-cycle scan from offset 0.
  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  const row = subagents.get(agentId)!;
  expect(row.toolUseId).toBe(toolUseId);
  expect(row.status).toBe("completed");
  expect(settleCalls).toEqual([taskId]);

  w.detach();
});

test("no false settle: the launching tool_use line and a <tool-use-id> notification tag contain the id string but must not match", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentId = `nofalse-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  writeSubagent(subagentsDir, agentId, toolUseId);
  // Both substring-hit shapes, plus a tool_result for a DIFFERENT tool call —
  // none may settle this agent.
  writeFileSync(jsonlPath,
    toolUseLaunchLine(toolUseId) + notificationLine(toolUseId) + toolResultLine(`toolu_other_${randomUUID()}`));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  w.pump(t0 + 60_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(settleCalls.length).toBe(0);

  w.detach();
});

test("meta without toolUseId degrades gracefully: unaffected by tool_results, still settleable via the classic end_turn path", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const agentId = `nometa-${randomUUID()}`;
  const file = writeSubagent(subagentsDir, agentId, null); // sidecar has no toolUseId field
  writeFileSync(jsonlPath, toolResultLine(`toolu_unrelated_${randomUUID()}`));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  w.pump(t0 + 30_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(subagents.get(agentId)!.toolUseId ?? null).toBeNull();

  // The classic path still works for it.
  appendFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: `end-${randomUUID()}`, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n");
  w.pump(t0 + 30_001);
  w.pump(t0 + 90_000);
  expect(subagents.get(agentId)!.status).toBe("completed");

  w.detach();
});

test("resume flip-back: a tool_result-settled subagent whose file grows again returns to running", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const agentId = `resume-${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  const file = writeSubagent(subagentsDir, agentId, toolUseId);
  writeFileSync(jsonlPath, toolResultLine(toolUseId));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  expect(subagents.get(agentId)!.status).toBe("completed");

  // Resume: new turn appended. Steady-state pumps skip completed files (the
  // production dir-watcher covers this); mirror the module's own resume test
  // by re-attaching, whose first cycle tails everything.
  appendFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: `r-${randomUUID()}`, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] } }) + "\n");
  w.detach();
  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t1 = Date.now();
  w2.pump(t1);
  expect(subagents.get(agentId)!.status).toBe("running");
  expect(captured.some((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "started" && e.subagentId === agentId)).toBe(true);
  // The flip-back retires the correlation key, so the stale tool_result
  // (re-served by the fresh watcher's offset-0 replay) can never re-settle
  // the resumed agent — not on this pump, not on later ones.
  w2.pump(t1 + 60_000);
  expect(subagents.get(agentId)!.status).toBe("running");
  // Its real completion still lands via its own end_turn.
  appendFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: `r2-${randomUUID()}`, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "resumed turn done" }] } }) + "\n");
  w2.pump(t1 + 60_001);
  w2.pump(t1 + 120_000);
  expect(subagents.get(agentId)!.status).toBe("completed");
  w2.detach();
});

test("late discovery rewinds the scan: a tool_result consumed before its agent's file existed still settles it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const agentA = `late-a-${randomUUID()}`;
  const toolUseA = `toolu_A_${randomUUID()}`;
  const agentB = `late-b-${randomUUID()}`;
  const toolUseB = `toolu_B_${randomUUID()}`;

  // Only A exists on disk; the main JSONL already carries B's tool_result.
  writeSubagent(subagentsDir, agentA, toolUseA);
  writeFileSync(jsonlPath, toolResultLine(toolUseB));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // A pending → scan reads (and passes) B's tool_result
  expect(subagents.get(agentA)!.status).toBe("running");

  // B's file materializes late (readdir-visibility race). discover() must
  // rewind the scan offset so B's already-consumed tool_result is re-read.
  writeSubagent(subagentsDir, agentB, toolUseB);
  w.pump(t0 + 1);
  expect(subagents.get(agentB)!.status).toBe("completed");
  expect(subagents.get(agentA)!.status).toBe("running"); // no collateral settle
  expect(settleCalls).toEqual([taskId]);

  w.detach();
});

test("subagents.setToolUseId fills only NULL and tool_use_id round-trips through insertIfAbsent", async () => {
  const { subagents } = await import("./db.ts");
  const { taskId, runId } = await seed();
  const now = Date.now();

  const idNull = `db-null-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: idNull, taskId, runId, parentKind: "subagent", agentType: "Explore",
    description: "x", spawnDepth: 1, sourcePath: "/tmp/x.jsonl",
    status: "running", startedAt: now, endedAt: null,
  });
  expect(subagents.get(idNull)!.toolUseId ?? null).toBeNull();
  subagents.setToolUseId(idNull, "toolu_first");
  expect(subagents.get(idNull)!.toolUseId).toBe("toolu_first");
  // Backfill-only: a second write must not clobber.
  subagents.setToolUseId(idNull, "toolu_second");
  expect(subagents.get(idNull)!.toolUseId).toBe("toolu_first");

  const idFull = `db-full-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: idFull, taskId, runId, parentKind: "subagent", agentType: "Explore",
    description: "y", spawnDepth: 1, sourcePath: "/tmp/y.jsonl",
    status: "running", startedAt: now, endedAt: null, toolUseId: "toolu_direct",
  });
  expect(subagents.get(idFull)!.toolUseId).toBe("toolu_direct");
});
