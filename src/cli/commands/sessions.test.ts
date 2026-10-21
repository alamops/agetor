import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import { makeTask } from "../test-fixtures.ts";
import { LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import type { ClaudeSessionSummary } from "../api-client.ts";

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };
let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client");
    return currentClient;
  },
}));
mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
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
  out: (msg = "") => { outputs.push(msg); },
  errln: () => {},
  printJson: (data: unknown) => { jsonOutputs.push(data); },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdSessions } = await import("./sessions.ts");
const { cmdStart } = await import("./lifecycle.ts");
const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdSessions>[1];

beforeEach(() => { outputs.length = 0; jsonOutputs.length = 0; });

function session(over: Partial<ClaudeSessionSummary> = {}): ClaudeSessionSummary {
  return {
    sessionId: "sess-1",
    cwd: "/repo",
    title: "Fix login",
    gitBranch: "main",
    importable: true,
    blockedReason: null,
    liveHint: null,
    liveness: "idle",
    ...over,
  };
}

test("sessions with no subcommand lists, and a long path is not importable", async () => {
  const listed = [
    session(),
    session({ sessionId: "long", importable: false, blockedReason: "long-path", title: "Too long" }),
  ];
  currentClient = { listClaudeSessions: async () => ({ sessions: listed }) } as unknown as AgetorClient;
  await cmdSessions([], flags);
  expect(outputs.some((l) => l.includes("sess-1") && l.includes("Fix login"))).toBe(true);
  expect(outputs).toContain(`  ${LONG_PATH_IMPORT_ERROR}`);
});

test("ls re-checks when liveness is missing or stale, and trusts a fresh list", async () => {
  let rechecks = 0;
  const recheck = async () => {
    rechecks += 1;
    return { sessions: [session({ title: "Rechecked" })], livenessCheckedAt: Date.now() };
  };
  currentClient = {
    listClaudeSessions: async () => ({ sessions: [session({ title: "Cached" })], livenessCheckedAt: null }),
    recheckClaudeSessions: recheck,
  } as unknown as AgetorClient;
  await cmdSessions(["ls"], flags);
  expect(rechecks).toBe(1);
  expect(outputs.some((l) => l.includes("Rechecked"))).toBe(true);

  outputs.length = 0;
  currentClient = {
    listClaudeSessions: async () => ({ sessions: [session({ title: "Old" })], livenessCheckedAt: Date.now() - 5 * 60_000 }),
    recheckClaudeSessions: recheck,
  } as unknown as AgetorClient;
  await cmdSessions(["ls"], flags);
  expect(rechecks).toBe(2);

  outputs.length = 0;
  currentClient = {
    listClaudeSessions: async () => ({ sessions: [session({ title: "Fresh" })], livenessCheckedAt: Date.now() }),
    recheckClaudeSessions: recheck,
  } as unknown as AgetorClient;
  await cmdSessions(["ls"], flags);
  expect(rechecks).toBe(2);
  expect(outputs.some((l) => l.includes("Fresh"))).toBe(true);
});

test("ls names a session whose folder is gone", async () => {
  currentClient = {
    listClaudeSessions: async () => ({
      sessions: [session({ importable: false, blockedReason: "missing-folder" })],
      livenessCheckedAt: Date.now(),
    }),
  } as unknown as AgetorClient;
  await cmdSessions(["ls"], flags);
  expect(outputs).toContain(`  ${MISSING_FOLDER_IMPORT_ERROR}`);
});

test("import --dry-run does not call import, and a non-TTY import without --yes is refused", async () => {
  let imported = 0;
  currentClient = {
    recheckClaudeSessions: async () => ({ sessions: [session()] }),
    importClaudeSessions: async () => { imported += 1; return { results: [] }; },
  } as unknown as AgetorClient;
  await cmdSessions(["import", "--dry-run"], flags);
  expect(imported).toBe(0);
  await expect(cmdSessions(["import"], flags)).rejects.toThrow("refusing to import without --yes");
  expect(imported).toBe(0);
});

test("import --yes of a long-path id exits with that sentence and imports nothing", async () => {
  let imported = 0;
  currentClient = {
    recheckClaudeSessions: async () => ({
      sessions: [session({ importable: false, blockedReason: "long-path" })],
    }),
    importClaudeSessions: async () => { imported += 1; return { results: [] }; },
  } as unknown as AgetorClient;
  await expect(cmdSessions(["import", "sess-1", "--yes"], flags)).rejects.toThrow(LONG_PATH_IMPORT_ERROR);
  expect(imported).toBe(0);
  expect(outputs).toContain(`  ${LONG_PATH_IMPORT_ERROR}`);
});

test("import --json --yes prints only the import result", async () => {
  const imported = { results: [{ id: "sess-1", taskId: "task-1" }] };
  currentClient = {
    recheckClaudeSessions: async () => ({
      sessions: [session(), session({ sessionId: "other" })],
    }),
    importClaudeSessions: async () => imported,
  } as unknown as AgetorClient;
  await cmdSessions(["import", "sess-1", "missing", "--yes"], { ...flags, json: true });
  expect(outputs).toEqual([]);
  expect(jsonOutputs).toEqual([{
    results: [
      { id: "sess-1", taskId: "task-1" },
      { id: "missing", error: "session not found" },
    ],
  }]);
});

test("import --json --yes reports a blocked id beside the results, and when nothing is importable", async () => {
  const listed = [
    session(),
    session({ sessionId: "live", importable: false, blockedReason: "live", liveHint: "Close it first" }),
    session({ sessionId: "long", importable: false, blockedReason: "long-path" }),
  ];
  let imported = 0;
  currentClient = {
    recheckClaudeSessions: async () => ({ sessions: listed }),
    importClaudeSessions: async () => { imported += 1; return { results: [{ id: "sess-1", taskId: "task-1" }] }; },
  } as unknown as AgetorClient;
  await cmdSessions(["import", "sess-1", "live", "missing", "--yes"], { ...flags, json: true });
  expect(jsonOutputs).toEqual([{
    results: [
      { id: "sess-1", taskId: "task-1" },
      { id: "live", error: "Close it first" },
      { id: "missing", error: "session not found" },
    ],
  }]);

  jsonOutputs.length = 0;
  await cmdSessions(["import", "long", "--yes"], { ...flags, json: true });
  expect(jsonOutputs).toEqual([{ results: [{ id: "long", error: LONG_PATH_IMPORT_ERROR }] }]);
  expect(imported).toBe(1);
  expect(outputs).toEqual([]);
});

test("import of an unknown id says session not found", async () => {
  let imported = 0;
  currentClient = {
    recheckClaudeSessions: async () => ({ sessions: [session()] }),
    importClaudeSessions: async () => { imported += 1; return { results: [] }; },
  } as unknown as AgetorClient;
  await expect(cmdSessions(["import", "nope", "--yes"], flags)).rejects.toThrow("session not found");
  expect(imported).toBe(0);
});

test("agetor start refuses an imported session", async () => {
  currentClient = {
    listTasks: async () => [makeTask({
      importedClaude: {
        sessionId: "sess-1",
        gitBranch: "main",
        importedAt: 1,
        configDir: "/tmp/claude",
        status: "ready",
        backfillOffset: 0,
        error: null,
      },
    })],
  } as unknown as AgetorClient;
  await expect(cmdStart(["abcdefgh"], flags)).rejects.toThrow("imported Claude session — send a message to continue");
});
