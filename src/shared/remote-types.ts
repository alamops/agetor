/**
 * Rows and DTOs of the Companion's persistence and control surface (docs/specs/remote-readiness-spec.md "Device registry", "Audit log").
 * Types only. `RemoteLevel` comes from the protocol package, the one definition of the level vocabulary.
 */
import type { RemoteLevel } from "@agetor/remote-protocol/levels";

export type RemotePlatform = "ios" | "android";
export type RemoteDeviceStatus = "active" | "revoked";

/** One `remote_devices` row, as the database module returns it. Trust is decided by `remote/registry.ts`, never by reading this. */
export interface RemoteDeviceRow {
  /** 32 lowercase hex characters (a random 128-bit id). */
  id: string;
  name: string;
  platform: RemotePlatform;
  appVersion: string;
  sessionPub: Uint8Array;
  approvePub: Uint8Array;
  pushPub: Uint8Array;
  linkSecret: Uint8Array;
  level: RemoteLevel;
  status: RemoteDeviceStatus;
  enrolledAt: number;
  lastSeenAt: number | null;
  pushRef: string | null;
  pushSendKey: Uint8Array | null;
  pushDead: boolean;
  /** The registry key's raw ES256 signature (64 bytes) over the canonical entry. */
  sig: Uint8Array;
}

/** What `remote.addDevice` stores: the row, written only after the key helper signed the entry. */
export type RemoteDeviceInsert = Omit<RemoteDeviceRow, "lastSeenAt" | "pushRef" | "pushSendKey" | "pushDead" | "status"> & {
  status?: RemoteDeviceStatus;
};

export type RemoteAuditKind = "entry" | "anchor";

/**
 * The actions an audit row names. `route` and `decision` rows come from the router: an attempt row first (before the handler runs),
 * then a result row naming it through `attemptSeq`.
 */
export type RemoteAuditAction =
  | "pair"
  | "revoke"
  | "revoke-all"
  | "expire"
  | "session-open"
  | "session-close"
  | "refusal"
  | "route"
  | "route-result"
  | "terminal-attach"
  | "terminal-detach"
  | "trim";

export interface RemoteAuditRow {
  seq: number;
  ts: number;
  kind: RemoteAuditKind;
  deviceId: string | null;
  sessionHash: string | null;
  action: RemoteAuditAction | (string & {});
  route: string | null;
  /** Canonical JSON of the target ids (never a body). */
  targetJson: string | null;
  resultCode: string | null;
  /** On a result row: the seq of its attempt row. */
  attemptSeq: number | null;
  bodyHash: string | null;
  /** A signed decision's ES256 signature, hex. */
  signature: string | null;
  prevHash: string;
  hash: string;
}

/** What a caller hands `remote.auditAppend`; the op fills `seq`, `prevHash` and `hash`. */
export interface RemoteAuditInput {
  ts: number;
  kind?: RemoteAuditKind;
  deviceId?: string | null;
  sessionHash?: string | null;
  action: RemoteAuditRow["action"];
  route?: string | null;
  /** Serialized as canonical JSON. */
  target?: unknown;
  resultCode?: string | null;
  attemptSeq?: number | null;
  bodyHash?: string | null;
  signature?: string | null;
}

export interface RemoteAuditHead {
  seq: number;
  hash: string;
}

export interface RemoteAuditVerify {
  ok: boolean;
  /** The first row whose hash or link is wrong, or the first row of a chain with no anchor. */
  firstBadSeq: number | null;
  rows: number;
}

export interface RemoteIdempotencyRow {
  deviceId: string;
  idemKey: string;
  bodyHash: string;
  status: number;
  contentType: string;
  /** The stored response, or null when it was over 64 KB (status only). */
  response: Uint8Array | null;
  createdAt: number;
}
