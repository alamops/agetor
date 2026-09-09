// Pure helpers for fx's usage/cost sentinel (`FX_USAGE_STATUS_PREFIX`, see
// src/shared/types.ts for the wire shape and the two sources that feed it —
// the ACP `usage_update` notification's `{used, size, cost?}` and the
// `session/prompt` result's per-turn `usage` object, mapped to `{turn}`).
// No React here so both the webview and bun-side tests can import this
// directly. RunPanel is the sole consumer today.
import { FX_TURN_KEYS, type FxUsagePayload } from "../../shared/types.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a `FX_USAGE_STATUS_PREFIX` sentinel body into a validated
 * {@link FxUsagePayload}, or `null` if nothing usable survives. Unknown keys
 * are dropped silently (forward-compat with a future fx wire shape); a
 * present-but-wrong-typed known key is dropped on its own rather than
 * failing the whole parse — e.g. `{"used":"x","size":5}` yields `{size:5}`.
 * `cost` is kept only as a whole `{amount:number, currency:string}` pair (a
 * malformed cost is dropped entirely, never partially). `turn` is kept only
 * when at least one of its five known fields is a finite number — an
 * all-unknown-or-invalid `turn` object is dropped rather than surviving as
 * `{}`. Returns `null` when the resulting payload would have no keys at all
 * (e.g. `parseFxUsage("{}")`).
 */
export function parseFxUsage(json: string): FxUsagePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;

  const out: FxUsagePayload = {};

  if (typeof raw.used === "number" && Number.isFinite(raw.used)) out.used = raw.used;
  if (typeof raw.size === "number" && Number.isFinite(raw.size)) out.size = raw.size;

  if (isPlainObject(raw.cost)) {
    const { amount, currency } = raw.cost;
    if (typeof amount === "number" && Number.isFinite(amount) && typeof currency === "string") {
      out.cost = { amount, currency };
    }
  }

  if (isPlainObject(raw.turn)) {
    const turn: NonNullable<FxUsagePayload["turn"]> = {};
    for (const key of FX_TURN_KEYS) {
      const value = raw.turn[key];
      if (typeof value === "number" && Number.isFinite(value)) turn[key] = value;
    }
    if (Object.keys(turn).length > 0) out.turn = turn;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Shallow-merge a newly-parsed sentinel onto the previous payload seen for a
 * run: `{...prev, ...next}`. `used`/`size`/`cost` take the latest value seen
 * for each key independently; `turn` is replaced wholesale by a later one
 * rather than merged field-by-field (fx emits `turn` as one complete object
 * per turn, so a partial merge would mix two different turns' numbers).
 */
export function mergeFxUsage(prev: FxUsagePayload | undefined, next: FxUsagePayload): FxUsagePayload {
  return { ...prev, ...next };
}

/** Compact token-count formatting for the usage chip: 45_000 → "45k",
 *  1_200_000 → "1.2M". Whole thousands/millions drop the decimal. */
export function formatUsageCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return String(n);
}

/** `· $x.xx` (USD) / `· <amount> <CUR>` (other currencies) cost suffix, or
 *  `""` when no cost is known. Sub-cent USD amounts round to "$0.00" under
 *  two decimals — nearly every fx call at typical token volumes costs a
 *  fraction of a cent, so that's the common case, not an edge case — widen
 *  to four decimals below that threshold. */
function costSuffix(cost: FxUsagePayload["cost"]): string {
  if (!cost) return "";
  const display = cost.amount < 0.01 ? cost.amount.toFixed(4) : cost.amount.toFixed(2);
  return cost.currency === "USD" ? ` · $${display}` : ` · ${display} ${cost.currency}`;
}

/**
 * The run-row chip's visible text, or `null` when there's nothing to show.
 * `used`+`size` (context-window usage, fx ≥0.0.8's `usage_update`) wins when
 * both are known: `${used}/${size}` plus the cost suffix. Otherwise, when at
 * least one of `turn.inputTokens`/`turn.outputTokens` (per-turn usage from
 * the `session/prompt` result) is known, falls back to a compact
 * `↑in ↓out` form (missing half reads as 0). Otherwise `null` — no chip.
 */
export function fxUsageChipText(u: FxUsagePayload): string | null {
  if (typeof u.used === "number" && typeof u.size === "number") {
    return `${formatUsageCount(u.used)}/${formatUsageCount(u.size)}${costSuffix(u.cost)}`;
  }
  if (u.turn && (typeof u.turn.inputTokens === "number" || typeof u.turn.outputTokens === "number")) {
    return `↑${formatUsageCount(u.turn.inputTokens ?? 0)} ↓${formatUsageCount(u.turn.outputTokens ?? 0)}`;
  }
  return null;
}

/**
 * The chip's hover tooltip: the exact (non-abbreviated) numbers behind
 * {@link fxUsageChipText}. `fx usage: <used>/<size> tokens` (toLocaleString)
 * when both are known, followed by `· <amount> <currency>` when a cost is
 * known; then a `turn: in <n> · out <n> · cache read <n> · cache write <n> ·
 * reasoning <n>` segment listing only the per-turn fields that are present
 * (so a turn payload carrying only cache fields prints `turn:` with just
 * those). The two segments are joined by ` · ` when both are present.
 */
export function fxUsageTitle(u: FxUsagePayload): string {
  const segments: string[] = [];

  if (typeof u.used === "number" && typeof u.size === "number") {
    let usageSegment = `fx usage: ${u.used.toLocaleString()}/${u.size.toLocaleString()} tokens`;
    if (u.cost) usageSegment += ` · ${u.cost.amount} ${u.cost.currency}`;
    segments.push(usageSegment);
  }

  if (u.turn) {
    const turnBits: string[] = [];
    if (typeof u.turn.inputTokens === "number") turnBits.push(`in ${u.turn.inputTokens}`);
    if (typeof u.turn.outputTokens === "number") turnBits.push(`out ${u.turn.outputTokens}`);
    if (typeof u.turn.cacheReadTokens === "number") turnBits.push(`cache read ${u.turn.cacheReadTokens}`);
    if (typeof u.turn.cacheWriteTokens === "number") turnBits.push(`cache write ${u.turn.cacheWriteTokens}`);
    if (typeof u.turn.reasoningTokens === "number") turnBits.push(`reasoning ${u.turn.reasoningTokens}`);
    if (turnBits.length > 0) segments.push(`turn: ${turnBits.join(" · ")}`);
  }

  return segments.join(" · ");
}
