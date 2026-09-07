import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { SentFileEntry, Task } from "../shared/types.ts";

/**
 * `cmdFiles` (in commands/files.ts) reaches for a client via
 * `getClient(flags)` internally, same as every other one-shot command — this
 * suite mocks `./context.ts` (for `getClient`) and `./output.ts` (to capture
 * `out()`/`errln()`) and drives the real `cmdFiles` against a fake
 * `AgetorClient`, following the mocking idiom `logs.test.ts` established.
 *
 * Both mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const jsonOutputs: unknown[] = [];

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
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdFiles } = await import("./commands/files.ts");

function task(sentFiles: SentFileEntry[] | null): Task {
  return {
    id: "t1", title: "T", column: "review", runId: null,
    pendingInteractionCount: 0, archivedAt: null, hasOpenableRun: false,
    sentFiles,
  } as unknown as Task;
}

function makeClient(t: Task): AgetorClient {
  return {
    listTasks: async () => [t],
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdFiles>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdFiles>[1];

const ENTRY_A: SentFileEntry = {
  path: "/tmp/a.png", size: 2048, mediaType: "image/png", isImage: true,
  sentAt: 1_700_000_000_000, runId: "run1",
};
const ENTRY_B: SentFileEntry = {
  path: "/tmp/sub/b.md", size: null, mediaType: null, isImage: false,
  sentAt: 1_700_000_100_000, runId: "run1",
};

test("files: prints an aligned table, newest first, with size/-, sent time, and full path", async () => {
  outputs.length = 0;
  currentClient = makeClient(task([ENTRY_A, ENTRY_B]));
  await cmdFiles(["t1"], flags);

  expect(outputs).toHaveLength(1);
  const lines = outputs[0]!.split("\n");
  expect(lines).toHaveLength(3); // header + 2 rows
  // Newest first: b.md (later sentAt) before a.png.
  const bIdx = lines.findIndex((l) => l.includes("b.md"));
  const aIdx = lines.findIndex((l) => l.includes("a.png"));
  expect(bIdx).toBeGreaterThan(0);
  expect(aIdx).toBeGreaterThan(bIdx);
  expect(lines[bIdx]).toContain("-"); // no known size
  expect(lines[bIdx]).toContain("/tmp/sub/b.md");
  expect(lines[aIdx]).toContain("2.0 KB");
  expect(lines[aIdx]).toContain("/tmp/a.png");
  expect(lines[aIdx]).toContain(new Date(ENTRY_A.sentAt).toLocaleString());
});

test("files: no files sent yet", async () => {
  outputs.length = 0;
  currentClient = makeClient(task([]));
  await cmdFiles(["t1"], flags);
  expect(outputs).toEqual(["No files sent yet."]);
});

test("files: a null sentFiles (never populated) also reads as empty, not an error", async () => {
  outputs.length = 0;
  currentClient = makeClient(task(null));
  await cmdFiles(["t1"], flags);
  expect(outputs).toEqual(["No files sent yet."]);
});

test("files --json: prints the raw array", async () => {
  jsonOutputs.length = 0;
  currentClient = makeClient(task([ENTRY_A, ENTRY_B]));
  await cmdFiles(["t1"], jsonFlags);
  expect(jsonOutputs).toHaveLength(1);
  expect(jsonOutputs[0]).toEqual([ENTRY_A, ENTRY_B]);
});

test("files --json: an empty/null list prints []", async () => {
  jsonOutputs.length = 0;
  currentClient = makeClient(task(null));
  await cmdFiles(["t1"], jsonFlags);
  expect(jsonOutputs).toEqual([[]]);
});

test("files: an unknown task id throws a friendly resolve error", async () => {
  outputs.length = 0;
  currentClient = makeClient(task([ENTRY_A]));
  await expect(cmdFiles(["nope"], flags)).rejects.toThrow(/no task matches/);
});

test("files: missing task-id argument throws the usage error", async () => {
  outputs.length = 0;
  currentClient = makeClient(task([]));
  await expect(cmdFiles([], flags)).rejects.toThrow(/usage: agetor files/);
});
