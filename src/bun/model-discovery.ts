import { harnesses } from "./db.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import {
  refreshDiscoveredModels,
  refreshHarnessTarget,
  refreshKindModels,
  pruneHarnessDiscovery,
  getDiscoveredModels,
  getHarnessDiscoveredModels,
  isDiscoveryReady,
  type DiscoveredModel,
  type HarnessTarget,
} from "./agent-discovery.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import type { AgentKind, HarnessStatus } from "../shared/types.ts";

/**
 * Scheduler layer on top of `agent-discovery.ts`'s pure, leaf probing
 * module (docs/plans/fx-model-catalog-refresh.md §3 D4). This module is
 * allowed to import `db.ts` (to enumerate registered harnesses) and
 * `agents.ts` (for `harnessEnv`) — the thing `agent-discovery.ts` itself
 * must never do, since that would drag DB-open and process-signal-handler
 * side effects into a module whose whole contract is "leaf, best-effort,
 * never throws".
 *
 * Responsibilities:
 *   - Build the per-harness probe target list from the DB (`discoveryTargets`).
 *   - Fan a full sweep or a single-harness refresh out to `agent-discovery.ts`
 *     and broadcast `agent_models_changed` when a harness's list actually
 *     changed (`publishIfChanged`).
 *   - Watch `HarnessStatus` transitions (`noteHarnessStatuses`) reported by
 *     `GET /harnesses` and debounce a targeted refresh when a harness's
 *     availability/login state changes — covers `fx login`, an install, a
 *     binary swap, etc. without waiting for the 15-minute periodic sweep.
 *   - Run a `.unref()`'d periodic sweep so a long-lived daemon eventually
 *     notices catalog drift even with no triggering event.
 */

const DEBOUNCE_MS = 500;
const DEFAULT_PERIODIC_MS = 15 * 60_000;

/**
 * Every *enabled* fx or codex harness, as a `HarnessTarget` (its own
 * `harnessEnv` and `resolveBin` — so an additional-account harness (fx's
 * `fx-2`-style alias, or a second codex harness with its own `home`) is
 * probed under its own env override rather than agetor's process env, *and*
 * a harness with its own configured `bin` (a second install of that CLI) is
 * probed against that binary rather than the process-wide
 * `AGETOR_<KIND>_BIN ?? "<kind>"` default — `resolveBin` is the exact same
 * resolver `agents.ts` uses for every real spawn of that kind, so discovery
 * can never target a different binary than the one a run would actually
 * launch). Disabled harnesses are skipped — they're hidden from every
 * picker, so probing them would just burn a spawn for a catalog nothing
 * renders. Both kinds joined this per-harness path together historically fx
 * first, codex added by code-review finding #4 on the GPT-6 Astra / codex
 * app-server discovery landing (codex's catalog is account-scoped exactly
 * like fx's — see `discoverCodex`'s doc comment in agent-discovery.ts).
 */
function discoveryTargets(): HarnessTarget[] {
  return harnesses
    .list()
    .filter((h) => h.enabled !== false && (h.kind === "fx" || h.kind === "codex"))
    .map((h) => ({ harnessId: h.id, kind: h.kind as "fx" | "codex", env: harnessEnv(h), bin: resolveBin(h) }));
}

/**
 * Snapshot of the last-published per-harness model id list, keyed by
 * harness id, as a stable JSON string — used by `publishIfChanged` to
 * detect which harnesses actually changed since the last publish. `null`
 * means "no publish has happened yet" (distinct from an empty `Map`, which
 * would mean a publish happened but no harnesses were enabled), so the
 * first publish can special-case "every non-empty harness counts as
 * changed" per the plan.
 */
let previousSnapshot: Map<string, string> | null = null;

// Hashes `id` *and* `efforts` (joined, in reported order) per model, not
// just `id` — a catalog whose ids are unchanged but whose per-model
// discovered effort sets changed (e.g. codex's `model/list` starts/stops
// reporting `ultra` for an id already in the cache) must still be treated
// as a change and publish `agent_models_changed`, since that's the only
// signal that drives a picker refetch.
function snapshotKey(models: DiscoveredModel[]): string {
  return JSON.stringify(models.map((m) => `${m.id}:${(m.efforts ?? []).join(",")}`));
}

function modelsForHarness(harnessId: string, kind: AgentKind): DiscoveredModel[] {
  return kind === "fx" || kind === "codex" ? getHarnessDiscoveredModels(harnessId) : getDiscoveredModels(kind);
}

/**
 * Compares the current per-enabled-harness model lists against the last
 * published snapshot and broadcasts `agent_models_changed` with exactly the
 * ids that changed — never throws (a broadcast failure or a DB hiccup here
 * must never fail the refresh call that triggered it).
 */
function publishIfChanged(): void {
  try {
    const isFirstPublish = previousSnapshot === null;
    const current = new Map<string, string>();
    const changed: string[] = [];
    for (const h of harnesses.list()) {
      if (h.enabled === false) continue;
      const key = snapshotKey(modelsForHarness(h.id, h.kind));
      current.set(h.id, key);
      if (isFirstPublish) {
        if (key !== "[]") changed.push(h.id);
      } else if (previousSnapshot!.get(h.id) !== key) {
        changed.push(h.id);
      }
    }
    previousSnapshot = current;
    if (changed.length > 0) {
      broadcastAppEvent({ type: "agent_models_changed", harnessIds: changed, ts: Date.now() });
    }
  } catch {
    /* never throws — a broadcast/snapshot failure must not fail the caller's refresh */
  }
}

/**
 * Full sweep: every kind's built-in discoverer plus every enabled fx or
 * codex harness's own account-scoped catalog. Broadcasts `agent_models_changed`
 * for whichever harnesses' lists changed. Never throws — this is called
 * fire-and-forget (`void refreshAllModels()`) from index.ts/headless.ts at
 * boot and from the periodic timer, with no caller left to observe a
 * rejection, so a failure here must degrade to a logged no-op rather than an
 * unhandled-rejection crash risk.
 *
 * `discoveryTargets` is passed as a thunk, not its already-called result —
 * `refreshDiscoveredModels` resolves it only once this call's turn in the
 * serialized queue actually starts, so a sweep that was enqueued behind
 * another in-flight refresh still sees any harness created/deleted in the
 * meantime, rather than pruning it from a stale snapshot taken at enqueue
 * time.
 */
export async function refreshAllModels(): Promise<void> {
  try {
    await refreshDiscoveredModels({ fxHarnesses: discoveryTargets });
    publishIfChanged();
  } catch (err) {
    console.error("[agetor] model discovery failed:", err);
  }
}

/**
 * Refreshes exactly one harness — kind-targeted, not a five-kind sweep:
 * an unknown/deleted harness id does nothing at all (there's nothing to
 * refresh and no kind to resolve it to); fx and codex each probe that
 * harness's own account-scoped catalog directly (`refreshHarnessTarget`,
 * keyed by harness id, since both kinds' catalogs vary per harness — codex
 * joined fx on this path via code-review finding #4); every other kind
 * refreshes just that kind's shared cache (`refreshKindModels` — kind-level
 * lists are shared across every harness of that kind, so there's nothing
 * harness-specific left to probe beyond the kind itself). Publishes at most
 * once per call either way. Never throws — every call site here fires this
 * unawaited (`void refreshHarnessModels(...)`), so a failure must degrade to
 * a logged no-op.
 */
export async function refreshHarnessModels(harnessId: string): Promise<void> {
  const harness = harnesses.get(harnessId);
  if (!harness) return;
  try {
    if (harness.kind === "fx" || harness.kind === "codex") {
      await refreshHarnessTarget({
        harnessId: harness.id,
        kind: harness.kind,
        env: harnessEnv(harness),
        bin: resolveBin(harness),
      });
    } else {
      await refreshKindModels(harness.kind);
    }
    publishIfChanged();
  } catch (err) {
    console.error("[agetor] model discovery failed:", err);
  }
}

/**
 * Called when a harness is deleted: prunes its per-harness discovery cache
 * entry (no probe — there's nothing left to refresh) and drops its
 * transition-detector bookkeeping (`lastStatusKey` + any pending debounce
 * timer, see `noteHarnessStatuses`) so a deleted harness id can't linger in
 * either map forever, then publishes once so any UI holding the deleted
 * harness's stale catalog gets the same "it's gone" signal a full sweep
 * would have produced — cheaper than `refreshAllModels()`, which the DELETE
 * route used to call just to exercise its own pruning-by-absence logic.
 * Never throws, matching every other scheduler entry point.
 */
export function noteHarnessRemoved(harnessId: string): void {
  try {
    pruneHarnessDiscovery(harnessId);
    lastStatusKey.delete(harnessId);
    const timer = pendingDebounce.get(harnessId);
    if (timer) {
      clearTimeout(timer);
      pendingDebounce.delete(harnessId);
    }
    publishIfChanged();
  } catch (err) {
    console.error("[agetor] model discovery failed:", err);
  }
}

/**
 * `GET /agent-models/harnesses`'s payload: one key per *enabled* harness
 * (all kinds) — fx and codex harnesses get their own per-harness catalog,
 * every other kind maps to its shared kind-level list, so callers have a
 * single lookup regardless of kind. `ready` mirrors `isDiscoveryReady()` —
 * false until the first full sweep has settled, so the webview's boot-race
 * retry can tell "hasn't run yet" apart from "ran and found nothing".
 */
export function getHarnessModelMap(): { ready: boolean; byHarness: Record<string, DiscoveredModel[]> } {
  const byHarness: Record<string, DiscoveredModel[]> = {};
  for (const h of harnesses.list()) {
    if (h.enabled === false) continue;
    byHarness[h.id] = modelsForHarness(h.id, h.kind);
  }
  return { ready: isDiscoveryReady(), byHarness };
}

/** Last-seen transition key per harness id, `${available}|${path}|${version}|${loggedIn}`. */
const lastStatusKey = new Map<string, string>();
/** Pending debounce timers per harness id — a second transition for the same
 *  harness inside the debounce window resets the timer rather than queuing
 *  a second refresh. */
const pendingDebounce = new Map<string, ReturnType<typeof setTimeout>>();

function statusKey(s: HarnessStatus): string {
  return `${s.available}|${s.path ?? ""}|${s.version ?? ""}|${s.loggedIn}`;
}

function scheduleDebouncedRefresh(harnessId: string): void {
  const existing = pendingDebounce.get(harnessId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingDebounce.delete(harnessId);
    // void-safe: refreshHarnessModels never throws by contract (its own
    // sub-calls degrade to [] / no-op broadcast), but this is a
    // belt-and-suspenders catch since it runs unawaited off a timer with no
    // caller to observe a rejection.
    refreshHarnessModels(harnessId).catch(() => { /* swallow */ });
  }, DEBOUNCE_MS);
  // Matches every other background timer in this file/index.ts/headless.ts:
  // a debounce timer must never by itself keep the process alive past its
  // own idle-shutdown / before-quit path. `.unref?.()` since some
  // lightweight test environments' timer objects don't implement it.
  timer.unref?.();
  pendingDebounce.set(harnessId, timer);
}

/**
 * Transition detector fed by `GET /harnesses` after each `checkAllHarnesses()`
 * probe. A harness seen for the first time is recorded but never triggers a
 * refresh — boot's own `refreshAllModels()` call already covers it. A
 * harness whose `{available, path, version, loggedIn}` key changed since the
 * last sighting schedules a debounced (500ms, per-harness, resettable)
 * refresh — this is what picks up `fx login`, an install, or a binary/version
 * swap without waiting for the 15-minute periodic sweep.
 *
 * `checkAllHarnesses()` (the sole real caller, via `GET /harnesses`) always
 * probes every harness currently in the DB, so any harness id present in
 * `lastStatusKey`/`pendingDebounce` but absent from this call's `statuses`
 * has been deleted since the previous poll — those entries are pruned (and
 * any pending debounce timer for them cleared) so both maps can't grow
 * unboundedly over a long-lived process's lifetime. (Deletion also goes
 * through `noteHarnessRemoved`, which prunes immediately rather than waiting
 * for the next poll — this is the backstop for any harness removal that
 * doesn't route through it.) Never throws.
 */
export function noteHarnessStatuses(statuses: HarnessStatus[]): void {
  try {
    const seen = new Set<string>();
    for (const s of statuses) {
      seen.add(s.harnessId);
      const key = statusKey(s);
      const prev = lastStatusKey.get(s.harnessId);
      lastStatusKey.set(s.harnessId, key);
      if (prev === undefined) continue; // first sight — boot already discovered
      if (prev === key) continue; // unchanged
      scheduleDebouncedRefresh(s.harnessId);
    }
    for (const harnessId of [...lastStatusKey.keys()]) {
      if (seen.has(harnessId)) continue;
      lastStatusKey.delete(harnessId);
      const timer = pendingDebounce.get(harnessId);
      if (timer) {
        clearTimeout(timer);
        pendingDebounce.delete(harnessId);
      }
    }
  } catch {
    /* never throws */
  }
}

let periodicTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic full-sweep timer, `.unref()`'d so it can never by
 * itself keep the process alive (matches every other background timer in
 * `index.ts`/`headless.ts` — see their comments on the idle-shutdown /
 * before-quit contract). Idempotent: a second call while one is already
 * running returns the existing timer instead of creating a duplicate.
 */
export function startPeriodicDiscovery(intervalMs = DEFAULT_PERIODIC_MS): ReturnType<typeof setInterval> {
  if (periodicTimer) return periodicTimer;
  const timer = setInterval(() => {
    void refreshAllModels();
  }, intervalMs);
  timer.unref();
  periodicTimer = timer;
  return periodicTimer;
}

/** Stops the periodic sweep timer, if one is running. Test-only in practice
 *  (production never needs to stop it once started), but exported plainly
 *  since it's a legitimate lifecycle op, not test-only plumbing. */
export function stopPeriodicDiscovery(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

function resetForTests(): void {
  previousSnapshot = null;
  lastStatusKey.clear();
  for (const timer of pendingDebounce.values()) clearTimeout(timer);
  pendingDebounce.clear();
  stopPeriodicDiscovery();
}

export const __testing = {
  resetForTests,
  pendingRefreshCount: () => pendingDebounce.size,
  /** The raw pending debounce timer for one harness id, if any — used to
   *  assert it's `.unref()`'d without exposing the whole map. */
  debounceTimerFor: (harnessId: string) => pendingDebounce.get(harnessId),
  /** Whether `noteHarnessStatuses` is still tracking a transition key for
   *  this harness id — used to assert pruning-by-absence. */
  hasLastStatusKey: (harnessId: string) => lastStatusKey.has(harnessId),
};
