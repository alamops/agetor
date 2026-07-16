import type { GitHubPullMergeability } from "../../shared/types.ts";

export type MergeTone = "ok" | "warn" | "bad" | "muted";

export interface MergeabilityView {
  label: string;
  tone: MergeTone;
  canMerge: boolean;
  showUpdateBranch: boolean;
}

/** Map GitHub's mergeable / mergeable_state into a label, colour tone, whether
 *  the Merge button should be enabled, and whether to offer "Update branch".
 *  Pure — drives whether a PR can be merged from the UI, so it's unit-tested. */
export function mergeabilityView(m: GitHubPullMergeability): MergeabilityView {
  if (m.mergeable === null) {
    return {
      label: "GitHub is still checking mergeability…",
      tone: "muted",
      canMerge: false,
      showUpdateBranch: m.mergeableState === "behind",
    };
  }
  switch (m.mergeableState) {
    case "clean":
    case "has_hooks":
      return { label: "Ready to merge", tone: "ok", canMerge: m.mergeable, showUpdateBranch: false };
    case "unstable":
      return { label: "Mergeable — some checks are pending or failing", tone: "warn", canMerge: m.mergeable, showUpdateBranch: false };
    case "behind":
      return { label: "Out of date with the base branch", tone: "warn", canMerge: m.mergeable, showUpdateBranch: true };
    case "dirty":
      return { label: "Conflicts must be resolved before merging", tone: "bad", canMerge: false, showUpdateBranch: false };
    case "blocked":
      return { label: "Blocked by required reviews or checks", tone: "bad", canMerge: false, showUpdateBranch: false };
    case "draft":
      return { label: "Draft — mark ready for review to merge", tone: "muted", canMerge: false, showUpdateBranch: false };
    default:
      return { label: `Mergeability: ${m.mergeableState}`, tone: "muted", canMerge: m.mergeable, showUpdateBranch: false };
  }
}
