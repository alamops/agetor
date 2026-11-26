/**
 * Idempotency of remote mutations (docs/specs/remote-readiness-spec.md "Idempotency", plan A-7).
 *
 * Every non-GET remote call carries a 128-bit `idem` key (32 lowercase hex). The result is stored per device for 10 minutes in SQLite
 * (migration 096), so a phone that retries after a relay redelivery, a reconnect, a port handoff or a core restart gets the stored
 * result instead of applying the mutation twice. The same key with a different body is refused (409 `idem-mismatch`). A response up to
 * 64 KB is stored whole; a larger one stores its status only (the repeat then answers that status with no body).
 *
 * Two concurrent calls with the same key are serialized in memory: the second waits for the first and answers from its result.
 */
import { createHash } from "node:crypto";

export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 64 * 1024;
const KEY_RE = /^[0-9a-f]{32}$/;

export function isValidIdemKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

/** SHA-256 hex of a request body (and the method and path): what "the same call" means. */
export function requestHash(method: string, path: string, query: string | null, body: unknown): string {
  return createHash("sha256").update(JSON.stringify([method, path, query ?? "", body ?? null])).digest("hex");
}

export interface StoredResult {
  status: number;
  contentType: string;
  /** Null when the response was too large to keep (status only). */
  body: Uint8Array | null;
}

export interface IdempotencyStore {
  get(deviceId: string, key: string): Promise<{ bodyHash: string; status: number; contentType: string; response: Uint8Array | null; createdAt: number } | null>;
  put(row: { deviceId: string; idemKey: string; bodyHash: string; status: number; contentType: string; response: Uint8Array | null; createdAt: number }): Promise<boolean>;
  prune(beforeTs: number): Promise<number>;
}

export function createDbIdempotencyStore(): IdempotencyStore {
  const db = () => import("../db-async.ts");
  return {
    get: async (d, k) => (await db()).remoteIdempotency.get(d, k),
    put: async (row) => (await db()).op("remote.idempotencyPut", [row]),
    prune: async (before) => (await db()).op("remote.idempotencyPrune", [before]),
  };
}

export type Claim =
  | { kind: "hit"; result: StoredResult }
  | { kind: "mismatch" }
  | {
      kind: "run";
      /** Store the result and release any waiting duplicate. */
      commit(result: StoredResult): Promise<void>;
      /** The call failed before producing a result worth keeping: release the key so a retry runs again. */
      abort(): void;
    };

export interface Idempotency {
  claim(deviceId: string, key: string, bodyHash: string): Promise<Claim>;
  prune(now?: number): Promise<number>;
}

export function createIdempotency(store: IdempotencyStore = createDbIdempotencyStore(), now: () => number = Date.now): Idempotency {
  const running = new Map<string, { bodyHash: string; done: Promise<void>; release: () => void }>();

  const fromRow = (r: { status: number; contentType: string; response: Uint8Array | null }): StoredResult => ({ status: r.status, contentType: r.contentType, body: r.response });

  const claim = async (deviceId: string, key: string, bodyHash: string): Promise<Claim> => {
    if (!isValidIdemKey(key)) throw new Error("bad idempotency key");
    const k = `${deviceId}\0${key}`;
    for (;;) {
      const stored = await store.get(deviceId, key);
      if (stored && now() - stored.createdAt < IDEMPOTENCY_WINDOW_MS) {
        return stored.bodyHash === bodyHash ? { kind: "hit", result: fromRow(stored) } : { kind: "mismatch" };
      }
      const other = running.get(k);
      if (other) {
        if (other.bodyHash !== bodyHash) return { kind: "mismatch" };
        await other.done; // then look the stored result up again (or run, if the first aborted)
        continue;
      }
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      running.set(k, { bodyHash, done, release });
      return {
        kind: "run",
        commit: async (result) => {
          try {
            const keep = result.body && result.body.length <= IDEMPOTENCY_MAX_RESPONSE_BYTES ? result.body : null;
            await store.put({ deviceId, idemKey: key, bodyHash, status: result.status, contentType: result.contentType, response: keep, createdAt: now() });
          } finally {
            running.delete(k);
            release();
          }
        },
        abort: () => {
          running.delete(k);
          release();
        },
      };
    }
  };

  return { claim, prune: (at = now()) => store.prune(at - IDEMPOTENCY_WINDOW_MS) };
}
