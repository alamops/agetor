import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import { makeTask } from "../test-fixtures.ts";
import { LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../../shared/claude-session-meta.ts";
import type { ClaudeSessionSummary } from "../api-client.ts";
import type { OpencodeSessionListItem } from "../../shared/types.ts";

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

// ── OpenCode (docs/plans/add-opencode-harness.md W3-D) ──────────────────

function ocSession(over: Partial<OpencodeSessionListItem> = {}): OpencodeSessionListItem {
  return {
    sessionId: "ses_abc123",
    harnessId: "opencode",
    harnessLabel: "OpenCode",
    directory: "/repo",
    title: "Refactor parser",
    updatedAt: 1,
    createdAt: 1,
    importable: true,
    blockedReason: null,
    ...over,
  };
}

test("ls lists both kinds with a kind/harness tag", async () => {
  currentClient = {
    listClaudeSessions: async () => ({ sessions: [session()], livenessCheckedAt: Date.now() }),
    listOpencodeSessions: async () => ({
      sessions: [ocSession(), ocSession({ sessionId: "ses_busy", blockedReason: "busy", importable: false })],
    }),
  } as unknown as AgetorClient;
  await cmdSessions(["ls"], flags);
  expect(outputs).toContain("sess-1  Fix login · main  [claude]");
  expect(outputs).toContain("ses_abc123  Refactor parser  [opencode · OpenCode]");
  expect(outputs).toContain("  OpenCode is still working on this session — wait for it to finish, then import");
});

test("ls --kind filters to one kind, and --json tags every row", async () => {
  let claudeCalls = 0;
  let opencodeCalls = 0;
  currentClient = {
    listClaudeSessions: async () => { claudeCalls += 1; return { sessions: [session()], livenessCheckedAt: Date.now() }; },
    listOpencodeSessions: async () => { opencodeCalls += 1; return { sessions: [ocSession()] }; },
  } as unknown as AgetorClient;
  await cmdSessions(["ls", "--kind", "opencode"], flags);
  expect(claudeCalls).toBe(0);
  expect(outputs.some((l) => l.includes("sess-1"))).toBe(false);
  expect(outputs.some((l) => l.includes("ses_abc123"))).toBe(true);

  outputs.length = 0;
  await cmdSessions(["ls", "--kind", "claude"], flags);
  expect(opencodeCalls).toBe(1);
  expect(outputs.some((l) => l.includes("ses_abc123"))).toBe(false);

  await cmdSessions(["ls"], { ...flags, json: true });
  const rows = (jsonOutputs[0] as { sessions: { sessionId: string; kind: string }[] }).sessions;
  expect(rows.map((r) => [r.sessionId, r.kind])).toEqual([["sess-1", "claude"], ["ses_abc123", "opencode"]]);

  await expect(cmdSessions(["ls", "--kind", "codex"], flags)).rejects.toThrow("'--kind' must be one of claude, opencode");
});

test("ls with no --kind tolerates a core without the OpenCode routes; --kind opencode does not", async () => {
  currentClient = {
    listClaudeSessions: async () => ({ sessions: [], livenessCheckedAt: Date.now() }),
    listOpencodeSessions: async () => { throw new Error("404 not found"); },
  } as unknown as AgetorClient;
  await cmdSessions([], flags);
  expect(outputs).toEqual(["No Claude Code or OpenCode sessions to import."]);
  await expect(cmdSessions(["ls", "--kind", "opencode"], flags)).rejects.toThrow("404 not found");
});

test("import routes ses_ ids to the OpenCode import and others to Claude, with --harness", async () => {
  const claudeBodies: string[][] = [];
  const opencodeBodies: { ids: string[]; harnessId?: string }[] = [];
  currentClient = {
    recheckClaudeSessions: async () => ({ sessions: [session()] }),
    recheckOpencodeSessions: async () => ({
      sessions: [ocSession(), ocSession({ harnessId: "oc-work", harnessLabel: "Work" }), ocSession({ sessionId: "ses_two" })],
    }),
    importClaudeSessions: async (ids: string[]) => {
      claudeBodies.push(ids);
      return { results: ids.map((id) => ({ id, taskId: `t-${id}` })) };
    },
    importOpencodeSessions: async (ids: string[], harnessId?: string) => {
      opencodeBodies.push({ ids, harnessId });
      return { results: ids.map((id) => ({ id, taskId: `t-${id}` })) };
    },
  } as unknown as AgetorClient;
  await cmdSessions(["import", "sess-1", "ses_abc123", "ses_gone", "--harness", "oc-work", "--yes"], { ...flags, json: true });
  expect(claudeBodies).toEqual([["sess-1"]]);
  // A session listed by two harnesses is imported once.
  expect(opencodeBodies).toEqual([{ ids: ["ses_abc123"], harnessId: "oc-work" }]);
  expect(jsonOutputs).toEqual([{
    results: [
      { id: "sess-1", taskId: "t-sess-1" },
      { id: "ses_abc123", taskId: "t-ses_abc123" },
      { id: "ses_gone", error: "session not found" },
    ],
  }]);
});

test("import of only OpenCode ids never rechecks Claude; --harness on Claude ids is refused", async () => {
  let claudeRechecks = 0;
  currentClient = {
    recheckClaudeSessions: async () => { claudeRechecks += 1; return { sessions: [session()] }; },
    recheckOpencodeSessions: async () => ({ sessions: [ocSession()] }),
    importOpencodeSessions: async (ids: string[]) => ({ results: ids.map((id) => ({ id, taskId: "t" })) }),
  } as unknown as AgetorClient;
  await cmdSessions(["import", "ses_abc123", "--yes"], flags);
  expect(claudeRechecks).toBe(0);
  expect(outputs).toContain("imported ses_abc123 → t");
  await expect(cmdSessions(["import", "sess-1", "--harness", "oc-work", "--yes"], flags)).rejects.toThrow(
    "--harness applies to OpenCode sessions (ses_… ids) only",
  );
});

test("import --json reports a busy or missing-folder OpenCode id with its reason, and an id of the other --kind", async () => {
  let imported = 0;
  currentClient = {
    recheckOpencodeSessions: async () => ({
      sessions: [
        ocSession({ sessionId: "ses_busy", importable: false, blockedReason: "busy" }),
        ocSession({ sessionId: "ses_gonefolder", importable: false, blockedReason: "missing-folder" }),
      ],
    }),
    importOpencodeSessions: async () => { imported += 1; return { results: [] }; },
  } as unknown as AgetorClient;
  await cmdSessions(["import", "ses_busy", "ses_gonefolder", "sess-1", "--kind", "opencode", "--yes"], { ...flags, json: true });
  expect(imported).toBe(0);
  expect(jsonOutputs).toEqual([{
    results: [
      { id: "ses_busy", error: "OpenCode is still working on this session — wait for it to finish, then import" },
      { id: "ses_gonefolder", error: MISSING_FOLDER_IMPORT_ERROR },
      { id: "sess-1", error: "not an OpenCode session id (--kind opencode)" },
    ],
  }]);

  // A single blocked id exits with its sentence in plain mode.
  await expect(cmdSessions(["import", "ses_busy", "--yes"], flags)).rejects.toThrow("OpenCode is still working on this session");
});

test("agetor start refuses an imported OpenCode session", async () => {
  currentClient = {
    listTasks: async () => [makeTask({
      agent: "opencode",
      importedOpencode: {
        sessionId: "ses_abc123",
        harnessId: "opencode",
        directory: "/repo",
        importedAt: 1,
        status: "ready",
        error: null,
      },
    })],
  } as unknown as AgetorClient;
  await expect(cmdStart(["abcdefgh"], flags)).rejects.toThrow("imported OpenCode session — send a message to continue");
});
