import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// The desktop quit prompt's running tasks (index.ts `before-quit`): the
// database snapshot (`running-tasks-snapshot.ts`) can trail a start by a read,
// so it is unioned with the orchestrator's synchronous `liveRunTaskIds()`. A
// run this process has claimed but the snapshot has not seen yet must still
// produce the confirm dialog, named (by its id when no title is known).

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-quit-running-"));
const workdirs: string[] = [];
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_DATA_DIR: dataDir,
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  // Holds the task's start claim (`startingTaskIds`) for the whole test.
  AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "3000",
};
const savedEnv: Record<string, string | undefined> = {};
let restoreHarnesses: (() => void) | null = null;
const taskIds: string[] = [];

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await import("./db.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restoreHarnesses = snapshotHarnessState();
});

afterAll(async () => {
  const { deleteTask, __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
  for (const id of taskIds) await deleteTask(id).catch(() => {});
  restoreHarnesses?.();
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(dataDir);
  for (const dir of workdirs) rmTestDataDir(dir);
});

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: not met within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

test("quitRunningTasks: snapshot first, live extras added once, a missing title falls back to the id", async () => {
  const { quitRunningTasks } = await import("./running-tasks-snapshot.ts");
  expect(quitRunningTasks([], [])).toEqual([]);
  expect(
    quitRunningTasks(
      [{ taskId: "a", title: "Task A" }, { taskId: "gone", title: "" }],
      ["b", "a", "b"],
    ),
  ).toEqual([
    { taskId: "a", title: "Task A" },
    { taskId: "gone", title: "gone" },
    { taskId: "b", title: "b" },
  ]);
});

test("a run claimed in memory but not yet in the snapshot still produces the quit warning", async () => {
  const orchestrator = await import("./orchestrator.ts");
  const guard = await import("./quit-guard.ts");
  const { createQuitLaunchGate, decideBeforeQuit } = await import("./quit-launch-gate.ts");
  const { createRunningTasksSnapshot, quitRunningTasks } = await import("./running-tasks-snapshot.ts");

  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-quit-running-wd-"));
  workdirs.push(workdir);
  const created = await orchestrator.createTask({ title: "quit warning", prompt: "hello", agent: "claude-code", workdir, isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  taskIds.push(taskId);

  // A snapshot whose read has not caught up with the start: empty.
  const snapshot = createRunningTasksSnapshot({
    read: () => Promise.resolve([]),
    onChange: () => () => {},
    minIntervalMs: 250,
    log: () => {},
  });
  snapshot.start();
  await Bun.sleep(0);

  const started = orchestrator.startTask(taskId);
  await waitFor(() => orchestrator.liveRunTaskIds().includes(taskId));
  expect(snapshot.current()).toEqual([]);

  const gate = createQuitLaunchGate({
    launchesInFlight: orchestrator.launchesInFlight,
    waitForLaunchesToSettle: orchestrator.waitForLaunchesToSettle,
    freezeLaunches: orchestrator.freezeLaunches,
    requeueQuit: () => {},
    timeoutMs: 8_000,
  });
  // quit-guard's force/completely flags are module state shared across files in
  // one bun test process: drain any an earlier quit test left pending, or a
  // stale force-quit skips the running check and the decision is a veto.
  guard.consumeForceQuit();
  guard.consumeQuitCompletely();
  const decide = (runningTaskIds: () => string[]) =>
    decideBeforeQuit({
      consumeForceQuit: guard.consumeForceQuit,
      consumeQuitCompletely: guard.consumeQuitCompletely,
      gate,
      hasSupervisor: false,
      runningTaskIds,
    });

  // index.ts's union: the claimed run is named.
  const union = () => quitRunningTasks(snapshot.current(), orchestrator.liveRunTaskIds());
  const d = decide(() => union().map((t) => t.taskId));
  // Other files in a shared process may leave their own live runs: assert on this task's id, not an exact list.
  expect(d).toMatchObject({ kind: "confirm", completely: false });
  expect((d as { runningTaskIds: string[] }).runningTaskIds).toContain(taskId);
  expect(union().filter((t) => t.taskId === taskId)).toEqual([{ taskId, title: taskId }]);

  snapshot.stop();
  const result = await started;
  if ("runId" in result && result.runId) await orchestrator.cancelRun(result.runId);
}, 20_000);

test("index.ts's before-quit handler names the union of the snapshot and liveRunTaskIds", () => {
  const src = readFileSync(path.join(import.meta.dir, "index.ts"), "utf8");
  const handler = src.slice(src.indexOf('"before-quit"'));
  expect(handler).toMatch(/runningTaskIds:\s*\(\)\s*=>\s*quitRunningTasks\(runningTasksSnapshot\.current\(\),\s*liveRunTaskIds\(\)\)/);
  expect(handler).toMatch(/runningTaskTitles:\s*quitRunningTasks\(runningTasksSnapshot\.current\(\),\s*liveRunTaskIds\(\)\)/);
});
