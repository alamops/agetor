import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. hook-installer
// imports db.ts indirectly via dataDir for the bin/ directory path.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-hook-installer-"));

function makeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-hook-target-"));
}

function readSettings(cwd: string): Record<string, unknown> {
  const file = path.join(cwd, ".claude", "settings.local.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

beforeEach(() => {
  // Each test gets a fresh dataDir-derived bin/ — materialiseSharedFiles is
  // memoised per-process so we only verify *behaviour around* the shared
  // files, not that they're re-written each time.
});

test("ensureInstalledMerged: writes hook + MCP entry into an empty repo", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const paths = ensureInstalledMerged(cwd);
  expect(paths).not.toBeNull();

  const settings = readSettings(cwd) as { hooks?: { PreToolUse?: unknown[] }; mcpServers?: Record<string, unknown> };
  // Exactly one agetor PreToolUse entry.
  expect(Array.isArray(settings.hooks?.PreToolUse)).toBe(true);
  expect(settings.hooks!.PreToolUse!.length).toBe(1);
  // mcpServers.agetor present.
  expect(settings.mcpServers?.agetor).toBeDefined();
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

  ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    permissions: { allow: string[] };
  };
  // Both the user's entry and ours are present.
  expect(settings.hooks.PreToolUse.length).toBe(2);
  const userEntry = settings.hooks.PreToolUse.find((e) => e.matcher === "Bash");
  expect(userEntry?.hooks[0]?.command).toBe("/usr/local/bin/user-hook.sh");
  // Untouched siblings still there.
  expect(settings.permissions.allow).toEqual(["Bash(git push *)"]);
});

test("ensureInstalledMerged: re-merge is idempotent — no duplicate agetor entry", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  ensureInstalledMerged(cwd);
  ensureInstalledMerged(cwd);
  ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { hooks: { PreToolUse: unknown[] } };
  expect(settings.hooks.PreToolUse.length).toBe(1);
});

test("ensureInstalledMerged: strips stale agetor entries from a previous data-dir", async () => {
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

  ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  // Stale agetor entry gone, user entry preserved, our fresh entry added.
  const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  expect(commands).not.toContain("/old/path/agetor-approval-hook.sh");
  expect(commands).toContain("/u/h.sh");
  expect(commands.some((c) => c.endsWith("agetor-approval-hook.sh"))).toBe(true);
});

test("ensureInstalledMerged: leaves a user-claimed `agetor` MCP server name alone", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    mcpServers: {
      // User picked the same name for an unrelated server.
      agetor: { command: "/u/their-agetor.sh" },
    },
  }));

  ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { mcpServers: { agetor: { command: string } } };
  expect(settings.mcpServers.agetor.command).toBe("/u/their-agetor.sh");
});

test("ensureInstalledMerged: refuses to overwrite malformed JSON and returns null", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.local.json");
  writeFileSync(file, "{ this is not json");

  const result = ensureInstalledMerged(cwd);
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

  const result = ensureInstalledMerged(cwd);
  expect(result).toBeNull();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([1, 2, 3]);
});

test("ensureInstalledMerged: empty file content treated as fresh install", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), "   \n  ");

  const result = ensureInstalledMerged(cwd);
  expect(result).not.toBeNull();
  const settings = readSettings(cwd) as { hooks: { PreToolUse: unknown[] } };
  expect(settings.hooks.PreToolUse.length).toBe(1);
});

test("ensureInstalledMerged: returns null when the cwd doesn't exist", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const missing = path.join(tmpdir(), "definitely-not-a-real-dir-" + Date.now());
  expect(existsSync(missing)).toBe(false);
  expect(ensureInstalledMerged(missing)).toBeNull();
});

test("installScopeForMode: bypass → narrow-no-mcp, auto → narrow, everything else → full", async () => {
  const { installScopeForMode } = await import("./hook-installer.ts");
  expect(installScopeForMode("bypass")).toBe("narrow-no-mcp");
  expect(installScopeForMode("auto")).toBe("narrow");
  // Interactive modes still want UI-routed approval + clarifying-question cards.
  expect(installScopeForMode("ask")).toBe("full");
  expect(installScopeForMode("plan")).toBe("full");
  expect(installScopeForMode("acceptEdits")).toBe("full");
  // Unknown future modes default to full — safer to over-route than to leak
  // hands-off behavior into a mode the user didn't opt into.
  expect(installScopeForMode("future-mode")).toBe("full");
  expect(installScopeForMode(null)).toBe("full");
  expect(installScopeForMode(undefined)).toBe("full");
});

test("ensureInstalled (narrow): matcher only catches AskUserQuestion + ExitPlanMode, MCP + CLAUDE.md wired", async () => {
  const { ensureInstalled } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  ensureInstalled(cwd, "narrow");
  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(settings.hooks.PreToolUse.length).toBe(1);
  expect(settings.hooks.PreToolUse[0]!.matcher).toBe("^(AskUserQuestion|ExitPlanMode)$");
  // narrow keeps the agetor MCP so claude can still call ask_user for clarifications.
  expect(settings.mcpServers?.agetor).toBeDefined();
  // CLAUDE.md is written whenever the MCP is — narrow has MCP, so addendum present.
  expect(existsSync(path.join(cwd, ".claude", "CLAUDE.md"))).toBe(true);
});

test("ensureInstalled (full): CLAUDE.md addendum includes the tool-not-found fallback instruction", async () => {
  // Belt-and-suspenders for the edge case: claude run directly inside an
  // agetor-owned worktree reads CLAUDE.md but the bypassed MCP launcher
  // never registers ask_user. The addendum must instruct the agent to
  // fall back to plain text on tool-not-found rather than retry.
  const { ensureInstalled } = await import("./hook-installer.ts");
  const { readFileSync } = await import("node:fs");
  const cwd = makeCwd();
  ensureInstalled(cwd, "full");
  const addendum = readFileSync(path.join(cwd, ".claude", "CLAUDE.md"), "utf8");
  expect(addendum).toContain("tool not found");
  expect(addendum).toContain("plain text");
});

test("ensureInstalled (narrow-no-mcp): narrow matcher, no MCP server, no CLAUDE.md", async () => {
  const { ensureInstalled } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  ensureInstalled(cwd, "narrow-no-mcp");
  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(settings.hooks.PreToolUse[0]!.matcher).toBe("^(AskUserQuestion|ExitPlanMode)$");
  expect(settings.mcpServers).toBeUndefined();
  expect(existsSync(path.join(cwd, ".claude", "CLAUDE.md"))).toBe(false);
});

test("ensureInstalled (full): matcher is `.*`, MCP wired, CLAUDE.md addendum written", async () => {
  const { ensureInstalled } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  ensureInstalled(cwd, "full");
  const settings = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(settings.hooks.PreToolUse[0]!.matcher).toBe(".*");
  expect(settings.mcpServers?.agetor).toBeDefined();
  // CLAUDE.md addendum teaches claude when to prefer the ask_user MCP
  // tool over plain-text clarification — the central training signal for
  // one of agetor's main value-adds. Always written in owned worktrees;
  // never written to user repos (ensureInstalledMerged path).
  expect(existsSync(path.join(cwd, ".claude", "CLAUDE.md"))).toBe(true);
});

test("ensureInstalledMerged (narrow-no-mcp): strips a previously-installed agetor MCP entry", async () => {
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  // Seed a prior full install — full scope writes an mcpServers.agetor entry.
  ensureInstalledMerged(cwd, "full");
  expect((readSettings(cwd) as { mcpServers?: { agetor?: unknown } }).mcpServers?.agetor).toBeDefined();
  // Re-install with narrow-no-mcp (matches `bypass`): our prior agetor MCP
  // entry must be removed so a hands-off run doesn't leave a dangling
  // clarifying-question channel claude could still call into.
  ensureInstalledMerged(cwd, "narrow-no-mcp");
  const after = readSettings(cwd) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
    mcpServers?: Record<string, unknown>;
  };
  expect(after.hooks.PreToolUse[0]!.matcher).toBe("^(AskUserQuestion|ExitPlanMode)$");
  // Whole mcpServers key is dropped once its only key (`agetor`) is removed.
  expect(after.mcpServers).toBeUndefined();
});

test("ensureInstalledForCwd: overwrites inside an agetor-owned worktree", async () => {
  const { ensureInstalledForCwd } = await import("./hook-installer.ts");
  // Simulate an agetor-owned worktree path. `dataDir` is the AGETOR_DATA_DIR
  // we set at the top of this file, so anything under it counts as owned.
  const owned = path.join(process.env.AGETOR_DATA_DIR!, "worktrees", "fake-task");
  require("node:fs").mkdirSync(owned, { recursive: true });

  const paths = ensureInstalledForCwd(owned, "ask");
  expect(paths).not.toBeNull();
  const settings = readSettings(owned) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
  expect(settings.hooks.PreToolUse.length).toBe(1);
  expect(settings.hooks.PreToolUse[0]!.matcher).toBe(".*");
});

test("ensureInstalled preserves `permissions.allow` across re-spawns (regression)", async () => {
  // Repro of the bug where ensureInstalled built a fresh settings object on
  // every call, clobbering allow-rules written by saveAllowRule between the
  // first task spawn and a re-run. This test simulates: (1) initial install,
  // (2) saveAllowRule appends an entry, (3) re-spawn calls ensureInstalled
  // again — the entry must survive.
  const { ensureInstalled } = await import("./hook-installer.ts");
  const owned = path.join(process.env.AGETOR_DATA_DIR!, "worktrees", "regression-task");
  require("node:fs").mkdirSync(owned, { recursive: true });

  // 1. First install (fresh worktree, no settings file).
  ensureInstalled(owned, "full");

  // 2. Simulate saveAllowRule writing a permissions.allow entry into the
  //    same settings file. (We don't import saveAllowRule here to keep
  //    this test focused on hook-installer behavior; the merge logic in
  //    appendPermissionEntry is exercised by interactions.test.ts.)
  const settingsFile = path.join(owned, ".claude", "settings.local.json");
  const after1 = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
  after1.permissions = { allow: ["Bash(git status)"] };
  // Also add an unrelated user-authored top-level key — must survive too.
  after1.experimentalUserKey = { keep: true };
  require("node:fs").writeFileSync(settingsFile, JSON.stringify(after1, null, 2));

  // 3. Re-spawn: ensureInstalled runs again on the same cwd.
  ensureInstalled(owned, "full");

  const final = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
  expect(final.permissions?.allow).toEqual(["Bash(git status)"]);
  expect(final.experimentalUserKey).toEqual({ keep: true });
  // Hooks + MCP still wired (the actual install we care about).
  expect(final.hooks.PreToolUse).toHaveLength(1);
  expect(final.mcpServers?.agetor).toBeDefined();
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

  ensureInstalled(owned, "full");

  const settings = readSettings(owned) as { permissions: { allow: string[] } };
  expect(settings.permissions.allow).toEqual(["Bash(git status)", "Edit(/repo/src/**)"]);
});

test("ensureInstalledMerged: does NOT strip a user repo's own permission entries", async () => {
  // The user's source repo (isolation=none) — we add our hook but must
  // never silently delete the user's version-controlled rules, even ones
  // claude would itself reject. claude's own startup dialog surfaces those.
  const { ensureInstalledMerged } = await import("./hook-installer.ts");
  const cwd = makeCwd();
  const dir = path.join(cwd, ".claude");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({
    permissions: { allow: ["Bash(git status)", "Bash(echo $((1+1)))"] },
  }));

  ensureInstalledMerged(cwd);

  const settings = readSettings(cwd) as { permissions: { allow: string[] } };
  expect(settings.permissions.allow).toEqual(["Bash(git status)", "Bash(echo $((1+1)))"]);
});
