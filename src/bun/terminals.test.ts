import { test, expect, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR before any import that pulls in db.ts (terminals.ts
// imports `tasks` from db.ts, which opens + migrates the database on load).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-terminals-"));

const { tasks, runs } = await import("./db.ts");
const {
  createTerminal,
  listTerminals,
  countTerminals,
  writeTerminal,
  closeTerminal,
  killTerminalsForTask,
  attachSocket,
  ARCHIVED_TERMINAL_ERROR,
  TEARDOWN_TERMINAL_ERROR,
} = await import("./terminals.ts");

import type { Task } from "../shared/types.ts";
import type { ServerWebSocket } from "bun";
import type { TerminalSocketData } from "./terminals.ts";

/** The manager spawns `$SHELL -l`. Under test, pin that to `/bin/sh`: the
 *  assertions below are about the MANAGER (a PTY round-trip, exit-driven
 *  removal), not about the developer's own shell — a `zsh -l` that sources
 *  a heavyweight profile (nvm, brew shellenv, a banner) can take seconds to
 *  even reach its first prompt on a loaded machine, which is exactly the
 *  flake this file used to have. Restored after the file so nothing else
 *  in the shared `bun test` process sees the override. */
const SAVED_SHELL = process.env.SHELL;
beforeAll(() => { process.env.SHELL = "/bin/sh"; });
afterAll(() => {
  if (SAVED_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = SAVED_SHELL;
});

/** Deadline-based readiness wait — polls `pred` every `intervalMs` until it
 *  holds or `timeoutMs` elapses. A generous ceiling costs nothing when the
 *  condition lands quickly (the common case) and absorbs a slow login shell
 *  on a loaded box instead of failing at a fixed 2s the way the old
 *  `40 × 50ms` loops did. */
async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

/** How long a spawned login shell gets to start, run a command, and (for the
 *  exit test) terminate — far above the expected sub-second path, so only a
 *  genuine manager bug trips it. */
const SHELL_READY_MS = 20_000;

let taskCounter = 0;
function makeTask(workdir: string, extra: Partial<Task> = {}): Task {
  const id = `term-task-${++taskCounter}`;
  return tasks.insert({
    id,
    title: "terminal host",
    prompt: "n/a",
    column: "backlog",
    agent: "codex",
    workdir,
    isolation: "none", // no git repo needed; cwd resolves to workdir
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off", maxMode: false,
    references: [],    backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
}

async function git(args: string[], cwd: string) {
  await Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-term-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

/** Minimal fake of a Bun ServerWebSocket that records what the manager sends. */
function fakeSocket() {
  const binary: Uint8Array[] = [];
  const text: string[] = [];
  const ws = {
    readyState: 1,
    data: { terminalId: "" },
    sendBinary(d: Uint8Array) { binary.push(d); },
    send(s: string) { text.push(s); },
    close() { this.readyState = 3; },
  };
  return { ws: ws as unknown as ServerWebSocket<TerminalSocketData>, binary, text };
}

function decodeAll(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join("");
}

afterEach(async () => {
  // Clean up any leftover shells so the test process can exit.
  for (let i = 1; i <= taskCounter; i++) await killTerminalsForTask(`term-task-${i}`);
});

test("createTerminal spawns a shell, streams output, and tracks count", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-cwd-"));
  const task = makeTask(dir);

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;

  expect(countTerminals(task.id)).toBe(1);
  expect(listTerminals(task.id)).toHaveLength(1);
  // The computed Task field reflects the open terminal.
  expect(tasks.get(task.id)!.openTerminalCount).toBe(1);

  // Attach a socket and drive a command through the PTY.
  const sock = fakeSocket();
  expect(attachSocket(created.id, sock.ws)).toBe(true);
  writeTerminal(created.id, "echo TERMINAL_MARKER_42\r");

  // Wait for the echoed marker (real PTY round-trip).
  const seen = await waitFor(() => decodeAll(sock.binary).includes("TERMINAL_MARKER_42"), SHELL_READY_MS);
  expect(seen).toBe(true);

  // Closing the tab drops the count.
  expect(closeTerminal(created.id)).toBe(true);
  expect(countTerminals(task.id)).toBe(0);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
}, SHELL_READY_MS + 10_000);

test("createTerminal enforces the per-task limit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-limit-"));
  const task = makeTask(dir);

  for (let i = 0; i < 8; i++) {
    const r = await createTerminal(task.id);
    expect("error" in r).toBe(false);
  }
  expect(countTerminals(task.id)).toBe(8);

  const overflow = await createTerminal(task.id);
  expect("error" in overflow).toBe(true);
  expect(countTerminals(task.id)).toBe(8);
});

test("archiving a task closes its terminals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-archive-"));
  // archiveTask only acts on `done` tasks with no live run.
  const task = makeTask(dir, { column: "done" });

  await createTerminal(task.id);
  await createTerminal(task.id);
  expect(countTerminals(task.id)).toBe(2);

  const { archiveTask } = await import("./orchestrator.ts");
  const res = await archiveTask(task.id);
  expect("task" in res).toBe(true);

  // archiveTask awaits killTerminalsForTask (a live shell would block the
  // worktree detach), so the tabs are gone once it resolves.
  expect(countTerminals(task.id)).toBe(0);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
});

test("killTerminalsForTask tears down every tab for a task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-kill-"));
  const task = makeTask(dir);

  await createTerminal(task.id);
  await createTerminal(task.id);
  expect(countTerminals(task.id)).toBe(2);

  await killTerminalsForTask(task.id);
  expect(countTerminals(task.id)).toBe(0);
});

test("createTerminal materializes the worktree for an isolation task and pins it on the task", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "claude-code" });
  // Pre-state: no worktree yet.
  expect(tasks.get(task.id)!.worktreePath).toBeNull();
  expect(tasks.get(task.id)!.branch).toBeNull();

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;

  // The worktree was created and pinned back onto the task, so a later agent
  // run reuses the same isolated dir.
  const after = tasks.get(task.id)!;
  expect(after.worktreePath).not.toBeNull();
  expect(after.branch).not.toBeNull();
  expect(existsSync(after.worktreePath!)).toBe(true);
  // The terminal's cwd is the worktree, not the source repo.
  expect(created.cwd).toBe(after.worktreePath!);
});

test("createTerminal on a drifted worktree opens in place, never checks out, and records the live branch", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  const pinned = tasks.get(task.id)!;
  const wt = pinned.worktreePath!;
  // The first open recorded the branch it materialized on.
  expect(pinned.checkoutBranch).toBe(pinned.branch);
  await killTerminalsForTask(task.id);

  // Drift: an agent cut its own branch, committed, then left a conflicting
  // uncommitted edit — exactly the state that made the old reuse-path
  // `git checkout <task.branch>` fail with "could not be switched".
  await git(["checkout", "-b", "implement/x"], wt);
  writeFileSync(path.join(wt, "README"), "drifted\n");
  await git(["commit", "-am", "drift"], wt);
  writeFileSync(path.join(wt, "README"), "uncommitted conflicting edit\n");

  const second = await createTerminal(task.id);
  if ("error" in second) throw new Error(`terminal open failed: ${second.error}`);
  expect(second.cwd).toBe(wt);
  const head = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], { cwd: wt }).stdout.toString().trim();
  expect(head).toBe("implement/x");
  const after = tasks.get(task.id)!;
  expect(after.branch).toBe(pinned.branch); // task.branch is never adopted
  expect(after.checkoutBranch).toBe("implement/x");
});

test("createTerminal keeps the recorded checkout when the live branch read fails", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  await killTerminalsForTask(task.id);
  const wt = tasks.get(task.id)!.worktreePath!;
  await git(["checkout", "-b", "implement/x"], wt);
  const second = await createTerminal(task.id);
  if ("error" in second) throw new Error(second.error);
  await killTerminalsForTask(task.id);
  expect(tasks.get(task.id)!.checkoutBranch).toBe("implement/x");

  // A transient git failure (here a broken `.git` pointer) is "unknown", not
  // "detached": the open still succeeds and the recorded drift survives.
  const pointer = path.join(wt, ".git");
  const saved = await Bun.file(pointer).text();
  writeFileSync(pointer, "gitdir: /nonexistent/agetor-broken\n");
  try {
    const third = await createTerminal(task.id);
    if ("error" in third) throw new Error(`terminal open failed: ${third.error}`);
    expect(third.cwd).toBe(wt);
    expect(tasks.get(task.id)!.checkoutBranch).toBe("implement/x");
  } finally {
    await killTerminalsForTask(task.id);
    writeFileSync(pointer, saved);
  }
});

test("createTerminal that re-attaches a missing worktree surfaces prepareWorkdir's warning on the latest run", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  await killTerminalsForTask(task.id);
  const pinned = tasks.get(task.id)!;
  const runId = `term-run-${task.id}`;
  runs.insert({
    id: runId, taskId: task.id, agent: "codex", status: "succeeded",
    startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, tmuxSession: null,
    claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });

  // The worktree dir AND the task branch are gone (e.g. cleaned up by hand):
  // the terminal open is the first thing to re-attach, recreating the branch
  // from base — the run log must say so, since later opens take the reuse path.
  const { detachWorktree } = await import("./worktree.ts");
  await detachWorktree(pinned, { force: true });
  await git(["branch", "-D", pinned.branch!], repo);
  expect(existsSync(pinned.worktreePath!)).toBe(false);

  const second = await createTerminal(task.id);
  if ("error" in second) throw new Error(`terminal open failed: ${second.error}`);
  expect(second.cwd).toBe(pinned.worktreePath!);
  const statuses = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statuses.some((d) => d.startsWith(`task branch ${pinned.branch} no longer exists — recreated it from `))).toBe(true);
  expect(tasks.get(task.id)!.checkoutBranch).toBe(pinned.branch);
});

test("createTerminal refuses a pipeline step whose shared worktree is missing", async () => {
  const repo = await makeRepo();
  const missing = path.join(repo, "no-such-worktree");
  const step = makeTask(repo, {
    isolation: "worktree",
    branch: "agetor/shared",
    worktreePath: missing,
    pipelineParentId: "term-parent",
    pipelineStepId: "s1",
  });
  const r = await createTerminal(step.id);
  expect(r).toEqual({ error: "step task's worktree is missing — run the pipeline task instead" });
  // Nothing was materialized at the step's own path.
  expect(existsSync(missing)).toBe(false);
  expect(countTerminals(step.id)).toBe(0);
});

test("createTerminal refuses an archived task without re-creating its torn-down worktree", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex", column: "done" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  const wt = tasks.get(task.id)!.worktreePath!;

  const { archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const res = await archiveTask(task.id);
  expect("task" in res).toBe(true);
  // Open right after archive, while its deferred teardown is still queued.
  const r = await createTerminal(task.id);
  expect(r).toEqual({ error: ARCHIVED_TERMINAL_ERROR });
  await pendingTeardown(task.id);
  // The teardown removed the worktree and nothing brought it back.
  expect(existsSync(wt)).toBe(false);
  expect(countTerminals(task.id)).toBe(0);
});

test("createTerminal waits out a queued teardown before reusing the worktree", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex", column: "done" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  await killTerminalsForTask(task.id);
  const wt = tasks.get(task.id)!.worktreePath!;

  const { archiveTask, pendingTeardown, __enqueueTeardownForTest } = await import("./orchestrator.ts");
  // Hold the repo's teardown queue open with a gate, so the archive teardown
  // below stays queued for exactly as long as the test wants.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  void __enqueueTeardownForTest(`${task.id}-gate`, repo, () => gate);
  try {
    const res = await archiveTask(task.id);
    expect("task" in res).toBe(true);
    // Clear the archive stamp directly (unarchiveTask would itself wait), so
    // the teardown is still queued when the terminal opens.
    tasks.update(task.id, { archivedAt: null });
    let settled = false;
    const opening = createTerminal(task.id).finally(() => { settled = true; });
    // While the teardown is queued the open must wait, not spawn a shell.
    await Bun.sleep(300);
    expect(settled).toBe(false);
    expect(countTerminals(task.id)).toBe(0);
    release();
    const r = await opening;
    if ("error" in r) throw new Error(`terminal open failed: ${r.error}`);
    await pendingTeardown(task.id);
    expect(r.cwd).toBe(wt);
    expect(existsSync(wt)).toBe(true);
    expect(countTerminals(task.id)).toBe(1);
  } finally {
    release();
  }
});

/** Open a terminal on `taskId`, running `during` right after the real
 *  `prepareWorkdir` returns — the window between terminal open's teardown
 *  wait and its spawn, where a delete or archive can land. */
async function openWithPrepareHook<T>(taskId: string, during: () => T | Promise<T>) {
  const worktree = await import("./worktree.ts");
  const real = worktree.prepareWorkdir;
  let produced: T | undefined;
  const spy = spyOn(worktree, "prepareWorkdir").mockImplementation(async (t, opts) => {
    const res = await real(t, opts);
    produced = await during();
    return res;
  });
  try {
    const result = await createTerminal(taskId);
    return { result, produced: produced as T };
  } finally {
    spy.mockRestore();
  }
}

function branchExists(repo: string, branch: string): boolean {
  return Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).exitCode === 0;
}

test("createTerminal refuses when a delete starts during prepareWorkdir, leaving no shell and no worktree", async () => {
  const { deleteTask, pendingTeardown } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  // No worktree yet: the open materializes it, then the delete lands.
  const task = makeTask(repo, { isolation: "worktree", agent: "codex", branch: "agetor/del-during-open" });

  const { result, produced } = await openWithPrepareHook(task.id, () => ({ deleting: deleteTask(task.id) }));
  expect("error" in result).toBe(true);
  if (!("error" in result)) return;
  expect([TEARDOWN_TERMINAL_ERROR, "task not found"]).toContain(result.error);
  await produced.deleting;
  await pendingTeardown(task.id);

  expect(tasks.get(task.id)).toBeNull();
  expect(countTerminals(task.id)).toBe(0);
  // Neither the materialized worktree nor its branch outlived the delete.
  const wt = path.join(process.env.AGETOR_DATA_DIR!, "worktrees", task.id);
  expect(existsSync(wt)).toBe(false);
  expect(branchExists(repo, "agetor/del-during-open")).toBe(false);
});

test("createTerminal refuses when a delete starts while it reuses an existing worktree", async () => {
  const { deleteTask, pendingTeardown } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex" });
  const first = await createTerminal(task.id);
  if ("error" in first) throw new Error(first.error);
  await killTerminalsForTask(task.id);
  const wt = tasks.get(task.id)!.worktreePath!;

  const { result, produced } = await openWithPrepareHook(task.id, () => ({ deleting: deleteTask(task.id) }));
  expect("error" in result).toBe(true);
  await produced.deleting;
  await pendingTeardown(task.id);
  expect(tasks.get(task.id)).toBeNull();
  expect(countTerminals(task.id)).toBe(0);
  expect(existsSync(wt)).toBe(false);
});

test("createTerminal refused by an archive during prepareWorkdir detaches the worktree it materialized", async () => {
  const { archiveTask, pendingTeardown } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "codex", column: "done", branch: "agetor/archive-during-open" });

  const { result } = await openWithPrepareHook(task.id, () => archiveTask(task.id));
  expect(result).toEqual({ error: ARCHIVED_TERMINAL_ERROR });
  await pendingTeardown(task.id);

  expect(countTerminals(task.id)).toBe(0);
  const row = tasks.get(task.id)!;
  expect(row.archivedAt).not.toBeNull();
  // Archive semantics: the checkout is gone, the branch survives for unarchive.
  expect(existsSync(path.join(process.env.AGETOR_DATA_DIR!, "worktrees", task.id))).toBe(false);
  expect(branchExists(repo, "agetor/archive-during-open")).toBe(true);
});

test("createTerminal refuses a pipeline task while its delete awaits the step cascade", async () => {
  const { deleteTask, isTaskTearingDown } = await import("./orchestrator.ts");
  const { withPipelineLock } = await import("./pipeline-runner.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-pipeline-del-"));
  // A pipeline PARENT: its delete awaits the step cascade (under the
  // per-parent pipeline lock) before it ever queues a teardown, so during
  // that window `pendingTeardown` has nothing to wait on — only the
  // delete-in-progress mark can tell the open the task is on its way out.
  const parent = makeTask(dir, { pipelineId: "term-pipeline" });

  // Hold the parent's pipeline lock so the delete's cascade stays parked.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withPipelineLock(parent.id, () => gate);
  let deleting: Promise<void> | undefined;
  try {
    deleting = deleteTask(parent.id);
    expect(isTaskTearingDown(parent.id)).toBe(true);
    // The row is still there — the open must be refused, not served.
    expect(tasks.get(parent.id)).not.toBeNull();

    const r = await createTerminal(parent.id);
    expect(r).toEqual({ error: TEARDOWN_TERMINAL_ERROR });
    expect(countTerminals(parent.id)).toBe(0);
  } finally {
    release();
    await held;
    await deleting;
  }
  expect(tasks.get(parent.id)).toBeNull();
  expect(isTaskTearingDown(parent.id)).toBe(false);
  expect(countTerminals(parent.id)).toBe(0);
});

test("a shell that exits is auto-removed from the manager", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-exit-"));
  const task = makeTask(dir);

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;
  expect(countTerminals(task.id)).toBe(1);

  // Tell the shell to exit; the manager should drop the entry on process exit.
  writeTerminal(created.id, "exit\r");
  const gone = await waitFor(() => countTerminals(task.id) === 0, SHELL_READY_MS);
  expect(gone).toBe(true);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
}, SHELL_READY_MS + 10_000);
