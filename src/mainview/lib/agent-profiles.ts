/**
 * Webview-side helpers for {@link AgentProfile}: a module-cached list hook
 * shared across every mounted picker/section (`AgentProfilePicker`, the
 * Settings Agents section, task-details chips, …) so switching tabs or
 * remounting a dialog never re-triggers a redundant `GET /agent-profiles`,
 * plus a couple of pure functions used by both the picker's search box and
 * the task-details display. See `docs/plans/agent-profiles.md` §3 (D10) for
 * the "one rendering, four surfaces" rationale this module supports.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AgentKind, AgentProfile, Harness, Task } from "../../shared/types.ts";
import { agentProfileSummary } from "../../shared/agent-profile.ts";

// Module-level store: one fetch serves every mounted `useAgentProfiles()`
// consumer. `cache` is `null` until the first fetch resolves (successfully
// or not) — see `loading` below. A failed fetch leaves the previous `cache`
// value in place (stale-but-known beats blanking a working list) and only
// sets `lastError`; the very first failed fetch therefore reports `error`
// with `profiles: []`.
let cache: AgentProfile[] | null = null;
let inFlight: Promise<AgentProfile[]> | null = null;
let lastError: string | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

async function fetchProfiles(): Promise<void> {
  const promise = api.listAgentProfiles();
  inFlight = promise;
  try {
    const profiles = await promise;
    cache = profiles;
    lastError = null;
    loaded = true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    if (inFlight === promise) inFlight = null;
    notify();
  }
}

// True once a fetch has succeeded at least once, across the whole app — a
// failed initial fetch keeps this `false` (see `loaded` below). Distinct
// from `cache !== null`, which flips even on a failed refetch that happened
// to run after a prior success (stale-but-known cache stays in place).
let loaded = false;

/**
 * Module-cached `AgentProfile[]` list. The first mount (across the whole
 * app) triggers the fetch; every later mount reads the already-resolved
 * cache instantly. `refresh()` refetches and re-renders every subscribed
 * component — call it after a Settings create/edit/delete so an already-open
 * picker elsewhere picks up the change without remounting.
 *
 * `opts.enabled: false` (default `true`) skips fetching entirely and always
 * reports an empty, non-loading, error-free, not-`loaded` result — for a
 * caller that only conditionally needs the list (e.g. a collapsed section).
 */
export function useAgentProfiles(opts?: { enabled?: boolean }): {
  profiles: AgentProfile[];
  loading: boolean;
  /** `true` once a fetch has succeeded at least once — a caller that needs
   *  to distinguish "still loading" / "failed and never loaded" from "loaded
   *  (possibly stale after a later failed refresh)" should gate on this
   *  rather than on `profiles.length` or `!loading`, so a bound task's chip
   *  never flashes "(deleted)" while the very first fetch is still in
   *  flight or has failed — see `resolveTaskProfileDisplay`. */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const enabled = opts?.enabled ?? true;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const listener = () => bump((n) => n + 1);
    subscribers.add(listener);
    if (cache === null && inFlight === null) void fetchProfiles();
    return () => {
      subscribers.delete(listener);
    };
  }, [enabled]);

  const refresh = useCallback(() => fetchProfiles(), []);

  if (!enabled) {
    return { profiles: [], loading: false, loaded: false, error: null, refresh };
  }
  return {
    profiles: cache ?? [],
    loading: cache === null && lastError === null,
    loaded,
    error: lastError,
    refresh,
  };
}

/**
 * Case-insensitive substring filter over name, harness id, model, effort,
 * mode, and instructions — used by `AgentProfilePicker`'s search box. An
 * empty/whitespace-only `query` returns `list` unchanged (same identity,
 * so callers can memoize on it).
 */
export function filterAgentProfiles(list: AgentProfile[], query: string): AgentProfile[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    p.name.toLowerCase().includes(q)
    || p.harness.toLowerCase().includes(q)
    || p.model.toLowerCase().includes(q)
    || (p.effort ?? "").toLowerCase().includes(q)
    || (p.mode ?? "").toLowerCase().includes(q)
    || p.instructions.toLowerCase().includes(q));
}

/** What a task-bound chip/header needs to render, resolved from either the
 *  live profile or the task's frozen snapshot — see
 *  {@link resolveTaskProfileDisplay}. */
export interface TaskProfileDisplay {
  id: string;
  name: string;
  harnessKind: AgentKind;
  harnessLabel: string;
  summary: string;
  deleted: boolean;
}

/**
 * Resolve what a task's agent-profile chip should display. Returns `null`
 * when the task carries neither `agentProfileId` nor `agentProfile` (never
 * bound to a profile).
 *
 * name/harnessKind/harnessLabel/model/effort/mode/summary ALWAYS come from
 * the task's frozen `agentProfile` snapshot when one is present — the
 * snapshot is what the task actually launched (or will launch) with, and
 * must never flicker to reflect a concurrent live edit to the profile
 * elsewhere in the app. Only when the task carries an `agentProfileId` with
 * NO snapshot (a legacy/malformed row — every current write path always
 * writes both together) does this fall back to the **live** profile's own
 * values, resolving `harnessKind`/`harnessLabel` against `harnesses`.
 *
 * `deleted` is resolved independently and is the ONLY thing the live list
 * decides: `true` exactly when a live list is available, the task names a
 * profile id, and that id no longer resolves in `live` — a `null` `live`
 * (not loaded yet, or the caller opted out — see `useAgentProfiles`'s
 * `loaded` flag) never reports `deleted`, matching the exact formula:
 * `live !== null && task.agentProfileId != null &&
 * !live.some(p => p.id === task.agentProfileId)`.
 */
export function resolveTaskProfileDisplay(
  task: Pick<Task, "agentProfileId" | "agentProfile">,
  live: AgentProfile[] | null,
  harnesses?: Harness[],
): TaskProfileDisplay | null {
  const profileId = task.agentProfileId ?? null;
  const snapshot = task.agentProfile ?? null;
  if (profileId == null && snapshot == null) return null;

  const deleted = live !== null && profileId != null && !live.some((p) => p.id === profileId);

  if (snapshot) {
    return {
      id: profileId ?? snapshot.id,
      name: snapshot.name,
      harnessKind: snapshot.harnessKind,
      harnessLabel: snapshot.harnessLabel,
      summary: agentProfileSummary({
        harnessLabel: snapshot.harnessLabel,
        model: snapshot.model,
        effort: snapshot.effort,
        mode: snapshot.mode,
      }),
      deleted,
    };
  }

  // Legacy/malformed: an `agentProfileId` with no snapshot — nothing frozen
  // to prefer, so fall back to the live profile's own values.
  const liveProfile = profileId != null ? (live?.find((p) => p.id === profileId) ?? null) : null;
  const model = liveProfile?.model ?? "";
  const effort = liveProfile?.effort ?? null;
  const mode = liveProfile?.mode ?? null;

  let harnessKind: AgentKind = "claude-code";
  let harnessLabel = "";
  if (liveProfile) {
    const harness = harnesses?.find((h) => h.id === liveProfile.harness);
    harnessKind = harness?.kind ?? "claude-code";
    harnessLabel = harness?.label ?? liveProfile.harness;
  }

  return {
    id: profileId ?? "",
    name: liveProfile?.name ?? "",
    harnessKind,
    harnessLabel,
    summary: agentProfileSummary({ harnessLabel, model, effort, mode }),
    deleted,
  };
}
