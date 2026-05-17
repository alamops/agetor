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
}): Promise<AvailableCommand[]> {
  const home = homedir();
  const all: AvailableCommand[] = [];

  if (opts.agent === "claude-code") {
    all.push(...discoverCommands(path.join(home, ".claude", "commands"), "user"));
    all.push(...discoverSkills(path.join(home, ".claude", "skills"), "user"));
    if (opts.workdir) {
      const root = (await repoRoot(opts.workdir)) ?? opts.workdir;
      all.push(...discoverCommands(path.join(root, ".claude", "commands"), "project"));
      all.push(...discoverSkills(path.join(root, ".claude", "skills"), "project"));
    }
  } else if (opts.agent === "codex") {
    all.push(...discoverCommands(path.join(home, ".codex", "prompts"), "user"));
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
