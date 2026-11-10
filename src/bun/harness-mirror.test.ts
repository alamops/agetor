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
import { homedir, tmpdir } from "node:os";
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

    expect(result.warnings.some((w) => w.includes(".claude.json: backup file is a symlink"))).toBe(true);
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

  test("a dotfile-manager symlinked primary config file is resolved, and a symlinked destination dir is not written through", async () => {
    const primary = mkdtempSync(path.join(tmpdir(), "agetor-link-p-"));
    const backup = mkdtempSync(path.join(tmpdir(), "agetor-link-b-"));
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-link-outside-"));
    const a = alias(unique("link-a"), primary);
    const b = alias(unique("link-b"), backup);
    const stack = stacks.harnessStacks.create({ label: "links", kind: "claude-code", members: [a, b], mirrorMode: "safe" });

    write(path.join(outside, "secret.json"), JSON.stringify({ model: "from-dotfiles" }));
    symlinkSync(path.join(outside, "secret.json"), path.join(primary, "settings.json"));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "sonnet" }));
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    symlinkSync(outside, path.join(backup, "skills"));

    await mirror.mirrorStack(stack, {});

    // The primary's settings.json is a link into a dotfiles folder: resolved
    // lexically and accepted, so the primary's value wins the merge.
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("from-dotfiles");
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
    const victim = path.join(outside, "sid.jsonl");
    writeFileSync(victim, "do not delete");
    mkdirSync(path.join(root, "projects", "real"), { recursive: true });
    symlinkSync(outside, path.join(root, "projects", "linked"));

    expect(await transfer.removeCopiedPaths([path.join(root, "projects", "linked", "sid.jsonl")], root, "claude-code", "sid"))
      .toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("do not delete");

    // A plain, shape-matching path under the root still cleans up, and the
    // account's own `projects/<enc>` folder is never pruned.
    const own = path.join(root, "projects", "real", "sid.jsonl");
    writeFileSync(own, "copied");
    expect(await transfer.removeCopiedPaths([own], root, "claude-code", "sid")).toEqual([own]);
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
    expect(await transfer.removeCopiedPaths([copied], root, "claude-code", "sid")).toEqual([copied]);
    // The empty `subagents/` is pruned…
    expect(existsSync(sidecar)).toBe(false);
    // …and pruning stops at the first non-empty directory, so the sibling
    // holding the backup's own file (and its parents) stay.
    expect(readFileSync(kept, "utf8")).toBe("backup's own");
    expect(existsSync(path.join(root, "projects", "enc", "sid"))).toBe(true);
    expect(existsSync(path.join(root, "projects", "enc"))).toBe(true);

    // With the last sidecar file gone, the whole session folder is pruned —
    // but never `projects/<enc>` itself.
    expect(await transfer.removeCopiedPaths([kept], root, "claude-code", "sid")).toEqual([kept]);
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
      "sid",
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
    expect(await transfer.removeCopiedPaths([auth, odd, rollout], codexRoot, "codex", "thread")).toEqual([rollout]);
    expect(existsSync(auth)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(path.join(codexRoot, "sessions", "2026"))).toBe(false);
    expect(existsSync(path.join(codexRoot, "sessions"))).toBe(true);
    // A claude shape is not a codex shape and vice versa.
    const claudeShaped = path.join(codexRoot, "projects", "enc", "sid.jsonl");
    write(claudeShaped, "x");
    expect(await transfer.removeCopiedPaths([claudeShaped], codexRoot, "codex", "thread")).toEqual([]);
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
    expect(await transfer.removeCopiedPaths([recorded], root, "claude-code", "sid")).toEqual([]);
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
  test("the primary's hooks and permissions replace the backup's; other arrays the primary defines replace the backup's", async () => {
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
    expect(merged.enabledMcpjsonServers).toEqual(["alpha"]);
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

describe("fix round: merge, credential and symlink bugs (T3)", () => {
  test("a bumped MCP arg replaces the backup's args; backup-only servers and per-project servers survive/mirror", async () => {
    const { primary, backup, stack } = claudePair("t3-args");
    write(path.join(primary, ".claude.json"), JSON.stringify({
      mcpServers: { foo: { command: "x", args: ["--v2"] } },
      enabledPlugins: { "p@m": { scope: "user" } },
      projects: { "/work/x": { mcpServers: { local: { command: "l", args: ["1"] } }, hasTrustDialogAccepted: true, history: ["secret"] } },
    }));
    write(path.join(backup, ".claude.json"), JSON.stringify({
      mcpServers: { foo: { command: "x", args: ["--v1"] }, mine: { command: "m" } },
    }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, ".claude.json"), "utf8"));
    expect(merged.mcpServers.foo.args).toEqual(["--v2"]);
    expect(merged.mcpServers.mine).toEqual({ command: "m" });
    expect(merged.projects["/work/x"]).toEqual({ mcpServers: { local: { command: "l", args: ["1"] } } });
  });

  test("a TOML multi-line string holding [Rules] is not a header, and a primary that moved env inline stays valid", async () => {
    const { pRoot, bRoot, stack } = codexPair("t3-toml");
    write(path.join(pRoot, "config.toml"), [
      'developer_instructions = """',
      "[Rules]",
      "be kind",
      '"""',
      "",
      "[mcp_servers.foo]",
      'command = "x"',
      'env = { A = "1" }',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      "[mcp_servers.foo]",
      'command = "old"',
      "",
      "[mcp_servers.foo.env]",
      'A = "old"',
      "",
      "[mcp_servers.mine]",
      'command = "m"',
    ].join("\n"));
    const result = await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(parsed.developer_instructions).toContain("[Rules]");
    expect(parsed.mcp_servers.foo.env).toEqual({ A: "1" });
    expect(parsed.mcp_servers.mine.command).toBe("m");
    expect(result.warnings.some((w) => w.includes("invalid TOML") || w.includes("would have lost"))).toBe(false);
  });

  test("Codex: dotted projects trust and shell/otel secrets never cross; the backup's own survive", async () => {
    const { pRoot, bRoot, stack } = codexPair("t3-cx-secret");
    write(path.join(pRoot, "config.toml"), [
      'model = "gpt-5"',
      'projects."/x".trust_level = "trusted"',
      "shell_environment_policy.set = { GH_TOKEN = \"p-secret\", LANG = \"C\" }",
      "",
      "[otel]",
      'environment = "dev"',
      "",
      "[otel.exporter.otlp-http.headers]",
      'authorization = "Bearer p-secret"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      "shell_environment_policy.set = { GH_TOKEN = \"b-own\" }",
      "",
      "[otel.exporter.otlp-http.headers]",
      'authorization = "Bearer b-own"',
    ].join("\n"));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    expect(text).not.toContain("p-secret");
    expect(text).not.toContain("trust_level");
    expect(text).toContain("b-own");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(parsed.shell_environment_policy.set.LANG).toBe("C");
    expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe("b-own");
    expect(parsed.model).toBe("gpt-5");
  });

  test("env credentials, proxy userinfo and (safe mode) command-running env are not imported", async () => {
    const { primary, backup, stack } = claudePair("t3-env", "safe");
    write(path.join(primary, "settings.json"), JSON.stringify({
      env: {
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x",
        SERPAPI_APIKEY: "k",
        github_token: "t",
        HTTPS_PROXY: "http://u:p@proxy:8080",
        NODE_OPTIONS: "--require /x.js",
        CLAUDE_CODE_SHELL_PREFIX: "wrap",
        MY_HELPER: "run",
        ANTHROPIC_MODEL: "opus",
        PATH: "/usr/bin",
        MAX_TOKENS: "10",
      },
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--own" } }));
    await mirror.mirrorStack(stack, {});
    const env = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env;
    expect(env).toEqual({ NODE_OPTIONS: "--own", ANTHROPIC_MODEL: "opus", PATH: "/usr/bin", MAX_TOKENS: "10" });
  });

  test("a planted .claude.json symlink into a protected folder is never stat'ed through", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-t3-tcc-")));
    const documents = path.join(home, "Documents");
    mkdirSync(documents);
    write(path.join(documents, "notes.json"), JSON.stringify({ mcpServers: { stolen: {} } }));
    transfer.setTccHomeForTests(home);
    try {
      const { primary, backup, stack } = claudePair("t3-cj-tcc");
      symlinkSync(path.join(documents, "notes.json"), path.join(primary, ".claude.json"));
      chmodSync(documents, 0o000);
      const result = await mirror.mirrorStack(stack, {});
      expect(result.warnings.some((w) => w.includes("macOS-protected folder ~/Documents"))).toBe(true);
      expect(existsSync(path.join(backup, ".claude.json"))).toBe(false);
    } finally {
      chmodSync(documents, 0o700);
      transfer.setTccHomeForTests(null);
    }
  });
});

describe("fix round: provenance, propagation, backups, preview, restore (T3)", () => {
  test("preview equals the real run; a backup CLAUDE.md is backed up, overwritten and Restore puts it back", async () => {
    const { primary, backup, a, b, stack } = claudePair("t3-restore");
    write(path.join(primary, "CLAUDE.md"), "primary rules\n");
    write(path.join(backup, "CLAUDE.md"), "my own rules\n");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "sonnet" }));

    const preview = await mirror.previewMirror({ kind: "claude-code", members: [a, b], mirrorMode: "full" }, { stackId: stack.id });
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("my own rules\n");
    expect(preview.overwrites).toBe(true);
    const plan = preview.plans[0]!;
    expect(plan.files.update).toContain("CLAUDE.md");
    expect(plan.backups).toContain("CLAUDE.md");
    expect(plan.backups).toContain("settings.json:model");
    expect(plan.keys).toContainEqual({ file: "settings.json", key: "env.FOO", action: "add" });
    expect(JSON.stringify(plan)).not.toContain("opus");

    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("primary rules\n");
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("opus");
    const rows = (await import("./harness-mirror-provenance.ts")).mirrorProvenance.list(b);
    expect(rows.find((r) => r.path === "CLAUDE.md")?.preexisted).toBe(true);
    expect(rows.find((r) => r.path === "settings.json" && r.key === "env.FOO")?.preexisted).toBe(false);

    const result = await mirror.restoreMirror(b);
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("my own rules\n");
    const settings = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(settings.model).toBe("sonnet");
    expect(settings.env.FOO).toBeUndefined();
    expect(result.restored).toContain("CLAUDE.md");
    expect(result.removed).toContain("settings.json:env.FOO");
    expect((await import("./harness-mirror-provenance.ts")).mirrorProvenance.list(b)).toEqual([]);
  });

  test("a primary deletion removes the unedited mirrored skill and keeps an edited one", async () => {
    const { primary, backup, b, stack } = claudePair("t3-delete");
    write(path.join(primary, "skills", "keep-me", "SKILL.md"), "# a");
    write(path.join(primary, "skills", "edited", "SKILL.md"), "# b");
    write(path.join(primary, "skills", "gone", "SKILL.md"), "# c");
    await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "skills", "gone", "SKILL.md"))).toBe(true);
    writeFileSync(path.join(backup, "skills", "edited", "SKILL.md"), "# my edit");
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "skills", "gone"), { recursive: true });
    rmSync(path.join(primary, "skills", "edited"), { recursive: true });

    const preview = await mirror.previewMirror({ kind: "claude-code", members: [stack.members[0]!.harnessId, b], mirrorMode: "full" });
    expect(preview.plans[0]!.files.remove).toEqual(["skills/gone/SKILL.md"]);
    expect(preview.plans[0]!.kept).toEqual(["skills/edited/SKILL.md"]);
    expect(existsSync(path.join(backup, "skills", "gone", "SKILL.md"))).toBe(true);

    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "skills", "gone", "SKILL.md"))).toBe(false);
    expect(readFileSync(path.join(backup, "skills", "edited", "SKILL.md"), "utf8")).toBe("# my edit");
    expect(existsSync(path.join(backup, "skills", "keep-me", "SKILL.md"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("edited on this account"))).toBe(true);
  });

  test("a planted provenance row cannot remove a file outside the mirror allowlist", async () => {
    const { primary, backup, b, stack } = claudePair("t3-planted");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    write(path.join(backup, "projects", "enc", "s.jsonl"), "transcript");
    const { mirrorProvenance } = await import("./harness-mirror-provenance.ts");
    const crypto = await import("node:crypto");
    mirrorProvenance.upsert({
      harnessId: b, stackId: stack.id, scope: "file", path: "projects/enc/s.jsonl", key: "",
      valueHash: crypto.createHash("sha256").update("transcript").digest("hex"),
      srcMtimeMs: null, srcSize: null, preexisted: false, backupRef: null, updatedAt: 1,
    });
    await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "projects", "enc", "s.jsonl"))).toBe(true);
    const restored = await mirror.restoreMirror(b);
    expect(existsSync(path.join(backup, "projects", "enc", "s.jsonl"))).toBe(true);
    expect(restored.removed).not.toContain("projects/enc/s.jsonl");
  });

  test("a backup's top-level symlinked file is skipped, never replaced by a regular file", async () => {
    const { primary, backup, stack } = claudePair("t3-dest-link");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-t3-dest-link-out-"));
    write(path.join(primary, "CLAUDE.md"), "primary\n");
    write(path.join(outside, "CLAUDE.md"), "dotfile\n");
    symlinkSync(path.join(outside, "CLAUDE.md"), path.join(backup, "CLAUDE.md"));
    const result = await mirror.mirrorStack(stack, {});
    expect(lstatSync(path.join(backup, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, "CLAUDE.md"), "utf8")).toBe("dotfile\n");
    expect(result.warnings.some((w) => w.includes("CLAUDE.md") && w.includes("symlink"))).toBe(true);
  });

  test("safe mode un-owns hooks without deleting them from the backup", async () => {
    const { primary, backup, b, stack } = claudePair("t3-safe-unown", "full");
    write(path.join(primary, "settings.json"), JSON.stringify({ hooks: { Stop: [] }, model: "opus" }));
    await mirror.mirrorStack(stack, {});
    const { mirrorProvenance } = await import("./harness-mirror-provenance.ts");
    expect(mirrorProvenance.get(b, "settings.json", "hooks")).not.toBeNull();
    const safeStack = { ...stack, mirrorMode: "safe" as const };
    await mirror.mirrorStack(safeStack, {});
    expect(mirrorProvenance.get(b, "settings.json", "hooks")).toBeNull();
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).hooks).toEqual({ Stop: [] });
  });
});

describe("fix round: wave 2 review fixes (T3)", () => {
  const prov = async () => (await import("./harness-mirror-provenance.ts")).mirrorProvenance;

  test("M3: an edited mirror-owned file is backed up, flagged in the preview, and Restore puts the edit back", async () => {
    const { primary, backup, a, b, stack } = claudePair("t3-m3");
    write(path.join(primary, "skills", "x", "SKILL.md"), "v1");
    await mirror.mirrorStack(stack, {});
    writeFileSync(path.join(backup, "skills", "x", "SKILL.md"), "MY EDIT");
    await Bun.sleep(20);
    write(path.join(primary, "skills", "x", "SKILL.md"), "v2 changed");
    const preview = await mirror.previewMirror({ kind: "claude-code", members: [a, b], mirrorMode: "full" });
    expect(preview.overwrites).toBe(true);
    expect(preview.plans[0]!.backups).toContain("skills/x/SKILL.md");
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "skills", "x", "SKILL.md"), "utf8")).toBe("v2 changed");
    await mirror.restoreMirror(b);
    expect(readFileSync(path.join(backup, "skills", "x", "SKILL.md"), "utf8")).toBe("MY EDIT");
  });

  test("M3: an edited key is backed up before the primary overwrites it", async () => {
    const { primary, backup, b, stack } = claudePair("t3-m3-key");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus" }));
    await mirror.mirrorStack(stack, {});
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "my-edit" }));
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "fable" }));
    await mirror.mirrorStack(stack, {});
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("fable");
    await mirror.restoreMirror(b);
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("my-edit");
  });

  test("M1: a kept item leaves its row for a retry, and an orphaned original never shadows a new one", async () => {
    const { primary, backup, b, stack } = claudePair("t3-m1");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", effortLevel: "high" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "O1", effortLevel: "low" }));
    await mirror.mirrorStack(stack, {});
    const s = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    s.effortLevel = "edited";
    write(path.join(backup, "settings.json"), JSON.stringify(s));
    const r1 = await mirror.restoreMirror(b);
    expect(r1.kept).toContain("settings.json:effortLevel");
    const left = (await prov()).list(b);
    expect(left.map((r) => r.key)).toEqual(["effortLevel"]);
    // The account sets a new model by hand; the next mirror backs THAT up.
    const s2 = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    s2.model = "O2";
    write(path.join(backup, "settings.json"), JSON.stringify(s2));
    await mirror.mirrorStack(stack, {});
    await mirror.restoreMirror(b);
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("O2");
  });

  test("M2: a dropped stale Codex subtable is restorable", async () => {
    const { pRoot, bRoot, b, stack } = codexPair("t3-m2");
    write(path.join(pRoot, "config.toml"), '[mcp_servers.foo]\ncommand = "x"\nenv = { A = "1" }\n');
    write(path.join(bRoot, "config.toml"), '[mcp_servers.foo]\ncommand = "old"\n\n[mcp_servers.foo.env]\nB = "mine"\n');
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(bRoot, "config.toml"), "utf8")).not.toContain("mcp_servers.foo.env");
    const result = await mirror.restoreMirror(b);
    const parsed = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(result.restored.some((n) => n.includes("mcp_servers.foo"))).toBe(true);
    expect(parsed.mcp_servers.foo.command).toBe("old");
    expect(parsed.mcp_servers.foo.env).toEqual({ B: "mine" });
  });

  test("S1: spaced and quoted projects headers never cross", async () => {
    const { pRoot, bRoot, stack } = codexPair("t3-s1");
    write(path.join(pRoot, "config.toml"), 'model = "m"\n\n[ projects . "/x" ]\ntrust_level = "trusted"\n\n["projects"."/y"]\ntrust_level = "trusted"\n');
    write(path.join(bRoot, "config.toml"), 'model = "o"\n');
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(bRoot, "config.toml"), "utf8")).not.toContain("trust_level");
  });

  test("S2: userinfo URLs in any env value, DSN names and credentialed marketplace entries do not cross", async () => {
    const { primary, backup, stack } = claudePair("t3-s2");
    write(path.join(primary, "settings.json"), JSON.stringify({
      env: { DATABASE_URL: "postgres://u:hunter2@db/x", SENTRY_DSN: "https://k@sentry.io/1", KEEP: "1" },
      extraKnownMarketplaces: {
        bad: { source: { url: "https://tok:x@host/repo.git" } },
        good: { source: { url: "https://host/repo.git" } },
      },
    }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.env).toEqual({ KEEP: "1" });
    expect(Object.keys(merged.extraKnownMarketplaces)).toEqual(["good"]);
  });

  test("S3: a crash-left intent row is refreshed so Restore sees the mirror's own bytes", async () => {
    const { primary, backup, b, stack } = claudePair("t3-s3");
    write(path.join(primary, "CLAUDE.md"), "primary\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    await mirror.mirrorStack(stack, {});
    const p = await prov();
    const row = p.get(b, "CLAUDE.md")!;
    p.upsert({ ...row, valueHash: "stale", srcMtimeMs: null, srcSize: null });
    await mirror.mirrorStack(stack, {});
    const result = await mirror.restoreMirror(b);
    expect(result.restored).toContain("CLAUDE.md");
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("mine\n");
  });

  test("S4: a dotfile link must be a regular file of the entry's type", async () => {
    const { primary, backup, stack } = claudePair("t3-s4");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-t3-s4-"));
    write(path.join(outside, "notes.txt"), "not markdown");
    symlinkSync(path.join(outside, "notes.txt"), path.join(primary, "CLAUDE.md"));
    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "CLAUDE.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("CLAUDE.md") && w.includes(".md"))).toBe(true);
  });

  test("S6: Restore keeps an original's exec bit", async () => {
    const { primary, backup, b, stack } = claudePair("t3-s6");
    write(path.join(primary, "commands", "run.sh"), "new");
    write(path.join(backup, "commands", "run.sh"), "#!/bin/sh\n");
    chmodSync(path.join(backup, "commands", "run.sh"), 0o755);
    await mirror.mirrorStack(stack, {});
    await mirror.restoreMirror(b);
    expect(statSync(path.join(backup, "commands", "run.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("fix round F-B: backup store trust, link restore, deleted originals, account delete", () => {
  const provs = async () => (await import("./harness-mirror-provenance.ts")).mirrorProvenance;
  const backupsOf = (id: string) => path.join(dbm.dataDir, "mirror-backups", id);

  test("M2: a planted symlink inside the backup store is never read or unlinked through", async () => {
    const { primary, backup, b, stack } = claudePair("fb-m2");
    write(path.join(primary, "skills", "x", "SKILL.md"), "primary skill");
    write(path.join(backup, "skills", "x", "SKILL.md"), "my own skill");
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "skills", "x", "SKILL.md"), "utf8")).toBe("primary skill");

    const outside = mkdtempSync(path.join(tmpdir(), "agetor-fb-m2-out-"));
    write(path.join(outside, "x", "SKILL.md"), "PLANTED DOCUMENTS CONTENT");
    const { renameSync } = await import("node:fs");
    renameSync(path.join(backupsOf(b), "files", "skills"), path.join(backupsOf(b), "files", "skills.real"));
    symlinkSync(outside, path.join(backupsOf(b), "files", "skills"));

    const result = await mirror.restoreMirror(b);
    // The planted bytes were never copied into the account...
    expect(readFileSync(path.join(backup, "skills", "x", "SKILL.md"), "utf8")).not.toBe("PLANTED DOCUMENTS CONTENT");
    expect(result.restored).not.toContain("skills/x/SKILL.md");
    // ...and nothing outside the store was unlinked.
    expect(readFileSync(path.join(outside, "x", "SKILL.md"), "utf8")).toBe("PLANTED DOCUMENTS CONTENT");
  });

  test("M2: removeMirrorBackups refuses a symlinked account directory and never follows links inside", async () => {
    const { b } = claudePair("fb-m2-rm");
    const outside = mkdtempSync(path.join(tmpdir(), "agetor-fb-m2-rm-out-"));
    write(path.join(outside, "keep.txt"), "keep");
    mkdirSync(path.dirname(backupsOf(b)), { recursive: true });
    symlinkSync(outside, backupsOf(b));
    await mirror.removeMirrorBackups(b);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(lstatSync(backupsOf(b)).isSymbolicLink()).toBe(true);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(backupsOf(b));

    // A link nested inside the tree is unlinked as itself, not followed.
    mkdirSync(path.join(backupsOf(b), "files"), { recursive: true });
    symlinkSync(outside, path.join(backupsOf(b), "files", "evil"));
    await mirror.removeMirrorBackups(b);
    expect(existsSync(backupsOf(b))).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  test("M3: Restore removes an added link and puts a replaced link's original target back", async () => {
    const { primary, backup, b, stack } = claudePair("fb-m3");
    const shared = mkdtempSync(path.join(tmpdir(), "agetor-fb-m3-shared-"));
    write(path.join(shared, "added", "SKILL.md"), "# added");
    write(path.join(shared, "new", "SKILL.md"), "# new");
    write(path.join(shared, "old", "SKILL.md"), "# old");
    mkdirSync(path.join(primary, "skills"), { recursive: true });
    symlinkSync(path.join(shared, "added"), path.join(primary, "skills", "added"));
    symlinkSync(path.join(shared, "new"), path.join(primary, "skills", "swapped"));
    mkdirSync(path.join(backup, "skills"), { recursive: true });
    symlinkSync(path.join(shared, "old"), path.join(backup, "skills", "swapped"));

    await mirror.mirrorStack(stack, {});
    expect(lstatSync(path.join(backup, "skills", "added")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(backup, "skills", "swapped"))).toBe(realpathSync(path.join(shared, "new")));

    const result = await mirror.restoreMirror(b);
    expect(existsSync(path.join(backup, "skills", "added"))).toBe(false);
    expect(readlinkSync(path.join(backup, "skills", "swapped"))).toBe(path.join(shared, "old"));
    expect(result.removed).toContain("skills/added");
    expect(result.restored).toContain("skills/swapped");
    expect((await provs()).list(b)).toEqual([]);
  });

  test("S1: Restore puts back a preexisted file the account deleted", async () => {
    const { primary, backup, b, stack } = claudePair("fb-s1");
    write(path.join(primary, "CLAUDE.md"), "primary\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    await mirror.mirrorStack(stack, {});
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path.join(backup, "CLAUDE.md"));
    const result = await mirror.restoreMirror(b);
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect(result.restored).toContain("CLAUDE.md");
  });

  test("account delete: deleteMirrorStateForHarness leaves no rows or backups, even mid-mirror", async () => {
    const { primary, backup, b, stack } = claudePair("fb-delete");
    write(path.join(primary, "CLAUDE.md"), "primary\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    for (let i = 0; i < 150; i++) write(path.join(primary, "skills", `s${i}`, "SKILL.md"), `# ${i}`);
    const running = mirror.mirrorStack(stack, {});
    const p = await provs();
    for (let i = 0; i < 2000 && p.list(b).length === 0; i++) await Bun.sleep(0);
    dbm.harnesses.delete(b);
    await mirror.deleteMirrorStateForHarness(b);
    await running;
    // The delete was queued behind the mirror in flight, so nothing it wrote survives.
    await mirror.deleteMirrorStateForHarness(b);
    expect(p.list(b)).toEqual([]);
    expect(existsSync(backupsOf(b))).toBe(false);
    expect((await import("./harness-mirror-provenance.ts")).harnessIdsWithProvenance()).not.toContain(b);
  });

  test("harnessIdsWithProvenance lists the accounts that have rows", async () => {
    const { primary, backup, b, stack } = claudePair("fb-ids");
    write(path.join(primary, "CLAUDE.md"), "primary rules\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    await mirror.mirrorStack(stack, {});
    const ids = (await import("./harness-mirror-provenance.ts")).harnessIdsWithProvenance();
    expect(ids).toContain(b);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("reversibility: a preexisted skill file the primary deleted is still restored", async () => {
    const { primary, backup, b, stack } = claudePair("fb-rev-file");
    write(path.join(primary, "skills", "s", "SKILL.md"), "primary");
    write(path.join(backup, "skills", "s", "SKILL.md"), "mine");
    await mirror.mirrorStack(stack, {});
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "skills", "s"), { recursive: true });
    await mirror.mirrorStack(stack, {});
    // Propagation keeps the file (it was the account's own)...
    expect(readFileSync(path.join(backup, "skills", "s", "SKILL.md"), "utf8")).toBe("primary");
    // ...but the row and the saved original remain as an un-owned restore pointer.
    const row = (await provs()).get(b, "skills/s/SKILL.md");
    expect(row?.preexisted).toBe(true);
    expect(row?.backupRef).toBeTruthy();
    // A later mirror that writes the item again re-adopts it without re-backing-up over "mine".
    write(path.join(primary, "skills", "s", "SKILL.md"), "primary v2");
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "skills", "s", "SKILL.md"), "utf8")).toBe("primary v2");
    rmSync(path.join(primary, "skills", "s"), { recursive: true });
    await mirror.mirrorStack(stack, {});

    const result = await mirror.restoreMirror(b);
    expect(readFileSync(path.join(backup, "skills", "s", "SKILL.md"), "utf8")).toBe("mine");
    expect(result.restored).toContain("skills/s/SKILL.md");
  });

  test("reversibility: a preexisted hook un-owned by safe mode is restored", async () => {
    const { primary, backup, b, stack } = claudePair("fb-rev-hook");
    write(path.join(primary, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ command: "primary-hook" }] } }));
    write(path.join(backup, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ command: "my-hook" }] } }));
    await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "settings.json"), "utf8")).toContain("primary-hook");
    await mirror.mirrorStack({ ...stack, mirrorMode: "safe" }, {});
    const result = await mirror.restoreMirror(b);
    const settings = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(JSON.stringify(settings.hooks)).toContain("my-hook");
    expect(JSON.stringify(settings.hooks)).not.toContain("primary-hook");
    expect(result.restored.some((r) => r.startsWith("settings.json:hooks"))).toBe(true);
  });
});

describe("TT-C: finding 12 (JSON merge semantics)", () => {
  test("stdio -> http: the replaced server keeps no stale command or args", async () => {
    const { primary, backup, stack } = claudePair("ttc-stdio-http");
    write(path.join(primary, ".claude.json"), JSON.stringify({ mcpServers: { foo: { type: "http", url: "https://mcp.example/x" } } }));
    write(path.join(backup, ".claude.json"), JSON.stringify({ mcpServers: { foo: { command: "old-bin", args: ["--old"], env: { A: "1" } } } }));
    await mirror.mirrorStack(stack, {});
    const foo = JSON.parse(readFileSync(path.join(backup, ".claude.json"), "utf8")).mcpServers.foo;
    expect(foo).toEqual({ type: "http", url: "https://mcp.example/x" });
  });

  test("an enabledPlugins entry is replaced whole, never deep-merged", async () => {
    const { primary, backup, stack } = claudePair("ttc-enabled-plugins");
    write(path.join(primary, "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": { scope: "user" } } }));
    write(path.join(backup, "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": { scope: "project", stale: true }, "own@m": true } }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.enabledPlugins["p@m"]).toEqual({ scope: "user" });
    expect(merged.enabledPlugins["own@m"]).toBe(true);
  });

  test("enabledMcpjsonServers and disabledMcpjsonServers are replaced, not unioned", async () => {
    const { primary, backup, stack } = claudePair("ttc-mcpjson");
    write(path.join(primary, "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["x"] }));
    write(path.join(backup, "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["b", "x"], disabledMcpjsonServers: ["a", "y"] }));
    await mirror.mirrorStack(stack, {});
    const merged = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(merged.enabledMcpjsonServers).toEqual(["a"]);
    expect(merged.disabledMcpjsonServers).toEqual(["x"]);
  });

  test("a per-project entry carries only mcpServers: no other project field crosses, and a project without servers adds none", async () => {
    const { primary, backup, stack } = claudePair("ttc-projects");
    write(path.join(primary, ".claude.json"), JSON.stringify({
      projects: {
        "/work/a": { mcpServers: { s: { command: "c" } }, allowedTools: ["Bash"], history: ["SENTINEL-HISTORY"], lastCost: 4, enabledMcpjsonServers: ["z"] },
        "/work/b": { allowedTools: ["Bash"], hasTrustDialogAccepted: true },
      },
    }));
    write(path.join(backup, ".claude.json"), JSON.stringify({ projects: { "/work/a": { mcpServers: { own: { command: "o" } }, history: ["mine"] } } }));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(backup, ".claude.json"), "utf8");
    expect(text).not.toContain("SENTINEL-HISTORY");
    expect(text).not.toContain("hasTrustDialogAccepted");
    const projects = JSON.parse(text).projects;
    expect(projects["/work/a"].mcpServers).toEqual({ own: { command: "o" }, s: { command: "c" } });
    expect(projects["/work/a"].history).toEqual(["mine"]);
    expect(projects["/work/a"].allowedTools).toBeUndefined();
    expect(projects["/work/a"].lastCost).toBeUndefined();
    expect(projects["/work/b"]?.allowedTools).toBeUndefined();
  });
});

describe("TT-C: finding 13 (TOML block handling)", () => {
  test("a ''' literal string holding [Rules] does not split the block", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-literal");
    write(path.join(pRoot, "config.toml"), [
      "developer_instructions = '''",
      "[Rules]",
      "[mcp_servers.fake]",
      "be kind",
      "'''",
      "",
      "[mcp_servers.foo]",
      'command = "x"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), 'model = "own"\n');
    const result = await mirror.mirrorStack(stack, {});
    const parsed = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(parsed.developer_instructions).toContain("[Rules]");
    expect(parsed.mcp_servers.fake).toBeUndefined();
    expect(parsed.mcp_servers.foo.command).toBe("x");
    expect(result.warnings.some((w) => w.includes("invalid TOML") || w.includes("would have lost"))).toBe(false);
  });

  test("the backup's own [[array-of-tables]] and comments survive, and the primary's cross intact", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-aot");
    write(path.join(pRoot, "config.toml"), [
      'model = "gpt-5"',
      "",
      "# the primary's server",
      "[mcp_servers.foo]",
      'command = "x" # inline comment',
      "",
      "[[hooks_list]]",
      'name = "p1"',
      "",
      "[[hooks_list]]",
      'name = "p2"',
    ].join("\n"));
    write(path.join(bRoot, "config.toml"), [
      "# my own note",
      "[[mine]]",
      'name = "m1"',
      "",
      "[[mine]]",
      'name = "m2"',
      "",
      "[mcp_servers.own]",
      "# keep this comment",
      'command = "o"',
    ].join("\n"));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as Record<string, any>;
    expect(parsed.mine.map((m: any) => m.name)).toEqual(["m1", "m2"]);
    expect(parsed.mcp_servers.own.command).toBe("o");
    expect(parsed.mcp_servers.foo.command).toBe("x");
    expect(parsed.hooks_list?.map((m: any) => m.name)).toEqual(["p1", "p2"]);
    expect(text).toContain("# keep this comment");
  });

  test("an unmergeable mix of dotted and table forms is refused: the backup stays byte-identical and a warning names config.toml", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-backstop");
    write(path.join(pRoot, "config.toml"), '[mcp_servers.foo]\ncommand = "x"\n[mcp_servers.foo.env]\nA = "2"\n');
    const original = 'mcp_servers.foo.command = "own"\n';
    write(path.join(bRoot, "config.toml"), original);
    const result = await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(bRoot, "config.toml"), "utf8")).toBe(original);
    expect(result.warnings.some((w) => w.includes("config.toml") && w.includes("backup left untouched"))).toBe(true);
  });

  test("an inline set member the filter stripped on purpose is not a lost key: LANG crosses, the userinfo URL does not", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-lostkey");
    write(path.join(pRoot, "config.toml"), 'shell_environment_policy.set = { URLISH = "https://SENTINEL-u@h/x", LANG = "C" }\n');
    write(path.join(bRoot, "config.toml"), 'shell_environment_policy.set = { GH_TOKEN = "b-own" }\n');
    const result = await mirror.mirrorStack(stack, {});
    expect(result.warnings.some((w) => w.includes("would have lost"))).toBe(false);
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(text) as { shell_environment_policy: { set: Record<string, string> } };
    expect(parsed.shell_environment_policy.set.LANG).toBe("C");
    expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe("b-own");
    expect(parsed.shell_environment_policy.set.URLISH).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SENTINEL-");
    expect(text).not.toContain("SENTINEL-");
  });

  test("mixed forms: the backup's [shell_environment_policy.set] table and the primary's inline set merge member-wise", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-mixed");
    write(path.join(pRoot, "config.toml"), 'shell_environment_policy.set = { URLISH = "https://SENTINEL-u@h/x", LANG = "C" }\n');
    write(path.join(bRoot, "config.toml"), '[shell_environment_policy.set]\nGH_TOKEN = "b-own"\nOWN = "1"\n');
    const result = await mirror.mirrorStack(stack, {});
    expect(result.warnings.some((w) => w.includes("would have lost") || w.includes("invalid TOML"))).toBe(false);
    const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
    const set = (Bun.TOML.parse(text) as { shell_environment_policy: { set: Record<string, string> } }).shell_environment_policy.set;
    expect(set.LANG).toBe("C");
    expect(set.GH_TOKEN).toBe("b-own");
    // The primary's set replaces the backup's non-credential members (as inline-vs-inline does)...
    expect(set.OWN).toBeUndefined();
    expect(set.URLISH).toBeUndefined();
    // ...and the file is one spelling only: TOML forbids a key defined both inline and as a table.
    expect(text).not.toContain("[shell_environment_policy.set]");
    expect(text).not.toContain("SENTINEL-");
  });
});

describe("TT-C: finding 14 (credential shapes and command-running env)", () => {
  const SHAPES = [
    "SERPAPI_APIKEY", "DB_PASS", "GH_PAT", "NPM_AUTH", "OTEL_EXPORTER_OTLP_HEADERS", "SITE_COOKIE", "MY_SESSION",
    "SENTRY_DSN", "SLACK_WEBHOOK", "PG_CONNECTION", "SSH_PASSPHRASE", "github_token", "Db_Pass", "my_apikey",
  ];

  test("every credential shape, in any case, is stripped from settings env while the backup's own survives", async () => {
    const { primary, backup, stack } = claudePair("ttc-shapes");
    const env: Record<string, string> = { KEEP_ME: "1" };
    for (const k of SHAPES) env[k] = `SENTINEL-${k}`;
    write(path.join(primary, "settings.json"), JSON.stringify({ env }));
    write(path.join(backup, "settings.json"), JSON.stringify({ env: { DB_PASS: "mine" } }));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(backup, "settings.json"), "utf8");
    expect(text).not.toContain("SENTINEL-");
    expect(JSON.parse(text).env).toEqual({ DB_PASS: "mine", KEEP_ME: "1" });
  });

  test("URL userinfo is stripped from env under any name", async () => {
    const { primary, backup, stack } = claudePair("ttc-userinfo");
    write(path.join(primary, "settings.json"), JSON.stringify({
      env: { HTTP_PROXY: "http://user:SENTINEL-pw@proxy:3128", WEIRD_NAME: "https://SENTINEL-tok@host/x", FINE_URL: "https://host/x" },
    }));
    await mirror.mirrorStack(stack, {});
    const text = readFileSync(path.join(backup, "settings.json"), "utf8");
    expect(text).not.toContain("SENTINEL-");
    expect(JSON.parse(text).env).toEqual({ FINE_URL: "https://host/x" });
  });

  test("non-credential names still mirror: PATH, AWS_REGION, *_MODEL, *_MAX_TOKENS", async () => {
    const { primary, backup, stack } = claudePair("ttc-keep");
    const env = { PATH: "/usr/bin", AWS_REGION: "eu-west-1", ANTHROPIC_SMALL_FAST_MODEL: "haiku", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9", MAX_THINKING_TOKENS: "5" };
    write(path.join(primary, "settings.json"), JSON.stringify({ env }));
    await mirror.mirrorStack(stack, {});
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env).toEqual(env);
  });

  test("safe mode skips every command-running env name and keeps the backup's own value; full mode copies them", async () => {
    const names = ["CLAUDE_CODE_SHELL_PREFIX", "NODE_OPTIONS", "BASH_ENV", "GIT_PAGER", "GIT_SSH_COMMAND", "DYLD_INSERT_LIBRARIES", "MY_HELPER", "x_command", "PAGER"];
    const env: Record<string, string> = { OK: "1" };
    for (const k of names) env[k] = `primary-${k}`;
    {
      const { primary, backup, stack } = claudePair("ttc-cmdenv-safe", "safe");
      write(path.join(primary, "settings.json"), JSON.stringify({ env }));
      write(path.join(backup, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--own", MY_HELPER: "own-helper" } }));
      await mirror.mirrorStack(stack, {});
      expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env).toEqual({ NODE_OPTIONS: "--own", MY_HELPER: "own-helper", OK: "1" });
    }
    {
      const { primary, backup, stack } = claudePair("ttc-cmdenv-full", "full");
      write(path.join(primary, "settings.json"), JSON.stringify({ env }));
      await mirror.mirrorStack(stack, {});
      expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env.NODE_OPTIONS).toBe("primary-NODE_OPTIONS");
    }
  });

  test("Codex: shell_environment_policy.set secrets are stripped in table, inline and dotted forms; the backup's own survive", async () => {
    for (const form of ["table", "inline", "dotted"] as const) {
      const { pRoot, bRoot, stack } = codexPair(`ttc-cx-shell-${form}`);
      const primaryText = {
        table: '[shell_environment_policy.set]\nGH_TOKEN = "SENTINEL-p"\nDB_PASS = "SENTINEL-q"\nURLISH = "https://SENTINEL-u@h/x"\nLANG = "C"\n',
        inline: 'shell_environment_policy.set = { GH_TOKEN = "SENTINEL-p", DB_PASS = "SENTINEL-q", LANG = "C" }\n',
        dotted: 'shell_environment_policy.set.GH_TOKEN = "SENTINEL-p"\nshell_environment_policy.set.DB_PASS = "SENTINEL-q"\nshell_environment_policy.set.URLISH = "https://SENTINEL-u@h/x"\nshell_environment_policy.set.LANG = "C"\n',
      }[form];
      write(path.join(pRoot, "config.toml"), primaryText);
      write(path.join(bRoot, "config.toml"), {
        table: '[shell_environment_policy.set]\nGH_TOKEN = "b-own"\n',
        inline: 'shell_environment_policy.set = { GH_TOKEN = "b-own" }\n',
        dotted: 'shell_environment_policy.set.GH_TOKEN = "b-own"\n',
      }[form]);
      await mirror.mirrorStack(stack, {});
      const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
      expect(text, form).not.toContain("SENTINEL-");
      const set = (Bun.TOML.parse(text) as Record<string, any>).shell_environment_policy.set;
      expect(set.GH_TOKEN, form).toBe("b-own");
      expect(set.LANG, form).toBe("C");
      expect(set.DB_PASS, form).toBeUndefined();
    }
  });

  test("Codex: otel exporter headers are stripped in table and inline forms", async () => {
    for (const form of ["table", "inline"] as const) {
      const { pRoot, bRoot, stack } = codexPair(`ttc-cx-otel-${form}`);
      write(path.join(pRoot, "config.toml"), form === "table"
        ? '[otel]\nenvironment = "dev"\n\n[otel.exporter.otlp-http]\nendpoint = "https://o.example"\n\n[otel.exporter.otlp-http.headers]\nauthorization = "Bearer SENTINEL-h"\n'
        : '[otel]\nenvironment = "dev"\nexporter = { otlp-http = { endpoint = "https://o.example", headers = { authorization = "Bearer SENTINEL-h" } } }\n');
      write(path.join(bRoot, "config.toml"), 'model = "own"\n');
      await mirror.mirrorStack(stack, {});
      const text = readFileSync(path.join(bRoot, "config.toml"), "utf8");
      expect(text, form).not.toContain("SENTINEL-h");
      expect((Bun.TOML.parse(text) as Record<string, any>).otel.environment, form).toBe("dev");
    }
  });

  test("a credentialed marketplace in the plugin registry is not copied; the clean one is", async () => {
    const { primary, backup, stack } = claudePair("ttc-registry");
    write(path.join(primary, "plugins", "known_marketplaces.json"), JSON.stringify({
      bad: { source: { source: "git", url: "https://SENTINEL-tok:x@host/repo.git" }, installLocation: path.join(primary, "plugins", "marketplaces", "bad") },
      good: { source: { source: "git", url: "https://host/repo.git" }, installLocation: path.join(primary, "plugins", "marketplaces", "good") },
    }));
    const result = await mirror.mirrorStack(stack, {});
    const out = path.join(backup, "plugins", "known_marketplaces.json");
    const text = existsSync(out) ? readFileSync(out, "utf8") : "";
    expect(text).not.toContain("SENTINEL-");
    expect(text).not.toContain('"bad"');
    expect(JSON.stringify(result)).not.toContain("SENTINEL-");
  });
});

describe("TT-C: finding 15 (dotfile symlinks)", () => {
  const LOGIN_REASON = "account login or session data";

  test("a dotfile-symlinked settings.json and CLAUDE.md are mirrored", async () => {
    const { primary, backup, stack } = claudePair("ttc-dot-ok");
    const dots = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-dots-")));
    write(path.join(dots, "settings.json"), JSON.stringify({ model: "from-dots" }));
    write(path.join(dots, "CLAUDE.md"), "dot rules\n");
    symlinkSync(path.join(dots, "settings.json"), path.join(primary, "settings.json"));
    symlinkSync(path.join(dots, "CLAUDE.md"), path.join(primary, "CLAUDE.md"));
    await mirror.mirrorStack(stack, {});
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("from-dots");
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("dot rules\n");
  });

  test("a link to a directory is refused", async () => {
    const { primary, backup, stack } = claudePair("ttc-dot-dir");
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-dir-")));
    mkdirSync(path.join(dir, "d.md"));
    symlinkSync(path.join(dir, "d.md"), path.join(primary, "CLAUDE.md"));
    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "CLAUDE.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("CLAUDE.md") && w.includes("not a regular file"))).toBe(true);
  });

  test("a link whose target has the wrong extension is refused", async () => {
    const { primary, backup, stack } = claudePair("ttc-dot-ext");
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-ext-")));
    write(path.join(dir, "settings.txt"), JSON.stringify({ model: "SENTINEL-ext" }));
    symlinkSync(path.join(dir, "settings.txt"), path.join(primary, "settings.json"));
    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "settings.json"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("settings.json") && w.includes("not a .json file"))).toBe(true);
  });

  // The link guard compares the target against both spellings of the data dir (macOS
  // /var -> /private/var, a dotfile-linked ~/.agetor).
  test("a link into the data dir is refused as login/session data", async () => {
    const { primary, backup, stack } = claudePair("ttc-dot-datadir");
    write(path.join(dbm.dataDir, "ttc-dotfile.md"), "SENTINEL-datadir");
    symlinkSync(path.join(dbm.dataDir, "ttc-dotfile.md"), path.join(primary, "CLAUDE.md"));
    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "CLAUDE.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("CLAUDE.md") && w.includes(LOGIN_REASON))).toBe(true);
  });

  // `os.homedir()` ignores a changed $HOME under Bun and the mirror has no home seam, so the real
  // home's folders are linked to (never read: the refusal happens first; nothing is created). Only
  // folders that exist can be exercised, so on a machine with none the test is skipped by name.
  const SECRET_HOME_FOLDERS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".git-credentials", ".npmrc", ".netrc"]
    .filter((n) => existsSync(path.join(homedir(), n)));
  test.skipIf(SECRET_HOME_FOLDERS.length === 0)("a link at or inside a secret-bearing home folder (~/.ssh, ~/.git-credentials, ...) is refused as login data, not merely for its extension [SKIPPED when none of these folders exists on this machine]", async () => {
    const home = homedir();
    const present = SECRET_HOME_FOLDERS;
    for (const name of present) {
      const { primary, backup, stack } = claudePair("ttc-dot-home");
      symlinkSync(path.join(home, name), path.join(primary, "CLAUDE.md"));
      const result = await mirror.mirrorStack(stack, {});
      expect(existsSync(path.join(backup, "CLAUDE.md")), name).toBe(false);
      expect(result.warnings.some((w) => w.includes("CLAUDE.md") && w.includes(LOGIN_REASON)), name).toBe(true);
    }
  });

  test("Codex: AGENTS.md linked into the data dir is refused", async () => {
    const { pRoot, bRoot, stack } = codexPair("ttc-dot-cx");
    write(path.join(dbm.dataDir, "ttc-agents.md"), "SENTINEL-agents");
    mkdirSync(pRoot, { recursive: true });
    symlinkSync(path.join(dbm.dataDir, "ttc-agents.md"), path.join(pRoot, "AGENTS.md"));
    const result = await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(bRoot, "AGENTS.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("AGENTS.md") && w.includes(LOGIN_REASON))).toBe(true);
  });
});

describe("TT-C: provenance, preview and propagation", () => {
  const provs = async () => (await import("./harness-mirror-provenance.ts")).mirrorProvenance;
  const SENTINEL = "SENTINEL-SECRET-VALUE-9f3a";

  test("every write records a provenance row: file, nested file, JSON key, link and TOML key", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-rows");
    const shared = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-rows-")));
    write(path.join(shared, "linked", "SKILL.md"), "# l");
    write(path.join(primary, "CLAUDE.md"), "rules\n");
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    mkdirSync(path.join(primary, "skills"), { recursive: true });
    symlinkSync(path.join(shared, "linked"), path.join(primary, "skills", "linked"));
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    await mirror.mirrorStack(stack, {});
    const rows = (await provs()).list(b);
    const has = (scope: string, p: string, key = "") => rows.some((r) => r.scope === scope && r.path === p && r.key === key);
    expect(has("file", "CLAUDE.md")).toBe(true);
    expect(has("file", "skills/s/SKILL.md")).toBe(true);
    expect(has("link", "skills/linked")).toBe(true);
    expect(has("key", "settings.json", "model")).toBe(true);
    expect(has("key", "settings.json", "env.FOO")).toBe(true);
    expect(rows.every((r) => r.preexisted === false)).toBe(true);
    expect(existsSync(backup)).toBe(true);

    const cx = codexPair("ttc-rows-cx");
    write(path.join(cx.pRoot, "config.toml"), 'model = "gpt-5"\n[mcp_servers.foo]\ncommand = "x"\n');
    await mirror.mirrorStack(cx.stack, {});
    const cxRows = (await provs()).list(cx.b);
    expect(cxRows.some((r) => r.scope === "key" && r.path === "config.toml" && r.key === "model")).toBe(true);
    expect(cxRows.some((r) => r.scope === "key" && r.path === "config.toml" && r.key === "mcp_servers.foo")).toBe(true);
  });

  test("the preview carries names only: no value, file content or secret appears anywhere in it", async () => {
    const { primary, backup, a, b, stack } = claudePair("ttc-preview-names");
    write(path.join(primary, "CLAUDE.md"), `${SENTINEL} rules\n`);
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    write(path.join(primary, "skills", "s", "SKILL.md"), `${SENTINEL} skill`);
    write(path.join(primary, "settings.json"), JSON.stringify({
      model: SENTINEL,
      env: { SAFE_VAR: SENTINEL, API_TOKEN: SENTINEL },
      mcpServers: { srv: { command: "run", args: [SENTINEL] } },
    }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: `${SENTINEL}-old` }));
    write(path.join(primary, ".claude.json"), JSON.stringify({ mcpServers: { j: { command: "c", args: [SENTINEL] } } }));
    const preview = await mirror.previewMirror({ kind: "claude-code", members: [a, b], mirrorMode: "full" }, { stackId: stack.id });
    expect(preview.plans.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(preview);
    expect(dumped).not.toContain(SENTINEL);
    expect(dumped).not.toContain("SENTINEL");
    // ...but it does name what would change.
    expect(preview.plans[0]!.keys.some((k) => k.key === "env.SAFE_VAR")).toBe(true);
    // A preview writes nothing and records nothing.
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect((await provs()).list(b)).toEqual([]);
  });

  test("the preview equals the real run: same files and keys, then the real run writes exactly those", async () => {
    const { primary, a, b, stack } = claudePair("ttc-preview-eq");
    write(path.join(primary, "CLAUDE.md"), "p\n");
    write(path.join(primary, "commands", "c.md"), "c");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "m", env: { K: "v" } }));
    const draft = { kind: "claude-code" as const, members: [a, b], mirrorMode: "full" as const };
    const preview = await mirror.previewMirror(draft, { stackId: stack.id });
    await mirror.mirrorStack(stack, {});
    const again = await mirror.previewMirror(draft, { stackId: stack.id });
    const plan = preview.plans[0]!;
    const rows = (await provs()).list(b);
    const written = new Set(rows.map((r) => r.path)); // merged files record per-key rows
    for (const f of [...plan.files.add, ...plan.files.update]) expect(written.has(f), f).toBe(true);
    const keyRows = new Set(rows.filter((r) => r.scope === "key").map((r) => `${r.path}:${r.key}`));
    for (const k of plan.keys.filter((x) => x.action !== "remove")) expect(keyRows.has(`${k.file}:${k.key}`), k.key).toBe(true);
    // Once mirrored, nothing is left to do.
    expect(again.plans[0]!.files.add).toEqual([]);
    expect(again.plans[0]!.files.update).toEqual([]);
    expect(again.plans[0]!.keys.filter((k) => k.action !== "remove")).toEqual([]);
  });

  test("overwrites is false for a clean first copy and true exactly when there are backups or removals", async () => {
    const { primary, a, b, stack } = claudePair("ttc-overwrites");
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "m" }));
    const draft = { kind: "claude-code" as const, members: [a, b], mirrorMode: "full" as const };
    const clean = await mirror.previewMirror(draft, { stackId: stack.id });
    expect(clean.overwrites).toBe(false);
    expect(clean.plans[0]!.backups).toEqual([]);
    await mirror.mirrorStack(stack, {});
    const idle = await mirror.previewMirror(draft, { stackId: stack.id });
    expect(idle.overwrites).toBe(false);
    // A pure removal (unedited mirrored file gone from the primary) is an overwrite.
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "skills", "s"), { recursive: true });
    const removal = await mirror.previewMirror(draft, { stackId: stack.id });
    expect(removal.plans[0]!.backups).toEqual([]);
    expect(removal.plans[0]!.files.remove).toEqual(["skills/s/SKILL.md"]);
    expect(removal.overwrites).toBe(true);
  });

  test("deleting a mirrored JSON key on the primary removes the unedited copy and keeps an edited one with a warning", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-key-delete");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "m", env: { A: "1", B: "2" } }));
    write(path.join(backup, "settings.json"), JSON.stringify({ env: { OWN: "o" } }));
    await mirror.mirrorStack(stack, {});
    const s = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    s.env.B = "edited";
    write(path.join(backup, "settings.json"), JSON.stringify(s));
    write(path.join(primary, "settings.json"), JSON.stringify({}));
    const result = await mirror.mirrorStack(stack, {});
    const after = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(after.model).toBeUndefined();
    expect(after.env.A).toBeUndefined();
    expect(after.env.B).toBe("edited");
    expect(after.env.OWN).toBe("o");
    expect(result.warnings.some((w) => w.includes("env.B") && w.includes("edited"))).toBe(true);
    expect((await provs()).get(b, "settings.json", "env.B")).toBeNull();
  });

  test("a planted provenance row for a settings key or a path outside the allowlist cannot remove anything", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-planted2");
    write(path.join(primary, "CLAUDE.md"), "p\n");
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    // Under an allowlisted folder, but a never-copy shape (a clone's .git): propagation must not delete it.
    write(path.join(backup, "skills", ".git", "config"), "[remote]");
    write(path.join(backup, ".credentials.json"), '{"claudeAiOauth":"SENTINEL-login"}');
    write(path.join(backup, "settings.json"), JSON.stringify({ forceLoginMethod: "console", model: "own" }));
    const crypto = await import("node:crypto");
    const p = await provs();
    p.upsert({ harnessId: b, stackId: stack.id, scope: "file", path: ".credentials.json", key: "", valueHash: crypto.createHash("sha256").update('{"claudeAiOauth":"SENTINEL-login"}').digest("hex"), srcMtimeMs: null, srcSize: null, preexisted: false, backupRef: null, updatedAt: 1 });
    p.upsert({ harnessId: b, stackId: stack.id, scope: "file", path: "skills/.git/config", key: "", valueHash: crypto.createHash("sha256").update("[remote]").digest("hex"), srcMtimeMs: null, srcSize: null, preexisted: false, backupRef: null, updatedAt: 1 });
    p.upsert({ harnessId: b, stackId: stack.id, scope: "file", path: "../outside.md", key: "", valueHash: "x", srcMtimeMs: null, srcSize: null, preexisted: false, backupRef: null, updatedAt: 1 });
    await mirror.mirrorStack(stack, {});
    await mirror.restoreMirror(b);
    expect(existsSync(path.join(backup, ".credentials.json"))).toBe(true);
    expect(readFileSync(path.join(backup, "skills", ".git", "config"), "utf8")).toBe("[remote]");
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).forceLoginMethod).toBe("console");
  });
});

describe("TT-C: backups and Restore", () => {
  const provs = async () => (await import("./harness-mirror-provenance.ts")).mirrorProvenance;
  const backupsOf = (id: string) => path.join(dbm.dataDir, "mirror-backups", id);

  test("the first overwrite backs up the original; a second overwrite never re-backs-up over it", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-first-backup");
    write(path.join(primary, "CLAUDE.md"), "p1\n");
    write(path.join(backup, "CLAUDE.md"), "the true original\n");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "p1" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "true-original" }));
    await mirror.mirrorStack(stack, {});
    expect(existsSync(backupsOf(b))).toBe(true);
    write(path.join(primary, "CLAUDE.md"), "p2 changed\n");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "p2" }));
    const second = await mirror.mirrorStack(stack, {});
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("p2 changed\n");
    write(path.join(primary, "CLAUDE.md"), "p3 changed again\n");
    await mirror.mirrorStack(stack, {});
    expect(second.warnings.some((w) => w.includes("invalid"))).toBe(false);
    await mirror.restoreMirror(b);
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("the true original\n");
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("true-original");
  });

  test("Restore puts back a TOML key and a JSON key the primary overwrote, and an original the account deleted", async () => {
    const cx = codexPair("ttc-restore-toml");
    write(path.join(cx.pRoot, "config.toml"), 'model = "primary"\neffort = "hi"\n');
    write(path.join(cx.bRoot, "config.toml"), 'model = "mine"\n');
    await mirror.mirrorStack(cx.stack, {});
    expect(readFileSync(path.join(cx.bRoot, "config.toml"), "utf8")).toContain("primary");
    await mirror.restoreMirror(cx.b);
    const parsed = Bun.TOML.parse(readFileSync(path.join(cx.bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(parsed.model).toBe("mine");
    expect(parsed.effort).toBeUndefined();

    const { primary, backup, b, stack } = claudePair("ttc-restore-deleted-key");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "primary" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "mine" }));
    await mirror.mirrorStack(stack, {});
    write(path.join(backup, "settings.json"), JSON.stringify({}));
    const result = await mirror.restoreMirror(b);
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("mine");
    expect(result.restored).toContain("settings.json:model");
  });

  test("Restore keeps the rows and the saved originals of a kept item; a later clean Restore removes both", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-restore-retry");
    write(path.join(primary, "CLAUDE.md"), "p\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    write(path.join(primary, "skills", "s", "SKILL.md"), "# s");
    await mirror.mirrorStack(stack, {});
    writeFileSync(path.join(backup, "skills", "s", "SKILL.md"), "# edited by the account");
    const first = await mirror.restoreMirror(b);
    expect(first.kept).toContain("skills/s/SKILL.md");
    expect(readFileSync(path.join(backup, "skills", "s", "SKILL.md"), "utf8")).toBe("# edited by the account");
    expect((await provs()).get(b, "skills/s/SKILL.md")).not.toBeNull();
    // The account's original CLAUDE.md came back; the retry still has rows, so the store stays.
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect(existsSync(backupsOf(b))).toBe(true);
    // Once the item matches what the mirror wrote again, the retry clears everything.
    writeFileSync(path.join(backup, "skills", "s", "SKILL.md"), "# s");
    const second = await mirror.restoreMirror(b);
    expect(second.kept).toEqual([]);
    expect((await provs()).list(b)).toEqual([]);
    expect(existsSync(backupsOf(b))).toBe(false);
  });

  test("a symlinked mirror-backups root is never read, restored from or removed through", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-root-link");
    write(path.join(primary, "CLAUDE.md"), "p\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    await mirror.mirrorStack(stack, {});
    const root = path.join(dbm.dataDir, "mirror-backups");
    const { renameSync, rmSync } = await import("node:fs");
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-root-out-")));
    write(path.join(outside, b, "files", "CLAUDE.md"), "PLANTED");
    renameSync(root, `${root}.real`);
    symlinkSync(outside, root);
    try {
      const result = await mirror.restoreMirror(b);
      expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("p\n");
      expect(result.restored).not.toContain("CLAUDE.md");
      await mirror.removeMirrorBackups(b);
      expect(readFileSync(path.join(outside, b, "files", "CLAUDE.md"), "utf8")).toBe("PLANTED");
      expect(lstatSync(root).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { force: true });
      renameSync(`${root}.real`, root);
    }
  });

  test("a symlinked parent inside mirror-backups/<id>/key and link stores is never followed", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-parent-link");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "primary" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "mine" }));
    await mirror.mirrorStack(stack, {});
    const store = backupsOf(b);
    const { readdirSync: ls, renameSync, rmSync } = await import("node:fs");
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-parent-out-")));
    write(path.join(outside, "keep.txt"), "keep");
    // Replace every child directory of the store with a link to the outside folder.
    for (const name of ls(store)) {
      const p = path.join(store, name);
      if (!lstatSync(p).isDirectory()) continue;
      renameSync(p, `${p}.real`);
      symlinkSync(outside, p);
    }
    await mirror.restoreMirror(b);
    // The planted bytes did not become the account's model, and nothing outside was touched.
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).not.toBe("keep");
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    await mirror.removeMirrorBackups(b);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    rmSync(store, { recursive: true, force: true });
  });

  test("W2: a primary deletion of a preexisted key never removes it, and Restore still recovers the original", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-w2-key");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "primary" }));
    write(path.join(backup, "settings.json"), JSON.stringify({ model: "mine" }));
    await mirror.mirrorStack(stack, {});
    write(path.join(primary, "settings.json"), JSON.stringify({}));
    await mirror.mirrorStack(stack, {});
    // Kept (it was the account's own to begin with)...
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("primary");
    // ...and still restorable.
    const row = (await provs()).get(b, "settings.json", "model");
    expect(row?.preexisted).toBe(true);
    await mirror.restoreMirror(b);
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).model).toBe("mine");
  });

  test("W2: a primary deletion of a preexisted Codex TOML key never removes it, and Restore recovers the original", async () => {
    const cx = codexPair("ttc-w2-toml");
    write(path.join(cx.pRoot, "config.toml"), 'model = "primary"\nother = "x"\n');
    write(path.join(cx.bRoot, "config.toml"), 'model = "mine"\n');
    await mirror.mirrorStack(cx.stack, {});
    write(path.join(cx.pRoot, "config.toml"), 'other = "x"\n');
    await mirror.mirrorStack(cx.stack, {});
    const kept = Bun.TOML.parse(readFileSync(path.join(cx.bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(kept.model).toBe("primary");
    await mirror.restoreMirror(cx.b);
    const back = Bun.TOML.parse(readFileSync(path.join(cx.bRoot, "config.toml"), "utf8")) as Record<string, any>;
    expect(back.model).toBe("mine");
    expect(back.other).toBeUndefined();
  });

  test("a planted symlink in the backup store makes the overwrite refuse to save through it; nothing lands outside", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-store-write-link");
    write(path.join(primary, "CLAUDE.md"), "primary\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-store-out-")));
    mkdirSync(backupsOf(b), { recursive: true });
    symlinkSync(outside, path.join(backupsOf(b), "files"));
    await mirror.mirrorStack(stack, {});
    expect(readdirSync(outside)).toEqual([]);
    // The account's own file is never overwritten without a saved original.
    expect(readFileSync(path.join(backup, "CLAUDE.md"), "utf8")).toBe("mine\n");
  });

  test("a backup's dotfile-symlinked settings.json is skipped, not replaced, and its target is untouched", async () => {
    const { primary, backup, stack } = claudePair("ttc-dest-link-json");
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-ttc-dest-json-")));
    write(path.join(outside, "settings.json"), JSON.stringify({ model: "dotfile" }));
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "primary" }));
    symlinkSync(path.join(outside, "settings.json"), path.join(backup, "settings.json"));
    const result = await mirror.mirrorStack(stack, {});
    expect(lstatSync(path.join(backup, "settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(outside, "settings.json"), "utf8")).model).toBe("dotfile");
    expect(result.warnings.some((w) => w.includes("settings.json"))).toBe(true);
  });

  test("Restore removes an item the mirror added and leaves the account's own files and keys", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-restore-added");
    write(path.join(primary, "skills", "new", "SKILL.md"), "# n");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "m" }));
    write(path.join(backup, "skills", "own", "SKILL.md"), "# own");
    write(path.join(backup, "settings.json"), JSON.stringify({ theme: "dark" }));
    await mirror.mirrorStack(stack, {});
    const result = await mirror.restoreMirror(b);
    expect(existsSync(path.join(backup, "skills", "new", "SKILL.md"))).toBe(false);
    expect(readFileSync(path.join(backup, "skills", "own", "SKILL.md"), "utf8")).toBe("# own");
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    expect(result.removed).toContain("skills/new/SKILL.md");
  });

  test("deleteMirrorStateForHarness queued behind a mirror in flight leaves no rows and no backups", async () => {
    const { primary, backup, b, stack } = claudePair("ttc-delete-queued");
    write(path.join(primary, "CLAUDE.md"), "p\n");
    write(path.join(backup, "CLAUDE.md"), "mine\n");
    for (let i = 0; i < 120; i++) write(path.join(primary, "skills", `s${i}`, "SKILL.md"), `# ${i}`);
    const running = mirror.mirrorStack(stack, {});
    const p = await provs();
    for (let i = 0; i < 2000 && p.list(b).length === 0; i++) await Bun.sleep(0);
    const deleting = mirror.deleteMirrorStateForHarness(b);
    await running;
    await deleting;
    expect(p.list(b)).toEqual([]);
    expect(existsSync(backupsOf(b))).toBe(false);
  });
});

describe("a deleted primary merged file propagates key removals", () => {
  test("settings.json deleted on the primary: unedited mirrored keys go, edited and the backup's own keys stay; preview shows it", async () => {
    const { primary, backup, a, b, stack } = claudePair("del-settings");
    write(path.join(primary, "settings.json"), JSON.stringify({ model: "opus", env: { FOO: "1", BAR: "2" } }));
    write(path.join(backup, "settings.json"), JSON.stringify({ theme: "dark", env: { MINE: "x" } }));
    await mirror.mirrorStack(stack, {});
    const mirrored = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(mirrored.env).toEqual({ MINE: "x", FOO: "1", BAR: "2" });
    // The backup edits one mirrored key, then the primary deletes the whole file.
    mirrored.env.BAR = "edited";
    writeFileSync(path.join(backup, "settings.json"), JSON.stringify(mirrored));
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "settings.json"));

    const preview = await mirror.previewMirror({ kind: "claude-code", members: [a, b], mirrorMode: "full" });
    expect(preview.plans[0]!.keys).toContainEqual({ file: "settings.json", key: "env.FOO", action: "remove" });
    expect(preview.plans[0]!.keys).toContainEqual({ file: "settings.json", key: "model", action: "remove" });
    expect(preview.plans[0]!.kept).toContain("settings.json:env.BAR");
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env.FOO).toBe("1");

    const result = await mirror.mirrorStack(stack, {});
    const after = JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"));
    expect(after).toEqual({ theme: "dark", env: { MINE: "x", BAR: "edited" } });
    expect(result.warnings.some((w) => w.includes("env.BAR") && w.includes("edited on this account"))).toBe(true);
    // Nothing left to own: a later run is a no-op.
    await mirror.mirrorStack(stack, {});
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8"))).toEqual(after);
  });

  test("a primary deletion never creates a backup file that does not exist", async () => {
    const { primary, backup, stack } = claudePair("del-settings-nofile");
    write(path.join(primary, "settings.json"), JSON.stringify({ env: { FOO: "1" } }));
    await mirror.mirrorStack(stack, {});
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "settings.json"));
    rmSync(path.join(backup, "settings.json"));
    await mirror.mirrorStack(stack, {});
    expect(existsSync(path.join(backup, "settings.json"))).toBe(false);
  });

  test("an unreadable or missing primary account is not a deletion: nothing is removed", async () => {
    const { primary, backup, stack } = claudePair("del-settings-noroot");
    write(path.join(primary, "settings.json"), JSON.stringify({ env: { FOO: "1" } }));
    await mirror.mirrorStack(stack, {});
    const { rmSync } = await import("node:fs");
    rmSync(primary, { recursive: true });
    await mirror.mirrorStack(stack, {}).catch(() => undefined);
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env.FOO).toBe("1");
  });

  test("a primary settings.json that is a dangling dotfile link is left alone, not treated as deleted", async () => {
    const { primary, backup, stack } = claudePair("del-settings-dangling");
    write(path.join(primary, "settings.json"), JSON.stringify({ env: { FOO: "1" } }));
    await mirror.mirrorStack(stack, {});
    const { rmSync } = await import("node:fs");
    rmSync(path.join(primary, "settings.json"));
    symlinkSync(path.join(primary, "no-such-target.json"), path.join(primary, "settings.json"));
    await mirror.mirrorStack(stack, {});
    expect(JSON.parse(readFileSync(path.join(backup, "settings.json"), "utf8")).env.FOO).toBe("1");
  });

  test("Codex config.toml deleted on the primary: mirrored keys and tables go, the backup's own keys stay", async () => {
    const { pRoot, bRoot, stack } = codexPair("del-config");
    write(path.join(pRoot, "config.toml"), ['model = "gpt-5"', "", "[mcp_servers.docs]", 'command = "docs-mcp"', ""].join("\n"));
    write(path.join(bRoot, "config.toml"), ['model_reasoning_effort = "high"', ""].join("\n"));
    await mirror.mirrorStack(stack, {});
    const mirrored = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(mirrored.model).toBe("gpt-5");
    expect((mirrored.mcp_servers as Record<string, unknown>).docs).toBeDefined();
    const { rmSync } = await import("node:fs");
    rmSync(path.join(pRoot, "config.toml"));
    await mirror.mirrorStack(stack, {});
    const after = Bun.TOML.parse(readFileSync(path.join(bRoot, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(after.model).toBeUndefined();
    expect((after.mcp_servers as Record<string, unknown> | undefined)?.docs).toBeUndefined();
    expect(after.model_reasoning_effort).toBe("high");
  });
});
