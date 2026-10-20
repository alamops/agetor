/**
 * Session memory for the pipeline pages' scroll state
 * (`docs/plans/board-scroll-position.md`).
 *
 * `App.tsx` swaps whole pages under `<AnimatePresence mode="wait">`, so the
 * Pipelines list and the run view remount on every visit and their scrollers
 * come back at the top. This module keeps:
 *
 * - The Pipelines list's one vertical offset (D11), saved from its
 *   `onScroll` and written back once the list has loaded.
 * - Per pipeline task, the run view's side panel: its offset, restored only
 *   while the run looks the same as when the user left
 *   (`pipelineRunPanelSignature`, D12/D13), plus the Goal toggle and the
 *   expanded history rows, which always come back (D14). Rows are keyed by
 *   run generation + `seq` (`historyExpansionKey`), so after a Restart every
 *   row starts collapsed.
 *
 * Module state only, never `localStorage`: a reload starts at the top (D2).
 * The per-task map is an LRU bounded by `PIPELINE_RUN_PANEL_MEMORY_MAX`;
 * task ids are never reused, so a deleted task's entry simply ages out.
 * No React import — unit-tested with `bun test`.
 */
import type { PipelineRunState, Task } from "../../shared/types.ts";

/** How many pipeline tasks' side-panel state is remembered at once. */
export const PIPELINE_RUN_PANEL_MEMORY_MAX = 200;

interface PanelMemory {
  top: number;
  /** The signature of the run as the user last saw it, or `null` before
   *  the panel was first shown. */
  signature: string | null;
  goalOpen: boolean;
  expanded: Set<string>;
}

let listTop = 0;
const panels = new Map<string, PanelMemory>();

/** Get-or-create a task's entry for a write, refreshing its recency and
 *  evicting the least recently written entries past the cap. Reads never
 *  come through here, so they never create entries. */
function writable(taskId: string): PanelMemory {
  const existing = panels.get(taskId);
  const entry = existing ?? { top: 0, signature: null, goalOpen: false, expanded: new Set<string>() };
  panels.delete(taskId);
  panels.set(taskId, entry);
  if (!existing) {
    while (panels.size > PIPELINE_RUN_PANEL_MEMORY_MAX) {
      const oldest = panels.keys().next().value;
      if (oldest === undefined) break;
      panels.delete(oldest);
    }
  }
  return entry;
}

/** The Pipelines list's saved scroll offset (`0` until first scrolled). */
export function pipelinesListScrollTop(): number {
  return listTop;
}

/** Remember the Pipelines list's offset — called from its `onScroll`. */
export function savePipelinesListScrollTop(top: number): void {
  listTop = top;
}

/** What the side panel's top content depends on, as one comparable string:
 *  the run generation (`startedAt`), its status, how many history rows it
 *  has, its blocks and its active executions — each flagged when its step
 *  task sits in `review` (the "Awaiting review" card). Order-sensitive. An
 *  unchanged signature means the panel would render the same rows in the
 *  same places, so the saved offset still points where the user left. */
export function pipelineRunPanelSignature(
  run: PipelineRunState,
  steps: readonly Pick<Task, "id" | "column">[],
): string {
  return JSON.stringify([
    run.startedAt,
    run.status,
    run.history.length,
    run.blocked.map((b) => [b.kind, b.stepId, b.taskId]),
    run.active.map((a) => [a.stepId, a.taskId, steps.find((s) => s.id === a.taskId)?.column === "review"]),
  ]);
}

/** A history row's identity across visits AND run generations — its
 *  expansion key and its React `key`, so a Restart (new `startedAt`) starts
 *  every row collapsed. */
export function historyExpansionKey(startedAt: number | null, seq: number): string {
  return `${startedAt ?? "none"}:${seq}`;
}

/** Decide, once per panel mount, where the side panel starts: the saved
 *  offset when the run's signature is the one the user last saw, else
 *  `null` (start at the top) — and then the stored offset is reset to `0`,
 *  so a later unchanged visit can't bring back a stale one. Either way the
 *  current signature becomes the one the user has seen. */
export function resolvePipelineRunPanelScroll(taskId: string, signature: string): number | null {
  const entry = writable(taskId);
  const top = entry.signature === signature ? entry.top : null;
  if (top === null) entry.top = 0;
  entry.signature = signature;
  return top;
}

/** Record the run's signature as the one the user is now looking at (the
 *  panel is mounted and the run changed under it). */
export function notePipelineRunPanelSignature(taskId: string, signature: string): void {
  writable(taskId).signature = signature;
}

/** Remember the side panel's offset — called from its `onScroll`. */
export function savePipelineRunPanelScroll(taskId: string, top: number): void {
  writable(taskId).top = top;
}

/** Whether the run view's Goal section was left open for this task. */
export function pipelineRunGoalOpen(taskId: string): boolean {
  return panels.get(taskId)?.goalOpen ?? false;
}

/** Remember the Goal toggle for this task. */
export function setPipelineRunGoalOpen(taskId: string, open: boolean): void {
  writable(taskId).goalOpen = open;
}

/** Whether this history row (`historyExpansionKey`) was left expanded. */
export function isHistoryRowExpanded(taskId: string, key: string): boolean {
  return panels.get(taskId)?.expanded.has(key) ?? false;
}

/** Remember a history row's expansion for this task. */
export function setHistoryRowExpanded(taskId: string, key: string, expanded: boolean): void {
  const entry = writable(taskId);
  if (expanded) entry.expanded.add(key);
  else entry.expanded.delete(key);
}

/** Reset the module state between unit tests. */
export function resetPipelineScrollMemoryForTest(): void {
  listTop = 0;
  panels.clear();
}
