import { test, expect, beforeAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fx-orch-"));
// Drive fx through the in-process fake (no ACP child process, no real CLI).
// fx's fake spawn calls onSessionId with a DISCOVERED session id (mirrors
// codex's `thread.started` timing, not claude/gemini's pre-generated-uuid
// pattern — see agents.ts's spawnAgent fx branch), so we can exercise the
// orchestrator's fx session bookkeeping + multi-turn routing deterministically.
process.env.AGETOR_FX_DRIVER = "fake";

// Availability probe (`checkHarness`) still runs in startTask. Unlike the
// other kinds, a bare `/bin/echo` isn't enough for fx: `checkHarness`
// additionally probes `--help` and requires the output to contain "coding
// agent" (disambiguating Vercel's fx from the unrelated npm JSON-viewer CLI
// of the same name — see agent-status.ts's FX_HELP_MARKER). Write a tiny
// fake binary that satisfies both probes.
const fxBinDir = mkdtempSync(path.join(tmpdir(), "agetor-fx-fakebin-"));
const fxBinPath = path.join(fxBinDir, "fx");
writeFileSync(
  fxBinPath,
  [
    "#!/bin/sh",
    'if [ "$1" = "--help" ]; then',
    '  echo "Fast, native coding agent for the terminal"',
    "  exit 0",
    "fi",
    'if [ "$1" = "--version" ]; then',
    '  echo "0.0.4-fake"',
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(fxBinPath, 0o755);
process.env.AGETOR_FX_BIN = fxBinPath;

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("createTask (fx) defaults model to zai/glm-5.2-fast, no effort, and lands in backlog", async () => {
  const { createTask } = await import("./orchestrator.ts");

  const created = await createTask({
    title: "fx defaults",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  expect(created.task.agent).toBe("fx");
  expect(created.task.model).toBe("zai/glm-5.2-fast");
  // fx has no per-invocation effort flag — every model in MODEL_EFFORT_SUPPORT.fx
  // reports an empty supported-effort list, so createTask leaves effort null
  // rather than defaulting it (see orchestrator.ts's createTask default logic).
  expect(created.task.effort).toBeNull();
  expect(created.task.column).toBe("backlog");
});

test("startTask (fx) sets tmux_session (inert, for row-shape symmetry) + persists the discovered session id as fx_session_id", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx run",
    prompt: "do a thing",
    agent: "fx",
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
  // Every kind gets a `tmuxSession` name on its run row for shape symmetry,
  // even though fx (ACP/stdio, no tmux at all) never uses it.
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  // fx's ACP session id is DISCOVERED (like codex's thread id), not
  // pre-generated — the fake stands in with a predictable value.
  expect(list[0]?.fxSessionId).toBe(`fake-fx-session-${taskId}`);
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  expect(list[0]?.cursorSessionId).toBeNull();
  expect(list[0]?.geminiSessionId).toBeNull();
  // The fake resolves done(0) -> succeeded -> review column.
  expect(list[0]?.status).toBe("succeeded");
  expect((await import("./db.ts")).tasks.get(taskId)?.column).toBe("review");
});

test("sendInput (fx, idle) spawns a NEW run row that resumes the same session", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx multiturn",
    prompt: "turn one",
    agent: "fx",
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
  // One row per turn — fx is one-shot per turn (ACP/stdio), same as
  // codex/cursor/gemini; the follow-up is its own run, not folded into the
  // first.
  expect(list.length).toBe(2);
  const newRunId = res.delivered ? res.runId : "";
  expect(newRunId).not.toBe(firstRunId);
  // findLastFxSessionId + spawnFxTurnNow carry the prior session id forward
  // onto the new run row.
  const newRun = list.find((r) => r.id === newRunId);
  expect(newRun?.fxSessionId).toBe(`fake-fx-session-${taskId}`);
});

test("sendInput (fx, busy) queues the follow-up; drainFxQueue spawns it after the active turn resolves", async () => {
  // Exploit the fake's ~20ms resolve window: a follow-up sent in the same
  // tick as start lands while the first turn is still active, so it must
  // queue (no new row yet) and then drain into a second run once the first
  // resolves. This is the review-flagged path: drainFxQueue must actually be
  // wired into attachDoneHandler, or the queued turn would strand forever.
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx queue",
    prompt: "turn one",
    agent: "fx",
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

  // Right away there should still be just one run row (the queued turn
  // hasn't spawned yet).
  expect(runs.listForTask(taskId).length).toBe(1);

  // After both turns drain, there are exactly two run rows, neither
  // stranded in `running`.
  await settle(200);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  expect(list.every((r) => r.status !== "running")).toBe(true);
});

test("cancelRun (fx) mid-turn records the run cancelled and returns the task to ready", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx cancel",
    prompt: "turn one",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";

  // Cancel synchronously, before the fake's ~20ms auto-resolve timer fires —
  // makeFakeAgent's kill() clears the pending timers and resolves done(0)
  // immediately, with the `cancelled` flag on the active handle overriding
  // the exit-code mapping.
  const result = cancelRun(runId);
  expect(result).toBe(true);

  await settle();

  expect(runs.get(runId)?.status).toBe("cancelled");
  expect(tasks.get(taskId)?.column).toBe("ready");
});

test("deleteTask (fx) tears down without throwing and removes the task", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx delete",
    prompt: "turn one",
    agent: "fx",
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

test("deleteTask (fx) mid-turn does not crash on late chunks", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx delete mid-turn",
    prompt: "will be deleted immediately",
    agent: "fx",
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
  // run row (see the equivalent cursor/gemini tests for the same guard).
  await expect(deleteTask(taskId)).resolves.toBeUndefined();
  await settle();

  expect(tasks.get(taskId)).toBeNull();
});

/** A minimal Task row for reconcileTaskSession's direct-call tests — mirrors
 *  reconcile-session.test.ts's `baseTask` helper. */
function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "t",
    prompt: "p",
    column: "ready",
    agent: "fx",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [], backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("reconcileTaskSession drops the fx session and resets mode to the new kind's modes[0] when switching AWAY from fx", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { AGENT_OPTIONS } = await import("../shared/types.ts");
  harnesses.setEnabled("gemini", true);

  const before = baseTask({
    id: "fx-switch-away",
    agent: "fx",
    mode: "yolo", // valid for fx, invalid for gemini
    model: "zai/glm-5.2-fast",
    effort: null,
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "gemini" };
  // Must not throw even though there's no live fx session to drop
  // (dropFxSession is a best-effort no-op — fx has no persistent process to
  // tear down between turns).
  await expect(reconcileTaskSession(before.id, before, after)).resolves.toBeUndefined();

  const updated = tasks.get(before.id)!;
  expect(updated.mode).toBe(AGENT_OPTIONS.gemini.modes[0]?.id ?? "auto");
  expect(updated.model).toBeNull();
  expect(updated.effort).toBeNull();
});

test("reconcileTaskSession resets mode to fx's own modes[0] when switching INTO fx from another kind", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { AGENT_OPTIONS } = await import("../shared/types.ts");
  harnesses.setEnabled("fx", true);

  const before = baseTask({
    id: "fx-switch-into",
    agent: "gemini",
    mode: "ask", // valid for gemini, and happens to also be a valid fx id —
    // still must be reset since the KIND changed, not preserved because the
    // literal id happens to overlap.
    model: "gemini-3-pro-preview",
    effort: null,
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "fx" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  expect(updated.mode).toBe(AGENT_OPTIONS.fx.modes[0]?.id ?? "auto");
  expect(updated.model).toBeNull();
  expect(updated.effort).toBeNull();
});

test("reconcileTaskSession preserves mode/model/effort on a same-kind fx alias swap", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.insert({ id: "fx-alt", kind: "fx", label: "fx alt" });
  harnesses.setEnabled("fx-alt", true);

  const before = baseTask({
    id: "fx-same-kind",
    agent: "fx",
    mode: "yolo",
    model: "openai/gpt-5.5",
    effort: null,
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "fx-alt" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  // Same kind -> ids stay valid -> keep the picks.
  expect(updated.mode).toBe("yolo");
  expect(updated.model).toBe("openai/gpt-5.5");
});

test("reconcileOrphans has no reattach path for fx: a mid-boot running fx run always flips to orphaned, task back to ready", async () => {
  const { db, tasks, runs, harnesses } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("fx", true);

  const taskId = `task-fx-orphan-${crypto.randomUUID()}`;
  const runId = `run-fx-orphan-${crypto.randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "stuck fx",
    prompt: "p",
    column: "running",
    agent: "fx",
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
    fast: false, maxMode: false,
    references: [], backlog: [], plans: [], draft: null,
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  // Populate BOTH tmuxSession and fxSessionId — proving the orphan outcome
  // holds even when the reattach key is present. fx's ACP pipes die with the
  // agetor process; unlike claude/codex/cursor/gemini there is never a live
  // session to reattach to, by design (see reconcileOrphans's `canTryReattach`
  // comment, which deliberately excludes "fx").
  runs.insert({
    id: runId,
    taskId,
    agent: "fx",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: `fake-fx-session-${taskId}`,
  });

  const reconciled = reconcileOrphans();
  expect(reconciled).toBe(1);

  const row = db.query<{ status: string }, [string]>(`SELECT status FROM runs WHERE id = ?`).get(runId);
  expect(row?.status).toBe("orphaned");

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();

  // A second call is a no-op — nothing left to reconcile.
  expect(reconcileOrphans()).toBe(0);
});
