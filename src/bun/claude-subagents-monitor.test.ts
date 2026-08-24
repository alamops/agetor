/* ────────────────────────────────────────────────────────────────────────── *
 * Monitor tracking (the `Monitor` tool — what `/loop` and "watch this log"
 * workflows use) in claude-subagents.ts — the `monitors` map, the two-line
 * launch/stub correlation over the MAIN session JSONL
 * (`scanLineForMonitorLaunch` / `scanLineForMonitorStub`), the terminal-vs-
 * activity receipt rule (`applyMonitorNotification` / its DB-only twin
 * `applyMonitorNotificationForRow`), the bounded ceiling + flip-back +
 * receipt-latch (`checkMonitorCeiling`), rehydration routing a `monitor` row
 * into `monitors` (never `files`), the live dispatch entry point
 * (`handleBackgroundTaskNotification`), and the `AGETOR_TRACK_MONITORS` kill
 * switch.
 *
 * See docs/plans/claude-code-monitors-hold-running.md and the "Monitors"
 * section of claude-subagents.ts's module header. Template:
 * claude-subagents-bgshell.test.ts — same conventions (mkdtemp
 * `AGETOR_DATA_DIR` before importing db/orchestrator, `manual: true` +
 * injected-`now` `pump()`, save/restore the module-level emitter/settle/
 * parked-discovery hooks), disjoint scope (monitors only).
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-monitor-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Whatever the orchestrator registered at its module load (or `null` if this
// file runs before it). `bun test` shares one process across every file, so
// hard-resetting these to `null` in `afterEach` would leave every later file
// with no SSE sink and no release/pull-back path — see
// claude-subagents-bgshell.test.ts's identical comment. Capture by
// read-modify-restore and put the originals back.
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;
let originalParkedDiscovery: ((taskId: string) => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { setSubagentEmitter, setSubagentSettleHook, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
  originalSettleHook = setSubagentSettleHook(null);
  setSubagentSettleHook(originalSettleHook);
  originalParkedDiscovery = setParkedDiscoveryHandler(null);
  setParkedDiscoveryHandler(originalParkedDiscovery);
});

// Every task `seed()` creates is tracked here and torn down in the global
// `afterEach` below — see claude-subagents-bgshell.test.ts's identical
// comment for why: `seed()` inserts the task `running` + the run `succeeded`,
// exactly the shape reconcileOrphans's held-task sweep looks for, and a
// leftover row (combined with a `running` subagents row several tests here
// create) would get silently swept by any later `reconcileOrphans()` call
// sharing this process's SQLite db.
const createdTaskIds: string[] = [];

afterEach(async () => {
  const {
    detachWatcherFor,
    setSubagentEmitter,
    setSubagentSettleHook,
    setParkedDiscoveryHandler,
  } = await import("./claude-subagents.ts");
  setSubagentEmitter(originalEmitter);
  setSubagentSettleHook(originalSettleHook);
  setParkedDiscoveryHandler(originalParkedDiscovery);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try {
      detachWatcherFor(id);
    } catch {
      /* best-effort */
    }
    try {
      tasks.delete(id);
    } catch {
      /* best-effort */
    }
  }
  createdTaskIds.length = 0;
});

/** Build a temp `<sessionId>/subagents/` layout + a seeded task/run, returning
 *  the jsonlPath the watcher derives everything from. Mirrors
 *  claude-subagents-bgshell.test.ts's `seed()` exactly — monitors are
 *  detected off the MAIN jsonl, but the watcher still derives `subagentsDir`
 *  from it and the dir must exist for `readdirSync` to not need
 *  special-casing. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-monitor-${randomUUID()}`;
  const runId = `run-monitor-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null,
    fast: false, maxMode: false, references: [], backlog: [], plans: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  // Insert the run as already-terminal — see claude-subagents-bgshell.test
  // .ts's identical comment: reconcileOrphans() scans every `running` run
  // globally.
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Fixture builders — verbatim live shapes from the plan doc / module header
 * (claude-code 2.1.241).
 * ────────────────────────────────────────────────────────────────────────── */

/** Main-JSONL assistant line: a `Monitor` tool_use. */
function launchLine(opts: {
  toolUseId: string;
  command?: string;
  description?: string;
  timeoutMs?: number;
  persistent?: boolean;
  timestamp?: string;
}): string {
  const input: Record<string, unknown> = {
    command: opts.command ?? 'tail -f -n 0 build.log | grep -E --line-buffered "passed|failed"',
  };
  if (opts.description !== undefined) input.description = opts.description;
  if (opts.timeoutMs !== undefined) input.timeout_ms = opts.timeoutMs;
  if (opts.persistent !== undefined) input.persistent = opts.persistent;
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp ?? new Date().toISOString(),
    uuid: randomUUID(),
    message: { role: "assistant", content: [{ type: "tool_use", id: opts.toolUseId, name: "Monitor", input }] },
  }) + "\n";
}

/** The human-readable stub text claude writes the moment a Monitor call is
 *  accepted. */
function stubContent(id: string, timeoutMs: number): string {
  return `Monitor started (task ${id}, timeout ${timeoutMs}ms). You will be notified on each event. Keep working — do not poll or sleep.`;
}

/** Main-JSONL `user` line carrying the immediate Monitor stub `tool_result`.
 *  `toolUseResult.taskId` IS the row PK — the same id every later
 *  `<task-notification>` for this monitor carries. */
function stubLine(opts: {
  toolUseId: string;
  id: string;
  timeoutMs?: number;
  persistent?: boolean;
  timestamp?: string;
}): string {
  const timeoutMs = opts.timeoutMs ?? 1_500_000;
  const persistent = opts.persistent ?? false;
  return JSON.stringify({
    type: "user",
    timestamp: opts.timestamp ?? new Date().toISOString(),
    uuid: randomUUID(),
    message: {
      role: "user",
      content: [{ tool_use_id: opts.toolUseId, type: "tool_result", content: stubContent(opts.id, timeoutMs) }],
    },
    toolUseResult: { taskId: opts.id, timeoutMs, persistent },
  }) + "\n";
}

/** Inner `<task-notification>` block for a Monitor event/terminal signal —
 *  verified live shape (see claude-subagents.ts's module header "Monitors"
 *  section). Also usable verbatim as the `body` argument to
 *  `handleBackgroundTaskNotification`/`applyMonitorNotification` directly
 *  (they tolerate a full wrapped block, see `extractNotificationBlockForId`). */
function notificationBlock(opts: { id: string; summary?: string; status?: string; event?: string }): string {
  let s = `<task-notification>\n<task-id>${opts.id}</task-id>\n`;
  if (opts.summary !== undefined) s += `<summary>${opts.summary}</summary>\n`;
  if (opts.status !== undefined) s += `<status>${opts.status}</status>\n`;
  if (opts.event !== undefined) s += `<event>${opts.event}</event>\n`;
  s += `</task-notification>`;
  return s;
}

/** Main-JSONL `queue-operation`/`enqueue` line embedding a notification block
 *  verbatim — one half of the dual shape a live Monitor event/terminal
 *  signal arrives as. */
function enqueueLine(content: string, timestamp?: string): string {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: timestamp ?? new Date().toISOString(),
    sessionId: randomUUID(),
    content,
  }) + "\n";
}

/** Main-JSONL synthetic `user` line, `origin.kind:"task-notification"` — the
 *  other half of the dual shape, carrying content byte-identical to its
 *  sibling `enqueueLine`. */
function originLine(content: string, timestamp?: string): string {
  return JSON.stringify({
    type: "user",
    uuid: randomUUID(),
    origin: { kind: "task-notification" },
    promptSource: "system",
    timestamp: timestamp ?? new Date().toISOString(),
    message: { role: "user", content },
  }) + "\n";
}

/** Both adjacent lines a live Monitor notification arrives as (see
 *  claude-subagents.ts's module header "Monitors" section) — the
 *  `queue-operation` enqueue line AND the synthetic `user`/origin line,
 *  carrying the SAME `<task-notification>` block. */
function eventLines(opts: { id: string; summary?: string; status?: string; event?: string; timestamp?: string }): string {
  const content = notificationBlock(opts);
  return enqueueLine(content, opts.timestamp) + originLine(content, opts.timestamp);
}

async function stdoutEvents(id: string) {
  const { db } = await import("./db.ts");
  return db.query<{ data: string; line_uuid: string | null }, [string]>(
    `SELECT data, line_uuid FROM run_events WHERE subagent_id = ? AND stream = 'stdout' ORDER BY id`,
  ).all(id);
}

// Mirrors the internal (unexported) constants in claude-subagents.ts. Kept in
// sync manually since they're not part of the module's public surface.
const MONITOR_TIMEOUT_MARGIN_MS = 2 * 60_000;
const MONITOR_DEFAULT_STALE_MS = 60 * 60_000;

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Launch + stub → row created, hasRunning true, "started" lifecycle
 * ────────────────────────────────────────────────────────────────────────── */

test("a Monitor launch + its stub tool_result creates a monitor row, holds the task, and emits a started lifecycle", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const parked: string[] = [];
  setParkedDiscoveryHandler((tid) => parked.push(tid));

  const toolUseId = "toolu_01M";
  const id = "bvkdtb50u";
  const stubTs = new Date().toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, description: "serial re-run of 3 specs", timeoutMs: 1_500_000, persistent: false }) +
      stubLine({ toolUseId, id, timeoutMs: 1_500_000, persistent: false, timestamp: stubTs }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  expect(row!.parentKind).toBe("monitor");
  expect(row!.agentType).toBe("monitor");
  expect(row!.description).toBe("serial re-run of 3 specs");
  expect(row!.toolUseId).toBe(toolUseId);
  expect(row!.status).toBe("running");
  expect(row!.runId).toBe(runId);
  // startedAt honors the STUB line's own timestamp, not the scan time.
  expect(Math.abs(row!.startedAt - Date.parse(stubTs))).toBeLessThan(2_000);

  expect(subagents.hasRunning(taskId)).toBe(true);

  const started = captured.filter((e) => e.stream === "subagent" && e.subagentId === id);
  expect(started.length).toBe(1);
  expect(JSON.parse(started[0]!.data).phase).toBe("started");
  expect(parked).toEqual([taskId]);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Ordinary event: still running, one stdout row despite the duplicate pair
 * ────────────────────────────────────────────────────────────────────────── */

test("an ordinary Monitor event does not settle the row, and persists exactly one stdout line despite arriving via both the enqueue and origin lines", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const toolUseId = "toolu_ev1";
  const id = "mon_ev1";
  writeFileSync(jsonlPath, launchLine({ toolUseId, description: "serial re-run of 3 specs" }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(
    jsonlPath,
    eventLines({
      id,
      summary: 'Monitor event: "serial re-run of 3 specs"',
      event: "4 failed\n36 passed (8.9m)",
    }),
  );
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.data).toContain("4 failed");
  const stdoutStreamed = captured.filter((e) => e.stream === "stdout" && e.subagentId === id);
  expect(stdoutStreamed.length).toBe(1);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Reattach replay of an already-persisted event is idempotent
 * ────────────────────────────────────────────────────────────────────────── */

test("replaying an already-persisted Monitor event on reattach does not duplicate the stdout row or re-emit it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_ev2";
  const id = "mon_ev2";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  appendFileSync(jsonlPath, eventLines({ id, event: "1 failed" }));
  w.pump(t0 + 1);
  expect((await stdoutEvents(id)).length).toBe(1);
  w.detach();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  // Fresh watcher: rehydrates the row (still `running`) into `monitors`, then
  // replays the WHOLE main jsonl from offset 0 — the launch, stub, AND the
  // event pair all re-scan.
  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + 2);

  expect(subagents.get(id)!.status).toBe("running");
  expect((await stdoutEvents(id)).length).toBe(1); // no duplicate row
  const stdoutStreamed = captured.filter((e) => e.stream === "stdout" && e.subagentId === id);
  expect(stdoutStreamed.length).toBe(0); // no re-emit on replay
  const restartedLifecycle = captured.filter(
    (e) => e.stream === "subagent" && e.subagentId === id && JSON.parse(e.data).phase === "started",
  );
  expect(restartedLifecycle.length).toBe(0); // stub replay guard: not resurrected

  w2.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. Timeout event: receipt settle, no resurrection by a later event
 * ────────────────────────────────────────────────────────────────────────── */

test("a Monitor timeout event settles the row via receipt, and a later event does not resurrect it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const toolUseId = "toolu_to1";
  const id = "mon_to1";
  writeFileSync(jsonlPath, launchLine({ toolUseId, timeoutMs: 5_000 }) + stubLine({ toolUseId, id, timeoutMs: 5_000 }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, eventLines({ id, event: "[Monitor timed out — re-arm if needed.]" }));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(settleCalls).toEqual([taskId]);
  const finished = captured.filter(
    (e) => e.stream === "subagent" && e.subagentId === id && JSON.parse(e.data).phase === "finished",
  );
  expect(finished.length).toBe(1);

  // A later notification for the same id — receipt-settled rows never
  // resurrect (unlike a ceiling-settled row).
  appendFileSync(jsonlPath, eventLines({ id, event: "9 passed", timestamp: new Date(t0 + 2).toISOString() }));
  w.pump(t0 + 2);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. <status> handling: a terminal status settles, an unrecognised one skips
 * ────────────────────────────────────────────────────────────────────────── */

test("a Monitor notification carrying <status>stopped</status> settles the row", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_st1";
  const id = "mon_st1";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, eventLines({ id, status: "stopped" }));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);

  w.detach();
});

test("a Monitor notification with an unrecognised non-terminal <status> is skipped without settling", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_st2";
  const id = "mon_st2";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, eventLines({ id, status: "paused" }));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);
  expect((await stdoutEvents(id)).length).toBe(0);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. Timed ceiling: bounded hold, then flip-back on a later event
 * ────────────────────────────────────────────────────────────────────────── */

test("a timed Monitor settles via the ceiling once its timeout + margin elapses with no notification", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_ceil1";
  const id = "mon_ceil1";
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + MONITOR_TIMEOUT_MARGIN_MS;
  const t0 = Date.now();
  const ts = new Date(t0).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs, persistent: false, timestamp: ts }) +
      stubLine({ toolUseId, id, timeoutMs, persistent: false, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.get(id)!.startedAt).toBe(t0);

  // Still within the margin.
  w.pump(t0 + ceiling - 1);
  expect(subagents.get(id)!.status).toBe("running");

  // Past the ceiling — no notification ever arrived, settle inferred.
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

// NOTE — this test currently FAILS against the implementation; see this
// file's final report for the root cause. Kept as a normal (non-`.skip`)
// test per the task's instructions: it's the proof of a real bug in
// `checkMonitorCeiling`'s TIMED branch, not a test-authoring mistake.
test("a later non-terminal event flips a ceiling-settled timed Monitor back to running", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const parked: string[] = [];
  setParkedDiscoveryHandler((tid) => parked.push(tid));

  const toolUseId = "toolu_ceil2";
  const id = "mon_ceil2";
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + MONITOR_TIMEOUT_MARGIN_MS;
  const t0 = Date.now();
  const ts = new Date(t0).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs, persistent: false, timestamp: ts }) +
      stubLine({ toolUseId, id, timeoutMs, persistent: false, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed"); // ceiling-settled, per the sibling test above

  const parkedBefore = parked.length;
  // A later non-terminal event proves the monitor is actually still alive.
  // Per docs/plans/claude-code-monitors-hold-running.md §3 ("a ceiling-
  // settled row flips back on a later non-terminal event") and
  // `applyMonitorNotification`'s flip-back block, this SHOULD settle back to
  // "running" with a fresh parked-discovery fire.
  appendFileSync(jsonlPath, eventLines({ id, event: "1 passed", timestamp: new Date(t0 + ceiling + 2).toISOString() }));
  w.pump(t0 + ceiling + 2);
  expect(subagents.get(id)!.status).toBe("running");
  expect(parked.length).toBe(parkedBefore + 1);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 7. Persistent-monitor ceiling: activity-anchored, resets on each event
 *
 * `applyMonitorNotification` stamps `lastActivityAt` off the REAL wall clock
 * (`Date.now()`), never off the notification line's own `timestamp` field or
 * `pump`'s injected `now` — mirrors `tailBgShells`'s identical posture for
 * `BgShellState.lastAppendAt` (see claude-subagents-bgshell.test.ts's R1
 * test comment: "tailBgShells stamps lastAppendAt off the real wall clock").
 * So this test ages the monitor via an OLD launch/stub line timestamp (to
 * exercise "not yet stale" without a synthetic future `now`) and keeps every
 * `pump()` call BEFORE the live event close to the real wall clock; only
 * once the event has fixed a real anchor does it become safe to jump `now`
 * far into a synthetic future (no further live activity intervenes to move
 * that anchor again).
 * ────────────────────────────────────────────────────────────────────────── */

test("a persistent Monitor is not settled by inactivity before the default stale window, is settled once it elapses, and an event in between resets the anchor", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_persist1";
  const id = "mon_persist1";
  const t0 = Date.now();
  // Started 59 minutes ago — just under MONITOR_DEFAULT_STALE_MS (60 min).
  const lineTs = t0 - 59 * 60_000;
  const ts = new Date(lineTs).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, persistent: true, timestamp: ts }) + stubLine({ toolUseId, id, persistent: true, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.get(id)!.startedAt).toBe(lineTs);

  // An event arrives, resetting the activity anchor away from the
  // (already nearly-expired) original startedAt.
  appendFileSync(jsonlPath, eventLines({ id, event: "still watching" }));
  w.pump(t0 + 5_000);
  expect(subagents.get(id)!.status).toBe("running");

  // Comfortably under the NEW anchor's stale window — no further
  // notification is processed from here on, so `lastActivityAt` stays fixed
  // and a synthetic future `now` is safe to inject.
  w.pump(t0 + 5_000 + MONITOR_DEFAULT_STALE_MS - 5_000);
  expect(subagents.get(id)!.status).toBe("running");

  // Past the stale window measured from the event (NOT from the original,
  // already-59-minutes-old startedAt) — settles.
  w.pump(t0 + 5_000 + MONITOR_DEFAULT_STALE_MS + 5_000);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 8. Rehydration routes a monitor row into `monitors`, not `files`
 * ────────────────────────────────────────────────────────────────────────── */

test("a pre-existing monitor row is rehydrated into the watcher's monitors map on attach, not treated as a JSONL transcript, and a later timeout event still settles it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const id = "mon_rehydrate1";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "monitor",
    agentType: "monitor", description: "rehydrated monitor", spawnDepth: 1,
    sourcePath: "", toolUseId: "toolu_rehy1",
    status: "running", startedAt: now - 5_000, endedAt: null,
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  expect(() => w.pump(now)).not.toThrow();
  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.get(id)!.parentKind).toBe("monitor");
  expect(subagents.hasRunning(taskId)).toBe(true);

  appendFileSync(
    jsonlPath,
    eventLines({ id, event: "[Monitor timed out — re-arm if needed.]", timestamp: new Date(now + 1).toISOString() }),
  );
  expect(() => w.pump(now + 1)).not.toThrow();
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 9. handleBackgroundTaskNotification — live dispatch entry point
 * ────────────────────────────────────────────────────────────────────────── */

test("handleBackgroundTaskNotification routes a non-terminal Monitor body through the attached watcher, persisting the event without settling", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, handleBackgroundTaskNotification } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_live1";
  const id = "mon_live1";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  expect(subagents.get(id)!.status).toBe("running");

  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, event: "3 passed" }));

  expect(subagents.get(id)!.status).toBe("running");
  expect((await stdoutEvents(id)).length).toBe(1);

  w.detach();
});

test("handleBackgroundTaskNotification routes a terminal Monitor body through the attached watcher and settles it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, handleBackgroundTaskNotification } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_live2";
  const id = "mon_live2";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());
  expect(subagents.get(id)!.status).toBe("running");

  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, event: "[Monitor timed out — re-arm if needed.]" }));

  expect(subagents.get(id)!.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);

  w.detach();
});

test("handleBackgroundTaskNotification falls back to the DB-only path for an unwatched monitor row, persisting a non-terminal event without settling", async () => {
  const { subagents } = await import("./db.ts");
  const { handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seed();

  const id = "mon_dbonly1";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "monitor",
    agentType: "monitor", description: "db-only monitor", spawnDepth: 1,
    sourcePath: "", toolUseId: null,
    status: "running", startedAt: now, endedAt: null,
  });

  // No `attachSubagentWatcher` call at all for this task — the row only
  // exists in the DB.
  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, event: "2 passed" }));

  expect(subagents.get(id)!.status).toBe("running");
  expect((await stdoutEvents(id)).length).toBe(1);
});

test("handleBackgroundTaskNotification falls back to the DB-only path for an unwatched monitor row and settles it on a terminal body", async () => {
  const { subagents } = await import("./db.ts");
  const { handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seed();

  const id = "mon_dbonly2";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "monitor",
    agentType: "monitor", description: "db-only monitor", spawnDepth: 1,
    sourcePath: "", toolUseId: null,
    status: "running", startedAt: now, endedAt: null,
  });

  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, status: "stopped" }));

  expect(subagents.get(id)!.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
});

test("handleBackgroundTaskNotification settles a non-monitor row unconditionally on any body, preserving today's behavior", async () => {
  const { subagents } = await import("./db.ts");
  const { handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seed();

  const id = "bg_notmonitor1";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "bg_session",
    agentType: "shell", description: "a shell", spawnDepth: 1,
    sourcePath: "", toolUseId: null,
    status: "running", startedAt: now, endedAt: null,
  });

  // A body that would be pure ACTIVITY for a monitor (no terminal <status>,
  // no terminal <event> text) — but a bg_session (or any non-monitor) row is
  // settled unconditionally by ANY notification body, exactly like before
  // this feature existed.
  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, event: "still going" }));

  expect(subagents.get(id)!.status).toBe("completed");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 10. AGETOR_TRACK_MONITORS=0 kill switch
 * ────────────────────────────────────────────────────────────────────────── */

test("AGETOR_TRACK_MONITORS=0 — no monitor row is created from the same launch/stub fixture", async () => {
  const prev = process.env.AGETOR_TRACK_MONITORS;
  process.env.AGETOR_TRACK_MONITORS = "0";
  // Re-import fresh so the module-level MONITORS_ENABLED flag re-reads the
  // env — the same cache-busting idiom claude-subagents-bgshell.test.ts uses
  // for its own kill switch.
  const mod = await import(`./claude-subagents.ts?gate=${randomUUID()}`);
  const { subagents } = await import("./db.ts");
  const { taskId, jsonlPath } = await seed();

  const toolUseId = "toolu_kill1";
  const id = "mon_kill1";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = mod.attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  expect(subagents.get(id)).toBeNull();
  expect(subagents.listForTask(taskId).length).toBe(0);
  expect(subagents.hasRunning(taskId)).toBe(false);

  w.detach();
  if (prev === undefined) delete process.env.AGETOR_TRACK_MONITORS;
  else process.env.AGETOR_TRACK_MONITORS = prev;
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 11. Launch/stub edge cases — no stub yet, and a stub with no pending launch
 * ────────────────────────────────────────────────────────────────────────── */

test("a Monitor stub whose tool_use_id has no pending launch entry still creates a row, with a null description", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const id = "mon_orphan1";
  // No launch line at all — the stub arrives naming a toolUseId this watcher
  // never remembered in `monitorPending`.
  writeFileSync(jsonlPath, stubLine({ toolUseId: "toolu_orphan1", id, timeoutMs: 500_000, persistent: false }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  expect(row!.parentKind).toBe("monitor");
  expect(row!.description).toBeNull();
  expect(row!.toolUseId).toBe("toolu_orphan1");
  expect(row!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  w.detach();
});

test("a Monitor launch whose stub never arrives creates no row", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  writeFileSync(jsonlPath, launchLine({ toolUseId: "toolu_nostub1", description: "never confirmed" }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  expect(subagents.listForTask(taskId).length).toBe(0);
  expect(subagents.hasRunning(taskId)).toBe(false);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 12. Finding #1 — a flipped-back timed monitor does not oscillate: it
 *     survives several more ticks (with live activity) past its original
 *     deadline, and only settles once activity genuinely stops for the
 *     default stale window.
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #1: a flipped-back timed monitor does not re-settle while events keep arriving, and settles only once activity stops for the default stale window", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const parked: string[] = [];
  setParkedDiscoveryHandler((tid) => parked.push(tid));

  const toolUseId = "toolu_ceil3";
  const id = "mon_ceil3";
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + MONITOR_TIMEOUT_MARGIN_MS;
  const t0 = Date.now();
  const ts = new Date(t0).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs, persistent: false, timestamp: ts }) +
      stubLine({ toolUseId, id, timeoutMs, persistent: false, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed"); // ceiling-settled, per the sibling test above

  // Flip back with a live event. Per finding #1(b), this also discards the
  // row's `timeoutMs`/`persistent` — from here on it behaves like a
  // persistent/rehydrated monitor (activity-anchored ceiling only).
  appendFileSync(jsonlPath, eventLines({ id, event: "event 1", timestamp: new Date(t0 + ceiling + 2).toISOString() }));
  w.pump(t0 + ceiling + 2);
  expect(subagents.get(id)!.status).toBe("running");

  // Several MORE ticks past the original deadline, each with its own live
  // event, all pumped close to the REAL wall clock (mirrors test 7's own
  // comment on `lastActivityAt`'s real-wall-clock posture — using a
  // synthetic `now` far from real time here would make the assertions
  // meaningless, not stricter). Without BOTH halves of finding #1, the very
  // first of these ticks would have already re-settled the row (the
  // immutable timed deadline never moves) — this loop is the "several
  // ticks" the finding's fix is about, not just the single first flip-back.
  for (let i = 0; i < 3; i++) {
    const now = Date.now();
    appendFileSync(jsonlPath, eventLines({ id, event: `event ${i + 2}`, timestamp: new Date(now).toISOString() }));
    w.pump(now);
    expect(subagents.get(id)!.status).toBe("running");
  }

  // Silence from here on — comfortably under the default stale window
  // (anchored to the LAST event's real `lastActivityAt`) still runs; past it
  // settles, exactly like a genuinely persistent monitor.
  const lastActivity = Date.now();
  w.pump(lastActivity + MONITOR_DEFAULT_STALE_MS - 5_000);
  expect(subagents.get(id)!.status).toBe("running");
  w.pump(lastActivity + MONITOR_DEFAULT_STALE_MS + 5_000);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 13. Finding #2 — MONITOR_TERMINAL_EVENT_RE is both-ends anchored: a
 *     terminal-looking PREFIX inside a longer live event does not settle.
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #2: an <event> that merely STARTS with a terminal-looking bracket does not settle the row", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_re1";
  const id = "mon_re1";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, eventLines({ id, event: "[Monitor stopped] 3 failed, 1 passed" }));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);
  const rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.data).toContain("3 failed");

  w.detach();
});

test("finding #2: an <event> that carries the exact terminal marker plus trailing text does not settle, but the exact marker alone still does", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_re2";
  const id = "mon_re2";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);

  // Trailing text after the closing bracket breaks the end anchor.
  appendFileSync(jsonlPath, eventLines({ id, event: "[Monitor timed out — re-arm if needed.] extra" }));
  w.pump(t0 + 1);
  expect(subagents.get(id)!.status).toBe("running");

  // The exact verified marker, and nothing else, still settles.
  appendFileSync(
    jsonlPath,
    eventLines({ id, event: "[Monitor timed out — re-arm if needed.]", timestamp: new Date(t0 + 2).toISOString() }),
  );
  w.pump(t0 + 2);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 14. Finding #3 — flip-back survives a restart (rehydration) and works on
 *     the watcher-less DB-only path, gated correctly by an authoritative
 *     receipt vs. a mere ceiling guess.
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #3(a/b): a ceiling-settled row rehydrates with its flip-back gate OPEN, and a new event after reattach flips it back to running", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });
  const parked: string[] = [];
  setParkedDiscoveryHandler((tid) => parked.push(tid));

  const toolUseId = "toolu_reh1";
  const id = "mon_reh1";
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + MONITOR_TIMEOUT_MARGIN_MS;
  const t0 = Date.now();
  const ts = new Date(t0).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs, persistent: false, timestamp: ts }) +
      stubLine({ toolUseId, id, timeoutMs, persistent: false, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed"); // settled by the CEILING — no receipt ever persisted
  w.detach(); // simulate an agetor restart: all in-memory MonitorState is gone

  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + ceiling + 2); // rehydrates the row into `monitors`
  expect(subagents.get(id)!.status).toBe("completed"); // rehydration alone never resurrects

  const parkedBefore = parked.length;
  appendFileSync(
    jsonlPath,
    eventLines({ id, event: "1 passed", timestamp: new Date(t0 + ceiling + 3).toISOString() }),
  );
  w2.pump(t0 + ceiling + 3);

  expect(subagents.get(id)!.status).toBe("running");
  expect(parked.length).toBe(parkedBefore + 1);

  w2.detach();
});

test("finding #3(a/b): a receipt-settled row rehydrates with its flip-back gate CLOSED, and a later event after reattach is ignored", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_reh2";
  const id = "mon_reh2";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  appendFileSync(jsonlPath, eventLines({ id, event: "[Monitor timed out — re-arm if needed.]" }));
  w.pump(t0 + 1);
  expect(subagents.get(id)!.status).toBe("completed"); // settled by an AUTHORITATIVE receipt
  w.detach();

  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + 2); // rehydrates — the `terminal:`-prefixed line_uuid is on record

  appendFileSync(
    jsonlPath,
    eventLines({ id, event: "1 passed", timestamp: new Date(t0 + 3).toISOString() }),
  );
  w2.pump(t0 + 3);

  expect(subagents.get(id)!.status).toBe("completed"); // never flips back — the harness already said it's over

  w2.detach();
});

test("finding #3(c): handleBackgroundTaskNotification flips a ceiling-settled DB row back to running on a fresh non-terminal body, with no watcher attached", async () => {
  const { subagents } = await import("./db.ts");
  const { handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seed();

  const id = "mon_dbflip1";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "monitor",
    agentType: "monitor", description: "db-only ceiling-settled monitor", spawnDepth: 1,
    sourcePath: "", toolUseId: null,
    status: "completed", startedAt: now - 10_000, endedAt: now, // ceiling-settled: no receipt ever recorded
  });

  // No `attachSubagentWatcher` call for this task at all.
  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, event: "3 passed" }));

  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);
  expect((await stdoutEvents(id)).length).toBe(1);
});

test("finding #3(c): handleBackgroundTaskNotification does NOT flip a settled DB row back on a replayed (already-persisted) body, with no watcher attached", async () => {
  const { subagents } = await import("./db.ts");
  const { handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, runId } = await seed();

  const id = "mon_dbnoflip1";
  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "monitor",
    agentType: "monitor", description: "db-only monitor", spawnDepth: 1,
    sourcePath: "", toolUseId: null,
    status: "completed", startedAt: now - 10_000, endedAt: now,
  });

  const body = notificationBlock({ id, event: "9 passed" });

  // First delivery: fresh event, genuinely new — flips the row back.
  handleBackgroundTaskNotification(taskId, id, body);
  expect(subagents.get(id)!.status).toBe("running");
  expect((await stdoutEvents(id)).length).toBe(1);

  // Something else settles it again (independent of this event) — e.g. a
  // ceiling check via a different path. The event's own row in `run_events`
  // is untouched.
  subagents.setStatus(id, "completed", Date.now());

  // The EXACT SAME body arrives again (a replay — same content, no line
  // timestamp threaded on this path, so the same hash-only line_uuid).
  // `persistMonitorEvent`'s `runs.appendEvent` dedups it — `isNew` is
  // `false` — so it must NOT resurrect the row this time.
  handleBackgroundTaskNotification(taskId, id, body);
  expect(subagents.get(id)!.status).toBe("completed");
  expect((await stdoutEvents(id)).length).toBe(1); // no duplicate row either
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 15. Finding #4 — an unrecognised <status> on a Monitor notification is
 *     still counted as ACTIVITY by the restart-safe scan (dispatch to
 *     `monitors` now runs before the unknown-<status> guard).
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #4: a Monitor notification with an unrecognised <status> and no <event> still counts as activity, deferring the staleness ceiling", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_unk1";
  const id = "mon_unk1";
  const t0 = Date.now();
  // Started 59 minutes ago — just under MONITOR_DEFAULT_STALE_MS (60 min),
  // mirroring the persistent-monitor ceiling test's own setup.
  const lineTs = t0 - 59 * 60_000;
  const ts = new Date(lineTs).toISOString();
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, persistent: true, timestamp: ts }) + stubLine({ toolUseId, id, persistent: true, timestamp: ts }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  // A notification with an UNRECOGNISED <status> and no <event> tag at all.
  // Before finding #4's fix, `scanLineForTaskNotification`'s unknown-<status>
  // guard ran BEFORE the `monitors` lookup and would `continue` here,
  // silently dropping it — `lastActivityAt` would stay pinned at the
  // original (59-minutes-stale) anchor.
  appendFileSync(jsonlPath, eventLines({ id, status: "paused" }));
  w.pump(t0 + 5_000);
  expect(subagents.get(id)!.status).toBe("running");
  expect((await stdoutEvents(id)).length).toBe(0); // no <event> text — nothing to persist to the tab

  // Comfortably under the NEW anchor's (the "paused" notification's) stale
  // window. Without the fix, this point is already ~7.14 hours past the
  // ORIGINAL 59-minutes-old anchor and would have settled well before now.
  w.pump(t0 + 5_000 + MONITOR_DEFAULT_STALE_MS - 5_000);
  expect(subagents.get(id)!.status).toBe("running");

  // Past the stale window measured from the "paused" notification.
  w.pump(t0 + 5_000 + MONITOR_DEFAULT_STALE_MS + 5_000);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 16. Finding #5 — the event dedup key buckets by the JSONL line's own
 *     timestamp: a genuinely repeated identical event >10s apart persists as
 *     its own row; the enqueue/user twin of the SAME event (same instant)
 *     still collapses to one.
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #5: an identical Monitor event repeated 30s later persists as a second row, while its own enqueue/user twin still collapses to one", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_dedup1";
  const id = "mon_dedup1";
  writeFileSync(jsonlPath, launchLine({ toolUseId }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  const eventText = "0 failed, 12 passed";
  const ts1 = t0;
  appendFileSync(jsonlPath, eventLines({ id, event: eventText, timestamp: new Date(ts1).toISOString() }));
  w.pump(t0 + 1);

  let rows = await stdoutEvents(id);
  expect(rows.length).toBe(1); // the enqueue+origin twin of ONE event collapses to one row

  // The exact same event text, 30 seconds later by the JSONL line's own
  // timestamp — a genuinely NEW occurrence (a real repeated log line), not a
  // replay of the same line. Must persist as its own row.
  const ts2 = ts1 + 30_000;
  appendFileSync(jsonlPath, eventLines({ id, event: eventText, timestamp: new Date(ts2).toISOString() }));
  w.pump(t0 + 2);

  rows = await stdoutEvents(id);
  expect(rows.length).toBe(2);
  expect(rows[0]!.line_uuid).not.toBe(rows[1]!.line_uuid);
  expect(subagents.get(id)!.status).toBe("running");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 17. Finding #8 — `hasAnyMonitor()` lets `handleBackgroundTaskNotification`
 *     skip the DB probe entirely for a task whose attached watcher tracks no
 *     monitors at all.
 * ────────────────────────────────────────────────────────────────────────── */

test("finding #8: handleBackgroundTaskNotification skips the extra DB probe when an attached watcher reports it tracks no monitors, while still settling a non-monitor id correctly either way", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, handleBackgroundTaskNotification } = await import(
    "./claude-subagents.ts"
  );
  setSubagentEmitter(() => { /* drain */ });

  // `settleSubagentById` itself always does ONE `subagentsDb.get(id)` call
  // internally (to build the lifecycle-emit payload and check for a
  // workflow-container cascade) — unrelated to finding #8, and present on
  // every path regardless of the fix. So a bare "0 calls" assertion is the
  // wrong test; the fix is only observable DIFFERENTIALLY: the watcher-less
  // path pays ONE EXTRA `subagentsDb.get(id)` call (the probe itself, to
  // check `row?.parentKind === "monitor"`) that the "watcher attached, no
  // monitors tracked" path must NOT pay.
  const originalGet = subagents.get.bind(subagents);
  let getCalls = 0;
  subagents.get = (probeId: string) => {
    getCalls++;
    return originalGet(probeId);
  };
  try {
    // Case A — watcher attached, tracks zero monitors (`hasAnyMonitor()` is
    // `false`): the fixed fast path skips the probe entirely.
    const a = await seed();
    writeFileSync(a.jsonlPath, ""); // no Monitor launch/stub lines at all
    const wA = attachSubagentWatcher({ taskId: a.taskId, jsonlPath: a.jsonlPath, manual: true });
    wA.pump(Date.now());
    const idA = "bg_probe_a";
    subagents.insertIfAbsent({
      id: idA, taskId: a.taskId, runId: a.runId, parentKind: "bg_session",
      agentType: "shell", description: "a shell", spawnDepth: 1,
      sourcePath: "", toolUseId: null,
      status: "running", startedAt: Date.now(), endedAt: null,
    });
    getCalls = 0;
    handleBackgroundTaskNotification(a.taskId, idA, notificationBlock({ id: idA, event: "still going" }));
    const callsWithWatcher = getCalls;
    wA.detach();

    // Case B — no watcher attached to the task at all: the DB is the only
    // source of truth, so the probe still runs (unchanged from before this
    // finding) — pays one MORE call than case A.
    const b = await seed();
    const idB = "bg_probe_b";
    subagents.insertIfAbsent({
      id: idB, taskId: b.taskId, runId: b.runId, parentKind: "bg_session",
      agentType: "shell", description: "a shell", spawnDepth: 1,
      sourcePath: "", toolUseId: null,
      status: "running", startedAt: Date.now(), endedAt: null,
    });
    getCalls = 0;
    handleBackgroundTaskNotification(b.taskId, idB, notificationBlock({ id: idB, event: "still going" }));
    const callsNoWatcher = getCalls;

    expect(callsWithWatcher).toBe(callsNoWatcher - 1);

    // Behavior is unchanged either way — a non-monitor id settles
    // unconditionally on any body.
    expect(originalGet(idA)!.status).toBe("completed");
    expect(originalGet(idB)!.status).toBe("completed");
  } finally {
    subagents.get = originalGet;
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Live dispatch and the restart-safe scan agree on the dedup key
 * ────────────────────────────────────────────────────────────────────────── */

test("a Monitor event dispatched live with the line's timestamp and then read by the restart-safe scan persists exactly one stdout row", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const toolUseId = "toolu_live1";
  const id = "mon_live1";
  writeFileSync(jsonlPath, launchLine({ toolUseId, description: "watch build" }) + stubLine({ toolUseId, id }));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  // claude-tmux's live tailer sees the enqueue line first and forwards the raw
  // payload PLUS the line's own timestamp (orchestrator handler → this export);
  // the watcher's scan then reads the very same bytes on its next pump. Both
  // must derive the same time-bucketed line_uuid, or the tab shows the event
  // twice.
  const timestamp = "2026-08-24T17:29:40.000Z";
  const summary = 'Monitor event: "watch build"';
  const event = "12 passed\n1 skipped";
  appendFileSync(jsonlPath, eventLines({ id, summary, event, timestamp }));
  handleBackgroundTaskNotification(taskId, id, notificationBlock({ id, summary, event }), Date.parse(timestamp));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("running");
  const rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  // A real newline (not the JSON-escaped two-char sequence) reaches the tab.
  expect(rows[0]!.data).toContain("12 passed\n1 skipped");
  expect(captured.filter((e) => e.stream === "stdout" && e.subagentId === id).length).toBe(1);

  w.detach();
});
