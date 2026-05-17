import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Important: env must be set before db.ts is imported (top-level dataDir).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-baseref-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-baseref-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "v1\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "v1"], repo);
  return repo;
}

beforeAll(async () => {
  await import("./db.ts");
});

test("createTask pins baseRef to the current HEAD sha when isolation is on", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const created = await createTask({
    title: "first",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.baseRef).toMatch(/^[0-9a-f]{40}$/);
});

test("createTask leaves baseRef null when isolation is off", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const created = await createTask({
    title: "no-isolation",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.baseRef).toBeNull();
});

test("createTask returns an error for an explicit ref that doesn't exist", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const res = await createTask({
    title: "bad-ref",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "worktree",
    baseRef: "feature/never-existed",
  });
  expect("error" in res).toBe(true);
  if ("error" in res) {
    expect(res.error).toContain("feature/never-existed");
    expect(res.error).toContain("not found");
  }
});

test("createTask honors an explicit ref (branch name) by storing its sha", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();

  // Create a second branch pointing at the same commit, then advance main.
  await git(["branch", "stable"], repo);
  writeFileSync(path.join(repo, "drift"), "x\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "drift on main"], repo);

  const onMain = await createTask({
    title: "main-task",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "worktree",
  });
  const onStable = await createTask({
    title: "stable-task",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "worktree",
    baseRef: "stable",
  });
  if ("error" in onMain) throw new Error(onMain.error);
  if ("error" in onStable) throw new Error(onStable.error);

  // Both are valid shas, and they differ — proving the explicit ref was used.
  expect(onMain.task.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(onStable.task.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(onMain.task.baseRef).not.toBe(onStable.task.baseRef);
});
