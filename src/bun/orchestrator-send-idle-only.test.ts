import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContinuationHooks } from "./claude-tmux.ts";
import type { ContinuationTrigger } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/*
 * RC4 / D6 (docs/plans/handoff-identification-fix.md §3.4): `sendInput` grows
 * an opt-in `onlyIfIdle` mode that the pipeline runner's handoff reminder
 * uses. While ANY run of the task is live it refuses with
 * `{ delivered: false, busy: true }` — and the refusal has NO side effects: no
 * run row, no `user` event, no queue entry, no steer, no backlog stash, no
 * un-archive. Without the option every kind keeps its fold/queue/steer
 * behavior. Idle tasks deliver as usual.
 *
 * Covered across the three driver families that take different branches:
 * claude (live session + the fake-driver/no-session mint branch), codex (a
 * queueing one-shot kind) and fx (a queueing + steering one-shot kind).
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-idle-only-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// An fx stub that satisfies `checkHarness`'s `--help` marker probe.
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-idle-only-bin-"));
const fxBin = path.join(binDir, "fx");
writeFileSync(
  fxBin,
  [
    "#!/bin/sh",
    'if [ "$1" = "--help" ]; then echo "Fast, native coding agent for the terminal"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "0.0.14-fake"; exit 0; fi',
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(fxBin, 0o755);

const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_CURSOR_DRIVER: "fake",
  AGETOR_CURSOR_BIN: "/bin/echo",
  AGETOR_GEMINI_DRIVER: "fake",
  AGETOR_GEMINI_BIN: "/bin/echo",
  AGETOR_ANTIGRAVITY_DRIVER: "fake",
  AGETOR_ANTIGRAVITY_BIN: "/bin/echo",
  AGETOR_FX_DRIVER: "fake",
  AGETOR_FX_BIN: fxBin,
  // fx pauses arm real timers elsewhere; keep any that this file could arm short.
  AGETOR_FX_AUTO_RESUME_DELAY_MS: "300",
};
const savedEnv: Record<string, string | undefined> = {};

let realFactory: ((taskId: string, trigger?: ContinuationTrigger) => ContinuationHooks | null) | null = null;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await import("./orchestrator.ts");
  const { setContinuationRunFactory } = await import("./claude-tmux.ts");
  realFactory = setContinuationRunFactory(null);
  setContinuationRunFactory(realFactory);
  if (!realFactory) throw new Error("orchestrator.ts did not register a continuation-run factory");
});

afterEach(async () => {
  const { stopFxAutoResumeTimers } = await import("./orchestrator.ts");
  stopFxAutoResumeTimers();
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(DATA_DIR);
});

const createdTaskIds: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor: not met within ${timeoutMs}ms`);
    await wait(25);
  }
}

async function createTaskOf(
  agent: "claude-code" | "codex" | "cursor" | "gemini" | "antigravity" | "fx",
  title: string,
  extra: { prompt?: string; model?: string } = {},
): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  if (agent !== "claude-code") harnesses.setEnabled(agent, true);
  const created = await createTask({
    title,
    prompt: extra.prompt ?? "turn one",
    agent,
    workdir: process.cwd(),
    isolation: "none", // never create branches in the live repo
    taskType: "task",
    ...(extra.model ? { model: extra.model } : {}),
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

/** A `succeeded` claude run the task points at (idle-looking, `review`). */
async function seedPriorClaudeRun(taskId: string): Promise<string> {
  const { runs, tasks } = await import("./db.ts");
  const runId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: now - 5000,
    endedAt: now,
    exitCode: 0,
    tmuxSession: `agetor-test-${taskId}`,
    claudeSessionId: `sess-${randomUUID()}`,
    codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  tasks.update(taskId, { column: "review", runId });
  return runId;
}

async function installSession(taskId: string) {
  const { __forTest } = await import("./claude-tmux.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-idle-only-sess-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  return __forTest.installSession(taskId, jsonlPath);
}

/** Register `hooks`' continuation run as live. Its `kill` resolves `done`, so
 *  `cancelRun` really settles and unregisters it. */
function adoptLive(hooks: ContinuationHooks): void {
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  hooks.onAdopted({ kill: () => finish(0), writeInput: () => true, done });
}

function userBubbles(
  runs: { eventsForTask: (id: string) => Array<{ stream: string; data: string }> },
  taskId: string,
  text: string,
) {
  return runs.eventsForTask(taskId).filter((e) => e.stream === "user" && e.data.includes(text));
}

// ── claude ───────────────────────────────────────────────────────────────────

test("claude: onlyIfIdle while a continuation run is live is refused busy with no side effects; the plain send still folds", async () => {
  const taskId = await createTaskOf("claude-code", "idle-only-claude-busy");
  const priorRunId = await seedPriorClaudeRun(taskId);
  const { runs, tasks } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");

  // A live continuation (the real factory), registered in `active`.
  const hooks = realFactory!(taskId)!;
  const contRunId = tasks.get(taskId)!.runId!;
  adoptLive(hooks);
  const state = await installSession(taskId);
  const { __forTest } = await import("./claude-tmux.ts");
  try {
    const rowsBefore = runs.listForTask(taskId).length;
    const eventsBefore = runs.eventsForTask(taskId).length;

    const refused = await sendInput(priorRunId, "idle-only reminder", { onlyIfIdle: true });
    expect(refused).toEqual({
      delivered: false,
      busy: true,
      reason: "the agent is busy with a turn — not sent",
    });
    // No run row, no user event, nothing stashed, nothing else written.
    expect(runs.listForTask(taskId).length).toBe(rowsBefore);
    expect(runs.eventsForTask(taskId).length).toBe(eventsBefore);
    expect(userBubbles(runs, taskId, "idle-only reminder")).toEqual([]);
    expect(tasks.get(taskId)!.backlog).toEqual([]);
    expect(tasks.get(taskId)!.runId).toBe(contRunId);
    expect(state.turnQueue.length).toBe(0);

    // Control: the SAME send without the option folds into the live run.
    const folded = await sendInput(priorRunId, "plain follow-up");
    expect(folded.delivered).toBe(true);
    if (folded.delivered) expect(folded.runId).toBe(contRunId);
    expect(userBubbles(runs, taskId, "plain follow-up").length).toBe(1);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("claude: onlyIfIdle is refused when the SESSION still has turn state (a queued slot) even with no active run", async () => {
  const taskId = await createTaskOf("claude-code", "idle-only-claude-session-turn");
  const priorRunId = await seedPriorClaudeRun(taskId);
  const { runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { __forTest } = await import("./claude-tmux.ts");
  const state = await installSession(taskId);
  // A turn slot the tailer still owns, with no matching `active` run.
  const pending = __forTest.pushTurnSlot(state, () => {});
  pending.catch(() => {});
  try {
    const rowsBefore = runs.listForTask(taskId).length;
    const refused = await sendInput(priorRunId, "reminder into a busy session", { onlyIfIdle: true });
    expect(refused.delivered).toBe(false);
    if (!refused.delivered) expect(refused.busy).toBe(true);
    expect(runs.listForTask(taskId).length).toBe(rowsBefore);
    expect(userBubbles(runs, taskId, "reminder into a busy session")).toEqual([]);
    expect(state.turnQueue.length).toBe(1); // untouched: no second slot pushed
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("claude: onlyIfIdle on the no-session (mint) branch is refused while a fake-driver run is live — no second run", async () => {
  const prevResolve = process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "600";
  try {
    const taskId = await createTaskOf("claude-code", "idle-only-claude-nosession");
    const { startTask, sendInput, cancelRun } = await import("./orchestrator.ts");
    const { runs } = await import("./db.ts");
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const firstRunId = started.runId;
    // No claude-tmux SessionState exists for a fake-driver task, so the send
    // takes sendClaudeTurn's dead/no-session mint branch.
    const refused = await sendInput(firstRunId, "reminder", { onlyIfIdle: true });
    expect(refused.delivered).toBe(false);
    if (!refused.delivered) expect(refused.busy).toBe(true);
    expect(runs.listForTask(taskId).length).toBe(1);
    expect(userBubbles(runs, taskId, "reminder")).toEqual([]);
    await cancelRun(firstRunId);
  } finally {
    if (prevResolve === undefined) delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
    else process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = prevResolve;
  }
});

test("claude: onlyIfIdle on an idle task with a live session is delivered as a new turn", async () => {
  const taskId = await createTaskOf("claude-code", "idle-only-claude-idle");
  const priorRunId = await seedPriorClaudeRun(taskId);
  const { runs, tasks } = await import("./db.ts");
  const { sendInput, cancelRun } = await import("./orchestrator.ts");
  const { __forTest } = await import("./claude-tmux.ts");
  const prevGap = __forTest.setBracketedEnterGapMs(0);
  const prevSettle = __forTest.setSlashCommandSettleMs(0);
  await installSession(taskId);
  try {
    const sent = await sendInput(priorRunId, "idle reminder", { onlyIfIdle: true });
    expect(sent.delivered).toBe(true);
    if (!sent.delivered) return;
    expect(sent.runId).not.toBe(priorRunId);
    expect(tasks.get(taskId)!.runId).toBe(sent.runId);
    expect(runs.listForTask(taskId).length).toBe(2);
    expect(userBubbles(runs, taskId, "idle reminder").length).toBe(1);
    await cancelRun(sent.runId);
  } finally {
    __forTest.uninstallSession(taskId);
    __forTest.setBracketedEnterGapMs(prevGap);
    __forTest.setSlashCommandSettleMs(prevSettle);
  }
});

// ── one-shot kinds (codex, cursor, gemini, antigravity) ──────────────────────
//
// Their fake turns resolve in ~20 ms, too short to hold a run open
// deterministically, so the task is made live the other way `isTaskRunLive`
// counts it: the #92 HOLD shape (column `running`, terminal run `succeeded`,
// a background subagent still `running`). That is the same predicate the live
// `task.runId && active.has(task.runId)` case feeds, and it is exactly what a
// busy one-shot task looks like to the idle-only gate.

test.each(["codex", "cursor", "gemini", "antigravity"] as const)(
  "%s: onlyIfIdle on a live task is refused busy with no side effects (no run row, user event, queue entry or un-archive); once idle the same send delivers",
  async (kind) => {
    const taskId = await createTaskOf(kind as "codex", `idle-only-${kind}`);
    const { runs, tasks, subagents, db } = await import("./db.ts");
    const { sendInput } = await import("./orchestrator.ts");

    const runId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: runId,
      taskId,
      agent: kind,
      status: "succeeded",
      startedAt: now - 3000,
      endedAt: now - 1000,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: kind === "codex" ? `thread-${randomUUID()}` : null,
      cursorSessionId: kind === "cursor" ? `cursor-${randomUUID()}` : null,
      geminiSessionId: kind === "gemini" ? randomUUID() : null,
      fxSessionId: null,
      antigravitySessionId: kind === "antigravity" ? `conv-${randomUUID()}` : null,
    });
    const archivedAt = now;
    tasks.update(taskId, { column: "running", runId, archivedAt });
    const subId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: subId,
      taskId,
      runId,
      parentKind: "subagent",
      agentType: "general-purpose",
      description: "still working",
      spawnDepth: 1,
      sourcePath: `/tmp/${subId}.jsonl`,
      status: "running",
      startedAt: now - 2000,
      endedAt: null,
    });

    const refused = await sendInput(runId, `${kind} reminder`, { onlyIfIdle: true });
    expect(refused).toEqual({
      delivered: false,
      busy: true,
      reason: "the agent is busy with a turn — not sent",
    });
    // No side effects, including no un-archive on the way to the refusal.
    expect(tasks.get(taskId)!.archivedAt).toBe(archivedAt);
    expect(runs.listForTask(taskId).length).toBe(1);
    expect(userBubbles(runs, taskId, `${kind} reminder`)).toEqual([]);
    expect(tasks.get(taskId)!.backlog).toEqual([]);

    // The task goes idle. Had the refused line been queued, a turn would be
    // spawned for it now; nothing is.
    db.run(`DELETE FROM subagents WHERE id = ?`, [subId]);
    tasks.update(taskId, { column: "review", archivedAt: null });
    await wait(200);
    expect(runs.listForTask(taskId).length).toBe(1);

    const sent = await sendInput(runId, `${kind} idle reminder`, { onlyIfIdle: true });
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).not.toBe(runId);
    await waitFor(() => runs.listForTask(taskId).every((r) => r.status !== "running"));
    expect(runs.listForTask(taskId).length).toBe(2);
    expect(userBubbles(runs, taskId, `${kind} idle reminder`).length).toBe(1);
  },
);

// ── fx ───────────────────────────────────────────────────────────────────────

test("fx: onlyIfIdle while a steerable turn is live is refused busy — it neither steers nor queues; the plain send still steers", async () => {
  const prevHold = process.env.AGETOR_FAKE_FX_STEER_HOLD_MS;
  process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = "500";
  try {
    const taskId = await createTaskOf("fx", "idle-only-fx", {
      prompt: "turn one __agetor_fake_fx_steer__:absorbed",
    });
    const { startTask, sendInput } = await import("./orchestrator.ts");
    const { runs } = await import("./db.ts");
    const { __getFakeDriver } = await import("./agents.ts");
    const started = await startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const firstRunId = started.runId;
    await wait(40);

    const refused = await sendInput(firstRunId, "fx reminder", { onlyIfIdle: true });
    expect(refused).toEqual({
      delivered: false,
      busy: true,
      reason: "the agent is busy with a turn — not sent",
    });
    // Not steered into the live turn, not queued, no bubble anywhere.
    expect(__getFakeDriver(taskId)?._record.some((r) => r.startsWith("steer:"))).toBe(false);
    expect(userBubbles(runs, taskId, "fx reminder")).toEqual([]);
    expect(runs.listForTask(taskId).length).toBe(1);

    // Control: the same text without the option steers the running turn.
    const steered = await sendInput(firstRunId, "plain fx steer");
    expect(steered.delivered).toBe(true);
    expect(__getFakeDriver(taskId)?._record).toContain("steer:plain fx steer");

    // After the turn settles nothing queued from the refused send spawns.
    await waitFor(() => runs.get(firstRunId)?.status !== "running", 6000);
    await wait(250);
    expect(runs.listForTask(taskId).length).toBe(1);
    expect(userBubbles(runs, taskId, "fx reminder")).toEqual([]);

    // Idle: delivered as a new turn.
    const sent = await sendInput(firstRunId, "fx idle reminder", { onlyIfIdle: true });
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).not.toBe(firstRunId);
    await waitFor(() => runs.listForTask(taskId).every((r) => r.status !== "running"), 6000);
  } finally {
    if (prevHold === undefined) delete process.env.AGETOR_FAKE_FX_STEER_HOLD_MS;
    else process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = prevHold;
  }
});

test("isAnyRunOfTaskLive counts a run displaced as task.runId, which isTaskRunLive does not", async () => {
  const taskId = await createTaskOf("claude-code", "any-run-live");
  await seedPriorClaudeRun(taskId);
  const { isAnyRunOfTaskLive, isTaskRunLive, cancelRun } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");

  expect(isAnyRunOfTaskLive(taskId)).toBe(false);

  const first = realFactory!(taskId)!;
  const firstRunId = tasks.get(taskId)!.runId!;
  adoptLive(first);
  const second = realFactory!(taskId)!;
  const secondRunId = tasks.get(taskId)!.runId!;
  adoptLive(second);
  expect(secondRunId).not.toBe(firstRunId);

  // Stop the CURRENT run: the displaced first run is still registered.
  await cancelRun(secondRunId);
  await wait(50);
  expect(isTaskRunLive(taskId)).toBe(false);
  expect(isAnyRunOfTaskLive(taskId)).toBe(true);

  await cancelRun(firstRunId);
  await wait(50);
  expect(isAnyRunOfTaskLive(taskId)).toBe(false);
});
