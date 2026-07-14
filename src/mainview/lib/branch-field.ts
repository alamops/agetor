import { renderBranchTemplate, type TaskType } from "../../shared/types.ts";

/** Inputs to {@link branchFieldState} — mirrors what the New Task form tracks
 *  for the branch-name field. `override` only matters while `dirty`. */
export interface BranchFieldInput {
  /** Whether the user has taken the field over with their own text. */
  dirty: boolean;
  /** The user's literal text — meaningful only when `dirty`. */
  override: string;
  /** The tag-visible pattern for the current config + task type, e.g.
   *  `feature/<slug>` — see {@link import("../../shared/types.ts").branchPattern}. */
  pattern: string;
  title: string;
  projectName: string;
  taskType: TaskType;
  token: string;
}

/** Derived view of the branch-name field, computed fresh each render. */
export interface BranchFieldState {
  /** What the input shows. */
  displayValue: string;
  /** What gets sent to the server on submit (raw template when clean, so the
   *  server stays the authoritative resolver; the trimmed literal when dirty). */
  submitValue: string;
  /** The fully-resolved name — used for validation and the `→ resolved`
   *  preview line while dirty. */
  resolved: string;
}

/**
 * Pure clean/dirty projection of the branch-name field. Clean: the field
 * tracks the live-rendered pattern (realtime as title/type/config change) and
 * submits the raw, un-rendered pattern — the server resolves it authoritatively
 * at task-creation time (task-id-derived token, creation timestamp). Dirty:
 * the user's literal text wins for both display and submit (trimmed), and is
 * still run through {@link renderBranchTemplate} to produce `resolved` for
 * validation/preview — a template-free override renders as itself (identity).
 */
export function branchFieldState(input: BranchFieldInput): BranchFieldState {
  const { dirty, override, pattern, title, projectName, taskType, token } = input;
  const ctx = { title, projectName, taskType, token };

  if (!dirty) {
    const rendered = renderBranchTemplate(pattern, ctx);
    return { displayValue: rendered, submitValue: pattern, resolved: rendered };
  }

  return {
    displayValue: override,
    submitValue: override.trim(),
    resolved: renderBranchTemplate(override, ctx),
  };
}
