import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import { discoveryScopesForTask } from "../../shared/file-scope.ts";

/**
 * List the slash commands and MCP/skill extensions available to a task's agent
 * in its workdir — the CLI view of the app composer's `/` and `@` autocomplete.
 * A multi-repository task unions every repository's scope: the workspace root
 * the agent runs in is not a git repository, so discovery there would list no
 * project-level entries from any selected repository.
 */
export async function cmdCommands(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("commands");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const agent = task.agent;
  // One call per repository; a failed repository contributes nothing so a
  // single broken worktree doesn't hide the others' project-level entries.
  // If every scope fails, surface the first failure (the command's contract
  // before multi support: a discovery error is an error).
  const settled = await Promise.allSettled(
    discoveryScopesForTask(task).map(({ workdir, branch }) =>
      client.agentDiscovery(agent, workdir, branch),
    ),
  );
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (results.length === 0) {
    const first = settled.find((s) => s.status === "rejected");
    throw first && first.status === "rejected" ? first.reason : new Error("agent discovery failed");
  }
  const byCommand = new Map<string, (typeof results)[number]["commands"][number]>();
  const byExtension = new Map<string, (typeof results)[number]["extensions"][number]>();
  for (const result of results) {
    for (const command of result.commands) if (!byCommand.has(command.name)) byCommand.set(command.name, command);
    for (const extension of result.extensions) {
      if (!byExtension.has(extension.insert)) byExtension.set(extension.insert, extension);
    }
  }
  const commands = [...byCommand.values()];
  const extensions = [...byExtension.values()];

  if (flags.json) return printJson({ commands, extensions });
  if (commands.length === 0 && extensions.length === 0) {
    out(c.dim("no slash commands or extensions discovered for this agent / workdir"));
    return;
  }
  if (commands.length) {
    out(c.bold(`Slash commands (${commands.length})`));
    for (const cmd of commands) {
      out(`  ${c.cyan(commandLabel(cmd.name))}  ${c.dim(brief(cmd.description))}`);
    }
  }
  if (extensions.length) {
    if (commands.length) out("");
    out(c.bold(`Extensions (${extensions.length})`));
    for (const e of extensions) out(`  ${c.cyan(e.insert)}  ${c.dim(brief(e.description || e.kind))}`);
  }
}

/** Normalize a discovered command name to its slash form — the discovery source
 *  already includes the leading slash for skills, so don't double it. */
export function commandLabel(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

/** One-line, length-capped description — collapse whitespace so multi-line
 *  skill blurbs don't wreck the list. */
export function brief(s: string, n = 72): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}
