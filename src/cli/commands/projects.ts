import { readFileSync } from "node:fs";
import path from "node:path";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";
import { usageError } from "../usage.ts";
import { asProfileError, matchAgentProfileRef } from "../../shared/agent-profile.ts";
import type { AgentProfile, IssueTaskTemplate } from "../../shared/types.ts";

export async function cmdProjects(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  const client = await getClient(flags);
  switch (sub) {
    case "ls":
    case "list": {
      const projects = await client.listProjects();
      if (flags.json) return printJson(projects);
      if (projects.length === 0) {
        out(c.dim("no projects registered"));
        return;
      }
      out(table(["name", "path"], projects.map((pr) => [c.bold(pr.name), c.dim(pr.path)])));
      return;
    }
    case "add": {
      const target = args[1];
      if (!target || target.startsWith("-")) {
        throw usageError("projects add");
      }
      let name: string | undefined;
      for (let i = 2; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--name") name = flagValue(args, ++i, a);
      }
      const project = await client.addProject(path.resolve(target), name);
      if (flags.json) return printJson(project);
      out(`${c.green("✓")} registered ${c.bold(project.name)} ${c.dim(project.path)}`);
      return;
    }
    case "rm":
    case "remove": {
      const target = args[1];
      if (!target) throw usageError("projects");
      const abs = path.resolve(target);
      await client.removeProject(abs);
      if (flags.json) return printJson({ removed: abs });
      out(`${c.gray("removed")} ${c.dim(abs)}`);
      return;
    }
    case "branches": {
      const target = args[1];
      if (!target) throw usageError("projects");
      const branches = await client.listBranches(path.resolve(target));
      if (flags.json) return printJson(branches);
      if (branches.length === 0) {
        out(c.dim("no branches"));
        return;
      }
      for (const b of branches) {
        const marker = b.current ? c.green("* ") : "  ";
        out(`${marker}${b.remote ? c.dim(b.name) : b.name}`);
      }
      return;
    }
    case "issue-template": {
      const target = args[1];
      if (!target || target.startsWith("-")) throw usageError("projects issue-template");
      const abs = path.resolve(target);
      // Parse before any network call, so a bad flag never half-applies.
      const f = parseIssueTemplateFlags(args.slice(2));
      const current = await client.getIssueTaskTemplate(abs);
      if (!f.clear && f.prompt === undefined && f.promptFile === undefined && f.profile === undefined && !f.noProfile) {
        if (flags.json) return printJson(current);
        printIssueTemplate(current, await client.listAgentProfiles().catch(() => [] as AgentProfile[]));
        return;
      }
      let next: IssueTaskTemplate | null = null;
      let profiles: AgentProfile[] = [];
      if (!f.clear) {
        const prompt =
          f.promptFile !== undefined
            ? f.promptFile === "-" ? await Bun.stdin.text() : readFileSync(f.promptFile, "utf8")
            : f.prompt;
        let agentProfileId: string | null | undefined;
        if (f.profile !== undefined) {
          profiles = await client.listAgentProfiles();
          const result = matchAgentProfileRef(profiles, f.profile);
          if ("error" in result) throw new Error(asProfileError(result.error));
          agentProfileId = result.profile.id;
        } else if (f.noProfile) {
          agentProfileId = null;
        }
        next = mergeIssueTemplate(current, { prompt, agentProfileId });
      }
      const project = await client.setIssueTaskTemplate(abs, next);
      if (flags.json) return printJson(project.issueTaskTemplate);
      if (!project.issueTaskTemplate) {
        out(`${c.green("✓")} issue template cleared for ${c.bold(project.name)} ${c.dim("(issues use the built-in prompt)")}`);
        return;
      }
      out(`${c.green("✓")} issue template saved for ${c.bold(project.name)}`);
      if (profiles.length === 0) profiles = await client.listAgentProfiles().catch(() => [] as AgentProfile[]);
      printIssueTemplate(project.issueTaskTemplate, profiles);
      return;
    }
    default:
      throw new Error(`unknown projects subcommand: ${sub} (use ls | add | rm | branches | issue-template)`);
  }
}

export interface IssueTemplateFlags {
  prompt?: string;
  /** A path, or `-` for stdin. */
  promptFile?: string;
  /** Profile id or (unique, case-insensitive) name. */
  profile?: string;
  noProfile?: boolean;
  clear?: boolean;
}

/**
 * Pure flag parser for `agetor projects issue-template <path> …` — no I/O
 * (the `--prompt-file`/stdin read and the `--profile` lookup happen in
 * `cmdProjects`). Stricter than the `projects add` loop: an unknown flag or a
 * contradictory pair throws instead of being ignored, because this command
 * WRITES a setting every future issue task inherits — a typo'd flag must not
 * silently save something other than what the caller meant.
 */
export function parseIssueTemplateFlags(args: string[]): IssueTemplateFlags {
  const f: IssueTemplateFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--prompt": f.prompt = flagValue(args, ++i, a); break;
      case "--prompt-file": f.promptFile = flagValue(args, ++i, a, true); break;
      case "--profile": f.profile = flagValue(args, ++i, a); break;
      case "--no-profile": f.noProfile = true; break;
      case "--clear": f.clear = true; break;
      default: throw usageError("projects issue-template");
    }
  }
  if (f.prompt !== undefined && f.promptFile !== undefined) {
    throw new Error("pass either --prompt or --prompt-file, not both");
  }
  if (f.profile !== undefined && f.noProfile) {
    throw new Error("pass either --profile or --no-profile, not both");
  }
  if (f.clear && (f.prompt !== undefined || f.promptFile !== undefined || f.profile !== undefined || f.noProfile)) {
    throw new Error("--clear cannot be combined with other flags");
  }
  return f;
}

/**
 * Apply an `issue-template` edit on top of the stored template: a field the
 * caller didn't pass keeps its current value (`agentProfileId: undefined` =
 * keep, `null` = remove), mirroring `agetor profile edit`. Setting only the
 * profile on a project with no template is an error — there is no prompt to
 * attach it to, and a template can't exist without one.
 */
export function mergeIssueTemplate(
  current: IssueTaskTemplate | null,
  edit: { prompt?: string; agentProfileId?: string | null },
): IssueTaskTemplate {
  const prompt = edit.prompt !== undefined ? edit.prompt.trim() : current?.prompt;
  if (!prompt) {
    throw new Error(
      edit.prompt !== undefined
        ? "the template prompt is empty"
        : "this project has no issue template yet — pass --prompt or --prompt-file",
    );
  }
  const agentProfileId = edit.agentProfileId !== undefined ? edit.agentProfileId : (current?.agentProfileId ?? null);
  return { prompt, agentProfileId };
}

function printIssueTemplate(template: IssueTaskTemplate | null, profiles: AgentProfile[]): void {
  if (!template) {
    out(c.dim("no issue template (issues start from the built-in prompt)"));
    return;
  }
  const id = template.agentProfileId;
  const profile = id ? profiles.find((p) => p.id === id) : undefined;
  const agent = !id ? c.dim("none") : profile ? `${profile.name} ${c.dim(`(${id})`)}` : `${id} ${c.yellow("(missing)")}`;
  out(`${c.dim("agent:")}  ${agent}`);
  out(c.dim("prompt:"));
  out(template.prompt);
}
