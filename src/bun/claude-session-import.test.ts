import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plainEncodedProjectPath, LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../shared/claude-session-meta.ts";
import type { ImportedClaudeSession, Task } from "../shared/types.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-import-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const {
  checkoutSessionBranch,
  importClaudeSessions,
  IMPORT_TRANSCRIPT_CHUNK_BYTES,
  pendingImportBackfill,
  resumeIncompleteImports,
  retryImport,
} = await import("./claude-session-import.ts");
const { db, projects, runs, subagents, tasks, IMPORTED_CLAUDE_HELD_ELSEWHERE } = await import("./db.ts");
const { subscribe, teardownBranchesForTask } = await import("./orchestrator.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

function plant(opts: {
  home: string;
  sessionId: string;
  cwd: string;
  dirName?: string;
  permissionMode?: string | null;
  lines?: unknown[];
  subagent?: boolean;
}): string {
  const config = path.join(opts.home, ".claude");
  const dirName = opts.dirName ?? plainEncodedProjectPath(opts.cwd);
  const dir = path.join(config, "projects", dirName);
  mkdirSync(dir, { recursive: true });
  const lines = opts.lines ?? [
    {
      type: "user",
      uuid: `${opts.sessionId}-user`,
      cwd: opts.cwd,
      gitBranch: "feature",
      timestamp: "2026-10-01T00:00:00.000Z",
      ...(opts.permissionMode != null ? { permissionMode: opts.permissionMode } : {}),
      message: { role: "user", content: "please fix the login" },
    },
    {
      type: "assistant",
      uuid: `${opts.sessionId}-assistant`,
      timestamp: "2026-10-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    },
  ];
  writeFileSync(path.join(dir, `${opts.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (opts.subagent) {
    const sub = path.join(dir, opts.sessionId, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "agent-helper.jsonl"), JSON.stringify({
      type: "assistant",
      uuid: `${opts.sessionId}-sub`,
      message: { role: "assistant", content: [{ type: "text", text: "helped" }], stop_reason: "end_turn" },
    }) + "\n");
  }
  return config;
}

function baseOpts(home: string, config: string, extra: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    harnesses: [{ id: "claude-code", kind: "claude-code", home: config }],
    encodePath: plainEncodedProjectPath,
    listLive: () => [] as { sessionId: string; kind: string | null }[],
    worktreeRoots: [] as string[],
    ...extra,
  };
}

test("import persists an in-place task, ask for default/missing/unknown, and plan for plan", async () => {
  const home = scratchDir("cc-import-home-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const cases = [
    { id: "mode-default", permissionMode: "default" as string | null, mode: "ask" },
    { id: "mode-missing", permissionMode: null, mode: "ask" },
    { id: "mode-nope", permissionMode: "nope", mode: "ask" },
    { id: "mode-plan", permissionMode: "plan", mode: "plan" },
  ];
  let config = "";
  for (const c of cases) {
    config = plant({
      home,
      sessionId: c.id,
      cwd,
      permissionMode: c.permissionMode,
      subagent: c.id === "mode-default",
    });
  }
  const imported = await importClaudeSessions(cases.map((c) => c.id), baseOpts(home, config));
  expect(imported.results.every((r) => r.taskId && !r.error)).toBe(true);
  for (const result of imported.results) {
    await pendingImportBackfill(result.taskId!);
  }
  for (const c of cases) {
    const result = imported.results.find((r) => r.id === c.id)!;
    const task = tasks.get(result.taskId!)!;
    expect(task.isolation).toBe("none");
    expect(task.workdir).toBe(cwd);
    expect(task.column).toBe("review");
    expect(task.mode).toBe(c.mode);
    expect(task.runId).toBeTruthy();
    const run = runs.get(task.runId!)!;
    expect(run.origin).toBe("imported");
    expect(run.status).toBe("succeeded");
    expect(run.claudeSessionId).toBe(c.id);
    expect(runs.seenLineUuidsForRun(run.id).has(`${c.id}-user`)).toBe(true);
    expect(runs.seenLineUuidsForRun(run.id).has(`${c.id}-assistant`)).toBe(true);
    expect(task.importedClaude?.status).toBe("ready");
  }
  expect(projects.get(cwd)?.name).toBe("repo");
  const parent = tasks.get(imported.results.find((r) => r.id === "mode-default")!.taskId!)!;
  const subs = subagents.listForTask(parent.id);
  expect(subs.map((s) => s.id)).toEqual(["helper"]);
  expect(subs[0]?.status).toBe("completed");
  expect(subs[0]?.endedAt).not.toBeNull();
  const subEvents = runs.events(parent.runId!).filter((e) => e.subagentId === "helper");
  expect(subEvents.length).toBeGreaterThan(0);
  const again = await importClaudeSessions(["mode-default"], baseOpts(home, config));
  expect(again.results[0]?.error).toBe("session is already imported");
  expect(again.results[0]?.taskId).toBeUndefined();
  const plan = await teardownBranchesForTask(parent);
  expect(plan.branches).toEqual([]);
});

test("overlapping imports of one session bind a single task", async () => {
  const home = scratchDir("cc-import-race-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "race-one", cwd });
  const opts = baseOpts(home, config);
  const [first, second] = await Promise.all([
    importClaudeSessions(["race-one"], opts),
    importClaudeSessions(["race-one"], opts),
  ]);
  const results = [first.results[0], second.results[0]];
  const bound = results.filter((r) => r?.taskId && !r.error);
  const refused = results.filter((r) => r?.error === "session is already imported" && !r.taskId);
  expect(bound).toHaveLength(1);
  expect(refused).toHaveLength(1);
  await pendingImportBackfill(bound[0]!.taskId!);
  const owners = tasks.list().filter((t) => t.workdir === cwd);
  expect(owners).toHaveLength(1);
  expect(owners[0]?.importedClaude?.sessionId).toBe("race-one");
  expect(runs.listForTask(owners[0]!.id).filter((r) => r.claudeSessionId === "race-one")).toHaveLength(1);
});

test("a session that becomes live during the transcript read is refused", async () => {
  const home = scratchDir("cc-import-live-race-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const sessionId = "appear-live";
  const config = plant({ home, sessionId, cwd });
  let live = false;
  const probes: boolean[] = [];
  const imported = await importClaudeSessions([sessionId], {
    ...baseOpts(home, config),
    listLive: () => {
      probes.push(live);
      return live ? [{ sessionId, kind: null }] : [];
    },
    onJsonlRead: () => { live = true; },
  });
  expect(probes).toEqual([false, true]);
  expect(imported.results[0]?.taskId).toBeUndefined();
  expect(imported.results[0]?.error).toBe("Close it in your terminal first");
  expect(tasks.list().some((t) => t.importedClaude?.sessionId === sessionId)).toBe(false);
  expect(runs.hasClaudeSessionId(sessionId)).toBe(false);
});

test("a registry record that appears during the transcript read refuses the import", async () => {
  const home = scratchDir("cc-import-reg-race-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const sessionId = "appear-reg";
  const config = plant({ home, sessionId, cwd });
  let appeared = false;
  const probes: number[] = [];
  const imported = await importClaudeSessions([sessionId], {
    ...baseOpts(home, config),
    readRegistry: () => {
      probes.push(appeared ? 1 : 0);
      return appeared
        ? [{ sessionId, pid: 42, procStart: "Thu Oct 16 12:00:00 2026", kind: null, tmux: null }]
        : [];
    },
    pidAlive: () => true,
    procStartMatches: () => true,
    onJsonlRead: () => { appeared = true; },
  });
  expect(probes).toEqual([0, 1]);
  expect(imported.results[0]?.taskId).toBeUndefined();
  expect(imported.results[0]?.error).toBe("Close it in your terminal first");
  expect(tasks.list().some((t) => t.importedClaude?.sessionId === sessionId)).toBe(false);
  expect(runs.hasClaudeSessionId(sessionId)).toBe(false);
});

test("a session that closes during the transcript read is imported", async () => {
  const home = scratchDir("cc-import-live-gone-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const sessionId = "closed-during";
  const config = plant({ home, sessionId, cwd });
  let live = true;
  const probes: boolean[] = [];
  const imported = await importClaudeSessions([sessionId], {
    ...baseOpts(home, config),
    listLive: () => {
      probes.push(live);
      return live ? [{ sessionId, kind: null }] : [];
    },
    onJsonlRead: () => { live = false; },
  });
  expect(probes).toEqual([true, false]);
  expect(imported.results[0]?.error).toBeUndefined();
  expect(imported.results[0]?.taskId).toBeTruthy();
  await pendingImportBackfill(imported.results[0]!.taskId!);
  const task = tasks.get(imported.results[0]!.taskId!)!;
  expect(task.importedClaude?.status).toBe("ready");
  expect(task.importedClaude?.sessionId).toBe(sessionId);
});

test("a live session and a long path write no task", async () => {
  const home = scratchDir("cc-import-live-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "live-one", cwd });
  const before = runs.claudeSessionIds();
  const live = await importClaudeSessions(["live-one"], {
    ...baseOpts(home, config),
    listLive: () => [{ sessionId: "live-one", kind: null }],
  });
  expect(live.results[0]?.taskId).toBeUndefined();
  expect(live.results[0]?.error).toBe("Close it in your terminal first");
  expect(runs.claudeSessionIds().has("live-one")).toBe(false);

  const longCwd = path.join(home, "p".repeat(210));
  mkdirSync(longCwd, { recursive: true });
  expect(plainEncodedProjectPath(longCwd).length).toBeGreaterThan(200);
  const longConfig = plant({ home, sessionId: "long-one", cwd: longCwd, dirName: "short" });
  const blocked = await importClaudeSessions(["long-one"], {
    ...baseOpts(home, longConfig),
    encodePath: plainEncodedProjectPath,
  });
  expect(blocked.results[0]?.error).toBe(LONG_PATH_IMPORT_ERROR);
  expect(blocked.results[0]?.taskId).toBeUndefined();
  expect(runs.claudeSessionIds().has("long-one")).toBe(before.has("long-one"));

  const open = await importClaudeSessions(["long-one"], {
    ...baseOpts(home, longConfig),
    encodePath: () => "short",
  });
  expect(open.results[0]?.error).toBeUndefined();
  expect(open.results[0]?.taskId).toBeTruthy();
  await pendingImportBackfill(open.results[0]!.taskId!);
});

test("dirty checkout is refused and a clean repo switches to the recorded branch", async () => {
  const home = scratchDir("cc-import-git-");
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await git(repo, ["checkout", "main"]);
  const config = plant({ home, sessionId: "git-one", cwd: repo });

  writeFileSync(path.join(repo, "dirty.txt"), "x\n");
  const dirty = await checkoutSessionBranch("git-one", baseOpts(home, config));
  expect("error" in dirty).toBe(true);
  if ("error" in dirty) expect(dirty.error).toContain("not clean");
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

  rmSync(path.join(repo, "dirty.txt"));
  const live = await checkoutSessionBranch("git-one", {
    ...baseOpts(home, config),
    listLive: async () => [{ sessionId: "git-one", kind: null }],
  });
  expect(live).toEqual({ error: "Close it in your terminal first" });
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

  const clean = await checkoutSessionBranch("git-one", baseOpts(home, config));
  expect(clean).toEqual({ ok: true, branch: "feature" });
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
});

test("checkout switches to the branch the caller showed, not the transcript's latest", async () => {
  const home = scratchDir("cc-import-git-asked-");
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["checkout", "-b", "later"]);
  // The session started on `main` and later moved to `later` — the task
  // panel's banner names the import-time branch.
  const config = plant({
    home,
    sessionId: "git-moved",
    cwd: repo,
    lines: [
      { type: "user", uuid: "m-1", cwd: repo, gitBranch: "main", message: { role: "user", content: "start" } },
      { type: "user", uuid: "m-2", cwd: repo, gitBranch: "later", message: { role: "user", content: "continue" } },
    ],
  });
  const asked = await checkoutSessionBranch("git-moved", baseOpts(home, config), "main");
  expect(asked).toEqual({ ok: true, branch: "main" });
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

  const bad = await checkoutSessionBranch("git-moved", baseOpts(home, config), "bad..name");
  expect(bad).toEqual({ error: "invalid branch name: bad..name" });
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
});

test("a session whose folder is gone imports nothing", async () => {
  const home = scratchDir("cc-import-gone-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "gone-before", cwd });
  rmSync(cwd, { recursive: true, force: true });
  const before = tasks.list().length;
  const result = await importClaudeSessions(["gone-before"], baseOpts(home, config));
  expect(result.results).toEqual([{ id: "gone-before", error: MISSING_FOLDER_IMPORT_ERROR }]);
  expect(tasks.list()).toHaveLength(before);
  expect(projects.list().some((p) => p.path === cwd)).toBe(false);
});

test("a folder removed during the commit's transcript read imports nothing", async () => {
  const home = scratchDir("cc-import-gone-late-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "gone-during", cwd });
  const before = tasks.list().length;
  let probes = 0;
  const result = await importClaudeSessions(["gone-during"], {
    ...baseOpts(home, config),
    // The second probe is the commit's re-check, after the scan stamped the
    // folder as present and before the commit lock.
    listLive: () => {
      probes += 1;
      if (probes === 2) rmSync(cwd, { recursive: true, force: true });
      return [];
    },
  });
  expect(probes).toBe(2);
  expect(result.results).toEqual([{ id: "gone-during", error: MISSING_FOLDER_IMPORT_ERROR }]);
  expect(tasks.list()).toHaveLength(before);
});

test("retry reports a backfill failure instead of succeeding quietly", async () => {
  const home = scratchDir("cc-import-retry-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "retry-one", cwd });
  const imported = await importClaudeSessions(["retry-one"], baseOpts(home, config));
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  const ready = tasks.get(id)!;
  expect(ready.importedClaude?.status).toBe("ready");
  tasks.setImportedClaude(id, { ...ready.importedClaude!, status: "failed", error: "boom" });
  rmSync(path.join(config, "projects", plainEncodedProjectPath(cwd), "retry-one.jsonl"));

  const result = await retryImport(id, baseOpts(home, config));
  expect(result).toEqual({ error: "session transcript is gone" });
  expect(tasks.get(id)?.importedClaude?.status).toBe("failed");
  expect(tasks.get(id)?.importedClaude?.error).toBe("session transcript is gone");
});

test("retry refuses a duplicate whose session claim belongs to another task", async () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const sessionId = `retry-dup-${winnerId.slice(0, 8)}`;
  const now = Date.now();
  const row = (id: string): Task => ({
    id,
    title: "imported",
    prompt: "please fix",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "ask",
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "review",
    runId: null,
    createdAt: now,
    updatedAt: now,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  });
  const provenance: ImportedClaudeSession = {
    sessionId,
    gitBranch: "main",
    importedAt: now,
    configDir: "/tmp/claude",
    status: "failed",
    backfillOffset: 0,
    error: "boom",
  };
  tasks.insert(row(winnerId));
  tasks.insert(row(loserId));
  tasks.setImportedClaude(winnerId, { ...provenance, status: "ready", error: null });
  db.run(
    `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
    [JSON.stringify(provenance), loserId],
  );
  try {
    const result = await retryImport(loserId);
    expect(result).toEqual({ error: IMPORTED_CLAUDE_HELD_ELSEWHERE });
    expect(tasks.get(loserId)?.importedClaude?.status).toBe("failed");
    expect(tasks.get(loserId)?.importedClaude?.error).toBe("boom");
    expect(tasks.findByImportedSessionId(sessionId)?.id).toBe(winnerId);
  } finally {
    db.run(`DELETE FROM tasks WHERE id IN (?, ?)`, [winnerId, loserId]);
  }
});

function importedRow(id: string, now: number): Task {
  return {
    id,
    title: "imported",
    prompt: "please fix",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "ask",
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "review",
    runId: null,
    createdAt: now,
    updatedAt: now,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

test("a claim-less duplicate left importing is marked failed without taking the session", async () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const sessionId = `boot-dup-${winnerId.slice(0, 8)}`;
  const now = Date.now();
  const provenance: ImportedClaudeSession = {
    sessionId,
    gitBranch: "main",
    importedAt: now,
    configDir: "/tmp/claude",
    status: "importing",
    backfillOffset: 0,
    error: null,
  };
  tasks.insert(importedRow(winnerId, now));
  tasks.insert(importedRow(loserId, now));
  tasks.setImportedClaude(winnerId, { ...provenance, status: "ready" });
  db.run(
    `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
    [JSON.stringify(provenance), loserId],
  );
  const home = scratchDir("cc-import-boot-dup-");
  try {
    await resumeIncompleteImports(baseOpts(home, path.join(home, ".claude")));
    await expect(pendingImportBackfill(loserId)).resolves.toBeUndefined();
    const loser = tasks.get(loserId);
    expect(loser?.importedClaude?.status).toBe("failed");
    expect(loser?.importedClaude?.error).toBe(IMPORTED_CLAUDE_HELD_ELSEWHERE);
    expect(loser?.runId ?? null).toBeNull();
    expect(runs.listForTask(loserId)).toHaveLength(0);
    const claim = db.query<{ imported_claude_session_id: string | null }, [string]>(
      `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
    ).get(loserId);
    expect(claim?.imported_claude_session_id).toBeNull();
    expect(tasks.findByImportedSessionId(sessionId)?.id).toBe(winnerId);
  } finally {
    db.run(`DELETE FROM runs WHERE task_id IN (?, ?)`, [winnerId, loserId]);
    db.run(`DELETE FROM tasks WHERE id IN (?, ?)`, [winnerId, loserId]);
  }
});

test("a claim write that loses the unique index still records the import as failed", async () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const sessionId = `race-dup-${winnerId.slice(0, 8)}`;
  const now = Date.now();
  const provenance: ImportedClaudeSession = {
    sessionId,
    gitBranch: "main",
    importedAt: now,
    configDir: "/tmp/claude",
    status: "importing",
    backfillOffset: 0,
    error: null,
  };
  tasks.insert(importedRow(winnerId, now));
  tasks.insert(importedRow(loserId, now));
  db.run(
    `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
    [JSON.stringify(provenance), loserId],
  );
  const original = tasks.setImportedClaude.bind(tasks);
  const home = scratchDir("cc-import-race-dup-");
  tasks.setImportedClaude = (taskId, value, opts) => {
    if (taskId === loserId && opts?.claim !== false) {
      tasks.setImportedClaude = original;
      original(winnerId, { ...provenance, status: "ready", error: null });
    }
    return original(taskId, value, opts);
  };
  try {
    await resumeIncompleteImports(baseOpts(home, path.join(home, ".claude")));
    await expect(pendingImportBackfill(loserId)).resolves.toBeUndefined();
    const loser = tasks.get(loserId);
    expect(loser?.importedClaude?.status).toBe("failed");
    expect(loser?.importedClaude?.error).toBe("session transcript is gone");
    const claim = db.query<{ imported_claude_session_id: string | null }, [string]>(
      `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
    ).get(loserId);
    expect(claim?.imported_claude_session_id).toBeNull();
    expect(tasks.findByImportedSessionId(sessionId)?.id).toBe(winnerId);
  } finally {
    tasks.setImportedClaude = original;
    db.run(`DELETE FROM runs WHERE task_id IN (?, ?)`, [winnerId, loserId]);
    db.run(`DELETE FROM tasks WHERE id IN (?, ?)`, [winnerId, loserId]);
  }
});

test("deleting the task mid-backfill does not throw, and a crashed import can resume", async () => {
  const home = scratchDir("cc-import-resume-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "gate-one", cwd });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = await importClaudeSessions(["gate-one"], { ...baseOpts(home, config), backfillGate: gate });
  const taskId = started.results[0]?.taskId;
  expect(taskId).toBeTruthy();
  tasks.delete(taskId!);
  release();
  await expect(pendingImportBackfill(taskId!)).resolves.toBeUndefined();

  const config2 = plant({ home, sessionId: "resume-one", cwd });
  const imported = await importClaudeSessions(["resume-one"], baseOpts(home, config2));
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  const ready = tasks.get(id)!;
  expect(ready.importedClaude?.status).toBe("ready");
  tasks.setImportedClaude(id, { ...ready.importedClaude!, status: "importing", backfillOffset: 0, error: null });
  await resumeIncompleteImports(baseOpts(home, config2));
  await pendingImportBackfill(id);
  expect(tasks.get(id)?.importedClaude?.status).toBe("ready");
});

function jsonlPath(config: string, cwd: string, sessionId: string): string {
  return path.join(config, "projects", plainEncodedProjectPath(cwd), `${sessionId}.jsonl`);
}

test("a batch parses each transcript once and backfill emits live events", async () => {
  const home = scratchDir("cc-import-once-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "once-a", cwd });
  plant({ home, sessionId: "once-b", cwd });
  const reads: string[] = [];
  const live: { taskId: string; stream: string }[] = [];
  const unsub = subscribe((event) => live.push({ taskId: event.taskId, stream: event.stream }));
  try {
    const imported = await importClaudeSessions(["once-a", "once-b"], {
      ...baseOpts(home, config),
      onJsonlRead: (file) => reads.push(file),
    });
    expect(imported.results.every((r) => r.taskId && !r.error)).toBe(true);
    for (const result of imported.results) await pendingImportBackfill(result.taskId!);
    expect(reads).toHaveLength(2);
    expect(new Set(reads).size).toBe(2);
    const taskIds = new Set(imported.results.map((r) => r.taskId));
    expect(live.some((event) => taskIds.has(event.taskId) && event.stream === "assistant")).toBe(true);
    expect(live.some((event) => taskIds.has(event.taskId) && event.stream === "user")).toBe(true);
  } finally {
    unsub();
  }
});

test("backfill persists its offset and a later resume continues from there", async () => {
  const home = scratchDir("cc-import-offset-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "slice-one", cwd });
  const file = jsonlPath(config, cwd, "slice-one");
  const size = statSync(file).size;
  const imported = await importClaudeSessions(["slice-one"], {
    ...baseOpts(home, config),
    sliceMs: 0,
    onBackfillProgress: () => { throw new Error("crash mid-backfill"); },
  });
  const id = imported.results[0]?.taskId;
  expect(id).toBeTruthy();
  await pendingImportBackfill(id!);
  const mid = tasks.get(id!)!;
  expect(mid.importedClaude?.status).toBe("failed");
  expect(mid.importedClaude!.backfillOffset).toBeGreaterThan(0);
  expect(mid.importedClaude!.backfillOffset).toBeLessThan(size);
  const runId = mid.runId!;
  expect(runs.seenLineUuidsForRun(runId).has("slice-one-user")).toBe(true);
  expect(runs.seenLineUuidsForRun(runId).has("slice-one-assistant")).toBe(false);
  tasks.setImportedClaude(id!, { ...mid.importedClaude!, status: "importing", error: null });
  await resumeIncompleteImports(baseOpts(home, config));
  await pendingImportBackfill(id!);
  const done = tasks.get(id!)!;
  expect(done.importedClaude?.status).toBe("ready");
  expect(done.importedClaude?.backfillOffset).toBe(size);
  expect(runs.seenLineUuidsForRun(runId).has("slice-one-assistant")).toBe(true);
});

test("provenance is stored before the seed run so a crash there can resume", async () => {
  const home = scratchDir("cc-import-order-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "order-one", cwd });
  const original = runs.insert.bind(runs);
  runs.insert = (run) => {
    if (run.origin === "imported" && run.claudeSessionId === "order-one") {
      throw new Error("crash before seed run");
    }
    return original(run);
  };
  try {
    const crashed = await importClaudeSessions(["order-one"], baseOpts(home, config));
    expect(crashed.results[0]).toEqual({ id: "order-one", error: "crash before seed run" });
    const task = tasks.list().find((t) => t.importedClaude?.sessionId === "order-one");
    expect(task?.importedClaude?.status).toBe("importing");
    expect(task?.runId ?? null).toBeNull();
    expect(runs.listForTask(task!.id).some((r) => r.origin === "imported")).toBe(false);
    const again = await importClaudeSessions(["order-one"], baseOpts(home, config));
    expect(again.results[0]?.error).toBe("session is already imported");
    expect(again.results[0]?.taskId).toBeUndefined();
    expect(tasks.list().filter((t) => t.workdir === cwd && t.importedClaude?.sessionId === "order-one")).toHaveLength(1);
  } finally {
    runs.insert = original;
  }
  const task = tasks.list().find((t) => t.importedClaude?.sessionId === "order-one")!;
  await resumeIncompleteImports(baseOpts(home, config));
  await pendingImportBackfill(task.id);
  const done = tasks.get(task.id)!;
  expect(done.importedClaude?.status).toBe("ready");
  expect(runs.get(done.runId!)?.origin).toBe("imported");
  expect(runs.get(done.runId!)?.claudeSessionId).toBe("order-one");
  expect(runs.seenLineUuidsForRun(done.runId!).has("order-one-user")).toBe(true);
});

test("bytes appended during the read are imported before the task is ready", async () => {
  const home = scratchDir("cc-import-grow-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "grow-one", cwd });
  const file = jsonlPath(config, cwd, "grow-one");
  let appended = false;
  const extra = JSON.stringify({
    type: "assistant",
    uuid: "grow-one-tail",
    message: { role: "assistant", content: [{ type: "text", text: "later" }] },
  }) + "\n";
  const imported = await importClaudeSessions(["grow-one"], {
    ...baseOpts(home, config),
    readChunk: async (read, buf, offset, length, position) => {
      const result = await read(buf, offset, length, position);
      if (!appended) {
        appended = true;
        appendFileSync(file, extra);
      }
      return result;
    },
  });
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  const task = tasks.get(id)!;
  expect(task.importedClaude?.status).toBe("ready");
  expect(task.importedClaude?.backfillOffset).toBe(statSync(file).size);
  expect(runs.seenLineUuidsForRun(task.runId!).has("grow-one-tail")).toBe(true);
});

test("a short read fails the import instead of marking the full transcript ready", async () => {
  const home = scratchDir("cc-import-short-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "short-one", cwd });
  const size = statSync(jsonlPath(config, cwd, "short-one")).size;
  expect(size).toBeGreaterThan(1);
  let first = true;
  const imported = await importClaudeSessions(["short-one"], {
    ...baseOpts(home, config),
    readChunk: async (read, buf, offset, length, position) => {
      if (!first) return { bytesRead: 0 };
      first = false;
      return read(buf, offset, Math.min(length, 1), position);
    },
  });
  const id = imported.results[0]?.taskId;
  expect(id).toBeTruthy();
  await pendingImportBackfill(id!);
  const task = tasks.get(id!)!;
  expect(task.importedClaude?.status).toBe("failed");
  expect(task.importedClaude?.error).toContain("short read");
  expect(task.importedClaude?.backfillOffset).toBe(0);
  expect(task.importedClaude!.backfillOffset).toBeLessThan(size);
  expect(runs.seenLineUuidsForRun(task.runId!).size).toBe(0);
});

test("backfill yields before a large transcript is fully read", async () => {
  const home = scratchDir("cc-import-stream-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const pad = "z".repeat(IMPORT_TRANSCRIPT_CHUNK_BYTES * 2);
  const config = plant({
    home,
    sessionId: "stream-one",
    cwd,
    lines: [
      {
        type: "user",
        uuid: "stream-one-user",
        cwd,
        gitBranch: "feature",
        timestamp: "2026-10-01T00:00:00.000Z",
        message: { role: "user", content: "please fix the login" },
      },
      {
        type: "assistant",
        uuid: "stream-one-assistant",
        timestamp: "2026-10-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: pad }],
          stop_reason: "end_turn",
        },
      },
    ],
  });
  const file = jsonlPath(config, cwd, "stream-one");
  const size = statSync(file).size;
  expect(size).toBeGreaterThan(IMPORT_TRANSCRIPT_CHUNK_BYTES);
  let readBytes = 0;
  let bytesAtFirstProgress = -1;
  const imported = await importClaudeSessions(["stream-one"], {
    ...baseOpts(home, config),
    sliceMs: 0,
    readChunk: async (read, buf, offset, length, position) => {
      const res = await read(buf, offset, length, position);
      readBytes += res.bytesRead;
      return res;
    },
    onBackfillProgress: () => {
      if (bytesAtFirstProgress < 0) bytesAtFirstProgress = readBytes;
    },
  });
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  expect(bytesAtFirstProgress).toBeGreaterThan(0);
  expect(bytesAtFirstProgress).toBeLessThanOrEqual(IMPORT_TRANSCRIPT_CHUNK_BYTES);
  expect(bytesAtFirstProgress).toBeLessThan(size);
  const task = tasks.get(id)!;
  expect(task.importedClaude?.status).toBe("ready");
  expect(task.importedClaude?.backfillOffset).toBe(size);
  expect(runs.seenLineUuidsForRun(task.runId!).has("stream-one-user")).toBe(true);
  expect(runs.seenLineUuidsForRun(task.runId!).has("stream-one-assistant")).toBe(true);
});

test("a transcript read one byte at a time still finishes", async () => {
  const home = scratchDir("cc-import-bytes-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "byte-one", cwd });
  const size = statSync(jsonlPath(config, cwd, "byte-one")).size;
  const imported = await importClaudeSessions(["byte-one"], {
    ...baseOpts(home, config),
    readChunk: (read, buf, offset, length, position) => read(buf, offset, Math.min(length, 1), position),
  });
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  const task = tasks.get(id)!;
  expect(task.importedClaude?.status).toBe("ready");
  expect(task.importedClaude?.backfillOffset).toBe(size);
  expect(runs.seenLineUuidsForRun(task.runId!).has("byte-one-assistant")).toBe(true);
});

test("a resume from a full offset does not replay, and a missing seed run is recreated", async () => {
  const home = scratchDir("cc-import-seed-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "skip-one", cwd });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = await importClaudeSessions(["skip-one"], { ...baseOpts(home, config), backfillGate: gate });
  const id = started.results[0]!.taskId!;
  const seeded = tasks.get(id)!;
  const size = statSync(jsonlPath(config, cwd, "skip-one")).size;
  tasks.setImportedClaude(id, { ...seeded.importedClaude!, backfillOffset: size });
  const oldRunId = seeded.runId!;
  db.run(`DELETE FROM runs WHERE id = ?`, [oldRunId]);
  tasks.update(id, { runId: null });
  release();
  await pendingImportBackfill(id);
  const done = tasks.get(id)!;
  expect(done.importedClaude?.status).toBe("ready");
  expect(done.runId).toBeTruthy();
  expect(done.runId).not.toBe(oldRunId);
  expect(runs.get(done.runId!)?.claudeSessionId).toBe("skip-one");
  expect(runs.seenLineUuidsForRun(done.runId!).has("skip-one-user")).toBe(false);
});
