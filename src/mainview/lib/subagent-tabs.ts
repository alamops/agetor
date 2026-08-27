/**
 * Pure derivation logic for the run panel's background/sub-agent tab strip.
 * Kept DOM-free (like event-dedup.ts / event-buffer.ts) so it can be unit
 * tested with `bun test` — the repo has no jsdom/testing-library, so component
 * behaviour is validated by testing the logic the component drives.
 */
import type { Subagent } from "../../shared/types.ts";

/** Max tabs rendered before the rest collapse behind a "+N" affordance. */
export const MAX_VISIBLE_TABS = 6;

/**
 * A Claude Code Workflow's container row (`parentKind: "workflow"`) has no
 * event stream of its own — it exists only to hold the task in `running` for
 * the workflow's lifetime — so it never becomes a tab. Every other row
 * (`"subagent"`, `"bg_session"`, `"monitor"` — a Claude Code Monitor whose tab
 * streams its events — and `"workflow_agent"` — one agent inside a workflow, a
 * normal sidechain transcript) is tabbable.
 */
function isTabbable(s: Subagent): boolean {
  return s.parentKind !== "workflow";
}

/**
 * A running workflow container still counts as "running" here — the workflow
 * is genuinely working between agent waves even though it has no tab. Do not
 * filter containers out of this predicate.
 */
export function anySubagentRunning(subs: Subagent[]): boolean {
  return subs.some((s) => s.status === "running");
}

/**
 * Tabs are shown only while background agents are *active*: at least one
 * subagent is running, or the parent turn is still running (so a just-finished
 * subagent stays readable until the turn resolves). Once nothing is running the
 * strip collapses back to a plain single-stream log.
 *
 * The "is there anything to show" gate counts only tabbable rows (a workflow
 * container alone shouldn't pop an empty strip), but the "is something still
 * active" check runs over the full list — a running container keeps the strip
 * open around the finished tabs from a prior wave, same as `parentRunRunning`
 * would.
 */
export function shouldShowSubagentTabs(subs: Subagent[], parentRunRunning: boolean): boolean {
  const tabbable = subs.filter(isTabbable);
  return tabbable.length > 0 && (anySubagentRunning(subs) || parentRunRunning);
}

/**
 * Resolve which stream should be active given the current selection. Falls back
 * to "main" when the strip is hidden or the selected subagent no longer exists,
 * so the log + composer can never be stranded on a vanished/hidden tab. A
 * workflow container is never a valid stream to land on (it has none).
 */
export function resolveActiveStream(active: string, show: boolean, subs: Subagent[]): string {
  if (active === "main") return "main";
  if (!show) return "main";
  return subs.filter(isTabbable).some((s) => s.id === active) ? active : "main";
}

/**
 * Order tabs so the *active* (running) agents sit first, immediately after the
 * pinned "Main" tab, with finished ones trailing behind. Within each group the
 * incoming spawn order is preserved, so a tab only ever moves across the
 * running→finished boundary — never shuffles among its peers.
 *
 * Returns a NEW array: the caller passes React state (`subagentList`) straight
 * in, and an in-place `.sort()` would mutate it. Workflow container rows are
 * dropped here — this is the single choke point every tab-producing caller
 * (`SubagentTabs` → `splitTabsForOverflow`) runs through, so filtering here is
 * enough for the whole render path to exclude them.
 */
export function sortSubagentTabs(subs: Subagent[]): Subagent[] {
  const running: Subagent[] = [];
  const finished: Subagent[] = [];
  for (const s of subs) {
    if (!isTabbable(s)) continue;
    (s.status === "running" ? running : finished).push(s);
  }
  return [...running, ...finished];
}

/**
 * Split tabs into an always-visible head + an overflow tail for the "+N" pill.
 * The incoming order is preserved (callers pass a `sortSubagentTabs`-ordered
 * list), and a running agent or the currently-active tab is never pushed into
 * overflow (you should always see what's live and what you're looking at) — so
 * `visible` can exceed `limit` when many agents run at once.
 */
export function splitTabsForOverflow(
  subs: Subagent[],
  active: string,
  limit: number = MAX_VISIBLE_TABS,
): { visible: Subagent[]; overflow: Subagent[] } {
  if (subs.length <= limit) return { visible: [...subs], overflow: [] };
  const forced = new Set<string>();
  for (const s of subs) if (s.status === "running") forced.add(s.id);
  if (active !== "main") forced.add(active);

  const visible: Subagent[] = [];
  const overflow: Subagent[] = [];
  for (const s of subs) {
    if (forced.has(s.id) || visible.length < limit) visible.push(s);
    else overflow.push(s);
  }
  return { visible, overflow };
}
