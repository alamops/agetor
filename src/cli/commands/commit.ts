import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { resumableRunId } from "../run-logic.ts";
import { c, out, printJson } from "../output.ts";
import { COMMIT_PUSH_PROMPT } from "../../shared/types.ts";

/**
 * One-shot "commit & push": ask the agent to commit all changes and push the
 * branch, using the exact prompt the webview's Commit & push chip sends
 * (COMMIT_PUSH_PROMPT). Resumes the session like `agetor send`.
 */
export async function cmdCommit(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor commit <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const short = task.id.slice(0, 8);
  if (task.archivedAt != null) {
    throw new Error("task is archived — unarchive it before committing");
  }
  if (task.pendingInteractionCount > 0) {
    throw new Error(`task is waiting for an answer — respond first with 'agetor answer ${short}'`);
  }
  const runs = task.runId ? [] : await client.getRuns(task.id);
  const runId = resumableRunId(task, runs);
  if (!runId) {
    throw new Error(`task has no run yet — start it first: agetor start ${short}`);
  }

  // Best-effort heads-up so a no-op turn (clean tree) isn't a surprise.
  let note = "";
  try {
    const git = await client.getGitStatus(task.id);
    if (git.ignored) note = " (not a git worktree)";
    else if (!git.hasChanges) note = " (working tree clean — push only)";
  } catch {
    /* git-status is advisory — never blocks the request */
  }

  const res = await client.sendInput(runId, COMMIT_PUSH_PROMPT);
  if (flags.json) {
    return printJson({ delivered: res.delivered !== false, reason: res.reason, note: note.trim() || undefined });
  }
  if (res.delivered === false) {
    out(`${c.red("!")} ${res.reason ?? "not delivered"}`);
    return;
  }
  out(`${c.green("→")} commit & push requested for ${c.dim(short)}${c.dim(note)}`);
}
