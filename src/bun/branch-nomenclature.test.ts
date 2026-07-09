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

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ projects } = await import("./db.ts"));
});

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
