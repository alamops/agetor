import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";

/**
 * List the slash commands and MCP/skill extensions available to a task's agent
 * in its workdir — the CLI view of the app composer's `/` and `@` autocomplete.
 */
export async function cmdCommands(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("commands");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const workdir = task.worktreePath ?? task.workdir;
  const { commands, extensions } = await client.agentDiscovery(
    task.agent ?? "claude-code",
    workdir,
    task.branch,
  );

  if (flags.json) return printJson({ commands, extensions });
  if (commands.length === 0 && extensions.length === 0) {
    out(c.dim("no slash commands or extensions discovered for this agent / workdir"));
    return;
  }
  if (commands.length) {
    out(c.bold(`Slash commands (${commands.length})`));
    for (const cmd of commands) {
      const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
      out(`  ${c.cyan(name)}  ${c.dim(brief(cmd.description))}`);
    }
  }
  if (extensions.length) {
    if (commands.length) out("");
    out(c.bold(`Extensions (${extensions.length})`));
    for (const e of extensions) out(`  ${c.cyan(e.insert)}  ${c.dim(brief(e.description || e.kind))}`);
  }
}

/** One-line, length-capped description — collapse whitespace so multi-line
 *  skill blurbs don't wreck the list. */
function brief(s: string, n = 72): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}
