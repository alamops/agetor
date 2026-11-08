// Provider-session transfer (T05/T12): Claude transcript + sidecars, Codex
// rollout, handoff recording, cleanup and unsafe-source refusal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-session-transfer-"));

type Db = typeof import("./db.ts");
let dbm: Db;
let transfer: typeof import("./harness-session-transfer.ts");
let claudeTmux: typeof import("./claude-tmux.ts");
let restore: () => void;

beforeAll(async () => {
  dbm = await import("./db.ts");
  transfer = await import("./harness-session-transfer.ts");
  claudeTmux = await import("./claude-tmux.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restore = snapshotHarnessState();
});

afterAll(() => restore());

let seq = 0;
function alias(kind: "claude-code" | "codex"): { id: string; home: string } {
  seq++;
  const id = `${kind === "codex" ? "ctx" : "clt"}-${seq}`;
  const home = mkdtempSync(path.join(tmpdir(), `agetor-${id}-`));
  dbm.harnesses.insert({ id, kind, label: id, home, env: {} } as never);
  return { id, home };
}

function seedTask(taskId: string): string {
  dbm.tasks.insert({
    id: taskId,
    title: "xfer",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
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
  } as never);
  return taskId;
}

function write(p: string, text = "x"): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}

describe("claudeSessionTransfer", () => {
  test("copies the transcript + sidecars, records a handoff and cleans up", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-task-cwd";
    const column = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const src = path.join(from.home, "projects", column, `${sessionId}.jsonl`);
    write(src, "transcript");
    write(path.join(from.home, "projects", column, sessionId, "subagents", "a.jsonl"), "sub");

    const taskId = seedTask(`task-${seq}`);
    const result = await transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dest = path.join(to.home, "projects", column, `${sessionId}.jsonl`);
    expect(readFileSync(dest, "utf8")).toBe("transcript");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(to.home, "projects", column, sessionId, "subagents", "a.jsonl"))).toBe(true);

    const handoff = dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id");
    expect(handoff?.sessionId).toBe(sessionId);
    expect(handoff?.copiedPaths.length).toBeGreaterThan(0);

    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(dest)).toBe(false);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });

  test("an env CLAUDE_CONFIG_DIR override is the transfer root, not the home field", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const fromRoot = mkdtempSync(path.join(tmpdir(), "agetor-xfer-env-from-"));
    const toRoot = mkdtempSync(path.join(tmpdir(), "agetor-xfer-env-to-"));
    dbm.harnesses.update(from.id, { env: { CLAUDE_CONFIG_DIR: fromRoot } });
    dbm.harnesses.update(to.id, { env: { CLAUDE_CONFIG_DIR: toRoot } });
    const cwd = "/tmp/agetor-env-cwd";
    const column = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "44444444-4444-4444-8444-444444444444";
    // `harnessEnv` layers the env map over the home-derived CLAUDE_CONFIG_DIR,
    // so the CLI reads from here. The transfer must agree, not use `home`.
    write(path.join(fromRoot, "projects", column, `${sessionId}.jsonl`), "env transcript");
    const taskId = seedTask(`task-env-${seq}`);
    const result = await transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(toRoot, "projects", column, `${sessionId}.jsonl`), "utf8")).toBe("env transcript");
    expect(existsSync(path.join(to.home, "projects", column, `${sessionId}.jsonl`))).toBe(false);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a symlinked projects parent is unsafe-source, never read through", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-linked-parent";
    const column = claudeTmux.encodeProjectPath(cwd);
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-xfer-parent-"));
    const sessionId = "33333333-3333-4333-8333-333333333333";
    write(path.join(outside, "projects", column, `${sessionId}.jsonl`), "outside transcript");
    // The leaf looks like a regular file inside the account when only the
    // final component is lstat'd; the linked `projects/` parent is the escape.
    symlinkSync(path.join(outside, "projects"), path.join(from.home, "projects"));

    const result = await transfer.claudeSessionTransfer.transfer({
      taskId: seedTask(`task-parent-${seq}`),
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-source");
    expect(existsSync(path.join(to.home, "projects", column, `${sessionId}.jsonl`))).toBe(false);
  });

  test("maps a missing transcript to no-session and a symlink to unsafe-source", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-missing";
    const missing = await transfer.claudeSessionTransfer.transfer({
      taskId: `task-${seq}`,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: "missing",
      cwd,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("no-session");

    const column = claudeTmux.encodeProjectPath(cwd);
    const real = path.join(from.home, "projects", column, "real.jsonl");
    write(real, "x");
    const link = path.join(from.home, "projects", column, "linked.jsonl");
    symlinkSync(real, link);
    const unsafe = await transfer.claudeSessionTransfer.transfer({
      taskId: `task-${seq}`,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: "linked",
      cwd,
    });
    expect(unsafe.ok).toBe(false);
    if (unsafe.ok) return;
    expect(unsafe.reason).toBe("unsafe-source");
  });
});

describe("codexSessionTransfer", () => {
  test("finds and copies a rollout by thread id and records the handoff", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const thread = "22222222-2222-4222-8222-222222222222";
    const rel = path.join("sessions", "2026", "11", "06", `rollout-2026-11-06T00-00-00-${thread}.jsonl`);
    write(path.join(from.home, ".codex", rel), "rollout");
    const taskId = seedTask(`task-codex-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(to.home, ".codex", rel), "utf8")).toBe("rollout");
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "codex_session_id")?.sessionId).toBe(thread);
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(path.join(to.home, ".codex", rel))).toBe(false);
  });

  test("an env CODEX_HOME override is the transfer root, not <home>/.codex", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const fromRoot = mkdtempSync(path.join(tmpdir(), "agetor-xfer-codex-env-from-"));
    const toRoot = mkdtempSync(path.join(tmpdir(), "agetor-xfer-codex-env-to-"));
    dbm.harnesses.update(from.id, { env: { CODEX_HOME: fromRoot } });
    dbm.harnesses.update(to.id, { env: { CODEX_HOME: toRoot } });
    const thread = "55555555-5555-4555-8555-555555555555";
    const rel = path.join("sessions", "2026", "11", "07", `rollout-2026-11-07T00-00-00-${thread}.jsonl`);
    write(path.join(fromRoot, rel), "env rollout");
    const taskId = seedTask(`task-codex-env-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(toRoot, rel), "utf8")).toBe("env rollout");
    expect(existsSync(path.join(to.home, ".codex", rel))).toBe(false);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a missing rollout is no-session", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const result = await transfer.codexSessionTransfer.transfer({
      taskId: `task-codex-missing-${seq}`,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: "nope",
      cwd: "/tmp/x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-session");
  });
});

describe("codex rollout projection migration (T12)", () => {
  /** A destination account whose `codex` binary is a shell script, so the
   *  migration branch can be observed without the real CLI. */
  function codexAccountWithBin(home: string, bin: string, env: Record<string, string> = {}): string {
    seq++;
    const id = `ctx-bin-${seq}`;
    dbm.harnesses.insert({ id, kind: "codex", label: id, home, env, bin } as never);
    return id;
  }

  function fakeCodex(body: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-fake-codex-"));
    const bin = path.join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  function seedRollout(fromHome: string, thread: string): void {
    write(
      path.join(fromHome, ".codex", "sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${thread}.jsonl`),
      "rollout",
    );
  }

  test("runs codex migrate-rollouts against the destination CODEX_HOME when a stale projection exists (Q2)", async () => {
    const from = alias("codex");
    const toHome = mkdtempSync(path.join(tmpdir(), "agetor-xfer-migrate-to-"));
    const marker = path.join(toHome, "migration.log");
    const bin = fakeCodex(`printf '%s\\n%s\\n' "$CODEX_HOME" "$*" > "${marker}"`);
    const toId = codexAccountWithBin(toHome, bin, { CODEX_HOME: toHome });
    const thread = "66666666-6666-4666-8666-666666666666";
    seedRollout(from.home, thread);
    // The destination already holds a projection DB from another thread; the
    // copied rollout may otherwise be shadowed by it.
    write(path.join(toHome, "thread_history_1.sqlite"), "sqlite");

    const taskId = seedTask(`task-codex-migrate-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(toId)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A successful migration is silent; the rollout transfer is the result.
    expect(result.warnings ?? []).toEqual([]);
    // The migration ran exactly once, against the account's own CODEX_HOME
    // root, with the --apply flag.
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([toHome, "migrate-rollouts --apply"]);
    expect(dbm.harnessSessionHandoffs.get(taskId, toId, "codex_session_id")?.sessionId).toBe(thread);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a failing migration keeps the transfer and surfaces the exit code as a warning", async () => {
    const from = alias("codex");
    const toHome = mkdtempSync(path.join(tmpdir(), "agetor-xfer-migrate-fail-"));
    const bin = fakeCodex("exit 9");
    const toId = codexAccountWithBin(toHome, bin);
    const thread = "77777777-7777-4777-8777-777777777777";
    seedRollout(from.home, thread);
    write(path.join(toHome, ".codex", "thread_history_1.sqlite"), "sqlite");

    const taskId = seedTask(`task-codex-migrate-fail-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(toId)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });

    // The rollout is on disk, so the conversation is transferable; the
    // projection is just stale. The caller sees the warning on the status line.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual(["codex migrate-rollouts exited 9"]);
    expect(dbm.harnessSessionHandoffs.get(taskId, toId, "codex_session_id")?.sessionId).toBe(thread);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a migration that cannot spawn is a warning, not a lost conversation", async () => {
    const from = alias("codex");
    const toHome = mkdtempSync(path.join(tmpdir(), "agetor-xfer-migrate-missing-"));
    const missing = path.join(mkdtempSync(path.join(tmpdir(), "agetor-missing-bin-")), "codex");
    const toId = codexAccountWithBin(toHome, missing);
    const thread = "88888888-8888-4888-8888-888888888888";
    seedRollout(from.home, thread);
    write(path.join(toHome, ".codex", "thread_history_1.sqlite"), "sqlite");

    const taskId = seedTask(`task-codex-migrate-missing-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(toId)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings?.[0]?.startsWith("codex migrate-rollouts could not run:")).toBe(true);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a destination without a projection database runs no migration process", async () => {
    const from = alias("codex");
    const toHome = mkdtempSync(path.join(tmpdir(), "agetor-xfer-migrate-absent-"));
    const marker = path.join(toHome, "should-not-exist.log");
    const bin = fakeCodex(`printf ran > "${marker}"`);
    const toId = codexAccountWithBin(toHome, bin);
    const thread = "99999999-9999-4999-8999-999999999999";
    seedRollout(from.home, thread);

    const taskId = seedTask(`task-codex-migrate-absent-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(toId)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings ?? []).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });
});

describe("hasPriorSessionForHarness", () => {
  function seedRun(taskId: string, agent: string, sessionId: string | null, startedAt = Date.now()): string {
    const id = randomUUID();
    dbm.runs.insert({
      id,
      taskId,
      agent,
      status: "succeeded",
      startedAt,
      endedAt: startedAt + 1,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: sessionId,
      codexSessionId: null,
      cursorSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
    } as never);
    return id;
  }

  test("only an earlier run on the same account counts (the settling run is excluded)", () => {
    const account = alias("claude-code");
    const taskId = seedTask(`task-prior-${seq}`);
    const current = seedRun(taskId, account.id, "sess-current");
    // The settling run's own freshly-minted id is not a conversation yet.
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", account.id, current)).toBe(false);
    seedRun(taskId, account.id, "sess-earlier", Date.now() - 1_000);
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", account.id, current)).toBe(true);
  });

  test("a different account's session does not count", () => {
    const a = alias("claude-code");
    const b = alias("claude-code");
    const taskId = seedTask(`task-prior-other-${seq}`);
    const current = seedRun(taskId, a.id, null);
    seedRun(taskId, b.id, "sess-b", Date.now() - 1_000);
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", a.id, current)).toBe(false);
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", b.id, current)).toBe(true);
  });

  test("a legacy bare-kind run resolves to the built-in account", () => {
    const taskId = seedTask(`task-prior-legacy-${seq}`);
    const current = seedRun(taskId, "claude-code", "sess-legacy", Date.now() - 1_000);
    const built = dbm.harnesses.getByIdOrKind("claude-code");
    if (!built) return;
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", built.id, "other-run")).toBe(true);
    expect(transfer.hasPriorSessionForHarness(taskId, "claude_session_id", built.id, current)).toBe(false);
  });
});

describe("cleanupHarnessSessionCopiesForHarness", () => {
  test("collect is read-only and remove runs only after a successful delete (R13-S2)", () => {
    const to = alias("claude-code");
    const taskId = seedTask(`task-collect-${seq}`);
    const inside = path.join(to.home, "projects", "p", "collect.jsonl");
    write(inside, "{}\n");
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: to.id,
      columnName: "claude_session_id",
      sessionId: "collect",
      copiedPaths: [inside],
      createdAt: Date.now(),
    });

    const copies = transfer.collectHarnessSessionCopies(to.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.root).toBe(to.home);
    // Capturing must not touch disk or the allowlist: a refused harness delete
    // (409/built-in) leaves a live task's conversation resumable.
    expect(existsSync(inside)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).not.toBeNull();

    transfer.removeHarnessSessionCopies(copies);
    expect(existsSync(inside)).toBe(false);
    // Removal is the caller's separate step; the row is dropped by the row
    // delete (or by `cleanupHarnessSessionCopiesForHarness`).
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).not.toBeNull();
    dbm.harnessSessionHandoffs.deleteForHarness(to.id);
  });

  test("deletes copied files for the destination account, inside its root only", async () => {
    const to = alias("claude-code");
    const taskId = seedTask(`task-harness-delete-${seq}`);
    const inside = path.join(to.home, "projects", "p", "s.jsonl");
    write(inside, "{}\n");
    const outsideDir = mkdtempSync(path.join(tmpdir(), "agetor-outside-"));
    const outside = path.join(outsideDir, "keep.jsonl");
    write(outside, "keep\n");
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: to.id,
      columnName: "claude_session_id",
      sessionId: "s",
      copiedPaths: [inside, outside],
      createdAt: Date.now(),
    });
    await transfer.cleanupHarnessSessionCopiesForHarness(to.id);
    expect(existsSync(inside)).toBe(false);
    // A path outside the destination root is never removed.
    expect(existsSync(outside)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });
});
