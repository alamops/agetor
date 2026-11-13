import { test, expect, afterAll, beforeAll, spyOn } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Review fixes for multi-repository tasks (issue #291), pinned at the
// orchestrator boundary. Setup mirrors orchestrator-multi-repo.test.ts.

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-multi-repo-fixes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_GEMINI_DRIVER = "fake";
process.env.AGETOR_GEMINI_BIN = "/bin/echo";

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

async function revParse(cwd: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ref], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return sha;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)) === 0;
}

async function makeRepo(name: string): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), `agetor-${name}-`));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), `${name}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
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

/** Create a multi-repository task and materialize its checkouts without a run. */
async function preparedMulti(title: string, paths: string[], agent = "claude-code"): Promise<Task> {
  const { createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const created = await createTask({
    title,
    prompt: "p",
    agent,
    workdir: paths[0]!,
    isolation: "worktree",
    repositories: paths.map((p) => ({ path: p })),
  });
  if ("error" in created) throw new Error(created.error);
  const prepared = await prepareTaskWorkdir(created.task);
  if ("error" in prepared) throw new Error(prepared.error);
  tasks.setRepositories(created.task.id, prepared.repositories!);
  tasks.update(created.task.id, { worktreePath: prepared.worktreePath, column: "done" });
  return tasks.get(created.task.id)!;
}

/** Create a single-repository worktree task and materialize its worktree. */
async function preparedSingle(title: string, repo: string): Promise<Task> {
  const { createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const created = await createTask({ title, prompt: "p", agent: "claude-code", workdir: repo, isolation: "worktree" });
  if ("error" in created) throw new Error(created.error);
  const prepared = await prepareTaskWorkdir(created.task);
  if ("error" in prepared) throw new Error(prepared.error);
  tasks.update(created.task.id, { worktreePath: prepared.worktreePath, branch: prepared.branch, column: "done" });
  return tasks.get(created.task.id)!;
}

// ── M1 ────────────────────────────────────────────────────────────────────

test("M1: a multi-repository codex spawn receives codexWorkspaceRepos; a single-repository one doesn't", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  const agents = await import("./agents.ts");
  harnesses.setEnabled("codex", true);
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const solo = await makeRepo("solo");
  const spy = spyOn(agents, "spawnAgent");
  let multiId = "";
  let singleId = "";
  try {
    const multi = await createTask({
      title: "codex multi roots",
      prompt: "p",
      agent: "codex",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in multi) throw new Error(multi.error);
    multiId = multi.task.id;
    const started = await startTask(multiId);
    if ("error" in started) throw new Error(started.error);
    await settleRun(multiId);

    const multiCall = spy.mock.calls.find(([args]) => args.taskId === multiId);
    expect(multiCall).toBeDefined();
    const { tasks } = await import("./db.ts");
    const repos = tasks.get(multiId)!.repositories!;
    expect(multiCall![0].opts?.codexWorkspaceRepos).toEqual(
      repos.map((r) => ({ worktreePath: r.worktreePath!, repoPath: r.path })),
    );
    expect(multiCall![0].opts?.extraDirectories).toEqual(repos.map((r) => r.worktreePath!));

    const single = await createTask({ title: "codex single roots", prompt: "p", agent: "codex", workdir: solo, isolation: "worktree" });
    if ("error" in single) throw new Error(single.error);
    singleId = single.task.id;
    const startedSingle = await startTask(singleId);
    if ("error" in startedSingle) throw new Error(startedSingle.error);
    await settleRun(singleId);
    const singleCall = spy.mock.calls.find(([args]) => args.taskId === singleId);
    expect(singleCall).toBeDefined();
    expect(singleCall![0].opts && "codexWorkspaceRepos" in singleCall![0].opts).toBe(false);
    expect(singleCall![0].opts && "extraDirectories" in singleCall![0].opts).toBe(false);
  } finally {
    spy.mockRestore();
    cleanup(multiId ? await workspaceOf(multiId) : undefined, singleId ? await workspaceOf(singleId) : undefined, a, b, solo);
  }
});

// ── M4 ────────────────────────────────────────────────────────────────────

test("M4: deleteOrphanWorktree refuses a nested id under a live single-repository task", async () => {
  const { deleteOrphanWorktree } = await import("./orchestrator.ts");
  const repo = await makeRepo("single-orphan");
  const task = await preparedSingle("single orphan guard", repo);
  const sub = path.join(task.worktreePath!, "src");
  try {
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "keep.txt"), "live work\n");
    const res = await deleteOrphanWorktree(`${task.id}__src`);
    expect("error" in res && res.error).toContain("owned by an active task");
    expect(existsSync(path.join(sub, "keep.txt"))).toBe(true);
  } finally {
    cleanup(task.worktreePath!, repo);
  }
});

test("M4: deleteOrphanWorktree refuses a case variant of a live repository name", async () => {
  const { deleteOrphanWorktree } = await import("./orchestrator.ts");
  const a = await makeRepo("api");
  const b = await makeRepo("web");
  const task = await preparedMulti("case variant guard", [a, b]);
  const entry = task.repositories![0]!;
  const variant = entry.name.toUpperCase();
  try {
    expect(variant).not.toBe(entry.name);
    // On a case-insensitive volume (macOS default) the variant names the live
    // checkout; on a case-sensitive one it names nothing. Either way nothing
    // may be removed.
    let aliasesLive = false;
    try {
      aliasesLive = statSync(path.join(path.dirname(entry.worktreePath!), variant)).isDirectory();
    } catch { /* case-sensitive volume */ }
    const res = await deleteOrphanWorktree(`${task.id}__${variant}`);
    expect("error" in res).toBe(true);
    if (aliasesLive && "error" in res) expect(res.error).toContain("owned by an active task");
    expect(existsSync(path.join(entry.worktreePath!, ".git"))).toBe(true);
  } finally {
    cleanup(await workspaceOf(task.id), a, b);
  }
});

// ── M5 / S5 ───────────────────────────────────────────────────────────────

test("M5: deleting a single task never deletes a branch an archived multi task holds in the same repo", async () => {
  const { archiveTask, deleteTask, teardownBranchesForTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("shared");
  const b = await makeRepo("other");
  const multi = await preparedMulti("archived multi holder", [a, b]);
  const held = multi.repositories![0]!.branch!;
  const single = await preparedSingle("single drifter", a);
  try {
    // Archive detaches the multi task's checkouts and keeps their branches.
    const archived = await archiveTask(multi.id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(await branchExists(a, held)).toBe(true);

    // The single task's worktree drifts onto the multi task's branch.
    expect(await git(["checkout", held], single.worktreePath!)).toBe(0);

    const preview = await teardownBranchesForTask(tasks.get(single.id)!);
    expect(preview.liveBranch).toBe(held);
    expect(preview.branches).not.toContain(held);

    await deleteTask(single.id);
    expect(tasks.get(single.id)).toBeNull();
    expect(await branchExists(a, held)).toBe(true);
  } finally {
    cleanup(single.worktreePath!, await workspaceOf(multi.id), a, b);
  }
});

test("S5: delete previews never resolve a multi task's workspace root as a repository", async () => {
  const { teardownBranchesForTask } = await import("./orchestrator.ts");
  const worktree = await import("./worktree.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("s5-a");
  const b = await makeRepo("s5-b");
  const live = await preparedMulti("s5 live multi", [a, b]);
  const other = await preparedMulti("s5 previewed multi", [a, b]);
  const single = await preparedSingle("s5 previewed single", a);
  const spy = spyOn(worktree, "repoRoot");
  try {
    await teardownBranchesForTask(tasks.get(single.id)!);
    await teardownBranchesForTask(tasks.get(other.id)!);
    const asked = spy.mock.calls.map(([dir]) => dir);
    expect(asked).not.toContain(live.workdir);
    expect(asked).not.toContain(other.workdir);
  } finally {
    spy.mockRestore();
    cleanup(single.worktreePath!, await workspaceOf(live.id), await workspaceOf(other.id), a, b);
  }
});

test("M5: createTask's existingBranch collision check sees a live multi task's branch", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const a = await makeRepo("collide");
  const b = await makeRepo("collide-other");
  const multi = await preparedMulti("multi branch holder", [a, b]);
  const held = multi.repositories![0]!.branch!;
  try {
    expect(await branchExists(a, held)).toBe(true);
    const res = await createTask({
      title: "attach to held branch",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      existingBranch: held,
    });
    expect("error" in res && res.error).toContain(`another task already has "${held}" checked out`);
  } finally {
    cleanup(await workspaceOf(multi.id), a, b);
  }
});

// ── S2 ────────────────────────────────────────────────────────────────────

test("S2: unarchiving a never-started multi task creates no worktrees or branches", async () => {
  const { createTask, archiveTask, unarchiveTask } = await import("./orchestrator.ts");
  const a = await makeRepo("never-a");
  const b = await makeRepo("never-b");
  const created = await createTask({
    title: "never started multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = await workspaceOf(id);
  try {
    const { tasks } = await import("./db.ts");
    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true });
    if ("error" in archived) throw new Error(archived.error);
    const unarchived = await unarchiveTask(id);
    if ("error" in unarchived) throw new Error(unarchived.error);
    expect(existsSync(workspace)).toBe(false);
    for (const r of created.task.repositories!) {
      expect(await branchExists(r.path, r.branch!)).toBe(false);
    }
  } finally {
    cleanup(workspace, a, b);
  }
});

// ── S3 ────────────────────────────────────────────────────────────────────

test("S3: a start refused after the prepare still records every materialized checkout", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  const { uniqueRepoSlugs } = await import("../shared/multi-repo.ts");
  harnesses.setEnabled("gemini", true);
  const a = await makeRepo("budget-a");
  const b = await makeRepo("budget-b");
  const [nameA] = uniqueRepoSlugs([a, b]);
  // Short `@` tokens that expand to long absolute paths under the workspace:
  // the raw prompt fits gemini's argv cap, the expanded one doesn't.
  const prompt = Array.from({ length: 60 }, () => `@${nameA}/README`).join(" ");
  const created = await createTask({
    title: "budget refusal multi",
    prompt,
    agent: "gemini",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = await workspaceOf(id);
  try {
    const res = await startTask(id);
    expect("error" in res && res.error).toContain("after expanding @ file references");
    const repos = tasks.get(id)!.repositories!;
    for (const r of repos) {
      expect(r.worktreePath).toBe(path.join(workspace, r.name));
      expect(existsSync(path.join(r.worktreePath!, ".git"))).toBe(true);
    }
  } finally {
    cleanup(workspace, a, b);
  }
});

// ── S6 ────────────────────────────────────────────────────────────────────

test("S6: a multi step row with one repository checkout missing is refused on start and follow-up", async () => {
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs, db } = await import("./db.ts");
  const a = await makeRepo("step-a");
  const b = await makeRepo("step-b");
  const parent = await preparedMulti("step parent", [a, b]);
  const step = await preparedMulti("step row", [a, b]);
  try {
    db.run("UPDATE tasks SET pipeline_parent_id = ?, pipeline_step_id = ? WHERE id = ?", [parent.id, "step-1", step.id]);
    const missing = step.repositories![1]!.worktreePath!;
    rmSync(missing, { recursive: true, force: true });
    expect(existsSync(step.worktreePath!)).toBe(true);

    const started = await startTask(step.id);
    expect("error" in started && started.error).toContain("step task's worktree is missing");
    expect(existsSync(missing)).toBe(false);

    const runId = crypto.randomUUID();
    runs.insert({
      id: runId,
      taskId: step.id,
      agent: "claude-code",
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
      copilotSessionId: null,
    });
    tasks.update(step.id, { column: "review" });
    const sent = await sendInput(runId, "follow up");
    expect(sent.delivered).toBe(false);
    if (!sent.delivered) expect(sent.reason).toContain("step task's worktree is missing");
    expect(existsSync(missing)).toBe(false);
  } finally {
    cleanup(await workspaceOf(parent.id), await workspaceOf(step.id), a, b);
  }
});

// ── N4 ────────────────────────────────────────────────────────────────────

test("N4: the same repository twice with different base refs is refused, naming the path", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const a = await makeRepo("dup-a");
  const b = await makeRepo("dup-b");
  await git(["checkout", "-b", "release"], a);
  writeFileSync(path.join(a, "CHANGE"), "x\n");
  await git(["add", "."], a);
  await git(["commit", "-m", "release"], a);
  await git(["checkout", "main"], a);
  const createdIds: string[] = [];
  try {
    const refused = await createTask({
      title: "dup refs",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a, baseRef: "main" }, { path: b }, { path: a, baseRef: "release" }],
    });
    expect("error" in refused && refused.error).toContain(a);
    expect("error" in refused && refused.error).toContain("different base refs");

    // The same ref twice (explicit or defaulted) is a harmless duplicate.
    const ok = await createTask({
      title: "dup same ref",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a, baseRef: "release" }, { path: b }, { path: a, baseRef: "release" }],
    });
    if ("error" in ok) throw new Error(ok.error);
    createdIds.push(ok.task.id);
    expect(ok.task.repositories).toHaveLength(2);
    expect(ok.task.repositories![0]!.baseRef).toBe(await revParse(a, "release"));
  } finally {
    for (const id of createdIds) cleanup(await workspaceOf(id));
    cleanup(a, b);
  }
});

// ── S7 ────────────────────────────────────────────────────────────────────

test("S7: a prepare reporting an unknown checkout doesn't overwrite the stored checkoutBranch", async () => {
  const { noteRestoredCheckout } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const a = await makeRepo("unknown-a");
  const b = await makeRepo("unknown-b");
  const task = await preparedMulti("unknown checkout", [a, b]);
  const [first, second] = task.repositories!;
  try {
    tasks.setRepositoryCheckout(task.id, first!.name, "recorded/first");
    tasks.setRepositoryCheckout(task.id, second!.name, "recorded/second");
    // `second`'s live read failed: its checkoutBranch is the input snapshot.
    const prepared = {
      cwd: task.worktreePath!,
      worktreePath: task.worktreePath!,
      branch: null,
      repositories: [
        { ...first!, checkoutBranch: "live/first" },
        { ...second!, checkoutBranch: "stale/snapshot" },
      ],
      unknownCheckouts: [second!.name],
    } as unknown as import("./worktree.ts").PreparedWorkdir;
    noteRestoredCheckout(task.id, prepared);
    const stored = tasks.get(task.id)!.repositories!;
    expect(stored.find((r) => r.name === first!.name)?.checkoutBranch).toBe("live/first");
    expect(stored.find((r) => r.name === second!.name)?.checkoutBranch).toBe("recorded/second");
  } finally {
    cleanup(await workspaceOf(task.id), a, b);
  }
});
