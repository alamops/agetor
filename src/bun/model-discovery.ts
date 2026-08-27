import { harnesses } from "./db.ts";
import { harnessEnv } from "./agents.ts";
import {
  refreshDiscoveredModels,
  refreshFxHarnessModels,
  getDiscoveredModels,
  getHarnessDiscoveredModels,
  isDiscoveryReady,
  type DiscoveredModel,
  type FxHarnessTarget,
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
 * Every *enabled* fx harness, as an `FxHarnessTarget` (its own `harnessEnv`,
 * so an additional-account `fx-2`-style harness is probed under its own
 * `HOME` override rather than agetor's process env). Disabled harnesses are
 * skipped — they're hidden from every picker, so probing them would just
 * burn a ~0.3-0.9s spawn for a catalog nothing renders.
 */
function discoveryTargets(): FxHarnessTarget[] {
  return harnesses
    .list()
    .filter((h) => h.enabled !== false && h.kind === "fx")
    .map((h) => ({ harnessId: h.id, env: harnessEnv(h) }));
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

function snapshotKey(models: DiscoveredModel[]): string {
  return JSON.stringify(models.map((m) => m.id));
}

function modelsForHarness(harnessId: string, kind: AgentKind): DiscoveredModel[] {
  return kind === "fx" ? getHarnessDiscoveredModels(harnessId) : getDiscoveredModels(kind);
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
 * Full sweep: every kind's built-in discoverer plus every enabled fx
 * harness's own account-scoped catalog. Broadcasts `agent_models_changed`
 * for whichever harnesses' lists changed.
 */
export async function refreshAllModels(): Promise<void> {
  await refreshDiscoveredModels({ fxHarnesses: discoveryTargets() });
  publishIfChanged();
}

/**
 * Refreshes exactly one harness. For fx this probes that harness's own
 * account-scoped catalog directly; for every other kind (and for an
 * unknown/deleted harness id, which can't be resolved to a kind) there's no
 * single-kind refresh exposed by `agent-discovery.ts` — kind-level lists are
 * shared across every harness of that kind — so it falls back to a full
 * sweep. Either way, broadcasts on change.
 */
export async function refreshHarnessModels(harnessId: string): Promise<void> {
  const harness = harnesses.get(harnessId);
  if (harness && harness.kind === "fx") {
    await refreshFxHarnessModels({ harnessId: harness.id, env: harnessEnv(harness) });
  } else {
    await refreshAllModels();
  }
  publishIfChanged();
}

/**
 * `GET /agent-models/harnesses`'s payload: one key per *enabled* harness
 * (all kinds) — fx harnesses get their own per-harness catalog, every other
 * kind maps to its shared kind-level list, so callers have a single lookup
 * regardless of kind. `ready` mirrors `isDiscoveryReady()` — false until the
 * first full sweep has settled, so the webview's boot-race retry can tell
 * "hasn't run yet" apart from "ran and found nothing".
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
  pendingDebounce.set(harnessId, timer);
}

/**
 * Transition detector fed by `GET /harnesses` after each `checkAllHarnesses()`
 * probe. A harness seen for the first time is recorded but never triggers a
 * refresh — boot's own `refreshAllModels()` call already covers it. A
 * harness whose `{available, path, version, loggedIn}` key changed since the
 * last sighting schedules a debounced (500ms, per-harness, resettable)
 * refresh — this is what picks up `fx login`, an install, or a binary/version
 * swap without waiting for the 15-minute periodic sweep. Never throws.
 */
export function noteHarnessStatuses(statuses: HarnessStatus[]): void {
  try {
    for (const s of statuses) {
      const key = statusKey(s);
      const prev = lastStatusKey.get(s.harnessId);
      lastStatusKey.set(s.harnessId, key);
      if (prev === undefined) continue; // first sight — boot already discovered
      if (prev === key) continue; // unchanged
      scheduleDebouncedRefresh(s.harnessId);
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
};
