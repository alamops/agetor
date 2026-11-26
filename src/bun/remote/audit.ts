/**
 * The audit writer and reader (docs/specs/remote-readiness-spec.md "Audit log", plan AU; invariant 12).
 *
 * Every remote action leaves a hash-chained row BEFORE its answer goes out: the router writes an ATTEMPT row first, runs the handler,
 * then writes a RESULT row naming the attempt. A crash in between leaves an attempt with no result, which the viewer and the CLI show
 * as "outcome unknown", and the idempotency row answers the retry. The chain itself (hash, triggers, trim) lives in the database
 * worker (`src/bun/db-core/ops/remote-ops.ts`); this module is the one place the rest of the core writes through.
 *
 * Bodies are never stored here, only a body hash; a signed decision's signature is. Rate-limit refusals are coalesced to one row per
 * device per minute so a flood cannot fill the log.
 */
import type { RemoteAuditHead, RemoteAuditInput, RemoteAuditRow, RemoteAuditVerify } from "../../shared/remote-types.ts";

export interface AuditStore {
  append(entry: RemoteAuditInput): Promise<RemoteAuditHead>;
  head(): Promise<RemoteAuditHead | null>;
  page(opts: { beforeSeq?: number; limit: number }): Promise<RemoteAuditRow[]>;
  resultFor(attemptSeq: number): Promise<RemoteAuditRow | null>;
  verify(): Promise<RemoteAuditVerify>;
  trim(opts: { maxAgeMs: number; maxRows: number; now: number }): Promise<{ dropped: number; anchorSeq: number | null }>;
}

/** The production store: the db-async facade (named ops run in the worker). Imported lazily so unit tests can inject a store without a database. */
export function createDbAuditStore(): AuditStore {
  const db = () => import("../db-async.ts");
  return {
    append: async (entry) => (await db()).op("remote.auditAppend", [entry]),
    head: async () => (await db()).remoteAudit.head(),
    page: async (opts) => (await db()).remoteAudit.page(opts),
    resultFor: async (seq) => (await db()).remoteAudit.resultFor(seq),
    verify: async () => (await db()).op("remote.auditVerify", []),
    trim: async (opts) => (await db()).op("remote.auditTrim", [opts]),
  };
}

export interface AttemptInput {
  deviceId: string;
  sessionHash: string;
  /** `METHOD /path` (route params unexpanded is fine; the target holds the ids). */
  route: string;
  /** The ids the call names (task, card, plan...). Never a body. */
  target?: unknown;
  /** SHA-256 hex of the request body, so a repeat is recognisable without storing it. */
  bodyHash?: string | null;
  /** A signed decision's signature (hex), when the call carried one. */
  signature?: string | null;
  action?: string;
}

/** A page row as the viewer and the CLI see it. */
export interface AuditViewRow extends RemoteAuditRow {
  /** For an attempt row only: its result code, or "unknown" when no result row exists (the core died between). */
  outcome?: string;
}

export interface AuditPage {
  rows: AuditViewRow[];
  chain: { ok: boolean; firstBadSeq: number | null };
}

export const REFUSAL_COALESCE_MS = 60_000;

export interface Audit {
  attempt(a: AttemptInput): Promise<number>;
  result(attemptSeq: number, resultCode: string, extra?: { deviceId?: string; sessionHash?: string }): Promise<void>;
  /** `pair`, `revoke`, `revoke-all`, `session-open`, `session-close`, `refusal`, `terminal-attach`, `terminal-detach`, `expire`. */
  event(action: string, fields?: Omit<RemoteAuditInput, "action" | "ts"> & { ts?: number }): Promise<RemoteAuditHead>;
  /** A refusal the device could repeat at will (a rate limit): at most one row per device per minute. Returns whether a row was written. */
  refusal(deviceId: string | null, code: string, route?: string): Promise<boolean>;
  head(): Promise<RemoteAuditHead | null>;
  page(opts: { beforeSeq?: number; limit: number }): Promise<AuditPage>;
}

export function createAudit(store: AuditStore = createDbAuditStore(), now: () => number = Date.now): Audit {
  let verified: { atHeadSeq: number; value: RemoteAuditVerify } | null = null;
  const lastRefusal = new Map<string, number>();

  const append = async (entry: RemoteAuditInput): Promise<RemoteAuditHead> => {
    const head = await store.append(entry);
    verified = null; // the cached chain check is stale after any append
    return head;
  };

  return {
    async attempt(a) {
      const head = await append({
        ts: now(), action: a.action ?? "route", deviceId: a.deviceId, sessionHash: a.sessionHash, route: a.route,
        target: a.target, bodyHash: a.bodyHash ?? null, signature: a.signature ?? null,
      });
      return head.seq;
    },
    async result(attemptSeq, resultCode, extra) {
      await append({ ts: now(), action: "route-result", attemptSeq, resultCode, deviceId: extra?.deviceId ?? null, sessionHash: extra?.sessionHash ?? null });
    },
    event(action, fields = {}) {
      return append({ ...fields, action, ts: fields.ts ?? now() });
    },
    async refusal(deviceId, code, route) {
      const key = deviceId ?? "-";
      const t = now();
      const last = lastRefusal.get(key);
      if (last !== undefined && t - last < REFUSAL_COALESCE_MS) return false;
      lastRefusal.set(key, t);
      if (lastRefusal.size > 1000) {
        for (const [k, v] of lastRefusal) if (t - v >= REFUSAL_COALESCE_MS) lastRefusal.delete(k);
      }
      await append({ ts: t, action: "refusal", deviceId, route: route ?? null, resultCode: code });
      return true;
    },
    head: () => store.head(),
    async page(opts) {
      const rows = await store.page(opts);
      const head = await store.head();
      const view: AuditViewRow[] = [];
      for (const r of rows) {
        if (r.action === "route" && r.kind === "entry") {
          const res = await store.resultFor(r.seq);
          view.push({ ...r, outcome: res?.resultCode ?? "unknown" });
        } else {
          view.push(r);
        }
      }
      if (!verified || verified.atHeadSeq !== (head?.seq ?? 0)) {
        const value = await store.verify();
        verified = { atHeadSeq: head?.seq ?? 0, value };
      }
      return { rows: view, chain: { ok: verified.value.ok, firstBadSeq: verified.value.firstBadSeq } };
    },
  };
}
