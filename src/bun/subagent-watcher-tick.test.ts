import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Steady-state responsiveness of the subagent watcher
 * (docs/plans/non-blocking-core.md, T11). The drift test covers the start-up
 * (seed + first cycle); this file covers what runs every 600 ms afterwards and
 * on every transcript append:
 *
 *   1. TICK LOAD. 39 transcripts take 5 MB of appends each, concurrently, while
 *      a real (timer-mode) watcher runs steady-state, with the transcript read
 *      and parse in the real transcript WORKER. The longest main-thread gap
 *      stays within `max(100 ms, 3 x the baseline gap measured in the same run)`.
 *      No more than one pass runs at a time, and the events leave in id order.
 *   2. COALESCING. A burst of dir-watcher events becomes ONE scheduled pass.
 *   3. LABEL. The `attach subagent watcher` lag label covers work slices only,
 *      never a yield or idle time.
 *   4. PARITY. The events persisted and emitted for a fixture transcript set are
 *      exactly what the old per-line path produced (reference: the old path's
 *      own mapper entry, `mapJsonlEventToChunks`, driven over the raw lines),
 *      across chunk sizes, and a failed batch insert neither drops nor
 *      duplicates events.
 * ────────────────────────────────────────────────────────────────────────── */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tick-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tick-fixture-"));

const SAMPLE_MS = 5;
const MIN_GAP_BUDGET_MS = 100;

const createdTaskIds: string[] = [];

beforeAll(async () => {
  await import("./db.ts");
});

afterEach(async () => {
  const { detachWatcherFor, setSubagentEmitter, __forTest } = await import("./claude-subagents.ts");
  const { db } = await import("./db.ts");
  setSubagentEmitter(null);
  __forTest.setJobSliceMs(null);
  __forTest.setReadChunkBytes(null);
  __forTest.setTranscriptClient(null);
  for (const id of createdTaskIds) {
    try { detachWatcherFor(id); } catch { /* best-effort */ }
    try { db.run(`DELETE FROM tasks WHERE id = ?`, [id]); } catch { /* best-effort */ }
  }
  createdTaskIds.length = 0;
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-tick-${randomUUID()}`;
  const runId = `run-tick-${randomUUID()}`;
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

/** Longest stretch between two ticks of a `SAMPLE_MS` interval the process spent
 *  computing: `min(wall, process CPU)` per gap, so an OS deschedule on a loaded
 *  machine (which no code of ours causes) is not counted, while synchronous work
 *  (CPU time ~ wall time) is counted in full. Same method as
 *  subagent-watcher-drift.test.ts. */
function startGapSampler() {
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  let max = 0;
  let wallMax = 0;
  const onCpuGap = (now: number): number => {
    const wall = now - last;
    const cpu = process.cpuUsage(lastCpu);
    if (wall > wallMax) wallMax = wall;
    return Math.min(wall, (cpu.user + cpu.system) / 1000);
  };
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = onCpuGap(now);
    if (gap > max) max = gap;
    last = now;
    lastCpu = process.cpuUsage();
  }, SAMPLE_MS);
  return {
    get wallMax(): number { return wallMax; },
    stop(): number {
      clearInterval(timer);
      return Math.max(max, onCpuGap(performance.now()));
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(14).slice(0, 700);
function sidechainLine(agentId: string, n: number, last: boolean): string {
  return (
    `{"parentUuid":null,"isSidechain":true,"userType":"external","agentId":"${agentId}",` +
    `"type":"assistant","message":{"id":"msg_${n}","type":"message","role":"assistant",` +
    `"model":"claude-fake","content":[{"type":"text","text":"[${n}] ${FILLER}"}],` +
    `"stop_reason":${last ? '"end_turn"' : "null"}},"uuid":"${agentId}-${n}","timestamp":"2026-01-01T00:00:00.000Z"}\n`
  );
}

/** Events with a row id, per run, in the order they were emitted. */
function recordEmits() {
  const byRun = new Map<string, number[]>();
  let count = 0;
  const sink = (e: RunEvent): void => {
    if (e.id === undefined || e.subagentId === undefined) return; // lifecycle frames carry no row id
    count++;
    let list = byRun.get(e.runId);
    if (!list) byRun.set(e.runId, (list = []));
    list.push(e.id);
  };
  return {
    sink,
    get count(): number { return count; },
    /** True when every run's ids are strictly increasing. */
    inOrder(): boolean {
      for (const ids of byRun.values()) {
        for (let i = 1; i < ids.length; i++) if (ids[i]! <= ids[i - 1]!) return false;
      }
      return true;
    },
  };
}

// ── 1. Tick load ────────────────────────────────────────────────────────────

const LOAD_FILES = 39;
/** ~1 KB per line, so 5000 lines is ~5 MB per transcript. */
const LOAD_LINES_PER_FILE = 5000;
const APPEND_LINES_PER_WRITE = 64;

test(
  "39 transcripts x 5 MB appended concurrently: the steady-state watcher keeps the loop free, runs one pass at a time and emits in id order",
  async () => {
    const mod = await import("./claude-subagents.ts");
    const { createTranscriptClient } = await import("./transcript-client.ts");
    const { transcriptWorkerFactory } = await import("./worker-entry.ts");
    // The production shape: the transcript read and JSON.parse run in the worker.
    const client = createTranscriptClient({ mode: "worker", workerFactory: transcriptWorkerFactory });
    mod.__forTest.setTranscriptClient(client);

    const { taskId, jsonlPath, subagentsDir } = await seed();
    const agentIds = Array.from({ length: LOAD_FILES }, (_, i) => `tick${String(i).padStart(3, "0")}${randomUUID().slice(0, 8)}`);
    const files = agentIds.map((id) => path.join(subagentsDir, `agent-${id}.jsonl`));
    // One line each at attach time, so the rows exist and are `running` before the load starts.
    agentIds.forEach((id, i) => writeFileSync(files[i]!, sidechainLine(id, 0, false)));

    const emits = recordEmits();
    mod.setSubagentEmitter(emits.sink);
    const handle = mod.attachSubagentWatcher({ taskId, jsonlPath });
    try {
      await handle.settled;
      expect(emits.count).toBe(LOAD_FILES); // the first cycle read every initial line

      // Baseline: the loop's own jitter in THIS run with the watcher idle.
      const baselineSampler = startGapSampler();
      await Bun.sleep(700);
      const baseline = baselineSampler.stop();
      const budget = Math.max(MIN_GAP_BUDGET_MS, 3 * baseline);

      mod.__forTest.resetPassStats();
      const sampler = startGapSampler();
      const startedAt = performance.now();
      const expectedTotal = LOAD_FILES * LOAD_LINES_PER_FILE; // lines 1..N-1 plus the final one per file
      await Promise.all(agentIds.map(async (id, i) => {
        for (let n = 1; n < LOAD_LINES_PER_FILE; n += APPEND_LINES_PER_WRITE) {
          let piece = "";
          const end = Math.min(LOAD_LINES_PER_FILE, n + APPEND_LINES_PER_WRITE);
          for (let k = n; k < end; k++) piece += sidechainLine(id, k, k === LOAD_LINES_PER_FILE - 1);
          await appendFile(files[i]!, piece);
          await Bun.sleep(5);
        }
      }));
      await waitFor(() => emits.count >= expectedTotal, 240_000, "every appended line to be persisted and emitted");
      const maxGap = sampler.stop();
      const stats = mod.__forTest.passStats();
      console.log(
        `[tick] ${emits.count} events in ${(performance.now() - startedAt).toFixed(0)} ms; ` +
          `baseline gap ${baseline.toFixed(1)} ms, max loop gap ${maxGap.toFixed(1)} ms on-CPU / ` +
          `${sampler.wallMax.toFixed(1)} ms wall (budget ${budget.toFixed(1)} ms); ` +
          `passes steady=${stats.steady} dir=${stats.dir}, max concurrent ${stats.maxActive}`,
      );

      expect(maxGap).toBeLessThanOrEqual(budget);
      expect(stats.maxActive).toBeLessThanOrEqual(1);
      expect(emits.count).toBe(LOAD_FILES * LOAD_LINES_PER_FILE);
      expect(emits.inOrder()).toBe(true);
    } finally {
      handle.detach();
      mod.setSubagentEmitter(null);
      client.close();
    }
  },
  300_000,
);

// ── 2. A dir-watcher burst is one scheduled pass ────────────────────────────

test("a burst of dir-watcher events coalesces into one scheduled pass, never one per event", async () => {
  const mod = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const ids = ["bur0aaaaaaaa", "bur1aaaaaaaa", "bur2aaaaaaaa"];
  const files = ids.map((id) => path.join(subagentsDir, `agent-${id}.jsonl`));
  ids.forEach((id, i) => writeFileSync(files[i]!, sidechainLine(id, 0, false)));

  const emits = recordEmits();
  mod.setSubagentEmitter(emits.sink);
  const handle = mod.attachSubagentWatcher({ taskId, jsonlPath });
  try {
    await handle.settled;
    // The tick is 600 ms while a row runs: park well past it so the passes
    // counted below are the dir watcher's, not the poll's.
    mod.__forTest.resetPassStats();
    const BURST = 60;
    for (let n = 1; n <= BURST; n++) {
      // Synchronous appends in one tick: 60 fs events arrive back to back.
      appendFileSync(files[n % ids.length]!, sidechainLine(ids[n % ids.length]!, n, false));
    }
    await waitFor(() => emits.count >= ids.length + BURST, 30_000, "the burst to be persisted");
    await Bun.sleep(150); // let any extra scheduled pass show up
    const stats = mod.__forTest.passStats();
    console.log(`[tick] burst of ${BURST} appends -> ${stats.dir} dir pass(es), ${stats.steady} steady, max concurrent ${stats.maxActive}`);
    expect(stats.dir).toBeGreaterThanOrEqual(1);
    expect(stats.dir).toBeLessThanOrEqual(3);
    expect(stats.maxActive).toBeLessThanOrEqual(1);
    expect(emits.count).toBe(ids.length + BURST);
    expect(emits.inOrder()).toBe(true);
  } finally {
    handle.detach();
    mod.setSubagentEmitter(null);
  }
}, 60_000);

// ── 3. The lag label covers work slices only ────────────────────────────────

test("the attach label covers slices only: present inside a slice, absent between slices and while idle", async () => {
  const mod = await import("./claude-subagents.ts");
  const { currentLagLabel } = await import("./event-loop-lag.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  mod.__forTest.setJobSliceMs(0); // every slice stops after one piece of work, so the job spans many yields
  mod.__forTest.setReadChunkBytes(512);
  for (let i = 0; i < 6; i++) {
    const id = `lab${i}aaaaaaaaa`;
    writeFileSync(path.join(subagentsDir, `agent-${id}.jsonl`), Array.from({ length: 40 }, (_, n) => sidechainLine(id, n, false)).join(""));
  }

  const isAttach = (l: { label: string } | null) => l !== null && l.label.startsWith("attach subagent watcher") && l.label.includes(taskId);
  let labelInSlice = false;
  mod.setSubagentEmitter(() => { if (isAttach(currentLagLabel())) labelInSlice = true; });
  let settledFlag = false;
  let nullBetweenSlices = false;
  let attachedBetweenSlices = false;
  const handle = mod.attachSubagentWatcher({ taskId, jsonlPath });
  void handle.settled.then(() => { settledFlag = true; });
  const poll = (): void => {
    if (settledFlag) return;
    // A check-phase callback runs between the watcher's own `setImmediate` yield
    // and the next slice.
    const l = currentLagLabel();
    if (isAttach(l)) attachedBetweenSlices = true; else nullBetweenSlices = true;
    setImmediate(poll);
  };
  setImmediate(poll);
  try {
    await handle.settled;
    expect(labelInSlice).toBe(true);
    // The old label spanned the whole job including its yields, so this was never observable.
    expect(nullBetweenSlices).toBe(true);
    console.log(`[tick] label between slices: present=${attachedBetweenSlices} absent=${nullBetweenSlices}`);
    // Idle (steady state, no pass running): no attach label.
    await Bun.sleep(30);
    expect(isAttach(currentLagLabel())).toBe(false);
  } finally {
    handle.detach();
    mod.setSubagentEmitter(null);
  }
}, 60_000);

test("a stall inside a work slice is attributed to the attach label; a stall while idle is not", async () => {
  const mod = await import("./claude-subagents.ts");
  const lag = await import("./event-loop-lag.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();
  const id = "stl0aaaaaaaa";
  const file = path.join(subagentsDir, `agent-${id}.jsonl`);
  writeFileSync(file, sidechainLine(id, 0, false));

  const stalls: Array<{ lagMs: number; label: string | null }> = [];
  lag.setLagStallSink((s) => stalls.push({ lagMs: s.lagMs, label: s.label }));
  lag.startLagMonitor({ sampleMs: 20, stallMs: 150, force: true });
  const warn = console.warn;
  console.warn = () => { /* the monitor logs every stall */ };
  let blockOnce = false;
  mod.setSubagentEmitter((e) => {
    // Block the main thread inside the slice that sends this event.
    if (blockOnce && e.id !== undefined) { blockOnce = false; Bun.sleepSync(300); }
  });
  const handle = mod.attachSubagentWatcher({ taskId, jsonlPath });
  try {
    await handle.settled;
    await Bun.sleep(60);
    stalls.length = 0;

    // (a) idle: a stall from code that is not the watcher's, between its ticks.
    await new Promise<void>((resolve) => setTimeout(() => { Bun.sleepSync(300); resolve(); }, 5));
    await Bun.sleep(80);
    const idleStalls = stalls.splice(0);
    expect(idleStalls.length).toBeGreaterThanOrEqual(1);
    expect(idleStalls.some((s) => s.label !== null && s.label.startsWith("attach subagent watcher"))).toBe(false);

    // (b) inside a slice: the emit of an appended line stalls the loop.
    blockOnce = true;
    appendFileSync(file, sidechainLine(id, 1, false));
    await waitFor(() => !blockOnce, 30_000, "the in-slice emit");
    await Bun.sleep(120);
    const sliceStalls = stalls.splice(0);
    expect(sliceStalls.length).toBeGreaterThanOrEqual(1);
    expect(sliceStalls.some((s) => s.label !== null && s.label.startsWith("attach subagent watcher"))).toBe(true);
  } finally {
    console.warn = warn;
    lag.stopLagMonitor();
    lag.setLagStallSink(null);
    handle.detach();
    mod.setSubagentEmitter(null);
  }
}, 60_000);

// ── 4. Parity with the old per-line path ────────────────────────────────────

/** A transcript exercising every branch of the per-line path: text, thinking,
 *  tool_use, tool_result, permission-mode markers (no uuid), a duplicate uuid, a
 *  blank line, a malformed line, an api-error line, a long text line. */
function parityLines(): string[] {
  const j = (o: unknown) => JSON.stringify(o);
  return [
    j({ type: "permission-mode", permissionMode: "plan", sessionId: "s" }),
    j({ type: "user", uuid: "p-u1", permissionMode: "plan", message: { role: "user", content: "do the thing" } }),
    j({ type: "assistant", uuid: "p-a1", message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "thinking", thinking: "hmm" }, { type: "text", text: "on it" },
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
    ] } }),
    "",
    "{not json at all",
    j({ type: "user", uuid: "p-u2", permissionMode: "plan", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu1", content: "file-a\nfile-b" },
    ] } }),
    j({ type: "assistant", uuid: "p-a1", message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "duplicate uuid, must dedupe" }] } }),
    j({ type: "system", subtype: "init", permissionMode: "acceptEdits" }),
    j({ type: "user", uuid: "p-u3", permissionMode: "acceptEdits", message: { role: "user", content: "next" } }),
    j({ type: "assistant", uuid: "p-a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(3000) }] } }),
    j({ type: "assistant", uuid: "p-e1", isApiErrorMessage: true, apiErrorStatus: 429, message: { role: "assistant", content: [{ type: "text", text: "API Error: 429" }] } }),
    j({ type: "attachment", uuid: "p-att", attachment: { type: "x" } }),
    j({ type: "assistant", uuid: "p-a3", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
  ];
}

/** The old per-line event production, with `mapJsonlEventToChunks` (the old
 *  path's own mapper entry, raw line in) as the reference. */
async function referenceEvents(lines: string[]) {
  const { mapJsonlEventToChunks } = await import("./claude-tmux.ts");
  const seen = new Set<string>();
  let lastMode: string | null = null;
  const out: Array<{ stream: string; data: string; lineUuid: string | null }> = [];
  const keys = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    let uuid: string | undefined;
    let mode: string | undefined;
    try {
      const o = JSON.parse(line) as { uuid?: unknown; type?: unknown; permissionMode?: unknown };
      uuid = typeof o.uuid === "string" ? o.uuid : undefined;
      if ((o.type === "system" || o.type === "permission-mode" || o.type === "user") && typeof o.permissionMode === "string") mode = o.permissionMode;
    } catch { /* the mapper reports it */ }
    const prev = lastMode;
    if (mode !== undefined) lastMode = mode;
    if (uuid && seen.has(uuid)) continue;
    mapJsonlEventToChunks(line, (stream, data, lineUuid) => {
      // INSERT OR IGNORE on (run, subagent, line_uuid)
      if (lineUuid) {
        if (keys.has(lineUuid)) return;
        keys.add(lineUuid);
      }
      out.push({ stream, data, lineUuid: lineUuid ?? null });
    }, true, prev);
    if (uuid) seen.add(uuid);
  }
  return out;
}

async function runParity(readChunkBytes: number | null, failBatches: number): Promise<void> {
  const mod = await import("./claude-subagents.ts");
  const { db } = await import("./db.ts");
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();
  const id = "par0aaaaaaaa";
  const lines = parityLines();
  writeFileSync(path.join(subagentsDir, `agent-${id}.jsonl`), lines.join("\n") + "\n");
  mod.__forTest.setReadChunkBytes(readChunkBytes);
  const emitted: Array<{ id: number; stream: string; data: string }> = [];
  mod.setSubagentEmitter((e) => {
    if (e.id !== undefined && e.subagentId === id) emitted.push({ id: e.id, stream: e.stream, data: e.data });
  });
  const w = mod.attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  await w.ready;
  mod.__forTest.failNextBatchInserts(failBatches);
  await w.pump(Date.now());
  w.detach();

  const expected = await referenceEvents(lines);
  const rows = db.query<{ id: number; stream: string; data: string; line_uuid: string | null }, [string, string]>(
    `SELECT id, stream, data, line_uuid FROM run_events WHERE run_id = ? AND subagent_id = ? ORDER BY id`,
  ).all(runId, id);
  expect(rows.length).toBeGreaterThan(8);
  expect(rows.map((r) => ({ stream: r.stream, data: r.data, lineUuid: r.line_uuid }))).toEqual(expected);
  // The live sends are the saved rows, in id order, with the stored content.
  expect(emitted).toEqual(rows.map((r) => ({ id: r.id, stream: r.stream, data: r.data })));
}

test("parity: persisted and emitted events equal the old per-line path (one read per transcript)", async () => {
  await runParity(null, 0);
});

test("parity: the same events when the transcript spans many small chunks", async () => {
  await runParity(200, 0);
});

test("a failed batch insert is retried event by event: nothing dropped, nothing duplicated", async () => {
  await runParity(null, 1);
});

test("a failed batch insert across several chunks keeps every chunk's events exactly once", async () => {
  await runParity(300, 2);
});
