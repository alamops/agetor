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
// `checkHarness`'s fx-only login pre-flight (agent-status.ts's probeStatus)
// additionally runs `fx status --json` once the --help/--version dual-probe
// above passes. The stub answers it from two env vars set per-test —
// AGETOR_FAKE_FX_STATUS_JSON (stdout) / AGETOR_FAKE_FX_STATUS_EXIT (exit
// code, default 0) — so individual tests can flip between "logged out",
// "logged in", and "doesn't implement the subcommand at all" (the default,
// unset state every pre-existing test in this file already relies on:
// `status` falls through to `exit 0` with empty stdout, which probeStatus
// treats as fail-open loggedIn:null — see agent-status.ts).
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
    'if [ "$1" = "status" ]; then',
    '  if [ -n "$AGETOR_FAKE_FX_STATUS_JSON" ]; then',
    '    echo "$AGETOR_FAKE_FX_STATUS_JSON"',
    '    exit "${AGETOR_FAKE_FX_STATUS_EXIT:-0}"',
    "  fi",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(fxBinPath, 0o755);
process.env.AGETOR_FX_BIN = fxBinPath;

// The model-null fallback regression test below wants a second, non-fx kind
// under its own fake driver to prove `task.model ?? DEFAULT_MODEL[kind]`
// isn't an fx-specific fallback. claude-code's `checkHarness` pre-flight
// additionally probes tmux (see agent-status.ts's TMUX_MISSING_REASON), so
// both bins need a stand-in — same convention as orchestrator-claude-plan.test.ts.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

// The spawn-throw hardening test below needs a kind whose FAKE spawn path
// still calls the real `buildCommand` synchronously (gemini's does, to keep
// the fake's argv-validation behavior honest — see agents.ts's spawnAgent
// gemini branch) so a real, deterministic synchronous throw (the
// GEMINI_PROMPT_ARGV_MAX_BYTES cap) is reachable without touching a real
// CLI. Same convention as orchestrator-gemini.test.ts.
process.env.AGETOR_GEMINI_DRIVER = "fake";
process.env.AGETOR_GEMINI_BIN = "/bin/echo";

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

test("createTask (fx) defaults model to zai/glm-5.3-flash, no effort, and lands in backlog", async () => {
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
  expect(created.task.model).toBe("zai/glm-5.3-flash");
  // fx has no per-invocation effort flag — every model in MODEL_EFFORT_SUPPORT.fx
  // reports an empty supported-effort list, so createTask leaves effort null
  // rather than defaulting it (see orchestrator.ts's createTask default logic).
  expect(created.task.effort).toBeNull();
  expect(created.task.column).toBe("backlog");
});

/* ── T5: startTask's logged-out pre-flight (orchestrator.ts's
 * `status.loggedIn === false` gate) ─────────────────────────────────────── */

async function withFxStatusJson<T>(
  json: string | null,
  exitCode: number | null,
  run: () => Promise<T>,
): Promise<T> {
  const prevJson = process.env.AGETOR_FAKE_FX_STATUS_JSON;
  const prevExit = process.env.AGETOR_FAKE_FX_STATUS_EXIT;
  if (json === null) delete process.env.AGETOR_FAKE_FX_STATUS_JSON;
  else process.env.AGETOR_FAKE_FX_STATUS_JSON = json;
  if (exitCode === null) delete process.env.AGETOR_FAKE_FX_STATUS_EXIT;
  else process.env.AGETOR_FAKE_FX_STATUS_EXIT = String(exitCode);
  try {
    return await run();
  } finally {
    if (prevJson === undefined) delete process.env.AGETOR_FAKE_FX_STATUS_JSON;
    else process.env.AGETOR_FAKE_FX_STATUS_JSON = prevJson;
    if (prevExit === undefined) delete process.env.AGETOR_FAKE_FX_STATUS_EXIT;
    else process.env.AGETOR_FAKE_FX_STATUS_EXIT = prevExit;
  }
}

test("startTask (fx) is blocked with an actionable error when the harness reports logged-out (auth:missing) — task stays in its pre-start column, no run row inserted", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx logged out",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const preStartColumn = created.task.column;

  await withFxStatusJson(
    JSON.stringify({ auth: "missing", auth_help: "Run fx login" }),
    null,
    async () => {
      const started = await startTask(taskId);
      expect("error" in started).toBe(true);
      if ("error" in started) {
        expect(started.error).toMatch(/isn't logged in/);
        expect(started.error).toContain("Run fx login");
      }
    },
  );

  const task = tasks.get(taskId);
  expect(task?.column).toBe(preStartColumn);
  expect(task?.runId).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("startTask (fx) proceeds normally when the stub doesn't implement status --json at all (fail-open, loggedIn:null) — the default every other test in this file relies on", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx fail-open",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await withFxStatusJson(null, null, () => startTask(taskId));
  expect("error" in started).toBe(false);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");
});

test("startTask (fx) proceeds when the harness reports logged-in (auth:ok) — the loggedIn===false gate only fires on an explicit false", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx logged in",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await withFxStatusJson(JSON.stringify({ auth: "ok" }), null, () => startTask(taskId));
  expect("error" in started).toBe(false);

  await settle();
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");
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
  const result = await cancelRun(runId);
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
    model: "zai/glm-4.7",
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
    model: "gemini-3.1-pro-preview",
    effort: null,
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "fx" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  expect(updated.mode).toBe(AGENT_OPTIONS.fx.modes[0]?.id ?? "auto");
  // Explicit literal too (TT4, docs/plans/fix-fx-harness-rate-limit.md §3.7):
  // the whole point of the mode reorder is that fx's modes[0] IS "yolo" —
  // the dynamic assertion above would pass just as well against the old
  // "auto"-first ordering, so it alone can't catch a regression there.
  expect(updated.mode).toBe("yolo");
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
    model: "openai/gpt-5.2",
    effort: null,
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "fx-alt" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  // Same kind -> ids stay valid -> keep the picks.
  expect(updated.mode).toBe("yolo");
  expect(updated.model).toBe("openai/gpt-5.2");
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

  const reconciled = await reconcileOrphans();
  expect(reconciled).toBe(1);

  const row = db.query<{ status: string }, [string]>(`SELECT status FROM runs WHERE id = ?`).get(runId);
  expect(row?.status).toBe("orphaned");

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();

  // A second call is a no-op — nothing left to reconcile.
  expect(await reconcileOrphans()).toBe(0);
});

/* ─── T11 additions: todo tracker, card × queue interplay, model-null
 * fallback, spawn-throw hardening ────────────────────────────────────── */

test("fx: TaskCreate/TaskUpdate chunks persist tasks.todo_progress the same kind-agnostic way claude's do", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { FAKE_CLAUDE_TODOS_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx todos",
    prompt: `do the thing ${FAKE_CLAUDE_TODOS_PROMPT_MARKER}`,
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // The canned scenario's last chunk fires at ~26ms.
  await settle(120);

  // Two TaskCreate calls, one TaskUpdate to in_progress on task #1 — 2 total,
  // 0 completed (see FAKE_CLAUDE_TODOS_PROMPT_MARKER's scenario in agents.ts:
  // it never emits a "completed" status).
  const task = tasks.get(taskId);
  expect(task?.todoProgress).toEqual({ completed: 0, total: 2 });
});

test("fx: a follow-up sent while an fx_permission card is open queues (no second run yet); answering the card resolves the turn and drainFxQueue then spawns the queued follow-up", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_PERMISSION_PROMPT_MARKER } = await import("./agents.ts");
  const { listPendingForTask, answerFxPermission } = await import("./interactions.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx card+queue",
    prompt: `edit a file ${FAKE_FX_PERMISSION_PROMPT_MARKER}`,
    agent: "fx",
    mode: "ask",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  // registerFxPermission runs synchronously inside spawnAgent (not gated by
  // the fake's setTimeout ladder), but poll defensively rather than assume
  // that timing.
  let pending = listPendingForTask(taskId);
  for (let i = 0; i < 30 && pending.length === 0; i++) {
    await settle(10);
    pending = listPendingForTask(taskId);
  }
  expect(pending.length).toBe(1);
  const card = pending[0]!;
  expect(card.kind).toBe("fx_permission");

  // A follow-up sent while the card is open must queue — delivered:true,
  // attached to the still-active run, and NO second run row yet.
  const res = await sendInput(firstRunId, "follow-up while waiting");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId);
  expect(runs.listForTask(taskId).length).toBe(1);

  // Answer the card — unblocks the fake driver's awaiter, resolving turn one.
  const ok = answerFxPermission(card.id, { optionId: "allow-once" });
  expect(ok).toBe(true);
  expect(listPendingForTask(taskId)).toHaveLength(0);

  await settle(120);

  // drainFxQueue (wired into attachDoneHandler) spawned the queued
  // follow-up as a second run once the first settled — neither is stranded
  // in `running`.
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(2);
  expect(list.every((r) => r.status !== "running")).toBe(true);
});

test("fx: yolo-mode never registers a card and completes with an auto-allowed status", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_PERMISSION_PROMPT_MARKER } = await import("./agents.ts");
  const { listPendingForTask } = await import("./interactions.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx yolo",
    prompt: `edit a file ${FAKE_FX_PERMISSION_PROMPT_MARKER}`,
    agent: "fx",
    mode: "yolo",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";

  await settle(80);

  // Never surfaced a card, in yolo or at any point during the turn.
  expect(listPendingForTask(taskId)).toHaveLength(0);

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");

  const events = runs.eventsForTask(taskId);
  expect(
    events.some((e) => e.runId === runId && e.stream === "status" && e.data.includes("auto-allowed")),
  ).toBe(true);
});

test("model-null fallback regression (fx): task.model=null still resolves via DEFAULT_MODEL.fx at spawn time — no throw", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx null model",
    prompt: "turn one",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  tasks.update(taskId, { model: null });
  expect(tasks.get(taskId)?.model).toBeNull();

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");
});

test("model-null fallback regression (claude-code): task.model=null still resolves via DEFAULT_MODEL['claude-code'] at spawn time — no throw", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);

  const created = await createTask({
    title: "claude null model",
    prompt: "turn one",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  tasks.update(taskId, { model: null });
  expect(tasks.get(taskId)?.model).toBeNull();

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  await settle();

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("succeeded");
});

// Spawn-throw hardening: the reviewer asked for a deterministic, SYNCHRONOUS
// `buildCommand` throw reachable under a fake driver. gemini's fake branch
// (agents.ts's spawnAgent) calls the real `buildCommand(harness, prompt,
// opts)` before ever constructing the fake agent — unlike fx/claude-code's
// fake branches, which build the command too but gemini's is the one with a
// throw condition (GEMINI_PROMPT_ARGV_MAX_BYTES) that's trivial to trigger
// from a test without touching any real CLI. That throw propagates through
// `spawnAgent` into `spawnAgentOrFail`'s catch, which is exactly the path
// this test pins.
test("spawn-throw hardening (gemini): an oversized prompt hits spawnAgentOrFail's catch — startTask returns {error}, the run row is failed, the task is back in ready with runId null", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { GEMINI_PROMPT_ARGV_MAX_BYTES } = await import("./agents.ts");
  harnesses.setEnabled("gemini", true);

  const oversizedPrompt = "x".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES + 200);
  const created = await createTask({
    title: "gemini oversized prompt",
    prompt: oversizedPrompt,
    agent: "gemini",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain(`prompt exceeds ${GEMINI_PROMPT_ARGV_MAX_BYTES} bytes`);
  }

  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.status).toBe("failed");

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();
});

/* ── TT4: resumeFxRecovery + spawnFxRun (docs/plans/fix-fx-harness-rate-
 * limit.md §3.5, "Shared spec") ──────────────────────────────────────────
 *
 * Uses the fake fx driver's "recovery" scenario (agents.ts's
 * FAKE_FX_RECOVERY_PROMPT_MARKER branch, `continueRecovery` unset): three
 * FX_RECOVERY_STATUS_PREFIX sentinels (attempt 1/3, 2/3, 3/3) at ~5/400/800ms,
 * then a `paused` sentinel + its persisted summary line + the enriched
 * "refused" line at ~1500ms, resolving the turn with exit code 1 (failed).
 * `resumeFxRecovery` then drives the "continue" variant (`continueRecovery:
 * true`): a `recovered` sentinel + summary line at ~5ms, then an ordinary
 * short turn (thinking/assistant/usage/title) resolving exit code 0
 * (succeeded) at ~10ms. */

/** Poll `runs.get(runId)` until its status leaves "running" — the fake
 *  storm's terminal chunk lands at ~1.5s and the "continue" scenario's at
 *  ~15ms, so a fixed `settle()` window would either be too slow (storm) or
 *  needlessly slow this whole file down (continue). */
async function waitForRunSettled(runId: string, timeoutMs = 5000) {
  const { runs } = await import("./db.ts");
  const start = Date.now();
  for (;;) {
    const r = runs.get(runId);
    if (r && r.status !== "running") return r;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for run ${runId} to settle (last status: ${r?.status ?? "missing"})`);
    }
    await settle(30);
  }
}

test("AGENT_OPTIONS.fx.modes[0] is 'yolo' (Full access) — the fix-fx-harness-rate-limit mode reorder", async () => {
  const { AGENT_OPTIONS } = await import("../shared/types.ts");
  expect(AGENT_OPTIONS.fx.modes[0]?.id).toBe("yolo");
});

test("resumeFxRecovery: storm → paused → resume happy path — the resumed run carries the same fx session, its transcript shows the recovered turn with no user bubble, and a second resume after that is gated (latest run succeeded)", async () => {
  const { createTask, startTask, resumeFxRecovery } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  const { FX_RECOVERY_STATUS_PREFIX } = await import("../shared/types.ts");
  const { parseFxRecoveryPayload } = await import("../shared/fx-recovery.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx recovery storm",
    prompt: `hit the gateway limit ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
    agent: "fx",
    mode: "yolo",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";

  const firstRun = await waitForRunSettled(firstRunId, 5000);
  expect(firstRun.status).toBe("failed");
  expect(tasks.get(taskId)?.column).toBe("ready");

  const firstEvents = runs.eventsForTask(taskId).filter((e) => e.runId === firstRunId);
  const sentinelPayloads = firstEvents
    .filter((e) => e.stream === "status" && e.data.startsWith(FX_RECOVERY_STATUS_PREFIX))
    .map((e) => parseFxRecoveryPayload(e.data.slice(FX_RECOVERY_STATUS_PREFIX.length)));
  // 3 "active" retry attempts + 1 terminal "paused" == 4.
  expect(sentinelPayloads.length).toBeGreaterThanOrEqual(4);
  expect(sentinelPayloads.at(-1)?.state).toBe("paused");

  expect(
    firstEvents.some(
      (e) =>
        e.stream === "status"
        && !e.data.startsWith(FX_RECOVERY_STATUS_PREFIX)
        && e.data.includes("recovery paused after 3/3 attempts")
        && e.data.includes("resume once the limit clears, or send a new message."),
    ),
  ).toBe(true);
  expect(
    firstEvents.some(
      (e) => e.stream === "status" && e.data === "fx turn ended: refused (response paused after 3/3 attempts — resumable)",
    ),
  ).toBe(true);

  const priorFxSessionId = runs.get(firstRunId)?.fxSessionId;
  expect(priorFxSessionId).toBeTruthy();

  const resumed = await resumeFxRecovery(taskId);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) throw new Error(resumed.error);
  const secondRunId = resumed.runId;
  expect(secondRunId).not.toBe(firstRunId);
  expect(runs.get(secondRunId)?.fxSessionId).toBe(priorFxSessionId);
  expect(tasks.get(taskId)?.column).toBe("running");

  const secondRun = await waitForRunSettled(secondRunId, 3000);
  expect(secondRun.status).toBe("succeeded");
  expect(tasks.get(taskId)?.column).toBe("review");

  const secondEvents = runs.eventsForTask(taskId).filter((e) => e.runId === secondRunId);
  const recoveredPayload = secondEvents
    .filter((e) => e.stream === "status" && e.data.startsWith(FX_RECOVERY_STATUS_PREFIX))
    .map((e) => parseFxRecoveryPayload(e.data.slice(FX_RECOVERY_STATUS_PREFIX.length)))
    .find((p) => p?.state === "recovered");
  expect(recoveredPayload).toBeDefined();
  expect(
    secondEvents.some((e) => e.stream === "status" && e.data === "✓ recovered · succeeded on attempt 1/3"),
  ).toBe(true);
  expect(secondEvents.some((e) => e.stream === "assistant" && e.data === "recovered answer")).toBe(true);
  expect(secondEvents.some((e) => e.stream === "user")).toBe(false);

  // A second resume attempt now that the recovered turn has succeeded is
  // gated by the same "no paused fx response to resume" check as any other
  // fx task with no pending recovery.
  const secondResume = await resumeFxRecovery(taskId);
  expect(secondResume.ok).toBe(false);
  if (!secondResume.ok) {
    expect(secondResume.status).toBe(400);
    expect(secondResume.error).toBe("no paused fx response to resume");
  }
});

test("resumeFxRecovery: unknown task id → {ok:false, status:404}", async () => {
  const { resumeFxRecovery } = await import("./orchestrator.ts");
  const result = await resumeFxRecovery("does-not-exist-task-id");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(404);
    expect(result.error).toBe("not found");
  }
});

test("resumeFxRecovery: a non-fx (claude-code) task → 400 'only fx tasks can resume a paused response'", async () => {
  const { createTask, resumeFxRecovery } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);

  const created = await createTask({
    title: "not an fx task",
    prompt: "do a thing",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  const result = await resumeFxRecovery(created.task.id);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(400);
    expect(result.error).toBe("only fx tasks can resume a paused response");
  }
});

test("resumeFxRecovery: an archived fx task → 400 'task is archived'", async () => {
  const { createTask, archiveTask, resumeFxRecovery } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx archived",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const archived = await archiveTask(taskId, { force: true });
  if ("error" in archived) throw new Error(archived.error);

  const result = await resumeFxRecovery(taskId);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(400);
    expect(result.error).toBe("task is archived");
  }
});

test("resumeFxRecovery: an fx task whose latest run succeeded → 400 'no paused fx response to resume'", async () => {
  const { createTask, startTask, resumeFxRecovery } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx ordinary turn",
    prompt: "just answer normally",
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
  const run = await waitForRunSettled(runId);
  expect(run.status).toBe("succeeded");

  const result = await resumeFxRecovery(taskId);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(400);
    expect(result.error).toBe("no paused fx response to resume");
  }
});

test("resumeFxRecovery: an fx task with a failed run but no recovery sentinel → 400 'no paused fx response to resume'", async () => {
  const { resumeFxRecovery } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  harnesses.setEnabled("fx", true);

  const taskId = `task-fx-plain-fail-${crypto.randomUUID()}`;
  const runId = `run-fx-plain-fail-${crypto.randomUUID()}`;
  const now = Date.now();
  tasks.insert(baseTask({
    id: taskId,
    column: "ready",
    runId: null,
    createdAt: now,
    updatedAt: now,
  }));
  runs.insert({
    id: runId,
    taskId,
    agent: "fx",
    status: "failed",
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: `fake-fx-session-${taskId}`,
  });

  const result = await resumeFxRecovery(taskId);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(400);
    expect(result.error).toBe("no paused fx response to resume");
  }
});

test("resumeFxRecovery: a turn already in flight for the task → 409", async () => {
  const { createTask, startTask, resumeFxRecovery } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx storm still in flight",
    prompt: `hit the gateway limit ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
    agent: "fx",
    mode: "yolo",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";

  // Called immediately — the storm's terminal chunk doesn't land for ~1.5s,
  // so the run is still registered active and resumeFxRecovery's own
  // in-flight gate (mirrored by the /fx-resume route's synchronous claim)
  // must refuse rather than spawn a second run against the same task.
  const result = await resumeFxRecovery(taskId);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(409);
    expect(result.error).toContain("already in flight");
  }

  // Drain the storm to completion so its timers don't leak past this test.
  await waitForRunSettled(runId, 5000);
});

test("spawnFxRun refactor equivalence: an ordinary sendInput follow-up still echoes the user bubble, logs the 'resuming fx session …' status line, and carries fxSessionId forward — guards the spawnFxTurnNow → spawnFxRun refactor", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx spawnFxRun equivalence",
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
  await waitForRunSettled(firstRunId);
  const priorFxSessionId = runs.get(firstRunId)?.fxSessionId;
  expect(priorFxSessionId).toBeTruthy();

  const res = await sendInput(firstRunId, "hello");
  expect(res.delivered).toBe(true);
  if (!res.delivered) throw new Error("expected delivered:true");
  const secondRunId = res.runId;
  expect(secondRunId).not.toBe(firstRunId);

  await waitForRunSettled(secondRunId);
  expect(runs.get(secondRunId)?.fxSessionId).toBe(priorFxSessionId);

  const secondEvents = runs.eventsForTask(taskId).filter((e) => e.runId === secondRunId);
  expect(secondEvents.some((e) => e.stream === "user" && e.data === "hello")).toBe(true);
  expect(
    secondEvents.some(
      (e) =>
        e.stream === "status"
        && e.data.startsWith("resuming fx session ")
        && e.data.includes((priorFxSessionId ?? "").slice(0, 8)),
    ),
  ).toBe(true);
});

/* ── Phase 8 review #10: spawnFxRun's "not spawned" branches ──────────────
 *
 * `spawnFxRun` used to return the SAME truthy `newRunId` on its two failure
 * branches (missing harness; `spawnAgentOrFail` throwing) as it does on a
 * real spawn — the run row it just wrote is already `failed`, but every
 * caller (`sendFxTurn`, `drainFxQueue`, `resumeFxRecovery`) had no way to
 * tell. `resumeFxRecovery` in particular would report `{ ok: true, runId }`
 * for a resume that never started. The fix: `spawnFxRun` now returns
 * `{ runId, spawned, error? }` (still `null` for the pre-existing "already
 * starting" signal), and `resumeFxRecovery` maps `spawned: false` to a real
 * `{ ok: false, status: 500, error }`.
 *
 * The missing-harness branch is exercised directly below via
 * `__testing.spawnFxRun` — NOT through `resumeFxRecovery`, because
 * `resumeFxRecovery`'s own `resolveHarness(task.agent)?.kind !== "fx"` gate
 * resolves the identical harness synchronously (no `await` in between for
 * the row to vanish before `spawnFxRun` re-resolves it), so any call that
 * clears that gate is guaranteed a resolvable harness — the branch is
 * provably unreachable from that caller. The other failure branch
 * (`spawnAgentOrFail` throwing) has no reachable trigger under the fake fx
 * driver either: `spawnFxRun` always resolves `model` via
 * `task.model ?? DEFAULT_MODEL.fx` and always passes a real `runId`, and
 * those are the only two conditions `buildCommand`'s fx branch throws on
 * (agents.ts, outside this task's file ownership) — unlike gemini's
 * argv-byte-cap throw (see the "spawn-throw hardening" test above), fx's
 * `buildCommand` has no size-style validation to trip since the prompt
 * never rides in argv. Exercising that second branch would require either
 * modifying agents.ts (out of scope for this fix) or a process-wide
 * `mock.module` override of `./agents.ts` in this shared, 1000+-line test
 * file — risking every other fx test that runs after it in the same `bun
 * test` process. Left untested per the task brief's own fallback
 * instruction; `resumeFxRecovery`'s `spawned === false → 500` mapping is a
 * two-line, directly-readable branch exercising the exact same shape the
 * missing-harness test below proves `spawnFxRun` produces. */

test("spawnFxRun (Phase 8 review #10): missing-harness branch returns { spawned: false, error } instead of a bare truthy runId for a run that never started", async () => {
  const { __testing } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");

  const taskId = `task-fx-missing-harness-${crypto.randomUUID()}`;
  const now = Date.now();
  const task = baseTask({
    id: taskId,
    // Not one of the five builtin kind literals `getByIdOrKind` falls back
    // to, and no harness row exists with this id — `resolveHarness` (inside
    // spawnFxRun) returns null.
    agent: "definitely-not-a-real-fx-harness",
    column: "ready",
    runId: null,
    createdAt: now,
    updatedAt: now,
  });
  tasks.insert(task);

  const result = await __testing.spawnFxRun(task, taskId, { line: "hello" });
  expect(result).not.toBeNull();
  if (!result) throw new Error("expected a non-null result");
  expect(result.spawned).toBe(false);
  expect(result.error).toBe(`harness "${task.agent}" not found — cannot resume`);
  expect(typeof result.runId).toBe("string");

  // The run row this branch wrote is recorded `failed` — callers must be
  // able to trust `spawned: false` without also re-deriving it from the run
  // row's own status.
  const run = runs.get(result.runId);
  expect(run?.status).toBe("failed");
  expect(run?.tmuxSession).toBe(sessionNameFor(taskId));

  // The task bounced back to `ready` with no active run, same recovery path
  // as every other spawnFxRun failure branch (and as `startTask`'s own
  // spawn-throw hardening, pinned above for gemini).
  const updated = tasks.get(taskId);
  expect(updated?.column).toBe("ready");
  expect(updated?.runId).toBeNull();
});

test("spawnFxRun (Phase 8 review #10): the ordinary spawn path still returns { spawned: true } (guards the string → object return-shape refactor for every caller)", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { __testing } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx spawnFxRun spawned:true",
    prompt: "turn one",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // Drive it through the real startTask path first so `spawnFxRun` is
  // exercised with the same task shape every other test uses, then call it
  // again directly (idle at this point — no active run) to assert on its
  // return value, which `startTask` itself doesn't expose.
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitForRunSettled("runId" in started ? started.runId : "");

  const task = tasks.get(taskId)!;
  const result = await __testing.spawnFxRun(task, taskId, { line: "turn two" });
  expect(result).not.toBeNull();
  if (!result) throw new Error("expected a non-null result");
  expect(result.spawned).toBe(true);
  expect(result.error).toBeUndefined();
  expect(typeof result.runId).toBe("string");

  await waitForRunSettled(result.runId);
});
