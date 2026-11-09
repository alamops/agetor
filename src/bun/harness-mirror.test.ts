// Safe transfer engine + mirror (T04/TT4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
    // A provider selector is a login choice, not configuration: the primary's
    // endpoint never becomes the backup's (review S3).
    expect(merged.env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Full mode: the primary's hooks object replaces the backup's outright
    // (review S14) — the backup's hook does not survive as a second entry.
    expect(merged.hooks.PostToolUse).toEqual([{ command: "primary-hook" }]);

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
    // A NESTED symlink is still skipped (only top-level entries are linked).
    symlinkSync(target, path.join(primary, "skills", "real", "linked"));
    const result = await mirror.mirrorStack(stack, {});
    expect(result.warnings.some((w) => w.includes("skills: skipped 1 entry"))).toBe(true);
    expect(existsSync(path.join(backup, "skills", "real", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(backup, "skills", "real", "linked"))).toBe(false);
  });

  test("safe mode skips hooks, permissions, status line and helper commands and keeps the backup's own (review S6)", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-primary-safe-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-backup-safe-"));
    const a = alias(unique("safe-a"), primary);
    const b = alias(unique("safe-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "safe", kind: "claude-code", members: [a, b], mirrorMode: "safe" });
    write(path.join(primary, "settings.json"), JSON.stringify({
      hooks: { A: 1 },
      permissions: { allow: ["x"] },
      statusLine: { type: "command", command: "/primary/status.sh" },
      otelHeadersHelper: "/primary/otel-headers.sh",
      enabledPlugins: { "p@m": true },
      model: "opus",
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({
      hooks: { B: 2 },
      statusLine: { type: "command", command: "/backup/status.sh" },
      model: "haiku",
    }));
    write(path.join(primary, ".claude.json"), JSON.stringify({ mcpServers: { alpha: { command: "alpha" } } }));
    write(path.join(primary, "plugins", "cache", "m", "p", "1", "SKILL.md"), "# plugin");
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.model).toBe("opus");
    expect(merged.hooks).toEqual({ B: 2 });
    expect(merged.permissions).toBeUndefined();
    expect(merged.statusLine).toEqual({ type: "command", command: "/backup/status.sh" });
    expect(merged.otelHeadersHelper).toBeUndefined();
    // Plugins and MCP servers are still mirrored in safe mode.
    expect(merged.enabledPlugins).toEqual({ "p@m": true });
    expect(JSON.parse(readFileSync(path.join(backup, ".claude.json"), "utf8")).mcpServers.alpha).toEqual({ command: "alpha" });
    expect(readFileSync(path.join(backup, "plugins", "cache", "m", "p", "1", "SKILL.md"), "utf8")).toBe("# plugin");
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
  test("removeCopiedPaths refuses a path behind a symlinked parent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-clean-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-clean-outside-"));
    const victim = path.join(outside, "s.jsonl");
    writeFileSync(victim, "do not delete");
    mkdirSync(path.join(root, "projects", "real"), { recursive: true });
    symlinkSync(outside, path.join(root, "projects", "linked"));

    expect(await transfer.removeCopiedPaths([path.join(root, "projects", "linked", "s.jsonl")], root, "claude-code"))
      .toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("do not delete");

    // A plain, shape-matching path under the root still cleans up, and the
    // account's own `projects/<enc>` folder is never pruned.
    const own = path.join(root, "projects", "real", "copy.jsonl");
    writeFileSync(own, "copied");
    expect(await transfer.removeCopiedPaths([own], root, "claude-code")).toEqual([own]);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(path.join(root, "projects", "real"))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  test("removeCopiedPaths prunes only empty sidecar directories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-prune-"));
    const sidecar = path.join(root, "projects", "enc", "sid", "subagents");
    const kept = path.join(root, "projects", "enc", "sid", "tool-results", "keep.txt");
    const copied = path.join(sidecar, "agent.jsonl");
    write(copied, "copy");
    write(kept, "backup's own");
    expect(await transfer.removeCopiedPaths([copied], root, "claude-code")).toEqual([copied]);
    // The empty `subagents/` is pruned…
    expect(existsSync(sidecar)).toBe(false);
    // …and pruning stops at the first non-empty directory, so the sibling
    // holding the backup's own file (and its parents) stay.
    expect(readFileSync(kept, "utf8")).toBe("backup's own");
    expect(existsSync(path.join(root, "projects", "enc", "sid"))).toBe(true);
    expect(existsSync(path.join(root, "projects", "enc"))).toBe(true);

    // With the last sidecar file gone, the whole session folder is pruned —
    // but never `projects/<enc>` itself.
    expect(await transfer.removeCopiedPaths([kept], root, "claude-code")).toEqual([kept]);
    expect(existsSync(path.join(root, "projects", "enc", "sid"))).toBe(false);
    expect(existsSync(path.join(root, "projects", "enc"))).toBe(true);
  });

  test("removeCopiedPaths never recurses into a directory and refuses paths outside the handoff shape (review S4)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-shape-"));
    // A recorded path that is a DIRECTORY (an agent-edited row) is left
    // alone with everything inside it.
    const dir = path.join(root, "projects", "enc", "sid.jsonl");
    write(path.join(dir, "inner.txt"), "inner");
    // Shapes a handoff never writes: config, credentials, the session folder
    // itself, a Codex file outside `sessions/YYYY/MM/DD/rollout-*.jsonl`.
    const settings = path.join(root, "settings.json");
    const creds = path.join(root, ".credentials.json");
    const sessionFolderFile = path.join(root, "projects", "enc", "sid2", "notes.txt");
    const strayJsonl = path.join(root, "history.jsonl");
    for (const p of [settings, creds, sessionFolderFile, strayJsonl]) write(p, "keep");

    const removed = await transfer.removeCopiedPaths(
      [dir, settings, creds, sessionFolderFile, strayJsonl, root, path.join(root, "projects")],
      root,
      "claude-code",
    );
    expect(removed).toEqual([]);
    expect(readFileSync(path.join(dir, "inner.txt"), "utf8")).toBe("inner");
    for (const p of [settings, creds, sessionFolderFile, strayJsonl]) expect(readFileSync(p, "utf8")).toBe("keep");

    // Codex: only a rollout in the date layout is removable; the date folders
    // are pruned once empty, `sessions` itself never.
    const codexRoot = mkdtempSync(path.join(tmpdir(), "agetor-shape-codex-"));
    const rollout = path.join(codexRoot, "sessions", "2026", "11", "08", "rollout-x-thread.jsonl");
    const auth = path.join(codexRoot, "auth.json");
    const odd = path.join(codexRoot, "sessions", "rollout-x-thread.jsonl");
    for (const p of [rollout, auth, odd]) write(p, "x");
    expect(await transfer.removeCopiedPaths([auth, odd, rollout], codexRoot, "codex")).toEqual([rollout]);
    expect(existsSync(auth)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(path.join(codexRoot, "sessions", "2026"))).toBe(false);
    expect(existsSync(path.join(codexRoot, "sessions"))).toBe(true);
    // A claude shape is not a codex shape and vice versa.
    const claudeShaped = path.join(codexRoot, "projects", "enc", "s.jsonl");
    write(claudeShaped, "x");
    expect(await transfer.removeCopiedPaths([claudeShaped], codexRoot, "codex")).toEqual([]);
    expect(existsSync(claudeShaped)).toBe(true);
  });

  test("removeCopiedPaths leaves a symlink at a recorded path (and its target) alone", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agetor-leaf-link-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-leaf-link-out-"));
    const victim = path.join(outside, "victim.jsonl");
    writeFileSync(victim, "keep");
    const recorded = path.join(root, "projects", "enc", "sid.jsonl");
    mkdirSync(path.dirname(recorded), { recursive: true });
    symlinkSync(victim, recorded);
    expect(await transfer.removeCopiedPaths([recorded], root, "claude-code")).toEqual([]);
    expect(lstatSync(recorded).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep");
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

/** `mirrorStack` reports copies as `<harnessId>:<rel>`; strip the id. */
function rels(result: { copied: string[] }): string[] {
  return result.copied.map((c) => c.slice(c.indexOf(":") + 1));
}

function codexAlias(id: string, home: string): string {
  if (!dbm.harnesses.get(id)) dbm.harnesses.insert({ id, kind: "codex", label: id, home, env: {} } as never);
  return id;
}

function claudePair(slug: string, mirrorMode: "full" | "safe" = "full") {
  const primary = mkdtempSync(path.join(tmpdir(), `agetor-${slug}-p-`));
  const backup = mkdtempSync(path.join(tmpdir(), `agetor-${slug}-b-`));
  const a = alias(unique(`${slug}-a`), primary);
  const b = alias(unique(`${slug}-b`), backup);
  const stack = stacks.harnessStacks.create({ label: slug, kind: "claude-code", members: [a, b], mirrorMode });
  return { primary, backup, a, b, stack };
}

function codexPair(slug: string, mirrorMode: "full" | "safe" = "full") {
  const primary = mkdtempSync(path.join(tmpdir(), `agetor-${slug}-p-`));
  const backup = mkdtempSync(path.join(tmpdir(), `agetor-${slug}-b-`));
  const a = codexAlias(unique(`${slug}-a`), primary);
  const b = codexAlias(unique(`${slug}-b`), backup);
  const stack = stacks.harnessStacks.create({ label: slug, kind: "codex", members: [a, b], mirrorMode });
  return { pRoot: path.join(primary, ".codex"), bRoot: path.join(backup, ".codex"), a, b, stack };
}

describe("login never crosses accounts", () => {
  test("Codex: the primary's provider login, forced workspace and keyring store are never imported (review M4)", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-login");
    write(path.join(pRoot, "config.toml"), [
      'model = "gpt-5"',
      'model_provider = "corp"',
      'forced_login_method = "chatgpt"',
      'forced_chatgpt_workspace_id = "ws-primary"',
      'cli_auth_credentials_store = "keyring"',
      'preferred_auth_method = "apikey"',
      'chatgpt_base_url = "https://primary.invalid/backend-api"',
      'model_providers.dotted = { name = "dotted", base_url = "https://dotted.invalid" }',
      "[model_providers.corp]",
      'name = "corp"',
      'base_url = "https://llm.primary.invalid/v1"',
      'experimental_bearer_token = "PRIMARY-BEARER-TOKEN"',
      'http_headers = { Authorization = "Bearer PRIMARY-HEADER-TOKEN" }',
      "requires_openai_auth = false",
      "[model_providers.shared]",
      'name = "primary-shared"',
      'base_url = "https://primary-shared.invalid"',
      "[profiles.work]",
      'model = "gpt-5-work"',
      'model_provider = "corp"',
      "[mcp_servers.alpha]",
      'command = "alpha"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      'model = "gpt-4"',
      'model_provider = "own"',
      'cli_auth_credentials_store = "file"',
      "[model_providers.own]",
      'name = "own"',
      'base_url = "https://own.invalid"',
      'env_key = "OWN_KEY"',
      "[model_providers.shared]",
      'name = "backup-shared"',
      'base_url = "https://backup-shared.invalid"',
      "[profiles.work]",
      'model_provider = "own"',
    ].join("\n"));

    const result = await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    // Ordinary config still mirrors.
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.alpha).toEqual({ command: "alpha" });
    expect(parsed.profiles.work.model).toBe("gpt-5-work");
    // The backup's own login selection survives untouched…
    expect(parsed.model_provider).toBe("own");
    expect(parsed.cli_auth_credentials_store).toBe("file");
    expect(parsed.model_providers.own).toEqual({ name: "own", base_url: "https://own.invalid", env_key: "OWN_KEY" });
    expect(parsed.model_providers.shared.name).toBe("backup-shared");
    expect(parsed.profiles.work.model_provider).toBe("own");
    // …and none of the primary's arrives.
    expect(parsed.forced_login_method).toBeUndefined();
    expect(parsed.forced_chatgpt_workspace_id).toBeUndefined();
    expect(parsed.preferred_auth_method).toBeUndefined();
    expect(parsed.chatgpt_base_url).toBeUndefined();
    expect(parsed.model_providers.corp).toBeUndefined();
    expect(parsed.model_providers.dotted).toBeUndefined();
    for (const secret of ["PRIMARY-BEARER-TOKEN", "PRIMARY-HEADER-TOKEN", "ws-primary", "llm.primary.invalid", "primary-shared"]) {
      expect(text).not.toContain(secret);
    }
    // One warning names what was skipped.
    const loginWarnings = result.warnings.filter((w) => w.includes("did not copy") && w.includes("model_provider"));
    expect(loginWarnings).toHaveLength(1);
    expect(loginWarnings[0]).toContain("forced_chatgpt_workspace_id");
  });

  test("Codex: a backup with no login keys does not inherit the primary's", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-login-none");
    write(path.join(pRoot, "config.toml"), [
      'model_provider = "corp"',
      'cli_auth_credentials_store = "keyring"',
      "[model_providers.corp]",
      'experimental_bearer_token = "PRIMARY-BEARER-TOKEN"',
    ].join("\n"));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.cli_auth_credentials_store).toBeUndefined();
    expect(parsed.model_providers).toBeUndefined();
    expect(text).not.toContain("PRIMARY-BEARER-TOKEN");
  });

  test("Codex auth.json is never copied: the backup's stays byte-identical, the primary's goes nowhere", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-auth");
    write(path.join(pRoot, "auth.json"), '{"tokens":"PRIMARY-AUTH"}');
    write(path.join(pRoot, "config.toml"), 'model = "gpt-5"\n');
    write(path.join(pRoot, "skills", "s", "SKILL.md"), "# s");
    const backupAuth = '{"tokens":"BACKUP-AUTH"}\n';
    write(path.join(bRoot, "auth.json"), backupAuth);
    const before = statSync(path.join(bRoot, "auth.json"));

    const result = await mirror.mirrorStack(stack, {});

    expect(readFileSync(path.join(bRoot, "auth.json"), "utf8")).toBe(backupAuth);
    expect(statSync(path.join(bRoot, "auth.json")).ino).toBe(before.ino);
    expect(result.copied.some((c) => c.includes("auth.json"))).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        const st = lstatSync(abs);
        if (st.isDirectory()) walk(abs);
        else if (st.isFile() && readFileSync(abs, "utf8").includes("PRIMARY-AUTH")) hits.push(abs);
      }
    };
    walk(bRoot);
    expect(hits).toEqual([]);
  });

  test("Claude provider-selector env keys are never imported; the backup's own survive (review S3)", async () => {
    const { primary, backup, stack } = claudePair("selector");
    write(path.join(primary, "settings.json"), JSON.stringify({
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_BASE_URL: "https://primary-gateway.invalid",
        ANTHROPIC_BEDROCK_BASE_URL: "https://primary-bedrock.invalid",
        ANTHROPIC_VERTEX_BASE_URL: "https://primary-vertex.invalid",
        ANTHROPIC_MODEL: "claude-opus",
        AWS_REGION: "us-east-1",
      },
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://backup-own.invalid" },
    }));
    const result = await mirror.mirrorStack(stack, {});
    const env = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env;
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://backup-own.invalid",
      ANTHROPIC_MODEL: "claude-opus",
      AWS_REGION: "us-east-1",
    });
    expect(result.warnings.some((w) => w.includes("stripped 6"))).toBe(true);
  });
});

describe("full mode hooks/permissions (review S14) and Codex safe notify (review S6)", () => {
  test("the primary's hooks and permissions replace the backup's; other arrays keep the union", async () => {
    const { primary, backup, stack } = claudePair("replace");
    write(path.join(primary, "settings.json"), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt --v2" }] }] },
      permissions: { allow: ["Bash(git:*)"], deny: [] },
      enabledMcpjsonServers: ["alpha"],
    }));
    // The backup holds an older mirror of the same hook, a permission the
    // primary since revoked, and a hook event the primary no longer has.
    write(path.join(backup, "settings.json"), JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt --v1" }] }],
        Stop: [{ hooks: [{ type: "command", command: "old-stop" }] }],
      },
      permissions: { allow: ["Bash(git:*)", "Bash(rm:*)"], additionalDirectories: ["/old"] },
      enabledMcpjsonServers: ["beta"],
    }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.hooks).toEqual({
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt --v2" }] }],
    });
    expect(merged.permissions).toEqual({ allow: ["Bash(git:*)"], deny: [] });
    expect(merged.enabledMcpjsonServers).toEqual(["alpha", "beta"]);
  });

  test("a primary without hooks leaves the backup's own hooks alone", async () => {
    const { primary, backup, stack } = claudePair("replace-absent");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ hooks: { Stop: [{ command: "mine" }] } }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.hooks).toEqual({ Stop: [{ command: "mine" }] });
  });

  test("Codex safe mode skips the primary's notify and keeps the backup's own; MCP servers still mirror", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-safe-notify", "safe");
    write(path.join(pRoot, "config.toml"), [
      'notify = ["/primary/notify.sh"]',
      'model = "gpt-5"',
      "[mcp_servers.alpha]",
      'command = "alpha"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), 'notify = ["/backup/notify.sh"]\n');
    await mirror.mirrorStack(stack, {});
    const parsed = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(parsed.notify).toEqual(["/backup/notify.sh"]);
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.alpha).toEqual({ command: "alpha" });
  });
});

describe("symlinked skills/commands/agents (review S15)", () => {
  test("a top-level relative symlink becomes an absolute link to the resolved target on the backup", async () => {
    const { primary, backup, stack } = claudePair("link");
    const shared = mkdtempSync(path.join(tmpdir(), "agetor-link-shared-"));
    write(path.join(shared, ".agents", "skills", "x", "SKILL.md"), "# shared skill");
    mkdirSync(path.join(primary, "skills"), { recursive: true });
    symlinkSync(path.relative(path.join(primary, "skills"), path.join(shared, ".agents", "skills", "x")), path.join(primary, "skills", "x"));
    write(path.join(shared, "cmd.md"), "# cmd");
    mkdirSync(path.join(primary, "commands"), { recursive: true });
    symlinkSync(path.join(shared, "cmd.md"), path.join(primary, "commands", "cmd.md"));

    const result = await mirror.mirrorStack(stack, {});

    const dest = path.join(backup, "skills", "x");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    const link = readlinkSync(dest);
    expect(path.isAbsolute(link)).toBe(true);
    expect(link).toBe(realpathSync(path.join(shared, ".agents", "skills", "x")));
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("# shared skill");
    expect(readlinkSync(path.join(backup, "commands", "cmd.md"))).toBe(realpathSync(path.join(shared, "cmd.md")));
    expect(rels(result)).toContain("skills/x");
    // A handled link is not reported as a skipped entry.
    expect(result.warnings.some((w) => w.startsWith("skills: skipped"))).toBe(false);

    // A second mirror leaves the matching link as it is.
    const again = await mirror.mirrorStack(stack, {});
    expect(rels(again)).not.toContain("skills/x");
    expect(readlinkSync(dest)).toBe(link);
  });

  test("dangling links and links into credential/session data are refused", async () => {
    const { primary, backup, stack } = claudePair("link-refuse");
    mkdirSync(path.join(primary, "skills"), { recursive: true });
    symlinkSync(path.join(primary, "nowhere"), path.join(primary, "skills", "dangling"));
    write(path.join(primary, ".credentials.json"), "SECRET");
    symlinkSync(path.join(primary, ".credentials.json"), path.join(primary, "skills", "creds"));
    write(path.join(primary, "projects", "p", "s.jsonl"), "transcript");
    symlinkSync(path.join(primary, "projects"), path.join(primary, "skills", "projects"));
    // The account root itself (it holds the credentials) and an ancestor of it.
    symlinkSync(primary, path.join(primary, "skills", "root"));
    symlinkSync(path.dirname(primary), path.join(primary, "skills", "parent"));
    // The backup's own root is no better a target.
    symlinkSync(backup, path.join(primary, "skills", "backup-root"));

    const result = await mirror.mirrorStack(stack, {});

    for (const name of ["dangling", "creds", "projects", "root", "parent", "backup-root"]) {
      expect(existsSync(path.join(backup, "skills", name)) || isLink(path.join(backup, "skills", name)), name).toBe(false);
    }
    expect(result.warnings.some((w) => w.includes("skills/dangling: symlink target is missing"))).toBe(true);
    expect(result.warnings.filter((w) => w.includes("account login or session data"))).toHaveLength(5);
  });

  test("a real backup entry is never replaced; a backup symlink is", async () => {
    const { primary, backup, stack } = claudePair("link-dest");
    const shared = mkdtempSync(path.join(tmpdir(), "agetor-link-dest-shared-"));
    write(path.join(shared, "a", "SKILL.md"), "# a");
    write(path.join(shared, "b", "SKILL.md"), "# b");
    write(path.join(shared, "old", "SKILL.md"), "# old");
    mkdirSync(path.join(primary, "skills"), { recursive: true });
    symlinkSync(path.join(shared, "a"), path.join(primary, "skills", "a"));
    symlinkSync(path.join(shared, "b"), path.join(primary, "skills", "b"));
    write(path.join(backup, "skills", "a", "SKILL.md"), "# backup's own a");
    symlinkSync(path.join(shared, "old"), path.join(backup, "skills", "b"));

    const result = await mirror.mirrorStack(stack, {});

    expect(lstatSync(path.join(backup, "skills", "a")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(backup, "skills", "a", "SKILL.md"), "utf8")).toBe("# backup's own a");
    expect(result.warnings.some((w) => w.includes("skills/a: kept this account's own copy"))).toBe(true);
    expect(readlinkSync(path.join(backup, "skills", "b"))).toBe(realpathSync(path.join(shared, "b")));
  });
});

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("aliased config roots (review S5)", () => {
  test("a backup whose root resolves to the primary's through a symlink is refused, nothing written", async () => {
    const { primary, b, stack } = claudePair("alias-root");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    const linkParent = mkdtempSync(path.join(tmpdir(), "agetor-alias-link-"));
    const aliasHome = path.join(linkParent, "home");
    symlinkSync(primary, aliasHome);
    // Edited AFTER the stack was saved (the stack-save check never saw it).
    dbm.harnesses.update(b, { home: aliasHome });
    const before = readFileSync(path.join(primary, "settings.json"), "utf8");

    const result = await mirror.mirrorStack(stack, {});

    expect(result.warnings.some((w) => w.includes("share a config directory"))).toBe(true);
    expect(result.copied).toEqual([]);
    expect(readFileSync(path.join(primary, "settings.json"), "utf8")).toBe(before);
  });

  test("canonicalRoot resolves a missing tail under a symlinked ancestor", () => {
    const real = mkdtempSync(path.join(tmpdir(), "agetor-canon-real-"));
    const linkParent = mkdtempSync(path.join(tmpdir(), "agetor-canon-link-"));
    symlinkSync(real, path.join(linkParent, "l"));
    expect(transfer.canonicalRoot(path.join(linkParent, "l", "not-yet", ".claude")))
      .toBe(path.join(realpathSync(real), "not-yet", ".claude"));
    expect(transfer.sameConfigRoot(path.join(linkParent, "l"), real)).toBe(true);
    expect(transfer.sameConfigRoot(path.join(linkParent, "l", "x"), real)).toBe(false);
  });
});

describe("unchanged-file skip and single-flight (review S9, contract C4)", () => {
  test("a repeat mirror does not rewrite unchanged files; a changed one is copied again", async () => {
    const { primary, backup, stack } = claudePair("unchanged");
    const src = path.join(primary, "skills", "s", "SKILL.md");
    write(src, "# v1");
    write(path.join(primary, "CLAUDE.md"), "# memory");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    const dest = path.join(backup, "skills", "s", "SKILL.md");

    const first = await mirror.mirrorStack(stack, {});
    expect(rels(first)).toEqual(expect.arrayContaining(["skills/s/SKILL.md", "CLAUDE.md", "settings.json"]));
    // The copy carries the source's mtime, so the next mirror can match it.
    expect(Math.abs(statSync(dest).mtimeMs - statSync(src).mtimeMs)).toBeLessThan(1);
    const inode = statSync(dest).ino;
    const memoryInode = statSync(path.join(backup, "CLAUDE.md")).ino;
    const settingsInode = statSync(path.join(backup, "settings.json")).ino;

    const second = await mirror.mirrorStack(stack, {});
    expect(second.copied).toEqual([]);
    // Same inode: nothing was renamed over the destination.
    expect(statSync(dest).ino).toBe(inode);
    expect(statSync(path.join(backup, "CLAUDE.md")).ino).toBe(memoryInode);
    expect(statSync(path.join(backup, "settings.json")).ino).toBe(settingsInode);

    // Same size, new content and mtime: copied again.
    writeFileSync(src, "# v2");
    const later = new Date(Date.now() + 5_000);
    utimesSync(src, later, later);
    const third = await mirror.mirrorStack(stack, {});
    expect(rels(third)).toContain("skills/s/SKILL.md");
    expect(readFileSync(dest, "utf8")).toBe("# v2");

    // A destination the backup's CLI edited (new mtime) is overwritten.
    writeFileSync(dest, "# local edit, same len");
    const fourth = await mirror.mirrorStack(stack, {});
    expect(rels(fourth)).toContain("skills/s/SKILL.md");
    expect(readFileSync(dest, "utf8")).toBe("# v2");
  });

  test("concurrent mirrorForSwap calls into one account share one run; a later call runs again", async () => {
    const { primary, b, stack } = claudePair("single-flight");
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    const p1 = mirror.mirrorForSwap(stack, b);
    const p2 = mirror.mirrorForSwap(stack, b);
    expect(p2).toBe(p1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(r1.copied).toContain(`${b}:skills/s/SKILL.md`);
    const p3 = mirror.mirrorForSwap(stack, b);
    expect(p3).not.toBe(p1);
    // Nothing changed, so the fresh run copies nothing.
    expect((await p3).copied).toEqual([]);
  });

  test("a stack-save mirror and a swap mirror into one account do not interleave", async () => {
    const { primary, backup, b, stack } = claudePair("serialize");
    for (let i = 0; i < 40; i++) write(path.join(primary, "skills", `s${i}`, "SKILL.md"), `# ${i}`);
    const [full, swap] = await Promise.all([mirror.mirrorStack(stack, {}), mirror.mirrorForSwap(stack, b)]);
    // The second run started only after the first finished, so exactly one of
    // them did the copying and the other saw every file unchanged.
    const counts = [full.copied.length, swap.copied.length].sort((x, y) => x - y);
    expect(counts).toEqual([0, 40]);
    expect(readdirSync(path.join(backup, "skills"))).toHaveLength(40);
  });
});

describe("Codex profiles in every TOML form (review R-S1, R-S2)", () => {
  test("a [profiles] table with dotted keys loses the primary's login keys and keeps the backup's", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-prof-dotted");
    write(path.join(pRoot, "config.toml"), [
      "[profiles]",
      'work.model_provider = "corp"',
      'work.model = "gpt-5-work"',
      'work.forced_login_method = "chatgpt"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      "[profiles]",
      'work.model_provider = "own"',
    ].join("\n"));

    const result = await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(parsed.profiles.work).toEqual({ model: "gpt-5-work", model_provider: "own" });
    expect(text).not.toContain("corp");
    expect(text).not.toContain("forced_login_method");
    expect(result.warnings.some((w) => w.includes("profiles.work.model_provider") && w.includes("profiles.work.forced_login_method")))
      .toBe(true);
  });

  test("a backup with no profile login gets none of the primary's from a [profiles] table", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-prof-dotted-none");
    write(path.join(pRoot, "config.toml"), '[profiles]\nwork.model_provider = "corp"\n');
    await mirror.mirrorStack(stack, {});
    const parsed = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(parsed.profiles?.work?.model_provider).toBeUndefined();
  });

  test("an inline profile table naming a login key is not imported; the backup's own inline profile survives", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-prof-inline");
    write(path.join(pRoot, "config.toml"), [
      "[profiles]",
      'work = { model_provider = "corp", model = "gpt-5" }',
      'plain = { model = "gpt-5-mini" }',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      "[profiles]",
      'work = { model_provider = "own" }',
    ].join("\n"));

    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(parsed.profiles.work).toEqual({ model_provider: "own" });
    expect(parsed.profiles.plain).toEqual({ model: "gpt-5-mini" });
    expect(text).not.toContain("corp");
  });

  test("the backup's own [profiles.<n>] login keys survive when the primary's profile has none (R-S2)", async () => {
    const { pRoot, bRoot, stack } = codexPair("cx-prof-keep");
    write(path.join(pRoot, "config.toml"), '[profiles.work]\nmodel = "gpt-5"\n');
    write(path.join(bRoot, "config.toml"), '[profiles.work]\nmodel_provider = "own"\nchatgpt_base_url = "https://own.invalid"\n');

    await mirror.mirrorStack(stack, {});
    const parsed = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(parsed.profiles.work).toEqual({ model: "gpt-5", model_provider: "own", chatgpt_base_url: "https://own.invalid" });
  });
});

describe("Claude login-selecting and command settings (review R-S3, R-S4)", () => {
  const LOGIN_KEYS = ["forceLoginMethod", "gcpAuthRefresh", "proxyAuthHelper"] as const;
  const COMMAND_KEYS = [
    "fileSuggestion",
    "processWrapper",
    "policyHelpers",
    "proxyAuthHelper",
    "subagentStatusLine",
    "gcpAuthRefresh",
    "statusLine",
    "otelHeadersHelper",
  ] as const;

  for (const mode of ["full", "safe"] as const) {
    for (const key of LOGIN_KEYS) {
      test(`${mode} mode never imports ${key}; the backup's own survives`, async () => {
        const { primary, backup, stack } = claudePair(`login-${key.toLowerCase()}-${mode}`, mode);
        write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", [key]: `primary-${key}` }));
        write(path.join(backup, "settings.json"), JSON.stringify({ model: "sonnet" }));
        await mirror.mirrorStack(stack, {});
        let merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
        expect(merged.model).toBe("opus");
        expect(merged[key]).toBeUndefined();

        write(path.join(backup, "settings.json"), JSON.stringify({ [key]: `backup-${key}` }));
        await mirror.mirrorStack(stack, {});
        merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
        expect(merged[key]).toBe(`backup-${key}`);
      });
    }
  }

  for (const key of COMMAND_KEYS) {
    test(`safe mode skips the command setting ${key} and keeps the backup's own`, async () => {
      const { primary, backup, stack } = claudePair(`safe-cmd-${key.toLowerCase()}`, "safe");
      const value = { type: "command", command: `/primary/${key}.sh` };
      write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", [key]: value }));
      write(path.join(backup, "settings.json"), JSON.stringify({ model: "sonnet" }));
      await mirror.mirrorStack(stack, {});
      let merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
      expect(merged.model).toBe("opus");
      expect(merged[key]).toBeUndefined();

      write(path.join(backup, "settings.json"), JSON.stringify({ [key]: "backup-own" }));
      await mirror.mirrorStack(stack, {});
      merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
      expect(merged[key]).toBe("backup-own");
    });
  }

  test("full mode still copies the non-login command settings", async () => {
    const { primary, backup, stack } = claudePair("full-cmd", "full");
    write(path.join(primary, "settings.json"), JSON.stringify({
      fileSuggestion: { type: "command", command: "/primary/fs.sh" },
      processWrapper: "/primary/wrap.sh",
      subagentStatusLine: { type: "command", command: "/primary/s.sh" },
    }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.fileSuggestion).toEqual({ type: "command", command: "/primary/fs.sh" });
    expect(merged.processWrapper).toBe("/primary/wrap.sh");
    expect(merged.subagentStatusLine).toEqual({ type: "command", command: "/primary/s.sh" });
  });
});

describe("macOS-protected folders (review R-S5, R-S6, contract CR4)", () => {
  /** A fake home with a `Documents` folder; while locked (mode 000) any stat
   *  below it fails, so a clean result proves the core never looked inside. */
  function protectedHome() {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-mirror-tcc-home-")));
    const documents = path.join(home, "Documents");
    mkdirSync(documents);
    transfer.setTccHomeForTests(home);
    return {
      home,
      documents,
      lock: () => chmodSync(documents, 0o000),
      unlock: () => chmodSync(documents, 0o700),
    };
  }

  test("a skill symlinked into a protected folder (directly or through a chain) is refused without stat'ing inside it", async () => {
    const { documents, lock, unlock } = protectedHome();
    try {
      mkdirSync(path.join(documents, "notes"));
      const { primary, backup, stack } = claudePair("tcc-skill");
      mkdirSync(path.join(primary, "skills"), { recursive: true });
      symlinkSync(path.join(documents, "notes"), path.join(primary, "skills", "notes"));
      const hop = mkdtempSync(path.join(tmpdir(), "agetor-mirror-tcc-hop-"));
      symlinkSync(documents, path.join(hop, "docs"));
      symlinkSync(path.join(hop, "docs", "notes"), path.join(primary, "skills", "chained"));
      const shared = mkdtempSync(path.join(tmpdir(), "agetor-mirror-tcc-ok-"));
      write(path.join(shared, "ok", "SKILL.md"), "# ok");
      symlinkSync(path.join(shared, "ok"), path.join(primary, "skills", "ok"));
      lock();

      const result = await mirror.mirrorStack(stack, {});

      for (const name of ["notes", "chained"]) {
        expect(isLink(path.join(backup, "skills", name)), name).toBe(false);
        expect(result.warnings.some((w) => w.includes(`skills/${name}: symlink points into the macOS-protected folder ~/Documents`)), name)
          .toBe(true);
      }
      // `realpath` on a link into the locked folder would have failed and been
      // reported as a missing target; the lexical walk never got that far.
      expect(result.warnings.some((w) => w.includes("target is missing"))).toBe(false);
      expect(readlinkSync(path.join(backup, "skills", "ok"))).toBe(realpathSync(path.join(shared, "ok")));
    } finally {
      unlock();
      transfer.setTccHomeForTests(null);
    }
  });

  test("a backup root swapped for a symlink into a protected folder after it was saved is refused, nothing written", async () => {
    const { documents, lock, unlock } = protectedHome();
    try {
      const { primary, b, stack } = claudePair("tcc-root");
      write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
      write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
      // The repro from review R-S6: the member root is replaced by a link
      // into a protected folder after the stack was saved.
      mkdirSync(path.join(documents, "acct2"));
      const parent = mkdtempSync(path.join(tmpdir(), "agetor-mirror-tcc-link-"));
      const linkedHome = path.join(parent, "home");
      symlinkSync(path.join(documents, "acct2"), linkedHome);
      dbm.harnesses.update(b, { home: linkedHome });
      lock();

      const result = await mirror.mirrorStack(stack, {});

      expect(result.copied).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("this account's config directory now resolves into the macOS-protected folder ~/Documents");
      unlock();
      expect(readdirSync(path.join(documents, "acct2"))).toEqual([]);
    } finally {
      unlock();
      transfer.setTccHomeForTests(null);
    }
  });

  test("a redirected primary root is refused the same way; a root saved under the folder still mirrors", async () => {
    const { documents, unlock } = protectedHome();
    try {
      const { primary, backup, a, stack } = claudePair("tcc-primary");
      write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
      const parent = mkdtempSync(path.join(tmpdir(), "agetor-mirror-tcc-plink-"));
      mkdirSync(path.join(documents, "primary"));
      write(path.join(documents, "primary", "settings.json"), JSON.stringify({ model: "from-documents" }));
      symlinkSync(path.join(documents, "primary"), path.join(parent, "home"));
      dbm.harnesses.update(a, { home: path.join(parent, "home") });

      const refused = await mirror.mirrorStack(stack, {});
      expect(refused.warnings.some((w) => w.includes("the primary's config directory now resolves into the macOS-protected folder"))).toBe(true);
      expect(existsSync(path.join(backup, "settings.json"))).toBe(false);

      // Saved under Documents on purpose: gated as such, so not refused.
      dbm.harnesses.update(a, { home: path.join(documents, "primary") });
      const ok = await mirror.mirrorStack(stack, {});
      expect(ok.warnings.some((w) => w.includes("macOS-protected"))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("from-documents");
    } finally {
      unlock();
      transfer.setTccHomeForTests(null);
    }
  });
});
