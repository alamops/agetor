import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task, Run, Subagent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-reconcile-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

/** Tracks task ids created by the boot-reconciliation-of-held-tasks tests
 *  below so `afterEach` can drop them (cascade-deletes their runs +
 *  subagents rows via the FK). Pre-existing tests above/below don't push
 *  here, so this is a silent no-op for them. Cleanup matters here more than
 *  in most files: `reconcileOrphans` now scans `tasks WHERE "column" =
 *  'running'` globally, so a leftover held-shaped row would keep getting
 *  re-visited (harmlessly, but wastefully) by every later call in this
 *  process, including from sibling test files in the combined `bun test`.
 *  Since the widened boot pass sources from `subagents.taskIdsWithRunning()`
 *  (every task with a `running` subagent row, regardless of column — not
 *  just `column = 'running'`), this hygiene now matters for ANY column a
 *  test below parks a task in, not only `running`. */
let cleanupTaskIds: string[] = [];
afterEach(async () => {
  if (cleanupTaskIds.length === 0) return;
  const { db } = await import("./db.ts");
  for (const id of cleanupTaskIds) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
  cleanupTaskIds = [];
});

/** Write an executable fake `tmux` that always exits `code` regardless of
 *  args, then point AGETOR_TMUX_BIN at it — makes `sessionExistsByName`
 *  deterministic without depending on a real tmux server or on whatever
 *  ambient AGETOR_TMUX_BIN a sibling test file left behind in this shared
 *  process. Mirrors the `fakeTmux` helper in claude-tmux-death.test.ts.
 *  Returns a restore fn; callers must call it (use try/finally).
 *
 *  Optional `logPath`: every invocation appends its full argv to that file
 *  (one line per call) before exiting — used by the kill-safety test below
 *  to assert `kill-session` never appears in the boot pass's tmux traffic,
 *  without needing a real tmux server or a mocked module. */
function fakeTmux(code: number, stderr = "", logPath?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-reconcile-faketmux-"));
  const bin = path.join(dir, "tmux");
  const logCmd = logPath ? `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\n` : "";
  writeFileSync(bin, `#!/bin/sh\n${logCmd}>&2 printf '%s' ${JSON.stringify(stderr)}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

/** A task row shaped like the "held by background agents" state: parked in
 *  `running` with a run id already set. Callers override `column`/`agent`/etc.
 *  as needed per case. */
function heldTaskRow(overrides: Partial<Task> & { id: string; runId: string | null }): Task {
  const now = Date.now();
  return {
    title: "held",
    prompt: "p",
    column: "running",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [], backlog: [], draft: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A terminal ("succeeded") run row — the shape a held task's run must have
 *  per `isHeldByBackgroundAgents`. Per the plan's documented test gotcha,
 *  tests must never leave a `status:'running'` run row lying around: the
 *  FIRST reconcile pass scans `runs WHERE status='running'` globally, so a
 *  stray one breaks sibling assertions in the combined `bun test`. */
function succeededRun(id: string, taskId: string, overrides: Partial<Run> = {}): Run {
  const now = Date.now();
  return {
    id,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: `sess-${randomUUID()}`,
    codexSessionId: null,
    ...overrides,
  };
}

function subagentRow(id: string, taskId: string, runId: string | null, overrides: Partial<Subagent> = {}): Subagent {
  const now = Date.now();
  return {
    id,
    taskId,
    runId,
    parentKind: "subagent",
    agentType: "Explore",
    description: "test subagent",
    spawnDepth: 1,
    sourcePath: "/tmp/agent.jsonl",
    status: "running",
    startedAt: now,
    endedAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await import("./db.ts");
  // Importing orchestrator.ts runs its module top level, which registers the
  // real `maybeReleaseHeldTask` as the subagent settle hook. The held-task
  // tests below rely on that hook firing when `orphanRunningSubagents` clears
  // the last `running` row. (Sibling test files save/restore the hook rather
  // than nulling it, so it survives whatever order `bun test` picks.)
  await import("./orchestrator.ts");
});

afterAll(async () => {
  // Hygiene: the real-tmux cancel test below spins up sessions on the
  // isolated test socket (NODE_ENV=test → "agetor-test"); kill that whole
  // test server so it doesn't linger after the suite. Best-effort — never
  // throws — and ONLY when tmuxSocketName() is non-null: we must NEVER
  // kill-server the user's default tmux socket (that is the exact incident
  // socket isolation exists to prevent).
  try {
    const { resolveTmuxBin, tmuxSocketName, tmuxSocketArgs } = await import(
      "./tmux-resolution.ts"
    );
    if (tmuxSocketName() === null) return;
    Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-server"]);
  } catch {
    // best-effort only — a missing tmux bin or dead server is fine.
  }
});

test("reconcileOrphans marks running rows as orphaned and returns tasks to ready", async () => {
  const { db, tasks, runs } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  // Randomised so we don't collide with leftover rows from sibling tests
  // that share this process's SQLite db (db.ts is loaded once, so whatever
  // test imported it first determines the actual file).
  const taskId = `task-orphan-${randomUUID()}`;
  const runId = `run-orphan-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "stuck",
    prompt: "p",
    column: "running",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],    backlog: [], draft: null,
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null, codexSessionId: null,
  });

  const reconciled = reconcileOrphans();
  expect(reconciled).toBe(1);

  const row = db.query<{ status: string }, [string]>(`SELECT status FROM runs WHERE id = ?`).get(runId);
  expect(row?.status).toBe("orphaned");

  const task = tasks.get(taskId);
  expect(task?.column).toBe("ready");
  expect(task?.runId).toBeNull();

  // A second call is a no-op.
  expect(reconcileOrphans()).toBe(0);
});

test("reattach pre-seed SQL: detects a prior api-error status row scoped to the run", async () => {
  // Locks in the query shape used by `reconcileOrphans` to pre-seed
  // `handle.apiError` on reattach. A real reattach test would need a live
  // tmux session + JSONL — too heavy — so we exercise the SQL directly
  // against three rows: the target run with a sentinel status, a sibling
  // run on the same task with the same prefix (must NOT match — pre-seed is
  // scoped to the reattached run id), and a same-run row with the prefix
  // on the wrong stream (must NOT match — only `status` rows count).
  const { db, runs, tasks } = await import("./db.ts");
  const { CLAUDE_API_ERROR_STATUS_PREFIX } = await import("./claude-tmux.ts");

  const taskId = `task-preseed-${randomUUID()}`;
  const targetRunId = `run-preseed-target-${randomUUID()}`;
  const siblingRunId = `run-preseed-sibling-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "x",
    prompt: "p",
    column: "blocked",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [],    backlog: [], draft: null,
    runId: targetRunId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  // status='failed' (not 'running') so this test's rows can't be
  // re-orphaned by a sibling test that calls `reconcileOrphans` later
  // — multiple test files in one bun process share the auto-allocated
  // db.ts when the first-loaded file didn't set AGETOR_DATA_DIR. The
  // SQL we're locking in only reads run_events, not runs.status, so
  // the run-row status is irrelevant to what's being tested.
  for (const id of [targetRunId, siblingRunId]) {
    runs.insert({
      id, taskId, agent: "claude-code", status: "failed",
      startedAt: now, endedAt: now, exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    });
  }
  // The real api-error status on the target run — must match.
  runs.appendEvent(targetRunId, "status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted`);
  // Same-task sibling run with the prefix — must NOT match (different run id).
  runs.appendEvent(siblingRunId, "status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 500 — turn aborted`);
  // Same-run row with the prefix on the WRONG stream — must NOT match.
  runs.appendEvent(targetRunId, "assistant", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 400`);

  const ask = (runId: string) => db.query<{ found: 0 | 1 }, [string, string]>(
    `SELECT EXISTS(
       SELECT 1 FROM run_events
       WHERE run_id = ? AND stream = 'status' AND data LIKE ?
     ) AS found`,
  ).get(runId, `${CLAUDE_API_ERROR_STATUS_PREFIX}%`)?.found ?? 0;

  expect(ask(targetRunId)).toBe(1);
  // Sibling row carries the prefix but on a different run id — pre-seed
  // must NOT bleed across runs of the same task.
  expect(ask(siblingRunId)).toBe(1); // sibling itself does have one — sanity check
  // A completely unrelated run with no events should return 0.
  const cleanRunId = `run-preseed-clean-${randomUUID()}`;
  runs.insert({
    id: cleanRunId, taskId, agent: "claude-code", status: "failed",
    startedAt: now, endedAt: now, exitCode: 1,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });
  expect(ask(cleanRunId)).toBe(0);
});

test("startTask honors cancel — exit handler records status 'cancelled'", async () => {
  // Codex now hosts its turn in a real tmux session (codex-tmux.ts). Point the
  // codex bin at a `sleep 30` stub so the session stays alive until cancelled;
  // cancelRun → kill the session → the driver resolves `done` and the exit
  // handler records 'cancelled' (it defers to handle.cancelled over exit code).
  // Uses real tmux (don't stub AGETOR_TMUX_BIN) so there's an actual session to
  // kill.
  const binDir = mkdtempSync(path.join(tmpdir(), "agetor-cancel-bin-"));
  const fakeBin = path.join(binDir, "fake-codex");
  writeFileSync(fakeBin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(fakeBin, 0o755);
  process.env.AGETOR_CODEX_BIN = fakeBin;
  process.env.AGETOR_CODEX_ARGS = "";

  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { runs, harnesses } = await import("./db.ts");
  // Codex is shipped disabled-by-default (see migration 016); re-enable the
  // built-in for the test database so startTask doesn't reject it.
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "long-running",
    prompt: "30", // sleep 30 → session blocks until killed
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);

  const started = await startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);

  // Give the tmux session a moment to come up, then cancel.
  await new Promise((r) => setTimeout(r, 250));
  expect(cancelRun(started.runId)).toBe(true);

  // Wait past the driver's kill grace + the exit handler's status flip.
  await new Promise((r) => setTimeout(r, 700));

  const list = runs.listForTask(created.task.id);
  expect(list[0]?.status).toBe("cancelled");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Boot reconciliation of tasks with a dangling `running` subagents row
 * (orchestrator.ts's second `reconcileOrphans` pass, appended after the
 * runs-scan pass above). A held task's terminal run is already `succeeded`,
 * so the runs-scan pass never sees it — nothing would re-arm its subagent
 * watcher after a restart without this second pass. See
 * docs/plans/hold-task-running-while-background-agents-run.md §4/T4.
 *
 * This pass was later WIDENED (see
 * docs/plans/adopt-continuation-on-task-notification.md §3/T2) to source
 * from `subagents.taskIdsWithRunning()` — every task with a `running`
 * subagent row, regardless of the task's own `column` — instead of just
 * `tasks WHERE column = 'running'`. The old scan had a blind spot: a task
 * whose terminal run resolved and moved the card to `review`/`done` before
 * agetor crashed, but whose subagent row was still `running` at the moment
 * of the crash, was invisible to both passes and stayed stuck forever. The
 * tests below split into: (a) the classic `column = 'running'` path,
 * unchanged; (b) the new any-other-column "blind spot" path this widening
 * added.
 * ────────────────────────────────────────────────────────────────────────── */

test("held-task boot pass: dead tmux session → subagent orphaned, task released to review", async () => {
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(1, "can't find session"); // has-session always fails → "gone"
  try {
    const taskId = `task-held-dead-${randomUUID()}`;
    const runId = `run-held-dead-${randomUUID()}`;
    const subId = `sub-held-dead-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId }));
    runs.insert(succeededRun(runId, taskId));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("orphaned");
    expect(sub?.endedAt).not.toBeNull();

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");
  } finally {
    restoreTmux();
  }
});

test("held-task boot pass: a task whose terminal run is still 'running' has its run orphaned by the first pass, then its dangling subagent row orphaned by the widened second pass", async () => {
  // This task LOOKS held-shaped (column='running', a `running` subagent
  // row) but its run hasn't actually finished, so `isHeldByBackgroundAgents`
  // is false and the FIRST pass (runs WHERE status='running') must own the
  // run instead — orphaning it and dropping the column to `ready`, not
  // `review`. That part of this test is UNCHANGED from before the widening.
  //
  // What changed: by the time the second (held-task) pass runs, the first
  // pass has already flipped this task's column from 'running' to 'ready'
  // (both passes execute inside the same `reconcileOrphans()` call, first
  // pass first). Before the widening, the second pass only scanned
  // `tasks WHERE column = 'running'` — so this task, now sitting in
  // 'ready', was invisible to it, and its dangling `running` subagent row
  // was left stranded forever (the exact blind-spot bug
  // docs/plans/adopt-continuation-on-task-notification.md §3/T2 fixes).
  // The widened pass sources from `subagents.taskIdsWithRunning()` instead,
  // which doesn't filter by column, so it now reaches this task via its
  // "blind spot" (any column other than 'running') branch and orphans the
  // row. Session is forced dead here so that branch is deterministic.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(1, "can't find session");
  try {
    const taskId = `task-notheld-running-${randomUUID()}`;
    const runId = `run-notheld-running-${randomUUID()}`;
    const subId = `sub-notheld-running-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId }));
    // status:'running', no tmux_session/claude_session_id → the first pass's
    // `canTryReattach` is false, so it falls straight to orphaning — no tmux
    // dependency needed for the RUN outcome, keeping that half deterministic
    // regardless of the fake tmux session state above.
    runs.insert(succeededRun(runId, taskId, {
      status: "running", endedAt: null, exitCode: null,
      tmuxSession: null, claudeSessionId: null,
    }));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    // Unchanged: the first pass still owns the run and the column drop.
    const run = runs.get(runId);
    expect(run?.status).toBe("orphaned");
    const task = tasks.get(taskId);
    expect(task?.column).toBe("ready");

    // NEW: the widened second pass now reaches this task's dangling row
    // (column is 'ready' by the time it scans, which the old
    // `column = 'running'` source set would have missed entirely) and
    // orphans it via the blind-spot branch.
    const sub = subagents.get(subId);
    expect(sub?.status).toBe("orphaned");
    expect(sub?.endedAt).not.toBeNull();

    // maybeReleaseHeldTask's settle hook fires from orphanRunningSubagents
    // but bails immediately (task.column !== 'running'), so the column the
    // first pass already set is left alone — it does not bounce to 'review'.
    expect(tasks.get(taskId)?.column).toBe("ready");
  } finally {
    restoreTmux();
  }
});

test("held-task boot pass: succeeded run with no running subagents is left untouched in running", async () => {
  // Not held (no `running` subagent row) → `isHeldByBackgroundAgents` is
  // false → the pass's `if (!isHeldByBackgroundAgents(heldId)) continue;`
  // skips this task outright. Verified by reading orchestrator.ts, not
  // assumed: this leaves the card resting in `running` with nothing armed to
  // move it (no live SessionState from this boot, no subagent watcher) until
  // some other action touches it — a slightly odd resting state, but it is
  // what the code does, and matches the plan's success criterion #3 ("no
  // running subagents → unchanged behavior") applied at boot time rather
  // than at settle time.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const taskId = `task-notheld-clean-${randomUUID()}`;
  const runId = `run-notheld-clean-${randomUUID()}`;
  const subId = `sub-notheld-clean-${randomUUID()}`;
  cleanupTaskIds.push(taskId);

  tasks.insert(heldTaskRow({ id: taskId, runId }));
  runs.insert(succeededRun(runId, taskId));
  subagents.insertIfAbsent(subagentRow(subId, taskId, runId, { status: "completed", endedAt: Date.now() }));

  reconcileOrphans();

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");

  const sub = subagents.get(subId);
  expect(sub?.status).toBe("completed");
});

test("held-task boot pass: a codex task can never be held — the kind !== 'claude-code' guard skips it untouched", async () => {
  // Codex never actually writes `subagents` rows (the table is claude-only —
  // grep confirms zero call sites in codex-tmux.ts). This constructs the
  // closest synthetic analogue (a codex task with a `running` subagent row
  // it would never really have) purely to exercise the
  // `resolveHarness(task.agent)?.kind !== "claude-code"` guard in the new
  // pass. `isHeldByBackgroundAgents` itself doesn't check kind — it would
  // report this task as held — so this test pins the guard as the thing
  // actually protecting codex, not an accident of the predicate.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const taskId = `task-codex-held-shaped-${randomUUID()}`;
  const runId = `run-codex-held-shaped-${randomUUID()}`;
  const subId = `sub-codex-held-shaped-${randomUUID()}`;
  cleanupTaskIds.push(taskId);

  tasks.insert(heldTaskRow({ id: taskId, runId, agent: "codex" }));
  runs.insert(succeededRun(runId, taskId, {
    agent: "codex", claudeSessionId: null, codexSessionId: `thread-${randomUUID()}`,
  }));
  subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

  reconcileOrphans();

  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");

  const sub = subagents.get(subId);
  expect(sub?.status).toBe("running");
});

test("held-task boot pass: null claudeSessionId with a live tmux session is released, not stranded", async () => {
  // No JSONL session id means there's no watch directory to derive, so a
  // live tmux session can't help re-arm a watcher — orchestrator.ts's
  // `if (!run?.claudeSessionId)` branch treats this exactly like a dead
  // session and releases immediately rather than leaving the card held
  // forever. `fakeTmux(0, ...)` makes "session alive" deterministic for
  // every has-session probe regardless of the actual session name, so this
  // doesn't depend on a real tmux server or session.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(0, "");
  try {
    const taskId = `task-held-nosession-${randomUUID()}`;
    const runId = `run-held-nosession-${randomUUID()}`;
    const subId = `sub-held-nosession-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId }));
    runs.insert(succeededRun(runId, taskId, { claudeSessionId: null }));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("orphaned");
  } finally {
    restoreTmux();
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Blind-spot coverage: the widened source set reaches tasks OUTSIDE the
 * `running` column. Each test below mirrors one of the `column = 'running'`
 * cases above (dead session / live+recoverable session / live+no session /
 * codex guard), but parks the task in `review` first — the exact shape that
 * was invisible to the pre-widening boot pass. `maybeReleaseHeldTask`'s
 * settle hook fires from every orphan in this branch too, but its own guard
 * (`task.column !== 'running'`) must bail every time, so the column is
 * asserted unchanged in each case, not just the subagent row's status.
 * ────────────────────────────────────────────────────────────────────────── */

test("boot pass (blind spot): review-column task with a dead-session subagent row is orphaned; column is left alone", async () => {
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans, subscribeGlobal } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(1, "can't find session");
  try {
    const taskId = `task-review-dead-${randomUUID()}`;
    const runId = `run-review-dead-${randomUUID()}`;
    const subId = `sub-review-dead-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId, column: "review" }));
    runs.insert(succeededRun(runId, taskId));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    // No `column` GlobalEvent should fire for this task: updateColumn only
    // emits one when the column actually changes, and
    // `maybeReleaseHeldTask` bails outright for a non-'running' column.
    const columnEvents: unknown[] = [];
    const unsub = subscribeGlobal((e) => {
      if (e.kind === "column" && e.taskId === taskId) columnEvents.push(e);
    });

    reconcileOrphans();
    unsub();

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("orphaned");
    expect(sub?.endedAt).not.toBeNull();

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");

    expect(columnEvents).toEqual([]);
  } finally {
    restoreTmux();
  }
});

test("boot pass (blind spot): review-column task with a live session + recoverable claudeSessionId re-arms the watcher instead of orphaning", async () => {
  // Distinguishing observable from the dead-session and no-claudeSessionId
  // cases (both of which orphan the row synchronously, inside
  // `reconcileOrphans()` itself): a recoverable live session takes the
  // re-arm branch — `attachSubagentWatcher` — which never touches the row
  // at all, so it's still 'running' immediately after the call returns.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const { detachWatcherFor } = await import("./claude-subagents.ts");

  const restoreTmux = fakeTmux(0, ""); // has-session always succeeds → "alive"
  const taskId = `task-review-live-${randomUUID()}`;
  try {
    const runId = `run-review-live-${randomUUID()}`;
    const subId = `sub-review-live-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId, column: "review" }));
    runs.insert(succeededRun(runId, taskId)); // seeds a non-null claudeSessionId
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("running");

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");
  } finally {
    // Release the real watcher timer `attachSubagentWatcher` armed (it isn't
    // called with `manual: true` from the boot pass) so it can't fire after
    // this test moves on.
    detachWatcherFor(taskId);
    restoreTmux();
  }
});

test("boot pass (blind spot): review-column task with a live session but no claudeSessionId is released, not stranded (mirrors the running-column case)", async () => {
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(0, "");
  try {
    const taskId = `task-review-nosession-${randomUUID()}`;
    const runId = `run-review-nosession-${randomUUID()}`;
    const subId = `sub-review-nosession-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId, column: "review" }));
    runs.insert(succeededRun(runId, taskId, { claudeSessionId: null }));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("orphaned");

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");
  } finally {
    restoreTmux();
  }
});

test("boot pass (blind spot): a codex task's stray running subagent row is skipped even outside the running column", async () => {
  // Same guard as the running-column codex test above
  // (`resolveHarness(task.agent)?.kind !== "claude-code"`), but pinned
  // specifically against the NEW blind-spot branch: without this guard, a
  // codex task parked in 'review' with a (synthetic — codex never really
  // writes these) running subagent row would hit the dead-session path
  // below and get orphaned. The guard fires before either branch runs.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  const restoreTmux = fakeTmux(1, "can't find session"); // dead — would orphan if the guard were missing
  try {
    const taskId = `task-codex-review-${randomUUID()}`;
    const runId = `run-codex-review-${randomUUID()}`;
    const subId = `sub-codex-review-${randomUUID()}`;
    cleanupTaskIds.push(taskId);

    tasks.insert(heldTaskRow({ id: taskId, runId, column: "review", agent: "codex" }));
    runs.insert(succeededRun(runId, taskId, {
      agent: "codex", claudeSessionId: null, codexSessionId: `thread-${randomUUID()}`,
    }));
    subagents.insertIfAbsent(subagentRow(subId, taskId, runId));

    reconcileOrphans();

    const task = tasks.get(taskId);
    expect(task?.column).toBe("review");

    const sub = subagents.get(subId);
    expect(sub?.status).toBe("running");
  } finally {
    restoreTmux();
  }
});

test("boot pass: never issues a tmux kill — dead and live review-column cases both leave kill-session absent from the tmux call log", async () => {
  // HARD INVARIANT documented at the blind-spot branch in orchestrator.ts:
  // the widened pass only ever re-arms a watcher or flips DB rows, never
  // touches tmux beyond a has-session probe. `fakeTmux`'s optional logging
  // captures every invocation's argv; asserting `kill-session` never
  // appears is a direct, black-box check of that invariant across both the
  // "orphan" and "re-arm" branches, without mocking any module.
  const { tasks, runs, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const { detachWatcherFor } = await import("./claude-subagents.ts");

  const logDir = mkdtempSync(path.join(tmpdir(), "agetor-reconcile-tmuxlog-"));
  const logPath = path.join(logDir, "calls.log");

  const deadTaskId = `task-nokill-dead-${randomUUID()}`;
  const deadRunId = `run-nokill-dead-${randomUUID()}`;
  const deadSubId = `sub-nokill-dead-${randomUUID()}`;
  cleanupTaskIds.push(deadTaskId);
  tasks.insert(heldTaskRow({ id: deadTaskId, runId: deadRunId, column: "review" }));
  runs.insert(succeededRun(deadRunId, deadTaskId));
  subagents.insertIfAbsent(subagentRow(deadSubId, deadTaskId, deadRunId));

  let restoreTmux = fakeTmux(1, "can't find session", logPath);
  try {
    reconcileOrphans();
  } finally {
    restoreTmux();
  }
  expect(subagents.get(deadSubId)?.status).toBe("orphaned");

  const liveTaskId = `task-nokill-live-${randomUUID()}`;
  const liveRunId = `run-nokill-live-${randomUUID()}`;
  const liveSubId = `sub-nokill-live-${randomUUID()}`;
  cleanupTaskIds.push(liveTaskId);
  tasks.insert(heldTaskRow({ id: liveTaskId, runId: liveRunId, column: "review" }));
  runs.insert(succeededRun(liveRunId, liveTaskId));
  subagents.insertIfAbsent(subagentRow(liveSubId, liveTaskId, liveRunId));

  restoreTmux = fakeTmux(0, "", logPath);
  try {
    reconcileOrphans();
  } finally {
    detachWatcherFor(liveTaskId);
    restoreTmux();
  }
  expect(subagents.get(liveSubId)?.status).toBe("running");

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  expect(log).not.toContain("kill-session");
});
