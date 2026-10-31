import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// The app's quit path end to end, minus Electrobun: index.ts wires the REAL
// quit-guard flags (`armForceQuit` / `consumeForceQuit` /
// `consumeQuitCompletely`) and the REAL orchestrator counters
// (`launchesInFlight` / `waitForLaunchesToSettle` / `freezeLaunches`) into
// `createQuitLaunchGate`, and its `before-quit` handler applies
// `decideBeforeQuit`. index.ts boots Electrobun on import, so `makeApp` below
// wires the same pieces the same way and drives the real `decideBeforeQuit`;
// the last test pins index.ts to calling it.

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-quit-flow-"));
const workdirs: string[] = [];
const taskIds: string[] = [];

const ENV_OVERRIDES: Record<string, string> = {
  // db.ts captures this at first import (dynamic imports below, after
  // beforeAll); if another file already opened the db, it stays that one.
  AGETOR_DATA_DIR: dataDir,
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  // Holds the task's start claim, i.e. one launch in flight. Long enough that
  // the whole held-quit sequence below fits inside it even under load.
  AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "3000",
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
  const { consumeForceQuit, consumeQuitCompletely } = await import("./quit-guard.ts");
  consumeForceQuit();
  consumeQuitCompletely();
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

async function makeTask(title: string, prompt: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({ title, prompt, agent: "claude-code", workdir: makeWorkdir(), isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  taskIds.push(created.task.id);
  return created.task.id;
}

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-quit-flow-wd-"));
  workdirs.push(dir);
  return dir;
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: not met within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

/** The app with its quit wiring: `quit()` stands in for `Utils.quit()`, which
 *  fires `before-quit` synchronously; `allowed` records each quit let through,
 *  `confirms` each confirm-dialog broadcast. `running` is what the handler's
 *  running-runs query would answer. */
async function makeApp(running: () => string[] = () => []) {
  const orchestrator = await import("./orchestrator.ts");
  const guard = await import("./quit-guard.ts");
  const { createQuitLaunchGate, decideBeforeQuit } = await import("./quit-launch-gate.ts");
  const allowed: Array<{ completely: boolean }> = [];
  const confirms: Array<{ completely: boolean; runningTaskIds: string[] }> = [];
  let vetoes = 0;
  const gate = createQuitLaunchGate({
    launchesInFlight: orchestrator.launchesInFlight,
    waitForLaunchesToSettle: orchestrator.waitForLaunchesToSettle,
    freezeLaunches: orchestrator.freezeLaunches,
    requeueQuit: ({ completely }) => {
      guard.armForceQuit({ completely });
      quit();
    },
    timeoutMs: 8_000,
  });
  function quit(): "allow" | "veto" {
    const d = decideBeforeQuit({
      consumeForceQuit: guard.consumeForceQuit,
      consumeQuitCompletely: guard.consumeQuitCompletely,
      gate,
      hasSupervisor: false,
      runningTaskIds: running,
    });
    if (d.kind === "allow") {
      allowed.push({ completely: d.completely });
      return "allow";
    }
    if (d.kind === "confirm") confirms.push({ completely: d.completely, runningTaskIds: d.runningTaskIds });
    else vetoes++;
    return "veto";
  }
  return { gate, allowed, confirms, quit, vetoes: () => vetoes };
}

test("a quit with a launch in flight is held, new work is refused, and the re-issued quit keeps a 'completely' asked for meanwhile", async () => {
  const orchestrator = await import("./orchestrator.ts");
  const guard = await import("./quit-guard.ts");
  const { startTask, launchesInFlight, launchesFrozen, LAUNCHES_FROZEN_REASON, cancelRun } = orchestrator;

  const taskId = await makeTask("quit flow", "hello");
  const started = startTask(taskId);
  await waitFor(() => launchesInFlight() > 0);

  const app = await makeApp(() => [taskId]);

  // Cmd+Q with a running task: the confirm dialog, and nothing else — the gate
  // isn't asked and new work isn't frozen until the user confirms.
  expect(app.quit()).toBe("veto");
  expect(app.confirms).toEqual([{ completely: false, runningTaskIds: [taskId] }]);
  expect(app.gate.isWaiting()).toBe(false);
  expect(launchesFrozen()).toBe(false);

  // "Quit anyway" (POST /app/force-quit): held, and nothing new may start
  // while the gate waits.
  guard.armForceQuit();
  expect(app.quit()).toBe("veto");
  expect(app.gate.isWaiting()).toBe(true);
  expect(launchesFrozen()).toBe(true);
  const otherId = await makeTask("quit flow 2", "never runs");
  expect(await startTask(otherId)).toEqual({ error: LAUNCHES_FROZEN_REASON, code: "launches-frozen" });

  // "Quit Agetor Completely" while waiting: absorbed (no second dialog, no
  // second wait), and its one-shot is spent here, not left for a later quit.
  guard.requestQuitCompletely();
  expect(app.quit()).toBe("veto");
  expect(guard.consumeQuitCompletely()).toBe(false);
  // A second plain Cmd+Q is absorbed too — no second confirm dialog.
  expect(app.quit()).toBe("veto");
  expect(app.allowed).toEqual([]);
  expect(app.confirms).toHaveLength(1);

  // The spawn registers → the gate re-issues the quit as a complete one, and
  // that re-issued before-quit goes through.
  await waitFor(() => app.allowed.length > 0, 10_000);
  expect(app.allowed).toEqual([{ completely: true }]);
  expect(app.gate.isWaiting()).toBe(false);
  expect(app.vetoes()).toBe(3);
  // The re-issue consumed the force-quit bypass it armed.
  expect(guard.consumeForceQuit()).toBeNull();

  const result = await started;
  if ("runId" in result && result.runId) await cancelRun(result.runId);
}, 20_000);

test("a plain quit with nothing launching goes straight through, still freezing new work first", async () => {
  const { launchesInFlight, launchesFrozen, startTask, LAUNCHES_FROZEN_REASON } = await import("./orchestrator.ts");
  expect(launchesInFlight()).toBe(0);
  const app = await makeApp();
  expect(app.quit()).toBe("allow");
  expect(app.allowed).toEqual([{ completely: false }]);
  expect(launchesFrozen()).toBe(true);

  const createdId = await makeTask("after quit", "never runs");
  expect(await startTask(createdId)).toEqual({ error: LAUNCHES_FROZEN_REASON, code: "launches-frozen" });
});

test("the confirm dialog's 'Quit completely' (force-quit armed completely) carries through the gate", async () => {
  const guard = await import("./quit-guard.ts");
  const app = await makeApp();
  guard.armForceQuit({ completely: true });
  expect(app.quit()).toBe("allow");
  expect(app.allowed).toEqual([{ completely: true }]);
});

test("a forced quit skips the running-tasks check; an unforced one never reaches the gate while tasks run", async () => {
  const guard = await import("./quit-guard.ts");
  const { launchesFrozen } = await import("./orchestrator.ts");
  let queried = 0;
  const app = await makeApp(() => {
    queried++;
    return ["t1"];
  });
  guard.requestQuitCompletely();
  expect(app.quit()).toBe("veto");
  expect(app.confirms).toEqual([{ completely: true, runningTaskIds: ["t1"] }]);
  expect(launchesFrozen()).toBe(false);
  guard.armForceQuit({ completely: true });
  expect(app.quit()).toBe("allow");
  expect(queried).toBe(1);
  expect(app.allowed).toEqual([{ completely: true }]);
});

test("decideBeforeQuit stops the supervisor only for a complete quit with one alive", async () => {
  const { createQuitLaunchGate, decideBeforeQuit } = await import("./quit-launch-gate.ts");
  const gate = createQuitLaunchGate({
    launchesInFlight: () => 0,
    waitForLaunchesToSettle: async () => true,
    freezeLaunches: () => {},
    requeueQuit: () => {},
    timeoutMs: 1_000,
  });
  const decide = (completely: boolean, hasSupervisor: boolean) =>
    decideBeforeQuit({
      consumeForceQuit: () => ({ completely }),
      consumeQuitCompletely: () => false,
      gate,
      hasSupervisor,
      runningTaskIds: () => [],
    });
  expect(decide(true, true)).toEqual({ kind: "allow", completely: true, stopSupervisor: true });
  expect(decide(true, false)).toEqual({ kind: "allow", completely: true, stopSupervisor: false });
  expect(decide(false, true)).toEqual({ kind: "allow", completely: false, stopSupervisor: false });
});

test("index.ts's before-quit handler applies decideBeforeQuit over the real gate and quit-guard flags", () => {
  const src = readFileSync(path.join(import.meta.dir, "index.ts"), "utf8");
  const handlerAt = src.indexOf('"before-quit"');
  expect(handlerAt).toBeGreaterThan(-1);
  const handler = src.slice(handlerAt);
  expect(handler).toMatch(/decideBeforeQuit\(/);
  expect(handler).toMatch(/consumeForceQuit\b/);
  expect(handler).toMatch(/consumeQuitCompletely\b/);
  expect(handler).toMatch(/gate:\s*quitLaunchGate\b/);
  // The gate's re-issue arms the force-quit bypass with the kept mode.
  const gateAt = src.indexOf("createQuitLaunchGate(");
  expect(gateAt).toBeGreaterThan(-1);
  expect(src.slice(gateAt, gateAt + 600)).toMatch(/armForceQuit\(\{\s*completely\b/);
});
