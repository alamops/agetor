import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { ApiError } from "../api-client.ts";
import { usageError } from "../usage.ts";
import type { HarnessMemberReason, HarnessStack } from "../../shared/types.ts";
import { memberReasonText, stackPositionText } from "../../shared/harness-stack.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";

/**
 * `agetor switch-account <task> [--cancel]` (D12): move a stacked task to the
 * next usable account. An idle task moves now; a live run schedules the move
 * for the end of the turn. `--cancel` drops a scheduled switch.
 */
export async function cmdSwitchAccount(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref || ref.startsWith("-")) throw usageError("switch-account");
  let cancel = false;
  for (const a of args.slice(1)) {
    if (a === "--cancel") cancel = true;
    else throw new Error(`unknown flag ${escapeControlChars(a)}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const short = task.id.slice(0, 8);

  if (cancel) {
    const result = await client.cancelScheduledAccountSwitch(task.id);
    if (flags.json) return printJson(result);
    out(`${c.gray("cancelled")} the scheduled account switch on ${c.dim(short)}`);
    return;
  }

  let result;
  try {
    result = await client.switchTaskAccount(task.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw refusal(e);
    throw e;
  }
  if (flags.json) return printJson(result);
  if (result.status === "scheduled") {
    out(
      `${c.cyan("⇄")} switch to the next account scheduled for the end of this turn ` +
        `(agetor switch-account ${short} --cancel to undo)`,
    );
    return;
  }
  const agent = result.task.agent;
  let stack: HarnessStack | undefined;
  if (typeof client.listHarnessStacks === "function") {
    const payload = await client.listHarnessStacks().catch(() => null);
    stack = payload?.stacks.find((s) => s.members.some((m) => m.harnessId === agent));
  }
  const member = stack?.members.find((m) => m.harnessId === agent);
  const pos = stack ? stackPositionText(stack, agent) : null;
  out(
    `${c.green("✓")} switched to ${c.bold(escapeFreeText(member?.label ?? agent))}` +
      `${pos ? ` (${pos})` : ""} — continuing this conversation`,
  );
}

/** A 409 from the route. When it carries member reasons the error text already
 *  embeds them, so print a fixed heading plus one escaped line per reason;
 *  without reasons print the error itself. The central error printer escapes
 *  again; escaping here keeps the text safe when shown another way. */
function refusal(e: ApiError): Error {
  const body = (e.body ?? {}) as { reasons?: HarnessMemberReason[] };
  const reasons = Array.isArray(body.reasons) ? body.reasons : [];
  if (reasons.length === 0) return new Error(escapeFreeText(e.message));
  const lines = [
    "no other account in the stack can take this task:",
    ...reasons.map((r) => `  - ${escapeFreeText(memberReasonText(r))}`),
  ];
  return new Error(lines.join("\n"));
}
