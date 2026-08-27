// Orchestrator-level tests for `createTask`/`deleteTask`'s issue-provenance
// handling (docs/plans/new-task-from-git-issue.md, Task A, §4 orchestrator.ts
// ~lines 3589-3680 and ~3964). Mirrors orchestrator-baseref.test.ts's own
// convention: AGETOR_DATA_DIR is set to a mkdtemp dir BEFORE db.ts is
// imported (module-scope, not in beforeAll — db.ts reads it at import time),
// and orchestrator.ts/db.ts are imported dynamically inside each test so that
// ordering is honored regardless of which test file bun runs first.
import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-issue-orch-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// These tests only exercise createTask/deleteTask, never startTask — but the
// fake driver + /bin/echo stand-ins are set anyway, mirroring the sibling
// orchestrator test files' convention, so a future addition that DOES call
// startTask stays hermetic (no dependency on a real claude/tmux binary).
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo whose `origin` is `https://github.com/<owner>/<name>.git`. */
async function makeRepoWithGitHubOrigin(owner: string, name: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-orch-repo-"));
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", `https://github.com/${owner}/${name}.git`], dir);
  return dir;
}

/** A throwaway git repo with no remote configured at all. */
async function makeRepoWithNoRemote(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-orch-repo-noremote-"));
  await git(["init", "-b", "main"], dir);
  return dir;
}

beforeAll(async () => {
  await import("./db.ts");
});

test("createTask stores issueUrl, writes the snapshot file under dataDir/issue-threads/<id>/, and references it exactly once", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { dataDir } = await import("./db.ts");
  const repo = await makeRepoWithGitHubOrigin("o", "r");

  const created = await createTask({
    title: "Issue #7: fix the thing",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r/issues/7",
    issueSnapshot: "# snap",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  expect(task.issueUrl).toBe("https://github.com/o/r/issues/7");

  const snapshotPath = path.join(dataDir, "issue-threads", task.id, "issue-7-thread.md");
  expect(existsSync(snapshotPath)).toBe(true);
  expect(readFileSync(snapshotPath, "utf8")).toBe("# snap");

  const matches = task.references.filter((r) => r.path === snapshotPath);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toEqual({ path: snapshotPath, isDirectory: false });
});

test("createTask rejects a pull-request URL passed as issueUrl", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepoWithGitHubOrigin("o", "r2");

  const res = await createTask({
    title: "not an issue",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r2/pull/7",
  });
  expect("error" in res).toBe(true);
  if ("error" in res) expect(res.error).toBe("issueUrl is not a recognized issue URL");
});

test("createTask rejects an issue URL for a different repo than the workdir's remote, mentioning both repo slugs", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepoWithGitHubOrigin("acme", "widgets");

  const res = await createTask({
    title: "wrong repo",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/other/repo/issues/7",
  });
  expect("error" in res).toBe(true);
  if ("error" in res) {
    expect(res.error).toContain("other/repo");
    expect(res.error).toContain("acme/widgets");
  }
});

test("createTask rejects issueUrl when the workdir has no matching remote at all", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepoWithNoRemote();

  const res = await createTask({
    title: "no remote",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r/issues/7",
  });
  expect("error" in res).toBe(true);
  if ("error" in res) {
    expect(res.error).toContain(repo);
    expect(res.error).toContain("github");
  }
});

test("createTask ignores issueSnapshot when issueUrl is absent — no directory written, no reference added", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { dataDir } = await import("./db.ts");
  const repo = await makeRepoWithGitHubOrigin("o", "r3");

  const created = await createTask({
    title: "snapshot without url",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueSnapshot: "# orphan snapshot",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  expect(task.issueUrl).toBeNull();
  expect(existsSync(path.join(dataDir, "issue-threads", task.id))).toBe(false);
  expect(task.references).toEqual([]);
});

test("deleteTask removes the task's issue-thread snapshot directory", async () => {
  const { createTask, deleteTask } = await import("./orchestrator.ts");
  const { dataDir } = await import("./db.ts");
  const repo = await makeRepoWithGitHubOrigin("o", "r4");

  const created = await createTask({
    title: "to be deleted",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r4/issues/9",
    issueSnapshot: "# snap",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;
  const snapshotDir = path.join(dataDir, "issue-threads", task.id);
  expect(existsSync(snapshotDir)).toBe(true);

  await deleteTask(task.id);
  expect(existsSync(snapshotDir)).toBe(false);
});

test("creating two tasks from the same issue writes separate snapshot files, each referenced exactly once — no duplication or cross-task leakage", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const repo = await makeRepoWithGitHubOrigin("o", "r5");

  const first = await createTask({
    title: "Issue #11: same issue, first task",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r5/issues/11",
    issueSnapshot: "# snap",
  });
  const second = await createTask({
    title: "Issue #11: same issue, second task",
    prompt: "x",
    workdir: repo,
    agent: "claude-code",
    isolation: "none",
    issueUrl: "https://github.com/o/r5/issues/11",
    issueSnapshot: "# snap",
  });
  if ("error" in first) throw new Error(first.error);
  if ("error" in second) throw new Error(second.error);

  const firstRefs = first.task.references.filter((r) => r.path.endsWith("issue-11-thread.md"));
  const secondRefs = second.task.references.filter((r) => r.path.endsWith("issue-11-thread.md"));
  expect(firstRefs).toHaveLength(1);
  expect(secondRefs).toHaveLength(1);
  // Each task owns its own per-id snapshot directory — never colliding, even
  // though both tasks were created from the exact same issue.
  expect(firstRefs[0]!.path).not.toBe(secondRefs[0]!.path);
  expect(first.task.id).not.toBe(second.task.id);
});
