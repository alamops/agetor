/**
 * Pure harness-stack helpers: the lap/wrap selection walk, the visible swap
 * notice, the all-exhausted copy and the hidden continuation tag.
 *
 * No DB, no filesystem, no runtime import outside `src/shared` (CLAUDE.md's
 * shared rule). The runtime uses these from `harness-failover.ts` (selection),
 * `orchestrator.ts` (notice + prompt), the webview and the CLI (formatting),
 * so all four surfaces format one string the same way.
 * See docs/architecture/harness-stacks.md.
 */
import {
  HARNESS_STACK_CONTINUATION_TAG,
  HARNESS_SWAP_STATUS_TOKEN,
  type HarnessLimitReason,
  type HarnessStack,
  type HarnessStackMember,
  type HarnessSwapNotice,
  type TaskHarnessState,
} from "./types.ts";
import { escapeFreeText } from "./terminal-text.ts";

/** How long a completed move stays in the task header. */
export const HARNESS_STACK_MOVED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Which harness-stack line the task header shows. The precedence is fixed so a
 * recent move cannot hide a live all-exhausted retry (a manual move followed by
 * "every account is out of quota" would otherwise hide the countdown and
 * "Run now" for a whole day):
 *
 *   pending swap → all-exhausted retry → recent move → nothing.
 */
export function harnessStackBannerMode(
  state: TaskHarnessState | null | undefined,
  now: number = Date.now(),
): "pending" | "exhausted" | "moved" | null {
  if (!state) return null;
  if (state.pendingSwap) return "pending";
  if (state.allExhausted) return "exhausted";
  if (state.lastMove && now - state.lastMove.at < HARNESS_STACK_MOVED_TTL_MS) return "moved";
  return null;
}

/** `"2/3"` for the account's 1-based position in the stack, or null when the
 *  account is not a member. */
export function stackPositionText(
  stack: Pick<HarnessStack, "members">,
  harnessId: string,
): string | null {
  const index = stack.members.findIndex((m) => m.harnessId === harnessId);
  if (index < 0) return null;
  return `${index + 1}/${stack.members.length}`;
}

/**
 * The task-header note for a completed move. A user-initiated switch inside
 * the stack preserves the conversation, so it must not claim the previous
 * account left or was unavailable (review S2). Kept here (not inline in the
 * webview) so the CLI/TUI can reuse exactly the same wording if they grow a
 * header.
 */
export function harnessMoveNote(
  move: NonNullable<TaskHarnessState["lastMove"]>,
  toLabel: string,
): string {
  return move.reason === "manual-switch"
    ? `Switched to ${toLabel} — continuing this conversation.`
    : `Moved to ${toLabel} — the previous account left the stack or was unavailable.`;
}

export interface PickNextMemberArgs {
  members: readonly HarnessStackMember[];
  currentId: string;
  /** Account ids already tried in this lap. */
  tried: readonly string[];
  now: number;
  /** Hard cooldown lookup (account-global). */
  cooling: (harnessId: string) => { exhaustedUntilMs: number } | null;
  /** Cached quota definitely exhausted (stale/missing fails open). */
  exhaustedByQuota?: (harnessId: string) => boolean;
  /** The exhausted snapshot's earliest known reset, when it reports one. */
  quotaResetAt?: (harnessId: string) => number | null;
  /** Why a member cannot run this task's model/turn, or null when usable. */
  usable: (member: HarnessStackMember) => string | null;
}

export type NextMemberPlan =
  | { kind: "next"; member: HarnessStackMember; skipped: Array<{ harnessId: string; reason: string }> }
  | {
      kind: "all-exhausted";
      earliestResetAtMs: number | null;
      skipped: Array<{ harnessId: string; reason: string }>;
    }
  | {
      kind: "none-usable";
      reasons: Array<{ harnessId: string; reason: string }>;
      earliestResetAtMs: number | null;
      skipped: Array<{ harnessId: string; reason: string }>;
    };

/**
 * Walk forward from the current account, wrapping once, and pick the next
 * usable member. A member is skipped — and **not** marked tried — when it is
 * disabled, cooling, quota-exhausted or unusable for another reason (not
 * installed, logged out, model not offered, CLI floor); a member already in
 * `tried` is skipped as well (this lap already ended a run on it in a limit).
 *
 * - `all-exhausted` means every runnable member was tried this lap, or at
 *   least one skipped member is blocked *by a limit* (cooling or quota) —
 *   waiting and retrying a fresh lap can help.
 * - `none-usable` means nothing is runnable and no limit is to blame — only a
 *   manual fix (enable/log in/install) can help.
 *
 * The limit check runs even for a `tried` member: a full lap of a two-account
 * stack otherwise reported "none-usable" (because both accounts were tried)
 * with no reset time, so the caller armed no retry and the task blocked
 * forever. Every tried account ended its run in a limit, so a full lap is
 * inherently all-exhausted.
 *
 * A member is "tried" only when a run on it genuinely ended in a limit; this
 * pure walk never mutates `tried`.
 */
export function pickNextMember(args: PickNextMemberArgs): NextMemberPlan {
  const { members, currentId, tried, now, cooling, exhaustedByQuota, quotaResetAt, usable } = args;
  const triedSet = new Set(tried);
  const skipped: Array<{ harnessId: string; reason: string }> = [];
  const startIndex = members.findIndex((m) => m.harnessId === currentId);
  // An orphaned current account (removed from the stack mid-flight) starts the
  // walk at member 0: `-1 + step` with `step` 1..length visits every member
  // exactly once, instead of skipping the first one as `from = 0` did.
  const from = startIndex;
  let earliestResetAtMs: number | null = null;
  let limitBlocked = 0;
  let triedCount = 0;
  const noteReset = (at: number) => {
    if (!Number.isFinite(at) || at <= now) return;
    if (earliestResetAtMs === null || at < earliestResetAtMs) earliestResetAtMs = at;
  };

  for (let step = 1; step <= members.length; step++) {
    const member = members[(from + step) % members.length]!;
    const id = member.harnessId;
    const wasTried = triedSet.has(id);
    if (wasTried) triedCount++;
    if (!member.enabled) {
      skipped.push({ harnessId: id, reason: wasTried ? "tried this lap" : "disabled" });
      continue;
    }
    // Inspect the limit state before the tried check so a tried+cooling
    // member still contributes its reset time and its limit-blocked bit.
    const cool = cooling(id);
    if (cool && cool.exhaustedUntilMs > now) {
      noteReset(cool.exhaustedUntilMs);
      limitBlocked++;
      skipped.push({ harnessId: id, reason: wasTried ? "tried this lap" : "cooling until its reset" });
      continue;
    }
    if (exhaustedByQuota?.(id)) {
      limitBlocked++;
      // A quota snapshot often carries the provider's own reset instant;
      // without it the all-exhausted plan falls back to the generic backoff.
      const resetAt = quotaResetAt?.(id);
      if (resetAt !== null && resetAt !== undefined) noteReset(resetAt);
      skipped.push({ harnessId: id, reason: wasTried ? "tried this lap" : "quota exhausted" });
      continue;
    }
    if (wasTried) {
      skipped.push({ harnessId: id, reason: "tried this lap" });
      continue;
    }
    const why = usable(member);
    if (why !== null) {
      skipped.push({ harnessId: id, reason: why });
      continue;
    }
    return { kind: "next", member, skipped };
  }

  if (limitBlocked > 0 || (members.length > 0 && triedCount === members.length)) {
    return { kind: "all-exhausted", earliestResetAtMs, skipped };
  }
  return { kind: "none-usable", reasons: skipped, earliestResetAtMs, skipped };
}

const REASON_COPY: Record<HarnessLimitReason, string> = {
  quota: "usage limit reached",
  rate_limit: "rate limit",
  insufficient_credits: "out of credits",
};

/**
 * The exact user-visible divider text. Labels only — never a product name, an
 * email or a token (plan invariant C12). The destination label is user data,
 * so it is escaped for a terminal: a label containing ESC/ANSI or a line
 * break must not be able to repaint the CLI/TUI transcript (review
 * should-fix). `escapeFreeText` keeps ordinary Unicode and folds line breaks
 * to a space.
 */
export function formatHarnessSwapNotice(notice: HarnessSwapNotice): string {
  const tail = notice.continuation === "restarted"
    ? "Restarting the request on this account."
    : "Continuing from the transferred conversation.";
  return `Switched to ${escapeFreeText(notice.toLabel)} — ${REASON_COPY[notice.reason]}. ${tail}`;
}

/** Parse a `status` payload that follows `HARNESS_SWAP_STATUS_PREFIX`. Tolerant:
 *  malformed JSON or a missing field → null. */
export function parseHarnessSwapNotice(data: string): HarnessSwapNotice | null {
  const raw = data.startsWith(HARNESS_SWAP_STATUS_TOKEN)
    ? data.slice(HARNESS_SWAP_STATUS_TOKEN.length).replace(/^\s+/, "")
    : data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.from !== "string" || typeof o.to !== "string") return null;
  if (typeof o.fromLabel !== "string" || typeof o.toLabel !== "string") return null;
  if (o.reason !== "quota" && o.reason !== "rate_limit" && o.reason !== "insufficient_credits") return null;
  if (typeof o.position !== "number" || typeof o.count !== "number" || typeof o.at !== "number") return null;
  const resetsAtMs = typeof o.resetsAtMs === "number" ? o.resetsAtMs : null;
  return {
    from: o.from,
    fromLabel: o.fromLabel,
    to: o.to,
    toLabel: o.toLabel,
    reason: o.reason,
    position: o.position,
    count: o.count,
    resetsAtMs,
    at: o.at,
    ...(o.continuation === "restarted" ? { continuation: "restarted" as const } : {}),
  };
}

/** Copy for the all-exhausted banner / CLI line. */
export function formatStackExhausted(args: {
  nextAttemptAt: number;
  attempts: number;
  max: number;
}): string {
  const { nextAttemptAt, attempts, max } = args;
  if (attempts >= max) {
    return `Every account in this stack is out of quota — run the task manually after a reset.`;
  }
  return `Every account in this stack is out of quota — retrying at ${new Date(nextAttemptAt).toLocaleString()} (attempt ${attempts + 1}/${max}).`;
}

/** Copy for "nothing in the stack can run this task". `label` is the account's
 *  user-facing name; a caller that cannot resolve one falls back to the id so
 *  the status line still names the member. */
export function formatStackUnusable(
  reasons: Array<{ harnessId: string; label?: string; reason: string }>,
): string {
  if (reasons.length === 0) return "No account in this stack is available.";
  const detail = reasons.map((r) => `${r.label ?? r.harnessId}: ${r.reason}`).join("; ");
  return `No account in this stack can run this task — ${detail}.`;
}

/** Wrap `text` in the exact hidden continuation tag. Callers that may re-send
 *  an already-wrapped value (a second consecutive clean retry) must call
 *  {@link stripHarnessStackContinuation} first: a nested wrapper is
 *  deliberately NOT recognised as the machine wrapper by
 *  {@link isHarnessStackContinuation}, so nesting would leak it into view. */
export function wrapHarnessStackContinuation(text: string): string {
  return `<${HARNESS_STACK_CONTINUATION_TAG}>\n${text.replace(/\r\n?/g, "\n")}\n</${HARNESS_STACK_CONTINUATION_TAG}>`;
}

/**
 * The transfer branch's hidden prompt. No product name and no added user-facing
 * text beyond this documented exception (owner decision, grill 24): the model
 * is told not to repeat completed work after a mid-turn resume.
 */
export function composeHarnessStackContinuationPrompt(): string {
  return wrapHarnessStackContinuation(
    "Continue the task from where it stopped. The previous account reached its usage limit; no work was lost. "
      + "Do not repeat completed steps, re-read files you already changed, or ask the user to confirm. "
      + "Pick up the next action.",
  );
}

/** True only when `text` is exactly the wrapper (trimmed). A user message that
 *  merely contains the tag in prose stays visible. */
export function isHarnessStackContinuation(text: string): boolean {
  const open = `<${HARNESS_STACK_CONTINUATION_TAG}>`;
  const close = `</${HARNESS_STACK_CONTINUATION_TAG}>`;
  const trimmed = text.trim();
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return false;
  const inner = trimmed.slice(open.length, trimmed.length - close.length);
  // Exactly one wrapper: a second open/close pair inside would mean this is
  // prose that happens to contain a tag, not the machine wrapper.
  return !inner.includes(open) && !inner.includes(close);
}

/**
 * The body of an exact continuation wrapper, or `text` unchanged when it is
 * not one. A second consecutive clean-retry swap re-sends the previous run's
 * last user text; without this, that text (already wrapped) was wrapped again
 * and `isHarnessStackContinuation` stopped recognising the outer value — the
 * hidden prompt leaked into the transcript as a visible bubble.
 */
export function stripHarnessStackContinuation(text: string): string {
  if (!isHarnessStackContinuation(text)) return text;
  const open = `<${HARNESS_STACK_CONTINUATION_TAG}>`;
  const close = `</${HARNESS_STACK_CONTINUATION_TAG}>`;
  const trimmed = text.trim();
  return trimmed.slice(open.length, trimmed.length - close.length).replace(/^\n+|\n+$/g, "");
}

