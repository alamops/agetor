import type { GitHubListItem } from "../../shared/types.ts";

/** Whether `item` is a pull request that has actually been merged (as opposed
 *  to closed-unmerged) — the one signal `state: "closed"` alone can't give,
 *  since GitHub collapses both outcomes into the same `state` value. Drives
 *  whether the GitHub dialog's PR detail view shows the purple "merged" card
 *  in place of the mergeability banner + Review/Merge/Close action grid. */
export function isMergedPull(item: GitHubListItem): boolean {
  return item.kind === "pulls" && !!item.mergedAt;
}

/** Builds the optimistic list-item replacement for a PR just merged from
 *  inside agetor. GitHub's merge endpoint response (`{merged, sha, message}`)
 *  carries no `mergedAt` — so the UI stamps an approximate one (default: now)
 *  to flip the card to "merged" immediately, and the next real fetch (the
 *  refresh-on-detail-entry effect, or a manual mergeability refresh) corrects
 *  it with GitHub's actual timestamp. `closedAt` is preserved if the item
 *  already carries one; otherwise it's stamped with the same timestamp,
 *  matching what `markPullClosed`'s default replacement does for a plain
 *  close. Every other field on `item` is passed through unchanged.
 *
 *  Same `kind === "pulls"` guard as `isMergedPull` above — a merge action is
 *  only ever invoked on a pulls item in practice, but keeping the two
 *  predicates symmetric means a caller can't accidentally stamp merge fields
 *  onto an issue. Returns `item` unchanged for a non-pulls item. */
export function mergedPullReplacement(item: GitHubListItem, mergedAtIso?: string): GitHubListItem {
  if (item.kind !== "pulls") return item;
  // `||`, not `??` — an empty string is falsy but not nullish, and must not be
  // stamped as-is (it would fail `isMergedPull`'s truthiness check, leaving the
  // "merged" replacement item reporting as not-merged).
  const stamp = mergedAtIso || new Date().toISOString();
  return {
    ...item,
    state: "closed",
    closedAt: item.closedAt ?? stamp,
    mergedAt: stamp,
  };
}
