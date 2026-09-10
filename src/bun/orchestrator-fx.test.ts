import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent, Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fx-orch-"));
// Drive fx through the in-process fake (no ACP child process, no real CLI).
// fx's fake spawn calls onSessionId with a DISCOVERED session id (mirrors
// codex's `thread.started` timing, not claude/gemini's pre-generated-uuid
// pattern — see agents.ts's spawnAgent fx branch), so we can exercise the
// orchestrator's fx session bookkeeping + multi-turn routing deterministically.
process.env.AGETOR_FX_DRIVER = "fake";
// Auto-resume timer hygiene (docs/plans/fx-recovery-follow-ups.md §3 T2 /
// TT3). Every fake-fx "storm" scenario that settles paused now runs through
// `recordFxPause`, which arms a REAL in-memory `setTimeout` via the auto-
// resume engine. Left at its default (`FX_AUTO_RESUME_DEFAULT_DELAY_SEC` =
// 120s), that timer is `.unref()`'d (so it never keeps `bun test`'s process
// alive on its own) but still fires 120s later INSIDE the same process if
// nothing cancels it first — and `bun test` runs many files in one process,
// so a leftover 120s timer from this file WAS observed firing in the middle
// of an unrelated later test file's run. Overriding the delay here — before
// any test imports orchestrator.ts — keeps every timer this file arms short
// enough to fire (or be explicitly cancelled) well within this file's own
// lifetime. See the `afterEach`/`afterAll` below for the other half of the
// hygiene fix.
process.env.AGETOR_FX_AUTO_RESUME_DELAY_MS = "300";

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

// Belt-and-braces auto-resume timer cleanup (see the AGETOR_FX_AUTO_RESUME_
// DELAY_MS comment above): clear every in-memory auto-resume timer after
// EVERY test, not just at the end of the file, so a test that pauses an fx
// task but doesn't itself wait out (or explicitly cancel) the schedule can
// never leak a live timer into the next test in this file. Tests that
// specifically assert on a pending/fired schedule do so before returning, so
// this runs after that assertion has already been made — it never races a
// test's own logic, only cleans up whatever is left once the test is done.
// `stopFxAutoResumeTimers` only clears the in-memory Map; it never touches a
// persisted `fx_recovery` DB row, so tests that need a clean DB row too
// still resolve/cancel it themselves.
afterEach(async () => {
  const { stopFxAutoResumeTimers } = await import("./orchestrator.ts");
  stopFxAutoResumeTimers();
});

afterAll(async () => {
  const { stopFxAutoResumeTimers } = await import("./orchestrator.ts");
  stopFxAutoResumeTimers();
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `predicate()` until it returns true, or throw after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 30): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await settle(intervalMs);
  }
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
  // The pause it settles into arms a real (300ms, per the file-level
  // AGETOR_FX_AUTO_RESUME_DELAY_MS override) auto-resume timer — cancel it
  // explicitly rather than lean solely on the file's `afterEach` hygiene net,
  // since this test doesn't otherwise touch the auto-resume engine at all.
  await waitForRunSettled(runId, 5000);
  const { cancelFxAutoResume, __testing } = await import("./orchestrator.ts");
  cancelFxAutoResume(taskId, "cancelled");
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);
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

/* ── TT3 (docs/plans/fx-recovery-follow-ups.md §3 T2): auto-resume engine
 * ─────────────────────────────────────────────────────────────────────────
 * Every test below runs under the file-level AGETOR_FX_AUTO_RESUME_DELAY_MS
 * = "300" override set at the top of this file, so a scheduled auto-resume
 * fires ~300ms after the pause that scheduled it, not the real 120s
 * default. Item 8 of the test brief ("reconcileTaskSession switching INTO fx
 * resets mode via defaultModeFor, literal 'yolo'") is already covered above
 * by "reconcileTaskSession resets mode to fx's own modes[0] when switching
 * INTO fx from another kind" — not duplicated here. */

test("fx auto-resume: storm → paused (scheduled, attempt 1/3) → timer fires → resumes → recovers, row clears", async () => {
  const { createTask, startTask, subscribeGlobal, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));
  try {
    const created = await createTask({
      title: "fx auto-resume happy path",
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

    // The row is set exactly per the shared spec: paused, naming run 1, a
    // fresh schedule for attempt 1/3, count still 0 (the counter only
    // advances once the timer actually fires — see fireFxAutoResume).
    const rec = tasks.get(taskId)?.fxRecovery;
    expect(rec?.state).toBe("paused");
    expect(rec?.runId).toBe(firstRunId);
    expect(rec?.autoResumeCount).toBe(0);
    expect(rec?.autoResume?.attempt).toBe(1);
    expect(rec?.autoResume?.max).toBe(3);
    expect([0, 1]).toContain(rec?.autoResume?.delaySec ?? -1);
    expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

    const firstEvents = runs.eventsForTask(taskId).filter((e) => e.runId === firstRunId);
    expect(
      firstEvents.some((e) => e.stream === "status" && /^auto-resume scheduled in \d+ s \(1\/3\)$/.test(e.data)),
    ).toBe(true);
    expect(
      globals.some((e) => e.kind === "fx-auto-resume" && e.state === "scheduled" && e.attempt === 1 && e.max === 3),
    ).toBe(true);

    // Wait for the timer to fire (spawns run 2) and for run 2 to settle —
    // the fake driver's "continue" variant recovers on the first attempt.
    await waitFor(() => runs.listForTask(taskId).length === 2, 4000);
    const secondRun = runs.listForTask(taskId).find((r) => r.id !== firstRunId)!;
    await waitForRunSettled(secondRun.id, 3000);

    expect(
      globals.some((e) => e.kind === "fx-auto-resume" && e.state === "fired" && e.attempt === 1 && e.max === 3),
    ).toBe(true);

    const secondEvents = runs.eventsForTask(taskId).filter((e) => e.runId === secondRun.id);
    expect(
      secondEvents.some(
        (e) => e.stream === "status" && e.data.startsWith("auto-resuming paused fx response (1/3) in session "),
      ),
    ).toBe(true);
    expect(secondEvents.some((e) => e.stream === "assistant" && e.data === "recovered answer")).toBe(true);

    expect(runs.get(secondRun.id)?.status).toBe("succeeded");
    expect(tasks.get(taskId)?.column).toBe("review");
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();
    expect(__testing.pendingFxAutoResume(taskId)).toBe(false);
  } finally {
    unsub();
  }
}, 10000);

test("fx auto-resume: cap — a repause chain reaches FX_AUTO_RESUME_MAX and stops with autoResumeStopped:'exhausted'; a manual resume afterward still works", async () => {
  const { createTask, startTask, resumeFxRecovery, subscribeGlobal, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  const { FX_AUTO_RESUME_MAX } = await import("../shared/types.ts");
  harnesses.setEnabled("fx", true);

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));
  // AGETOR_FAKE_FX_REPAUSE=1 makes every "continue" turn re-storm instead of
  // recovering — the ONLY way to drive a repause on a continueRecovery
  // launch, since that turn's prompt is always empty (the prompt-marker
  // trigger can never reach it — see FAKE_FX_REPAUSE_PROMPT_MARKER's doc
  // comment in agents.ts). Scoped to this test via try/finally so it can't
  // leak into any other test in this file.
  process.env.AGETOR_FAKE_FX_REPAUSE = "1";
  try {
    const created = await createTask({
      title: "fx auto-resume cap",
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
    await waitForRunSettled(firstRunId, 5000);

    // Chain: pause 1 -> auto 1 -> repause 2 -> auto 2 -> repause 3 -> auto 3
    // -> repause 4, at which point autoResumeCount has reached
    // FX_AUTO_RESUME_MAX (3) and recordFxPause gives up instead of
    // scheduling a 4th attempt. Each storm cycle is ~1.5s + a 300ms wait —
    // generous poll budget below.
    await waitFor(() => tasks.get(taskId)?.fxRecovery?.autoResumeStopped === "exhausted", 15000, 100);

    const rec = tasks.get(taskId)?.fxRecovery;
    expect(rec?.state).toBe("paused");
    expect(rec?.autoResume).toBeNull();
    expect(rec?.autoResumeCount).toBe(FX_AUTO_RESUME_MAX);
    expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

    // 1 initial pause + 3 repauses == 4 run rows, all failed.
    const list = runs.listForTask(taskId);
    expect(list.length).toBe(4);
    expect(list.every((r) => r.status === "failed")).toBe(true);

    // The row still names the run that recorded the exhausted verdict —
    // more robust than re-deriving "the last one" from startedAt ordering.
    const lastRunId = rec!.runId;
    const lastEvents = runs.eventsForTask(taskId).filter((e) => e.runId === lastRunId);
    expect(
      lastEvents.some(
        (e) =>
          e.stream === "status"
          && e.data === `auto-resume gave up after ${FX_AUTO_RESUME_MAX} attempts — resume manually once the limit clears`,
      ),
    ).toBe(true);
    expect(
      globals.some(
        (e) => e.kind === "fx-auto-resume" && e.state === "exhausted" && e.attempt === FX_AUTO_RESUME_MAX,
      ),
    ).toBe(true);

    // A manual resume still works once the repause storm is turned off —
    // recovers the checkpoint and clears the whole chain (row + counter).
    delete process.env.AGETOR_FAKE_FX_REPAUSE;
    const resumed = await resumeFxRecovery(taskId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.error);
    await waitForRunSettled(resumed.runId, 3000);
    expect(runs.get(resumed.runId)?.status).toBe("succeeded");
    expect(tasks.get(taskId)?.fxRecovery).toBeNull();
  } finally {
    delete process.env.AGETOR_FAKE_FX_REPAUSE;
    unsub();
  }
}, 25000);

test("fx auto-resume: cancelFxAutoResume cancels a pending schedule (status line, event, row kept but schedule cleared); a second call is a no-op", async () => {
  const { createTask, startTask, cancelFxAutoResume, subscribeGlobal, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));
  try {
    const created = await createTask({
      title: "fx auto-resume cancel",
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
    await waitForRunSettled(runId, 5000);
    expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

    const cancelled = cancelFxAutoResume(taskId, "cancelled");
    expect(cancelled).toBe(true);

    const rec = tasks.get(taskId)?.fxRecovery;
    expect(rec?.state).toBe("paused"); // still paused — cancel clears the schedule, not the pause.
    expect(rec?.autoResume).toBeNull();
    expect(rec?.autoResumeStopped).toBe("cancelled");
    expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

    const events = runs.eventsForTask(taskId).filter((e) => e.runId === runId);
    expect(events.some((e) => e.stream === "status" && e.data === "auto-resume cancelled")).toBe(true);
    expect(
      globals.some((e) => e.kind === "fx-auto-resume" && e.state === "cancelled" && e.attempt === 1 && e.max === 3),
    ).toBe(true);

    // A second call has nothing left to cancel.
    expect(cancelFxAutoResume(taskId, "cancelled")).toBe(false);
  } finally {
    unsub();
  }
}, 8000);

test("fx auto-resume: cancelRun (Stop) on a paused task with no active run cancels the pending auto-resume timer instead of failing", async () => {
  const { createTask, startTask, cancelRun, __testing } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx auto-resume cancelRun",
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
  await waitForRunSettled(runId, 5000);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

  // No `active` handle exists for this run (it already settled) —
  // cancelRun's fallback path must find the pending fx auto-resume timer and
  // cancel it, rather than returning false.
  const result = await cancelRun(runId);
  expect(result).toBe(true);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);
  expect(tasks.get(taskId)?.fxRecovery?.autoResumeStopped).toBe("cancelled");
}, 8000);

test("fx auto-resume: an ordinary sendInput follow-up while a schedule is pending cancels the timer and clears the row once the new turn spawns", async () => {
  const { createTask, startTask, sendInput, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx auto-resume + follow-up",
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
  await waitForRunSettled(firstRunId, 5000);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

  // A plain follow-up (no recovery marker) — the ordinary idle-send path.
  // sendFxTurn cancels the pending timer synchronously as its first act,
  // before any await, then spawns a normal turn whose own row lifecycle
  // (spawnFxRun's `{ line }` branch) clears the fxRecovery row outright.
  const res = await sendInput(firstRunId, "an ordinary follow-up");
  expect(res.delivered).toBe(true);
  if (!res.delivered) throw new Error("expected delivered:true");
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

  await waitForRunSettled(res.runId, 3000);
  expect(runs.get(res.runId)?.status).toBe("succeeded");
  expect(tasks.get(taskId)?.fxRecovery).toBeNull();
}, 8000);

test("fx auto-resume: a manual resumeFxRecovery while a schedule is pending cancels the timer first, and the resumed run's opening status uses the manual (not 'auto-resuming') wording", async () => {
  const { createTask, startTask, resumeFxRecovery, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx auto-resume + manual resume",
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
  await waitForRunSettled(firstRunId, 5000);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

  const resumed = await resumeFxRecovery(taskId);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) throw new Error(resumed.error);
  // resumeFxRecovery's manual branch cancels the timer synchronously, before
  // spawnFxRun is ever called.
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

  const secondEvents = runs.eventsForTask(taskId).filter((e) => e.runId === resumed.runId);
  expect(
    secondEvents.some((e) => e.stream === "status" && e.data.startsWith("resuming paused fx response in session ")),
  ).toBe(true);
  expect(secondEvents.some((e) => e.stream === "status" && e.data.includes("auto-resuming"))).toBe(false);

  await waitForRunSettled(resumed.runId, 3000);
  expect(runs.get(resumed.runId)?.status).toBe("succeeded");
  expect(tasks.get(taskId)?.fxRecovery).toBeNull();
}, 8000);

test("fx auto-resume: the fxAutoResume preference off marks the pause autoResumeStopped:'disabled' with no timer scheduled", async () => {
  const { createTask, startTask, subscribeGlobal, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses, preferences } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  const { FX_AUTO_RESUME_PREF } = await import("../shared/types.ts");
  harnesses.setEnabled("fx", true);

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));
  preferences.set(FX_AUTO_RESUME_PREF, "off");
  try {
    const created = await createTask({
      title: "fx auto-resume pref off",
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
    await waitForRunSettled(runId, 5000);

    const rec = tasks.get(taskId)?.fxRecovery;
    expect(rec?.state).toBe("paused");
    expect(rec?.autoResume).toBeNull();
    expect(rec?.autoResumeStopped).toBe("disabled");
    expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

    const events = runs.eventsForTask(taskId).filter((e) => e.runId === runId);
    expect(
      events.some((e) => e.stream === "status" && e.data === "auto-resume disabled in Settings — resume manually"),
    ).toBe(true);
    expect(
      globals.some((e) => e.kind === "fx-auto-resume" && e.state === "disabled" && e.attempt === 1 && e.max === 3),
    ).toBe(true);
  } finally {
    unsub();
    preferences.set(FX_AUTO_RESUME_PREF, "on");
  }
}, 8000);

test("fx auto-resume: two synchronous resumeFxRecovery calls on the same paused task → exactly one ok:true, the other {status:409}", async () => {
  const { createTask, startTask, resumeFxRecovery, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx auto-resume concurrency",
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
  await waitForRunSettled(firstRunId, 5000);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

  // resumeFxRecovery's `resumingTaskIds` claim is synchronous and taken
  // before any `await`, so calling it twice back-to-back (no intervening
  // await on the caller's side) deterministically lets the first call run
  // its entire gating chain — including the claim — before the second call
  // even starts.
  const [first, second] = await Promise.all([resumeFxRecovery(taskId), resumeFxRecovery(taskId)]);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.status).toBe(409);
    expect(second.error).toContain("already in flight");
  }
  if (!first.ok) throw new Error("expected the first call to succeed");

  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

  await waitForRunSettled(first.runId, 3000);
  expect(runs.get(first.runId)?.status).toBe("succeeded");
  expect(tasks.get(taskId)?.fxRecovery).toBeNull();
}, 8000);

test("rearmFxAutoResumes: re-arms a past-due persisted schedule (fires after a real, staggered timer), and clears a stale row whose runId no longer names the task's latest resumable pause", async () => {
  const { createTask, startTask, rearmFxAutoResumes, cancelFxAutoResume, __testing } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  async function pausedTask(title: string): Promise<{ taskId: string; runId: string }> {
    const created = await createTask({
      title,
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
    await waitForRunSettled(runId, 5000);
    return { taskId, runId };
  }

  // rearmFxAutoResumes sweeps every non-archived task in the DB with a
  // pending schedule — not scoped to this test's own tasks — so every
  // assertion below is a DELTA against a baseline sweep taken right before
  // each scenario, rather than an absolute count. (`bun test` runs every
  // matched file in one process sharing one `db.ts`/`orchestrator.ts`
  // singleton — see the file-level hygiene comment at the top of this file —
  // so an absolute "returns exactly N" assertion would be fragile against
  // whatever else happens to be pending elsewhere at the moment this runs.)
  const baseline = await rearmFxAutoResumes();

  // Scenario (b): a stale row — its `runId` no longer names the task's
  // CURRENT latest resumable pause. Cancel the real schedule the storm just
  // armed, then hand-craft a stale, past-due one in its place.
  const stale = await pausedTask("fx rearm stale");
  cancelFxAutoResume(stale.taskId, "cancelled");
  const staleRec = tasks.get(stale.taskId)?.fxRecovery;
  if (!staleRec) throw new Error("expected a paused fxRecovery row");
  tasks.setFxRecovery(stale.taskId, {
    ...staleRec,
    runId: "not-the-real-run-id",
    autoResume: { at: Date.now() - 1000, attempt: 1, max: 3, delaySec: 1 },
    autoResumeStopped: undefined,
  });

  const armedAfterStale = await rearmFxAutoResumes();
  expect(armedAfterStale).toBe(baseline); // the stale row contributed zero.
  expect(tasks.get(stale.taskId)?.fxRecovery).toBeNull();
  expect(__testing.pendingFxAutoResume(stale.taskId)).toBe(false);

  // Scenario (a): a valid past-due schedule for a genuinely-still-paused
  // task — rearm must re-arm it (short, staggered), not fire it inline.
  const valid = await pausedTask("fx rearm past-due");
  cancelFxAutoResume(valid.taskId, "cancelled");
  const validRec = tasks.get(valid.taskId)?.fxRecovery;
  if (!validRec) throw new Error("expected a paused fxRecovery row");
  tasks.setFxRecovery(valid.taskId, {
    ...validRec,
    autoResume: { at: Date.now() - 1000, attempt: 2, max: 3, delaySec: 1 },
    autoResumeStopped: undefined,
  });

  const armedAfterValid = await rearmFxAutoResumes();
  expect(armedAfterValid).toBe(armedAfterStale + 1); // exactly this task's row was newly armed.
  expect(__testing.pendingFxAutoResume(valid.taskId)).toBe(true);

  // rearmFxAutoResumes's stagger for an overdue entry is a fixed
  // `now + 5000 + i*2000` (NOT affected by AGETOR_FX_AUTO_RESUME_DELAY_MS) —
  // wait for the real fire and the resume run it spawns.
  await waitFor(() => runs.listForTask(valid.taskId).length === 2, 12000, 100);
  const secondRun = runs.listForTask(valid.taskId).find((r) => r.id !== valid.runId)!;
  await waitForRunSettled(secondRun.id, 3000);
  expect(runs.get(secondRun.id)?.status).toBe("succeeded");
  expect(tasks.get(valid.taskId)?.fxRecovery).toBeNull();
}, 20000);

/* ── Phase 8 code-review fixes (docs/plans/fx-recovery-follow-ups.md, wave
 * 2 review) ────────────────────────────────────────────────────────────── */

test("startTask (fx): a stored null mode's opening status breadcrumb reports the resolved default (mode=yolo), not the literal string 'auto' (Phase 8 review #3)", async () => {
  const { createTask, startTask, subscribe } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx null mode breadcrumb",
    prompt: "do a thing",
    agent: "fx",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    // mode intentionally omitted — createTask stores it as null (input.mode
    // ?? null); buildCommand/spawnAgent resolve that null via
    // defaultModeFor("fx"), which is "yolo" (AGENT_OPTIONS.fx.modes[0]), not
    // a literal "auto" — the started-status breadcrumb must agree.
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.mode).toBeNull();
  const taskId = created.task.id;

  // The opening "started — …" breadcrumb is a live-only `emit()` (SSE
  // fan-out), never persisted to `run_events` — subscribe before starting,
  // not after, since `startTask` fires it synchronously inline with the
  // spawn, well before this call even returns.
  const statuses: string[] = [];
  const unsub = subscribe((e) => {
    if (e.taskId === taskId && e.stream === "status") statuses.push(e.data);
  });
  try {
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    await settle(120);
  } finally {
    unsub();
  }

  const startedLine = statuses.find((s) => s.startsWith("started — "));
  expect(startedLine).toBeDefined();
  expect(startedLine).toContain("mode=yolo");
  expect(startedLine).not.toContain("mode=auto");
}, 8000);

test("startTask (fx): a pre-flight failure leaves a paused fxRecovery row untouched; only a start that reaches the run-row insert clears it (Phase 8 review #2)", async () => {
  const { createTask, startTask, cancelFxAutoResume } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx clearFxRecovery ordering",
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
  await waitForRunSettled(firstRunId, 5000);

  // Cancel the pending auto-resume timer first — this assertion is about the
  // PERSISTED row surviving a pre-flight failure, not about a still-armed
  // timer surviving (that's covered by the other auto-resume tests above).
  cancelFxAutoResume(taskId, "cancelled");
  const pausedRec = tasks.get(taskId)?.fxRecovery;
  expect(pausedRec?.state).toBe("paused");

  const prevBin = process.env.AGETOR_FX_BIN;
  process.env.AGETOR_FX_BIN = "/nonexistent/agetor-test-fx-binary-does-not-exist";
  try {
    const failedStart = await startTask(taskId);
    expect("error" in failedStart).toBe(true);
    if ("error" in failedStart) expect(failedStart.error).toMatch(/not available/);
  } finally {
    if (prevBin === undefined) delete process.env.AGETOR_FX_BIN;
    else process.env.AGETOR_FX_BIN = prevBin;
  }

  // The aborted Start must not have touched the paused row at all — before
  // the fix, `clearFxRecovery` ran unconditionally at the very top of
  // `startTaskInner`, so a Start that failed on ANY pre-flight check
  // (harness availability here; worktree prep or the prompt-budget check
  // would hit the same bug) silently discarded the user's only path back to
  // the paused response even though no new turn ever actually started.
  expect(tasks.get(taskId)?.fxRecovery).toEqual(pausedRec);

  // With the real (fake) binary restored, a start that actually proceeds
  // past every pre-flight check DOES clear the row — right before the new
  // run row is inserted, unconditional on how the spawn itself later
  // resolves.
  const secondStart = await startTask(taskId);
  if ("error" in secondStart) throw new Error(secondStart.error);
  expect(tasks.get(taskId)?.fxRecovery).toBeNull();

  const secondRunId = "runId" in secondStart ? secondStart.runId : "";
  await waitForRunSettled(secondRunId, 5000);
}, 15000);

test("noteFxRunSettled clears a stale paused row via clearFxRecovery — cancels a still-armed in-memory auto-resume timer, not just the DB row (Phase 8 review #5)", async () => {
  const { createTask, startTask, __testing } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx noteFxRunSettled stale clear",
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
  await waitForRunSettled(firstRunId, 5000);

  // recordFxPause just armed a real (AGETOR_FX_AUTO_RESUME_DELAY_MS-
  // overridden) in-memory timer for this task's pause — confirm it's
  // actually pending before simulating the race fix #5 guards against.
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);
  const pausedTask = tasks.get(taskId);
  if (!pausedTask) throw new Error("expected task to exist");
  expect(pausedTask.fxRecovery?.state).toBe("paused");

  // Simulate an unrelated run for this same task settling for a non-"failed"
  // reason (short-circuits the pause-detection branch regardless of runId)
  // WHILE the timer from the earlier pause is still armed. Every REAL spawn
  // path (spawnFxRun's two row lifecycles, startTaskInner) already disarms
  // the timer before its own run can reach this hook, so driving
  // `noteFxRunSettled` directly is the only deterministic way to exercise
  // this exact precondition.
  __testing.noteFxRunSettled(pausedTask, "unrelated-run-id", "succeeded");

  // Before the fix, this branch called `tasks.setFxRecovery(taskId, null)`
  // directly — clearing the DB row but leaving the in-memory timer armed, so
  // it would still be sitting in `fxAutoResumeTimers` ready to fire later
  // against an already-null row. The fix routes through `clearFxRecovery`,
  // which cancels the timer too.
  expect(tasks.get(taskId)?.fxRecovery).toBeNull();
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);
}, 8000);

test("fireFxAutoResume: when resumeFxRecovery itself rejects the auto-resume attempt, the row is persisted with autoResumeStopped:'failed' — not 'cancelled', which is reserved for an explicit user/Stop cancel (Phase 8 review #1)", async () => {
  const { createTask, startTask, __testing } = await import("./orchestrator.ts");
  const { db, tasks, runs, harnesses } = await import("./db.ts");
  const { FAKE_FX_RECOVERY_PROMPT_MARKER } = await import("./agents.ts");
  harnesses.setEnabled("fx", true);

  const created = await createTask({
    title: "fx auto-resume failed-not-cancelled",
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
  await waitForRunSettled(firstRunId, 5000);
  expect(__testing.pendingFxAutoResume(taskId)).toBe(true);

  // Drive `resumeFxRecovery` itself to reject the attempt the timer is about
  // to fire, deterministically, without relying on a genuinely racy
  // concurrent `resumingTaskIds` claim (documented as effectively
  // unreachable via the fake driver — see this fix's plan-brief note).
  // `fireFxAutoResume`'s OWN pre-checks (task exists, has a pending
  // `autoResume`, isn't archived, nothing `active`) never look at the
  // harness at all, so they still pass unchanged; `resumeFxRecovery`'s
  // re-fetch then hits its own harness-kind gate (`resolveHarness(task.agent
  // )?.kind !== "fx"`) and returns `{ ok: false }` — the same outward shape
  // a `resumingTaskIds` collision or a genuine spawn failure would produce,
  // exercising the exact branch under test.
  tasks.update(taskId, { agent: "does-not-exist" });

  // Read the RAW `fx_recovery` column via SQL rather than `tasks.get()` /
  // `__testing.pendingFxAutoResume`'s typed round-trip: this repo's landing
  // order has `src/shared/types.ts`'s `TaskFxRecovery["autoResumeStopped"]`
  // union (and `src/shared/fx-recovery.ts`'s matching tolerant-parser
  // allow-list) gaining the `"failed"` literal in a sibling, concurrent
  // change — outside this fix's four-file boundary. Until that lands, the
  // shared parser's `AUTO_RESUME_STOPPED_REASONS` allow-list doesn't yet
  // recognize `"failed"` and silently drops it on read-back (the same
  // tolerant behavior that protects against a corrupt/future-version row),
  // which would make a `tasks.get()`-based assertion here a false negative
  // against a correctly-written value, not a real failure of this fix.
  // Querying the column directly proves what `fireFxAutoResume` actually
  // persisted, independent of that landing order.
  await waitFor(() => {
    const row = db.query<{ fx_recovery: string | null }, [string]>(
      `SELECT fx_recovery FROM tasks WHERE id = ?`,
    ).get(taskId);
    return !!row?.fx_recovery && JSON.parse(row.fx_recovery).autoResumeStopped != null;
  }, 4000, 30);

  const row = db.query<{ fx_recovery: string | null }, [string]>(
    `SELECT fx_recovery FROM tasks WHERE id = ?`,
  ).get(taskId);
  const rawRec = row?.fx_recovery ? JSON.parse(row.fx_recovery) : null;
  expect(rawRec?.autoResumeStopped).toBe("failed");
  expect(rawRec?.autoResumeStopped).not.toBe("cancelled");
  expect(rawRec?.autoResume).toBeNull();
  expect(__testing.pendingFxAutoResume(taskId)).toBe(false);

  const events = runs.eventsForTask(taskId).filter((e) => e.runId === firstRunId);
  expect(
    events.some((e) => e.stream === "status" && e.data.startsWith("auto-resume could not start: ")),
  ).toBe(true);
}, 8000);
