import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import { makeTask } from "../test-fixtures.ts";
import { LONG_PATH_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import type { ClaudeSessionSummary } from "../api-client.ts";

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };
let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

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
  printJson: () => {},
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdSessions } = await import("./sessions.ts");
const { cmdStart } = await import("./lifecycle.ts");
const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdSessions>[1];

beforeEach(() => { outputs.length = 0; });

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
