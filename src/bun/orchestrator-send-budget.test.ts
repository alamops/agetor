import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { SPAWN_RESPONSE_BUDGET_MS, type GlobalEvent } from "../shared/types.ts";

// Tests for docs/plans/non-blocking-session-restore.md row TT4 / decision D:
// the bounded wait on `sendInput`. Everything after the cheap `run not found`
// / `task not found` refusals runs as `sendInputInner`, raced against
// `SPAWN_RESPONSE_BUDGET_MS`; past it the caller gets
// `{ delivered: true, runId, pending: true }` and a late refusal is turned
// into a backlog re-stash of the RAW message plus one live-only `send-failed`
// global event (`settleLateSend`).
//
// Slow pre-dispatch is made deterministic two ways, neither needing real
// load: (a) the `__enqueueTeardownForTest` seam holds the teardown FIFO open
// so `sendInputInner`'s `await pendingTeardown(...)` blocks until the test
// releases a gate; (b) a stub `codex` binary that sleeps before printing an
// out-of-date version, which stalls the codex CLI-floor probe
// (`minCliVersionError`) and then makes it refuse.
//
// Top-level env setup (same convention as orchestrator-spawn-budget.test.ts):
// db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-send-budget-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_CODEX_DRIVER = "fake";
delete process.env.AGETOR_SKIP_CLI_VERSION_FLOOR;

const scratch = mkdtempSync(path.join(tmpdir(), "agetor-send-budget-scratch-"));

afterAll(() => {
  rmTestDataDir(process.env.AGETOR_DATA_DIR!);
  rmSync(scratch, { recursive: true, force: true });
});

/** Comfortably above SPAWN_RESPONSE_BUDGET_MS so the budget wins the race. */
const SLOW_SPAWN_DELAY_MS = 2200;
/** Slack over the budget for the "answered within the budget" assertions. */
const BUDGET_SLACK_MS = 300;

async function waitFor(check: () => boolean, timeoutMs = 6000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect `send-failed` global events for one task. */
async function collectSendFailed(taskId: string) {
  const { subscribeGlobal } = await import("./orchestrator.ts");
  const events: Extract<GlobalEvent, { kind: "send-failed" }>[] = [];
  const unsubscribe = subscribeGlobal((e) => {
    if (e.kind === "send-failed" && e.taskId === taskId) events.push(e);
  });
  return { events, unsubscribe };
}

/** A held teardown FIFO slot: `pendingTeardown(taskId)` waits until `release`. */
async function holdTeardown(taskId: string, key: string) {
  const { __enqueueTeardownForTest } = await import("./orchestrator.ts");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void __enqueueTeardownForTest(taskId, key, () => gate);
  return release;
}

async function makeClaudeTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-send-budget-wd-"));
  const created = await createTask({
    title,
    prompt: `prompt for ${title}`,
    agent: "claude-code",
    workdir,
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return { taskId: created.task.id, workdir };
}

/** Insert an already-settled run so `sendInput` has a run to be addressed to
 *  without starting the task. */
async function insertSettledRun(taskId: string, agent: string, runId: string) {
  const { runs } = await import("./db.ts");
  runs.insert({
    id: runId,
    taskId,
    agent,
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: agent === "codex" ? "thread-x" : null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
}

/** A stub codex binary that stalls the version probe, then reports an old
 *  version (below gpt-6.1-sol's floor) so the floor check refuses. The stall
 *  must outlast SPAWN_RESPONSE_BUDGET_MS (1.5 s) but stay under the 2 s
 *  version-probe timeout (agent-status.ts), which would fail the floor open.
 *  A unique
 *  path per call keeps any per-path probe memoization from making a later
 *  test's probe fast. */
function makeSlowOldCodex(label: string, sleepSec = "1.65"): string {
  const bin = path.join(scratch, `slow-codex-${label}.sh`);
  writeFileSync(bin, `#!/bin/sh\nsleep ${sleepSec}\necho "codex-cli 0.100.0"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function makeCodexTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-send-budget-codex-wd-"));
  const created = await createTask({
    title,
    prompt: `prompt for ${title}`,
    agent: "codex",
    model: "gpt-6.1-sol",
    workdir,
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Synchronous refusal and fast path
 * ────────────────────────────────────────────────────────────────────────── */

test("sync refusal: an unknown run answers immediately with no pending key", async () => {
  const { sendInput } = await import("./orchestrator.ts");
  const before = Date.now();
  const res = await sendInput("run-does-not-exist-send-budget", "hi");
  expect(Date.now() - before).toBeLessThan(50);
  expect(res).toEqual({ delivered: false, reason: "run not found" });
  expect("pending" in res).toBe(false);
});

test("fast path: a quick delivered send has no pending key at all", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  const { taskId } = await makeClaudeTask("fast-send");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) return;
  await waitFor(() => tasks.get(taskId)?.column === "review");

  const { events, unsubscribe } = await collectSendFailed(taskId);
  try {
    const res = await sendInput(started.runId, "quick follow-up");
    expect(res.delivered).toBe(true);
    expect("pending" in res).toBe(false);
    await waitFor(() => tasks.get(taskId)?.column === "review");
    await sleep(100);
    expect(events).toEqual([]);
  } finally {
    unsubscribe();
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Slow pre-dispatch → pending, then late success / failure
 * ────────────────────────────────────────────────────────────────────────── */

test("slow pre-dispatch (held teardown): answers pending with the addressed run; a late delivered:true emits no send-failed", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const { taskId, workdir } = await makeClaudeTask("late-ok");
  const addressedRunId = `run-late-ok-${taskId.slice(0, 8)}`;
  await insertSettledRun(taskId, "claude-code", addressedRunId);

  const release = await holdTeardown(taskId, workdir);
  const { events, unsubscribe } = await collectSendFailed(taskId);
  try {
    const before = Date.now();
    const res = await sendInput(addressedRunId, "message that waits on a teardown");
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + BUDGET_SLACK_MS);
    // Nothing minted yet (still waiting on the teardown): the addressed run.
    expect(res).toEqual({ delivered: true, runId: addressedRunId, pending: true });
    expect(runs.get(addressedRunId)?.status).toBe("succeeded");

    release();
    // The detached work now proceeds: the fake driver mints a new run and
    // the task settles in review.
    await waitFor(() => {
      const t = tasks.get(taskId);
      return t?.column === "review" && t.runId !== addressedRunId && t.runId != null;
    }, 8000);
    await sleep(150);
    expect(events).toEqual([]);
    expect(tasks.get(taskId)?.backlog ?? []).toEqual([]);
  } finally {
    release();
    unsubscribe();
  }
});

test("slow pre-dispatch then restore failure: raw text re-stashed into the backlog and exactly one send-failed fires", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { createTask, sendInput } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  // A worktree-isolated task whose worktree dir is gone AND whose source repo
  // is gone too: `prepareWorkdir` cannot re-materialize it and answers
  // "not inside a git repo", which `sendInputInner` reports as
  // `worktree restore failed: …`.
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-send-budget-repo-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(
      ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  };
  git("init", "-q");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");

  const created = await createTask({
    title: "late-restore-fail",
    prompt: "p",
    agent: "claude-code",
    workdir: repo,
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  expect(created.task.isolation).toBe("worktree");
  tasks.update(taskId, { worktreePath: path.join(scratch, "vanished-worktree") });
  rmSync(repo, { recursive: true, force: true });

  const addressedRunId = `run-late-fail-${taskId.slice(0, 8)}`;
  await insertSettledRun(taskId, "claude-code", addressedRunId);

  const release = await holdTeardown(taskId, repo);
  const { events, unsubscribe } = await collectSendFailed(taskId);
  const body = "please look at @docs/some-file.md again";
  try {
    const before = Date.now();
    const res = await sendInput(addressedRunId, body);
    expect(Date.now() - before).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + BUDGET_SLACK_MS);
    expect(res).toEqual({ delivered: true, runId: addressedRunId, pending: true });
    // Still blocked on the teardown: nothing stashed or emitted yet.
    expect(events).toEqual([]);
    expect(tasks.get(taskId)?.backlog ?? []).toEqual([]);

    release();
    await waitFor(() => events.length > 0, 8000);
    await sleep(150);

    expect(events).toHaveLength(1);
    expect(events[0]!.savedToBacklog).toBe(true);
    expect(events[0]!.reason).toMatch(/worktree restore failed/);
    const backlog = tasks.get(taskId)!.backlog ?? [];
    // The RAW pre-expansion text — the `@token` is intact.
    expect(backlog.map((b) => b.text)).toEqual([body]);
  } finally {
    release();
    unsubscribe();
  }
});

test("slow codex floor refusal: raw text re-stashed and exactly one send-failed fires", async () => {
  const { sendInput } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  process.env.AGETOR_CODEX_BIN = makeSlowOldCodex("floor");
  try {
    const taskId = await makeCodexTask("late-floor");
    const addressedRunId = `run-late-floor-${taskId.slice(0, 8)}`;
    await insertSettledRun(taskId, "codex", addressedRunId);

    const { events, unsubscribe } = await collectSendFailed(taskId);
    const body = "hello @nothing.md";
    try {
      const before = Date.now();
      const res = await sendInput(addressedRunId, body);
      expect(Date.now() - before).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + BUDGET_SLACK_MS);
      expect(res).toEqual({ delivered: true, runId: addressedRunId, pending: true });

      await waitFor(() => events.length > 0, 8000);
      await sleep(150);

      expect(events).toHaveLength(1);
      expect(events[0]!.savedToBacklog).toBe(true);
      expect(events[0]!.reason.length).toBeGreaterThan(0);
      expect((tasks.get(taskId)!.backlog ?? []).map((b) => b.text)).toEqual([body]);
    } finally {
      unsubscribe();
    }
  } finally {
    delete process.env.AGETOR_CODEX_BIN;
  }
});

test("late floor refusal on an archived task does not un-archive it (floor check precedes the archivedAt clear)", async () => {
  const { sendInput } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  process.env.AGETOR_CODEX_BIN = makeSlowOldCodex("archived");
  try {
    const taskId = await makeCodexTask("late-floor-archived");
    const addressedRunId = `run-late-arch-${taskId.slice(0, 8)}`;
    await insertSettledRun(taskId, "codex", addressedRunId);
    const archivedAt = Date.now();
    tasks.update(taskId, { archivedAt });

    const { events, unsubscribe } = await collectSendFailed(taskId);
    try {
      const res = await sendInput(addressedRunId, "message to an archived task");
      expect(res).toEqual({ delivered: true, runId: addressedRunId, pending: true });

      await waitFor(() => events.length > 0, 8000);
      await sleep(150);

      expect(events).toHaveLength(1);
      // Still archived: the refusal happened before the auto-unarchive.
      expect(tasks.get(taskId)?.archivedAt).toBe(archivedAt);
      // And an archived task never takes a re-stash, so the toast says so.
      expect(events[0]!.savedToBacklog).toBe(false);
      expect(tasks.get(taskId)?.backlog ?? []).toEqual([]);
    } finally {
      unsubscribe();
    }
  } finally {
    delete process.env.AGETOR_CODEX_BIN;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Slow claude mint: the pending runId is the NEW run
 * ────────────────────────────────────────────────────────────────────────── */

test("slow claude mint: pending answer carries the newly minted run's id, not the addressed one", async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const { taskId } = await makeClaudeTask("slow-mint");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) return;
  const firstRunId = started.runId;
  await waitFor(() => tasks.get(taskId)?.column === "review");

  const { events, unsubscribe } = await collectSendFailed(taskId);
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = String(SLOW_SPAWN_DELAY_MS);
  try {
    const before = Date.now();
    const res = await sendInput(firstRunId, "resume with a slow mint");
    expect(Date.now() - before).toBeLessThan(SPAWN_RESPONSE_BUDGET_MS + BUDGET_SLACK_MS);
    expect(res.delivered).toBe(true);
    if (!res.delivered) return;
    expect(res.pending).toBe(true);
    expect(res.runId).not.toBe(firstRunId);
    // It names the run the mint persisted and pointed `task.runId` at.
    expect(res.runId).toBe(tasks.get(taskId)?.runId ?? "");
    expect(runs.get(res.runId)?.status).toBe("running");

    await waitFor(() => tasks.get(taskId)?.column === "review", SLOW_SPAWN_DELAY_MS + 3000);
    expect(runs.get(res.runId)?.status).toBe("succeeded");
    await sleep(100);
    // A late delivered:true is not a failure.
    expect(events).toEqual([]);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
    unsubscribe();
  }
});
