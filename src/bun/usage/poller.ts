import type { AgentKind, Harness, HarnessQuota } from "../../shared/types.ts";
import { USAGE_MIN_REFRESH_MS, USAGE_SUPPORTED_KINDS } from "../../shared/types.ts";
import { harnessUsage, harnesses } from "../db.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { fetchClaudeQuota } from "./claude-usage.ts";
import { fetchCodexQuota } from "./codex-usage.ts";
import { fetchCursorQuota } from "./cursor-usage.ts";

/**
 * Per-harness usage poller (docs/plans/harness-usage-tracker.md, §3 "Refresh:
 * SSE push + background poller", Wave B4). Mirrors the shape of the idle-
 * session reaper `reapIdleSessions()` (src/bun/orchestrator.ts) — a module-
 * level in-flight boolean guards overlapping sweeps, `await Bun.sleep(0)`
 * yields between candidates so a long sweep never blocks the event loop, and
 * every provider failure is swallowed so one bad harness can't abort the
 * sweep or crash the caller. Wave C wires `pollAllUsage` onto a
 * `USAGE_POLL_SWEEP_MS` timer (index.ts / headless.ts) and `refreshOne` onto
 * `POST /harnesses/:id/usage/refresh` (server.ts) — this module only
 * supplies the functions, it does not schedule itself.
 */

/**
 * Registry mapping `AgentKind` → provider fetcher. Deliberately a `Partial`
 * — gemini and grok have no usage provider yet (plan §1 "Non-goals": no
 * live gemini/grok data), so harnesses of those kinds are skipped by both
 * `refreshOne` (returns null, no snapshot stored) and `pollAllUsage` (filtered
 * out of the sweep). Adding a new provider later is one new module + one
 * line here + the kind added to `USAGE_SUPPORTED_KINDS` (shared/types.ts) —
 * the key type below is derived from that list so the webview's
 * supported-kind messaging can't drift from this registry.
 */
export const USAGE_PROVIDERS: Partial<Record<AgentKind, (h: Harness) => Promise<HarnessQuota>>> &
  Record<(typeof USAGE_SUPPORTED_KINDS)[number], (h: Harness) => Promise<HarnessQuota>> = {
  "claude-code": fetchClaudeQuota,
  codex: fetchCodexQuota,
  cursor: fetchCursorQuota,
};

// ── Test seam ────────────────────────────────────────────────────────────
// Real providers hit the network/keychain, so tests can't exercise this
// module's orchestration (freshness floor, force bypass, in-flight guard,
// upsert, broadcast) against them hermetically. `resolveProvider` is the
// single choke point `refreshOne`/`pollAllUsage` use to look up a kind's
// provider; tests substitute a fake via `__setUsageProviderForTest` without
// touching `USAGE_PROVIDERS` itself. With an empty override map (the default
// in production), `resolveProvider` is byte-for-byte equivalent to reading
// `USAGE_PROVIDERS[kind]` directly.
const providerOverrides = new Map<AgentKind, (h: Harness) => Promise<HarnessQuota>>();

function resolveProvider(kind: AgentKind): ((h: Harness) => Promise<HarnessQuota>) | undefined {
  return providerOverrides.get(kind) ?? USAGE_PROVIDERS[kind];
}

/** Test-only: override the provider for a kind (pass null to clear). Never use in production. */
export function __setUsageProviderForTest(
  kind: AgentKind,
  fn: ((h: Harness) => Promise<HarnessQuota>) | null,
): void {
  if (fn) providerOverrides.set(kind, fn);
  else providerOverrides.delete(kind);
}

/**
 * Refresh (or return the cached) `HarnessQuota` snapshot for one harness.
 *
 * - Unknown/disabled harness id → `null` (nothing to refresh, nothing to
 *   show).
 * - Kind has no registered provider (gemini, grok) → `null` — callers must
 *   not synthesize or store an empty snapshot; the UI falls back to just the
 *   availability dot for these kinds.
 * - Otherwise: unless `opts.force`, a cached snapshot fresher than
 *   `USAGE_MIN_REFRESH_MS` is returned as-is, without hitting the provider
 *   again — this is the per-provider floor from the plan (§3) that keeps a
 *   burst of force-refresh clicks or overlapping sweeps from hammering an
 *   undocumented endpoint. On an actual fetch, the provider is already
 *   fail-soft (never throws — resolves a `status:"error"|"unavailable"`
 *   quota instead), but the call is wrapped in try/catch anyway as a
 *   belt-and-braces backstop so a provider regression can never propagate
 *   into the poller/route caller. The fresh snapshot is persisted and
 *   broadcast to every webview before being returned.
 */
export async function refreshOne(
  harnessId: string,
  opts?: { force?: boolean },
): Promise<HarnessQuota | null> {
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness || !harness.enabled) return null;

  const provider = resolveProvider(harness.kind);
  if (!provider) return null;

  if (!opts?.force) {
    const cached = harnessUsage.get(harness.id);
    if (cached && Date.now() - cached.fetchedAtMs < USAGE_MIN_REFRESH_MS) {
      return cached;
    }
  }

  let quota: HarnessQuota;
  try {
    quota = await provider(harness);
  } catch (err) {
    // Belt-and-braces: providers are documented to always resolve, never
    // throw. If one regresses, synthesize an error snapshot rather than
    // letting the throw escape into the sweep/route caller.
    quota = {
      harnessId: harness.id,
      kind: harness.kind,
      planType: null,
      status: "error",
      source: "api",
      fetchedAtMs: Date.now(),
      meters: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  harnessUsage.upsert(quota);
  broadcastAppEvent({ type: "harness_usage", quota, ts: Date.now() });
  return quota;
}

// Guards `pollAllUsage` against overlapping sweeps — same pattern as
// orchestrator.ts's `reapInFlight`.
let pollInFlight = false;

/**
 * Sweep every enabled harness that has a usage provider and refresh its
 * quota snapshot (respecting `refreshOne`'s freshness floor — a harness
 * whose snapshot is still fresh is a no-op read, not a refetch). Never
 * throws: a per-harness failure is logged and skipped so one bad provider
 * can't abort the sweep for the rest. Overlapping calls (e.g. a slow sweep
 * still running when the next timer tick fires) are no-ops via the
 * module-level `pollInFlight` guard, mirroring `reapIdleSessions`.
 */
export async function pollAllUsage(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const candidates = harnesses.list().filter((h) => h.enabled && USAGE_PROVIDERS[h.kind]);
    for (const h of candidates) {
      // Yield between harnesses — mirrors reapIdleSessions's per-candidate
      // `Bun.sleep(0)` so a large harness list never blocks the event loop.
      await Bun.sleep(0);
      try {
        await refreshOne(h.id);
      } catch (err) {
        // refreshOne already fail-softs internally; this is a final
        // backstop so a single harness's failure never aborts the sweep.
        console.error("[agetor] usage poll failed for", h.id, err);
      }
    }
  } finally {
    pollInFlight = false;
  }
}
