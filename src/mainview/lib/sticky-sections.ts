/**
 * Sticky-header grouping for the RunPanel transcript (the "sticky user
 * messages" preference): each user message heads a section whose body is
 * every event up to the next user message. Pure and generic over the node
 * type so the grouping rules are unit-testable without React.
 */

export type StickyItem<N> =
  /** A user message. `header` is its rendered bubble — null when the message
   *  renders nothing (a hidden harness-stack continuation prompt). */
  | { kind: "turn"; key: string; header: N | null; before: N[] }
  | { kind: "body"; key: string; nodes: N[] };

export interface StickySection<N> {
  key: string;
  header: N | null;
  body: N[];
}

/**
 * Preamble events before the first user message share an initial headerless
 * section. Each subsequent VISIBLE user message starts a new section. A user
 * message that renders nothing (the hidden continuation agetor sends after an
 * account swap) does not open one: a headerless section mid-transcript would
 * end the previous turn's sticky header for no visible reason (review N4), so
 * its slotted interactions join the current section's body instead.
 */
export function groupStickySections<N>(
  items: ReadonlyArray<StickyItem<N>>,
  trailing: readonly N[] = [],
): StickySection<N>[] {
  const sections: StickySection<N>[] = [];
  let current: StickySection<N> = { key: "", header: null, body: [] };
  for (const item of items) {
    if (item.kind === "turn" && item.header !== null) {
      if (current.header !== null || current.body.length > 0) sections.push(current);
      current = { key: item.key, header: item.header, body: [...item.before] };
      continue;
    }
    if (current.key === "") current.key = item.key;
    if (item.kind === "turn") current.body.push(...item.before);
    else current.body.push(...item.nodes);
  }
  current.body.push(...trailing);
  if (current.header !== null || current.body.length > 0) sections.push(current);
  return sections;
}
