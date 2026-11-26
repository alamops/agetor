/**
 * The device registry's trust check (docs/specs/remote-readiness-spec.md "Device registry", invariants 2 and 3).
 *
 * A row in `remote_devices` is only a cache. It is TRUSTED when all three hold, checked afresh on every call (no cache, so a revoke
 * or a rewritten row takes effect at once):
 *   1. its `sig` verifies, with the registry public key the key helper reports, over the canonical JSON of
 *      `{id, name, platform, session_pub, approve_pub, push_pub, level, enrolled_at}`;
 *   2. its id is not in the helper's own append-only revoked list;
 *   3. its `status` is `active`.
 * Anything else is returned as `untrusted` with a reason, and audited once per row per process. An agent that writes a row with a
 * made-up signature, edits a level, or re-inserts an old signed row after a revoke gains nothing.
 *
 * Revoking only removes authority, so it needs no Touch ID: the helper records the id (append-only, so a replayed signed row cannot bring
 * it back), the row is marked revoked (with its audit entry, one transaction), live sessions end, and the Mac says so.
 */
import { toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { canonicalize } from "@agetor/remote-protocol/canonical-json";
import { verifyEs256 } from "@agetor/remote-protocol/es256";
import type { RemoteDeviceRow } from "../../shared/remote-types.ts";
import type { Audit } from "./audit.ts";
import { getKeyHelper, type KeyHelper } from "./key-helper-api.ts";

export type UntrustedReason = "bad-signature" | "revoked" | "status";

export interface UntrustedDevice {
  row: RemoteDeviceRow;
  reason: UntrustedReason;
}

export interface TrustedSet {
  trusted: RemoteDeviceRow[];
  untrusted: UntrustedDevice[];
}

export interface RegistryStore {
  list(): Promise<RemoteDeviceRow[]>;
  /** Mark devices revoked and audit each (`remote.revokeDevices`). */
  revoke(ids: string[], reason: string, ts: number): Promise<unknown>;
}

export function createDbRegistryStore(): RegistryStore {
  const db = () => import("../db-async.ts");
  return {
    list: async () => (await db()).remoteDevices.list(),
    revoke: async (ids, reason, ts) => (await db()).op("remote.revokeDevices", [ids, reason, ts]),
  };
}

export const EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;

/** The canonical JSON the registry key signs for a device entry. */
export function registryEntryJson(r: Pick<RemoteDeviceRow, "id" | "name" | "platform" | "sessionPub" | "approvePub" | "pushPub" | "level" | "enrolledAt">): string {
  return canonicalize({
    id: r.id,
    name: r.name,
    platform: r.platform,
    session_pub: toHex(r.sessionPub),
    approve_pub: toHex(r.approvePub),
    push_pub: toHex(r.pushPub),
    level: r.level,
    enrolled_at: r.enrolledAt,
  });
}

export interface RegistryDeps {
  helper?: () => KeyHelper;
  store?: RegistryStore;
  audit?: Pick<Audit, "event">;
  now?: () => number;
  /** Told for every id that loses trust (revoke, revoke all, expiry): the gateway ends that device's sessions. */
  notify?: (n: { deviceId: string; deviceName: string; title: string; body: string }) => void;
}

export interface Registry {
  trustedDevices(): Promise<TrustedSet>;
  /** The trusted row for an id, or null. Always re-checked. */
  trustedDevice(id: string): Promise<RemoteDeviceRow | null>;
  hasTrustedDevice(): Promise<boolean>;
  revoke(id: string, reason?: string): Promise<void>;
  /** The helper revokes everything it signed and replaces the core key; every phone must pair again. Returns the new core public key. */
  revokeAll(): Promise<Uint8Array>;
  /** Revoke devices unused for 60 days. Returns the ids. */
  expireStale(now?: number): Promise<string[]>;
  /** Called with a device id after it loses trust. Returns an unsubscribe function. */
  onRevoked(fn: (deviceId: string, reason: string) => void): () => void;
  /** Called after Revoke all, once the core key changed. */
  onKeyReplaced(fn: () => void): () => void;
}

export function createRegistry(deps: RegistryDeps = {}): Registry {
  const helper = deps.helper ?? getKeyHelper;
  const store = deps.store ?? createDbRegistryStore();
  const now = deps.now ?? Date.now;
  const revokedFns = new Set<(id: string, reason: string) => void>();
  const keyFns = new Set<() => void>();
  const auditedUntrusted = new Set<string>();

  const fire = (id: string, reason: string) => {
    for (const fn of [...revokedFns]) {
      try {
        fn(id, reason);
      } catch {
        /* a listener must not stop the others */
      }
    }
  };

  async function trustedDevices(): Promise<TrustedSet> {
    const h = helper();
    // Read the helper first: with no helper there is nothing to trust, whatever the rows say.
    const [status, revoked, rows] = await Promise.all([h.status(), h.revoked(), store.list()]);
    const revokedSet = new Set(revoked);
    const out: TrustedSet = { trusted: [], untrusted: [] };
    for (const row of rows) {
      let reason: UntrustedReason | null = null;
      if (revokedSet.has(row.id)) reason = "revoked";
      else if (!verifyEs256(status.registryPub, utf8(registryEntryJson(row)), row.sig)) reason = "bad-signature";
      else if (row.status !== "active") reason = "status";
      if (reason === null) {
        out.trusted.push(row);
        continue;
      }
      out.untrusted.push({ row, reason });
      // Audited once per row per process. A row that is merely already-revoked is not news.
      if (reason === "bad-signature" && deps.audit && !auditedUntrusted.has(row.id)) {
        auditedUntrusted.add(row.id);
        void deps.audit.event("refusal", { deviceId: row.id, resultCode: "untrusted-row", target: { reason } }).catch(() => undefined);
      }
    }
    return out;
  }

  async function revoke(id: string, reason = "revoked"): Promise<void> {
    let helperError: unknown = null;
    try {
      await helper().revoke(id); // append-only list first: trust is withdrawn even if the next step fails
    } catch (e) {
      helperError = e;
    }
    // Only the name for the notice: a failing read must not stop the sessions from ending below.
    const row = await store.list().then((rows) => rows.find((r) => r.id === id), () => undefined);
    // Trust is withdrawn once either write lands (`trustedDevices` reads the helper's list and the row's status afresh), so the live
    // sessions end whether or not the other one succeeded: a failing database must not leave a revoked phone attached. When neither
    // landed the phone is still trusted, so nothing is ended and no notice claims otherwise; both failures are reported.
    let storeError: unknown = null;
    try {
      await store.revoke([id], reason, now());
    } catch (e) {
      storeError = e;
    }
    if (helperError && storeError) {
      const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
      throw new Error(`the revoke was not recorded: ${msg(helperError)}; ${msg(storeError)}`, { cause: storeError });
    }
    fire(id, reason);
    deps.notify?.({ deviceId: id, deviceName: row?.name ?? id.slice(0, 8), title: "Phone revoked", body: `${row?.name ?? "A phone"} can no longer reach this Mac.` });
    if (storeError) throw storeError;
    if (helperError) throw helperError;
  }

  return {
    trustedDevices,
    async trustedDevice(id) {
      return (await trustedDevices()).trusted.find((r) => r.id === id) ?? null;
    },
    async hasTrustedDevice() {
      return (await trustedDevices()).trusted.length > 0;
    },
    revoke,
    async revokeAll() {
      const rows = await store.list();
      const active = rows.filter((r) => r.status === "active").map((r) => r.id);
      const result = await helper().revokeAll();
      const ids = [...new Set([...active, ...result.ids])];
      // The helper has already replaced the core key: every session and mailbox is stale whether or not the rows can be written.
      try {
        await store.revoke(ids, "revoke-all", now());
      } finally {
        // Audited whether or not the rows were written: the key is already replaced, so the revoke has happened.
        await deps.audit?.event("revoke-all", { target: { count: ids.length } }).catch(() => undefined);
        for (const id of ids) fire(id, "revoke-all");
        for (const fn of [...keyFns]) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
        deps.notify?.({ deviceId: "all", deviceName: "all phones", title: "All phones revoked", body: "Every paired phone was revoked. Pair again to reconnect." });
      }
      return result.corePub;
    },
    async expireStale(at = now()) {
      const { trusted } = await trustedDevices();
      const stale = trusted.filter((r) => at - (r.lastSeenAt ?? r.enrolledAt) > EXPIRY_MS).map((r) => r.id);
      for (const id of stale) await revoke(id, "expired");
      return stale;
    },
    onRevoked(fn) {
      revokedFns.add(fn);
      return () => void revokedFns.delete(fn);
    },
    onKeyReplaced(fn) {
      keyFns.add(fn);
      return () => void keyFns.delete(fn);
    },
  };
}
