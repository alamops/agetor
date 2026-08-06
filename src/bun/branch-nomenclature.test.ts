import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BranchNamingConfig } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE importing db.ts (top-level dataDir setup).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-branch-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-branch-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

let createTask: typeof import("./orchestrator.ts").createTask;
let projects: typeof import("./db.ts").projects;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ projects, tasks } = await import("./db.ts"));
});

function countTasksFor(workdir: string): number {
  return tasks.list().filter((t) => t.workdir === workdir).length;
}

test("createTask composes the branch from the project's nomenclature by task type", async () => {
  const repo = await makeRepo();
  projects.upsert(repo, "repo");
  const cfg: BranchNamingConfig = {
    includeSlug: true,
    rules: { task: { prefix: "feature/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
  };
  projects.setBranchConfig(repo, cfg);

  const bug = await createTask({ title: "Broken nav bar", prompt: "p", workdir: repo, isolation: "worktree", taskType: "bug" });
  if ("error" in bug) throw new Error(bug.error);
  expect(bug.task.branch).toBe("fix/broken-nav-bar");

  const spike = await createTask({ title: "Try SSE", prompt: "p", workdir: repo, isolation: "worktree", taskType: "spike" });
  if ("error" in spike) throw new Error(spike.error);
  expect(spike.task.branch).toBe("spike/try-sse");
});

test("createTask falls back to built-in defaults when the project has no config", async () => {
  const repo = await makeRepo();
  // Not registered / no config → DEFAULT_BRANCH_CONFIG (task → feature/).
  const t = await createTask({ title: "Add login", prompt: "p", workdir: repo, isolation: "worktree", taskType: "task" });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBe("feature/add-login");
});

test("createTask honors an explicit valid branch override", async () => {
  const repo = await makeRepo();
  const t = await createTask({ title: "Anything", prompt: "p", workdir: repo, isolation: "worktree", taskType: "task", branch: "custom/my-branch" });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBe("custom/my-branch");
});

test("createTask rejects an illegal branch override", async () => {
  const repo = await makeRepo();
  const t = await createTask({ title: "Anything", prompt: "p", workdir: repo, isolation: "worktree", taskType: "task", branch: "bad branch/" });
  expect("error" in t).toBe(true);
});

test("createTask makes the branch unique across same-title/type tasks", async () => {
  const repo = await makeRepo();
  projects.upsert(repo, "repo");
  const a = await createTask({ title: "Same title", prompt: "p", workdir: repo, isolation: "worktree", taskType: "task" });
  const b = await createTask({ title: "Same title", prompt: "p", workdir: repo, isolation: "worktree", taskType: "task" });
  if ("error" in a) throw new Error(a.error);
  if ("error" in b) throw new Error(b.error);
  expect(a.task.branch).toBe("feature/same-title");
  expect(b.task.branch).toBe("feature/same-title-2");
  expect(a.task.branch).not.toBe(b.task.branch);
});

test("isolation:none tasks get no branch", async () => {
  const repo = await makeRepo();
  const t = await createTask({ title: "No worktree", prompt: "p", workdir: repo, isolation: "none", taskType: "task" });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBeNull();
});

test("createTask resolves <slug> in a branch override template", async () => {
  const repo = await makeRepo();
  const t = await createTask({
    title: "My Cool Task",
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    branch: "feature/<slug>",
  });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBe("feature/my-cool-task");
});

test("createTask resolves <project_name> and <type> in a branch override template", async () => {
  const repo = await makeRepo();
  const projectFolderSlug = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const t = await createTask({
    title: "Whatever",
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "bug",
    branch: "<project_name>/<type>",
  });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBe(`${projectFolderSlug}/bug`);
});

test("createTask resolves <token> in a branch override template to a 6-char lowercase token from the task id", async () => {
  const repo = await makeRepo();
  const t = await createTask({
    title: "Whatever",
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    branch: "feature/<token>",
  });
  if ("error" in t) throw new Error(t.error);
  const branch = t.task.branch;
  if (!branch) throw new Error("expected a branch");
  expect(branch).toMatch(/^feature\/[0-9a-z]{6}$/);
  const expectedToken = t.task.id.replace(/-/g, "").slice(0, 6);
  expect(branch).toBe(`feature/${expectedToken}`);
});

test("createTask passes a tag-free branch override through verbatim (back-compat)", async () => {
  const repo = await makeRepo();
  const t = await createTask({
    title: "Anything",
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    branch: "custom/no-tags-here",
  });
  if ("error" in t) throw new Error(t.error);
  expect(t.task.branch).toBe("custom/no-tags-here");
});

test("createTask rejects a branch override that renders invalid", async () => {
  const repo = await makeRepo();
  const before = countTasksFor(repo);
  const t = await createTask({
    title: "Whatever",
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    // <slug> resolves fine, but the trailing "." after it is illegal.
    branch: "feature/<slug>.",
  });
  expect("error" in t).toBe(true);
  expect(countTasksFor(repo)).toBe(before);
});

test("createTask applies uniqueness AFTER rendering a templated override", async () => {
  const repo = await makeRepo();
  const title = "Templated Duplicate Title";
  const a = await createTask({
    title,
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    branch: "feature/<slug>",
  });
  const b = await createTask({
    title,
    prompt: "p",
    workdir: repo,
    isolation: "worktree",
    taskType: "task",
    branch: "feature/<slug>",
  });
  if ("error" in a) throw new Error(a.error);
  if ("error" in b) throw new Error(b.error);
  expect(a.task.branch).toBe("feature/templated-duplicate-title");
  expect(b.task.branch).toBe("feature/templated-duplicate-title-2");
});
