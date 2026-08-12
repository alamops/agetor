/**
 * Codex quota provider — Wave B2 of the per-harness usage tracker
 * (docs/plans/harness-usage-tracker.md, sections 2 and 4).
 *
 * Data sources, API-first with a local-file fallback (both undocumented /
 * reverse-engineered, so both are treated as best-effort — see the plan's
 * "Endpoints are undocumented" note):
 *
 *  1. `auth.json` under `<CODEX_HOME>` holds `{ tokens: { access_token,
 *     account_id } }`. With a token, `GET https://chatgpt.com/backend-api/
 *     wham/usage` returns `{ plan_type, rate_limit: { primary_window,
 *     secondary_window }, credits, additional_rate_limits[] }`.
 *  2. When there's no token, the fetch fails, or the API returns zero
 *     meters, fall back to the newest `sessions/YYYY/MM/DD/rollout-*.jsonl`
 *     (or `archived_sessions/`) file's last `token_count` event, which
 *     carries a `rate_limits` blob shaped like `{ primary: { used_percent,
 *     window_minutes, resets_at|resets_in_seconds }, secondary: {...},
 *     credits: {...} }`. Per openai/codex#14728, exec-mode sessions can
 *     omit `rate_limits` entirely (null) — that's a normal "no data" case,
 *     not an error.
 *
 * Every exported function here fails soft: parsers return `[]` on
 * unrecognized input, resolvers return `null`/nulls on any I/O error, and
 * `fetchCodexQuota` always resolves to a `HarnessQuota` (never throws),
 * because it feeds a background poller that must not die on one bad
 * harness or one flaky endpoint.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Harness, HarnessQuota, QuotaMeter } from "../../shared/types.ts";

/** Fetch timeout for the live `wham/usage` call. */
const FETCH_TIMEOUT_MS = 5000;

/** Filename pattern for a codex session rollout log. */
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;

/** Bound on how deep we'll recurse under `sessions/`/`archived_sessions/`. */
const MAX_WALK_DEPTH = 6;

/**
 * `<home>/.codex` for an aliased harness, else `~/.codex` for the main
 * account — mirrors `harnessEnv`'s `CODEX_HOME = path.join(home, ".codex")`
 * (src/bun/agents.ts:231); `home=null` inherits the real home dir.
 */
export function codexHome(harness: Harness): string {
  return harness.home ? path.join(harness.home, ".codex") : path.join(homedir(), ".codex");
}

/**
 * Read `<codexHome>/auth.json` and pull out the OAuth access token +
 * account id. Tolerates the flat `{ OPENAI_API_KEY }` shape some codex
 * installs use (API-key auth, no OAuth token) by simply returning nulls —
 * the caller falls back to the local-file quota source in that case. Never
 * throws.
 */
export function readCodexToken(harness: Harness): {
  accessToken: string | null;
  accountId: string | null;
} {
  try {
    const authPath = path.join(codexHome(harness), "auth.json");
    if (!existsSync(authPath)) return { accessToken: null, accountId: null };
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "tokens" in parsed &&
      (parsed as Record<string, unknown>).tokens &&
      typeof (parsed as Record<string, unknown>).tokens === "object"
    ) {
      const tokens = (parsed as Record<string, unknown>).tokens as Record<string, unknown>;
      const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
      const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
      return { accessToken, accountId };
    }
    // Flat `{ OPENAI_API_KEY }` (or any other unrecognized shape) — no
    // usable OAuth token for the wham endpoint.
    return { accessToken: null, accountId: null };
  } catch {
    return { accessToken: null, accountId: null };
  }
}

/** Infer a stable meter id + label from a rate-limit window's duration. */
function inferWindowRole(seconds: number): { id: string; label: string } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { id: "window", label: "Usage" };
  if (seconds <= 6 * 3600) return { id: "session", label: "Session (5h)" };
  if (seconds >= 6 * 24 * 3600 && seconds <= 8 * 24 * 3600) return { id: "weekly", label: "Weekly" };
  const hours = Math.round(seconds / 3600);
  return { id: `window_${seconds}`, label: `${hours}h window` };
}

/** Build a `QuotaMeter` from a `{ used_percent, reset_at }`-shaped window. */
function meterFromSecondsWindow(
  window: Record<string, unknown>,
  id: string,
  label: string,
  scope?: string,
): QuotaMeter | null {
  const usedPercentRaw = window.used_percent;
  if (typeof usedPercentRaw !== "number" || !Number.isFinite(usedPercentRaw)) return null;
  const resetAt = window.reset_at;
  const resetsAtMs = typeof resetAt === "number" && resetAt > 0 ? resetAt * 1000 : null;
  const meter: QuotaMeter = {
    id,
    label,
    usedPercent: Math.round(usedPercentRaw),
    resetsAtMs,
  };
  if (scope) meter.scope = scope;
  return meter;
}

/** Add a "credits" meter (balance-in-label, no percent) when applicable. */
function pushCreditsMeter(meters: QuotaMeter[], credits: unknown): void {
  if (!credits || typeof credits !== "object") return;
  const c = credits as Record<string, unknown>;
  if (c.has_credits === true && c.unlimited !== true && c.balance !== null && c.balance !== undefined) {
    meters.push({
      id: "credits",
      label: `Credits: ${c.balance}`,
      usedPercent: 0,
      resetsAtMs: null,
    });
  }
}

/**
 * Pure mapper: `wham/usage` response body → `QuotaMeter[]`. Handles the
 * top-level `rate_limit.{primary_window,secondary_window}`, an optional
 * `credits` balance, and model-scoped `additional_rate_limits[]` (each
 * with its own `primary_window`/`secondary_window` and a `limit_name`
 * used as the meter `scope`). Defensive against any unrecognized shape —
 * returns `[]` rather than throwing.
 */
export function parseCodexUsage(json: unknown, _fetchedAtMs: number): QuotaMeter[] {
  try {
    if (!json || typeof json !== "object") return [];
    const body = json as Record<string, unknown>;
    const meters: QuotaMeter[] = [];

    const rateLimit = body.rate_limit;
    if (rateLimit && typeof rateLimit === "object") {
      const rl = rateLimit as Record<string, unknown>;
      for (const key of ["primary_window", "secondary_window"] as const) {
        const window = rl[key];
        if (!window || typeof window !== "object") continue;
        const w = window as Record<string, unknown>;
        const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : 0;
        const role = inferWindowRole(seconds);
        const meter = meterFromSecondsWindow(w, role.id, role.label);
        if (meter) meters.push(meter);
      }
    }

    pushCreditsMeter(meters, body.credits);

    const additional = body.additional_rate_limits;
    if (Array.isArray(additional)) {
      for (const entry of additional) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const scope = typeof e.limit_name === "string" ? e.limit_name : undefined;
        for (const key of ["primary_window", "secondary_window"] as const) {
          const window = e[key];
          if (!window || typeof window !== "object") continue;
          const w = window as Record<string, unknown>;
          const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : 0;
          const role = inferWindowRole(seconds);
          const id = scope ? `${scope}_${role.id}` : role.id;
          const label = scope ? `${scope} — ${role.label}` : role.label;
          const meter = meterFromSecondsWindow(w, id, label, scope);
          if (meter) meters.push(meter);
        }
      }
    }

    return meters;
  } catch {
    return [];
  }
}

/**
 * Pure mapper: a session JSONL's `token_count.rate_limits` blob →
 * `QuotaMeter[]`. Window duration here is in MINUTES (`window_minutes`),
 * unlike the API shape's seconds. Per openai/codex#14728 this blob can be
 * entirely absent (exec-mode sessions) — `rateLimits == null` returns `[]`,
 * which the caller (`fetchCodexQuota`) treats as "no data", not an error.
 */
export function parseCodexSessionRateLimits(rateLimits: unknown, fetchedAtMs: number): QuotaMeter[] {
  try {
    if (!rateLimits || typeof rateLimits !== "object") return [];
    const rl = rateLimits as Record<string, unknown>;
    const meters: QuotaMeter[] = [];

    const buildMeter = (window: unknown, fallbackId: string): QuotaMeter | null => {
      if (!window || typeof window !== "object") return null;
      const w = window as Record<string, unknown>;
      const usedPercentRaw = w.used_percent;
      if (typeof usedPercentRaw !== "number" || !Number.isFinite(usedPercentRaw)) return null;
      const minutes = typeof w.window_minutes === "number" ? w.window_minutes : 0;
      const role = inferWindowRole(minutes * 60);
      let resetsAtMs: number | null = null;
      if (typeof w.resets_at === "number" && w.resets_at > 0) {
        resetsAtMs = w.resets_at * 1000;
      } else if (typeof w.resets_in_seconds === "number" && w.resets_in_seconds >= 0) {
        resetsAtMs = fetchedAtMs + w.resets_in_seconds * 1000;
      }
      return {
        id: role.id === "window" ? fallbackId : role.id,
        label: role.label,
        usedPercent: Math.round(usedPercentRaw),
        resetsAtMs,
      };
    };

    const primary = buildMeter(rl.primary, "primary");
    if (primary) meters.push(primary);
    const secondary = buildMeter(rl.secondary, "secondary");
    if (secondary) meters.push(secondary);

    pushCreditsMeter(meters, rl.credits);

    return meters;
  } catch {
    return [];
  }
}

/** One candidate rollout file with its mtime, for newest-file selection. */
interface RolloutCandidate {
  filePath: string;
  mtimeMs: number;
}

/** Recursively collect `rollout-*.jsonl` files under `dir`, bounded by depth. */
function collectRolloutFiles(dir: string, depth: number, out: RolloutCandidate[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRolloutFiles(entryPath, depth + 1, out);
    } else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) {
      try {
        const stat = statSync(entryPath);
        out.push({ filePath: entryPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip files that vanish between readdir and stat.
      }
    }
  }
}

/**
 * Find the newest `rollout-*.jsonl` under `<codexHome>/sessions/` (falling
 * back to `<codexHome>/archived_sessions/` when `sessions/` has nothing),
 * and pull the last `token_count` event's `rate_limits` blob out of it.
 * Never throws — returns `null` on any I/O or parse failure, or when no
 * rollout file carries a `rate_limits` blob at all.
 */
export function readNewestCodexRateLimits(harness: Harness): { rateLimits: unknown; mtimeMs: number } | null {
  try {
    const home = codexHome(harness);
    const candidates: RolloutCandidate[] = [];
    for (const sub of ["sessions", "archived_sessions"]) {
      const dir = path.join(home, sub);
      if (existsSync(dir)) collectRolloutFiles(dir, 0, candidates);
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = candidates[0];
    if (!newest) return null;
    const text = readFileSync(newest.filePath, "utf8");
    const lines = text.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Record<string, unknown>;
      if (
        record.type === "event_msg" &&
        record.payload &&
        typeof record.payload === "object" &&
        (record.payload as Record<string, unknown>).type === "token_count" &&
        (record.payload as Record<string, unknown>).rate_limits
      ) {
        return { rateLimits: (record.payload as Record<string, unknown>).rate_limits, mtimeMs: newest.mtimeMs };
      }
      if (record.rate_limits) {
        return { rateLimits: record.rate_limits, mtimeMs: newest.mtimeMs };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a codex harness's quota: live `wham/usage` first, falling back
 * to the newest session JSONL's cached `rate_limits` on any API failure or
 * a zero-meter response. Always resolves — never throws — so it's safe to
 * call from a background poller fan-out (see B4/poller.ts).
 */
export async function fetchCodexQuota(harness: Harness): Promise<HarnessQuota> {
  const fetchedAtMs = Date.now();
  const { accessToken, accountId } = readCodexToken(harness);

  if (accessToken) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        };
        if (accountId) headers["chatgpt-account-id"] = accountId;
        const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
          headers,
          signal: controller.signal,
        });
        if (res.ok) {
          const body: unknown = await res.json().catch(() => null);
          const meters = parseCodexUsage(body, fetchedAtMs);
          if (meters.length > 0) {
            const planType =
              body && typeof body === "object" && typeof (body as Record<string, unknown>).plan_type === "string"
                ? ((body as Record<string, unknown>).plan_type as string)
                : null;
            return {
              harnessId: harness.id,
              kind: harness.kind,
              planType,
              status: "ok",
              source: "api",
              fetchedAtMs,
              meters,
              reason: null,
            };
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // Network error, timeout/abort, or bad JSON — fall through to the
      // local-file fallback below.
    }
  }

  // No token, API failure, or an API response with zero meters — fall back
  // to the newest session JSONL's cached rate_limits.
  let rateLimits: unknown = null;
  try {
    rateLimits = readNewestCodexRateLimits(harness)?.rateLimits ?? null;
  } catch {
    rateLimits = null;
  }
  const meters = parseCodexSessionRateLimits(rateLimits, fetchedAtMs);
  return {
    harnessId: harness.id,
    kind: harness.kind,
    planType: null,
    status: meters.length > 0 ? "ok" : "unavailable",
    source: "cache",
    fetchedAtMs,
    meters,
    reason: meters.length > 0 ? null : "No recent codex rate-limit data (exec-mode sessions omit it)",
  };
}
