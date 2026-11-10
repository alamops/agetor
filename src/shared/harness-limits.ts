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
  /**
   * A structured error code the driver read off the wire, when the event
   * carries one (Codex: `codex_error_info`, `error.code`, `error.type`). A
   * string (`usage_limit_exceeded`, `usageLimitExceeded`) or a one-key object
   * (`{ "response_too_many_failed_attempts": {…} }`). A known limit code
   * decides the reason; a known non-limit code (`server_overloaded`,
   * `model_not_found`, …) is a definitive negative; anything else falls back
   * to the text.
   */
  code?: unknown;
  /** The instant a relative reset ("try again at 3:00 PM") resolves against;
   *  defaults to `Date.now()`. Tests pin it so a dated reset stays exact. */
  now?: number;
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

/** True when the text names an outage, auth or model failure — the explicit
 *  negatives above. A driver that remembers an earlier limit-shaped error uses
 *  this to refuse attaching it to a terminal failure that names a different,
 *  account-independent cause. */
export function harnessLimitTextIsNegative(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && NEGATIVES.some((re) => re.test(trimmed));
}

const CLAUDE_MATCHERS: Matcher[] = [
  { re: /\busage limit\b/i, reason: "quota" },
  // The client-composed 429 line ("You've hit your limit · resets 3pm") and
  // the standalone auto-continue row ("Continuing automatically at 8am · Esc
  // to cancel", claude 2.1.319), which only ever renders for a usage limit.
  { re: /\bhit your (?:usage )?limit\b/i, reason: "quota" },
  { re: /\bcontinuing automatically\b.*\besc to cancel\b/i, reason: "quota" },
  { re: /\binsufficient (?:credit|credits|quota)\b/i, reason: "insufficient_credits" },
  { re: /\bcredit balance\b/i, reason: "insufficient_credits" },
  { re: /\bpayment required\b/i, reason: "insufficient_credits" },
  { re: /\brate limit\b/i, reason: "rate_limit" },
  { re: /\btoo many requests\b/i, reason: "rate_limit" },
  { re: /\b402\b/, reason: "insufficient_credits" },
  { re: /\b429\b/, reason: "rate_limit" },
];

/**
 * Codex's vocabulary. codex-cli 0.166 prints prose, not the error codes, in
 * `codex exec --json` `error`/`turn.failed` messages (verified with `strings`
 * on the 0.166.0 binary):
 *   "You've hit your usage limit. Upgrade to Plus to continue using Codex
 *    (https://chatgpt.com/explore/plus), or try again at 3:00 PM."
 *   "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to
 *    purchase more credits or try again at Nov 10th, 2026 3:00 PM."
 *   "You've hit your usage limit. To get more access now, send a request to
 *    your admin …", "You've hit your usage limit for <model>. Switch to
 *    another model now, or try again at …"
 *   "Quota exceeded. Check your plan and billing details." (API-key quota)
 * The snake_case codes stay for an event that carries them as text.
 */
const CODEX_MATCHERS: Matcher[] = [
  { re: /\bhit your usage limit\b/i, reason: "quota" },
  { re: /\bquota exceeded\b/i, reason: "insufficient_credits" },
  { re: /\busage_limit_(?:exceeded|reached)\b/i, reason: "quota" },
  { re: /\bworkspace_(?:owner|member)_usage_limit_reached\b/i, reason: "quota" },
  { re: /\bworkspace_(?:owner|member)_credits_depleted\b/i, reason: "insufficient_credits" },
  { re: /\binsufficient_quota\b/i, reason: "insufficient_credits" },
  { re: /\binsufficient (?:credit|credits)\b/i, reason: "insufficient_credits" },
  { re: /\brate_limit_(?:exceeded|reached)\b/i, reason: "rate_limit" },
  { re: /\btoo many requests\b/i, reason: "rate_limit" },
  { re: /\b402\b/, reason: "insufficient_credits" },
  { re: /\b429\b/, reason: "rate_limit" },
];

/** Structured codes (normalized to snake_case) that decide the reason. */
const LIMIT_CODES: Record<string, HarnessLimitReason> = {
  usage_limit_exceeded: "quota",
  usage_limit_reached: "quota",
  workspace_owner_usage_limit_reached: "quota",
  workspace_member_usage_limit_reached: "quota",
  insufficient_quota: "insufficient_credits",
  workspace_owner_credits_depleted: "insufficient_credits",
  workspace_member_credits_depleted: "insufficient_credits",
  rate_limit_exceeded: "rate_limit",
  rate_limit_reached: "rate_limit",
};

/** Structured codes that definitively say "not an account limit". Codex's
 *  `CodexErrorInfo` variants plus the generic auth/outage codes. */
const NEGATIVE_CODES = new Set([
  "server_overloaded",
  "model_not_found",
  "context_window_exceeded",
  "internal_server_error",
  "unauthorized",
  "bad_request",
  "invalid_request",
  "http_connection_failed",
  "response_stream_connection_failed",
  "response_stream_disconnected",
  "sandbox_error",
  "policy_capacity_unavailable",
  "flex_unavailable",
  "cyber_policy",
  "bio_policy",
  "misalignment_policy_violation",
  "authentication_error",
  "permission_error",
  "overloaded_error",
  "api_error",
]);

/** `usageLimitExceeded` / `UsageLimitExceeded` / `usage_limit_exceeded` /
 *  `{ "usage_limit_exceeded": {…} }` → `usage_limit_exceeded`; null when the
 *  value carries no usable code. */
function normalizeErrorCode(code: unknown): string | null {
  let raw: unknown = code;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>);
    raw = keys.length === 1 ? keys[0] : null;
  }
  if (typeof raw !== "string") return null;
  const snake = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(snake) ? snake : null;
}

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
  const matchers = matchersFor(kind);
  if (!matchers) return null;
  const trimmed = typeof input.text === "string" ? input.text.trim() : "";
  const source = kind === "codex" ? "codex-error" as const : "claude-api-error" as const;
  const code = normalizeErrorCode(input.code);
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  if (code !== null) {
    if (NEGATIVE_CODES.has(code)) return null;
    const reason = LIMIT_CODES[code];
    if (reason) {
      return {
        reason,
        resetAtMs: trimmed ? parseClaudeResetNotice(trimmed, now) : null,
        message: sanitizeLimitMessage(trimmed || code),
        source,
      };
    }
  }
  if (!trimmed) return null;
  if (NEGATIVES.some((re) => re.test(trimmed))) return null;
  for (const matcher of matchers) {
    if (!matcher.re.test(trimmed)) continue;
    return {
      reason: matcher.reason,
      resetAtMs: parseClaudeResetNotice(trimmed, now),
      message: sanitizeLimitMessage(trimmed),
      source,
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

const MONTH_SRC =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY_SRC =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?";
const DAY_SRC = "\\d{1,2}(?:st|nd|rd|th)?";
const YEAR_SRC = "\\d{4}";
/** `Nov 10`, `Nov 10th, 2026`, `Tue, Nov 10`, `Tuesday`. */
const DATE_SRC = `(?:${WEEKDAY_SRC},?\\s+)?${MONTH_SRC}\\s+${DAY_SRC}(?:,?\\s+${YEAR_SRC})?|${WEEKDAY_SRC}`;
/** `3pm`, `3:30 PM`, `3 p.m.`, `15:00`. */
const TIME_SRC = "\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?\\s*m\\b\\.?|\\d{1,2}:\\d{2}\\b";
/**
 * The reset phrase after its anchor word: date-first (`Nov 10, 3pm`, `Nov 10
 * at 3pm`, Codex's `Nov 10th, 2026 3:00 PM`, `Tuesday at 3pm`) or time-first
 * (`3pm`, `3pm on Nov 10`, `3pm Tuesday`). Sticky: it must start right after
 * the anchor, so a time somewhere later in the sentence is never borrowed.
 */
const RESET_PHRASE_RE = new RegExp(
  `(?:(?:${DATE_SRC}),?\\s*(?:at\\s+)?(?:${TIME_SRC}))|(?:(?:${TIME_SRC})(?:\\s*(?:,|on)?\\s*(?:${DATE_SRC}))?)`,
  "iy",
);
/** Words a reset instant follows: Claude's `… at 8am` / `resets 3pm` /
 *  `resets Nov 10 at 3pm`, Codex's `try again at 3:00 PM`. An optional `on`/
 *  `at` after the anchor is consumed. */
const RESET_ANCHOR_RE = /\b(?:resets?|until|at)\b\s*(?:(?:on|at)\s+)?/gi;

const TIME_12H_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i;
const TIME_24H_RE = /\b(\d{1,2}):(\d{2})\b/;
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_SRC})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");
const YEAR_RE = /\b(\d{4})\b/;
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_SRC})(?=[\\s,.]|$)`, "i");

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** A dated reset further out than this is not believed (weekly limits are the
 *  longest window either provider prints); the caller falls back to its
 *  default backoff. A time-only reset is at most a day out by construction. */
const MAX_RESET_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;
/** An explicit month/day without a year that already passed by more than
 *  this is read as next year's (a December notice seen across New Year);
 *  anything more recent is a stale notice, not a future reset. */
const YEAR_WRAP_MS = 180 * 24 * 60 * 60 * 1000;

function parseTime(phrase: string): { hour: number; minute: number } | null {
  const m12 = TIME_12H_RE.exec(phrase);
  if (m12) {
    const hourRaw = Number(m12[1]);
    const minute = m12[2] === undefined ? 0 : Number(m12[2]);
    if (hourRaw < 1 || hourRaw > 12 || minute > 59) return null;
    return { hour: (hourRaw % 12) + (m12[3]!.toLowerCase() === "p" ? 12 : 0), minute };
  }
  const m24 = TIME_24H_RE.exec(phrase);
  if (m24) {
    const hour = Number(m24[1]);
    const minute = Number(m24[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

/** Local wall-clock instant, or null when the fields don't name a real date
 *  (Feb 30). Built from calendar fields, never by adding 24 h, so a reset
 *  across a DST change keeps its printed wall-clock time. */
function localInstant(year: number, month: number, day: number, hour: number, minute: number): number | null {
  const date = new Date(year, month, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date.getTime();
}

function resolveResetPhrase(phrase: string, now: number): number | null {
  const time = parseTime(phrase);
  if (!time) return null;
  const today = new Date(now);
  let at: number | null;
  const monthDay = MONTH_DAY_RE.exec(phrase);
  const weekday = WEEKDAY_RE.exec(phrase);
  if (monthDay) {
    const month = MONTH_INDEX[monthDay[1]!.slice(0, 3).toLowerCase()];
    const day = Number(monthDay[2]);
    if (month === undefined) return null;
    const yearMatch = YEAR_RE.exec(phrase);
    if (yearMatch) {
      at = localInstant(Number(yearMatch[1]), month, day, time.hour, time.minute);
    } else {
      at = localInstant(today.getFullYear(), month, day, time.hour, time.minute);
      if (at !== null && at <= now && now - at > YEAR_WRAP_MS) {
        at = localInstant(today.getFullYear() + 1, month, day, time.hour, time.minute);
      }
    }
    // A dated reset that already passed is a stale notice: unsure, so null.
    if (at === null || at <= now) return null;
  } else if (weekday) {
    const target = WEEKDAY_INDEX[weekday[1]!.slice(0, 3).toLowerCase()];
    if (target === undefined) return null;
    const offset = (target - today.getDay() + 7) % 7;
    at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, time.hour, time.minute).getTime();
    if (at <= now) {
      at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset + 7, time.hour, time.minute).getTime();
    }
  } else {
    // Time only: today, or the same wall-clock time on the next calendar day.
    at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), time.hour, time.minute).getTime();
    if (at <= now) {
      at = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, time.hour, time.minute).getTime();
    }
  }
  if (!Number.isFinite(at) || at - now > MAX_RESET_AHEAD_MS) return null;
  return at;
}

/**
 * Best-effort parse of a provider's reset wording into an epoch-ms instant:
 * Claude's `… at 8am` / `resets 3:30pm` / `resets Nov 10 at 3pm` / `resets
 * Tuesday 3pm`, and Codex's `try again at 3:00 PM` / `try again at Nov 10th,
 * 2026 3:00 PM`. Null when unsure — the caller then uses the default backoff.
 *
 * - Time only: today, or the same wall-clock time tomorrow when it already
 *   passed (calendar increment, so a DST change doesn't shift it an hour).
 * - Weekday: the next occurrence of that day at that time (today counts when
 *   the time is still ahead).
 * - Month/day: that date (this year; next year only for a date months in the
 *   past, i.e. across New Year). A dated reset already in the past is stale
 *   and reads as null, as does anything more than 31 days out.
 * Times are local wall-clock: both CLIs print the reset in the machine's own
 * zone, the same zone agetor runs in.
 */
export function parseClaudeResetNotice(text: string, now: number): number | null {
  RESET_ANCHOR_RE.lastIndex = 0;
  for (let anchor = RESET_ANCHOR_RE.exec(text); anchor; anchor = RESET_ANCHOR_RE.exec(text)) {
    RESET_PHRASE_RE.lastIndex = anchor.index + anchor[0].length;
    const phrase = RESET_PHRASE_RE.exec(text);
    if (!phrase) continue;
    return resolveResetPhrase(phrase[0], now);
  }
  return null;
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
