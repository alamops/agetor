// Switch to the next account (docs/plans/harness-stacks-fix-round.md D12) and
// the boot-resume of an interrupted swap (finding 2), driven through the fake
// Claude driver. Minimal verification of the orchestrator side; the
// comprehensive matrix lives in the fix-round test file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// Literal copy: a static src/bun import would load db.ts before the data dir
// below is set (the suite runs every file in one process).
const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
const FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER = "__agetor_fake_claude_limit_clean__";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-switch-now-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_FAKE_CLAUDE_TURN_MS", "AGETOR_FAKE_CLAUDE_SESSION_DIED", "AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-switch-now-bin-"));
{
  const tmux = path.join(binDir, "tmux");
  writeFileSync(tmux, "#!/bin/sh\nexit 1\n");
  chmodSync(tmux, 0o755);
  process.env.AGETOR_TMUX_BIN = tmux;
}

let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");
let stacks: typeof import("./harness-stacks.ts");
let failover: typeof import("./harness-failover.ts");
let history: typeof import("./harness-swap-history.ts");
let restore: () => void;
let seq = 0;

beforeAll(async () => {
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  history = await import("./harness-swap-history.ts");
});

afterAll(async () => {
  failover.stopAllAutoRetryTimers();
  orch.__resetLaunchFreezeForTest();
  restore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(binDir, { recursive: true, force: true });
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

function alias(prefix: string): string {
  const id = `${prefix}-${++seq}`;
  const dir = path.join(DATA_DIR, "harnesses", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".credentials.json"), "{}");
  db.harnesses.insert({ id, kind: "claude-code", label: id, home: dir, env: {} } as never);
  return id;
}

function makeTask(agent: string, prompt: string, extra: Partial<Task> = {}): Task {
  const id = randomUUID();
  const workdir = path.join(DATA_DIR, "work", `${++seq}`);
  mkdirSync(workdir, { recursive: true });
  db.tasks.insert({
    id, title: "switch", prompt, agent, workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "sonnet-4.6", effort: "high", speed: "off", maxMode: false,
    opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
    column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
    ...extra,
  } as never);
  return db.tasks.get(id)!;
}

function insertRun(taskId: string, agent: string, patch: Record<string, unknown> = {}): string {
  const id = randomUUID();
  db.runs.insert({
    id, taskId, agent, status: "succeeded", startedAt: Date.now() - 1_000, endedAt: Date.now() - 900,
    exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null, antigravitySessionId: null, ...patch,
  } as never);
  return id;
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(15);
  }
}

const events = (stackId: string) => history.harnessSwapEvents.page(stackId, { limit: 50 }).events;

describe("switchTaskAccountNow", () => {
  test("a lone account is refused up front", async () => {
    const a = alias("lone");
    const task = makeTask(a, "work");
    let refusal: unknown = null;
    try {
      await orch.switchTaskAccountNow(task.id);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(orch.SwitchAccountRefusedError);
    expect((refusal as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code).toBe("not-in-stack");
  });

  test("an idle task moves now: one history row, no cooldown, not tried", async () => {
    const a = alias("idle-a");
    const b = alias("idle-b");
    const stack = stacks.harnessStacks.create({ label: "idle", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "review" });
    // The persisted intent names the action, so a restart mid-move keeps the
    // switch-now label (the boot completion reads it).
    const intents: unknown[] = [];
    const realSet = db.tasks.setHarnessState.bind(db.tasks);
    db.tasks.setHarnessState = ((id: string, state: Parameters<typeof realSet>[1]) => {
      if (id === task.id && state?.pendingSwap) intents.push(state.pendingSwap);
      return realSet(id, state);
    }) as typeof db.tasks.setHarnessState;
    let result: Awaited<ReturnType<typeof orch.switchTaskAccountNow>>;
    try {
      result = await orch.switchTaskAccountNow(task.id);
    } finally {
      db.tasks.setHarnessState = realSet;
    }
    expect(result.status).toBe("switched");
    expect(intents).toEqual([expect.objectContaining({ from: a, to: b, manual: true, switchNow: "manual" })]);
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.lastMove?.reason).toBe("switch-now");
    expect(after.harnessState?.tried ?? []).toEqual([]);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(stacks.harnessStacks.getLimitState(a)).toBeNull();
    const rows = events(stack.id).filter((e) => e.taskId === task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe("manual");
    expect(rows[0]!.reason).toBe("user");
    expect(rows[0]!.fromHarnessId).toBe(a);
    expect(rows[0]!.toHarnessId).toBe(b);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a live run schedules (idempotent) and cancel clears it", async () => {
    const a = alias("live-a");
    const b = alias("live-b");
    const stack = stacks.harnessStacks.create({ label: "live", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running" });
    const runId = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId });
    const first = await orch.switchTaskAccountNow(task.id);
    expect(first.status).toBe("scheduled");
    const requestedAt = db.tasks.get(task.id)!.harnessState?.scheduledSwitch?.requestedAt;
    expect(requestedAt).toBeGreaterThan(0);
    const second = await orch.switchTaskAccountNow(task.id);
    expect(second.status).toBe("scheduled");
    expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch?.requestedAt).toBe(requestedAt);
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    const cancelled = orch.cancelScheduledAccountSwitch(task.id);
    expect(cancelled.harnessState?.scheduledSwitch ?? null).toBeNull();
    // Nothing scheduled: a no-op that still returns the task.
    expect(orch.cancelScheduledAccountSwitch(task.id).id).toBe(task.id);
    db.runs.update(runId, { status: "failed", endedAt: Date.now() });
    stacks.harnessStacks.delete(stack.id);
  });

  test("a scheduled switch is performed when the turn succeeds, before the next turn", async () => {
    const a = alias("sched-a");
    const b = alias("sched-b");
    const stack = stacks.harnessStacks.create({ label: "sched", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "400";
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      const result = await orch.switchTaskAccountNow(task.id);
      expect(result.status).toBe("scheduled");
      await waitFor(() => db.tasks.get(task.id)?.agent === b);
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    }
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(after.harnessState?.lastMove?.reason).toBe("switch-now");
    const rows = events(stack.id).filter((e) => e.taskId === task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe("scheduled");
    expect(stacks.harnessStacks.getLimitState(a)).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a Stop drops the scheduled switch", async () => {
    const a = alias("stop-a");
    const b = alias("stop-b");
    const stack = stacks.harnessStacks.create({ label: "stop", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "3000";
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      await orch.cancelRun((started as { runId: string }).runId);
      await waitFor(() => db.tasks.get(task.id)?.harnessState?.scheduledSwitch == null);
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    }
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(a);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(events(stack.id).filter((e) => e.taskId === task.id)).toHaveLength(0);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a provider limit consumes the request: failover moves once, no second move", async () => {
    const a = alias("lim-a");
    const b = alias("lim-b");
    const c = alias("lim-c");
    const stack = stacks.harnessStacks.create({ label: "lim", kind: "claude-code", members: [a, b, c] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "300";
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 2 && rows.every((r) => r.status !== "running");
      });
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    }
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    const rows = events(stack.id).filter((e) => e.taskId === task.id);
    expect(rows.map((r) => r.trigger)).toEqual(["limit"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("refusals during a swap, retry or launch freeze (review S1, S3)", () => {
  async function refusalCode(taskId: string): Promise<string | null> {
    try {
      await orch.switchTaskAccountNow(taskId);
      return null;
    } catch (err) {
      return (err as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code;
    }
  }

  test("an in-flight retry or a limit swap refuses 409 busy and schedules nothing", async () => {
    const a = alias("busy-a");
    const b = alias("busy-b");
    const stack = stacks.harnessStacks.create({ label: "busy", kind: "claude-code", members: [a, b] });
    const base = { stackId: stack.id, position: 0, count: 2, tried: [] as string[], lastMove: null };
    const retrying = makeTask(a, "work", { column: "blocked" });
    db.tasks.setHarnessState(retrying.id, {
      ...base, pendingSwap: null,
      allExhausted: { at: Date.now(), attempts: 0, max: 3, nextAttemptAt: 0, earliestResetAtMs: null, reason: "quota", inFlight: true },
    });
    expect(await refusalCode(retrying.id)).toBe("busy");
    expect(db.tasks.get(retrying.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();

    const swapping = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(swapping.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(swapping.id, { runId: oldRun });
    db.tasks.setHarnessState(swapping.id, {
      ...base, allExhausted: null,
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
    });
    expect(await refusalCode(swapping.id)).toBe("busy");
    expect(db.tasks.get(swapping.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();
    db.runs.update(oldRun, { status: "failed", endedAt: Date.now() });
    stacks.harnessStacks.delete(stack.id);
  });

  test("a launch freeze refuses an idle switch with launches-frozen and blocks the claim", async () => {
    const a = alias("frozen-a");
    const b = alias("frozen-b");
    const stack = stacks.harnessStacks.create({ label: "frozen", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "review" });
    orch.freezeLaunches();
    try {
      expect(await refusalCode(task.id)).toBe("launches-frozen");
      expect(orch.claimTaskForAccountSwitch(task.id)).toBe(false);
      expect(db.tasks.get(task.id)!.agent).toBe(a);
    } finally {
      orch.__resetLaunchFreezeForTest();
    }
    expect(orch.claimTaskForAccountSwitch(task.id)).toBe(true);
    orch.releaseTaskAccountSwitch(task.id);
    stacks.harnessStacks.delete(stack.id);
  });

  test("an archived task is refused with code archived", async () => {
    const a = alias("arch-a");
    const b = alias("arch-b");
    const stack = stacks.harnessStacks.create({ label: "arch", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "review", archivedAt: Date.now() });
    expect(await refusalCode(task.id)).toBe("archived");
    stacks.harnessStacks.delete(stack.id);
  });
});

describe("boot", () => {
  test("a scheduled switch whose turn ended during downtime is performed", async () => {
    const a = alias("boot-a");
    const b = alias("boot-b");
    const stack = stacks.harnessStacks.create({ label: "boot", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "ready" });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [], pendingSwap: null, allExhausted: null, lastMove: null,
      scheduledSwitch: { requestedAt: Date.now() },
    });
    await orch.reconcilePendingHarnessSwaps();
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["scheduled"]);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a crash mid-swap resumes at boot: the limited run is failed, not orphaned", async () => {
    const a = alias("resume-a");
    const b = alias("resume-b");
    const stack = stacks.harnessStacks.create({ label: "resume", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    await orch.reconcileOrphans();
    const settled = db.runs.get(oldRun)!;
    expect(settled.status).toBe("failed");
    // The card and its run pointer are left for the swap reconcile.
    expect(db.tasks.get(task.id)!.column).toBe("running");
    expect(db.tasks.get(task.id)!.runId).toBe(oldRun);
    expect(db.runs.events(oldRun).some((e) => e.data.includes("orphaned"))).toBe(false);

    await orch.reconcilePendingHarnessSwaps();
    await waitFor(() => db.runs.listForTask(task.id).length >= 2 && db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    const rows = [...db.runs.listForTask(task.id)].sort((x, y) => x.startedAt - y.startedAt);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.agent).toBe(b);
    expect(rows[1]!.origin).toBe("harness-swap");
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["boot-resume"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("clean retry follow-ups", () => {
  test("a cancelled clean retry stashes the follow-ups after the original prompt, once", async () => {
    const a = alias("clean-a");
    const b = alias("clean-b");
    const stack = stacks.harnessStacks.create({ label: "clean", kind: "claude-code", members: [a, b] });
    // The backup is cooling, so the limit on A blocks the task with an armed retry.
    stacks.harnessStacks.setLimitState(b, {
      reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "usage limit", source: "claude-api-error",
    });
    const task = makeTask(a, `no tools yet ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const folded = "also update the docs";
    const prevObserved = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", folded);
    });
    let firstRunId = "";
    try {
      const started = await orch.startTask(task.id);
      firstRunId = (started as { runId: string }).runId;
      await waitFor(() => db.tasks.get(task.id)?.harnessState?.allExhausted != null);
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prevObserved);
    }
    const ex = db.tasks.get(task.id)!.harnessState!.allExhausted!;
    expect(ex.cleanRetryOf).toBe(firstRunId);
    expect(ex.memberReasons?.map((r) => r.harnessId).sort()).toEqual([a, b].sort());
    expect(db.tasks.get(task.id)!.backlog).toHaveLength(0);

    expect(orch.cancelHarnessRetryForTask(task.id, "cancelled for test")).toBe(true);
    expect(db.tasks.get(task.id)!.backlog.map((i) => i.text)).toEqual([folded]);
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted ?? null).toBeNull();
    // Nothing left to stash a second time.
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(false);
    expect(db.tasks.get(task.id)!.backlog).toHaveLength(1);
    // The blocked outcome wrote exactly one history row.
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["blocked"]);
    stacks.harnessStacks.clearLimitState(b);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("wave 3 review fixes", () => {
  test("M2: a throw while resuming an interrupted swap at boot blocks the card instead of leaving it running", async () => {
    const a = alias("m2-a");
    const b = alias("m2-b");
    const stack = stacks.harnessStacks.create({ label: "m2", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    await orch.reconcileOrphans();
    const prev = orch.__setHarnessSwapSpawnHookForTest(() => {
      throw new Error("EACCES: synthetic transfer failure");
    });
    try {
      await orch.reconcilePendingHarnessSwaps();
    } finally {
      orch.__setHarnessSwapSpawnHookForTest(prev);
    }
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("blocked");
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    expect(db.runs.get(oldRun)!.status).toBe("failed");
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["blocked"]);
    stacks.harnessStacks.delete(stack.id);
  });

  test("S1: a Stop during an account switch copy does not leak into the next limit swap", async () => {
    const a = alias("s1-a");
    const b = alias("s1-b");
    const stack = stacks.harnessStacks.create({ label: "s1", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`, { column: "review" });
    const prior = insertRun(task.id, a);
    db.tasks.update(task.id, { runId: prior });
    expect(orch.claimTaskForAccountSwitch(task.id)).toBe(true);
    expect(await orch.cancelRun(prior)).toBe(true);
    orch.releaseTaskAccountSwitch(task.id);
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "100";
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 3 && rows.every((r) => r.status !== "running");
      });
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    }
    const rows = [...db.runs.listForTask(task.id)].sort((x, y) => x.startedAt - y.startedAt);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.agent).toBe(b);
    expect(rows[2]!.origin).toBe("harness-swap");
    expect(rows[1]!.status).toBe("failed");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("S4: a scheduled switch waits for background agents, then applies; Stop drops it", async () => {
    const { settleSubagentById } = await import("./claude-subagents.ts");
    const a = alias("s4-a");
    const b = alias("s4-b");
    const stack = stacks.harnessStacks.create({ label: "s4", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p");
    const runId = insertRun(task.id, a, { status: "succeeded", claudeSessionId: `s4-${task.id}` });
    db.tasks.update(task.id, { runId, column: "running" });
    const subagentId = `agent-${randomUUID()}`;
    db.subagents.insertIfAbsent({
      id: subagentId, taskId: task.id, runId, parentKind: "subagent", agentType: "general-purpose",
      description: "background review", spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`),
      status: "running", startedAt: Date.now() - 1000, endedAt: null,
    } as never);
    // Held by background agents: the request is refused up front...
    let refusal: unknown = null;
    try {
      await orch.switchTaskAccountNow(task.id);
    } catch (err) {
      refusal = err;
    }
    expect((refusal as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code).toBe("background-agents");
    // ...but one scheduled earlier (turn live) is kept when the turn ends held.
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [], pendingSwap: null, allExhausted: null, lastMove: null,
      scheduledSwitch: { requestedAt: Date.now() },
    });
    expect(settleSubagentById(subagentId, "completed", "receipt")).toBe(true);
    await waitFor(() => db.tasks.get(task.id)?.agent === b && !orch.isTaskRunLive(task.id));
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("S5: a message arriving during a switch-now move is held and delivered, not refused", async () => {
    const a = alias("s5-a");
    const b = alias("s5-b");
    const stack = stacks.harnessStacks.create({ label: "s5", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "review" });
    const prior = insertRun(task.id, a);
    db.tasks.update(task.id, { runId: prior });
    const switching = orch.switchTaskAccountNow(task.id);
    const sent = await orch.sendInput(prior, "handoff reminder", { bounded: false });
    expect(sent.delivered).toBe(true);
    await switching;
    await waitFor(() => db.runs.listForTask(task.id).length >= 2 || db.tasks.get(task.id)!.backlog.length > 0);
    const rowsAfter = db.runs.listForTask(task.id);
    const backlog = db.tasks.get(task.id)!.backlog;
    // Delivered through the ordinary path after the move (a new turn on B), or,
    // if that path declined, kept in the tray: never lost or refused.
    expect(rowsAfter.length >= 2 || backlog.some((i) => i.text === "handoff reminder")).toBe(true);
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    await waitFor(() => db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Phase 6 TT-D additions (docs/plans/harness-stacks-fix-round.md D12, Phase 5
// review decisions): the refusals and settlement paths not covered above.
// ---------------------------------------------------------------------------

describe("refusals with per-member reasons and in-memory windows (TT-D)", () => {
  async function refusal(taskId: string): Promise<InstanceType<typeof orch.SwitchAccountRefusedError> | null> {
    try {
      await orch.switchTaskAccountNow(taskId);
      return null;
    } catch (err) {
      return err as InstanceType<typeof orch.SwitchAccountRefusedError>;
    }
  }

  test("no-usable-member: every other account is unusable, and the reasons name them", async () => {
    const a = alias("nu-a");
    const b = alias("nu-b");
    const stack = stacks.harnessStacks.create({ label: "nu", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "review" });
    db.harnesses.setEnabled(b, false);
    try {
      const err = await refusal(task.id);
      expect(err).toBeInstanceOf(orch.SwitchAccountRefusedError);
      expect(err!.body.code).toBe("no-usable-member");
      expect(err!.body.reasons?.some((r) => r.harnessId === b && r.reason === "disabled")).toBe(true);
      expect(err!.body.error).toContain("disabled");
      // Refused up front: nothing scheduled, nothing moved, no history.
      expect(db.tasks.get(task.id)!.agent).toBe(a);
      expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();
      expect(events(stack.id).filter((e) => e.taskId === task.id)).toHaveLength(0);
    } finally {
      db.harnesses.setEnabled(b, true);
    }
    stacks.harnessStacks.delete(stack.id);
  });

  test("busy while the limit settlement's swap window is open, and nothing is scheduled", async () => {
    const a = alias("busyw-a");
    const b = alias("busyw-b");
    const stack = stacks.harnessStacks.create({ label: "busyw", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    let inWindow: InstanceType<typeof orch.SwitchAccountRefusedError> | null = null;
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      // The earliest point of the window: no pendingSwap yet, so only the
      // in-memory window itself can refuse (a scheduled switch here would be
      // rewritten away by the swap's state writes).
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      inWindow = await refusal(task.id);
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => inWindow !== null);
      await waitFor(() => db.runs.listForTask(task.id).length >= 2 && db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    expect(inWindow).not.toBeNull();
    expect((inWindow as unknown as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code).toBe("busy");
    expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("busy while the boot swap claim is held", async () => {
    const a = alias("busyb-a");
    const b = alias("busyb-b");
    const stack = stacks.harnessStacks.create({ label: "busyb", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    await orch.reconcileOrphans();
    let during: InstanceType<typeof orch.SwitchAccountRefusedError> | null = null;
    const prev = orch.__setHarnessSwapSpawnHookForTest(async (hooked) => {
      if (hooked !== task.id) return;
      orch.__setHarnessSwapSpawnHookForTest(null);
      during = await refusal(task.id);
    });
    try {
      await orch.reconcilePendingHarnessSwaps();
      await waitFor(() => db.runs.listForTask(task.id).length >= 2 && db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    } finally {
      orch.__setHarnessSwapSpawnHookForTest(prev);
    }
    expect(during).not.toBeNull();
    expect((during as unknown as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code).toBe("busy");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("a scheduled switch is performed when the turn FAILS (TT-D)", () => {
  test("a turn that ends failed moves the task to the next account, as a `scheduled` row", async () => {
    const a = alias("fail-a");
    const b = alias("fail-b");
    const stack = stacks.harnessStacks.create({ label: "fail", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED = "1";
    process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      await waitFor(() => db.tasks.get(task.id)?.agent === b);
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED;
      delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
    }
    const first = [...db.runs.listForTask(task.id)].sort((x, y) => x.startedAt - y.startedAt)[0]!;
    expect(first.status).not.toBe("succeeded");
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    const rows = events(stack.id).filter((e) => e.taskId === task.id);
    expect(rows.map((r) => r.trigger)).toEqual(["scheduled"]);
    // Not a limit: no cooldown, nothing marked tried.
    expect(stacks.harnessStacks.getLimitState(a)).toBeNull();
    expect(after.harnessState?.tried ?? []).toEqual([]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Review fixes: an account no longer in its stack (S6), a scheduled switch
// left waiting after its turn ended (S7), the boot `manual` label.
// ---------------------------------------------------------------------------

describe("an account removed from its stack (S6)", () => {
  function orphanedTask(prefix: string, extra: Partial<Task> = {}) {
    const a = alias(`${prefix}-a`);
    const b = alias(`${prefix}-b`);
    const c = alias(`${prefix}-c`);
    const stack = stacks.harnessStacks.create({ label: prefix, kind: "claude-code", members: [a, b, c] });
    const task = makeTask(a, "work", { column: "review", ...extra });
    const prior = insertRun(task.id, a);
    db.tasks.update(task.id, { runId: prior });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 3, tried: [], pendingSwap: null, allExhausted: null, lastMove: null,
    });
    // The task's account leaves the stack; the task still resolves to it
    // through its recorded state.
    stacks.harnessStacks.update(stack.id, { members: [b, c] });
    expect(stacks.harnessStacks.resolveForTask(db.tasks.get(task.id)!)?.orphaned).toBe(true);
    return { a, b, c, stack, task, prior };
  }

  test("a switch is refused not-in-stack instead of a silent fresh start", async () => {
    const { a, stack, task } = orphanedTask("s6");
    let refusal: unknown = null;
    try {
      await orch.switchTaskAccountNow(task.id);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(orch.SwitchAccountRefusedError);
    expect((refusal as InstanceType<typeof orch.SwitchAccountRefusedError>).body.code).toBe("not-in-stack");
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(a);
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    expect(events(stack.id).filter((e) => e.taskId === task.id)).toHaveLength(0);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a scheduled switch is dropped with a status line, not applied", async () => {
    const { a, stack, task, prior } = orphanedTask("s6sched");
    db.tasks.setHarnessState(task.id, {
      ...db.tasks.get(task.id)!.harnessState!, scheduledSwitch: { requestedAt: Date.now() },
    });
    await orch.reconcilePendingHarnessSwaps();
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(a);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(db.runs.events(prior).some((e) => e.stream === "status" && e.data.includes("no longer in a stack with a backup account"))).toBe(true);
    expect(events(stack.id).filter((e) => e.taskId === task.id)).toHaveLength(0);
    stacks.harnessStacks.delete(stack.id);
  });
});

describe("a scheduled switch left waiting after its turn ended (S7)", () => {
  const statusOf = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);

  test("a FAILED turn whose background agents were still running switches once they finish", async () => {
    const { settleSubagentById } = await import("./claude-subagents.ts");
    const a = alias("s7bg-a");
    const b = alias("s7bg-b");
    const stack = stacks.harnessStacks.create({ label: "s7bg", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p");
    // The turn ended in an API error (failed, card blocked) while a background
    // agent kept running, so its turn end deferred the switch to the agents.
    const runId = insertRun(task.id, a, { status: "failed", exitCode: 1, claudeSessionId: `s7bg-${task.id}` });
    db.tasks.update(task.id, { runId, column: "blocked" });
    const subagentId = `agent-${randomUUID()}`;
    db.subagents.insertIfAbsent({
      id: subagentId, taskId: task.id, runId, parentKind: "subagent", agentType: "general-purpose",
      description: "background review", spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`),
      status: "running", startedAt: Date.now() - 1000, endedAt: null,
    } as never);
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [], pendingSwap: null, allExhausted: null, lastMove: null,
      scheduledSwitch: { requestedAt: Date.now() },
    });
    expect(settleSubagentById(subagentId, "completed", "receipt")).toBe(true);
    await waitFor(() => db.tasks.get(task.id)?.agent === b && !orch.isTaskRunLive(task.id));
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["scheduled"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  /** Run a fake turn, schedule a switch, and hold a claim on the task across
   *  the turn end: the turn end leaves the request to the claim holder. */
  async function turnEndsUnderClaim(prefix: string) {
    const a = alias(`${prefix}-a`);
    const b = alias(`${prefix}-b`);
    const stack = stacks.harnessStacks.create({ label: prefix, kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    let runId = "";
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "600";
    try {
      const started = await orch.startTask(task.id);
      runId = (started as { runId: string }).runId;
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      // The start's own claim is released once its spawn returns; take one as
      // soon as it is free (the turn is still running).
      let claimed = false;
      const deadline = Date.now() + 5000;
      while (!claimed && Date.now() < deadline) {
        claimed = orch.claimTaskForAccountSwitch(task.id);
        if (!claimed) await Bun.sleep(5);
      }
      expect(claimed).toBe(true);
      expect(db.runs.get(runId)!.status).toBe("running");
      await waitFor(() => db.runs.get(runId)?.status !== "running");
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    }
    // Give the settle chain past the turn end a moment: the request must still
    // be there, on the old account.
    await waitFor(() => statusOf(runId).some((l) => l.startsWith("exit:")));
    await Bun.sleep(50);
    expect(db.runs.get(runId)!.status).toBe("succeeded");
    expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch).toBeTruthy();
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    return { a, b, stack, task, runId };
  }

  test("the start holding the task at the turn end ends without a run: the switch is applied then", async () => {
    const { b, stack, task } = await turnEndsUnderClaim("s7claim");
    orch.releaseTaskAccountSwitch(task.id);
    await waitFor(() => db.tasks.get(task.id)?.agent === b && !orch.isTaskRunLive(task.id));
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(after.harnessState?.lastMove?.reason).toBe("switch-now");
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["scheduled"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a start holding the task that fails before minting a run applies it; a Stop on that start drops it", async () => {
    for (const stop of [false, true]) {
      const { a, b, stack, task, runId } = await turnEndsUnderClaim(stop ? "s7stop" : "s7pre");
      // Hand the task from the stand-in claim to a real start, in the same
      // tick, and hold that start in its pre-flight (the teardown queue).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      void orch.__enqueueTeardownForTest(task.id, task.workdir, () => gate);
      // Worktree isolation on a folder that is no git repo: the start fails
      // its workdir pre-flight, after the claim and before any run exists.
      db.tasks.update(task.id, { isolation: "worktree" });
      orch.releaseTaskAccountSwitch(task.id);
      const starting = orch.startTask(task.id);
      // Nothing is live, so a Stop lands on the start's claim.
      if (stop) expect(await orch.cancelLiveRunOfTask(task.id)).toBe(true);
      release();
      const result = await starting;
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("not inside a git repo");
      expect(db.runs.listForTask(task.id)).toHaveLength(1);
      if (stop) {
        await waitFor(() => db.tasks.get(task.id)?.harnessState?.scheduledSwitch == null);
        expect(db.tasks.get(task.id)!.agent).toBe(a);
        expect(statusOf(runId).some((l) => l.includes("scheduled account switch cancelled (stopped)"))).toBe(true);
        expect(events(stack.id).filter((e) => e.taskId === task.id && e.trigger === "scheduled")).toHaveLength(0);
      } else {
        await waitFor(() => db.tasks.get(task.id)?.agent === b && !orch.isTaskRunLive(task.id));
        expect(db.tasks.get(task.id)!.agent).toBe(b);
        expect(events(stack.id).filter((e) => e.taskId === task.id && e.trigger === "scheduled")).toHaveLength(1);
      }
      expect(db.tasks.get(task.id)!.harnessState?.scheduledSwitch ?? null).toBeNull();
      stacks.harnessStacks.delete(stack.id);
    }
  }, 40_000);
});

describe("boot completion of an interrupted switch-now (label)", () => {
  test("an idle `manual` switch-now finished at boot keeps the switch-now label; a plain manual switch does not", async () => {
    for (const switchNow of ["manual", undefined] as const) {
      const a = alias(`bootlbl-${switchNow ?? "plain"}-a`);
      const b = alias(`bootlbl-${switchNow ?? "plain"}-b`);
      const stack = stacks.harnessStacks.create({ label: "bootlbl", kind: "claude-code", members: [a, b] });
      // The row update landed on the destination before the restart.
      const task = makeTask(b, "work", { column: "review" });
      const prior = insertRun(task.id, a);
      db.tasks.update(task.id, { runId: prior });
      db.tasks.setHarnessState(task.id, {
        stackId: stack.id, position: 1, count: 2, tried: [], allExhausted: null, lastMove: null,
        pendingSwap: {
          from: a, to: b, reason: "quota", runId: prior, startedAt: Date.now(), manual: true,
          ...(switchNow ? { switchNow } : {}),
        },
      });
      await orch.reconcilePendingHarnessSwaps();
      const after = db.tasks.get(task.id)!;
      expect(after.agent).toBe(b);
      expect(after.harnessState?.pendingSwap ?? null).toBeNull();
      expect(after.harnessState?.lastMove).toMatchObject({
        from: a, to: b, reason: switchNow ? "switch-now" : "manual-switch",
      });
      expect(after.harnessState?.tried ?? []).toEqual([]);
      expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["boot-resume"]);
      expect(stacks.harnessStacks.getLimitState(a)).toBeNull();
      stacks.harnessStacks.delete(stack.id);
    }
  });
});

describe("a limit settlement that throws before consuming a scheduled switch (S7)", () => {
  test("drops the request with a status line instead of leaving it for a later turn", async () => {
    const a = alias("s7throw-a");
    const b = alias("s7throw-b");
    const stack = stacks.harnessStacks.create({ label: "s7throw", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    // The earliest point of the settlement, before the request is consumed.
    const prev = orch.__setHarnessSwapSettleHookForTest((hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      throw new Error("synthetic settlement failure");
    });
    let runId = "";
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "300";
    try {
      runId = ((await orch.startTask(task.id)) as { runId: string }).runId;
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("blocked");
    expect(after.agent).toBe(a);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    const lines = db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(lines.some((l) => l.includes("switching accounts failed: synthetic settlement failure"))).toBe(true);
    expect(lines.some((l) => l.includes("scheduled account switch dropped: the account switch after the limit failed"))).toBe(true);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("a background agent settling inside the turn-end pump (S7 race)", () => {
  test("the turn-end path applies the scheduled switch, not the subagent release edge", async () => {
    const { settleSubagentById } = await import("./claude-subagents.ts");
    const a = alias("s7pump-a");
    const b = alias("s7pump-b");
    const stack = stacks.harnessStacks.create({ label: "s7pump", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    const subagentId = `agent-${randomUUID()}`;
    // Whether the account-switch claim was free right after the last
    // background agent settled inside the done handler: if the release edge
    // had applied the switch there, it would hold the claim (without the
    // turn-end ordering) and the turn end could not claim it.
    let claimFreeAfterRelease: boolean | null = null;
    const prev = orch.__setTurnSettlePumpHookForTest((hooked) => {
      if (hooked !== task.id) return;
      orch.__setTurnSettlePumpHookForTest(null);
      settleSubagentById(subagentId, "completed", "receipt");
      claimFreeAfterRelease = orch.claimTaskForAccountSwitch(task.id);
      if (claimFreeAfterRelease) orch.releaseTaskAccountSwitch(task.id);
    });
    process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "500";
    try {
      const runId = ((await orch.startTask(task.id)) as { runId: string }).runId;
      db.subagents.insertIfAbsent({
        id: subagentId, taskId: task.id, runId, parentKind: "subagent", agentType: "general-purpose",
        description: "background review", spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`),
        status: "running", startedAt: Date.now(), endedAt: null,
      } as never);
      expect((await orch.switchTaskAccountNow(task.id)).status).toBe("scheduled");
      await waitFor(() => db.tasks.get(task.id)?.agent === b && !orch.isTaskRunLive(task.id));
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
      orch.__setTurnSettlePumpHookForTest(prev);
    }
    expect(claimFreeAfterRelease as boolean | null).toBe(true);
    const after = db.tasks.get(task.id)!;
    expect(after.agent).toBe(b);
    expect(after.harnessState?.scheduledSwitch ?? null).toBeNull();
    expect(events(stack.id).filter((e) => e.taskId === task.id).map((e) => e.trigger)).toEqual(["scheduled"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});
