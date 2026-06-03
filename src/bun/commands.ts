import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentKind } from "../shared/types.ts";
import { repoRoot } from "./worktree.ts";

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
  source: "user" | "project";
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
  source: "user" | "project";
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

function safeReadFile(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function safeListDir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

/**
 * Walk a commands directory, treating nested folders as `parent:child` namespaces
 * (the convention both Claude Code and `bunx claudeup`-style tooling adopt).
 */
function discoverCommands(dir: string, source: "user" | "project"): AvailableCommand[] {
  if (!existsSync(dir)) return [];
  const out: AvailableCommand[] = [];
  const walk = (cur: string, prefix: string) => {
    for (const name of safeListDir(cur)) {
      const p = path.join(cur, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) {
        walk(p, prefix + name + ":");
      } else if (name.endsWith(".md")) {
        const cmdName = prefix + name.slice(0, -3);
        out.push({
          name: "/" + cmdName,
          description: readMdSummary(safeReadFile(p)),
          source,
          kind: "command",
        });
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * A "skill" is a folder under `skills/` containing a SKILL.md file. The folder
 * name is the slash-invokable name.
 */
function discoverSkills(dir: string, source: "user" | "project"): AvailableCommand[] {
  if (!existsSync(dir)) return [];
  const out: AvailableCommand[] = [];
  for (const name of safeListDir(dir)) {
    const skillFile = path.join(dir, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({
      name: "/" + name,
      description: readMdSummary(safeReadFile(skillFile)),
      source,
      kind: "skill",
    });
  }
  return out;
}

/**
 * Return the slash commands + skills that an agent will see when started with
 * the given workdir. User-level entries are always included; project-level
 * entries are read from the workdir's `.claude/` (or `.codex/`) tree when the
 * workdir exists. Project entries override user entries by name.
 *
 * `harnessHome` is the harness-level config-dir override (from `Harness.home`):
 *  - claude-code: CLAUDE_CONFIG_DIR=<harnessHome>, so user commands/skills live
 *    directly under it (no `.claude/` segment, matching what spawned claude sees).
 *  - codex: HOME=<harnessHome>, so user prompts live at <harnessHome>/.codex/prompts.
 *  - NULL: fall back to the agetor process homedir + the default `.claude/`
 *    or `.codex/` layout.
 *
 * Branch is accepted but not used to swap filesystem views — when the user
 * picks a different branch, the worktree will be checked out from that branch
 * at task-start, but for autocomplete we read what the user currently has on
 * disk in the source repo. That matches what the user "sees" right now and
 * avoids spawning git per keystroke. The branch field is wired through so a
 * future enhancement can git-ls-tree without breaking the API shape.
 */
export async function listAvailableCommands(opts: {
  agent: AgentKind;
  workdir: string | null;
  branch?: string | null;
  harnessHome?: string | null;
}): Promise<AvailableCommand[]> {
  const all: AvailableCommand[] = [];

  if (opts.agent === "claude-code") {
    const userCmdRoot = opts.harnessHome ?? path.join(homedir(), ".claude");
    all.push(...discoverCommands(path.join(userCmdRoot, "commands"), "user"));
    all.push(...discoverSkills(path.join(userCmdRoot, "skills"), "user"));
    if (opts.workdir) {
      const root = (await repoRoot(opts.workdir)) ?? opts.workdir;
      all.push(...discoverCommands(path.join(root, ".claude", "commands"), "project"));
      all.push(...discoverSkills(path.join(root, ".claude", "skills"), "project"));
    }
  } else if (opts.agent === "codex") {
    const userCmdRoot = opts.harnessHome
      ? path.join(opts.harnessHome, ".codex")
      : path.join(homedir(), ".codex");
    all.push(...discoverCommands(path.join(userCmdRoot, "prompts"), "user"));
    if (opts.workdir) {
      const root = (await repoRoot(opts.workdir)) ?? opts.workdir;
      all.push(...discoverCommands(path.join(root, ".codex", "prompts"), "project"));
    }
  }

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

function safeReadJson(p: string): any {
  const text = safeReadFile(p);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Stat-keyed cache for JSON files that are large and re-read often. `~/.claude.json`
 * in particular grows with per-project history and can reach multiple MB; the
 * picker re-discovers on every (agent, workdir, branch) change, so we avoid
 * re-parsing it when it hasn't changed on disk. The key combines mtime *and*
 * size so a same-millisecond rewrite (or a filesystem with coarse mtime
 * granularity) still invalidates as long as the byte count differs. A changed
 * key invalidates the entry; an unreadable/missing file caches `null`.
 */
const jsonStatCache = new Map<string, { mtimeMs: number; size: number; value: any }>();
function safeReadJsonCached(p: string): any {
  let mtimeMs: number, size: number;
  try { ({ mtimeMs, size } = statSync(p)); }
  catch { jsonStatCache.delete(p); return null; }
  const hit = jsonStatCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value;
  const value = safeReadJson(p);
  jsonStatCache.set(p, { mtimeMs, size, value });
  return value;
}

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
 * Parse `[mcp_servers.<name>]` section headers out of a codex `config.toml`.
 * A deliberately tiny scanner — we only need the server names, not the full
 * TOML, and pulling in a TOML parser for this would be overkill.
 */
function codexTomlMcpServers(tomlPath: string, source: "user" | "project"): AvailableExtension[] {
  const text = safeReadFile(tomlPath);
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
 * Installed claude-code plugins, scoped to what applies here: user-scoped
 * plugins always count; project-scoped ones only when their `projectPath`
 * matches the repo we're discovering against. Descriptions come from each
 * plugin's `.claude-plugin/plugin.json` when readable.
 */
function pluginExtensions(
  pluginsDir: string,
  repoRoots: string[],
): AvailableExtension[] {
  const installed = safeReadJson(path.join(pluginsDir, "installed_plugins.json"));
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const roots = new Set(repoRoots.filter(Boolean));
  const rows: (AvailableExtension & { marketplace: string })[] = [];
  for (const [key, recordsRaw] of Object.entries(plugins as Record<string, unknown>)) {
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
    if (!chosen) continue;
    // Plugin keys are `name@marketplace`; show the bare name, marketplace as a hint.
    const at = key.indexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : "";
    let description = marketplace ? `plugin · ${marketplace}` : "plugin";
    if (typeof chosen.installPath === "string") {
      const manifest = safeReadJson(path.join(chosen.installPath, ".claude-plugin", "plugin.json"));
      if (manifest && typeof manifest.description === "string" && manifest.description.trim()) {
        description = manifest.description.trim().slice(0, 200);
      }
    }
    rows.push({ name, insert: "@" + name, description, source, kind: "plugin", marketplace });
  }
  // Two marketplaces can ship a plugin with the same bare name. Those are
  // distinct plugins, not a user/project shadow of each other, so they must not
  // collapse into one in the final (kind, name) dedupe. Suffix the display name
  // with the marketplace for any name that appears more than once so both
  // survive and the user can tell them apart.
  const nameCounts = new Map<string, number>();
  for (const r of rows) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  return rows.map(({ marketplace, ...r }) =>
    nameCounts.get(r.name)! > 1 && marketplace
      ? { ...r, name: `${r.name} (${marketplace})` }
      : r,
  );
}

interface DiscoveryOpts {
  agent: AgentKind;
  workdir: string | null;
  branch?: string | null;
  harnessHome?: string | null;
}

/**
 * MCP servers + plugins for the given context — everything in the Extensions
 * picker *except* skills. Split out from skill discovery so the combined
 * `listAgentCapabilities` can reuse the skills `listAvailableCommands` already
 * walked instead of walking the `skills/` tree a second time.
 */
function discoverMcpAndPluginExtensions(opts: DiscoveryOpts, root: string | null): AvailableExtension[] {
  const all: AvailableExtension[] = [];
  if (opts.agent === "claude-code") {
    // harnessHome (CLAUDE_CONFIG_DIR) replaces ~/.claude; the big config blob
    // lives alongside it as `.claude.json` (in HOME by default).
    const configDir = opts.harnessHome ?? path.join(homedir(), ".claude");
    const claudeJsonPath = opts.harnessHome
      ? path.join(opts.harnessHome, ".claude.json")
      : path.join(homedir(), ".claude.json");

    // MCP servers: user-scoped from the top-level mcpServers, project-scoped
    // from both the per-project block in .claude.json and a committed .mcp.json.
    const claudeJson = safeReadJsonCached(claudeJsonPath);
    all.push(...mcpServersToExtensions(claudeJson?.mcpServers, "user"));
    if (root) {
      const projects = claudeJson?.projects;
      for (const key of new Set([root, opts.workdir].filter(Boolean) as string[])) {
        all.push(...mcpServersToExtensions(projects?.[key]?.mcpServers, "project"));
      }
      all.push(...mcpServersToExtensions(safeReadJson(path.join(root, ".mcp.json"))?.mcpServers, "project"));
    }

    // Plugins (claude-code only).
    all.push(...pluginExtensions(path.join(configDir, "plugins"), [root, opts.workdir].filter(Boolean) as string[]));
  } else if (opts.agent === "codex") {
    const codexHome = opts.harnessHome ? path.join(opts.harnessHome, ".codex") : path.join(homedir(), ".codex");
    all.push(...codexTomlMcpServers(path.join(codexHome, "config.toml"), "user"));
  }
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
  const commands = await listAvailableCommands(opts);
  // repoRoot is memoized, so this is a cache hit after listAvailableCommands.
  const root = opts.workdir ? (await repoRoot(opts.workdir)) ?? opts.workdir : null;
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
    ...discoverMcpAndPluginExtensions(opts, root),
  ]);
  return { commands, extensions };
}
