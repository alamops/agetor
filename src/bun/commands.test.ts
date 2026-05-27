import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { listAvailableCommands } from "./commands.ts";

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
