import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError, type AgetorClient } from "./api-client.ts";
import type { Task, WorktreeTeardownResult } from "../shared/types.ts";

/**
 * `agetor archive` (commands/manage.ts `cmdArchive`): archiving removes the
 * task's worktree, and the core answers 409 `uncommitted-changes` when that
 * would discard uncommitted work. The command explains it and points at
 * `--discard-changes`, which sends `forceWorktree`. Same mocking idiom as
 * ls.test.ts: `./context.ts` (for `getClient`) and `./output.ts` are mocked
 * and restored in `afterAll`.
 */
import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errors: string[] = [];

void mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

void mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: (msg = "") => {
    errors.push(msg);
  },
}));

afterAll(() => {
  void mock.module("./context.ts", () => realContextSnapshot);
  void mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdArchive, cmdUnarchive, archiveReport, unarchiveReport, tildePath } = await import("./commands/manage.ts");
const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdArchive>[1];

const TASK = { id: "abcdef12-0000-4000-8000-000000000001", title: "t" } as Task;

/** A fake client whose archive refuses unless `forceWorktree` is set. */
function dirtyClient(repositories: string[], calls: unknown[]): AgetorClient {
  return {
    listTasks: async () => [TASK],
    archiveTask: async (_id: string, opts: { forceWorktree?: boolean; awaitTeardown?: boolean } = {}) => {
      calls.push(opts);
      if (!opts.forceWorktree) {
        throw new ApiError(409, { error: "dirty", code: "uncommitted-changes", repositories }, "409");
      }
      return { ...TASK, archivedAt: 1 };
    },
  } as unknown as AgetorClient;
}

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
});

test("a refused archive explains what would be lost and how to go ahead", async () => {
  const calls: unknown[] = [];
  currentClient = dirtyClient([], calls);
  const err = await cmdArchive(["abcdef12"], flags).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("This task's worktree has uncommitted changes");
  expect((err as Error).message).toContain("Re-run with --discard-changes to archive anyway.");
  expect(calls).toEqual([{ forceWorktree: false, awaitTeardown: true }]);
  expect(outputs).toEqual([]);
});

test("a refusal on a multi-repository task names the repositories", async () => {
  currentClient = dirtyClient(["frontend", "backend"], []);
  const err = await cmdArchive(["abcdef12"], flags).catch((e: Error) => e);
  expect((err as Error).message).toContain("Repositories frontend, backend have uncommitted changes");
});

test("--discard-changes sends forceWorktree and archives", async () => {
  const calls: unknown[] = [];
  currentClient = dirtyClient([], calls);
  await cmdArchive(["abcdef12", "--discard-changes"], flags);
  expect(calls).toEqual([{ forceWorktree: true, awaitTeardown: true }]);
  expect(outputs.join("\n")).toContain("archived abcdef12");
});

test("an unknown flag or a second id is a usage error", async () => {
  currentClient = dirtyClient([], []);
  await expect(cmdArchive(["abcdef12", "--discard"], flags)).rejects.toThrow("usage: agetor archive");
  await expect(cmdArchive(["abcdef12", "other"], flags)).rejects.toThrow("usage: agetor archive");
});

// Issue #315: archive removes the worktree and keeps the branch, and nothing
// the user reads said so. The command now waits for the removal
// (`awaitTeardown`) and reports its outcome under a `✓ archived` line, in the
// house style (`✓` head, indented detail rows, `!` for a problem); unarchive
// reports the re-created worktree the same way. Colors are stubbed out above.

/** A clean client: archive succeeds and answers with `teardown`. */
function cleanClient(task: Task, teardown: WorktreeTeardownResult | undefined, calls: unknown[] = []): AgetorClient {
  return {
    listTasks: async () => [task],
    archiveTask: async (_id: string, opts: unknown) => {
      calls.push(opts);
      return { ...task, archivedAt: 1, ...(teardown ? { teardown } : {}) };
    },
    unarchiveTask: async () => ({ ...task, archivedAt: null }),
  } as unknown as AgetorClient;
}

const WORKTREE_TASK = {
  ...TASK,
  title: "Fix login",
  isolation: "worktree",
  branch: "agetor/abcdef12-fix-login",
  worktreePath: "/w/abcdef12",
} as unknown as Task;

const MULTI_TASK = {
  ...WORKTREE_TASK,
  multiRepo: true,
  branch: null,
  worktreePath: "/w/abcdef12",
  repositories: [
    { name: "frontend", branch: "agetor/a", worktreePath: "/w/abcdef12/frontend" },
    { name: "backend", branch: "agetor/b", worktreePath: "/w/abcdef12/backend" },
    { name: "docs", branch: "agetor/c", worktreePath: null },
  ],
} as unknown as Task;

test("a successful archive waits for the removal and lists the removed worktree and the kept branch", async () => {
  const calls: unknown[] = [];
  currentClient = cleanClient(WORKTREE_TASK, { removed: true }, calls);
  await cmdArchive(["abcdef12"], flags);
  expect(calls).toEqual([{ forceWorktree: false, awaitTeardown: true }]);
  expect(outputs).toEqual([
    "✓ archived abcdef12  Fix login",
    "  worktree removed  /w/abcdef12",
    "  branch kept       agetor/abcdef12-fix-login  (agetor unarchive abcdef12 restores it)",
  ]);
  expect(errors).toEqual([]);
});

test("a multi-repository archive has one aligned row per repository that had a checkout", async () => {
  currentClient = cleanClient(MULTI_TASK, {
    removed: true,
    repositories: [
      { name: "frontend", result: { removed: true } },
      { name: "backend", result: { removed: true } },
      { name: "docs", result: { removed: false, reason: "no-worktree" } },
    ],
  });
  await cmdArchive(["abcdef12"], flags);
  expect(outputs).toEqual([
    "✓ archived abcdef12  Fix login",
    "  frontend  worktree removed · branch agetor/a kept",
    "  backend   worktree removed · branch agetor/b kept",
    "  (agetor unarchive abcdef12 restores it)",
  ]);
});

test("nothing to remove, or a core that does not report the outcome, prints only the head line", async () => {
  for (const teardown of [
    { removed: false, reason: "no-worktree" },
    { removed: false, reason: "already-absent" },
    undefined,
  ] as (WorktreeTeardownResult | undefined)[]) {
    outputs.length = 0;
    currentClient = cleanClient(WORKTREE_TASK, teardown);
    await cmdArchive(["abcdef12"], flags);
    expect(outputs).toEqual(["✓ archived abcdef12  Fix login"]);
    expect(errors).toEqual([]);
  }
});

test("a checkout left on disk is a ! row with where, why and what to do; the archive still succeeds", async () => {
  currentClient = cleanClient(WORKTREE_TASK, { removed: false, reason: "failed" });
  await cmdArchive(["abcdef12"], flags);
  expect(outputs).toEqual([
    "✓ archived abcdef12  Fix login",
    "  ! worktree still on disk: /w/abcdef12 (the removal failed)",
    "    Remove it from the Worktrees page, or by hand.",
  ]);
  expect(errors).toEqual([]);
});

test("a multi-repository archive marks the repository that kept its checkout", async () => {
  currentClient = cleanClient(MULTI_TASK, {
    removed: false,
    reason: "source-missing",
    repositories: [
      { name: "frontend", result: { removed: true } },
      { name: "backend", result: { removed: false, reason: "source-missing" } },
    ],
  });
  await cmdArchive(["abcdef12"], flags);
  expect(outputs).toEqual([
    "✓ archived abcdef12  Fix login",
    "  frontend  worktree removed · branch agetor/a kept",
    "! backend   worktree still on disk: /w/abcdef12/backend (its source repository no longer exists)",
    "    Remove it from the Worktrees page, or by hand.",
  ]);
});

test("a task workspace left on disk after every checkout went is its own ! row", () => {
  const lines = archiveReport(MULTI_TASK, {
    removed: false,
    reason: "workspace-not-empty",
    repositories: [
      { name: "frontend", result: { removed: true } },
      { name: "backend", result: { removed: true } },
    ],
  }, "/nohome");
  expect(lines.slice(2)).toEqual([
    "  ! task workspace still on disk: /w/abcdef12 (it holds files outside its repositories)",
    "    Remove it from the Worktrees page, or by hand.",
  ]);
});

test("archiveReport words a dirty checkout, and skips the path and branch it doesn't know", () => {
  expect(archiveReport(WORKTREE_TASK, { removed: false, reason: "dirty" }, "/nohome")[0])
    .toBe("  ! worktree still on disk: /w/abcdef12 (it has uncommitted changes)");
  expect(archiveReport({ ...WORKTREE_TASK, branch: null, worktreePath: null }, { removed: true }, "/nohome"))
    .toEqual(["  worktree removed  (agetor unarchive abcdef12 restores it)"]);
});

test("paths under the home directory are shortened to ~", () => {
  expect(tildePath("/Users/me/.agetor/worktrees/x", "/Users/me")).toBe("~/.agetor/worktrees/x");
  expect(tildePath("/Users/meme/x", "/Users/me")).toBe("/Users/meme/x");
  expect(archiveReport({ ...WORKTREE_TASK, worktreePath: "/Users/me/.agetor/worktrees/abcdef12" }, { removed: true }, "/Users/me")[0])
    .toBe("  worktree removed  ~/.agetor/worktrees/abcdef12");
});

test("--json prints the task with its teardown and no report", async () => {
  currentClient = cleanClient(WORKTREE_TASK, { removed: true });
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await cmdArchive(["abcdef12"], { ...flags, json: true } as typeof flags);
  } finally {
    process.stdout.write = orig;
  }
  expect(outputs).toEqual([]);
  expect(JSON.parse(writes.join("")).teardown).toEqual({ removed: true });
});

test("unarchive says the worktree is back, checked on disk", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agt-unarchive-"));
  try {
    currentClient = cleanClient({ ...WORKTREE_TASK, worktreePath: dir }, undefined);
    await cmdUnarchive(["abcdef12"], flags);
    expect(outputs).toEqual([
      "✓ unarchived abcdef12  Fix login",
      `  worktree re-created  ${tildePath(dir)}  (branch agetor/abcdef12-fix-login)`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unarchive flags a worktree that isn't back, per repository for a multi task", () => {
  expect(unarchiveReport(WORKTREE_TASK, () => false, "/nohome")).toEqual([
    "  ! worktree not re-created: /w/abcdef12",
    "    agetor start abcdef12 re-creates it.",
  ]);
  expect(unarchiveReport(MULTI_TASK, (p) => p.endsWith("frontend"), "/nohome")).toEqual([
    "  frontend  worktree re-created · branch agetor/a",
    "! backend   worktree not re-created: /w/abcdef12/backend",
    "    agetor start abcdef12 re-creates it.",
  ]);
  expect(unarchiveReport({ ...WORKTREE_TASK, isolation: "none" } as Task, () => true)).toEqual([]);
  expect(unarchiveReport({ ...WORKTREE_TASK, pipelineParentId: "p" } as Task, () => true)).toEqual([]);
});

test("archive and unarchive help say what happens to the worktree", async () => {
  const { USAGE } = await import("./usage.ts");
  const flat = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");
  expect(USAGE.archive!.split("\n", 1)[0]).toBe("usage: agetor archive <task-id> [--discard-changes]");
  expect(flat(USAGE.archive)).toContain("Archiving removes the task's worktree; its branch and commits are kept");
  expect(flat(USAGE.archive)).toContain("unless --discard-changes");
  expect(flat(USAGE.archive)).toContain('"teardown"');
  expect(flat(USAGE.unarchive)).toContain("Its worktree is re-created from the branch the archive kept");
});

test("the README's CLI lines for archive and unarchive say what happens to the worktree", () => {
  const lines = readFileSync(path.join(import.meta.dir, "../../README.md"), "utf8").split("\n");
  const archive = lines.find((l) => l.startsWith("agetor archive "));
  expect(archive).toContain("removes its worktree, keeps its branch");
  expect(archive).toContain("--discard-changes");
  expect(lines.find((l) => l.startsWith("agetor unarchive "))).toContain("re-creates its worktree");
});
