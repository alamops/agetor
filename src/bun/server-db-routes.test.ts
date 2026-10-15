// Route-level tests for the database-maintenance routes
// (docs/plans/non-blocking-session-restore.md §2.4, TT5): `GET /db/stats`,
// `POST /db/compact`, `POST /db/retention/run`, the retention hook on
// `PUT /preferences/archivedHistoryRetentionDays`, and the test-only
// `POST /test/block-event-loop`.
//
// AGETOR_DATA_DIR and the retention debounce seam are set at module scope
// BEFORE `./db.ts`/`./server.ts` are imported (db.ts opens + migrates on load).
// Two servers run in this one process so the env-gated block route can be
// exercised in both states — the gate is read at `startApiServer()` call time:
//   • 4620 — AGETOR_TEST_BLOCK_ROUTE unset  → `/test/block-event-loop` is a 404
//   • 4621 — AGETOR_TEST_BLOCK_ROUTE=1      → the route holds the main thread
//   • 4622 — a stub native host, for the native-file-dialog lag label
// (4620/4621/4622 are unique across src/ — grep before reusing.)
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DbCompactResult, DbStats, RetentionPassResult, Run } from "../shared/types.ts";
import { ARCHIVED_HISTORY_RETENTION_PREF } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-routes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Short debounce so a preference change schedules its pass within ~50 ms.
process.env.AGETOR_RETENTION_DEBOUNCE_MS = "50";
// A held fake CODEX turn is the "run in flight" the compact gate needs; no
// real CLI or tmux is ever spawned.
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const PLAIN = "http://127.0.0.1:4620";
const BLOCKING = "http://127.0.0.1:4621";
const NATIVE = "http://127.0.0.1:4622";

/** The lag label live while the stub native host's Open panel "is up", one
 *  entry per `openFileDialog` call (see the native-dialog describe below). */
const dialogLabels: (string | null)[] = [];

const DAY_MS = 86_400_000;

let servers: { stop: () => void }[] = [];
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let preferences: typeof import("./db.ts").preferences;
let harnesses: typeof import("./db.ts").harnesses;
let orchestrator: typeof import("./orchestrator.ts");
let retention: typeof import("./retention.ts");

beforeAll(async () => {
  ({ db, tasks, runs, preferences, harnesses } = await import("./db.ts"));
  orchestrator = await import("./orchestrator.ts");
  retention = await import("./retention.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  token = API_TOKEN;

  delete process.env.AGETOR_TEST_BLOCK_ROUTE;
  process.env.AGETOR_API_PORT = "4620";
  const plain = startApiServer() as unknown as { stop: () => void };

  process.env.AGETOR_TEST_BLOCK_ROUTE = "1";
  process.env.AGETOR_API_PORT = "4621";
  const blocking = startApiServer() as unknown as { stop: () => void };
  delete process.env.AGETOR_TEST_BLOCK_ROUTE;

  process.env.AGETOR_API_PORT = "4622";
  const { makeTestNative } = await import("./test-native.ts");
  const { currentLagLabel } = await import("./event-loop-lag.ts");
  const withNative = startApiServer({
    native: makeTestNative({
      openFileDialog: async () => {
        dialogLabels.push(currentLagLabel()?.label ?? null);
        return [];
      },
    }),
  }) as unknown as { stop: () => void };

  servers = [plain, blocking, withNative];
  harnesses.setEnabled("codex", true);
});

afterAll(() => {
  retention?.stopRetentionTimers();
  for (const s of servers) s.stop();
  rmTestDataDir(DATA_DIR);
});

const get = (p: string, base = PLAIN, withToken = true) =>
  fetch(`${base}${p}`, { headers: withToken ? { authorization: `Bearer ${token}` } : {} });

const post = (p: string, body: unknown = {}, base = PLAIN) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (p: string, value: string, base = PLAIN) =>
  fetch(`${base}${p}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!cond()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

/** Wait for any retention pass (a debounced one from an earlier test) to end. */
async function idleRetention(): Promise<void> {
  await waitFor(() => !retention.isRetentionRunning());
}

function clearRetentionBookkeeping(): void {
  db.run(`DELETE FROM preferences WHERE key LIKE 'retention:%'`);
}

let seedCounter = 0;

/** Insert a task archived 40 days ago with one run and `rows` tool_result
 *  events of `kb` KB each (JSON envelope the trim understands). */
async function seedArchivedTask(rows: number, kb: number): Promise<{ taskId: string; runId: string }> {
  const created = await orchestrator.createTask({
    title: `db-routes seed ${++seedCounter}`,
    prompt: "seed",
    agent: "codex",
    workdir: DATA_DIR,
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const runId = `db-routes-run-${seedCounter}-${Math.random().toString(36).slice(2, 8)}`;
  runs.insert({
    id: runId,
    taskId,
    agent: "codex",
    status: "succeeded",
    startedAt: Date.now() - 41 * DAY_MS,
    endedAt: Date.now() - 41 * DAY_MS + 1000,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  } as Run);
  const payload = (i: number) =>
    JSON.stringify({ toolUseId: `tu-${i}`, content: "x".repeat(kb * 1024), isError: false });
  db.transaction(() => {
    for (let i = 0; i < rows; i++) runs.appendEvent(runId, "tool_result", payload(i), `seed-${seedCounter}-${i}`);
  })();
  db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [Date.now() - 40 * DAY_MS, taskId]);
  return { taskId, runId };
}

describe("GET /db/stats", () => {
  test("returns every DbStats field with the right types; activeRunCount mirrors the orchestrator", async () => {
    const res = await get("/db/stats");
    expect(res.status).toBe(200);
    const s = (await res.json()) as DbStats;
    for (const k of [
      "fileBytes", "walBytes", "pageSize", "pageCount", "freelistCount",
      "reclaimableBytes", "compactEstimateSec", "activeRunCount",
    ] as const) {
      expect(typeof s[k]).toBe("number");
    }
    expect(s.fileBytes).toBeGreaterThan(0);
    expect(s.pageSize).toBeGreaterThan(0);
    expect(s.pageCount).toBeGreaterThan(0);
    expect(s.compactEstimateSec).toBeGreaterThanOrEqual(1);
    expect(s.reclaimableBytes).toBe(s.freelistCount * s.pageSize);
    // Other test files in the same `bun test` process can leave fake runs in
    // the orchestrator's in-memory `active` map, so compare against the live
    // count rather than assuming 0.
    expect(s.activeRunCount).toBe(orchestrator.activeRunCount());
    expect(s.retention.days === null || typeof s.retention.days === "number").toBe(true);
    expect(s.retention.lastRunAt === null || typeof s.retention.lastRunAt === "number").toBe(true);
    expect(s.retention.lastFreedBytes === null || typeof s.retention.lastFreedBytes === "number").toBe(true);
    expect(s.retention.lastTrimmedRows === null || typeof s.retention.lastTrimmedRows === "number").toBe(true);
    expect(typeof s.retention.running).toBe("boolean");
  });

  test("401 without the token (stats, compact, retention run)", async () => {
    expect((await get("/db/stats", PLAIN, false)).status).toBe(401);
    expect((await fetch(`${PLAIN}/db/compact`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${PLAIN}/db/retention/run`, { method: "POST" })).status).toBe(401);
  });
});

describe("POST /db/compact", () => {
  test("409 with the running-tasks message + activeRunCount while a run is active; 200 once idle", async () => {
    // Hold the fake codex turn in flight long enough to observe the gate.
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1500";
    try {
      const created = await orchestrator.createTask({
        title: "db-routes active run",
        prompt: "hold",
        agent: "codex",
        workdir: DATA_DIR,
        isolation: "none",
        taskType: "task",
      });
      if ("error" in created) throw new Error(created.error);
      // Runs other test files in this process left active count too — the
      // gate is relative to that baseline.
      const baseline = orchestrator.activeRunCount();
      const started = await orchestrator.startTask(created.task.id);
      expect("error" in started).toBe(false);
      await waitFor(() => orchestrator.activeRunCount() > baseline);

      const n = orchestrator.activeRunCount();
      const res = await post("/db/compact");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; activeRunCount: number };
      expect(body.activeRunCount).toBe(n);
      expect(body.error).toBe(`${n} task${n === 1 ? "" : "s"} running — stop or wait for them first`);

      // The stats route reports the same count.
      const stats = (await (await get("/db/stats")).json()) as DbStats;
      expect(stats.activeRunCount).toBe(n);

      await waitFor(() => orchestrator.activeRunCount() <= baseline, 6000);
    } finally {
      delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
    }
    await idleRetention();

    const leftover = orchestrator.activeRunCount();
    if (leftover > 0) {
      // Only reachable when an earlier test file in this process leaked an
      // active run: the gate must still name it, and the 200 path is covered
      // when this file runs on its own (and by the e2e).
      const refused = await post("/db/compact");
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { activeRunCount: number }).activeRunCount).toBe(leftover);
      return;
    }
    const res = await post("/db/compact");
    expect(res.status).toBe(200);
    const out = (await res.json()) as DbCompactResult;
    expect(out.ok).toBe(true);
    expect(typeof out.durationMs).toBe("number");
    expect(out.beforeBytes).toBeGreaterThan(0);
    expect(out.afterBytes).toBeLessThanOrEqual(out.beforeBytes);

    // The database still answers queries after the VACUUM.
    expect(tasks.list().length).toBeGreaterThan(0);
    expect((await get("/db/stats")).status).toBe(200);
  });

  test("409 while a retention pass is running", async () => {
    await idleRetention();
    await seedArchivedTask(1500, 5);
    // sliceMs 0 → the pass yields to the event loop after every row, so it is
    // still mid-flight (running === true from the synchronous prologue) when
    // the in-process HTTP request below is handled.
    const pass = retention.runArchivedHistoryRetentionPass({ days: 30, sliceMs: 0 });
    try {
      expect(retention.isRetentionRunning()).toBe(true);
      const res = await post("/db/compact");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        "archived-history retention is running — try again when it finishes",
      );
    } finally {
      // Never leave the pass running into the next test (or test file).
      const result = await pass;
      expect(result.trimmedRows).toBeGreaterThan(0);
    }
  });
});

describe("POST /db/retention/run", () => {
  test("400 when the preference is off", async () => {
    await idleRetention();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "off");
    const res = await post("/db/retention/run");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("archived-history retention is off");
  });

  test("200 with a RetentionPassResult that trimmed the seeded tool_result", async () => {
    await idleRetention();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "30");
    const { runId } = await seedArchivedTask(3, 32);
    const res = await post("/db/retention/run");
    expect(res.status).toBe(200);
    const r = (await res.json()) as RetentionPassResult;
    expect(r.trimmedRows).toBeGreaterThanOrEqual(3);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(r.scannedTasks).toBeGreaterThanOrEqual(1);
    expect(r.aborted).toBe(false);
    expect(typeof r.durationMs).toBe("number");
    // The rows really were rewritten: the retention marker is the first key.
    const sizes = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND substr(data, 1, 13) = '{"retention":'`,
      )
      .get(runId);
    expect(sizes?.n).toBe(3);
    // And the bookkeeping the stats route reports was written.
    const stats = (await (await get("/db/stats")).json()) as DbStats;
    expect(stats.retention.days).toBe(30);
    expect(stats.retention.lastRunAt).not.toBeNull();
    expect(stats.retention.lastTrimmedRows).toBe(r.trimmedRows);
  });

  test("409 while a pass is running", async () => {
    await idleRetention();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "30");
    await seedArchivedTask(1500, 5);
    const pass = retention.runArchivedHistoryRetentionPass({ days: 30, sliceMs: 0 });
    expect(retention.isRetentionRunning()).toBe(true);
    const res = await post("/db/retention/run");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already running");
    expect((await pass).trimmedRows).toBeGreaterThan(0);
  });
});

describe("PUT /preferences/archivedHistoryRetentionDays", () => {
  test("a non-off value schedules a debounced pass", async () => {
    await idleRetention();
    clearRetentionBookkeeping();
    await seedArchivedTask(2, 16);
    const res = await put(`/preferences/${ARCHIVED_HISTORY_RETENTION_PREF}`, "45");
    expect(res.status).toBe(204);
    expect(preferences.get(ARCHIVED_HISTORY_RETENTION_PREF)).toBe("45");
    // The seeded task was archived 40 days ago: inside a 45-day window, so the
    // pass finds nothing to trim but still completes and records its time.
    await waitFor(() => preferences.get("retention:lastRunAt") !== null, 3000);
    await idleRetention();
  });

  test("off does not schedule a pass", async () => {
    await idleRetention();
    clearRetentionBookkeeping();
    const res = await put(`/preferences/${ARCHIVED_HISTORY_RETENTION_PREF}`, "off");
    expect(res.status).toBe(204);
    // Well past the 50 ms debounce.
    await new Promise((r) => setTimeout(r, 400));
    expect(retention.isRetentionRunning()).toBe(false);
    expect(preferences.get("retention:lastRunAt")).toBeNull();
  });

  test("an off-word like \"0\" is stored as off and schedules nothing", async () => {
    await idleRetention();
    clearRetentionBookkeeping();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "30");
    await seedArchivedTask(2, 16);
    for (const word of ["0", " FALSE ", "none"]) {
      const res = await put(`/preferences/${ARCHIVED_HISTORY_RETENTION_PREF}`, word);
      expect(res.status).toBe(204);
      expect(preferences.get(ARCHIVED_HISTORY_RETENTION_PREF)).toBe("off");
    }
    // Well past the 50 ms debounce: the 40-day-old archived task stays untrimmed.
    await new Promise((r) => setTimeout(r, 400));
    expect(retention.isRetentionRunning()).toBe(false);
    expect(preferences.get("retention:lastRunAt")).toBeNull();
  });

  test("a value that is neither off nor 1..3650 days is a 400 that stores and schedules nothing", async () => {
    await idleRetention();
    clearRetentionBookkeeping();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "off");
    for (const bad of ["garbage", "-3", "3651", "1.5", "1e2", "", "  "]) {
      const res = await put(`/preferences/${ARCHIVED_HISTORY_RETENTION_PREF}`, bad);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("\"off\"");
      expect(error).toContain("1 to 3650");
      expect(preferences.get(ARCHIVED_HISTORY_RETENTION_PREF)).toBe("off");
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(retention.isRetentionRunning()).toBe(false);
    expect(preferences.get("retention:lastRunAt")).toBeNull();
  });

  test("a padded day count is stored normalized", async () => {
    await idleRetention();
    const res = await put(`/preferences/${ARCHIVED_HISTORY_RETENTION_PREF}`, " 090 ");
    expect(res.status).toBe(204);
    expect(preferences.get(ARCHIVED_HISTORY_RETENTION_PREF)).toBe("90");
    await waitFor(() => preferences.get("retention:lastRunAt") !== null, 3000);
    await idleRetention();
  });

  test("an unrelated preference never schedules a pass", async () => {
    await idleRetention();
    clearRetentionBookkeeping();
    preferences.set(ARCHIVED_HISTORY_RETENTION_PREF, "30");
    expect((await put("/preferences/someOtherKey", "45")).status).toBe(204);
    await new Promise((r) => setTimeout(r, 300));
    expect(preferences.get("retention:lastRunAt")).toBeNull();
  });
});

describe("native file dialogs carry a context-free lag label", () => {
  test("every route that opens the Open panel brackets it with \"native file dialog\"", async () => {
    delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
    dialogLabels.length = 0;
    const { currentLagLabel } = await import("./event-loop-lag.ts");
    // A profile so the folder save has something to export.
    const created = await post("/agent-profiles", { name: "dialog-label agent", harness: "codex", model: "gpt-6.1-sol" }, NATIVE);
    expect(created.ok).toBe(true);

    expect((await post("/projects/pick", {}, NATIVE)).status).toBe(200);
    expect((await post("/refs/pick", { mode: "files" }, NATIVE)).status).toBe(200);
    expect((await post("/bundle/pick-file", {}, NATIVE)).status).toBe(200);
    const save = await post("/bundle/export/save", { all: true, target: "folder" }, NATIVE);
    expect(save.status).toBe(200);
    expect(((await save.json()) as { cancelled?: boolean }).cancelled).toBe(true);

    expect(dialogLabels).toEqual(Array(4).fill("native file dialog"));
    // Disposed once each panel closes — nothing leaks onto the label stack.
    expect(currentLagLabel()).toBeNull();
  });
});

describe("POST /test/block-event-loop", () => {
  test("404 on a server started without AGETOR_TEST_BLOCK_ROUTE=1 (token or not)", async () => {
    expect((await post("/test/block-event-loop", { ms: 1 }, PLAIN)).status).toBe(404);
    expect((await fetch(`${PLAIN}/test/block-event-loop`, { method: "POST" })).status).toBe(404);
  });

  test("enabled server: validates ms, requires the token", async () => {
    expect((await fetch(`${BLOCKING}/test/block-event-loop`, { method: "POST" })).status).toBe(401);
    for (const ms of [0, -5, 20_001, 1.5, "100", null]) {
      expect((await post("/test/block-event-loop", { ms }, BLOCKING)).status).toBe(400);
    }
    expect((await post("/test/block-event-loop", {}, BLOCKING)).status).toBe(400);
    const ok = await post("/test/block-event-loop", { ms: 5 }, BLOCKING);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, ms: 5 });
  });

  test("a 300 ms block holds the main thread: timers and a concurrent /health are delayed", async () => {
    const t0 = performance.now();
    // A 20 ms timer scheduled before the block can only fire after it ends.
    const timerFiredAt = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - t0), 20));
    const block = post("/test/block-event-loop", { ms: 300 }, BLOCKING);
    const health = get("/health", BLOCKING, false).then((r) => {
      expect(r.status).toBe(200);
      return performance.now() - t0;
    });
    const blockRes = await block;
    expect(blockRes.status).toBe(200);
    expect(await timerFiredAt).toBeGreaterThanOrEqual(250);
    expect(await health).toBeGreaterThanOrEqual(250);
  });
});
