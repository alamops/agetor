import { mkdirSync } from "node:fs";
import path from "node:path";
import { dataDir, harnesses, preferences } from "./db.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import { checkHarness, peekCachedCliVersion } from "./agent-status.ts";
import { copilotHome } from "./copilot-home.ts";
import {
  refreshDiscoveredModels,
  refreshHarnessTarget,
  refreshKindModels,
  pruneHarnessDiscovery,
  getDiscoveredModels,
  getHarnessDiscoveredModels,
  isDiscoveryReady,
  seedDiscoveryCache,
  setDiscoverySettleHook,
  type DiscoveredModel,
  type DiscoveryCacheKey,
  type HarnessTarget,
  type KindProbeTarget,
} from "./agent-discovery.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { sanitizeCliDescription, sanitizeCliLabel } from "../shared/model-display.ts";
import type { AgentKind, Harness, HarnessStatus } from "../shared/types.ts";

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

/**
 * The kinds whose catalog varies per harness and so get probed one harness
 * at a time (`HarnessTarget`): fx and codex are account-scoped catalogs, and
 * an OpenCode harness lists only the providers its own config/env credential
 * (spike Q7). Every other kind shares one kind-level list.
 */
type PerHarnessKind = NonNullable<HarnessTarget["kind"]>;
const PER_HARNESS_KINDS: ReadonlySet<AgentKind> = new Set<PerHarnessKind>(["fx", "codex", "opencode"]);

function isPerHarnessKind(kind: AgentKind): kind is PerHarnessKind {
  return PER_HARNESS_KINDS.has(kind);
}
const DEFAULT_PERIODIC_MS = 15 * 60_000;

/**
 * Every *enabled* fx, codex or opencode harness, as a `HarnessTarget` (its own
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
    .filter((h) => h.enabled !== false && isPerHarnessKind(h.kind))
    .map((h) => ({ harnessId: h.id, kind: h.kind as PerHarnessKind, env: harnessEnv(h), bin: resolveBin(h) }));
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

// Hashes every field of every model, in order — a catalog whose ids are
// unchanged but whose per-model data changed (codex's `model/list` starts or
// stops reporting `ultra`, a claude model gains an effort level, fx flips an
// id's `fast` flag, a label is renamed) must still count as a change and
// publish `agent_models_changed`, since that is the only signal that drives a
// picker refetch. `null` vs `[]` efforts stays distinct (OpenCode, D-6) because
// the whole object is serialized.
function snapshotKey(models: DiscoveredModel[]): string {
  return JSON.stringify(models);
}

function modelsForHarness(harnessId: string, kind: AgentKind): DiscoveredModel[] {
  return isPerHarnessKind(kind) ? getHarnessDiscoveredModels(harnessId) : getDiscoveredModels(kind);
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

// ───────────────────────── persisted catalog ─────────────────────────────
//
// The last discovered catalog survives a restart and an offline start
// (dynamic-model-catalog #16): every settled probe that found models is
// written to `preferences` under `modelCatalog:kind:<kind>` (kinds that share
// one list) or `modelCatalog:harness:<id>` (fx, codex and opencode, whose
// catalog is per harness), and the first sweep seeds the in-memory caches from
// those rows before probing. A transient empty probe keeps the previous
// catalog; an unavailable harness or a CLI whose version changed drops it. The
// rows are server-managed: `/preferences` neither lists nor accepts them.
//
// Only the whitelisted `DiscoveredModel` fields are ever stored — never a raw
// CLI response (the claude `initialize` answer carries the account email and
// organization; its parser already reads `models[]` only, and this whitelist is
// the second belt).

export const MODEL_CATALOG_PREF_PREFIX = "modelCatalog:";
const MAX_STORED_MODELS = 2_000;

interface StoredCatalog {
  v: 1;
  cliVersion: string | null;
  savedAt: number;
  models: DiscoveredModel[];
}

const ALL_KINDS: ReadonlySet<string> = new Set<AgentKind>([
  "claude-code", "codex", "cursor", "gemini", "fx", "antigravity", "opencode", "copilot",
]);

function storageKey(key: DiscoveryCacheKey): string | null {
  if (key.scope === "harness") return `${MODEL_CATALOG_PREF_PREFIX}harness:${key.harnessId}`;
  // A per-harness kind's kind-level list is the built-in harness's own, which
  // is persisted under its harness key; storing both would just duplicate it.
  return isPerHarnessKind(key.kind) ? null : `${MODEL_CATALOG_PREF_PREFIX}kind:${key.kind}`;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asStringList = (v: unknown, max = 64): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, max);
  return out;
};

/** Whitelist one stored/persisted row; null when it is not a usable model. */
function cleanModel(raw: unknown): DiscoveredModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  if (!id || id.length > 256) return null;
  const m: DiscoveredModel = { id };
  const label = asString(r.label);
  if (label) m.label = sanitizeCliLabel(label) || label.slice(0, 80);
  const description = asString(r.description);
  if (description) m.description = sanitizeCliDescription(description);
  // `[]` is meaningful for opencode (D-6); `undefined` is "never reported".
  const efforts = asStringList(r.efforts);
  if (efforts) m.efforts = efforts;
  if (r.effortLabels && typeof r.effortLabels === "object") {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.effortLabels as Record<string, unknown>).slice(0, 64)) {
      if (typeof v === "string" && v) labels[k.slice(0, 64)] = sanitizeCliLabel(v);
    }
    if (Object.keys(labels).length > 0) m.effortLabels = labels;
  }
  const defaultEffort = asString(r.defaultEffort);
  if (defaultEffort) m.defaultEffort = defaultEffort.slice(0, 64);
  if (r.cliDefault === true) m.cliDefault = true;
  if (r.fast === true) m.fast = true;
  if (r.ultrafast === true) m.ultrafast = true;
  const fastHint = asString(r.fastHint);
  if (fastHint) m.fastHint = sanitizeCliDescription(fastHint);
  const fastTier = asString(r.fastTier);
  if (fastTier) m.fastTier = fastTier.slice(0, 64);
  if (r.defaultFast === true) m.defaultFast = true;
  const cliId = asString(r.cliId);
  if (cliId) m.cliId = cliId.slice(0, 256);
  const alias = asString(r.alias);
  if (alias) m.alias = alias.slice(0, 64);
  if (r.cursor && typeof r.cursor === "object") {
    const c = r.cursor as Record<string, unknown>;
    const effortIds: Record<string, string> = {};
    if (c.effortIds && typeof c.effortIds === "object") {
      for (const [k, v] of Object.entries(c.effortIds as Record<string, unknown>).slice(0, 64)) {
        if (typeof v === "string" && v) effortIds[k.slice(0, 64)] = v.slice(0, 256);
      }
    }
    const fastEfforts = asStringList(c.fastEfforts);
    const fastId = asString(c.fastId);
    if (Object.keys(effortIds).length > 0 || (fastEfforts && fastEfforts.length > 0) || fastId) {
      m.cursor = {
        ...(Object.keys(effortIds).length > 0 ? { effortIds } : {}),
        ...(fastEfforts && fastEfforts.length > 0 ? { fastEfforts } : {}),
        ...(fastId ? { fastId: fastId.slice(0, 256) } : {}),
      };
    }
  }
  return m;
}

function cleanModels(raw: unknown): DiscoveredModel[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_STORED_MODELS)) {
    const m = cleanModel(entry);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function parseStored(value: string): StoredCatalog | null {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (!raw || raw.v !== 1) return null;
    const models = cleanModels(raw.models);
    return {
      v: 1,
      cliVersion: typeof raw.cliVersion === "string" ? raw.cliVersion : null,
      savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
      models,
    };
  } catch {
    return null;
  }
}

/** What is currently persisted per preference key: the version it was probed
 *  under and a fingerprint of its models, so an identical sweep writes nothing. */
const persisted = new Map<string, { cliVersion: string | null; fingerprint: string }>();
let hydrated = false;

/** Latest `{available, version, loggedIn}` per harness id, from `noteHarnessStatuses`. */
const knownStatus = new Map<string, { available: boolean; version: string | null; loggedIn: boolean | null }>();

/** The harness whose state a cache slot reflects. */
function harnessForKey(key: DiscoveryCacheKey): Harness | null {
  if (key.scope === "harness") return harnesses.get(key.harnessId);
  return harnesses.get(key.kind);
}

function currentCliVersion(harness: Harness | null): string | null {
  if (!harness) return null;
  try {
    return peekCachedCliVersion(harness) ?? knownStatus.get(harness.id)?.version ?? null;
  } catch {
    return null;
  }
}

function persistCatalog(prefKey: string, models: DiscoveredModel[], cliVersion: string | null): void {
  const clean = cleanModels(models);
  const fingerprint = JSON.stringify(clean);
  const have = persisted.get(prefKey);
  if (have && have.fingerprint === fingerprint && have.cliVersion === cliVersion) return;
  try {
    const value: StoredCatalog = { v: 1, cliVersion, savedAt: Date.now(), models: clean };
    preferences.set(prefKey, JSON.stringify(value));
    persisted.set(prefKey, { cliVersion, fingerprint });
  } catch (err) {
    console.error("[agetor] could not persist the model catalog:", err instanceof Error ? err.message : err);
  }
}

function dropPersisted(prefKey: string): void {
  persisted.delete(prefKey);
  try {
    preferences.delete(prefKey);
  } catch { /* nothing to drop */ }
}

/**
 * The settle hook (`agent-discovery.ts`): decides what lands in the cache for
 * a fresh probe and persists it. A non-empty probe replaces the catalog. An
 * empty one keeps the previous catalog (a transient failure, an offline
 * start) unless the harness is known unavailable or its CLI is now a
 * different version than the one the catalog came from, in which case the
 * stale catalog and its stored row are dropped.
 */
function settleCatalog(
  key: DiscoveryCacheKey,
  fresh: DiscoveredModel[],
  previous: DiscoveredModel[] | undefined,
): DiscoveredModel[] {
  const prefKey = storageKey(key);
  const harness = harnessForKey(key);
  const version = currentCliVersion(harness);
  if (fresh.length > 0) {
    if (prefKey) persistCatalog(prefKey, fresh, version);
    return fresh;
  }
  const status = harness ? knownStatus.get(harness.id) : undefined;
  const stored = prefKey ? persisted.get(prefKey) : undefined;
  const unavailable = status?.available === false;
  const versionChanged = !!version && !!stored?.cliVersion && stored.cliVersion !== version;
  if (unavailable || versionChanged) {
    if (prefKey) dropPersisted(prefKey);
    return [];
  }
  return previous ?? [];
}

/**
 * Seed the in-memory caches from the persisted catalogs, once, synchronously
 * (before the first sweep's first `await`) so a `GET /agent-models` right
 * after boot already has rows. Rows that fail validation are ignored; harness
 * keys are honored only for an existing, enabled harness. A built-in
 * per-harness kind's harness row also seeds its kind-level slot.
 */
function hydrateFromStore(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    for (const [prefKey, value] of Object.entries(preferences.list())) {
      if (!prefKey.startsWith(MODEL_CATALOG_PREF_PREFIX)) continue;
      const rest = prefKey.slice(MODEL_CATALOG_PREF_PREFIX.length);
      const stored = parseStored(value);
      if (!stored) continue;
      if (rest.startsWith("kind:")) {
        const kind = rest.slice("kind:".length);
        if (!ALL_KINDS.has(kind) || isPerHarnessKind(kind as AgentKind)) continue;
        persisted.set(prefKey, { cliVersion: stored.cliVersion, fingerprint: JSON.stringify(stored.models) });
        if (stored.models.length > 0) seedDiscoveryCache({ scope: "kind", kind: kind as AgentKind }, stored.models);
      } else if (rest.startsWith("harness:")) {
        const harnessId = rest.slice("harness:".length);
        const harness = harnesses.get(harnessId);
        if (!harness || harness.enabled === false || !isPerHarnessKind(harness.kind)) continue;
        persisted.set(prefKey, { cliVersion: stored.cliVersion, fingerprint: JSON.stringify(stored.models) });
        if (stored.models.length === 0) continue;
        seedDiscoveryCache({ scope: "harness", kind: harness.kind, harnessId }, stored.models);
        if (harness.id === harness.kind) seedDiscoveryCache({ scope: "kind", kind: harness.kind }, stored.models);
      }
    }
  } catch (err) {
    console.error("[agetor] could not read the stored model catalog:", err instanceof Error ? err.message : err);
  }
}

// ───────────────────────── kind-level probe targets ──────────────────────────

/** An empty directory for probes that open a session-like context (claude's
 *  `initialize`, copilot's ACP `session/new`): nothing of the user's project
 *  can be read, and no session lands in a real project's history. */
function probeCwd(): string | undefined {
  try {
    const dir = path.join(dataDir, "discovery", "probe-cwd");
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * The claude-code and copilot kind-level probe targets: the built-in
 * harness's own env and binary. A disabled harness gets no target (nothing
 * is probed); a missing CLI or a logged-out claude is `skip` (no spawn).
 * Resolved inside the enqueued sweep so it reflects the harness rows at run
 * time.
 */
async function kindTargets(): Promise<Partial<Record<AgentKind, KindProbeTarget>>> {
  const out: Partial<Record<AgentKind, KindProbeTarget>> = {};
  const cwd = probeCwd();
  const claude = harnesses.get("claude-code");
  if (claude && claude.enabled !== false) {
    let skip = false;
    try {
      const status = await checkHarness(claude);
      skip = !status.available || status.loggedIn === false;
    } catch {
      skip = true;
    }
    out["claude-code"] = { env: harnessEnv(claude), bin: resolveBin(claude), ...(cwd ? { cwd } : {}), skip };
  }
  const copilot = harnesses.get("copilot");
  if (copilot && copilot.enabled !== false) {
    out.copilot = {
      env: { ...harnessEnv(copilot), COPILOT_HOME: copilotHome({ harnessHome: copilot.home, harnessEnv: copilot.env }) },
      bin: resolveBin(copilot),
      ...(cwd ? { cwd } : {}),
    };
  }
  return out;
}

/** Install the settle hook once the module is loaded; `refreshAllModels` also
 *  re-asserts it so a test that cleared it gets it back. */
function installSettleHook(): void {
  setDiscoverySettleHook(settleCatalog);
}

/**
 * Full sweep: every kind's built-in discoverer plus every enabled fx,
 * codex or opencode harness's own catalog (`PER_HARNESS_KINDS`). Broadcasts `agent_models_changed`
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
    installSettleHook();
    // Synchronous, before the first await: the persisted catalog is served
    // from the moment the sweep starts, not after its probes finish.
    hydrateFromStore();
    await refreshDiscoveredModels({ fxHarnesses: discoveryTargets, kindTargets });
    publishIfChanged();
  } catch (err) {
    console.error("[agetor] model discovery failed:", err);
  }
}

/**
 * Refreshes exactly one harness — kind-targeted, not a five-kind sweep:
 * an unknown/deleted harness id does nothing at all (there's nothing to
 * refresh and no kind to resolve it to); fx, codex and opencode each probe
 * that harness's own catalog directly (`refreshHarnessTarget`, keyed by
 * harness id, since those kinds' catalogs vary per harness — codex joined fx
 * on this path via code-review finding #4, opencode with its harness); every
 * other kind
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
    installSettleHook();
    hydrateFromStore();
    if (isPerHarnessKind(harness.kind)) {
      await refreshHarnessTarget({
        harnessId: harness.id,
        kind: harness.kind,
        env: harnessEnv(harness),
        bin: resolveBin(harness),
      });
    } else if (harness.kind === "claude-code" || harness.kind === "copilot") {
      // Probed with the built-in harness's own env/binary (one kind-level
      // list), whichever claude/copilot harness changed.
      await refreshKindModels(harness.kind, (await kindTargets())[harness.kind]);
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
    dropPersisted(`${MODEL_CATALOG_PREF_PREFIX}harness:${harnessId}`);
    knownStatus.delete(harnessId);
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
 * (all kinds) — fx, codex and opencode harnesses get their own per-harness catalog,
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

/** True when a persisted catalog for this harness was probed under a
 *  different (non-null) CLI version than the one just observed. */
function storedVersionDiffers(s: HarnessStatus): boolean {
  if (!s.version) return false;
  const harness = harnesses.get(s.harnessId);
  if (!harness) return false;
  const prefKey = isPerHarnessKind(harness.kind)
    ? `${MODEL_CATALOG_PREF_PREFIX}harness:${harness.id}`
    : `${MODEL_CATALOG_PREF_PREFIX}kind:${harness.kind}`;
  const stored = persisted.get(prefKey);
  return !!stored?.cliVersion && stored.cliVersion !== s.version;
}

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
      knownStatus.set(s.harnessId, { available: s.available, version: s.version ?? null, loggedIn: s.loggedIn });
      const key = statusKey(s);
      const prev = lastStatusKey.get(s.harnessId);
      lastStatusKey.set(s.harnessId, key);
      if (prev === undefined) {
        // First sight — boot already discovered, except when the stored
        // catalog was probed under a different CLI version: re-probe so a
        // stale catalog is replaced (or dropped) instead of lingering.
        if (storedVersionDiffers(s)) scheduleDebouncedRefresh(s.harnessId);
        continue;
      }
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
  hydrated = false;
  persisted.clear();
  knownStatus.clear();
  setDiscoverySettleHook(null);
  previousSnapshot = null;
  lastStatusKey.clear();
  for (const timer of pendingDebounce.values()) clearTimeout(timer);
  pendingDebounce.clear();
  stopPeriodicDiscovery();
}

export const __testing = {
  resetForTests,
  hydrateFromStore,
  settleCatalog,
  kindTargets,
  parseStored,
  pendingRefreshCount: () => pendingDebounce.size,
  /** The raw pending debounce timer for one harness id, if any — used to
   *  assert it's `.unref()`'d without exposing the whole map. */
  debounceTimerFor: (harnessId: string) => pendingDebounce.get(harnessId),
  /** Whether `noteHarnessStatuses` is still tracking a transition key for
   *  this harness id — used to assert pruning-by-absence. */
  hasLastStatusKey: (harnessId: string) => lastStatusKey.has(harnessId),
};
