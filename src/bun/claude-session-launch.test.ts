import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, type AppEvent, type Task } from "../shared/types.ts";
import { plainEncodedProjectPath } from "../shared/claude-session-meta.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-launch-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const { claudeSessionSeen, db, preferences, runs, tasks } = await import("./db.ts");
const {
  clearPendingClaudeSessionsNotice,
  flushPendingClaudeSessionsNotice,
  startClaudeSessionLaunchScan,
} = await import("./claude-session-launch.ts");
const { pendingImportBackfill } = await import("./claude-session-import.ts");
const { clearClaudeSessionLivenessCache } = await import("./claude-session-scan.ts");
const { subscribeAppEvents } = await import("./quit-guard.ts");

const scratch: string[] = [];

function resetSeen(): void {
  db.run(`DELETE FROM claude_session_seen`);
}

/** Seen ids, oldest first. */
function seenIds(): string[] {
  return db.query<{ session_id: string }, []>(
    `SELECT session_id FROM claude_session_seen ORDER BY seen_at, session_id`,
  ).all().map((r) => r.session_id);
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function plant(sessionId: string): { home: string; stub: string } {
  const home = mkdtempSync(path.join(tmpdir(), "cc-launch-home-"));
  scratch.push(home);
  const cwd = path.join(home, "repo");
  expect(plainEncodedProjectPath(cwd).length).toBeLessThanOrEqual(200);
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(home, ".claude", "projects", plainEncodedProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user",
    uuid: `${sessionId}-u`,
    cwd,
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "user", content: "hello from outside" },
  }) + "\n");
  const stub = path.join(home, "agents.json");
  writeFileSync(stub, "[]");
  return { home, stub };
}

let homeGate: Promise<void> = Promise.resolve();

async function withHome<T>(home: string, stub: string, fn: () => Promise<T>): Promise<T> {
  const run = homeGate.then(async () => {
    const prevHome = process.env.HOME;
    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    const prevStub = process.env.AGETOR_CLAUDE_AGENTS_JSON;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.AGETOR_CLAUDE_AGENTS_JSON = stub;
    clearClaudeSessionLivenessCache();
    try {
      return await fn();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
      if (prevStub === undefined) delete process.env.AGETOR_CLAUDE_AGENTS_JSON;
      else process.env.AGETOR_CLAUDE_AGENTS_JSON = prevStub;
      clearClaudeSessionLivenessCache();
    }
  });
  homeGate = run.then(() => {}, () => {});
  return run;
}

test("a disabled launch scan still resumes an import left in progress", async () => {
  const sessionId = "scan-off-resume";
  const { home, stub } = plant(sessionId);
  const cwd = path.join(home, "repo");
  const taskId = randomUUID();
  tasks.insert({ ...makeTask(taskId), workdir: cwd, column: "review" });
  tasks.setImportedClaude(taskId, {
    sessionId,
    gitBranch: null,
    importedAt: Date.now(),
    configDir: path.join(home, ".claude"),
    status: "importing",
    backfillOffset: 0,
    error: null,
  });
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "0");
  resetSeen();
  const events: { type: string }[] = [];
  const unsub = subscribeAppEvents((e) => {
    if (e.type === "claude_sessions_found") events.push(e);
  });
  try {
    await withHome(home, stub, async () => {
      await startClaudeSessionLaunchScan();
      await pendingImportBackfill(taskId);
    });
    expect(events).toEqual([]);
    expect(seenIds()).toEqual([]);
    const task = tasks.get(taskId);
    expect(task?.importedClaude?.status).toBe("ready");
    expect(task?.runId).toBeTruthy();
    expect(runs.get(task!.runId!)?.origin).toBe("imported");
    expect(runs.get(task!.runId!)?.claudeSessionId).toBe(sessionId);
  } finally {
    unsub();
    preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  }
});

test("a disabled launch scan does nothing", async () => {
  const { home, stub } = plant("off-one");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "0");
  resetSeen();
  const events: unknown[] = [];
  const unsub = subscribeAppEvents((e) => events.push(e));
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([]);
    expect(seenIds()).toEqual([]);
  } finally {
    unsub();
    preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  }
});

test("launch scan toasts only new importable ids and caps the seen set at 2000", async () => {
  const { home, stub } = plant("fresh-one");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  const prior = Array.from({ length: 2000 }, (_, i) => `old-${i}`);
  resetSeen();
  claudeSessionSeen.add(prior, 2000, Date.now() - 10_000);
  const events: { type: string; count?: number }[] = [];
  const unsub = subscribeAppEvents((e) => {
    if (e.type === "claude_sessions_found") events.push(e);
  });
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([expect.objectContaining({ type: "claude_sessions_found", count: 1 })]);
    const seen = seenIds();
    expect(seen).toHaveLength(2000);
    expect(seen.at(-1)).toBe("fresh-one");
    expect(seen).not.toContain("old-0");
    events.length = 0;
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([]);
  } finally {
    unsub();
  }
});

function makeTask(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

test("launch scan hides a session whose seed run resume inserts before ownership is read", async () => {
  const sessionId = "crash-window-seed";
  const sibling = "crash-window-new";
  const { home, stub } = plant(sessionId);
  const cwd = path.join(home, "repo");
  const dir = path.join(home, ".claude", "projects", plainEncodedProjectPath(cwd));
  writeFileSync(path.join(dir, `${sibling}.jsonl`), JSON.stringify({
    type: "user",
    uuid: `${sibling}-u`,
    cwd,
    timestamp: "2026-10-02T00:00:00.000Z",
    message: { role: "user", content: "a different session" },
  }) + "\n");
  const taskId = randomUUID();
  await withHome(home, stub, async () => {
    // Claim column stays empty. The only hide signal is the seed run
    // resume inserts before this function reads ownership for the toast.
    tasks.insert({ ...makeTask(taskId), workdir: cwd, column: "review" });
    tasks.setImportedClaude(taskId, {
      sessionId,
      gitBranch: null,
      importedAt: Date.now(),
      configDir: path.join(home, ".claude"),
      status: "importing",
      backfillOffset: 0,
      error: null,
    }, { claim: false });
    const claim = db.query<{ imported_claude_session_id: string | null }, [string]>(
      `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
    ).get(taskId);
    expect(claim?.imported_claude_session_id).toBeNull();
    expect(runs.hasClaudeSessionId(sessionId)).toBe(false);

    preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
    resetSeen();
    const events: { type: string; count?: number }[] = [];
    const unsub = subscribeAppEvents((e) => {
      if (e.type === "claude_sessions_found") events.push(e);
    });
    try {
      await startClaudeSessionLaunchScan();
      expect(events).toEqual([expect.objectContaining({ type: "claude_sessions_found", count: 1 })]);
      expect(seenIds()).toEqual([sibling]);
      const task = tasks.get(taskId);
      expect(task?.runId).toBeTruthy();
      expect(runs.get(task!.runId!)?.claudeSessionId).toBe(sessionId);
      expect(runs.get(task!.runId!)?.origin).toBe("imported");
      await pendingImportBackfill(taskId);
      expect(tasks.get(taskId)?.importedClaude?.status).toBe("ready");
    } finally {
      unsub();
    }
  });
});

test("launch scan does not offer a session already stored on a run", async () => {
  const { home, stub } = plant("owned-scan");
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTask(taskId));
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: "owned-scan",
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "imported",
  });
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  resetSeen();
  const events: { type: string }[] = [];
  const unsub = subscribeAppEvents((e) => {
    if (e.type === "claude_sessions_found") events.push(e);
  });
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([]);
    expect(seenIds()).toEqual([]);
  } finally {
    unsub();
  }
});

test("a scan failure is logged and does not reject", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cc-launch-fail-"));
  scratch.push(home);
  const stub = path.join(home, "agents.json");
  writeFileSync(stub, "[]");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  const lines: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    await withHome(home, stub, async () => {
      await expect(startClaudeSessionLaunchScan({
        scan: async () => { throw new Error("boom"); },
      })).resolves.toBeUndefined();
    });
    expect(lines.some((args) => String(args[0]).includes("claude session launch scan failed"))).toBe(true);
  } finally {
    console.error = orig;
  }
});

test("with no client connected the notice is held, then sent to the next client and only then marked seen", async () => {
  const { home, stub } = plant("held-one");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  resetSeen();
  clearPendingClaudeSessionsNotice();
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    // Nobody heard it, so nothing is recorded: a crash here offers it again.
    expect(seenIds()).toEqual([]);

    const sent: AppEvent[] = [];
    flushPendingClaudeSessionsNotice((e) => sent.push(e));
    expect(sent).toEqual([expect.objectContaining({ type: "claude_sessions_found", count: 1 })]);
    expect(seenIds()).toEqual(["held-one"]);

    // Delivered once. A reconnect does not repeat it.
    sent.length = 0;
    flushPendingClaudeSessionsNotice((e) => sent.push(e));
    expect(sent).toEqual([]);
  } finally {
    clearPendingClaudeSessionsNotice();
  }
});

test("a held notice drops a session imported before a client connected", async () => {
  const { home, stub } = plant("held-then-owned");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  resetSeen();
  clearPendingClaudeSessionsNotice();
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    const taskId = randomUUID();
    tasks.insert(makeTask(taskId));
    runs.insert({
      id: randomUUID(),
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: "held-then-owned",
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      origin: "imported",
    });
    const sent: AppEvent[] = [];
    flushPendingClaudeSessionsNotice((e) => sent.push(e));
    expect(sent).toEqual([]);
    expect(seenIds()).toEqual([]);
  } finally {
    clearPendingClaudeSessionsNotice();
  }
});
