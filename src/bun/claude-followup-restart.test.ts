import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Regression test for the follow-up-after-restart path. Boot reconciliation no
// longer sweeps idle `agetor-*` sessions, so an idle claude session can now
// outlive the agetor process with NO in-memory SessionState. Sending a
// follow-up to such a task must route through `spawnResumedSession`
// (`claude --resume`) — NOT `sendTurn`, which rejects with "no live session".
//
// Uses real tmux to construct the survivor (a live session with no state), so
// it must NOT stub AGETOR_TMUX_BIN. We also force the real spawn path
// (AGETOR_CLAUDE_DRIVER unset) and point AGETOR_CLAUDE_BIN at /bin/echo so the
// resumed session's launch command is harmless and exits immediately. Env is
// scoped to beforeAll/afterAll (restored) so it can't leak into sibling files.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-followup-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

/** Real tmux resolvable on THIS process's PATH? This file needs the genuine
 *  binary (see the header — it can't stub AGETOR_TMUX_BIN), but an agent's
 *  non-interactive shell often lacks /opt/homebrew/bin, and `Bun.spawnSync`
 *  then THROWS ENOENT mid-test — a false hard failure. Skip (visibly) instead:
 *  on any machine that can actually run agetor, tmux is present and the test
 *  runs; only PATH-stripped harness shells skip. */
const HAVE_TMUX = (() => {
  try {
    return Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
  } catch {
    return false;
  }
})();
if (!HAVE_TMUX) {
  console.warn("[claude-followup-restart.test] tmux not on PATH — skipping real-tmux test");
}

const saved: Record<string, string | undefined> = {};
function restore(key: string) {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
}

beforeAll(async () => {
  for (const k of ["AGETOR_TMUX_BIN", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN"]) {
    saved[k] = process.env[k];
  }
  delete process.env.AGETOR_TMUX_BIN; // force real tmux (need a real survivor session)
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless launch command
  await import("./db.ts");
});

afterAll(() => {
  restore("AGETOR_TMUX_BIN");
  restore("AGETOR_CLAUDE_DRIVER");
  restore("AGETOR_CLAUDE_BIN");
});

test.skipIf(!HAVE_TMUX)("follow-up to a task whose session outlived the process resumes instead of rejecting", async () => {
  const { db, tasks, runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { sessionNameFor, dropSession } = await import("./claude-tmux.ts");
  // Dynamic import (not top-level) so db.ts — which tmux-resolution.ts pulls
  // in and which opens on module load — can't load before AGETOR_DATA_DIR is
  // set at the top of this file.
  const { tmuxSocketArgs } = await import("./tmux-resolution.ts");

  const taskId = `task-followup-${randomUUID()}`;
  const priorRunId = `run-followup-${randomUUID()}`;
  const sessionName = sessionNameFor(taskId);
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-followup-wd-"));

  // Simulate a claude REPL that survived an agetor restart: a real tmux session
  // with the task's deterministic name, created OUTSIDE agetor so there is no
  // in-memory SessionState for it. Must use the same socket args as the code
  // under test (`agetor-test` under bun test) — the follow-up path probes and
  // kills on the isolated socket, so a survivor created on the default socket
  // would be invisible to it (and would pollute the user's real tmux server).
  const create = Bun.spawnSync([
    "tmux",
    ...tmuxSocketArgs(),
    "new-session",
    "-d",
    "-s",
    sessionName,
    "--",
    "sleep",
    "30",
  ]);
  expect(create.exitCode).toBe(0);

  try {
    // Task in `review` with a prior succeeded run carrying a claude session id —
    // reconcile would NOT reattach this (it isn't `running`), so no state.
    tasks.insert({
      id: taskId,
      title: "resumed",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      branch: null,
      worktreePath: null,
      baseRef: null,
      mode: null,
      // buildCommand requires a model + effort for claude-code; the values are
      // inert here since AGETOR_CLAUDE_BIN=/bin/echo makes the launch a no-op.
      model: "claude-opus-4-7",
      effort: "medium",
      references: [],
      backlog: [],
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: sessionName,
      claudeSessionId: "prior-claude-session-id",
      codexSessionId: null,
      kimiSessionId: null,
    });

    const result = await sendInput(priorRunId, "please continue");
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error(result.reason);

    // A fresh run row for the follow-up turn.
    const newRunId = result.runId;
    expect(newRunId).not.toBe(priorRunId);

    const events = db
      .query<{ stream: string; data: string }, [string]>(
        `SELECT stream, data FROM run_events WHERE run_id = ?`,
      )
      .all(newRunId);

    // Proof we took the spawnResumedSession route (emitted synchronously before
    // the spawn), and NOT the sendTurn reject path.
    const resumed = events.some(
      (e) => e.stream === "status" && /resuming claude session|starting fresh/.test(e.data),
    );
    const rejected = events.some((e) => e.data.includes("no live session for task"));
    expect(resumed).toBe(true);
    expect(rejected).toBe(false);
  } finally {
    // Dispose any state + kill whatever session is now named for this task
    // (the survivor, or the short-lived echo session the resume spawned).
    dropSession(taskId);
  }
});
