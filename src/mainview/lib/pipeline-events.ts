/**
 * In-memory fan-out for the pipeline-relevant `GlobalEvent`s — the
 * `pipeline`, `column`, `run-status` and `interaction` kinds (see
 * `GlobalEvent` in `src/shared/types.ts`, and `docs/plans/pipelines.md`
 * D12). `interaction` is what lets the run view repaint a step's amber
 * "waiting on you" highlight the moment it asks (or its question resolves),
 * instead of on the next 2s poll —
 * `docs/plans/pipeline-blocked-step-highlight.md` D8.
 *
 * Same spirit as `lib/clone-progress.ts`: WKWebView caps HTTP/1.1
 * connections per host at ~6, and two are already spent on permanent SSE
 * channels (`/app/events`, `/events`, plus one per open task's
 * `/tasks/:id/events`) — so neither the pipeline run view nor the RunPanel's
 * pipeline strip may open their own `EventSource` on `/events`. Instead
 * `App.tsx`'s single `subscribeGlobalEvents` handler forwards every
 * `pipeline`/`column`/`run-status`/`interaction` event here via
 * `publishPipelineGlobalEvent` — FIRST thing, before any of its own toast /
 * board gating — and consumers subscribe through
 * `subscribePipelineGlobalEvents`.
 *
 * Plain module state, no React — a `useEffect` in the consumer is enough,
 * and it stays unit-testable with `bun:test` (no jsdom in this repo). The
 * store is deliberately kind-agnostic: App decides which kinds to forward,
 * and a consumer narrows on `e.kind` itself.
 */
import type { GlobalEvent } from "../../shared/types.ts";

type Listener = (e: GlobalEvent) => void;

const listeners = new Set<Listener>();

/** Publish one `GlobalEvent` to every current subscriber. Called from
 *  `App.tsx`'s `subscribeGlobalEvents` handler — never from a consumer.
 *  Listeners are snapshotted before dispatch so one that unsubscribes (or
 *  subscribes a sibling) mid-dispatch can't skip or double-fire another,
 *  and a throwing listener never breaks App's own handler or the remaining
 *  listeners — it's logged and dispatch continues. */
export function publishPipelineGlobalEvent(e: GlobalEvent): void {
  for (const cb of [...listeners]) {
    try {
      cb(e);
    } catch (err) {
      console.warn("[agetor] pipeline global-event listener threw", err);
    }
  }
}

/** Subscribe to every published event. Returns an unsubscribe function
 *  (idempotent — calling it twice is a no-op). */
export function subscribePipelineGlobalEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only seam: production code must never call this. Lets tests prove
 *  subscriptions don't leak and reset the module between runs (the set is
 *  module-level and `bun test` runs every file in one process). */
export const __forTest = {
  listenerCount(): number {
    return listeners.size;
  },
  reset(): void {
    listeners.clear();
  },
};
