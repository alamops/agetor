import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — mkdtemp BEFORE any import
// that could pull db.ts in transitively.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-copilot-orch-"));
const { rmTestDataDir } = await import("./test-data-dir.ts");
const dataDirForCleanup = process.env.AGETOR_DATA_DIR;

// Drive copilot through the in-process fake (no tmux, no real CLI). The fake
// calls `onSessionId` synchronously (`fake-copilot-session-<taskId>` on a
// fresh turn, the resume id otherwise) and plays canned Copilot JSONL through
// the REAL mapper, settlement and subagent sink.
process.env.AGETOR_COPILOT_DRIVER = "fake";
// Keep the stream scenario's subagent short so the whole turn is ~0.5 s; the
// busy-queue tests rely on it being long enough to land a follow-up mid-turn.
process.env.AGETOR_FAKE_COPILOT_SUBAGENT_MS = "500";

// `checkHarness` runs in startTask: plant a stub `copilot` whose `--version`
// carries GitHub Copilot CLI's identity marker and a version we can steer via
// FAKE_COPILOT_VERSION (the Pre-flight 1b floor tests).
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-copilot-orch-bin-"));
const fakeCopilotBin = path.join(binDir, "copilot");
writeFileSync(
  fakeCopilotBin,
  `#!/bin/sh\n`
    + `if [ "$1" = "--version" ]; then echo "GitHub Copilot CLI $FAKE_COPILOT_VERSION."; exit 0; fi\n`
    + `exit 0\n`,
);
chmodSync(fakeCopilotBin, 0o755);
process.env.AGETOR_COPILOT_BIN = fakeCopilotBin;
process.env.FAKE_COPILOT_VERSION = "1.0.104";

// The orchestrator's "does this session still exist" check reads
// `<COPILOT_HOME>/session-state/<id>`; point it at a scratch dir.
const copilotHomeDir = mkdtempSync(path.join(tmpdir(), "agetor-copilot-orch-home-"));
process.env.COPILOT_HOME = copilotHomeDir;

const STREAM = "__agetor_fake_copilot_stream__";
const PLAN = "__agetor_fake_copilot_plan__";

beforeAll(async () => {
  await import("./db.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("copilot", true);
});

afterAll(() => {
  rmTestDataDir(dataDirForCleanup);
});

async function settle(ms = 120) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `cond` every `stepMs` until it returns true or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!cond()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

async function createCopilotTask(
  prompt: string,
  extra: { model?: string; mode?: string; agent?: string } = {},
): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title: "copilot probe",
    prompt,
    agent: extra.agent ?? "copilot",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.mode ? { mode: extra.mode } : {}),
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

async function startAndGetRunId(taskId: string): Promise<string> {
  const { startTask } = await import("./orchestrator.ts");
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  return started.runId;
}

async function statusTexts(taskId: string): Promise<string[]> {
  const { runs } = await import("./db.ts");
  return runs.eventsForTask(taskId).filter((e) => e.stream === "status").map((e) => e.data);
}

async function waitForRunSettled(taskId: string, runId: string): Promise<void> {
  const { runs } = await import("./db.ts");
  await waitFor(() => {
    const r = runs.get(runId);
    return r !== null && r.status !== "running";
  });
  void taskId;
}

/** Waits until this task has a run that isn't one of `knownIds`, and until
 *  that run has settled, then returns it. Never picks "the newest" run by
 *  index: `runs.listForTask` orders by `started_at` alone, so a run started in
 *  the same millisecond as an earlier one can sort on either side of it (a
 *  wait on `listForTask(...)[0]` then reads the earlier, settled run and
 *  passes before the new turn has even run). */
async function waitForNewRunSettled(taskId: string, knownIds: string[]): Promise<Run> {
  const { runs } = await import("./db.ts");
  const fresh = () => runs.listForTask(taskId).filter((r) => !knownIds.includes(r.id));
  await waitFor(() => fresh().length === 1 && fresh()[0]!.status !== "running");
  return fresh()[0]!;
}

test("startTask (copilot) mints a run row, persists the self-issued session id, and moves the card to review", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");

  const taskId = await createCopilotTask("do a thing");
  expect(tasks.get(taskId)?.model).toBe("auto");
  const runId = await startAndGetRunId(taskId);
  // The card flips to `running` the moment the run row exists.
  expect(tasks.get(taskId)?.column).toBe("running");

  await waitForRunSettled(taskId, runId);
  const list = runs.listForTask(taskId);
  expect(list.length).toBe(1);
  expect(list[0]?.tmuxSession).toBe(sessionNameFor(taskId));
  expect(list[0]?.copilotSessionId).toBe(`fake-copilot-session-${taskId}`);
  // Exactly one session-id column is populated.
  expect(list[0]?.claudeSessionId).toBeNull();
  expect(list[0]?.codexSessionId).toBeNull();
  expect(list[0]?.geminiSessionId).toBeNull();
  expect(list[0]?.fxSessionId).toBeNull();
  expect(list[0]?.status).toBe("succeeded");
  await waitFor(() => tasks.get(taskId)?.column === "review");
});

test("sendInput (copilot, busy) queues the follow-up; it drains as the next run with the SAME session id", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");

  const taskId = await createCopilotTask(`${STREAM} first turn`);
  const firstRunId = await startAndGetRunId(taskId);

  // The stream scenario (500 ms subagent) keeps the first turn in flight.
  const res = await sendInput(firstRunId, "queued follow-up");
  expect(res.delivered).toBe(true);
  if (res.delivered) expect(res.runId).toBe(firstRunId);
  // Queued, not spawned: still one run row.
  expect(runs.listForTask(taskId).length).toBe(1);

  await waitFor(() => runs.listForTask(taskId).length === 2 && runs.listForTask(taskId).every((r) => r.status !== "running"));
  const list = runs.listForTask(taskId); // newest first
  const sessionId = `fake-copilot-session-${taskId}`;
  expect(list[1]?.copilotSessionId).toBe(sessionId);
  expect(list[0]?.copilotSessionId).toBe(sessionId);
  expect(list[0]?.id).not.toBe(firstRunId);
  expect((await statusTexts(taskId)).some((t) => t.startsWith("resuming GitHub Copilot session "))).toBe(true);
  await waitFor(() => tasks.get(taskId)?.column === "review");
});

test("a follow-up after a same-kind harness switch starts a fresh session and says why", async () => {
  const { runs, tasks, harnesses } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  harnesses.insert({ id: "copilot-2", kind: "copilot", label: "Copilot 2", home: path.join(copilotHomeDir, "second") });
  harnesses.setEnabled("copilot-2", true);

  const taskId = await createCopilotTask("hello");
  const runId = await startAndGetRunId(taskId);
  await waitForRunSettled(taskId, runId);

  // Direct switch to the second Copilot harness (a different COPILOT_HOME).
  tasks.update(taskId, { agent: "copilot-2" });
  const res = await sendInput(runId, "continue on the other account");
  expect(res.delivered).toBe(true);
  const second = await waitForNewRunSettled(taskId, [runId]);

  const texts = await statusTexts(taskId);
  expect(texts).toContain(
    `previous GitHub Copilot context is on harness "copilot" — starting a fresh session (context didn't carry over)`,
  );
  expect(texts.some((t) => t.startsWith("resuming GitHub Copilot session "))).toBe(false);
  expect(second.agent).toBe("copilot-2");
});

test("a resume whose session dir is missing under this COPILOT_HOME starts fresh; once it exists the next follow-up resumes", async () => {
  const { runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  process.env.AGETOR_COPILOT_FAKE_REQUIRE_SESSION_DIR = "1";
  try {
    const taskId = await createCopilotTask("hello");
    const runId = await startAndGetRunId(taskId);
    await waitForRunSettled(taskId, runId);
    const sessionId = `fake-copilot-session-${taskId}`;

    // The fake driver wrote no session-state dir → "not found, starting fresh".
    const res1 = await sendInput(runId, "second turn");
    expect(res1.delivered).toBe(true);
    const second = await waitForNewRunSettled(taskId, [runId]);
    expect(await statusTexts(taskId)).toContain(
      `previous Copilot session ${sessionId.slice(0, 8)}… not found for this account — starting fresh`,
    );

    // Materialize the dir Copilot itself would have written → resumes.
    mkdirSync(path.join(copilotHomeDir, "session-state", sessionId), { recursive: true });
    const res2 = await sendInput(runId, "third turn");
    expect(res2.delivered).toBe(true);
    const third = await waitForNewRunSettled(taskId, [runId, second.id]);
    expect(await statusTexts(taskId)).toContain(`resuming GitHub Copilot session ${sessionId.slice(0, 8)}…`);
    expect(third.copilotSessionId).toBe(sessionId);
  } finally {
    delete process.env.AGETOR_COPILOT_FAKE_REQUIRE_SESSION_DIR;
  }
});

test("a queued follow-up refused by Pre-flight 1b goes to the backlog with a status line and the queue is cleared", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  process.env.FAKE_COPILOT_VERSION = "1.0.104";

  // claude-sonnet-5.5 has no floor, so the first turn starts cleanly.
  const taskId = await createCopilotTask(`${STREAM} first turn`, { model: "claude-sonnet-5.5" });
  const firstRunId = await startAndGetRunId(taskId);

  expect((await sendInput(firstRunId, "queued one")).delivered).toBe(true);
  expect((await sendInput(firstRunId, "queued two")).delivered).toBe(true);
  expect(runs.listForTask(taskId).length).toBe(1);

  // Move to a floored model (gpt-6-sol needs 1.0.89) and drop the installed
  // CLI below it before the first turn resolves and the queue drains.
  tasks.update(taskId, { model: "gpt-6-sol" });
  process.env.FAKE_COPILOT_VERSION = "1.0.50";
  try {
    await waitFor(() => (tasks.get(taskId)?.backlog ?? []).length === 2);
    // The refused line lands on top; the tray reads chronologically.
    expect((tasks.get(taskId)?.backlog ?? []).map((b) => b.text)).toEqual(["queued one", "queued two"]);
    expect(runs.listForTask(taskId).length).toBe(1);
    const decline = (await statusTexts(taskId)).find((t) => t.includes("queued messages not sent"));
    expect(decline).toBeDefined();
    expect(decline).toContain("2 queued messages not sent");
    expect(decline).toContain("1.0.89");

    // sendInput's early gate also refuses an idle follow-up with no side effect.
    await waitFor(() => runs.get(firstRunId)?.status !== "running");
    const refused = await sendInput(firstRunId, "idle follow-up");
    expect(refused.delivered).toBe(false);
    expect(runs.listForTask(taskId).length).toBe(1);

    // Queue is empty: once the CLI satisfies the floor a send spawns directly
    // and nothing else lands in the backlog.
    process.env.FAKE_COPILOT_VERSION = "1.0.104";
    const ok = await sendInput(firstRunId, "after upgrade");
    expect(ok.delivered).toBe(true);
    await waitForNewRunSettled(taskId, [firstRunId]);
    expect(runs.listForTask(taskId).length).toBe(2);
    expect(tasks.get(taskId)?.backlog?.length).toBe(2);
  } finally {
    process.env.FAKE_COPILOT_VERSION = "1.0.104";
  }
});

test("plan marker in Plan mode records a pending plan keyed on the synthetic copilot_plan tool_use", async () => {
  const { tasks } = await import("./db.ts");
  const taskId = await createCopilotTask(`${PLAN} plan it`, { mode: "plan" });
  const runId = await startAndGetRunId(taskId);
  await waitForRunSettled(taskId, runId);
  await waitFor(() => (tasks.get(taskId)?.plans ?? []).length === 1);

  const plan = tasks.get(taskId)!.plans[0]!;
  expect(plan.status).toBe("pending");
  expect(plan.toolCallId).toBe(`copilot-plan:${runId}`);
  expect(plan.runId).toBe(runId);
  expect(plan.content).toContain("Fake plan");
  expect(plan.filePath).toBeNull();
});

test("a non-Plan-mode run records no plan", async () => {
  const { tasks } = await import("./db.ts");
  const taskId = await createCopilotTask(`${PLAN} not planning`);
  const runId = await startAndGetRunId(taskId);
  await waitForRunSettled(taskId, runId);
  expect(tasks.get(taskId)?.plans ?? []).toEqual([]);
});

test("stream marker: a subagent row runs then completes, its events carry the subagent id, and the task is not held", async () => {
  const { runs, tasks, subagents } = await import("./db.ts");
  const taskId = await createCopilotTask(`${STREAM} stream it`);
  const runId = await startAndGetRunId(taskId);

  // While the 500 ms subagent is open there's a `running` tab for this run.
  await waitFor(() => subagents.listForTask(taskId).some((s) => s.status === "running"));
  const open = subagents.listForTask(taskId).find((s) => s.status === "running")!;
  expect(open.id).toBe(`cp-${runId}-call_sub`);
  expect(open.runId).toBe(runId);
  // A dedicated kind (round-trips through db.ts's PARENT_KINDS allow-list) so
  // the Claude watcher's seed never tails it, and no source file of its own.
  expect(open.parentKind).toBe("copilot_subagent");
  expect(open.spawnDepth).toBe(1);
  expect(open.toolUseId).toBe("call_sub");
  expect(open.sourcePath).toBe("");

  await waitForRunSettled(taskId, runId);
  const row = subagents.get(`cp-${runId}-call_sub`)!;
  expect(row.status).toBe("completed");
  expect(row.endedAt).not.toBeNull();
  expect(subagents.hasRunning(taskId)).toBe(false);
  // Not held in `running` for background agents.
  await waitFor(() => tasks.get(taskId)?.column === "review");

  const events = runs.eventsForTask(taskId);
  const tagged = events.filter((e) => e.subagentId === row.id);
  expect(tagged.length).toBeGreaterThan(0);
  expect(tagged.some((e) => e.stream === "tool_use")).toBe(true);
  // The main stream still has its own (untagged) assistant text.
  expect(events.some((e) => !e.subagentId && e.stream === "assistant")).toBe(true);
});

test("Stop mid-turn records the run cancelled, returns the task to ready and settles its open subagents", async () => {
  const { runs, tasks, subagents } = await import("./db.ts");
  const { cancelRun } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask(`${STREAM} long`);
  const runId = await startAndGetRunId(taskId);
  await waitFor(() => subagents.listForTask(taskId).some((s) => s.status === "running"));

  expect(await cancelRun(runId)).toBe(true);
  await waitFor(() => runs.get(runId)?.status === "cancelled");
  expect(tasks.get(taskId)?.column).toBe("ready");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(subagents.get(`cp-${runId}-call_sub`)?.status).toBe("orphaned");
});

test("archiving a task drops its queued copilot follow-ups (the stopped run's drain must not spawn them)", async () => {
  const { runs } = await import("./db.ts");
  const { sendInput, archiveTask } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask(`${STREAM} long`);
  const runId = await startAndGetRunId(taskId);
  expect((await sendInput(runId, "queued behind")).delivered).toBe(true);

  const archived = await archiveTask(taskId, { force: true, stopRun: true });
  expect("error" in archived).toBe(false);
  await waitFor(() => runs.get(runId)?.status !== "running");
  await settle(300);
  expect(runs.listForTask(taskId).length).toBe(1);
});

test("switching to another copilot harness clears the queue (the drain's kind check alone would not)", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sendInput, reconcileTaskSession, cancelRun } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask(`${STREAM} long`);
  const runId = await startAndGetRunId(taskId);
  expect((await sendInput(runId, "queued behind")).delivered).toBe(true);

  const before = tasks.get(taskId)!;
  const after = tasks.update(taskId, { agent: "copilot-2" })!;
  await reconcileTaskSession(taskId, before, after);

  await cancelRun(runId);
  await waitFor(() => runs.get(runId)?.status !== "running");
  await settle(300);
  expect(runs.listForTask(taskId).length).toBe(1);
});

test("switching a copilot task to claude-code orphans a leftover running copilot subagent row so the card is not held", async () => {
  const { tasks, subagents } = await import("./db.ts");
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask("hello");
  const runId = await insertRunningCopilotRun(taskId, "stale-session-id");
  const rowId = await insertCopilotSubagentRow(taskId, runId, "call_switch");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const before = tasks.get(taskId)!;
  const after = tasks.update(taskId, { agent: "claude-code" })!;
  await reconcileTaskSession(taskId, before, after);

  expect(subagents.get(rowId)?.status).toBe("orphaned");
  expect(subagents.hasRunning(taskId)).toBe(false);
});

test("deleting a task clears its queue and removes the row; nothing is spawned afterwards", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sendInput, deleteTask } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask(`${STREAM} long`);
  const runId = await startAndGetRunId(taskId);
  expect((await sendInput(runId, "queued behind")).delivered).toBe(true);

  await deleteTask(taskId);
  expect(tasks.get(taskId)).toBeNull();
  await settle(300);
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("a tmux launch failure surfaces as a failed run and the task returns to ready (spawnAgentOrFail)", async () => {
  const { runs, tasks } = await import("./db.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-copilot-orch-faketmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(
    bin,
    // Match whole argument words, never a substring of the joined argv: the
    // new-session argv carries mkdtemp paths whose random suffix can start
    // with `V` (`…-home-Vx3k2a`), and a `*-V*` glob on "$*" then answered the
    // launch as a version probe and let it "succeed".
    `#!/bin/sh\n`
      + `for a in "$@"; do\n`
      + `  case "$a" in\n`
      + `    -V) echo "tmux 3.4"; exit 0;;\n`
      + `    new-session) echo "boom: cannot launch" >&2; exit 1;;\n`
      + `  esac\n`
      + `done\n`
      + `exit 1\n`,
  );
  chmodSync(bin, 0o755);
  const prevBin = process.env.AGETOR_TMUX_BIN;
  const prevDriver = process.env.AGETOR_COPILOT_DRIVER;
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_COPILOT_DRIVER;
  try {
    const { startTask } = await import("./orchestrator.ts");
    const taskId = await createCopilotTask("will not launch");
    const started = await startTask(taskId);
    // The throw from spawnCopilotViaTmux is caught by spawnAgentOrFail: the
    // start reports the error, the run is recorded failed, the card returns
    // to ready — it never hangs in `running`.
    expect("error" in started).toBe(true);
    if ("error" in started) expect(started.error).toContain("boom: cannot launch");
    const list = runs.listForTask(taskId);
    expect(list.length).toBe(1);
    expect(list[0]?.status).toBe("failed");
    expect(tasks.get(taskId)?.column).toBe("ready");
  } finally {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
    if (prevDriver === undefined) delete process.env.AGETOR_COPILOT_DRIVER;
    else process.env.AGETOR_COPILOT_DRIVER = prevDriver;
  }
});

test("startTask refuses a floored model on an older Copilot CLI before any run row exists; an unparseable version never blocks", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { startTask } = await import("./orchestrator.ts");
  // gpt-6-sol needs Copilot CLI 1.0.89 (MODEL_MIN_CLI_VERSION.copilot).
  const taskId = await createCopilotTask("needs a newer cli", { model: "gpt-6-sol" });
  const columnBefore = tasks.get(taskId)!.column;
  process.env.FAKE_COPILOT_VERSION = "1.0.50";
  try {
    const refused = await startTask(taskId);
    expect("error" in refused).toBe(true);
    if ("error" in refused) {
      // The stub lives in a temp dir (not a Homebrew prefix) → `copilot update`.
      expect(refused.error).toBe(
        "GitHub Copilot 1.0.50 can't run GPT-6 Sol — it needs copilot CLI ≥ 1.0.89. Upgrade with: copilot update",
      );
    }
    // Pre-flight: nothing minted, nothing moved.
    expect(runs.listForTask(taskId)).toEqual([]);
    expect(tasks.get(taskId)!.column).toBe(columnBefore);
    expect(tasks.get(taskId)!.runId).toBeNull();

    // At the floor exactly → allowed.
    process.env.FAKE_COPILOT_VERSION = "1.0.89";
    const atFloor = await startAndGetRunId(taskId);
    await waitForRunSettled(taskId, atFloor);
    expect(runs.get(atFloor)?.status).toBe("succeeded");

    // A version string that doesn't parse fails OPEN (never blocks a run).
    const other = await createCopilotTask("dev build", { model: "gpt-6-sol" });
    process.env.FAKE_COPILOT_VERSION = "dev-build";
    const devRun = await startAndGetRunId(other);
    await waitForRunSettled(other, devRun);
    expect(runs.get(devRun)?.status).toBe("succeeded");
  } finally {
    process.env.FAKE_COPILOT_VERSION = "1.0.104";
  }
});

test("a follow-up with no recorded Copilot session on any harness starts fresh, says so, and records the minted id", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask("hello");
  // An earlier copilot run that failed before Copilot reported a session id.
  const priorRunId = await insertRunningCopilotRun(taskId, null);
  runs.update(priorRunId, { status: "failed", endedAt: Date.now(), exitCode: 1 });
  tasks.update(taskId, { column: "ready", runId: null });

  const res = await sendInput(priorRunId, "try again");
  expect(res.delivered).toBe(true);
  const newest = await waitForNewRunSettled(taskId, [priorRunId]);

  const texts = await statusTexts(taskId);
  expect(texts).toContain("no prior GitHub Copilot session — starting fresh");
  expect(texts.some((t) => t.startsWith("resuming GitHub Copilot session "))).toBe(false);
  expect(texts.some((t) => t.startsWith("previous GitHub Copilot context is on harness"))).toBe(false);
  // The fresh session id the driver minted lands on the new run (via onSessionId).
  expect(newest.copilotSessionId).toBe(`fake-copilot-session-${taskId}`);
  expect(newest.status).toBe("succeeded");
  // The follow-up itself is the new run's user bubble.
  expect(runs.eventsForTask(taskId).some((e) => e.runId === newest.id && e.stream === "user" && e.data === "try again")).toBe(true);
});

test("a second Plan-mode plan turn supersedes the earlier pending plan", async () => {
  const { tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask(`${PLAN} first plan`, { mode: "plan" });
  const firstRunId = await startAndGetRunId(taskId);
  await waitForRunSettled(taskId, firstRunId);
  await waitFor(() => (tasks.get(taskId)?.plans ?? []).length === 1);

  const res = await sendInput(firstRunId, `${PLAN} revise the plan`);
  expect(res.delivered).toBe(true);
  await waitFor(() => (tasks.get(taskId)?.plans ?? []).length === 2);

  const plans = tasks.get(taskId)!.plans;
  const first = plans.find((p) => p.runId === firstRunId)!;
  const second = plans.find((p) => p.runId !== firstRunId)!;
  expect(first.status).toBe("superseded");
  expect(first.toolCallId).toBe(`copilot-plan:${firstRunId}`);
  expect(second.status).toBe("pending");
  expect(second.toolCallId).toBe(`copilot-plan:${second.runId}`);
  expect(second.filePath).toBeNull();
});

test("a not-logged-in turn in Plan mode fails the run, returns the card to ready and shows the login status once", async () => {
  const { runs, tasks } = await import("./db.ts");
  const { COPILOT_LOGIN_STATUS_TEXT } = await import("./copilot-tmux.ts");
  const taskId = await createCopilotTask("__agetor_fake_copilot_auth__ plan without a login", { mode: "plan" });
  // Plant a fresh plan.md where the driver would look for this session's plan,
  // so only the driver's `code === 0` gate keeps a failed turn from emitting a
  // plan chunk (the auth script itself sends no exit_plan_mode).
  const sessionDir = path.join(copilotHomeDir, "session-state", `fake-copilot-session-${taskId}`);
  mkdirSync(sessionDir, { recursive: true });
  const planFile = path.join(sessionDir, "plan.md");
  writeFileSync(planFile, "# Stale plan\n\n1. must not surface\n");
  const future = new Date(Date.now() + 60 * 60 * 1000);
  utimesSync(planFile, future, future);
  const runId = await startAndGetRunId(taskId);
  await waitForRunSettled(taskId, runId);

  expect(runs.get(runId)?.status).toBe("failed");
  await waitFor(() => tasks.get(taskId)?.column === "ready");
  await settle();
  expect(tasks.get(taskId)?.plans ?? []).toEqual([]);
  expect((await statusTexts(taskId)).filter((t) => t === COPILOT_LOGIN_STATUS_TEXT)).toHaveLength(1);
  // The unauthenticated stderr is kept as stderr, not shown as assistant text.
  const events = runs.eventsForTask(taskId);
  expect(events.some((e) => e.stream === "stderr" && e.data.includes("No authentication information found"))).toBe(true);
  expect(events.some((e) => e.stream === "assistant")).toBe(false);
  expect(events.some((e) => e.stream === "tool_use" && e.data.includes('"copilot_plan"'))).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * reconcileOrphans — keep these LAST: it scans every `running` run in the DB.
 * ────────────────────────────────────────────────────────────────────────── */

async function insertRunningCopilotRun(taskId: string, sessionId: string | null): Promise<string> {
  const { runs, tasks } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  const runId = crypto.randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "copilot",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: sessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    copilotSessionId: sessionId,
  });
  tasks.update(taskId, { column: "running", runId });
  return runId;
}

// reconcileOrphans asks tmux whether a run's session is alive. Other test files
// in the same `bun test` process leave AGETOR_TMUX_BIN=/bin/echo behind, which
// answers "alive" for every session; pin a real answer for the reconcile tests.
async function withRealTmux<T>(fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = Bun.which("tmux") ?? "/usr/bin/false";
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  }
}

test("reconcileOrphans: a running copilot run with no live session flips to orphaned, task to ready, its subagent rows to orphaned", () => withRealTmux(async () => {
  const { runs, tasks, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const taskId = await createCopilotTask("hello");
  const runId = await insertRunningCopilotRun(taskId, "dead-session-id");
  subagents.insertIfAbsent({
    id: `cp-${runId}-call_x`,
    taskId,
    runId,
    parentKind: "copilot_subagent",
    agentType: "explore",
    description: "stale",
    spawnDepth: 1,
    sourcePath: "",
    toolUseId: "call_x",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });

  const orphaned = await reconcileOrphans();
  expect(orphaned).toBeGreaterThanOrEqual(1);
  expect(runs.get(runId)?.status).toBe("orphaned");
  expect(tasks.get(taskId)?.column).toBe("ready");
  expect(subagents.get(`cp-${runId}-call_x`)?.status).toBe("orphaned");
  expect(subagents.hasRunning(taskId)).toBe(false);
}));

async function insertCopilotSubagentRow(taskId: string, runId: string, callId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `cp-${runId}-${callId}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId,
    parentKind: "copilot_subagent",
    agentType: "explore",
    description: "stale",
    spawnDepth: 1,
    sourcePath: "",
    toolUseId: callId,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

test("reconcileOrphans: a copilot subagent row left running on a TERMINAL run is retired, and a held card is released to review", () => withRealTmux(async () => {
  const { runs, tasks, subagents } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");

  // Held in `running`: the terminal run succeeded but its in-turn settleAll
  // never landed, so the row would hold the card forever.
  const heldTask = await createCopilotTask("hello");
  const heldRun = await insertRunningCopilotRun(heldTask, "held-session-id");
  runs.update(heldRun, { status: "succeeded", endedAt: Date.now(), exitCode: 0 });
  const heldRow = await insertCopilotSubagentRow(heldTask, heldRun, "call_held");

  // Blind spot: the card already left `running` before the restart.
  const reviewTask = await createCopilotTask("hello");
  const reviewRun = await insertRunningCopilotRun(reviewTask, "review-session-id");
  runs.update(reviewRun, { status: "succeeded", endedAt: Date.now(), exitCode: 0 });
  tasks.update(reviewTask, { column: "review" });
  const reviewRow = await insertCopilotSubagentRow(reviewTask, reviewRun, "call_review");

  await reconcileOrphans();
  expect(subagents.get(heldRow)?.status).toBe("orphaned");
  expect(subagents.get(reviewRow)?.status).toBe("orphaned");
  expect(subagents.hasRunning(heldTask)).toBe(false);
  expect(subagents.hasRunning(reviewTask)).toBe(false);
  await waitFor(() => tasks.get(heldTask)?.column === "review");
  expect(tasks.get(reviewTask)?.column).toBe("review");
}));

const hasTmux = Bun.which("tmux") !== null;

(hasTmux ? test : test.skip)("reconcileOrphans: a running copilot run whose tmux session is alive is reattached and settles from the log", () => withRealTmux(async () => {
  const { runs, tasks } = await import("./db.ts");
  const { reconcileOrphans } = await import("./orchestrator.ts");
  const { sessionNameFor, sessionExistsByName } = await import("./claude-tmux.ts");
  const { resolveTmuxBin, tmuxSocketArgs } = await import("./tmux-resolution.ts");
  const { buildCopilotShellCommand, copilotLogPath, copilotPromptPath, copilotExitPath } = await import("./copilot-tmux.ts");

  const taskId = await createCopilotTask("hello");
  const sessionId = "11111111-2222-3333-4444-555555555555";
  // A row an EARLIER run of the task left running (its settleAll never
  // landed): the reattached turn's sink only owns its own run's rows, so the
  // boot pass must retire this one.
  const { runs: runsDb, subagents } = await import("./db.ts");
  const earlierRun = await insertRunningCopilotRun(taskId, sessionId);
  runsDb.update(earlierRun, { status: "succeeded", endedAt: Date.now() - 1000, exitCode: 0 });
  const staleRow = await insertCopilotSubagentRow(taskId, earlierRun, "call_stale");
  const runId = await insertRunningCopilotRun(taskId, sessionId);
  const liveRow = await insertCopilotSubagentRow(taskId, runId, "call_live");

  // A stub `copilot` that prints two events then a `result`, with a pause
  // after the first so the session is alive when reconcile runs.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "agetor-copilot-orch-stub-")), "copilot");
  const ev = (type: string, id: string, data: Record<string, unknown>) =>
    JSON.stringify({ type, data, id, timestamp: new Date().toISOString(), parentId: null });
  const line1 = ev("assistant.message", "re1", { messageId: "m1", content: "before restart" });
  const line2 = ev("assistant.message", "re2", { messageId: "m2", content: "after restart" });
  const line3 = JSON.stringify({ type: "result", timestamp: new Date().toISOString(), sessionId, exitCode: 0 });
  writeFileSync(
    stub,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${line1}'\nsleep 2\nprintf '%s\\n' '${line2}'\nprintf '%s\\n' '${line3}'\nexit 0\n`,
  );
  chmodSync(stub, 0o755);

  const logPath = copilotLogPath(runId);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, "");
  writeFileSync(copilotPromptPath(runId), "hello");
  const shell = buildCopilotShellCommand({
    argv: [stub],
    promptPath: copilotPromptPath(runId),
    logPath,
    exitPath: copilotExitPath(runId),
    stripClassicTokens: [],
    unsetAllowAll: false,
  });
  const name = sessionNameFor(taskId);
  const started = Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "new-session", "-d", "-s", name, "-c", tmpdir(), "--", ...shell]);
  expect(started.exitCode).toBe(0);
  try {
    expect(await sessionExistsByName(name)).toBe(true);
    const orphaned = await reconcileOrphans();
    // Reattached, not orphaned.
    expect(orphaned).toBe(0);
    expect(runs.get(runId)?.status).toBe("running");
    expect((await statusTexts(taskId)).some((t) => t.includes("reconnected to live session"))).toBe(true);
    expect(subagents.get(staleRow)?.status).toBe("orphaned");
    // The live turn's row stays with its own sink until the turn settles.
    expect(subagents.get(liveRow)?.status).toBe("running");

    await waitFor(() => runs.get(runId)?.status === "succeeded", 15_000);
    await waitFor(() => tasks.get(taskId)?.column === "review");
    const assistant = runs.eventsForTask(taskId).filter((e) => e.stream === "assistant").map((e) => e.data);
    expect(assistant).toEqual(["before restart", "after restart"]);
    expect(subagents.get(liveRow)?.status).toBe("completed");
  } finally {
    Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-session", "-t", "=" + name]);
  }
}), 30_000);
