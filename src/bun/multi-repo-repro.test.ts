import { afterAll, test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueRepoSlugs } from "../shared/multi-repo.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Permanent regression for issue #291's reported behavior: before the fix,
// `POST /tasks` silently dropped `repositories` and materialized exactly one
// worktree. This test fails on that assertion at the pre-fix commit and
// passes once multi-repository tasks are supported.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-multi-repro-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Temp dirs are otherwise never reclaimed: the per-repo fixtures are removed
// in the test's own `finally`, but the data dir (db + worktrees) was not.
// `rmTestDataDir` keeps it when it holds the process-wide live sqlite — `bun
// test` runs every file in one process, so deleting that here would pull the
// database out from under every later test file.
afterAll(() => {
  rmTestDataDir(DATA_DIR);
});
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(name: string): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), `agetor-repro-${name}-`));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), `${name}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

test("a two-repository create keeps both repositories and materializes one worktree each", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { WORKTREES_DIR } = await import("./worktree.ts");
  const a = await makeRepo("a");
  const b = await makeRepo("b");
  const created = await createTask({
    title: "repro",
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
    // The original report: the payload was silently dropped.
    expect(created.task.repositories?.map((r) => r.path)).toEqual([a, b]);
    const res = await startTask(id);
    if ("error" in res) throw new Error(res.error);
    const t = tasks.get(id)!;
    // And only one worktree was materialized.
    const names = uniqueRepoSlugs([a, b]);
    expect(t.repositories?.map((r) => r.worktreePath)).toEqual([
      path.join(workspace, names[0]!),
      path.join(workspace, names[1]!),
    ]);
    expect(existsSync(path.join(workspace, names[0]!, ".git"))).toBe(true);
    expect(existsSync(path.join(workspace, names[1]!, ".git"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
