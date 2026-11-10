// Harness-stack fix round (review M1, M3, M5, M6, M8, S1, S7, S8, S16, S27,
// Q4): the orchestrator side of the failover engine, driven through the fake
// Claude driver. Nothing here touches a real CLI or the user's accounts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HARNESS_LIMIT_STATUS_PREFIX, type Task, type TaskHarnessState } from "../shared/types.ts";

// Literal copies: a static src/bun import would load db.ts before the data
// dir below is set (the suite runs every file in one process).
const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
const FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER = "__agetor_fake_claude_limit_clean__";
const FAKE_CODEX_LIMIT_PROMPT_MARKER = "__agetor_fake_codex_limit__";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harness-fixes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Every key a test here sets (some only inside one test) is restored in
// afterAll: `bun test` runs every file in one process.
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
  orch.__setChunkHandlerTapForTest(null);
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
    // (The copy records its intended paths before copying, then the result:
    // every handoff write happens under the claim.)
    expect(claimedDuringCopy.length).toBeGreaterThan(0);
    expect(claimedDuringCopy.every(Boolean)).toBe(true);
    // The claim is released afterwards.
    expect(orch.isTaskRunLive(task.id)).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Fix round 2 (review R-S12, R-S13, R-S14, R-S16, N1, N2, N3, N5)
// ---------------------------------------------------------------------------

/** Run `fn` with env vars set, restoring each one's previous value after. */
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

/** A Codex account whose `CODEX_HOME` is `<home>/.codex`; returns that root. */
function codexAccount(id: string): string {
  const dir = path.join(DATA_DIR, "harnesses", id);
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "auth.json"), "{}");
  if (!db.harnesses.get(id)) db.harnesses.insert({ id, kind: "codex", label: id, home: dir, env: {} } as never);
  return path.join(dir, ".codex");
}

/** Plant a Codex rollout for `threadId` where codex lays it out. */
function plantRollout(root: string, threadId: string): string {
  const rel = path.join("sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${threadId}.jsonl`);
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(root, rel), `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n`, { mode: 0o600 });
  return rel;
}

const userRows = (runId: string) => db.runs.events(runId).filter((e) => e.stream === "user").map((e) => e.data);
const backlogTexts = (taskId: string) => db.tasks.get(taskId)!.backlog.map((i) => i.text);

describe("unread mid-turn follow-ups are never dropped (R-S12)", () => {
  test("an all-exhausted block puts them in the tray", async () => {
    const [a, b] = ids("midblock", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "midblock", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 120_000, message: "x", source: "claude-pane" });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      // Still sitting in the REPL's input box: echo only, no JSONL twin.
      db.runs.appendEvent(runId, "user", "please also update the docs");
      orch.__noteMidTurnFollowUpForTest(runId, "please also update the docs");
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
      failover.cancelAutoRetry(task.id);
      stacks.harnessStacks.clearLimitState(a);
      stacks.harnessStacks.clearLimitState(b);
    }
    // The limited turn had a tool call: a retry resumes the copied
    // transcript, which never held this message — only the tray does.
    expect(backlogTexts(task.id)).toContain("please also update the docs");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("an all-exhausted clean retry carries them itself, so they are not also stashed", async () => {
    const [a, b] = ids("midclean", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "midclean", kind: "claude-code", members: [a, b] });
    stacks.harnessStacks.setLimitState(b, { reason: "quota", resetAtMs: Date.now() + 120_000, message: "x", source: "claude-pane" });
    const task = makeTask(a, `ask ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", "and the changelog");
      orch.__noteMidTurnFollowUpForTest(runId, "and the changelog");
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
      failover.cancelAutoRetry(task.id);
      stacks.harnessStacks.clearLimitState(a);
      stacks.harnessStacks.clearLimitState(b);
    }
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted?.nextAttemptAt).toBeGreaterThan(0);
    expect(backlogTexts(task.id)).not.toContain("and the changelog");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a failed transfer block puts them in the tray", async () => {
    const [a, b] = ids("midxfer", 2);
    const homeA = alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "midxfer", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", "rename the helper too");
      orch.__noteMidTurnFollowUpForTest(runId, "rename the helper too");
      // The recorded conversation vanished: the transfer must fail.
      rmSync(transcriptOn(homeA, task, `fake-swap-${task.id}`), { force: true });
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
      stacks.harnessStacks.clearLimitState(a);
    }
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(1);
    expect(statusLines(rows[0]!.id).some((l) => l.includes("could not move the conversation"))).toBe(true);
    expect(backlogTexts(task.id)).toContain("rename the helper too");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("unread mid-turn follow-ups on the other settlement endings (R-S12)", () => {
  test("a launch freeze that leaves the swap to the next owner stashes them before exit", async () => {
    const [a, b] = ids("midfreeze", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "midfreeze", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prevObserved = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", "keep the old flag");
      orch.__noteMidTurnFollowUpForTest(runId, "keep the old flag");
    });
    const prevSettle = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      orch.freezeLaunches();
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.tasks.get(task.id)!.harnessState?.pendingSwap != null && db.runs.listForTask(task.id)[0]?.status === "failed");
      // The next owner (another process) has no memory of the REPL's input
      // box: the tray is the only place the text survives.
      expect(backlogTexts(task.id)).toContain("keep the old flag");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prevObserved);
      orch.__setHarnessSwapSettleHookForTest(prevSettle);
      orch.__resetLaunchFreezeForTest();
      db.tasks.setHarnessState(task.id, null);
      stacks.harnessStacks.clearLimitState(a);
    }
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a pane limit on a lone account drops the paused REPL and stashes them", async () => {
    const FAKE_CLAUDE_LIMIT_PANE_PROMPT_MARKER = "__agetor_fake_claude_limit_pane__";
    const [a] = ids("midpane", 1);
    alias(a);
    const task = makeTask(a, `work ${FAKE_CLAUDE_LIMIT_PANE_PROMPT_MARKER}`);
    const prev = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      db.runs.appendEvent(runId, "user", "then run the linter");
      orch.__noteMidTurnFollowUpForTest(runId, "then run the linter");
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 1));
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(db.runs.listForTask(task.id)[0]!.status).toBe("failed");
    expect(backlogTexts(task.id)).toContain("then run the linter");
  }, 20_000);
});

describe("held swap messages reach the live successor (R-S13)", () => {
  test("a message typed during the window lands on the successor while it is still running", async () => {
    const [a, b] = ids("heldlive", 2);
    const rootA = codexAccount(a);
    codexAccount(b);
    const stack = stacks.harnessStacks.create({ label: "heldlive", kind: "codex", members: [a, b] });
    const task = makeTask(a, `quota ${FAKE_CODEX_LIMIT_PROMPT_MARKER}`, { model: "fixture-codex-model" } as Partial<Task>);
    plantRollout(rootA, `fake-codex-thread-${task.id}`);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== task.id || phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect((await orch.sendInput(runId, "typed during the swap")).delivered).toBe(true);
    });
    let seenWhileLive = false;
    try {
      await withEnv(
        { AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "1500" },
        async () => {
          expect(await orch.startTask(task.id)).toHaveProperty("runId");
          await waitFor(() => {
            const successor = sortedRuns(task.id)[1];
            if (!successor) return false;
            if (userRows(successor.id).includes("typed during the swap")) {
              seenWhileLive = db.runs.get(successor.id)?.status === "running";
              return true;
            }
            return successor.status !== "running";
          }, 10_000);
          // Let the successor and the queued turn behind it finish.
          await waitFor(settledRuns(task.id, 3), 10_000);
        },
      );
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      stacks.harnessStacks.clearLimitState(a);
      stacks.harnessStacks.clearLimitState(b);
    }
    // Delivered through the ordinary mid-turn path the moment the successor
    // registered (Codex queues it behind the live turn), not drained after
    // the successor's whole turn settled.
    expect(seenWhileLive).toBe(true);
    const rows = sortedRuns(task.id);
    expect(rows[1]!.agent).toBe(b);
    expect(userRows(rows[1]!.id)).toContain("typed during the swap");
    expect(backlogTexts(task.id)).not.toContain("typed during the swap");
    stacks.harnessStacks.delete(stack.id);
  }, 30_000);
});

describe("a Stop during an all-exhausted retry (R-S14)", () => {
  test("a plain Stop during the retry's move aborts the move itself", async () => {
    const [a, b] = ids("retrystop", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "retrystop", kind: "claude-code", members: [a, b] });
    // A is still cooling, so the retry picks B and has to move the task.
    stacks.harnessStacks.setLimitState(a, { reason: "quota", resetAtMs: Date.now() + 600_000, message: "x", source: "claude-pane" });
    const task = makeTask(a, "p");
    const lastRun = insertRun(task.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(task.id, { runId: lastRun, column: "blocked" });
    const at = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 1, nextAttemptAt: at }),
    });
    let stopped = null as boolean | null;
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "retry-before-commit") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      stopped = await orch.cancelRun(lastRun);
    });
    try {
      failover.armAutoRetry(task.id, at);
      await waitFor(() => stopped !== null && db.tasks.get(task.id)!.harnessState?.allExhausted == null);
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(stopped).toBe(true);
    const after = db.tasks.get(task.id)!;
    // Nothing moved and nothing ran on the stopped retry's behalf.
    expect(after.agent).toBe(a);
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    expect(after.column).toBe("blocked");
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    expect(failover.hasArmedAutoRetry(task.id)).toBe(false);
    expect(statusLines(lastRun).some((l) => l.includes("cancelled by user during the account retry"))).toBe(true);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a Stop the retry never consumed does not cancel a later, unrelated failover", async () => {
    const [a, b] = ids("stalestop", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "stalestop", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `later ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const lastRun = insertRun(task.id, a, { status: "failed", exitCode: -1 });
    db.tasks.update(task.id, { runId: lastRun, column: "blocked" });
    const at = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
      allExhausted: exhausted(at, { attempts: 0, nextAttemptAt: at }),
    });
    // The Stop lands in the retry window, then the retry ends on a path that
    // never reads it (an unexpected throw before its successor exists).
    const prev = orch.__setHarnessSwapSpawnHookForTest(async (hooked) => {
      if (hooked !== task.id) return;
      orch.__setHarnessSwapSpawnHookForTest(null);
      expect(await orch.cancelRun(lastRun)).toBe(true);
      throw new Error("synthetic retry spawn throw");
    });
    try {
      failover.armAutoRetry(task.id, at);
      await waitFor(() => (db.tasks.get(task.id)!.harnessState?.allExhausted?.attempts ?? 0) === 1);
    } finally {
      orch.__setHarnessSwapSpawnHookForTest(prev);
      failover.cancelAutoRetry(task.id);
    }
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    // The user takes the task back and runs it; that run hits a real limit.
    db.tasks.setHarnessState(task.id, null);
    db.tasks.update(task.id, { column: "ready" });
    expect(await orch.startTask(task.id)).toHaveProperty("runId");
    await waitFor(settledRuns(task.id, 3));
    const rows = sortedRuns(task.id);
    // It fails over to B instead of being read as "cancelled by user".
    expect(rows).toHaveLength(3);
    expect(rows[1]!.agent).toBe(a);
    expect(statusLines(rows[1]!.id).some((l) => l.includes("cancelled by user"))).toBe(false);
    expect(rows[2]!.agent).toBe(b);
    expect(rows[2]!.origin).toBe("harness-swap");
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("Codex limit settle and the retry timer at the orchestrator (R-S16)", () => {
  test("a recovered 429 on a turn that completes settles succeeded: no swap, no cooldown", async () => {
    const [a, b] = ids("recovered", 2);
    codexAccount(a);
    codexAccount(b);
    const stack = stacks.harnessStacks.create({ label: "recovered", kind: "codex", members: [a, b] });
    const task = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    // The fake has no "429 then success" scenario: feed the live run's real
    // chunk handler the structured signal the codex driver writes for a
    // top-level `error`, then let the turn complete (exit 0).
    const signal = { reason: "rate_limit", resetAtMs: null, message: "429 Too Many Requests", source: "codex-error" };
    let sawCooldown = false;
    let cooldownAfter: unknown = "unset";
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== task.id) return;
      orch.__setChunkHandlerTapForTest(null);
      setTimeout(() => {
        handler("status", `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify(signal)}`);
        sawCooldown = stacks.harnessStacks.getLimitState(a) !== null;
      }, 150);
    });
    try {
      await withEnv(
        { AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "800" },
        async () => {
          expect(await orch.startTask(task.id)).toHaveProperty("runId");
          await waitFor(() => db.tasks.get(task.id)?.column === "review", 10_000);
          cooldownAfter = stacks.harnessStacks.getLimitState(a);
        },
      );
    } finally {
      orch.__setChunkHandlerTapForTest(prevTap);
      stacks.harnessStacks.clearLimitState(a);
      stacks.harnessStacks.clearLimitState(b);
    }
    // The signal really reached the live run (the chunk handler recorded it)…
    expect(sawCooldown).toBe(true);
    // …and the completed turn still settled as a success on A.
    const rows = sortedRuns(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.agent).toBe(a);
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    expect(db.tasks.get(task.id)!.harnessState?.pendingSwap ?? null).toBeNull();
    // No swap divider, and the successful settle cleared the cooldown.
    expect(statusLines(rows[0]!.id).some((l) => l.includes("switching"))).toBe(false);
    expect(cooldownAfter).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("the self-clear of a recovered 429 keeps a newer cooldown another task wrote", async () => {
    const [a, b] = ids("recovered-newer", 2);
    codexAccount(a);
    codexAccount(b);
    const stack = stacks.harnessStacks.create({ label: "recovered-newer", kind: "codex", members: [a, b] });
    const task = makeTask(a, "plain codex work", { model: "fixture-codex-model" } as Partial<Task>);
    const signal = { reason: "rate_limit", resetAtMs: null, message: "429 Too Many Requests", source: "codex-error" };
    const prevTap = orch.__setChunkHandlerTapForTest((_runId, hooked, handler) => {
      if (hooked !== task.id) return;
      orch.__setChunkHandlerTapForTest(null);
      setTimeout(() => {
        handler("status", `${HARNESS_LIMIT_STATUS_PREFIX}${JSON.stringify(signal)}`);
        // Another task overwrites the account-wide row after this run's own.
        stacks.harnessStacks.setLimitState(a, { ...signal, message: "another task" } as never, Date.now() + 5);
      }, 150);
    });
    let after: ReturnType<typeof stacks.harnessStacks.getLimitState> = null;
    try {
      await withEnv(
        { AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "800" },
        async () => {
          expect(await orch.startTask(task.id)).toHaveProperty("runId");
          await waitFor(() => db.tasks.get(task.id)?.column === "review", 10_000);
          after = stacks.harnessStacks.getLimitState(a);
        },
      );
    } finally {
      orch.__setChunkHandlerTapForTest(prevTap);
      stacks.harnessStacks.clearLimitState(a);
      stacks.harnessStacks.clearLimitState(b);
    }
    expect(after).not.toBeNull();
    expect(after!.message).toBe("another task");
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a retry timer that fires while a run is live is re-armed, not consumed", async () => {
    const [a, b] = ids("liveretry", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "liveretry", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "a long turn");
    try {
      await withEnv({ AGETOR_FAKE_CLAUDE_TURN_MS: "1500" }, async () => {
        expect(await orch.startTask(task.id)).toHaveProperty("runId");
        // The driver is live (its first chunk landed), so the start claim is
        // released: the ORCHESTRATOR's busy check is what the timer meets,
        // not the failover engine's claim backoff.
        await waitFor(() => {
          const live = db.runs.listForTask(task.id).find((r) => r.status === "running");
          return !!live && db.runs.events(live.id).some((e) => e.stream === "stdout");
        });
        await Bun.sleep(30);
        const at = Date.now();
        db.tasks.setHarnessState(task.id, {
          stackId: stack.id, position: 0, count: 2, tried: [a], pendingSwap: null, lastMove: null,
          allExhausted: exhausted(at, { attempts: 1, nextAttemptAt: at }),
        });
        failover.armAutoRetry(task.id, at);
        // The timer fires (immediately) while the turn is still running.
        await waitFor(() => (db.tasks.get(task.id)!.harnessState?.allExhausted?.nextAttemptAt ?? 0) > at);
        expect(db.runs.listForTask(task.id).some((r) => r.status === "running")).toBe(true);
        expect(failover.hasArmedAutoRetry(task.id)).toBe(true);
        expect(db.tasks.get(task.id)!.harnessState?.allExhausted?.attempts).toBe(1);
        // No second run was minted next to the live one.
        expect(db.runs.listForTask(task.id)).toHaveLength(1);
        await waitFor(settledRuns(task.id, 1), 10_000);
      });
    } finally {
      failover.cancelAutoRetry(task.id);
      db.tasks.setHarnessState(task.id, null);
    }
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("Stop while a frozen process left the swap for the next owner (N1)", () => {
  test("the Stop clears the persisted swap so the next owner does not finish it", async () => {
    const [a, b] = ids("frozenstop", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "frozenstop", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, _runId, phase) => {
      if (hooked !== task.id || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      orch.freezeLaunches();
    });
    let oldRunId = "";
    try {
      await orch.startTask(task.id);
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length === 1 && rows[0]!.status === "failed" && db.tasks.get(task.id)!.harnessState?.pendingSwap != null;
      });
      oldRunId = db.runs.listForTask(task.id)[0]!.id;
      expect(await orch.cancelRun(oldRunId)).toBe(true);
      const stoppedTask = db.tasks.get(task.id)!;
      expect(stoppedTask.harnessState?.pendingSwap ?? null).toBeNull();
      expect(db.runs.get(oldRunId)?.status).toBe("cancelled");
      expect(stoppedTask.column).toBe("ready");
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      orch.__resetLaunchFreezeForTest();
    }
    // The next owner's boot finds nothing to resume.
    await orch.reconcileHarnessFailover();
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    expect(db.tasks.get(task.id)!.agent).toBe(a);
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("clean-retry prompts (N2, N5)", () => {
  test("a slash command goes out alone; the folded follow-ups follow it, never as its arguments", async () => {
    const [a, b] = ids("slashrest", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "slashrest", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `/review ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const prompts: string[] = [];
    const prevPrompt = orch.__setHarnessSwapPromptHookForTest((hooked, prompt) => {
      if (hooked === task.id) prompts.push(prompt);
    });
    const prevObserved = orch.__setHarnessLimitObservedHookForTest((hooked, runId) => {
      if (hooked !== task.id) return;
      // A follow-up folded into the limited turn.
      db.runs.appendEvent(runId, "user", "and also check the tests");
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 2));
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prevPrompt);
      orch.__setHarnessLimitObservedHookForTest(prevObserved);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(prompts).toEqual([task.prompt]);
    // The remainder is never lost: it reached the successor as a follow-up
    // (a live REPL folds it), or — the fake has no REPL to fold into — it is
    // back in the tray as the user's own words, never the hidden wrapper.
    const successor = sortedRuns(task.id)[1]!;
    const delivered = userRows(successor.id).some((d) => d.includes("and also check the tests"));
    const stashed = backlogTexts(task.id).includes("and also check the tests");
    expect(delivered || stashed).toBe(true);
    expect(backlogTexts(task.id).some((t) => t.includes("<harness-stack-continuation>"))).toBe(false);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a clean retry of text that quotes the tag is still exactly one hidden wrapper", async () => {
    const [a, b] = ids("quoted", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "quoted", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, `what does <harness-stack-continuation> mean? ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
    const prompts: string[] = [];
    const prev = orch.__setHarnessSwapPromptHookForTest((hooked, prompt) => {
      if (hooked === task.id) prompts.push(prompt);
    });
    try {
      expect(await orch.startTask(task.id)).toHaveProperty("runId");
      await waitFor(settledRuns(task.id, 2));
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prev);
      stacks.harnessStacks.clearLimitState(a);
    }
    expect(prompts).toHaveLength(1);
    expect(shared.isHarnessStackContinuation(prompts[0]!)).toBe(true);
    expect(shared.stripHarnessStackContinuation(prompts[0]!)).toBe(
      `what does < harness-stack-continuation> mean? ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`,
    );
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});

describe("a same-stack switch on a held task (N3)", () => {
  test("is refused: the claim fails and a direct reconcile puts the account back without touching the session", async () => {
    const [a, b] = ids("heldswitch", 2);
    alias(a);
    alias(b);
    const stack = stacks.harnessStacks.create({ label: "heldswitch", kind: "claude-code", members: [a, b] });
    const task = makeTask(a, "p");
    const runId = insertRun(task.id, a, { status: "succeeded", claudeSessionId: `held-${task.id}` });
    db.tasks.update(task.id, { runId, column: "running" });
    const subagentId = `agent-${randomUUID()}`;
    db.subagents.insertIfAbsent({
      id: subagentId, taskId: task.id, runId, parentKind: "subagent", agentType: "general-purpose",
      description: "background review", spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`),
      status: "running", startedAt: Date.now() - 1000, endedAt: null,
    } as never);
    try {
      expect(orch.isHeldByBackgroundAgents(task.id)).toBe(true);
      expect(orch.claimTaskForAccountSwitch(task.id)).toBe(false);

      const before = db.tasks.get(task.id)!;
      db.tasks.update(task.id, { agent: b });
      await orch.reconcileTaskSession(task.id, before, db.tasks.get(task.id)!);
      const after = db.tasks.get(task.id)!;
      expect(after.agent).toBe(a);
      expect(after.harnessState?.lastMove ?? null).toBeNull();
      expect(statusLines(runId).some((l) => l.includes("account switch refused"))).toBe(true);
      // The background agent was not abandoned.
      expect(db.subagents.hasRunning(task.id)).toBe(true);
      expect(orch.isHeldByBackgroundAgents(task.id)).toBe(true);
    } finally {
      db.tasks.update(task.id, { column: "review" });
    }
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);
});
