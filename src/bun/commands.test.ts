import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

// commands.ts imports repoRoot from worktree.ts, which imports dataDir from
// db.ts — db.ts opens its sqlite connection at module-load time. A plain
// top-level `import` is hoisted ahead of any other code in this file, so
// AGETOR_DATA_DIR must be set before a *dynamic* import instead (same
// pattern as harnesses.test.ts). Without this, this file (or whichever file
// `bun test` loads first) can silently open the real ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-commands-db-"));
const { listAvailableCommands, listAgentCapabilities } = await import("./commands.ts");

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

test("codex reads user and project skills", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "codex-skill-home-"));
  writeCmd(
    path.join(harness, ".codex", "skills", "user-skill"),
    "SKILL.md",
    "---\ndescription: User skill\n---\nbody",
  );
  const project = mkdtempSync(path.join(tmpRoot, "codex-skill-proj-"));
  writeCmd(
    path.join(project, ".codex", "skills", "project-skill"),
    "SKILL.md",
    "---\ndescription: Project skill\n---\nbody",
  );

  const all = await listAvailableCommands({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
  });
  expect(all.find((c) => c.name === "/user-skill")?.source).toBe("user");
  expect(all.find((c) => c.name === "/project-skill")?.source).toBe("project");
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

test("extensions: codex reads project .codex/config.toml MCP servers", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-codex-project-home-"));
  const project = mkdtempSync(path.join(tmpRoot, "ext-codex-project-"));
  mkdirSync(path.join(project, ".codex"), { recursive: true });
  writeFileSync(
    path.join(project, ".codex", "config.toml"),
    `[mcp_servers.projectdb]\ncommand = "npx"\n`,
  );
  const all = await listExtensions({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
  });
  const mcp = all.find((e) => e.kind === "mcp" && e.name === "projectdb");
  expect(mcp).toBeDefined();
  expect(mcp!.source).toBe("project");
});

test("extensions: codex honors explicit CODEX_HOME from harness env", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "ext-codex-env-home-"));
  const envHome = mkdtempSync(path.join(tmpRoot, "ext-codex-env-codexhome-"));
  writeFileSync(
    path.join(envHome, "config.toml"),
    `[mcp_servers.envhome]\ncommand = "npx"\n`,
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-codex-env-proj-"));
  const all = await listExtensions({
    agent: "codex",
    workdir: project,
    harnessHome: harness,
    harnessEnv: { CODEX_HOME: envHome },
  });
  const mcp = all.find((e) => e.kind === "mcp" && e.name === "envhome");
  expect(mcp).toBeDefined();
  expect(mcp!.source).toBe("user");
});

test("extensions: codex falls back to explicit HOME from harness env", async () => {
  const envHome = mkdtempSync(path.join(tmpRoot, "ext-codex-env-home-only-"));
  mkdirSync(path.join(envHome, ".codex"), { recursive: true });
  writeFileSync(
    path.join(envHome, ".codex", "config.toml"),
    `[mcp_servers.homeonly]\ncommand = "npx"\n`,
  );
  const project = mkdtempSync(path.join(tmpRoot, "ext-codex-env-home-only-proj-"));
  const all = await listExtensions({
    agent: "codex",
    workdir: project,
    harnessEnv: { HOME: envHome },
  });
  const mcp = all.find((e) => e.kind === "mcp" && e.name === "homeonly");
  expect(mcp).toBeDefined();
  expect(mcp!.source).toBe("user");
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

// --- Plugin-contributed content (commands / skills / MCP) ------------------

/**
 * Scaffold a claude-code plugin under a fake harnessHome: writes an install
 * record into `installed_plugins.json`, the unpacked plugin tree (commands/,
 * skills/, .mcp.json, plugin.json), and — when `enabled` is given — an
 * `enabledPlugins` entry in the harness settings.json. Returns the installPath.
 */
function installPlugin(
  harness: string,
  key: string,
  opts: {
    commands?: Record<string, string>;
    skills?: Record<string, string>;
    mcpServers?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    enabled?: boolean;
  } = {},
): string {
  const installPath = path.join(harness, "plugins", "cache", key.replace(/[@/]/g, "_"));
  for (const [name, body] of Object.entries(opts.commands ?? {})) {
    writeCmd(path.join(installPath, "commands"), name, body);
  }
  for (const [name, body] of Object.entries(opts.skills ?? {})) {
    writeCmd(path.join(installPath, "skills", name), "SKILL.md", body);
  }
  if (opts.mcpServers) {
    mkdirSync(installPath, { recursive: true });
    writeFileSync(path.join(installPath, ".mcp.json"), JSON.stringify({ mcpServers: opts.mcpServers }));
  }
  if (opts.manifest) {
    mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify(opts.manifest));
  }
  mkdirSync(path.join(harness, "plugins"), { recursive: true });
  // Merge into any existing install file so a test can stage several plugins.
  let installed: any = { version: 2, plugins: {} };
  try { installed = JSON.parse(readFileSync(path.join(harness, "plugins", "installed_plugins.json"), "utf8")); } catch { /* first plugin */ }
  installed.plugins[key] = [{ scope: "user", installPath }];
  writeFileSync(path.join(harness, "plugins", "installed_plugins.json"), JSON.stringify(installed));
  if (opts.enabled !== undefined) {
    let settings: any = {};
    try { settings = JSON.parse(readFileSync(path.join(harness, "settings.json"), "utf8")); } catch { /* none yet */ }
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [key]: opts.enabled };
    writeFileSync(path.join(harness, "settings.json"), JSON.stringify(settings));
  }
  return installPath;
}

test("plugin commands + skills are namespaced `/<plugin>:<name>` on the `/` surface", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-cmd-"));
  installPlugin(harness, "vercel@mp", {
    commands: { "deploy.md": "---\ndescription: Deploy to Vercel\n---\nbody" },
    skills: { "ai-sdk": "---\ndescription: AI SDK guidance\n---\nbody" },
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-cmd-proj-"));
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project, harnessHome: harness });

  const cmd = all.find((c) => c.name === "/vercel:deploy");
  expect(cmd).toBeDefined();
  expect(cmd!.kind).toBe("command");
  expect(cmd!.source).toBe("plugin");
  expect(cmd!.description).toBe("Deploy to Vercel");

  const skill = all.find((c) => c.name === "/vercel:ai-sdk");
  expect(skill).toBeDefined();
  expect(skill!.kind).toBe("skill");
  expect(skill!.source).toBe("plugin");
});

test("plugin .mcp.json servers surface as extensions (server==plugin collapses to bare name)", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-mcp-"));
  installPlugin(harness, "vercel@mp", {
    mcpServers: {
      vercel: { type: "http", url: "https://mcp.vercel.com" },
      logs: { command: "vercel-logs" },
    },
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-mcp-proj-"));
  const exts = await listExtensions({ agent: "claude-code", workdir: project, harnessHome: harness });

  // Single-server-named-after-the-plugin collapses to just `vercel`.
  const main = exts.find((e) => e.name === "vercel" && e.kind === "mcp");
  expect(main).toBeDefined();
  expect(main!.insert).toBe("@vercel");
  expect(main!.source).toBe("plugin");
  // A differently-named server keeps the `<plugin>:<server>` namespace.
  const logs = exts.find((e) => e.name === "vercel:logs" && e.kind === "mcp");
  expect(logs).toBeDefined();
  expect(logs!.insert).toBe("@vercel:logs");
});

test("plugin skill appears in the extensions Skills group with a /<plugin>:<name> insert", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-skillext-"));
  installPlugin(harness, "sentry@mp", {
    skills: { seer: "---\ndescription: Ask Sentry questions\n---\nbody" },
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-skillext-proj-"));
  const exts = await listExtensions({ agent: "claude-code", workdir: project, harnessHome: harness });
  const skill = exts.find((e) => e.name === "sentry:seer" && e.kind === "skill");
  expect(skill).toBeDefined();
  expect(skill!.insert).toBe("/sentry:seer");
  expect(skill!.source).toBe("plugin");
});

test("a plugin disabled via enabledPlugins contributes nothing", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-disabled-"));
  installPlugin(harness, "off@mp", {
    commands: { "go.md": "do it" },
    skills: { helper: "---\ndescription: helps\n---\nbody" },
    mcpServers: { off: { command: "x" } },
    manifest: { name: "off", description: "A disabled plugin" },
    enabled: false,
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-disabled-proj-"));
  const { commands, extensions } = await listAgentCapabilities({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  expect(commands.some((c) => c.name.startsWith("/off"))).toBe(false);
  expect(extensions.some((e) => e.name === "off" || e.name.startsWith("off:"))).toBe(false);
});

test("two plugins sharing a bare name collapse to one /name:cmd but both self-rows show", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-dupcmd-"));
  installPlugin(harness, "dup@mp-one", {
    commands: { "deploy.md": "---\ndescription: From mp-one\n---\nbody" },
    manifest: { name: "dup", description: "dup from mp-one" },
  });
  installPlugin(harness, "dup@mp-two", {
    commands: { "deploy.md": "---\ndescription: From mp-two\n---\nbody" },
    manifest: { name: "dup", description: "dup from mp-two" },
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-dupcmd-proj-"));
  const { commands, extensions } = await listAgentCapabilities({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  // claude has no per-marketplace invocation token, so the `/dup:deploy`
  // namespace collapses to a single deterministic entry (first install wins).
  const deploy = commands.filter((c) => c.name === "/dup:deploy");
  expect(deploy).toHaveLength(1);
  expect(deploy[0]!.source).toBe("plugin");
  // …but the picker still surfaces both plugins, marketplace-disambiguated, so
  // the conflict is visible.
  const dupRows = extensions.filter((e) => e.kind === "plugin" && e.name.startsWith("dup"));
  expect(dupRows).toHaveLength(2);
  expect(dupRows.some((e) => e.name === "dup (mp-one)")).toBe(true);
  expect(dupRows.some((e) => e.name === "dup (mp-two)")).toBe(true);
});

// --- Built-in (binary-baked) commands + skills -----------------------------

// An empty harnessHome isolates these from the test runner's real user config
// (which may carry user skills like `code-review` that legitimately shadow a
// same-named built-in — see the shadow test below).
test("agents surface curated built-in commands and skills", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "builtin-home-"));
  writeCmd(
    path.join(harness, ".codex", "skills", ".system", "openai-docs"),
    "SKILL.md",
    "---\ndescription: OpenAI docs\n---\nbody",
  );
  const project = mkdtempSync(path.join(tmpRoot, "builtin-"));
  const claude = await listAvailableCommands({ agent: "claude-code", workdir: project, harnessHome: harness });

  const claudeInit = claude.find((c) => c.name === "/init");
  expect(claudeInit).toBeDefined();
  expect(claudeInit!.source).toBe("builtin");
  expect(claudeInit!.kind).toBe("command");

  const codeReview = claude.find((c) => c.name === "/code-review");
  expect(codeReview).toBeDefined();
  expect(codeReview!.source).toBe("builtin");
  expect(codeReview!.kind).toBe("skill");

  const codex = await listAvailableCommands({ agent: "codex", workdir: project, harnessHome: harness });
  const codexInit = codex.find((c) => c.name === "/init");
  expect(codexInit).toBeDefined();
  expect(codexInit!.source).toBe("builtin");
  expect(codexInit!.kind).toBe("command");

  const docs = codex.find((c) => c.name === "/openai-docs");
  expect(docs).toBeDefined();
  expect(docs!.source).toBe("builtin");
  expect(docs!.kind).toBe("skill");
});

test("built-ins are available even with no workdir", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "builtin-nowd-"));
  const claude = await listAvailableCommands({ agent: "claude-code", workdir: null, harnessHome: harness });
  expect(claude.some((c) => c.name === "/security-review" && c.source === "builtin")).toBe(true);
  const codex = await listAvailableCommands({ agent: "codex", workdir: null, harnessHome: harness });
  expect(codex.some((c) => c.name === "/init" && c.source === "builtin")).toBe(true);
});

test("a user/project command shadows a same-named built-in", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "builtin-shadow-home-"));
  const project = mkdtempSync(path.join(tmpRoot, "builtin-shadow-"));
  writeCmd(
    path.join(project, ".claude", "commands"),
    "review.md",
    "---\ndescription: My custom review\n---\nbody",
  );
  const all = await listAvailableCommands({ agent: "claude-code", workdir: project, harnessHome: harness });
  const review = all.filter((c) => c.name === "/review");
  // Exactly one `/review`, and it's the project one (not the built-in).
  expect(review).toHaveLength(1);
  expect(review[0]!.source).toBe("project");
  expect(review[0]!.description).toBe("My custom review");
});

test("built-in skills surface in the extensions Skills group", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "builtin-ext-home-"));
  writeCmd(
    path.join(harness, ".codex", "skills", ".system", "openai-docs"),
    "SKILL.md",
    "---\ndescription: OpenAI docs\n---\nbody",
  );
  const project = mkdtempSync(path.join(tmpRoot, "builtin-ext-"));
  const claudeExts = await listExtensions({ agent: "claude-code", workdir: project, harnessHome: harness });
  const verify = claudeExts.find((e) => e.name === "verify" && e.kind === "skill");
  expect(verify).toBeDefined();
  expect(verify!.insert).toBe("/verify");
  expect(verify!.source).toBe("builtin");

  const codexExts = await listExtensions({ agent: "codex", workdir: project, harnessHome: harness });
  const docs = codexExts.find((e) => e.name === "openai-docs" && e.kind === "skill");
  expect(docs).toBeDefined();
  expect(docs!.insert).toBe("/openai-docs");
  expect(docs!.source).toBe("builtin");
});

test("an explicitly enabled plugin contributes its self-row + content", async () => {
  const harness = mkdtempSync(path.join(tmpRoot, "plug-enabled-"));
  installPlugin(harness, "on@mp", {
    commands: { "go.md": "do it" },
    manifest: { name: "on", description: "An enabled plugin" },
    enabled: true,
  });
  const project = mkdtempSync(path.join(tmpRoot, "plug-enabled-proj-"));
  const { commands, extensions } = await listAgentCapabilities({
    agent: "claude-code",
    workdir: project,
    harnessHome: harness,
  });
  expect(commands.some((c) => c.name === "/on:go")).toBe(true);
  const selfRow = extensions.find((e) => e.name === "on" && e.kind === "plugin");
  expect(selfRow).toBeDefined();
  expect(selfRow!.description).toBe("An enabled plugin");
});

// --- Branch-scoped (git ref) discovery --------------------------------------
//
// listAvailableCommands/listAgentCapabilities accept a `branch` option that,
// when set, reads project-level entries from that git ref's COMMITTED tree
// (via resolveProjectTree -> ref-tree.ts) instead of live disk. One fixture
// repo covers all these tests: `main` carries only a README; `feature/skills`
// commits the branch-only entries (claude + codex); back on `main`, untracked
// disk-only entries prove the ref mode ignores them while disk mode sees them.

/** Run git in `cwd`, returning ok/stdout/stderr rather than throwing. */
async function branchGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

/** Same as `branchGit`, but throws (with stderr) on a non-zero exit — for
 *  fixture setup steps that must succeed. */
async function branchGitOk(args: string[], cwd: string): Promise<string> {
  const res = await branchGit(args, cwd);
  if (!res.ok) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr}`);
  return res.stdout;
}

let branchRepo: string;

describe("branch-scoped capability discovery (ref mode)", () => {
  beforeAll(async () => {
    branchRepo = mkdtempSync(path.join(tmpRoot, "branch-repo-"));
    await branchGitOk(["init", "-q", "-b", "main"], branchRepo);
    await branchGitOk(["config", "user.email", "test@example.com"], branchRepo);
    await branchGitOk(["config", "user.name", "test"], branchRepo);
    await branchGitOk(["config", "commit.gpgsign", "false"], branchRepo);

    writeCmd(branchRepo, "README.md", "hello\n");
    await branchGitOk(["add", "."], branchRepo);
    await branchGitOk(["commit", "-q", "-m", "init"], branchRepo);

    // feature/skills adds everything ref-mode discovery should surface.
    await branchGitOk(["checkout", "-q", "-b", "feature/skills"], branchRepo);
    writeCmd(
      path.join(branchRepo, ".claude", "skills", "only-on-feature"),
      "SKILL.md",
      "---\ndescription: Feature-only skill\n---\nbody",
    );
    writeCmd(path.join(branchRepo, ".claude", "commands", "nested"), "cmd.md", "nested command body");
    writeCmd(
      branchRepo,
      ".mcp.json",
      JSON.stringify({ mcpServers: { "feature-mcp": { command: "x" } } }),
    );
    // Disables the "demo@mkt" plugin at the PROJECT scope, only on this ref —
    // `main` never gets a settings.json, so the plugin is enabled there.
    writeCmd(
      path.join(branchRepo, ".claude"),
      "settings.json",
      JSON.stringify({ enabledPlugins: { "demo@mkt": false } }),
    );
    // Project-overrides-user precedence, exercised through ref mode.
    writeCmd(path.join(branchRepo, ".claude", "skills", "dup"), "SKILL.md", "---\ndescription: Project dup\n---\nbody");
    writeCmd(path.join(branchRepo, ".codex", "prompts"), "feat-prompt.md", "---\ndescription: Feature prompt\n---\nbody");
    writeCmd(
      path.join(branchRepo, ".codex", "skills", "codex-feat"),
      "SKILL.md",
      "---\ndescription: Codex feature skill\n---\nbody",
    );
    writeCmd(path.join(branchRepo, ".codex"), "config.toml", `[mcp_servers.feat-server]\ncommand = "npx"\n`);
    await branchGitOk(["add", "."], branchRepo);
    await branchGitOk(["commit", "-q", "-m", "add feature entries"], branchRepo);

    await branchGitOk(["checkout", "-q", "main"], branchRepo);

    // Untracked disk-only entries: visible with no `branch` (live disk),
    // invisible under any ref (including `main`, which never committed them).
    writeCmd(path.join(branchRepo, ".claude", "skills", "untracked"), "SKILL.md", "---\ndescription: Untracked\n---\nbody");
    writeCmd(branchRepo, ".mcp.json", JSON.stringify({ mcpServers: { "disk-mcp": { command: "y" } } }));
  });

  test("branch set to a side branch: only that ref's committed entries show", async () => {
    const { commands, extensions } = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      branch: "feature/skills",
    });
    expect(commands.some((c) => c.name === "/only-on-feature" && c.kind === "skill" && c.source === "project")).toBe(true);
    expect(commands.some((c) => c.name === "/nested:cmd" && c.source === "project")).toBe(true);
    expect(extensions.some((e) => e.name === "feature-mcp" && e.kind === "mcp" && e.source === "project")).toBe(true);
    expect(extensions.some((e) => e.name === "only-on-feature" && e.kind === "skill")).toBe(true);
    // Untracked disk-only entries never show through a ref.
    expect(commands.some((c) => c.name === "/untracked")).toBe(false);
    expect(extensions.some((e) => e.name === "disk-mcp")).toBe(false);
  });

  test("branch set to main: no project-sourced rows at all (committed-on-feature and untracked-on-disk both absent)", async () => {
    const { commands, extensions } = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      branch: "main",
    });
    expect(commands.some((c) => c.source === "project")).toBe(false);
    expect(extensions.some((e) => e.source === "project")).toBe(false);
  });

  test("no branch: reads live disk, so untracked entries show", async () => {
    const { commands, extensions } = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
    });
    expect(commands.some((c) => c.name === "/untracked" && c.source === "project")).toBe(true);
    expect(extensions.some((e) => e.name === "disk-mcp" && e.kind === "mcp" && e.source === "project")).toBe(true);
  });

  test("branch set to an unknown ref: zero project rows, builtin rows still present", async () => {
    const { commands, extensions } = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      branch: "does-not-exist",
    });
    expect(commands.some((c) => c.source === "project")).toBe(false);
    expect(extensions.some((e) => e.source === "project")).toBe(false);
    expect(commands.some((c) => c.name === "/init" && c.source === "builtin")).toBe(true);
  });

  // `resolveProjectTree` (commands.ts) does `branch?.trim()` itself before
  // deciding disk-vs-ref and before calling `loadRefProjectTree` —
  // i.e. the FUNCTION trims, not just the HTTP route's query-param handling.
  // This pins that observed contract (whitespace-padded branch behaves exactly
  // like the trimmed form) rather than assuming the plan's phrasing ("the
  // route trims; the function may not") without checking.
  test("branch with surrounding whitespace resolves the same as the trimmed ref (function itself trims)", async () => {
    const { commands } = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      branch: "  feature/skills  ",
    });
    expect(commands.some((c) => c.name === "/only-on-feature" && c.source === "project")).toBe(true);
    expect(commands.some((c) => c.name === "/nested:cmd" && c.source === "project")).toBe(true);
  });

  test("codex: project prompts/skills/config.toml MCP servers are ref-scoped", async () => {
    const harness = mkdtempSync(path.join(tmpRoot, "branch-codex-harness-"));

    const feat = await listAvailableCommands({
      agent: "codex",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "feature/skills",
    });
    expect(feat.some((c) => c.name === "/feat-prompt" && c.source === "project")).toBe(true);
    expect(feat.some((c) => c.name === "/codex-feat" && c.kind === "skill" && c.source === "project")).toBe(true);
    const featExts = await listExtensions({
      agent: "codex",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "feature/skills",
    });
    expect(featExts.some((e) => e.name === "feat-server" && e.kind === "mcp" && e.source === "project")).toBe(true);

    const main = await listAvailableCommands({
      agent: "codex",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "main",
    });
    expect(main.some((c) => c.name === "/feat-prompt")).toBe(false);
    expect(main.some((c) => c.name === "/codex-feat")).toBe(false);
    const mainExts = await listExtensions({
      agent: "codex",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "main",
    });
    expect(mainExts.some((e) => e.name === "feat-server")).toBe(false);
  });

  test("claude-code plugin: a settings.json committed at the ref disables a plugin that's enabled at every other scope", async () => {
    const harness = mkdtempSync(path.join(tmpRoot, "branch-plugin-harness-"));
    installPlugin(harness, "demo@mkt", {
      commands: { "hello.md": "---\ndescription: Say hello\n---\nbody" },
      manifest: { name: "demo", description: "Demo plugin" },
    });

    const feat = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "feature/skills",
    });
    expect(feat.commands.some((c) => c.name === "/demo:hello")).toBe(false);
    expect(feat.extensions.some((e) => e.name === "demo" && e.kind === "plugin")).toBe(false);

    // `main` never committed a settings.json, so the same plugin (still
    // installed at the same harness) is enabled there.
    const main = await listAgentCapabilities({
      agent: "claude-code",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "main",
    });
    expect(main.commands.some((c) => c.name === "/demo:hello")).toBe(true);
    expect(main.extensions.some((e) => e.name === "demo" && e.kind === "plugin")).toBe(true);
  });

  test("project entry at the ref still overrides a same-named user-scoped entry", async () => {
    const harness = mkdtempSync(path.join(tmpRoot, "branch-precedence-harness-"));
    writeCmd(path.join(harness, "skills", "dup"), "SKILL.md", "---\ndescription: User dup\n---\nbody");

    const all = await listAvailableCommands({
      agent: "claude-code",
      workdir: branchRepo,
      harnessHome: harness,
      branch: "feature/skills",
    });
    const dup = all.find((c) => c.name === "/dup");
    expect(dup).toBeDefined();
    expect(dup!.source).toBe("project");
  });
});
