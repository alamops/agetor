import { test, expect, afterAll, beforeAll, spyOn } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// One-repository multi tasks and repository removal (issue #291, round 15):
// a task created with 2+ repositories stays multi after removals down to one,
// and `removeTaskRepository` is the way out of a deleted source repository.
// Setup mirrors orchestrator-multi-repo-fixes.test.ts.

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-multi-repo-remove-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

let restoreHarnesses: (() => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restoreHarnesses = snapshotHarnessState();
});

afterAll(() => {
  restoreHarnesses?.();
  rmTestDataDir(DATA_DIR);
});

async function git(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return await proc.exited;
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)) === 0;
}

async function makeRepo(name: string, remote?: string): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), `agetor-${name}-`));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), `${name}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  if (remote) await git(["remote", "add", "origin", remote], repo);
  return repo;
}

function cleanup(...paths: (string | undefined)[]) {
  for (const p of paths) if (p) rmSync(p, { recursive: true, force: true });
}

async function waitFor(cond: () => boolean, timeoutMs = 8_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function settleRun(taskId: string): Promise<void> {
  const { tasks, runs } = await import("./db.ts");
  await waitFor(() => {
    const runId = tasks.get(taskId)?.runId;
    if (!runId) return true;
    const run = runs.get(runId);
    return !!run && run.status !== "running";
  });
}

async function workspaceOf(id: string): Promise<string> {
  const { WORKTREES_DIR } = await import("./worktree.ts");
  return path.join(WORKTREES_DIR, id);
}

async function createMulti(title: string, paths: string[], extra: Record<string, unknown> = {}): Promise<Task> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "p",
    agent: "claude-code",
    workdir: paths[0]!,
    isolation: "worktree",
    repositories: paths.map((p) => ({ path: p })),
    ...extra,
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

/** Materialize every checkout of a multi task without a run. */
async function materialize(task: Task): Promise<Task> {
  const { tasks } = await import("./db.ts");
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const prepared = await prepareTaskWorkdir(task);
  if ("error" in prepared) throw new Error(prepared.error);
  tasks.setRepositories(task.id, prepared.repositories!);
  tasks.update(task.id, { worktreePath: prepared.worktreePath, column: "done" });
  return tasks.get(task.id)!;
}

function expectRefused(result: unknown, status: number, code?: string): string {
  const r = result as { error?: string; status?: number; code?: string };
  expect(r.error, JSON.stringify(result)).toBeTruthy();
  expect(r.status).toBe(status);
  if (code) expect(r.code).toBe(code);
  return r.error!;
}

// ── multiRepo is the stored set ──────────────────────────────────────────

test("multiRepo: true for a multi row (and stays true down to one), false for a single row", async () => {
  const { createTask, removeTaskRepository } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const solo = await makeRepo("solo");
  let multiId = "";
  let singleId = "";
  try {
    const multi = await createMulti("flag multi", [a, b]);
    multiId = multi.id;
    expect(multi.multiRepo).toBe(true);
    const single = await createTask({ title: "flag single", prompt: "p", agent: "claude-code", workdir: solo, isolation: "worktree" });
    if ("error" in single) throw new Error(single.error);
    singleId = single.task.id;
    expect(single.task.multiRepo).toBe(false);
    // The single row still derives its one entry from the scalars.
    expect(single.task.repositories).toHaveLength(1);
    expect(single.task.repositories![0]!.path).toBe(solo);

    const removed = await removeTaskRepository(multiId, multi.repositories![1]!.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(removed.task.multiRepo).toBe(true);
    expect(removed.task.repositories!.map((r) => r.path)).toEqual([a]);
    // Still the workspace root, not the remaining repository.
    expect(removed.task.workdir).toBe(await workspaceOf(multiId));
  } finally {
    cleanup(multiId ? await workspaceOf(multiId) : undefined, singleId ? await workspaceOf(singleId) : undefined, a, b, solo);
  }
});

// ── a one-repository multi task behaves as multi end to end ─────────────

test("a one-repository multi task prepares under the workspace root, launches with the block and roots, restores and tears down per repository", async () => {
  const { startTask, archiveTask, unarchiveTask, deleteTask, removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const agents = await import("./agents.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const spy = spyOn(agents, "spawnAgent");
  let id = "";
  try {
    const created = await createMulti("one-repo multi", [a, b]);
    id = created.id;
    const keep = created.repositories![0]!;
    const removed = await removeTaskRepository(id, created.repositories![1]!.name);
    if (!("task" in removed)) throw new Error(removed.error);

    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);

    const workspace = await workspaceOf(id);
    const checkout = path.join(workspace, keep.name);
    const t = tasks.get(id)!;
    expect(t.multiRepo).toBe(true);
    // The single checkout sits under the workspace root, never at the root.
    expect(t.worktreePath).toBe(workspace);
    expect(t.repositories!.map((r) => r.worktreePath)).toEqual([checkout]);
    expect(existsSync(path.join(checkout, ".git"))).toBe(true);
    expect(t.branch).toBeNull();
    // Launched at the workspace root with the Repositories: block.
    const record = agents.__getFakeDriver(id)?._record ?? [];
    expect(record).toContain(`cwd:${workspace}`);
    const spawnLine = record.find((r) => r.startsWith("spawn:")) ?? "";
    expect(spawnLine).toContain(`Repositories:\n- ${keep.name}: ${checkout} (branch ${keep.branch})`);
    // …and the checkout named as an extra root.
    const call = spy.mock.calls.find(([args]) => args.taskId === id);
    expect(call![0].opts?.extraDirectories).toEqual([checkout]);
    expect(call![0].opts?.codexWorkspaceRepos).toEqual([{ worktreePath: checkout, repoPath: a }]);

    // Archive detaches per repository (branch kept), unarchive restores.
    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(existsSync(checkout)).toBe(false);
    expect(await branchExists(a, keep.branch!)).toBe(true);
    const unarchived = await unarchiveTask(id);
    if ("error" in unarchived) throw new Error(unarchived.error);
    expect(existsSync(path.join(checkout, ".git"))).toBe(true);
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], checkout)).toBe(keep.branch!);

    // Delete tears the repository down per entry: checkout and branch gone.
    await deleteTask(id);
    expect(tasks.get(id)).toBeNull();
    expect(existsSync(checkout)).toBe(false);
    expect(await branchExists(a, keep.branch!)).toBe(false);
  } finally {
    spy.mockRestore();
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("a single-repository task is unchanged: multiRepo false, no Repositories block, no extra roots", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const agents = await import("./agents.ts");
  const solo = await makeRepo("solo");
  const spy = spyOn(agents, "spawnAgent");
  let id = "";
  try {
    const created = await createTask({ title: "single unchanged", prompt: "just this", agent: "claude-code", workdir: solo, isolation: "worktree" });
    if ("error" in created) throw new Error(created.error);
    id = created.task.id;
    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);
    const t = tasks.get(id)!;
    expect(t.multiRepo).toBe(false);
    expect(t.worktreePath).toBe(await workspaceOf(id));
    const record = agents.__getFakeDriver(id)?._record ?? [];
    const spawnLine = record.find((r) => r.startsWith("spawn:")) ?? "";
    expect(spawnLine).toContain("just this");
    expect(spawnLine).not.toContain("Repositories:");
    const call = spy.mock.calls.find(([args]) => args.taskId === id);
    expect(call![0].opts && "extraDirectories" in call![0].opts).toBe(false);
  } finally {
    spy.mockRestore();
    cleanup(id ? await workspaceOf(id) : undefined, solo);
  }
});

// ── removal: the clean path ─────────────────────────────────────────────

test("removing a clean repository detaches its checkout, keeps its branch, drops the entry and writes one status line", async () => {
  const { startTask, removeTaskRepository, subscribe } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const events: RunEvent[] = [];
  const unsubscribe = subscribe((e) => { events.push(e); });
  let id = "";
  try {
    const created = await createMulti("remove clean", [a, b]);
    id = created.id;
    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);
    const before = tasks.get(id)!;
    const gone = before.repositories![1]!;
    expect(existsSync(gone.worktreePath!)).toBe(true);

    const removed = await removeTaskRepository(id, gone.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(removed.task.repositories!.map((r) => r.name)).toEqual([before.repositories![0]!.name]);
    expect(tasks.get(id)!.repositories!.map((r) => r.name)).toEqual([before.repositories![0]!.name]);
    // Checkout gone, registration pruned, branch kept.
    expect(existsSync(gone.worktreePath!)).toBe(false);
    expect(await gitOut(["worktree", "list", "--porcelain"], b)).not.toContain(gone.worktreePath!);
    expect(await branchExists(b, gone.branch!)).toBe(true);
    // The other repository is untouched.
    expect(existsSync(path.join(before.repositories![0]!.worktreePath!, ".git"))).toBe(true);
    // Exactly one status line, on the task's latest run, naming no product.
    const lines = events.filter((e) => e.taskId === id && e.stream === "status" && e.data.startsWith("removed repository"));
    expect(lines.map((e) => e.data)).toEqual([`removed repository ${gone.name} from this task (branch ${gone.branch} kept)`]);
    expect(lines[0]!.runId).toBe(started.runId);
    // updated_at untouched by the server-managed write.
    expect(tasks.get(id)!.updatedAt).toBe(before.updatedAt);
  } finally {
    unsubscribe();
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("a removed repository stays removed: a stale prepare snapshot can't write it back", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("stale snapshot", [a, b]));
    id = task.id;
    const stale = task.repositories!;
    const removed = await removeTaskRepository(id, stale[1]!.name);
    if (!("task" in removed)) throw new Error(removed.error);
    // A writer holding the pre-removal set (a prepare that started earlier).
    tasks.setRepositories(id, stale);
    expect(tasks.get(id)!.repositories!.map((r) => r.name)).toEqual([stale[0]!.name]);
    expect(tasks.get(id)!.multiRepo).toBe(true);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

// ── removal: the dead end it exists for ─────────────────────────────────

test("a deleted source repository: follow-ups fail until it is removed, then the next follow-up and start prepare only what remains", async () => {
  const { startTask, sendInput, removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const created = await createMulti("dead source", [a, b]);
    id = created.id;
    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);
    const [keep, gone] = tasks.get(id)!.repositories!;
    // The source repository is deleted, and with it the checkout's git dir.
    rmSync(gone!.worktreePath!, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });

    const failing = await sendInput(started.runId, "keep going");
    expect(failing.delivered).toBe(false);
    if (!failing.delivered) expect(failing.reason).toContain("worktree restore failed");

    const removed = await removeTaskRepository(id, gone!.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(removed.task.repositories!.map((r) => r.name)).toEqual([keep!.name]);

    const sent = await sendInput(started.runId, "keep going");
    if (!sent.delivered) throw new Error(sent.reason);
    await settleRun(id);
    const workspace = await workspaceOf(id);
    expect(readdirSync(workspace).filter((n) => !n.startsWith("."))).toEqual([keep!.name]);

    const restarted = await startTask(id);
    if ("error" in restarted) throw new Error(restarted.error);
    await settleRun(id);
    expect(tasks.get(id)!.repositories!.map((r) => r.worktreePath)).toEqual([path.join(workspace, keep!.name)]);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("a missing checkout with its source still there just drops the entry and prunes the registration", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("missing checkout", [a, b]));
    id = task.id;
    const gone = task.repositories![1]!;
    rmSync(gone.worktreePath!, { recursive: true, force: true });
    const removed = await removeTaskRepository(id, gone.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(removed.task.repositories).toHaveLength(1);
    expect(await gitOut(["worktree", "list", "--porcelain"], b)).not.toContain(gone.worktreePath!);
    expect(await branchExists(b, gone.branch!)).toBe(true);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

// ── removal: refusals ───────────────────────────────────────────────────

test("removal refuses: unknown task, unknown repository, single task, last repository", async () => {
  const { createTask, removeTaskRepository } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const solo = await makeRepo("solo");
  let multiId = "";
  let singleId = "";
  try {
    expectRefused(await removeTaskRepository(randomUUID(), "x"), 404);
    const multi = await createMulti("refusals", [a, b]);
    multiId = multi.id;
    expect(expectRefused(await removeTaskRepository(multiId, "nope"), 404)).toContain("nope");

    const single = await createTask({ title: "refuse single", prompt: "p", agent: "claude-code", workdir: solo, isolation: "worktree" });
    if ("error" in single) throw new Error(single.error);
    singleId = single.task.id;
    expectRefused(await removeTaskRepository(singleId, single.task.repositories![0]!.name), 409, "not-multi");

    const first = await removeTaskRepository(multiId, multi.repositories![1]!.name);
    if (!("task" in first)) throw new Error(first.error);
    expectRefused(await removeTaskRepository(multiId, multi.repositories![0]!.name), 409, "last-repository");
  } finally {
    cleanup(multiId ? await workspaceOf(multiId) : undefined, singleId ? await workspaceOf(singleId) : undefined, a, b, solo);
  }
});

test("removal refuses a dirty checkout and leaves it, its entry and its branch alone", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("dirty", [a, b]));
    id = task.id;
    const dirty = task.repositories![1]!;
    writeFileSync(path.join(dirty.worktreePath!, "wip.txt"), "unsaved\n");
    const err = expectRefused(await removeTaskRepository(id, dirty.name), 409, "dirty");
    expect(err).toContain(dirty.name);
    expect(existsSync(path.join(dirty.worktreePath!, "wip.txt"))).toBe(true);
    expect(tasks.get(id)!.repositories).toHaveLength(2);
    expect(await branchExists(b, dirty.branch!)).toBe(true);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("removal refuses a running task", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await createMulti("running", [a, b]);
    id = task.id;
    tasks.update(id, { column: "running" });
    expectRefused(await removeTaskRepository(id, task.repositories![1]!.name), 409, "running");
    expect(tasks.get(id)!.repositories).toHaveLength(2);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("removal refuses a pipeline step, and a pipeline parent while a step runs", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let parentId = "";
  try {
    const parent = await createMulti("pipeline parent", [a, b]);
    parentId = parent.id;
    // Mark it a pipeline parent (soft reference, migration 058).
    const stepId = randomUUID();
    const { db } = await import("./db.ts");
    db.run(`UPDATE tasks SET pipeline_id = ? WHERE id = ?`, ["pipe-1", parentId]);
    tasks.insert({
      ...tasks.get(parentId)!,
      id: stepId,
      title: "step",
      pipelineId: null,
      pipelineParentId: parentId,
      pipelineStepId: "s1",
      multiRepo: true,
      column: "running",
    });
    expect(tasks.get(stepId)!.multiRepo).toBe(true);
    expectRefused(await removeTaskRepository(stepId, parent.repositories![1]!.name), 409, "pipeline-step");
    const err = expectRefused(await removeTaskRepository(parentId, parent.repositories![1]!.name), 409, "running");
    expect(err).toContain("pipeline step");

    // Once the step settles the parent's removal goes through and the step
    // row's copy of the set follows.
    tasks.update(stepId, { column: "done" });
    const removed = await removeTaskRepository(parentId, parent.repositories![1]!.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(tasks.get(stepId)!.repositories!.map((r) => r.name)).toEqual([parent.repositories![0]!.name]);
    expect(tasks.get(stepId)!.multiRepo).toBe(true);
  } finally {
    cleanup(parentId ? await workspaceOf(parentId) : undefined, a, b);
  }
});

// ── issueRepoPath ───────────────────────────────────────────────────────

test("removing the issue's repository clears issueRepoPath; removing another keeps it", async () => {
  const { removeTaskRepository } = await import("./orchestrator.ts");
  const frontend = await makeRepo("frontend", "https://github.com/acme/frontend.git");
  const backend = await makeRepo("backend", "https://github.com/acme/backend.git");
  const extra = await makeRepo("extra", "https://github.com/acme/extra.git");
  let id = "";
  try {
    const task = await createMulti("issue repo", [frontend, backend, extra], {
      issueUrl: "https://github.com/acme/backend/issues/7",
    });
    id = task.id;
    expect(task.issueRepoPath).toBe(backend);
    const byPath = new Map(task.repositories!.map((r) => [r.path, r.name]));
    const other = await removeTaskRepository(id, byPath.get(extra)!);
    if (!("task" in other)) throw new Error(other.error);
    expect(other.task.issueRepoPath).toBe(backend);
    const issue = await removeTaskRepository(id, byPath.get(backend)!);
    if (!("task" in issue)) throw new Error(issue.error);
    expect(issue.task.issueRepoPath).toBeNull();
    expect(issue.task.issueUrl).toBe("https://github.com/acme/backend/issues/7");
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, frontend, backend, extra);
  }
});

// ── archived tasks ──────────────────────────────────────────────────────

test("removal works on an archived task (nothing left to detach) and archive later only sees what remains", async () => {
  const { archiveTask, unarchiveTask, removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("archived removal", [a, b]));
    id = task.id;
    const archived = await archiveTask(id, { awaitTeardown: true });
    if ("error" in archived) throw new Error(archived.error);
    const gone = task.repositories![1]!;
    const removed = await removeTaskRepository(id, gone.name);
    if (!("task" in removed)) throw new Error(removed.error);
    expect(removed.task.archivedAt).not.toBeNull();
    // Unarchive restores only the remaining repository.
    const unarchived = await unarchiveTask(id);
    if ("error" in unarchived) throw new Error(unarchived.error);
    expect(existsSync(path.join(task.repositories![0]!.worktreePath!, ".git"))).toBe(true);
    expect(existsSync(gone.worktreePath!)).toBe(false);
    expect(tasks.get(id)!.repositories).toHaveLength(1);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

// ── Q2: extra roots skip a checkout that isn't on disk ──────────────────

test("withTaskRepositoryRoots names only checkouts that exist; a single task gets its opts back untouched", async () => {
  const { withTaskRepositoryRoots, createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const solo = await makeRepo("solo");
  let id = "";
  let singleId = "";
  try {
    const task = await materialize(await createMulti("roots", [a, b]));
    id = task.id;
    const [present, missing] = task.repositories!;
    const opts = { mode: null };
    expect(withTaskRepositoryRoots(id, opts)).toMatchObject({
      extraDirectories: [present!.worktreePath, missing!.worktreePath],
    });
    rmSync(missing!.worktreePath!, { recursive: true, force: true });
    const pruned = withTaskRepositoryRoots(id, opts)!;
    expect(pruned.extraDirectories).toEqual([present!.worktreePath!]);
    expect(pruned.codexWorkspaceRepos).toEqual([{ worktreePath: present!.worktreePath!, repoPath: a }]);
    // Nothing on disk at all: no flags.
    rmSync(present!.worktreePath!, { recursive: true, force: true });
    expect(withTaskRepositoryRoots(id, opts)).toBe(opts);

    const single = await createTask({ title: "roots single", prompt: "p", agent: "claude-code", workdir: solo, isolation: "worktree" });
    if ("error" in single) throw new Error(single.error);
    singleId = single.task.id;
    mkdirSync(await workspaceOf(singleId), { recursive: true });
    tasks.update(singleId, { worktreePath: await workspaceOf(singleId) });
    expect(withTaskRepositoryRoots(singleId, opts)).toBe(opts);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, singleId ? await workspaceOf(singleId) : undefined, a, b, solo);
  }
});

// ── serialization: a start that arrives mid-removal reads the new set ───

test("a start that arrives while a removal is detaching waits for it and prepares only what remains", async () => {
  const { startTask, removeTaskRepository } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const worktree = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const original = worktree.detachRepositoryForRemoval;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inDetach = new Promise<void>((resolve) => { entered = resolve; });
  const spy = spyOn(worktree, "detachRepositoryForRemoval").mockImplementation(async (task, repo) => {
    entered();
    await gate;
    return original(task, repo);
  });
  let id = "";
  try {
    const task = await materialize(await createMulti("start mid-removal", [a, b]));
    id = task.id;
    const [keep, gone] = task.repositories!;
    const removal = removeTaskRepository(id, gone!.name);
    await inDetach;
    // The removal already passed its checks; this start must not prepare
    // the snapshot it read before the removal settled.
    const start = startTask(id);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const removed = await removal;
    if (!("task" in removed)) throw new Error(removed.error);
    const started = await start;
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);
    expect(tasks.get(id)!.repositories!.map((r) => r.name)).toEqual([keep!.name]);
    expect(existsSync(path.join(keep!.worktreePath!, ".git"))).toBe(true);
    expect(existsSync(gone!.worktreePath!)).toBe(false);
  } finally {
    spy.mockRestore();
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

// ── teardown with a deleted source repository ───────────────────────────

test("archive of a multi task whose first source repository was deleted detaches the other and reaches archived", async () => {
  const { archiveTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { repoRoot } = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("archive dead source", [a, b]));
    id = task.id;
    const [gone, keep] = task.repositories!;
    // Warm the root cache the way a live core has it, then delete the source.
    expect(await repoRoot(a)).toBeTruthy();
    rmSync(a, { recursive: true, force: true });

    const archived = await archiveTask(id, { awaitTeardown: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(tasks.get(id)!.archivedAt).not.toBeNull();
    // The other repository was detached normally, branch kept.
    expect(existsSync(keep!.worktreePath!)).toBe(false);
    expect(await branchExists(b, keep!.branch!)).toBe(true);
    // Git can't vouch for the orphaned checkout: left alone, reported.
    expect(existsSync(gone!.worktreePath!)).toBe(true);
    const outcome = archived.teardown?.repositories?.find((r) => r.name === gone!.name);
    expect(outcome?.result).toEqual({ removed: false, reason: "source-missing" });
    expect(archived.teardown?.repositories?.find((r) => r.name === keep!.name)?.result.removed).toBe(true);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("delete of a multi task whose first source repository was deleted removes the other and deletes the row", async () => {
  const { deleteTask, teardownBranchesForTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { repoRoot } = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("delete dead source", [a, b]));
    id = task.id;
    const [gone, keep] = task.repositories!;
    expect(await repoRoot(a)).toBeTruthy();
    rmSync(a, { recursive: true, force: true });

    // The preview plans nothing for the dead repository and doesn't throw.
    const preview = await teardownBranchesForTask(tasks.get(id)!);
    expect(preview.repositories?.find((r) => r.name === gone!.name)?.branches ?? []).toEqual([]);
    expect(preview.repositories?.find((r) => r.name === keep!.name)?.branches).toContain(keep!.branch!);

    await deleteTask(id);
    expect(tasks.get(id)).toBeNull();
    expect(existsSync(keep!.worktreePath!)).toBe(false);
    expect(await branchExists(b, keep!.branch!)).toBe(false);
    expect(existsSync(gone!.worktreePath!)).toBe(true);
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});

test("a forced archive (Worktrees page) of a multi task whose first source repository was deleted still detaches the other", async () => {
  const { archiveTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { repoRoot } = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  let id = "";
  try {
    const task = await materialize(await createMulti("force archive dead source", [a, b]));
    id = task.id;
    const [gone, keep] = task.repositories!;
    expect(await repoRoot(a)).toBeTruthy();
    rmSync(a, { recursive: true, force: true });

    const archived = await archiveTask(id, { awaitTeardown: true, forceWorktree: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(tasks.get(id)!.archivedAt).not.toBeNull();
    expect(existsSync(keep!.worktreePath!)).toBe(false);
    expect(await branchExists(b, keep!.branch!)).toBe(true);
    expect(existsSync(gone!.worktreePath!)).toBe(true);
    expect(archived.teardown?.reason).toBe("source-missing");
  } finally {
    cleanup(id ? await workspaceOf(id) : undefined, a, b);
  }
});
