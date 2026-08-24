import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/*
 * TT3 (docs/plans/claude-code-monitors-hold-running.md, §3 "Monitor-aware
 * receipt rule" / "Pane regex sweep", §5 TT3): proves two independent things
 * about the live (non-restart-safe) Monitor path —
 *
 *   (a) `dispatchLine` (claude-tmux.ts) forwards the RAW `<task-notification>`
 *       payload it extracted (`taskNotificationContent`) to whatever handler
 *       is currently installed via `setBackgroundTaskSettledHandler`, for
 *       BOTH shapes claude uses to report a background completion/event
 *       (`queue-operation`/`enqueue` and `user`/`origin.kind=task-notification`).
 *       This is a pure claude-tmux.ts contract test — it never touches the
 *       orchestrator or the DB.
 *
 *   (b) the REAL handler orchestrator.ts installs at module load —
 *       `(taskId, agentId, body) => handleBackgroundTaskNotification(taskId,
 *       agentId, body)` (claude-subagents.ts) — applies the monitor-aware
 *       terminal-vs-activity rule end to end against the real DB/hold
 *       predicate: a non-terminal Monitor body leaves the row (and the held
 *       task) `running`; a terminal body (`<status>` completed/failed/
 *       killed/stopped, or an `<event>` matching `MONITOR_TERMINAL_EVENT_RE`)
 *       settles it and releases the hold. A non-monitor (`bg_session`) row
 *       keeps the exact pre-existing behavior — any body naming its id
 *       settles it — as a regression guard on the contract change.
 *
 *   (c) the pane scraper's `WORKING_LINE_RE` reads "N monitors still
 *       running" (and its status-bar `· N monitor(s) ·` item) as busy,
 *       mirroring the existing shells arms, while NOT over-matching prose
 *       that merely mentions the word "monitor" or a status bar with no
 *       monitor count at all.
 *
 * Harness idioms borrowed from the templates named in this task's brief:
 *   - claude-continuation.test.ts: `AGETOR_DATA_DIR` set at module top
 *     (before the dynamic `await import("./claude-tmux.ts")`, since db.ts is
 *     a transitive import and captures the env var at first load), the
 *     `__forTest.installSession`/`dispatchLine` harness for driving the
 *     tailer against a synthetic session with no real tmux/JSONL tailing,
 *     and the read-modify-restore idiom for `setBackgroundTaskSettledHandler`.
 *   - workflow-hold.test.ts: `ENV_OVERRIDES` + `beforeAll(() =>
 *     import("./orchestrator.ts"))` to install the REAL orchestrator wiring,
 *     `createClaudeTask`/`wait`/the `createdTaskIds` + `afterEach` hard-delete
 *     (this process's `bun test` run shares ONE SQLite DB across every
 *     `*.test.ts` file — see that file's header — so every task created here
 *     must be tracked and torn down), and capturing the real
 *     `setBackgroundTaskSettledHandler` handler through the setter seam
 *     (`const real = setBackgroundTaskSettledHandler(() => {}); setBackgroundTaskSettledHandler(real);`)
 *     to invoke it directly exactly like a live `<task-notification>` line
 *     would.
 *   - claude-tmux-scraper.test.ts: the `WORKING_PANE_LINES` truth-table
 *     pattern for `paneShowsClaudeWorking`/`WORKING_LINE_RE`.
 *
 * Synthetic ids only — no ticket ids or real transcript content.
 */

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-monitor-test-"));

const { __forTest, setBackgroundTaskSettledHandler } = await import("./claude-tmux.ts");

// ─── (a) live dispatchLine forwarding — no DB, no orchestrator ────────────

function freshSession(): { taskId: string; jsonlPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-monitor-sess-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  return { taskId: randomUUID(), jsonlPath };
}

/** The `queue-operation`/`enqueue` shape claude uses to report a background
 *  command/agent/monitor event — mirrors `queueOperationLine` in
 *  claude-continuation.test.ts. */
function queueOperationMonitorLine(content: string, uuid?: string): string {
  return JSON.stringify({ type: "queue-operation", operation: "enqueue", uuid, content }) + "\n";
}

/** The `user`/`origin.kind=task-notification` shape claude also uses for the
 *  same signal — mirrors `taskNotificationLine` in claude-continuation.test.ts,
 *  parameterized on the full content string (rather than just a task tag)
 *  since these tests need to embed an `<event>` block too. */
function userTaskNotificationLine(content: string, uuid?: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    origin: { kind: "task-notification" },
    message: { content },
  }) + "\n";
}

test("dispatchLine forwards a live monitor event (queue-operation/enqueue shape) to the installed background-task-settled handler with the raw payload", () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  const monitorId = `mon-${randomUUID()}`;
  const eventText = "tail -f build.log: 40 new lines appended";
  const content =
    `<task-notification><task-id>${monitorId}</task-id>`
    + `<summary>Monitor event: "watch build"</summary><event>${eventText}</event></task-notification>`;
  const calls: { taskId: string; agentId: string; body: string }[] = [];
  const prev = setBackgroundTaskSettledHandler((tid, agentId, body) => {
    calls.push({ taskId: tid, agentId, body });
  });
  try {
    __forTest.dispatchLine(state, queueOperationMonitorLine(content, "uuid-mon-enqueue"));

    expect(calls.length).toBe(1);
    expect(calls[0]!.taskId).toBe(taskId);
    expect(calls[0]!.agentId).toBe(monitorId);
    expect(calls[0]!.body).toBe(content);
    expect(calls[0]!.body).toContain(`<task-id>${monitorId}</task-id>`);
    expect(calls[0]!.body).toContain(eventText);
  } finally {
    setBackgroundTaskSettledHandler(prev);
    __forTest.uninstallSession(taskId);
  }
});

test("dispatchLine forwards a live monitor event (user/origin.kind=task-notification shape) to the installed background-task-settled handler with the raw payload", () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  const monitorId = `mon-${randomUUID()}`;
  const eventText = "still waiting on the deploy webhook";
  const content =
    `<task-notification><task-id>${monitorId}</task-id>`
    + `<summary>Monitor event: "watch deploy"</summary><event>${eventText}</event></task-notification>`;
  const calls: { taskId: string; agentId: string; body: string }[] = [];
  const prev = setBackgroundTaskSettledHandler((tid, agentId, body) => {
    calls.push({ taskId: tid, agentId, body });
  });
  try {
    __forTest.dispatchLine(state, userTaskNotificationLine(content, "uuid-mon-user"));

    expect(calls.length).toBe(1);
    expect(calls[0]!.taskId).toBe(taskId);
    expect(calls[0]!.agentId).toBe(monitorId);
    expect(calls[0]!.body).toBe(content);
    expect(calls[0]!.body).toContain(`<task-id>${monitorId}</task-id>`);
    expect(calls[0]!.body).toContain(eventText);
  } finally {
    setBackgroundTaskSettledHandler(prev);
    __forTest.uninstallSession(taskId);
  }
});

// ─── (b) live path end-to-end through the REAL orchestrator handler ───────

// Every OTHER env override is scoped to this file and restored afterwards —
// see workflow-hold.test.ts / subagent-hold.test.ts's header comments for why
// a top-level `process.env.X =` would leak into sibling test files sharing
// this one `bun test` process.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake", // in-process fake instead of tmux + the real CLI
  AGETOR_CLAUDE_BIN: "/bin/echo", // agent-status preflight passes without claude
  AGETOR_TMUX_BIN: "/bin/echo", // tmux probe in agent-status passes
  AGETOR_CLAUDE_ARGS: "",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // Importing orchestrator.ts is what installs the REAL
  // `setBackgroundTaskSettledHandler((taskId, agentId, body) =>
  // handleBackgroundTaskNotification(taskId, agentId, body))` wiring at
  // module load — the scenarios below drive through that seam rather than
  // importing claude-subagents.ts's handler directly.
  await import("./orchestrator.ts");
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

// Shared-DB hygiene: `bun test` runs every `*.test.ts` file in one process
// against one SQLite DB (see workflow-hold.test.ts's header). Every task
// created here is tracked and hard-deleted in `afterEach` — FK ON DELETE
// CASCADE covers runs/subagents/run_events, so the monitor/bg_session rows
// inserted below need no separate cleanup.
const createdTaskIds: string[] = [];

afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createClaudeTask(title: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo during tests
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

test("live orchestrator wiring: a non-terminal monitor body leaves the row and task running; a terminal body settles it and releases the hold", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");

  const taskId = await createClaudeTask("monitor-hold-basic");
  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");

  // Insert the monitor row synchronously, right after `startTask` returns —
  // no `await` intervenes, so this DB write lands well before the fake
  // driver's earliest scheduled chunk (its soonest `setTimeout` is several
  // ms out) and long before its "turn complete" settlement. This is what
  // makes the orchestrator's end-of-turn hold predicate
  // (`subagents.hasRunning(taskId)`, orchestrator.ts ~1396-1402) see the row
  // deterministically — mirrors the real driver's timing (a Monitor's launch
  // stub lands on disk mid-turn, well before `end_turn`), not a race.
  const monitorId = `mon-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: monitorId,
    taskId,
    runId: res.runId,
    parentKind: "monitor",
    agentType: "monitor",
    description: "test monitor",
    spawnDepth: 1,
    sourcePath: "",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });

  await wait(250); // let the fake driver's turn resolve

  // Held shape: the run succeeded, but the running monitor row keeps the
  // task in `running` instead of `review`.
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const real = setBackgroundTaskSettledHandler(() => {});
  setBackgroundTaskSettledHandler(real);
  if (!real) throw new Error("expected orchestrator.ts to have installed a real background-task-settled handler");

  // Non-terminal: an ordinary Monitor event — no <status> tag, and the
  // <event> text doesn't match MONITOR_TERMINAL_EVENT_RE. This is exactly
  // what dispatchLine forwards for every intermediate event a live Monitor
  // reports; it must NOT be treated as a completion receipt.
  real(
    taskId,
    monitorId,
    `<task-notification>\n<task-id>${monitorId}</task-id>\n<event>build still running</event>\n</task-notification>`,
  );

  expect(subagents.get(monitorId)?.status).toBe("running");
  expect(tasks.get(taskId)?.column).toBe("running");

  // Terminal: the verified live shape for a timed-out Monitor
  // (docs/plans/claude-code-monitors-hold-running.md §2: "same envelope with
  // `<event>[Monitor timed out — re-arm if needed.]</event>`").
  real(
    taskId,
    monitorId,
    `<task-notification>\n<task-id>${monitorId}</task-id>\n<event>[Monitor timed out — re-arm if needed.]</event>\n</task-notification>`,
  );

  expect(subagents.get(monitorId)?.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("live orchestrator wiring: a bg_session row still settles unconditionally on any notification body (regression guard for the unchanged path)", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");

  const taskId = await createClaudeTask("monitor-bgsession-regression");
  const bgId = `bg-${randomUUID()}`;
  // Inserted BEFORE startTask, runId: null — `hasRunning` only keys off
  // task_id (see workflow-hold.test.ts's `insertRunningContainer`), and
  // `settleSubagentById` (the unconditional path a non-monitor kind still
  // takes) never reads `row.runId` either.
  subagents.insertIfAbsent({
    id: bgId,
    taskId,
    runId: null,
    parentKind: "bg_session",
    agentType: "bg_session",
    description: "test bg session",
    spawnDepth: 1,
    sourcePath: "",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const real = setBackgroundTaskSettledHandler(() => {});
  setBackgroundTaskSettledHandler(real);
  if (!real) throw new Error("expected orchestrator.ts to have installed a real background-task-settled handler");

  // A body shaped like it would be "non-terminal" for a Monitor (no
  // <status>, and the <event> text doesn't match MONITOR_TERMINAL_EVENT_RE)
  // — but this row isn't parentKind "monitor", so handleBackgroundTaskNotification
  // never applies the terminal-vs-activity rule to it: any body naming its
  // id is still, unconditionally, its completion receipt (today's exact
  // pre-existing behavior for a bg-shell/session id).
  real(
    taskId,
    bgId,
    `<task-notification>\n<task-id>${bgId}</task-id>\n<event>some ordinary progress line</event>\n</task-notification>`,
  );

  expect(subagents.get(bgId)?.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

// ─── (c) pane scrape: "N monitors still running" reads as busy ────────────

const { WORKING_LINE_RE, paneShowsClaudeWorking } = __forTest;

/** Real capture shapes lifted from `WORKING_LINE_RE`'s own doc comment
 *  (claude-tmux.ts ~3983-3990): the elapsed-summary spinner line with a live
 *  monitor count, and the auto-mode status bar's `· N monitor ·` item. The
 *  present-participle variant is a synthetic combination (spinner form +
 *  monitor count) exercising the same `\d+\s+monitors?\s+still\s+running`
 *  arm independent of what precedes it. */
const MONITOR_WORKING_LINES = [
  "✻ Cooked for 4m 32s · 2 monitors still running",
  "✻ Waiting… · 1 monitor still running",
  "⏵⏵ auto mode on · 1 monitor · esc to interrupt · ← 4 agents · ↓ to manage",
];

for (const line of MONITOR_WORKING_LINES) {
  test(`paneShowsClaudeWorking / WORKING_LINE_RE — true for a busy monitor pane line: ${JSON.stringify(line)}`, () => {
    expect(WORKING_LINE_RE.test(line)).toBe(true);
    expect(paneShowsClaudeWorking(line)).toBe(true);
    // Also true when the line sits inside a fuller pane tail.
    expect(paneShowsClaudeWorking(`some prior line\n${line}\nsome later line`)).toBe(true);
  });
}

test("paneShowsClaudeWorking / WORKING_LINE_RE — false for prose that merely mentions 'monitor' with no count", () => {
  const line = "I'll monitor the build output for you.";
  expect(WORKING_LINE_RE.test(line)).toBe(false);
  expect(paneShowsClaudeWorking(line)).toBe(false);
});

test("paneShowsClaudeWorking / WORKING_LINE_RE — false for the agents-only status bar (no monitor count)", () => {
  // WORKING_LINE_RE deliberately excludes "N agents" (see its doc comment
  // and plan §8 Q1 — that counter is other local Claude sessions, not this
  // task's background work), so a status bar naming only agents — no
  // "esc to interrupt", no monitor/shell count — must not read as busy.
  const line = "⏵⏵ auto mode on · ← 4 agents · ↓ to manage";
  expect(WORKING_LINE_RE.test(line)).toBe(false);
  expect(paneShowsClaudeWorking(line)).toBe(false);
});
