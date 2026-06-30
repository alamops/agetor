import { test, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-subagents-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

beforeAll(async () => {
  await import("./db.ts");
});

/** Build a temp `<sessionId>/subagents/` layout + a seeded task/run, returning
 *  the jsonlPath the watcher derives the subagents dir from. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-sub-${randomUUID()}`;
  const runId = `run-sub-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], runId,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  // Insert the run as already-terminal: bun test shares one SQLite db across
  // files, and reconcileOrphans() scans every `running` run globally — a
  // lingering `running` row here would pollute reconcile.test.ts. The watcher
  // attaches subagent events by task.runId regardless of the run's status, so
  // this doesn't affect what we're testing.
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

function sidechainLines(): string {
  return [
    JSON.stringify({ type: "user", isSidechain: true, uuid: "u1", message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
  ].join("\n") + "\n";
}

test("discovers a subagent file, tags its events, and emits lifecycle", async () => {
  const { subagents, db } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const agentId = "a1b2c3d4e5f6";
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "Map the thing", toolUseId: "toolu_x", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines());

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  // Registry row created from the meta sidecar, still running.
  const list = subagents.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe(agentId);
  expect(list[0]!.agentType).toBe("Explore");
  expect(list[0]!.description).toBe("Map the thing");
  expect(list[0]!.status).toBe("running");
  expect(list[0]!.runId).toBe(runId);

  // Content events persisted under the parent run, tagged with subagent_id.
  const rows = db.query<{ stream: string; subagent_id: string | null }, [string]>(
    `SELECT stream, subagent_id FROM run_events WHERE run_id = ? AND subagent_id IS NOT NULL ORDER BY id`,
  ).all(runId);
  expect(rows.map((r) => r.stream)).toEqual(["user", "tool_use"]);
  expect(rows.every((r) => r.subagent_id === agentId)).toBe(true);

  // Live emits: one 'subagent' started lifecycle + the tagged content events.
  const started = captured.filter((e) => e.stream === "subagent");
  expect(started.length).toBe(1);
  expect(JSON.parse(started[0]!.data).phase).toBe("started");
  expect(captured.filter((e) => e.stream === "user" || e.stream === "tool_use").every((e) => e.subagentId === agentId)).toBe(true);

  w.detach();
  setSubagentEmitter(null);
});

test("marks a subagent completed after end_turn + idle, without double-emitting on reattach", async () => {
  const { subagents, db } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const agentId = "f6e5d4c3b2a1";
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "work", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines());

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(agentId)!.status).toBe("running");

  // Append the terminal end_turn line, then pump again far enough in the
  // future that the idle threshold elapses → completed.
  appendFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n");
  w.pump(t0 + 1);          // reads the end_turn (sawEndOfTurn=true), still running (not idle yet)
  expect(subagents.get(agentId)!.status).toBe("running");
  w.pump(t0 + 10_000);     // now idle past DONE_IDLE_MS → completed
  const done = subagents.get(agentId)!;
  expect(done.status).toBe("completed");
  expect(done.endedAt).not.toBeNull();
  expect(captured.some((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished")).toBe(true);

  const countBefore = db.query<{ c: number }, [string]>(
    `SELECT COUNT(*) c FROM run_events WHERE subagent_id = ?`,
  ).get(agentId)!.c;
  expect(countBefore).toBe(3); // user + tool_use + assistant(text)

  w.detach();

  // Reattach: a fresh watcher re-tails the same file from offset 0, seeded from
  // the DB dedup set — it must NOT re-insert the already-persisted events.
  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(Date.now());
  const countAfter = db.query<{ c: number }, [string]>(
    `SELECT COUNT(*) c FROM run_events WHERE subagent_id = ?`,
  ).get(agentId)!.c;
  expect(countAfter).toBe(countBefore);
  w2.detach();
  setSubagentEmitter(null);
});

test("a resumed (re-running) subagent is not re-completed until its new turn ends", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const agentId = "resume0a1b2c3";
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "resumable", spawnDepth: 1 }));
  // First turn: ends with end_turn → completes.
  writeFileSync(file,
    JSON.stringify({ type: "user", isSidechain: true, uuid: "ru", message: { role: "user", content: "go" } }) + "\n" +
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "rA", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done turn 1" }] } }) + "\n");

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  w.pump(t0 + 10_000);
  expect(subagents.get(agentId)!.status).toBe("completed");

  // Resume: append a NEW turn that has NOT ended yet (a tool_use, stop_reason
  // "tool_use"). Re-tail via a fresh watcher (reattach path re-reads from 0;
  // the DB-seeded dedup skips the old lines, and the unfinished new line flips
  // the agent back to running).
  appendFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "rB", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] } }) + "\n");
  w.detach();

  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + 10_001);
  expect(subagents.get(agentId)!.status).toBe("running");
  // Idle WITHOUT a fresh end_turn: the reset `sawEndOfTurn` must keep it
  // running (the bug this guards against would re-complete it here).
  w2.pump(t0 + 40_000);
  expect(subagents.get(agentId)!.status).toBe("running");

  // The resumed turn finally ends → completes again.
  appendFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "rC", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done turn 2" }] } }) + "\n");
  w2.pump(t0 + 40_001);
  w2.pump(t0 + 80_000);
  expect(subagents.get(agentId)!.status).toBe("completed");

  w2.detach();
  setSubagentEmitter(null);
});

test("AGETOR_TRACK_SUBAGENTS=0 yields an inert no-op watcher", async () => {
  const prev = process.env.AGETOR_TRACK_SUBAGENTS;
  process.env.AGETOR_TRACK_SUBAGENTS = "0";
  // Re-import fresh so the module-level ENABLED flag re-reads the env.
  const mod = await import(`./claude-subagents.ts?gate=${randomUUID()}`);
  const { subagents } = await import("./db.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  writeFileSync(path.join(subagentsDir, `agent-zzz.meta.json`), JSON.stringify({ agentType: "Explore", description: "x", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-zzz.jsonl`), sidechainLines());
  const w = mod.attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  expect(subagents.listForTask(taskId).length).toBe(0);
  w.detach();
  if (prev === undefined) delete process.env.AGETOR_TRACK_SUBAGENTS;
  else process.env.AGETOR_TRACK_SUBAGENTS = prev;
});
