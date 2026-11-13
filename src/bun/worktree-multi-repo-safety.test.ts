// Safety contracts of the multi-repository worktree engine (issue #291,
// docs/architecture/multi-repo-tasks.md): what may be granted to a codex
// sandbox, what prepare may clear or adopt, per-task serialization, teardown
// confinement, and the D25 routing of the workspace-root scratch cleanup.
// Every repository here is a temp git repo; nothing touches this checkout.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task, TaskRepository } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE anything imports db.ts (worktree.ts does).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-wt-safety-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const cleanup: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

async function run(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  return { code: await proc.exited, out };
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return r.out;
}

async function makeRepo(prefix = "agetor-safety-repo-"): Promise<string> {
  const repo = tmp(prefix);
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

function entry(repoPath: string, name: string, extra: Partial<TaskRepository> = {}): TaskRepository {
  return {
    path: repoPath,
    name,
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    checkoutBranch: null,
    prUrl: null,
    ...extra,
  };
}

function multiTask(repos: TaskRepository[], overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "Fix the thing",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    workdir: repos[0]!.path,
    isolation: "worktree",
    taskType: "task",
    branch: "feature/auth",
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    repositories: repos,
    ...overrides,
  };
}

/** Put a directory on PATH holding a `git` wrapper; returns a restore fn. */
function shimGit(body: (realGit: string) => string): { dir: string; restore: () => void } {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git not on PATH");
  const dir = tmp("agetor-safety-gitshim-");
  const shim = path.join(dir, "git");
  writeFileSync(shim, `#!/bin/sh\n${body(realGit)}\n`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  return {
    dir,
    restore: () => {
      process.env.PATH = saved;
    },
  };
}

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

// ── M1: codex writable roots come from the task row, never from the disk ──

describe("gitWritableRoots (M1)", () => {
  test("a non-git cwd with a planted separate-git-dir child grants nothing", async () => {
    const { gitWritableRoots } = await import("./worktree.ts");
    const cwd = tmp("agetor-safety-plant-");
    await git(["init", "-q", `--separate-git-dir=${path.join(cwd, "g")}`, "a"], cwd);
    // Before the fix the child scan returned `<cwd>/g` (outside the child),
    // which escalated codex `auto` to danger-full-access.
    expect(await gitWritableRoots(cwd)).toEqual([]);
    expect(await gitWritableRoots(cwd, [])).toEqual([]);
  });

  test("an isolation:none folder holding a worktree of some repository grants nothing", async () => {
    const { gitWritableRoots } = await import("./worktree.ts");
    const repo = await makeRepo();
    const folder = tmp("agetor-safety-folder-");
    await git(["worktree", "add", "-q", "-b", "side", path.join(folder, "child")], repo);
    expect(await gitWritableRoots(folder)).toEqual([]);
  });

  test("a workspace entry whose checkout belongs to a different repository is excluded", async () => {
    const { gitWritableRoots } = await import("./worktree.ts");
    const claimed = await makeRepo();
    const other = await makeRepo();
    const cwd = tmp("agetor-safety-ws-");
    // The checkout is a worktree of `other`, but the row says `claimed`.
    await git(["worktree", "add", "-q", "-b", "x", path.join(cwd, "frontend")], other);
    await git(["init", "-q", `--separate-git-dir=${path.join(cwd, "g")}`, "planted"], cwd);
    const roots = await gitWritableRoots(cwd, [
      { worktreePath: path.join(cwd, "frontend"), repoPath: claimed },
      { worktreePath: path.join(cwd, "planted"), repoPath: claimed },
    ]);
    expect(roots).toEqual([]);
  });

  test("an entry outside the cwd is never granted, even when it is genuine", async () => {
    const { gitWritableRoots } = await import("./worktree.ts");
    const repo = await makeRepo();
    const elsewhere = tmp("agetor-safety-elsewhere-");
    const wt = path.join(elsewhere, "wt");
    await git(["worktree", "add", "-q", "-b", "y", wt], repo);
    const cwd = tmp("agetor-safety-ws2-");
    expect(await gitWritableRoots(cwd, [{ worktreePath: wt, repoPath: repo }])).toEqual([]);
  });

  test("genuine multi-repository checkouts grant exactly their source repositories' common dirs", async () => {
    const { gitWritableRoots, prepareTaskWorkdir } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const prepared = await prepareTaskWorkdir(multiTask([entry(a, "frontend"), entry(b, "backend")]));
    if ("error" in prepared) throw new Error(prepared.error);
    const workspaceRepos = prepared.repositories!.map((r) => ({ worktreePath: r.worktreePath!, repoPath: r.path }));
    const roots = await gitWritableRoots(prepared.cwd, workspaceRepos);
    expect(new Set(roots)).toEqual(new Set([path.join(a, ".git"), path.join(b, ".git")]));
  });
});

// ── M2: prepare never clears a directory that holds a .git it can't prove ──

describe("prepareTaskWorkdir reuse guard (M2)", () => {
  test("adopts an unrecorded checkout when the selected repository is itself a linked worktree", async () => {
    const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
    const main = await makeRepo();
    const linked = path.join(tmp("agetor-safety-linkedparent-"), "linked");
    await git(["worktree", "add", "-q", "-b", "selected", linked], main);
    const b = await makeRepo();
    const task = multiTask([entry(linked, "frontend"), entry(b, "backend")]);
    const frontend = path.join(WORKTREES_DIR, task.id, "frontend");
    mkdirSync(path.dirname(frontend), { recursive: true });
    // Its `.git` points at `<main>/.git/worktrees/frontend`, not at `linked`:
    // the old pointer-path parse said "not ours" and cleared it.
    await git(["worktree", "add", "-q", "-b", "feature/auth", frontend], linked);
    writeFileSync(path.join(frontend, "wip.txt"), "uncommitted\n");

    const r = await prepareTaskWorkdir(task);
    if ("error" in r) throw new Error(r.error);
    expect(readFileSync(path.join(frontend, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(r.repositories?.[0]?.worktreePath).toBe(frontend);
    expect(r.note).toContain(`reusing worktree at ${frontend}`);
  });

  test("adopts an unrecorded checkout when the selected repository is a worktree of a bare repository", async () => {
    const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
    const seed = await makeRepo();
    const bare = tmp("agetor-safety-bare-");
    await git(["init", "-q", "--bare", "-b", "main", bare], bare);
    await git(["push", "-q", bare, "main"], seed);
    const selected = path.join(tmp("agetor-safety-bareparent-"), "work");
    await git(["worktree", "add", "-q", selected, "main"], bare);
    const b = await makeRepo();
    const task = multiTask([entry(selected, "frontend"), entry(b, "backend")]);
    const frontend = path.join(WORKTREES_DIR, task.id, "frontend");
    mkdirSync(path.dirname(frontend), { recursive: true });
    // Pointer is `<bare>/worktrees/frontend` — no `.git/worktrees/` marker.
    await git(["worktree", "add", "-q", "-b", "feature/auth", frontend], selected);
    writeFileSync(path.join(frontend, "wip.txt"), "uncommitted\n");

    const r = await prepareTaskWorkdir(task);
    if ("error" in r) throw new Error(r.error);
    expect(readFileSync(path.join(frontend, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(r.repositories?.[0]?.worktreePath).toBe(frontend);
  });

  test("a recorded checkout whose branch read fails is left untouched and the prepare errors", async () => {
    const { prepareTaskWorkdir } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const task = multiTask([entry(a, "frontend"), entry(b, "backend")]);
    const first = await prepareTaskWorkdir(task);
    if ("error" in first) throw new Error(first.error);
    const frontend = first.repositories![0]!.worktreePath!;
    writeFileSync(path.join(frontend, "wip.txt"), "uncommitted\n");
    // Break the pointer: every git read in the checkout now fails.
    writeFileSync(path.join(frontend, ".git"), "gitdir: /nonexistent/agetor-safety\n");

    const recorded = { ...task, repositories: first.repositories, worktreePath: first.worktreePath, workdir: first.cwd };
    const r = await prepareTaskWorkdir(recorded);
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("frontend");
    expect(r.error).toContain("left untouched");
    expect(readFileSync(path.join(frontend, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(path.join(frontend, ".git"), "utf8")).toContain("/nonexistent/agetor-safety");
  });

  test("a checkout of some OTHER repository at the target is refused, not cleared", async () => {
    const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const stranger = await makeRepo();
    const task = multiTask([entry(a, "frontend"), entry(b, "backend")]);
    const frontend = path.join(WORKTREES_DIR, task.id, "frontend");
    mkdirSync(path.dirname(frontend), { recursive: true });
    await git(["worktree", "add", "-q", "-b", "elsewhere", frontend], stranger);
    writeFileSync(path.join(frontend, "wip.txt"), "theirs\n");
    const r = await prepareTaskWorkdir(task);
    expect("error" in r).toBe(true);
    expect(readFileSync(path.join(frontend, "wip.txt"), "utf8")).toBe("theirs\n");
  });
});

// ── M3: overlapping prepares of one task are serialized ──

test("an overlapping failing prepare cannot roll back the checkout a concurrent prepare returned (M3)", async () => {
  const { prepareTaskWorkdir, readCheckoutBranch, WORKTREES_DIR } = await import("./worktree.ts");
  const a = await makeRepo();
  const b = await makeRepo();
  const slow = await makeRepo();
  const good = multiTask([entry(a, "frontend"), entry(b, "backend")]);
  // Same task id, a snapshot whose backend fails — slowly: every git call in
  // `slow` sleeps, and its pinned base does not exist.
  const bad: Task = {
    ...good,
    repositories: [entry(a, "frontend"), entry(slow, "backend", { baseRef: "0".repeat(40) })],
  };
  const shim = shimGit((realGit) => [
    `case "$(pwd -P)" in "${slow}"*) sleep 0.4 ;; esac`,
    `exec "${realGit}" "$@"`,
  ].join("\n"));
  try {
    const pBad = prepareTaskWorkdir(bad);
    // Let the failing prepare materialize the frontend first, so the second
    // prepare finds (and, unserialized, adopts) it while the failing one is
    // still working on its backend.
    const frontendGit = path.join(WORKTREES_DIR, good.id, "frontend", ".git");
    for (let i = 0; i < 200 && !existsSync(frontendGit); i++) await Bun.sleep(10);
    expect(existsSync(frontendGit)).toBe(true);
    const pGood = prepareTaskWorkdir(good);
    const [rBad, rGood] = await Promise.all([pBad, pGood]);
    expect("error" in rBad).toBe(true);
    if ("error" in rGood) throw new Error(rGood.error);
    const fe = rGood.repositories![0]!;
    expect(existsSync(path.join(fe.worktreePath!, ".git"))).toBe(true);
    expect(await readCheckoutBranch(fe.worktreePath!)).toEqual({ ok: true, branch: fe.branch });
    expect(await branchExists(a, fe.branch!)).toBe(true);
  } finally {
    shim.restore();
  }
}, 30_000);

// ── N9: a throwing worker still triggers the rollback ──

test("a worker that throws becomes a failed repository and the others are rolled back (N9)", async () => {
  const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
  const a = await makeRepo();
  const b = await makeRepo();
  // A malformed row: `path.join(workspace, undefined)` throws inside the worker.
  const task = multiTask([entry(a, "frontend"), entry(b, undefined as unknown as string)]);
  const r = await prepareTaskWorkdir(task);
  expect("error" in r).toBe(true);
  expect(existsSync(path.join(WORKTREES_DIR, task.id, "frontend"))).toBe(false);
  expect(await branchExists(a, "feature/auth")).toBe(false);
});

// ── S1: a workdir pointing at another task's workspace is not adopted ──

test("workspacePathFor ignores another task's workspace (S1)", async () => {
  const { workspacePathFor, worktreePath, WORKTREES_DIR } = await import("./worktree.ts");
  const victim = randomUUID();
  const other = path.join(WORKTREES_DIR, victim);
  const t = multiTask([entry("/x/a", "a"), entry("/x/b", "b")], { workdir: other, worktreePath: other });
  expect(workspacePathFor(t)).toBe(worktreePath(t));
  // Its own folder and its pipeline parent's are still honored.
  const own = path.join(WORKTREES_DIR, t.id);
  expect(workspacePathFor({ ...t, workdir: own, worktreePath: own })).toBe(own);
  expect(workspacePathFor({ ...t, pipelineParentId: victim })).toBe(other);
});

// ── S3: teardown and adoption of checkouts the row never recorded ──

describe("unrecorded checkouts (S3)", () => {
  test("removeWorktree tears down a materialized checkout whose path was never persisted", async () => {
    const { prepareTaskWorkdir, removeWorktree, WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const stranger = await makeRepo();
    const task = multiTask([entry(a, "frontend"), entry(b, "backend"), entry(stranger, "docs")]);
    const prepared = await prepareTaskWorkdir({ ...task, repositories: task.repositories!.slice(0, 2) });
    if ("error" in prepared) throw new Error(prepared.error);
    const workspace = path.join(WORKTREES_DIR, task.id);
    // `docs` holds a checkout of a different repository than its entry names:
    // the fallback must not touch it.
    const docs = path.join(workspace, "docs");
    await git(["worktree", "add", "-q", "-b", "keep", docs], b);

    // The row still has null worktreePaths (the prepare was never recorded).
    await removeWorktree(task);
    expect(existsSync(path.join(workspace, "frontend"))).toBe(false);
    expect(existsSync(path.join(workspace, "backend"))).toBe(false);
    expect(existsSync(path.join(docs, ".git"))).toBe(true);
  });

  test("detachWorktree also finds the unrecorded checkout", async () => {
    const { prepareTaskWorkdir, detachWorktree, WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const task = multiTask([entry(a, "frontend"), entry(b, "backend")]);
    const prepared = await prepareTaskWorkdir(task);
    if ("error" in prepared) throw new Error(prepared.error);
    const res = await detachWorktree(task);
    expect(res.removed).toBe(true);
    expect(existsSync(path.join(WORKTREES_DIR, task.id))).toBe(false);
    expect(await branchExists(a, "feature/auth")).toBe(true);
  });

  test("adopting an unrecorded checkout records the branch it is actually on", async () => {
    const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const task = multiTask([entry(a, "frontend", { branch: "feature/auth" }), entry(b, "backend")]);
    const frontend = path.join(WORKTREES_DIR, task.id, "frontend");
    mkdirSync(path.dirname(frontend), { recursive: true });
    // An earlier, unrecorded prepare hit a collision and minted `-2`.
    await git(["worktree", "add", "-q", "-b", "feature/auth-2", frontend], a);
    const r = await prepareTaskWorkdir(task);
    if ("error" in r) throw new Error(r.error);
    expect(r.repositories?.[0]?.branch).toBe("feature/auth-2");
    expect(r.repositories?.[0]?.checkoutBranch).toBe("feature/auth-2");
  });
});

// ── S4: per-repository base-ref pinning is bounded ──

test("pinMissingRepositoryBaseRefs runs at most MULTI_REPO_CONCURRENCY git calls at once (S4)", async () => {
  const { pinMissingRepositoryBaseRefs, MULTI_REPO_CONCURRENCY } = await import("./worktree.ts");
  const repos: TaskRepository[] = [];
  for (let i = 0; i < 8; i++) repos.push(entry(await makeRepo(), `r${i}`));
  // Each git call registers itself in `inflight/` for 0.3 s and logs how many
  // calls were in flight when it started.
  const shim = shimGit((realGit) => [
    'd="$(dirname "$0")/inflight"; mkdir -p "$d"',
    'f="$d/$$"; : > "$f"',
    'ls "$d" | wc -l | tr -d " " >> "$(dirname "$0")/counts.log"',
    "sleep 0.3",
    `"${realGit}" "$@"; rc=$?`,
    'rm -f "$f"',
    "exit $rc",
  ].join("\n"));
  try {
    const pinned = await pinMissingRepositoryBaseRefs(repos);
    expect(pinned.every((r) => /^[0-9a-f]{40}$/.test(r.baseRef ?? ""))).toBe(true);
  } finally {
    shim.restore();
  }
  const counts = readFileSync(path.join(shim.dir, "counts.log"), "utf8").split("\n").filter(Boolean).map(Number);
  expect(counts.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...counts)).toBeLessThanOrEqual(MULTI_REPO_CONCURRENCY);
});

// ── S7: per-repository warnings and unknown reads ──

describe("prepare result labelling (S7)", () => {
  test("each warning is prefixed with its repository name", async () => {
    const { prepareTaskWorkdir, WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    await git(["branch", "feature/auth"], a);
    const id = randomUUID();
    const workspace = path.join(WORKTREES_DIR, id);
    // Frontend materialized before (recorded path, now gone) on a branch that
    // no longer exists → the re-attach warns.
    const task = multiTask([
      entry(a, "frontend", {
        branch: "feature/auth",
        worktreePath: path.join(workspace, "frontend"),
        checkoutBranch: "gone-branch",
      }),
      entry(b, "backend"),
    ], { id, workdir: workspace, worktreePath: workspace });
    const r = await prepareTaskWorkdir(task);
    if ("error" in r) throw new Error(r.error);
    expect(r.warning).toBe("frontend: recorded checkout gone-branch no longer exists — restored on feature/auth");
  });

  test("a repository whose live read failed is reported in unknownCheckouts", async () => {
    const { prepareTaskWorkdir } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const task = multiTask([entry(a, "frontend"), entry(b, "backend")]);
    const first = await prepareTaskWorkdir(task);
    if ("error" in first) throw new Error(first.error);
    const recorded: Task = {
      ...task,
      workdir: first.cwd,
      worktreePath: first.worktreePath,
      repositories: first.repositories!.map((r) => ({ ...r, checkoutBranch: "stale-snapshot" })),
    };
    // Only `symbolic-ref` (the branch read) fails; everything else works.
    const shim = shimGit((realGit) => [
      'if [ "$1" = symbolic-ref ]; then echo "fatal: simulated failure" >&2; exit 128; fi',
      `exec "${realGit}" "$@"`,
    ].join("\n"));
    let r: Awaited<ReturnType<typeof prepareTaskWorkdir>>;
    try {
      r = await prepareTaskWorkdir(recorded);
    } finally {
      shim.restore();
    }
    if ("error" in r) throw new Error(r.error);
    expect(r.unknownCheckouts).toEqual(["frontend", "backend"]);
    // Single-repository-style reuse: the checkout survives untouched.
    expect(existsSync(path.join(first.repositories![0]!.worktreePath!, "README"))).toBe(true);
  });
});

// ── S8: teardown confinement on stored paths ──

describe("teardown confinement (S8)", () => {
  async function victimSetup() {
    const { WORKTREES_DIR } = await import("./worktree.ts");
    const a = await makeRepo();
    const b = await makeRepo();
    const victimDir = path.join(WORKTREES_DIR, randomUUID());
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(path.join(victimDir, "precious.txt"), "keep\n");
    const id = randomUUID();
    const workspace = path.join(WORKTREES_DIR, id);
    mkdirSync(workspace, { recursive: true });
    // A `..`-bearing path that still starts with `<WORKTREES_DIR>/`.
    const sneaky = `${workspace}/../${path.basename(victimDir)}`;
    const task = multiTask([
      entry(a, "frontend", { worktreePath: sneaky, branch: "feature/auth" }),
      entry(b, "backend", { worktreePath: path.join(WORKTREES_DIR, randomUUID(), "backend") }),
    ], { id, workdir: workspace, worktreePath: workspace });
    return { task, victimDir };
  }

  test("removeWorktree refuses a stored path that leaves the task's workspace", async () => {
    const { removeWorktree } = await import("./worktree.ts");
    const { task, victimDir } = await victimSetup();
    await removeWorktree(task);
    expect(readFileSync(path.join(victimDir, "precious.txt"), "utf8")).toBe("keep\n");
  });

  test("detachWorktree (forced) refuses it too", async () => {
    const { detachWorktree } = await import("./worktree.ts");
    const { task, victimDir } = await victimSetup();
    const res = await detachWorktree(task, { force: true });
    expect(res.removed).toBe(false);
    expect(res.repositories?.find((r) => r.name === "frontend")?.result).toEqual({ removed: false, reason: "failed" });
    expect(readFileSync(path.join(victimDir, "precious.txt"), "utf8")).toBe("keep\n");
  });

  test("isOwnedRepositoryCheckoutPath accepts only the exact owned shape", async () => {
    const { isOwnedRepositoryCheckoutPath, WORKTREES_DIR } = await import("./worktree.ts");
    const t = { id: "task-1", pipelineParentId: "parent-1" };
    expect(isOwnedRepositoryCheckoutPath(t, "fe", path.join(WORKTREES_DIR, "task-1", "fe"))).toBe(true);
    expect(isOwnedRepositoryCheckoutPath(t, "fe", path.join(WORKTREES_DIR, "parent-1", "fe"))).toBe(true);
    expect(isOwnedRepositoryCheckoutPath(t, "fe", path.join(WORKTREES_DIR, "other", "fe"))).toBe(false);
    expect(isOwnedRepositoryCheckoutPath(t, "fe", path.join(WORKTREES_DIR, "task-1", "be"))).toBe(false);
    expect(isOwnedRepositoryCheckoutPath(t, "fe", `${WORKTREES_DIR}/task-1/x/../fe`)).toBe(false);
    expect(isOwnedRepositoryCheckoutPath(t, "fe", path.join(WORKTREES_DIR, "task-1", "fe", "deeper"))).toBe(false);
    expect(isOwnedRepositoryCheckoutPath(t, "..", path.join(WORKTREES_DIR, "task-1"))).toBe(false);
  });
});

// ── M6: workspace-root scratch cleanup goes through task-dir-fs (D25) ──

describe("workspace scratch cleanup (M6)", () => {
  let stubBin = "";
  let stubLog = "";
  const savedBin = process.env.AGETOR_DISCLAIM_BIN;
  let savedSwitch = true;

  beforeAll(async () => {
    const { getDisclaimSwitch } = await import("./disclaim.ts");
    savedSwitch = getDisclaimSwitch();
    const dir = tmp("agetor-safety-disclaim-");
    stubBin = path.join(dir, "disclaim-stub.sh");
    stubLog = path.join(dir, "disclaim-stub.log");
    writeFileSync(stubBin, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${stubLog}'\nexec "$@"\n`, { mode: 0o755 });
    chmodSync(stubBin, 0o755);
  });

  afterEach(async () => {
    const { setDisclaimSwitch } = await import("./disclaim.ts");
    if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
    else process.env.AGETOR_DISCLAIM_BIN = savedBin;
    setDisclaimSwitch(savedSwitch);
  });

  async function useMode(mode: "in-process" | "disclaimed"): Promise<void> {
    const { disclaimEnabled, setDisclaimSwitch } = await import("./disclaim.ts");
    if (mode === "disclaimed") {
      process.env.AGETOR_DISCLAIM_BIN = stubBin;
      setDisclaimSwitch(true);
      expect(disclaimEnabled()).toBe(true);
      writeFileSync(stubLog, "");
    } else {
      setDisclaimSwitch(false);
      expect(disclaimEnabled()).toBe(false);
    }
  }

  function stubLines(): string[] {
    return existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean) : [];
  }

  test("with the switch on, both the check and the delete run in a disclaimed child", async () => {
    const { removeWorkspaceIfEmpty, workspaceHasOnlyAgetorScratch } = await import("./worktree.ts");
    await useMode("disclaimed");
    const ws = tmp("agetor-safety-wsd-");
    mkdirSync(path.join(ws, ".claude"));
    writeFileSync(path.join(ws, ".claude", "settings.local.json"), "{}\n");
    expect(await workspaceHasOnlyAgetorScratch(ws)).toBe(true);
    expect(stubLines()).toEqual(["/bin/sh"]);
    await removeWorkspaceIfEmpty(ws);
    expect(stubLines()).toEqual(["/bin/sh", "/bin/sh"]);
    expect(existsSync(ws)).toBe(false);
  });

  for (const mode of ["in-process", "disclaimed"] as const) {
    describe(mode, () => {
      test("a symlinked .claude never redirects the delete outside the workspace", async () => {
        const { removeWorkspaceIfEmpty, workspaceHasOnlyAgetorScratch } = await import("./worktree.ts");
        await useMode(mode);
        const outside = tmp("agetor-safety-outside-");
        writeFileSync(path.join(outside, "settings.local.json"), "user's own\n");
        const ws = tmp("agetor-safety-wss-");
        symlinkSync(outside, path.join(ws, ".claude"));
        expect(await workspaceHasOnlyAgetorScratch(ws)).toBe(false);
        await removeWorkspaceIfEmpty(ws);
        expect(readFileSync(path.join(outside, "settings.local.json"), "utf8")).toBe("user's own\n");
        expect(existsSync(ws)).toBe(true);
      });

      test("a symlinked workspace root is neither read through nor removed", async () => {
        const { removeWorkspaceIfEmpty, workspaceHasOnlyAgetorScratch } = await import("./worktree.ts");
        await useMode(mode);
        const outside = tmp("agetor-safety-outside2-");
        const parent = tmp("agetor-safety-wsparent-");
        const ws = path.join(parent, "ws");
        symlinkSync(outside, ws);
        expect(await workspaceHasOnlyAgetorScratch(ws)).toBe(false);
        await removeWorkspaceIfEmpty(ws);
        expect(existsSync(outside)).toBe(true);
      });

      test("a symlinked settings.local.json keeps the workspace and its target", async () => {
        const { removeWorkspaceIfEmpty } = await import("./worktree.ts");
        await useMode(mode);
        const outside = tmp("agetor-safety-outside3-");
        const target = path.join(outside, "real.json");
        writeFileSync(target, "user's own\n");
        const ws = tmp("agetor-safety-wsl-");
        mkdirSync(path.join(ws, ".claude"));
        symlinkSync(target, path.join(ws, ".claude", "settings.local.json"));
        await removeWorkspaceIfEmpty(ws);
        expect(readFileSync(target, "utf8")).toBe("user's own\n");
        expect(existsSync(ws)).toBe(true);
      });

      test("scratch-only and empty workspaces are removed; any other content keeps them", async () => {
        const { removeWorkspaceIfEmpty, workspaceHasOnlyAgetorScratch } = await import("./worktree.ts");
        await useMode(mode);
        const empty = tmp("agetor-safety-empty-");
        expect(await workspaceHasOnlyAgetorScratch(empty)).toBe(true);
        await removeWorkspaceIfEmpty(empty);
        expect(existsSync(empty)).toBe(false);

        const scratch = tmp("agetor-safety-scratch-");
        mkdirSync(path.join(scratch, ".claude"));
        writeFileSync(path.join(scratch, ".claude", "settings.local.json"), "{}\n");
        await removeWorkspaceIfEmpty(scratch);
        expect(existsSync(scratch)).toBe(false);

        const kept = tmp("agetor-safety-kept-");
        mkdirSync(path.join(kept, ".claude"));
        writeFileSync(path.join(kept, ".claude", "settings.local.json"), "{}\n");
        writeFileSync(path.join(kept, ".claude", "history.jsonl"), "{}\n");
        expect(await workspaceHasOnlyAgetorScratch(kept)).toBe(false);
        await removeWorkspaceIfEmpty(kept);
        expect(existsSync(path.join(kept, ".claude", "settings.local.json"))).toBe(true);

        const dotfile = tmp("agetor-safety-dot-");
        writeFileSync(path.join(dotfile, ".notes"), "keep\n");
        expect(await workspaceHasOnlyAgetorScratch(dotfile)).toBe(false);
        await removeWorkspaceIfEmpty(dotfile);
        expect(existsSync(path.join(dotfile, ".notes"))).toBe(true);

        expect(await workspaceHasOnlyAgetorScratch(path.join(empty, "missing"))).toBe(false);
      });
    });
  }
});
