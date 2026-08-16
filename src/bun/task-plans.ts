import { createHash } from "node:crypto";
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
 * route param. SHA-256 over the UTF-8 bytes, truncated to the first 16 hex
 * chars — deterministic (same call_id always yields the same plan id, which
 * is what makes `upsertDetectedPlan`'s dedup-by-toolCallId reattach-safe)
 * and short enough to read comfortably in a URL or `.plan.md` filename. 16
 * hex chars (64 bits) rather than a 32-bit hash: a 32-bit FNV hash collides
 * with non-negligible probability across enough plans over a long-lived
 * task's history, and a collision here silently misroutes an edit/approve
 * to the wrong plan — worth the few extra bytes.
 */
export function planIdFromCallId(callId: string): string {
  return createHash("sha256").update(callId, "utf8").digest("hex").slice(0, 16);
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

/** Retention cap for `task.plans` — a long-lived task can accumulate one
 *  `createPlanToolCall` per turn indefinitely, and the JSON column round-trips
 *  through every `/tasks` poll (2s) and every task-row read, so unbounded
 *  growth is a real cost, not just a cosmetic one. */
const MAX_RETAINED_PLANS = 10;

/**
 * Prune `plans` down to at most `MAX_RETAINED_PLANS`, oldest-first, but never
 * drop the two entries that still matter operationally: the most recent plan
 * (always kept regardless of status — this is what `upsertDetectedPlan` just
 * appended) and the most recent `approved` plan (still the operative record
 * of what the agent was told to build). Everything else — overwhelmingly
 * `superseded` history the user never acted on — is fair game, oldest first.
 * A pure transform: never touches status/content, only which entries survive.
 */
function pruneRetainedPlans(plans: TaskPlan[]): TaskPlan[] {
  if (plans.length <= MAX_RETAINED_PLANS) return plans;
  const lastIdx = plans.length - 1;
  let latestApprovedIdx = -1;
  for (let i = plans.length - 1; i >= 0; i--) {
    if (plans[i]!.status === "approved") {
      latestApprovedIdx = i;
      break;
    }
  }
  const protectedIdx = new Set<number>([lastIdx]);
  if (latestApprovedIdx !== -1) protectedIdx.add(latestApprovedIdx);

  let toDrop = plans.length - MAX_RETAINED_PLANS;
  const kept: TaskPlan[] = [];
  for (let i = 0; i < plans.length; i++) {
    if (toDrop > 0 && !protectedIdx.has(i)) {
      toDrop--;
      continue;
    }
    kept.push(plans[i]!);
  }
  return kept;
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
  return pruneRetainedPlans([...superseded, next]);
}

/**
 * Persist (or clear) a draft edit on a pending plan. Returns `null` when the
 * plan is missing or no longer `pending` — the caller (the PATCH route)
 * turns that into a 4xx rather than silently writing to a frozen/approved
 * plan. Setting `editedContent` back to the original `content` normalizes to
 * `null` (no draft) so a no-op edit doesn't linger as a phantom "dirty"
 * state in the UI.
 *
 * Whitespace-only text is deliberately NOT normalized to `null` here — the
 * PATCH route rejects it outright (400 "plan edit cannot be empty") before
 * this is ever called, because silently discarding it would let approve
 * ship the *original* plan content while the UI still showed the user's
 * (whitespace) edit as accepted. This helper only handles the "same as
 * original" no-op case; the "empty" case is a route-level validation error.
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
    editedContent !== null && editedContent !== plan.content ? editedContent : null;
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

/**
 * Record a freshly-detected claude-code `ExitPlanMode` plan. Thin wrapper
 * over `upsertDetectedPlan` — claude's `ExitPlanMode` tool_use has no `name`
 * field (cursor's `createPlanToolCall` does), so this always passes
 * `name: null`. Same idempotent-by-`toolCallId` / supersede-prior-`pending`
 * contract as the cursor path: a reattach-replayed tool_use is a no-op
 * (dedup by `toolCallId`), and at most one plan is ever `pending` per task —
 * a fresh `ExitPlanMode` supersedes whatever was pending before it.
 *
 * Claude plans are read-only records once created: approval stays a live
 * tmux-keystroke flow (see `resolveClaudePlan`), not a route — so unlike
 * cursor's `approvePlan`, nothing here ever sets `filePath`.
 */
export function upsertClaudePlanFromExitPlanMode(
  plans: TaskPlan[],
  input: { toolCallId: string; runId: string; content: string; now: number },
): TaskPlan[] {
  return upsertDetectedPlan(plans, { ...input, name: null });
}

/** Exact prefix claude's `ExitPlanMode` approval tool_result starts with when
 *  the user approved the plan (verified against real JSONL — plan §2). Any
 *  other tool_result content for the same call id (rejection copy, an
 *  interrupted turn, …) is treated as a rejection — there is no separate
 *  "the user explicitly rejected" signal to match on. */
const CLAUDE_PLAN_APPROVED_PREFIX = "User has approved your plan";

/** Marker claude's approval tool_result includes when the user edited the
 *  plan in the native UI before approving — everything after it is the
 *  edited plan markdown, replacing the original. */
const CLAUDE_PLAN_EDITED_MARKER = "## Approved Plan (edited by user):";

/**
 * Resolve a claude-code `ExitPlanMode` plan from its matching tool_result.
 * Mirrors `upsertDetectedPlan`'s "return the SAME array by reference when
 * there's nothing to do" contract, so callers can gate the DB write on
 * `next !== plans` exactly like `detectCursorPlan` already does for cursor —
 * that covers a stale/duplicate tool_result replayed on reattach, a
 * `toolCallId` from another task, and (defensively) a plan that's already
 * left `pending` for any reason.
 *
 * `resultContent` is the tool_result's raw text — matched after
 * `trimStart()` so incidental leading whitespace (e.g. a leading "\n" some
 * claude output shapes prepend) can never flip a genuine approval into a
 * permanent `rejected` verdict; the exact-prefix contract only ever needed
 * to rule out *content* differences, not incidental leading whitespace:
 *  - starts with `"User has approved your plan"` → `approved`. When it also
 *    contains the `"## Approved Plan (edited by user):"` marker, the text
 *    after the marker becomes `editedContent` (the edited plan wins, same
 *    `effectiveContent` convention cursor plans use) and `approvedEdited` is
 *    derived from that, matching `approvePlan`'s convention.
 *  - anything else → `rejected` (user declined, or the turn was interrupted
 *    before an explicit approval/rejection was recorded).
 *
 * Claude plans never get a `filePath` — approval doesn't write a file the
 * way cursor's `approvePlan` does; the plan stays a read-only history record.
 */
export function resolveClaudePlan(
  plans: TaskPlan[],
  toolCallId: string,
  resultContent: string,
  now: number,
): TaskPlan[] {
  const idx = plans.findIndex((p) => p.toolCallId === toolCallId);
  if (idx === -1) return plans;
  const plan = plans[idx]!;
  if (plan.status !== "pending") return plans;

  const trimmed = resultContent.trimStart();
  const next = [...plans];
  if (!trimmed.startsWith(CLAUDE_PLAN_APPROVED_PREFIX)) {
    next[idx] = { ...plan, status: "rejected", approvedAt: null };
    return next;
  }

  const markerIdx = trimmed.indexOf(CLAUDE_PLAN_EDITED_MARKER);
  const editedContent = markerIdx === -1
    ? null
    : trimmed.slice(markerIdx + CLAUDE_PLAN_EDITED_MARKER.length).trim() || null;

  next[idx] = {
    ...plan,
    status: "approved",
    editedContent,
    approvedAt: now,
    approvedEdited: editedContent !== null,
  };
  return next;
}
