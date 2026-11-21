/**
 * Pure keyboard math for a listbox (`ui/picker.tsx`). Kept free of React and
 * the DOM so the arrow / Home / End / type-ahead rules are unit-testable.
 *
 * Every function works on the list of *enabled-ness* flags rather than on the
 * items themselves, so a disabled option is skipped the same way everywhere.
 */

export interface NavItem {
  disabled?: boolean;
}

function enabledIndexes(items: readonly NavItem[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (!it.disabled) out.push(i);
  });
  return out;
}

/** The first enabled index, or -1 when every option is disabled / the list is empty. */
export function firstEnabled(items: readonly NavItem[]): number {
  return enabledIndexes(items)[0] ?? -1;
}

/** The last enabled index, or -1. */
export function lastEnabled(items: readonly NavItem[]): number {
  const idx = enabledIndexes(items);
  return idx.length ? idx[idx.length - 1]! : -1;
}

/**
 * The next enabled index after `from` (wrapping). `from = -1` (nothing active
 * yet) lands on the first enabled option. Returns -1 when none is enabled.
 */
export function nextEnabled(items: readonly NavItem[], from: number): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (((from + step) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

/**
 * The previous enabled index before `from` (wrapping). `from = -1` lands on
 * the last enabled option. Returns -1 when none is enabled.
 */
export function prevEnabled(items: readonly NavItem[], from: number): number {
  const n = items.length;
  if (n === 0) return -1;
  const start = from < 0 ? 0 : from;
  for (let step = 1; step <= n; step++) {
    const i = (((start - step) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Resolve a navigation key to the next active index (or the current one when
 *  nothing is enabled). Other keys return `null` so the caller can ignore them. */
export function navigate(items: readonly NavItem[], from: number, key: string): number | null {
  switch (key) {
    case "ArrowDown": {
      const i = nextEnabled(items, from);
      return i === -1 ? from : i;
    }
    case "ArrowUp": {
      const i = prevEnabled(items, from);
      return i === -1 ? from : i;
    }
    case "Home": {
      const i = firstEnabled(items);
      return i === -1 ? from : i;
    }
    case "End": {
      const i = lastEnabled(items);
      return i === -1 ? from : i;
    }
    default:
      return null;
  }
}

/**
 * Type-ahead for a list with no search box: the next enabled option whose label
 * starts with `buffer` (case-insensitive), searching forward from `from + 1`
 * and wrapping. Typing the same single letter repeatedly cycles through the
 * options that start with it. Returns -1 when nothing matches.
 */
export function typeAhead(
  items: readonly (NavItem & { label: string })[],
  from: number,
  buffer: string,
): number {
  const q = buffer.toLowerCase();
  if (!q) return -1;
  const n = items.length;
  if (n === 0) return -1;
  const sameLetter = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = sameLetter ? q[0]! : q;
  // A repeated single letter ("aaa") cycles; a longer prefix re-matches from the
  // current option so refining "ca" → "cal" doesn't skip past it.
  const startOffset = sameLetter || q.length === 1 ? 1 : 0;
  for (let step = 0; step < n; step++) {
    const i = (((from + startOffset + step) % n) + n) % n;
    const it = items[i]!;
    if (!it.disabled && it.label.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** Whether a key press should be treated as a type-ahead character. */
export function isTypeAheadKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
}
