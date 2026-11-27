/**
 * Audit retention (docs/specs/remote-readiness-spec.md "Audit log"): one year or 50,000 entries, whichever trims more. A daily job
 * calls the worker op `remote.auditTrim`, which drops the oldest rows and writes an anchor row with the hash of the last dropped
 * entry, so the chain still verifies from the oldest remaining row. The work runs in the database worker as one transaction, so the
 * main thread only awaits a single call (no loop here).
 */
import type { AuditStore } from "./audit.ts";

export const AUDIT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const AUDIT_MAX_ROWS = 50_000;
export const AUDIT_TRIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AuditRetentionDeps {
  store: AuditStore;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  maxAgeMs?: number;
  maxRows?: number;
  intervalMs?: number;
  /** Errors are reported here (the core log), never thrown out of the timer. */
  onError?: (e: unknown) => void;
}

export function trimAuditNow(deps: Pick<AuditRetentionDeps, "store" | "now" | "maxAgeMs" | "maxRows">): Promise<{ dropped: number; anchorSeq: number | null }> {
  return deps.store.trim({ maxAgeMs: deps.maxAgeMs ?? AUDIT_MAX_AGE_MS, maxRows: deps.maxRows ?? AUDIT_MAX_ROWS, now: (deps.now ?? Date.now)() });
}

/** Trim once now, then every day. Returns a stop function. */
export function startAuditRetention(deps: AuditRetentionDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void trimAuditNow(deps)
      .catch((e) => deps.onError?.(e))
      .finally(() => {
        if (!stopped) handle = setTimer(tick, deps.intervalMs ?? AUDIT_TRIM_INTERVAL_MS);
      });
  };
  // Let boot finish before the first trim.
  handle = setTimer(tick, 60_000);
  return () => {
    stopped = true;
    if (handle !== null) clearTimer(handle);
  };
}
