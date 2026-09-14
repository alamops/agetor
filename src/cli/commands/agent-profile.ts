import { readFileSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";
import type { AgetorClient, AgentProfileInput } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { matchAgentProfileRef, normalizeSkillName } from "../../shared/agent-profile.ts";
import type { AgentProfile } from "../../shared/types.ts";

export async function cmdAgentProfile(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  const client = await getClient(flags);
  switch (sub) {
    case "ls":
    case "list": {
      const profiles = await client.listAgentProfiles();
      if (flags.json) return printJson(profiles);
      if (profiles.length === 0) {
        out(c.dim("no agents defined — create one: agetor agent add <name> --harness <id> --model <id>"));
        return;
      }
      const rows = profiles.map((pr) => [
        c.bold(pr.name),
        c.gray(pr.harness),
        pr.model,
        pr.effort ?? "-",
        pr.mode ?? "-",
        String(pr.skills.length),
        c.dim(oneLine(pr.instructions, 60)),
      ]);
      out(table(["name", "harness", "model", "effort", "mode", "skills", "instructions"], rows));
      return;
    }
    case "show": {
      const ref = args[1];
      if (!ref) throw usageError("agent");
      const profile = await resolveProfile(client, ref);
      if (flags.json) return printJson(profile);
      out(`${c.bold(profile.name)}  ${c.dim(profile.id)}`);
      out(
        `  ${label("harness")} ${profile.harness}   ${label("model")} ${profile.model}` +
          `   ${label("effort")} ${profile.effort ?? "-"}   ${label("mode")} ${profile.mode ?? "-"}`,
      );
      out(`  ${label("fast")} ${profile.fast ? "yes" : "no"}   ${label("max mode")} ${profile.maxMode ? "yes" : "no"}`);
      out(
        `  ${label("skills")} ${profile.skills.length ? profile.skills.map((s) => `/${s}`).join(", ") : c.dim("none")}`,
      );
      out(`  ${label("instructions")}${profile.instructions ? "" : ` ${c.dim("none")}`}`);
      if (profile.instructions) {
        for (const line of profile.instructions.split("\n")) out(`    ${line}`);
      }
      return;
    }
    case "add": {
      const name = args[1];
      if (!name || name.startsWith("-")) throw usageError("agent add");
      const f = parseAgentProfileFlags(args.slice(2));
      if (!f.harness || !f.model) throw usageError("agent add");
      const instructions = await resolveInstructions(f);
      const input: AgentProfileInput = {
        name,
        harness: f.harness,
        model: f.model,
        effort: f.effort ?? null,
        mode: f.mode ?? null,
        fast: f.fast ?? false,
        maxMode: f.maxMode ?? false,
        instructions: instructions ?? "",
        skills: normalizeSkillList(f.skills),
      };
      const created = await client.createAgentProfile(input);
      if (flags.json) return printJson(created);
      out(`${c.green("✓")} created agent ${c.bold(created.name)} (${c.dim(created.id)})`);
      return;
    }
    case "edit": {
      const ref = args[1];
      if (!ref) throw usageError("agent edit");
      const f = parseAgentProfileFlags(args.slice(2));
      const hasAnyFlag =
        f.name !== undefined ||
        f.harness !== undefined ||
        f.model !== undefined ||
        f.effort !== undefined ||
        f.mode !== undefined ||
        f.fast !== undefined ||
        f.maxMode !== undefined ||
        f.instructions !== undefined ||
        f.instructionsFile !== undefined ||
        f.skills.length > 0 ||
        f.clearSkills;
      if (!hasAnyFlag) {
        throw new Error(
          "nothing to edit — pass at least one of --name/--harness/--model/--mode/--effort/--fast/--no-fast/--max-mode/--no-max-mode/--instructions/--instructions-file/--skill/--clear-skills",
        );
      }
      const profile = await resolveProfile(client, ref);
      const instructions = await resolveInstructions(f);
      const patch: Partial<AgentProfileInput> = {};
      if (f.name !== undefined) patch.name = f.name;
      if (f.harness !== undefined) patch.harness = f.harness;
      if (f.model !== undefined) patch.model = f.model;
      if (f.effort !== undefined) patch.effort = f.effort;
      if (f.mode !== undefined) patch.mode = f.mode;
      if (f.fast !== undefined) patch.fast = f.fast;
      if (f.maxMode !== undefined) patch.maxMode = f.maxMode;
      if (instructions !== undefined) patch.instructions = instructions;
      if (f.clearSkills) {
        patch.skills = normalizeSkillList(f.skills);
      } else if (f.skills.length > 0) {
        patch.skills = normalizeSkillList([...profile.skills, ...f.skills]);
      }
      const updated = await client.patchAgentProfile(profile.id, patch);
      if (flags.json) return printJson(updated);
      out(`${c.green("✓")} updated agent ${c.bold(updated.name)} (${c.dim(updated.id)})`);
      return;
    }
    case "rm":
    case "delete": {
      const ref = args[1];
      if (!ref) throw usageError("agent");
      const profile = await resolveProfile(client, ref);
      await client.deleteAgentProfile(profile.id);
      if (flags.json) return printJson({ removed: profile.id });
      out(`${c.red("✗")} removed agent ${c.bold(profile.name)} — existing tasks keep their snapshot`);
      return;
    }
    default:
      throw new Error(`unknown agent subcommand: ${sub} (use ls | show | add | edit | rm)`);
  }
}

async function resolveProfile(client: AgetorClient, ref: string): Promise<AgentProfile> {
  const profiles = await client.listAgentProfiles();
  const result = matchAgentProfileRef(profiles, ref);
  if ("error" in result) throw new Error(result.error);
  return result.profile;
}

/** Dedupe (case-sensitive, first-occurrence order) a list of raw skill
 *  tokens through {@link normalizeSkillName}, dropping any that normalize to
 *  `""` (invalid / over the length cap). Server-side validation still owns
 *  the count cap (`AGENT_PROFILE_LIMITS.skills`) and the final say on each
 *  entry — this just keeps the CLI from sending obviously-wrong tokens
 *  (`/foo` verbatim, duplicate whitespace) that the webview would never
 *  produce either. */
function normalizeSkillList(raw: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const r of raw) {
    const name = normalizeSkillName(r);
    if (name && !seen.has(name)) {
      seen.add(name);
      normalized.push(name);
    }
  }
  return normalized;
}

function label(s: string): string {
  return c.dim(s + ":");
}

function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Read `--instructions-file` (a real path, or `-` for stdin) when given,
 *  else pass `--instructions` through verbatim, else `undefined` (caller
 *  decides the "unset" behavior — `""` on create, "don't touch" on edit). */
async function resolveInstructions(f: AgentProfileFlags): Promise<string | undefined> {
  if (f.instructionsFile !== undefined) {
    return f.instructionsFile === "-"
      ? (await Bun.stdin.text()).trim()
      : readFileSync(f.instructionsFile, "utf8");
  }
  return f.instructions;
}

export interface AgentProfileFlags {
  name?: string;
  harness?: string;
  model?: string;
  effort?: string;
  mode?: string;
  fast?: boolean;
  maxMode?: boolean;
  instructions?: string;
  instructionsFile?: string;
  skills: string[];
  clearSkills?: boolean;
}

/** Pure flag parser for `agetor agent add|edit` — no I/O (the
 *  `--instructions-file`/stdin read happens in `resolveInstructions`, kept
 *  out of here so this stays unit-testable without touching the filesystem,
 *  mirroring `parseHarnessFlags`). */
export function parseAgentProfileFlags(args: string[]): AgentProfileFlags {
  const f: AgentProfileFlags = { skills: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = (allowDash = false) => flagValue(args, ++i, a, allowDash);
    switch (a) {
      case "--name": f.name = val(); break;
      case "--harness": f.harness = val(); break;
      case "--model": f.model = val(); break;
      case "--effort": f.effort = val(); break;
      case "--mode": f.mode = val(); break;
      case "--fast": f.fast = true; break;
      case "--no-fast": f.fast = false; break;
      case "--max-mode": f.maxMode = true; break;
      case "--no-max-mode": f.maxMode = false; break;
      case "--instructions": f.instructions = val(); break;
      case "--instructions-file": f.instructionsFile = val(true); break;
      case "--skill": f.skills.push(val()); break;
      case "--clear-skills": f.clearSkills = true; break;
      default: break;
    }
  }
  return f;
}
