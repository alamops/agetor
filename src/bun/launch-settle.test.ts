import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `launchesInFlight` / `waitForLaunchesToSettle` (orchestrator.ts): a core
// asked to hand the port off waits for the agent launches it is still in the
// middle of before it exits (docs/plans/always-on-host.md; headless.ts
// `handOffPort`). A slow fake claude spawn holds the task's start claim, which
// is exactly what the wait has to see.

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-launch-settle-"));

const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "600",
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
});

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
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-launch-settle-wd-"));
  const created = await createTask({
    title: "launch settle",
    prompt: "hello",
    agent: "claude-code",
    workdir,
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
