import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { ApiError, type AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";

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

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
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
  errln: () => {},
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdArchive } = await import("./commands/manage.ts");
const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdArchive>[1];

const TASK = { id: "abcdef12-0000-4000-8000-000000000001", title: "t" } as Task;

/** A fake client whose archive refuses unless `forceWorktree` is set. */
function dirtyClient(repositories: string[], calls: unknown[]): AgetorClient {
  return {
    listTasks: async () => [TASK],
    archiveTask: async (_id: string, opts: { forceWorktree?: boolean } = {}) => {
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
});

test("a refused archive explains what would be lost and how to go ahead", async () => {
  const calls: unknown[] = [];
  currentClient = dirtyClient([], calls);
  const err = await cmdArchive(["abcdef12"], flags).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("This task's worktree has uncommitted changes");
  expect((err as Error).message).toContain("Re-run with --discard-changes to archive anyway.");
  expect(calls).toEqual([{ forceWorktree: false }]);
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
  expect(calls).toEqual([{ forceWorktree: true }]);
  expect(outputs.join("\n")).toContain("archived abcdef12");
});

test("an unknown flag or a second id is a usage error", async () => {
  currentClient = dirtyClient([], []);
  await expect(cmdArchive(["abcdef12", "--discard"], flags)).rejects.toThrow("usage: agetor archive");
  await expect(cmdArchive(["abcdef12", "other"], flags)).rejects.toThrow("usage: agetor archive");
});
