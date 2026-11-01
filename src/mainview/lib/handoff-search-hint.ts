// Which handoff cards may still show the "Match in handoff — Open to see it"
// hint (`docs/plans/formatted-handoff.md` D10). A card sets the hint when a
// search jump (`EXPAND_EVENT`, carrying the query) lands on a match that is
// only visible inside its modal. The hint is only true while THAT search is
// still on screen, so RunPanel publishes its search session here and each card
// clears its hint when the search closes or the query changes.
//
// Module-level store (one RunPanel instance exists app-wide); pure and
// DOM-free so it is unit-tested without a DOM env.

export interface HandoffSearchSession {
  open: boolean;
  query: string;
}

/** The hint set for `hintQuery` still describes `session`: the search is open
 *  and the query is the one the jump matched. */
export function searchHintStillValid(hintQuery: string, session: HandoffSearchSession): boolean {
  return session.open && session.query === hintQuery;
}

/** Whether a search jump onto an invalid-handoff card should open its
 *  collapsed "Raw handoff" section: the jump's query occurs in the raw text
 *  the section shows. The search trims and lower-cases its query
 *  (`findMatchingEventIds`), so this does too. A jump that carries no query
 *  reads as a plain "expand me", like every other expand-on-jump listener; a
 *  blank query matches nothing, as in the search itself. */
export function rawHandoffMatchesJump(raw: string, query: string | undefined): boolean {
  if (query === undefined) return true;
  const needle = query.trim().toLowerCase();
  return needle !== "" && raw.toLowerCase().includes(needle);
}

type Listener = (session: HandoffSearchSession) => void;

let current: HandoffSearchSession = { open: false, query: "" };
const listeners = new Set<Listener>();

export function getHandoffSearchSession(): HandoffSearchSession {
  return current;
}

/** Publish the panel's search state. A no-op when nothing changed. */
export function publishHandoffSearchSession(next: HandoffSearchSession): void {
  if (next.open === current.open && next.query === current.query) return;
  current = { open: next.open, query: next.query };
  for (const fn of [...listeners]) fn(current);
}

export function subscribeHandoffSearchSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam. */
export function resetHandoffSearchSessionForTest(): void {
  current = { open: false, query: "" };
  listeners.clear();
}
