import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Event-loop drift regression test — docs/plans/non-blocking-session-restore.md
 * (TT2). The bug: `attachSubagentWatcher` used to rehydrate every subagent row
 * of a task (one DB query + stat each) and replay every transcript from offset
 * 0 as ONE synchronous block inside the spawn / reattach / boot path, so a task
 * that had run for weeks (hundreds of subagents, hundreds of MB of
 * transcripts) froze Bun's single main thread — every HTTP route, SSE stream,
 * tmux op and pipeline step — for seconds to minutes. The fix splits the start-
 * up into two cooperative jobs (seed + first cycle) stepped in ~20 ms slices
 * with a `setImmediate` yield between them.
 *
 * This file proves that property with the REAL watcher in timer mode over a
 * production-shaped fixture, measuring the longest gap between two 5 ms
 * sampler ticks while the watcher seeds and runs its first full pass.
 *
 * FIXTURE SIZE (and why it is smaller than the plan's ~180 MB). One task, 40
 * runs, 60 completed subagents, ~200k `run_events` rows (~160k subagent-tagged,
 * the rest main-stream), and 60 transcripts of ~3 MB (≈2500 lines each, ≈184 MB
 * of JSONL in total — the plan's figure). Per transcript, 2200 lines carry uuids
 * that the DB already holds (the seed must dedupe them) and 300 carry brand-new
 * uuids (18,000 new events overall). Measured on the dev machine, the OLD
 * synchronous path (manual mode runs seed + first cycle with `step(Infinity)`,
 * i.e. exactly the old inline code) blocked the loop for ~2.3 s in the first
 * `pump()` alone (plus the synchronous seed inside attach) — well above the
 * 500 ms "unfixed would block" bar the test relies on; the cooperative path
 * measured ~50-80 ms worst case when each file was still read in one block
 * (one 20 ms slice + one 3 MB file) and ~40-55 ms since transcripts are read
 * in `TAIL_READ_CHUNK_BYTES` (256 KB) chunks (one slice + one chunk).
 * ────────────────────────────────────────────────────────────────────────── */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-drift-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Transcripts live in their own dir (never under the data dir) so cleanup can
// never touch the live sqlite.
const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-drift-fixture-"));

const MAX_GAP_MS = 150;
const SAMPLE_MS = 5;

const TASK_ID = `task-drift-${randomUUID()}`;
const RUN_COUNT = 40;
const SUB_COUNT = 60;
/** Lines per transcript (≈1.2 KB each → ≈3 MB per file). */
const LINES_PER_FILE = 2500;
/** Lines whose uuid the DB already holds (the seed must dedupe them). */
const SEEDED_LINES_PER_FILE = 2200;
/** Seeded events per subagent — the 2200 above plus ids the transcript no longer has. */
const SEEDED_EVENTS_PER_SUB = 2666;
const MAIN_EVENT_COUNT = 40_000;
const NEW_LINES_PER_FILE = LINES_PER_FILE - SEEDED_LINES_PER_FILE;
const EXPECTED_NEW_EVENTS = SUB_COUNT * NEW_LINES_PER_FILE;

const SESSION_ID = `sess-${randomUUID()}`;
const PROJECT_DIR = path.join(FIXTURE_DIR, "projects", "encoded");
const SUBAGENTS_DIR = path.join(PROJECT_DIR, SESSION_ID, "subagents");
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-drift-wd-"));

const runIds = Array.from({ length: RUN_COUNT }, (_, i) => `run-drift-${i}-${randomUUID()}`);
const subIds = Array.from({ length: SUB_COUNT }, (_, i) => `drift${String(i).padStart(3, "0")}${randomUUID().slice(0, 8)}`);

const saved: Record<string, string | undefined> = {};
const createdTaskIds: string[] = [TASK_ID];

/** Longest stretch between two consecutive ticks of a `SAMPLE_MS` interval
 *  that the process actually spent computing. A free loop reads ~`SAMPLE_MS`;
 *  a blocked one reads the length of the block.
 *
 *  Each gap counts as `min(wall, process CPU time)`, not wall time alone: on
 *  an overloaded machine (the full suite next to other agents' runs, load
 *  average 30) the OS can deschedule the whole process for 100-200 ms, which
 *  shows up as a wall gap no code of ours caused, and is not what this
 *  measures. A loop held by synchronous work keeps the main thread on-CPU for
 *  the whole gap (the transcripts were just written, so their reads are page
 *  cache hits, not disk waits), so its CPU time ≈ its wall time and the min
 *  still reports the full block — the assertion bar is unchanged.
 *  `process.cpuUsage` is process-wide, so a GC helper thread can push CPU
 *  above wall; the min caps that. `stop()` returns that on-CPU max; `wallMax`
 *  is kept for the log line. */
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
    get wallMax(): number {
      return wallMax;
    },
    stop(): number {
      clearInterval(timer);
      // A final partial interval counts too (the loop may have been blocked
      // right up to the moment the sampler is stopped).
      return Math.max(max, onCpuGap(performance.now()));
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** String-template sidechain line (claude shape: `isSidechain`, one text block,
 *  a uuid that is the dedup key). Templates, not JSON.stringify per line —
 *  this runs 150k times. */
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(17).slice(0, 900);
function sidechainLine(agentId: string, n: number, uuid: string, last: boolean): string {
  return (
    `{"parentUuid":null,"isSidechain":true,"userType":"external","sessionId":"${SESSION_ID}",` +
    `"agentId":"${agentId}","type":"assistant","message":{"id":"msg_${n}","type":"message",` +
    `"role":"assistant","model":"claude-fake","content":[{"type":"text","text":"[${n}] ${FILLER}"}],` +
    `"stop_reason":${last ? '"end_turn"' : "null"}},"uuid":"${uuid}","timestamp":"2026-01-01T00:00:00.000Z"}`
  );
}

/** uuid of line `n` of subagent `i`: lines below SEEDED_LINES_PER_FILE are in the DB. */
function lineUuid(i: number, n: number): string {
  return `drift-${i}-${n < SEEDED_LINES_PER_FILE ? "s" : "n"}-${n}`;
}

async function buildFixture(): Promise<void> {
  const { db, tasks, runs, subagents } = await import("./db.ts");
  mkdirSync(SUBAGENTS_DIR, { recursive: true });
  writeFileSync(JSONL_PATH, "");

  // Transcripts first (async file IO), then one big DB transaction.
  for (let i = 0; i < SUB_COUNT; i++) {
    const agentId = subIds[i]!;
    const lines: string[] = new Array(LINES_PER_FILE);
    for (let n = 0; n < LINES_PER_FILE; n++) {
      lines[n] = sidechainLine(agentId, n, lineUuid(i, n), n === LINES_PER_FILE - 1);
    }
    await Bun.write(path.join(SUBAGENTS_DIR, `agent-${agentId}.jsonl`), lines.join("\n") + "\n");
  }

  const now = Date.now();
  const insertEvent = db.prepare(
    `INSERT INTO run_events (run_id, stream, data, ts, line_uuid, subagent_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    tasks.insert({
      id: TASK_ID, title: "drift", prompt: "p", column: "review", agent: "claude-code",
      workdir: WORKDIR, isolation: "none", taskType: "task", branch: null, branchSource: "created",
      worktreePath: null, baseRef: null, mode: null, model: null, effort: null,
      speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
      runId: runIds[0]!, prUrl: null,
      hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
      archivedAt: null, createdAt: now, updatedAt: now,
    });
    for (let r = 0; r < RUN_COUNT; r++) {
      runs.insert({
        id: runIds[r]!, taskId: TASK_ID, agent: "claude-code", status: "succeeded",
        startedAt: now - (RUN_COUNT - r) * 1000, endedAt: now - (RUN_COUNT - r) * 1000 + 500, exitCode: 0,
        tmuxSession: null,
        // Only run 0 carries a session id — the re-arm test below needs one.
        claudeSessionId: r === 0 ? `sess-rearm-${randomUUID()}` : null,
        codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
      });
    }
    for (let i = 0; i < SUB_COUNT; i++) {
      const agentId = subIds[i]!;
      const runId = runIds[i % RUN_COUNT]!;
      subagents.insertIfAbsent({
        id: agentId, taskId: TASK_ID, runId, parentKind: "subagent", agentType: "general-purpose",
        description: `drift subagent ${i}`, spawnDepth: 1,
        sourcePath: path.join(SUBAGENTS_DIR, `agent-${agentId}.jsonl`),
        // Present so the seed never reads a `.meta.json` sidecar (there is none).
        toolUseId: `toolu_${agentId}`,
        status: "completed", startedAt: now - 60_000 + i, endedAt: now - 30_000,
      });
      for (let n = 0; n < SEEDED_EVENTS_PER_SUB; n++) {
        // The first SEEDED_LINES_PER_FILE ids are the transcript's seeded lines;
        // the rest are extras the transcript no longer carries.
        const uuid = n < SEEDED_LINES_PER_FILE ? lineUuid(i, n) : `drift-${i}-x-${n}`;
        insertEvent.run(runId, "assistant", '{"seed":1}', now, uuid, agentId);
      }
    }
    for (let m = 0; m < MAIN_EVENT_COUNT; m++) {
      insertEvent.run(runIds[m % RUN_COUNT]!, "assistant", '{"main":1}', now, `drift-main-${m}`, null);
    }
  })();
}

async function eventCount(taskId: string, subagentOnly: boolean): Promise<number> {
  const { db } = await import("./db.ts");
  return db.query<{ c: number }, [string]>(
    `SELECT COUNT(*) c FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE r.task_id = ?${subagentOnly ? " AND e.subagent_id IS NOT NULL" : ""}`,
  ).get(taskId)!.c;
}

beforeAll(async () => {
  for (const k of ["AGETOR_TMUX_BIN", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_CLAUDE_ARGS"]) {
    saved[k] = process.env[k];
  }
  // tmux probes (`has-session`) answer "alive" (exit 0) and the claude pre-flight passes
  // without the real CLI installed.
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_CLAUDE_ARGS = "";
  await import("./db.ts");
});

afterAll(async () => {
  const { detachWatcherFor } = await import("./claude-subagents.ts");
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try { detachWatcherFor(id); } catch { /* best-effort */ }
    // FK cascade removes runs / subagents / run_events, and takes the held-shaped
    // rows out of every later `reconcileOrphans` scan in this shared process.
    try { db.run(`DELETE FROM tasks WHERE id = ?`, [id]); } catch { /* best-effort */ }
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(WORKDIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

test(
  "the real watcher seeds 60 subagents / 3 MB transcripts / ~200k events without blocking the loop, and dedupes the replay",
  async () => {
    const t0 = performance.now();
    await buildFixture();
    console.log(`[drift] fixture built in ${(performance.now() - t0).toFixed(0)} ms`);

    const { attachSubagentWatcher } = await import("./claude-subagents.ts");
    const { subagents } = await import("./db.ts");
    expect(subagents.listForTask(TASK_ID).length).toBe(SUB_COUNT);

    const totalBefore = await eventCount(TASK_ID, false);
    const subBefore = await eventCount(TASK_ID, true);
    expect(subBefore).toBe(SUB_COUNT * SEEDED_EVENTS_PER_SUB);
    expect(totalBefore).toBe(SUB_COUNT * SEEDED_EVENTS_PER_SUB + MAIN_EVENT_COUNT);

    const sampler = startGapSampler();
    const attachedAt = performance.now();
    // Timer mode on purpose (`manual` unset): this is the production code path.
    const handle = attachSubagentWatcher({ taskId: TASK_ID, jsonlPath: JSONL_PATH, runId: runIds[0] });

    let readyMs = -1;
    await Promise.race([
      handle.ready.then(() => { readyMs = performance.now() - attachedAt; }),
      Bun.sleep(2000),
    ]);
    expect(readyMs).toBeGreaterThanOrEqual(0); // ready resolved within 2 s of the attach
    expect(readyMs).toBeLessThan(2000);

    await handle.settled;
    const settledMs = performance.now() - attachedAt;
    const maxGap = sampler.stop();
    console.log(
      `[drift] ready ${readyMs.toFixed(0)} ms, settled ${settledMs.toFixed(0)} ms, ` +
        `max loop gap ${maxGap.toFixed(1)} ms on-CPU / ${sampler.wallMax.toFixed(1)} ms wall (budget ${MAX_GAP_MS} ms)`,
    );
    handle.detach();

    expect(maxGap).toBeLessThan(MAX_GAP_MS);

    // The first pass replayed every transcript from offset 0: the 2200 seeded
    // uuids per file must dedupe through the task-scoped seen-set, so only the
    // 300 unseen lines per file land.
    const subAfter = await eventCount(TASK_ID, true);
    expect(subAfter - subBefore).toBe(EXPECTED_NEW_EVENTS);
    // Nothing leaked into the main stream.
    expect(await eventCount(TASK_ID, false)).toBe(totalBefore + EXPECTED_NEW_EVENTS);
    // Rows the DB called completed stay completed (replay must not resurrect them).
    expect(subagents.listForTask(TASK_ID).every((s) => s.status === "completed")).toBe(true);
  },
  120_000,
);

test(
  "boot re-arm of a review-column task with a running subagent (reconcileOrphans) awaits the cooperative seed without blocking the loop",
  async () => {
    const { subagents } = await import("./db.ts");
    const { reconcileOrphans } = await import("./orchestrator.ts");
    const { detachWatcherFor } = await import("./claude-subagents.ts");

    // The fixture task is already `review` with run 0 (a succeeded claude run
    // carrying a claudeSessionId) as `task.runId`; flip ONE subagent back to
    // `running` — the shape `reconcileOrphans`'s "any column" held-task pass
    // looks for. `AGETOR_TMUX_BIN=/bin/echo` (beforeAll) makes `has-session`
    // exit 0, so the session reads as alive and the pass re-arms the watcher
    // (`await attachSubagentWatcher(...).ready`) instead of orphaning the row.
    // The watcher it attaches points at a non-existent main JSONL under the
    // real ~/.claude (nothing is ever written there); the heavy part is the
    // seed over the 60 rehydrated rows / ~160k persisted uuids.
    const runningId = subIds[7]!;
    subagents.setStatus(runningId, "running", null);

    const sampler = startGapSampler();
    const t0 = performance.now();
    try {
      await reconcileOrphans();
    } finally {
      const maxGap = sampler.stop();
      detachWatcherFor(TASK_ID); // before the first cycle (600 ms later) starts replaying 180 MB
      console.log(
        `[drift] reconcileOrphans (re-arm) took ${(performance.now() - t0).toFixed(0)} ms, ` +
          `max loop gap ${maxGap.toFixed(1)} ms on-CPU / ${sampler.wallMax.toFixed(1)} ms wall (budget ${MAX_GAP_MS} ms)`,
      );
      expect(maxGap).toBeLessThan(MAX_GAP_MS);
    }

    // Re-armed, not orphaned: the orphan path would have flipped the row.
    expect(subagents.get(runningId)!.status).toBe("running");
  },
  120_000,
);

test(
  "fake-driver real-watcher seam: turn 1 persists the subagent rows + events, a follow-up turn re-attaches and dedupes to zero new rows/events",
  async () => {
    process.env.AGETOR_CLAUDE_DRIVER = "fake";
    const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
    const { FAKE_CLAUDE_REAL_WATCHER_PROMPT_MARKER } = await import("./agents.ts");
    const { subagents, runs, tasks } = await import("./db.ts");

    const workdir = mkdtempSync(path.join(tmpdir(), "agetor-drift-seam-"));
    try {
      const created = await createTask({
        title: "real watcher seam",
        prompt: `exercise the watcher ${FAKE_CLAUDE_REAL_WATCHER_PROMPT_MARKER}:6x32`,
        agent: "claude-code",
        workdir,
        isolation: "none",
      });
      if ("error" in created) throw new Error(created.error);
      const taskId = created.task.id;
      createdTaskIds.push(taskId);

      const started = await startTask(taskId);
      if (!("runId" in started)) throw new Error(`expected the run to start: ${JSON.stringify(started)}`);
      const firstRunId = started.runId;
      await waitFor(() => runs.get(firstRunId)?.status === "succeeded", 30_000, "turn 1 to settle");

      expect(subagents.listForTask(taskId).length).toBe(6);
      const subEvents = await eventCount(taskId, true);
      expect(subEvents).toBeGreaterThan(0);

      // Follow-up: the marker-less turn finds the scenario through the task's
      // stored prompt, re-attaches a fresh watcher (real rehydrate + offset-0
      // replay) and must dedupe everything.
      const sent = await sendInput(firstRunId, "follow-up");
      if (!sent.delivered) throw new Error(`follow-up not delivered: ${JSON.stringify(sent)}`);
      const secondRunId = sent.runId;
      expect(secondRunId).not.toBe(firstRunId);
      await waitFor(() => runs.get(secondRunId)?.status === "succeeded", 30_000, "turn 2 to settle");
      expect(tasks.get(taskId)?.runId).toBe(secondRunId);

      expect(subagents.listForTask(taskId).length).toBe(6);
      expect(await eventCount(taskId, true)).toBe(subEvents);
    } finally {
      if (saved.AGETOR_CLAUDE_DRIVER === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
      else process.env.AGETOR_CLAUDE_DRIVER = saved.AGETOR_CLAUDE_DRIVER;
      rmSync(workdir, { recursive: true, force: true });
    }
  },
  60_000,
);
