import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. hook-installer
// imports db.ts indirectly via dataDir for the worktree-namespace check.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-hook-installer-"));

function makeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-hook-target-"));
}

function readSettings(cwd: string): Record<string, unknown> {
  const file = path.join(cwd, ".claude", "settings.local.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

beforeEach(() => {
  // No per-test setup needed — agetor materialises no shared files any more.
});

test("ensureInstalledMerged: writes a clean settings file into an empty repo (no hook, no MCP)", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const paths = await ensureInstalledMerged(cwd);
  expect(paths).not.toBeNull();

  const settings = readSettings(cwd) as { hooks?: { PreToolUse?: unknown[] }; mcpServers?: Record<string, unknown> };
  // Agetor is non-invasive: it installs no PreToolUse hook and no MCP server.
  expect(settings.hooks?.PreToolUse).toBeUndefined();
  expect(settings.mcpServers).toBeUndefined();
  // And it never writes a CLAUDE.md.
  expect(existsSync(path.join(cwd, ".claude", "CLAUDE.md"))).toBe(false);
});

test("ensureInstalledMerged: preserves a pre-existing user PreToolUse entry", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  // The user already configured their own hook.
  const existing = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/user-hook.sh" }] },
      ],
    },
    permissions: { allow: ["Bash(git push *)"] },
  };
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify(existing));

  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    permissions: { allow: string[] };
  };
  // The user's own hook is preserved; agetor adds none of its own.
  expect(settings.hooks.PreToolUse.length).toBe(1);
  const userEntry = settings.hooks.PreToolUse.find((e) => e.matcher === "Bash");
  expect(userEntry?.hooks[0]?.command).toBe("/usr/local/bin/user-hook.sh");
  // Untouched siblings still there.
  expect(settings.permissions.allow).toEqual(["Bash(git push *)"]);
});

test("ensureInstalledMerged: re-merge stays clean — never installs a PreToolUse hook or MCP", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  await ensureInstalledMerged(cwd);
  await ensureInstalledMerged(cwd);
  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { hooks?: { PreToolUse?: unknown[] }; mcpServers?: Record<string, unknown> };
  expect(settings.hooks?.PreToolUse).toBeUndefined();
  expect(settings.mcpServers).toBeUndefined();
});

test("ensureInstalledMerged: strips a stale agetor PreToolUse hook from a previous data-dir", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  // Settings left behind by a previous AGETOR_DATA_DIR location.
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    hooks: {
      PreToolUse: [
        // The stale agetor entry — different path than the current install.
        { matcher: ".*", hooks: [{ type: "command", command: "/old/path/agetor-approval-hook.sh" }] },
        // A user entry that must survive.
        { matcher: "Edit", hooks: [{ type: "command", command: "/u/h.sh" }] },
      ],
    },
  }));

  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  // Stale agetor entry gone, user entry preserved, and NO fresh agetor entry
  // re-added (agetor no longer installs a hook — it only strips its old ones).
  const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  expect(commands).not.toContain("/old/path/agetor-approval-hook.sh");
  expect(commands).toContain("/u/h.sh");
  expect(commands.some((c) => c.endsWith("agetor-approval-hook.sh"))).toBe(false);
});

test("ensureInstalledMerged: strips a stale `mcpServers.agetor` registration (no new one added)", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  // Settings a previous agetor build wrote: the `agetor` MCP launcher plus an
  // unrelated user-installed MCP server that must survive untouched.
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    mcpServers: {
      agetor: { command: "/old/.agetor/bin/agetor-mcp.sh" },
      context7: { command: "/u/context7.sh" },
    },
  }));

  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { mcpServers: Record<string, { command: string }> };
  // The stale agetor registration is gone, and none is re-added.
  expect(settings.mcpServers.agetor).toBeUndefined();
  // Every other MCP server is left exactly as it was.
  expect(settings.mcpServers.context7?.command).toBe("/u/context7.sh");
});

test("ensureInstalledMerged: drops the whole mcpServers object once the only key (agetor) is stripped", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    mcpServers: { agetor: { command: "/old/.agetor/bin/agetor-mcp.sh" } },
  }));

  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { mcpServers?: Record<string, unknown> };
  // Mirrors the empty-PreToolUse handling: drop the key, don't leave `{}`.
  expect(settings.mcpServers).toBeUndefined();
});

test("ensureInstalledMerged: refuses to overwrite malformed JSON and returns null", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.local.json");
  writeFileSync(file, "{ this is not json");

  const result = await ensureInstalledMerged(cwd);
  expect(result).toBeNull();
  // Original content untouched.
  expect(readFileSync(file, "utf8")).toBe("{ this is not json");
});

test("ensureInstalledMerged: refuses to overwrite a JSON array (must be an object)", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.local.json");
  writeFileSync(file, JSON.stringify([1, 2, 3]));

  const result = await ensureInstalledMerged(cwd);
  expect(result).toBeNull();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([1, 2, 3]);
});

test("ensureInstalledMerged: empty file content treated as fresh install", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), "   \n  ");

  const result = await ensureInstalledMerged(cwd);
  expect(result).not.toBeNull();
  const settings = readSettings(cwd) as { hooks?: { PreToolUse?: unknown[] }; mcpServers?: Record<string, unknown> };
  expect(settings.hooks?.PreToolUse).toBeUndefined();
  expect(settings.mcpServers).toBeUndefined();
});

test("ensureInstalledMerged: returns null when the cwd doesn't exist", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const missing = path.join(tmpdir(), "definitely-not-a-real-dir-" + Date.now());
  expect(existsSync(missing)).toBe(false);
  expect(await ensureInstalledMerged(missing)).toBeNull();
});

test("ensureInstalled (owned worktree): writes a clean settings file — no hook, no MCP, no CLAUDE.md", async () => {
  const { ensureInstalled } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  await ensureInstalled(cwd);
  const settings = readSettings(cwd) as {
    hooks?: { PreToolUse?: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(settings.hooks?.PreToolUse).toBeUndefined();
  expect(settings.mcpServers).toBeUndefined();
  expect(existsSync(path.join(cwd, ".claude", "CLAUDE.md"))).toBe(false);
});

test("ensureInstalledForCwd: cleans up inside an agetor-owned worktree", async () => {
  const { ensureInstalledForCwd } = await import("./hook-installer.ts");
  // Simulate an agetor-owned worktree path. `dataDir` is the AGETOR_DATA_DIR
  // we set at the top of this file, so anything under it counts as owned.
  const owned = path.join(process.env.AGETOR_DATA_DIR!, "worktrees", "fake-task");
  require("node:fs").mkdirSync(owned, { recursive: true });

  const paths = await ensureInstalledForCwd(owned, "ask");
  expect(paths).not.toBeNull();
  const settings = readSettings(owned) as {
    hooks?: { PreToolUse?: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(settings.hooks?.PreToolUse).toBeUndefined();
  expect(settings.mcpServers).toBeUndefined();
});

test("ensureInstalled preserves `permissions.allow` and other keys across re-spawns (regression)", async () => {
  // Repro of the bug where ensureInstalled built a fresh settings object
  // on every call, clobbering pre-existing `permissions.allow` entries
  // between the first task spawn and a re-run. Today those entries come
  // from: legacy agetor builds (saveAllowRule used to write per-cwd),
  // direct user edits, or a manual `claude` invocation inside the
  // worktree. This test simulates: (1) initial install, (2) an entry is
  // written into the same settings file, (3) re-spawn calls
  // ensureInstalled again — the entry must survive.
  const { ensureInstalled } = await import("./hook-installer.ts");
  const owned = path.join(process.env.AGETOR_DATA_DIR!, "worktrees", "regression-task");
  require("node:fs").mkdirSync(owned, { recursive: true });

  // 1. First install (fresh worktree, no settings file).
  await ensureInstalled(owned);

  // 2. Simulate a permissions.allow entry landing in the same settings
  //    file (from any of the sources noted above).
  const settingsFile = path.join(owned, ".claude", "settings.local.json");
  const after1 = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
  after1.permissions = { allow: ["Bash(git status)"] };
  // Also add an unrelated user-authored top-level key — must survive too.
  after1.experimentalUserKey = { keep: true };
  require("node:fs").writeFileSync(settingsFile, JSON.stringify(after1, null, 2));

  // 3. Re-spawn: ensureInstalled runs again on the same cwd.
  await ensureInstalled(owned);

  const final = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
  expect(final.permissions?.allow).toEqual(["Bash(git status)"]);
  expect(final.experimentalUserKey).toEqual({ keep: true });
  // No agetor PreToolUse hook and no MCP are installed.
  expect(final.hooks?.PreToolUse).toBeUndefined();
  expect(final.mcpServers).toBeUndefined();
});

test("ensureInstalled: strips permission entries claude's parser would reject (owned worktree self-heal)", async () => {
  const { ensureInstalled } = await import("./hook-installer.ts");
  const owned = makeCwd();
  const dir = path.join(owned, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  // A settings file an older "Allow always" save poisoned: two valid rules
  // plus three claude would reject at startup (paren / newline / empty).
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    permissions: {
      allow: [
        "Bash(git status)",
        "Bash(echo $((1+1)))",
        "Bash(cat <<'EOF'\nx\nEOF)",
        "Bash()",
        "Edit(/repo/src/**)",
      ],
    },
  }));

  await ensureInstalled(owned);

  const settings = readSettings(owned) as { permissions: { allow: string[] } };
  expect(settings.permissions.allow).toEqual(["Bash(git status)", "Edit(/repo/src/**)"]);
});

test("ensureInstalledMerged: does NOT strip a user repo's own permission entries", async () => {
  // The user's source repo (isolation=none) — we strip our stale entries but
  // must never silently delete the user's version-controlled rules, even ones
  // claude would itself reject. claude's own startup dialog surfaces those.
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    permissions: { allow: ["Bash(git status)", "Bash(echo $((1+1)))"] },
  }));

  await ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { permissions: { allow: string[] } };
  expect(settings.permissions.allow).toEqual(["Bash(git status)", "Bash(echo $((1+1)))"]);
});
