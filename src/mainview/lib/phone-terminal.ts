/**
 * Which tasks a phone's terminal is attached to right now (docs/architecture/run-panel.md, "Phone attached banner"). Plain module state, no
 * React in the reducer, so it is unit-testable and shares the single `/app/events` stream `App.tsx` holds open: that handler forwards each
 * `phone_terminal` event here, and seeds the store once from `GET /remote-access` (`attachedTerminals`) so a banner shows for a terminal
 * that was attached before this window opened. One phone per task, so the state is a map keyed by task id.
 */
import { useSyncExternalStore } from "react";
import type { AppEvent } from "../../shared/types.ts";

export interface PhoneTerminalEntry {
  taskId: string;
  deviceId: string;
  deviceName: string;
  since: number;
}

export type PhoneTerminalState = ReadonlyMap<string, PhoneTerminalEntry>;

type PhoneTerminalEvent = Extract<AppEvent, { type: "phone_terminal" }>;

const EMPTY: PhoneTerminalState = new Map();

/** The pure reducer: an attach sets (replacing any earlier phone), a detach clears only the phone that detached. */
export function reducePhoneTerminal(state: PhoneTerminalState, ev: PhoneTerminalEvent): PhoneTerminalState {
  const cur = state.get(ev.taskId);
  if (ev.attached) {
    if (cur && cur.deviceId === ev.deviceId && cur.since === ev.since) return state;
    const next = new Map(state);
    next.set(ev.taskId, { taskId: ev.taskId, deviceId: ev.deviceId, deviceName: ev.deviceName, since: ev.since });
    return next;
  }
  // A late detach of an earlier phone must not clear the phone that replaced it.
  if (!cur || cur.deviceId !== ev.deviceId) return state;
  const next = new Map(state);
  next.delete(ev.taskId);
  return next;
}

/** The snapshot's entries, except for tasks an event already spoke about (the event is newer than the snapshot). */
export function seedPhoneTerminalState(list: PhoneTerminalEntry[], current: PhoneTerminalState = EMPTY, touched: ReadonlySet<string> = new Set()): PhoneTerminalState {
  const next = new Map<string, PhoneTerminalEntry>();
  for (const e of list) if (!touched.has(e.taskId)) next.set(e.taskId, e);
  for (const [taskId, e] of current) if (touched.has(taskId)) next.set(taskId, e);
  return next;
}

let state: PhoneTerminalState = EMPTY;
/** Tasks a live event has spoken about since the page loaded: a snapshot read a moment earlier must not override them. */
const touchedByEvent = new Set<string>();
const listeners = new Set<() => void>();

function set(next: PhoneTerminalState): void {
  if (next === state) return;
  state = next;
  for (const fn of [...listeners]) fn();
}

/** From `App.tsx`'s `subscribeAppEvents` handler. */
export function applyPhoneTerminalEvent(ev: PhoneTerminalEvent): void {
  touchedByEvent.add(ev.taskId);
  set(reducePhoneTerminal(state, ev));
}

/** From the one `GET /remote-access` read at startup. */
export function seedPhoneTerminals(list: PhoneTerminalEntry[]): void {
  set(seedPhoneTerminalState(list, state, touchedByEvent));
}

export function getPhoneTerminal(taskId: string): PhoneTerminalEntry | null {
  return state.get(taskId) ?? null;
}

export function subscribePhoneTerminals(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The entry for one task, or null. Re-renders only when this task's entry changes. */
export function usePhoneTerminal(taskId: string): PhoneTerminalEntry | null {
  return useSyncExternalStore(subscribePhoneTerminals, () => getPhoneTerminal(taskId), () => null);
}

/** Test seam. */
export function resetPhoneTerminalsForTests(): void {
  state = EMPTY;
  touchedByEvent.clear();
  listeners.clear();
}
