import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { resumableRunId } from "../run-logic.ts";
import { c, out, printJson } from "../output.ts";
import { commitPushPrompt } from "../../shared/types.ts";
import { usageError } from "../usage.ts";

/**
 * One-shot "commit & push": ask the agent to commit all changes and push the
 * branch, using the exact prompt the webview's Commit & push chip sends
 * (commitPushPrompt). Resumes the session like `agetor send`.
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
  // Match the webview, which only offers Commit & push when the run is idle:
  // committing mid-turn would fold the prompt into the in-flight work and could
  // capture half-finished changes.
  if (task.column === "running") {
    throw new Error(`task is still working — commit after it finishes (watch it with 'agetor logs ${short}')`);
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
    note = commitNote(await client.getGitStatus(task.id));
  } catch {
    /* git-status is advisory — never blocks the request */
  }

  const res = await client.sendInput(runId, commitPushPrompt(task));
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
 *  clean tree. Pure so the note contract can be unit-tested. */
export function commitNote(git: { hasChanges: boolean; ignored?: boolean }): string {
  if (git.ignored) return " (not a git worktree)";
  if (!git.hasChanges) return " (working tree clean — push only)";
  return "";
}
