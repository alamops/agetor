/**
 * Claude-code usage/quota provider for the topbar usage tracker
 * (docs/plans/harness-usage-tracker.md, section 2 "claude-code" bullet and
 * Wave B1). API-first (`/api/oauth/usage`), falling back to the on-disk
 * `.claude.json` `cachedUsageUtilization` cache the CLI itself maintains.
 * `fetchClaudeQuota` always resolves — it never throws into the poller.
 */

import { existsSync } from "node:fs";
import type { AgentKind, Harness, HarnessQuota, QuotaMeter, QuotaSource } from "../../shared/types.ts";
import { claudeDotJsonPath, readClaudeToken } from "./creds.ts";

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 5000;
const REQUIRED_SCOPE = "user:profile";

/** Scalar meter fields shared by the OAuth response and the `.claude.json`
 *  `cachedUsageUtilization.utilization` cache (same field names — plan
 *  section 2, "already normalized to the same field names"). */
const SCALAR_FIELDS: Array<{ key: string; id: string; label: string; scope?: string }> = [
  { key: "five_hour", id: "five_hour", label: "Session (5h)" },
  { key: "seven_day", id: "seven_day", label: "Weekly" },
  { key: "seven_day_opus", id: "seven_day_opus", label: "Weekly Opus", scope: "Opus" },
  { key: "seven_day_sonnet", id: "seven_day_sonnet", label: "Weekly Sonnet", scope: "Sonnet" },
  { key: "seven_day_routines", id: "seven_day_routines", label: "Daily routines" },
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `utilization` is 0..1 per the provider; clamp + round to a 0..100 percent. */
function utilizationToPercent(utilization: unknown): number | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  return Math.round(Math.min(1, Math.max(0, utilization)) * 100);
}

/** `percent` (from `limits[]`) is already 0..100; clamp + round defensively. */
function clampPercent(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

function parseResetsAtMs(resetsAt: unknown): number | null {
  if (typeof resetsAt !== "string" || !resetsAt) return null;
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Map one scalar field (`{utilization, resets_at}`) to a `QuotaMeter`, or
 * `null` when the field is absent/malformed (present-only mapping — plan
 * section 2's field list, "each present-only").
 */
function mapScalarField(
  raw: unknown,
  id: string,
  label: string,
  scope?: string,
): QuotaMeter | null {
  if (!isObject(raw)) return null;
  const usedPercent = utilizationToPercent(raw.utilization);
  if (usedPercent === null) return null;
  const meter: QuotaMeter = {
    id,
    label,
    usedPercent,
    resetsAtMs: parseResetsAtMs(raw.resets_at),
  };
  if (scope) meter.scope = scope;
  return meter;
}

/**
 * Map the `extra_usage` field — a single object gated by `is_enabled` in the
 * shapes we've observed, but read defensively in case a future response
 * shape makes it an array of extra-usage entries.
 */
function mapExtraUsage(raw: unknown): QuotaMeter[] {
  const entries = Array.isArray(raw) ? raw : isObject(raw) ? [raw] : [];
  const meters: QuotaMeter[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    if (entry.is_enabled !== true) continue;
    const usedPercent = utilizationToPercent(entry.utilization);
    if (usedPercent === null) continue;
    meters.push({
      id: "extra_usage",
      label: "Extra usage",
      usedPercent,
      resetsAtMs: parseResetsAtMs(entry.resets_at),
    });
  }
  return meters;
}

/** Derive a stable meter id + label/scope from one `limits[]` entry. Falls
 *  back to `group` or a positional id when `kind` is missing so a shape
 *  drift never throws. */
function mapLimitEntry(entry: unknown, index: number): QuotaMeter | null {
  if (!isObject(entry)) return null;
  const usedPercent = clampPercent(entry.percent);
  if (usedPercent === null) return null;
  const kind = typeof entry.kind === "string" && entry.kind ? entry.kind : null;
  const group = typeof entry.group === "string" && entry.group ? entry.group : null;
  const id = kind ?? group ?? `limit_${index}`;
  const modelName =
    isObject(entry.scope) && isObject((entry.scope as Record<string, unknown>).model)
      ? ((entry.scope as Record<string, unknown>).model as Record<string, unknown>).display_name
      : undefined;
  const scope = typeof modelName === "string" && modelName ? modelName : undefined;
  const known = SCALAR_FIELDS.find((f) => f.id === id);
  const label = known ? known.label : scope ? `${group ?? "Usage"} (${scope})` : (group ?? id);
  const meter: QuotaMeter = {
    id,
    label,
    usedPercent,
    resetsAtMs: parseResetsAtMs(entry.resets_at),
  };
  if (scope) meter.scope = scope;
  return meter;
}

/**
 * Pure mapper: OAuth `/api/oauth/usage` response OR `.claude.json`'s
 * `cachedUsageUtilization.utilization` object → `QuotaMeter[]`. Both shapes
 * share field names (plan section 2), so one parser covers both sources.
 * Defensive throughout — unknown/missing fields are skipped, never thrown;
 * unrecognized input returns `[]`. `harnessId`/`kind`/`source`/`fetchedAtMs`
 * are accepted for a uniform provider-parser signature (mirrored by the
 * codex/cursor providers) but don't affect the meters themselves.
 */
export function parseClaudeUsage(
  json: unknown,
  _harnessId: string,
  _kind: AgentKind,
  _source: QuotaSource,
  _fetchedAtMs: number,
): QuotaMeter[] {
  if (!isObject(json)) return [];

  const meters = new Map<string, QuotaMeter>();

  // `limits[]` is the newer, model-scoped shape and fully supersedes the flat
  // scalar fields when present. Prefer it EXCLUSIVELY (rather than merging by
  // id) so a `limits[]` entry whose id doesn't happen to match a scalar id
  // can't produce a duplicate meter for the same underlying window. `extra_usage`
  // (a distinct credit meter, not a rate window) is still included either way.
  const limitMeters: QuotaMeter[] = [];
  if (Array.isArray(json.limits)) {
    json.limits.forEach((entry, index) => {
      const meter = mapLimitEntry(entry, index);
      if (meter) limitMeters.push(meter);
    });
  }

  if (limitMeters.length > 0) {
    for (const meter of limitMeters) meters.set(meter.id, meter);
  } else {
    for (const field of SCALAR_FIELDS) {
      const meter = mapScalarField(json[field.key], field.id, field.label, field.scope);
      if (meter) meters.set(meter.id, meter);
    }
  }

  for (const meter of mapExtraUsage(json.extra_usage)) {
    meters.set(meter.id, meter);
  }

  return Array.from(meters.values());
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorQuota(harness: Harness, status: "error" | "unavailable", reason: string): HarnessQuota {
  return {
    harnessId: harness.id,
    kind: harness.kind,
    planType: null,
    status,
    source: "cache",
    fetchedAtMs: Date.now(),
    meters: [],
    reason,
  };
}

/** Attempt the live OAuth usage fetch. Returns `null` on any failure (no
 *  token, missing scope, non-2xx, network throw, unparseable body, or zero
 *  mapped meters) so the caller falls through to the file-cache fallback —
 *  never throws. */
async function tryFetchApiQuota(harness: Harness): Promise<HarnessQuota | null> {
  const { token, scopes } = await readClaudeToken(harness);
  if (!token || !scopes.includes(REQUIRED_SCOPE)) return null;

  try {
    const res = await fetchWithTimeout(OAUTH_USAGE_URL, {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-code/unknown",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const now = Date.now();
    const meters = parseClaudeUsage(body, harness.id, harness.kind, "api", now);
    if (meters.length === 0) return null;
    const planType =
      isObject(body) && typeof body.plan_type === "string" ? body.plan_type : null;
    return {
      harnessId: harness.id,
      kind: harness.kind,
      planType,
      status: "ok",
      source: "api",
      fetchedAtMs: now,
      meters,
      reason: null,
    };
  } catch {
    return null;
  }
}

/** Read the `.claude.json` cache the claude CLI itself maintains
 *  (`cachedUsageUtilization.{utilization,fetchedAtMs}`). Returns `null` if
 *  the file is missing, unparseable, or has no usable utilization block. */
async function tryReadCacheQuota(harness: Harness): Promise<HarnessQuota | null> {
  const filePath = claudeDotJsonPath(harness);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await Bun.file(filePath).text();
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const cached = parsed.cachedUsageUtilization;
    if (!isObject(cached)) return null;
    const cachedFetchedAtMs =
      typeof cached.fetchedAtMs === "number" && Number.isFinite(cached.fetchedAtMs)
        ? cached.fetchedAtMs
        : Date.now();
    const meters = parseClaudeUsage(
      cached.utilization,
      harness.id,
      harness.kind,
      "cache",
      cachedFetchedAtMs,
    );
    return {
      harnessId: harness.id,
      kind: harness.kind,
      planType: null,
      status: meters.length > 0 ? "ok" : "unavailable",
      source: "cache",
      fetchedAtMs: cachedFetchedAtMs,
      meters,
      reason: meters.length > 0 ? null : "No cached usage data in .claude.json yet",
    };
  } catch {
    return null;
  }
}

/**
 * Orchestrates API-first → file-fallback quota resolution for a claude-code
 * harness (plan section 3, "Provider seam"). Always resolves — never
 * throws — so a single misbehaving harness can't take down the poller.
 */
export async function fetchClaudeQuota(harness: Harness): Promise<HarnessQuota> {
  try {
    const apiQuota = await tryFetchApiQuota(harness);
    if (apiQuota) return apiQuota;
  } catch {
    // fall through to cache
  }

  try {
    const cacheQuota = await tryReadCacheQuota(harness);
    if (cacheQuota) return cacheQuota;
  } catch {
    // fall through to the terminal "no data" result below
  }

  return errorQuota(
    harness,
    "unavailable",
    "No usage data available (no API token/scope and no cached usage file)",
  );
}
