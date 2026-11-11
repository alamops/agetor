import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BranchNamingConfig, Task } from "../shared/types.ts";
import { DEFAULT_BRANCH_CONFIG } from "../shared/types.ts";
import { uniqueRepoSlugs } from "../shared/multi-repo.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-multi-repo-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

type Mods = {
  createTask: typeof import("./orchestrator.ts").createTask;
  startTask: typeof import("./orchestrator.ts").startTask;
  archiveTask: typeof import("./orchestrator.ts").archiveTask;
  unarchiveTask: typeof import("./orchestrator.ts").unarchiveTask;
  tasks: typeof import("./db.ts").tasks;
  db: typeof import("./db.ts").db;
  projects: typeof import("./db.ts").projects;
  worktreePath: typeof import("./worktree.ts").worktreePath;
  WORKTREES_DIR: typeof import("./worktree.ts").WORKTREES_DIR;
};
let mods: Mods | null = null;
async function load(): Promise<Mods> {
  if (mods) return mods;
  const o = await import("./orchestrator.ts");
  const dbm = await import("./db.ts");
  const wt = await import("./worktree.ts");
  mods = {
    createTask: o.createTask,
    startTask: o.startTask,
    archiveTask: o.archiveTask,
    unarchiveTask: o.unarchiveTask,
    tasks: dbm.tasks,
    db: dbm.db,
    projects: dbm.projects,
    worktreePath: wt.worktreePath,
    WORKTREES_DIR: wt.WORKTREES_DIR,
  };
  return mods;
}

/** Simulate what a claude spawn leaves in a multi-repository workspace root:
 *  `ensureInstalledForCwd` writes `<workspace>/.claude/settings.local.json`.
 *  Teardown must prune this agetor-owned scratch, or the non-empty root stays
 *  behind forever (review M4). */
function seedClaudeScratch(workspace: string): void {
  mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  writeFileSync(path.join(workspace, ".claude", "settings.local.json"), "{}");
}

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(name = "repo", remote?: string): Promise<string> {
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

/** Wait until the task's current run (if any) has settled. A fixed sleep was
 *  both slow and flaky: too short on a loaded box (archive/delete racing a
 *  live run) and needlessly long on a fast one. */
async function settleRun(taskId: string): Promise<void> {
  const { tasks } = await load();
  const { runs } = await import("./db.ts");
  await waitFor(() => {
    const runId = tasks.get(taskId)?.runId;
    if (!runId) return true;
    const run = runs.get(runId);
    return !!run && run.status !== "running";
  });
}

test("createTask pins a workspace with one entry, branch and base per repository", async () => {
  const { createTask } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "auth across repos",
    prompt: "do it",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  try {
    if ("error" in created) throw new Error(created.error);
    const t = created.task;
    const { WORKTREES_DIR } = await load();
    expect(t.workdir).toBe(path.join(WORKTREES_DIR, t.id));
    expect(t.worktreePath).toBeNull();
    expect(t.branch).toBeNull();
    expect(t.baseRef).toBeNull();
    const names = uniqueRepoSlugs([a, b]);
    expect(t.repositories?.map((r) => r.name)).toEqual(names);
    expect(t.repositories?.map((r) => r.path)).toEqual([a, b]);
    expect(t.repositories?.every((r) => r.branch && r.baseRef?.length === 40)).toBe(true);
    expect(t.repositories?.[0]?.branch).toBe(t.repositories?.[1]?.branch);
  } finally {
    cleanup(a, b);
  }
});

test("createTask plans a multi task's branch from repositories[0] even when workdir isn't a git repo", async () => {
  // Review round seven: with no git `--workdir` (an API caller, or
  // `agetor add --repo` from a non-repo cwd) the branch plan was skipped
  // entirely — the explicit `branch` override and the project's branch
  // nomenclature were both silently ignored. Anchor on the first selected
  // repository instead.
  const { createTask, projects } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const notRepo = mkdtempSync(path.join(tmpdir(), "agetor-branch-cwd-"));
  const config: BranchNamingConfig = {
    ...DEFAULT_BRANCH_CONFIG,
    rules: { ...DEFAULT_BRANCH_CONFIG.rules, task: { prefix: "proj/" } },
  };
  projects.upsert(a, "frontend");
  projects.setBranchConfig(a, config);
  try {
    const fromConfig = await createTask({
      title: "Implement auth",
      prompt: "p",
      agent: "claude-code",
      workdir: notRepo,
      isolation: "worktree",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in fromConfig) throw new Error(fromConfig.error);
    expect(fromConfig.task.repositories?.every((r) => r.branch?.startsWith("proj/"))).toBe(true);
    expect(new Set(fromConfig.task.repositories?.map((r) => r.branch)).size).toBe(1);

    const overridden = await createTask({
      title: "Implement auth",
      prompt: "p",
      agent: "claude-code",
      workdir: notRepo,
      isolation: "worktree",
      branch: "feature/explicit",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in overridden) throw new Error(overridden.error);
    expect(overridden.task.repositories?.map((r) => r.branch)).toEqual([
      "feature/explicit",
      "feature/explicit",
    ]);
  } finally {
    projects.delete(a);
    cleanup(notRepo, a, b);
  }
});

test("createTask gives a secondary repository a fresh branch instead of re-attaching a leftover one", async () => {
  // Review M1: only the first repository was probed for an existing ref, so a
  // branch left behind by an archived task in repository B was silently
  // re-attached — the new worktree came back with that task's commits.
  const { createTask, startTask, tasks, WORKTREES_DIR } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  // An archived task's leftovers in repo B: a branch with a commit on it.
  await git(["checkout", "-b", "feature/auth"], b);
  writeFileSync(path.join(b, "leftover.txt"), "old work\n");
  await git(["add", "."], b);
  await git(["commit", "-m", "old work"], b);
  await git(["checkout", "main"], b);
  const created = await createTask({
    title: "auth across repos",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    branch: "feature/auth",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = path.join(WORKTREES_DIR, id);
  try {
    const repos = created.task.repositories!;
    expect(repos[0]!.branch).toBe("feature/auth");
    expect(repos[1]!.branch).toBe("feature/auth-2");

    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    await settleRun(id);
    const started = tasks.get(id)!;
    const backend = started.repositories!.find((r) => r.name === repos[1]!.name)!;
    expect(backend.branch).toBe("feature/auth-2");
    expect(existsSync(path.join(backend.worktreePath!, "leftover.txt"))).toBe(false);
  } finally {
    cleanup(workspace, a, b);
  }
});

test("two paths under one git root collapse to the single-repository layout", async () => {
  const { createTask } = await load();
  const a = await makeRepo("mono");
  const sub = path.join(a, "packages", "app");
  mkdirSync(sub, { recursive: true });
  try {
    const created = await createTask({
      title: "mono",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a }, { path: sub }],
    });
    if ("error" in created) throw new Error(created.error);
    expect(created.task.workdir).toBe(a);
    expect(created.task.branch).not.toBeNull();
    expect(created.task.repositories).toHaveLength(1);
    expect(created.task.repositories?.[0]?.path).toBe(a);
  } finally {
    cleanup(a);
  }
});

test("a single repositories entry keeps its per-repository base ref", async () => {
  // Review S1: `agetor add --repo <path>=<ref>` sends ONE entry and its ref in
  // `repositories[].baseRef`. createTask took the ordinary single-repository
  // path, which only read the top-level `baseRef`, so the ref was silently
  // ignored and the task branched from HEAD.
  const { createTask } = await load();
  const a = await makeRepo("single-base");
  writeFileSync(path.join(a, "next.txt"), "next\n");
  await git(["checkout", "-b", "release/next"], a);
  await git(["add", "."], a);
  await git(["commit", "-m", "next"], a);
  await git(["checkout", "main"], a);
  const proc = Bun.spawn(["git", "rev-parse", "release/next"], { cwd: a, stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  try {
    const created = await createTask({
      title: "single base",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a, baseRef: "release/next" }],
    });
    if ("error" in created) throw new Error(created.error);
    expect(created.task.workdir).toBe(a);
    expect(created.task.baseRef).toBe(sha);
    expect(created.task.repositories).toHaveLength(1);
    expect(created.task.repositories?.[0]?.baseRef).toBe(sha);
  } finally {
    cleanup(a);
  }
});

test("createTask names every bad repository and inserts nothing", async () => {
  const { createTask, tasks } = await load();
  const good = await makeRepo("good");
  const notRepo = mkdtempSync(path.join(tmpdir(), "agetor-notrepo-"));
  const badBase = await makeRepo("badbase");
  const before = tasks.list().length;
  try {
    const created = await createTask({
      title: "bad",
      prompt: "p",
      agent: "claude-code",
      workdir: good,
      isolation: "worktree",
      repositories: [
        { path: good },
        { path: notRepo },
        { path: badBase, baseRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      ],
    });
    expect("error" in created).toBe(true);
    if (!("error" in created)) return;
    expect(created.error).toContain("not inside a git repository");
    expect(created.error).toContain("deadbeef");
    expect(tasks.list().length).toBe(before);
  } finally {
    cleanup(good, notRepo, badBase);
  }
});

test("multi-repo rejects isolation none and existingBranch", async () => {
  const { createTask } = await load();
  const a = await makeRepo("a");
  const b = await makeRepo("b");
  try {
    const none = await createTask({
      title: "none",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "none",
      repositories: [{ path: a }, { path: b }],
    });
    expect("error" in none && /worktree isolation/.test(none.error)).toBe(true);
    const existing = await createTask({
      title: "existing",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      existingBranch: "main",
      repositories: [{ path: a }, { path: b }],
    });
    expect("error" in existing && /existingBranch/.test(existing.error)).toBe(true);
  } finally {
    cleanup(a, b);
  }
});

test("the issue repo is matched against every repository", async () => {
  const { createTask } = await load();
  const frontend = await makeRepo("frontend", "https://github.com/acme/frontend.git");
  const backend = await makeRepo("backend", "https://github.com/acme/backend.git");
  try {
    const created = await createTask({
      title: "issue",
      prompt: "p",
      agent: "claude-code",
      workdir: frontend,
      isolation: "worktree",
      repositories: [{ path: frontend }, { path: backend }],
      issueUrl: "https://github.com/acme/backend/issues/7",
    });
    if ("error" in created) throw new Error(created.error);
    expect(created.task.issueRepoPath).toBe(backend);

    const none = await createTask({
      title: "issue2",
      prompt: "p",
      agent: "claude-code",
      workdir: frontend,
      isolation: "worktree",
      repositories: [{ path: frontend }, { path: backend }],
      issueUrl: "https://github.com/acme/other/issues/7",
    });
    expect("error" in none).toBe(true);
  } finally {
    cleanup(frontend, backend);
  }
});

test("startTask materializes both worktrees, spawns at the workspace and appends the Repositories block once", async () => {
  const { createTask, startTask, tasks, WORKTREES_DIR } = await load();
  const { __getFakeDriver } = await import("./agents.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "start multi",
    prompt: "implement auth",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
    references: [{ path: path.join(a, "README"), isDirectory: false }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  try {
    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    await settleRun(id);
    const t = tasks.get(id)!;
    const workspace = path.join(WORKTREES_DIR, id);
    expect(t.worktreePath).toBe(workspace);
    const names = uniqueRepoSlugs([a, b]);
    expect(t.repositories?.map((r) => r.worktreePath)).toEqual([
      path.join(workspace, names[0]!),
      path.join(workspace, names[1]!),
    ]);
    expect(existsSync(path.join(workspace, names[0]!, ".git"))).toBe(true);
    expect(existsSync(path.join(workspace, names[1]!, ".git"))).toBe(true);

    const record = __getFakeDriver(id)?._record ?? [];
    const spawn = record.find((r) => r.startsWith("spawn:")) ?? "";
    expect(record).toContain(`cwd:${workspace}`);
    expect(spawn).toContain("implement auth");
    expect(spawn.split("Repositories:").length - 1).toBe(1);
    expect(spawn).toContain(`- ${names[0]}: ${path.join(workspace, names[0]!)} (branch `);
    expect(spawn).toContain(`- ${names[1]}: ${path.join(workspace, names[1]!)} (branch `);
    // The references block stays last.
    expect(spawn.indexOf("Repositories:")).toBeLessThan(spawn.indexOf("README"));
  } finally {
    cleanup((await load()).worktreePath({ id } as Task), a, b);
  }
});

test("archive detaches every clean repository and unarchive restores them", async () => {
  const { createTask, startTask, archiveTask, unarchiveTask, tasks, WORKTREES_DIR } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "archive multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = path.join(WORKTREES_DIR, id);
  try {
    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    await settleRun(id);
    // A claude run writes agetor's settings scratch into the workspace root.
    seedClaudeScratch(workspace);
    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    const names = uniqueRepoSlugs([a, b]);
    expect(existsSync(path.join(workspace, names[0]!))).toBe(false);
    expect(existsSync(path.join(workspace, names[1]!))).toBe(false);
    // The workspace root itself is reclaimed too — its only leftover was
    // agetor's own `.claude/settings.local.json`.
    expect(existsSync(workspace)).toBe(false);
    // Branches survive a detach.
    expect(tasks.get(id)?.repositories?.map((r) => r.branch)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);

    const unarchived = await unarchiveTask(id);
    if ("error" in unarchived) throw new Error(unarchived.error);
    expect(existsSync(path.join(workspace, names[0]!, ".git"))).toBe(true);
    expect(existsSync(path.join(workspace, names[1]!, ".git"))).toBe(true);
  } finally {
    cleanup(workspace, a, b);
  }
});

test("deleteTask removes every repository worktree and branch", async () => {
  const { createTask, startTask, tasks, WORKTREES_DIR } = await load();
  const { deleteTask } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "delete multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = path.join(WORKTREES_DIR, id);
  try {
    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    await settleRun(id);
    seedClaudeScratch(workspace);
    await deleteTask(id);
    expect(existsSync(workspace)).toBe(false);
    expect(tasks.get(id)).toBeNull();
    const branch = (await Bun.spawn(["git", "rev-parse", "--verify", "--quiet", "refs/heads/" + created.task.repositories![0]!.branch], { cwd: a, stdout: "pipe", stderr: "pipe" }).exited) !== 0;
    expect(branch).toBe(true);
  } finally {
    cleanup(workspace, a, b);
  }
});

test("deleteTask removes the branch a repository's worktree drifted onto", async () => {
  // Review should-fix: the per-repository teardown plan was computed but
  // ignored by delete, which deleted only each entry's pinned branch — a
  // drifted checkout's branch was left behind.
  const { createTask, startTask, tasks, WORKTREES_DIR } = await load();
  const { deleteTask } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "delete drifted multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = path.join(WORKTREES_DIR, id);
  try {
    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    await settleRun(id);
    const repoA = tasks.get(id)!.repositories![0]!;
    // Switch repo A's worktree onto a new branch (drift), then delete.
    await git(["checkout", "-b", "drifted-work"], repoA.worktreePath!);
    await deleteTask(id);
    const exists = async (branch: string) =>
      (await Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: a, stdout: "pipe", stderr: "pipe",
      }).exited) === 0;
    expect(await exists(repoA.branch!)).toBe(false);
    expect(await exists("drifted-work")).toBe(false);
    expect(existsSync(workspace)).toBe(false);
  } finally {
    cleanup(workspace, a, b);
  }
});

test("duplicateAgentProfile copies a multi-repository task's repository set", async () => {
  const { createTask } = await load();
  const { agentProfiles } = await import("./db.ts");
  const { duplicateAgentProfile } = await import("./duplicate-agent-profile.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const profile = agentProfiles.insert({
    name: `multi-copy-${randomUUID()}`,
    harness: "claude-code",
    model: "claude-opus-4-7",
    instructions: "",
    skills: [],
  });
  try {
    const created = await createTask({
      title: "copy me",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      agentProfileId: profile.id,
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in created) throw new Error(created.error);
    const res = await duplicateAgentProfile(profile.id, {
      name: `copy-of-${randomUUID()}`,
      harness: "claude-code",
      model: "claude-opus-4-7",
      instructions: "",
      skills: [],
    }, true);
    if ("notFound" in res) throw new Error("not found");
    expect(res.copiedTasks).toHaveLength(1);
    const copy = res.copiedTasks[0]!;
    expect(copy.id).not.toBe(created.task.id);
    expect(copy.repositories?.map((r) => r.path)).toEqual([a, b]);
    expect(copy.repositories?.map((r) => r.name)).toEqual(created.task.repositories?.map((r) => r.name));
    expect(copy.agentProfileId).toBe(res.profile.id);
  } finally {
    cleanup(a, b);
  }
});
