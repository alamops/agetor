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
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    if (inFlight === promise) inFlight = null;
    notify();
  }
}

/**
 * Module-cached `AgentProfile[]` list. The first mount (across the whole
 * app) triggers the fetch; every later mount reads the already-resolved
 * cache instantly. `refresh()` refetches and re-renders every subscribed
 * component — call it after a Settings create/edit/delete so an already-open
 * picker elsewhere picks up the change without remounting.
 *
 * `opts.enabled: false` (default `true`) skips fetching entirely and always
 * reports an empty, non-loading, error-free result — for a caller that only
 * conditionally needs the list (e.g. a collapsed section).
 */
export function useAgentProfiles(opts?: { enabled?: boolean }): {
  profiles: AgentProfile[];
  loading: boolean;
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
    return { profiles: [], loading: false, error: null, refresh };
  }
  return {
    profiles: cache ?? [],
    loading: cache === null && lastError === null,
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
 * Prefers the **live** profile (matched by id in `live`) for
 * name/harness/model/effort/mode whenever it's present — a not-yet-started
 * task tracks live edits (see the plan's "freeze at first run" rule, D2) —
 * and falls back to the task's frozen `agentProfile` snapshot otherwise
 * (profile deleted, `live` not loaded yet, or the task already ran and the
 * live profile has since diverged from what it actually launched with —
 * this function doesn't know which case applies; callers that need "did
 * this task freeze" should consult run count separately).
 *
 * `deleted` is `true` exactly when a live list is available, the task names
 * a profile id, and that id no longer resolves in `live` — a `null` `live`
 * (not loaded yet) never reports `deleted`, matching the plan's exact
 * formula: `live !== null && task.agentProfileId != null &&
 * !live.some(p => p.id === task.agentProfileId)`.
 *
 * `harnessKind`/`harnessLabel` for a live profile are resolved against
 * `harnesses` (falling back to the snapshot's own recorded kind/label when
 * the harness itself can't be found there, or to a bare default when
 * neither is available).
 */
export function resolveTaskProfileDisplay(
  task: Pick<Task, "agentProfileId" | "agentProfile">,
  live: AgentProfile[] | null,
  harnesses?: Harness[],
): TaskProfileDisplay | null {
  const profileId = task.agentProfileId ?? null;
  const snapshot = task.agentProfile ?? null;
  if (profileId == null && snapshot == null) return null;

  const liveProfile = profileId != null ? (live?.find((p) => p.id === profileId) ?? null) : null;
  const deleted = live !== null && profileId != null && !live.some((p) => p.id === profileId);

  const id = profileId ?? snapshot?.id ?? "";
  const name = liveProfile?.name ?? snapshot?.name ?? "";
  const model = liveProfile?.model ?? snapshot?.model ?? "";
  const effort = liveProfile ? liveProfile.effort : (snapshot?.effort ?? null);
  const mode = liveProfile ? liveProfile.mode : (snapshot?.mode ?? null);

  let harnessKind: AgentKind;
  let harnessLabel: string;
  if (liveProfile) {
    const harness = harnesses?.find((h) => h.id === liveProfile.harness);
    harnessKind = harness?.kind ?? snapshot?.harnessKind ?? "claude-code";
    harnessLabel = harness?.label ?? snapshot?.harnessLabel ?? liveProfile.harness;
  } else {
    harnessKind = snapshot?.harnessKind ?? "claude-code";
    harnessLabel = snapshot?.harnessLabel ?? "";
  }

  return {
    id,
    name,
    harnessKind,
    harnessLabel,
    summary: agentProfileSummary({ harnessLabel, model, effort, mode }),
    deleted,
  };
}
