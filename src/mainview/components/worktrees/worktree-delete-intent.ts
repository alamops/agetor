import type { WorktreeGitStatus, WorktreeInfo, WorktreeTeardownResult } from "../../../shared/types.ts";

/**
 * What the "Archive & delete" confirm dialog should say for a given row, given
 * its freshly-fetched git status. The copy is driven by a three-state dirty
 * classification crossed with whether the task is already archived (the
 * "will be archived" phrasing is simply wrong for a row that's already in
 * that state) — the two axes can co-occur, so this is a small cross-product
 * rather than a single flag.
 *
 * The dirty classification's three states are mutually exclusive and
 * exhaustive:
 *  - confirmed-clean: `status` resolved and reports no uncommitted changes.
 *    No warning.
 *  - confirmed-dirty: `status` resolved and reports uncommitted changes.
 *    The existing red "will be discarded" warning.
 *  - unknown: `status` is `null` (the pre-confirm `getWorktreeGitStatus` call
 *    threw) OR `status.ignored` is `true` (the dir wasn't inspectable — not a
 *    git repo, or `git status` itself failed, e.g. a broken/pruned worktree
 *    registration). Critically, `deleteTaskBacked` sends `forceWorktree: true`
 *    unconditionally, so an unknown status still force-deletes — we just
 *    can't tell the user whether that's discarding anything. Treating
 *    "unknown" the same as "confirmed clean" would silently drop this
 *    warning in exactly the case `forceWorktree` exists to unstick (a
 *    worktree whose git registration is broken), which is how uncommitted
 *    work gets lost with no red flag ever shown. So "unknown" gets its own,
 *    harder-worded warning instead of falling back to silence.
 */
export interface DeleteConfirmCopy {
  title: string;
  /** True only for confirmed-dirty: `status` resolved and reports real
   *  uncommitted changes worth calling out. */
  showDirtyWarning: boolean;
  /** True for the unknown state: agetor could not determine whether the
   *  checkout is dirty, but is still about to force-delete it. */
  unknown: boolean;
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
 * dependency); it reads `alreadyArchived`/`showDirtyWarning`/`unknown` off the
 * result.
 */
export function buildDeleteConfirmCopy(w: WorktreeInfo, status: WorktreeGitStatus | null): DeleteConfirmCopy {
  const unknown = status == null || status.ignored === true;
  const dirty = !unknown && status!.dirty === true;
  const alreadyArchived = w.archivedAt != null;
  return {
    title: `Delete worktree "${w.branch ?? w.id}"?`,
    showDirtyWarning: dirty,
    unknown,
    alreadyArchived,
    confirmLabel: dirty || unknown ? "Discard changes & delete" : "Archive & delete",
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
