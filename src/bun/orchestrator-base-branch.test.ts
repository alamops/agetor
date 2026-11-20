// `createTask` records the base branch NAME beside the pinned sha
// (docs/plans/create-all-prs-title-and-base.md T12).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-orch-base-branch-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

/** A repo with main plus `develop`, with remote-tracking refs for both (no real remote). */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-orch-base-branch-"));
  dirs.push(dir);
  await git(["init", "-q", "-b", "main"], dir);
  writeFileSync(path.join(dir, "f"), "1\n");
  await git(["add", "."], dir);
  await git(["commit", "-q", "-m", "c1"], dir);
  await git(["branch", "develop"], dir);
  await git(["update-ref", "refs/remotes/origin/main", "main"], dir);
  return dir;
}

const base = { title: "t", prompt: "p", agent: "claude-code" } as const;

test("a single-repo task records the requested branch name beside the pinned sha", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const created = await createTask({ ...base, workdir: repo, isolation: "worktree", baseRef: "develop" });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.baseBranch).toBe("develop");
  expect(created.task.baseRef).toBe(await git(["rev-parse", "develop"], repo));
  expect(created.task.prs).toEqual([]);
  expect(created.task.repositories?.[0]?.baseBranch).toBe("develop");
});

test("HEAD records the checked-out branch when it has a remote-tracking ref", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  const created = await createTask({ ...base, workdir: repo, isolation: "worktree" });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.baseBranch).toBe("main");
});

test("a tag, existingBranch, isolation none and a non-git directory record null", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepo();
  await git(["tag", "v1"], repo);
  const tag = await createTask({ ...base, workdir: repo, isolation: "worktree", baseRef: "v1" });
  if ("error" in tag) throw new Error(tag.error);
  expect(tag.task.baseBranch).toBeNull();
  expect(tag.task.baseRef).toMatch(/^[0-9a-f]{40}$/);

  const none = await createTask({ ...base, workdir: repo, isolation: "none", baseRef: "develop" });
  if ("error" in none) throw new Error(none.error);
  expect(none.task.baseBranch).toBeNull();

  const plain = mkdtempSync(path.join(tmpdir(), "agetor-orch-base-branch-plain-"));
  dirs.push(plain);
  const nongit = await createTask({ ...base, workdir: plain, isolation: "none" });
  if ("error" in nongit) throw new Error(nongit.error);
  expect(nongit.task.baseBranch).toBeNull();
});

test("a multi-repo task records each entry's own base, then the task-level default, then HEAD", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const a = await makeRepo();
  const b = await makeRepo();
  const created = await createTask({
    ...base,
    workdir: a,
    isolation: "worktree",
    baseRef: "develop",
    repositories: [{ path: a }, { path: b, baseRef: "main" }],
  });
  if ("error" in created) throw new Error(created.error);
  expect(created.task.multiRepo).toBe(true);
  expect(created.task.baseBranch).toBeNull();
  expect(created.task.repositories?.map((r) => r.baseBranch)).toEqual(["develop", "main"]);
  expect(created.task.repositories?.every((r) => (r.prs ?? []).length === 0)).toBe(true);
  // It survives a re-read from the stored row.
  const { tasks } = await import("./db.ts");
  expect(tasks.get(created.task.id)?.repositories?.map((r) => r.baseBranch)).toEqual(["develop", "main"]);
});
