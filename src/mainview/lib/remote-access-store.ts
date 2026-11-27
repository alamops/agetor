/**
 * Pure helpers and a tiny event store for Settings → Remote access (docs/architecture/remote-gateway.md). Plain module state, no React, so
 * everything here is unit-testable with `bun:test` and the section can share the single `/app/events` stream `App.tsx` already holds open
 * instead of opening its own (WKWebView allows about six HTTP/1.1 connections per host; see lib/clone-progress.ts).
 *
 * `App.tsx` calls `publishRemoteChanged()` on the app events that can change what the section shows (`background_changed`, `remote_action`
 * and `phone_terminal`); the section then re-reads. Nothing here turns remote access on, pairs a phone or raises a level: the web view only
 * ever reads, revokes and turns it off.
 */
import type { RemoteDeviceDto, RemoteLogResult, RemoteTrustState } from "../../shared/remote-types.ts";
import type { AppEvent, RemoteAccessStatus } from "../../shared/types.ts";

/** The longest Mac name the core accepts (`PUT /preferences/remoteMacName`). */
export const MAC_NAME_MAX = 40;

/** Why a Mac name would be refused, or null when it is fine. Mirrors the core's rule (at most 40 as typed, not empty once cleaned). */
export function macNameProblem(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0) return "Give this Mac a name.";
  if (Array.from(t).length > MAC_NAME_MAX) return `At most ${MAC_NAME_MAX} characters.`;
  // Control and invisible characters are removed by the core; a name made only of them would end up empty.
  if (t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, "").trim().length === 0) return "Give this Mac a name.";
  return null;
}

const TRUST_TEXT: Record<Exclude<RemoteTrustState, "trusted">, string> = {
  "bad-signature": "its entry does not verify, so Agetor ignores it",
  revoked: "revoked",
  status: "not active",
};

export interface DeviceRowView {
  id: string;
  name: string;
  platform: string;
  level: string;
  /** "Not trusted" and why, or null for a trusted device. */
  notTrusted: string | null;
  lastSeen: string;
  online: boolean;
  /** Only a device that still has authority can be revoked. */
  canRevoke: boolean;
}

export function lastSeenText(ts: number | null, now = Date.now()): string {
  if (ts === null) return "Never connected";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return "Just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export function deviceRowView(d: RemoteDeviceDto, now = Date.now()): DeviceRowView {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform === "ios" ? "iPhone / iPad" : "Android",
    level: d.level,
    notTrusted: d.trust === "trusted" ? null : `Not trusted: ${TRUST_TEXT[d.trust]}`,
    lastSeen: lastSeenText(d.lastSeenAt, now),
    online: d.online,
    canRevoke: d.trust !== "revoked",
  };
}

export interface LogRowView {
  seq: number;
  when: string;
  text: string;
  /** An attempt whose result was never written: the Mac stopped between the two. */
  outcomeUnknown: boolean;
}

const ACTION_TEXT: Record<string, string> = {
  pair: "Phone paired",
  revoke: "Phone revoked",
  "revoke-all": "All phones revoked",
  "session-open": "Phone connected",
  "session-close": "Phone disconnected",
  refusal: "Refused",
  "terminal-attach": "Terminal attached",
  "terminal-detach": "Terminal detached",
  unlock: "Unlocked",
  replayed: "Repeat answered from the stored result",
  expire: "Phone expired after 60 days",
  route: "Request",
  anchor: "Older entries trimmed",
};

export function logRowView(r: RemoteLogResult["rows"][number], devices: Array<{ id: string; name: string }>): LogRowView {
  const who = r.deviceId ? (devices.find((d) => d.id === r.deviceId)?.name ?? r.deviceId.slice(0, 8)) : null;
  const base = r.kind === "anchor" ? ACTION_TEXT.anchor! : (ACTION_TEXT[r.action] ?? r.action);
  const parts = [base, who ? `from ${who}` : null, r.route ? r.route : null].filter((x): x is string => x !== null);
  return {
    seq: r.seq,
    when: new Date(r.ts).toLocaleString(),
    text: parts.join(" · "),
    outcomeUnknown: r.outcome === "unknown",
  };
}

// ── the event store ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called by `App.tsx`'s single `subscribeAppEvents` handler. */
export function publishRemoteChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn("[agetor] remote access listener threw", e);
    }
  }
}

export function subscribeRemoteChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── the remote-access switch, shared by the two Settings surfaces ─────────────────────────────────────────────────────────────

// Settings shows the switch twice: the Remote access row of the background card (`GET /background`, `remoteAccess`) and this section
// (`GET /remote-access`, `enabled`). They poll on their own clocks, so without a shared value one could read "Off" while the other still
// read "On". Each surface reports every value it applies; a change reaches the other surface at once, which shows it and re-reads.

type SwitchListener = (enabled: boolean) => void;
const switchListeners = new Set<SwitchListener>();
let lastSwitch: boolean | null = null;

/** Report the remote-access switch a surface just applied. Listeners hear only a change from the last reported value. */
export function reportRemoteSwitch(enabled: boolean): void {
  if (lastSwitch === enabled) return;
  lastSwitch = enabled;
  for (const fn of [...switchListeners]) {
    try {
      fn(enabled);
    } catch (e) {
      console.warn("[agetor] remote switch listener threw", e);
    }
  }
}

export function subscribeRemoteSwitch(fn: SwitchListener): () => void {
  switchListeners.add(fn);
  return () => {
    switchListeners.delete(fn);
  };
}

/** Test seam: forget the last reported value. */
export function resetRemoteSwitchForTests(): void {
  lastSwitch = null;
}

type RemoteActionEvent = Extract<AppEvent, { type: "remote_action" }>;

const ACTION_TEXT_TOAST: Record<RemoteActionEvent["action"], (device: string) => string> = {
  "plan-approved": (d) => `Plan approved from ${d}`,
  "card-allowed": (d) => `Allowed from ${d}`,
  "gate-decided": (d) => `Review decided from ${d}`,
  "auto-mode-approved": (d) => `Auto mode approved from ${d}`,
  "terminal-attached": (d) => `${d} attached to a terminal`,
  "device-paired": (d) => `${d} was paired`,
  "device-revoked": (d) => `${d} was revoked`,
};

/** The toast for a `remote_action` app event ("Plan approved from Ana's iPhone"). The device name is plain text from the core. */
export function remoteActionToast(ev: RemoteActionEvent): string {
  return ACTION_TEXT_TOAST[ev.action](ev.deviceName);
}

/** Whether the section shows at all: only in a build that ships the Companion. */
export function remoteSectionVisible(status: RemoteAccessStatus | null): boolean {
  return status !== null && status.companion;
}
