import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Only AGETOR_DATA_DIR belongs at module top level: db.ts captures it at first
// import, `beforeAll` would race a sibling that already imported db.ts, and the
// value is unique per file so nobody inherits it harmfully.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));

// Every OTHER override is scoped to this file and restored afterwards. `bun
// test` shares one process, so a top-level `process.env.X = …` leaks into every
// file that runs later. Concretely: AGETOR_CODEX_DRIVER=fake and
// AGETOR_TMUX_BIN=/bin/echo would break reconcile.test.ts's "startTask honors
// cancel" test, which deliberately uses the REAL codex driver in a REAL tmux
// session so there is something alive to cancel. spawnAgent and the
// agent-status preflight both read these at CALL time, so beforeAll is early
// enough.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake", // in-process fake instead of tmux + the real CLI
  AGETOR_CLAUDE_BIN: "/bin/echo", // agent-status preflight passes without claude
  AGETOR_TMUX_BIN: "/bin/echo", // tmux probe in agent-status passes
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_CODEX_DRIVER: "fake", // only the "codex is inert" test needs this
  AGETOR_CODEX_BIN: "/bin/echo",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

/*
 * Covers the "hold a task in `running` while its background agents are still
 * running" behavior added to `attachDoneHandler` / `maybeReleaseHeldTask` /
 * `isHeldByBackgroundAgents` in src/bun/orchestrator.ts.
 *
 * IMPORTANT — shared-DB hygiene (see docs/plans/hold-task-running-while-
 * background-agents-run.md and the module CLAUDE.md): `bun test` runs every
 * *.test.ts in one process against one SQLite DB. `reconcileOrphans`' boot
 * pass scans BOTH `runs WHERE status='running'` and `tasks WHERE column=
 * 'running'` globally, and will mutate (orphan subagents / release to
 * review) any held task it finds left over from this file. Every task
 * created here is tracked and hard-deleted (cascades to runs/subagents/
 * run_events via FK) in `afterEach` so no test in this file can ever leak a
 * `running` row into `reconcile.test.ts` or any other sibling.
 */

const createdTaskIds: string[] = [];

afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createClaudeTask(title: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo during tests
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

async function insertRunningSubagent(taskId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `agent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId: null, // the gate only keys off task_id — see subagents.hasRunning
    parentKind: "subagent",
    agentType: "Explore",
    description: "test subagent",
    spawnDepth: 1,
    sourcePath: `/tmp/${id}.jsonl`,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

/** Mirrors `insertRunningSubagent` for a `parentKind: "bg_session"` row — the
 *  DB/hold-gate representation of a backgrounded `Bash(run_in_background:
 *  true)` shell (see docs/plans/fix-bg-shell-detection.md §2-3). `hasRunning`
 *  and the release predicate are kind-agnostic, so this should hold/release
 *  identically to a `"subagent"` row. */
async function insertRunningBgShell(taskId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `bgshell-${randomUUID()}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId: null,
    parentKind: "bg_session",
    agentType: "shell",
    description: "test bg shell",
    spawnDepth: 1,
    sourcePath: `/tmp/${id}.output`,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

/** Mirrors `insertRunningBgShell` for a `parentKind: "monitor"` row — the
 *  DB/hold-gate representation of a live Claude Code `Monitor` tool call
 *  (see docs/plans/claude-code-monitors-hold-running.md §3). `hasRunning`
 *  and the release predicate are kind-agnostic, so this should hold/release
 *  identically to a `"subagent"`/`"bg_session"` row. `sourcePath` is empty —
 *  a monitor has no transcript file of its own; its `toolUseId` is the
 *  correlation key back to the launch `tool_use` block. */
async function insertRunningMonitor(taskId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `monitor-${randomUUID()}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId: null,
    parentKind: "monitor",
    agentType: "monitor",
    description: "test monitor",
    spawnDepth: 1,
    sourcePath: "",
    toolUseId: `toolu-${randomUUID()}`,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

test("hold: a succeeded run with a running subagent keeps the task in running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-basic");
  // Insert the running subagent row BEFORE startTask so the gate is
  // deterministic against the fake driver's ~20ms resolve — no race.
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  await wait(250);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");
  const run = runs.get(runId);
  expect(run?.status).toBe("succeeded");
});

test("release: the last subagent leaving running fires the settle hook and moves the task to review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { orphanRunningSubagents } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-release");
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  // Sanity: confirm the task is actually held before driving the release.
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Drive maybeReleaseHeldTask the same way the real watcher does: the last
  // running subagent leaving `running` state fires the settle hook. There's
  // no exported "mark completed and settle" helper, so `orphanRunningSubagents`
  // (which flips every running row and THEN calls the settle hook) is the
  // documented, supported way to trigger this from a test.
  orphanRunningSubagents(taskId);

  expect(subagents.hasRunning(taskId)).toBe(false);
  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
});

test("no hold (regression guard): a succeeded run with no subagent rows goes straight to review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-none");

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
});

// ── bg_session (backgrounded shell) hold coverage ───────────────────────────
// docs/plans/fix-bg-shell-detection.md §2-3: a `Bash(run_in_background: true)`
// shell is tracked as a `parentKind: "bg_session"` subagents row and must hold
// / release exactly like a `"subagent"` row — `hasRunning` and the release
// predicate are kind-agnostic by design (no orchestrator/db changes needed).

test("hold: a succeeded run with a running bg_session row (backgrounded shell) keeps the task in running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-bgshell");
  await insertRunningBgShell(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  await wait(250);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");
  const run = runs.get(runId);
  expect(run?.status).toBe("succeeded");
});

test("release: settling a bg_session row via settleSubagentById releases the task to review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-bgshell-release");
  const bgId = await insertRunningBgShell(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  // Sanity: confirm the task is actually held before driving the release.
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Drive the same externally-detected-completion path a live `<task-
  // notification>` (or restart-safe journal scan) takes: settleSubagentById
  // settles the single row and fires the orchestrator's release hook itself.
  const changed = settleSubagentById(bgId, "completed");
  expect(changed).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(false);
  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
});

test("hasRunning treats subagent and bg_session rows alike: settling only the subagent leaves the bg_session hold intact", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-bgshell-mixed");
  const subagentId = await insertRunningSubagent(taskId);
  const bgId = await insertRunningBgShell(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Settle only the "subagent" row — the bg_session row is still running, so
  // the mixed-kind hold must stay intact and the task must not release.
  const subagentChanged = settleSubagentById(subagentId, "completed");
  expect(subagentChanged).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(true);
  expect(tasks.get(taskId)?.column).toBe("running");

  // Now settle the bg_session row too — the last hold clears, task releases.
  const bgChanged = settleSubagentById(bgId, "completed");
  expect(bgChanged).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("cancelled wins over a hold: task goes to ready, not running", async () => {
  const { startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-cancel");
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  // Cancel immediately — the fake driver's success path doesn't resolve
  // `done()` until ~20ms, so this races ahead of it deterministically.
  const cancelled = cancelRun(runId);
  expect(cancelled).toBe(true);

  await wait(250);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
});

test("api-error wins over a hold: task goes to blocked, not running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-api-error");
  await insertRunningSubagent(taskId);

  // AGETOR_FAKE_CLAUDE_API_ERROR is read inside makeFakeAgent at spawn time —
  // set it right before starting the run and restore it immediately after so
  // it can't leak into sibling tests in this file or elsewhere.
  const prev = process.env.AGETOR_FAKE_CLAUDE_API_ERROR;
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  try {
    const res = await startTask(taskId);
    if (!("runId" in res)) throw new Error("expected the run to start");
    await wait(250);
  } finally {
    if (prev === undefined) delete process.env.AGETOR_FAKE_CLAUDE_API_ERROR;
    else process.env.AGETOR_FAKE_CLAUDE_API_ERROR = prev;
  }

  const task = tasks.get(taskId);
  expect(task?.column).toBe("blocked");
});

test("session-died wins over a hold: task goes to blocked, not running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-session-died");
  await insertRunningSubagent(taskId);

  const prev = process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED;
  process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED = "1";
  try {
    const res = await startTask(taskId);
    if (!("runId" in res)) throw new Error("expected the run to start");
    await wait(250);
  } finally {
    if (prev === undefined) delete process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED;
    else process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED = prev;
  }

  const task = tasks.get(taskId);
  expect(task?.column).toBe("blocked");
});

test("codex is inert to the hold gate: no subagent rows means straight to review", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");

  // Fresh test DBs ship codex disabled by default (migration
  // 016_disable_codex.sql) — enable it for this test only and restore.
  const prevEnabled = harnesses.get("codex")?.enabled ?? false;
  harnesses.setEnabled("codex", true);
  try {
    const created = await createTask({
      title: "hold-codex",
      prompt: "hello",
      agent: "codex",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    createdTaskIds.push(created.task.id);
    const taskId = created.task.id;

    // Codex never writes subagent rows, so the gate is inert by
    // construction — no need to assert `subagents.hasRunning` here.
    const res = await startTask(taskId);
    if (!("runId" in res)) throw new Error("expected the run to start");
    await wait(250);

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");
  } finally {
    harnesses.setEnabled("codex", prevEnabled);
  }
});

test("maybeReleaseHeldTask does not misfire when the user dragged the card out of running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { orphanRunningSubagents } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-dragged-away");
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);
  expect(tasks.get(taskId)?.column).toBe("running"); // sanity: held

  // The user moves the card out of `running` while it's held.
  tasks.update(taskId, { column: "done" });

  // Fires the settle hook (there's still a running subagent row) — the
  // release predicate must see column !== 'running' and bail.
  orphanRunningSubagents(taskId);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("done");
});

test("maybeReleaseHeldTask does not misfire when a newer run is already in flight", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { orphanRunningSubagents } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-newer-run");
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);
  expect(tasks.get(taskId)?.column).toBe("running"); // sanity: held

  // Simulate a follow-up turn already in flight: a second run row that
  // hasn't resolved yet, with the task pointed at it (mirrors what
  // sendTurnInExistingSession does for a real follow-up).
  const runId2 = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runId2,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null,
  });
  tasks.update(taskId, { runId: runId2 });

  // Fires the settle hook — the release predicate must see the pointed-at
  // run isn't `succeeded` yet and bail, leaving the card in `running`.
  orphanRunningSubagents(taskId);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");

  // Terminal-ize the hand-inserted run immediately so no `status='running'`
  // row survives this test — reconcileOrphans scans that globally.
  runs.update(runId2, { status: "succeeded", endedAt: Date.now(), exitCode: 0 });
});

test("Stop on a held task releases it: cancelRun orphans subagents and moves the card to review", async () => {
  const { startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-stop");
  await insertRunningSubagent(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;
  await wait(250);

  // Sanity: the run has already settled and the task is held — the run id
  // is no longer in the orchestrator's `active` map, so cancelRun must take
  // the held-task branch (not the normal in-flight-handle branch).
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // `cancelRun`'s held-task branch calls `interruptTaskSession` only for its
  // side effect (best-effort Ctrl+C) — it never reads the return value, so
  // whatever `/bin/echo` makes the underlying tmux probe report doesn't
  // change the outcome here; the assertion is on cancelRun's own return.
  const cancelled = cancelRun(runId);
  expect(cancelled).toBe(true);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
  expect(subagents.hasRunning(taskId)).toBe(false);
});

// ── monitor (Claude Code Monitor) hold coverage ─────────────────────────────
// docs/plans/claude-code-monitors-hold-running.md §3: a live Claude Code
// `Monitor` tool call is tracked as a `parentKind: "monitor"` subagents row
// and must hold/release exactly like a `"subagent"`/`"bg_session"` row —
// `hasRunning` and the release predicate are kind-agnostic by design (no
// orchestrator/db changes needed for the hold itself).

test("hold: a succeeded run with a running monitor row keeps the task in running and emits the hold breadcrumb", async () => {
  const { startTask, subscribe } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-monitor");
  await insertRunningMonitor(taskId);

  // Capture live-broadcast status events the same way
  // "createTask + startTask runs to completion and emits stdout" does —
  // the hold breadcrumb (orchestrator.ts, the `holdForSubagents` branch) is
  // only ever `emit()`-ed for SSE fan-out, never `runs.appendEvent`-persisted,
  // so it must be caught in flight via `subscribe`, not read back from
  // `runs.eventsForTask`.
  const statuses: string[] = [];
  const unsub = subscribe((e) => {
    if (e.stream === "status") statuses.push(e.data);
  });

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  await wait(250);
  unsub();

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");
  const run = runs.get(runId);
  expect(run?.status).toBe("succeeded");

  // Pinned UI-facing copy — assert on it verbatim, don't paraphrase it.
  expect(statuses).toContain("background agents still running (1) — holding in running");
});

test("release: settleSubagentById(id, \"completed\", \"receipt\") on a monitor row releases the task to review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-monitor-release");
  const monitorId = await insertRunningMonitor(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  // Sanity: confirm the task is actually held before driving the release.
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Drive the same externally-detected-completion path a live monitor
  // terminal `<task-notification>` (or the restart-safe journal scan) takes:
  // `settleSubagentById(..., "receipt")` settles the row and fires the
  // orchestrator's release hook (`maybeReleaseHeldTask`) itself.
  const changed = settleSubagentById(monitorId, "completed", "receipt");
  expect(changed).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(false);
  const task = tasks.get(taskId);
  expect(task?.column).toBe("review");
});

test("hasRunning treats monitor and bg_session rows alike: settling one leaves the hold intact, settling both releases (count-agnostic)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("hold-monitor-mixed");
  const monitorId = await insertRunningMonitor(taskId);
  const bgId = await insertRunningBgShell(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);
  expect(subagents.runningCountForTask(taskId)).toBe(2);

  // Settle only the monitor row — the bg_session row is still running, so
  // the mixed-kind hold must stay intact and the task must not release.
  const monitorChanged = settleSubagentById(monitorId, "completed", "receipt");
  expect(monitorChanged).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(true);
  expect(tasks.get(taskId)?.column).toBe("running");

  // Now settle the bg_session row too — the last hold clears, task releases,
  // regardless of how many rows or which kinds were involved.
  const bgChanged = settleSubagentById(bgId, "completed");
  expect(bgChanged).toBe(true);

  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("cancelled wins over a monitor hold: task goes to ready, not running", async () => {
  const { startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-monitor-cancel");
  await insertRunningMonitor(taskId);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  const runId = res.runId;

  // Cancel immediately — the fake driver's success path doesn't resolve
  // `done()` until ~20ms, so this races ahead of it deterministically.
  const cancelled = cancelRun(runId);
  expect(cancelled).toBe(true);

  await wait(250);

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
});

test("subagents.runningCountForTask and runningCountsByTask count a monitor row — what the board badge shows", async () => {
  const { subagents } = await import("./db.ts");

  const taskId = await createClaudeTask("hold-monitor-count");
  await insertRunningMonitor(taskId);

  expect(subagents.runningCountForTask(taskId)).toBe(1);
  const counts = subagents.runningCountsByTask();
  expect(counts.get(taskId)).toBe(1);
});
