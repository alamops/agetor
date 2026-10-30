import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cursor-orch-"));
// Drive cursor through the in-process fake (no tmux, no real CLI). The fake
// emits canned chunks and calls onSessionId with a synthetic session id, so we
// can exercise the orchestrator's cursor session bookkeeping + multi-turn
// routing deterministically.
process.env.AGETOR_CURSOR_DRIVER = "fake";
// Availability probe (`checkHarness`) still runs in startTask; point the
// cursor bin at /bin/echo so `--version` succeeds on CI hosts without cursor.
process.env.AGETOR_CURSOR_BIN = "/bin/echo";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for cursor turn");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("createTask (cursor) defaults model to Grok 4.7 at high effort and lands in backlog", async () => {
  const { createTask } = await import("./orchestrator.ts");

  const created = await createTask({
    title: "cursor defaults",
    prompt: "do a thing",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  expect(created.task.agent).toBe("cursor");
  expect(created.task.model).toBe("grok-4.7");
  expect(created.task.effort).toBe("high");
  expect(created.task.column).toBe("backlog");
});

test("startTask (cursor) sets tmux_session + persists the session id as cursor_session_id", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor run",
    prompt: "do a thing",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  // All three agent kinds host their run in a per-task tmux session.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // The fake delivers a synthetic session id via onSessionId → cursor_session_id.
  expect(list[0]?.cursorSessionId).toBe(`fake-cursor-session-${taskId}`);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  // The fake resolves done(0) → succeeded → review column.
  expect(list[0]?.status).toBe("succeeded");
});

test("sendInput (cursor, idle) spawns a NEW run row that resumes the same session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor multiturn",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(); // let the first turn resolve (fake done at ~20ms)

  const firstRunId = "runId" in started ? started.runId : "";
  const res = await sendInput(firstRunId, "turn two");
  expect(res.delivered).toBe(true);
  await settle();

  const list = runs.listForTask(taskId);
  // One row per turn — the follow-up is its own run, not folded into the first.
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // The resumed turn carries the same session id forward.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.cursorSessionId).toBe(`fake-cursor-session-${taskId}`);
});

test("sendInput (cursor, busy) queues the follow-up; it spawns after the active turn resolves", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same
  // tick as start lands while the first turn is still active, so it must
  // queue (no new row yet) and then drain into a second run once the first
  // resolves.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor queue",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
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

  // After both turns drain, there are exactly two run rows, neither stranded
  // in `running`.
  await settle(200);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  expect(list.every((r) => r.status !== "running")).toBe(true);
});

/** First turn settled, so the next `sendInput` takes `spawnCursorTurnNow`. */
async function startSettledCursorTask(title: string): Promise<{ taskId: string; runId: string }> {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);
  const created = await createTask({
    title,
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => tasks.get(created.task.id)?.column === "review");
  return { taskId: created.task.id, runId: started.runId };
}

test("spawnCursorTurnNow does not register a child deleted during the handshake", async () => {
  const { sendInput, deleteTask, isAnyRunOfTaskLive } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { taskId, runId } = await startSettledCursorTask("cursor delete during handshake");
  // Longer than delete on an isolation-none task, so the row is gone before
  // the spawn returns and the ownership guard runs.
  process.env.AGETOR_FAKE_CURSOR_SPAWN_DELAY_MS = "2000";
  try {
    const sent = sendInput(runId, "turn two");
    let followUpId = "";
    await waitFor(() => {
      const next = tasks.get(taskId)?.runId;
      if (!next || next === runId) return false;
      followUpId = next;
      return true;
    });
    await deleteTask(taskId);
    expect(tasks.get(taskId)).toBeNull();
    await sent;
    expect(runs.get(followUpId)).toBeNull();
    expect(isAnyRunOfTaskLive(taskId)).toBe(false);
    // A registered child would still be in `active` until its turn timer
    // fired, and that timer would append against the cascade-deleted run.
    await settle(80);
    expect(isAnyRunOfTaskLive(taskId)).toBe(false);
  } finally {
    delete process.env.AGETOR_FAKE_CURSOR_SPAWN_DELAY_MS;
  }
});

test("spawnCursorTurnNow does not register a child force-archived during the handshake", async () => {
  const { sendInput, archiveTask, unarchiveTask, isAnyRunOfTaskLive } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { taskId, runId } = await startSettledCursorTask("cursor archive during handshake");
  process.env.AGETOR_FAKE_CURSOR_SPAWN_DELAY_MS = "2000";
  try {
    const sent = sendInput(runId, "turn two");
    let followUpId = "";
    await waitFor(() => {
      const next = tasks.get(taskId)?.runId;
      if (!next || next === runId) return false;
      followUpId = next;
      return true;
    });
    const archived = await archiveTask(taskId, { force: true });
    expect("error" in archived).toBe(false);
    const result = await sent;
    expect(result.delivered).toBe(false);
    if (result.delivered) return;
    expect(result.reason).toContain("cancelled before Cursor started");
    expect(runs.events(followUpId).some((event) => event.stream === "user")).toBe(false);
    expect(tasks.get(taskId)?.archivedAt).not.toBeNull();
    // The handshake never registers, so the done handler cannot pull the
    // card off `running`. Settlement has to, or unarchive shows Stop for a
    // run that is already cancelled.
    expect(tasks.get(taskId)?.column).toBe("ready");
    expect(tasks.get(taskId)?.runId).toBe(followUpId);
    expect(runs.get(followUpId)?.status).toBe("cancelled");
    expect(
      runs.events(followUpId).some((event) => event.stream === "status" && event.data === "task archived before the agent launched"),
    ).toBe(true);
    expect(isAnyRunOfTaskLive(taskId)).toBe(false);
    const restored = await unarchiveTask(taskId);
    expect("error" in restored).toBe(false);
    expect(tasks.get(taskId)?.archivedAt).toBeNull();
    expect(tasks.get(taskId)?.column).toBe("ready");
    expect(isAnyRunOfTaskLive(taskId)).toBe(false);
  } finally {
    delete process.env.AGETOR_FAKE_CURSOR_SPAWN_DELAY_MS;
  }
});

test("deleteTask (cursor) tears down without throwing and removes the task", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor delete",
    prompt: "turn one",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  // Let the fake turn resolve fully, then delete — the common path.
  await settle();

  await expect(deleteTask(taskId)).resolves.toBeUndefined();

  expect(tasks.get(taskId)).toBeNull();
});

test("deleteTask (cursor) mid-turn does not crash on late chunks", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor delete mid-turn",
    prompt: "will be deleted immediately",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // Delete while the fake turn is still in flight. `makeFakeAgent.kill()`
  // clears its pending timers, so no chunk can land on the cascade-deleted
  // run row (the old behavior threw SQLITE_CONSTRAINT_FOREIGNKEY from
  // runs.appendEvent). Note the equivalent guard for the REAL tmux drivers
  // (a buffered chunk racing dropSession + cascade-delete) is still an open
  // follow-up in makeChunkHandler/appendEvent.
  await expect(deleteTask(taskId)).resolves.toBeUndefined();
  await settle();

  expect(tasks.get(taskId)).toBeNull();
});

test("fake ask marker leaves the run running until the card is answered", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, tasks, harnesses } = await import("./db.ts");
  const { listPendingForTask, answerCursorAsk } = await import("./interactions.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor ask",
    prompt: "__agetor_fake_cursor_ask__",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  await settle(40);
  expect(runs.get(started.runId)?.status).toBe("running");
  const pending = listPendingForTask(created.task.id);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.kind).toBe("ask_questions");
  answerCursorAsk(pending[0]!.id, { outcome: "skipped" });
  await settle(80);
  expect(runs.get(started.runId)?.status).toBe("succeeded");
  expect(tasks.get(created.task.id)?.column).toBe("review");
  expect(runs.get(started.runId)?.cursorSessionId).toBe(`fake-cursor-session-${created.task.id}`);
  const result = runs.events(started.runId).find((event) => event.stream === "tool_result");
  expect(JSON.parse(result?.data ?? "{}")).toEqual({
    toolUseId: "fake-ask-1",
    content: "skipped",
    isError: false,
  });
});

test("fake :2 ask marker registers two cards at once", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { listPendingForTask, answerCursorAsk } = await import("./interactions.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor ask two",
    prompt: "__agetor_fake_cursor_ask__:2",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  await settle(40);
  const pending = listPendingForTask(created.task.id);
  expect(pending).toHaveLength(2);
  expect(runs.get(started.runId)?.status).toBe("running");
  for (const card of pending) answerCursorAsk(card.id, { outcome: "skipped" });
  await settle(80);
  expect(runs.get(started.runId)?.status).toBe("succeeded");
  const results = runs.events(started.runId).filter((event) => event.stream === "tool_result");
  expect(results.map((event) => JSON.parse(event.data))).toEqual([
    { toolUseId: "fake-ask-1", content: "skipped", isError: false },
    { toolUseId: "fake-ask-2", content: "skipped", isError: false },
  ]);
});

test("stopping a fake Cursor ask records a cancelled tool_result", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { listPendingForTask } = await import("./interactions.ts");
  harnesses.setEnabled("cursor", true);

  const created = await createTask({
    title: "cursor ask stop",
    prompt: "__agetor_fake_cursor_ask__",
    agent: "cursor",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  await settle(40);
  expect(listPendingForTask(created.task.id)).toHaveLength(1);
  expect(await cancelRun(started.runId)).toBe(true);
  await settle(80);
  expect(listPendingForTask(created.task.id)).toEqual([]);
  const result = runs.events(started.runId).find((event) => event.stream === "tool_result");
  expect(JSON.parse(result?.data ?? "{}")).toEqual({
    toolUseId: "fake-ask-1",
    content: "cancelled",
    isError: false,
  });
});

test("a running cursor row at boot is orphaned and its open question is rebuilt", async () => {
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const { tasks, runs, insertCursorAsk } = await import("./db.ts");
  const { listPendingForTask, __testing } = await import("./interactions.ts");
  __testing.reset();
  const taskId = `cursor-boot-${Date.now()}`;
  const runId = `run-${taskId}`;
  const now = Date.now();
  tasks.insert({
    id: taskId, title: taskId, prompt: "ask", column: "running",
    agent: "cursor", workdir: process.cwd(), isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: "auto",
    model: "grok-4.7", effort: "high", speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, runId,
    createdAt: now, updatedAt: now, hasOpenableRun: true,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  runs.insert({
    id: runId, taskId, agent: "cursor", status: "running",
    startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: `agetor-leftover-${taskId}`,
    claudeSessionId: null, codexSessionId: null, cursorSessionId: "sess-old",
    geminiSessionId: null, fxSessionId: null,
  });
  insertCursorAsk({
    taskId, runId, toolCallId: "call-boot",
    payload: {
      title: "Pick one",
      questions: [{ id: "q1", prompt: "Which?", allowMultiple: false, options: [{ id: "a", label: "Alpha" }] }],
    },
  });
  await reconcileOrphans();
  expect(runs.get(runId)?.status).toBe("orphaned");
  expect(tasks.get(taskId)?.column).toBe("ready");
  expect(tasks.get(taskId)?.runId).toBeNull();
  const pending = listPendingForTask(taskId);
  expect(pending).toHaveLength(1);
  const card = pending[0]!;
  expect(card.kind).toBe("ask_questions");
  if (card.kind === "ask_questions") expect(card.delivery).toBe("restart-followup");
});
