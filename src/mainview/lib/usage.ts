/**
 * Pure presentation logic for the per-harness usage tracker (topbar chip
 * mini-bar + popover). No DOM, no React, no I/O — mirrors the split in
 * `font-size.ts` / `todo-progress.ts`: this module derives the numbers and
 * labels; the components (`UsageMeter.tsx`, `UsagePopover.tsx`, D2) do the
 * actual rendering.
 */
import { USAGE_CRIT_PERCENT, USAGE_WARN_PERCENT, type QuotaMeter } from "../../shared/types.ts";

export type WarnTier = "ok" | "warn" | "crit";

/**
 * Classify a used-percent value into a warn tier: `>= USAGE_CRIT_PERCENT`
 * (90) is "crit", `>= USAGE_WARN_PERCENT` (70) is "warn", else "ok". A
 * non-finite input (NaN, ±Infinity — a malformed/missing provider value)
 * never escalates past "ok" rather than risk a false alarm.
 */
export function warnTier(usedPercent: number): WarnTier {
  if (!Number.isFinite(usedPercent)) return "ok";
  if (usedPercent >= USAGE_CRIT_PERCENT) return "crit";
  if (usedPercent >= USAGE_WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * The meter with the highest `usedPercent` in a snapshot's `meters` list —
 * this is what the topbar chip's mini-bar renders (worst case drives the
 * warn color). Ties keep the first occurrence. `null` for an empty list.
 */
export function worstMeter(meters: QuotaMeter[]): QuotaMeter | null {
  let worst: QuotaMeter | null = null;
  for (const m of meters) {
    if (worst === null || m.usedPercent > worst.usedPercent) worst = m;
  }
  return worst;
}

/** `warnTier` of `worstMeter(meters)`'s percent, or "ok" when there are no
 *  meters at all (nothing to warn about). */
export function worstTier(meters: QuotaMeter[]): WarnTier {
  const worst = worstMeter(meters);
  return worst ? warnTier(worst.usedPercent) : "ok";
}

/**
 * Map a warn tier to the semantic CSS token name (`--success`/`--warning`/
 * `--danger`, defined in both `src/mainview/index.css` and
 * `tailwind.config.js` — see CLAUDE.md's "undefined-token trap"). Returns
 * just the token name (e.g. "warning"); callers compose the Tailwind class
 * they need (`bg-warning`, `text-warning`, `bg-warning/10`, …).
 */
export function tierColorVar(tier: WarnTier): "success" | "warning" | "danger" {
  switch (tier) {
    case "crit":
      return "danger";
    case "warn":
      return "warning";
    case "ok":
      return "success";
  }
}

/** Clamp a percent value to [0, 100] for use as a bar width. A non-finite
 *  input (NaN, ±Infinity) clamps to 0 rather than producing an invalid
 *  `width` style. */
export function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

/**
 * Filter a list of agent statuses down to the ones whose harness is
 * `enabled` — this is what drives the window topbar's chip list. An agent
 * whose harness id has no matching row (or whose row is disabled) is
 * dropped, same as today's `harness?.enabled ?? false` inline check.
 * Enabled-but-unavailable/logged-out harnesses still pass through; this
 * only looks at the Settings toggle, not live probe state. Input order is
 * preserved.
 */
export function visibleTopbarAgents<A extends { harnessId: string }>(
  agents: readonly A[],
  harnesses: readonly { id: string; enabled: boolean }[],
): A[] {
  return agents.filter((a) => harnesses.find((h) => h.id === a.harnessId)?.enabled ?? false);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Human relative label for when a meter resets, e.g. "resets in 3h",
 * "resets in 2d", "resets in 5m". `null` (provider didn't report a reset
 * time) or a `resetsAtMs` at/before `nowMs` both render as "" — a countdown
 * to the past isn't useful and the caller just omits the label. Pure: takes
 * `nowMs` explicitly rather than calling `Date.now()` so it's deterministic
 * under test.
 */
export function formatResetsIn(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs == null || !Number.isFinite(resetsAtMs)) return "";
  const deltaMs = resetsAtMs - nowMs;
  if (deltaMs <= 0) return "";
  if (deltaMs < HOUR_MS) {
    const mins = Math.max(1, Math.round(deltaMs / MINUTE_MS));
    return `resets in ${mins}m`;
  }
  if (deltaMs < DAY_MS) {
    const hours = Math.round(deltaMs / HOUR_MS);
    return `resets in ${hours}h`;
  }
  const days = Math.round(deltaMs / DAY_MS);
  return `resets in ${days}d`;
}

/**
 * Human relative "last updated" label for a snapshot's `fetchedAtMs`, e.g.
 * "updated just now" / "updated 2m ago" / "updated 3h ago". Pure: takes
 * `nowMs` explicitly rather than calling `Date.now()`. A `fetchedAtMs` in
 * the future (clock skew) also reads as "updated just now" rather than a
 * nonsensical negative duration.
 */
export function formatUpdatedAgo(fetchedAtMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - fetchedAtMs);
  if (deltaMs < MINUTE_MS) return "updated just now";
  if (deltaMs < HOUR_MS) {
    const mins = Math.round(deltaMs / MINUTE_MS);
    return `updated ${mins}m ago`;
  }
  if (deltaMs < DAY_MS) {
    const hours = Math.round(deltaMs / HOUR_MS);
    return `updated ${hours}h ago`;
  }
  const days = Math.round(deltaMs / DAY_MS);
  return `updated ${days}d ago`;
}
