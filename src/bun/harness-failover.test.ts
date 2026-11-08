// Failover engine decisions (T08): the lap/wrap planner and all-exhausted
// persistence/cap. Timers are not fired here — the boot/handoff behaviour is
// exercised by the orchestrator suite and the boot reconcile is read-only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-failover-"));

type Db = typeof import("./db.ts");
type Fo = typeof import("./harness-failover.ts");
let dbm: Db;
let fo: Fo;
let stacks: typeof import("./harness-stacks.ts");
let restore: () => void;

beforeAll(async () => {
  dbm = await import("./db.ts");
  fo = await import("./harness-failover.ts");
  stacks = await import("./harness-stacks.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
});

afterAll(() => {
  fo.cancelAutoRetry("__none__");
  restore();
});

let seq = 0;
function account(): string {
  seq++;
  const id = `fo-${seq}`;
  const home = path.join(process.env.AGETOR_DATA_DIR!, "homes", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "{}");
  dbm.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
  return id;
}

function makeTask(agent: string): string {
  const id = randomUUID();
  dbm.tasks.insert({
    id, title: "fo", prompt: "p", agent, workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "sonnet-4.6", effort: "high", speed: "off", maxMode: false,
    opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
    column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
  } as never);
  return id;
}

describe("planNextMember", () => {
  test("walks forward, skips a cooling member, wraps once", () => {
    const a = account();
    const b = account();
    const c = account();
    const stack = stacks.harnessStacks.create({ label: "fo", kind: "claude-code", members: [a, b, c] });
    const task = dbm.tasks.get(makeTask(a))!;
    stacks.harnessStacks.setLimitState(b, {
      reason: "quota", resetAtMs: Date.now() + 60_000, message: "x", source: "claude-pane",
    });
    const plan = fo.planNextMember(task);
    expect(plan.kind).toBe("next");
    if (plan.kind === "next") expect(plan.member.harnessId).toBe(c);
    stacks.harnessStacks.clearLimitState(b);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a non-stack task has no usable member", () => {
    const plan = fo.planNextMember(dbm.tasks.get(makeTask(account()))!);
    expect(plan.kind).toBe("none-usable");
  });

  test("a retry skips a still-cooling current account and resumes the current one after its reset", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "retry-target", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const resetAt = now + 60_000;
    stacks.harnessStacks.setLimitState(a, {
      reason: "quota", resetAtMs: resetAt, message: "x", source: "claude-pane",
    }, now);

    // The reset has not arrived: never target A again; walk to B.
    const cooling = fo.planRetryMember(dbm.tasks.get(taskId)!, { now: now + 1000 });
    expect(cooling.kind).toBe("next");
    if (cooling.kind === "next") expect(cooling.member.harnessId).toBe(b);

    // After the reset, the current account is the preferred retry target so
    // the existing provider session can be resumed in place.
    const reset = fo.planRetryMember(dbm.tasks.get(taskId)!, { now: resetAt + 1 });
    expect(reset.kind).toBe("next");
    if (reset.kind === "next") expect(reset.member.harnessId).toBe(a);

    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  });

  test("two accounts hitting a limit in sequence schedule an all-exhausted retry", () => {
    // Regression: marking both accounts tried used to yield none-usable with
    // no reset time, so planExhausted armed no timer and the task blocked
    // permanently instead of showing the promised countdown.
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "two-limit", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();

    fo.recordTried(taskId, a);
    stacks.harnessStacks.setLimitState(a, {
      reason: "quota", resetAtMs: now + 60_000, message: "x", source: "claude-pane",
    }, now);
    const first = fo.planNextMember(dbm.tasks.get(taskId)!, { now });
    expect(first.kind).toBe("next");
    if (first.kind === "next") expect(first.member.harnessId).toBe(b);

    fo.recordTried(taskId, b);
    stacks.harnessStacks.setLimitState(b, {
      reason: "quota", resetAtMs: now + 120_000, message: "x", source: "claude-pane",
    }, now);
    const second = fo.planNextMember(dbm.tasks.get(taskId)!, { now });
    expect(second.kind).toBe("all-exhausted");
    if (second.kind !== "all-exhausted") return;
    expect(second.earliestResetAtMs).toBe(now + 60_000);

    const state = fo.planExhausted(taskId, second, now, { startedThisAttempt: false });
    expect(state?.allExhausted?.attempts).toBe(0);
    expect(state?.allExhausted?.nextAttemptAt).toBeGreaterThan(now);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.clearLimitState(b);
    stacks.harnessStacks.delete(stack.id);
  });
});

describe("cooldown and boot recovery", () => {
  test("a manual prepare resets the lap but keeps the account-global cooldown", async () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "manual-cool", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    stacks.harnessStacks.setLimitState(a, {
      reason: "quota", resetAtMs: now + 60_000, message: "x", source: "claude-pane",
    }, now);

    const result = await fo.prepareTaskHarness(taskId, { manual: true });
    expect(result.ok).toBe(true);
    // Forcing this task through the account must not un-cool it for every
    // other task: only a successful turn or the reset clears it.
    expect(stacks.harnessStacks.isCooling(a, now + 1000)).not.toBeNull();
    expect(dbm.tasks.get(taskId)!.harnessState?.allExhausted ?? null).toBeNull();

    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a forced pre-flight move skips the current account and lands on the backup", async () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "forced-move", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);

    // Both accounts look usable to the cached member check; the start
    // pre-flight is what failed on A (fresh auth / CLI floor is newer than the
    // 15 s status cache). The forced move must not stay on A.
    const result = await fo.prepareTaskHarness(taskId, {
      manual: true,
      forceOffCurrent: true,
      forceReason: "pre-flight failed",
    });
    expect(result).toEqual({ ok: true, moved: { from: a, to: b } });
    expect(dbm.tasks.get(taskId)!.agent).toBe(b);
    expect(dbm.tasks.get(taskId)!.harnessState?.lastMove?.to).toBe(b);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a persisted lapse re-points the failover state at the account's current stack", () => {
    const a = account();
    const b = account();
    const c = account();
    const first = stacks.harnessStacks.create({ label: "first-train", kind: "claude-code", members: [a, b] });
    const second = stacks.harnessStacks.create({ label: "second-train", kind: "claude-code", members: [c] });
    const taskId = makeTask(a);
    dbm.tasks.setHarnessState(taskId, {
      stackId: first.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
    // The user edits A into the second train; the recorded stackId is stale.
    stacks.harnessStacks.update(first.id, { members: [b] });
    stacks.harnessStacks.update(second.id, { members: [c, a] });

    fo.recordTried(taskId, a);
    const state = dbm.tasks.get(taskId)!.harnessState!;
    expect(state.stackId).toBe(second.id);
    expect(state.position).toBe(1);
    expect(state.count).toBe(2);
    expect(state.tried).toEqual([a]);

    stacks.harnessStacks.delete(first.id);
    stacks.harnessStacks.delete(second.id);
  });

  test("failover plans inside the current stack after the account moves trains", () => {
    const a = account();
    const b = account();
    const c = account();
    const first = stacks.harnessStacks.create({ label: "old-train", kind: "claude-code", members: [a, b] });
    const second = stacks.harnessStacks.create({ label: "new-train", kind: "claude-code", members: [c] });
    const taskId = makeTask(a);
    const now = Date.now();
    dbm.tasks.setHarnessState(taskId, {
      stackId: first.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
    stacks.harnessStacks.update(first.id, { members: [b] });
    stacks.harnessStacks.update(second.id, { members: [c, a] });
    stacks.harnessStacks.setLimitState(a, {
      reason: "quota", resetAtMs: now + 60_000, message: "x", source: "claude-pane",
    }, now);

    // A is last in its new train, so the lap wraps to C. Walking the recorded
    // (old) stack would have sent the task to B — a different conversation
    // home — while the UI already showed the new train.
    const plan = fo.planNextMember(dbm.tasks.get(taskId)!, { now, currentId: a });
    expect(plan.kind).toBe("next");
    if (plan.kind === "next") expect(plan.member.harnessId).toBe(c);

    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(first.id);
    stacks.harnessStacks.delete(second.id);
  });

  test("a manual Run moves inside the account's current stack after a membership move", async () => {
    const a = account();
    const b = account();
    const c = account();
    const first = stacks.harnessStacks.create({ label: "manual-old", kind: "claude-code", members: [a, b] });
    const second = stacks.harnessStacks.create({ label: "manual-new", kind: "claude-code", members: [c] });
    const taskId = makeTask(a);
    dbm.tasks.setHarnessState(taskId, {
      stackId: first.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
    stacks.harnessStacks.update(first.id, { members: [b] });
    stacks.harnessStacks.update(second.id, { members: [c, a] });
    // A can no longer serve the turn, so the next manual Run must move — but
    // to C in the account's CURRENT train, never to B in the train it left.
    dbm.harnesses.setEnabled(a, false);

    const result = await fo.prepareTaskHarness(taskId, { manual: true });
    expect(result).toEqual({ ok: true, moved: { from: a, to: c } });
    expect(dbm.tasks.get(taskId)!.agent).toBe(c);
    const state = dbm.tasks.get(taskId)!.harnessState!;
    expect(state.stackId).toBe(second.id);
    expect(state.position).toBe(0);
    expect(state.lastMove).toMatchObject({ from: a, to: c, reason: "member-disabled" });

    stacks.harnessStacks.delete(first.id);
    stacks.harnessStacks.delete(second.id);
  });

  test("boot re-arms a retry interrupted while its spawn was in flight", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "in-flight", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: 0,
        earliestResetAtMs: null,
        reason: "quota",
        inFlight: true,
      },
      lastMove: null,
    });

    const armed = fo.rearmAutoRetries(now);
    expect(armed).toBeGreaterThanOrEqual(1);
    const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
    expect(state.inFlight ?? false).toBe(false);
    expect(state.nextAttemptAt).toBeGreaterThan(now);
    // A crash mid-spawn is not a started retry, so the attempt count is kept.
    expect(state.attempts).toBe(1);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("boot keeps a live retry run in flight so its settle can end the loop", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "in-flight-live", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const retryRunId = randomUUID();
    dbm.runs.insert({
      id: retryRunId,
      taskId,
      agent: b,
      status: "running",
      startedAt: now - 1000,
      endedAt: null,
      exitCode: null,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      origin: "harness-swap",
    } as never);
    dbm.tasks.update(taskId, { runId: retryRunId });
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 1,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: 0,
        earliestResetAtMs: null,
        reason: "quota",
        inFlight: true,
        attemptRunId: retryRunId,
      },
      lastMove: null,
    });

    fo.rearmAutoRetries(now);
    // The reattached retry run still owns the marker: clearing `inFlight`
    // here would disarm `settleHarnessStateAndFollowUps`'s non-limit-failure
    // guard and leave the UI on "Retrying…" forever.
    const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
    expect(state.inFlight ?? false).toBe(true);
    expect(state.nextAttemptAt).toBe(0);
    expect(state.attempts).toBe(1);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("boot ends the loop when the retry run settled for a non-limit reason", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "settled-retry", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const retryRunId = randomUUID();
    dbm.runs.insert({
      id: retryRunId,
      taskId,
      agent: b,
      status: "failed",
      startedAt: now - 1000,
      endedAt: now - 500,
      exitCode: 1,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      origin: "harness-swap",
    } as never);
    dbm.tasks.update(taskId, { runId: retryRunId });
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 1,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: 0,
        earliestResetAtMs: null,
        reason: "quota",
        inFlight: true,
        attemptRunId: retryRunId,
      },
      lastMove: null,
    });

    fo.rearmAutoRetries(now);
    // A terminal non-limit failure is the retry's real outcome: re-arming
    // would loop on the same error forever.
    expect(dbm.tasks.get(taskId)!.harnessState!.allExhausted).toBeNull();
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("boot re-arms when the recorded retry run was orphaned by the crash", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "orphan-retry", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const retryRunId = randomUUID();
    dbm.runs.insert({
      id: retryRunId,
      taskId,
      agent: b,
      status: "orphaned",
      startedAt: now - 1000,
      endedAt: now,
      exitCode: -1,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      origin: "harness-swap",
    } as never);
    dbm.tasks.update(taskId, { runId: retryRunId });
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 1,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: 0,
        earliestResetAtMs: null,
        reason: "quota",
        inFlight: true,
        attemptRunId: retryRunId,
      },
      lastMove: null,
    });

    fo.rearmAutoRetries(now);
    const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
    expect(state.inFlight ?? false).toBe(false);
    expect(state.nextAttemptAt).toBeGreaterThan(now);
    expect(state.attempts).toBe(1);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("boot does not re-arm a capped in-flight retry", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "in-flight-cap", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 3,
        max: 3,
        nextAttemptAt: 0,
        earliestResetAtMs: null,
        reason: "quota",
        inFlight: true,
      },
      lastMove: null,
    });
    fo.rearmAutoRetries(now);
    const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
    expect(state.inFlight ?? false).toBe(false);
    expect(state.nextAttemptAt).toBe(0);
    stacks.harnessStacks.delete(stack.id);
  });
  test("a manual move with a recorded but missing transcript refuses instead of starting fresh", async () => {
    const a = account();
    const b = account();
    // A is disabled so the manual prepare really has to move. Build the stack
    // AFTER disabling so the member snapshot carries enabled: false.
    dbm.harnesses.setEnabled(a, false);
    const stack = stacks.harnessStacks.create({ label: "missing-transcript", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const runId = randomUUID();
    dbm.runs.insert({
      id: runId,
      taskId,
      agent: a,
      status: "succeeded",
      startedAt: now - 1000,
      endedAt: now - 500,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: `missing-${taskId}`,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
      origin: "user",
    } as never);
    dbm.tasks.update(taskId, { runId });

    // The DB records a conversation for A but the transcript file is gone.
    // The automatic swap blocks in that case; the manual path must too —
    // silently starting fresh here would lose the conversation.
    const result = await fo.prepareTaskHarness(taskId, { manual: true });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("could not move the conversation");
    expect(dbm.tasks.get(taskId)!.agent).toBe(a);

    stacks.harnessStacks.delete(stack.id);
  });

  test("boot clamps a missed retry instant to now and persists it so the armed timer matches", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "missed-retry", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now - 120_000,
        attempts: 1,
        max: 3,
        // The core was asleep when this was due. Clamping only in memory would
        // leave the persisted instant stale and the timer's identity check
        // would reject its own fire.
        nextAttemptAt: now - 60_000,
        earliestResetAtMs: null,
        reason: "quota",
      },
      lastMove: null,
    });
    const prev = fo.setHarnessFailoverHooks({ onAutoRetry: async () => {}, onReconcileSwap: async () => {} });
    try {
      const armed = fo.rearmAutoRetries(now);
      expect(armed).toBeGreaterThanOrEqual(1);
      const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
      expect(state.nextAttemptAt).toBe(now);
      // A crash/pause is not a started retry.
      expect(state.attempts).toBe(1);
    } finally {
      fo.cancelAutoRetry(taskId);
      fo.setHarnessFailoverHooks(prev);
      stacks.harnessStacks.delete(stack.id);
    }
  });

  test("boot leaves a capped or timer-less retry untouched", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "retry-guards", kind: "claude-code", members: [a, b] });
    const now = Date.now();
    const capped = makeTask(a);
    const unscheduled = makeTask(a);
    const base = { stackId: stack.id, position: 0, count: 2, tried: [], pendingSwap: null, lastMove: null };
    dbm.tasks.setHarnessState(capped, {
      ...base,
      allExhausted: { at: now, attempts: 3, max: 3, nextAttemptAt: now + 60_000, earliestResetAtMs: null, reason: "quota" },
    });
    dbm.tasks.setHarnessState(unscheduled, {
      ...base,
      allExhausted: { at: now, attempts: 0, max: 3, nextAttemptAt: 0, earliestResetAtMs: null, reason: "no-usable-member" },
    });
    const prev = fo.setHarnessFailoverHooks({ onAutoRetry: async () => {}, onReconcileSwap: async () => {} });
    try {
      fo.rearmAutoRetries(now);
      // The cap is terminal until a manual run; a zero instant is "no timer",
      // not "due now". Re-arming either would loop the task or wake it forever.
      expect(dbm.tasks.get(capped)!.harnessState!.allExhausted).toMatchObject({ attempts: 3, nextAttemptAt: now + 60_000 });
      expect(dbm.tasks.get(unscheduled)!.harnessState!.allExhausted).toMatchObject({ attempts: 0, nextAttemptAt: 0 });
    } finally {
      fo.cancelAutoRetry(capped);
      fo.cancelAutoRetry(unscheduled);
      fo.setHarnessFailoverHooks(prev);
      stacks.harnessStacks.delete(stack.id);
    }
  });

  test("boot reconciles every pending swap and one failure cannot stop the rest", async () => {
    const a = account();
    const b = account();
    const first = makeTask(a);
    const second = makeTask(a);
    const pending = { from: a, to: b, reason: "quota" as const, runId: randomUUID(), startedAt: Date.now() };
    for (const id of [first, second]) {
      dbm.tasks.setHarnessState(id, {
        stackId: "boot-reconcile",
        position: 0,
        count: 2,
        tried: [],
        pendingSwap: pending,
        allExhausted: null,
        lastMove: null,
      });
    }
    const called: string[] = [];
    const prev = fo.setHarnessFailoverHooks({
      onAutoRetry: async () => {},
      onReconcileSwap: async (taskId) => {
        called.push(taskId);
        if (taskId === first) throw new Error("synthetic reconcile failure");
      },
    });
    try {
      const reconciled = await fo.reconcilePendingSwaps();
      expect(reconciled).toBeGreaterThanOrEqual(2);
      expect(called).toContain(first);
      // A crashed/failed completion must not strand the other task's intent:
      // each task's reconcile is independent.
      expect(called).toContain(second);
    } finally {
      fo.setHarnessFailoverHooks(prev);
      for (const id of [first, second]) dbm.tasks.setHarnessState(id, null);
    }
  });
});

describe("planExhausted", () => {
  test("persists the schedule and increments the attempt", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "fo-ex", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    const state = fo.planExhausted(
      taskId,
      { kind: "all-exhausted", earliestResetAtMs: now + 120_000, skipped: [] },
      now,
    );
    expect(state?.allExhausted?.attempts).toBe(1);
    expect(state?.allExhausted?.nextAttemptAt).toBeGreaterThanOrEqual(now + 10_000);
    expect(state?.allExhausted?.max).toBe(3);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("the cap stops the schedule without incrementing forever", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "fo-cap", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      fo.planExhausted(taskId, { kind: "all-exhausted", earliestResetAtMs: now + 60_000, skipped: [] }, now);
    }
    const capped = fo.planExhausted(
      taskId,
      { kind: "all-exhausted", earliestResetAtMs: now + 60_000, skipped: [] },
      now,
      { startedThisAttempt: false },
    );
    expect(capped?.allExhausted?.attempts).toBe(3);
    expect(capped?.allExhausted?.nextAttemptAt).toBe(0);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a none-usable member with no reset schedules nothing", () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "fo-none", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    const state = fo.planExhausted(
      taskId,
      { kind: "none-usable", reasons: [{ harnessId: b, reason: "disabled" }], earliestResetAtMs: null, skipped: [] },
    );
    expect(state?.allExhausted?.reason).toBe("no-usable-member");
    expect(state?.allExhausted?.nextAttemptAt).toBe(0);
    fo.cancelAutoRetry(taskId);
    stacks.harnessStacks.delete(stack.id);
  });
});

describe("auto-retry timer claim", () => {
  /** Persist an exhausted schedule that fires at `at` (the two-arg shape the
   *  real settlement/retry write). */
  function schedule(taskId: string, at: number): void {
    const state = dbm.tasks.get(taskId)!.harnessState!;
    dbm.tasks.setHarnessState(taskId, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt: at, inFlight: false },
    });
  }

  test("a timer firing while another start holds the claim re-arms instead of being consumed (R17-S3)", async () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "fo-defer", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    fo.planExhausted(
      taskId,
      { kind: "all-exhausted", earliestResetAtMs: Date.now() + 60_000, skipped: [] },
      Date.now(),
      { startedThisAttempt: false },
    );
    const firedAt = Date.now();
    schedule(taskId, firedAt);
    let fired = 0;
    const prev = fo.setHarnessFailoverHooks({
      onAutoRetry: async () => { fired++; },
      onReconcileSwap: async () => {},
      canAutoRetry: () => false,
    });
    try {
      fo.armAutoRetry(taskId, firedAt);
      await Bun.sleep(60);
      const state = dbm.tasks.get(taskId)!.harnessState!.allExhausted!;
      // The claim holder won; the timer must not have started a second turn…
      expect(fired).toBe(0);
      // …and must not have vanished: a persisted countdown with no timer
      // would never wake the task again if that start's prepare failed.
      expect(state.nextAttemptAt).toBeGreaterThan(firedAt);
      expect(state.attempts).toBe(0);
    } finally {
      fo.setHarnessFailoverHooks(prev);
      fo.cancelAutoRetry(taskId);
      stacks.harnessStacks.delete(stack.id);
    }
  });

  test("a timer fires once the claim is free", async () => {
    const a = account();
    const b = account();
    const stack = stacks.harnessStacks.create({ label: "fo-fire", kind: "claude-code", members: [a, b] });
    const taskId = makeTask(a);
    fo.planExhausted(
      taskId,
      { kind: "all-exhausted", earliestResetAtMs: Date.now() + 60_000, skipped: [] },
      Date.now(),
      { startedThisAttempt: false },
    );
    const firedAt = Date.now();
    schedule(taskId, firedAt);
    let fired = 0;
    const prev = fo.setHarnessFailoverHooks({
      onAutoRetry: async () => { fired++; },
      onReconcileSwap: async () => {},
      canAutoRetry: () => true,
    });
    try {
      fo.armAutoRetry(taskId, firedAt);
      await Bun.sleep(60);
      expect(fired).toBe(1);
    } finally {
      fo.setHarnessFailoverHooks(prev);
      fo.cancelAutoRetry(taskId);
      stacks.harnessStacks.delete(stack.id);
    }
  });
});
