// The assembled harness-stack swap (TT5): a fake-driver limit on the primary
// account settles the old run, transfers the conversation and keeps the task
// running on the backup. Nothing here touches a real CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GlobalEvent, Task } from "../shared/types.ts";
import { classifyHarnessLimitSignal } from "../shared/harness-limits.ts";

// Literal copies: a static src/bun import would load db.ts before the data
// dir below is set (the suite runs every file in one process).
const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
const FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER = "__agetor_fake_claude_limit_clean__";
const FAKE_CLAUDE_LIMIT_PANE_PROMPT_MARKER = "__agetor_fake_claude_limit_pane__";
const FAKE_CLAUDE_API_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_api_limit__";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harness-swap-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-harness-swap-bin-"));
const stub = (name: string, body: string): string => {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
process.env.AGETOR_TMUX_BIN = stub("tmux", "exit 1");

let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");
let stacks: typeof import("./harness-stacks.ts");
let failover: typeof import("./harness-failover.ts");
let claude: typeof import("./claude-tmux.ts");
let restore: () => void;
let seq = 0;

beforeAll(async () => {
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  claude = await import("./claude-tmux.ts");
});

afterAll(async () => {
  restore();
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

function home(label: string): string {
  const dir = path.join(DATA_DIR, "harnesses", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".credentials.json"), "{}");
  return dir;
}

function alias(id: string, h: string): void {
  if (db.harnesses.get(id)) return;
  db.harnesses.insert({ id, kind: "claude-code", label: id, home: h, env: {} } as never);
}

function makeTask(agent: string, prompt: string, extra: Partial<Task> = {}): Task {
  const id = randomUUID();
  const workdir = path.join(DATA_DIR, "work", `${++seq}`);
  mkdirSync(workdir, { recursive: true });
  db.tasks.insert({
    id,
    title: "swap",
    prompt,
    agent,
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: "sonnet-4.6",
    effort: "high",
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    ...extra,
  } as never);
  return db.tasks.get(id)!;
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(15);
  }
}

function statusLines(runId: string): string[] {
  return db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}

/**
 * Seed the run row + transcript an EARLIER turn on `harnessId` would have left
 * behind, and make it the task's current run. A real resumed turn reuses that
 * session id; the fake driver's ordinary turn stamps no id at all, so a test
 * that needs "this account already has a conversation" must write it itself.
 */
function seedPriorConversation(task: Task, harnessId: string, sessionId: string): string {
  const encoded = claude.encodeProjectPath(task.workdir);
  const transcript = path.join(home(harnessId), "projects", encoded, `${sessionId}.jsonl`);
  mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "first ask" }] } })}\n`,
    { mode: 0o600 },
  );
  const runId = randomUUID();
  db.runs.insert({
    id: runId,
    taskId: task.id,
    agent: harnessId,
    status: "succeeded",
    startedAt: Date.now() - 1_000,
    endedAt: Date.now() - 900,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: sessionId,
    codexSessionId: null,
    cursorSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
  } as never);
  db.tasks.update(task.id, { column: "review", runId });
  return runId;
}

describe("harness-stack swap", () => {
  test("a limit on the primary transfers the conversation and keeps the task running", async () => {
    const idA = `swap-a-${seq}`;
    const idB = `swap-b-${seq}`;
    const homeA = home(idA);
    const homeB = home(idB);
    alias(idA, homeA);
    alias(idB, homeB);
    const stack = stacks.harnessStacks.create({ label: "swap", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `do it ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.runs.listForTask(task.id).length >= 2 && db.runs.listForTask(task.id).every((r) => r.status !== "running"));

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.agent).toBe(idA);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[1]!.agent).toBe(idB);
    expect(runs[1]!.origin).toBe("harness-swap");
    expect(runs[1]!.claudeSessionId).toBe(`fake-swap-${task.id}`);

    const noticeRaw = statusLines(runs[1]!.id).find((l) => l.startsWith("harness-swap: "));
    expect(noticeRaw).toBeTruthy();
    const { parseHarnessSwapNotice, formatHarnessSwapNotice } = await import("../shared/harness-stack.ts");
    const notice = parseHarnessSwapNotice(noticeRaw!);
    expect(notice?.toLabel).toBe(idB);
    expect(formatHarnessSwapNotice(notice!)).toContain("Switched to");
    expect(formatHarnessSwapNotice(notice!)).not.toContain("Agetor");

    // The transcript really moved to the backup account.
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const copied = path.join(homeB, "projects", encodeProjectPath(task.worktreePath ?? task.workdir), `fake-swap-${task.id}.jsonl`);
    expect(existsSync(copied)).toBe(true);
    expect(existsSync(path.join(homeA, "projects"))).toBe(true);

    const final = db.tasks.get(task.id)!;
    expect(final.agent).toBe(idB);
    expect(final.column).toBe("review");
    expect(final.harnessState?.pendingSwap ?? null).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a stacked Claude 429 API error swaps without ever painting a blocked api-error", async () => {
    const idA = `api-limit-a-${seq}`;
    const idB = `api-limit-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "api-limit", kind: "claude-code", members: [idA, idB] });
    const globals: GlobalEvent[] = [];
    const unsub = orch.subscribeGlobal((e) => globals.push(e));
    let taskId = "";
    try {
      const task = makeTask(idA, `api limit ${FAKE_CLAUDE_API_LIMIT_PROMPT_MARKER}`);
      taskId = task.id;
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => {
        const runs = db.runs.listForTask(task.id);
        return runs.length >= 2 && runs.every((r) => r.status !== "running");
      });

      const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
      expect(runs).toHaveLength(2);
      expect(runs[0]!.agent).toBe(idA);
      // The driver resolves the 429 turn with code 0; the settlement still
      // records the old run failed and the backup succeeds.
      expect(runs[0]!.status).toBe("failed");
      expect(runs[1]!.agent).toBe(idB);
      expect(runs[1]!.origin).toBe("harness-swap");

      // The API error was also a provider limit, so the swap owned the
      // settlement: no `blocked`/`api-error` column flip may be painted (that
      // is what fires the sticky retry toast and drops the card out of
      // running before the successor starts).
      const apiErrorBlock = globals.find(
        (e) => e.kind === "column" && e.taskId === task.id && e.column === "blocked" && e.reason === "api-error",
      );
      expect(apiErrorBlock).toBeUndefined();
      expect(db.tasks.get(task.id)?.column).toBe("review");
    } finally {
      unsub();
      if (taskId) {
        stacks.harnessStacks.clearLimitState(idA);
        stacks.harnessStacks.clearLimitState(idB);
        stacks.harnessStacks.delete(stack.id);
      }
    }
  }, 15_000);


  test("when every account is cooling the task blocks with a counted retry", async () => {
    const idA = `ex-a-${seq}`;
    const idB = `ex-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "exhausted", kind: "claude-code", members: [idA, idB] });
    // The backup is already cooling, so the walk has nowhere to go.
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    const blocked = db.tasks.get(task.id)!;
    expect(blocked.column).toBe("blocked");
    // The initial exhaustion schedules a retry without spending one of the
    // three attempts — attempts count retry runs that actually started.
    expect(blocked.harnessState?.allExhausted?.attempts).toBe(0);
    expect(blocked.harnessState?.allExhausted?.max).toBe(3);
    expect(blocked.harnessState?.allExhausted?.nextAttemptAt).toBeGreaterThan(Date.now());
    const runs = db.runs.listForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    const { cancelAutoRetry } = await import("./harness-failover.ts");
    cancelAutoRetry(task.id);
    stacks.harnessStacks.clearLimitState(idB);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("an all-exhausted retry skips the still-cooling account and resumes the conversation", async () => {
    const idA = `retry-a-${seq}`;
    const idB = `retry-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "retry", kind: "claude-code", members: [idA, idB] });
    // Force the first settlement to block: the backup is cooling too.
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    const blocked = db.tasks.get(task.id)!;
    expect(blocked.harnessState?.allExhausted).toBeTruthy();

    // Let the backup serve, then fire the retry "now" instead of waiting for
    // the fallback quota backoff. The current account A is still cooling, so
    // the retry must move to B — and because the first turn recorded a tool
    // call, it must transfer and resume the session, not start fresh.
    stacks.harnessStacks.clearLimitState(idB);
    const state = blocked.harnessState!;
    const nextAttemptAt = Date.now();
    db.tasks.setHarnessState(task.id, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt },
    });
    // Fire only THIS task's schedule; `rearmAutoRetries` would walk every row
    // in the shared test DB.
    failover.armAutoRetry(task.id, nextAttemptAt);

    await waitFor(() => {
      const runs = db.runs.listForTask(task.id);
      return runs.length >= 2 && runs.every((r) => r.status !== "running") && db.tasks.get(task.id)?.agent === idB;
    }, 8000);

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs[1]!.agent).toBe(idB);
    expect(runs[1]!.origin).toBe("harness-swap");
    expect(runs[1]!.claudeSessionId).toBe(`fake-swap-${task.id}`);
    expect(db.tasks.get(task.id)?.agent).toBe(idB);
    stacks.harnessStacks.clearLimitState(idA);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("an all-exhausted retry surfaces the mirror warnings on the successor run (R13-M2)", async () => {
    const idA = `retry-warn-a-${seq}`;
    const idB = `retry-warn-b-${seq}`;
    const homeA = home(idA);
    const homeB = home(idB);
    alias(idA, homeA);
    alias(idB, homeB);
    // A valid primary file plus a non-object backup file makes the mirror skip
    // the merge with a warning. The retry path used to log it and show plain
    // success; it must now land on the successor's message stream.
    writeFileSync(path.join(homeA, "settings.json"), "{}\n");
    writeFileSync(path.join(homeB, "settings.json"), "[]\n");
    const stack = stacks.harnessStacks.create({ label: "retry-warn", kind: "claude-code", members: [idA, idB] });
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    await orch.startTask(task.id);
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    const blocked = db.tasks.get(task.id)!;
    stacks.harnessStacks.clearLimitState(idB);
    const state = blocked.harnessState!;
    const nextAttemptAt = Date.now();
    db.tasks.setHarnessState(task.id, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt },
    });
    failover.armAutoRetry(task.id, nextAttemptAt);

    await waitFor(() => {
      const runs = db.runs.listForTask(task.id);
      return runs.length >= 2 && runs.every((r) => r.status !== "running") && db.tasks.get(task.id)?.agent === idB;
    }, 8000);

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    const successorLines = statusLines(runs[1]!.id);
    expect(successorLines.some((line) => line.startsWith("config mirror:"))).toBe(true);
    // The wording names what actually failed (a JSON array is valid JSON but
    // not a settings object), instead of claiming invalid JSON.
    expect(successorLines.some((line) => line.includes("not a JSON object"))).toBe(true);
    stacks.harnessStacks.clearLimitState(idA);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("an all-exhausted retry blocks when the recorded transcript is gone", async () => {
    const idA = `retry-gone-a-${seq}`;
    const idB = `retry-gone-b-${seq}`;
    const homeA = home(idA);
    alias(idA, homeA);
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "retry-gone", kind: "claude-code", members: [idA, idB] });
    // Force the first settlement to block: the backup is cooling too.
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    const blocked = db.tasks.get(task.id)!;
    expect(blocked.harnessState?.allExhausted).toBeTruthy();
    // The first turn recorded a session id AND a transcript on A. Delete the
    // file: the retry then has a recorded conversation it cannot move.
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const transcript = path.join(homeA, "projects", encodeProjectPath(task.worktreePath ?? task.workdir), `fake-swap-${task.id}.jsonl`);
    expect(existsSync(transcript)).toBe(true);
    unlinkSync(transcript);

    // Let the backup serve, then fire the retry "now".
    stacks.harnessStacks.clearLimitState(idB);
    const state = blocked.harnessState!;
    const nextAttemptAt = Date.now();
    db.tasks.setHarnessState(task.id, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt },
    });
    failover.armAutoRetry(task.id, nextAttemptAt);

    const blockedRunId = db.runs.listForTask(task.id)[0]!.id;
    await waitFor(
      () => statusLines(blockedRunId).some((l) => l.includes("could not move the conversation")),
      8000,
    );

    // A missing transcript is a hard block, not a silent fresh start: the
    // conversation the user had is gone, so no successor run may be minted.
    const runs = db.runs.listForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("blocked");
    expect(after.agent).toBe(idA);
    expect(statusLines(runs[0]!.id).some((l) => l.includes("could not move the conversation"))).toBe(true);
    // A hard block is a manual fix: the stale all-exhausted marker must be
    // cleared, or the card/badge/CLI would claim "Retrying…" with no timer.
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    expect(orch.hasPendingHarnessRetry(task.id)).toBe(false);
    const { harnessStackBannerMode } = await import("../shared/harness-stack.ts");
    expect(harnessStackBannerMode(after.harnessState)).not.toBe("exhausted");
    stacks.harnessStacks.clearLimitState(idA);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a none-usable backup blocks with a manual-fix line, not a phantom quota retry", async () => {
    const idA = `none-a-${seq}`;
    const idB = `none-b-${seq}`;
    const idC = `none-c-${seq}`;
    alias(idA, home(idA));
    // Homes with no credentials: the cached login evidence marks B and C
    // unusable, so after A leaves the stack the walk has no limit-blocked
    // member and returns `none-usable`.
    for (const id of [idB, idC]) {
      const dir = path.join(DATA_DIR, "harnesses", id);
      mkdirSync(dir, { recursive: true });
      alias(id, dir);
    }
    const stack = stacks.harnessStacks.create({ label: "none-usable", kind: "claude-code", members: [idA, idB, idC] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    // Remove the account that hit the limit from the stack before the
    // settlement resolves. Its own cooldown is then not a member cooldown, so
    // the remaining two logged-out accounts are `none-usable` rather than a
    // quota-exhausted train.
    const prev = orch.__setHarnessLimitObservedHookForTest((observedTaskId) => {
      orch.__setHarnessLimitObservedHookForTest(null);
      expect(observedTaskId).toBe(task.id);
      stacks.harnessStacks.update(stack.id, { members: [idB, idC] });
    });
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
    }

    const after = db.tasks.get(task.id)!;
    expect(after.harnessState?.allExhausted?.reason).toBe("no-usable-member");
    expect(after.harnessState?.allExhausted?.nextAttemptAt).toBe(0);
    const run = db.runs.listForTask(task.id)[0]!;
    const lines = statusLines(run.id);
    expect(lines.some((l) => l.includes("No account in this stack can run this task"))).toBe(true);
    // No timer was armed, so the transcript must not claim a quota retry.
    expect(lines.some((l) => /retrying at/i.test(l))).toBe(false);
    expect(lines.some((l) => /out of quota/i.test(l))).toBe(false);
    stacks.harnessStacks.clearLimitState(idA);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a same-account retry after the reset resumes the existing session", async () => {
    const idA = `same-a-${seq}`;
    const idB = `same-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "same", kind: "claude-code", members: [idA, idB] });
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    // A's reset arrives first; B is still cooling. The retry stays on A and
    // must resume the same provider session rather than resending the prompt
    // on a fresh one.
    stacks.harnessStacks.clearLimitState(idA);
    const state = db.tasks.get(task.id)!.harnessState!;
    const nextAttemptAt = Date.now();
    db.tasks.setHarnessState(task.id, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt },
    });
    failover.armAutoRetry(task.id, nextAttemptAt);

    await waitFor(() => {
      const runs = db.runs.listForTask(task.id);
      return runs.length >= 2 && runs.every((r) => r.status !== "running");
    }, 8000);

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs[1]!.agent).toBe(idA);
    expect(runs[1]!.origin).toBe("harness-swap");
    expect(runs[1]!.claudeSessionId).toBe(`fake-swap-${task.id}`);
    stacks.harnessStacks.clearLimitState(idA);
    stacks.harnessStacks.clearLimitState(idB);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a retry that fails for a non-limit reason ends the failover loop", async () => {
    const idA = `retry-fail-a-${seq}`;
    const idB = `retry-fail-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "retry-fail", kind: "claude-code", members: [idA, idB] });
    // Force the first settlement to block: the backup is cooling too.
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted).toBeTruthy();

    // The backup serves again, but its turn fails for a NON-limit reason (an
    // API error). The retry marker must end the loop — leaving `inFlight`
    // armed is what lets the normal settle clear `allExhausted` instead of
    // showing "Retrying…" forever with `nextAttemptAt: 0` and no timer.
    stacks.harnessStacks.clearLimitState(idB);
    const state = db.tasks.get(task.id)!.harnessState!;
    const nextAttemptAt = Date.now();
    db.tasks.setHarnessState(task.id, {
      ...state,
      allExhausted: { ...state.allExhausted!, nextAttemptAt },
    });
    process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
    // Snapshot before the cleanup: deleting the stack clears every task state,
    // which would make a later reading of `allExhausted` vacuously null.
    let runs: ReturnType<typeof db.runs.listForTask> = [];
    let allExhausted: unknown = "not-read";
    let pendingRetry = true;
    try {
      failover.armAutoRetry(task.id, nextAttemptAt);
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 2
          && rows.every((r) => r.status !== "running")
          && db.tasks.get(task.id)!.harnessState?.allExhausted == null;
      }, 8000);
      runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
      allExhausted = db.tasks.get(task.id)!.harnessState?.allExhausted ?? null;
      pendingRetry = orch.hasPendingHarnessRetry(task.id);
    } finally {
      delete process.env.AGETOR_FAKE_CLAUDE_API_ERROR;
      stacks.harnessStacks.clearLimitState(idA);
      stacks.harnessStacks.clearLimitState(idB);
      stacks.harnessStacks.delete(stack.id);
    }

    expect(runs).toHaveLength(2);
    expect(runs[1]!.agent).toBe(idB);
    expect(runs[1]!.status).toBe("failed");
    expect(allExhausted).toBeNull();
    expect(pendingRetry).toBe(false);
  }, 15_000);

  test("a retry successor whose spawn throws emits only the reason-tagged failure and re-arms", async () => {
    const idA = `retry-spawn-a-${seq}`;
    const idB = `retry-spawn-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "retry-spawn-throw", kind: "claude-code", members: [idA, idB] });
    // Force the first settlement to block so the retry timer is what starts the
    // successor (the R8-M1 path: the retry is re-armed after a failed spawn).
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");

    const statusEvents: { taskId: string; runId: string; status: string; reason?: string }[] = [];
    const unsubscribe = orch.subscribeGlobal((ev) => {
      if (ev.kind === "run-status" && ev.taskId === task.id) {
        statusEvents.push({ taskId: ev.taskId, runId: ev.runId, status: ev.status, reason: ev.reason });
      }
    });
    let runsAfter: ReturnType<typeof db.runs.listForTask> = [];
    let retryState: { attempts: number; inFlight?: boolean; nextAttemptAt: number } | null = null;
    try {
      stacks.harnessStacks.clearLimitState(idB);
      // A deterministic synchronous throw inside `spawnAgent` → the swap's
      // `spawnAgentOrFail` catch. `buildCommand` requires a model; the empty
      // string reaches it as-is (nullish coalescing does not fall back).
      db.tasks.update(task.id, { model: "" });
      const state = db.tasks.get(task.id)!.harnessState!;
      const nextAttemptAt = Date.now();
      db.tasks.setHarnessState(task.id, {
        ...state,
        allExhausted: { ...state.allExhausted!, nextAttemptAt },
      });
      failover.armAutoRetry(task.id, nextAttemptAt);

      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 2
          && rows.every((r) => r.status !== "running")
          && (db.tasks.get(task.id)!.harnessState?.allExhausted?.attempts ?? 0) >= 1;
      }, 8000);
      runsAfter = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
      retryState = db.tasks.get(task.id)!.harnessState!.allExhausted ?? null;
    } finally {
      unsubscribe();
      db.tasks.update(task.id, { model: "sonnet-4.6" });
      failover.cancelAutoRetry(task.id);
      stacks.harnessStacks.clearLimitState(idA);
      stacks.harnessStacks.clearLimitState(idB);
      stacks.harnessStacks.delete(stack.id);
    }

    expect(runsAfter).toHaveLength(2);
    const successor = runsAfter[1]!;
    expect(successor.origin).toBe("harness-swap");
    expect(successor.status).toBe("failed");
    // The bug: `spawnAgentOrFail` emitted an UNTAGGED failed status first, so
    // the webview double-toasted and the pipeline runner settled the step
    // `step-failed` while the retry was still armed. Exactly one terminal
    // event for the successor, and it must carry the swap reason.
    const successorStatuses = statusEvents.filter((e) => e.runId === successor.id);
    expect(successorStatuses).toHaveLength(1);
    expect(successorStatuses[0]!.status).toBe("failed");
    expect(successorStatuses[0]!.reason).toBe("harness-swap");
    // The spawn failure spent one attempt and left the timer armed.
    expect(retryState).not.toBeNull();
    expect(retryState!.attempts).toBe(1);
    expect(retryState!.inFlight).not.toBe(true);
    expect(retryState!.nextAttemptAt).toBeGreaterThan(Date.now());
  }, 20_000);

  test("a throw inside the auto-retry handler clears inFlight and re-arms the timer", async () => {
    const idA = `retry-throw-a-${seq}`;
    const idB = `retry-throw-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "retry-throw", kind: "claude-code", members: [idA, idB] });
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    await orch.startTask(task.id);
    await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted).toBeTruthy();

    // The successor launch itself blows up before minting a run row. Without
    // the recovery in `fireHarnessAutoRetry`, the persisted `inFlight: true`
    // with `nextAttemptAt: 0` and no timer would leave "Retrying…" forever.
    const prevHook = orch.__setHarnessSwapSpawnHookForTest(() => {
      throw new Error("synthetic retry spawn throw");
    });
    let after: Task["harnessState"] = null;
    let runCount = 0;
    let pending = false;
    try {
      stacks.harnessStacks.clearLimitState(idB);
      const state = db.tasks.get(task.id)!.harnessState!;
      const nextAttemptAt = Date.now();
      db.tasks.setHarnessState(task.id, {
        ...state,
        allExhausted: { ...state.allExhausted!, nextAttemptAt },
      });
      failover.armAutoRetry(task.id, nextAttemptAt);

      await waitFor(() => {
        const exhausted = db.tasks.get(task.id)!.harnessState?.allExhausted;
        // attempts becomes 1 only after the fired retry threw and was
        // recovered; the initial block has attempts 0 and a future timer.
        return !!exhausted && exhausted.attempts === 1 && exhausted.inFlight !== true && (exhausted.nextAttemptAt ?? 0) > Date.now();
      }, 8000);
      after = db.tasks.get(task.id)!.harnessState;
      runCount = db.runs.listForTask(task.id).length;
      pending = orch.hasPendingHarnessRetry(task.id);
    } finally {
      orch.__setHarnessSwapSpawnHookForTest(prevHook);
      failover.cancelAutoRetry(task.id);
      stacks.harnessStacks.clearLimitState(idA);
      stacks.harnessStacks.clearLimitState(idB);
      stacks.harnessStacks.delete(stack.id);
    }

    expect(after?.allExhausted?.inFlight).not.toBe(true);
    expect(after?.allExhausted?.attempts).toBe(1);
    expect(after?.allExhausted?.nextAttemptAt).toBeGreaterThan(Date.now());
    // Nothing was minted: the throw happened before the run row existed.
    expect(runCount).toBe(1);
    expect(pending).toBe(true);
  }, 20_000);

  test("a failed delete keeps the copied conversation resumable", async () => {
    const idA = `del-copy-a-${seq}`;
    const homeA = home(idA);
    alias(idA, homeA);
    // A pipeline parent so the cascade runs before the task row is removed —
    // the same throwing work the tombstone rollback covers (R8-S1).
    const task = makeTask(idA, "delete me", { pipelineId: randomUUID() } as Partial<Task>);
    const copied = path.join(homeA, "projects", "p", "s.jsonl");
    mkdirSync(path.dirname(copied), { recursive: true });
    writeFileSync(copied, "{}\n");
    db.harnessSessionHandoffs.upsert({
      taskId: task.id,
      harnessId: idA,
      columnName: "claude_session_id",
      sessionId: "s",
      copiedPaths: [copied],
      createdAt: Date.now(),
    });

    // Make the cascade's own step enumeration throw exactly once, after the
    // delete has started but before it can commit.
    const originalList = db.tasks.list;
    let armed = true;
    db.tasks.list = function (this: typeof db.tasks, ...args: Parameters<typeof db.tasks.list>) {
      if (armed) {
        armed = false;
        throw new Error("simulated cascade failure");
      }
      return originalList.apply(this, args);
    };
    let threw = false;
    try {
      await orch.deleteTask(task.id);
    } catch {
      threw = true;
    } finally {
      db.tasks.list = originalList;
    }

    expect(threw).toBe(true);
    // The task row survived, so its transferred conversation must still be on
    // disk and allowed — otherwise the card can never resume what it had.
    expect(db.tasks.get(task.id)).not.toBeNull();
    expect(existsSync(copied)).toBe(true);
    expect(db.harnessSessionHandoffs.get(task.id, idA, "claude_session_id")).not.toBeNull();

    // A retried delete succeeds and then removes the copies.
    await orch.deleteTask(task.id);
    expect(db.tasks.get(task.id)).toBeNull();
    expect(existsSync(copied)).toBe(false);
  }, 15_000);

  test("before any tool call the original prompt is retried on a fresh session", async () => {
    const idA = `clean-a-${seq}`;
    const idB = `clean-b-${seq}`;
    const homeA = home(idA);
    const homeB = home(idB);
    alias(idA, homeA);
    alias(idB, homeB);
    const stack = stacks.harnessStacks.create({ label: "clean", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `no tools yet ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);

    // The clean-retry branch has no transfer and the fake driver does not echo
    // its input, so capture the prompt the successor is actually spawned with.
    const prompts: string[] = [];
    const prevPromptHook = orch.__setHarnessSwapPromptHookForTest((hookedTaskId, prompt) => {
      if (hookedTaskId === task.id) prompts.push(prompt);
    });
    // A live turn can accumulate more than one main-stream user row: a REPL
    // follow-up typed while it runs folds into the SAME run, and one send can
    // be stored twice (live echo + the CLI's JSONL twin). Seed both shapes so
    // this test proves the successor replays the WHOLE request in order — a
    // regression that sent only the newest raw row would fail here (R11-S3).
    const folded = "also update the docs";
    const prevObserved = orch.__setHarnessLimitObservedHookForTest((hookedTaskId, runId) => {
      if (hookedTaskId !== task.id) return;
      db.runs.appendEvent(runId, "user", folded);
      db.runs.appendEvent(runId, "user", task.prompt);
    });
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => db.runs.listForTask(task.id).length >= 2 && db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prevPromptHook);
      orch.__setHarnessLimitObservedHookForTest(prevObserved);
    }

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.agent).toBe(idB);
    // The successor replays the user's own request (the plan's "original
    // prompt"), hidden behind the continuation wrapper so the transcript does
    // not show the same bubble twice. The folded follow-up and the duplicate
    // twin are composed by `composeCleanRetryText`, not resent raw.
    const { wrapHarnessStackContinuation } = await import("../shared/harness-stack.ts");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(wrapHarnessStackContinuation(`${task.prompt}\n\n${folded}`));
    // No tool_use on the first turn → no transfer, no handoff on the backup.
    expect(db.harnessSessionHandoffs.get(task.id, idB, "claude_session_id")).toBeNull();
    const { encodeProjectPath } = await import("./claude-tmux.ts");
    const copied = path.join(homeB, "projects", encodeProjectPath(task.worktreePath ?? task.workdir), `fake-swap-${task.id}.jsonl`);
    expect(existsSync(copied)).toBe(false);
    // The new run's first status is still the visible notice, but it must not
    // claim a transferred conversation that never happened.
    const raw = statusLines(runs[1]!.id).find((l) => l.startsWith("harness-swap: "));
    expect(raw).toBeTruthy();
    const { parseHarnessSwapNotice, formatHarnessSwapNotice } = await import("../shared/harness-stack.ts");
    const notice = parseHarnessSwapNotice(raw!)!;
    expect(notice.continuation).toBe("restarted");
    const text = formatHarnessSwapNotice(notice);
    expect(text).toContain("Restarting the request on this account.");
    expect(text).not.toContain("transferred conversation");
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a follow-up turn that limits before its first tool call keeps the earlier conversation", async () => {
    const idA = `follow-a-${seq}`;
    const idB = `follow-b-${seq}`;
    const homeA = home(idA);
    const homeB = home(idB);
    alias(idA, homeA);
    alias(idB, homeB);
    const stack = stacks.harnessStacks.create({ label: "follow-up", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "first ask");

    // An earlier turn on A already produced a provider conversation; the first
    // user send then RESENDS that session id, exactly like a real follow-up.
    const sessionId = `prior-${task.id}`;
    const priorRunId = seedPriorConversation(task, idA, sessionId);

    const prompts: string[] = [];
    const prevPromptHook = orch.__setHarnessSwapPromptHookForTest((hookedTaskId, prompt) => {
      if (hookedTaskId === task.id) prompts.push(prompt);
    });
    try {
      // The follow-up hits the quota before any tool call. R11-M1: the earlier
      // conversation must still move — a fresh session with only this text
      // would drop every earlier turn (the plan's "conversation is preserved"
      // clause), for a cross-account swap and a same-account retry alike.
      const sent = await orch.sendInput(priorRunId, `one more thing ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
      expect(sent.delivered).toBe(true);
      await waitFor(
        () => db.runs.listForTask(task.id).length >= 3 && db.runs.listForTask(task.id).every((r) => r.status !== "running"),
        8000,
      );
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prevPromptHook);
    }

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs).toHaveLength(3);
    expect(runs[1]!.agent).toBe(idA);
    expect(runs[1]!.status).toBe("failed");
    expect(runs[1]!.claudeSessionId).toBe(sessionId);
    expect(runs[2]!.agent).toBe(idB);
    expect(runs[2]!.origin).toBe("harness-swap");
    // The successor resumes the SAME conversation instead of starting fresh.
    expect(runs[2]!.claudeSessionId).toBe(sessionId);
    expect(db.harnessSessionHandoffs.get(task.id, idB, "claude_session_id")?.sessionId).toBe(sessionId);
    const { composeHarnessStackContinuationPrompt, parseHarnessSwapNotice } = await import("../shared/harness-stack.ts");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(composeHarnessStackContinuationPrompt());
    const raw = statusLines(runs[2]!.id).find((l) => l.startsWith("harness-swap: "));
    const { formatHarnessSwapNotice } = await import("../shared/harness-stack.ts");
    const notice = parseHarnessSwapNotice(raw!)!;
    // `continuation` is absent for the transferred branch (legacy-tolerant
    // parser); the formatted divider is what must not claim a restart.
    expect(notice.continuation).not.toBe("restarted");
    expect(formatHarnessSwapNotice(notice)).toContain("Continuing from the transferred conversation.");
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a same-account retry after a follow-up limit also resumes the earlier conversation", async () => {
    const idA = `follow-same-a-${seq}`;
    const idB = `follow-same-b-${seq}`;
    const homeA = home(idA);
    alias(idA, homeA);
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "follow-same", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "first ask");
    const sessionId = `prior-same-${task.id}`;
    const priorRunId = seedPriorConversation(task, idA, sessionId);

    // The backup is still cooling, so the follow-up limit cannot leave the
    // account. A's own reset then re-picks A — the same-account retry must
    // resume the conversation a fresh session would throw away (R11-M1).
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const prompts: string[] = [];
    const prevPromptHook = orch.__setHarnessSwapPromptHookForTest((hookedTaskId, prompt) => {
      if (hookedTaskId === task.id) prompts.push(prompt);
    });
    try {
      const sent = await orch.sendInput(priorRunId, `one more thing ${FAKE_CLAUDE_LIMIT_CLEAN_PROMPT_MARKER}`);
      expect(sent.delivered).toBe(true);
      await waitFor(() => db.tasks.get(task.id)?.column === "blocked");
      expect(db.tasks.get(task.id)!.harnessState?.allExhausted).toBeTruthy();

      stacks.harnessStacks.clearLimitState(idA);
      const state = db.tasks.get(task.id)!.harnessState!;
      const nextAttemptAt = Date.now();
      db.tasks.setHarnessState(task.id, {
        ...state,
        allExhausted: { ...state.allExhausted!, nextAttemptAt },
      });
      failover.armAutoRetry(task.id, nextAttemptAt);

      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 3 && rows.every((r) => r.status !== "running");
      }, 8000);
    } finally {
      orch.__setHarnessSwapPromptHookForTest(prevPromptHook);
      stacks.harnessStacks.clearLimitState(idA);
      stacks.harnessStacks.clearLimitState(idB);
    }

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs).toHaveLength(3);
    expect(runs[1]!.agent).toBe(idA);
    expect(runs[1]!.status).toBe("failed");
    // No transfer happened (same account), but the retry resumes the id.
    expect(db.harnessSessionHandoffs.get(task.id, idA, "claude_session_id")).toBeNull();
    expect(runs[2]!.agent).toBe(idA);
    expect(runs[2]!.claudeSessionId).toBe(sessionId);
    const { composeHarnessStackContinuationPrompt } = await import("../shared/harness-stack.ts");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(composeHarnessStackContinuationPrompt());
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("boot keeps a settled successor's outcome instead of blocking a stale pending swap", async () => {
    const idA = `boot-a-${seq}`;
    const idB = `boot-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "boot-reconcile", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idB, "already continued");
    const oldRunId = randomUUID();
    const successorId = randomUUID();
    db.runs.insert({
      id: successorId,
      taskId: task.id,
      agent: idB,
      status: "succeeded",
      startedAt: Date.now() - 1_000,
      endedAt: Date.now(),
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
      origin: "harness-swap",
    } as never);
    db.tasks.update(task.id, { column: "review", runId: successorId });
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id,
      position: 1,
      count: 2,
      tried: [idA],
      pendingSwap: {
        from: idA,
        to: idB,
        reason: "quota",
        runId: oldRunId,
        startedAt: Date.now() - 2_000,
      },
      allExhausted: null,
      lastMove: null,
    });

    await orch.reconcileHarnessFailover();

    const after = db.tasks.get(task.id)!;
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    // The successor already succeeded; boot must not overwrite that with a
    // "core restarted mid-switch" block.
    expect(after.column).toBe("review");
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a 1-member stack settles like a lone account and drains a follow-up typed during the limit", async () => {
    const idA = `inert-a-${seq}`;
    alias(idA, home(idA));
    const stack = stacks.harnessStacks.create({ label: "inert", kind: "claude-code", members: [idA] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const prev = orch.__setHarnessSwapSettleHookForTest(async (hookedTaskId, runId, phase) => {
      if (phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      expect(hookedTaskId).toBe(task.id);
      // The settlement holds the start claim, so this is held in the swap
      // follow-up queue and must be drained by the normal settle.
      const sent = await orch.sendInput(runId, "follow-up during the limit");
      expect(sent.delivered).toBe(true);
    });
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length >= 2 && rows.every((r) => r.status !== "running");
      }, 8000);
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }

    const runs = [...db.runs.listForTask(task.id)].sort((a, b) => a.startedAt - b.startedAt);
    expect(runs).toHaveLength(2);
    // The limit really failed the turn (not a fake-driver "succeeded"), but
    // with no backup the task takes the ordinary settle — no exhausted marker
    // and no swap intent left behind.
    expect(runs[0]!.status).toBe("failed");
    const after = db.tasks.get(task.id)!;
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    // The queued follow-up was drained onto the next run, never stranded —
    // and exactly once: the swap window holds the text without writing an
    // optimistic bubble on the displaced run, so the drain's send is the only
    // user event (that duplicate bubble was the review's should-fix).
    expect(db.runs.mainUserTexts(runs[1]!.id)).toEqual(["follow-up during the limit"]);
    const userBubbles = db.runs
      .listForTask(task.id)
      .flatMap((r) => db.runs.events(r.id))
      .filter((e) => e.stream === "user" && e.data.includes("follow-up during the limit"));
    expect(userBubbles).toHaveLength(1);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);

  test("a pending all-exhausted retry is reported and can be cancelled before it fires", async () => {
    const idA = `pending-a-${seq}`;
    const idB = `pending-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "pending-retry", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "never runs");
    const now = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 0,
        max: 3,
        nextAttemptAt: now + 60,
        earliestResetAtMs: null,
        reason: "quota",
      },
      lastMove: null,
    });
    failover.armAutoRetry(task.id, now + 60);

    expect(orch.hasPendingHarnessRetry(task.id)).toBe(true);
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(true);
    expect(orch.hasPendingHarnessRetry(task.id)).toBe(false);
    expect(db.tasks.get(task.id)!.harnessState!.allExhausted).toBeNull();
    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    // The timer was cleared, not fired: no run appeared.
    expect(db.runs.listForTask(task.id)).toHaveLength(0);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a Stop in the settlement window aborts the swap before a successor exists", async () => {
    const idA = `stop-window-a-${seq}`;
    const idB = `stop-window-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "stop-window", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const prev = orch.__setHarnessSwapSettleHookForTest(async (stoppedTaskId, runId, phase) => {
      if (phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      // No active handle and no pendingSwap yet: the exact M7 window.
      expect(await orch.cancelRun(runId)).toBe(true);
      expect(stoppedTaskId).toBe(task.id);
    });
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => db.tasks.get(task.id)?.column === "ready");
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }

    const runs = db.runs.listForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("ready");
    expect(after.agent).toBe(idA);
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a Stop while the train is exhausted blocks no card and arms no retry", async () => {
    const idA = `stop-ex-a-${seq}`;
    const idB = `stop-ex-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "stop-exhausted", kind: "claude-code", members: [idA, idB] });
    stacks.harnessStacks.setLimitState(idB, {
      reason: "quota",
      resetAtMs: Date.now() + 120_000,
      message: "usage limit",
      source: "claude-pane",
    });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const prev = orch.__setHarnessSwapSettleHookForTest(async (_taskId, runId, phase) => {
      if (phase !== "before-block") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      await orch.cancelRun(runId);
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.tasks.get(task.id)?.column === "ready");
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
      stacks.harnessStacks.clearLimitState(idB);
    }

    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("ready");
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("an archive during the mirror/transfer never resurrects the swap", async () => {
    const idA = `arch-a-${seq}`;
    const idB = `arch-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "archive", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const prev = orch.__setHarnessSwapSettleHookForTest(async (archivedTaskId, _runId, phase) => {
      if (phase !== "after-transfer") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      db.tasks.update(archivedTaskId, { archivedAt: Date.now() });
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.tasks.get(task.id)?.archivedAt != null);
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }

    // The old run settles failed; the successor is never minted.
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    expect(db.tasks.get(task.id)?.agent).toBe(idA);
    expect(db.tasks.get(task.id)?.harnessState?.pendingSwap ?? null).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a pane limit passthrough drops the paused REPL session", async () => {
    const idA = `pane-pass-a-${seq}`;
    const idB = `pane-pass-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "pane-pass", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `pane limit ${FAKE_CLAUDE_LIMIT_PANE_PROMPT_MARKER}`);
    // The pane notice leaves the REPL parked; model that state explicitly.
    claude.__forTest.installSession(task.id, path.join(DATA_DIR, "pane-session.jsonl"));

    const prev = orch.__setHarnessLimitObservedHookForTest((observedTaskId) => {
      orch.__setHarnessLimitObservedHookForTest(null);
      expect(observedTaskId).toBe(task.id);
      // No swap target left when the settlement resolves (M1 window).
      stacks.harnessStacks.delete(stack.id);
    });
    try {
      await orch.startTask(task.id);
      await waitFor(() => db.runs.listForTask(task.id).every((r) => r.status !== "running"));
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
    }

    // The normal settle owns the run now; the paused session must not survive
    // to swallow the next message into a REPL waiting on a limit nobody will
    // continue.
    expect(claude.hasSessionState(task.id)).toBe(false);
  }, 15_000);

  test("a limit on a stack deleted mid-turn is recorded failed, never a false success", async () => {
    const idA = `gone-a-${seq}`;
    const idB = `gone-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "gone", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);

    const prev = orch.__setHarnessLimitObservedHookForTest((observedTaskId) => {
      orch.__setHarnessLimitObservedHookForTest(null);
      expect(observedTaskId).toBe(task.id);
      // The user deletes the stack while the limited turn is still settling,
      // so there is no swap target left when the done handler decides.
      stacks.harnessStacks.delete(stack.id);
    });
    try {
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await waitFor(() => {
        const rows = db.runs.listForTask(task.id);
        return rows.length > 0 && rows.every((r) => r.status !== "running");
      });
    } finally {
      orch.__setHarnessLimitObservedHookForTest(prev);
    }

    const runs = db.runs.listForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    const after = db.tasks.get(task.id)!;
    // The normal settle ran (no phantom review card); the account is unchanged
    // and no failover state survives the deleted stack.
    expect(after.column).toBe("ready");
    expect(after.agent).toBe(idA);
    expect(after.harnessState ?? null).toBeNull();
  }, 15_000);

  test("a refused archive keeps an armed failover retry and its lap state", async () => {
    const idA = `arch-refuse-a-${seq}`;
    const idB = `arch-refuse-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "arch-refuse", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "never runs");
    const now = Date.now();
    db.tasks.setHarnessState(task.id, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [idA],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: now + 60_000,
        earliestResetAtMs: null,
        reason: "quota",
      },
      lastMove: null,
    });
    failover.armAutoRetry(task.id, now + 60_000);
    expect(orch.hasPendingHarnessRetry(task.id)).toBe(true);

    // The card is not in Done, so the archive is refused — and a refused
    // archive must not cancel the retry or drop the exhausted countdown.
    const result = await orch.archiveTask(task.id);
    expect("error" in result).toBe(true);
    expect(db.tasks.get(task.id)!.archivedAt).toBeNull();
    expect(db.tasks.get(task.id)!.harnessState?.allExhausted).not.toBeNull();
    expect(orch.hasPendingHarnessRetry(task.id)).toBe(true);

    expect(orch.cancelHarnessRetryForTask(task.id)).toBe(true);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a one-member stack is inert: the limit settles normally with no retry", async () => {
    const idA = `solo-a-${seq}`;
    alias(idA, home(idA));
    const stack = stacks.harnessStacks.create({ label: "solo", kind: "claude-code", members: [idA] });
    const task = makeTask(idA, `limit ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`);
    await orch.startTask(task.id);
    await waitFor(() => db.tasks.get(task.id)?.column !== "running");

    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("ready");
    expect(after.harnessState?.allExhausted ?? null).toBeNull();
    expect(after.harnessState?.pendingSwap ?? null).toBeNull();
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("only Claude's synthetic api-error status is classified from raw text", () => {
    // The classifier itself would flag all of these — that is why the gate
    // must keep arbitrary status prose (a compaction/background summary, an
    // account label) away from it. A false positive swaps/duplicates work.
    expect(classifyHarnessLimitSignal("claude-code", { text: "Compaction done · 92% of your usage limit used" })).not.toBeNull();
    expect(classifyHarnessLimitSignal("claude-code", { text: "Rate Limit Test account is ready" })).not.toBeNull();

    expect(
      orch.isRawTextLimitChunk("claude-code", "status", "Compaction done · 92% of your usage limit used"),
    ).toBe(false);
    expect(orch.isRawTextLimitChunk("claude-code", "status", "Rate Limit Test account is ready")).toBe(false);
    expect(
      orch.isRawTextLimitChunk("claude-code", "status", "api error: HTTP 429 Too Many Requests"),
    ).toBe(true);
    // Codex's error vocabulary is a genuine error body and remains eligible.
    expect(orch.isRawTextLimitChunk("codex", "stderr", "rate_limit_exceeded")).toBe(true);
    expect(orch.isRawTextLimitChunk("codex", "status", "usage_limit_exceeded")).toBe(true);
    // A non-error Claude stream is never classified.
    expect(orch.isRawTextLimitChunk("claude-code", "assistant", "api error: HTTP 429")).toBe(false);
  });
});

// Review S2/S3: the explicit same-stack account switch is awaited by the PATCH
// route, records a `manual-switch` move (not "the previous account left"), and
// holds the task's start claim for the whole transcript copy so a Run or a
// message cannot touch the old account's still-live REPL.
describe("manual same-stack account switch", () => {
  test("records lastMove reason manual-switch and copies the conversation", async () => {
    const idA = `manual-a-${seq}`;
    const idB = `manual-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "manual", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "manual switch");
    seedPriorConversation(task, idA, "11111111-1111-4111-8111-111111111111");

    const before = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: idB });
    const after = db.tasks.get(task.id)!;

    await orch.reconcileTaskSession(task.id, before, after);

    const state = db.tasks.get(task.id)!.harnessState;
    expect(state?.lastMove).toMatchObject({ from: idA, to: idB, reason: "manual-switch" });
    // The conversation genuinely moved: the handoff is what a later resume reads.
    expect(db.harnessSessionHandoffs.get(task.id, idB, "claude_session_id")?.sessionId)
      .toBe("11111111-1111-4111-8111-111111111111");
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("records manual-switch even when the task has no recorded session (review S2)", async () => {
    const idA = `manual-nosession-a-${seq}`;
    const idB = `manual-nosession-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "manual-nosession", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "manual switch without a session");
    // Nothing ran on the old account: there is no transcript to copy, but the
    // user still made a manual move inside the stack.
    expect(db.runs.listForTask(task.id)).toHaveLength(0);

    const before = db.tasks.get(task.id)!;
    db.tasks.update(task.id, { agent: idB });
    const after = db.tasks.get(task.id)!;

    await orch.reconcileTaskSession(task.id, before, after);

    const state = db.tasks.get(task.id)!.harnessState;
    expect(state).not.toBeNull();
    expect(state?.lastMove).toMatchObject({ from: idA, to: idB, reason: "manual-switch" });
    expect(state?.pendingSwap ?? null).toBeNull();
    expect(db.harnessSessionHandoffs.get(task.id, idB, "claude_session_id")).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);

  test("a held switch claim refuses a Run and a message, then clears", async () => {
    const idA = `hold-a-${seq}`;
    const idB = `hold-b-${seq}`;
    alias(idA, home(idA));
    alias(idB, home(idB));
    const stack = stacks.harnessStacks.create({ label: "hold", kind: "claude-code", members: [idA, idB] });
    const task = makeTask(idA, "hold");

    // A run row so `sendInput` has something to address (it declines before
    // dispatching into any driver).
    const runId = randomUUID();
    db.runs.insert({
      id: runId,
      taskId: task.id,
      agent: idA,
      status: "succeeded",
      startedAt: Date.now() - 1_000,
      endedAt: Date.now() - 900,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
    } as never);
    db.tasks.update(task.id, { runId, column: "review" });

    expect(orch.claimTaskForAccountSwitch(task.id)).toBe(true);
    // A second switch cannot steal the claim.
    expect(orch.claimTaskForAccountSwitch(task.id)).toBe(false);
    const started = await orch.startTask(task.id);
    expect("error" in started && started.error).toContain("switching accounts");
    const sent = await orch.sendInput(runId, "hello during the copy", { bounded: false });
    expect(sent.delivered).toBe(false);
    if (!sent.delivered) expect(sent.reason).toContain("switching accounts");

    orch.releaseTaskAccountSwitch(task.id);
    // After release the claim is free again; nothing is left gate-closed.
    expect(orch.claimTaskForAccountSwitch(task.id)).toBe(true);
    orch.releaseTaskAccountSwitch(task.id);
    stacks.harnessStacks.delete(stack.id);
  }, 15_000);
});
