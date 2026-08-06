import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentKind } from "../shared/types.ts";
import { repoRoot } from "./worktree.ts";

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
function discoverCommands(dir: string, source: EntrySource): AvailableCommand[] {
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
function discoverSkills(dir: string, source: EntrySource): AvailableCommand[] {
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

/** The harness's built-in commands/skills as AvailableCommand rows. */
function builtinCommands(agent: AgentKind): AvailableCommand[] {
  const builtins = agent === "claude-code" ? CLAUDE_BUILTINS : CODEX_BUILTINS;
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

function codexSystemSkills(home: string): AvailableCommand[] {
  const primary = discoverSkills(path.join(home, "skills", ".system"), "builtin");
  if (primary.length > 0 || home === defaultCodexHome()) return primary;
  return discoverSkills(path.join(defaultCodexHome(), "skills", ".system"), "builtin");
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
 *    CODEX_HOME in harness env wins when present, matching the spawned process.
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
export async function listAvailableCommands(
  opts: {
    agent: AgentKind;
    workdir: string | null;
    branch?: string | null;
    harnessHome?: string | null;
    harnessEnv?: Record<string, string> | null;
  },
  // Pre-resolved active plugins, threaded in by `listAgentCapabilities` so the
  // (settings + installed_plugins) resolution runs once per capabilities request
  // instead of once here and again in `discoverMcpAndPluginExtensions`. Omitted
  // by direct callers (e.g. tests), who get a self-contained resolve.
  activePlugins?: ActivePlugin[],
): Promise<AvailableCommand[]> {
  const all: AvailableCommand[] = [];

  if (opts.agent === "claude-code") {
    const userCmdRoot = opts.harnessHome ?? path.join(homedir(), ".claude");
    all.push(...discoverCommands(path.join(userCmdRoot, "commands"), "user"));
    all.push(...discoverSkills(path.join(userCmdRoot, "skills"), "user"));
    // Plugins apply regardless of workdir (user-scoped ones are global), so
    // resolve the repo root up front — it's also reused for project entries.
    const root = opts.workdir ? (await repoRoot(opts.workdir)) ?? opts.workdir : null;
    if (root) {
      all.push(...discoverCommands(path.join(root, ".claude", "commands"), "project"));
      all.push(...discoverSkills(path.join(root, ".claude", "skills"), "project"));
    }
    // Enabled plugins contribute namespaced `/<plugin>:<name>` commands + skills.
    all.push(...pluginCommands(activePlugins ?? resolveActivePlugins(opts, root)));
    // Binary built-ins go LAST so any same-named user/project/plugin entry above
    // wins the dedupe and built-ins only ever fill a gap (matches the CLI).
    all.push(...builtinCommands(opts.agent));
  } else if (opts.agent === "codex") {
    const userCmdRoot = codexHome(opts);
    all.push(...discoverCommands(path.join(userCmdRoot, "prompts"), "user"));
    all.push(...discoverSkills(path.join(userCmdRoot, "skills"), "user"));
    if (opts.workdir) {
      const root = (await repoRoot(opts.workdir)) ?? opts.workdir;
      all.push(...discoverCommands(path.join(root, ".codex", "prompts"), "project"));
      all.push(...discoverSkills(path.join(root, ".codex", "skills"), "project"));
    }
    all.push(...builtinCommands(opts.agent));
    all.push(...codexSystemSkills(userCmdRoot));
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
 */
function readEnabledPlugins(harnessHome: string | null, root: string | null): Map<string, boolean> {
  const merged = new Map<string, boolean>();
  const apply = (p: string) => {
    const ep = safeReadJsonCached(p)?.enabledPlugins;
    if (ep && typeof ep === "object") {
      for (const [k, v] of Object.entries(ep)) {
        if (typeof v === "boolean") merged.set(k, v);
      }
    }
  };
  // harnessHome IS the CLAUDE_CONFIG_DIR, so settings.json sits directly under
  // it (mirroring how commands/skills live there sans `.claude/` segment).
  apply(harnessHome ? path.join(harnessHome, "settings.json") : path.join(homedir(), ".claude", "settings.json"));
  if (root) {
    apply(path.join(root, ".claude", "settings.json"));
    apply(path.join(root, ".claude", "settings.local.json"));
  }
  return merged;
}

/**
 * The plugins a spawned `claude` would load for this (workdir, harness): an
 * applicable install record (user-scoped always; project-scoped only when its
 * `projectPath` matches the repo) AND not explicitly disabled via
 * `enabledPlugins`. claude-code only — codex has no plugin system.
 */
function resolveActivePlugins(opts: DiscoveryOpts, root: string | null): ActivePlugin[] {
  if (opts.agent !== "claude-code") return [];
  const configDir = opts.harnessHome ?? path.join(homedir(), ".claude");
  const installed = safeReadJsonCached(path.join(configDir, "plugins", "installed_plugins.json"));
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const enabled = readEnabledPlugins(opts.harnessHome ?? null, root);
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
function pluginSelfExtensions(active: ActivePlugin[]): AvailableExtension[] {
  const rows = active.map((p) => {
    let description = p.marketplace ? `plugin · ${p.marketplace}` : "plugin";
    const manifest = safeReadJson(path.join(p.installPath, ".claude-plugin", "plugin.json"));
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
function pluginCommands(active: ActivePlugin[]): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const p of active) {
    const contributed = [
      ...discoverCommands(path.join(p.installPath, "commands"), "plugin"),
      ...discoverSkills(path.join(p.installPath, "skills"), "plugin"),
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
function pluginMcpExtensions(active: ActivePlugin[]): AvailableExtension[] {
  const out: AvailableExtension[] = [];
  for (const p of active) {
    const servers = safeReadJson(path.join(p.installPath, ".mcp.json"))?.mcpServers;
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
}

/**
 * MCP servers + plugins for the given context — everything in the Extensions
 * picker *except* skills. Split out from skill discovery so the combined
 * `listAgentCapabilities` can reuse the skills `listAvailableCommands` already
 * walked instead of walking the `skills/` tree a second time.
 */
function discoverMcpAndPluginExtensions(opts: DiscoveryOpts, root: string | null, active: ActivePlugin[]): AvailableExtension[] {
  const all: AvailableExtension[] = [];
  if (opts.agent === "claude-code") {
    // harnessHome (CLAUDE_CONFIG_DIR) replaces ~/.claude; the big config blob
    // lives alongside it as `.claude.json` (in HOME by default).
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

    // Plugins (claude-code only): the `@plugin` rows plus the MCP servers each
    // enabled plugin ships via its bundled `.mcp.json`. `active` is resolved once
    // by the caller and shared with the command pass.
    all.push(...pluginSelfExtensions(active));
    all.push(...pluginMcpExtensions(active));
  } else if (opts.agent === "codex") {
    const userCodexHome = codexHome(opts);
    all.push(...codexTomlMcpServers(path.join(userCodexHome, "config.toml"), "user"));
    if (root) {
      all.push(...codexTomlMcpServers(path.join(root, ".codex", "config.toml"), "project"));
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
  // Resolve repo root + active plugins once, then thread both into the command
  // and extension passes so neither re-reads settings/installed_plugins. repoRoot
  // is memoized, so `listAvailableCommands` re-deriving root internally is a hit.
  const root = opts.workdir ? (await repoRoot(opts.workdir)) ?? opts.workdir : null;
  const active = resolveActivePlugins(opts, root);
  const commands = await listAvailableCommands(opts, active);
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
    ...discoverMcpAndPluginExtensions(opts, root, active),
  ]);
  return { commands, extensions };
}
