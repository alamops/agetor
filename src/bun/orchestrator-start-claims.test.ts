import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/*
 * The start claim with the database on another thread
 * (docs/plans/non-blocking-core.md, T10d). `startTask` reads the task row, a
 * thread hop, before it decides; two starts landing together, or a message
 * sent while a start is still being prepared, must still produce exactly one
 * run: the in-memory claim (`startingTaskIds`) is taken before the first await
 * and every competing path checks it in the same synchronous step as its own
 * decision.
 */

// db.ts captures AGETOR_DATA_DIR at first import: set at the top level.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-start-claims-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  rmTestDataDir(DATA_DIR);
});

const createdTaskIds: string[] = [];
afterEach(async () => {
  delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  const { cancelRun } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    const runId = tasks.get(id)?.runId;
    if (runId) await cancelRun(runId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

async function newClaudeTask(title: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // never create branches in the live repo
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("two starts landing together spawn exactly once", async () => {
  const taskId = await newClaudeTask("double start");
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  // The spawn sits for a while, so the first start still holds its claim when
  // the second one decides.
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "200";

  // Both issued in the same tick: each reads the task row (a hop) before it
  // could decide anything from it.
  const [a, b] = await Promise.all([startTask(taskId), startTask(taskId)]);

  const started = [a, b].filter((r) => "runId" in r);
  const refused = [a, b].filter((r) => "error" in r);
  expect(started).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect((refused[0] as { error: string }).error).toBe("task is already starting");
  expect(runs.listForTask(taskId)).toHaveLength(1);
  expect(runs.listForTask(taskId)[0]!.id).toBe((started[0] as { runId: string }).runId);
});

test("a second start issued while the first is mid-preparation is refused, and only one run exists", async () => {
  const taskId = await newClaudeTask("staggered start");
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "300";

  const first = startTask(taskId);
  // Let the first start get past its reads and into the spawn.
  await waitFor(() => runs.listForTask(taskId).length === 1);
  const second = await startTask(taskId);
  expect(second).toEqual({ error: "task is already starting" });

  const firstResult = await first;
  expect("runId" in firstResult).toBe(true);
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("a message sent while a start is being prepared is refused as already starting — no second run", async () => {
  const taskId = await newClaudeTask("start plus send");
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "300";

  const starting = startTask(taskId);
  // The run row exists and the task points at it; its agent is still spawning
  // (the start claim is held, nothing is registered yet).
  await waitFor(() => runs.listForTask(taskId).length === 1 && tasks.get(taskId)?.runId != null);
  const runId = tasks.get(taskId)!.runId!;

  const sent = await sendInput(runId, "typed while it starts");
  // Exactly as before the database moved threads: the start owns the task, so
  // the send neither folds into a run that is not live yet nor mints a second
  // run; it is refused with the "already starting" reason (the UI keeps the
  // draft).
  expect(sent.delivered).toBe(false);
  if (!sent.delivered) expect(sent.reason).toContain("already starting");

  const started = await starting;
  expect("runId" in started).toBe(true);
  if ("runId" in started) expect(started.runId).toBe(runId);
  expect(runs.listForTask(taskId)).toHaveLength(1);
  expect(runs.eventsForTask(taskId).some((e) => e.stream === "user" && e.data.includes("typed while it starts"))).toBe(false);
});

test("many sends racing one start never mint a second run", async () => {
  const taskId = await newClaudeTask("start plus burst");
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "300";

  const starting = startTask(taskId);
  await waitFor(() => tasks.get(taskId)?.runId != null);
  const runId = tasks.get(taskId)!.runId!;
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sendInput(runId, `burst ${i}`)));
  for (const r of results) {
    if (r.delivered) expect(r.runId).toBe(runId);
  }
  await starting;
  expect(runs.listForTask(taskId)).toHaveLength(1);
});
