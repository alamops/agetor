import { harnessAutoEnabled, harnesses } from "./db.ts";
import { refreshHarnessModels } from "./model-discovery.ts";
import {
  AUTO_ENABLE_KINDS,
  type AppEvent,
  type HarnessStatus,
} from "../shared/types.ts";

/**
 * Auto-enable built-in harnesses whose CLI is installed (D-14,
 * `docs/plans/add-opencode-harness.md`). The built-in rows of the
 * `AUTO_ENABLE_KINDS` ship disabled; the first time one is seen `available`
 * it is turned on and recorded in `harness_auto_enabled`. The record is what
 * makes a later manual Off stick: a recorded id is never acted on again.
 *
 * Every function here is synchronous, so two concurrent `GET /harnesses` calls
 * (or a boot call racing one) cannot interleave between the `has` check and
 * the `record` write; the db `record` is also INSERT OR IGNORE. Whichever call
 * records an id first is the only one that enables and announces it.
 */

type Broadcaster = (e: AppEvent) => boolean;

let broadcaster: Broadcaster | null = null;
let refreshModels: (harnessId: string) => Promise<void> = refreshHarnessModels;

/**
 * Off under `NODE_ENV=test` unless `AGETOR_HARNESS_AUTO_ENABLE=1`;
 * `AGETOR_HARNESS_AUTO_ENABLE=0` disables it anywhere. The seam keeps tests
 * that stub `AGETOR_CODEX_BIN=/bin/echo` from silently turning codex on.
 */
export function harnessAutoEnableActive(): boolean {
  const v = process.env.AGETOR_HARNESS_AUTO_ENABLE;
  if (v === "0") return false;
  if (v === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/** Live broadcast hook. `fn` reports whether ≥1 client received the event. */
export function setHarnessAutoEnableBroadcaster(fn: Broadcaster | null): void {
  broadcaster = fn;
}

function buildNotice(harnessIds: string[]): Extract<AppEvent, { type: "harnesses_auto_enabled" }> | null {
  const ids: string[] = [];
  const labels: string[] = [];
  for (const id of harnessIds) {
    const row = harnesses.get(id);
    // A vanished row, or one the user turned back Off since, has nothing to announce.
    if (!row || !row.enabled) continue;
    ids.push(id);
    labels.push(row.label);
  }
  if (ids.length === 0) return null;
  return { type: "harnesses_auto_enabled", harnessIds: ids, labels, ts: Date.now() };
}

/**
 * D-14. Returns the harness ids it turned ON in this call. A built-in row
 * that was already on is recorded silently (no notice), so a later Off sticks.
 * Not-available rows are left alone and unrecorded so they turn on once the
 * CLI shows up.
 */
export function applyHarnessAutoEnable(statuses: readonly HarnessStatus[]): string[] {
  if (!harnessAutoEnableActive()) return [];
  const enabledNow: string[] = [];
  for (const status of statuses) {
    if (!status.available || !AUTO_ENABLE_KINDS.has(status.kind)) continue;
    const row = harnesses.get(status.harnessId);
    // Built-in rows only: an additional account harness of the same kind is
    // the user's own and is never touched. A missing row (synthetic fallback)
    // has nothing to enable.
    if (!row || !row.isBuiltin || row.kind !== status.kind) continue;
    if (harnessAutoEnabled.has(row.id)) continue;
    harnessAutoEnabled.record(row.id);
    if (row.enabled) {
      // The user (or an earlier build) already had it on: nothing to announce.
      harnessAutoEnabled.markNotified([row.id]);
      continue;
    }
    harnesses.setEnabled(row.id, true);
    enabledNow.push(row.id);
  }
  if (enabledNow.length === 0) return enabledNow;

  for (const id of enabledNow) {
    void refreshModels(id).catch((err) => {
      console.error("[agetor] model discovery after auto-enable failed:", err);
    });
  }

  const fn = broadcaster;
  if (fn) {
    const notice = buildNotice(enabledNow);
    if (notice) {
      let delivered = false;
      try {
        delivered = fn(notice);
      } catch (err) {
        console.error("[agetor] harness auto-enable broadcast failed:", err);
      }
      // Undelivered ids stay pending for the next /app/events subscriber.
      if (delivered) harnessAutoEnabled.markNotified(enabledNow);
    }
  }
  return enabledNow;
}

/**
 * Send one `harnesses_auto_enabled` event for every recorded-but-unnotified
 * row that is still enabled, then mark every pending id notified (an id whose
 * row is gone or turned Off has nothing left to announce). No-op when none.
 */
export function flushPendingHarnessAutoEnableNotice(send: (e: AppEvent) => void): void {
  const pending = harnessAutoEnabled.pending();
  if (pending.length === 0) return;
  const notice = buildNotice(pending);
  if (notice) {
    try {
      send(notice);
    } catch (err) {
      // Leave them pending: the client never saw the notice.
      console.error("[agetor] harness auto-enable notice failed:", err);
      return;
    }
  }
  harnessAutoEnabled.markNotified(pending);
}

export const __forTest = {
  /** Swap the model-discovery call; `null` restores the real one. */
  setRefresh(fn: ((harnessId: string) => Promise<void>) | null): void {
    refreshModels = fn ?? refreshHarnessModels;
  },
};
