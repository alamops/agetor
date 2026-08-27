/* ────────────────────────────────────────────────────────────────────────── *
 * Background-shell tracking (`Bash(run_in_background:true)`) in
 * claude-subagents.ts — the `bgShells` map, the two-line launch/stub
 * correlation over the MAIN session JSONL (`scanLineForBgShellLaunch` /
 * `scanLineForBgShellStub`), raw output tailing (`tailBgShells`), the bounded
 * ceiling + flip-back + receipt-latch (`checkBgShellCeiling`), the
 * `<task-notification>` settle widening in `scanLineForTaskNotification`,
 * rehydration routing a `bg_session` row into `bgShells` (never `files`), and
 * the `AGETOR_TRACK_BG_SHELLS` kill switch.
 *
 * See docs/plans/fix-bg-shell-detection.md. Companion to
 * claude-subagents.test.ts / claude-workflow-agents.test.ts — same
 * conventions (mkdtemp `AGETOR_DATA_DIR` before importing db/orchestrator,
 * `manual: true` + injected-`now` `pump()`, save/restore the module-level
 * emitter/settle hooks), disjoint scope (bg shells only).
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-bgshell-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Whatever the orchestrator registered at its module load (or `null` if this
// file runs before it). `bun test` shares one process across every file, so
// hard-resetting these to `null` in `afterEach` would leave every later file
// with no SSE sink and no release/pull-back path — see claude-subagents.
// test.ts's identical comment. Capture by read-modify-restore and put the
// originals back.
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
// `afterEach` below — see claude-subagents.test.ts's identical comment for
// why: `seed()` inserts the task `running` + the run `succeeded`, exactly the
// shape reconcileOrphans's held-task sweep looks for, and a leftover row
// (combined with a `running` subagents row several tests here create) would
// get silently swept by any later `reconcileOrphans()` call sharing this
// process's SQLite db.
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
 *  claude-subagents.test.ts's `seed()` exactly — bg shells are detected off
 *  the MAIN jsonl, but the watcher still derives `subagentsDir` from it and
 *  the dir must exist for `readdirSync` to not need special-casing. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-bgshell-${randomUUID()}`;
  const runId = `run-bgshell-${randomUUID()}`;
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
  // Insert the run as already-terminal — see claude-subagents.test.ts's
  // identical comment: reconcileOrphans() scans every `running` run globally.
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/** A real on-disk path a bg shell's raw output could live at, under this
 *  file's own scratch dir (never the repo). The directory is created eagerly
 *  so `writeFileSync`/`appendFileSync` callers never have to think about it. */
function bgOutputPath(id: string): string {
  const p = path.join(DATA_DIR, "bg-out", `${id}.output`);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Fixture builders — verbatim live shapes from the plan doc.
 * ────────────────────────────────────────────────────────────────────────── */

/** Main-JSONL assistant line: a `Bash(run_in_background:true)` tool_use. */
function launchLine(opts: {
  toolUseId: string;
  command?: string;
  description?: string;
  timeoutMs?: number;
  timestamp?: string;
}): string {
  const input: Record<string, unknown> = {
    command: opts.command ?? "sleep 99",
    run_in_background: true,
  };
  if (opts.description !== undefined) input.description = opts.description;
  if (opts.timeoutMs !== undefined) input.timeout = opts.timeoutMs;
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp ?? new Date().toISOString(),
    message: { content: [{ type: "tool_use", id: opts.toolUseId, name: "Bash", input }] },
  }) + "\n";
}

/** The human-readable stub text claude writes for a backgrounded shell. */
function stubContent(backgroundTaskId: string, outputPath: string | null): string {
  return outputPath
    ? `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}. You will be notified when it completes.`
    : `Command running in background with ID: ${backgroundTaskId}. You will be notified when it completes.`;
}

/** Main-JSONL `user` line carrying the immediate stub `tool_result`, with an
 *  arbitrary set of tool_result blocks (for the coalesced-line test) — most
 *  callers use the single-block `stubLine` convenience below instead. */
function stubLineRaw(opts: {
  backgroundTaskId: string;
  blocks: { toolUseId: string; content: string }[];
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: "user",
    timestamp: opts.timestamp ?? new Date().toISOString(),
    message: {
      content: opts.blocks.map((b) => ({
        type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: false,
      })),
    },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: opts.backgroundTaskId },
  }) + "\n";
}

function stubLine(opts: {
  toolUseId: string;
  backgroundTaskId: string;
  outputPath?: string | null;
  timestamp?: string;
}): string {
  return stubLineRaw({
    backgroundTaskId: opts.backgroundTaskId,
    timestamp: opts.timestamp,
    blocks: [{ toolUseId: opts.toolUseId, content: stubContent(opts.backgroundTaskId, opts.outputPath ?? null) }],
  });
}

/** Main-JSONL line embedding a verbatim `<task-notification>` payload —
 *  wrapped in the same `queue-operation` enqueue shape
 *  claude-workflow-agents.test.ts uses (`scanLineForTaskNotification` only
 *  substring/regex-matches the raw line text, so the wrapper doesn't matter). */
function notificationLine(opts: { id: string; status?: string }): string {
  const content =
    `<task-notification>\n<task-id>${opts.id}</task-id>\n<status>${opts.status ?? "completed"}</status>\n</task-notification>`;
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    content,
  }) + "\n";
}

async function stdoutEvents(id: string) {
  const { db } = await import("./db.ts");
  return db.query<{ data: string; line_uuid: string | null }, [string]>(
    `SELECT data, line_uuid FROM run_events WHERE subagent_id = ? AND stream = 'stdout' ORDER BY id`,
  ).all(id);
}

// Mirrors the internal (unexported) constants in claude-subagents.ts. Kept in
// sync manually since they're not part of the module's public surface.
const BG_SHELL_TIMEOUT_MARGIN_MS = 2 * 60_000;
const BG_SHELL_BATCH_MAX_BYTES = 256 * 1024;

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Launch + stub → row created, hasRunning true, "started" lifecycle
 * ────────────────────────────────────────────────────────────────────────── */

test("a Bash(run_in_background) launch + its stub tool_result creates a bg_session row, holds the task, and emits a started lifecycle", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const toolUseId = "toolu_1";
  const id = "bg1";
  const outputPath = bgOutputPath(id);
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, description: "Build things", timeoutMs: 600_000, command: "sleep 99" }) +
      stubLine({ toolUseId, backgroundTaskId: id, outputPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  expect(row!.parentKind).toBe("bg_session");
  expect(row!.agentType).toBe("shell");
  expect(row!.description).toBe("Build things");
  expect(row!.sourcePath).toBe(outputPath);
  expect(row!.status).toBe("running");
  expect(row!.runId).toBe(runId);

  expect(subagents.hasRunning(taskId)).toBe(true);

  const started = captured.filter((e) => e.stream === "subagent" && e.subagentId === id);
  expect(started.length).toBe(1);
  expect(JSON.parse(started[0]!.data).phase).toBe("started");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Output-path parse tolerates a space in the path (review fix R8)
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R8 — a stub whose output path contains a space is still parsed correctly", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_2";
  const id = "bg2";
  const spacedPath = "/tmp/My Project/tasks/bg2.output";
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, description: "Spaced path build" }) +
      stubLine({ toolUseId, backgroundTaskId: id, outputPath: spacedPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  expect(row!.sourcePath).toBe(spacedPath);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Stub content missing the output-path sentence — row still created
 * ────────────────────────────────────────────────────────────────────────── */

test("a stub whose content lacks the output-path sentence still creates the row, with an empty sourcePath", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_3";
  const id = "bg3";
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, description: "No path text" }) +
      stubLineRaw({
        backgroundTaskId: id,
        blocks: [{ toolUseId, content: `Command running in background with ID: ${id}. You will be notified when it completes.` }],
      }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  expect(row!.sourcePath).toBe("");
  expect(row!.status).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. Coalesced user line, two tool_result blocks — correlates the right one
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R6 — a coalesced user line with an unrelated tool_result block first still correlates the correct launch", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_bg4";
  const id = "bg4";
  const outputPath = bgOutputPath(id);
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, description: "Long build", timeoutMs: 5_000 }) +
      stubLineRaw({
        backgroundTaskId: id,
        blocks: [
          // Unrelated block first: neither its content nor its tool_use_id
          // has anything to do with this launch/stub pair.
          { toolUseId: "toolu_unrelated", content: "Reading file contents: ok" },
          { toolUseId, content: stubContent(id, outputPath) },
        ],
      }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  // Wrong-block correlation would have left description null (no pending
  // entry under "toolu_unrelated") and toolUseId "toolu_unrelated".
  expect(row!.description).toBe("Long build");
  expect(row!.toolUseId).toBe(toolUseId);
  expect(row!.sourcePath).toBe(outputPath);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. Output tailing: persist/emit, offset advance, replay dedup
 * ────────────────────────────────────────────────────────────────────────── */

test("live output tailing persists batches with offset-derived line_uuids and never re-persists unchanged content", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));

  const toolUseId = "toolu_5";
  const id = "bg5";
  const outputPath = bgOutputPath(id);
  writeFileSync(outputPath, "");
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // discovers the row; output file is still empty, no tail yet

  writeFileSync(outputPath, "hello "); // 6 bytes
  w.pump(t0 + 1);
  let rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.data).toBe("hello ");
  expect(rows[0]!.line_uuid).toBe(`bgshell:${id}:0`);
  const stdoutStreamed = captured.filter((e) => e.stream === "stdout" && e.subagentId === id);
  expect(stdoutStreamed.length).toBe(1);
  expect(stdoutStreamed[0]!.data).toBe("hello ");

  appendFileSync(outputPath, "world"); // total "hello world" (11 bytes)
  w.pump(t0 + 2);
  rows = await stdoutEvents(id);
  expect(rows.length).toBe(2);
  expect(rows[1]!.data).toBe("world");
  expect(rows[1]!.line_uuid).toBe(`bgshell:${id}:6`);

  // No growth — a further pump must not duplicate anything.
  w.pump(t0 + 3);
  rows = await stdoutEvents(id);
  expect(rows.length).toBe(2);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. Per-batch cap (review fix R4)
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R4 — a batch beyond BG_SHELL_BATCH_MAX_BYTES is capped, and the remainder drains on the next pump", async () => {
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_6";
  const id = "bg6";
  const outputPath = bgOutputPath(id);
  writeFileSync(outputPath, "");
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0); // discover, output empty

  writeFileSync(outputPath, "x".repeat(BG_SHELL_BATCH_MAX_BYTES + 100));
  w.pump(t0 + 1);
  let rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.data.length).toBe(BG_SHELL_BATCH_MAX_BYTES);
  expect(rows[0]!.line_uuid).toBe(`bgshell:${id}:0`);

  // Remainder drains on the next pump, keyed by the offset it actually
  // started at (not from 0 again).
  w.pump(t0 + 2);
  rows = await stdoutEvents(id);
  expect(rows.length).toBe(2);
  expect(rows[1]!.data.length).toBe(100);
  expect(rows[1]!.line_uuid).toBe(`bgshell:${id}:${BG_SHELL_BATCH_MAX_BYTES}`);

  // Fully drained — a further pump adds nothing.
  w.pump(t0 + 3);
  rows = await stdoutEvents(id);
  expect(rows.length).toBe(2);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 7. Notification settle — live scan + idempotent replay
 * ────────────────────────────────────────────────────────────────────────── */

test("a <task-notification> for the backgroundTaskId settles the row, and replaying it on reattach is idempotent", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));

  const toolUseId = "toolu_7";
  const id = "bg7";
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath: null }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, notificationLine({ id }));
  w.pump(t0 + 1);

  expect(subagents.get(id)!.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(settleCalls).toEqual([taskId]);
  const finished = captured.filter((e) => e.stream === "subagent" && e.subagentId === id && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(1);

  // Reattach — the fresh watcher replays the WHOLE main jsonl from offset 0,
  // re-scanning the launch, stub, AND notification lines. The row must not
  // be resurrected, and the settle hook must not fire a second time.
  w.detach();
  captured.length = 0;
  settleCalls.length = 0;

  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + 2);

  expect(subagents.get(id)!.status).toBe("completed");
  expect(settleCalls.length).toBe(0);
  const restartedLifecycle = captured.filter((e) => e.stream === "subagent" && e.subagentId === id && JSON.parse(e.data).phase === "started");
  expect(restartedLifecycle.length).toBe(0);

  w2.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 8. Bounded ceiling: forward settle, flip-back within margin, receipt latch
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R1/R3 — a lost notification settles via the ceiling, and output growth within the margin flips it back to running", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_8a";
  const id = "bg8a";
  const outputPath = bgOutputPath(id);
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + BG_SHELL_TIMEOUT_MARGIN_MS;
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  // No output ever appended — the ceiling (timeout + margin) past the last
  // sign of life (here, ~startedAt) fires and settles it inferred.
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed");

  // Evidence the shell was actually still alive: the output file grows.
  // Well within one more margin window past the settle (R3's retire bound).
  writeFileSync(outputPath, "still going");
  w.pump(t0 + ceiling + 2);
  expect(subagents.get(id)!.status).toBe("running");

  w.detach();
});

test("review fix R2 — once a ceiling-settled row is latched by a receipt, later output growth does not resurrect it", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_8b";
  const id = "bg8b";
  const outputPath = bgOutputPath(id);
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + BG_SHELL_TIMEOUT_MARGIN_MS;
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);

  // Ceiling settle (no output, no notification).
  w.pump(t0 + ceiling + 1);
  expect(subagents.get(id)!.status).toBe("completed");

  // The harness's own authoritative receipt arrives after the fact and
  // latches receiptSettled — even though the row was already settled by the
  // ceiling, not by this notification.
  appendFileSync(jsonlPath, notificationLine({ id }));
  w.pump(t0 + ceiling + 2);
  expect(subagents.get(id)!.status).toBe("completed");

  // LATER output growth — must not resurrect a receipt-latched row.
  writeFileSync(outputPath, "trailing buffered flush");
  w.pump(t0 + ceiling + 3);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 9. Activity extends the hold (R1 anchor: lastAppendAt, not startedAt)
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R1 — recent output activity keeps the row running even though total runtime since startedAt exceeds the ceiling", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_9";
  const id = "bg9";
  const outputPath = bgOutputPath(id);
  const timeoutMs = 1_000;
  const ceiling = timeoutMs + BG_SHELL_TIMEOUT_MARGIN_MS;

  const t0 = Date.now();
  const lineTs = t0 - 200_000; // an "old" launch, well past the ceiling by now
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timeoutMs, timestamp: new Date(lineTs).toISOString() }) +
      stubLine({ toolUseId, backgroundTaskId: id, outputPath, timestamp: new Date(lineTs).toISOString() }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  // Register the row while still well within its ceiling relative to lineTs.
  w.pump(lineTs + 500);
  expect(subagents.get(id)!.status).toBe("running");
  expect(subagents.get(id)!.startedAt).toBeLessThanOrEqual(t0 - 100_000); // honored the old timestamp (R5)

  // Fresh activity: append real bytes right before pumping at a `now` that is
  // far beyond (timeout + margin) past the OLD startedAt/lineTs, but — because
  // tailBgShells stamps lastAppendAt off the real wall clock when it reads
  // these bytes — only a hair past the append itself.
  writeFileSync(outputPath, "still writing");
  expect(lineTs + 200_000 - t0).toBeLessThan(1_000); // sanity: this "now" is ~t0, not ~lineTs
  expect(lineTs + 200_000 - t0).toBeGreaterThan(-1_000);
  w.pump(lineTs + 200_000);

  // If the ceiling were (incorrectly) anchored on startedAt, `now - startedAt`
  // here is ~200_000ms, comfortably past `ceiling` (121_000ms), and the row
  // would have settled. Anchored on lastAppendAt (just refreshed by the
  // append, at real "now" ~ t0), it stays running.
  expect(subagents.get(id)!.status).toBe("running");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 10. Rehydration routes a bg_session row into bgShells, not files
 * ────────────────────────────────────────────────────────────────────────── */

test("a bg_session row created directly in the DB (simulating a pre-existing row at attach time) is rehydrated into bgShells, not tailed as JSONL, and still settles via notification", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, runId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const id = "bg10";
  const outputPath = bgOutputPath(id);
  writeFileSync(outputPath, "historical content written before this process started");

  const now = Date.now();
  subagents.insertIfAbsent({
    id, taskId, runId, parentKind: "bg_session",
    agentType: "shell", description: "rehydrated shell", spawnDepth: 1,
    sourcePath: outputPath, toolUseId: null,
    status: "running", startedAt: now - 5_000, endedAt: null,
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  expect(() => w.pump(now)).not.toThrow();

  // Offset seeded at the file's CURRENT size at attach — the pre-existing
  // content must not be re-persisted as a "new" stdout batch (which is also
  // exactly what would happen if this row were mistakenly routed into
  // `files` and JSONL-tailed from offset 0).
  let rows = await stdoutEvents(id);
  expect(rows.length).toBe(0);
  expect(subagents.get(id)!.parentKind).toBe("bg_session");
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(outputPath, " fresh bytes");
  w.pump(now + 1);
  rows = await stdoutEvents(id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.data).toBe(" fresh bytes");

  // Still settles via the ordinary notification path — proof it landed in
  // bgShells (the settle widening's third lookup), not lost or mis-routed.
  appendFileSync(jsonlPath, notificationLine({ id }));
  expect(() => w.pump(now + 2)).not.toThrow();
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 11. Replayed stub for an already-settled rehydrated row is not resurrected
 * ────────────────────────────────────────────────────────────────────────── */

test("replay guard — a rehydrated, already-settled bg_session row is not resurrected by replaying its own launch/stub lines", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const parked: string[] = [];
  setParkedDiscoveryHandler((tid) => parked.push(tid));

  const toolUseId = "toolu_11";
  const id = "bg11";
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath: null }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(id)!.status).toBe("running");

  appendFileSync(jsonlPath, notificationLine({ id }));
  w.pump(t0 + 1);
  expect(subagents.get(id)!.status).toBe("completed");

  w.detach();
  captured.length = 0;
  parked.length = 0;

  // Fresh watcher: rehydrates the row from the DB (status "completed") into
  // `bgShells` BEFORE the main-jsonl replay reaches the stub line again.
  // `scanLineForBgShellStub`'s `if (bgShells.has(id)) return;` guard must
  // fire — the replayed stub must never re-create/resurrect the row.
  const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w2.pump(t0 + 2);

  expect(subagents.get(id)!.status).toBe("completed");
  expect(parked.length).toBe(0);
  const restarted = captured.filter((e) => e.stream === "subagent" && e.subagentId === id && JSON.parse(e.data).phase === "started");
  expect(restarted.length).toBe(0);

  w2.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 12. AGETOR_TRACK_BG_SHELLS=0 kill switch
 * ────────────────────────────────────────────────────────────────────────── */

test("AGETOR_TRACK_BG_SHELLS=0 — no bg_session row is created from the same launch/stub fixture", async () => {
  const prev = process.env.AGETOR_TRACK_BG_SHELLS;
  process.env.AGETOR_TRACK_BG_SHELLS = "0";
  // Re-import fresh so the module-level BG_SHELLS_ENABLED flag re-reads the
  // env — the same cache-busting idiom claude-subagents.test.ts /
  // claude-workflow-agents.test.ts use for their own kill switches.
  const mod = await import(`./claude-subagents.ts?gate=${randomUUID()}`);
  const { subagents } = await import("./db.ts");
  const { taskId, jsonlPath } = await seed();

  const toolUseId = "toolu_12";
  const id = "bg12";
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId }) + stubLine({ toolUseId, backgroundTaskId: id, outputPath: null }),
  );

  const w = mod.attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(Date.now());

  expect(subagents.get(id)).toBeNull();
  expect(subagents.listForTask(taskId).length).toBe(0);
  expect(subagents.hasRunning(taskId)).toBe(false);

  w.detach();
  if (prev === undefined) delete process.env.AGETOR_TRACK_BG_SHELLS;
  else process.env.AGETOR_TRACK_BG_SHELLS = prev;
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 13. startedAt honors the line's own timestamp (review fix R5)
 * ────────────────────────────────────────────────────────────────────────── */

test("review fix R5 — startedAt is taken from the stub line's own past timestamp, not the scan time", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath } = await seed();
  setSubagentEmitter(() => { /* drain */ });

  const toolUseId = "toolu_13";
  const id = "bg13";
  const now = Date.now();
  const lineTs = now - 500_000; // ~8.3 minutes in the past
  writeFileSync(
    jsonlPath,
    launchLine({ toolUseId, timestamp: new Date(lineTs).toISOString() }) +
      stubLine({ toolUseId, backgroundTaskId: id, outputPath: null, timestamp: new Date(lineTs).toISOString() }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  w.pump(now); // scanned "now", but the line itself is old

  const row = subagents.get(id);
  expect(row).not.toBeNull();
  // Close to the fixture's own timestamp...
  expect(Math.abs(row!.startedAt - lineTs)).toBeLessThan(5_000);
  // ...and clearly NOT the scan time.
  expect(Math.abs(row!.startedAt - now)).toBeGreaterThan(100_000);

  w.detach();
});
