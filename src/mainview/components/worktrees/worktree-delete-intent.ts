import type { WorktreeGitStatus, WorktreeInfo, WorktreeTeardownResult } from "../../../shared/types.ts";

/**
 * What the "Archive & delete" confirm dialog should say for a given row, given
 * its freshly-fetched git status and those of any sibling repository rows. The
 * copy is driven by a three-state dirty classification crossed with whether
 * the task is already archived (the "will be archived" phrasing is simply
 * wrong for a row that's already in that state) — the two axes can co-occur,
 * so this is a small cross-product rather than a single flag.
 *
 * The dirty classification's three states are mutually exclusive and
 * exhaustive PER CHECKOUT:
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
  /** True when at least one checkout about to be force-deleted is confirmed
   *  to have uncommitted changes worth calling out. */
  showDirtyWarning: boolean;
  /** True when agetor could not determine whether at least one checkout
   *  about to be force-deleted is dirty, but is still about to delete it. */
  unknown: boolean;
  /** Labels (repository name when known, else branch/id) of every checkout
   *  confirmed dirty. Empty when none. */
  dirtyCheckouts: string[];
  /** Labels of every checkout whose state couldn't be determined. Empty when
   *  none. */
  unknownCheckouts: string[];
  /** True when the clicked row is a repository checkout of a
   *  multi-repository task (it has siblings, or carries a `repoName` — a
   *  multi task left with one repository has no siblings) — archiving
   *  removes all of them. */
  multiRepo: boolean;
  /** Total checkouts the confirm will force-delete (1 for a single-repo task). */
  checkoutCount: number;
  /** True when the task is already archived — the body copy must not repeat
   *  "will be archived" for a ticket that already is. */
  alreadyArchived: boolean;
  confirmLabel: string;
}

/** Another repository's checkout belonging to the same task as the clicked
 *  row. Archiving the task from any one row force-deletes every one of them,
 *  so the confirm must consider their states too — a clean clicked row must
 *  not silently discard a dirty sibling's uncommitted work. */
export interface SiblingCheckout {
  /** Workspace subdirectory / repository name, used to name it in the warning. */
  name: string;
  /** Freshly-fetched status, or null when the fetch failed. */
  status: WorktreeGitStatus | null;
}

/**
 * Pure decision logic for `deleteTaskBacked`'s confirm dialog. Kept out of the
 * component (which has no render tests in this app) so the branching itself
 * is unit-testable — see `github-dialog-view.ts` for the same idiom. The JSX
 * description itself still lives in the component (this module has no React
 * dependency); it reads the flags/name lists off the result.
 *
 * `siblings` are the task's OTHER repository checkouts. Archiving is
 * task-scoped, so every one of them is force-deleted no matter which row the
 * user clicked; classifying only the clicked row let a clean-looking row hide
 * a sibling's uncommitted changes. Each checkout is classified independently
 * (the three states are mutually exclusive per checkout, but across a
 * multi-repository task a confirmed-dirty sibling and an unknown sibling can
 * both exist, so both warnings can legitimately show at once).
 */
export function buildDeleteConfirmCopy(
  w: WorktreeInfo,
  status: WorktreeGitStatus | null,
  siblings: readonly SiblingCheckout[] = [],
): DeleteConfirmCopy {
  const ownLabel = w.repoName ?? w.branch ?? w.id;
  const ownUnknown = status == null || status.ignored === true;
  const ownDirty = !ownUnknown && status!.dirty === true;
  const dirtyCheckouts = [
    ...(ownDirty ? [ownLabel] : []),
    ...siblings
      .filter((s) => s.status != null && s.status.ignored !== true && s.status.dirty === true)
      .map((s) => s.name),
  ];
  const unknownCheckouts = [
    ...(ownUnknown ? [ownLabel] : []),
    ...siblings
      .filter((s) => s.status == null || s.status.ignored === true)
      .map((s) => s.name),
  ];
  const alreadyArchived = w.archivedAt != null;
  return {
    title: `Delete worktree "${w.branch ?? w.id}"?`,
    showDirtyWarning: dirtyCheckouts.length > 0,
    unknown: unknownCheckouts.length > 0,
    dirtyCheckouts,
    unknownCheckouts,
    multiRepo: siblings.length > 0 || !!w.repoName,
    checkoutCount: siblings.length + 1,
    alreadyArchived,
    confirmLabel:
      dirtyCheckouts.length > 0 || unknownCheckouts.length > 0
        ? "Discard changes & delete"
        : "Archive & delete",
  };
}

/** Outcome of triaging a `WorktreeTeardownResult` (or its absence) into
 *  something the UI can act on: either nothing to say (the row disappearing
 *  on refresh IS the feedback, per house convention for destructive list
 *  mutations) or a message worth toasting. */
export type DeleteOutcome = { kind: "silent" } | { kind: "error"; message: string };

/**
 * The Worktrees delete confirm fetches one git status per checkout of a task
 * (each is a `git` subprocess on the bun side), so it bounds that fan-out
 * with the shared `mapWithConcurrency` helper. Re-exported here so the
 * dialog keeps importing its decision helpers from one module; the helper
 * and its unit tests live in `src/mainview/lib/map-with-concurrency.ts`.
 */
export { mapWithConcurrency } from "../../lib/map-with-concurrency.ts";

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
 *
 * For a multi-repository teardown the failing entry is named
 * (`repositories[]`), because deleting any one row archives the whole task:
 * the branch passed by the clicked row may belong to a repository that was
 * removed successfully, while a sibling is the one holding uncommitted work.
 */
export function triageDeleteOutcome(teardown: WorktreeTeardownResult | undefined, branch: string | null): DeleteOutcome {
  if (teardown === undefined) return { kind: "silent" };
  if (teardown.removed) return { kind: "silent" };
  // A multi-repository delete archives the WHOLE task, so the failure may
  // belong to a sibling repository, not the row the user clicked. Name the
  // repository that actually failed rather than that row's branch, or the
  // toast points the user at the wrong checkout.
  const failedRepo = teardown.repositories?.find(
    (repo) =>
      !repo.result.removed
      && repo.result.reason !== "no-worktree"
      && repo.result.reason !== "already-absent",
  );
  const reason = failedRepo?.result.reason ?? teardown.reason;
  const name = failedRepo ? `repository "${failedRepo.name}"` : (branch ?? "this worktree");
  switch (reason) {
    case "no-worktree":
    case "already-absent":
      return { kind: "silent" };
    case "dirty":
      return {
        kind: "error",
        message: `Couldn't delete ${name}: it still has uncommitted changes.`,
      };
    case "workspace-not-empty":
      // Every repository checkout is gone but the task's workspace root
      // survives on files outside them (agent notes, scratch, …). The row
      // the user clicked represents that root, so a silent success made the
      // delete look broken — say why it is still there and how to finish.
      return {
        kind: "error",
        message:
          "Couldn't delete the task workspace: it still contains files outside its repositories. " +
          "Move or remove them, then try again.",
      };
    case "source-missing":
      // The repository this checkout came from no longer exists, so git can't
      // vouch for the checkout and teardown deliberately leaves it on disk.
      return {
        kind: "error",
        message:
          `Kept ${name}: its source repository no longer exists, so its checkout was left on disk. ` +
          "Remove the folder manually if you don't need it.",
      };
    case "failed":
    default:
      return {
        kind: "error",
        message: `Couldn't delete ${name}: the worktree removal failed. Try again or remove it manually.`,
      };
  }
}

/**
 * The confirm body's "what gets removed" noun phrase: the single task's
 * worktree directory, the one remaining checkout of a multi-repository task
 * (named, never "all 1 repository worktrees"), or every checkout of a multi
 * task.
 */
export function worktreeRemovalPhrase(
  copy: Pick<DeleteConfirmCopy, "multiRepo" | "checkoutCount">,
  repoName: string | null | undefined,
): string {
  if (!copy.multiRepo) return "its worktree directory";
  if (copy.checkoutCount === 1) {
    return repoName ? `its ${repoName} repository worktree` : "its repository worktree";
  }
  return `all ${copy.checkoutCount} repository worktrees`;
}
