/**
 * Forward-resume decisions for the per-task event stream
 * (docs/plans/event-stream-forward-resume.md §3.1).
 *
 * A reconnecting client sends the id of the last event it saw (the
 * `Last-Event-ID` header, or `?afterId=`); the server answers with just the
 * events after it ("resume") or, when that gap is too big or the cursor makes
 * no sense for this database, tells the client to start over from a fresh
 * window ("snapshot").
 *
 * Everything here is pure and imports nothing from `db.ts` (or anything
 * else), so the HTTP route, the db layer and a future remote router that has
 * no SQLite handle can share one definition of "what is a valid cursor" and
 * "does this gap fit" (grill D13).
 */

/** Why a resume was refused and the client must take a fresh window. */
export type ForwardResumeSnapshotReason = "cursor-ahead" | "too-many" | "too-large";

export type ForwardResumeDecision =
  | { kind: "resume" }
  | { kind: "snapshot"; reason: ForwardResumeSnapshotReason };

const CURSOR_RE = /^[0-9]{1,16}$/;

/**
 * A cursor is 1–16 ASCII digits that fit a safe integer. Anything else
 * (absent, empty, signed, decimal, non-numeric, too long) is `null`: the
 * caller treats it as "no cursor" and serves today's fresh window — never an
 * error, because a client retries a 400 forever (grill D15).
 */
export function parseResumeCursor(raw: string | null | undefined): number | null {
  if (raw == null || !CURSOR_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The first VALID of header, query wins: a malformed header falls through to
 *  a valid query parameter rather than masking it. */
export function resolveResumeCursor(
  header: string | null | undefined,
  query: string | null | undefined,
): number | null {
  return parseResumeCursor(header) ?? parseResumeCursor(query);
}

/**
 * Resume or snapshot, in this order:
 *  1. `afterId > highWater` — the cursor came from another (or a wiped)
 *     database; a legitimate one can never exceed the AUTOINCREMENT
 *     high-water mark → `cursor-ahead`.
 *  2. more than `maxEvents` rows after the cursor → `too-many`. The caller
 *     probes with `LIMIT maxEvents + 1`, so the +1 row proves it without ever
 *     seeing an unbounded set.
 *  3. their `len` (UTF-8 bytes) sum above `maxBytes` → `too-large`.
 *  4. otherwise resume, possibly with an empty gap.
 *
 * All-or-nothing: there is no partial resume.
 */
export function decideForwardResume(args: {
  afterId: number;
  highWater: number;
  gapRowsAsc: ReadonlyArray<{ id: number; len: number }>;
  maxEvents: number;
  maxBytes: number;
}): ForwardResumeDecision {
  const { afterId, highWater, gapRowsAsc, maxEvents, maxBytes } = args;
  if (afterId > highWater) return { kind: "snapshot", reason: "cursor-ahead" };
  if (gapRowsAsc.length > maxEvents) return { kind: "snapshot", reason: "too-many" };
  let total = 0;
  for (const row of gapRowsAsc) total += row.len;
  if (total > maxBytes) return { kind: "snapshot", reason: "too-large" };
  return { kind: "resume" };
}
