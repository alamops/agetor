import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// The boot restore's "JSONL may still appear" grace (orchestrator.ts
// `CLAUDE_JSONL_APPEAR_GRACE_MS`, claude-tmux.ts `jsonlWaitUntil`): a claude
// session spawned moments before the previous owner exited — the app taking
// the port from a background core mid-launch — has not written its JSONL yet.
// The new owner's restore waits for it (until the run's `started_at` + the
// grace) instead of killing a healthy session as "JSONL missing"; a run older
// than the grace is orphaned at once, as before.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-jsonl-wait-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// A config dir of our own, so a built-in (home-less) claude harness never
// resolves to the real ~/.claude.
const CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-jsonl-wait-config-"));
const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGETOR_TMUX_BIN: process.env.AGETOR_TMUX_BIN };

/** Every task id here starts with this, so the fake tmux reports only OUR
 *  sessions alive — a leftover `running` row from another file in the same
 *  `bun test` process is orphaned quickly instead of reattached. */
const ID_PREFIX = "jwait";
const cleanupTaskIds: string[] = [];
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  const dir = tempDir("agetor-jsonl-wait-tmux-");
  const bin = path.join(dir, "tmux");
  // has-session answers "alive" for agetor-jwait* only; everything else
  // (list-panes, kill-session, …) succeeds silently.
  writeFileSync(
    bin,
    "#!/bin/sh\n"
      + 'case " $* " in\n'
      + `  *" has-session "*) case "$*" in *agetor-${ID_PREFIX}*) exit 0;; *) exit 1;; esac;;\n`
      + "esac\n"
      + "exit 0\n",
  );
  chmodSync(bin, 0o755);
  process.env.AGETOR_TMUX_BIN = bin;
});

afterAll(async () => {
  const { deleteTask } = await import("./orchestrator.ts");
  const { dropSession } = await import("./claude-tmux.ts");
  const { db } = await import("./db.ts");
  for (const id of cleanupTaskIds) {
    await dropSession(id).catch(() => {});
    await deleteTask(id).catch(() => {});
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of tempDirs) rmTestDataDir(dir);
  rmTestDataDir(DATA_DIR);
  rmTestDataDir(CONFIG_DIR);
});

function newTaskId(): string {
  const id = `${ID_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 7)}-${randomUUID()}`;
  cleanupTaskIds.push(id);
  return id;
}

function baseTask(id: string, runId: string | null, workdir: string): Task {
  const now = Date.now();
  return {
    id,
    title: "jsonl wait",
    prompt: "p",
    column: "running",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** A JSONL with one user line: a session mid-turn (no end_turn), so a
 *  reattached run stays `running`. */
function writeJsonl(jsonlPath: string): void {
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  writeFileSync(
    jsonlPath,
    JSON.stringify({ type: "user", uuid: `u-${randomUUID()}`, message: { role: "user", content: "hi" } }) + "\n",
  );
}

async function reattachInputs() {
  const { tasks } = await import("./db.ts");
  const { jsonlPathFor } = await import("./claude-tmux.ts");
  const taskId = newTaskId();
  const cwd = tempDir("agetor-jsonl-wait-cwd-");
  const sessionId = randomUUID();
  tasks.insert(baseTask(taskId, null, cwd));
  return { taskId, cwd, sessionId, jsonlPath: jsonlPathFor(cwd, sessionId, CONFIG_DIR) };
}

test("reattachSession with no wait reports a missing JSONL at once", async () => {
  const { reattachSession, dropSession } = await import("./claude-tmux.ts");
  const { taskId, cwd, sessionId } = await reattachInputs();
  const t0 = Date.now();
  const agent = await reattachSession({
    taskId,
    cwd,
    sessionId,
    configDir: CONFIG_DIR,
    onChunk: () => {},
    seenLineUuids: new Set(),
  });
  expect(agent).toBeNull();
  expect(Date.now() - t0).toBeLessThan(200);
  await dropSession(taskId);
});

test("reattachSession waits for a JSONL that appears before jsonlWaitUntil, and attaches to it", async () => {
  const { reattachSession, dropSession } = await import("./claude-tmux.ts");
  const { taskId, cwd, sessionId, jsonlPath } = await reattachInputs();
  setTimeout(() => writeJsonl(jsonlPath), 400);
  const t0 = Date.now();
  const agent = await reattachSession({
    taskId,
    cwd,
    sessionId,
    configDir: CONFIG_DIR,
    onChunk: () => {},
    seenLineUuids: new Set(),
    jsonlWaitUntil: Date.now() + 5_000,
  });
  const waited = Date.now() - t0;
  expect(agent).not.toBeNull();
  expect(waited).toBeGreaterThanOrEqual(350);
  // It returned once the file appeared, not at the deadline.
  expect(waited).toBeLessThan(3_000);
  await dropSession(taskId);
});

test("reattachSession gives up at jsonlWaitUntil when the JSONL never appears", async () => {
  const { reattachSession, dropSession } = await import("./claude-tmux.ts");
  const { taskId, cwd, sessionId } = await reattachInputs();
  const t0 = Date.now();
  const agent = await reattachSession({
    taskId,
    cwd,
    sessionId,
    configDir: CONFIG_DIR,
    onChunk: () => {},
    seenLineUuids: new Set(),
    jsonlWaitUntil: Date.now() + 500,
  });
  const waited = Date.now() - t0;
  expect(agent).toBeNull();
  expect(waited).toBeGreaterThanOrEqual(450);
  expect(waited).toBeLessThan(2_500);
  await dropSession(taskId);
});

test("the grace is sized past claude's own boot timeout", async () => {
  const { CLAUDE_JSONL_APPEAR_GRACE_MS } = await import("./orchestrator.ts");
  const { CLAUDE_BOOT_TIMEOUT_MS } = await import("./claude-tmux.ts");
  expect(CLAUDE_JSONL_APPEAR_GRACE_MS).toBeGreaterThan(CLAUDE_BOOT_TIMEOUT_MS);
});

/** A `running` claude run row (with a live session) whose JSONL is missing. */
async function seedRunningClaudeRun(startedAt: number) {
  const { tasks, runs } = await import("./db.ts");
  const { jsonlPathFor, sessionNameFor } = await import("./claude-tmux.ts");
  const taskId = newTaskId();
  const runId = `run-${randomUUID()}`;
  const sessionId = randomUUID();
  const cwd = tempDir("agetor-jsonl-wait-cwd-");
  tasks.insert(baseTask(taskId, runId, cwd));
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt,
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: sessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  // The built-in harness has no home: the restore resolves CLAUDE_CONFIG_DIR.
  return { taskId, runId, jsonlPath: jsonlPathFor(cwd, sessionId, null) };
}

test("boot restore: a run started moments ago is reattached once its late JSONL appears, not orphaned", async () => {
  const { reconcileOrphans, deleteTask, CLAUDE_JSONL_APPEAR_GRACE_MS } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  // Still inside the grace, but with its deadline ~4 s out, so a regression
  // where the JSONL is never seen costs seconds, not the whole 35 s grace.
  const seeded = await seedRunningClaudeRun(Date.now() - CLAUDE_JSONL_APPEAR_GRACE_MS + 4_000);
  try {
    expect(seeded.jsonlPath.startsWith(CONFIG_DIR)).toBe(true);

    setTimeout(() => writeJsonl(seeded.jsonlPath), 500);
    const t0 = Date.now();
    await reconcileOrphans();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(runs.get(seeded.runId)?.status).toBe("running");
  } finally {
    // Gone before the next restore, which would otherwise visit it again —
    // and torn down even when an assertion above failed.
    await deleteTask(seeded.taskId);
  }
}, 15_000);

test("boot restore: a run older than the grace whose JSONL is missing is orphaned without waiting", async () => {
  const { reconcileOrphans, CLAUDE_JSONL_APPEAR_GRACE_MS } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  const seeded = await seedRunningClaudeRun(Date.now() - CLAUDE_JSONL_APPEAR_GRACE_MS - 5_000);

  const t0 = Date.now();
  await reconcileOrphans();
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect(runs.get(seeded.runId)?.status).toBe("orphaned");
  expect(tasks.get(seeded.taskId)?.column).toBe("ready");
});
