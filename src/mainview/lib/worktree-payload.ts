import type { Isolation } from "../../shared/types.ts";
import { dedupeSelections, type RepoSelection } from "./repo-selection.ts";

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

/** The project-selection half of `api.createTask`'s input. */
export interface SelectionPayload extends WorktreePayload {
  workdir: string;
  /** Present only for a 2+ (post-dedupe) selection. A one-entry `repositories`
   *  array is deliberately never sent: the server rejects a plain non-git
   *  folder there, so a single project keeps the historical `workdir` +
   *  top-level `baseRef` shape. */
  repositories?: { path: string; baseRef?: string }[];
}

export interface SelectionPayloadInput {
  repos: readonly RepoSelection[];
  /** The *effective* isolate state — `forceIsolate || isolate` from
   *  `useWorktreeOptions`; for 2+ it is forced regardless of the raw toggle. */
  isolate: boolean;
  /** `BranchFieldState.submitValue`; passed through verbatim (see
   *  {@link WorktreePayloadInput}). */
  branchSubmitValue: string;
}

/**
 * The single source of truth mapping the combined project selection to a
 * task-create payload. Every surface (New Task, create-from-issue) spreads
 * its result; no form maps refs itself.
 *
 * - 0 projects: inert (`workdir: ""`, no isolation, no refs) — the form's
 *   `canSubmit` already refuses this.
 * - 1 project (post-dedupe): the historical single-repository shape, through
 *   {@link worktreePayload}, so the top-level `baseRef`/`branch` still work
 *   and a non-git folder with isolation off stays valid.
 * - 2+ (post-dedupe): worktree isolation is required, `workdir` is the first
 *   kept path (the server assigns the real workspace root), each project
 *   contributes a `repositories[]` entry with its own trimmed base ref, and
 *   no top-level `baseRef` is sent (the server reads per-entry refs).
 */
export function selectionPayload({
  repos,
  isolate,
  branchSubmitValue,
}: SelectionPayloadInput): SelectionPayload {
  const kept = dedupeSelections([...repos]);
  const first = kept[0];
  if (!first) return { workdir: "", isolation: "none" };
  const branch = branchSubmitValue ? branchSubmitValue : undefined;
  if (kept.length === 1) {
    return {
      workdir: first.path,
      ...worktreePayload({ isolate, baseRef: first.baseRef ?? "", branchSubmitValue }),
    };
  }
  return {
    workdir: first.path,
    isolation: "worktree",
    ...(branch === undefined ? {} : { branch }),
    repositories: kept.map((entry) => {
      const ref = entry.baseRef?.trim();
      return ref ? { path: entry.path, baseRef: ref } : { path: entry.path };
    }),
  };
}
