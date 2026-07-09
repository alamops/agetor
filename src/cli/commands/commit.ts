import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { resumableRunId } from "../run-logic.ts";
import { c, out, printJson } from "../output.ts";
import { COMMIT_PUSH_PROMPT } from "../../shared/types.ts";
import { usageError } from "../usage.ts";

/**
 * One-shot "commit & push": ask the agent to commit all changes and push the
 * branch, using the exact prompt the webview's Commit & push chip sends
 * (COMMIT_PUSH_PROMPT). Resumes the session like `agetor send`.
 */
export async function cmdCommit(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("commit");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const short = task.id.slice(0, 8);
  if (task.archivedAt != null) {
    throw new Error("task is archived — unarchive it before committing");
  }
  // Committing mid-turn is supported: the prompt folds into the in-flight run
  // via the same paste-follow-up path as `agetor send`. Since #92, a task can
  // also sit in column "running" long after the background agent's run has
  // actually succeeded — column no longer implies a turn is in flight — so
  // there's no column-based guard here.
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
    note = commitNote(await client.getGitStatus(task.id));
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

/** The best-effort heads-up appended to the success line. Empty in the normal
 *  case (uncommitted changes present); `ignored` (not a git repo) wins over a
 *  clean tree. A clean tree with nothing ahead of upstream means there's
 *  nothing for the prompt to do at all. Pure so the note contract can be
 *  unit-tested. */
export function commitNote(git: { hasChanges: boolean; ahead?: number; ignored?: boolean }): string {
  if (git.ignored) return " (not a git worktree)";
  if (!git.hasChanges) {
    return (git.ahead ?? 0) > 0 ? " (working tree clean — push only)" : " (nothing to commit or push)";
  }
  return "";
}
