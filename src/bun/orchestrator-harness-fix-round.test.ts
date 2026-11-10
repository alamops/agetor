// Harness-stack fix round, Phase 6 group TT-D (docs/plans/harness-stacks-fix-round.md
// §1 SC1-SC5/SC8/SC9, §3 D1-D6/D12, §4 findings 1-5 and 22a/b, §7a): the
// orchestrator regressions, driven through the fake Claude/Codex drivers.
// Nothing here touches a real CLI or the user's accounts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HARNESS_LIMIT_STATUS_PREFIX, type GlobalEvent, type Task, type TaskHarnessState } from "../shared/types.ts";

// Literal copies: a static src/bun import would load db.ts before the data dir
// below is set (the suite runs every file in one process).
const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
const FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER = "__agetor_fake_claude_limit_clean__";
const FAKE_CODEX_LIMIT_PROMPT_MARKER = "__agetor_fake_codex_limit__";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harness-fixround-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const ENV_KEYS = [
  "AGETOR_CLAUDE_DRIVER",
  "AGETOR_CLAUDE_BIN",
  "AGETOR_TMUX_BIN",
  "AGETOR_CODEX_DRIVER",
  "AGETOR_CODEX_BIN",
  "AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS",
  "AGETOR_FAKE_CLAUDE_TURN_MS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-harness-fixround-bin-"));
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
const taskIds: string[] = [];

beforeAll(async () => {
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  history = await import("./harness-swap-history.ts");
});

afterAll(async () => {
  for (const id of taskIds) {
    const state = db.tasks.get(id)?.harnessState;
    if (state) db.tasks.setHarnessState(id, { ...state, allExhausted: null, pendingSwap: null });
  }
  failover.stopAllAutoRetryTimers();
  orch.__resetLaunchFreezeForTest();
  orch.__setChunkHandlerTapForTest(null);
  orch.__setHarnessSwapSettleHookForTest(null);
  orch.__setHarnessSwapSpawnHookForTest(null);
  orch.__setHarnessLimitObservedHookForTest(null);
  orch.__setHarnessSwapPromptHookForTest(null);
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

/** A Codex account whose `CODEX_HOME` is `<home>/.codex`; returns its id. */
function codexAlias(prefix: string): string {
  const id = `${prefix}-${++seq}`;
  const dir = path.join(DATA_DIR, "harnesses", id);
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "auth.json"), "{}");
  db.harnesses.insert({ id, kind: "codex", label: id, home: dir, env: {} } as never);
  return id;
}
const codexRoot = (id: string) => path.join(DATA_DIR, "harnesses", id, ".codex");

function plantRollout(root: string, threadId: string): string {
  const rel = path.join("sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${threadId}.jsonl`);
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(root, rel), `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n`, { mode: 0o600 });
  return rel;
}

function makeTask(agent: string, prompt: string, extra: Partial<Task> = {}): Task {
  const id = randomUUID();
  const workdir = path.join(DATA_DIR, "work", `${++seq}`);
  mkdirSync(workdir, { recursive: true });
  db.tasks.insert({
    id, title: "fix round", prompt, agent, workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "sonnet-4.6", effort: "high", speed: "off", maxMode: false,
    opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
    column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
    ...extra,
  } as never);
  taskIds.push(id);
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

function exhausted(at: number, patch: Partial<NonNullable<TaskHarnessState["allExhausted"]>> = {}): NonNullable<TaskHarnessState["allExhausted"]> {
  return { at, attempts: 0, max: 3, nextAttemptAt: at, earliestResetAtMs: null, reason: "quota", ...patch };
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(15);
  }
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const settledRuns = (taskId: string, n: number) => () => {
  const rows = db.runs.listForTask(taskId);
  return rows.length >= n && rows.every((r) => r.status !== "running");
};
const sortedRuns = (taskId: string) => [...db.runs.listForTask(taskId)].sort((a, b) => a.startedAt - b.startedAt);
const statusLines = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
const userRows = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "user").map((e) => e.data);
const backlogTexts = (taskId: string) => db.tasks.get(taskId)!.backlog.map((i) => i.text);
const histRows = (stackId: string, taskId: string) =>
  history.harnessSwapEvents.page(stackId, { limit: 100 }).events.filter((e) => e.taskId === taskId);
const limitChunk = (extra: Record<string, unknown> = {}) =>
  `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify({
    reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "usage limit", source: "claude-api-error", ...extra,
  })}`;

// ---------------------------------------------------------------------------
// Finding 1 (SC1, D1): a limit that lands while the swap/boot claim is held
// ---------------------------------------------------------------------------

describe("finding 1: a successor limit while a claim is held is deferred, then settled", () => {
  /** Hold the task's teardown queue open: the held-follow-up delivery awaits it
   *  (`pendingTeardown`), so the swap window stays open for as long as the gate. */
  function openGate(task: Task): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void orch.__enqueueTeardownForTest(task.id, task.workdir, () => gate);
    return release;
  }

  /** Feed the successor (the task's second run) a limit through its real chunk
   *  handler, retrying until its run is registered (the handler ignores a
   *  signal before that), then report the cooldown it stored. */
  function limitSuccessorWhenRegistered(on: string, state: { handler: ((s: never, d: string) => void) | null; injected: boolean }) {
    return async () => {
      await waitFor(() => state.handler !== null);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && stacks.harnessStacks.getLimitState(on) === null) {
        state.handler!("status" as never, limitChunk());
        await Bun.sleep(5);
      }
      state.injected = stacks.harnessStacks.getLimitState(on) !== null;
    };
  }

  test("during held follow-up delivery: moved to the next account, never left running", async () => {
    const a = alias("f1-a");
    const b = alias("f1-b");
    const c = alias("f1-c");
    const stack = stacks.harnessStacks.create({ label: "f1", kind: "claude-code", members: [a, b, c] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const state = { handler: null as ((s: never, d: string) => void) | null, injected: false };
    const gateRef: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== task.id) return;
      calls++;
      // The second handler is the first successor's: gate its delivery.
      if (calls === 2) {
        state.handler = handler as never;
        gateRef.release = openGate(task);
      }
    });
    const prevSettle = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      // Held (the window is open) and delivered to the successor afterwards.
      expect((await orch.sendInput(runId, "typed during the swap")).delivered).toBe(true);
    });
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "250" }, async () => {
        expect(await orch.startTask(task.id)).toHaveProperty("runId");
        await limitSuccessorWhenRegistered(b, state)();
        expect(state.injected).toBe(true);
        // The successor's turn ends while the delivery still holds the window:
        // its limit is deferred, so it is still `running` (undecided) here.
        await waitFor(() => statusLines(sortedRuns(task.id)[1]!.id).some((l) => l.includes("switching once the current switch settles")));
        const successor = sortedRuns(task.id)[1]!;
        expect(statusLines(successor.id).some((l) => l.includes("switching once the current switch settles"))).toBe(true);
        expect(db.runs.get(successor.id)!.status).toBe("running");
        expect(db.tasks.get(task.id)!.column).toBe("running");
        gateRef.release!();
        await waitFor(settledRuns(task.id, 3), 15_000);
      });
    } finally {
      gateRef.release?.();
      orch.__setChunkHandlerTapForTest(prevTap);
      orch.__setHarnessSwapSettleHookForTest(prevSettle);
    }
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(3);
    // Decided exactly once: the limited successor failed, the third account took over.
    expect(rows[1]!.agent).toBe(b);
    expect(rows[1]!.status).toBe("failed");
    expect(rows[2]!.agent).toBe(c);
    expect(rows[2]!.origin).toBe("harness-swap");
    expect(rows.some((r) => r.status === "running")).toBe(false);
    expect(db.tasks.get(task.id)!.agent).toBe(c);
    expect(histRows(stack.id, task.id).map((r) => r.trigger).sort()).toEqual(["limit", "limit"]);
    for (const id of [a, b, c]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("during held follow-up delivery with nowhere to go: the card is blocked, not left running", async () => {
    const a = alias("f1blk-a");
    const b = alias("f1blk-b");
    const stack = stacks.harnessStacks.create({ label: "f1blk", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const state = { handler: null as ((s: never, d: string) => void) | null, injected: false };
    const gateRef: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== task.id) return;
      calls++;
      if (calls === 2) {
        state.handler = handler as never;
        gateRef.release = openGate(task);
      }
    });
    const prevSettle = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      await orch.sendInput(runId, "typed during the swap");
    });
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "250" }, async () => {
        expect(await orch.startTask(task.id)).toHaveProperty("runId");
        await limitSuccessorWhenRegistered(b, state)();
        await waitFor(() => statusLines(sortedRuns(task.id)[1]!.id).some((l) => l.includes("switching once the current switch settles")));
        expect(db.runs.get(sortedRuns(task.id)[1]!.id)!.status).toBe("running");
        gateRef.release!();
        await waitFor(() => db.tasks.get(task.id)?.column === "blocked", 15_000);
      });
    } finally {
      gateRef.release?.();
      orch.__setChunkHandlerTapForTest(prevTap);
      orch.__setHarnessSwapSettleHookForTest(prevSettle);
      failover.cancelAutoRetry(task.id);
    }
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.status).toBe("failed");
    expect(rows.some((r) => r.status === "running")).toBe(false);
    expect(db.tasks.get(task.id)!.column).toBe("blocked");
    // Both accounts are cooling: a counted retry is armed, one blocked row written.
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted?.nextAttemptAt).toBeGreaterThan(0);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("during the boot swap claim: settled on release, not left running", async () => {
    const a = alias("f1boot-a");
    const b = alias("f1boot-b");
    const c = alias("f1boot-c");
    const stack = stacks.harnessStacks.create({ label: "f1boot", kind: "claude-code", members: [a, b, c] });
    const task = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 3, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    await orch.reconcileOrphans();
    const state = { handler: null as ((s: never, d: string) => void) | null, injected: false };
    const gateRef: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== task.id) return;
      calls++;
      if (calls === 1) {
        state.handler = handler as never;
        gateRef.release = openGate(task);
      }
    });
    // Held at boot: the boot claim is the swap window, so a message is held.
    const prevSpawn = orch.__setHarnessSwapSpawnHookForTest(async (hooked) => {
      if (hooked !== task.id) return;
      orch.__setHarnessSwapSpawnHookForTest(null);
      expect((await orch.sendInput(oldRun, "typed during boot")).delivered).toBe(true);
    });
    let booted: Promise<number> | null = null;
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "250" }, async () => {
        booted = orch.reconcilePendingHarnessSwaps();
        await limitSuccessorWhenRegistered(b, state)();
        expect(state.injected).toBe(true);
        await waitFor(() => (sortedRuns(task.id)[1] ? statusLines(sortedRuns(task.id)[1]!.id).some((l) => l.includes("switching once the current switch settles")) : false));
        expect(db.runs.get(sortedRuns(task.id)[1]!.id)!.status).toBe("running");
        gateRef.release!();
        await booted;
        await waitFor(settledRuns(task.id, 3), 15_000);
      });
    } finally {
      gateRef.release?.();
      await booted;
      orch.__setChunkHandlerTapForTest(prevTap);
      orch.__setHarnessSwapSpawnHookForTest(prevSpawn);
    }
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.agent).toBe(b);
    expect(rows[1]!.status).toBe("failed");
    expect(rows[2]!.agent).toBe(c);
    expect(rows.some((r) => r.status === "running")).toBe(false);
    for (const id of [a, b, c]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a foreign claim (an account switch that owns the next turn) passes through to the normal settle", async () => {
    const a = alias("f1foreign-a");
    const b = alias("f1foreign-b");
    const stack = stacks.harnessStacks.create({ label: "f1foreign", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    const state = { handler: null as ((s: never, d: string) => void) | null };
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked === task.id) state.handler = handler as never;
    });
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "400" }, async () => {
        expect(await orch.startTask(task.id)).toHaveProperty("runId");
        await waitFor(() => state.handler !== null);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && stacks.harnessStacks.getLimitState(a) === null) {
          state.handler!("status" as never, limitChunk());
          await Bun.sleep(5);
        }
        expect(stacks.harnessStacks.getLimitState(a)).not.toBeNull();
        // Not the swap window: an ordinary account-switch claim.
        expect(orch.claimTaskForAccountSwitch(task.id)).toBe(true);
        await waitFor(() => db.runs.listForTask(task.id).every((r) => r.status !== "running"), 8000);
        orch.releaseTaskAccountSwitch(task.id);
      });
    } finally {
      orch.__setChunkHandlerTapForTest(prevTap);
      orch.releaseTaskAccountSwitch(task.id);
    }
    const rows = sortedRuns(task.id);
    // Settled normally in place: no deferral, no successor next to the claim holder.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(statusLines(rows[0]!.id).some((l) => l.includes("switching once the current switch settles"))).toBe(false);
    expect(db.tasks.get(task.id)!.column).toBe("ready");
    expect(histRows(stack.id, task.id)).toHaveLength(0);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Finding 2 (SC2, D2): a core killed mid-transfer resumes the swap at boot
// ---------------------------------------------------------------------------

describe("finding 2: a crash mid-swap resumes instead of orphaning", () => {
  test("old run still running: no orphaned event, no step settle, the swap resumes", async () => {
    const a = alias("f2-a");
    const b = alias("f2-b");
    const stack = stacks.harnessStacks.create({ label: "f2", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running", pipelineId: randomUUID() } as Partial<Task>);
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    const seen: GlobalEvent[] = [];
    const unsub = orch.subscribeGlobal((e) => { if ("taskId" in e && e.taskId === task.id) seen.push(e); });
    try {
      await orch.reconcileOrphans();
      // Between the reconciles: the old run is failed (swap reason), nothing orphaned.
      expect(db.runs.get(oldRun)!.status).toBe("failed");
      expect(db.tasks.get(task.id)!.column).toBe("running");
      expect(db.tasks.get(task.id)!.runId).toBe(oldRun);
      const settledWithoutReason = seen.filter((e) => e.kind === "run-status" && e.runId === oldRun && (e as { reason?: string }).reason !== "harness-swap");
      expect(settledWithoutReason).toEqual([]);
      expect(seen.some((e) => e.kind === "run-status" && (e as { status?: string }).status === "orphaned")).toBe(false);
      expect(db.runs.events(oldRun).some((e) => e.data.includes("orphaned"))).toBe(false);

      await orch.reconcilePendingHarnessSwaps();
      await waitFor(settledRuns(task.id, 2), 15_000);
    } finally {
      unsub();
    }
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.agent).toBe(b);
    expect(rows[1]!.origin).toBe("harness-swap");
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    // The old run was only ever reported as a harness-swap failure; a step
    // runner settles on any other terminal status, so none was emitted for it.
    expect(seen.filter((e) => e.kind === "run-status" && e.runId === oldRun).every((e) => (e as { reason?: string }).reason === "harness-swap")).toBe(true);
    expect(histRows(stack.id, task.id).map((r) => r.trigger)).toEqual(["boot-resume"]);
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);

  test("a resume that throws blocks the task with harness-swap-failed and one blocked history row", async () => {
    const a = alias("f2throw-a");
    const b = alias("f2throw-b");
    const stack = stacks.harnessStacks.create({ label: "f2throw", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "work", { column: "running" });
    const oldRun = insertRun(task.id, a, { status: "running", endedAt: null, exitCode: null });
    db.tasks.update(task.id, { runId: oldRun });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a],
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRun, startedAt: Date.now() },
      allExhausted: null, lastMove: null,
    });
    await orch.reconcileOrphans();
    const prev = orch.__setHarnessSwapSpawnHookForTest(() => { throw new Error("EACCES: synthetic transfer failure"); });
    try {
      await orch.reconcilePendingHarnessSwaps();
    } finally {
      orch.__setHarnessSwapSpawnHookForTest(prev);
    }
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("blocked");
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    expect(db.runs.get(oldRun)!.status).toBe("failed");
    expect(histRows(stack.id, task.id).map((r) => r.trigger)).toEqual(["blocked"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Finding 3 (SC3, D3): Codex queued follow-ups reach the tray on every ending
// ---------------------------------------------------------------------------

describe("finding 3: Codex queued follow-ups are stashed on every ending without a successor", () => {
  const CODEX_ENV = { AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "400" };

  function codexStack(prefix: string) {
    const a = codexAlias(`${prefix}-a`);
    const b = codexAlias(`${prefix}-b`);
    const stack = stacks.harnessStacks.create({ label: prefix, kind: "codex", members: [a, b] });
    const task = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    return { a, b, stack, task };
  }

  /** Turn 1 is plain and live; the follow-up that carries the limit marker and a
   *  third message queue behind it. When turn 1 ends the limit turn runs, with
   *  the third message still sitting in the Codex turn queue. */
  async function queueBehindTurn(taskId: string): Promise<string> {
    const started = await orch.startTask(taskId);
    const runId = (started as { runId: string }).runId;
    expect((await orch.sendInput(runId, `second ${FAKE_CODEX_LIMIT_PROMPT_MARKER}`)).delivered).toBe(true);
    expect((await orch.sendInput(runId, "third message")).delivered).toBe(true);
    return runId;
  }

  test("all accounts exhausted: the queued message and the one held in the window are stashed, queued first", async () => {
    const { a, b, stack, task } = codexStack("f3blk");
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "x", source: "codex-turn-failed" } as never);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "before-block") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect((await orch.sendInput(runId, "typed during the window")).delivered).toBe(true);
    });
    try {
      await withEnv(CODEX_ENV, async () => {
        await queueBehindTurn(task.id);
        await waitFor(() => db.tasks.get(task.id)?.column === "blocked", 15_000);
        await waitFor(() => backlogTexts(task.id).length >= 2);
      });
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      failover.cancelAutoRetry(task.id);
    }
    // The queue drained into the tray before the held message (tray order is send order).
    expect(backlogTexts(task.id)).toEqual(["third message", "typed during the window"]);
    // Nothing ran the stranded message.
    expect(db.runs.listForTask(task.id)).toHaveLength(2);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a transfer that fails and blocks: the queued message is stashed", async () => {
    const { a, b, stack, task } = codexStack("f3xfer");
    // No rollout on A: the limited turn did work, so the move has nothing to copy and blocks.
    try {
      await withEnv(CODEX_ENV, async () => {
        await queueBehindTurn(task.id);
        await waitFor(() => db.tasks.get(task.id)?.column === "blocked", 15_000);
      });
    } finally {
      failover.cancelAutoRetry(task.id);
    }
    expect(backlogTexts(task.id)).toContain("third message");
    expect(sortedRuns(task.id)).toHaveLength(2);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a Stop in the settlement window: the queued message is stashed, not drained", async () => {
    const { a, b, stack, task } = codexStack("f3stop");
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect(await orch.cancelRun(runId)).toBe(true);
    });
    try {
      await withEnv(CODEX_ENV, async () => {
        await queueBehindTurn(task.id);
        await waitFor(() => db.tasks.get(task.id)?.column === "ready" && sortedRuns(task.id).length >= 2 && backlogTexts(task.id).length > 0, 15_000);
      });
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    expect(backlogTexts(task.id)).toContain("third message");
    expect(sortedRuns(task.id)).toHaveLength(2);
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a successor whose spawn fails: the queued message is stashed", async () => {
    const { a, b, stack, task } = codexStack("f3spawn");
    plantRollout(codexRoot(a), `fake-codex-thread-${task.id}`);
    // The conversation moves fine, then the successor cannot start: an empty
    // model makes the driver throw on every spawn.
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      db.tasks.update(task.id, { model: "" as never });
    });
    try {
      await withEnv(CODEX_ENV, async () => {
        await queueBehindTurn(task.id);
        await waitFor(() => db.tasks.get(task.id)?.column === "blocked" && backlogTexts(task.id).length > 0, 15_000);
      });
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      failover.cancelAutoRetry(task.id);
    }
    expect(backlogTexts(task.id)).toContain("third message");
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a launch freeze in the window leaves the swap for the next owner: the queued message is stashed first", async () => {
    const { a, b, stack, task } = codexStack("f3frz");
    plantRollout(codexRoot(a), `fake-codex-thread-${task.id}`);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      orch.freezeLaunches();
    });
    try {
      await withEnv(CODEX_ENV, async () => {
        await queueBehindTurn(task.id);
        await waitFor(() => backlogTexts(task.id).length > 0, 15_000);
      });
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      orch.__resetLaunchFreezeForTest();
    }
    expect(backlogTexts(task.id)).toContain("third message");
    expect(sortedRuns(task.id)).toHaveLength(2);
    // The swap itself is left persisted for the next owner.
    expect(db.tasks.get(task.id)!.harnessState?.pendingSwap?.to).toBe(b);
    db.tasks.setHarnessState(task.id, null);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Finding 4 (SC3, D3) and review M1/S6: clean-retry follow-ups
// ---------------------------------------------------------------------------

describe("finding 4: clean-retry follow-ups survive every ending of the retry", () => {
  /** A task blocked on an armed clean retry of `original` (rows P and F1). */
  async function armedCleanRetry(prefix: string) {
    const a = alias(`${prefix}-a`);
    const b = alias(`${prefix}-b`);
    const stack = stacks.harnessStacks.create({ label: prefix, kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "usage limit", source: "claude-api-error" });
    const task = makeTask(a, `no tools yet ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", "also update the docs");
    });
    let original = "";
    try {
      original = ((await orch.startTask(task.id)) as { runId: string }).runId;
      await waitFor(() => db.tasks.get(task.id)?.harnessState?.allExhausted != null);
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
    }
    expect(db.tasks.get(task.id)!.harnessState!.allExhausted!.cleanRetryOf).toBe(original);
    expect(backlogTexts(task.id)).toEqual([]);
    return { a, b, stack, task, original };
  }

  test("a manual message ends the retry and stashes the follow-ups once", async () => {
    const { a, b, stack, task, original } = await armedCleanRetry("f4manual");
    // The user takes the task back by typing: a manual prepare ends the armed retry.
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.clearLimitState(b);
    await orch.sendInput(original, "my own message");
    await waitFor(() => backlogTexts(task.id).includes("also update the docs"));
    expect(backlogTexts(task.id).filter((t) => t === "also update the docs")).toHaveLength(1);
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted?.cleanRetryOf).toBeUndefined();
    // Nothing is stashed a second time by a later cancel.
    orch.cancelHarnessRetryForTask(task.id);
    expect(backlogTexts(task.id).filter((t) => t === "also update the docs")).toHaveLength(1);
    await waitFor(() => db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    failover.cancelAutoRetry(task.id);
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);

  test("the retry attempt cap ends the retry and stashes the follow-ups", async () => {
    const a = alias("f4cap-a");
    const b = alias("f4cap-b");
    const stack = stacks.harnessStacks.create({ label: "f4cap", kind: "claude-code", members: [a, b] });
    // An empty model makes every retry spawn throw: each fired retry spends an attempt.
    const task = makeTask(a, "the task prompt", { model: "" as never, column: "blocked" });
    const original = insertRun(task.id, a, { status: "failed", exitCode: -1, startedAt: Date.now() - 5_000, endedAt: Date.now() - 4_900 });
    db.runs.appendEvent(original, "user", "the task prompt");
    db.runs.appendEvent(original, "user", "follow-up one");
    db.tasks.update(task.id, { runId: original });
    const at = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 2, nextAttemptAt: at, cleanRetryOf: original }),
    });
    try {
      failover.armAutoRetry(task.id, at);
      await waitFor(() => db.tasks.get(task.id)!.harnessState?.allExhausted?.attempts === 3);
      await waitFor(() => backlogTexts(task.id).length > 0);
    } finally {
      failover.cancelAutoRetry(task.id);
    }
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted).toMatchObject({ attempts: 3, nextAttemptAt: 0 });
    expect(backlogTexts(task.id)).toEqual(["follow-up one"]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a second consecutive clean retry recovers the follow-ups from the original run", async () => {
    const a = alias("f4chain-a");
    const b = alias("f4chain-b");
    const stack = stacks.harnessStacks.create({ label: "f4chain", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "the task prompt", { column: "blocked" });
    const original = insertRun(task.id, a, { status: "failed", exitCode: -1, startedAt: Date.now() - 9_000, endedAt: Date.now() - 8_900 });
    db.runs.appendEvent(original, "user", "the task prompt");
    db.runs.appendEvent(original, "user", "follow-up one");
    // The first retry replayed everything as ONE hidden wrapper row, then took a newer message.
    const sharedStack = await import("../shared/harness-stack.ts");
    const firstRetry = insertRun(task.id, b, {
      status: "failed", exitCode: -1, origin: "harness-swap", startedAt: Date.now() - 5_000, endedAt: Date.now() - 4_900,
    });
    db.runs.appendEvent(firstRetry, "user", sharedStack.composeHarnessStackContinuationPrompt(["the task prompt", "follow-up one"]));
    db.runs.appendEvent(firstRetry, "user", "follow-up two");
    db.tasks.update(task.id, { runId: firstRetry });
    // The retry limited again: the marker chains to the ORIGINAL run.
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 1, count: 2, tried: [a, b], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(Date.now(), { attempts: 1, nextAttemptAt: Date.now() + 3_600_000, cleanRetryOf: original }),
    });
    expect(orch.cancelHarnessRetryForTask(task.id, "cancelled for test")).toBe(true);
    // Each message once, in send order, and never the hidden wrapper text.
    expect(backlogTexts(task.id)).toEqual(["follow-up one", "follow-up two"]);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a first part that is not the task prompt is kept (S6) and the stash is a one-shot", async () => {
    const a = alias("f4s6-a");
    const b = alias("f4s6-b");
    const stack = stacks.harnessStacks.create({ label: "f4s6", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "the task prompt", { column: "blocked" });
    const original = insertRun(task.id, a, { status: "failed", exitCode: -1, startedAt: Date.now() - 5_000, endedAt: Date.now() - 4_900 });
    db.runs.appendEvent(original, "user", "a fresh start message");
    db.runs.appendEvent(original, "user", "and a follow-up");
    db.tasks.update(task.id, { runId: original });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(Date.now(), { nextAttemptAt: Date.now() + 3_600_000, cleanRetryOf: original }),
    });
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(true);
    expect(backlogTexts(task.id)).toEqual(["a fresh start message", "and a follow-up"]);
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(false);
    expect(backlogTexts(task.id)).toHaveLength(2);
    stacks.harnessStacks.delete(stack.id);
  });

  test("two identical unread mid-turn sends are both kept in the tray", async () => {
    const a = alias("f4twin-a");
    const b = alias("f4twin-b");
    const stack = stacks.harnessStacks.create({ label: "f4twin", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "x", source: "claude-pane" });
    // A transfer-branch limit (the turn used a tool) with nowhere to go: the retry
    // resumes a copied transcript that never held the unread messages.
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      for (let i = 0; i < 2; i++) {
        db.runs.appendEvent(runId, "user", "same text");
        orch.__noteMidTurnFollowUpForTest(runId, "same text");
      }
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
      failover.cancelAutoRetry(task.id);
    }
    expect(backlogTexts(task.id)).toEqual(["same text", "same text"]);
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Finding 5 (SC4, D4): a success clears only the cooldown it could have seen
// ---------------------------------------------------------------------------

describe("finding 5: cooldown clears are conditional", () => {
  test("a success that started before another task's limit leaves that cooldown alone", async () => {
    const a = alias("f5-a");
    const b = alias("f5-b");
    const stack = stacks.harnessStacks.create({ label: "f5", kind: "claude-code", members: [a, b] });
    const slow = makeTask(a, "a slow plain turn");
    let startedAt = 0;
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "500" }, async () => {
        expect(await orch.startTask(slow.id)).toHaveProperty("runId");
        startedAt = db.runs.listForTask(slow.id)[0]!.startedAt;
        // Another task on the same account hits a limit while this turn is running.
        await Bun.sleep(0);
        stacks.harnessStacks.setLimitState(a, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "other task", source: "claude-api-error" }, Math.max(Date.now(), startedAt + 5));
        expect(stacks.harnessStacks.getLimitState(a)).not.toBeNull();
        await waitFor(settledRuns(slow.id, 1), 10_000);
      });
    } finally {
      // keep the assertion below independent of cleanup
    }
    expect(db.runs.listForTask(slow.id)[0]!.status).toBe("succeeded");
    // The success began before the limit was recorded, so it proves nothing about it.
    expect(stacks.harnessStacks.getLimitState(a)?.message).toBe("other task");
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a success that started after the limit clears it", async () => {
    const a = alias("f5ok-a");
    const b = alias("f5ok-b");
    const stack = stacks.harnessStacks.create({ label: "f5ok", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(a, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "stale", source: "claude-api-error" }, Date.now() - 60_000);
    const task = makeTask(a, "a plain turn");
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 1));
    await waitFor(() => stacks.harnessStacks.getLimitState(a) === null);
    expect(stacks.harnessStacks.getLimitState(a)).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a recovered per-model Codex 429 self-clears its own model row; a newer overwrite of that row survives", async () => {
    const a = codexAlias("f5cm-a");
    const b = codexAlias("f5cm-b");
    const stack = stacks.harnessStacks.create({ label: "f5cm", kind: "codex", members: [a, b] });
    const own = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    const newer = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    const signal = { reason: "rate_limit", resetAtMs: null, message: "429 for the model", source: "codex-error", model: "fixture-codex-model" };
    const feed = (target: Task, after?: () => void) => orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== target.id) return;
      orch.__setChunkHandlerTapForTest(null);
      setTimeout(() => {
        handler("status", `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify(signal)}`);
        after?.();
      }, 150);
    });
    let sawOwn = false;
    let ownAfter: unknown = "unset";
    let newerAfter: ReturnType<typeof stacks.harnessStacks.getLimitState> = null;
    try {
      await withEnv({ AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "700" }, async () => {
        feed(own, () => { sawOwn = stacks.harnessStacks.getLimitState(a, { model: "fixture-codex-model" }) !== null; });
        expect(await orch.startTask(own.id)).toHaveProperty("runId");
        await waitFor(() => db.tasks.get(own.id)?.column === "review", 10_000);
        ownAfter = stacks.harnessStacks.getLimitState(a, { model: "fixture-codex-model" });
        feed(newer, () => {
          stacks.harnessStacks.setLimitState(a, { ...signal, message: "newer model overwrite" } as never, Date.now() + 5);
        });
        expect(await orch.startTask(newer.id)).toHaveProperty("runId");
        await waitFor(() => db.tasks.get(newer.id)?.column === "review", 10_000);
        newerAfter = stacks.harnessStacks.getLimitState(a, { model: "fixture-codex-model" });
      });
    } finally {
      orch.__setChunkHandlerTapForTest(null);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(sawOwn).toBe(true);
    expect(ownAfter).toBeNull();
    expect(newerAfter).not.toBeNull();
    expect(newerAfter!.message).toBe("newer model overwrite");
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);

  test("a recovered Codex 429 self-clears exactly its own row; a newer overwrite survives", async () => {
    const a = codexAlias("f5cx-a");
    const b = codexAlias("f5cx-b");
    const stack = stacks.harnessStacks.create({ label: "f5cx", kind: "codex", members: [a, b] });
    const own = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    const newer = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    const signal = { reason: "rate_limit", resetAtMs: null, message: "429 Too Many Requests", source: "codex-error" };
    const feed = (target: Task, after?: () => void) => orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== target.id) return;
      orch.__setChunkHandlerTapForTest(null);
      setTimeout(() => {
        handler("status", `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify(signal)}`);
        after?.();
      }, 150);
    });
    let sawOwn = false;
    let afterOwn: unknown = "unset";
    let afterNewer: ReturnType<typeof stacks.harnessStacks.getLimitState> = null;
    try {
      await withEnv({ AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "700" }, async () => {
        // 1. Its own row, still the stored one when the turn completes: cleared.
        feed(own, () => { sawOwn = stacks.harnessStacks.getLimitState(a) !== null; });
        expect(await orch.startTask(own.id)).toHaveProperty("runId");
        await waitFor(() => db.tasks.get(own.id)?.column === "review", 10_000);
        afterOwn = stacks.harnessStacks.getLimitState(a);
        // 2. Another task overwrote the row after this run stored it: kept.
        feed(newer, () => {
          stacks.harnessStacks.setLimitState(a, { ...signal, message: "newer overwrite" } as never, Date.now() + 5);
        });
        expect(await orch.startTask(newer.id)).toHaveProperty("runId");
        await waitFor(() => db.tasks.get(newer.id)?.column === "review", 10_000);
        afterNewer = stacks.harnessStacks.getLimitState(a);
      });
    } finally {
      orch.__setChunkHandlerTapForTest(null);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(sawOwn).toBe(true);
    expect(afterOwn).toBeNull();
    expect(afterNewer).not.toBeNull();
    expect(afterNewer!.message).toBe("newer overwrite");
    stacks.harnessStacks.delete(stack.id);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// SC8 (D6): exactly one history row per move and per blocked outcome
// ---------------------------------------------------------------------------

describe("swap history: one row per move, per trigger", () => {
  test("limit: one row with the limit's reason, source and both account ids", async () => {
    const a = alias("h-limit-a");
    const b = alias("h-limit-b");
    const stack = stacks.harnessStacks.create({ label: "h-limit", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 2));
    const rows = histRows(stack.id, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "limit", fromHarnessId: a, toHarnessId: b, continuation: "transferred" });
    expect(rows[0]!.reason).not.toBeNull();
    expect(rows[0]!.source).not.toBeNull();
    const runIds = sortedRuns(task.id).map((r) => r.id);
    expect(rows[0]!.fromRunId).toBe(runIds[0] ?? null);
    expect(rows[0]!.toRunId).toBe(runIds[1] ?? null);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("clean limit: the row says the request was restarted, not transferred", async () => {
    const a = alias("h-clean-a");
    const b = alias("h-clean-b");
    const stack = stacks.harnessStacks.create({ label: "h-clean", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `ask ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 2));
    const rows = histRows(stack.id, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "limit", continuation: "restarted" });
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("retry to another account and a same-account retry each write one `retry` row", async () => {
    const a = alias("h-retry-a");
    const b = alias("h-retry-b");
    const stack = stacks.harnessStacks.create({ label: "h-retry", kind: "claude-code", members: [a, b] });
    // (1) A still cools, so the retry moves the task to B.
    stacks.harnessStacks.setLimitState(a, { reason: "quota", resetAtMs: Date.now() + 600_000, message: "x", source: "claude-pane" });
    const toB = makeTask(a, "plain retry work", { column: "blocked" });
    const lastB = insertRun(toB.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(toB.id, { runId: lastB });
    const at = Date.now();
    db.tasks.setHarnessState(toB.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 0, nextAttemptAt: at }),
    });
    failover.armAutoRetry(toB.id, at);
    await waitFor(settledRuns(toB.id, 2), 10_000);
    const rowsB = histRows(stack.id, toB.id);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ trigger: "retry", fromHarnessId: a, toHarnessId: b });
    // (2) The reset passed: the retry resumes on the SAME account, still one row.
    stacks.harnessStacks.clearLimitState(a);
    const same = makeTask(a, "plain retry work", { column: "blocked" });
    const lastSame = insertRun(same.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(same.id, { runId: lastSame });
    db.tasks.setHarnessState(same.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 0, nextAttemptAt: at }),
    });
    failover.armAutoRetry(same.id, at);
    await waitFor(settledRuns(same.id, 2), 10_000);
    const rowsSame = histRows(stack.id, same.id);
    expect(rowsSame).toHaveLength(1);
    expect(rowsSame[0]).toMatchObject({ trigger: "retry", fromHarnessId: a, toHarnessId: a });
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);

  test("manual move from the picker: one `manual` row", async () => {
    const a = alias("h-manual-a");
    const b = alias("h-manual-b");
    const stack = stacks.harnessStacks.create({ label: "h-manual", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "manual switch");
    const before = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: b });
    await orch.reconcileTaskSession(task.id, before, db.tasks.get(task.id)!);
    const rows = histRows(stack.id, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "manual", reason: "user", fromHarnessId: a, toHarnessId: b });
    stacks.harnessStacks.delete(stack.id);
  });

  test("unavailable at Run: a disabled account moves on start with one `unavailable` row", async () => {
    const a = alias("h-unavail-a");
    const b = alias("h-unavail-b");
    const stack = stacks.harnessStacks.create({ label: "h-unavail", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work");
    db.harnesses.setEnabled(a, false);
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 1));
    } finally {
      db.harnesses.setEnabled(a, true);
    }
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    const rows = histRows(stack.id, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "unavailable", fromHarnessId: a, toHarnessId: b });
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("blocked with the limit's reason: all accounts exhausted writes one `blocked` row, not two", async () => {
    const a = alias("h-blocked-a");
    const b = alias("h-blocked-b");
    const stack = stacks.harnessStacks.create({ label: "h-blocked", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 3_600_000, message: "x", source: "claude-pane" });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      failover.cancelAutoRetry(task.id);
    }
    const rows = histRows(stack.id, task.id);
    expect(rows.map((r) => r.trigger)).toEqual(["blocked"]);
    // The limit's own reason and source, not the generic no-usable-member.
    expect(rows[0]!.reason).toBe("quota");
    expect(rows[0]!.source).not.toBeNull();
    expect(rows[0]!.toHarnessId).toBeNull();
    for (const id of [a, b]) stacks.harnessStacks.clearLimitState(id);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a Stop during the settlement window writes no row at all", async () => {
    const a = alias("h-stop-a");
    const b = alias("h-stop-b");
    const stack = stacks.harnessStacks.create({ label: "h-stop", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      await orch.cancelRun(runId);
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.tasks.get(task.id)?.column === "ready");
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    expect(histRows(stack.id, task.id)).toHaveLength(0);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 22a/22b and the cooldown clear (D13, Phase 5 decisions)
// ---------------------------------------------------------------------------

describe("a 1-member stack is inert at Run (22a)", () => {
  test("Run takes the normal pre-flight and clears a stale retry and its timer", async () => {
    const a = alias("inert-a");
    const b = alias("inert-b");
    const stack = stacks.harnessStacks.create({ label: "inert", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "plain work", { column: "blocked" });
    const at = Date.now() + 3_600_000;
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(Date.now(), { attempts: 1, nextAttemptAt: at, earliestResetAtMs: at }),
    });
    failover.armAutoRetry(task.id, at);
    expect(failover.hasArmedAutoRetry(task.id)).toBe(true);
    // Cut to one account: the stack is now a lone account in effect.
    stacks.harnessStacks.update(stack.id, { members: [a] });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 1));
    } finally {
      failover.cancelAutoRetry(task.id);
    }
    expect(failover.hasArmedAutoRetry(task.id)).toBe(false);
    expect(db.tasks.get(task.id)!.harnessState ?? null).toBeNull();
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    expect(histRows(stack.id, task.id)).toHaveLength(0);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("rearmRetriesAfterCooldownClear: only limit-blocked, waiting tasks; no attempt spent (22b companion)", () => {
  test("skips in-flight, no-usable-member, capped, archived and other-stack tasks; keeps the attempt count", () => {
    const a = alias("rearm2-a");
    const b = alias("rearm2-b");
    const other = alias("rearm2-o1");
    const other2 = alias("rearm2-o2");
    const stack = stacks.harnessStacks.create({ label: "rearm2", kind: "claude-code", members: [a, b] });
    const otherStack = stacks.harnessStacks.create({ label: "rearm2-other", kind: "claude-code", members: [other, other2] });
    const far = Date.now() + 3_600_000;
    const make = (agent: string, st: string, ex: ReturnType<typeof exhausted>, extra: Partial<Task> = {}) => {
      const t = makeTask(agent, "p", { column: "blocked", ...extra });
      const runId = insertRun(t.id, agent, { status: "failed", exitCode: -1 });
      db.tasks.update(t.id, { runId });
      db.tasks.setHarnessState(t.id, { stackId: st, position: 0, count: 2, tried: [agent], pendingSwap: null, lastMove: null, allExhausted: ex });
      return { t, runId };
    };
    const waiting = make(a, stack.id, exhausted(Date.now(), { attempts: 2, nextAttemptAt: far }));
    const inFlight = make(a, stack.id, exhausted(Date.now(), { attempts: 1, nextAttemptAt: far, inFlight: true, attemptRunId: "x" }));
    const noMember = make(a, stack.id, exhausted(Date.now(), { reason: "no-usable-member", nextAttemptAt: 0 }));
    const capped = make(a, stack.id, exhausted(Date.now(), { attempts: 3, nextAttemptAt: 0 }));
    const archived = make(a, stack.id, exhausted(Date.now(), { attempts: 0, nextAttemptAt: far }), { archivedAt: Date.now() });
    const elsewhere = make(other, otherStack.id, exhausted(Date.now(), { attempts: 0, nextAttemptAt: far }));

    expect(orch.rearmRetriesAfterCooldownClear(a)).toBe(1);
    const fresh = db.tasks.get(waiting.t.id)!.harnessState!.allExhausted!;
    expect(fresh.nextAttemptAt).toBeLessThan(far);
    // Re-arming is not a retry: the attempt count is untouched.
    expect(fresh.attempts).toBe(2);
    expect(fresh.memberReasons?.length).toBeGreaterThan(0);
    for (const untouched of [inFlight, noMember, capped, archived]) {
      const ex = db.tasks.get(untouched.t.id)!.harnessState!.allExhausted!;
      expect(ex.nextAttemptAt === far || ex.nextAttemptAt === 0).toBe(true);
      expect(statusLines(untouched.runId).some((l) => l.startsWith("cooldown cleared"))).toBe(false);
    }
    expect(db.tasks.get(elsewhere.t.id)!.harnessState!.allExhausted!.nextAttemptAt).toBe(far);
    expect(failover.hasArmedAutoRetry(waiting.t.id)).toBe(true);
    expect(failover.hasArmedAutoRetry(inFlight.t.id)).toBe(false);
    for (const t of [waiting, inFlight, noMember, capped, archived, elsewhere]) failover.cancelAutoRetry(t.t.id);
    stacks.harnessStacks.delete(stack.id);
    stacks.harnessStacks.delete(otherStack.id);
  });
});

describe("cancelHarnessRetryForTask with a live in-flight retry (22b)", () => {
  test("clears the loop marker only: no status line, no stash, the live successor keeps its follow-ups", async () => {
    const a = alias("cancel-live-a");
    const b = alias("cancel-live-b");
    const stack = stacks.harnessStacks.create({ label: "cancel-live", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "a long plain turn");
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "800" }, async () => {
        const started = await orch.startTask(task.id);
        const runId = (started as { runId: string }).runId;
        // The first run stands in for a retry's live successor.
        db.runs.appendEvent(runId, "user", "a follow-up the successor carries");
        db.tasks.setHarnessState(task.id, {
          stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
          allExhausted: exhausted(Date.now(), { attempts: 1, nextAttemptAt: Date.now(), inFlight: true, attemptRunId: runId, cleanRetryOf: runId }),
        });
        expect(orch.cancelHarnessRetryForTask(task.id, "automatic account retry cancelled")).toBe(true);
        expect(db.tasks.get(task.id)!.harnessState?.allExhausted ?? null).toBeNull();
        expect(statusLines(runId).some((l) => l.includes("automatic account retry cancelled"))).toBe(false);
        expect(backlogTexts(task.id)).toEqual([]);
        await waitFor(settledRuns(task.id, 1), 10_000);
      });
    } finally {
      failover.cancelAutoRetry(task.id);
    }
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("an armed (not running) retry does get the line, once", () => {
    const a = alias("cancel-armed-a");
    const b = alias("cancel-armed-b");
    const stack = stacks.harnessStacks.create({ label: "cancel-armed", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p", { column: "blocked" });
    const runId = insertRun(task.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(task.id, { runId });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(Date.now(), { nextAttemptAt: Date.now() + 3_600_000 }),
    });
    expect(orch.cancelHarnessRetryForTask(task.id, "automatic account retry cancelled")).toBe(true);
    expect(statusLines(runId).filter((l) => l === "automatic account retry cancelled")).toHaveLength(1);
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  });
});
