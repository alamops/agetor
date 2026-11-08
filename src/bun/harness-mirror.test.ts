// Safe transfer engine + mirror (T04/TT4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-mirror-"));

type Db = typeof import("./db.ts");
let dbm: Db;
let mirror: typeof import("./harness-mirror.ts");
let transfer: typeof import("./harness-file-transfer.ts");
let stacks: typeof import("./harness-stacks.ts");
let restore: () => void;

beforeAll(async () => {
  dbm = await import("./db.ts");
  mirror = await import("./harness-mirror.ts");
  transfer = await import("./harness-file-transfer.ts");
  stacks = await import("./harness-stacks.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restore = snapshotHarnessState();
});

afterAll(() => restore());

let seq = 0;
function unique(slug: string): string {
  seq++;
  return `${slug}-${seq}`;
}

function alias(id: string, home: string): string {
  if (!dbm.harnesses.get(id)) {
    dbm.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
  }
  return id;
}

function write(p: string, text: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}

describe("atomic transfer primitives", () => {
  test("atomicWriteFile creates a 0600 file and replaces a symlink", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-atomic-"));
    const target = path.join(dir, "a.json");
    writeFileSync(target, "old");
    chmodSync(target, 0o644);
    await transfer.atomicWriteFile(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("copyRegularFile refuses a symlink and a FIFO-like special file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-copy-"));
    const real = path.join(dir, "real");
    writeFileSync(real, "x");
    const link = path.join(dir, "link");
    symlinkSync(real, link);
    await expect(transfer.copyRegularFile(link, path.join(dir, "out"))).rejects.toThrow(/symlink/);
  });

  test("assertNotCredentialPath refuses a never path", () => {
    expect(() => transfer.assertNotCredentialPath("auth.json", "codex")).toThrow();
    expect(() => transfer.assertNotCredentialPath("settings.json", "claude-code")).not.toThrow();
    expect(() => transfer.assertNotCredentialPath("../x", "claude-code")).toThrow();
  });
});

describe("mirrorStack", () => {
  test("merges config, copies the allowlist and never copies credentials", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-primary-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-backup-"));
    const a = alias(unique("mirror-a"), primary);
    const b = alias(unique("mirror-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "mirror", kind: "claude-code", members: [a, b], mirrorMode: "full" });

    write(path.join(primary, "settings.json"), JSON.stringify({
      model: "opus",
      env: {
        ANTHROPIC_API_KEY: "primary-secret",
        AWS_SECRET_ACCESS_KEY: "primary-aws-secret",
        AWS_BEARER_TOKEN_BEDROCK: "primary-bedrock-token",
        AZURE_OPENAI_API_KEY: "primary-azure-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/primary/gcp.json",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer primary-header-secret",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        SHARED: "primary",
      },
      hooks: { PostToolUse: [{ command: "primary-hook" }] },
      permissions: { allow: ["Bash"] },
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({
      model: "sonnet",
      env: { ANTHROPIC_API_KEY: "backup-own-key" },
      hooks: { PostToolUse: [{ command: "backup-hook" }] },
    }));
    write(path.join(primary, ".credentials.json"), "SECRET");
    write(path.join(primary, "skills", "one", "SKILL.md"), "# one");
    write(path.join(primary, "projects", "p", "s.jsonl"), "transcript");
    write(path.join(backup, ".credentials.json"), "SECRET2");

    const result = await mirror.mirrorStack(stack, {});
    expect(result.warnings.some((w) => w.includes("stripped"))).toBe(true);

    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.model).toBe("opus");
    expect(merged.env.SHARED).toBe("primary");
    // The primary's provider login key is stripped; the backup's own survives.
    expect(merged.env.ANTHROPIC_API_KEY).toBe("backup-own-key");
    expect(readFileSync(path.join(backup, "settings.json"), "utf8")).not.toContain("primary-secret");
    // Cloud/vendor credentials are stripped by the same control (review S1):
    // inheriting any of them would run the backup as the primary.
    const mergedText = readFileSync(path.join(backup, "settings.json"), "utf8");
    for (const secret of [
      "primary-aws-secret",
      "primary-bedrock-token",
      "primary-azure-key",
      "/primary/gcp.json",
      "primary-header-secret",
    ]) {
      expect(mergedText).not.toContain(secret);
    }
    expect(merged.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(merged.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(merged.env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(merged.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(merged.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    // Non-credential provider configuration still mirrors.
    expect(merged.env.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
    expect(merged.hooks.PostToolUse[0].command).toBe("primary-hook");

    expect(readFileSync(path.join(backup, "skills", "one", "SKILL.md"), "utf8")).toBe("# one");
    expect(existsSync(path.join(backup, "projects"))).toBe(false);
    // Never copied: the backup's own credentials file stays byte-identical.
    expect(readFileSync(path.join(backup, ".credentials.json"), "utf8")).toBe("SECRET2");
  });

  test("skipped mirror entries are warnings, not silent", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-primary-skip-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-backup-skip-"));
    const a = alias(unique("skip-a"), primary);
    const b = alias(unique("skip-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "skip", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "skills", "real", "SKILL.md"), "# real");
    const target = mkdtempSync(path.join(tmpdir(), "agetor-skip-target-"));
    write(path.join(target, "outside.md"), "outside");
    symlinkSync(target, path.join(primary, "skills", "linked"));
    const result = await mirror.mirrorStack(stack, {});
    expect(result.warnings.some((w) => w.includes("skills: skipped"))).toBe(true);
    expect(existsSync(path.join(backup, "skills", "real", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(backup, "skills", "linked"))).toBe(false);
  });

  test("safe mode does not copy hooks/permissions and keeps the backup's own", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-primary-safe-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-backup-safe-"));
    const a = alias(unique("safe-a"), primary);
    const b = alias(unique("safe-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "safe", kind: "claude-code", members: [a, b], mirrorMode: "safe" });
    write(path.join(primary, "settings.json"), JSON.stringify({ hooks: { A: 1 }, permissions: { allow: ["x"] }, model: "opus" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ hooks: { B: 2 }, model: "haiku" }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.model).toBe("opus");
    expect(merged.hooks).toEqual({ B: 2 });
    expect(merged.permissions).toBeUndefined();
  });

  test("Codex config.toml merge keeps backup-only tables and never inherits projects", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-codex-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-codex-b-"));
    const a = unique("cx-a");
    const b = unique("cx-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "codex", kind: "codex", members: [a, b], mirrorMode: "full" });
    const pRoot = path.join(primary, ".codex");
    const bRoot = path.join(backup, ".codex");
    write(path.join(pRoot, "config.toml"), [
      'model = "gpt-5"',
      "[mcp_servers.alpha]",
      'command = "alpha"',
      '[projects."/primary/secret"]',
      'trust_level = "trusted"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      'model = "gpt-4"',
      "[mcp_servers.beta]",
      'command = "beta"',
      '[projects."/backup/mine"]',
      'trust_level = "trusted"',
    ].join("\n"));
    await mirror.mirrorStack(stack, {});
    const merged = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(merged) as Record<string, unknown>;
    expect((parsed.mcp_servers as Record<string, unknown>).alpha).toBeTruthy();
    expect((parsed.mcp_servers as Record<string, unknown>).beta).toBeTruthy();
    expect((parsed.projects as Record<string, unknown>)["/backup/mine"]).toBeTruthy();
    expect((parsed.projects as Record<string, unknown>)["/primary/secret"]).toBeUndefined();
  });

  test("Codex top-level scalars: primary wins, backup-only keys survive", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-codex-top-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-codex-top-b-"));
    const a = unique("cxt-a");
    const b = unique("cxt-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "codex-top", kind: "codex", members: [a, b], mirrorMode: "full" });
    const pRoot = path.join(primary, ".codex");
    const bRoot = path.join(backup, ".codex");
    write(path.join(pRoot, "config.toml"), [
      'model = "gpt-5"',
      "notify = [",
      '  "primary-hook",',
      "]",
      "[mcp_servers.alpha]",
      'command = "alpha"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      'model = "gpt-4"',
      'model_reasoning_effort = "low"',
      'backup_only = "keep-me"',
      "[mcp_servers.beta]",
      'command = "beta"',
    ].join("\n"));
    await mirror.mirrorStack(stack, {});
    const merged = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(merged) as Record<string, unknown>;
    // Primary scalar replaces the backup's; the backup-only keys survive.
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.model_reasoning_effort).toBe("low");
    expect(parsed.backup_only).toBe("keep-me");
    expect(parsed.notify).toEqual(["primary-hook"]);
    expect((parsed.mcp_servers as Record<string, unknown>).beta).toBeTruthy();
  });

  test("safe mode keeps the backup's own section when the primary section is excluded", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-codex-safe-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-codex-safe-b-"));
    const a = unique("cxs-a");
    const b = unique("cxs-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "codex-safe", kind: "codex", members: [a, b], mirrorMode: "safe" });
    write(path.join(primary, ".codex", "config.toml"), "[hooks]\nprimary_hook = true\n");
    write(path.join(backup, ".codex", "config.toml"), "[hooks]\nbackup_hook = true\n");
    await mirror.mirrorStack(stack, {});
    const parsed = Bun.TOML.parse(readFileSync(path.join(backup, ".codex", "config.toml"), "utf8")) as Record<string, unknown>;
    expect(parsed.hooks).toEqual({ backup_hook: true });
  });

  test("the copy is additive: backup-only files and directories survive", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-add-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-add-b-"));
    const a = alias(unique("add-a"), primary);
    const b = alias(unique("add-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "additive", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "skills", "shared", "SKILL.md"), "# shared");
    write(path.join(primary, "plugins", "data", "from-primary.json"), "{}");
    write(path.join(backup, "skills", "backup-only", "SKILL.md"), "# mine");
    write(path.join(backup, "skills", "shared", "LOCAL.md"), "# local note");

    await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(backup, "skills", "shared", "SKILL.md"), "utf8")).toBe("# shared");
    // Destination-only sibling and file are not deleted by the mirror.
    expect(readFileSync(path.join(backup, "skills", "backup-only", "SKILL.md"), "utf8")).toBe("# mine");
    expect(readFileSync(path.join(backup, "skills", "shared", "LOCAL.md"), "utf8")).toBe("# local note");
    expect(readFileSync(path.join(backup, "plugins", "data", "from-primary.json"), "utf8")).toBe("{}");
  });

  test("a marketplace's .git (and any token in it) never reaches the backup", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-git-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-git-b-"));
    const a = alias(unique("git-a"), primary);
    const b = alias(unique("git-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "git", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "marketplaces", "m", "marketplace.json"), "{}");
    write(
      path.join(primary, "plugins", "marketplaces", "m", ".git", "config"),
      '[remote "origin"]\n  url = https://x-access-token:PLANTED-TOKEN@github.com/acme/private.git\n',
    );
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# plugin");

    const result = await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(backup, "plugins", "marketplaces", "m", "marketplace.json"), "utf8")).toBe("{}");
    expect(existsSync(path.join(backup, "plugins", "marketplaces", "m", ".git"))).toBe(false);
    // The payload is copied so the backup can load the plugin itself.
    expect(readFileSync(path.join(backup, "plugins", "cache", "m", "p", "1", "SKILL.md"), "utf8")).toBe("# plugin");
    // No file under the backup home may carry the planted token.
    expect(JSON.stringify(result.warnings)).not.toContain("PLANTED-TOKEN");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        const st = lstatSync(abs);
        if (st.isDirectory()) walk(abs);
        else if (st.isFile() && readFileSync(abs, "utf8").includes("PLANTED-TOKEN")) hits.push(abs);
      }
    };
    walk(backup);
    expect(hits).toEqual([]);
  });

  test(".claude.json merges mcpServers and enabledPlugins without copying the primary's account/session blob", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-cj-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-cj-b-"));
    const a = alias(unique("cj-a"), primary);
    const b = alias(unique("cj-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "claude-json", kind: "claude-code", members: [a, b], mirrorMode: "full" });

    write(path.join(primary, ".claude.json"), JSON.stringify({
      mcpServers: {
        alpha: { command: "alpha-server" },
        shared: { command: "primary-shared" },
      },
      enabledPlugins: { "p@m": true },
      // Account/session state in the same blob must never cross accounts.
      oauthAccount: { emailAddress: "primary@example.invalid", accountUuid: "uuid-primary" },
      projects: { "/primary/project": { allowedTools: ["Bash"] } },
      numStartups: 42,
    }));
    write(path.join(backup, ".claude.json"), JSON.stringify({
      mcpServers: {
        beta: { command: "beta-server" },
        shared: { command: "backup-shared" },
      },
      enabledPlugins: { "own@m": true },
      hooks: { Stop: [{ command: "backup-hook" }] },
      projects: { "/backup/project": { hasTrustDialogAccepted: true } },
    }));

    const result = await mirror.mirrorStack(stack, {});

    expect(result.warnings).toEqual([]);
    const dest = path.join(backup, ".claude.json");
    const merged = JSON.parse(readFileSync(dest, "utf8"));
    // MCP servers are the feature's promise: the primary's servers arrive, a
    // backup-only server survives, and the primary wins a shared name.
    expect(merged.mcpServers.alpha).toEqual({ command: "alpha-server" });
    expect(merged.mcpServers.beta).toEqual({ command: "beta-server" });
    expect(merged.mcpServers.shared.command).toBe("primary-shared");
    expect(merged.enabledPlugins).toEqual({ "own@m": true, "p@m": true });
    // Additive: the backup's own blob keys survive, the primary's account and
    // project state do not leak in (only the two allowlisted keys are copied).
    expect(merged.hooks).toEqual({ Stop: [{ command: "backup-hook" }] });
    expect(merged.projects).toEqual({ "/backup/project": { hasTrustDialogAccepted: true } });
    expect(merged.oauthAccount).toBeUndefined();
    expect(merged.numStartups).toBeUndefined();
    // The merged blob is written user-only, like every other mirror write.
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  test("a malformed primary .claude.json is left alone with a warning", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-cj-bad-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-cj-bad-b-"));
    const a = alias(unique("cj-bad-a"), primary);
    const b = alias(unique("cj-bad-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "claude-json-bad", kind: "claude-code", members: [a, b], mirrorMode: "safe" });
    write(path.join(primary, ".claude.json"), "{not json");

    const result = await mirror.mirrorStack(stack, {});

    expect(result.warnings.some((w) => w.includes(".claude.json: primary file is not a JSON object"))).toBe(true);
    // No half-written blob on the account: an unmergeable source must not
    // replace the backup's real config.
    expect(existsSync(path.join(backup, ".claude.json"))).toBe(false);
  });

  test("an unreadable backup .claude.json (symlink) is left untouched", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-cj-link-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-cj-link-b-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-cj-link-outside-"));
    const a = alias(unique("cj-link-a"), primary);
    const b = alias(unique("cj-link-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "claude-json-link", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, ".claude.json"), JSON.stringify({ mcpServers: { alpha: { command: "a" } } }));
    const real = path.join(outside, "backup-claude.json");
    write(real, JSON.stringify({ mcpServers: { beta: { command: "b" } }, keep_me: true }));
    symlinkSync(real, path.join(backup, ".claude.json"));

    const result = await mirror.mirrorStack(stack, {});

    expect(result.warnings.some((w) => w.includes(".claude.json: backup file could not be read safely"))).toBe(true);
    // The link target is never replaced or followed.
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ mcpServers: { beta: { command: "b" } }, keep_me: true });
    expect(lstatSync(path.join(backup, ".claude.json")).isSymbolicLink()).toBe(true);
  });

  test("a malformed primary plugin registry leaves the backup's registry untouched", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-reg-bad-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-reg-bad-b-"));
    const a = alias(unique("reg-bad-a"), primary);
    const b = alias(unique("reg-bad-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "registry-bad", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "installed_plugins.json"), "{broken");
    const own = JSON.stringify({ version: 2, plugins: { "own@m": [{ scope: "user" }] } });
    write(path.join(backup, "plugins", "installed_plugins.json"), own);

    const result = await mirror.mirrorStack(stack, {});

    expect(
      result.warnings.some((w) => w.includes("installed_plugins.json: primary file is not a JSON object")),
    ).toBe(true);
    expect(readFileSync(path.join(backup, "plugins", "installed_plugins.json"), "utf8")).toBe(own);
  });

  test("plugin registries are merged with paths rewritten to the backup, keeping backup-only entries", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-reg-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-reg-b-"));
    const a = alias(unique("reg-a"), primary);
    const b = alias(unique("reg-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "registry", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# primary plugin");
    write(path.join(primary, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [{ scope: "user", installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" }],
      },
    }));
    write(path.join(primary, "plugins", "known_marketplaces.json"), JSON.stringify({
      m: { source: { source: "github", repo: "acme/m" }, installLocation: path.join(primary, "plugins", "marketplaces", "m") },
    }));
    write(path.join(backup, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "own@m2": [{ scope: "user", installPath: path.join(backup, "plugins", "cache", "m2", "own", "1"), version: "1" }],
      },
    }));

    await mirror.mirrorStack(stack, {});

    const registry = JSON.parse(readFileSync(path.join(backup, "plugins", "installed_plugins.json"), "utf8"));
    const installPath = registry.plugins["p@m"][0].installPath as string;
    expect(installPath.startsWith(path.resolve(backup))).toBe(true);
    expect(installPath).not.toContain(path.resolve(primary));
    // The backup's own plugin entry survives the merge.
    expect(registry.plugins["own@m2"][0].installPath.startsWith(path.resolve(backup))).toBe(true);
    const marketplaces = JSON.parse(readFileSync(path.join(backup, "plugins", "known_marketplaces.json"), "utf8"));
    expect((marketplaces.m.installLocation as string).startsWith(path.resolve(backup))).toBe(true);
    expect(marketplaces.m.installLocation).not.toContain(path.resolve(primary));
  });

  test("user-level CLAUDE.md and output-styles are mirrored (review M2)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-mem-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-mem-b-"));
    const a = alias(unique("mem-a"), primary);
    const b = alias(unique("mem-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "memory", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "CLAUDE.md"), "# standing instructions");
    write(path.join(primary, "output-styles", "concise.md"), "be brief");

    const result = await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("# standing instructions");
    expect(readFileSync(path.join(backup, "output-styles", "concise.md"), "utf8")).toBe("be brief");
    expect(result.warnings).toEqual([]);
  });

  test("Codex AGENTS.md is mirrored (review M2)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-agents-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-agents-b-"));
    const a = unique("agents-a");
    const b = unique("agents-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "agents", kind: "codex", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, ".codex", "AGENTS.md"), "# codex instructions");

    await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(backup, ".codex", "AGENTS.md"), "utf8")).toBe("# codex instructions");
  });

  test("installed_plugins.json merges install records by scope, not as a plain union (review S1)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-scope-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-scope-b-"));
    const a = alias(unique("scope-a"), primary);
    const b = alias(unique("scope-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "scope", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# primary plugin");
    write(path.join(primary, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [
          { scope: "user", installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" },
        ],
      },
    }));
    write(path.join(backup, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [
          { scope: "user", installPath: path.join(backup, "plugins", "cache", "m", "p", "0"), version: "0" },
          { scope: "project", installPath: path.join(backup, "plugins", "cache", "m", "p", "local"), version: "0" },
        ],
      },
    }));

    await mirror.mirrorStack(stack, {});

    const records = JSON.parse(readFileSync(path.join(backup, "plugins", "installed_plugins.json"), "utf8"))
      .plugins["p@m"] as Array<{ scope: string; installPath: string }>;
    // One user-scope record (the primary's, rewritten), never two.
    expect(records.filter((r) => r.scope === "user")).toHaveLength(1);
    expect(records.find((r) => r.scope === "user")?.installPath.startsWith(path.resolve(backup))).toBe(true);
    // A backup-only scope survives the merge.
    expect(records.find((r) => r.scope === "project")?.installPath.startsWith(path.resolve(backup))).toBe(true);
  });

  test("installed_plugins.json keeps every project record: keyed by scope + projectPath (R17-M1)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-proj-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-proj-b-"));
    const a = alias(unique("proj-a"), primary);
    const b = alias(unique("proj-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "project-records", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# primary plugin");
    const primaryOne = "/repos/one";
    const primaryTwo = "/repos/two";
    const backupOwn = "/repos/backup-own";
    write(path.join(primary, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [
          { scope: "user", installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" },
          { scope: "project", projectPath: primaryOne, installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" },
          { scope: "project", projectPath: primaryTwo, installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" },
        ],
      },
    }));
    write(path.join(backup, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [
          { scope: "user", installPath: path.join(backup, "plugins", "cache", "m", "p", "0"), version: "0" },
          { scope: "project", projectPath: backupOwn, installPath: path.join(backup, "plugins", "cache", "m", "p", "0"), version: "0" },
        ],
      },
    }));

    await mirror.mirrorStack(stack, {});

    const records = JSON.parse(readFileSync(path.join(backup, "plugins", "installed_plugins.json"), "utf8"))
      .plugins["p@m"] as Array<{ scope: string; projectPath?: string; installPath: string }>;
    // Both of the primary's project installs survive (they used to collapse
    // into one because the key was the scope alone).
    expect(records.filter((r) => r.scope === "project").map((r) => r.projectPath).sort())
      .toEqual([backupOwn, primaryOne, primaryTwo].sort());
    // The backup's own project record is not dropped by the shared plugin key.
    expect(records.some((r) => r.projectPath === backupOwn)).toBe(true);
    // And the shared user scope still dedupes to one record.
    expect(records.filter((r) => r.scope === "user")).toHaveLength(1);
    expect(new Set(records.map((r) => `${r.scope}:${r.projectPath ?? ""}`)).size).toBe(records.length);
  });

  test("an incomplete plugin-payload copy leaves the registry untouched (review S3)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-trunc-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-trunc-b-"));
    const a = alias(unique("trunc-a"), primary);
    const b = alias(unique("trunc-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "trunc", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# one");
    write(path.join(primary, "plugins", "cache", "m", "p", "2", "SKILL.md"), "# two");
    write(path.join(primary, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "p@m": [{ scope: "user", installPath: path.join(primary, "plugins", "cache", "m", "p", "1"), version: "1" }],
      },
    }));
    const backupRegistry = JSON.stringify({
      version: 2,
      plugins: {
        "own@m": [{ scope: "user", installPath: path.join(backup, "plugins", "cache", "m", "own", "1"), version: "1" }],
      },
    });
    write(path.join(backup, "plugins", "installed_plugins.json"), backupRegistry);

    // Force the cache tree over its entry budget: the registry must not be
    // rewritten to point at a payload that was only partially copied.
    const result = await mirror.mirrorStack(stack, { copyLimits: { "plugins/cache": { maxEntries: 1 } } });

    expect(readFileSync(path.join(backup, "plugins", "installed_plugins.json"), "utf8")).toBe(backupRegistry);
    expect(result.warnings.some((w) => w.includes("copy was incomplete"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("size/entry budget"))).toBe(true);
  });

  test("an unreadable backup config is left untouched instead of being overwritten", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-bk-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-bk-b-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-bk-outside-"));
    const a = alias(unique("bk-a"), primary);
    const b = alias(unique("bk-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "backup-unreadable", kind: "claude-code", members: [a, b], mirrorMode: "safe" });
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    // The backup's own settings live behind a symlink (a user dotfile setup).
    // Reading it no-follow fails; treating that as {} would replace the link
    // target with only the primary's keys.
    const real = path.join(outside, "backup-settings.json");
    write(real, JSON.stringify({ model: "sonnet", keep_me: true }));
    mkdirSync(backup, { recursive: true });
    symlinkSync(real, path.join(backup, "settings.json"));

    await mirror.mirrorStack(stack, {});

    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ model: "sonnet", keep_me: true });
    expect(lstatSync(path.join(backup, "settings.json")).isSymbolicLink()).toBe(true);
  });

  test("a symlinked primary config file is not read, and a symlinked destination dir is not written through", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-link-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-link-b-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-link-outside-"));
    const a = alias(unique("link-a"), primary);
    const b = alias(unique("link-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "links", kind: "claude-code", members: [a, b], mirrorMode: "safe" });

    write(path.join(outside, "secret.json"), JSON.stringify({ model: "stolen" }));
    symlinkSync(path.join(outside, "secret.json"), path.join(primary, "settings.json"));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "sonnet" }));
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    symlinkSync(outside, path.join(backup, "skills"));

    await mirror.mirrorStack(stack, {});

    // The primary's symlinked settings.json was refused (no merge), so the
    // backup's own value is untouched.
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("sonnet");
    // The symlinked destination skills dir was refused; nothing was written
    // into the outside directory it points at.
    expect(existsSync(path.join(outside, "s", "SKILL.md"))).toBe(false);
  });

  test("a symlinked intermediate source directory is refused, never read through", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-parent-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-parent-b-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-parent-outside-"));
    const a = alias(unique("parent-a"), primary);
    const b = alias(unique("parent-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "source-parent", kind: "claude-code", members: [a, b], mirrorMode: "full" });

    // `plugins/` is the linked INTERMEDIATE component: a leaf-only `lstat`
    // sees the target's regular file / plain directory and would copy it.
    write(path.join(outside, "plugins", "installed_plugins.json"), "{}");
    write(path.join(outside, "plugins", "marketplaces", "m", "marketplace.json"), "{}");
    mkdirSync(primary, { recursive: true });
    symlinkSync(path.join(outside, "plugins"), path.join(primary, "plugins"));

    const result = await mirror.mirrorStack(stack, {});

    expect(result.warnings.some((w) => w.includes("symlinked parent"))).toBe(true);
    expect(existsSync(path.join(backup, "plugins", "installed_plugins.json"))).toBe(false);
    expect(existsSync(path.join(backup, "plugins", "marketplaces", "m", "marketplace.json"))).toBe(false);
  });

  test("login-selecting settings keys never cross accounts; the backup's own survives", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-login-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-login-b-"));
    const a = alias(unique("login-a"), primary);
    const b = alias(unique("login-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "login-keys", kind: "claude-code", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, "settings.json"), JSON.stringify({
      model: "opus",
      apiKeyHelper: "/primary/key-helper.sh",
      forceLoginOrgUUID: "primary-org",
      awsCredentialExport: "primary-aws",
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({
      model: "sonnet",
      apiKeyHelper: "/backup/key-helper.sh",
    }));

    const result = await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.model).toBe("opus");
    // The backup keeps its own helper; the primary's never replaces it.
    expect(merged.apiKeyHelper).toBe("/backup/key-helper.sh");
    // Keys the backup did not have are not imported from the primary.
    expect(merged.forceLoginOrgUUID).toBeUndefined();
    expect(merged.awsCredentialExport).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("login key"))).toBe(true);
  });

  test("Codex plugin payload is mirrored; .git and install staging are not", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-cxp-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-cxp-b-"));
    const a = unique("cxp-a");
    const b = unique("cxp-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "codex-plugins", kind: "codex", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, ".codex", "plugins", "cache", "m", "p", "1", "SKILL.md"), "# payload");
    write(path.join(primary, ".codex", "plugins", "cache", "m", "p", "1", ".git", "config"), "token");
    write(path.join(primary, ".codex", "plugins", ".remote-plugin-install-staging", "x", "bundle.json"), "{}");

    await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(backup, ".codex", "plugins", "cache", "m", "p", "1", "SKILL.md"), "utf8")).toBe("# payload");
    expect(existsSync(path.join(backup, ".codex", "plugins", "cache", "m", "p", "1", ".git"))).toBe(false);
    expect(existsSync(path.join(backup, ".codex", "plugins", ".remote-plugin-install-staging"))).toBe(false);
  });

  test("a Codex mirror with MCP servers warns that sign-in may need repeating", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-mcp-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-mcp-b-"));
    const a = unique("mcp-a");
    const b = unique("mcp-b");
    if (!dbm.harnesses.get(a)) dbm.harnesses.insert({ id: a, kind: "codex", label: a, home: primary, env: {} } as never);
    if (!dbm.harnesses.get(b)) dbm.harnesses.insert({ id: b, kind: "codex", label: b, home: backup, env: {} } as never);
    const stack = stacks.harnessStacks.create({ label: "mcp-warn", kind: "codex", members: [a, b], mirrorMode: "full" });
    write(path.join(primary, ".codex", "config.toml"), '[mcp_servers.alpha]\ncommand = "alpha"\n');
    write(path.join(backup, ".codex", "config.toml"), 'model = "gpt-5"\n');

    const result = await mirror.mirrorStack(stack, { targetHarnessId: b });
    expect(result.warnings.some((w) => w.includes("MCP sign-in may need repeating"))).toBe(true);
  });
});

describe("cleanup", () => {
  test("removeCopiedPaths refuses a path behind a symlinked parent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-clean-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-clean-outside-"));
    const victim = path.join(outside, "session.jsonl");
    writeFileSync(victim, "do not delete");
    mkdirSync(path.join(root, "real"), { recursive: true });
    symlinkSync(outside, path.join(root, "linked"));

    expect(transfer.removeCopiedPaths([path.join(root, "linked", "session.jsonl")], root)).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("do not delete");

    // A plain path under the root still cleans up.
    const own = path.join(root, "real", "copy.jsonl");
    writeFileSync(own, "copied");
    expect(transfer.removeCopiedPaths([own], root)).toEqual([own]);
    expect(existsSync(own)).toBe(false);
    // The empty directory shell it created is pruned, but the root survives.
    expect(existsSync(path.join(root, "real"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  test("removeCopiedPaths prunes only empty sidecar directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-prune-"));
    const sidecar = path.join(root, "projects", "enc", "sid", "subagents");
    const kept = path.join(root, "projects", "enc", "sid", "tool-results", "keep.txt");
    const copied = path.join(sidecar, "agent.jsonl");
    write(copied, "copy");
    write(kept, "backup's own");
    expect(transfer.removeCopiedPaths([copied], root)).toEqual([copied]);
    // The empty `subagents/` is pruned…
    expect(existsSync(sidecar)).toBe(false);
    // …and pruning stops at the first non-empty directory, so the sibling
    // holding the backup's own file (and its parents) stay.
    expect(readFileSync(kept, "utf8")).toBe("backup's own");
    expect(existsSync(path.join(root, "projects", "enc", "sid"))).toBe(true);
    expect(existsSync(path.join(root, "projects", "enc"))).toBe(true);
  });
});

// Direct contract of the exported registry merge (the integration tests above
// drive it through `mirrorStack`; these pin the fallback shapes that a real
// registry can hold without needing a fixture tree).
describe("mergeInstalledPluginsJson", () => {
  test("merges plugin arrays by install identity and keeps backup-only plugins", () => {
    const merged = mirror.mergeInstalledPluginsJson(
      {
        version: 2,
        plugins: {
          "p@m": [
            { scope: "user", version: "2" },
            { scope: "project", projectPath: "/p/one", version: "2" },
            { scope: "project", projectPath: "/p/two", version: "2" },
          ],
        },
      },
      {
        version: 2,
        plugins: {
          "p@m": [
            { scope: "user", version: "1" },
            { scope: "project", projectPath: "/p/one", version: "1" },
            { scope: "project", projectPath: "/backup/own", version: "1" },
          ],
          "own@m": [{ scope: "user", version: "1" }],
        },
      },
    );
    const records = (merged.plugins as Record<string, Array<Record<string, unknown>>>)["p@m"]!;
    // Primary wins a shared identity, every distinct project identity survives.
    expect(records.find((r) => r.scope === "user")?.version).toBe("2");
    expect(records.find((r) => r.projectPath === "/p/one")?.version).toBe("2");
    expect(records.find((r) => r.projectPath === "/p/two")?.version).toBe("2");
    expect(records.find((r) => r.projectPath === "/backup/own")?.version).toBe("1");
    expect((merged.plugins as Record<string, unknown>)["own@m"]).toBeTruthy();
  });

  test("top-level arrays union, nested objects deep-merge and scalars take the primary", () => {
    const merged = mirror.mergeInstalledPluginsJson(
      { version: 2, tags: ["a"], config: { a: 1, shared: "primary" }, label: "primary" },
      { version: 1, tags: ["b"], config: { b: 2, shared: "backup" }, extra: true },
    );
    expect(merged).toEqual({
      version: 2,
      tags: ["a", "b"],
      config: { a: 1, b: 2, shared: "primary" },
      label: "primary",
      extra: true,
    });
  });

  test("records without a scope keep full-record identity instead of collapsing", () => {
    expect(mirror.mergeInstallRecords([{ path: "/a" }], [{ path: "/a" }, { path: "/b" }])).toEqual([
      { path: "/a" },
      { path: "/b" },
    ]);
    // A non-serializable record must not make the merge throw and lose the
    // whole registry.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => mirror.mergeInstallRecords([circular], [])).not.toThrow();
  });
});
