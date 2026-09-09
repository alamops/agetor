import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { out } from "../output.ts";
import { usageError } from "../usage.ts";

/**
 * `agetor resume <task-id> [--cancel]` — continue an fx response the Vercel
 * AI Gateway (or another recoverable provider error) paused mid-turn
 * (`docs/plans/fix-fx-harness-rate-limit.md`). Sends no new prompt: the
 * server spawns a fresh run in the task's existing fx session with
 * `_meta.fx.continueRecovery: true`, resuming from fx's own checkpoint
 * rather than replaying the original message. Mirrors `cmdFiles`'
 * resolve-then-render shape; API errors (bad task, not fx, not paused, a
 * run already in flight, or fx's own rejection of the continue) propagate
 * from `client.resumeFxRecovery` exactly like every other command here —
 * `main()`'s top-level catch prints them.
 *
 * `--cancel` (`docs/plans/fx-recovery-follow-ups.md` §3.4) instead calls off
 * a pending automatic resume without resuming the paused response itself —
 * the task stays paused. `--json` and `--cancel` never combine with the
 * resume request; only one of the two branches runs.
 */
export async function cmdResume(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  const cancel = args.includes("--cancel");
  if (!ref) throw usageError("resume");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);

  if (cancel) {
    const res = await client.cancelFxAutoResume(task.id);
    if (flags.json) return out(JSON.stringify(res));
    out(`■ auto-resume cancelled for ${task.id.slice(0, 8)}`);
    return;
  }

  const res = await client.resumeFxRecovery(task.id);

  if (flags.json) return out(JSON.stringify(res));

  out(`▸ resuming paused fx response for ${task.id.slice(0, 8)} (run ${res.runId.slice(0, 8)})`);
}
