import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { out } from "../output.ts";
import { usageError } from "../usage.ts";

/**
 * `agetor resume <task-id>` — continue an fx response the Vercel AI Gateway
 * (or another recoverable provider error) paused mid-turn (`docs/plans/
 * fix-fx-harness-rate-limit.md`). Sends no new prompt: the server spawns a
 * fresh run in the task's existing fx session with
 * `_meta.fx.continueRecovery: true`, resuming from fx's own checkpoint
 * rather than replaying the original message. Mirrors `cmdFiles`'
 * resolve-then-render shape; API errors (bad task, not fx, not paused, a
 * run already in flight, or fx's own rejection of the continue) propagate
 * from `client.resumeFxRecovery` exactly like every other command here —
 * `main()`'s top-level catch prints them.
 */
export async function cmdResume(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("resume");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const res = await client.resumeFxRecovery(task.id);

  if (flags.json) return out(JSON.stringify(res));

  out(`▸ resuming paused fx response for ${task.id.slice(0, 8)} (run ${res.runId.slice(0, 8)})`);
}
