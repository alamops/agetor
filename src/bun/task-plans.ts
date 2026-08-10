import type { TaskPlan } from "../shared/types.ts";

/**
 * Pure list-transform helpers over `task.plans`, mirroring the `backlog`
 * module's shape in `db.ts`: no process side effect, no DB access — callers
 * (the orchestrator's `attachDoneHandler`, the plan edit/approve routes)
 * `tasks.get`, transform, then `tasks.update({ plans: ... })` themselves.
 * Kept side-effect-free on purpose so orchestrator-level tests can drive the
 * lifecycle transitions without spinning up a task/run at all.
 */

/**
 * Derive a filesystem/URL-safe plan id from Cursor's raw `call_id`. Cursor's
 * call_ids contain embedded newlines (confirmed against real runs — see
 * plan §2), so the raw value can never be used directly in a filename or a
 * route param. FNV-1a 32-bit over the UTF-8 bytes, rendered as 8 lowercase
 * hex chars — deterministic (same call_id always yields the same plan id,
 * which is what makes `upsertDetectedPlan`'s dedup-by-toolCallId reattach-safe)
 * and short enough to read comfortably in a URL or `.plan.md` filename.
 */
export function planIdFromCallId(callId: string): string {
  const bytes = new TextEncoder().encode(callId);
  let hash = 0x811c9dc5; // FNV offset basis
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193); // FNV prime, 32-bit wraparound via Math.imul
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Slugify a plan's `name` for use in the `.plan.md` filename written at
 * approval time. Lowercases, collapses any run of non-alphanumerics to a
 * single `_`, trims leading/trailing `_`, and caps at 40 chars (trimming any
 * `_` the cap exposes at the new end). Falls back to `"plan"` for a null/
 * empty/all-punctuation name so the filename is never empty.
 */
export function planSlug(name: string | null): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const capped = base.slice(0, 40).replace(/_+$/g, "");
  return capped || "plan";
}

/**
 * The plan's effective content — what gets written to disk on approval and
 * shown as read-only once approved. Edits win over the original when present.
 */
export function effectiveContent(plan: TaskPlan): string {
  return plan.editedContent ?? plan.content;
}

/**
 * Record a freshly-detected `createPlanToolCall` plan. Idempotent by
 * `toolCallId`: a run's terminal tool_use is re-read from durable
 * `run_events` on reattach after a restart, so calling this twice for the
 * same call_id must be a no-op that preserves any edits/status already
 * applied since — not silently reset a plan someone has since approved.
 * Any other `pending` plan is
 * marked `superseded`: at most one plan is ever actionable at a time (§3).
 */
export function upsertDetectedPlan(
  plans: TaskPlan[],
  input: { toolCallId: string; runId: string; name: string | null; content: string; now: number },
): TaskPlan[] {
  if (plans.some((p) => p.toolCallId === input.toolCallId)) return plans;
  const superseded = plans.map((p): TaskPlan =>
    p.status === "pending" ? { ...p, status: "superseded" } : p,
  );
  const next: TaskPlan = {
    id: planIdFromCallId(input.toolCallId),
    toolCallId: input.toolCallId,
    runId: input.runId,
    name: input.name,
    content: input.content,
    editedContent: null,
    status: "pending",
    createdAt: input.now,
    approvedAt: null,
    approvedEdited: false,
    filePath: null,
  };
  return [...superseded, next];
}

/**
 * Persist (or clear) a draft edit on a pending plan. Returns `null` when the
 * plan is missing or no longer `pending` — the caller (the PATCH route)
 * turns that into a 4xx rather than silently writing to a frozen/approved
 * plan. Setting `editedContent` back to the original `content`, or to
 * empty/whitespace-only text, normalizes to `null` (no draft) so a no-op
 * edit doesn't linger as a phantom "dirty" state in the UI.
 */
export function setEditedContent(
  plans: TaskPlan[],
  planId: string,
  editedContent: string | null,
): TaskPlan[] | null {
  const idx = plans.findIndex((p) => p.id === planId);
  if (idx === -1) return null;
  const plan = plans[idx]!;
  if (plan.status !== "pending") return null;
  const normalized =
    editedContent !== null && editedContent.trim() !== "" && editedContent !== plan.content
      ? editedContent
      : null;
  const next = [...plans];
  next[idx] = { ...plan, editedContent: normalized };
  return next;
}

/**
 * Approve a pending plan. Returns `null` when the plan is missing or not
 * `pending` (already approved/superseded, or a stale id) — the approve route
 * must check this *before* sending the auto-approval message, since the send
 * is non-idempotent. `approvedEdited` is derived from whether a draft edit
 * was present at approval time, not re-derived later, so the record stays
 * accurate even if edits were somehow cleared afterward.
 */
export function approvePlan(
  plans: TaskPlan[],
  planId: string,
  opts: { now: number; filePath: string },
): { plans: TaskPlan[]; approved: TaskPlan } | null {
  const idx = plans.findIndex((p) => p.id === planId);
  if (idx === -1) return null;
  const plan = plans[idx]!;
  if (plan.status !== "pending") return null;
  const approved: TaskPlan = {
    ...plan,
    status: "approved",
    approvedAt: opts.now,
    approvedEdited: plan.editedContent !== null,
    filePath: opts.filePath,
  };
  const next = [...plans];
  next[idx] = approved;
  return { plans: next, approved };
}
