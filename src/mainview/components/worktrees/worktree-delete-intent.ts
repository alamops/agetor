import type { WorktreeGitStatus, WorktreeInfo, WorktreeTeardownResult } from "../../../shared/types.ts";

/**
 * What the "Archive & delete" confirm dialog should say for a given row, given
 * its freshly-fetched git status. Two independent facts change the copy —
 * whether the checkout is dirty (uncommitted work is about to be discarded)
 * and whether the task is already archived (the "will be archived" phrasing
 * is simply wrong for a row that's already in that state) — and they can
 * co-occur, so this is a small cross-product rather than a single flag.
 * `status: null` means the git-status fetch failed or hasn't resolved; we
 * fall back to the no-warning copy rather than block the delete on it.
 */
export interface DeleteConfirmCopy {
  title: string;
  /** True when the checkout has uncommitted changes worth calling out. */
  showDirtyWarning: boolean;
  /** True when the task is already archived — the body copy must not repeat
   *  "will be archived" for a ticket that already is. */
  alreadyArchived: boolean;
  confirmLabel: string;
}

/**
 * Pure decision logic for `deleteTaskBacked`'s confirm dialog. Kept out of the
 * component (which has no render tests in this app) so the branching itself
 * is unit-testable — see `github-dialog-view.ts` for the same idiom. The JSX
 * description itself still lives in the component (this module has no React
 * dependency); it reads `alreadyArchived`/`showDirtyWarning` off the result.
 */
export function buildDeleteConfirmCopy(w: WorktreeInfo, status: WorktreeGitStatus | null): DeleteConfirmCopy {
  const dirty = status != null && status.dirty === true && !status.ignored;
  const alreadyArchived = w.archivedAt != null;
  return {
    title: `Delete worktree "${w.branch ?? w.id}"?`,
    showDirtyWarning: dirty,
    alreadyArchived,
    confirmLabel: dirty ? "Discard changes & delete" : "Archive & delete",
  };
}

/** Outcome of triaging a `WorktreeTeardownResult` (or its absence) into
 *  something the UI can act on: either nothing to say (the row disappearing
 *  on refresh IS the feedback, per house convention for destructive list
 *  mutations) or a message worth toasting. */
export type DeleteOutcome = { kind: "silent" } | { kind: "error"; message: string };

/**
 * Decide whether an archive's `teardown` result is a success or a failure
 * worth surfacing. `removed: true` is the obvious success; `"no-worktree"`
 * and `"already-absent"` are *also* success — there was simply nothing left
 * to remove, which is not a failure of this action. `"dirty"` shouldn't occur
 * given we always pass `forceWorktree: true`, but the server can still report
 * it (e.g. a race), so it's treated as a real failure rather than swallowed.
 * `undefined` means the caller didn't request `awaitTeardown` (or the server
 * predates it) — nothing to report, so treat it as silent success and let the
 * list refresh speak for itself.
 */
export function triageDeleteOutcome(teardown: WorktreeTeardownResult | undefined, branch: string | null): DeleteOutcome {
  if (teardown === undefined) return { kind: "silent" };
  if (teardown.removed) return { kind: "silent" };
  const name = branch ?? "this worktree";
  switch (teardown.reason) {
    case "no-worktree":
    case "already-absent":
      return { kind: "silent" };
    case "dirty":
      return {
        kind: "error",
        message: `Couldn't delete ${name}: it still has uncommitted changes.`,
      };
    case "failed":
    default:
      return {
        kind: "error",
        message: `Couldn't delete ${name}: the worktree removal failed. Try again or remove it manually.`,
      };
  }
}
