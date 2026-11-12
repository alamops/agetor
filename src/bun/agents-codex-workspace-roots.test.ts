// codex `auto` sandbox escalation from a multi-repository workspace root
// (issue #291, docs/architecture/harness-codex.md): only the task row's own
// repository checkouts (`codexWorkspaceRepos`), each verified against its
// source repository, may escalate `workspace-write` to `danger-full-access`.
// A checkout an agent plants in the workspace must not.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task, TaskRepository } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE anything imports db.ts (agents.ts → worktree.ts does).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-codex-roots-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const cleanup: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

async function makeRepo(): Promise<string> {
  const repo = tmp("agetor-codex-roots-repo-");
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

const codexHarness = {
  id: "codex", kind: "codex" as const, label: "codex",
  isBuiltin: true, home: null, bin: null, env: {}, enabled: true,
};
const codexOpts = { mode: "auto", model: "gpt-5-codex", effort: "high" } as const;

beforeAll(async () => {
  await import("./db.ts");
});

afterAll(async () => {
  const { WORKTREES_DIR } = await import("./worktree.ts");
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  rmSync(WORKTREES_DIR, { recursive: true, force: true });
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

test("a planted separate-git-dir checkout keeps the sandbox on workspace-write", async () => {
  const { buildCodexCommand } = await import("./agents.ts");
  const repo = await makeRepo();
  const cwd = tmp("agetor-codex-roots-ws-");
  // `git init --separate-git-dir=$PWD/g a` — the shape the old child scan
  // escalated on.
  await git(["init", "-q", `--separate-git-dir=${path.join(cwd, "g")}`, "a"], cwd);

  const bare = await buildCodexCommand(codexHarness, "hi", { ...codexOpts }, cwd);
  expect(bare.cmd).toContain("workspace-write");
  expect(bare.cmd).not.toContain("danger-full-access");

  // Even when the row names the planted directory, it is not a checkout of
  // the repository the entry claims, so it grants nothing.
  const claimed = await buildCodexCommand(
    codexHarness,
    "hi",
    { ...codexOpts, codexWorkspaceRepos: [{ worktreePath: path.join(cwd, "a"), repoPath: repo }] },
    cwd,
  );
  expect(claimed.cmd).toContain("workspace-write");
  expect(claimed.cmd).not.toContain("danger-full-access");
});

test("the task's own verified repository checkouts escalate to danger-full-access", async () => {
  const { prepareTaskWorkdir } = await import("./worktree.ts");
  const { buildCodexCommand } = await import("./agents.ts");
  const a = await makeRepo();
  const b = await makeRepo();
  const entry = (repoPath: string, name: string): TaskRepository => ({
    path: repoPath, name, branch: null, branchSource: "created",
    worktreePath: null, baseRef: null, checkoutBranch: null, prUrl: null,
  });
  const task = {
    id: randomUUID(), title: "Fix the thing", prompt: "p", column: "ready", agent: "codex",
    workdir: a, isolation: "worktree", taskType: "task", branch: "feature/auth",
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, runId: null, hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null, createdAt: 0, updatedAt: 0,
    repositories: [entry(a, "frontend"), entry(b, "backend")],
  } as Task;
  const prepared = await prepareTaskWorkdir(task);
  if ("error" in prepared) throw new Error(prepared.error);

  // Without the row's checkouts the workspace root grants nothing.
  const unwired = await buildCodexCommand(codexHarness, "hi", { ...codexOpts }, prepared.cwd);
  expect(unwired.cmd).toContain("workspace-write");

  const codexWorkspaceRepos = prepared.repositories!.map((r) => ({ worktreePath: r.worktreePath!, repoPath: r.path }));
  const { cmd } = await buildCodexCommand(codexHarness, "hi", { ...codexOpts, codexWorkspaceRepos }, prepared.cwd);
  expect(cmd).toContain("danger-full-access");
  expect(cmd).toContain("approval_policy=never");
  expect(cmd).not.toContain("workspace-write");
});
