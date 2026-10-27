import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Unit tests for the cooperative-job contract of `attachSubagentWatcher`
 * (docs/plans/non-blocking-session-restore.md, TT2): the handle returns
 * synchronously, the heavy start-up (the SEED, then the FIRST CYCLE) runs as
 * resumable jobs in ~20 ms slices, and `ready` / `settled` / `pump()` /
 * `syncSettled()` / `detach()` keep well-defined semantics while those jobs
 * are pending. The loop-drift property itself is proven over a production-sized
 * fixture in `subagent-watcher-drift.test.ts`; this file pins the API semantics
 * on small fixtures.
 * ────────────────────────────────────────────────────────────────────────── */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-yield-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Transcripts never live under the data dir (cleanup must not touch the sqlite).
const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-yield-fixture-"));

const createdTaskIds: string[] = [];

beforeAll(async () => {
  await import("./db.ts");
});

afterEach(async () => {
  const { detachWatcherFor } = await import("./claude-subagents.ts");
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try { detachWatcherFor(id); } catch { /* best-effort */ }
    // FK cascade removes runs / subagents / run_events and keeps held-shaped
    // rows out of later `reconcileOrphans` scans in this shared process.
    try { db.run(`DELETE FROM tasks WHERE id = ?`, [id]); } catch { /* best-effort */ }
  }
  createdTaskIds.length = 0;
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

/** A task + an already-terminal run + a `<session>/subagents/` layout. The run
 *  is `succeeded` (a lingering `running` run would pollute every later
 *  `reconcileOrphans` in this shared process) and the task sits in `review`. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-yield-${randomUUID()}`;
  const runId = `run-yield-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "review", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created",
    worktreePath: null, baseRef: null, mode: null, model: null, effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const sessionId = randomUUID();
  const proj = path.join(FIXTURE_DIR, "projects", randomUUID());
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  return { taskId, runId, jsonlPath: path.join(proj, `${sessionId}.jsonl`), subagentsDir, now };
}

/** `count` claude-shaped sidechain assistant lines with uuids `<prefix>-<n>`. */
function sidechainLines(prefix: string, count: number, start = 0): string {
  const out: string[] = [];
  for (let n = start; n < start + count; n++) {
    out.push(JSON.stringify({
      type: "assistant", isSidechain: true, uuid: `${prefix}-${n}`,
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: `line ${n}` }] },
    }));
  }
  return out.join("\n") + "\n";
}

async function subagentEventCount(taskId: string): Promise<number> {
  const { db } = await import("./db.ts");
  return db.query<{ c: number }, [string]>(
    `SELECT COUNT(*) c FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE r.task_id = ? AND e.subagent_id IS NOT NULL`,
  ).get(taskId)!.c;
}

/** True when `p` has already resolved (microtasks drained, then one loop turn). */
async function isResolved(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

/** Persist `count` pre-seeded events for (runId, subagentId) in one transaction. */
async function insertSeededEvents(runId: string, subagentId: string, count: number): Promise<void> {
  const { db } = await import("./db.ts");
  const stmt = db.prepare(
    `INSERT INTO run_events (run_id, stream, data, ts, line_uuid, subagent_id) VALUES (?, 'assistant', '{}', ?, ?, ?)`,
  );
  const ts = Date.now();
  db.transaction(() => {
    for (let n = 0; n < count; n++) stmt.run(runId, ts, `heavy-${subagentId}-${n}`, subagentId);
  })();
}

test("manual mode: ready is already resolved, the first pump() runs the first cycle, and events appear only after it", async () => {
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const agentId = "m1aaaaaaaaaa";
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines("m1", 3));

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  // The seed ran synchronously inside attach; the first cycle has not.
  expect(await isResolved(w.ready)).toBe(true);
  expect(await isResolved(w.settled)).toBe(false);
  expect(await subagentEventCount(taskId)).toBe(0);
  expect(subagents.listForTask(taskId).length).toBe(0);

  w.pump(Date.now());
  expect(await subagentEventCount(taskId)).toBe(3);
  expect(subagents.listForTask(taskId).map((s) => s.id)).toEqual([agentId]);
  expect(await isResolved(w.settled)).toBe(true);

  // Later pumps keep tailing (steady state), unchanged from the old semantics.
  appendFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines("m1", 2, 3));
  w.pump(Date.now());
  expect(await subagentEventCount(taskId)).toBe(5);
  w.detach();
});

test("production mode: pump() is a no-op while the seed / first cycle is pending, and works after settled", async () => {
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const agentId = "p1bbbbbbbbbb";
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(file, sidechainLines("p1", 3));

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  // Synchronously after attach the first cycle cannot have started (it begins
  // FAST_POLL_MS after the seed), so a pump() here lands in the pending window.
  w.pump(Date.now());
  expect(await subagentEventCount(taskId)).toBe(0);
  expect(subagents.listForTask(taskId).length).toBe(0);

  // Still pending after the seed finished: the first cycle is behind the
  // FAST_POLL_MS beat, and `ready` resolves strictly before `settled`.
  await w.ready;
  expect(await isResolved(w.settled)).toBe(false);
  w.pump(Date.now());
  expect(await subagentEventCount(taskId)).toBe(0);
  expect(subagents.listForTask(taskId).length).toBe(0);

  await w.settled;
  // The first cycle itself discovered + replayed the file.
  expect(await subagentEventCount(taskId)).toBe(3);

  // After settled a synchronous pump() performs a real cycle: it tails the
  // appended lines and discovers a brand-new transcript, with no timer involved.
  appendFileSync(file, sidechainLines("p1", 2, 3));
  const secondId = "p2cccccccccc";
  writeFileSync(path.join(subagentsDir, `agent-${secondId}.jsonl`), sidechainLines("p2", 4));
  const before = await subagentEventCount(taskId);
  w.pump(Date.now());
  expect(await subagentEventCount(taskId)).toBe(before + 2 + 4);
  expect(subagents.listForTask(taskId).map((s) => s.id).sort()).toEqual([agentId, secondId].sort());
  w.detach();
});

test("syncSettled for an id that is not rehydrated yet is a no-op, and the row later rehydrates with its DB status", async () => {
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, runId, jsonlPath, now } = await seed();

  // Seed order is `listForTask` order (started_at): a heavy first row makes the
  // first ~20 ms slice end after that row alone, so the monitor row behind it
  // is still un-rehydrated when attach returns.
  const heavyId = "h1dddddddddd";
  const monitorId = "mon_yield_sync1";
  subagents.insertIfAbsent({
    id: heavyId, taskId, runId, parentKind: "subagent", agentType: "general-purpose",
    description: "heavy", spawnDepth: 1, sourcePath: path.join(FIXTURE_DIR, "missing-heavy.jsonl"),
    toolUseId: "toolu_heavy", status: "completed", startedAt: now - 10_000, endedAt: now - 5_000,
  });
  subagents.insertIfAbsent({
    id: monitorId, taskId, runId, parentKind: "monitor", agentType: "monitor",
    description: "monitor", spawnDepth: 1, sourcePath: "", toolUseId: "toolu_mon",
    status: "running", startedAt: now - 9_000, endedAt: null,
  });
  await insertSeededEvents(runId, heavyId, 150_000);

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  // Precondition that makes this test meaningful: the seed is genuinely mid-flight.
  // Everything up to `await w.ready` below is synchronous — an `await` here would
  // let the seed's next slice (queued on `setImmediate` before ours) finish first.
  expect(w.hasMonitor(monitorId)).toBe(false);

  expect(() => w.syncSettled(monitorId, "completed", now, "receipt")).not.toThrow();
  // A notification for the not-yet-tracked monitor is likewise refused.
  const terminal = `<task-notification>\n<task-id>${monitorId}</task-id>\n<status>stopped</status>\n</task-notification>`;
  expect(w.applyMonitorNotification(monitorId, terminal)).toBe(false);
  expect(subagents.get(monitorId)!.status).toBe("running");

  await w.ready;
  // Rehydrated with the DB's status (running), NOT with the pre-seed sync: a
  // terminal receipt now takes effect on the in-memory state and settles the row.
  expect(w.hasMonitor(monitorId)).toBe(true);
  expect(w.applyMonitorNotification(monitorId, terminal)).toBe(true);
  expect(subagents.get(monitorId)!.status).toBe("completed");
  w.detach();
});

test("a monitor activity notification that lands mid-seed takes the DB path and never receipt-closes the monitor", async () => {
  const { attachSubagentWatcher, handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, runId, jsonlPath, now } = await seed();

  // Same shape as the syncSettled test: a heavy first row keeps the monitor
  // behind it un-rehydrated when attach returns.
  const heavyId = "h3dddddddddd";
  const monitorId = "mon_yield_midseed";
  subagents.insertIfAbsent({
    id: heavyId, taskId, runId, parentKind: "subagent", agentType: "general-purpose",
    description: "heavy", spawnDepth: 1, sourcePath: path.join(FIXTURE_DIR, "missing-heavy-3.jsonl"),
    toolUseId: "toolu_heavy3", status: "completed", startedAt: now - 10_000, endedAt: now - 5_000,
  });
  subagents.insertIfAbsent({
    id: monitorId, taskId, runId, parentKind: "monitor", agentType: "monitor",
    description: "monitor", spawnDepth: 1, sourcePath: "", toolUseId: "toolu_mon3",
    status: "running", startedAt: now - 9_000, endedAt: null,
  });
  await insertSeededEvents(runId, heavyId, 150_000);

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  // Synchronous up to `await w.ready` (see the syncSettled test).
  expect(w.hasMonitor(monitorId)).toBe(false);
  // The map is incomplete mid-seed, so "no monitors" can't be claimed.
  expect(w.hasAnyMonitor()).toBe(true);
  const activity = `<task-notification>\n<task-id>${monitorId}</task-id>\n<event>tick 1</event>\n</task-notification>`;
  handleBackgroundTaskNotification(taskId, monitorId, activity);
  // Used to take the `!hasAnyMonitor()` receipt shortcut and settle the row.
  expect(subagents.get(monitorId)!.status).toBe("running");

  await w.ready;
  expect(w.hasMonitor(monitorId)).toBe(true);
  expect(subagents.get(monitorId)!.status).toBe("running");
  w.detach();
});

test("a row whose status changes while the seed is mid-flight is rehydrated with its CURRENT status, not the snapshot's", async () => {
  const { attachSubagentWatcher, handleBackgroundTaskNotification } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, runId, jsonlPath, now } = await seed();

  const heavyId = "h4dddddddddd";
  const monitorId = "mon_yield_resnap";
  subagents.insertIfAbsent({
    id: heavyId, taskId, runId, parentKind: "subagent", agentType: "general-purpose",
    description: "heavy", spawnDepth: 1, sourcePath: path.join(FIXTURE_DIR, "missing-heavy-4.jsonl"),
    toolUseId: "toolu_heavy4", status: "completed", startedAt: now - 10_000, endedAt: now - 5_000,
  });
  // Settled by the ceiling's guess only (no terminal receipt on record), so a
  // later activity event may reopen it.
  subagents.insertIfAbsent({
    id: monitorId, taskId, runId, parentKind: "monitor", agentType: "monitor",
    description: "monitor", spawnDepth: 1, sourcePath: "", toolUseId: "toolu_mon4",
    status: "completed", startedAt: now - 9_000, endedAt: now - 8_000,
  });
  await insertSeededEvents(runId, heavyId, 150_000);

  const w = attachSubagentWatcher({ taskId, jsonlPath });
  expect(w.hasMonitor(monitorId)).toBe(false);
  // Mid-seed activity reopens the row through the DB path.
  const activity = `<task-notification>\n<task-id>${monitorId}</task-id>\n<event>tick 2</event>\n</task-notification>`;
  handleBackgroundTaskNotification(taskId, monitorId, activity);
  expect(subagents.get(monitorId)!.status).toBe("running");

  await w.ready;
  expect(w.hasMonitor(monitorId)).toBe(true);
  // Seeded from the stale snapshot the monitor read `completed` in memory, so
  // its terminal receipt below was latched without settling the row — which
  // then stayed `running` (holding the task) forever.
  const terminal = `<task-notification>\n<task-id>${monitorId}</task-id>\n<status>completed</status>\n</task-notification>`;
  w.applyMonitorNotification(monitorId, terminal);
  expect(subagents.get(monitorId)!.status).toBe("completed");
  w.detach();
});

test("detach() mid-seed stops the job — no events are persisted afterwards — and still resolves ready and settled", async () => {
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");

  /** Heavy first row + a running monitor behind it + a transcript with 3 unseen
   *  lines (what an un-detached first cycle would persist). */
  async function buildTask() {
    const t = await seed();
    const heavyId = `h2${randomUUID().slice(0, 10)}`;
    const fileId = `f2${randomUUID().slice(0, 10)}`;
    const monitorId = `mon_yield_${randomUUID().slice(0, 8)}`;
    subagents.insertIfAbsent({
      id: heavyId, taskId: t.taskId, runId: t.runId, parentKind: "subagent", agentType: "general-purpose",
      description: "heavy", spawnDepth: 1, sourcePath: path.join(FIXTURE_DIR, "missing-heavy.jsonl"),
      toolUseId: "toolu_heavy", status: "completed", startedAt: t.now - 10_000, endedAt: t.now - 5_000,
    });
    subagents.insertIfAbsent({
      id: monitorId, taskId: t.taskId, runId: t.runId, parentKind: "monitor", agentType: "monitor",
      description: "monitor", spawnDepth: 1, sourcePath: "", toolUseId: "toolu_mon",
      status: "running", startedAt: t.now - 9_000, endedAt: null,
    });
    const filePath = path.join(t.subagentsDir, `agent-${fileId}.jsonl`);
    writeFileSync(filePath, sidechainLines(fileId, 3));
    subagents.insertIfAbsent({
      id: fileId, taskId: t.taskId, runId: t.runId, parentKind: "subagent", agentType: "general-purpose",
      description: "file", spawnDepth: 1, sourcePath: filePath,
      toolUseId: "toolu_file", status: "completed", startedAt: t.now - 8_000, endedAt: t.now - 4_000,
    });
    await insertSeededEvents(t.runId, heavyId, 150_000);
    return { ...t, monitorId };
  }

  // Control: the same shape, left running, persists the 3 unseen lines.
  const control = await buildTask();
  const cw = attachSubagentWatcher({ taskId: control.taskId, jsonlPath: control.jsonlPath });
  await cw.settled;
  expect(await subagentEventCount(control.taskId)).toBe(150_000 + 3);
  cw.detach();

  const t = await buildTask();
  const baseline = await subagentEventCount(t.taskId);
  expect(baseline).toBe(150_000);
  const w = attachSubagentWatcher({ taskId: t.taskId, jsonlPath: t.jsonlPath });
  expect(w.hasMonitor(t.monitorId)).toBe(false); // seed is mid-flight
  w.detach();

  // Both promises resolve (neither rejects) once detached…
  await Promise.all([w.ready, w.settled]);
  // …the seed never reached the monitor row behind the heavy one…
  expect(w.hasMonitor(t.monitorId)).toBe(false);
  // …and the first cycle never runs: wait past FAST_POLL_MS (600 ms) and check.
  await Bun.sleep(900);
  expect(await subagentEventCount(t.taskId)).toBe(baseline);
  // A pump() on a detached handle stays inert too.
  w.pump(Date.now());
  expect(await subagentEventCount(t.taskId)).toBe(baseline);
});

test("AGETOR_TRACK_SUBAGENTS=0 (read at module load) yields a disabled stub whose ready and settled resolve immediately", async () => {
  const prev = process.env.AGETOR_TRACK_SUBAGENTS;
  process.env.AGETOR_TRACK_SUBAGENTS = "0";
  let mod: typeof import("./claude-subagents.ts");
  try {
    // The flag is a module-level constant, so a fresh module instance (cache-busting
    // specifier — the idiom claude-subagents.test.ts already uses) has to load under it.
    mod = await import(`./claude-subagents.ts?gate=${randomUUID()}`);
  } finally {
    if (prev === undefined) delete process.env.AGETOR_TRACK_SUBAGENTS;
    else process.env.AGETOR_TRACK_SUBAGENTS = prev;
  }
  const { taskId, jsonlPath, subagentsDir } = await seed();
  writeFileSync(path.join(subagentsDir, "agent-disabled0000.jsonl"), sidechainLines("dis", 3));

  const w = mod.attachSubagentWatcher({ taskId, jsonlPath });
  expect(await isResolved(w.ready)).toBe(true);
  expect(await isResolved(w.settled)).toBe(true);
  w.pump(Date.now());
  w.syncSettled("whatever", "completed", Date.now());
  expect(w.hasMonitor("whatever")).toBe(false);
  expect(w.hasAnyMonitor()).toBe(false);
  expect(w.applyMonitorNotification("whatever", "x")).toBe(false);
  w.detach();
  await Bun.sleep(700); // past FAST_POLL_MS: nothing is ever tailed
  expect(await subagentEventCount(taskId)).toBe(0);
});

test("unreadable transcripts (a directory, a missing file, a 000-mode file) never reject ready/settled, and ready resolves before settled", async () => {
  const { attachSubagentWatcher } = await import("./claude-subagents.ts");
  const { subagents } = await import("./db.ts");
  const { taskId, runId, jsonlPath, subagentsDir, now } = await seed();

  const goodId = "g3eeeeeeeeee";
  const dirId = "d3ffffffffff";
  const missingId = "m3000000000a";
  const lockedId = "l3000000000b";
  const goodFile = path.join(subagentsDir, `agent-${goodId}.jsonl`);
  const dirPath = path.join(subagentsDir, "a-directory-not-a-file");
  const lockedFile = path.join(subagentsDir, `agent-${lockedId}.jsonl`);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(goodFile, sidechainLines("good", 3));
  writeFileSync(lockedFile, sidechainLines("locked", 3));
  chmodSync(lockedFile, 0o000);

  const row = (id: string, sourcePath: string, i: number) => ({
    id, taskId, runId, parentKind: "subagent" as const, agentType: "general-purpose",
    description: id, spawnDepth: 1, sourcePath, toolUseId: `toolu_${id}`,
    status: "running" as const, startedAt: now - 10_000 + i, endedAt: null,
  });
  subagents.insertIfAbsent(row(dirId, dirPath, 0));
  subagents.insertIfAbsent(row(missingId, path.join(subagentsDir, "agent-never-written.jsonl"), 1));
  subagents.insertIfAbsent(row(lockedId, lockedFile, 2));
  subagents.insertIfAbsent(row(goodId, goodFile, 3));

  try {
    const order: string[] = [];
    const w = attachSubagentWatcher({ taskId, jsonlPath });
    const ready = w.ready.then(() => { order.push("ready"); });
    const settled = w.settled.then(() => { order.push("settled"); });
    await Promise.all([ready, settled]); // would throw if either rejected
    expect(order).toEqual(["ready", "settled"]);

    // The healthy sibling was still replayed (the locked file only reads empty
    // when the process cannot open it; a root run would read it — either way
    // the good row's three lines must be present).
    const { db } = await import("./db.ts");
    const goodEvents = db.query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) c FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.task_id = ? AND e.subagent_id = ?`,
    ).get(taskId, goodId)!.c;
    expect(goodEvents).toBe(3);
    w.detach();
  } finally {
    chmodSync(lockedFile, 0o644);
  }
});
