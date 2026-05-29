/**
 * Pure splice: given the current textarea value and the live `selectionStart`
 * / `selectionEnd` (or `null` to append), compute the next value and the
 * caret position that should follow the inserted token. Surrounds the
 * insertion with single spaces when adjacent characters aren't already
 * whitespace so the marker stays a clean grep-friendly token.
 *
 * Pure → safe to call from inside a `setState((cur) => …)` updater, which
 * is how callers avoid the closure-staleness race when two captures land
 * across an async boundary.
 */
export interface Splice {
  next: string;
  caret: number;
}

export function spliceAtSelection(
  value: string,
  selection: { start: number; end: number } | null,
  insertion: string,
): Splice {
  const start = selection?.start ?? value.length;
  const end = selection?.end ?? value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const needLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const token = `${needLeadingSpace ? " " : ""}${insertion}${needTrailingSpace ? " " : ""}`;
  return { next: before + token + after, caret: start + token.length };
}

/** Read the live caret position from the textarea, but only when it's
 *  focused. An unfocused textarea has a meaningless `selectionStart` (often
 *  0 or stale) — we want to append in that case, which the splice helper
 *  does when given `null`. */
export function readCaret(el: HTMLTextAreaElement | null): { start: number; end: number } | null {
  if (!el || document.activeElement !== el) return null;
  return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
}

/** Restore the caret on the next frame, after React has flushed the new
 *  `value` into the DOM. WKWebView occasionally throws if `value` hasn't
 *  propagated yet — the try/catch keeps the marker visible even when the
 *  caret restore fails. */
export function restoreCaret(el: HTMLTextAreaElement | null, caret: number): void {
  if (!el) return;
  requestAnimationFrame(() => {
    el.focus();
    try { el.setSelectionRange(caret, caret); } catch { /* see above */ }
  });
}
