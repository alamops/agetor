import type { Isolation } from "../../shared/types.ts";

/**
 * Inputs to {@link worktreePayload} — the three pieces of New Task Form /
 * issue-modal state that decide the worktree half of a task-create payload.
 * `branchSubmitValue` is `BranchFieldState.submitValue` from
 * `src/mainview/lib/branch-field.ts`: already trimmed when the user has
 * edited the branch field (dirty), or the raw un-rendered pattern when they
 * haven't (clean — the server resolves it authoritatively at create time).
 * Pass it through as-is; re-trimming it here would only be correct for the
 * dirty case and would double-trim (harmlessly, but pointlessly) the other.
 */
export interface WorktreePayloadInput {
  isolate: boolean;
  baseRef: string;
  branchSubmitValue: string;
}

/** The worktree-related subset of `api.createTask`'s input. */
export interface WorktreePayload {
  isolation: Isolation;
  baseRef?: string;
  branch?: string;
}

/**
 * Single source of truth for mapping the worktree UI state (isolate toggle +
 * base ref + branch field) into the `isolation` / `baseRef` / `branch` fields
 * of a task-create payload. Lifted verbatim from `NewTaskForm.tsx`'s
 * `submit()` — every caller (the New Task form, the create-from-issue dialog)
 * must go through this rather than keep its own copy of the mapping.
 */
export function worktreePayload({ isolate, baseRef, branchSubmitValue }: WorktreePayloadInput): WorktreePayload {
  return {
    isolation: isolate ? "worktree" : "none",
    baseRef: isolate && baseRef.trim() ? baseRef.trim() : undefined,
    branch: isolate && branchSubmitValue ? branchSubmitValue : undefined,
  };
}
