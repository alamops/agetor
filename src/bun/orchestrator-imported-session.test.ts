import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportedClaudeSession, Task } from "../shared/types.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-imported-orch-"));
process.env.AGETOR_DATA_DIR ??= dataDir;
process.env.AGETOR_CLAUDE_DRIVER ??= "fake";
process.env.AGETOR_CLAUDE_BIN ??= "/bin/echo";
process.env.AGETOR_TMUX_BIN ??= "/bin/echo";

const { db, runs, tasks, IMPORTED_CLAUDE_HELD_ELSEWHERE } = await import("./db.ts");
const { sendInput, startTask } = await import("./orchestrator.ts");

function makeTask(taskId: string, workdir: string): Task {
  const now = Date.now();
  return {
    id: taskId,
    title: "imported",
    prompt: "please fix",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "ask",
    model: "claude-opus-4-7",
    effort: "medium",
    fast: false,
    maxMode: false,
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

function provenance(status: ImportedClaudeSession["status"], error: string | null = null): ImportedClaudeSession {
  return {
    sessionId: "sess-imported",
    gitBranch: "main",
    importedAt: Date.now(),
    configDir: "/tmp/claude",
    status,
    backfillOffset: 0,
    error,
  };
}

test("startTask on an imported task returns imported-session and inserts no run", async () => {
  const taskId = randomUUID();
  const workdir = mkdtempSync(path.join(tmpdir(), "cc-imported-wd-"));
  tasks.insert(makeTask(taskId, workdir));
  tasks.setImportedClaude(taskId, provenance("ready"));
  try {
    const before = runs.listForTask(taskId).length;
    const result = await startTask(taskId);
    expect(result).toEqual({
      error: "imported Claude session — send a message to continue",
      code: "imported-session",
    });
    expect(runs.listForTask(taskId)).toHaveLength(before);
    expect(tasks.get(taskId)?.column).toBe("review");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("sendInput refuses importing and failed sessions and resumes a ready one", async () => {
  const taskId = randomUUID();
  const runId = randomUUID();
  const workdir = mkdtempSync(path.join(tmpdir(), "cc-imported-send-"));
  const now = Date.now();
  tasks.insert({ ...makeTask(taskId, workdir), runId });
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: "sess-imported",
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "imported",
  });
  tasks.setImportedClaude(taskId, provenance("importing"));
  try {
    const importing = await sendInput(runId, "hello");
    expect(importing).toEqual({ delivered: false, reason: "still importing this session's history" });
    expect(runs.listForTask(taskId)).toHaveLength(1);

    tasks.setImportedClaude(taskId, provenance("failed", "disk full"));
    const failed = await sendInput(runId, "hello");
    expect(failed).toEqual({ delivered: false, reason: "disk full" });
    expect(runs.listForTask(taskId)).toHaveLength(1);

    tasks.setImportedClaude(taskId, provenance("ready"));
    const sent = await sendInput(runId, "please continue");
    expect(sent.delivered).toBe(true);
    if (!sent.delivered) return;
    expect(sent.runId).not.toBe(runId);
    const next = runs.get(sent.runId);
    expect(next?.claudeSessionId).toBe("sess-imported");
    const status = runs.events(sent.runId).find((e) => e.stream === "status" && e.data.includes("resuming claude session"));
    expect(status).toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    db.run(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)`, [taskId]);
    db.run(`DELETE FROM runs WHERE task_id = ?`, [taskId]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("sendInput refuses a duplicate whose session claim belongs to another task", async () => {
  const winnerId = randomUUID();
  const loserId = randomUUID();
  const runId = randomUUID();
  const sessionId = `dup-${winnerId.slice(0, 8)}`;
  const workdir = mkdtempSync(path.join(tmpdir(), "cc-imported-dup-"));
  const now = Date.now();
  const held = provenance("ready");
  held.sessionId = sessionId;
  tasks.insert(makeTask(winnerId, workdir));
  tasks.insert({ ...makeTask(loserId, workdir), runId, column: "review" });
  tasks.setImportedClaude(winnerId, held);
  db.run(
    `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
    [JSON.stringify({ ...held, status: "ready" }), loserId],
  );
  runs.insert({
    id: runId,
    taskId: loserId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: sessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "imported",
  });
  try {
    expect(tasks.get(loserId)?.importedClaude?.sessionId).toBe(sessionId);
    expect(tasks.importedSessionHeldElsewhere(loserId, sessionId)).toBe(true);
    const sent = await sendInput(runId, "please continue");
    expect(sent).toEqual({ delivered: false, reason: IMPORTED_CLAUDE_HELD_ELSEWHERE });
    expect(runs.listForTask(loserId)).toHaveLength(1);
    expect(tasks.get(loserId)?.column).toBe("review");
    expect(tasks.findByImportedSessionId(sessionId)?.id).toBe(winnerId);
  } finally {
    db.run(`DELETE FROM runs WHERE task_id IN (?, ?)`, [winnerId, loserId]);
    db.run(`DELETE FROM tasks WHERE id IN (?, ?)`, [winnerId, loserId]);
  }
});
