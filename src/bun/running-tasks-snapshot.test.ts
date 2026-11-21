/**
 * The in-memory running-tasks snapshot the desktop quit prompt reads
 * (`running-tasks-snapshot.ts`): first read on start, re-read on a revision
 * change, single-flight and spaced, a failed read keeps the last answer, and
 * the real `runs.runningTasks` read behind it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRunningTasksSnapshot, type RunningTask } from "./running-tasks-snapshot.ts";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-running-snapshot-"));

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A controllable read: each call returns a promise the test settles. */
function harness(minIntervalMs = 0) {
  const pending: Array<{ resolve: (v: RunningTask[]) => void; reject: (e: Error) => void }> = [];
  const listeners = new Set<() => void>();
  const logs: string[] = [];
  const snap = createRunningTasksSnapshot({
    read: () => new Promise<RunningTask[]>((resolve, reject) => pending.push({ resolve, reject })),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    minIntervalMs,
    log: (m) => logs.push(m),
  });
  const change = () => { for (const cb of [...listeners]) cb(); };
  return { snap, pending, listeners, logs, change };
}

describe("createRunningTasksSnapshot", () => {
  test("empty until the first read lands; start reads once and subscribes once", async () => {
    const h = harness();
    expect(h.snap.current()).toEqual([]);
    h.snap.start();
    h.snap.start();
    expect(h.pending).toHaveLength(1);
    expect(h.listeners.size).toBe(1);
    h.pending[0]!.resolve([{ taskId: "a", title: "A" }]);
    await until(() => h.snap.current().length === 1, "the first read");
    expect(h.snap.current()).toEqual([{ taskId: "a", title: "A" }]);
    h.snap.stop();
  });

  test("changes during a read coalesce into one re-read after it", async () => {
    const h = harness();
    h.snap.start();
    h.change();
    h.change();
    h.change();
    expect(h.pending).toHaveLength(1); // still the first read
    h.pending[0]!.resolve([]);
    await until(() => h.pending.length === 2, "the coalesced re-read");
    h.pending[1]!.resolve([{ taskId: "b", title: "B" }]);
    await until(() => h.snap.current().length === 1, "the re-read to land");
    for (let i = 0; i < 5; i++) await tick();
    expect(h.pending).toHaveLength(2);
    h.snap.stop();
  });

  test("re-reads are spaced by minIntervalMs", async () => {
    const h = harness(80);
    h.snap.start();
    h.pending[0]!.resolve([]);
    await tick();
    const changedAt = Date.now();
    h.change();
    await until(() => h.pending.length === 2, "the spaced re-read");
    expect(Date.now() - changedAt).toBeGreaterThanOrEqual(60);
    h.pending[1]!.resolve([]);
    h.snap.stop();
  });

  test("a failed read keeps the last snapshot and logs once per failure streak", async () => {
    const h = harness();
    h.snap.start();
    h.pending[0]!.resolve([{ taskId: "a", title: "A" }]);
    await until(() => h.snap.current().length === 1, "the first read");
    for (const n of [1, 2]) {
      h.change();
      await until(() => h.pending.length === n + 1, `read ${n + 1}`);
      h.pending[n]!.reject(new Error("database restarting"));
      await tick();
    }
    expect(h.snap.current()).toEqual([{ taskId: "a", title: "A" }]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("database restarting");
    h.snap.stop();
  });

  test("stop unsubscribes and drops a scheduled read", async () => {
    const h = harness(50);
    h.snap.start();
    h.pending[0]!.resolve([]);
    await tick();
    h.change(); // schedules a read ~50 ms out
    h.snap.stop();
    expect(h.listeners.size).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.pending).toHaveLength(1);
  });
});

describe("runs.runningTasks", () => {
  type Db = typeof import("./db.ts");
  let dbm: Db;
  const taskIds: string[] = [];
  afterAll(() => {
    for (const id of taskIds) dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  });

  test("lists each task with a running run once, with its title", async () => {
    dbm = await import("./db.ts");
    const fa = await import("./db-async.ts");
    const { makeRun, makeTask } = await import("./db-rpc-test-util.ts");
    const busy = makeTask({ title: `busy ${randomUUID()}` });
    const idle = makeTask({ title: `idle ${randomUUID()}` });
    taskIds.push(busy.id, idle.id);
    dbm.tasks.insert(busy);
    dbm.tasks.insert(idle);
    dbm.runs.insert(makeRun(busy.id, { status: "running" }));
    dbm.runs.insert(makeRun(busy.id, { status: "running" }));
    dbm.runs.insert(makeRun(idle.id, { status: "succeeded", endedAt: Date.now(), exitCode: 0 }));
    const rows = await fa.runs.runningTasks();
    expect(rows.filter((r) => r.taskId === busy.id)).toEqual([{ taskId: busy.id, title: busy.title }]);
    expect(rows.some((r) => r.taskId === idle.id)).toBe(false);
  });
});
