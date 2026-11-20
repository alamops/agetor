// The Claude Code login pre-flight through the real Start entry point
// (`startTask`), docs/plans/claude-enter-to-confirm-prompts.md SC9 / T3 / T7,
// owner decisions D5–D7. A stub `claude` answers `claude auth status` from
// marker files in the account's CLAUDE_CONFIG_DIR, so each account's login
// state is scripted; the fake driver runs the turn, so no real CLI or tmux is
// touched.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-claude-login-preflight-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// `bun test` runs every file in one process: restore every env var in afterAll.
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** What the logged-out JSON carries besides `loggedIn` (the real one has the
 *  account's email and org); none of it may reach an error or a status line. */
const ACCOUNT_EMAIL = "someone-private@example.invalid";

const binDir = mkdtempSync(path.join(tmpdir(), "agetor-claude-login-bin-"));
const stub = (name: string, body: string): string => {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = stub("tmux", "exit 1");
process.env.AGETOR_CLAUDE_BIN = stub(
  "claude",
  [
    `if [ "$1" = "--version" ]; then echo "2.1.326 (Claude Code)"; exit 0; fi`,
    `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then`,
    `  if [ -f "$CLAUDE_CONFIG_DIR/UNKNOWN" ]; then echo "Welcome to Claude Code"; exit 0; fi`,
    `  if [ -f "$CLAUDE_CONFIG_DIR/LOGGED_OUT" ]; then echo '{"loggedIn": false, "authMethod": "none", "email": "${ACCOUNT_EMAIL}"}'; exit 1; fi`,
    `  echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "${ACCOUNT_EMAIL}"}'; exit 0`,
    `fi`,
    `exit 1`,
  ].join("\n"),
);

let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");
let stacks: typeof import("./harness-stacks.ts");
let failover: typeof import("./harness-failover.ts");
let status: typeof import("./agent-status.ts");
let restore: () => void;
let seq = 0;
const taskIds: string[] = [];

beforeAll(async () => {
  db = await import("./db.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  status = await import("./agent-status.ts");
});

beforeEach(() => {
  // Each test scripts its accounts from scratch: no login answer carries over.
  status.__testing.clearStatusCache();
});

afterAll(async () => {
  for (const id of taskIds) {
    const state = db.tasks.get(id)?.harnessState;
    if (state?.allExhausted || state?.pendingSwap) db.tasks.setHarnessState(id, { ...state, allExhausted: null, pendingSwap: null });
  }
  failover.stopAllAutoRetryTimers();
  status.__testing.clearStatusCache();
  restore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(binDir, { recursive: true, force: true });
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

type LoginState = "in" | "out" | "unknown";

/** A Claude Code account whose `claude auth status` answers `login`. Its
 *  `.claude.json` exists, so the probe really runs (agent-status.ts never
 *  probes a config dir claude has not created). */
function account(login: LoginState): { id: string; home: string; set: (l: LoginState) => void } {
  const id = `login-${++seq}`;
  const home = path.join(DATA_DIR, "harnesses", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "{}");
  writeFileSync(path.join(home, ".claude.json"), "{}");
  db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
  const set = (l: LoginState): void => {
    for (const marker of ["LOGGED_OUT", "UNKNOWN"]) {
      try { unlinkSync(path.join(home, marker)); } catch { /* not there */ }
    }
    if (l === "out") writeFileSync(path.join(home, "LOGGED_OUT"), "");
    if (l === "unknown") writeFileSync(path.join(home, "UNKNOWN"), "");
  };
  set(login);
  return { id, home, set };
}

function makeTask(agent: string): Task {
  const id = randomUUID();
  const workdir = path.join(DATA_DIR, "work", `${++seq}`);
  mkdirSync(workdir, { recursive: true });
  db.tasks.insert({
    id, title: "login", prompt: "do it", agent, workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: "sonnet-4.6", effort: "high", speed: "off", maxMode: false,
    opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
    column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
  } as never);
  taskIds.push(id);
  return db.tasks.get(id)!;
}

async function waitFor(fn: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(15);
  }
  throw new Error("timed out");
}

/** Let the fake turn finish so no run is still live when the next test starts. */
async function settled(taskId: string): Promise<void> {
  await waitFor(() => db.runs.listForTask(taskId).length > 0 && db.runs.listForTask(taskId).every((r) => r.status !== "running"));
}

function statusLines(runId: string): string[] {
  return db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}

describe("Start pre-flight: claude auth status", () => {
  test("a logged-out account is refused with the login hint, nothing runs, and logging in makes the next Start go through", async () => {
    const a = account("out");
    const task = makeTask(a.id);
    const refused = await orch.startTask(task.id);
    expect(refused).toEqual({ error: `${a.id} isn't logged in — ${status.CLAUDE_LOGIN_HINT}` });
    // Only `loggedIn` is read from the probe's output.
    expect(JSON.stringify(refused)).not.toContain(ACCOUNT_EMAIL);
    const after = db.tasks.get(task.id)!;
    expect(after.column).toBe("ready");
    expect(after.runId).toBeNull();
    expect(db.runs.listForTask(task.id)).toHaveLength(0);

    // The user runs `claude auth login` and clicks Start again at once: the
    // refusal above cached "logged out", but a Start always re-probes.
    a.set("in");
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await settled(task.id);
    expect(db.runs.listForTask(task.id)).toHaveLength(1);
  }, 20_000);

  test("an unknown login state (the probe printed no JSON) never blocks a Start: fail-open", async () => {
    const a = account("unknown");
    const task = makeTask(a.id);
    const started = await orch.startTask(task.id);
    expect(started).toHaveProperty("runId");
    await settled(task.id);
    expect(db.runs.listForTask(task.id)[0]!.agent).toBe(a.id);
  }, 20_000);
});

describe("Start pre-flight on a harness stack", () => {
  test("a current account that logged out since the stack's login cache was warmed moves to the backup, and the run says why, once", async () => {
    const a = account("in");
    const b = account("in");
    const stack = stacks.harnessStacks.create({ label: "login-move", kind: "claude-code", members: [a.id, b.id] });
    try {
      const task = makeTask(a.id);
      // The stack planner reads the warmed (cached) login state: A was logged in.
      await status.refreshClaudeAuth([db.harnesses.get(a.id)!, db.harnesses.get(b.id)!]);
      expect(status.peekClaudeLoggedIn(db.harnesses.get(a.id)!)).toBe(true);
      // A logs out before the Start; only the Start's fresh probe can see it.
      a.set("out");

      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      if (!("runId" in started)) return;
      await settled(task.id);

      const final = db.tasks.get(task.id)!;
      expect(final.agent).toBe(b.id);
      const runs = db.runs.listForTask(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.agent).toBe(b.id);
      // Why the task left A: the pre-flight failure itself, exactly once (no
      // second "skipped A: not logged in" line for the same account).
      const lines = statusLines(started.runId);
      const aboutA = lines.filter((l) => l.includes(a.id) && /logged in/.test(l));
      expect(aboutA).toEqual([`${a.id} isn't logged in — ${status.CLAUDE_LOGIN_HINT}`]);
      expect(lines.join("\n")).not.toContain(ACCOUNT_EMAIL);
    } finally {
      stacks.harnessStacks.delete(stack.id);
    }
  }, 20_000);

  test("every account in the stack logged out: the Start is refused with the login hint and nothing runs", async () => {
    const a = account("out");
    const b = account("out");
    const stack = stacks.harnessStacks.create({ label: "login-none", kind: "claude-code", members: [a.id, b.id] });
    try {
      const task = makeTask(a.id);
      const refused = await orch.startTask(task.id);
      expect("error" in refused).toBe(true);
      if (!("error" in refused)) return;
      expect(refused.error).toContain("not logged in");
      expect(refused.error).toContain("claude auth login");
      expect(refused.error).not.toContain(ACCOUNT_EMAIL);
      expect(db.runs.listForTask(task.id)).toHaveLength(0);
      expect(db.tasks.get(task.id)!.column).toBe("ready");
    } finally {
      stacks.harnessStacks.delete(stack.id);
    }
  }, 20_000);

  test("a current account the cache still says is logged out, but that the user just logged in to, is not left", async () => {
    const a = account("out");
    const b = account("in");
    const stack = stacks.harnessStacks.create({ label: "login-stale", kind: "claude-code", members: [a.id, b.id] });
    try {
      const task = makeTask(a.id);
      // The /harnesses poll cached A as logged out (60 s TTL)…
      await status.refreshClaudeAuth([db.harnesses.get(a.id)!, db.harnesses.get(b.id)!]);
      expect(status.peekClaudeLoggedIn(db.harnesses.get(a.id)!)).toBe(false);
      // …then the user ran `claude auth login` for A and pressed Start.
      a.set("in");
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await settled(task.id);
      expect(db.tasks.get(task.id)!.agent).toBe(a.id);
      expect(db.runs.listForTask(task.id)[0]!.agent).toBe(a.id);
    } finally {
      stacks.harnessStacks.delete(stack.id);
    }
  }, 20_000);

  test("after an all-logged-out refusal, logging in and pressing Start again at once goes through", async () => {
    const a = account("out");
    const b = account("out");
    const stack = stacks.harnessStacks.create({ label: "login-retry", kind: "claude-code", members: [a.id, b.id] });
    try {
      const task = makeTask(a.id);
      const refused = await orch.startTask(task.id);
      expect("error" in refused).toBe(true);
      // The refusal cached "logged out" for both accounts. The user logs in to
      // the task's account and clicks Start within the cache's 15 s.
      expect(status.peekClaudeLoggedIn(db.harnesses.get(a.id)!)).toBe(false);
      a.set("in");
      const started = await orch.startTask(task.id);
      expect(started).toHaveProperty("runId");
      await settled(task.id);
      expect(db.tasks.get(task.id)!.agent).toBe(a.id);
      expect(db.runs.listForTask(task.id)[0]!.agent).toBe(a.id);
    } finally {
      stacks.harnessStacks.delete(stack.id);
    }
  }, 20_000);
});
