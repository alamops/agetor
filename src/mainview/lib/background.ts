/**
 * Pure copy + a tiny event store for Settings → General → "Keep Agetor
 * running in the background" (docs/plans/always-on-host.md §3.4/§3.5, grill
 * C9). Plain module state, no React, so `backgroundCopy` is unit-testable with
 * `bun:test` (no jsdom in this repo) and the section can share the single
 * `/app/events` stream `App.tsx` already holds open instead of opening its own
 * (WKWebView caps HTTP/1.1 connections per host at ~6 — see clone-progress.ts).
 */
import type {
  BackgroundState,
  BackgroundStatus,
  BackgroundUnavailableReason,
} from "../../shared/types.ts";

/** A button the state line offers: `open-login-items` jumps to System
 *  Settings › Login Items, `start-now` boots the stopped supervisor. */
export type BackgroundAction = "open-login-items" | "start-now";

export interface BackgroundCopy {
  /** One-line state shown next to the switch (`background-state`). */
  label: string;
  /** Optional second line (a reason or an explanation); `null` when none. */
  detail: string | null;
  /** The switch can be clicked (false only when `unavailable`). */
  toggleEnabled: boolean;
  /** The switch shows "on": the item is registered in any form. */
  toggleChecked: boolean;
  actions: BackgroundAction[];
}

/** Plain-English reasons the switch can't be used on this install. */
export const UNAVAILABLE_REASON_TEXT: Record<BackgroundUnavailableReason, string> = {
  "not-macos": "Only available on macOS",
  "dev-build": "Unavailable in development builds",
  unsigned: "Unavailable in unsigned builds",
  "not-in-applications": "Move Agetor to Applications first",
  "helper-missing": "This build has no login-item helper",
  "other-install": "Another Agetor install owns the background core",
  "helper-failed": "Couldn't read the login-item status",
};

const STATE_LABEL: Record<Exclude<BackgroundState, "unavailable">, string> = {
  running: "On — running in the background",
  parked: "On, parked while the app is open",
  starting: "On — starting…",
  stopped: "On — stopped, starts again at next login",
  "needs-approval": "Needs approval in System Settings › Login Items",
  off: "Off",
};

const STATE_DETAIL: Partial<Record<BackgroundState, string>> = {
  running: "Tasks keep running when you quit the app.",
  parked: "The background core takes over when you quit the app, so running tasks keep going.",
  starting: "Waiting a moment before the background core takes over.",
  stopped: "Use Start now to run it without waiting for the next login.",
  "needs-approval": "Agetor was turned off in Login Items. Approve it there to use the background core.",
};

/** What the Settings section shows for a status: label, detail, switch state
 *  and the action buttons. Total over every state and every unavailable reason. */
export function backgroundCopy(status: BackgroundStatus): BackgroundCopy {
  if (status.state === "unavailable") {
    const reason = status.unavailableReason;
    const label = reason ? UNAVAILABLE_REASON_TEXT[reason] : "Unavailable on this install";
    // helper-failed carries the helper's own error, which is the useful part.
    const detail = status.detail && status.detail !== label ? status.detail : null;
    return { label, detail, toggleEnabled: false, toggleChecked: false, actions: [] };
  }
  const detail = status.detail ?? STATE_DETAIL[status.state] ?? null;
  const base = {
    label: STATE_LABEL[status.state],
    detail,
    toggleEnabled: true,
    toggleChecked: status.state !== "off",
  };
  switch (status.state) {
    case "needs-approval":
      return { ...base, actions: ["open-login-items"] };
    case "stopped":
      return { ...base, actions: ["start-now"] };
    default:
      return { ...base, actions: [] };
  }
}

type Listener = (status: BackgroundStatus) => void;

const listeners = new Set<Listener>();

/** Called by `App.tsx`'s single `subscribeAppEvents` handler on each
 *  `background_changed` event. */
export function publishBackgroundStatus(status: BackgroundStatus): void {
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch (e) {
      console.warn("[agetor] background status listener threw", e);
    }
  }
}

/** Subscribe to published statuses; returns the unsubscribe function. */
export function subscribeBackgroundStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
