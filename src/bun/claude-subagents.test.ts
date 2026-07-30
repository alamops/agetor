import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent, Subagent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-subagents-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Whatever the orchestrator registered at its module load (or `null` if this
// file runs before it). `bun test` shares one process across every file, so
// hard-resetting these to `null` in `afterEach` would leave every later file
// with no SSE sink and no release path — a held task would never reach
// `review`. Capture by read-modify-restore and put the originals back.
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { setSubagentEmitter, setSubagentSettleHook } = await import("./claude-subagents.ts");
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
  originalSettleHook = setSubagentSettleHook(null);
  setSubagentSettleHook(originalSettleHook);
});

// Every task `seed()` creates is tracked here and torn down in the global
// `afterEach` below. THE TRAP: `seed()` always inserts the task with
// `column: "running"` and the run as `status: "succeeded"` — exactly the
// shape `reconcileOrphans`'s held-task sweep (orchestrator.ts) looks for
// (task.column==='running' && run.status==='succeeded' && a claude-code
// agent). Combined with a `running` subagent row (which several tests below
// create), a task left behind here would get silently swept into `review`
// by any later `reconcileOrphans()` call — including one from
// reconcile.test.ts, which shares this same process's SQLite db. Deleting
// the task row (FK ON DELETE CASCADE on runs/subagents/run_events, verified
// live via `PRAGMA foreign_keys = ON` in db.ts) removes it from every scan.
const createdTaskIds: string[] = [];

afterEach(async () => {
  const { detachWatcherFor, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  setSubagentEmitter(originalEmitter);
  setSubagentSettleHook(originalSettleHook);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try {
      detachWatcherFor(id);
    } catch {
      /* best-effort */
    }
    try {
      tasks.delete(id);
    } catch {
      /* best-effort */
    }
  }
  createdTaskIds.length = 0;
});

/** Build a temp `<sessionId>/subagents/` layout + a seeded task/run, returning
 *  the jsonlPath the watcher derives the subagents dir from. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-sub-${randomUUID()}`;
  const runId = `run-sub-${randomUUID()}`;
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

/* ────────────────────────────────────────────────────────────────────────── *
 * Settle hook
 * ────────────────────────────────────────────────────────────────────────── */

test("setSubagentSettleHook fires exactly once, after the DB row already reads 'completed'", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const agentId = `settle-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "settle", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines());

  const settleCalls: string[] = [];
  // Collected rather than assigned to a `let`: TS keeps narrowing a
  // `let x: string | null = null` to `null` across a callback assignment, so
  // the later `toBe("completed")` wouldn't typecheck.
  const statusesInsideHook: string[] = [];
  setSubagentSettleHook((tid) => {
    settleCalls.push(tid);
    // Read the DB from INSIDE the hook — this is the ordering guarantee under
    // test: fireSettle runs after checkDone's `subagentsDb.setStatus(...,
    // "completed", ...)` write, so a hook reading the row here must already
    // see the terminal status.
    statusesInsideHook.push(subagents.get(agentId)!.status);
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(settleCalls.length).toBe(0); // mere discovery never settles

  appendFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "sA", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n");
  w.pump(t0 + 1);
  expect(settleCalls.length).toBe(0); // end_turn observed but not idle yet — not done

  w.pump(t0 + 10_000); // idle past DONE_IDLE_MS → completes → fires settle
  expect(settleCalls).toEqual([taskId]);
  expect(statusesInsideHook).toEqual(["completed"]);
  expect(subagents.get(agentId)!.status).toBe("completed");

  // A further pump with nothing new to complete must not re-fire the hook.
  w.pump(t0 + 20_000);
  expect(settleCalls).toEqual([taskId]);

  w.detach();
});

test("a throwing settle hook does not crash the poll cycle, and the DB write still lands", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const agentId = `throws-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "throws", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines());

  let hookCalls = 0;
  setSubagentSettleHook(() => {
    hookCalls++;
    throw new Error("settle hook boom");
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  appendFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "tB", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n");
  w.pump(t0 + 1);

  expect(() => w.pump(t0 + 10_000)).not.toThrow();
  expect(hookCalls).toBe(1);
  // The hook throwing must not have rolled back (or prevented) the DB write
  // that happened just before `fireSettle` was called.
  expect(subagents.get(agentId)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * orphanRunningSubagents
 * ────────────────────────────────────────────────────────────────────────── */

test("orphanRunningSubagents flips only running rows to orphaned, emits one lifecycle event each, and fires settle once", async () => {
  const { subagents } = await import("./db.ts");
  const { orphanRunningSubagents, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId } = await seed();

  const now = Date.now();
  const running1: Subagent = {
    id: `orph-r1-${randomUUID()}`, taskId, runId, parentKind: "subagent",
    agentType: "Explore", description: "r1", spawnDepth: 1,
    sourcePath: "/tmp/r1.jsonl", status: "running", startedAt: now, endedAt: null,
  };
  const running2: Subagent = {
    id: `orph-r2-${randomUUID()}`, taskId, runId, parentKind: "subagent",
    agentType: "general-purpose", description: "r2", spawnDepth: 1,
    sourcePath: "/tmp/r2.jsonl", status: "running", startedAt: now, endedAt: null,
  };
  const completedEndedAt = now - 5_000;
  const completed: Subagent = {
    id: `orph-c1-${randomUUID()}`, taskId, runId, parentKind: "subagent",
    agentType: "Explore", description: "c1", spawnDepth: 1,
    sourcePath: "/tmp/c1.jsonl", status: "completed", startedAt: now - 10_000, endedAt: completedEndedAt,
  };
  for (const s of [running1, running2, completed]) subagents.insertIfAbsent(s);

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  orphanRunningSubagents(taskId);

  const r1 = subagents.get(running1.id)!;
  const r2 = subagents.get(running2.id)!;
  const c1 = subagents.get(completed.id)!;
  expect(r1.status).toBe("orphaned");
  expect(r1.endedAt).not.toBeNull();
  expect(r2.status).toBe("orphaned");
  expect(r2.endedAt).not.toBeNull();
  // The already-completed row must be left untouched — same status, same endedAt.
  expect(c1.status).toBe("completed");
  expect(c1.endedAt).toBe(completedEndedAt);

  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(2);
  expect(finished.map((e) => e.subagentId).sort()).toEqual([running1.id, running2.id].sort());
  expect(finished.every((e) => e.taskId === taskId)).toBe(true);

  // Fired ONCE for the whole batch, not once per orphaned row.
  expect(settleCalls).toEqual([taskId]);
});

test("orphanRunningSubagents on a task with no rows is a silent no-op: no events, no settle", async () => {
  const { orphanRunningSubagents, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId } = await seed(); // fresh task — zero subagent rows ever created

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  expect(() => orphanRunningSubagents(taskId)).not.toThrow();

  expect(captured.length).toBe(0);
  // Real contract (read from the implementation): `orphanRunning` returns []
  // for a task with no running rows, and the function returns immediately
  // BEFORE calling `fireSettle` — there's nothing for the orchestrator's
  // release predicate to usefully re-check, so the hook is not fired at all
  // (not "fired with zero effect").
  expect(settleCalls.length).toBe(0);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Module-level watcher registry
 * ────────────────────────────────────────────────────────────────────────── */

test("attachSubagentWatcher detaches a prior handle for the same taskId; different taskIds stay independent", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { taskId: taskA, jsonlPath: jsonlA, subagentsDir: dirA } = await seed();
  const { taskId: taskB, jsonlPath: jsonlB, subagentsDir: dirB } = await seed();

  const h1 = attachSubagentWatcher({ taskId: taskA, jsonlPath: jsonlA, manual: true });
  const hB = attachSubagentWatcher({ taskId: taskB, jsonlPath: jsonlB, manual: true });

  // Re-attach for taskA — must silently detach h1 (structurally impossible to
  // double-attach the same taskId per the module comment on `watchers`).
  const h2 = attachSubagentWatcher({ taskId: taskA, jsonlPath: jsonlA, manual: true });

  // h1 is now inert: writing a new subagent file and pumping h1 must NOT
  // discover it.
  const idOld = `old-${randomUUID()}`;
  writeFileSync(path.join(dirA, `agent-${idOld}.meta.json`), JSON.stringify({ agentType: "Explore", description: "x", spawnDepth: 1 }));
  writeFileSync(path.join(dirA, `agent-${idOld}.jsonl`), sidechainLines());
  h1.pump(Date.now());
  expect(subagents.listForTask(taskA).length).toBe(0);

  // h2 — the live, currently-registered handle — DOES discover it.
  h2.pump(Date.now());
  expect(subagents.listForTask(taskA).length).toBe(1);
  expect(subagents.listForTask(taskA)[0]!.id).toBe(idOld);

  // taskB's watcher, untouched by taskA's re-attach, keeps working
  // independently — attaching for a different taskId must not detach it.
  const idB = `b-${randomUUID()}`;
  writeFileSync(path.join(dirB, `agent-${idB}.meta.json`), JSON.stringify({ agentType: "Explore", description: "y", spawnDepth: 1 }));
  writeFileSync(path.join(dirB, `agent-${idB}.jsonl`), sidechainLines());
  hB.pump(Date.now());
  expect(subagents.listForTask(taskB).length).toBe(1);

  h2.detach();
  hB.detach();
});

test("a stale handle's detach() cannot evict a newer handle for the same taskId", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, detachWatcherFor } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();

  const h1 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const h2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true }); // auto-detaches h1

  // Calling detach() on the now-stale h1 must be a no-op w.r.t. the registry —
  // it must NOT evict h2 (identity-compared inside detach()).
  h1.detach();

  const id1 = `stale-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${id1}.meta.json`), JSON.stringify({ agentType: "Explore", description: "x", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${id1}.jsonl`), sidechainLines());
  h2.pump(Date.now()); // h2 must still be live/functional after h1.detach()
  expect(subagents.listForTask(taskId).length).toBe(1);

  // Now tear down via the registry helper — this SHOULD reach h2, since it's
  // still the registered handle for taskId.
  detachWatcherFor(taskId);
  const id2 = `stale2-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${id2}.meta.json`), JSON.stringify({ agentType: "Explore", description: "y", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${id2}.jsonl`), sidechainLines());
  h2.pump(Date.now()); // now inert
  expect(subagents.listForTask(taskId).length).toBe(1); // unchanged — h2 didn't discover id2
});

test("detachWatcherFor on an unknown taskId is a silent no-op", async () => {
  const { detachWatcherFor } = await import("./claude-subagents.ts");
  expect(() => detachWatcherFor(`no-such-task-${randomUUID()}`)).not.toThrow();
});
