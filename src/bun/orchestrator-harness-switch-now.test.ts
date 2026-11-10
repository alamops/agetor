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
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_FAKE_CLAUDE_TURN_MS"] as const;
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
    const result = await orch.switchTaskAccountNow(task.id);
    expect(result.status).toBe("switched");
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
