import { homedir } from "node:os";
import path from "node:path";
import type { AgentKind } from "../shared/types.ts";
import {
  discoveryFs,
  markdownTree,
  safeParseJson,
  singleFile,
  skillsDir,
  type DiscoveryReader,
  type DiscoverySelector,
} from "./discovery-fs.ts";
import { diskProjectTree, emptyProjectTree, loadRefProjectTree, type ProjectTree } from "./ref-tree.ts";
import { repoRoot } from "./worktree.ts";

// `safeReadJsonCached` lives in discovery-fs.ts (the in-process half of the
// discovery filesystem seam); re-exported for `harness-discovery.ts`.
export { safeReadJsonCached } from "./discovery-fs.ts";

/**
 * Where an entry comes from, for UI badging and dedupe precedence:
 *  - `user`    — the user's global config (`~/.claude`, harnessHome, …)
 *  - `project` — the workdir's repo (`.claude/…`); wins over `user` on a name clash
 *  - `plugin`  — contributed by an enabled plugin (namespaced `<plugin>:<name>`)
 *  - `builtin` — baked into the harness binary; only ever fills a gap (a same-named
 *    user/project/plugin entry always shadows it, matching the CLI)
 */
export type EntrySource = "user" | "project" | "plugin" | "builtin";

/**
 * A single slash-invokable entry surfaced to the new-task prompt autocomplete.
 *
 * `name` includes the leading `/` so the UI can drop it into the textarea
 * verbatim. `source` lets the UI badge user-level vs project-level entries
 * (project wins on duplicate names — same precedence the CLIs use at runtime).
 */
export interface AvailableCommand {
  name: string;
  description: string;
  source: EntrySource;
  kind: "command" | "skill";
}

/**
 * A non-command extension the user can reference from the prompt: an MCP
 * server, a skill, or an installed plugin. Surfaced by the "Extensions" picker
 * that sits above the prompt / message field (distinct from the `/` slash
 * autocomplete, which only covers slash-invokable commands + skills).
 *
 * `insert` is the literal token dropped into the textarea at the caret:
 *  - skills    → `/name`  (slash-invokable, same as the autocomplete)
 *  - mcp / plugin → `@name` (a mention nudging the agent to use it; MCP servers
 *    and plugins aren't slash-invokable, so the mention is the lightest-weight
 *    way to point the agent at them).
 */
export interface AvailableExtension {
  name: string;
  insert: string;
  description: string;
  source: EntrySource;
  kind: "mcp" | "skill" | "plugin";
}

/**
 * Pull a short description for an entry. Prefers a YAML `description:` field in
 * the frontmatter (the convention both Claude Code commands and skills use),
 * then falls back to the first non-blank, non-heading line.
 */
function readMdSummary(text: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const desc = /^description:\s*(.+)$/m.exec(fm[1]!);
    if (desc) return desc[1]!.trim().replace(/^["']|["']$/g, "");
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("---")) continue;
    return line.slice(0, 200);
  }
  return "";
}

/**
 * Walk a commands directory (`relDir`, root-relative to `tree`), treating
 * nested folders as `parent:child` namespaces (the convention both Claude
 * Code and `bunx claudeup`-style tooling adopt). Reads through a
 * `ProjectTree` rather than the filesystem directly so the exact same walk
 * serves live disk, a git ref, or a plugin's install dir.
 */
function discoverCommands(tree: ProjectTree, relDir: string, source: EntrySource): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  const walk = (curRel: string, prefix: string) => {
    for (const entry of tree.list(curRel)) {
      const p = curRel ? `${curRel}/${entry.name}` : entry.name;
      if (entry.isDir) {
        walk(p, prefix + entry.name + ":");
      } else if (entry.name.endsWith(".md")) {
        const cmdName = prefix + entry.name.slice(0, -3);
        out.push({
          name: "/" + cmdName,
          description: readMdSummary(tree.read(p) ?? ""),
          source,
          kind: "command",
        });
      }
    }
  };
  walk(relDir, "");
  return out;
}

/**
 * A "skill" is a folder under `skills/` containing a SKILL.md file. The folder
 * name is the slash-invokable name.
 *
 * Gates on `tree.read(...) != null`, not on the file merely existing: a
 * `SKILL.md` that exists but can't be produced as text (unreadable due to
 * permissions, or a directory named `SKILL.md`) is now omitted entirely
 * rather than listed with an empty description — an intentional behavior
 * change from the pre-`ProjectTree` walk. `ProjectTree` has no separate
 * "exists" notion distinct from "read successfully" (see `list`/`read` on
 * the interface), and a skill agetor can't describe isn't one worth
 * offering in the autocomplete.
 */
function discoverSkills(tree: ProjectTree, relDir: string, source: EntrySource): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const entry of tree.list(relDir)) {
    if (!entry.isDir) continue;
    const text = tree.read(`${relDir}/${entry.name}/SKILL.md`);
    if (text == null) continue;
    out.push({
      name: "/" + entry.name,
      description: readMdSummary(text),
      source,
      kind: "skill",
    });
  }
  return out;
}

/**
 * Curated snapshot of binary-baked built-in commands + skills.
 * These have NO on-disk discovery surface (no manifest, no `--list` flag), so
 * enumerating them means hand-maintaining the set worth dropping into a task
 * prompt. Kept deliberately tight: actionable coding-workflow entries only,
 * not interactive/TUI meta (`/clear`, `/compact`, `/config`, `/model`,
 * `/settings`, `/help`, …), which make no sense as a task.
 */
const CLAUDE_BUILTINS: ReadonlyArray<{ name: string; description: string; kind: "command" | "skill" }> = [
  { name: "/init", description: "Initialize a new CLAUDE.md file with codebase documentation", kind: "command" },
  { name: "/review", description: "Review a pull request", kind: "command" },
  { name: "/security-review", description: "Complete a security review of the pending changes on the current branch", kind: "command" },
  { name: "/code-review", description: "Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups", kind: "skill" },
  { name: "/simplify", description: "Review the changed code for reuse, simplification, and efficiency, then apply the fixes", kind: "skill" },
  { name: "/verify", description: "Verify a change works by running the app and observing real behavior", kind: "skill" },
  { name: "/run", description: "Launch and drive this project's app to confirm a change works", kind: "skill" },
];

const CODEX_BUILTINS: ReadonlyArray<{ name: string; description: string; kind: "command" | "skill" }> = [
  { name: "/init", description: "Create an AGENTS.md file with project-specific guidance for Codex", kind: "command" },
  { name: "/review", description: "Review current changes and find issues", kind: "command" },
];

// cursor-agent's slash-command surface is unverified against a real binary
// (no `--list` flag, no docs page enumerating built-ins as of this writing).
// v1 ships zero curated built-ins rather than guess wrong; revisit once
// `mapCursorEvent` has been live-verified against a real cursor-agent run
// (see plan open question 8).
const CURSOR_BUILTINS: ReadonlyArray<{ name: string; description: string; kind: "command" | "skill" }> = [];

/** The harness's built-in commands/skills as AvailableCommand rows. */
function builtinCommands(agent: AgentKind): AvailableCommand[] {
  let builtins: ReadonlyArray<{ name: string; description: string; kind: "command" | "skill" }>;
  switch (agent) {
    case "claude-code":
      builtins = CLAUDE_BUILTINS;
      break;
    case "codex":
      builtins = CODEX_BUILTINS;
      break;
    case "cursor":
      builtins = CURSOR_BUILTINS;
      break;
    default:
      builtins = [];
  }
  return builtins.map((b) => ({ name: b.name, description: b.description, source: "builtin", kind: b.kind }));
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

function codexHome(opts: { harnessHome?: string | null; harnessEnv?: Record<string, string> | null }): string {
  if (opts.harnessEnv?.CODEX_HOME) return opts.harnessEnv.CODEX_HOME;
  if (opts.harnessHome) return path.join(opts.harnessHome, ".codex");
  if (opts.harnessEnv?.HOME) return path.join(opts.harnessEnv.HOME, ".codex");
  return defaultCodexHome();
}

function codexSystemSkills(home: string, reader: DiscoveryReader): AvailableCommand[] {
  const primary = discoverSkills(reader.tree(home), "skills/.system", "builtin");
  if (primary.length > 0 || home === defaultCodexHome()) return primary;
  return discoverSkills(reader.tree(defaultCodexHome()), "skills/.system", "builtin");
}

/**
 * Root-relative paths capability discovery ever reads at a git ref, as
 * glob-equivalent regexes. Kept tight (rather than reading every `.claude`/
 * `.codex` file `loadRefProjectTree`'s default pathspecs would list) so a
 * ref checkout never pulls in unrelated project files — mirrors exactly
 * what `listAvailableCommands`/`readEnabledPlugins`/
 * `discoverMcpAndPluginExtensions` read from disk today. The list is the
 * union across kinds, so a claude or codex ref read may also fetch a
 * cursor/fx `SKILL.md` it will not surface.
 */
const CAPABILITY_READ_PATTERNS: RegExp[] = [
  /^\.claude\/commands\/.+\.md$/,
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/settings\.local\.json$/,
  /^\.mcp\.json$/,
  /^\.codex\/prompts\/.+\.md$/,
  /^\.codex\/skills\/[^/]+\/SKILL\.md$/,
  /^\.codex\/config\.toml$/,
  // cursor / fx project skills: one-level SKILL.md only. Cursor MCP is the
  // one extra file under `.cursor/` — same `mcpServers` object as `.mcp.json`.
  /^\.cursor\/mcp\.json$/,
  /^\.cursor\/skills\/[^/]+\/SKILL\.md$/,
  /^\.agents\/skills\/[^/]+\/SKILL\.md$/,
  /^\.grok\/skills\/[^/]+\/SKILL\.md$/,
  /^\.fx\/skills\/[^/]+\/SKILL\.md$/,
  /^\.opencode\/skills\/[^/]+\/SKILL\.md$/,
  /^\.claw\/skills\/[^/]+\/SKILL\.md$/,
  /^skills\/[^/]+\/SKILL\.md$/,
];

const CURSOR_USER_SKILL_DIRS = [".cursor/skills", ".claude/skills", ".codex/skills", ".grok/skills", ".agents/skills"];
const FX_USER_SKILL_DIRS = [".fx/skills", ".config/opencode/skills", ".codex/skills", ".claude/skills", ".agents/skills", ".claw/skills"];
const FX_PROJECT_SKILL_DIRS = [".fx/skills", "skills", ".opencode/skills", ".codex/skills", ".claude/skills", ".agents/skills", ".claw/skills"];

/** HOME for cursor/fx. An explicit harness-env HOME wins, matching spawn
 *  (`harnessEnv` writes HOME from `harness.home` and then lets the env map
 *  overwrite it). Else the harness home, else the process home. */
function homeForHomeKinds(opts: { harnessHome?: string | null; harnessEnv?: Record<string, string> | null }): string {
  return opts.harnessEnv?.HOME || opts.harnessHome || homedir();
}

function isDiscoveredCapabilityPath(relPath: string): boolean {
  return CAPABILITY_READ_PATTERNS.some((re) => re.test(relPath));
}

/**
 * Loads the live-disk project tree for `root` somewhere other than the core
 * process (`callerProjectTree` for a CLI-token caller). `shouldRead(rel)` says
 * which files' content discovery actually parses.
 */
export type ProjectTreeLoader = (root: string, shouldRead: (rel: string) => boolean) => Promise<ProjectTree>;

/**
 * Resolve the `ProjectTree` capability discovery should read project-level
 * entries from: `null` when there's no root at all (matches today's "no
 * workdir ⇒ no project entries"); the ref's committed tree — scoped to
 * `CAPABILITY_READ_PATTERNS` — when `branch` is a non-empty ref; otherwise
 * live disk, byte-identical to pre-ref-mode behavior. Takes `branch` directly
 * (not an `opts` bag) — `workdir` was accepted here once but never read;
 * `root` (already resolved from `workdir` by the caller) is what matters.
 *
 * An unresolvable ref (unknown ref, `root` not a git repo) deliberately
 * degrades to `emptyProjectTree()` rather than falling back to disk — the
 * owner's call: a ref-scoped request that can't be honored should show no
 * project rows, not a possibly-misleading disk snapshot.
 */
export async function resolveProjectTree(
  branch: string | null | undefined,
  root: string | null,
  projectTreeLoader?: ProjectTreeLoader,
): Promise<ProjectTree | null> {
  if (root == null) return null;
  const trimmedBranch = branch?.trim();
  if (!trimmedBranch) {
    // Live-disk mode. A caller-supplied loader replaces the in-process read:
    // the HTTP route passes one for a CLI-token caller so a caller-named
    // workdir is read by a disclaimed child, not by the core (D24).
    // `isDiscoveredCapabilityPath` is the `shouldRead` filter — only the files
    // discovery parses are loaded as content.
    return projectTreeLoader ? projectTreeLoader(root, isDiscoveredCapabilityPath) : diskProjectTree(root);
  }
  const tree = await loadRefProjectTree(root, trimmedBranch, { shouldRead: isDiscoveredCapabilityPath });
  return tree ?? emptyProjectTree();
}

// ---------------------------------------------------------------------------
// Discovery data: every file one request reads, fetched up front.
//
// All filesystem access goes through `DiscoveryFs` (discovery-fs.ts). While the
// disclaim switch is on, each stage below is a handful of disclaimed children
// — one `find -L` per selector shape, then one `tar` (user-level files + the
// live project tree together; then, once `installed_plugins.json` is known,
// every active plugin's files together), so a symlink an agent plants
// in a skills dir, a plugin `installPath` or the project can never make the core
// open a protected folder under Agetor's TCC identity. With the switch off the
// same code reads the disk in-process, as it always did. The parsers below stay
// synchronous and only see a `DiscoveryReader` / `ProjectTree`.
// ---------------------------------------------------------------------------

/** What one discovery request reads, resolved before any parsing. */
interface DiscoveryData {
  /** Repo root of the workdir (or the workdir itself); null without a workdir. */
  root: string | null;
  /** Project-level tree (live disk, a git ref, or the loader's); null without a root. */
  projectTree: ProjectTree | null;
  /** User-level files: config dirs, `settings.json`, `installed_plugins.json`, … */
  reader: DiscoveryReader;
  /** Active plugins' install dirs (same as `reader` when there are none). */
  pluginReader: DiscoveryReader;
  /** Plugins a spawned claude would load (claude-code only). */
  active: ActivePlugin[];
  /** Parsed `~/.claude.json` (claude-code with `claudeJson: true`), else null. */
  claudeJson: any;
}

/** CLAUDE_CONFIG_DIR as a spawned claude sees it: the harness home, else `~/.claude`. */
function claudeConfigDir(opts: { harnessHome?: string | null }): string {
  return opts.harnessHome ?? path.join(homedir(), ".claude");
}

/** The big config blob lives alongside the config dir as `.claude.json` (in HOME by default). */
function claudeJsonPath(opts: { harnessHome?: string | null }): string {
  return opts.harnessHome ? path.join(opts.harnessHome, ".claude.json") : path.join(homedir(), ".claude.json");
}

/** User-level files each kind's parsers read (everything machine-local). */
function userSelectors(opts: DiscoveryOpts): DiscoverySelector[] {
  switch (opts.agent) {
    case "claude-code": {
      const cfg = claudeConfigDir(opts);
      return [
        markdownTree(path.join(cfg, "commands")),
        skillsDir(path.join(cfg, "skills")),
        singleFile(path.join(cfg, "settings.json")),
        singleFile(path.join(cfg, "plugins", "installed_plugins.json")),
      ];
    }
    case "codex": {
      const home = codexHome(opts);
      const out = [
        markdownTree(path.join(home, "prompts")),
        skillsDir(path.join(home, "skills")),
        skillsDir(path.join(home, "skills", ".system")),
        singleFile(path.join(home, "config.toml")),
      ];
      // `codexSystemSkills` falls back to the default home's bundled skills.
      if (home !== defaultCodexHome()) out.push(skillsDir(path.join(defaultCodexHome(), "skills", ".system")));
      return out;
    }
    case "cursor": {
      const home = homeForHomeKinds(opts);
      return [
        ...CURSOR_USER_SKILL_DIRS.map((d) => skillsDir(path.join(home, d))),
        skillsDir(path.join(home, ".cursor", "skills-cursor")),
        singleFile(path.join(home, ".cursor", "mcp.json")),
      ];
    }
    case "fx": {
      const home = homeForHomeKinds(opts);
      return FX_USER_SKILL_DIRS.map((d) => skillsDir(path.join(home, d)));
    }
    default:
      return [];
  }
}

/** Project-level files each kind's parsers read from the live project tree —
 *  the same set `CAPABILITY_READ_PATTERNS` lists for a git ref. */
function projectSelectors(agent: AgentKind, root: string): DiscoverySelector[] {
  const at = (rel: string) => path.join(root, rel);
  switch (agent) {
    case "claude-code":
      return [
        markdownTree(at(".claude/commands")),
        skillsDir(at(".claude/skills")),
        singleFile(at(".claude/settings.json")),
        singleFile(at(".claude/settings.local.json")),
        singleFile(at(".mcp.json")),
      ];
    case "codex":
      return [
        markdownTree(at(".codex/prompts")),
        skillsDir(at(".codex/skills")),
        singleFile(at(".codex/config.toml")),
      ];
    case "cursor":
      return [...CURSOR_USER_SKILL_DIRS.map((d) => skillsDir(at(d))), singleFile(at(".cursor/mcp.json"))];
    case "fx":
      return FX_PROJECT_SKILL_DIRS.map((d) => skillsDir(at(d)));
    default:
      return [];
  }
}

/** What an active plugin contributes: manifest, bundled `.mcp.json`, commands, skills. */
function pluginSelectors(active: ActivePlugin[]): DiscoverySelector[] {
  return active.flatMap((p) => [
    singleFile(path.join(p.installPath, ".claude-plugin", "plugin.json")),
    singleFile(path.join(p.installPath, ".mcp.json")),
    markdownTree(path.join(p.installPath, "commands")),
    skillsDir(path.join(p.installPath, "skills")),
  ]);
}

/**
 * Resolve everything one discovery request reads. Stage 1 runs concurrently:
 * the user-level (and, for live disk, project-level) files, `~/.claude.json`
 * when asked for, and the ref / loader project tree when one is in play. Stage 2
 * fetches the active plugins' files, which are only known after stage 1.
 *
 * `projectTreeLoader` (the route's CLI-token loader) only matters when reads
 * run in-process: with the disclaim switch on, the live project tree rides in
 * stage 1's disclaimed child for every caller, which is the same read the loader
 * would do in a second child.
 */
async function prepareDiscovery(opts: DiscoveryOpts, want: { claudeJson: boolean }): Promise<DiscoveryData> {
  const dfs = discoveryFs();
  const root = opts.workdir ? (await repoRoot(opts.workdir)) ?? opts.workdir : null;
  const liveViaFs = dfs.disclaimed && root != null && !opts.branch?.trim();
  const selectors = [...userSelectors(opts), ...(liveViaFs ? projectSelectors(opts.agent, root!) : [])];
  const [reader, claudeJson, otherProject] = await Promise.all([
    dfs.load(selectors),
    want.claudeJson && opts.agent === "claude-code" ? dfs.readJsonCached(claudeJsonPath(opts)) : Promise.resolve(null),
    liveViaFs ? Promise.resolve(null) : resolveProjectTree(opts.branch, root, opts.projectTreeLoader),
  ]);
  const projectTree = liveViaFs ? reader.tree(root!) : otherProject;
  const active = resolveActivePlugins(opts, root, projectTree, reader);
  const pluginReader = active.length > 0 ? await dfs.load(pluginSelectors(active)) : reader;
  return { root, projectTree, reader, pluginReader, active, claudeJson };
}

/**
 * Return the slash commands + skills that an agent will see when started with
 * the given workdir. User-level entries are always included; project-level
 * entries are read from the workdir's `.claude/` or `.codex/` tree, and for
 * cursor and fx from their skill directories, when the workdir exists.
 * Project entries override user entries by name.
 *
 * `harnessHome` is the harness-level config-dir override (from `Harness.home`):
 *  - claude-code: CLAUDE_CONFIG_DIR=<harnessHome>, so user commands/skills live
 *    directly under it (no `.claude/` segment, matching what spawned claude sees).
 *  - codex: HOME=<harnessHome>, so user prompts live at <harnessHome>/.codex/prompts.
 *    CODEX_HOME in harness env wins when present, matching the spawned process.
 *  - cursor / fx: an explicit HOME in the harness env wins (it wins at spawn
 *    too — `harnessEnv` applies the env map after the home-derived HOME),
 *    else HOME=<harnessHome>, else the process home; user skills live under
 *    that HOME (`.cursor/skills`, `.fx/skills`, …),
 *    project skills under the same relative dirs (fx also a bare `skills/`),
 *    and cursor's `~/.cursor/skills-cursor` built-ins are read from disk last.
 *  - NULL: fall back to the agetor process homedir + the default `.claude/`
 *    or `.codex/` layout.
 *
 * `branch` is a git ref. When set, project-level entries (everything under
 * `.claude/` or `.codex/` in the repo root, plus `.mcp.json`, plus
 * `.cursor/mcp.json`, plus the cursor/fx skill dirs in `PROJECT_CAPABILITY_PATHSPECS`, ref-tree.ts)
 * are read from
 * that ref's COMMITTED tree via `ref-tree.ts`'s `loadRefProjectTree`, not
 * from whatever happens to be checked out on disk — so the autocomplete
 * shows exactly what a worktree cut from that ref will contain; an
 * uncommitted skill sitting on disk is deliberately not offered. Resolution
 * mirrors the `@` file listing: `--full-tree` root-relative paths, and a
 * ref with no local match is retried once as `refs/remotes/origin/<ref>`
 * (PR head branches and other remote-only refs). An unknown ref (or a
 * non-git workdir) yields NO project-level rows rather than falling back to
 * disk — user-level, plugin, and builtin rows still show. With no `branch`,
 * behavior is unchanged: project entries come from live disk.
 */
export async function listAvailableCommands(
  opts: {
    agent: AgentKind;
    workdir: string | null;
    branch?: string | null;
    harnessHome?: string | null;
    harnessEnv?: Record<string, string> | null;
  },
  // Pre-fetched discovery inputs, threaded in by `listAgentCapabilities` so the
  // (settings + installed_plugins + ref/disk) resolution and every filesystem
  // read run once per capabilities request instead of once here and again in
  // the extension pass. Omitted by direct callers (e.g. tests), who get a
  // self-contained prepare.
  ctx?: { data?: DiscoveryData },
): Promise<AvailableCommand[]> {
  const data = ctx?.data ?? (await prepareDiscovery(opts, { claudeJson: false }));
  const { reader, projectTree } = data;
  const all: AvailableCommand[] = [];

  if (opts.agent === "claude-code") {
    const userTree = reader.tree(claudeConfigDir(opts));
    all.push(...discoverCommands(userTree, "commands", "user"));
    all.push(...discoverSkills(userTree, "skills", "user"));
    if (projectTree) {
      all.push(...discoverCommands(projectTree, ".claude/commands", "project"));
      all.push(...discoverSkills(projectTree, ".claude/skills", "project"));
    }
    // Enabled plugins contribute namespaced `/<plugin>:<name>` commands + skills.
    all.push(...pluginCommands(data.active, data.pluginReader));
    // Binary built-ins go LAST so any same-named user/project/plugin entry above
    // wins the dedupe and built-ins only ever fill a gap (matches the CLI).
    all.push(...builtinCommands(opts.agent));
  } else if (opts.agent === "codex") {
    const userCmdRoot = codexHome(opts);
    const userTree = reader.tree(userCmdRoot);
    all.push(...discoverCommands(userTree, "prompts", "user"));
    all.push(...discoverSkills(userTree, "skills", "user"));
    if (projectTree) {
      all.push(...discoverCommands(projectTree, ".codex/prompts", "project"));
      all.push(...discoverSkills(projectTree, ".codex/skills", "project"));
    }
    all.push(...builtinCommands(opts.agent));
    all.push(...codexSystemSkills(userCmdRoot, reader));
  } else if (opts.agent === "cursor") {
    // Skills only in this walk (commands and rules stay unread). MCP config
    // is parsed in `discoverMcpAndPluginExtensions`. User skills come from
    // the HOME dirs below, project skills from the same relative dirs on the
    // project tree; `~/.cursor/skills-cursor` (disk only, never the git ref)
    // are built-ins and go last so same-named skills win.
    const userTree = reader.tree(homeForHomeKinds(opts));
    for (const dir of CURSOR_USER_SKILL_DIRS) all.push(...discoverSkills(userTree, dir, "user"));
    if (projectTree) {
      for (const dir of CURSOR_USER_SKILL_DIRS) all.push(...discoverSkills(projectTree, dir, "project"));
    }
    all.push(...builtinCommands(opts.agent));
    all.push(...discoverSkills(userTree, ".cursor/skills-cursor", "builtin"));
  } else if (opts.agent === "fx") {
    // fx skills: HOME-relative user dirs, repo-relative project dirs (incl. a
    // bare top-level `skills/`). No builtin list.
    const userTree = reader.tree(homeForHomeKinds(opts));
    for (const dir of FX_USER_SKILL_DIRS) all.push(...discoverSkills(userTree, dir, "user"));
    if (projectTree) {
      for (const dir of FX_PROJECT_SKILL_DIRS) all.push(...discoverSkills(projectTree, dir, "project"));
    }
  }
  // Gemini intentionally falls through with no discovery yet: it stores
  // custom commands as `.toml` files under `<geminiDir>/commands/` (verified
  // in the bundled CLI source), a different format from claude/codex's
  // markdown-with-frontmatter that `discoverCommands`/`discoverSkills` parse
  // — reusing them here would silently mis-parse or drop every gemini
  // command. Left as a documented gap rather than a half-correct TOML
  // parser; `all` stays empty for gemini until that's built properly.

  // Project overrides user on collision so users can shadow a global command
  // with a repo-specific one (same precedence the CLIs use at runtime).
  const byName = new Map<string, AvailableCommand>();
  for (const c of all) {
    const existing = byName.get(c.name);
    if (!existing || (existing.source === "user" && c.source === "project")) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Extensions (MCP servers / skills / plugins) — for the prompt-top picker.
// ---------------------------------------------------------------------------

/** Best-effort one-line summary of an MCP server entry, never leaking auth. */
function describeMcpServer(value: unknown): string {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.url === "string") {
      let host = v.url;
      try { host = new URL(v.url).host || v.url; } catch { /* keep raw */ }
      return `${typeof v.type === "string" ? v.type : "http"} · ${host}`;
    }
    if (typeof v.command === "string") return `stdio · ${v.command}`;
  }
  return "MCP server";
}

/** Map a `{ name: config }` mcpServers object into extension rows. */
function mcpServersToExtensions(
  servers: unknown,
  source: "user" | "project",
): AvailableExtension[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, cfg]) => ({
    name,
    insert: "@" + name,
    description: describeMcpServer(cfg),
    source,
    kind: "mcp" as const,
  }));
}

/**
 * Parse `[mcp_servers.<name>]` section headers out of codex `config.toml`
 * TEXT already in hand. A deliberately tiny scanner — we only need the
 * server names, not the full TOML, and pulling in a TOML parser for this
 * would be overkill. Shared by the user path (a `DiscoveryReader` read) and
 * the project path (a `ProjectTree.read()` result).
 */
function codexTomlMcpServersFromText(text: string | null, source: "user" | "project"): AvailableExtension[] {
  if (!text) return [];
  const out: AvailableExtension[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    // Bare names (`[mcp_servers.context7]`) or quoted names that may contain
    // dots (`[mcp_servers."my.server"]`). A trailing `.subkey` (e.g. `.env`)
    // is tolerated — we capture the server name and dedupe repeats.
    const m = /^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].\s]+))\]/.exec(raw);
    if (!m) continue;
    const name = m[1] ?? m[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, insert: "@" + name, description: "MCP server", source, kind: "mcp" });
  }
  return out;
}

/**
 * A claude-code plugin that is installed, applicable to this context, and not
 * disabled — i.e. one the spawned `claude` would actually load. The resolution
 * (scope + enablement) is shared by everything the plugin contributes: its
 * `@plugin` picker row, its namespaced `/<plugin>:<name>` commands + skills, and
 * its bundled MCP servers.
 */
interface ActivePlugin {
  /** Bare plugin name (the `name` half of the `name@marketplace` key). */
  name: string;
  /** Marketplace half of the key; "" when the key carried no `@marketplace`. */
  marketplace: string;
  /** Absolute path to the chosen install record's unpacked plugin dir. */
  installPath: string;
  /** Install scope of the chosen record, for UI badging. */
  source: "user" | "project";
}

/**
 * Merge the `enabledPlugins` maps claude-code consults, lowest-precedence
 * first: user settings, then project `settings.json`, then project
 * `settings.local.json` (later writes win). Keys are `name@marketplace`; values
 * are booleans. A plugin absent from every map is treated as enabled (claude
 * adds an explicit `true` on install, so "absent" means "no opinion recorded"),
 * but an explicit `false` at any scope hides it.
 *
 * User settings are machine-local and always read from disk (through the
 * discovery filesystem, so in a disclaimed child while that switch is on). Project
 * settings go through `projectTree` (live disk, or a git ref's committed
 * tree — see `resolveProjectTree`) so the enabled-plugin view matches
 * whichever tree the rest of project discovery is reading. The two project
 * `settings.json`/`settings.local.json` reads deliberately bypass
 * `jsonStatCache` (unlike `userSettingsPath` above): the tree may be a git
 * ref, where there's no meaningful on-disk path/mtime to key a stat cache
 * by. They're tiny files and the request rate is bounded by picker changes
 * (agent/workdir/branch), so re-parsing them every call is cheap enough.
 */
function readEnabledPlugins(
  harnessHome: string | null,
  projectTree: ProjectTree | null,
  reader: DiscoveryReader,
): Map<string, boolean> {
  const merged = new Map<string, boolean>();
  const apply = (ep: unknown) => {
    if (ep && typeof ep === "object") {
      for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
        if (typeof v === "boolean") merged.set(k, v);
      }
    }
  };
  // harnessHome IS the CLAUDE_CONFIG_DIR, so settings.json sits directly under
  // it (mirroring how commands/skills live there sans `.claude/` segment).
  const userSettingsPath = path.join(claudeConfigDir({ harnessHome }), "settings.json");
  apply(reader.json(userSettingsPath, { cached: true })?.enabledPlugins);
  if (projectTree) {
    apply(safeParseJson(projectTree.read(".claude/settings.json"))?.enabledPlugins);
    apply(safeParseJson(projectTree.read(".claude/settings.local.json"))?.enabledPlugins);
  }
  return merged;
}

/**
 * The plugins a spawned `claude` would load for this (workdir, harness): an
 * applicable install record (user-scoped always; project-scoped only when its
 * `projectPath` matches the repo) AND not explicitly disabled via
 * `enabledPlugins`. claude-code only — codex has no plugin system.
 *
 * Plugin install RECORDS and their `installPath` contents stay disk-only —
 * they're machine-local, not tracked files — but which plugins are enabled
 * can be overridden by a project `settings.json` at a ref, hence `projectTree`.
 */
function resolveActivePlugins(
  opts: DiscoveryOpts,
  root: string | null,
  projectTree: ProjectTree | null,
  reader: DiscoveryReader,
): ActivePlugin[] {
  if (opts.agent !== "claude-code") return [];
  const configDir = claudeConfigDir(opts);
  const installed = reader.json(path.join(configDir, "plugins", "installed_plugins.json"), { cached: true });
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const enabled = readEnabledPlugins(opts.harnessHome ?? null, projectTree, reader);
  const roots = new Set([root, opts.workdir].filter(Boolean) as string[]);
  const out: ActivePlugin[] = [];
  for (const [key, recordsRaw] of Object.entries(plugins as Record<string, unknown>)) {
    // Explicit disable at any settings scope ⇒ claude won't load it. Absent ⇒
    // load (default-enabled-on-install), so only `=== false` excludes.
    if (enabled.get(key) === false) continue;
    const records = Array.isArray(recordsRaw) ? recordsRaw : [];
    // Pick the most relevant install record: prefer a project match, else any
    // user-scoped one. A plugin can be installed at both scopes.
    let chosen: any = null;
    let source: "user" | "project" = "user";
    for (const rec of records) {
      if (rec && rec.scope === "project" && typeof rec.projectPath === "string" && roots.has(rec.projectPath)) {
        chosen = rec; source = "project"; break;
      }
      if (rec && rec.scope === "user" && !chosen) { chosen = rec; source = "user"; }
    }
    if (!chosen || typeof chosen.installPath !== "string") continue;
    // Plugin keys are `name@marketplace`; split into the bare name + marketplace.
    const at = key.indexOf("@");
    out.push({
      name: at > 0 ? key.slice(0, at) : key,
      marketplace: at > 0 ? key.slice(at + 1) : "",
      installPath: chosen.installPath,
      source,
    });
  }
  return out;
}

/**
 * One `@plugin` picker row per active plugin. Descriptions come from each
 * plugin's `.claude-plugin/plugin.json` when readable. Two marketplaces can
 * ship a plugin with the same bare name — those are distinct plugins, not a
 * user/project shadow of each other, so they must not collapse in the final
 * (kind, name) dedupe; suffix the display name with the marketplace for any
 * name that appears more than once so both survive and stay distinguishable.
 */
function pluginSelfExtensions(active: ActivePlugin[], reader: DiscoveryReader): AvailableExtension[] {
  const rows = active.map((p) => {
    let description = p.marketplace ? `plugin · ${p.marketplace}` : "plugin";
    const manifest = reader.json(path.join(p.installPath, ".claude-plugin", "plugin.json"));
    if (manifest && typeof manifest.description === "string" && manifest.description.trim()) {
      description = manifest.description.trim().slice(0, 200);
    }
    return { name: p.name, insert: "@" + p.name, description, source: p.source, kind: "plugin" as const, marketplace: p.marketplace };
  });
  const nameCounts = new Map<string, number>();
  for (const r of rows) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  return rows.map(({ marketplace, ...r }) =>
    nameCounts.get(r.name)! > 1 && marketplace ? { ...r, name: `${r.name} (${marketplace})` } : r,
  );
}

/**
 * Commands + skills an active plugin contributes to the `/` surface. claude
 * namespaces them `<plugin>:<name>` (e.g. `/vercel:deploy`, `/sentry:seer`), so
 * we walk the plugin's own `commands/` + `skills/` trees and re-prefix each
 * discovered `/name` as `/<plugin>:<name>`. `source: "plugin"` keeps them from
 * shadowing — or being shadowed by — user/project entries.
 *
 * Two plugins that share a bare name across marketplaces (e.g. `foo@mp-a` +
 * `foo@mp-b`) both emit `/foo:deploy`; the outer name-dedupe in
 * `listAvailableCommands` keeps the first deterministically. That collapse is
 * CORRECT, not a bug: claude has no invocation-level marketplace disambiguation
 * (there is no `/foo@mp-a:deploy` token), so both versions genuinely compete for
 * the one `/foo:deploy` namespace at runtime too. The `@plugin` picker rows
 * still list both (suffixed with their marketplace) so the user can see the
 * conflict; the slash surface just mirrors claude's actual single-namespace
 * resolution. Do NOT "fix" this by minting a marketplace-qualified token — that
 * token would not be invokable.
 */
function pluginCommands(active: ActivePlugin[], reader: DiscoveryReader): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const p of active) {
    // Plugin install dirs are machine-local (not tracked in the project
    // repo), so they always read from disk regardless of any ref in play.
    const tree = reader.tree(p.installPath);
    const contributed = [
      ...discoverCommands(tree, "commands", "plugin"),
      ...discoverSkills(tree, "skills", "plugin"),
    ];
    for (const c of contributed) {
      out.push({ ...c, name: `/${p.name}:${c.name.slice(1)}` });
    }
  }
  return out;
}

/**
 * MCP servers an active plugin ships via its bundled `.mcp.json`. These start
 * automatically when the plugin is enabled, so they belong in the picker.
 * Namespaced `<plugin>:<server>` to avoid colliding across plugins; collapsed
 * to just `<plugin>` when the server name already equals the plugin name (the
 * common single-server case, e.g. the `vercel` plugin's `vercel` server).
 */
function pluginMcpExtensions(active: ActivePlugin[], reader: DiscoveryReader): AvailableExtension[] {
  const out: AvailableExtension[] = [];
  for (const p of active) {
    const servers = reader.json(path.join(p.installPath, ".mcp.json"))?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [server, cfg] of Object.entries(servers as Record<string, unknown>)) {
      const name = server === p.name ? p.name : `${p.name}:${server}`;
      out.push({ name, insert: "@" + name, description: describeMcpServer(cfg), source: "plugin", kind: "mcp" });
    }
  }
  return out;
}

interface DiscoveryOpts {
  agent: AgentKind;
  workdir: string | null;
  branch?: string | null;
  harnessHome?: string | null;
  harnessEnv?: Record<string, string> | null;
  /**
   * Replaces the in-process live-disk read (`diskProjectTree`) when no
   * `branch` is set — the route passes `callerProjectTree(…, "cli", …)` for a
   * CLI-token caller (D24). Ignored in ref mode, which reads git objects, not
   * the working tree.
   */
  projectTreeLoader?: ProjectTreeLoader;
}

/**
 * MCP servers + plugins for the given context — everything in the Extensions
 * picker *except* skills. Split out from skill discovery so the combined
 * `listAgentCapabilities` can reuse the skills `listAvailableCommands` already
 * walked instead of walking the `skills/` tree a second time.
 *
 * `projectTree` is `resolveProjectTree`'s result — live disk or a git ref's
 * committed tree — and backs only the tracked project files (`.mcp.json`,
 * `.cursor/mcp.json`, `.codex/config.toml`); `~/.claude.json`'s per-project
 * MCP block stays disk-only regardless (it's machine-local, keyed by the cwd
 * claude ran in, not a file the ref would carry).
 */
function discoverMcpAndPluginExtensions(opts: DiscoveryOpts, data: DiscoveryData): AvailableExtension[] {
  const { root, projectTree, reader, pluginReader, active, claudeJson } = data;
  const all: AvailableExtension[] = [];
  if (opts.agent === "claude-code") {
    // MCP servers: user-scoped from the top-level mcpServers, project-scoped
    // from both the per-project block in .claude.json (already read and
    // stat-cached by `prepareDiscovery`) and a committed .mcp.json.
    all.push(...mcpServersToExtensions(claudeJson?.mcpServers, "user"));
    if (root) {
      const projects = claudeJson?.projects;
      for (const key of new Set([root, opts.workdir].filter(Boolean) as string[])) {
        all.push(...mcpServersToExtensions(projects?.[key]?.mcpServers, "project"));
      }
      all.push(...mcpServersToExtensions(safeParseJson(projectTree?.read(".mcp.json") ?? null)?.mcpServers, "project"));
    }

    // Plugins (claude-code only): the `@plugin` rows plus the MCP servers each
    // enabled plugin ships via its bundled `.mcp.json`. `active` is resolved once
    // by the caller and shared with the command pass.
    all.push(...pluginSelfExtensions(active, pluginReader));
    all.push(...pluginMcpExtensions(active, pluginReader));
  } else if (opts.agent === "codex") {
    const userCodexHome = codexHome(opts);
    all.push(...codexTomlMcpServersFromText(reader.text(path.join(userCodexHome, "config.toml")), "user"));
    if (root) {
      all.push(...codexTomlMcpServersFromText(projectTree?.read(".codex/config.toml") ?? null, "project"));
    }
  } else if (opts.agent === "cursor") {
    // Same `{ mcpServers }` object Claude's `.mcp.json` uses. User file is
    // `<home>/.cursor/mcp.json` (env HOME, else harness.home, else the
    // process home). Project file is `.cursor/mcp.json` on the project tree,
    // so a ref reads the committed copy. Plugin-contributed and dashboard
    // servers are not in these files.
    const home = homeForHomeKinds(opts);
    all.push(
      ...mcpServersToExtensions(reader.json(path.join(home, ".cursor", "mcp.json"))?.mcpServers, "user"),
    );
    if (root) {
      all.push(
        ...mcpServersToExtensions(
          safeParseJson(projectTree?.read(".cursor/mcp.json") ?? null)?.mcpServers,
          "project",
        ),
      );
    }
  }
  // Gemini has its own `gemini mcp add/list/remove` surface, so it almost
  // certainly stores MCP config somewhere under GEMINI_CLI_HOME/`.gemini/` —
  // not yet reverse-engineered. Same documented-gap treatment as commands
  // above: falls through with `all` empty rather than guessing at a config
  // shape and mis-parsing it.
  return all;
}

/**
 * Collapse a raw extension list: project overrides user on a (kind, name)
 * collision (same precedence rule as listAvailableCommands), then a stable
 * grouping — mcp, then skill, then plugin; alphabetical within a group.
 */
function dedupeAndSortExtensions(all: AvailableExtension[]): AvailableExtension[] {
  const byKey = new Map<string, AvailableExtension>();
  for (const e of all) {
    const k = e.kind + " " + e.name;
    const existing = byKey.get(k);
    if (!existing || (existing.source === "user" && e.source === "project")) {
      byKey.set(k, e);
    }
  }
  const order = { mcp: 0, skill: 1, plugin: 2 } as const;
  return [...byKey.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
  );
}

/**
 * Combined discovery for the prompt UI: slash commands/skills (for the `/`
 * autocomplete) and MCP/skill/plugin extensions (for the picker) in a single
 * pass. The webview fetches this once per (agent, workdir, branch) change
 * instead of hitting two endpoints that each re-resolve the repo root and
 * re-walk the `skills/` tree.
 *
 * Skills are walked exactly once: `listAvailableCommands` already discovers
 * them (they share the `/name` slash surface), so the skill rows of the
 * extension list are derived from that result rather than re-scanned. A
 * command and a skill that share a name are the same `/name` invocation (the
 * CLI merged custom commands into skills), so reusing the command-list view is
 * the correct precedence, not a divergence.
 */
export async function listAgentCapabilities(opts: DiscoveryOpts): Promise<{
  commands: AvailableCommand[];
  extensions: AvailableExtension[];
}> {
  // Resolve repo root + project tree + active plugins and read every file once
  // (`prepareDiscovery`), then thread that into the command and extension
  // passes so neither re-reads settings/installed_plugins or re-resolves the
  // ref/disk tree. repoRoot is memoized.
  const data = await prepareDiscovery(opts, { claudeJson: true });
  const commands = await listAvailableCommands(opts, { data });
  const skillExts: AvailableExtension[] = commands
    .filter((c) => c.kind === "skill")
    .map((c) => ({
      name: c.name.replace(/^\//, ""),
      insert: c.name,
      description: c.description,
      source: c.source,
      kind: "skill" as const,
    }));
  const extensions = dedupeAndSortExtensions([
    ...skillExts,
    ...discoverMcpAndPluginExtensions(opts, data),
  ]);
  return { commands, extensions };
}
