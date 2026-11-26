/**
 * Types shared by the remote gateway modules (docs/plans/remote-readiness.md §3.3, docs/specs/remote-readiness-spec.md).
 * Types only: nothing here runs, so any module may import it without pulling the gateway in.
 */
import type { RemoteLevel } from "@agetor/remote-protocol/levels";

/** The device behind a request that arrived through an authenticated session (set only by `remote/router.ts`). */
export interface DevicePrincipal {
  kind: "device";
  deviceId: string;
  /** The cleaned name, at most 40 characters. */
  deviceName: string;
  /** From the device's signed registry entry; nothing raises it later. */
  level: RemoteLevel;
  sessionId: string;
  /** The Noise handshake hash of this session, bound into every signed decision. */
  sessionHash: Uint8Array;
  /** The device's approve public key (uncompressed P-256), from the registry entry. */
  approvePub: Uint8Array;
}

/** What a session offers the router, the subscriptions and the terminal. Implemented by `session.ts`; faked in unit tests. */
export interface PhoneChannel {
  readonly principal: DevicePrincipal;
  /** Send a message of a protocol type: chunks, pads and paces it. `heavy` marks bulk data (previews, history). */
  send(type: string, body: unknown, opts?: { heavy?: boolean }): void;
  /** Bytes queued for the relay and not yet sent (the 4 MB backpressure cap reads it). */
  queuedBytes(): number;
  /** Whether the phone is on the other end of the mailbox right now. */
  peerPresent(): boolean;
  onClose(fn: (reason: string) => void): () => void;
  onPeerChange(fn: (present: boolean) => void): () => void;
}

/** How the router treats a request after the class rules (route-classes.ts). `action` is a session-only mutation (switch-account). */
export type RemoteClass = "read" | "remove" | "action" | "content" | "consent" | "never";

export type ContentTarget =
  | { kind: "plan"; taskId: string; planId: string }
  | { kind: "plan-edit"; taskId: string; planId: string; body: string }
  | { kind: "claude-plan"; taskId: string; promptId: string; row: "auto" | "manual" }
  | { kind: "tmux-card"; taskId: string; promptId: string }
  | { kind: "fx-permission"; taskId: string; permissionId: string }
  | { kind: "gate"; taskId: string; stepId: string; seq: number }
  | { kind: "fx-resume"; taskId: string }
  | { kind: "terminal"; taskId: string; tmuxSession: string };

export interface Classified {
  class: RemoteClass;
  level: RemoteLevel;
  stepUp: "none" | "unlock" | "signed";
  rate: "normal" | "heavy" | "stop";
  /**
   * A signed call that ALSO needs the unlock window: `true` while the task runs without asking (a plan edit), `"always"` when the call itself
   * makes the task autonomous (Claude's "auto mode" row), so it needs the window whatever mode the task is in now.
   */
  alsoUnlock?: boolean | "always";
  /** The task the call acts on, when the class rules resolved it (the router checks `runsWithoutAsking` against it). */
  taskId?: string;
  target?: ContentTarget;
  /** For a signed gate call: the decision and comment the request body must repeat exactly as signed. */
  bound?: { decision?: string; comment?: string | null };
  /** Why a `never` call was refused, or which rule raised the level. */
  reason?: string;
}
