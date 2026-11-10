// Provider-session transfer (T05/T12): Claude transcript + sidecars, Codex
// rollout, handoff recording, cleanup and unsafe-source refusal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-session-transfer-"));

type Db = typeof import("./db.ts");
let dbm: Db;
let transfer: typeof import("./harness-session-transfer.ts");
let claudeTmux: typeof import("./claude-tmux.ts");
let fileTransfer: typeof import("./harness-file-transfer.ts");
let restore: () => void;

beforeAll(async () => {
  dbm = await import("./db.ts");
  transfer = await import("./harness-session-transfer.ts");
  claudeTmux = await import("./claude-tmux.ts");
  fileTransfer = await import("./harness-file-transfer.ts");
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

  test("an account with only an env-map HOME migrates <HOME>/.codex, never the real ~/.codex (review R-S11)", async () => {
    const from = alias("codex");
    const envHome = mkdtempSync(path.join(tmpdir(), "agetor-xfer-migrate-envhome-"));
    const codexHome = path.join(envHome, ".codex");
    const marker = path.join(envHome, "migration.log");
    const bin = fakeCodex(`printf '%s\\n' "$CODEX_HOME" > "${marker}"`);
    seq++;
    const toId = `ctx-envhome-${seq}`;
    dbm.harnesses.insert({ id: toId, kind: "codex", label: toId, home: null, env: { HOME: envHome }, bin } as never);
    const thread = "abababab-abab-4bab-8bab-abababababab";
    seedRollout(from.home, thread);
    write(path.join(codexHome, "thread_history_1.sqlite"), "sqlite");
    // The account's root falls back to the process CODEX_HOME when one is set;
    // clear it so the env-map HOME decides, and restore it afterwards.
    const savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      const taskId = seedTask(`task-codex-migrate-envhome-${seq}`);
      const result = await transfer.codexSessionTransfer.transfer({
        taskId,
        fromHarness: dbm.harnesses.get(from.id)!,
        toHarness: dbm.harnesses.get(toId)!,
        sessionId: thread,
        cwd: "/tmp/x",
      });
      expect(result.ok).toBe(true);
      expect(existsSync(path.join(codexHome, "sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${thread}.jsonl`)))
        .toBe(true);
      // Before the fix the envelope was empty for this shape, so the child saw
      // no CODEX_HOME at all and codex migrated the user's real ~/.codex.
      expect(readFileSync(marker, "utf8").trim()).toBe(codexHome);
      await transfer.cleanupHarnessSessionCopies(taskId);
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
    }
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

describe("collectHarnessSessionCopies / removeHarnessSessionCopies (harness delete)", () => {
  test("collect is read-only and remove runs only after a successful delete (R13-S2)", async () => {
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
    expect(copies[0]!.kind).toBe("claude-code");
    // Capturing must not touch disk or the allowlist: a refused harness delete
    // (409/built-in) leaves a live task's conversation resumable.
    expect(existsSync(inside)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).not.toBeNull();

    await transfer.removeHarnessSessionCopies(copies);
    expect(existsSync(inside)).toBe(false);
    // Removal is the caller's separate step; the row is dropped by the row
    // delete.
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).not.toBeNull();
    dbm.harnessSessionHandoffs.deleteForHarness(to.id);
  });

  test("deletes copied files for the destination account, inside its root and handoff shape only", async () => {
    const to = alias("claude-code");
    const codexTo = alias("codex");
    const taskId = seedTask(`task-harness-delete-${seq}`);
    const inside = path.join(to.home, "projects", "p", "s.jsonl");
    write(inside, "{}\n");
    const outsideDir = mkdtempSync(path.join(tmpdir(), "agetor-outside-"));
    const outside = path.join(outsideDir, "keep.jsonl");
    write(outside, "keep\n");
    // A planted row naming the account's own config is not a handoff shape.
    const settings = path.join(to.home, "settings.json");
    write(settings, "{}");
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: to.id,
      columnName: "claude_session_id",
      sessionId: "s",
      copiedPaths: [inside, outside, settings],
      createdAt: Date.now(),
    });
    const rollout = path.join(codexTo.home, ".codex", "sessions", "2026", "11", "08", "rollout-x-t.jsonl");
    const codexAuth = path.join(codexTo.home, ".codex", "auth.json");
    write(rollout, "rollout");
    write(codexAuth, "auth");
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: codexTo.id,
      columnName: "codex_session_id",
      sessionId: "t",
      copiedPaths: [rollout, codexAuth],
      createdAt: Date.now(),
    });

    await transfer.removeHarnessSessionCopies(transfer.collectHarnessSessionCopies(to.id));
    await transfer.removeHarnessSessionCopies(transfer.collectHarnessSessionCopies(codexTo.id));
    dbm.harnessSessionHandoffs.deleteForHarness(to.id);
    dbm.harnessSessionHandoffs.deleteForHarness(codexTo.id);

    expect(existsSync(inside)).toBe(false);
    expect(existsSync(rollout)).toBe(false);
    // A path outside the destination root is never removed…
    expect(existsSync(outside)).toBe(true);
    // …nor one inside it that a handoff never writes.
    expect(existsSync(settings)).toBe(true);
    expect(existsSync(codexAuth)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });
});

describe("transfer safety (review S5, S27, contract C5)", () => {
  test("an A→B→A wrap never records A's own original transcript for cleanup", async () => {
    const a = alias("claude-code");
    const b = alias("claude-code");
    const cwd = "/tmp/agetor-wrap";
    const enc = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "abababab-abab-4bab-8bab-abababababab";
    const aTranscript = path.join(a.home, "projects", enc, `${sessionId}.jsonl`);
    const aSidecar = path.join(a.home, "projects", enc, sessionId, "subagents", "agent.jsonl");
    write(aTranscript, "turn 1 on A\n");
    write(aSidecar, "A's subagent\n");
    const taskId = seedTask(`task-wrap-${seq}`);

    const toB = await transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(a.id)!,
      toHarness: dbm.harnesses.get(b.id)!,
      sessionId,
      cwd,
    });
    expect(toB.ok).toBe(true);
    if (!toB.ok) return;
    const bTranscript = path.join(b.home, "projects", enc, `${sessionId}.jsonl`);
    // B did not have these files: both are B's to clean up.
    expect(toB.copiedPaths.sort()).toEqual(
      [bTranscript, path.join(b.home, "projects", enc, sessionId, "subagents", "agent.jsonl")].sort(),
    );

    // B continues the conversation (and a new sidecar file), then wraps back.
    writeFileSync(bTranscript, "turn 1 on A\nturn 2 on B\n");
    write(path.join(b.home, "projects", enc, sessionId, "tool-results", "r.txt"), "B's result");
    const toA = await transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(b.id)!,
      toHarness: dbm.harnesses.get(a.id)!,
      sessionId,
      cwd,
    });
    expect(toA.ok).toBe(true);
    if (!toA.ok) return;
    // A's transcript was updated with B's turn…
    expect(readFileSync(aTranscript, "utf8")).toBe("turn 1 on A\nturn 2 on B\n");
    // …but A's original transcript and sidecar existed before the copy, so
    // they are not on A's cleanup allowlist; only the new sidecar file is.
    const aResult = path.join(a.home, "projects", enc, sessionId, "tool-results", "r.txt");
    expect(toA.copiedPaths).toEqual([aResult]);
    const handoffA = dbm.harnessSessionHandoffs.get(taskId, a.id, "claude_session_id");
    expect(handoffA?.copiedPaths).not.toContain(aTranscript);
    expect(handoffA?.copiedPaths).not.toContain(aSidecar);

    // Cleanup of the task removes copies, never A's own conversation.
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(readFileSync(aTranscript, "utf8")).toBe("turn 1 on A\nturn 2 on B\n");
    expect(existsSync(aSidecar)).toBe(true);
    expect(existsSync(aResult)).toBe(false);
    expect(existsSync(bTranscript)).toBe(false);
  });

  test("Codex: a rollout the destination already had is not recorded", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const thread = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const rel = path.join("sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${thread}.jsonl`);
    write(path.join(from.home, ".codex", rel), "from");
    write(path.join(to.home, ".codex", rel), "to's own");
    const taskId = seedTask(`task-codex-pre-${seq}`);
    const result = await transfer.codexSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.copiedPaths).toEqual([]);
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(readFileSync(path.join(to.home, ".codex", rel), "utf8")).toBe("from");
  });

  test("roots that alias each other through a symlink are refused by both adapters", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-alias";
    const enc = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    write(path.join(from.home, "projects", enc, `${sessionId}.jsonl`), "mine");
    const linkParent = mkdtempSync(path.join(tmpdir(), "agetor-xfer-alias-"));
    symlinkSync(from.home, path.join(linkParent, "home"));
    dbm.harnesses.update(to.id, { home: path.join(linkParent, "home") });
    const claude = await transfer.claudeSessionTransfer.transfer({
      taskId: seedTask(`task-alias-${seq}`),
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(claude.ok).toBe(false);
    if (claude.ok) return;
    expect(claude.reason).toBe("unsafe-source");
    expect(claude.message).toContain("share a config directory");

    const cfrom = alias("codex");
    const cto = alias("codex");
    const thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    write(path.join(cfrom.home, ".codex", "sessions", "2026", "11", "08", `rollout-x-${thread}.jsonl`), "r");
    const codexLinkParent = mkdtempSync(path.join(tmpdir(), "agetor-xfer-alias-codex-"));
    symlinkSync(path.join(cfrom.home, ".codex"), path.join(codexLinkParent, "codex-home"));
    dbm.harnesses.update(cto.id, { env: { CODEX_HOME: path.join(codexLinkParent, "codex-home") } });
    const codex = await transfer.codexSessionTransfer.transfer({
      taskId: seedTask(`task-alias-codex-${seq}`),
      fromHarness: dbm.harnesses.get(cfrom.id)!,
      toHarness: dbm.harnesses.get(cto.id)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });
    expect(codex.ok).toBe(false);
    if (codex.ok) return;
    expect(codex.message).toContain("share a CODEX_HOME");
  });

  test("symlinks inside the session sidecars are never copied or followed", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-sidecar-links";
    const enc = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    write(path.join(from.home, "projects", enc, `${sessionId}.jsonl`), "t");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-sidecar-outside-"));
    write(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
    write(path.join(outside, "dir", "inner.txt"), "OUTSIDE-DIR");
    const sub = path.join(from.home, "projects", enc, sessionId, "subagents");
    write(path.join(sub, "real.jsonl"), "real");
    symlinkSync(path.join(outside, "secret.txt"), path.join(sub, "file-link.jsonl"));
    symlinkSync(path.join(outside, "dir"), path.join(sub, "dir-link"));
    // A whole sidecar folder that is a symlink is refused too.
    symlinkSync(path.join(outside, "dir"), path.join(from.home, "projects", enc, sessionId, "tool-results"));

    const result = await transfer.claudeSessionTransfer.transfer({
      taskId: seedTask(`task-sidecar-links-${seq}`),
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(result.ok).toBe(true);
    const destSession = path.join(to.home, "projects", enc, sessionId);
    expect(readFileSync(path.join(destSession, "subagents", "real.jsonl"), "utf8")).toBe("real");
    expect(readdirSync(path.join(destSession, "subagents"))).toEqual(["real.jsonl"]);
    expect(existsSync(path.join(destSession, "tool-results"))).toBe(false);
    const leaked: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) leaked.push(abs);
        else if (st.isDirectory()) walk(abs);
        else if (/OUTSIDE-/.test(readFileSync(abs, "utf8"))) leaked.push(abs);
      }
    };
    walk(to.home);
    expect(leaked).toEqual([]);
  });

  test("a symlinked destination projects folder is never written through", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-dest-projects-link";
    const enc = claudeTmux.encodeProjectPath(cwd);
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    write(path.join(from.home, "projects", enc, `${sessionId}.jsonl`), "t");
    write(path.join(from.home, "projects", enc, sessionId, "subagents", "a.jsonl"), "a");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-dest-projects-outside-"));
    symlinkSync(outside, path.join(to.home, "projects"));
    const taskId = seedTask(`task-dest-link-${seq}`);

    const result = await transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId,
      cwd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-source");
    expect(readdirSync(outside)).toEqual([]);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });

  test("a session id that is not a plain file name is refused", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const cwd = "/tmp/agetor-bad-id";
    const enc = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", "x.jsonl"), "t");
    const result = await transfer.claudeSessionTransfer.transfer({
      taskId: seedTask(`task-bad-id-${seq}`),
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: `../../${enc}/x`,
      cwd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-source");
  });

  test("a Codex rollout outside the sessions/YYYY/MM/DD layout is refused (it could never be cleaned up)", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const thread = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    write(path.join(from.home, ".codex", "sessions", "odd", `rollout-x-${thread}.jsonl`), "r");
    const result = await transfer.codexSessionTransfer.transfer({
      taskId: seedTask(`task-codex-odd-${seq}`),
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: thread,
      cwd: "/tmp/x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-source");
    expect(existsSync(path.join(to.home, ".codex", "sessions", "odd"))).toBe(false);
  });
});

describe("transfer completeness and cleanup (fix round T4)", () => {
  const cwd = "/tmp/agetor-t4-cwd";
  const sid = "55555555-5555-4555-8555-555555555555";
  const run = (from: { id: string }, to: { id: string }, taskId: string, c = cwd, s = sid) =>
    transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: s,
      cwd: c,
    });

  test("a transcript over the old 64 MB cap copies, with file-history and sidecar warnings", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const src = path.join(from.home, "projects", column, `${sid}.jsonl`);
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, Buffer.alloc(65 * 1024 * 1024, 97));
    write(path.join(from.home, "file-history", sid, "abc@v1"), "checkpoint");
    write(path.join(from.home, "file-history", "other-sid", "zzz@v1"), "not mine");
    const taskId = seedTask(`t4-big-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(true);
    expect(statSync(path.join(to.home, "projects", column, `${sid}.jsonl`)).size).toBe(65 * 1024 * 1024);
    expect(readFileSync(path.join(to.home, "file-history", sid, "abc@v1"), "utf8")).toBe("checkpoint");
    expect(existsSync(path.join(to.home, "file-history", "other-sid"))).toBe(false);
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(path.join(to.home, "file-history", sid))).toBe(false);
    expect(existsSync(path.join(to.home, "file-history"))).toBe(true);
  });

  test("a transcript in a hashed (long-path) project dir is found by session id", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const hashed = `${"-x".repeat(100)}-epaaob`;
    write(path.join(from.home, "projects", hashed, `${sid}.jsonl`), "long");
    const taskId = seedTask(`t4-long-${seq}`);
    const result = await run(from, to, taskId, `/${"x/".repeat(150)}`);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(to.home, "projects", hashed, `${sid}.jsonl`), "utf8")).toBe("long");
  });

  test("a symlinked projects dir is refused before the leaf is stat'ed", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-t4-out-"));
    symlinkSync(outside, path.join(from.home, "projects"));
    const taskId = seedTask(`t4-link-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-source");
  });

  test("the destination paths are recorded before the copy, so a re-run after a crash still cleans up", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    const taskId = seedTask(`t4-crash-${seq}`);
    // Simulate the crash: the file exists at the destination, but no row.
    const dest = path.join(to.home, "projects", column, `${sid}.jsonl`);
    write(dest, "orphan");
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
    // A pre-recorded row (what the new code writes before copying) is enough.
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: sid, copiedPaths: [dest], createdAt: 0,
    });
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(dest)).toBe(false);
  });

  test("a changed account root keeps the row and warns; restoring the root cleans up", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    const taskId = seedTask(`t4-root-${seq}`);
    expect((await run(from, to, taskId)).ok).toBe(true);
    const dest = path.join(to.home, "projects", column, `${sid}.jsonl`);
    const other = mkdtempSync(path.join(tmpdir(), "agetor-t4-newroot-"));
    dbm.harnesses.update(to.id, { home: other });
    const warnings = await transfer.cleanupHarnessSessionCopies(taskId);
    expect(warnings.length).toBe(1);
    expect(existsSync(dest)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).not.toBeNull();
    dbm.harnesses.update(to.id, { home: to.home });
    expect(await transfer.cleanupHarnessSessionCopies(taskId)).toEqual([]);
    expect(existsSync(dest)).toBe(false);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });

  test("a symlinked projects dir on the DESTINATION is refused and nothing lands in its target", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    write(path.join(from.home, "file-history", sid, "abc@v1"), "c");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-t4-dest-out-"));
    symlinkSync(outside, path.join(to.home, "projects"));
    symlinkSync(outside, path.join(to.home, "file-history"));
    const taskId = seedTask(`t4-destlink-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-source");
    expect(readdirSync(outside)).toEqual([]);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
    expect(fileTransfer.destinationState(to.home, path.join(to.home, "file-history", sid, "abc@v1"))).toBe("unsafe");
    expect(await fileTransfer.planTreeDestinations(path.join(from.home, "file-history", sid), path.join(to.home, "file-history", sid), { root: to.home })).toEqual([]);
  });

  test("a pre-recorded (createdAt 0) row is never resumed; a superseded session is cleaned only after the new copy", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const taskId = seedTask(`t4-super-${seq}`);
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: sid, copiedPaths: [], createdAt: 0,
    });
    expect(transfer.findSessionIdForHarness(taskId, "claude_session_id", to.id)).toBeNull();

    const oldSid = "66666666-6666-4666-8666-666666666666";
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "old");
    expect((await run(from, to, taskId, cwd, oldSid)).ok).toBe(true);
    const oldDest = path.join(to.home, "projects", column, `${oldSid}.jsonl`);
    // New session whose source is missing: the transfer fails, the old copy stays.
    expect((await run(from, to, taskId)).ok).toBe(false);
    expect(existsSync(oldDest)).toBe(true);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "new");
    expect((await run(from, to, taskId)).ok).toBe(true);
    expect(existsSync(oldDest)).toBe(false);
    expect(readFileSync(path.join(to.home, "projects", column, `${sid}.jsonl`), "utf8")).toBe("new");
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a planted row naming another session's transcript deletes nothing", async () => {
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const victim = path.join(to.home, "projects", column, "99999999-9999-4999-8999-999999999999.jsonl");
    write(victim, "keep me");
    const taskId = seedTask(`t4-plant-${seq}`);
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: sid, copiedPaths: [victim], createdAt: 1,
    });
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });
});

describe("TT-B: fix-round transfer regressions", () => {
  const cwd = "/tmp/agetor-ttb-cwd";
  const sid = "77777777-7777-4777-8777-777777777777";
  const run = (from: { id: string }, to: { id: string }, taskId: string, s = sid) =>
    transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: s,
      cwd,
    });

  test("the destination paths are recorded BEFORE any byte is copied (createdAt 0), then re-stamped after", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    write(path.join(from.home, "projects", column, sid, "subagents", "agent-1.jsonl"), "sub");
    const taskId = seedTask(`ttb-pre-${seq}`);
    const dest = path.join(to.home, "projects", column, `${sid}.jsonl`);
    const store = dbm.harnessSessionHandoffs;
    const realUpsert = store.upsert.bind(store);
    const calls: { createdAt: number; paths: string[]; transcriptExisted: boolean; sidecarExisted: boolean }[] = [];
    store.upsert = ((h: Parameters<typeof realUpsert>[0]) => {
      calls.push({
        createdAt: h.createdAt,
        paths: [...h.copiedPaths],
        transcriptExisted: existsSync(dest),
        sidecarExisted: existsSync(path.join(to.home, "projects", column, sid)),
      });
      return realUpsert(h);
    }) as typeof store.upsert;
    try {
      expect((await run(from, to, taskId)).ok).toBe(true);
    } finally {
      store.upsert = realUpsert;
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0]!;
    expect(first).toMatchObject({ createdAt: 0, transcriptExisted: false, sidecarExisted: false });
    expect(first.paths).toContain(dest);
    expect(first.paths).toContain(path.join(to.home, "projects", column, sid, "subagents", "agent-1.jsonl"));
    expect(calls[calls.length - 1]!.createdAt).toBeGreaterThan(0);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a superseded session's copy survives a new transfer that fails at the copy step, and is removed once one succeeds", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const oldSid = "99999999-0000-4000-8000-000000000001";
    const taskId = seedTask(`ttb-super-${seq}`);
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "old");
    expect((await run(from, to, taskId, oldSid)).ok).toBe(true);
    const oldDest = path.join(to.home, "projects", column, `${oldSid}.jsonl`);
    // The new session's source exists but its destination path is a directory.
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "new");
    mkdirSync(path.join(to.home, "projects", column, `${sid}.jsonl`), { recursive: true });
    expect((await run(from, to, taskId)).ok).toBe(false);
    expect(readFileSync(oldDest, "utf8")).toBe("old");
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")?.sessionId).toBe(oldSid);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")?.copiedPaths).toContain(oldDest);
    // Clear the blocker: the retry succeeds and only then is the old copy removed.
    rmSync(path.join(to.home, "projects", column, `${sid}.jsonl`), { recursive: true });
    expect((await run(from, to, taskId)).ok).toBe(true);
    expect(existsSync(oldDest)).toBe(false);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a failed transcript copy rolls the pre-recorded row back, leaving nothing resumable", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    // The transcript's destination is a directory: the copy cannot land.
    mkdirSync(path.join(to.home, "projects", column, `${sid}.jsonl`), { recursive: true });
    const taskId = seedTask(`ttb-fail-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
    expect(transfer.findSessionIdForHarness(taskId, "claude_session_id", to.id)).toBeNull();
  });

  test("a sidecar entry that cannot be copied becomes a warning; the transfer still succeeds", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    write(path.join(from.home, "projects", column, sid, "subagents", "ok.jsonl"), "fine");
    const outside = path.join(from.home, "secret.txt");
    write(outside, "do not copy");
    symlinkSync(outside, path.join(from.home, "projects", column, sid, "subagents", "link.jsonl"));
    const taskId = seedTask(`ttb-warn-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings?.some((w) => w.includes("subagents") && w.includes("skipped"))).toBe(true);
    expect(existsSync(path.join(to.home, "projects", column, sid, "subagents", "link.jsonl"))).toBe(false);
    expect(readFileSync(path.join(to.home, "projects", column, sid, "subagents", "ok.jsonl"), "utf8")).toBe("fine");
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a sidecar tree whose copy throws is a warning, not a lost conversation", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    write(path.join(from.home, "file-history", sid, "abc@v1"), "checkpoint");
    // The destination file-history/<sid> exists as a FILE: the tree copy cannot create the directory.
    write(path.join(to.home, "file-history", sid), "in the way");
    const taskId = seedTask(`ttb-throw-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(path.join(to.home, "projects", column, `${sid}.jsonl`), "utf8")).toBe("t");
    expect(result.warnings?.some((w) => w.startsWith("file-history:"))).toBe(true);
    expect(readFileSync(path.join(to.home, "file-history", sid), "utf8")).toBe("in the way");
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a symlinked projects dir on the source is refused even when the transcript is reachable through it", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-ttb-src-out-"));
    write(path.join(outside, column, `${sid}.jsonl`), "reachable through the link");
    symlinkSync(outside, path.join(from.home, "projects"));
    const taskId = seedTask(`ttb-srclink-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-source");
    expect(existsSync(path.join(to.home, "projects"))).toBe(false);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
  });

  test("a symlinked project dir (not just projects/) on the source is refused too", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-ttb-proj-out-"));
    write(path.join(outside, `${sid}.jsonl`), "reachable");
    mkdirSync(path.join(from.home, "projects"), { recursive: true });
    symlinkSync(outside, path.join(from.home, "projects", column));
    const taskId = seedTask(`ttb-projlink-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["unsafe-source", "no-session"]).toContain(result.reason);
    expect(existsSync(path.join(to.home, "projects"))).toBe(false);
  });

  test("destination parents are walked per component: a symlinked <projects>/<project> is refused and nothing lands in its target", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    write(path.join(from.home, "projects", column, `${sid}.jsonl`), "t");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-ttb-dest-out-"));
    mkdirSync(path.join(to.home, "projects"), { recursive: true });
    symlinkSync(outside, path.join(to.home, "projects", column));
    const taskId = seedTask(`ttb-destcomp-${seq}`);
    const result = await run(from, to, taskId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-source");
    expect(readdirSync(outside)).toEqual([]);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
    expect(fileTransfer.destinationState(to.home, path.join(to.home, "projects", column, `${sid}.jsonl`))).toBe("unsafe");
  });

  test("cleanup removes sidecar files tied to the recorded session and nothing tied to another", async () => {
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const mine = path.join(to.home, "projects", column, sid, "subagents", "agent-1.jsonl");
    const mineHistory = path.join(to.home, "file-history", sid, "abc@v1");
    const otherSid = "88888888-8888-4888-8888-888888888888";
    const theirs = path.join(to.home, "projects", column, otherSid, "subagents", "agent-9.jsonl");
    const theirsHistory = path.join(to.home, "file-history", otherSid, "zzz@v1");
    for (const p of [mine, mineHistory, theirs, theirsHistory]) write(p, "x");
    const taskId = seedTask(`ttb-tie-${seq}`);
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: sid,
      copiedPaths: [mine, mineHistory, theirs, theirsHistory], createdAt: 1,
    });
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(mineHistory)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(theirsHistory)).toBe(true);
  });

  test("a planted row naming a non-handoff shape (settings.json, a path outside the root) deletes nothing", async () => {
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const settings = path.join(to.home, "settings.json");
    const outsideDir = mkdtempSync(path.join(tmpdir(), "agetor-ttb-plant-"));
    const outside = path.join(outsideDir, `${sid}.jsonl`);
    const nested = path.join(to.home, "projects", column, sid, "notes", "x.txt");
    for (const p of [settings, outside, nested]) write(p, "keep");
    const taskId = seedTask(`ttb-shape-${seq}`);
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: sid,
      copiedPaths: [settings, outside, nested], createdAt: 1,
    });
    await transfer.cleanupHarnessSessionCopies(taskId);
    for (const p of [settings, outside, nested]) expect(readFileSync(p, "utf8")).toBe("keep");
  });
});

describe("roots redirected into a macOS-protected folder (contract CR4, review R-S6)", () => {
  function protectedHome() {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-xfer-tcc-home-")));
    const documents = path.join(home, "Documents");
    mkdirSync(path.join(documents, "acct2"), { recursive: true });
    fileTransfer.setTccHomeForTests(home);
    return { documents, lock: () => chmodSync(documents, 0o000), unlock: () => chmodSync(documents, 0o700) };
  }

  test("Claude: a destination root swapped for a link into a protected folder is unsafe-source, nothing written", async () => {
    const { documents, lock, unlock } = protectedHome();
    try {
      const from = alias("claude-code");
      const to = alias("claude-code");
      const cwd = "/tmp/xfer-tcc";
      const sid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
      write(path.join(from.home, "projects", claudeTmux.encodeProjectPath(cwd), `${sid}.jsonl`), "transcript");
      const linked = path.join(mkdtempSync(path.join(tmpdir(), "agetor-xfer-tcc-link-")), "home");
      symlinkSync(path.join(documents, "acct2"), linked);
      dbm.harnesses.update(to.id, { home: linked });
      lock();
      const taskId = seedTask(`task-tcc-claude-${seq}`);
      const result = await transfer.claudeSessionTransfer.transfer({
        taskId,
        fromHarness: dbm.harnesses.get(from.id)!,
        toHarness: dbm.harnesses.get(to.id)!,
        sessionId: sid,
        cwd,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unsafe-source");
      expect(result.message).toContain("the destination account's config directory now resolves into the macOS-protected folder ~/Documents");
      expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeFalsy();
      unlock();
      expect(readdirSync(path.join(documents, "acct2"))).toEqual([]);
    } finally {
      unlock();
      fileTransfer.setTccHomeForTests(null);
    }
  });

  test("Codex: a source CODEX_HOME redirected into a protected folder is unsafe-source", async () => {
    const { documents, lock, unlock } = protectedHome();
    try {
      const from = alias("codex");
      const to = alias("codex");
      const thread = "efefefef-efef-4fef-8fef-efefefefefef";
      write(
        path.join(documents, "acct2", "sessions", "2026", "11", "08", `rollout-2026-11-08T00-00-00-${thread}.jsonl`),
        "rollout",
      );
      const linked = path.join(mkdtempSync(path.join(tmpdir(), "agetor-xfer-tcc-codex-")), "codex-home");
      symlinkSync(path.join(documents, "acct2"), linked);
      dbm.harnesses.update(from.id, { env: { CODEX_HOME: linked } });
      lock();
      const result = await transfer.codexSessionTransfer.transfer({
        taskId: seedTask(`task-tcc-codex-${seq}`),
        fromHarness: dbm.harnesses.get(from.id)!,
        toHarness: dbm.harnesses.get(to.id)!,
        sessionId: thread,
        cwd: "/tmp/x",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unsafe-source");
      expect(result.message).toContain("the source account's CODEX_HOME now resolves into the macOS-protected folder ~/Documents");
      expect(existsSync(path.join(to.home, ".codex", "sessions"))).toBe(false);
    } finally {
      unlock();
      fileTransfer.setTccHomeForTests(null);
    }
  });
});

describe("orphaned handoff copies (migration 088)", () => {
  const cwd = "/tmp/agetor-orphan-cwd";
  const oldSid = "88888888-0000-4000-8000-000000000001";
  const newSid = "88888888-0000-4000-8000-000000000002";
  const run = (from: { id: string }, to: { id: string }, taskId: string, s: string) =>
    transfer.claudeSessionTransfer.transfer({
      taskId,
      fromHarness: dbm.harnesses.get(from.id)!,
      toHarness: dbm.harnesses.get(to.id)!,
      sessionId: s,
      cwd,
    });
  const orphansOf = (harnessId: string) =>
    dbm.harnessOrphanedCopies.list({ harnessId }).map((r) => ({ sessionId: r.sessionId, path: r.path }));

  test("a re-key whose old copy cannot be unlinked keeps it on record under the old session, and a sweep removes it later", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const taskId = seedTask(`orph-rekey-${seq}`);
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "old");
    write(path.join(from.home, "projects", column, oldSid, "subagents", "agent-1.jsonl"), "old sub");
    expect((await run(from, to, taskId, oldSid)).ok).toBe(true);
    const oldTranscript = path.join(to.home, "projects", column, `${oldSid}.jsonl`);
    const stuckDir = path.join(to.home, "projects", column, oldSid, "subagents");
    const stuck = path.join(stuckDir, "agent-1.jsonl");
    expect(existsSync(stuck)).toBe(true);

    // The old sidecar cannot be unlinked while its folder is read-only.
    chmodSync(stuckDir, 0o500);
    try {
      write(path.join(from.home, "projects", column, `${newSid}.jsonl`), "new");
      const result = await run(from, to, taskId, newSid);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.warnings?.some((w) => w.includes("retried later"))).toBe(true);
      expect(existsSync(oldTranscript)).toBe(false);
      expect(existsSync(stuck)).toBe(true);
      // The live row names only the new session's files; the stuck one is an
      // orphan under the session it was copied for.
      const row = dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")!;
      expect(row.sessionId).toBe(newSid);
      expect(row.copiedPaths.some((p) => p.includes(oldSid))).toBe(false);
      expect(orphansOf(to.id)).toEqual([{ sessionId: oldSid, path: stuck }]);
    } finally {
      chmodSync(stuckDir, 0o700);
    }
    const swept = await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id });
    expect(swept.removed).toBe(1);
    expect(existsSync(stuck)).toBe(false);
    expect(orphansOf(to.id)).toEqual([]);
    // The new session is untouched.
    expect(readFileSync(path.join(to.home, "projects", column, `${newSid}.jsonl`), "utf8")).toBe("new");
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a deleted task's kept copies are orphaned instead of cascading away; restoring the account root sweeps them", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const taskId = seedTask(`orph-delete-${seq}`);
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "t");
    expect((await run(from, to, taskId, oldSid)).ok).toBe(true);
    const dest = path.join(to.home, "projects", column, `${oldSid}.jsonl`);
    // The account's root changes: cleanup must keep the file and the row.
    dbm.harnesses.update(to.id, { home: mkdtempSync(path.join(tmpdir(), "agetor-orph-newroot-")) });
    expect((await transfer.cleanupHarnessSessionCopies(taskId)).length).toBe(1);
    dbm.tasks.delete(taskId);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toBeNull();
    expect(orphansOf(to.id)).toEqual([{ sessionId: oldSid, path: dest }]);
    // Out of reach while the root differs: kept, not forgotten.
    expect((await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id })).retained).toBe(1);
    expect(existsSync(dest)).toBe(true);
    dbm.harnesses.update(to.id, { home: to.home });
    await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id });
    expect(existsSync(dest)).toBe(false);
    expect(orphansOf(to.id)).toEqual([]);
  });

  test("a crash after the copy but before the final row keeps the old session resumable; the boot sweep removes only the new copy", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const taskId = seedTask(`orph-crash-${seq}`);
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "old");
    write(path.join(from.home, "projects", column, oldSid, "subagents", "agent-1.jsonl"), "old sub");
    expect((await run(from, to, taskId, oldSid)).ok).toBe(true);
    const oldRow = dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")!;
    const oldFiles = [
      path.join(to.home, "projects", column, `${oldSid}.jsonl`),
      path.join(to.home, "projects", column, oldSid, "subagents", "agent-1.jsonl"),
    ];

    write(path.join(from.home, "projects", column, `${newSid}.jsonl`), "new");
    write(path.join(from.home, "projects", column, newSid, "subagents", "agent-2.jsonl"), "new sub");
    const newFiles = [
      path.join(to.home, "projects", column, `${newSid}.jsonl`),
      path.join(to.home, "projects", column, newSid, "subagents", "agent-2.jsonl"),
    ];
    // "Crash": the final upsert for the new session never lands.
    const store = dbm.harnessSessionHandoffs;
    const realUpsert = store.upsert.bind(store);
    store.upsert = ((h: Parameters<typeof realUpsert>[0]) => {
      if (h.sessionId === newSid && h.createdAt > 0) throw new Error("simulated crash");
      return realUpsert(h);
    }) as typeof store.upsert;
    try {
      await expect(run(from, to, taskId, newSid)).rejects.toThrow("simulated crash");
    } finally {
      store.upsert = realUpsert;
    }
    for (const f of newFiles) expect(existsSync(f)).toBe(true);
    // The old row was never touched: its session is still the resumable one.
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toEqual(oldRow);
    expect(transfer.findSessionIdForHarness(taskId, "claude_session_id", to.id)).toBe(oldSid);

    await transfer.sweepOrphanedHandoffCopiesAtBoot();
    for (const f of oldFiles) expect(existsSync(f)).toBe(true);
    for (const f of newFiles) expect(existsSync(f)).toBe(false);
    expect(orphansOf(to.id)).toEqual([]);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a failed copy onto an account holding another session leaves that row and its files alone", async () => {
    const from = alias("claude-code");
    const to = alias("claude-code");
    const column = claudeTmux.encodeProjectPath(cwd);
    const taskId = seedTask(`orph-fail-${seq}`);
    write(path.join(from.home, "projects", column, `${oldSid}.jsonl`), "old");
    expect((await run(from, to, taskId, oldSid)).ok).toBe(true);
    const oldRow = dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")!;
    write(path.join(from.home, "projects", column, `${newSid}.jsonl`), "new");
    write(path.join(from.home, "projects", column, newSid, "subagents", "agent-2.jsonl"), "sub");
    // The new transcript's destination is a directory: the copy throws after
    // the sidecar destination was recorded as a pending orphan.
    mkdirSync(path.join(to.home, "projects", column, `${newSid}.jsonl`), { recursive: true });
    expect((await run(from, to, taskId, newSid)).ok).toBe(false);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")).toEqual(oldRow);
    expect(readFileSync(path.join(to.home, "projects", column, `${oldSid}.jsonl`), "utf8")).toBe("old");
    // The pending record of the never-created sidecar was swept away.
    expect(orphansOf(to.id)).toEqual([]);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("a sweep never touches a session while it is being transferred onto the account", async () => {
    const to = alias("claude-code");
    // A pending record of the session being copied, whose file the copy has
    // already created (no live row names it yet).
    const copying = path.join(to.home, "projects", "enc", oldSid, "tool-results", "r.txt");
    write(copying, "being copied");
    dbm.harnessOrphanedCopies.add(to.id, "claude_session_id", oldSid, [copying]);
    const release = transfer.holdTransferForTests(to.id, "claude_session_id", oldSid);
    try {
      const swept = await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id });
      expect(swept).toEqual({ removed: 0, forgotten: 0, retained: 1 });
      expect(existsSync(copying)).toBe(true);
    } finally {
      release();
    }
    // Once the transfer is over (and failed, so no row names it), it goes.
    expect((await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id })).removed).toBe(1);
    expect(existsSync(copying)).toBe(false);
  });

  test("a session live on a handoff row of the same account is never swept", async () => {
    const to = alias("claude-code");
    const taskId = seedTask(`orph-live-${seq}`);
    const file = path.join(to.home, "projects", "enc", oldSid, "subagents", "a.jsonl");
    write(file, "live");
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: oldSid, copiedPaths: [], createdAt: 1,
    });
    dbm.harnessOrphanedCopies.add(to.id, "claude_session_id", oldSid, [file]);
    expect((await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id })).retained).toBe(1);
    expect(existsSync(file)).toBe(true);
    // Back on a live row, a path stops being an orphan.
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: oldSid, copiedPaths: [file], createdAt: 1,
    });
    expect(orphansOf(to.id)).toEqual([]);
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(file)).toBe(false);
  });

  test("an orphan record naming another shape or another session deletes nothing; one outside the root is kept on record", async () => {
    const to = alias("claude-code");
    const settings = path.join(to.home, "settings.json");
    const otherTranscript = path.join(to.home, "projects", "enc", `${newSid}.jsonl`);
    write(settings, "{}");
    write(otherTranscript, "someone else's");
    dbm.harnessOrphanedCopies.add(to.id, "claude_session_id", oldSid, [settings, otherTranscript, "/etc/hosts"]);
    const swept = await transfer.sweepOrphanedHandoffCopies({ harnessId: to.id });
    expect(swept.removed).toBe(0);
    expect(existsSync(settings)).toBe(true);
    expect(existsSync(otherTranscript)).toBe(true);
    // Outside the account's current root reads as "the root changed", the
    // handoff rule: kept for a later sweep, never touched.
    expect(swept.retained).toBe(1);
    expect(orphansOf(to.id)).toEqual([{ sessionId: oldSid, path: "/etc/hosts" }]);
    dbm.harnessOrphanedCopies.deleteForHarness(to.id);
  });

  test("boot normalization moves a pre-088 re-keyed row's old-session paths to the orphan store and sweeps them", async () => {
    const to = alias("claude-code");
    const taskId = seedTask(`orph-boot-${seq}`);
    const oldFile = path.join(to.home, "projects", "enc", `${oldSid}.jsonl`);
    const oldSidecar = path.join(to.home, "projects", "enc", oldSid, "tool-results", "r.txt");
    const newFile = path.join(to.home, "projects", "enc", `${newSid}.jsonl`);
    for (const f of [oldFile, oldSidecar, newFile]) write(f, "x");
    // The shape a pre-088 re-key left: new session id, old paths merged in.
    dbm.harnessSessionHandoffs.upsert({
      taskId, harnessId: to.id, columnName: "claude_session_id", sessionId: newSid,
      copiedPaths: [oldFile, oldSidecar, newFile], createdAt: 1,
    });
    await transfer.sweepOrphanedHandoffCopiesAtBoot();
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(oldSidecar)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(dbm.harnessSessionHandoffs.get(taskId, to.id, "claude_session_id")?.copiedPaths).toEqual([newFile]);
    expect(orphansOf(to.id)).toEqual([]);
    // Idempotent.
    expect(await transfer.adoptMismatchedHandoffPaths()).toBe(0);
    await transfer.cleanupHarnessSessionCopies(taskId);
  });

  test("Codex: a superseded rollout that cannot be unlinked is orphaned under the codex column and swept later", async () => {
    const from = alias("codex");
    const to = alias("codex");
    const taskId = seedTask(`orph-codex-${seq}`);
    const day = path.join("sessions", "2026", "11", "10");
    const nextDay = path.join("sessions", "2026", "11", "11");
    write(path.join(from.home, ".codex", day, `rollout-2026-11-10T00-00-00-${oldSid}.jsonl`), "old");
    write(path.join(from.home, ".codex", nextDay, `rollout-2026-11-11T01-00-00-${newSid}.jsonl`), "new");
    const runCodex = (s: string) =>
      transfer.codexSessionTransfer.transfer({
        taskId, fromHarness: dbm.harnesses.get(from.id)!, toHarness: dbm.harnesses.get(to.id)!, sessionId: s, cwd,
      });
    expect((await runCodex(oldSid)).ok).toBe(true);
    const oldDest = path.join(to.home, ".codex", day, `rollout-2026-11-10T00-00-00-${oldSid}.jsonl`);
    expect(existsSync(oldDest)).toBe(true);
    // A read-only day folder blocks the unlink; the new rollout lands in
    // another day's folder.
    const newDest = path.join(to.home, ".codex", nextDay, `rollout-2026-11-11T01-00-00-${newSid}.jsonl`);
    chmodSync(path.dirname(oldDest), 0o500);
    try {
      expect((await runCodex(newSid)).ok).toBe(true);
      expect(existsSync(oldDest)).toBe(true);
      expect(dbm.harnessOrphanedCopies.list({ harnessId: to.id })).toEqual([
        expect.objectContaining({ columnName: "codex_session_id", sessionId: oldSid, path: oldDest }),
      ]);
    } finally {
      chmodSync(path.dirname(oldDest), 0o700);
    }
    await transfer.sweepOrphanedHandoffCopies();
    expect(existsSync(oldDest)).toBe(false);
    expect(readFileSync(newDest, "utf8")).toBe("new");
    await transfer.cleanupHarnessSessionCopies(taskId);
    expect(existsSync(newDest)).toBe(false);
  });

  test("account delete collects its orphaned copies with its handoffs and drops their records", async () => {
    const to = alias("claude-code");
    const file = path.join(to.home, "projects", "enc", `${oldSid}.jsonl`);
    write(file, "x");
    dbm.harnessOrphanedCopies.add(to.id, "claude_session_id", oldSid, [file]);
    const copies = transfer.collectHarnessSessionCopies(to.id);
    expect(copies).toEqual([expect.objectContaining({ sessionId: oldSid, paths: [file] })]);
    dbm.harnesses.delete(to.id);
    expect(dbm.harnessOrphanedCopies.list({ harnessId: to.id })).toEqual([]);
    await transfer.removeHarnessSessionCopies(copies);
    expect(existsSync(file)).toBe(false);
  });
});
