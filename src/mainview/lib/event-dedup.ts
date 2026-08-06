// Dedup for the unified task-level event stream the run panel renders.
//
// Every user message is emitted TWICE on the wire: once live (the
// orchestrator's `onChunk`/`appendEvent` the instant the message is sent,
// stamped with the wall clock) and once from the JSONL parser when claude
// transcribes it into its session file (a different `ts`). The server also
// replays the full persisted history on every (re)connection. So the panel
// must collapse duplicates client-side — this is that collapse, extracted as a
// pure helper so it can be unit-tested apart from the React effect.
import type { RunEvent } from "../../shared/types.ts";
import { canonicalizeUserText } from "./command-message.ts";
import { canonicalizeAttachmentText } from "../../shared/attachments.ts";

/** Normalize CR-only / CRLF newlines to `\n`. tmux's paste-buffer delivers our
 *  `\n`-separated prompt to claude as `\r`, and the JSONL stores those `\r`s
 *  verbatim — so without this the live (`\n`) and JSONL (`\r`) copies of a user
 *  message differ byte-for-byte in the first 200 chars and slip past dedup. */
const normalizeForKey = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * Composite dedup key for a stream event.
 *
 * `user` events drop `ts` (the live + JSONL copies carry different
 * timestamps) and normalize newlines, keying on `user|runId|first-200-chars`
 * so the two paths collapse to one bubble. Everything else keeps `ts` because
 * the polling fallback in claude-tmux flushes many JSONL events per tick, all
 * stamped with the same `Date.now()` ms — `ts` is what keeps genuinely
 * distinct same-tick events apart.
 *
 * A slash-command send produces a live echo ("/implement args…") the instant
 * it's submitted, and a JSONL twin — claude CLI's `<command-name>`/
 * `<command-args>` XML expansion of that same send — whose text differs
 * byte-for-byte from the echo. `canonicalizeUserText` reduces the XML shape
 * back to the plain echo shape before the key is sliced, so the existing
 * 200-char key collapses the two into one bubble instead of two.
 *
 * An image-attached send has the same live-echo/JSONL-twin split for a
 * different reason: claude's TUI rewrites its OWN transcript copy of the
 * send, prepending a `[Image #N]` placeholder and blanking the image path
 * out of the trailing "Referenced files/folders:" bullet, while the live
 * echo agetor emits keeps the original text and the real path in the bullet.
 * `canonicalizeAttachmentText` strips both differences (the placeholder
 * token, and the now-bare/image bullet) from whichever copy is being keyed,
 * so the live echo and the JSONL twin of the same image-attached send
 * reduce to one identical string and collapse to a single bubble too.
 *
 * Consequence of the ts-less `user` key: two genuinely-identical user sends in
 * the SAME run (e.g. folding `"continue"` twice into one in-flight turn) share
 * a key and render as a single bubble. This is intentional — there is no
 * disambiguator that survives the live-echo↔JSONL-twin collapse — and harmless:
 * both sends are still delivered to claude (the tmux paste is independent of UI
 * dedup). Distinct runs get distinct keys via `runId`, so repeated idle
 * follow-ups still each show.
 */
export function eventDedupKey(e: RunEvent): string {
  return e.stream === "user"
    ? `user|${e.runId}|${canonicalizeAttachmentText(canonicalizeUserText(normalizeForKey(e.data ?? ""))).slice(0, 200)}`
    : `${e.ts}|${e.runId}|${e.stream}|${(e.data ?? "").slice(0, 200)}`;
}

/** Evict oldest keys (Sets iterate in insertion order) once `set` exceeds
 *  `cap`, trimming back down to `keep`. No-op while under the cap. */
function trimOldest(set: Set<string>, cap: number, keep: number): void {
  if (set.size <= cap) return;
  const drop = set.size - keep;
  let i = 0;
  for (const k of set) {
    if (i++ >= drop) break;
    set.delete(k);
  }
}

export interface EventDeduper {
  /** @returns true the first time this event is seen (caller keeps it),
   *  false on a repeat (caller drops it). */
  accept(e: RunEvent): boolean;
}

/**
 * Build a stateful deduper backed by two sets:
 *
 *  - `volatile` — high-volume non-`user` events (stdout / assistant / tool /
 *    status / …). Capped at `cap` keys and trimmed back to `keep` (oldest
 *    evicted) so a multi-thousand-event turn can't grow the set unbounded.
 *
 *  - `durable` — `user` events ONLY. A user message's two copies (live echo +
 *    JSONL twin) can be separated by thousands of intervening events: when a
 *    follow-up is folded into an in-flight turn on a long-running task, the live
 *    echo lands immediately but claude doesn't transcribe the JSONL twin until
 *    it finishes the current (long) response. If the live echo's key lived in
 *    the evictable `volatile` set it would be gone by the time the twin arrives,
 *    and the twin would render as a duplicate bubble — the exact "duplicated
 *    user message on long-running tasks" bug. So `user` keys get their own set,
 *    trimmed only at a far higher threshold (`userCap`). Crucially the fold gap
 *    is measured in *volatile* events, not user messages, so eviction here only
 *    ever drops user keys old enough that their twin landed long ago — the
 *    high cap is pure belt-and-suspenders against an unbounded session, not
 *    load-bearing for correctness. User events are rare (one per turn), so the
 *    default cap is reached only by genuinely enormous conversations.
 */
export function createEventDeduper(opts?: {
  cap?: number;
  keep?: number;
  userCap?: number;
  userKeep?: number;
}): EventDeduper {
  const cap = opts?.cap ?? 5000;
  const keep = opts?.keep ?? 4000;
  const userCap = opts?.userCap ?? 50_000;
  const userKeep = opts?.userKeep ?? 40_000;
  const volatile = new Set<string>();
  const durable = new Set<string>();
  return {
    accept(e: RunEvent): boolean {
      const key = eventDedupKey(e);
      if (e.stream === "user") {
        if (durable.has(key)) return false;
        durable.add(key);
        trimOldest(durable, userCap, userKeep);
        return true;
      }
      if (volatile.has(key)) return false;
      volatile.add(key);
      trimOldest(volatile, cap, keep);
      return true;
    },
  };
}
