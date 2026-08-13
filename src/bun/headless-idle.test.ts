import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — a `beforeAll`
// hook would race with any sibling test file that already imported db.ts in
// this process (worktrees-list.test.ts's identical convention). Every test
// below reaches `./headless.ts`/`./db.ts`/`./orchestrator.ts` only through a
// dynamic `await import(...)` inside the test body, so this assignment is
// guaranteed to run first.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-headless-idle-test-"));
// Drive claude through the in-process fake driver instead of tmux + the real
// CLI, so `createTask`'s agent-status preflight passes without claude/tmux
// installed.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

/**
 * Unit tests for the headless daemon's idle-work predicate
 * (`hasRunningWork` in `src/bun/headless.ts`, and its `subagents.hasAnyRunning`
 * building block in `src/bun/db.ts`) — WITHOUT booting the daemon.
 * `daemon-boot.test.ts` / `daemon-handoff.test.ts` spawn `bun src/bun/headless.ts`
 * as a real subprocess to exercise the whole listen/idle-shutdown lifecycle;
 * this file instead imports `./headless.ts` in-process. That's safe because
 * `runDaemon()` (the only code with real side effects — binding a port,
 * writing creds, arming timers) is gated behind `if (import.meta.main)` at
 * the bottom of the module, which is false for a module reached via `import`
 * rather than `bun run`. Importing still opens the sqlite db (via `./db.ts`),
 * which is exactly why `AGETOR_DATA_DIR` must be set above before any import.
 *
 * `hasRunningWork` takes no arguments and reads the whole db (no task
 * scoping), so every test below creates its own task and deletes it in a
 * `finally` — `tasks(id)` cascades to both `runs` and `subagents` rows
 * (`ON DELETE CASCADE`, migrations 001/022) — to avoid leaking rows that
 * would make a later "false" assertion flaky.
 */

/** Mirrors session-reaper.test.ts's `createClaudeTask` helper: worktree
 *  isolation off, so no real git branch/worktree is materialized in the repo
 *  running the test suite (see the worktree-isolation warning in CLAUDE.md). */
async function createClaudeTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

test("hasRunningWork is false against an empty db", async () => {
  const { hasRunningWork } = await import("./headless.ts");
  expect(hasRunningWork()).toBe(false);
});

test("a running run row makes hasRunningWork true", async () => {
  const { hasRunningWork } = await import("./headless.ts");
  const { db, runs } = await import("./db.ts");

  const task = await createClaudeTask("running run row");
  const taskId = task.id;
  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });

  try {
    expect(hasRunningWork()).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("a recent running subagent row makes hasRunningWork true with zero running runs", async () => {
  const { hasRunningWork } = await import("./headless.ts");
  const { db, subagents } = await import("./db.ts");

  const task = await createClaudeTask("running subagent row");
  const taskId = task.id;
  const agentId = `held-${randomUUID()}`;

  try {
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null,
      parentKind: "subagent",
      agentType: "Explore",
      description: "still working",
      spawnDepth: 1,
      sourcePath: `/tmp/agent-${agentId}.jsonl`,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });

    // The feature's core assertion: no running run row, yet a running
    // background agent alone is enough to report work in flight.
    expect(hasRunningWork()).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("settling the running subagent row makes hasRunningWork false again", async () => {
  const { hasRunningWork } = await import("./headless.ts");
  const { db, subagents } = await import("./db.ts");

  const task = await createClaudeTask("settled subagent row");
  const taskId = task.id;
  const agentId = `settle-${randomUUID()}`;

  try {
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null,
      parentKind: "subagent",
      agentType: "Explore",
      description: "about to finish",
      spawnDepth: 1,
      sourcePath: `/tmp/agent-${agentId}.jsonl`,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });
    expect(hasRunningWork()).toBe(true);

    subagents.setStatus(agentId, "completed", Date.now());
    expect(hasRunningWork()).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("a running subagent row started past the 6h hold ceiling does not hold the daemon up", async () => {
  const { hasRunningWork } = await import("./headless.ts");
  const { db, subagents } = await import("./db.ts");

  // Mirrors headless.ts's own SUBAGENT_HOLD_MAX_MS (6h, not exported) — a
  // wedged row (a workflow container row, which never hits the
  // STALE_SUBAGENT_SETTLE_MS backstop, or an AGETOR_TRACK_SUBAGENTS=0
  // no-op stub) must eventually stop pinning the daemon alive.
  const SUBAGENT_HOLD_MAX_MS = 6 * 60 * 60 * 1000;

  const task = await createClaudeTask("wedged subagent row");
  const taskId = task.id;
  const agentId = `wedged-${randomUUID()}`;

  try {
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null,
      parentKind: "workflow",
      agentType: null,
      description: "wedged workflow container",
      spawnDepth: 1,
      sourcePath: `/tmp/workflow-${agentId}`,
      status: "running",
      startedAt: Date.now() - SUBAGENT_HOLD_MAX_MS - 60_000,
      endedAt: null,
    });

    expect(hasRunningWork()).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("subagents.hasAnyRunning: started_at > cutoff boundary, and the no-cutoff overload sees any running row", async () => {
  const { db, subagents } = await import("./db.ts");

  const task = await createClaudeTask("hasAnyRunning cutoff boundary");
  const taskId = task.id;
  const agentId = `cutoff-${randomUUID()}`;
  const now = Date.now();
  const startedAt = now - 1000;

  try {
    subagents.insertIfAbsent({
      id: agentId,
      taskId,
      runId: null,
      parentKind: "subagent",
      agentType: "Explore",
      description: "cutoff probe",
      spawnDepth: 1,
      sourcePath: `/tmp/agent-${agentId}.jsonl`,
      status: "running",
      startedAt,
      endedAt: null,
    });

    // startedAt (now-1000) is after a cutoff of now-5000 → in range.
    expect(subagents.hasAnyRunning(now - 5000)).toBe(true);
    // startedAt (now-1000) is NOT after a cutoff of now-500 → excluded.
    expect(subagents.hasAnyRunning(now - 500)).toBe(false);
    // No-arg overload: any running row, regardless of age.
    expect(subagents.hasAnyRunning()).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});
