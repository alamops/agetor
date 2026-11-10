import { DEFAULT_MODEL, type HarnessLimitState, type HarnessQuota, type HarnessStack, type MirrorPlan, type MirrorPreview, type Task } from "../shared/types.ts";
import { memberStateText, quotaSummary } from "../shared/harness-stack.ts";
import { escapeControlChars, escapeFreeText } from "../shared/terminal-text.ts";
import { c, out } from "./output.ts";

/** Every cooldown row of one account: there can be an account-wide row and one
 *  per model, so callers never assume one row per harness id. */
export function limitRowsFor(states: readonly HarnessLimitState[], harnessId: string): HarnessLimitState[] {
  return states.filter((s) => s.harnessId === harnessId);
}

/** `usage limit until <time>[ for <model>]` — the reason and reset of one row,
 *  worded by the shared {@link memberStateText}. Model ids are escaped. */
export function coolingText(state: HarnessLimitState): string {
  const t = memberStateText(state);
  const model = t.model ? ` for ${escapeControlChars(t.model)}` : "";
  return `${t.reasonText} until ${new Date(t.until).toLocaleString()}${model}`;
}

/** Whether the account is cooling for a task on `model`: an account-wide row
 *  always counts, a per-model row only when the task's model matches. */
export function isCoolingFor(
  states: readonly HarnessLimitState[],
  harnessId: string,
  model: string | null,
): boolean {
  const want = model?.toLowerCase() ?? null;
  return limitRowsFor(states, harnessId).some(
    (s) => !s.model || (want !== null && s.model.toLowerCase() === want),
  );
}

/** What `ls` and the TUI header flag about a task's stack state, one rule for
 *  both: the current account cooling for the task's model (or account-wide),
 *  every account failed, or a scheduled switch to the next account. */
export interface StackMarkers {
  cooling: boolean;
  exhausted: "out of quota" | "blocked: no usable account" | null;
  scheduledSwitch: boolean;
}

export function stackMarkers(
  task: Pick<Task, "agent" | "model" | "column" | "harnessState">,
  stack: Pick<HarnessStack, "kind"> | undefined,
  limitStates: readonly HarnessLimitState[],
): StackMarkers {
  const hs = task.harnessState;
  const exhausted = hs?.allExhausted
    ? (hs.allExhausted.reason === "no-usable-member" ? "blocked: no usable account" : "out of quota")
    : null;
  const cooling = !exhausted && stack !== undefined && task.column !== "done"
    && isCoolingFor(limitStates, task.agent, task.model ?? DEFAULT_MODEL[stack.kind]);
  return { cooling, exhausted, scheduledSwitch: Boolean(hs?.scheduledSwitch) };
}

function ageText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/** Compact per-account quota: `5-hour 42% · Weekly 10% (3m ago)`, `stale`
 *  appended past the failover's 20-minute cutoff. Empty when no snapshot. */
export function quotaText(quota: HarnessQuota | null | undefined, now: number = Date.now()): string {
  const s = quotaSummary(quota, now);
  if (s.status === "missing") return "";
  const meters = s.meters.map((m) => `${escapeControlChars(m.label)} ${Math.round(m.usedPercent)}%`).join(" · ");
  const age = s.ageMs === null ? "age unknown" : ageText(s.ageMs);
  const body = meters || `quota ${s.status}`;
  return `${body} (${age}${s.stale ? ", stale" : ""})`;
}

const SAMPLE = 3;

function pathList(label: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, SAMPLE).map((p) => escapeControlChars(p)).join(", ");
  const more = paths.length > SAMPLE ? ` (+${paths.length - SAMPLE} more)` : "";
  return `${label} ${paths.length}: ${shown}${more}`;
}

function printPlan(plan: MirrorPlan): void {
  out(`  ${c.bold(escapeControlChars(plan.label))} ${c.gray(escapeControlChars(plan.harnessId))}`);
  const lines = [
    pathList("files added", plan.files.add),
    pathList("files updated", plan.files.update),
    pathList("files removed", plan.files.remove),
  ].filter((l): l is string => l !== null);
  for (const l of lines) out(`    ${l}`);
  const shownKeys = plan.keys.slice(0, 10);
  for (const k of shownKeys) {
    out(`    key ${escapeControlChars(k.file)}: ${escapeControlChars(k.key)} (${k.action})`);
  }
  if (plan.keys.length > shownKeys.length) out(`    … ${plan.keys.length - shownKeys.length} more keys`);
  const backed = pathList("backed up first", plan.backups);
  if (backed) out(`    ${c.yellow(backed)}`);
  const kept = pathList("kept (edited on the backup)", plan.kept);
  if (kept) out(`    ${kept}`);
  for (const w of plan.warnings) out(`    ${c.yellow("!")} ${escapeFreeText(w)}`);
  if (lines.length === 0 && plan.keys.length === 0 && plan.warnings.length === 0) out(c.dim("    no changes"));
}

/** The mirror dry run, per backup account. Names only — the core never sends
 *  values. Everything printed is escaped. */
export function printMirrorPreview(preview: MirrorPreview): void {
  if (preview.plans.length === 0) {
    out(c.dim("mirror: no backup accounts to copy to"));
    return;
  }
  out(c.bold("mirror preview:"));
  for (const plan of preview.plans) printPlan(plan);
}
