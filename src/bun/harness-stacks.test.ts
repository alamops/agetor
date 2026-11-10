// Harness account stack store (T03): CRUD, blockers, warnings, cooldown and
// task resolution. Restores harness + stack state afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-harness-stacks-"));

type Stacks = typeof import("./harness-stacks.ts");
type Db = typeof import("./db.ts");
let stacks: Stacks;
let dbm: Db;
let restore: () => void;
const homes: string[] = [];

// Ambient credentials in the runner's env (a CI secret, or the
// `CLAUDE_CODE_*_TOKEN` a Claude Code session exports) are login evidence and
// a `process-provider-key` warning for every account. Strip every key the
// evidence check would count for the whole file, then restore it.
const ambientAuth = new Map<string, string | undefined>();

beforeAll(async () => {
  const { isHarnessAuthEnvKey } = await import("../shared/harness-mirror.ts");
  for (const key of Object.keys(process.env)) {
    if (isHarnessAuthEnvKey(key)) {
      ambientAuth.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  dbm = await import("./db.ts");
  stacks = await import("./harness-stacks.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restore = snapshotHarnessState();
  for (const id of ["stack-a", "stack-b", "stack-c"]) {
    homes.push(mkdtempSync(path.join(tmpdir(), `agetor-${id}-`)));
    dbm.harnesses.insert({
      id,
      kind: "claude-code",
      label: id,
      home: homes[homes.length - 1]!,
      env: {},
    } as never);
  }
});

afterAll(() => {
  restore();
  for (const [key, value] of ambientAuth) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function input(members: string[], extra: Partial<{ label: string; mirrorMode: "full" | "safe" }> = {}) {
  return { label: extra.label ?? "train", kind: "claude-code" as const, members, mirrorMode: extra.mirrorMode };
}

describe("harnessStacks", () => {
  test("create/list/get keeps order and rejects a second membership", () => {
    const stack = stacks.harnessStacks.create(input(["stack-a", "stack-b"]));
    expect(stack.members.map((m) => m.harnessId)).toEqual(["stack-a", "stack-b"]);
    expect(stacks.harnessStacks.list().some((s) => s.id === stack.id)).toBe(true);
    expect(() => stacks.harnessStacks.create(input(["stack-b", "stack-c"]))).toThrow();
    stacks.harnessStacks.delete(stack.id);
    expect(stacks.harnessStacks.get(stack.id)).toBeNull();
  });

  test("runtime reads skip member warnings; list and create/update compute them (C6)", () => {
    // The hot path (`get`/`getByMember`/`resolveForTask`, read on every swap,
    // retry, start and send) must not run install probes, login evidence (a
    // keychain lookup on macOS) or the catalog.
    const services: string[] = [];
    stacks.setLoginEvidenceDepsForTests({
      platform: "darwin",
      keychainProbe: (service) => {
        services.push(service);
        return false;
      },
    });
    const created = stacks.harnessStacks.create(input(["stack-a", "stack-b"]));
    try {
      expect(created.warnings.map((w) => w.code)).toContain("full-mirror-hooks");
      expect(created.warnings.map((w) => w.code)).toContain("member-logged-out");
      // Same words as the Settings editor's own draft warning (N6).
      expect(created.warnings.find((w) => w.code === "full-mirror-hooks")?.message).toBe(
        "Full mirror copies settings hooks, permissions, status line and helper commands (Codex: notify) onto every backup.",
      );

      services.length = 0;
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: (service) => {
        services.push(service);
        return false;
      } });
      expect(stacks.harnessStacks.get(created.id)!.warnings).toEqual([]);
      expect(stacks.harnessStacks.getByMember("stack-b")!.warnings).toEqual([]);
      expect(stacks.harnessStacks.resolveForTask({ id: "t", agent: "stack-a", harnessState: null } as never)!.stack.warnings)
        .toEqual([]);
      expect(services).toEqual([]);

      const listed = stacks.harnessStacks.list().find((s) => s.id === created.id)!;
      expect(listed.warnings.map((w) => w.code)).toContain("member-logged-out");
      expect(services.length).toBeGreaterThan(0);
      expect(stacks.harnessStacks.get(created.id, { warnings: true })!.warnings.map((w) => w.code))
        .toContain("full-mirror-hooks");

      const updated = stacks.harnessStacks.update(created.id, { mirrorMode: "safe" });
      expect(updated.warnings.map((w) => w.code)).not.toContain("full-mirror-hooks");
      expect(updated.warnings.map((w) => w.code)).toContain("member-logged-out");
    } finally {
      stacks.harnessStacks.delete(created.id);
      stacks.setLoginEvidenceDepsForTests(null);
    }
  });

  test("validateMemberRoot refuses an edit that aliases another member's root (C9)", () => {
    const stack = stacks.harnessStacks.create(input(["stack-a", "stack-b"]));
    try {
      // Not a member of any stack: nothing to check.
      expect(stacks.harnessStacks.validateMemberRoot("stack-c", { kind: "claude-code", home: homes[0]!, env: {} }))
        .toBeNull();
      // A fresh, distinct root is fine.
      const fresh = mkdtempSync(path.join(tmpdir(), "agetor-member-root-"));
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", { kind: "claude-code", home: fresh, env: {} }))
        .toBeNull();
      // Its own current root is fine (it is not compared with itself).
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", { kind: "claude-code", home: homes[1]!, env: {} }))
        .toBeNull();
      // The primary's root, directly, through a symlink, or via the env map.
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", { kind: "claude-code", home: homes[0]!, env: {} }))
        .toContain("stack-a");
      const link = path.join(mkdtempSync(path.join(tmpdir(), "agetor-member-link-")), "alias");
      symlinkSync(homes[0]!, link);
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", { kind: "claude-code", home: link, env: {} }))
        .toContain("share its config directory");
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", {
        kind: "claude-code",
        home: fresh,
        env: { CLAUDE_CONFIG_DIR: homes[0]! },
      })).toContain("stack-a");
      // A kind change would leave the stack's kind.
      expect(stacks.harnessStacks.validateMemberRoot("stack-b", { kind: "codex", home: fresh, env: {} }))
        .toContain("remove it from the stack");
    } finally {
      stacks.harnessStacks.delete(stack.id);
    }
  });

  test("update reorders and can remove a member", () => {
    const stack = stacks.harnessStacks.create(input(["stack-a", "stack-b", "stack-c"]));
    const reordered = stacks.harnessStacks.update(stack.id, { members: ["stack-c", "stack-a"] });
    expect(reordered.members.map((m) => m.harnessId)).toEqual(["stack-c", "stack-a"]);
    expect(stacks.harnessStacks.getByMember("stack-b")).toBeNull();
    stacks.harnessStacks.delete(stack.id);
  });

  test("blockers: mixed kinds, unknown account, duplicate, same home", () => {
    dbm.harnesses.insert({
      id: "codex-x",
      kind: "codex",
      label: "codex-x",
      home: mkdtempSync(path.join(tmpdir(), "agetor-codex-x-")),
      env: {},
    } as never);
    const mixed = stacks.validateInput({ ...input([]), members: ["stack-a", "codex-x"] });
    expect(mixed.blockers.map((b) => b.code)).toContain("mixed-kinds");

    const unknown = stacks.validateInput(input(["stack-a", "ghost"]));
    expect(unknown.blockers.map((b) => b.code)).toContain("unknown-harness");

    const dup = stacks.validateInput(input(["stack-a", "stack-a"]));
    expect(dup.blockers.map((b) => b.code)).toContain("duplicate-member");

    // Two DIFFERENT aliases pointing at the same real directory are not
    // distinct accounts — this must be caught by the home check, not merely
    // by the duplicate-id check (the pre-review test re-tested the latter).
    dbm.harnesses.insert({
      id: "stack-a-copy",
      kind: "claude-code",
      label: "stack-a-copy",
      home: homes[0]!,
      env: {},
    } as never);
    const sameHome = stacks.validateInput(input(["stack-a", "stack-a-copy"])).blockers.map((b) => b.code);
    expect(sameHome).toContain("same-home");
    expect(sameHome).not.toContain("duplicate-member");
  });

  test("warnings: one member, >10 members, full mirror hooks", () => {
    const one = stacks.validateInput(input(["stack-a"]));
    expect(one.blockers).toEqual([]);
    expect(one.warnings.map((w) => w.code)).toContain("too-few-members");
    expect(one.warnings.map((w) => w.code)).toContain("full-mirror-hooks");
    const safe = stacks.validateInput({ ...input(["stack-a"]), mirrorMode: "safe" });
    expect(safe.warnings.map((w) => w.code)).not.toContain("full-mirror-hooks");
  });

  test("cooldown upsert, isCooling, prune and clear", () => {
    stacks.harnessStacks.clearLimitState("stack-a");
    const now = 1_000_000;
    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "quota",
      resetAtMs: now + 60_000,
      message: "usage limit",
      source: "claude-pane",
    }, now);
    expect(stacks.harnessStacks.isCooling("stack-a", now + 1000)?.reason).toBe("quota");
    expect(stacks.harnessStacks.isCooling("stack-a", now + 60_001)).toBeNull();
    // Reads filter expired rows out of the payload but never DELETE: the row
    // stays until the boot sweep or the next write prunes it.
    expect(stacks.harnessStacks.listLimitStates(now + 1000).map((s) => s.harnessId)).toContain("stack-a");
    expect(stacks.harnessStacks.listLimitStates(now + 60_001)).toEqual([]);
    expect(stacks.harnessStacks.getLimitState("stack-a")).not.toBeNull();
    stacks.harnessStacks.setLimitState("stack-b", {
      reason: "quota",
      resetAtMs: now + 120_000,
      message: "usage limit",
      source: "claude-pane",
    }, now + 60_001);
    expect(stacks.harnessStacks.getLimitState("stack-a")).toBeNull();
    stacks.harnessStacks.clearLimitState("stack-b");
    stacks.harnessStacks.pruneExpired(now + 60_001);
    expect(stacks.harnessStacks.getLimitState("stack-a")).toBeNull();

    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "rate_limit",
      resetAtMs: null,
      message: "429",
      source: "claude-api-error",
    }, now);
    const state = stacks.harnessStacks.getLimitState("stack-a")!;
    expect(state.exhaustedUntilMs).toBe(now + stacks.HARNESS_RATE_LIMIT_COOLDOWN_MS);
    stacks.harnessStacks.clearLimitState("stack-a");
    expect(stacks.harnessStacks.getLimitState("stack-a")).toBeNull();
  });

  test("a fallback cooldown never shortens a later provider reset", () => {
    stacks.harnessStacks.clearLimitState("stack-a");
    const now = 2_000_000;
    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "quota",
      resetAtMs: now + 3 * 60 * 60_000,
      message: "usage limit",
      source: "claude-pane",
    }, now);
    // A later rate limit with no reset time would otherwise fall back to 60s
    // and free the account long before the provider reset.
    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "rate_limit",
      resetAtMs: null,
      message: "429",
      source: "claude-api-error",
    }, now + 1000);
    expect(stacks.harnessStacks.getLimitState("stack-a")!.exhaustedUntilMs)
      .toBe(now + 3 * 60 * 60_000);
    // A provider reset is authoritative even when it is earlier than the
    // stored fallback.
    stacks.harnessStacks.clearLimitState("stack-a");
    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "rate_limit",
      resetAtMs: null,
      message: "429",
      source: "claude-api-error",
    }, now);
    stacks.harnessStacks.setLimitState("stack-a", {
      reason: "quota",
      resetAtMs: now + 30_000,
      message: "usage limit",
      source: "claude-pane",
    }, now);
    expect(stacks.harnessStacks.getLimitState("stack-a")!.exhaustedUntilMs).toBe(now + 30_000);
    stacks.harnessStacks.clearLimitState("stack-a");
  });

  test("home-less built-ins resolve the process-level config overrides", () => {
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    const prevCodex = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/agetor-test-claude-env";
    process.env.CODEX_HOME = "/tmp/agetor-test-codex-env";
    try {
      expect(stacks.claudeConfigDirFor({ home: null })).toBe("/tmp/agetor-test-claude-env");
      expect(stacks.claudeJsonDirFor({ home: null })).toBe("/tmp/agetor-test-claude-env");
      expect(stacks.codexHomeFor({ home: null })).toBe("/tmp/agetor-test-codex-env");
      // A harness env map still wins over the process env.
      expect(stacks.claudeConfigDirFor({ home: null, env: { CLAUDE_CONFIG_DIR: "/per-harness" } }))
        .toBe("/per-harness");
      expect(stacks.codexHomeFor({ home: null, env: { CODEX_HOME: "/per-harness-codex" } }))
        .toBe("/per-harness-codex");
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
    }
  });

  test("resolveForTask follows the current membership and falls back to the recorded stack", () => {
    const taskId = randomUUID();
    const stack = stacks.harnessStacks.create(input(["stack-a", "stack-b"]));
    dbm.tasks.insert({
      id: taskId,
      title: "resolve",
      prompt: "p",
      agent: "stack-a",
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
    const task = dbm.tasks.get(taskId)!;
    expect(stacks.harnessStacks.resolveForTask(task)?.current).toBe("stack-a");
    dbm.tasks.setHarnessState(taskId, {
      stackId: stack.id,
      position: 0,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
    expect(stacks.harnessStacks.resolveForTask(dbm.tasks.get(taskId)!)?.stack.id).toBe(stack.id);

    // The account is edited into a DIFFERENT stack while the recorded state
    // still names the old one. The current membership must win: failover (and
    // the next manual Run) follows the account, never the stale train.
    const other = stacks.harnessStacks.create({ ...input(["stack-c"]), label: "other" });
    stacks.harnessStacks.update(stack.id, { members: ["stack-b"] });
    stacks.harnessStacks.update(other.id, { members: ["stack-c", "stack-a"] });
    const moved = stacks.harnessStacks.resolveForTask(dbm.tasks.get(taskId)!)!;
    expect(moved.stack.id).toBe(other.id);
    expect(moved.position).toBe(1);
    expect(moved.orphaned).toBe(false);

    // Removed from every stack mid-flight: the recorded stack still resolves
    // (orphaned) so nothing silently starts fresh on the next turn.
    stacks.harnessStacks.update(other.id, { members: ["stack-c"] });
    const orphaned = stacks.harnessStacks.resolveForTask(dbm.tasks.get(taskId)!);
    expect(orphaned?.orphaned).toBe(true);
    expect(orphaned?.stack.id).toBe(stack.id);

    stacks.harnessStacks.delete(other.id);
    stacks.harnessStacks.delete(stack.id);
    expect(dbm.tasks.get(taskId)?.harnessState).toBeNull();
    dbm.tasks.delete(taskId);
  });

  test("deleting a stack member re-packs the surviving ranks (R13-M1)", () => {
    // Deleting a member account used to drop its row through the (since
    // removed, migration 085) FK cascade and leave a gap in the stored
    // position (0, 2). The swap divider then rendered an impossible "3/2" and
    // the reader trusted the stale rank. `harnesses.delete` now deletes the
    // membership explicitly and renumbers, and `toStack` derives from the
    // array index, so both a fresh delete and pre-fix data read back
    // contiguously.
    const ids = ["ren-a", "ren-b", "ren-c"];
    for (const id of ids) {
      dbm.harnesses.insert({
        id,
        kind: "claude-code",
        label: id,
        home: mkdtempSync(path.join(tmpdir(), `agetor-${id}-`)),
        env: {},
      } as never);
    }
    const stack = stacks.harnessStacks.create(input(ids));
    expect(stack.members.map((m) => m.position)).toEqual([0, 1, 2]);

    // Delete the PRIMARY through the harness row (`harnesses.delete`).
    dbm.harnesses.delete("ren-a");
    const after = stacks.harnessStacks.get(stack.id)!;
    expect(after.members.map((m) => m.harnessId)).toEqual(["ren-b", "ren-c"]);
    expect(after.members.map((m) => m.position)).toEqual([0, 1]);
    // The stored ranks are re-packed too, not merely hidden by the reader.
    const stored = dbm.db
      .query<{ harness_id: string; position: number }, [string]>(
        `SELECT harness_id, position FROM harness_stack_members WHERE stack_id = ? ORDER BY position ASC`,
      )
      .all(stack.id);
    expect(stored).toEqual([
      { harness_id: "ren-b", position: 0 },
      { harness_id: "ren-c", position: 1 },
    ]);

    // A task on the last member now reports position 1 of 2, never 3 of 2.
    const taskId = randomUUID();
    dbm.tasks.insert({
      id: taskId,
      title: "renumber",
      prompt: "p",
      agent: "ren-c",
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
    const resolved = stacks.harnessStacks.resolveForTask(dbm.tasks.get(taskId)!)!;
    expect(resolved.position).toBe(1);
    expect(resolved.stack.members.length).toBe(2);
    expect(resolved.position + 1).toBeLessThanOrEqual(resolved.stack.members.length);

    // Defensive read: a database written BEFORE the renumber fix (a real gap
    // in the stored rank) still reports contiguous positions.
    dbm.db.run(
      `UPDATE harness_stack_members SET position = 2 WHERE stack_id = ? AND harness_id = ?`,
      [stack.id, "ren-c"],
    );
    expect(stacks.harnessStacks.get(stack.id)!.members.map((m) => m.position)).toEqual([0, 1]);

    dbm.tasks.delete(taskId);
    stacks.harnessStacks.delete(stack.id);
    dbm.harnesses.delete("ren-b");
    dbm.harnesses.delete("ren-c");
  });

  test("effective homes are the CLI config roots", () => {
    const claude = dbm.harnesses.getByIdOrKind("stack-a")!;
    expect(stacks.effectiveHome(claude)).toBe(claude.home!);
    expect(stacks.claudeConfigDirFor(claude)).toBe(claude.home!);
    const builtin = dbm.harnesses.getByIdOrKind("claude-code")!;
    expect(stacks.effectiveHome(builtin)).toContain(".claude");
  });

  test("effective homes honor the harness env map's CLAUDE_CONFIG_DIR / CODEX_HOME", () => {
    // `harnessEnv` layers the env map over the home-derived value, so the CLI
    // really reads the override. The resolver must agree, or the mirror and a
    // session transfer target the wrong directory (a swap then blocks on
    // no-session).
    const overrideDir = mkdtempSync(path.join(tmpdir(), "agetor-env-claude-"));
    dbm.harnesses.insert({
      id: "env-claude-override",
      kind: "claude-code",
      label: "env-claude-override",
      home: mkdtempSync(path.join(tmpdir(), "agetor-env-claude-home-")),
      env: { CLAUDE_CONFIG_DIR: overrideDir },
    } as never);
    const claude = dbm.harnesses.getByIdOrKind("env-claude-override")!;
    expect(stacks.effectiveHome(claude)).toBe(overrideDir);
    expect(stacks.claudeConfigDirFor(claude)).toBe(overrideDir);
    // `.claude.json` follows the pinned config root, not the home field.
    expect(stacks.claudeJsonDirFor(claude)).toBe(overrideDir);

    const codexOverrideDir = mkdtempSync(path.join(tmpdir(), "agetor-env-codex-"));
    dbm.harnesses.insert({
      id: "env-codex-override",
      kind: "codex",
      label: "env-codex-override",
      home: mkdtempSync(path.join(tmpdir(), "agetor-env-codex-home-")),
      env: { CODEX_HOME: codexOverrideDir },
    } as never);
    const codex = dbm.harnesses.getByIdOrKind("env-codex-override")!;
    expect(stacks.effectiveHome(codex)).toBe(codexOverrideDir);
    expect(stacks.codexHomeFor(codex)).toBe(codexOverrideDir);

    // An env-only account (no `home`) resolves from the env map too.
    dbm.harnesses.insert({
      id: "env-only-claude",
      kind: "claude-code",
      label: "env-only-claude",
      home: null,
      env: { CLAUDE_CONFIG_DIR: overrideDir },
    } as never);
    expect(stacks.claudeConfigDirFor(dbm.harnesses.getByIdOrKind("env-only-claude")!)).toBe(overrideDir);

    // Two accounts with different home fields but the same effective config
    // root are the SAME account on disk — the stack validation must block it.
    dbm.harnesses.insert({
      id: "env-claude-same-root",
      kind: "claude-code",
      label: "env-claude-same-root",
      home: mkdtempSync(path.join(tmpdir(), "agetor-env-claude-home2-")),
      env: { CLAUDE_CONFIG_DIR: overrideDir },
    } as never);
    const clash = stacks.validateInput(input(["env-claude-override", "env-claude-same-root"]));
    expect(clash.blockers.map((b) => b.code)).toContain("same-home");
  }, 15_000);
});

// Login evidence is what decides whether a stack may Run or fail over to an
// account at all, so every supported auth shape needs a case (R15-M1).
describe("loginEvidence", () => {
  const cleared = [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AZURE_OPENAI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of cleared) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    // The cases below predate the macOS keychain lookup: a fixture account
    // with no credential file has no keychain item either.
    stacks.setLoginEvidenceDepsForTests({ keychainProbe: () => false });
  });
  afterAll(() => {
    stacks.setLoginEvidenceDepsForTests(null);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function claudeHome(files: Record<string, string> = {}): string {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-login-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(home, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return home;
  }

  test("Claude: credentials file, settings.json env, helper and env map all count", () => {
    const creds = claudeHome({ ".credentials.json": "{}" });
    expect(stacks.loginEvidence({ kind: "claude-code", home: creds, env: {} } as never)).toBe(true);

    const settingsEnv = claudeHome({
      "settings.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-test" } }),
    });
    expect(stacks.loginEvidence({ kind: "claude-code", home: settingsEnv, env: {} } as never)).toBe(true);

    const helper = claudeHome({
      "settings.json": JSON.stringify({ apiKeyHelper: "/usr/local/bin/get-key" }),
    });
    expect(stacks.loginEvidence({ kind: "claude-code", home: helper, env: {} } as never)).toBe(true);

    const envMap = claudeHome();
    expect(
      stacks.loginEvidence({ kind: "claude-code", home: envMap, env: { ANTHROPIC_AUTH_TOKEN: "tok" } } as never),
    ).toBe(true);
  });

  test("Claude: a symlinked credentials file is login evidence, not a logout (R17-S2)", () => {
    const home = claudeHome({ "dotfiles/creds.json": "{}" });
    symlinkSync(path.join(home, "dotfiles", "creds.json"), path.join(home, ".credentials.json"));
    expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBe(true);
  });

  test("Claude: a Bedrock/Vertex/custom-provider setup fails open, a bare home is logged out", () => {
    const bedrock = claudeHome({
      "settings.json": JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
    });
    expect(stacks.loginEvidence({ kind: "claude-code", home: bedrock, env: {} } as never)).toBeNull();

    const vertex = claudeHome({
      "settings.json": JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }),
    });
    expect(stacks.loginEvidence({ kind: "claude-code", home: vertex, env: {} } as never)).toBeNull();

    const gateway = claudeHome({
      "settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
    });
    expect(stacks.loginEvidence({ kind: "claude-code", home: gateway, env: {} } as never)).toBeNull();

    const awsProfile = claudeHome({
      "settings.json": JSON.stringify({ env: { AWS_PROFILE: "bedrock" } }),
    });
    // A login-selecting cloud setting is evidence of *some* login (the
    // profile may hold it); it must never read as logged out.
    expect(stacks.loginEvidence({ kind: "claude-code", home: awsProfile, env: {} } as never)).toBe(true);

    const bare = claudeHome();
    expect(stacks.loginEvidence({ kind: "claude-code", home: bare, env: {} } as never)).toBe(false);

    // A present-but-unparseable settings.json cannot be judged; never call it
    // logged out.
    const broken = claudeHome({ "settings.json": "{not json" });
    expect(stacks.loginEvidence({ kind: "claude-code", home: broken, env: {} } as never)).toBeNull();

    // The built-in account authenticates through the macOS keychain.
    expect(stacks.loginEvidence({ kind: "claude-code", home: null, env: {} } as never)).toBeNull();
  });

  test("Claude: a process-level cloud/gateway selector fails open (review M1)", () => {
    const bare = claudeHome();
    const saved = new Map<string, string | undefined>();
    const set = (key: string, value: string) => {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    };
    try {
      set("CLAUDE_CODE_USE_BEDROCK", "1");
      expect(stacks.loginEvidence({ kind: "claude-code", home: bare, env: {} } as never)).toBeNull();
      delete process.env.CLAUDE_CODE_USE_BEDROCK;

      set("CLAUDE_CODE_USE_VERTEX", "1");
      expect(stacks.loginEvidence({ kind: "claude-code", home: bare, env: {} } as never)).toBeNull();
      delete process.env.CLAUDE_CODE_USE_VERTEX;

      set("ANTHROPIC_BASE_URL", "https://gateway.example");
      expect(stacks.loginEvidence({ kind: "claude-code", home: bare, env: {} } as never)).toBeNull();
      delete process.env.ANTHROPIC_BASE_URL;

      // The selectors are kind-scoped: a Codex endpoint cannot make Claude's
      // evidence unknowable (that would only weaken the warning).
      set("OPENAI_BASE_URL", "https://example.invalid/v1");
      expect(stacks.loginEvidence({ kind: "claude-code", home: bare, env: {} } as never)).toBe(false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("Codex: auth.json, env key, and a custom provider fails open", () => {
    const authHome = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-"));
    mkdirSync(path.join(authHome, ".codex"), { recursive: true });
    writeFileSync(path.join(authHome, ".codex", "auth.json"), "{}");
    expect(stacks.loginEvidence({ kind: "codex", home: authHome, env: {} } as never)).toBe(true);

    const envHome = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-"));
    expect(
      stacks.loginEvidence({ kind: "codex", home: envHome, env: { OPENAI_API_KEY: "sk-test" } } as never),
    ).toBe(true);

    const providerHome = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-"));
    mkdirSync(path.join(providerHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(providerHome, ".codex", "config.toml"),
      'model_provider = "azure"\n[model_providers.azure]\nbase_url = "https://example.openai.azure.com"\n',
    );
    expect(stacks.loginEvidence({ kind: "codex", home: providerHome, env: {} } as never)).toBeNull();

    const bareHome = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-"));
    expect(stacks.loginEvidence({ kind: "codex", home: bareHome, env: {} } as never)).toBe(false);
  });

  test("Codex: a symlinked auth.json is login evidence (R17-S2)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-link-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "auth-real.json"), "{}");
    symlinkSync(path.join(home, ".codex", "auth-real.json"), path.join(home, ".codex", "auth.json"));
    expect(stacks.loginEvidence({ kind: "codex", home, env: {} } as never)).toBe(true);
  });

  test("Codex: a process selector or an uninspectable config.toml fails open (review M1 + nit)", () => {
    const saved = new Map<string, string | undefined>();
    const set = (key: string, value: string) => {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    };
    try {
      // A process-level custom endpoint applies to every Codex spawn.
      set("OPENAI_BASE_URL", "https://example.invalid/v1");
      const bare = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-proc-"));
      expect(stacks.loginEvidence({ kind: "codex", home: bare, env: {} } as never)).toBeNull();
      delete process.env.OPENAI_BASE_URL;

      // Present but not a readable regular file: it might select a provider,
      // so it must never read as logged out.
      const blocked = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-dir-"));
      mkdirSync(path.join(blocked, ".codex", "config.toml"), { recursive: true });
      expect(stacks.loginEvidence({ kind: "codex", home: blocked, env: {} } as never)).toBeNull();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // Review B1: on macOS, Claude Code keeps a CLAUDE_CONFIG_DIR account's
  // OAuth login in the keychain and writes no `.credentials.json`. Every real
  // backup account looked logged out, so failover skipped all of them.
  describe("macOS keychain login (B1)", () => {
    // Restore the defaults (N10b). Under `bun test` the default probe answers
    // "no item" without touching the real keychain, as the outer fixture did.
    afterAll(() => stacks.setLoginEvidenceDepsForTests(null));

    function probeRecording(result: boolean | null) {
      const services: string[] = [];
      const probe = (service: string) => {
        services.push(service);
        return result;
      };
      return { services, probe };
    }

    test("darwin + pinned dir + no credentials file: the keychain item decides", () => {
      const home = claudeHome();
      const expected = `Claude Code-credentials-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;

      const found = probeRecording(true);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: found.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBe(true);
      expect(found.services).toEqual([expected]);

      const missing = probeRecording(false);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: missing.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBe(false);

      // A failed lookup (timeout, locked keychain, no `security`) is unknown,
      // never a logout.
      const broken = probeRecording(null);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: broken.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBeNull();
    });

    test("the env map's CLAUDE_CONFIG_DIR is the hashed value, as given", () => {
      const home = claudeHome();
      const pinned = claudeHome();
      const rec = probeRecording(true);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: rec.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: { CLAUDE_CONFIG_DIR: pinned } } as never)).toBe(true);
      expect(rec.services).toEqual([
        `Claude Code-credentials-${createHash("sha256").update(pinned).digest("hex").slice(0, 8)}`,
      ]);
    });

    test("a credentials file still wins without a lookup", () => {
      const home = claudeHome({ ".credentials.json": "{}" });
      const rec = probeRecording(false);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: rec.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBe(true);
      expect(rec.services).toEqual([]);
    });

    test("non-darwin is unchanged: no file means logged out, no lookup", () => {
      const home = claudeHome();
      const rec = probeRecording(true);
      stacks.setLoginEvidenceDepsForTests({ platform: "linux", keychainProbe: rec.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never)).toBe(false);
      expect(rec.services).toEqual([]);
    });

    test("the built-in account (no config dir) stays unknown without a lookup", () => {
      const rec = probeRecording(false);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: rec.probe });
      expect(stacks.loginEvidence({ kind: "claude-code", home: null, env: {} } as never)).toBeNull();
      expect(rec.services).toEqual([]);
    });

    test("the lookup is cached per service", () => {
      const home = claudeHome();
      const rec = probeRecording(true);
      stacks.setLoginEvidenceDepsForTests({ platform: "darwin", keychainProbe: rec.probe });
      stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never);
      stacks.loginEvidence({ kind: "claude-code", home, env: {} } as never);
      expect(rec.services.length).toBe(1);
    });

    test("an async lookup never blocks: unknown until it lands, one lookup per service (R-S10)", async () => {
      const home = claudeHome();
      const calls: string[] = [];
      let release!: (value: boolean | null) => void;
      const pending = new Promise<boolean | null>((resolve) => { release = resolve; });
      stacks.setLoginEvidenceDepsForTests({
        platform: "darwin",
        keychainProbe: (service) => {
          calls.push(service);
          return pending;
        },
      });
      const harness = { kind: "claude-code", home, env: {} } as never;
      // A miss returns unknown at once and starts one background lookup…
      expect(stacks.loginEvidence(harness)).toBeNull();
      // …which a second reader joins instead of starting another.
      expect(stacks.loginEvidence(harness)).toBeNull();
      expect(calls).toHaveLength(1);
      release(false);
      await stacks.settleKeychainProbesForTests();
      expect(stacks.loginEvidence(harness)).toBe(false);
      expect(calls).toHaveLength(1);
    });

    test("a stale answer is served while one background refresh runs (R-S10)", async () => {
      const home = claudeHome();
      let answer: boolean | null = true;
      let calls = 0;
      stacks.setLoginEvidenceDepsForTests({
        platform: "darwin",
        keychainProbe: async () => {
          calls++;
          return answer;
        },
      });
      const harness = { kind: "claude-code", home, env: {} } as never;
      expect(stacks.loginEvidence(harness)).toBeNull();
      await stacks.settleKeychainProbesForTests();
      expect(stacks.loginEvidence(harness)).toBe(true);
      expect(calls).toBe(1);
      // A minute later the entry is stale: the old answer is served while the
      // refresh runs, then the new one.
      answer = false;
      const realNow = Date.now;
      Date.now = () => realNow() + 61_000;
      try {
        expect(stacks.loginEvidence(harness)).toBe(true);
        expect(stacks.loginEvidence(harness)).toBe(true);
        expect(calls).toBe(2);
        await stacks.settleKeychainProbesForTests();
        expect(stacks.loginEvidence(harness)).toBe(false);
      } finally {
        Date.now = realNow;
      }
    });

    test("the real lookup: existence-only argv and the exit-code mapping, through an injected runner (R-S10)", async () => {
      const home = claudeHome();
      const service = `Claude Code-credentials-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
      const runs: Array<{ argv: string[]; timeoutMs: number }> = [];
      let exit: number | null = 0;
      stacks.setLoginEvidenceDepsForTests({
        platform: "darwin",
        securityRunner: async (argv, timeoutMs) => {
          runs.push({ argv, timeoutMs });
          return exit;
        },
      });
      const harness = { kind: "claude-code", home, env: {} } as never;
      expect(stacks.loginEvidence(harness)).toBeNull();
      await stacks.settleKeychainProbesForTests();
      expect(stacks.loginEvidence(harness)).toBe(true);
      // Never `-w`/`-g`: the secret is never read.
      expect(runs).toEqual([{ argv: ["/usr/bin/security", "find-generic-password", "-s", service], timeoutMs: 2_000 }]);

      for (const [code, expected] of [[0, true], [44, false], [1, null], [51, null], [null, null]] as const) {
        exit = code;
        expect(await stacks.securityItemExists(service, async () => exit)).toBe(expected);
      }
      expect(await stacks.securityItemExists(service, async () => { throw new Error("spawn failed"); })).toBeNull();
    });

    test("the real runner reports exit codes and maps a timeout to null (R-S10)", async () => {
      expect(await stacks.runSecurity(["/bin/sh", "-c", "exit 44"], 2_000)).toBe(44);
      expect(await stacks.runSecurity(["/bin/sh", "-c", "exit 0"], 2_000)).toBe(0);
      expect(await stacks.runSecurity(["/bin/sh", "-c", "sleep 5"], 100)).toBeNull();
      expect(await stacks.runSecurity(["/nonexistent/agetor-security-probe"], 2_000)).toBeNull();
    });

    test("service name: sha256 of the dir string exactly (trailing slash and secure-storage override)", () => {
      expect(stacks.claudeKeychainServiceFor({ home: null }, "/Users/alice/.agetor/harnesses/claude-backup"))
        .toBe("Claude Code-credentials-111767e8");
      expect(stacks.claudeKeychainServiceFor({ home: null }, "/Users/alice/.agetor/harnesses/claude-backup/"))
        .toBe("Claude Code-credentials-c70e3e00");
      expect(stacks.claudeKeychainServiceFor(
        { home: null, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/srv/secure-store" } },
        "/ignored",
      )).toBe("Claude Code-credentials-523ed66e");
      // Set but empty selects the unsuffixed shared item: unattributable.
      expect(stacks.claudeKeychainServiceFor({ home: null, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } }, "/x"))
        .toBeNull();
    });
  });

  test("Codex: a keyring/auto credential store with no auth.json is unknown, not logged out (S19)", () => {
    for (const store of ["keyring", "auto"]) {
      const home = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-keyring-"));
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(path.join(home, ".codex", "config.toml"), `cli_auth_credentials_store = "${store}"\n`);
      expect(stacks.loginEvidence({ kind: "codex", home, env: {} } as never)).toBeNull();
    }
    const fileStore = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-filestore-"));
    mkdirSync(path.join(fileStore, ".codex"), { recursive: true });
    writeFileSync(path.join(fileStore, ".codex", "config.toml"), `cli_auth_credentials_store = "file"\n`);
    expect(stacks.loginEvidence({ kind: "codex", home: fileStore, env: {} } as never)).toBe(false);
  });

  test("Codex: an env-map HOME with no CODEX_HOME reads <HOME>/.codex (S17)", () => {
    const realHome = mkdtempSync(path.join(tmpdir(), "agetor-login-codex-envhome-"));
    mkdirSync(path.join(realHome, ".codex"), { recursive: true });
    writeFileSync(path.join(realHome, ".codex", "auth.json"), "{}");
    expect(stacks.loginEvidence({ kind: "codex", home: null, env: { HOME: realHome } } as never)).toBe(true);
  });

  test("a process-level cloud credential warns on stack creation (R15-S2)", () => {
    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    try {
      const warnings = stacks.validateInput(input(["stack-a", "stack-b"])).warnings;
      const warning = warnings.find((w) => w.code === "process-provider-key");
      expect(warning?.message).toContain("AWS_SECRET_ACCESS_KEY");
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
    }
    // A credential for a provider this kind never reads must not warn.
    const github = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-token";
    try {
      const warnings = stacks.validateInput(input(["stack-a", "stack-b"])).warnings;
      expect(warnings.some((w) => w.code === "process-provider-key")).toBe(false);
    } finally {
      if (github === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = github;
    }
  });
});
