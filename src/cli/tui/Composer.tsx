import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeDrop } from "./paste.ts";
import type { FileEntry } from "../../shared/at-file-filter.ts";
import { acceptSuggestion, suggestAtEntries } from "./at-complete.ts";

/** A stable identity for an active `@`-query slice — used to know when the
 *  query has moved on (so a stale `sel`/dismiss doesn't leak into a new
 *  one). Two slices with the same start and query text are "the same"
 *  suggestion set for this purpose, even across renders. */
function sliceKey(slice: { start: number; query: string }): string {
  return `${slice.start}\u0000${slice.query}`;
}

/** How long to wait after the query stops changing before firing
 *  remoteSearch (mirrors the webview's /refs/resolve debounce, CLAUDE.md
 *  section 12) so a fast typist doesn't fire one request per keystroke. */
const REMOTE_SEARCH_DEBOUNCE_MS = 200;

/** Cap on remote rows actually rendered, independent of how many the
 *  caller's remoteSearch resolves with (mirrors at-complete.ts's own cap). */
const MAX_REMOTE_SUGGESTIONS = 5;

/** Shortest query `remoteSearch` is ever fired for — a bare `@` (empty
 *  query) or a single character would force the server to rank the ENTIRE
 *  listing to serve at most a handful of very loose matches, and the local
 *  capped `suggestAtEntries` rows already serve a query this short just
 *  fine. */
const MIN_REMOTE_QUERY_LEN = 2;

/**
 * A minimal single-line text input, hand-rolled on `useInput` (no extra dep).
 * Stays mounted across sends so you can fire several messages in a row; clears
 * on submit, exits on Esc. Only active while `active` so it never competes with
 * the dashboard's nav keys.
 *
 * When `fileEntries` is given, typing an `@`-token opens an inline popover
 * (up to 5 rows) beneath the input — CLI parity for the webview's `@` file
 * autocomplete (CLAUDE.md §12). Omitting `fileEntries` disables the feature
 * entirely: no popover, no extra per-keystroke work, identical behavior to
 * before this prop existed.
 */
export function Composer({
  active,
  label,
  width,
  fileEntries,
  remoteSearch,
  listingError,
  onSubmit,
  onCancel,
}: {
  active: boolean;
  label: string;
  width?: number;
  fileEntries?: FileEntry[];
  /** Full-depth server-side search for a monorepo whose local listing was
   *  truncated at the 20k cap (CLAUDE.md §12) — when given, an active `@`
   *  query is debounced and handed to this instead of relying solely on the
   *  capped `fileEntries` passed in above. Resolves with rows already
   *  ranked/filtered for `q`, or `null` on a failed search — a `null`
   *  leaves whatever's already showing untouched (the local
   *  `suggestAtEntries` rows), so a transient failure can't blank the
   *  popover; a genuine `[]` DOES replace them (every local match is
   *  contained in the full listing, so an empty full-search answer means
   *  there's truly nothing there). This component only caps the display
   *  count and discards a stale (superseded-by-a-newer-query) answer.
   *  Omitting this prop is a no-op — identical to before it existed. */
  remoteSearch?: (q: string) => Promise<FileEntry[] | null>;
  /** Why the file listing couldn't be fetched (Dashboard's compose-open
   *  fetch failed). With an active `@` query and zero entries, the popover
   *  area renders this as a dim notice instead of staying silent — a failed
   *  listing must not read as "no matches". Escape dismisses it; every
   *  other key behaves as if nothing were shown. */
  listingError?: string | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  // The slice key the popover was dismissed for (Esc while open). Compared
  // by value (see `sliceKey`), so it's cleared below whenever the active key
  // changes — otherwise a query that narrows away from the dismissed key and
  // later widens back to it (e.g. typing past it, then backspacing) would
  // compare equal to a stale dismissal and never reopen.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Memoized: `suggestAtEntries` re-scans the whole listing (a fresh
  // subsequence-match pass over every entry) and, unmemoized, ran on every
  // render body — including the ~12fps re-renders `useSpinner` drives on the
  // parent Dashboard while any task is running, and any of this composer's
  // own unrelated state changes (e.g. `sel` moving on an arrow key). Only a
  // change to the listing or the typed text should recompute it.
  const suggestions = useMemo(
    () => (fileEntries ? suggestAtEntries(fileEntries, text) : null),
    [fileEntries, text],
  );
  const currentKey = suggestions ? sliceKey(suggestions.slice) : null;

  // Ref mirrors `currentKey` synchronously (assigned every render, not just
  // in an effect) so the async `remoteSearch` callback below can tell
  // whether its answer is still relevant at the moment it resolves — the
  // actual "is this a stale response" check. The `alive` flag inside the
  // effect below is a separate, narrower guard (don't set state after this
  // effect instance was cleaned up); together they cover both "a newer
  // query superseded this one" and "we're mid-unmount".
  const currentKeyRef = useRef<string | null>(null);
  currentKeyRef.current = currentKey;

  // Remote answer for a specific query key, kept only while it still
  // matches `currentKey` below — a stale answer for an abandoned query is
  // never rendered, even if it lands after the query has moved on.
  const [remoteEntries, setRemoteEntries] = useState<{ key: string; entries: FileEntry[] } | null>(null);

  useEffect(() => {
    if (!remoteSearch || !suggestions || currentKey === null) return;
    const key = currentKey;
    const query = suggestions.slice.query;
    // Don't fire a full-listing rank for a query this short — see
    // `MIN_REMOTE_QUERY_LEN`'s doc.
    if (query.length < MIN_REMOTE_QUERY_LEN) return;
    let alive = true;
    const timer = setTimeout(() => {
      void remoteSearch(query)
        .then((entries) => {
          // Discard if this effect instance was cleaned up, or if a newer
          // query has since taken over (the ref is the live truth; `key` is
          // just what this particular request was asked to resolve).
          if (!alive || currentKeyRef.current !== key) return;
          // `null` means the search errored — leave `remoteEntries` alone so
          // the fallback below keeps showing the local `suggestAtEntries`
          // rows instead of being blanked by a failure masquerading as
          // "zero matches". A genuine `[]` DOES replace them (see the prop
          // doc above).
          if (entries === null) return;
          setRemoteEntries({ key, entries: entries.slice(0, MAX_REMOTE_SUGGESTIONS) });
        })
        .catch(() => {
          // Defensive backstop only — the contract is that `remoteSearch`
          // never rejects (a failure resolves to `null` instead). Keep
          // showing whatever's already on screen if it does anyway.
        });
    }, REMOTE_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `currentKey` (not `suggestions`' object identity, which changes every
    // render the memo recomputes) is the actual "did the active query
    // change" signal — that's what should restart the debounce timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteSearch, currentKey]);

  // A matching-key remote answer overrides the local rows; otherwise (no
  // remoteSearch, no answer yet, in flight, or errored) fall back to the
  // local `suggestAtEntries` rows exactly as before this prop existed.
  const remoteEntriesForCurrentKey =
    remoteEntries && currentKey !== null && remoteEntries.key === currentKey ? remoteEntries.entries : null;
  const displayEntries = remoteEntriesForCurrentKey ?? (suggestions ? suggestions.entries : []);

  const open = suggestions !== null && displayEntries.length > 0 && currentKey !== dismissedKey;
  const errorOpen = suggestions !== null && displayEntries.length === 0
    && (fileEntries?.length ?? 0) === 0 && !!listingError && currentKey !== dismissedKey;
  const clampedSel = displayEntries.length > 0 ? Math.min(sel, displayEntries.length - 1) : 0;

  // Reset the highlighted row whenever the active query changes (new slice
  // start, or the query text narrowed/widened) — otherwise `sel` can point
  // past a shorter new list, or land on an unrelated row of a new query.
  // Also clear a stale dismissal here: `dismissedKey` is compared by value
  // (see `sliceKey`), so `@src` → Esc → type `x` → backspace returns to a
  // key equal to the one just dismissed, and without this the popover would
  // stay closed forever even though the user re-typed the query from
  // scratch. Clearing on every key change (not just a mismatch with
  // `dismissedKey`) is safe — a genuinely different key already isn't equal
  // to `dismissedKey`, so this is a no-op in that case — and mirrors the
  // webview's `AtFileAutocomplete.tsx` `dismissedSlice` reset.
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentKey !== prevKeyRef.current) {
      prevKeyRef.current = currentKey;
      setSel(0);
      setDismissedKey(null);
    }
  }, [currentKey]);

  useInput(
    (input, key) => {
      if (errorOpen && suggestions) {
        // Notice mode: only Escape (dismiss) is handled — typing/Enter must
        // behave as if nothing were shown.
        if (key.escape) {
          setDismissedKey(currentKey);
          return;
        }
      }
      if (open && suggestions) {
        if (key.tab || key.return) {
          const entry = displayEntries[clampedSel];
          if (entry) setText(acceptSuggestion(text, suggestions.slice, entry));
          return;
        }
        if (key.upArrow) {
          setSel((s) => (s - 1 + displayEntries.length) % displayEntries.length);
          return;
        }
        if (key.downArrow) {
          setSel((s) => (s + 1) % displayEntries.length);
          return;
        }
        if (key.escape) {
          setDismissedKey(currentKey);
          return;
        }
        // Anything else (typing, backspace) falls through to the normal
        // handling below so the query keeps narrowing/widening.
      }

      if (key.escape) {
        setText("");
        onCancel();
        return;
      }
      if (key.return) {
        const t = text.trim();
        if (t) {
          onSubmit(t);
          setText("");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setText((s) => s.slice(0, -1));
        return;
      }
      // Append printable input only — skip control/meta chords (arrows, Ctrl-C).
      // A multi-char chunk is a paste/drop; normalize a dragged file path.
      if (input && !key.ctrl && !key.meta) {
        const chunk = input.length > 1 ? sanitizeDrop(input) : input;
        setText((s) => s + chunk);
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" width={width}>
      {/* truncate-start keeps the caret (and the text you just typed) on
          screen when the message outgrows the terminal width. */}
      <Box paddingX={1} width={width}>
        <Text wrap="truncate-start">
          <Text color="cyan">{label} </Text>
          {text}
          <Text color="cyan">▏</Text>
        </Text>
      </Box>
      {errorOpen ? (
        <Box paddingX={1} width={width}>
          <Text color="yellow" dimColor wrap="truncate">
            ⚠ file listing unavailable — @ suggestions off ({listingError})
          </Text>
        </Box>
      ) : null}
      {open && suggestions ? (
        <Box flexDirection="column" paddingX={1} width={width}>
          {displayEntries.map((entry, i) => (
            <Text
              key={entry.path}
              color="cyan"
              inverse={i === clampedSel}
            >
              {"▸ "}
              {entry.path}
            </Text>
          ))}
          <Text dimColor>tab/enter accept · esc dismiss</Text>
        </Box>
      ) : null}
    </Box>
  );
}
