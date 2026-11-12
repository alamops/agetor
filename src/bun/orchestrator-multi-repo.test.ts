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

async function revParse(cwd: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ref], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return sha;
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

test("three repositories get three entries, three branches and three worktrees under one workspace", async () => {
  // Acceptance criterion 1 (the issue's frontend/backend/infrastructure case):
  // the two-repository scenarios elsewhere prove the multi path, but the
  // reported shape is N repositories in one card. Also pins that the sanitized
  // slugs stay distinct at N=3 and that every entry materializes its own
  // branch instead of the first repo's name leaking to its siblings.
  const { createTask, WORKTREES_DIR } = await load();
  const { prepareTaskWorkdir, readCheckoutBranch } = await import("./worktree.ts");
  const frontend = await makeRepo("frontend");
  const backend = await makeRepo("backend");
  const infra = await makeRepo("infrastructure");
  const created = await createTask({
    title: "three repos",
    prompt: "p",
    agent: "claude-code",
    workdir: frontend,
    isolation: "worktree",
    repositories: [{ path: frontend }, { path: backend }, { path: infra }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const workspace = path.join(WORKTREES_DIR, id);
  try {
    const repos = created.task.repositories!;
    expect(repos.map((r) => r.path)).toEqual([frontend, backend, infra]);
    expect(new Set(repos.map((r) => r.name)).size).toBe(3);
    expect(repos.every((r) => typeof r.branch === "string" && r.branch.length > 0)).toBe(true);

    const prepared = await prepareTaskWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.cwd).toBe(workspace);
    expect(prepared.repositories).toHaveLength(3);
    for (const repo of prepared.repositories!) {
      expect(repo.worktreePath).toBe(path.join(workspace, repo.name));
      expect(existsSync(path.join(repo.worktreePath!, ".git"))).toBe(true);
      const live = await readCheckoutBranch(repo.worktreePath!);
      expect(live.ok && live.branch).toBe(repo.branch);
    }
  } finally {
    cleanup(workspace, frontend, backend, infra);
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

test("a not-yet-started multi task's branch pins keep a later same-title single task unique", async () => {
  // Review R-M1: create-time uniqueness read only `t.branch`, so a multi task
  // created FIRST (its pins live in `repositories[].branch`, scalar branch is
  // null) was invisible. A same-title single task then pinned the SAME name,
  // and whichever materialized second silently attached to the other's
  // branch — including its commits.
  const { createTask, tasks } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  try {
    const multi = await createTask({
      title: "shared title",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in multi) throw new Error(multi.error);
    const pinned = multi.task.repositories!.map((r) => r.branch);
    expect(pinned[0]).toBe(pinned[1]);

    const single = await createTask({
      title: "shared title",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
    });
    if ("error" in single) throw new Error(single.error);

    expect(single.task.branch).not.toBe(pinned[0]);
    expect(single.task.branch).toBe(`${pinned[0]}-2`);
    // The multi row's own pins are untouched by the later single create.
    expect(tasks.get(multi.task.id)?.repositories?.map((r) => r.branch)).toEqual(pinned);
  } finally {
    cleanup(a, b);
  }
});

test("sibling subdirectory selections of one repository see each other's branch pins", async () => {
  // Review R11-M1: pins were keyed only by the selected path, so two multi
  // tasks that picked sibling subdirectories of one repository never saw each
  // other's pin. Both pinned the same name, and whichever started second
  // attached to the other task's branch and commits.
  const { createTask } = await load();
  const mono = await makeRepo("mono");
  const subA = path.join(mono, "app-one");
  const subB = path.join(mono, "app-two");
  mkdirSync(subA);
  mkdirSync(subB);
  const otherA = await makeRepo("other-a");
  const otherB = await makeRepo("other-b");
  try {
    const first = await createTask({
      title: "shared title",
      prompt: "p",
      agent: "claude-code",
      workdir: subA,
      isolation: "worktree",
      repositories: [{ path: subA }, { path: otherA }],
    });
    if ("error" in first) throw new Error(first.error);
    const pinned = first.task.repositories!.find((r) => r.path === subA)!.branch;
    expect(pinned).toBeTruthy();

    const second = await createTask({
      title: "shared title",
      prompt: "p",
      agent: "claude-code",
      workdir: subB,
      isolation: "worktree",
      repositories: [{ path: subB }, { path: otherB }],
    });
    if ("error" in second) throw new Error(second.error);
    const repinned = second.task.repositories!.find((r) => r.path === subB)!.branch;

    expect(repinned).not.toBe(pinned);
    expect(repinned).toBe(`${pinned}-2`);
    // The unrelated repositories still share the desired name.
    expect(second.task.repositories!.find((r) => r.path === otherB)!.branch).toBe(pinned);
  } finally {
    cleanup(mono, otherA, otherB);
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

test("the repository set owns workdir over an explicit one", async () => {
  // Review round thirteen (Q1): `--workdir A --repo B` sent A as the task's
  // workdir, but createTask derives it from the selected repositories, so A
  // was silently dropped server-side. Pin the rule at the contract: one kept
  // entry -> that entry's path, 2+ -> the per-task workspace root.
  const { createTask, WORKTREES_DIR } = await load();
  const a = await makeRepo("single-anchor");
  const b = await makeRepo("multi-anchor");
  const elsewhere = mkdtempSync(path.join(tmpdir(), "agetor-workdir-anchor-"));
  try {
    const single = await createTask({
      title: "single anchor",
      prompt: "p",
      agent: "claude-code",
      workdir: elsewhere,
      isolation: "worktree",
      repositories: [{ path: a }],
    });
    if ("error" in single) throw new Error(single.error);
    expect(single.task.workdir).toBe(a);
    expect(single.task.repositories).toHaveLength(1);

    const multi = await createTask({
      title: "multi anchor",
      prompt: "p",
      agent: "claude-code",
      workdir: elsewhere,
      isolation: "worktree",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in multi) throw new Error(multi.error);
    expect(multi.task.workdir).toBe(path.join(WORKTREES_DIR, multi.task.id));
  } finally {
    cleanup(elsewhere, a, b);
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

test("a single repositories entry's own base ref beats the task-level default", async () => {
  // Review M1 (round 9): a selection that collapses to one repository took
  // the ordinary single path, where the top-level `baseRef` was read first.
  // That let `--base-ref` silently override an explicit
  // `--repo <path>=<ref>` pin, while the same two flags on a 2+ selection
  // honored the pin. The documented rule is entry-pin-wins everywhere.
  const { createTask } = await load();
  const a = await makeRepo("collapsed-base");
  writeFileSync(path.join(a, "next.txt"), "next\n");
  await git(["checkout", "-b", "release/next"], a);
  await git(["add", "."], a);
  await git(["commit", "-m", "next"], a);
  await git(["checkout", "main"], a);
  const nextSha = await revParse(a, "release/next");
  const mainSha = await revParse(a, "main");
  expect(nextSha).not.toBe(mainSha);
  try {
    const pinned = await createTask({
      title: "collapsed pinned",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      baseRef: "main",
      repositories: [{ path: a, baseRef: "release/next" }],
    });
    if ("error" in pinned) throw new Error(pinned.error);
    expect(pinned.task.baseRef).toBe(nextSha);
    expect(pinned.task.repositories?.[0]?.baseRef).toBe(nextSha);

    const defaulted = await createTask({
      title: "collapsed default",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      baseRef: "release/next",
      repositories: [{ path: a }],
    });
    if ("error" in defaulted) throw new Error(defaulted.error);
    expect(defaulted.task.baseRef).toBe(nextSha);
    expect(defaulted.task.repositories?.[0]?.baseRef).toBe(nextSha);
  } finally {
    cleanup(a);
  }
});

test("a task-level base ref is the default for unpinned multi-repository entries", async () => {
  // Review M1: `agetor add --repo a --repo b --base-ref release/next` (and a
  // direct POST /tasks with `baseRef`) resolved each entry's own pin or HEAD
  // and silently discarded the task-level ref, so both repos branched from
  // their HEAD instead of the requested sha.
  const { createTask } = await load();
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  for (const repo of [a, b]) {
    writeFileSync(path.join(repo, "next.txt"), "next\n");
    await git(["checkout", "-b", "release/next"], repo);
    await git(["add", "."], repo);
    await git(["commit", "-m", "next"], repo);
    await git(["checkout", "main"], repo);
  }
  const aNext = await revParse(a, "release/next");
  const bNext = await revParse(b, "release/next");
  const bMain = await revParse(b, "main");
  try {
    const created = await createTask({
      title: "auth across repos",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      baseRef: "release/next",
      // The entry-level pin must still win over the task-level default.
      repositories: [{ path: a }, { path: b, baseRef: "main" }],
    });
    if ("error" in created) throw new Error(created.error);
    expect(created.task.baseRef).toBeNull();
    expect(created.task.repositories?.map((r) => r.baseRef)).toEqual([aNext, bMain]);
    // The repos really do carry distinct shas on that branch, so the assertion
    // above proves each entry resolved against its own refs.
    expect(aNext).not.toBe(bNext);

    const both = await createTask({
      title: "auth across repos",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      baseRef: "release/next",
      repositories: [{ path: a }, { path: b }],
    });
    if ("error" in both) throw new Error(both.error);
    expect(both.task.repositories?.map((r) => r.baseRef)).toEqual([aNext, bNext]);

    const missing = await createTask({
      title: "bad default base",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      baseRef: "does-not-exist",
      repositories: [{ path: a }, { path: b }],
    });
    expect("error" in missing).toBe(true);
    if ("error" in missing) {
      expect(missing.error).toContain('base ref "does-not-exist" not found in');
    }
  } finally {
    cleanup(a, b);
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

test("a follow-up send restores a repository worktree that vanished from disk", async () => {
  // T4 acceptance: `sendInput` restores a missing worktree before delivering.
  // For a multi-repository task `workdirNeedsRestore` must consider EVERY
  // entry, not just the (always-present) workspace root — a deleted secondary
  // checkout otherwise starts the follow-up turn in a workspace where one
  // repository silently cannot be read or modified.
  const { createTask, startTask, tasks } = await load();
  const { sendInput } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "send restores multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  try {
    const started = await startTask(id);
    if ("error" in started) throw new Error(started.error);
    await settleRun(id);
    const before = tasks.get(id)!;
    const missing = before.repositories![1]!;
    expect(missing.worktreePath).toBeTruthy();
    rmSync(missing.worktreePath!, { recursive: true, force: true });
    expect(existsSync(missing.worktreePath!)).toBe(false);

    const sent = await sendInput(started.runId, "continue after the restore");
    if (!sent.delivered) throw new Error(sent.reason);
    await settleRun(id);

    const after = tasks.get(id)!.repositories!;
    expect(existsSync(after[1]!.worktreePath!)).toBe(true);
    expect(existsSync(path.join(after[1]!.worktreePath!, ".git"))).toBe(true);
    // Still the same pinned branch, re-attached in place.
    const { readCheckoutBranch } = await import("./worktree.ts");
    const live = await readCheckoutBranch(after[1]!.worktreePath!);
    expect(live.ok && live.branch).toBe(after[1]!.branch);
  } finally {
    cleanup((await load()).worktreePath({ id } as Task), a, b);
  }
});

test("archive records every repository's live checkout and unarchive re-attaches onto it", async () => {
  // T6 acceptance: the archive teardown reads each repository's worktree for
  // its live branch — never the non-git workspace root — so a drifted checkout
  // survives an archive/unarchive round trip instead of coming back on the
  // stale task branch.
  const { createTask, archiveTask, unarchiveTask, tasks } = await load();
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "checkout multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  try {
    // Materialize without starting a run: the run-settled checkout recorder is
    // fire-and-forget and could otherwise read the drifted branch, masking the
    // archive-time per-repository read this test exists to pin.
    const prepared = await prepareTaskWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.setRepositories(id, prepared.repositories!);
    tasks.update(id, { worktreePath: prepared.worktreePath, branch: prepared.branch });
    const drifted = prepared.repositories![1]!;
    await git(["checkout", "-b", "hotfix/live"], drifted.worktreePath!);

    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);

    const afterArchive = tasks.get(id)!;
    // Per-repository recording: A kept its task branch, B its drifted checkout.
    expect(afterArchive.repositories![0]!.checkoutBranch).toBe(afterArchive.repositories![0]!.branch);
    expect(afterArchive.repositories![1]!.checkoutBranch).toBe("hotfix/live");
    // The scalar never absorbed the workspace root (it is not a git checkout).
    expect(afterArchive.checkoutBranch).toBeNull();

    const unarchived = await unarchiveTask(id);
    if ("error" in unarchived) throw new Error(unarchived.error);
    const restored = tasks.get(id)!.repositories![1]!;
    expect(existsSync(restored.worktreePath!)).toBe(true);
    const { readCheckoutBranch } = await import("./worktree.ts");
    const live = await readCheckoutBranch(restored.worktreePath!);
    expect(live.ok && live.branch).toBe("hotfix/live");
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

test("a retained multi workspace is listed and can be cleaned by a repeat archive", async () => {
  // Review S1 (round 9): teardown keeps the workspace root when an agent left
  // files in it. `listWorktrees` must surface that retained root (it emitted
  // zero rows once every repository checkout was gone), and a repeat archive
  // must then reclaim it once the artifact is removed.
  const { createTask, startTask, archiveTask, tasks, WORKTREES_DIR } = await load();
  const { listWorktrees } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "retained multi",
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
    const names = uniqueRepoSlugs([a, b]);
    // A user-visible agent artifact (not agetor's own scratch): teardown must
    // preserve it and therefore keep the root.
    writeFileSync(path.join(workspace, "notes.md"), "agent notes\n");
    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(existsSync(path.join(workspace, names[0]!))).toBe(false);
    expect(existsSync(path.join(workspace, names[1]!))).toBe(false);
    expect(existsSync(path.join(workspace, "notes.md"))).toBe(true);
    // Review R-S3: every repository checkout is gone but the root survives on
    // user files, so the Worktrees row (id = task id) is still there. The
    // teardown must say so instead of reporting "already absent" success.
    expect(archived.teardown?.removed).toBe(false);
    expect(archived.teardown?.reason).toBe("workspace-not-empty");

    const row = listWorktrees().find((entry) => entry.id === id);
    expect(row).toBeDefined();
    expect(row?.taskId).toBe(id);
    expect(row?.path).toBe(workspace);
    expect(row?.staleReasons).toContain("archived");

    // The Worktrees page's delete action archives again; once the artifact is
    // gone this pass reclaims the empty root.
    rmSync(path.join(workspace, "notes.md"));
    const retried = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.teardown?.removed).toBe(true);
    expect(existsSync(workspace)).toBe(false);
    expect(listWorktrees().some((entry) => entry.id === id)).toBe(false);
  } finally {
    cleanup(workspace, a, b);
  }
});

/**
 * Fixture for the multi-repository teardown FIFO tests: two prepared multi
 * tasks, A = [frontend, backend] and B = [backend, infra], sharing the backend
 * repository, plus a controllable gate per repository key.
 *
 * "Parked" is checked without timing. Every key is held while the tasks are
 * archived, so no job can start yet; then, while a task's job must stay
 * parked, its row's `archivedAt` is cleared: the archive job re-reads the row
 * first and
 * bails synchronously when it is not archived, so a job that ran too early
 * settles within the microtask queue, and one `setImmediate` turn (which runs
 * only after every microtask) is enough to see it. The real `archivedAt` is
 * restored before that task's last gate opens, so the real teardown runs.
 */
async function fifoFixture(label: string) {
  const { createTask, archiveTask, tasks } = await load();
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const { __enqueueTeardownForTest, pendingTeardown } = await import("./orchestrator.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const c = await makeRepo("infra");
  const makeTask = async (title: string, paths: string[]) => {
    const created = await createTask({
      title,
      prompt: "p",
      agent: "claude-code",
      workdir: paths[0]!,
      isolation: "worktree",
      repositories: paths.map((p) => ({ path: p })),
    });
    if ("error" in created) throw new Error(created.error);
    const prepared = await prepareTaskWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    tasks.setRepositories(created.task.id, prepared.repositories!);
    tasks.update(created.task.id, { worktreePath: prepared.worktreePath, column: "done" });
    const row = tasks.get(created.task.id)!;
    return {
      id: row.id,
      workspace: prepared.worktreePath!,
      // The FIFO keys are the stored selected paths, sorted (enqueueTeardownMany).
      keys: row.repositories!.map((r) => r.path).sort(),
    };
  };
  const A = await makeTask(`fifo ${label} A`, [a, b]);
  const B = await makeTask(`fifo ${label} B`, [b, c]);
  const [ka, kb, kc] = tasks.get(A.id)!.repositories!.map((r) => r.path).concat(
    tasks.get(B.id)!.repositories![1]!.path,
  );
  // Precondition the scenarios rely on: the shared key sorts FIRST in both
  // tasks' key sets, so "held only the shared key" exercises each task's
  // first key and "held only the other key" exercises its second.
  expect(A.keys).toEqual([kb!, ka!]);
  expect(B.keys).toEqual([kb!, kc!]);

  const gates = new Map<string, { release: () => void; held: Promise<void> }>();
  const hold = (key: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = __enqueueTeardownForTest(`fifo-gate-${label}-${key}`, key, () => gate);
    gates.set(key, { release, held });
  };
  const open = async (key: string) => {
    const g = gates.get(key)!;
    g.release();
    await g.held;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const settled: string[] = [];
  const archive = async (t: { id: string }, name: string) => {
    const res = await archiveTask(t.id);
    if ("error" in res) throw new Error(res.error);
    void pendingTeardown(t.id).then(() => settled.push(name));
    return res.task.archivedAt!;
  };
  /** Queue a probe behind whatever job is the current tail of `key`; it
   *  records which workspaces were already torn down when it got to run. */
  const probe = (key: string) => {
    let seen: { aGone: boolean; bGone: boolean } | null = null;
    const done = __enqueueTeardownForTest(`fifo-probe-${label}-${key}`, key, async () => {
      seen = { aGone: !existsSync(A.workspace), bGone: !existsSync(B.workspace) };
    }).then(() => seen!);
    return done;
  };
  const releaseAll = () => { for (const g of gates.values()) g.release(); };
  return { a, b, c, A, B, ka: ka!, kb: kb!, kc: kc!, hold, open, archive, probe, settled, releaseAll, pendingTeardown, tasks };
}

test("multi teardown parks on its FIRST key: holding the shared repository parks both tasks, then A runs before B", async () => {
  // T6 acceptance: a multi task's teardown acquires a FIFO key per selected
  // repository, so two tasks that share one source repo never run `git
  // worktree` teardown concurrently in it, and overlapping key SETS
  // ([a,b] vs [b,c]) must not deadlock.
  const f = await fifoFixture("first");
  try {
    for (const key of [f.ka, f.kb, f.kc]) f.hold(key);
    const archivedA = await f.archive(f.A, "A");
    const archivedB = await f.archive(f.B, "B");
    f.tasks.update(f.A.id, { archivedAt: null });
    f.tasks.update(f.B.id, { archivedAt: null });

    // Open every gate except the shared key (each task's first sorted key).
    await f.open(f.ka);
    await f.open(f.kc);
    // A "waits on its last key only" regression would have run (and bailed).
    expect(f.settled).toEqual([]);
    expect(existsSync(f.A.workspace)).toBe(true);
    expect(existsSync(f.B.workspace)).toBe(true);

    f.tasks.update(f.A.id, { archivedAt: archivedA });
    f.tasks.update(f.B.id, { archivedAt: archivedB });
    // Each task must be the tail of EVERY key it holds: a probe queued on a
    // key runs only after the job that last claimed it. A job that claimed
    // only one key would let the probe on its other key run while it is
    // still parked, and that probe would see the workspace present.
    const probes = [f.probe(f.ka), f.probe(f.kb), f.probe(f.kc)];
    await f.open(f.kb);
    const [onA, onShared, onC] = await Promise.all(probes);
    expect(onA?.aGone).toBe(true);
    expect(onShared).toEqual({ aGone: true, bGone: true });
    expect(onC?.bGone).toBe(true);
    await f.pendingTeardown(f.B.id);
    // B's tail on the shared key is A's job, so A always settles first.
    expect(f.settled).toEqual(["A", "B"]);
    expect(existsSync(f.A.workspace)).toBe(false);
    expect(existsSync(f.B.workspace)).toBe(false);
    expect(f.tasks.get(f.A.id)?.archivedAt).toBe(archivedA);
    expect(f.tasks.get(f.B.id)?.archivedAt).toBe(archivedB);
  } finally {
    f.releaseAll();
    cleanup(f.a, f.b, f.c);
  }
});

test("multi teardown parks on its SECOND key too: each task waits for its non-shared repository", async () => {
  // Companion to the test above: a "first sorted key only" regression passes
  // it, because the shared key sorts first in both tasks. Here the shared key
  // is opened first and only each task's second key stays held.
  const f = await fifoFixture("second");
  try {
    // Every key starts held so no job can start before its row's archivedAt
    // is cleared; the shared key is then opened, which frees each task's
    // first key.
    for (const key of [f.ka, f.kb, f.kc]) f.hold(key);
    const archivedA = await f.archive(f.A, "A");
    const archivedB = await f.archive(f.B, "B");
    f.tasks.update(f.A.id, { archivedAt: null });
    f.tasks.update(f.B.id, { archivedAt: null });
    await f.open(f.kb);
    // A's first key (shared) is free; it must still wait for its second.
    expect(f.settled).toEqual([]);
    expect(existsSync(f.A.workspace)).toBe(true);

    // Let A tear down for real, then prove B still waits on ITS second key
    // even though its shared-key tail (A's job) has finished.
    f.tasks.update(f.A.id, { archivedAt: archivedA });
    await f.open(f.ka);
    await f.pendingTeardown(f.A.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.settled).toEqual(["A"]);
    expect(existsSync(f.A.workspace)).toBe(false);
    expect(existsSync(f.B.workspace)).toBe(true);

    f.tasks.update(f.B.id, { archivedAt: archivedB });
    const probes = [f.probe(f.kb), f.probe(f.kc)];
    await f.open(f.kc);
    const [onShared, onC] = await Promise.all(probes);
    expect(onShared).toEqual({ aGone: true, bGone: true });
    expect(onC).toEqual({ aGone: true, bGone: true });
    await f.pendingTeardown(f.B.id);
    expect(f.settled).toEqual(["A", "B"]);
    expect(existsSync(f.B.workspace)).toBe(false);
    expect(f.tasks.get(f.B.id)?.archivedAt).toBe(archivedB);
  } finally {
    f.releaseAll();
    cleanup(f.a, f.b, f.c);
  }
});

test("archiving a multi task with one dirty repository archives it and keeps that checkout intact", async () => {
  // Contract (docs/architecture/multi-repo-tasks.md, Teardown): archive is per
  // repository and best-effort — a dirty checkout is kept with its branch and
  // the workspace, clean ones are detached, and the task is archived anyway.
  const { createTask, archiveTask, tasks } = await load();
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const a = await makeRepo("frontend");
  const b = await makeRepo("backend");
  const created = await createTask({
    title: "dirty archive multi",
    prompt: "p",
    agent: "claude-code",
    workdir: a,
    isolation: "worktree",
    repositories: [{ path: a }, { path: b }],
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  let workspace: string | undefined;
  try {
    const prepared = await prepareTaskWorkdir(created.task);
    if ("error" in prepared) throw new Error(prepared.error);
    workspace = prepared.worktreePath!;
    tasks.setRepositories(id, prepared.repositories!);
    tasks.update(id, { worktreePath: prepared.worktreePath, column: "done" });
    const [clean, dirty] = prepared.repositories!;
    // An uncommitted edit to a tracked file plus an untracked file: neither is
    // on the branch, so detaching this checkout would lose them for good.
    writeFileSync(path.join(dirty!.worktreePath!, "README"), "edited, not committed\n");
    writeFileSync(path.join(dirty!.worktreePath!, "scratch.txt"), "untracked work\n");

    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(archived.task.archivedAt).not.toBeNull();
    expect(tasks.get(id)?.archivedAt).not.toBeNull();
    expect(archived.teardown?.removed).toBe(false);
    expect(archived.teardown?.reason).toBe("dirty");
    expect(archived.teardown?.repositories?.map((r) => [r.name, r.result.removed, r.result.reason ?? null])).toEqual([
      [clean!.name, true, null],
      [dirty!.name, false, "dirty"],
    ]);

    // The clean repository was detached; its branch survives for unarchive.
    expect(existsSync(clean!.worktreePath!)).toBe(false);
    const branchExists = async (repo: string, branch: string) =>
      (await Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: repo, stdout: "pipe", stderr: "pipe",
      }).exited) === 0;
    expect(await branchExists(a, clean!.branch!)).toBe(true);

    // The dirty checkout, its uncommitted changes, its branch and the
    // workspace holding it are all still there.
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(path.join(dirty!.worktreePath!, ".git"))).toBe(true);
    expect(await Bun.file(path.join(dirty!.worktreePath!, "README")).text()).toBe("edited, not committed\n");
    expect(await Bun.file(path.join(dirty!.worktreePath!, "scratch.txt")).text()).toBe("untracked work\n");
    expect(await branchExists(b, dirty!.branch!)).toBe(true);
    const { readCheckoutBranch } = await import("./worktree.ts");
    const live = await readCheckoutBranch(dirty!.worktreePath!);
    expect(live.ok && live.branch).toBe(dirty!.branch);
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
    const [repoA, repoB] = tasks.get(id)!.repositories!;
    const exists = async (repo: string, branch: string) =>
      (await Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: repo, stdout: "pipe", stderr: "pipe",
      }).exited) === 0;
    // Both branches exist before the delete, so their absence afterwards is
    // the delete's doing (each repository's own branch, in its own repo).
    expect(await exists(a, repoA!.branch!)).toBe(true);
    expect(await exists(b, repoB!.branch!)).toBe(true);
    await deleteTask(id);
    expect(existsSync(workspace)).toBe(false);
    expect(tasks.get(id)).toBeNull();
    expect(await exists(a, repoA!.branch!)).toBe(false);
    expect(await exists(b, repoB!.branch!)).toBe(false);
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
