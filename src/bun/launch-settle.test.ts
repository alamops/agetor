import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// `launchesInFlight` / `waitForLaunchesToSettle` / `freezeLaunches`
// (orchestrator.ts): a core asked to hand the port off — and the app before it
// lets a quit through — stops taking new work, then waits for the agent
// launches it is still in the middle of before it exits
// (docs/plans/always-on-host.md; headless.ts `handOffPort`,
// quit-launch-gate.ts). A slow fake claude spawn holds the task's start claim,
// and a tmux op chain counts as in flight, which is exactly what the wait has
// to see.

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-launch-settle-"));
const workdirs: string[] = [];

const ENV_OVERRIDES: Record<string, string> = {
  // db.ts captures this at first import (dynamic imports below, after
  // beforeAll); if another file already opened the db, it stays that one.
  AGETOR_DATA_DIR: dataDir,
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "600",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  // Hold a fake codex turn in flight so a follow-up queues behind it.
  AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "500",
};
const savedEnv: Record<string, string | undefined> = {};
let restoreHarnesses: (() => void) | null = null;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await import("./db.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restoreHarnesses = snapshotHarnessState();
});

afterEach(async () => {
  const { __resetLaunchFreezeForTest } = await import("./orchestrator.ts");
  __resetLaunchFreezeForTest();
});

afterAll(() => {
  restoreHarnesses?.();
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(dataDir);
  for (const dir of workdirs) rmTestDataDir(dir);
});

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-launch-settle-wd-"));
  workdirs.push(dir);
  return dir;
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: not met within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

test("waitForLaunchesToSettle resolves at once when nothing is launching", async () => {
  const { launchesInFlight, waitForLaunchesToSettle } = await import("./orchestrator.ts");
  expect(launchesInFlight()).toBe(0);
  const t0 = Date.now();
  expect(await waitForLaunchesToSettle(5_000)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(100);
});

test("a slow spawn counts as in flight until it registers; the wait is bounded", async () => {
  const { createTask, startTask, launchesInFlight, waitForLaunchesToSettle, cancelRun } = await import(
    "./orchestrator.ts"
  );
  const created = await createTask({
    title: "launch settle",
    prompt: "hello",
    agent: "claude-code",
    workdir: makeWorkdir(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);

  const started = startTask(created.task.id);
  await Bun.sleep(50);
  expect(launchesInFlight()).toBeGreaterThan(0);

  // Bounded: still launching after 100 ms.
  expect(await waitForLaunchesToSettle(100)).toBe(false);
  // Settles once the spawn registers.
  expect(await waitForLaunchesToSettle(5_000)).toBe(true);
  expect(launchesInFlight()).toBe(0);

  const result = await started;
  expect("error" in result).toBe(false);
  if ("runId" in result && result.runId) await cancelRun(result.runId);
});

test("a claude tmux op chain (a paste between its text and its Enter) counts as in flight", async () => {
  const { launchesInFlight, waitForLaunchesToSettle } = await import("./orchestrator.ts");
  const { __forTest, claudeTmuxOpsInFlight } = await import("./claude-tmux.ts");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const op = __forTest.queueTmuxOp("launch-settle-tmux-op", () => gate);
  expect(claudeTmuxOpsInFlight()).toBe(1);
  expect(launchesInFlight()).toBe(1);
  expect(await waitForLaunchesToSettle(100)).toBe(false);
  release();
  await op;
  expect(await waitForLaunchesToSettle(1_000)).toBe(true);
  expect(claudeTmuxOpsInFlight()).toBe(0);
});

test("freezeLaunches: new starts, sends and fx resumes are refused; queued follow-ups move to the backlog and never drain", async () => {
  const {
    createTask,
    startTask,
    sendInput,
    resumeFxRecovery,
    freezeLaunches,
    launchesFrozen,
    LAUNCHES_FROZEN_REASON,
  } = await import("./orchestrator.ts");
  const { harnesses, runs, tasks } = await import("./db.ts");
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "freeze probe",
    prompt: "turn one",
    agent: "codex",
    workdir: makeWorkdir(),
    isolation: "none",
    model: "gpt-5.6-sol",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // Queued behind the in-flight turn (held open by the resolve delay).
  const queued = await sendInput(started.runId, "queued before the freeze");
  expect(queued.delivered).toBe(true);
  expect(runs.listForTask(taskId)).toHaveLength(1);

  freezeLaunches();
  expect(launchesFrozen()).toBe(true);
  freezeLaunches(); // idempotent

  // The queued line is in the tray now, with a status line on the run.
  expect((tasks.get(taskId)?.backlog ?? []).map((b) => b.text)).toEqual(["queued before the freeze"]);
  const statusLines = runs.eventsForTask(taskId).filter((e) => e.stream === "status").map((e) => e.data);
  expect(statusLines.some((d) => d.includes("queued message not sent — Agetor stopped before it could run"))).toBe(
    true,
  );

  // Every new launch path refuses.
  const other = await createTask({
    title: "freeze probe 2",
    prompt: "never runs",
    agent: "codex",
    workdir: makeWorkdir(),
    isolation: "none",
    model: "gpt-5.6-sol",
  });
  if ("error" in other) throw new Error(other.error);
  expect(await startTask(other.task.id)).toEqual({ error: LAUNCHES_FROZEN_REASON, code: "launches-frozen" });
  expect(await sendInput(started.runId, "after the freeze")).toEqual({
    delivered: false,
    reason: LAUNCHES_FROZEN_REASON,
  });
  expect(await sendInput(started.runId, "idle-only", { onlyIfIdle: true })).toEqual({
    delivered: false,
    busy: true,
    reason: LAUNCHES_FROZEN_REASON,
  });
  expect(await resumeFxRecovery(taskId)).toEqual({ ok: false, status: 409, error: LAUNCHES_FROZEN_REASON });

  // The in-flight turn still settles, and nothing drains after it.
  await waitFor(() => runs.listForTask(taskId)[0]?.status !== "running");
  await Bun.sleep(150);
  expect(runs.listForTask(taskId)).toHaveLength(1);
  expect((tasks.get(taskId)?.backlog ?? []).map((b) => b.text)).toEqual(["queued before the freeze"]);
});
