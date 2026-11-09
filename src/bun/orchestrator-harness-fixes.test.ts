// Harness-stack fix round (review M1, M3, M5, M6, M8, S1, S7, S8, S16, S27,
// Q4): the orchestrator side of the failover engine, driven through the fake
// Claude driver. Nothing here touches a real CLI or the user's accounts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskHarnessState } from "../shared/types.ts";

// Literal copies: a static src/bun import would load db.ts before the data
// dir below is set (the suite runs every file in one process).
const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
const FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER = "__agetor_fake_claude_limit_clean__";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harness-fixes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-harness-fixes-bin-"));
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
let claude: typeof import("./claude-tmux.ts");
let shared: typeof import("../shared/harness-stack.ts");
let restore: () => void;
let seq = 0;
const taskIds: string[] = [];

beforeAll(async () => {
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  claude = await import("./claude-tmux.ts");
  shared = await import("../shared/harness-stack.ts");
});

afterAll(async () => {
  for (const id of taskIds) {
    const state = db.tasks.get(id)?.harnessState;
    if (state) db.tasks.setHarnessState(id, { ...state, allExhausted: null, pendingSwap: null });
  }
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

function home(label: string): string {
  const dir = path.join(DATA_DIR, "harnesses", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".credentials.json"), "{}");
  return dir;
}

function alias(id: string): string {
  const h = home(id);
  if (!db.harnesses.get(id)) db.harnesses.insert({ id, kind: "claude-code", label: id, home: h, env: {} } as never);
  return h;
}

/** Three fresh account ids (`<prefix>-a-N`, `-b-`, `-c-`); tests use what they need. */
function ids(prefix: string, _n?: number): [string, string, string] {
  seq++;
  return [`${prefix}-a-${seq}`, `${prefix}-b-${seq}`, `${prefix}-c-${seq}`];
}

function makeTask(agent: string, prompt: string, extra: Partial<Task> = {}): Task {
  const id = randomUUID();
  const workdir = path.join(DATA_DIR, "work", `${++seq}`);
  mkdirSync(workdir, { recursive: true });
  db.tasks.insert({
    id, title: "fix", prompt, agent, workdir, isolation: "none", taskType: "task",
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

const settledRuns = (taskId: string, n: number) => () => {
  const rows = db.runs.listForTask(taskId);
  return rows.length >= n && rows.every((r) => r.status !== "running");
};
const sortedRuns = (taskId: string) => [...db.runs.listForTask(taskId)].sort((a, b) => a.startedAt - b.startedAt);
const statusLines = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
const transcriptOn = (h: string, task: Task, sid: string) =>
  path.join(h, "projects", claude.encodeProjectPath(task.worktreePath ?? task.workdir), `${sid}.jsonl`);

describe("codex limits (M1)", () => {
  test("a Codex turn that exited 0 is never settled as a limit; Claude keeps its signal", () => {
    const signal = { reason: "rate_limit" as const, resetAtMs: null, message: "429", source: "codex-error" as const };
    expect(orch.limitSignalForSettle("codex", 0, signal)).toBeNull();
    expect(orch.limitSignalForSettle("codex", 1, signal)).toEqual(signal);
    // The Claude drivers resolve a limited turn with code 0 on purpose.
    expect(orch.limitSignalForSettle("claude-code", 0, { ...signal, source: "claude-pane" })).not.toBeNull();
    expect(orch.limitSignalForSettle("codex", 0, null)).toBeNull();
  });
});

describe("agent switches keep copied conversations (M3, S27)", () => {
  test("switching out of the stack and back resumes the backup's transcript; the outside account starts fresh", async () => {
    const [a, b, c] = ids("out", 3);
    alias(a);
    const homeB = alias(b);
    alias(c);
    const stack = stacks.harnessStacks.create({ label: "out", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `swap ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 2));
    const sid = `fake-swap-${task.id}`;
    const copied = transcriptOn(homeB, task, sid);
    expect(existsSync(copied)).toBe(true);
    expect(db.tasks.get(task.id)!.agent).toBe(b);

    // B → C (outside every stack): the old reset behaviour, minus deleting
    // the live conversation the successor resumed on B.
    const before = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: c });
    await orch.reconcileTaskSession(task.id, before, db.tasks.get(task.id)!);
    expect(existsSync(copied)).toBe(true);
    expect(db.harnessSessionHandoffs.get(task.id, b, "claude_session_id")?.sessionId).toBe(sid);
    // No manual-switch note and no failover state: an outside switch resets.
    expect(db.tasks.get(task.id)!.harnessState ?? null).toBeNull();
    // C has nothing to resume: its first turn starts fresh.
    expect(orch.findLastSessionIdForHarness(task.id, "claude_session_id", c)).toBeNull();

    // C → B: the task resumes the transcript B still holds.
    const back = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: b });
    await orch.reconcileTaskSession(task.id, back, db.tasks.get(task.id)!);
    expect(orch.findLastSessionIdForHarness(task.id, "claude_session_id", b)).toBe(sid);
    expect(existsSync(copied)).toBe(true);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a failed same-stack transfer never touches the source account's files", async () => {
    const [a, b] = ids("failsame", 2);
    const homeA = alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "failsame", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p");
    // A holds a conversation an earlier swap copied onto it (a handoff file).
    const oldSid = `old-${task.id}`;
    const handoffFile = transcriptOn(homeA, task, oldSid);
    mkdirSync(path.dirname(handoffFile), { recursive: true });
    writeFileSync(handoffFile, "{}\n");
    db.harnessSessionHandoffs.upsert({
      taskId: task.id, harnessId: a, columnName: "claude_session_id", sessionId: oldSid,
      copiedPaths: [handoffFile], createdAt: Date.now() - 60_000,
    });
    // A newer turn on A recorded a session whose transcript is gone, so the
    // same-stack transfer to B fails.
    const runId = insertRun(task.id, a, { claudeSessionId: `missing-${task.id}` });
    db.tasks.update(task.id, { runId, column: "review" });

    const before = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: b });
    await orch.reconcileTaskSession(task.id, before, db.tasks.get(task.id)!);

    expect(statusLines(runId).some((l) => l.includes("could not move the conversation"))).toBe(true);
    expect(existsSync(handoffFile)).toBe(true);
    expect(db.harnessSessionHandoffs.get(task.id, a, "claude_session_id")).not.toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("an armed retry respects the user (M5)", () => {
  test("the timer bails and clears the countdown when the card is no longer blocked", async () => {
    const [a, b] = ids("bail", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "bail", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p", { column: "review" });
    const at = Date.now() + 30;
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at),
    });
    failover.armAutoRetry(task.id, at);
    await waitFor(() => db.tasks.get(task.id)!.harnessState?.allExhausted == null && !failover.hasArmedAutoRetry(task.id), 4000);
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted ?? null).toBeNull();
    expect(failover.hasArmedAutoRetry(task.id)).toBe(false);
    // Never pulled back to running: no run was minted.
    expect(db.runs.listForTask(task.id)).toHaveLength(0);
    expect(db.tasks.get(task.id)!.column).toBe("review");
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("Stop on a blocked card cancels its armed retry", async () => {
    const [a, b] = ids("stopretry", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "stopretry", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p");
    const runId = insertRun(task.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(task.id, { runId, column: "blocked" });
    const at = Date.now() + 60_000;
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at),
    });
    failover.armAutoRetry(task.id, at);
    expect(await orch.cancelRun(runId)).toBe(true);
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted ?? null).toBeNull();
    expect(failover.hasArmedAutoRetry(task.id)).toBe(false);
    expect(orch.hasPendingHarnessRetry(task.id)).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("boot puts a re-armed retry's orphan-flipped card back in blocked", async () => {
    const [a, b] = ids("bootcol", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "bootcol", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p", { column: "ready" });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(Date.now(), { nextAttemptAt: Date.now() + 600_000 }),
    });
    try {
      await orch.reconcileHarnessFailover({ includeSwaps: false });
      expect(db.tasks.get(task.id)!.column).toBe("blocked");
      expect(failover.hasArmedAutoRetry(task.id)).toBe(true);
    } finally {
      failover.cancelAutoRetry(task.id);
      db.tasks.setHarnessState(task.id, null);
      stacks.harnessStacks.delete(stack.id);
    }
  }, 15_000);
});

describe("held follow-ups and the launch freeze (M6, S7)", () => {
  test("a block with a retry timer stashes messages typed during the swap right away", async () => {
    const [a, b] = ids("stash", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "stash", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 120_000, message: "x", source: "claude-pane" });
    const task = makeTask(a, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect((await orch.sendInput(runId, "typed during the swap")).delivered).toBe(true);
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      stacks.harnessStacks.clearLimitState(b);
    }
    const after = db.tasks.get(task.id)!;
    expect(after.harnessState?.allExhausted?.nextAttemptAt).toBeGreaterThan(Date.now());
    // The timer is hours away at worst: the message is in the tray now.
    expect(after.backlog.map((i) => i.text)).toContain("typed during the swap");
    failover.cancelAutoRetry(task.id);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a freeze mid-swap stashes held messages, stops retry timers and leaves the swap for the next owner, which finishes it", async () => {
    const [a, b] = ids("freeze", 2);
    alias(a);
    const homeB = alias(b);
    const stack = stacks.harnessStacks.create({ label: "freeze", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    // An unrelated armed retry: the freeze must stop it too.
    const other = makeTask(a, "other", { column: "blocked" });
    const otherAt = Date.now() + 600_000;
    db.tasks.setHarnessState(other.id, {
      stackId: stack.id, position: 0, count: 2, tried: [], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(otherAt, { nextAttemptAt: otherAt }),
    });
    failover.armAutoRetry(other.id, otherAt);

    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect((await orch.sendInput(runId, "held before the handoff")).delivered).toBe(true);
      orch.freezeLaunches();
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length === 1 && rows[0]!.status === "failed" && db.tasks.get(task.id)!.harnessState?.pendingSwap != null;
      });
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    let resumed: ReturnType<typeof sortedRuns> = [];
    try {
      const frozen = db.tasks.get(task.id)!;
      expect(frozen.backlog.map((i) => i.text)).toContain("held before the handoff");
      expect(failover.hasArmedAutoRetry(other.id)).toBe(false);
      expect(db.runs.listForTask(task.id)).toHaveLength(1);
      expect(frozen.agent).toBe(a);
      expect(frozen.column).toBe("running");
      expect(frozen.harnessState?.pendingSwap?.to).toBe(b);
    } finally {
      orch.__resetLaunchFreezeForTest();
      db.tasks.setHarnessState(other.id, null);
    }

    // The next owner's boot: no successor was ever minted, so the swap is
    // re-run (S7) instead of blocking the card.
    await orch.reconcileHarnessFailover();
    await waitFor(settledRuns(task.id, 2));
    resumed = sortedRuns(task.id);
    expect(resumed).toHaveLength(2);
    expect(resumed[1]!.agent).toBe(b);
    expect(resumed[1]!.origin).toBe("harness-swap");
    expect(resumed[1]!.claudeSessionId).toBe(`fake-swap-${task.id}`);
    expect(existsSync(transcriptOn(homeB, task, `fake-swap-${task.id}`))).toBe(true);
    const done = db.tasks.get(task.id)!;
    expect(done.harnessState?.pendingSwap ?? null).toBeNull();
    expect(done.column).toBe("review");
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);

  test("boot still blocks a pending swap whose successor is unaccounted for", async () => {
    const [a, b] = ids("bootblock", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "bootblock", kind: "claude-code", members: [a, b] });
    const task = makeTask(b, "p", { column: "running" });
    const oldRunId = insertRun(task.id, a, { status: "failed" });
    // A successor row the restart left `running` with no live handle.
    const successor = insertRun(task.id, b, { status: "running", endedAt: null, exitCode: null, origin: "harness-swap" });
    db.tasks.update(task.id, { runId: successor });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 1, count: 2, tried: [a], allExhausted: null, lastMove: null,
      pendingSwap: { from: a, to: b, reason: "quota", runId: oldRunId, startedAt: Date.now() - 1000 },
    });
    try {
      await orch.reconcileHarnessFailover();
      const after = db.tasks.get(task.id)!;
      expect(after.harnessState?.pendingSwap ?? null).toBeNull();
      expect(after.column).toBe("blocked");
      expect(statusLines(oldRunId).some((l) => l.includes("restarted during the account switch"))).toBe(true);
      // No second successor was minted next to the unknown one.
      expect(db.runs.listForTask(task.id)).toHaveLength(2);
    } finally {
      db.runs.update(successor, { status: "failed", endedAt: Date.now(), exitCode: -1 });
      stacks.harnessStacks.delete(stack.id);
    }
  }, 15_000);
});

describe("the retry loop (M8, S27)", () => {
  test("a retry attempt that moves to the next member keeps its attempt count", async () => {
    const [a, b] = ids("carry", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "carry", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `retry ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`, { column: "blocked" });
    const at = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 1, nextAttemptAt: at }),
    });
    const seen: Array<{ agent: string; ex: TaskHarnessState["allExhausted"] }> = [];
    const prev = orch.__setHarnessSwapPromptHookForTest((hooked) => {
      if (hooked !== task.id) return;
      const t = db.tasks.get(task.id)!;
      seen.push({ agent: t.agent, ex: t.harnessState?.allExhausted ?? null });
    });
    try {
      failover.armAutoRetry(task.id, at);
      await waitFor(settledRuns(task.id, 2), 10_000);
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prev);
    }
    // 1: the retry on A (its reset passed). 2: A limited again, the
    // successor moved to B — with the retry's attempt count, not a fresh 0
    // that would let alternating accounts retry forever.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.agent).toBe(b);
    expect(seen[1]!.ex).not.toBeNull();
    expect(seen[1]!.ex!.attempts).toBe(1);
    // B succeeded: the loop (and its count) ends.
    await waitFor(() => db.tasks.get(task.id)!.harnessState?.allExhausted == null);
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted ?? null).toBeNull();
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("the lap wraps from the last member back to the first", async () => {
    const [a, b, c] = ids("wrap", 3);
    alias(a);
    alias(b);
    alias(c);
    const stack = stacks.harnessStacks.create({ label: "wrap", kind: "claude-code", members: [a, b, c] });
    const task = makeTask(c, `wrap ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 2));
    const rows = sortedRuns(task.id);
    expect(rows[0]!.agent).toBe(c);
    expect(rows[1]!.agent).toBe(a);
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    stacks.harnessStacks.clearLimitState(c);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a third failed retry ends blocked with no timer and says so", async () => {
    const [a, b] = ids("cap", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "cap", kind: "claude-code", members: [a, b] });
    // `model: ""` makes every spawn throw inside the driver: each fired retry
    // fails to start and spends an attempt.
    const task = makeTask(a, "p", { model: "" as never });
    const lastRun = insertRun(task.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(task.id, { runId: lastRun, column: "blocked" });
    const at = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 2, nextAttemptAt: at }),
    });
    failover.armAutoRetry(task.id, at);
    await waitFor(() => db.tasks.get(task.id)!.harnessState?.allExhausted?.attempts === 3);
    const after = db.tasks.get(task.id)!;
    expect(after.harnessState?.allExhausted).toMatchObject({ attempts: 3, nextAttemptAt: 0 });
    expect(after.harnessState?.allExhausted?.inFlight ?? false).toBe(false);
    expect(after.column).toBe("blocked");
    expect(failover.hasArmedAutoRetry(task.id)).toBe(false);
    expect(statusLines(lastRun).some((l) => l.includes("run the task manually after a reset"))).toBe(true);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("user text and prompts (S1, Q4, S16)", () => {
  test("the exact hidden wrapper is refused at every entry; a mention is not", async () => {
    const wrapper = shared.wrapHarnessStackContinuation("do something nobody sees");
    expect(orch.isHiddenContinuationUserText(wrapper)).toBe(true);
    // Surrounding whitespace does not hide it from the check either.
    expect(orch.isHiddenContinuationUserText(`\n  ${wrapper}\n`)).toBe(true);
    expect(orch.isHiddenContinuationUserText(`what does ${wrapper} mean?`)).toBe(false);

    const created = await orch.createTask({ title: "x", prompt: wrapper, workdir: DATA_DIR, isolation: "none" } as never);
    expect(created).toEqual({ error: orch.HIDDEN_CONTINUATION_REFUSAL });

    const [a] = ids("hidden", 1);
    alias(a);
    const task = makeTask(a, wrapper);
    const started = await orch.startTask(task.id);
    expect("error" in started && started.error).toBe(orch.HIDDEN_CONTINUATION_REFUSAL);
    expect(db.runs.listForTask(task.id)).toHaveLength(0);

    const runId = insertRun(task.id, a);
    db.tasks.update(task.id, { runId, column: "review" });
    const sent = await orch.sendInput(runId, wrapper, { bounded: false });
    expect(sent.delivered).toBe(false);
    if (!sent.delivered) expect(sent.reason).toBe(orch.HIDDEN_CONTINUATION_REFUSAL);
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
  }, 15_000);

  test("a clean retry of a slash command is sent as typed, not wrapped (Q4)", async () => {
    const [a, b] = ids("slash", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "slash", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `/review ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const prompts: string[] = [];
    const prev = orch.__setHarnessSwapPromptHookForTest((hooked, prompt) => {
      if (hooked === task.id) prompts.push(prompt);
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 2));
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prev);
    }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(task.prompt);
    expect(shared.isHarnessStackContinuation(prompts[0]!)).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a mid-turn follow-up that never reached the transcript rides the transfer continuation (S16)", async () => {
    const [a, b] = ids("midturn", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "midturn", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prompts: string[] = [];
    const prevPrompt = orch.__setHarnessSwapPromptHookForTest((hooked, prompt) => {
      if (hooked === task.id) prompts.push(prompt);
    });
    const prevObserved = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      // Claude processed this one: echo + JSONL twin.
      db.runs.appendEvent(runId, "user", "already handled");
      db.runs.appendEvent(runId, "user", "already handled");
      orch.__noteMidTurnFollowUpForTest(runId, "already handled");
      // Still sitting in the REPL's input box: echo only.
      db.runs.appendEvent(runId, "user", "please also update the docs");
      orch.__noteMidTurnFollowUpForTest(runId, "please also update the docs");
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 2));
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prevPrompt);
      orch.__setHarnessLimitObservedHookForTest(prevObserved);
    }
    expect(prompts).toEqual([shared.composeHarnessStackContinuationPrompt(["please also update the docs"])]);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("manual prepare holds the start claim (S8)", () => {
  test("a message's account move copies the transcript while the task is claimed", async () => {
    const [a, b] = ids("claim", 2);
    const homeA = alias(a);
    alias(b);
    db.harnesses.setEnabled(a, false);
    const stack = stacks.harnessStacks.create({ label: "claim", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "first ask");
    const sid = `claim-${task.id}`;
    const transcript = transcriptOn(homeA, task, sid);
    mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "first ask" }] } })}\n`,
      { mode: 0o600 },
    );
    const runId = insertRun(task.id, a, { claudeSessionId: sid });
    db.tasks.update(task.id, { runId, column: "review" });

    const claimedDuringCopy: boolean[] = [];
    const originalUpsert = db.harnessSessionHandoffs.upsert;
    db.harnessSessionHandoffs.upsert = function (this: typeof db.harnessSessionHandoffs, ...args: Parameters<typeof originalUpsert>) {
      if (args[0].taskId === task.id) claimedDuringCopy.push(orch.isTaskRunLive(task.id));
      return originalUpsert.apply(this, args);
    };
    try {
      const sent = await orch.sendInput(runId, "next ask", { bounded: false });
      expect(sent.delivered).toBe(true);
      await waitFor(settledRuns(task.id, 2));
    } finally {
      db.harnessSessionHandoffs.upsert = originalUpsert;
      db.harnesses.setEnabled(a, true);
    }
    // The move really happened, and the claim covered the copy: a retry timer
    // firing then defers instead of minting a competing successor.
    expect(db.tasks.get(task.id)!.agent).toBe(b);
    expect(claimedDuringCopy).toEqual([true]);
    // The claim is released afterwards.
    expect(orch.isTaskRunLive(task.id)).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});
