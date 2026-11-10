import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { uniqueRepoSlugs } from "../shared/multi-repo.ts";

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
    worktreePath: wt.worktreePath,
    WORKTREES_DIR: wt.WORKTREES_DIR,
  };
  return mods;
}

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
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
    await new Promise((r) => setTimeout(r, 350));
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
    await new Promise((r) => setTimeout(r, 350));
    tasks.update(id, { column: "done" });
    const archived = await archiveTask(id, { awaitTeardown: true, stopRun: true });
    if ("error" in archived) throw new Error(archived.error);
    const names = uniqueRepoSlugs([a, b]);
    expect(existsSync(path.join(workspace, names[0]!))).toBe(false);
    expect(existsSync(path.join(workspace, names[1]!))).toBe(false);
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
    await new Promise((r) => setTimeout(r, 350));
    await deleteTask(id);
    expect(existsSync(workspace)).toBe(false);
    expect(tasks.get(id)).toBeNull();
    const branch = (await Bun.spawn(["git", "rev-parse", "--verify", "--quiet", "refs/heads/" + created.task.repositories![0]!.branch], { cwd: a, stdout: "pipe", stderr: "pipe" }).exited) !== 0;
    expect(branch).toBe(true);
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
