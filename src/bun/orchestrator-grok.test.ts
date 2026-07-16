import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-grok-orch-"));
// Drive grok through the in-process fake (no tmux, no real CLI). The fake
// emits canned chunks and calls onSessionId with the PROVIDED session id
// (D4: the orchestrator pre-seeds the id before spawn now, so the fake
// echoes it back rather than synthesizing its own `fake-grok-session-<id>`),
// so we can exercise the orchestrator's grok session bookkeeping + multi-turn
// routing deterministically. Mirrors orchestrator-codex.test.ts.
process.env.AGETOR_GROK_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the grok
// bin at /bin/echo so `--version` succeeds on CI hosts without grok.
process.env.AGETOR_GROK_BIN = "/bin/echo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
  const { db } = await import("./db.ts");
  // bun test runs every file in one process, so db.ts's first import wins and
  // the DB is SHARED across files — the mkdtemp above only isolates us when
  // this file happens to load first. An earlier file may have deleted the
  // seeded grok builtin (harnesses.test.ts exercises exactly that), and
  // setEnabled below needs the real row — re-seed idempotently.
  db.run(
    `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
     VALUES ('grok', 'grok', 'Grok Build', 1, NULL, NULL, '{}', ?, ?, 0)`,
    [Date.now(), Date.now()],
  );
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("startTask (grok) pre-seeds a UUID session id at run INSERT, persisted through the resolved turn", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok run",
    prompt: "do a thing",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // D4: the session id is minted and persisted on the run row AT INSERT —
  // i.e. before the turn has resolved (or even necessarily finished
  // spawning), not sniffed later from an `end`/onSessionId callback. Assert
  // this BEFORE settle() so we're actually exercising the "known up front"
  // contract, not just whatever's true once the turn is done.
  const preSettleList = runs.listForTask(taskId);
  expect(preSettleList.length).toBe(1);
  const preSeededId = preSettleList[0]?.grokSessionId ?? "";
  expect(preSeededId).toMatch(UUID_RE);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  // All three kinds host their run in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake echoes back the id it was GIVEN (D4) — same id as pre-seeded,
  // not a freshly synthesized one.
  expect(list[0]?.grokSessionId).toBe(preSeededId);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
  const { tasks } = await import("./db.ts");
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("sendInput (grok, idle) spawns a NEW run row that resumes the SAME session id (fake driver bypasses the disk-existence gate)", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok multiturn",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the first turn resolve (fake done at ~20ms)

  const firstRunId = "runId" in started ? started.runId : "";
  const firstRun = runs.listForTask(taskId).find((r) => r.id === firstRunId);
  const firstSessionId = firstRun?.grokSessionId ?? "";
  expect(firstSessionId).toMatch(UUID_RE);

  const res = await sendInput(firstRunId, "turn two");
  expect(res.delivered).toBe(true);
  await settle();

  const list = runs.listForTask(taskId);
  // One row per turn — the follow-up is its own run, not folded into the first.
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // resolveGrokSession's disk-existence gate is bypassed for the fake driver
  // (`AGETOR_GROK_DRIVER === "fake"` short-circuits `grokSessionExistsOnDisk`)
  // — this is the "resume path" this test verifies: without that bypass, a
  // fake run (which never touches disk) would always look "not established"
  // and mint a fresh id on every follow-up instead of resuming.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.grokSessionId).toBe(firstSessionId);
});

test("sendInput (grok, busy) queues the follow-up; it spawns after the active turn resolves, both rows share the session id", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same tick
  // as start lands while the first turn is still active, so it must queue (no
  // new row yet) and then drain into a second run once the first resolves.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok queue",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  // Send immediately — the first turn's fake hasn't resolved yet, so this
  // folds into the queue and reports the still-active run id.
  const res = await sendInput(firstRunId, "queued turn");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId); // attached to active run

  // Right away there should still be just one run row (the queued turn hasn't
  // spawned yet).
  expect(runs.listForTask(taskId).length).toBe(1);

  // After both turns drain, there are exactly two run rows, both resolved —
  // no `running` rows left behind for reconcile.test.ts to trip over.
  await settle(200);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  for (const r of list) expect(r.status).toBe("succeeded");
  // Same conversation, same session throughout — the drained queued turn
  // resumes rather than starting fresh.
  const sessionIds = new Set(list.map((r) => r.grokSessionId));
  expect(sessionIds.size).toBe(1);
  expect([...sessionIds][0]).toMatch(UUID_RE);
});

test("mode change between turns forces a FRESH grok session id (D5: --resume never re-sends --sandbox)", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok mode change",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
    // Mode omitted → null → resolveGrokSession treats it as "auto".
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  expect(tasks.get(taskId)?.mode).toBeNull();

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let turn one resolve

  const firstRunId = "runId" in started ? started.runId : "";
  const firstSessionId = runs.listForTask(taskId).find((r) => r.id === firstRunId)?.grokSessionId ?? "";
  expect(firstSessionId).toMatch(UUID_RE);

  // Grok's two curated modes are "auto" and "ask" (src/shared/types.ts,
  // AGENT_OPTIONS.grok.modes) — flip from the implicit "auto" default to
  // "ask", mirroring a PATCH /tasks/:id (mode is in the server's allow-list).
  tasks.update(taskId, { mode: "ask" });

  const res = await sendInput(firstRunId, "turn two, after mode change");
  expect(res.delivered).toBe(true);
  await settle();

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  const secondRunId = res.delivered ? res.runId : "";
  expect(secondRunId).not.toBe(firstRunId);
  const secondSessionId = list.find((r) => r.id === secondRunId)?.grokSessionId ?? "";
  expect(secondSessionId).toMatch(UUID_RE);
  // The mode change forces a fresh session — NOT the same id as turn one.
  expect(secondSessionId).not.toBe(firstSessionId);
});

test("deleteTask (grok) tears down mid-flight without throwing and leaves no running rows", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok delete",
    prompt: "turn one",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  // Let the fake's turn resolve first: its `.kill()` only records a log line
  // and doesn't cancel the in-flight `setTimeout`s (mirrors the codex/claude
  // fakes), so deleting while still in flight would let a late `onChunk` fire
  // after the row is cascade-deleted and throw an FK error on a sibling
  // test's tick. Settling first isolates the teardown path we actually want
  // to exercise (dropGrokSession + grokTurnQueue.delete) from that fake-only
  // timing artifact.
  await settle();

  await deleteTask(taskId);

  expect(tasks.get(taskId)).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("archiveTask (grok) tears down the session + queue without throwing", async () => {
  const { createTask, startTask, archiveTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok archive",
    prompt: "do a thing",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    effort: null,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the turn resolve → column 'review'

  // archiveTask requires column 'done'.
  tasks.update(taskId, { column: "done" });

  const archived = await archiveTask(taskId);
  if ("error" in archived) throw new Error(archived.error);
  expect(archived.task.archivedAt).not.toBeNull();

  // No running rows left behind.
  expect(runs.listForTask(taskId).every((r) => r.status !== "running")).toBe(true);
});

test("createTask (grok) with no explicit effort resolves DEFAULT_EFFORT.grok, and the fake spawn doesn't throw", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  const { DEFAULT_EFFORT } = await import("../shared/types.ts");
  harnesses.setEnabled("grok", true);

  const created = await createTask({
    title: "grok default effort",
    prompt: "do a thing",
    agent: "grok",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model: "grok-build",
    // effort intentionally omitted — createTask must resolve it itself
    // (grok-build's MODEL_EFFORT_SUPPORT list is non-empty, so this does NOT
    // fall back to null the way an effort-unsupported model like Haiku 4.5
    // would — see orchestrator.ts createTask's effort-resolution comment).
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  expect(created.task.effort).toBe(DEFAULT_EFFORT.grok);
  expect(created.task.effort).toBe("medium");
  // Re-fetch from the DB too, not just the in-memory return value.
  expect(tasks.get(taskId)?.effort).toBe("medium");

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle();

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");
});
