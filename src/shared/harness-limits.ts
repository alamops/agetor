/**
 * Conservative harness-limit classification (docs/architecture/harness-stacks.md,
 * plan D6). A false positive swaps a task onto a backup that may duplicate
 * work, so only provider quota, HTTP 429 and 402/insufficient credits count.
 * Auth failures, 5xx/529, network errors and model-not-available are explicit
 * negatives: they are account-independent or need the user, not another
 * account.
 *
 * Pure and shared: drivers use the same table for Claude pane/API text and
 * Codex's error vocabulary, so the two kinds cannot drift.
 */
import type { AgentKind, HarnessLimitReason, HarnessLimitSignal, HarnessQuota, QuotaMeter } from "./types.ts";

export interface HarnessLimitInput {
  text?: string | null;
  /** A driver-parsed structured signal (already classified by the wire shape). */
  structured?: HarnessLimitSignal | null;
}

interface Matcher {
  re: RegExp;
  reason: HarnessLimitReason;
}

/** Explicit negatives are checked FIRST so a sentence that names both a limit
 *  and an outage ("rate limited while server overloaded") stays conservative. */
const NEGATIVES: RegExp[] = [
  /\b5\d\d\b/,
  /\b529\b/,
  /\boverloaded\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bnetwork (?:error|failure|unreachable)\b/i,
  /\btimed? ?out\b/i,
  /\b401\b/,
  /\b403\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bmodel_not_found\b/i,
  /\bmodel (?:is )?not (?:supported|available)\b/i,
  /\bserver_overloaded\b/i,
];

const CLAUDE_MATCHERS: Matcher[] = [
  { re: /\busage limit\b/i, reason: "quota" },
  { re: /\binsufficient (?:credit|credits|quota)\b/i, reason: "insufficient_credits" },
  { re: /\bcredit balance\b/i, reason: "insufficient_credits" },
  { re: /\bpayment required\b/i, reason: "insufficient_credits" },
  { re: /\brate limit\b/i, reason: "rate_limit" },
  { re: /\btoo many requests\b/i, reason: "rate_limit" },
  { re: /\b402\b/, reason: "insufficient_credits" },
  { re: /\b429\b/, reason: "rate_limit" },
];

const CODEX_MATCHERS: Matcher[] = [
  { re: /\busage_limit_exceeded\b/i, reason: "quota" },
  { re: /\binsufficient_quota\b/i, reason: "insufficient_credits" },
  { re: /\binsufficient (?:credit|credits)\b/i, reason: "insufficient_credits" },
  { re: /\brate_limit_exceeded\b/i, reason: "rate_limit" },
  { re: /\btoo many requests\b/i, reason: "rate_limit" },
  { re: /\b402\b/, reason: "insufficient_credits" },
  { re: /\b429\b/, reason: "rate_limit" },
];

/** Kinds this classifier knows. Unknown/unsupported kinds never produce a
 *  signal (the caller also gates on a v1 stack kind). */
function matchersFor(kind: AgentKind): Matcher[] | null {
  if (kind === "claude-code") return CLAUDE_MATCHERS;
  if (kind === "codex") return CODEX_MATCHERS;
  return null;
}

/**
 * Classify a driver's text (or pass through a structured signal). Returns null
 * for every non-limit, including an empty input.
 */
export function classifyHarnessLimitSignal(
  kind: AgentKind,
  input: HarnessLimitInput,
): HarnessLimitSignal | null {
  if (input.structured) return input.structured;
  const text = input.text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (NEGATIVES.some((re) => re.test(trimmed))) return null;
  const matchers = matchersFor(kind);
  if (!matchers) return null;
  for (const matcher of matchers) {
    if (!matcher.re.test(trimmed)) continue;
    return {
      reason: matcher.reason,
      resetAtMs: parseClaudeResetNotice(trimmed, Date.now()),
      message: sanitizeLimitMessage(trimmed),
      source: kind === "codex" ? "codex-error" : "claude-api-error",
    };
  }
  return null;
}

/** A notice line is user-visible; strip anything token-shaped in case a
 *  provider echoed a credential into an error body. */
function sanitizeLimitMessage(text: string): string {
  return text
    .replace(/\b(?:sk|pk|tok|Bearer)[-_ ]?[A-Za-z0-9._-]{12,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[account]")
    .slice(0, 300);
}

/**
 * Validate a structured signal that crossed a process boundary as JSON (the
 * `harness-limit: ` status sentinel drivers emit). A sentinel claiming to be a
 * limit can drive a real account swap and a persisted cooldown, so a
 * malformed/hostile payload must be rejected rather than trusted via a TypeScript
 * cast: an unknown reason would poison `harness_limit_state`, and a non-finite
 * reset could arm a cooldown no timer can fire. Returns null for anything that
 * is not a complete, well-formed signal; the caller then behaves as if no limit
 * was reported (conservative — no swap).
 */
export function parseHarnessLimitSignal(value: unknown): HarnessLimitSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const reason = o.reason;
  if (reason !== "quota" && reason !== "rate_limit" && reason !== "insufficient_credits") return null;
  const source = o.source;
  if (source !== "claude-pane" && source !== "claude-api-error" && source !== "codex-error") return null;
  const resetAtMs = o.resetAtMs;
  if (resetAtMs !== null && (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs))) return null;
  const message = o.message;
  if (typeof message !== "string") return null;
  return { reason, resetAtMs, source, message: message.slice(0, 300) };
}

const TIME_AT_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const RESET_AT_RE = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

/**
 * Best-effort parse of Claude's "… at 8am" / "… at 3:30pm" reset wording into
 * an epoch-ms instant. Null when unsure — the caller then uses the default
 * backoff. A parsed time that is already in the past rolls to tomorrow.
 */
export function parseClaudeResetNotice(text: string, now: number): number | null {
  const match = TIME_AT_RE.exec(text) ?? RESET_AT_RE.exec(text);
  if (!match) return null;
  const hourRaw = Number(match[1]);
  const minuteRaw = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(hourRaw) || hourRaw < 1 || hourRaw > 12) return null;
  if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) return null;
  const meridiem = match[3]?.toLowerCase();
  let hour = hourRaw % 12;
  if (meridiem === "pm") hour += 12;
  const date = new Date(now);
  date.setHours(hour, minuteRaw, 0, 0);
  let at = date.getTime();
  if (at <= now) at += 24 * 60 * 60 * 1000;
  return at;
}

/**
 * The unscoped meters of a snapshot that *definitively* say the account is
 * exhausted, or null when the snapshot is stale/missing/scoped-only/not fully
 * used. Shared by {@link harnessQuotaLooksExhausted} and
 * {@link harnessQuotaResetAt} so the two cannot disagree about what "exhausted"
 * means.
 */
function exhaustedUnscopedMeters(
  quota: HarnessQuota | null | undefined,
  now: number,
  staleMs: number,
): QuotaMeter[] | null {
  if (!quota || quota.status !== "ok") return null;
  if (!Number.isFinite(quota.fetchedAtMs) || now - quota.fetchedAtMs > staleMs) return null;
  const unscoped = quota.meters.filter((m) => !m.scope);
  if (unscoped.length === 0) return null;
  if (!unscoped.every((m) => m.usedPercent >= 100 && (m.resetsAtMs === null || m.resetsAtMs > now))) return null;
  return unscoped;
}

/**
 * True only when a quota snapshot *definitively* says the account is
 * exhausted: `status === "ok"`, fresh enough, and every unscoped meter at
 * >= 100% with an unexpired reset. Used only to skip a member during an
 * automatic walk — a stale, missing or scoped-only snapshot fails open.
 */
export function harnessQuotaLooksExhausted(
  quota: HarnessQuota | null | undefined,
  now: number,
  staleMs: number,
): boolean {
  return exhaustedUnscopedMeters(quota, now, staleMs) !== null;
}

/**
 * The earliest known instant an exhausted account's quota frees up, or null
 * when the snapshot is not definitively exhausted or reports no future reset.
 * Feeding this into the all-exhausted plan arms the retry at the provider's
 * own reset instead of the generic backoff.
 */
export function harnessQuotaResetAt(
  quota: HarnessQuota | null | undefined,
  now: number,
  staleMs: number,
): number | null {
  const meters = exhaustedUnscopedMeters(quota, now, staleMs);
  if (!meters) return null;
  let earliest: number | null = null;
  for (const meter of meters) {
    const at = meter.resetsAtMs;
    if (at === null || !Number.isFinite(at) || at <= now) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}
