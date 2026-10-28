import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// commands.ts -> worktree.ts -> db.ts opens sqlite at module load, so the data
// dir must be set before the dynamic imports (same pattern as commands.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-commands-copilot-db-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { listAgentCapabilities, listAvailableCommands } = await import("./commands.ts");
const { userLevelSkills } = await import("./bundle.ts");

let tmpRoot: string;
let home: string; // fake HOME (for ~/.agents/skills), passed via harnessEnv.HOME
let copilotDir: string; // fake $COPILOT_HOME, passed as harnessHome

function git(args: string[], cwd: string): void {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
}

function write(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function skill(root: string, dir: string, name: string, description: string) {
  write(root, `${dir}/${name}/SKILL.md`, `---\ndescription: ${description}\n---\nbody`);
}

/** A fresh git repo with the full copilot project surface committed. */
function makeRepo(label: string): string {
  const repo = mkdtempSync(path.join(tmpRoot, `${label}-`));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  skill(repo, ".github/skills", "gh-skill-zq", "from .github");
  skill(repo, ".agents/skills", "agents-skill-zq", "from .agents");
  skill(repo, ".claude/skills", "claude-skill-zq", "from .claude");
  write(repo, ".mcp.json", JSON.stringify({ mcpServers: { "root-mcp-zq": { command: "node" } } }));
  write(repo, ".github/mcp.json", JSON.stringify({ servers: { "gh-servers-zq": { url: "https://example.com/mcp" } } }));
  write(repo, ".github/agents/reviewer-zq.agent.md", "---\nname: fancy-reviewer-zq\ndescription: Reviews code\n---\nbody");
  write(repo, ".github/agents/plain-zq.agent.md", "Plain agent body line");
  write(repo, ".github/agents/old-zq.md", "---\ndescription: legacy name\n---\nbody");
  // Names that would not survive the `@` tokenizer as one token.
  write(repo, ".github/agents/spaced-zq.agent.md", "---\nname: Spaced Name\n---\nbody");
  write(repo, ".github/agents/trail-zq.agent.md", "---\nname: Trail.\n---\nbody");
  write(repo, ".github/agents/two words zq.agent.md", "---\nname: Two Words\n---\nbody");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agetor-cmds-copilot-"));
  home = mkdtempSync(path.join(tmpRoot, "home-"));
  copilotDir = mkdtempSync(path.join(tmpRoot, "copilot-home-"));
  skill(copilotDir, "skills", "user-skill-zq", "user copilot skill");
  skill(copilotDir, "skills", "shared-zq", "from user");
  skill(home, ".agents/skills", "home-agents-zq", "from ~/.agents");
  write(copilotDir, "mcp-config.json", JSON.stringify({ mcpServers: { "user-mcp-zq": { command: "uvx" } } }));
  write(copilotDir, "agents/user-agent-zq.agent.md", "---\nname: user-agent-named-zq\ndescription: mine\n---\nbody");
  write(copilotDir, "agents/shared-agent-zq.md", "---\ndescription: from user\n---\nbody");
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  rmTestDataDir(DATA_DIR);
});

const caps = (workdir: string | null, branch?: string | null) =>
  listAgentCapabilities({
    agent: "copilot",
    workdir,
    branch,
    harnessHome: copilotDir,
    harnessEnv: { HOME: home },
  });

describe("copilot capability discovery (live disk)", () => {
  test("user + project skills, no builtins", async () => {
    const repo = makeRepo("live-skills");
    const { commands } = await caps(repo);
    const byName = new Map(commands.map((c) => [c.name, c]));
    expect(byName.get("/user-skill-zq")?.source).toBe("user");
    expect(byName.get("/home-agents-zq")?.source).toBe("user");
    expect(byName.get("/gh-skill-zq")?.source).toBe("project");
    expect(byName.get("/agents-skill-zq")?.source).toBe("project");
    expect(byName.get("/claude-skill-zq")?.source).toBe("project");
    expect(commands.some((c) => c.source === "builtin")).toBe(false);
    expect(commands.every((c) => c.kind === "skill")).toBe(true);
  });

  test("project skill overrides a same-named user skill", async () => {
    const repo = makeRepo("override");
    skill(repo, ".github/skills", "shared-zq", "from project");
    const all = await listAvailableCommands({
      agent: "copilot",
      workdir: repo,
      harnessHome: copilotDir,
      harnessEnv: { HOME: home },
    });
    const shared = all.find((c) => c.name === "/shared-zq");
    expect(shared?.source).toBe("project");
    expect(shared?.description).toBe("from project");
  });

  test("MCP from user config and all project files (mcpServers + servers)", async () => {
    const repo = makeRepo("mcp");
    const { extensions } = await caps(repo);
    const by = new Map(extensions.filter((e) => e.kind === "mcp").map((e) => [e.name, e]));
    expect(by.get("user-mcp-zq")).toMatchObject({ source: "user", insert: "@user-mcp-zq" });
    expect(by.get("root-mcp-zq")?.source).toBe("project");
    expect(by.get("gh-servers-zq")).toMatchObject({ source: "project", description: "http · example.com" });
  });

  test(".github/mcp.json also accepts mcpServers", async () => {
    const repo = makeRepo("mcp-key");
    write(repo, ".github/mcp.json", JSON.stringify({ mcpServers: { "gh-mcpservers-zq": { command: "x" } } }));
    const { extensions } = await caps(repo);
    expect(extensions.some((e) => e.kind === "mcp" && e.name === "gh-mcpservers-zq")).toBe(true);
  });

  test("custom agents: frontmatter name, filename fallback, @ insert", async () => {
    const repo = makeRepo("agents");
    const { extensions } = await caps(repo);
    const agents = new Map(extensions.filter((e) => e.kind === "agent").map((e) => [e.name, e]));
    expect(agents.get("fancy-reviewer-zq")).toMatchObject({
      source: "project",
      insert: "@fancy-reviewer-zq",
      description: "Reviews code",
    });
    expect(agents.has("plain-zq")).toBe(true); // `.agent.md` stripped
    expect(agents.has("old-zq")).toBe(true); // `.md` stripped
    expect(agents.get("user-agent-named-zq")?.source).toBe("user");
    expect(agents.get("shared-agent-zq")?.source).toBe("user");
  });

  test("custom agents: a name the @ tokenizer would split falls back to the filename stem, else is skipped", async () => {
    const repo = makeRepo("agent-names");
    const { extensions } = await caps(repo);
    const agents = extensions.filter((e) => e.kind === "agent");
    const names = agents.map((e) => e.name);
    expect(names).toContain("spaced-zq"); // "Spaced Name" has whitespace
    expect(names).toContain("trail-zq"); // "Trail." would lose its trailing "."
    expect(names).not.toContain("Spaced Name");
    expect(names).not.toContain("Trail.");
    // Neither the frontmatter name nor the stem is one token → not offered.
    expect(names.some((n) => /two\s*words/i.test(n))).toBe(false);
    for (const a of agents) expect(a.insert).toBe(`@${a.name}`);
  });

  test("project agent overrides a same-named user agent", async () => {
    const repo = makeRepo("agent-override");
    write(repo, ".github/agents/shared-agent-zq.agent.md", "---\ndescription: from project\n---\nbody");
    const { extensions } = await caps(repo);
    const shared = extensions.find((e) => e.kind === "agent" && e.name === "shared-agent-zq");
    expect(shared).toMatchObject({ source: "project", description: "from project" });
  });

  test("the agent kind sorts after mcp, skill and plugin", async () => {
    const repo = makeRepo("order");
    const { extensions } = await caps(repo);
    const rank = { mcp: 0, skill: 1, plugin: 2, agent: 3 } as const;
    const ranks = extensions.map((e) => rank[e.kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const kinds = extensions.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("agent");
    expect(kinds).toContain("mcp");
    expect(kinds).toContain("skill");
  });

  test("COPILOT_HOME from the harness env map wins over harness.home", async () => {
    const other = mkdtempSync(path.join(tmpRoot, "other-copilot-"));
    skill(other, "skills", "other-home-zq", "other");
    const { commands } = await listAgentCapabilities({
      agent: "copilot",
      workdir: null,
      harnessHome: copilotDir,
      harnessEnv: { HOME: home, COPILOT_HOME: other },
    });
    expect(commands.some((c) => c.name === "/other-home-zq")).toBe(true);
    expect(commands.some((c) => c.name === "/user-skill-zq")).toBe(false);
  });

  test("no workdir yields user entries only", async () => {
    const { commands, extensions } = await caps(null);
    expect(commands.map((c) => c.source)).not.toContain("project");
    expect(extensions.map((e) => e.source)).not.toContain("project");
    expect(extensions.some((e) => e.kind === "agent" && e.name === "user-agent-named-zq")).toBe(true);
  });
});

describe("copilot capability discovery (git ref)", () => {
  test("reads committed .github entries, ignoring a differing working tree", async () => {
    const repo = makeRepo("ref");
    // Diverge the working tree from the committed ref.
    rmSync(path.join(repo, ".github"), { recursive: true, force: true });
    skill(repo, ".github/skills", "uncommitted-zq", "only on disk");
    write(repo, ".github/mcp.json", JSON.stringify({ servers: { "disk-only-zq": { command: "x" } } }));
    write(repo, ".github/agents/disk-only-zq.agent.md", "disk only");

    const { commands, extensions } = await caps(repo, "main");
    expect(commands.find((c) => c.name === "/gh-skill-zq")?.source).toBe("project");
    expect(commands.find((c) => c.name === "/agents-skill-zq")?.source).toBe("project");
    expect(commands.find((c) => c.name === "/claude-skill-zq")?.source).toBe("project");
    expect(commands.some((c) => c.name === "/uncommitted-zq")).toBe(false);

    const mcp = extensions.filter((e) => e.kind === "mcp").map((e) => e.name);
    expect(mcp).toContain("root-mcp-zq");
    expect(mcp).toContain("gh-servers-zq");
    expect(mcp).not.toContain("disk-only-zq");

    const agents = extensions.filter((e) => e.kind === "agent").map((e) => e.name);
    expect(agents).toEqual(expect.arrayContaining(["fancy-reviewer-zq", "plain-zq", "old-zq"]));
    expect(agents).not.toContain("disk-only-zq");
    // user-level rows still come from disk
    expect(agents).toContain("user-agent-named-zq");
  });

  test("project overrides user at a ref", async () => {
    const repo = makeRepo("ref-override");
    skill(repo, ".github/skills", "shared-zq", "from ref");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "more"], repo);
    const { commands } = await caps(repo, "main");
    const shared = commands.find((c) => c.name === "/shared-zq");
    expect(shared).toMatchObject({ source: "project", description: "from ref" });
  });

  test("an unknown ref yields no project rows", async () => {
    const repo = makeRepo("ref-unknown");
    const { commands, extensions } = await caps(repo, "no-such-ref");
    expect(commands.some((c) => c.source === "project")).toBe(false);
    expect(extensions.some((e) => e.source === "project")).toBe(false);
  });
});

describe("userLevelSkills (bundle import)", () => {
  const harness = (over: Partial<Harness> = {}): Harness =>
    ({
      id: "copilot",
      kind: "copilot",
      label: "GitHub Copilot",
      home: copilotDir,
      bin: null,
      env: { HOME: home },
      enabled: true,
      ...over,
    }) as Harness;

  test("copilot harnesses report their user-level skills", async () => {
    const skills = await userLevelSkills(harness());
    expect(skills).not.toBeNull();
    expect(skills).toEqual(expect.arrayContaining(["user-skill-zq", "home-agents-zq", "shared-zq"]));
  });

  test("gemini and antigravity still report null", async () => {
    expect(await userLevelSkills(harness({ id: "gemini", kind: "gemini" }))).toBeNull();
    expect(await userLevelSkills(harness({ id: "antigravity", kind: "antigravity" }))).toBeNull();
  });
});
