import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plainEncodedProjectPath } from "../shared/claude-session-meta.ts";

// harness-discovery → worktree → db.ts opens sqlite on import.
process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-scan-db-"));

const {
  claudeSessionLivenessCheckedAt,
  clearClaudeSessionLivenessCache,
  clearClaudeSessionMetaCache,
  findClaudeSession,
  refreshClaudeSessionLiveness,
  scanClaudeSessions,
} = await import("./claude-session-scan.ts");

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-scan-home-"));
  homes.push(dir);
  return dir;
}

function plant(opts: {
  home: string;
  configName?: string;
  dirName: string;
  sessionId: string;
  cwd: string;
  lines: unknown[];
  registry?: unknown;
}): string {
  const config = path.join(opts.home, opts.configName ?? ".claude");
  const dir = path.join(config, "projects", opts.dirName);
  mkdirSync(dir, { recursive: true });
  const body = opts.lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(path.join(dir, `${opts.sessionId}.jsonl`), body);
  if (opts.registry) {
    const sessions = path.join(config, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "1.json"), JSON.stringify(opts.registry));
  }
  return config;
}

function userLine(cwd: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    cwd,
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  };
}

const harnessFor = (configDir: string) => [{ id: "claude-code", kind: "claude-code", home: configDir }];

test("scan hides owned, worktree, agetor tmux, temp agetor, and empty transcripts", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const enc = plainEncodedProjectPath(cwd);
  const config = plant({
    home: root,
    dirName: enc,
    sessionId: "keep-me",
    cwd,
    lines: [userLine(cwd, "hello", { gitBranch: "main", timestamp: "2026-10-02T00:00:00.000Z" })],
  });
  plant({
    home: root,
    dirName: enc,
    sessionId: "owned-id",
    cwd,
    lines: [userLine(cwd, "owned")],
  });
  const wt = path.join(root, "worktrees", "task");
  mkdirSync(wt, { recursive: true });
  plant({
    home: root,
    dirName: enc,
    sessionId: "in-worktree",
    cwd: wt,
    lines: [userLine(wt, "wt")],
  });
  plant({
    home: root,
    dirName: enc,
    sessionId: "ours",
    cwd,
    lines: [userLine(cwd, "tmux")],
    registry: { sessionId: "ours", pid: 1, tmux: "agetor-07b34738-b02:@1.%1", kind: "interactive" },
  });
  const tempCwd = path.join(tmpdir(), "agetor-scan-fixture", "proj");
  plant({
    home: root,
    dirName: "tempdir",
    sessionId: "temp-one",
    cwd: tempCwd,
    lines: [userLine(tempCwd, "temp")],
  });
  plant({
    home: root,
    dirName: enc,
    sessionId: "empty-one",
    cwd,
    lines: [{ type: "assistant", cwd, message: { model: "claude-opus-4-6", content: "only" }, timestamp: "2026-10-03T00:00:00.000Z" }],
  });
  plant({
    home: root,
    dirName: enc,
    sessionId: "continued",
    cwd,
    lines: [userLine(cwd, "old", { continuedIn: "keep-me" })],
  });

  const sentinel = path.join(root, "claude-was-spawned");
  const rows = await scanClaudeSessions({
    homeDir: root,
    env: { AGETOR_CLAUDE_BIN: sentinel },
    ownedSessionIds: new Set(["owned-id"]),
    worktreeRoots: [path.join(root, "worktrees")],
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: () => [],
  });
  expect(rows.map((r) => r.sessionId)).toEqual(["keep-me"]);
  expect(rows[0]?.importable).toBe(true);
  expect(rows[0]?.liveness).toBe("idle");
  expect(rows[0]?.blockedReason).toBeNull();
  expect(rows[0]?.harnessId).toBe("claude-code");
  const { existsSync } = await import("node:fs");
  expect(existsSync(sentinel)).toBe(false);
});

test("scan marks live and no-harness and sorts newest first", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const enc = plainEncodedProjectPath(cwd);
  const config = plant({
    home: root,
    dirName: enc,
    sessionId: "older",
    cwd,
    lines: [userLine(cwd, "old", { timestamp: "2026-10-01T00:00:00.000Z" })],
  });
  plant({
    home: root,
    dirName: enc,
    sessionId: "newer",
    cwd,
    lines: [userLine(cwd, "new", { timestamp: "2026-10-05T00:00:00.000Z" })],
  });
  plant({
    home: root,
    configName: ".claude-other",
    dirName: enc,
    sessionId: "other-acct",
    cwd,
    lines: [userLine(cwd, "other", { timestamp: "2026-10-04T00:00:00.000Z" })],
  });

  const rows = await scanClaudeSessions({
    homeDir: root,
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: (dir) => dir === config ? [{ sessionId: "newer", kind: "background" }] : [],
  });
  expect(rows.map((r) => r.sessionId)).toEqual(["newer", "other-acct", "older"]);
  const newer = rows[0]!;
  expect(newer.liveness).toBe("live");
  expect(newer.blockedReason).toBe("live");
  expect(newer.importable).toBe(false);
  expect(newer.liveHint).toBe("claude stop newer");
  const other = rows.find((r) => r.sessionId === "other-acct")!;
  expect(other.blockedReason).toBe("no-harness");
  expect(other.importable).toBe(false);
  expect(other.liveness).toBe("idle");
});

test("a long plain encoding is long-path until encode returns the directory name", async () => {
  const root = home();
  const cwd = path.join(root, "p".repeat(210));
  mkdirSync(cwd, { recursive: true });
  expect(plainEncodedProjectPath(cwd).length).toBeGreaterThan(200);
  const config = plant({
    home: root,
    dirName: "short",
    sessionId: "long-one",
    cwd,
    lines: [userLine(cwd, "long path")],
  });
  const base = {
    homeDir: root,
    harnesses: harnessFor(config),
    listLive: () => [] as { sessionId: string; kind: string | null }[],
  };
  const blocked = await scanClaudeSessions({ ...base, encodePath: plainEncodedProjectPath });
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.blockedReason).toBe("long-path");
  expect(blocked[0]?.importable).toBe(false);

  const open = await scanClaudeSessions({ ...base, encodePath: () => "short" });
  expect(open[0]?.blockedReason).toBeNull();
  expect(open[0]?.importable).toBe(true);
  expect(open[0]?.liveness).toBe("idle");
});

test("a failed liveness probe drops a stale idle cache", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({
    home: root,
    dirName: plainEncodedProjectPath(cwd),
    sessionId: "idle-one",
    cwd,
    lines: [userLine(cwd, "hello")],
  });
  const stub = path.join(root, "agents.json");
  writeFileSync(stub, "[]");
  clearClaudeSessionLivenessCache();
  try {
    await refreshClaudeSessionLiveness([config], { AGETOR_CLAUDE_AGENTS_JSON: stub });
    const idle = await scanClaudeSessions({
      homeDir: root,
      harnesses: harnessFor(config),
      encodePath: plainEncodedProjectPath,
    });
    expect(idle[0]?.liveness).toBe("idle");
    expect(idle[0]?.importable).toBe(true);

    await refreshClaudeSessionLiveness([config], { AGETOR_CLAUDE_BIN: "/bin/false" });
    const unknown = await scanClaudeSessions({
      homeDir: root,
      harnesses: harnessFor(config),
      encodePath: plainEncodedProjectPath,
    });
    expect(unknown[0]?.liveness).toBe("unknown");
    expect(unknown[0]?.importable).toBe(false);
  } finally {
    clearClaudeSessionLivenessCache();
  }
});

test("a session whose folder is gone is listed but blocked, and a re-check keeps it blocked", async () => {
  const root = home();
  const cwd = path.join(root, "deleted-repo");
  const config = plant({
    home: root,
    dirName: plainEncodedProjectPath(cwd),
    sessionId: "gone-folder",
    cwd,
    lines: [userLine(cwd, "old work")],
  });
  const opts = {
    homeDir: root,
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: () => [] as { sessionId: string; kind: string | null }[],
  };
  const rows = await scanClaudeSessions(opts);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.blockedReason).toBe("missing-folder");
  expect(rows[0]?.importable).toBe(false);
  expect(rows[0]?.liveness).toBe("idle");
  expect(rows[0]?.liveBranch).toBeNull();

  const found = await findClaudeSession("gone-folder", opts);
  expect(found?.blockedReason).toBe("missing-folder");
  expect(found?.importable).toBe(false);
});

test("a list skips owned files unread, reuses an unchanged parse, and re-reads a grown file", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const enc = plainEncodedProjectPath(cwd);
  const config = plant({ home: root, dirName: enc, sessionId: "mine", cwd, lines: [userLine(cwd, "outside")] });
  plant({ home: root, dirName: enc, sessionId: "agetor-owned", cwd, lines: [userLine(cwd, "ours")] });
  const reads: string[] = [];
  const opts = {
    homeDir: root,
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: () => [] as { sessionId: string; kind: string | null }[],
    ownedSessionIds: new Set(["agetor-owned"]),
    onJsonlRead: (file: string) => reads.push(path.basename(file)),
  };
  clearClaudeSessionMetaCache();
  try {
    expect((await scanClaudeSessions(opts)).map((r) => r.sessionId)).toEqual(["mine"]);
    expect(reads).toEqual(["mine.jsonl"]);

    reads.length = 0;
    expect((await scanClaudeSessions(opts)).map((r) => r.title)).toEqual(["outside"]);
    expect(reads).toEqual([]);

    appendFileSync(
      path.join(config, "projects", enc, "mine.jsonl"),
      JSON.stringify({ type: "ai-title", aiTitle: "Renamed later" }) + "\n",
    );
    reads.length = 0;
    expect((await scanClaudeSessions(opts)).map((r) => r.title)).toEqual(["Renamed later"]);
    expect(reads).toEqual(["mine.jsonl"]);

    // A lookup by id still finds an owned session (the commit path refuses it by name).
    reads.length = 0;
    const owned = await findClaudeSession("agetor-owned", opts);
    expect(owned?.sessionId).toBe("agetor-owned");
    expect(reads).toEqual(["agetor-owned.jsonl"]);
  } finally {
    clearClaudeSessionMetaCache();
  }
});

test("a folder named like an Agetor worktree is peeked, and only a real worktree cwd skips the parse", async () => {
  const root = home();
  // Not named `.agetor`: under tmpdir that alone hides a cwd (isTempAgetorCwd).
  const worktrees = path.join(root, "data", "worktrees");
  const wt = path.join(worktrees, "task-1");
  mkdirSync(wt, { recursive: true });
  const config = plant({
    home: root,
    dirName: plainEncodedProjectPath(wt),
    sessionId: "in-agetor-worktree",
    cwd: wt,
    lines: [userLine(wt, "agent work")],
  });
  // `worktrees-x` encodes with the same prefix but is not under the root.
  const lookalike = path.join(root, "data", "worktrees-x");
  mkdirSync(lookalike, { recursive: true });
  plant({
    home: root,
    dirName: plainEncodedProjectPath(lookalike),
    sessionId: "lookalike",
    cwd: lookalike,
    lines: [userLine(lookalike, "user work")],
  });
  const reads: string[] = [];
  clearClaudeSessionMetaCache();
  try {
    const rows = await scanClaudeSessions({
      homeDir: root,
      harnesses: harnessFor(config),
      worktreeRoots: [worktrees],
      encodePath: plainEncodedProjectPath,
      listLive: () => [],
      onJsonlRead: (file) => reads.push(path.basename(file)),
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["lookalike"]);
    expect(reads).toEqual(["lookalike.jsonl"]);
  } finally {
    clearClaudeSessionMetaCache();
  }
});

test("the liveness probe runs the owning harness's bin and records when it ran", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({
    home: root,
    dirName: plainEncodedProjectPath(cwd),
    sessionId: "probe-bin",
    cwd,
    lines: [userLine(cwd, "hello")],
  });
  const marker = path.join(root, "custom-claude-ran");
  const bin = path.join(root, "custom-claude");
  writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '[]'\n`);
  chmodSync(bin, 0o755);
  clearClaudeSessionLivenessCache();
  try {
    expect(claudeSessionLivenessCheckedAt([config])).toBeNull();
    const before = Date.now();
    await refreshClaudeSessionLiveness(
      [config],
      { PATH: process.env.PATH, AGETOR_CLAUDE_BIN: "/bin/false" },
      [{ id: "work-claude", kind: "claude-code", home: config, bin }],
      root,
    );
    expect(existsSync(marker)).toBe(true);
    const checkedAt = claudeSessionLivenessCheckedAt([config]);
    expect(checkedAt).not.toBeNull();
    expect(checkedAt!).toBeGreaterThanOrEqual(before);
    const rows = await scanClaudeSessions({
      homeDir: root,
      harnesses: [{ id: "work-claude", kind: "claude-code", home: config, bin }],
      encodePath: plainEncodedProjectPath,
    });
    expect(rows[0]?.liveness).toBe("idle");
    expect(rows[0]?.importable).toBe(true);
  } finally {
    clearClaudeSessionLivenessCache();
  }
});

// An agent can plant a symlink where Claude writes regular files; the core
// must never open or list through it (no-follow.ts).
test("a symlinked transcript or project dir is skipped, never read through", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const enc = plainEncodedProjectPath(cwd);
  const config = plant({ home: root, dirName: enc, sessionId: "real", cwd, lines: [userLine(cwd, "hi")] });
  // A "protected" target outside the config dir, reached only via symlinks.
  const outside = path.join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "planted.jsonl"), JSON.stringify(userLine(cwd, "secret")) + "\n");
  symlinkSync(path.join(outside, "planted.jsonl"), path.join(config, "projects", enc, "via-file-link.jsonl"));
  symlinkSync(outside, path.join(config, "projects", `${enc}-dirlink`));

  const read: string[] = [];
  const rows = await scanClaudeSessions({
    homeDir: root,
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: () => [],
    onJsonlRead: (p) => read.push(p),
  });
  expect(rows.map((r) => r.sessionId)).toEqual(["real"]);
  expect(read.every((p) => !p.includes("via-file-link") && !p.includes("dirlink"))).toBe(true);
});

// One level up: a whole `projects/` (or `sessions/`) folder linked elsewhere is
// never listed in-process either — only the config dir itself is trusted.
test("a symlinked projects/ or sessions/ folder is not listed", async () => {
  const root = home();
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const enc = plainEncodedProjectPath(cwd);
  // The real transcripts live outside the config dir…
  const outsideConfig = plant({ home: root, configName: "outside-config", dirName: enc, sessionId: "planted", cwd, lines: [userLine(cwd, "secret")] });
  // …and the scanned config dir reaches them only through symlinked folders.
  const config = path.join(root, ".claude");
  mkdirSync(config, { recursive: true });
  symlinkSync(path.join(outsideConfig, "projects"), path.join(config, "projects"));
  mkdirSync(path.join(outsideConfig, "sessions"), { recursive: true });
  writeFileSync(path.join(outsideConfig, "sessions", "1.json"), JSON.stringify({ sessionId: "planted", pid: 1 }));
  symlinkSync(path.join(outsideConfig, "sessions"), path.join(config, "sessions"));

  const read: string[] = [];
  const rows = await scanClaudeSessions({
    homeDir: root,
    harnesses: harnessFor(config),
    encodePath: plainEncodedProjectPath,
    listLive: () => [],
    onJsonlRead: (p) => read.push(p),
  });
  expect(rows).toEqual([]);
  expect(read).toEqual([]);
  const { readClaudeRegistry } = await import("./claude-session-scan.ts");
  expect(readClaudeRegistry(config)).toEqual([]);
});
