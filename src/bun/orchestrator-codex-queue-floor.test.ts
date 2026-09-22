import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import — mkdtemp BEFORE any
// import that could pull db.ts in transitively. Mirrors
// orchestrator-min-cli-version.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-codex-queue-floor-"));

// Drive codex through the in-process fake (no tmux, no real CLI).
process.env.AGETOR_CODEX_DRIVER = "fake";

// NOTE on AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: this env var only gates the
// AGETOR_FAKE_CLAUDE_API_ERROR / _SESSION_DIED / _UNKNOWN_COMMAND scenario
// branches inside `makeFakeAgent` (src/bun/agents.ts:1194/1208/1222) — none
// of which apply to a plain codex fake run. The generic fallback branch that
// an ordinary codex fake turn actually takes (agents.ts ~1751-1785) resolves
// on a HARD-CODED `after(20, ...)` with no env-var seam at all. Setting this
// var here is a documented no-op for this file's purposes (kept only in case
// a future refactor wires it up); the "turn still in flight" window this
// file relies on is instead the same one `orchestrator-codex.test.ts`'s
// "sendInput (codex, busy) queues the follow-up" test already exploits:
// call `sendInput` synchronously, with no `settle()`, right after `startTask`
// resolves, before the fake's ~20ms timer fires.
process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "600";

// Plant a fake codex binary whose `--version` echoes back whatever
// `FAKE_CODEX_VERSION` is currently set to, and exits 0 for anything else —
// copied from orchestrator-min-cli-version.test.ts.
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-codex-queue-floor-bin-"));
const fakeCodexBin = path.join(binDir, "codex");
writeFileSync(
  fakeCodexBin,
  `#!/bin/sh\n`
    + `if [ "$1" = "--version" ]; then echo "$FAKE_CODEX_VERSION"; exit 0; fi\n`
    + `exit 0\n`,
  { mode: 0o755 },
);
process.env.AGETOR_CODEX_BIN = fakeCodexBin;

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 100) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `cond` every `stepMs` until it returns true or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!cond()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

async function createCodexTask(model: string) {
  const { createTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "codex queue-floor probe",
    prompt: "turn one",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    model,
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("a queued codex follow-up refused by Pre-flight 1b is restashed to the backlog with a status line, and the queue is cleared", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // gpt-5.6-sol has no minimum-CLI-version floor, so this starts cleanly.
  const taskId = await createCodexTask("gpt-5.6-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = started.runId;

  // Queue two follow-ups WHILE the first turn is still in flight (no settle
  // in between — exploits the same ~20ms fake-resolve window
  // orchestrator-codex.test.ts's "sendInput (codex, busy)" test already
  // relies on). Both should fold into the active run's queue.
  const res1 = await sendInput(firstRunId, "queued follow-up");
  expect(res1.delivered).toBe(true);
  if (res1.delivered) expect(res1.runId).toBe(firstRunId);

  const res2 = await sendInput(firstRunId, "queued follow-up 2");
  expect(res2.delivered).toBe(true);
  if (res2.delivered) expect(res2.runId).toBe(firstRunId);

  // Still just the one run row — neither queued message has spawned yet.
  expect(runs.listForTask(taskId).length).toBe(1);

  // Now move the task onto a floored model and drop the installed CLI below
  // the floor, before the first turn resolves and the queue drains.
  tasks.update(taskId, { model: "gpt-6-sol" });
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";

  // Wait for the first turn to resolve and drainCodexQueue to restash both
  // queued lines to the backlog.
  await waitFor(() => {
    const backlog = tasks.get(taskId)?.backlog ?? [];
    return backlog.some((item) => item.text === "queued follow-up");
  });

  const afterDrain = tasks.get(taskId);
  expect(afterDrain).not.toBeNull();
  const backlogTexts = (afterDrain!.backlog ?? []).map((item) => item.text);
  // Both stranded lines are restashed. `restashPasteWithheldText` calls
  // `backlog.add`, which prepends ("newest draft on top"), so the drain
  // restashes in REVERSE send order — the refused message ("queued
  // follow-up") lands on top and the tray reads chronologically.
  expect(backlogTexts).toEqual(["queued follow-up", "queued follow-up 2"]);
  expect(backlogTexts).toContain("queued follow-up");
  expect(backlogTexts).toContain("queued follow-up 2");

  // No second run row was minted for either queued follow-up.
  expect(runs.listForTask(taskId).length).toBe(1);

  // The refusal was recorded as a status event on the run.
  const events = runs.eventsForTask(taskId);
  const statusEvents = events.filter((e) => e.stream === "status");
  const declineEvent = statusEvents.find((e) => e.data.includes("queued message"));
  expect(declineEvent).toBeDefined();
  expect(declineEvent?.data).toContain("2 queued messages not sent");
  expect(declineEvent?.data).toContain("0.155.0");

  // The codex queue is empty — prove it behaviorally: restore a satisfying
  // CLI version and send a fresh follow-up; it must spawn (not queue) and
  // must NOT add anything further to the backlog.
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const res3 = await sendInput(firstRunId, "after upgrade");
  expect(res3.delivered).toBe(true);

  await settle(150);

  expect(runs.listForTask(taskId).length).toBe(2);
  const finalBacklogTexts = (tasks.get(taskId)?.backlog ?? []).map((item) => item.text);
  expect(finalBacklogTexts).toEqual(["queued follow-up", "queued follow-up 2"]);
  expect(finalBacklogTexts).not.toContain("after upgrade");
});

test("control: a queued codex follow-up on a non-floored model drains normally into a second run, with an empty backlog", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-5.6-sol"); // no floor for this model
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = started.runId;

  const res = await sendInput(firstRunId, "queued follow-up");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId);

  expect(runs.listForTask(taskId).length).toBe(1);

  await waitFor(() => runs.listForTask(taskId).length === 2);

  expect(runs.listForTask(taskId).length).toBe(2);
  const backlog = tasks.get(taskId)?.backlog ?? [];
  expect(backlog).toEqual([]);
});
