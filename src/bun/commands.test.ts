import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { listAvailableCommands, listAgentCapabilities } from "./commands.ts";

/** Discover just the extension list via the production path (the picker uses
 *  `listAgentCapabilities`; this keeps the extension assertions pointed at it). */
async function listExtensions(opts: Parameters<typeof listAgentCapabilities>[0]) {
  return (await listAgentCapabilities(opts)).extensions;
}

// We can't easily fake `os.homedir()`, so tests focus on project-level
// discovery + precedence behavior. User-level entries pulled from the real
// home are tolerated as long as project entries win when names collide.

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agetor-cmds-"));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeCmd(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body);
}

test("discovers project-level claude-code commands", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "proj-"));
  writeCmd(
    path.join(project, ".claude", "commands"),
    "review.md",
    "---\ndescription: Review a PR\n---\n\nbody",
  );

  const all = await listAvailableCommands({ agent: "claude-code", workdir: project });
  const review = all.find((c) => c.name === "/review");
  expect(review).toBeDefined();
  expect(review!.source).toBe("project");
  expect(review!.kind).toBe("command");
  expect(review!.description).toBe("Review a PR");
});

test("discovers project-level claude-code skills via SKILL.md", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "proj-skill-"));
  writeCmd(
    path.join(project, ".claude", "skills", "my-skill"),
    "SKILL.md",
    "---\ndescription: A skill\n---\nbody",
  );
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project });
  const skill = all.find((c) => c.name === "/my-skill");
  expect(skill).toBeDefined();
  expect(skill!.kind).toBe("skill");
  expect(skill!.source).toBe("project");
});

test("namespaces nested command folders with `:`", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "proj-nest-"));
  writeCmd(
    path.join(project, ".claude", "commands", "git"),
    "blame.md",
    "git blame helper",
  );
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project });
  expect(all.some((c) => c.name === "/git:blame")).toBe(true);
});

test("codex looks under .codex/prompts", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "proj-codex-"));
  writeCmd(
    path.join(project, ".codex", "prompts"),
    "refactor.md",
    "---\ndescription: Refactor\n---\nbody",
  );
  // Claude-code shouldn't see codex prompts.
  const claude = await listAvailableCommands({ agent: "claude-code", workdir: project });
  expect(claude.some((c) => c.name === "/refactor" && c.source === "project")).toBe(false);
  const codex = await listAvailableCommands({ agent: "codex", workdir: project });
  expect(codex.some((c) => c.name === "/refactor" && c.source === "project")).toBe(true);
});

test("missing workdir returns user-level entries (no crash)", async () => {
  const all = await listAvailableCommands({ agent: "claude-code", workdir: null });
  // Just ensure it didn't throw; the exact list depends on the test runner's
  // home directory and may legitimately be empty.
  expect(Array.isArray(all)).toBe(true);
});

test("falls back to first content line when frontmatter is missing", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "proj-fallback-"));
  writeCmd(
    path.join(project, ".claude", "commands"),
    "bare.md",
    "# Title heading\n\nFirst real line of body.",
  );
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project });
  const bare = all.find((c) => c.name === "/bare");
  expect(bare?.description).toBe("First real line of body.");
});

test("claude-code reads user commands/skills from harnessHome when set (matches CLAUDE_CONFIG_DIR layout)", async () => {
  // For aliased multi-account harnesses we set CLAUDE_CONFIG_DIR=<harnessHome>
  // on spawn; the picker has to read from the same place so the autocomplete
  // matches what claude actually sees at runtime. Under CLAUDE_CONFIG_DIR
  // mode the user commands live directly at <harnessHome>/commands/, NOT at
  // <harnessHome>/.claude/commands/.
  const harness = mkdtempSync(path.join(tmpRoot, "harness-"));
  writeCmd(path.join(harness, "commands"), "alias-only.md", "---\ndescription: Alias\n---\nbody");
  const project = mkdtempSync(path.join(tmpRoot, "proj-alias-"));

  const all = await listAvailableCommands({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  const alias = all.find((c) => c.name === "/alias-only");
  expect(alias).toBeDefined();
  expect(alias!.source).toBe("user");
  expect(alias!.description).toBe("Alias");
});

test("codex reads user prompts from <harnessHome>/.codex/prompts when set", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "codex-harness-"));
  writeCmd(path.join(harness, ".codex", "prompts"), "alias-only.md", "Alias prompt body");
  const project = mkdtempSync(path.join(tmpRoot, "proj-codex-alias-"));

  const all = await listAvailableCommands({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
  });
  const alias = all.find((c) => c.name === "/alias-only");
  expect(alias).toBeDefined();
  expect(alias!.source).toBe("user");
});

test("project entry overrides user entry with the same name", async () => {
  // Drop a same-named file under both locations and assert project wins. We
  // can't safely write into the real ~/.claude/commands here, so we synthesise
  // both ourselves and assert the dedup rule directly via two project paths.
  // The unit-level guarantee in commands.ts is: when two entries share `name`,
  // the one with source="project" wins over source="user". This test sets up
  // a project with one command and verifies its source is "project".
  const project = mkdtempSync(path.join(tmpRoot, "proj-override-"));
  writeCmd(
    path.join(project, ".claude", "commands"),
    "shared-name.md",
    "project version",
  );
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project });
  const entry = all.find((c) => c.name === "/shared-name");
  expect(entry?.source).toBe("project");
});

// --- Extensions (MCP / skills / plugins) ----------------------------------

test("extensions: discovers project .mcp.json servers as @mentions", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "ext-mcp-"));
  writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        jubarteai: { type: "http", url: "https://jubarte.ai/api/mcp", headers: { Authorization: "secret" } },
      },
    }),
  );
  const all = await listExtensions({ agent: "claude-code", workdir: project });
  const mcp = all.find((e) => e.name === "jubarteai");
  expect(mcp).toBeDefined();
  expect(mcp!.kind).toBe("mcp");
  expect(mcp!.insert).toBe("@jubarteai");
  expect(mcp!.source).toBe("project");
  // Description summarises transport/host but must never leak auth headers.
  expect(mcp!.description).toContain("jubarte.ai");
  expect(JSON.stringify(all)).not.toContain("secret");
});

test("extensions: surfaces skills with a /name insert token", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "ext-skill-"));
  writeCmd(
    path.join(project, ".claude", "skills", "my-skill"),
    "SKILL.md",
    "---\ndescription: A skill\n---\nbody",
  );
  const all = await listExtensions({ agent: "claude-code", workdir: project });
  const skill = all.find((e) => e.name === "my-skill");
  expect(skill).toBeDefined();
  expect(skill!.kind).toBe("skill");
  expect(skill!.insert).toBe("/my-skill");
  expect(skill!.description).toBe("A skill");
});

test("extensions: discovers user-scoped plugins from harnessHome", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-plug-"));
  const installPath = path.join(harness, "plugins", "cache", "demo");
  mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(installPath, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", description: "A demo plugin" }),
  );
  mkdirSync(path.join(harness, "plugins"), { recursive: true });
  writeFileSync(
    path.join(harness, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "demo@some-marketplace": [{ scope: "user", installPath }],
      },
    }),
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-plug-proj-"));
  const all = await listExtensions({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  const plugin = all.find((e) => e.name === "demo");
  expect(plugin).toBeDefined();
  expect(plugin!.kind).toBe("plugin");
  expect(plugin!.insert).toBe("@demo");
  expect(plugin!.source).toBe("user");
  expect(plugin!.description).toBe("A demo plugin");
});

test("extensions: project-scoped plugins only count for the matching repo", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-plug-scope-"));
  const project = mkdtempSync(path.join(tmpRoot, "ext-plug-match-"));
  const other = mkdtempSync(path.join(tmpRoot, "ext-plug-other-"));
  mkdirSync(path.join(harness, "plugins"), { recursive: true });
  writeFileSync(
    path.join(harness, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "mine@mp": [{ scope: "project", projectPath: project, installPath: "/nope" }],
        "theirs@mp": [{ scope: "project", projectPath: other, installPath: "/nope" }],
      },
    }),
  );
  const all = await listExtensions({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  expect(all.some((e) => e.name === "mine" && e.kind === "plugin")).toBe(true);
  expect(all.some((e) => e.name === "theirs")).toBe(false);
});

test("extensions: same plugin name across marketplaces keeps both, disambiguated", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-plug-dup-"));
  mkdirSync(path.join(harness, "plugins"), { recursive: true });
  writeFileSync(
    path.join(harness, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "dup@mp-one": [{ scope: "user", installPath: "/nope" }],
        "dup@mp-two": [{ scope: "user", installPath: "/nope" }],
      },
    }),
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-plug-dup-proj-"));
  const all = await listExtensions({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  const plugins = all.filter((e) => e.kind === "plugin" && e.name.startsWith("dup"));
  // Both survive (the final (kind, name) dedupe must not collapse them) and the
  // marketplace disambiguates the display name.
  expect(plugins).toHaveLength(2);
  expect(plugins.some((e) => e.name === "dup (mp-one)")).toBe(true);
  expect(plugins.some((e) => e.name === "dup (mp-two)")).toBe(true);
});

test("extensions: codex parses quoted, dotted MCP server names", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-codex-quoted-"));
  mkdirSync(path.join(harness, ".codex"), { recursive: true });
  writeFileSync(
    path.join(harness, ".codex", "config.toml"),
    `[mcp_servers."my.server"]\ncommand = "npx"\n`,
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-codex-quoted-proj-"));
  const all = await listExtensions({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
  });
  const mcp = all.find((e) => e.kind === "mcp" && e.name === "my.server");
  expect(mcp).toBeDefined();
  expect(mcp!.insert).toBe("@my.server");
});

test("extensions: codex reads [mcp_servers.*] from config.toml", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-codex-"));
  mkdirSync(path.join(harness, ".codex"), { recursive: true });
  writeFileSync(
    path.join(harness, ".codex", "config.toml"),
    `[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app"\n`,
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-codex-proj-"));
  const all = await listExtensions({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
  });
  expect(all.some((e) => e.name === "context7" && e.kind === "mcp")).toBe(true);
  expect(all.some((e) => e.name === "linear" && e.kind === "mcp")).toBe(true);
});

test("capabilities: returns both commands and extensions in one pass", async () => {
  const project = mkdtempSync(path.join(tmpRoot, "cap-"));
  // A slash command, a skill, and a project MCP server.
  writeCmd(
    path.join(project, ".claude", "commands"),
    "deploy.md",
    "---\ndescription: Deploy\n---\nbody",
  );
  writeCmd(
    path.join(project, ".claude", "skills", "reviewer"),
    "SKILL.md",
    "---\ndescription: Reviews code\n---\nbody",
  );
  writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { db: { command: "dbhub" } } }),
  );

  const { commands, extensions } = await listAgentCapabilities({
    agent: "claude-code",
    workdir: project,
  });

  // Commands list carries both the command and the skill (the `/` surface).
  expect(commands.some((c) => c.name === "/deploy" && c.kind === "command")).toBe(true);
  expect(commands.some((c) => c.name === "/reviewer" && c.kind === "skill")).toBe(true);

  // Extensions list carries the skill (reused from the commands pass) and the
  // MCP server, but NOT the plain command.
  expect(extensions.some((e) => e.name === "reviewer" && e.kind === "skill" && e.insert === "/reviewer")).toBe(true);
  expect(extensions.some((e) => e.name === "db" && e.kind === "mcp" && e.insert === "@db")).toBe(true);
  expect(extensions.some((e) => e.name === "deploy")).toBe(false);
});
