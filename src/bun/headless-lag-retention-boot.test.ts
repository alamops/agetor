/**
 * Boot wiring of the event-loop lag monitor and the archived-history retention
 * scheduler (docs/plans/non-blocking-session-restore.md, decisions C and G):
 * boots the real headless daemon as a subprocess against a data dir seeded with
 * an archived-old task, and checks that
 *   - `scheduleRetention()` runs a first pass after the (shortened) boot delay
 *     and that pass trims and records its bookkeeping, visible on GET /db/stats;
 *   - `startLagMonitor()` reports a deliberate core stall on stderr;
 *   - the env switches (`AGETOR_ARCHIVED_HISTORY_RETENTION=0`, and the lag
 *     monitor's default-off under `NODE_ENV=test`) are honored at boot;
 *   - shutdown still exits 0 with both armed.
 *
 * Seeding happens in a separate `bun` process (db.ts migrates on load and is a
 * process-wide singleton, so it must not be imported into this test process
 * against a different data dir). For the same reason the data dirs here are
 * never this process's own db dir, so removing them with `rmSync` once the
 * daemon has exited is safe (`rmTestDataDir` would refuse: the daemon leaves
 * an `agetor.sqlite` behind).
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DAY = 86_400_000;
const DB_MODULE = path.join(import.meta.dir, "db.ts");

/** One archived-40-days-ago task with one run holding a single ~64 KB
 *  tool_result row (a retention candidate) and one small one (not). */
async function seedDataDir(dir: string): Promise<{ taskId: string; bigEventId: number }> {
  const script = `
    const { tasks, runs } = await import(${JSON.stringify(DB_MODULE)});
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = Date.now();
    tasks.insert({
      id: taskId, title: "boot retention", prompt: "p", agent: "claude-code", workdir: "/tmp",
      isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
      baseRef: null, prUrl: null, mode: null, model: null, effort: null, speed: "off", maxMode: false,
      references: [], backlog: [], plans: [], draft: null, column: "ready", runId: null,
      createdAt: now, updatedAt: now, hasOpenableRun: false, pendingInteractionCount: 0,
      openTerminalCount: 0, archivedAt: now - ${40 * DAY},
    });
    runs.insert({
      id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now, endedAt: now + 1,
      exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
      cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    });
    const big = JSON.stringify({ toolUseId: "toolu_big", content: "x ".repeat(32 * 1024), isError: false });
    const small = JSON.stringify({ toolUseId: "toolu_small", content: "ok", isError: false });
    const bigEventId = runs.appendEvent(runId, "tool_result", big, "ln-big", null)!.id;
    runs.appendEvent(runId, "tool_result", small, "ln-small", null);
    console.log(JSON.stringify({ taskId, bigEventId }));
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, AGETOR_DATA_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`seed failed (${code}): ${err}`);
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`seed printed nothing: ${out}`);
  return JSON.parse(line);
}

type Daemon = {
  base: string;
  bearer: Record<string, string>;
  stderr: () => string;
  proc: ReturnType<typeof Bun.spawn>;
};

const MASTER_TOKEN = randomBytes(32).toString("hex");

async function bootDaemon(dir: string, port: number, env: Record<string, string | undefined>): Promise<Daemon> {
  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dir,
      AGETOR_API_PORT: String(port),
      AGETOR_DAEMON_IDLE_MS: "0",
      AGETOR_TEST_BLOCK_ROUTE: "1",
      // `/test/block-event-loop` is desktop-only (an app-token route), and
      // `agetor-core.json` only ever holds the CLI-scoped token, so the test
      // drives the child with a master token it chose itself.
      AGETOR_API_TOKEN: MASTER_TOKEN,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderrText = "";
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrText += decoder.decode(value, { stream: true });
    }
  })();
  // Drain stdout too so the child never blocks on a full pipe.
  void new Response(proc.stdout as ReadableStream<Uint8Array>).text();

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try {
      up = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await Bun.sleep(100);
  }
  if (!up) {
    proc.kill();
    throw new Error(`daemon never came up: ${stderrText}`);
  }
  return { base, bearer: { authorization: `Bearer ${MASTER_TOKEN}` }, stderr: () => stderrText, proc };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

type Stats = { retention: { days: number | null; lastRunAt: number | null; lastTrimmedRows: number | null; running: boolean } };

async function getStats(d: Daemon): Promise<Stats> {
  const res = await fetch(`${d.base}/db/stats`, { headers: d.bearer });
  expect(res.status).toBe(200);
  return (await res.json()) as Stats;
}

async function blockCore(d: Daemon, ms: number): Promise<void> {
  const res = await fetch(`${d.base}/test/block-event-loop`, {
    method: "POST",
    headers: { ...d.bearer, "content-type": "application/json" },
    body: JSON.stringify({ ms }),
  });
  expect(res.status).toBe(200);
}

async function shutdown(d: Daemon): Promise<void> {
  const res = await fetch(`${d.base}/daemon/shutdown`, { method: "POST", headers: d.bearer });
  expect(res.status).toBe(200);
  expect(await d.proc.exited).toBe(0);
}

test("headless boot arms retention (first pass trims + records) and the lag monitor (a stall is reported)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-boot-retention-"));
  const seeded = await seedDataDir(dir);
  const d = await bootDaemon(dir, 4641, {
    AGETOR_RETENTION_BOOT_DELAY_MS: "300",
    AGETOR_LAG_MONITOR: "1",
    AGETOR_ARCHIVED_HISTORY_RETENTION: undefined,
  });
  try {
    // The scheduled first pass ran on its own — nothing here asked for it.
    const stats = await waitFor(
      "the boot-scheduled retention pass",
      async () => {
        const s = await getStats(d);
        return s.retention.lastRunAt !== null && !s.retention.running ? s : null;
      },
      20_000,
    );
    expect(stats.retention.days).toBe(30);
    expect(stats.retention.lastTrimmedRows).toBe(1);

    // A deliberate 1.5 s freeze of the core is named on stderr by the monitor.
    expect(d.stderr()).not.toContain("core was unresponsive");
    await blockCore(d, 1500);
    const line = await waitFor(
      "the lag monitor's stall report",
      async () => d.stderr().split("\n").find((l) => l.includes("core was unresponsive for")) ?? null,
      10_000,
    );
    expect(line).toMatch(/core was unresponsive for \d+\.\ds during /);

    await shutdown(d);
  } finally {
    d.proc.kill();
    await d.proc.exited;
  }

  // The pass wrote through to the db the daemon owned: the big row is
  // marker-first, and the sweep is recorded for the task.
  const check = Bun.spawn(
    [
      "bun",
      "-e",
      `const { db, retentionSweeps } = await import(${JSON.stringify(DB_MODULE)});
       const row = db.query("SELECT data FROM run_events WHERE id = ?").get(${seeded.bigEventId});
       console.log(JSON.stringify({ trimmed: row.data.startsWith('{"retention":'), swept: retentionSweeps.all().has(${JSON.stringify(seeded.taskId)}) }));`,
    ],
    { cwd: process.cwd(), env: { ...process.env, AGETOR_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(check.stdout).text();
  expect(await check.exited).toBe(0);
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop()!;
  expect(JSON.parse(line)).toEqual({ trimmed: true, swept: true });
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

test("headless boot honors the kill switches: no retention pass with AGETOR_ARCHIVED_HISTORY_RETENTION=0, no lag report under NODE_ENV=test", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-boot-retention-off-"));
  await seedDataDir(dir);
  const d = await bootDaemon(dir, 4642, {
    AGETOR_RETENTION_BOOT_DELAY_MS: "100",
    AGETOR_ARCHIVED_HISTORY_RETENTION: "0",
    AGETOR_LAG_MONITOR: undefined,
    NODE_ENV: "test",
  });
  try {
    await blockCore(d, 1500);
    // Ample time for both the 100 ms boot delay and a 100 ms lag sample.
    await Bun.sleep(1500);
    const stats = await getStats(d);
    expect(stats.retention.days).toBeNull();
    expect(stats.retention.lastRunAt).toBeNull();
    expect(stats.retention.running).toBe(false);
    expect(d.stderr()).not.toContain("core was unresponsive");
    await shutdown(d);
  } finally {
    d.proc.kill();
    await d.proc.exited;
  }
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
