import { test, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Regression test for the `priorApiError` pre-seed filter in
// `reconcileOrphans` (src/bun/orchestrator.ts ~line 355): since #81, subagent
// tailers persist their OWN api-error status rows under the parent run's id
// (subagent_id set to the sidechain's id, not NULL). Before this fix the
// query matched any `data LIKE 'api error: %'` row for the run regardless of
// which tailer wrote it, so a background subagent's transient 429/529 would
// wrongly seed `handle.apiError = true` on a healthy reattached MAIN run,
// settling it `failed` -> `blocked` even though the top-level session never
// hit an API error itself. The fix adds `AND subagent_id IS NULL` so only the
// main tailer's own api-error rows can pre-seed the flag.
//
// A full reconcileOrphans() reattach needs a live tmux session + a real
// claude JSONL fixture (see reconcile.test.ts's "reattach pre-seed SQL" test,
// which already exercises the un-scoped predecessor of this same query end to
// end via the SQL-replication approach — full reattach wiring is covered
// there and in reconcile-session.test.ts). Per the task brief that's
// disproportionate for testing one predicate, so — mirroring reconcile.test.ts's
// existing "reattach pre-seed SQL" test — this drives the exact EXISTS query
// `reconcileOrphans` runs directly against seeded run_events rows, asserting
// it returns 0 for a subagent-tagged api-error row and 1 for a main-tailer
// (subagent_id IS NULL) one.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-reconcile-subagent-apierror-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

beforeAll(async () => {
  await import("./db.ts");
});

/** Verbatim copy of the query `reconcileOrphans` runs to pre-seed
 *  `handle.apiError` on reattach — see orchestrator.ts's `priorApiError`. */
function priorApiError(db: typeof import("./db.ts").db, runId: string, prefix: string): 0 | 1 {
  return db.query<{ found: 0 | 1 }, [string, string]>(
    `SELECT EXISTS(
       SELECT 1 FROM run_events
       WHERE run_id = ? AND stream = 'status' AND data LIKE ? AND subagent_id IS NULL
     ) AS found`,
  ).get(runId, `${prefix}%`)?.found ?? 0;
}

test("priorApiError query ignores a subagent-tagged api-error row (subagent_id set)", async () => {
  const { db, runs, tasks } = await import("./db.ts");
  const { CLAUDE_API_ERROR_STATUS_PREFIX } = await import("./claude-tmux.ts");

  const taskId = `task-subagent-apierror-${randomUUID()}`;
  const runId = `run-subagent-apierror-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "x",
    prompt: "p",
    // Not 'running' so a sibling test's later reconcileOrphans() call in this
    // shared bun-test process can't re-orphan this row — the query under
    // test only reads run_events, not runs.status.
    column: "blocked",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [], backlog: [],
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "failed",
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null, grokSessionId: null,
  });

  // A subagent tailer's own api-error status row, persisted under the
  // PARENT run's id with a non-null subagent_id — this is exactly the #81
  // shape the fix must exclude.
  runs.appendEvent(
    runId,
    "status",
    `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted`,
    null,
    "agent-x",
  );

  expect(priorApiError(db, runId, CLAUDE_API_ERROR_STATUS_PREFIX)).toBe(0);
});

test("priorApiError query matches a main-tailer api-error row (subagent_id NULL)", async () => {
  const { db, runs, tasks } = await import("./db.ts");
  const { CLAUDE_API_ERROR_STATUS_PREFIX } = await import("./claude-tmux.ts");

  const taskId = `task-main-apierror-${randomUUID()}`;
  const runId = `run-main-apierror-${randomUUID()}`;
  const now = Date.now();
  tasks.insert({
    id: taskId,
    title: "x",
    prompt: "p",
    column: "blocked",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: null,
    model: null,
    effort: null,
    references: [], backlog: [],
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "failed",
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null, grokSessionId: null,
  });

  // The main tailer's own api-error status row — subagent_id explicitly
  // NULL (the default `appendEvent` writes when no subagentId is passed).
  runs.appendEvent(runId, "status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted`);

  expect(priorApiError(db, runId, CLAUDE_API_ERROR_STATUS_PREFIX)).toBe(1);
});
