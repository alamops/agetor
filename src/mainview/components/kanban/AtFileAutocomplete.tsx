import { useEffect, useMemo, useRef, useState } from "react";
import { iconForRef } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { searchProjectFiles, type FileScope } from "@/lib/use-project-files";
import { findActiveAtQuery, formatAtToken, MAX_PROJECT_FILES } from "../../../shared/at-refs.ts";
import { descendInto, filterFileEntries, fuzzyPathMatch, type FileEntry } from "../../../shared/at-file-filter.ts";

interface Props {
  /** File/directory entries to suggest, scoped to the surface's project +
   *  branch/worktree (see `useProjectFiles`). Empty list disables the
   *  popover regardless of the caret position. */
  entries: FileEntry[];
  /** True when the underlying listing hit the server's file-count cap — a
   *  muted footer row tells the user to keep typing to narrow instead of
   *  silently showing an incomplete set with no explanation, UNLESS
   *  `fileScope` is also given (see that prop's doc), in which case the
   *  remote-search footer takes over once a result lands. */
  truncated?: boolean;
  /** Current textarea value. */
  value: string;
  /** Setter for the textarea value. */
  onChange: (next: string) => void;
  /** The textarea this autocomplete is decorating. We attach key handlers here. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Which side of the textarea the popover floats on — see `SlashAutocomplete`. */
  placement?: "above" | "below";
  /** Only consulted when `truncated` is true (a monorepo past the 20k-file
   *  display cap): the scope to run a debounced server-side full-depth
   *  search (`searchProjectFiles`) against, so a file past the cap still
   *  autocompletes instead of silently never appearing. `null`/omitted keeps
   *  the truncated-mode behavior as before this feature — client-filtered
   *  rows over the capped `entries` only, with the "keep typing to narrow"
   *  footer. */
  fileScope?: FileScope | null;
}

type Slice = { start: number; end: number; query: string; quoted: boolean };

/** After inserting text at `slice`, land the caret at `caret` inside `next`
 *  the way the two peer gotchas require: `setSelectionRange` **before**
 *  `focus()` (a stale caret left inside a live `/token` from a prior render
 *  would pop the slash menu and swallow the next Enter — SlashAutocomplete
 *  syncs its own caret off the native `focus` event, so ours has to already
 *  be correct by the time that fires), and a manual `scrollTop` afterward
 *  since a textarea never auto-scrolls to a programmatically set caret. When
 *  the new caret lands at the very end of the text we know the scroll target
 *  is the bottom (`scrollHeight`); for a caret elsewhere (editing a token
 *  mid-message) we leave the current scroll position alone rather than
 *  guess.
 */
function landCaret(el: HTMLTextAreaElement, caret: number, next: string) {
  el.setSelectionRange(caret, caret);
  el.focus();
  if (caret >= next.length) el.scrollTop = el.scrollHeight;
}

/**
 * `@`-file reference picker, a sibling of `SlashAutocomplete` in shape and
 * behavior: caret tracked off native events, an edge-anchored popover, and a
 * native `keydown` listener that `preventDefault()`s every key it handles so
 * the parent's own `onKeyDown` (Enter-to-send, etc.) can bail on
 * `e.defaultPrevented`.
 *
 * Enter and a row click both *commit* the active row — replace the active
 * `@`-slice with `@path ` (or `@"path" `) and move the caret past the
 * trailing space. Tab is special only for a directory row: it *descends*,
 * rewriting the slice to `@dir/` (no trailing space) so the popover stays
 * open and the list narrows to that directory's contents — Tab on a file row
 * behaves exactly like Enter. This component only renders the picker; it
 * does not resolve `@`-tokens against a listing itself (see
 * `useProjectFiles`) and does not render the in-field highlight (see
 * `AtHighlightBackdrop`).
 *
 * **Truncated-scope fallback**: when `truncated` and `fileScope` are both
 * given, an active slice also fires a debounced (150ms) server-side search
 * (`searchProjectFiles`) over the FULL listing, not just the capped `entries`
 * this component otherwise filters client-side. The remote result is tagged
 * with the exact `(scope, query)` it answers (`remoteResult`) so a response
 * that arrives after the user has moved on to a different query or scope is
 * never shown — `remoteRowsForCurrentQuery` re-validates the tag on every
 * render before trusting it. While a matching remote result exists it
 * REPLACES the displayed rows outright (`rows`); otherwise (no `fileScope`,
 * or the search hasn't resolved yet for the current query) the existing
 * instant client-filtered subset is shown, so the popover never goes blank
 * while a request is in flight.
 */
export function AtFileAutocomplete({ entries, truncated, value, onChange, textareaRef, placement = "below", fileScope }: Props) {
  const [caret, setCaret] = useState<number>(0);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the caret state in sync without forcing the parent to manage it —
  // same approach as SlashAutocomplete.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const sync = () => setCaret(el.selectionStart ?? 0);
    el.addEventListener("keyup", sync);
    el.addEventListener("click", sync);
    el.addEventListener("focus", sync);
    return () => {
      el.removeEventListener("keyup", sync);
      el.removeEventListener("click", sync);
      el.removeEventListener("focus", sync);
    };
  }, [textareaRef]);

  const slice = useMemo<Slice | null>(() => findActiveAtQuery(value, caret), [value, caret]);

  // Escape dismisses the popover WITHOUT moving the caret — identical
  // reasoning to SlashAutocomplete's `dismissedSlice`: forcing the caret to
  // fall out of the active slice is a no-op (and leaves the popover stuck
  // open) whenever the slice already sits at the end of the text.
  const [dismissedSlice, setDismissedSlice] = useState<Slice | null>(null);
  useEffect(() => {
    if (!dismissedSlice) return;
    if (!slice || slice.start !== dismissedSlice.start || slice.end !== dismissedSlice.end || slice.query !== dismissedSlice.query) {
      setDismissedSlice(null);
    }
  }, [slice, dismissedSlice]);

  const isDismissed = !!(dismissedSlice && slice
    && slice.start === dismissedSlice.start && slice.end === dismissedSlice.end && slice.query === dismissedSlice.query);

  const filtered = useMemo<FileEntry[]>(() => {
    if (!slice) return [];
    return filterFileEntries(entries, slice.query, 50);
  }, [entries, slice]);

  // --- Truncated-scope fallback: server-side search over the full listing --
  // Only consulted when the base listing is `truncated` AND a scope is
  // known — otherwise this whole block is inert (no timer, no fetch) and
  // `rows` below is just `filtered`, byte-identical to before this feature.
  const scopeKey = fileScope ? `${fileScope.dir}\0${fileScope.ref ?? ""}` : null;
  const [remoteResult, setRemoteResult] = useState<{ scopeKey: string; query: string; rows: FileEntry[] } | null>(null);
  useEffect(() => {
    if (!truncated || !fileScope || !slice || !scopeKey) {
      setRemoteResult(null);
      return;
    }
    const query = slice.query;
    // Cheap closure captures so the async callback below never reads a
    // `fileScope`/`scopeKey` that could have changed identity by the time it
    // resolves — `cancelled` (below) is still the actual staleness guard;
    // these are just what gets tagged onto the eventual result.
    const scope = fileScope;
    const answeredScopeKey = scopeKey;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchProjectFiles(scope, query, 50).then((rows) => {
        if (cancelled) return; // superseded by a newer slice/scope — drop it
        setRemoteResult({ scopeKey: answeredScopeKey, query, rows });
      });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
    // `fileScope` is read via closure; `scopeKey` (its dir+ref identity) is
    // the dependency that actually matters, same reasoning as the effects in
    // PromptComposer.tsx that stale-guard on a scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truncated, scopeKey, slice?.query]);

  // Only trust `remoteResult` when it answers the CURRENTLY active (scope,
  // query) pair — a result from a query the user has since edited past, or a
  // now-superseded scope, must never leak into `rows` even for one render.
  const remoteRowsForCurrentQuery = remoteResult && slice && scopeKey
    && remoteResult.scopeKey === scopeKey && remoteResult.query === slice.query
    ? remoteResult.rows
    : null;

  // Remote rows (when they answer the current query) win outright; otherwise
  // fall back to the instant client-filtered subset — so the popover never
  // goes blank while a search is in flight or unavailable (no `fileScope`).
  const rows = remoteRowsForCurrentQuery ?? filtered;

  const open = slice !== null && !isDismissed && rows.length > 0;

  // Reset highlight when the displayed list changes (avoid a stale index
  // that points past the new list's length).
  useEffect(() => { setActive(0); }, [slice?.query, rows.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (entry: FileEntry) => {
    if (!slice) return;
    const before = value.slice(0, slice.start);
    const after = value.slice(slice.end);
    const token = formatAtToken(entry.path) + " ";
    const next = before + token + after;
    onChange(next);
    const newCaret = before.length + token.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      landCaret(el, newCaret, next);
      setCaret(newCaret);
    });
  };

  const descend = (entry: FileEntry) => {
    if (!slice) return;
    const before = value.slice(0, slice.start);
    const after = value.slice(slice.end);
    const descended = descendInto(entry.path);
    // Invariant: a bare `@`-slice can never contain whitespace —
    // `findActiveAtQuery`'s bare branch rejects any query matching
    // `WHITESPACE_RE`, and `findAtTokens`' bare form stops at the first
    // whitespace char. So when the descended path itself has a space (or the
    // slice we're rewriting was already quoted), we must emit the QUOTED
    // in-progress form — an opening quote with NO closing quote — so the
    // rewritten text still round-trips through `findActiveAtQuery`'s quoted
    // branch (which tolerates any char but `"`/newline) and the popover
    // keeps narrowing into the directory instead of the slice going dead
    // mid-path. The commit path (Enter/click) is unaffected: `commit` calls
    // `formatAtToken(entry.path) + " "`, which replaces this whole slice —
    // including any opening quote left dangling here — with a freshly built,
    // properly closed token.
    const token = (slice.quoted || /\s/.test(descended)) ? `@"${descended}` : `@${descended}`;
    const next = before + token + after;
    onChange(next);
    const newCaret = before.length + token.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      landCaret(el, newCaret, next);
      setCaret(newCaret);
    });
  };

  // Hook key handling into the textarea via a one-time effect — same pattern
  // as SlashAutocomplete.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!open || rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + rows.length) % rows.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = rows[active];
        if (entry) commit(entry);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const entry = rows[active];
        if (!entry) return;
        if (entry.isDirectory) descend(entry);
        else commit(entry);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (slice) setDismissedSlice(slice);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
    // `commit`/`descend` close over the current value/slice; rebinding on
    // those changes keeps the closure fresh without holding a stale snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, active, value, slice?.start, slice?.end]);

  if (!open) return null;

  return (
    <div
      data-popover-open=""
      // Same "escape only" contract as SlashAutocomplete — this popover
      // doesn't want to swallow document-level shortcuts like RunPanel's
      // Cmd/Ctrl+F.
      data-popover-keys="escape-only"
      data-testid="at-file-autocomplete"
      className={cn(
        "absolute left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-md border border-border/60 bg-card text-card-foreground shadow-lg",
        placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      <ul ref={listRef} className="py-1">
        {rows.map((entry, i) => {
          const Icon = iconForRef(entry);
          const match = slice ? fuzzyPathMatch(slice.query, entry.path) : null;
          return (
            <li key={entry.path} data-testid="at-file-autocomplete-row" data-idx={i} data-path={entry.path}>
              <button
                type="button"
                // `onMouseDown` instead of `onClick` so the textarea doesn't
                // lose focus before the insertion runs.
                onMouseDown={(e) => { e.preventDefault(); commit(entry); }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px]",
                  i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                )}
              >
                <Icon className="size-3 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {renderMatchedPath(entry.path, match?.indices)}
                </span>
              </button>
            </li>
          );
        })}
        {truncated && (
          remoteRowsForCurrentQuery !== null ? (
            <li className="px-3 py-1.5 text-[10px] text-muted-foreground/70">
              Large repo — matches searched server-side over the full listing
            </li>
          ) : (
            <li className="px-3 py-1.5 text-[10px] text-muted-foreground">
              Showing the first {MAX_PROJECT_FILES.toLocaleString()} files — keep typing to narrow
            </li>
          )
        )}
      </ul>
    </div>
  );
}

/** Renders `path` with the characters at `indices` (from `fuzzyPathMatch`)
 *  emphasized — groups consecutive matched/unmatched runs so the DOM stays
 *  small instead of one `<span>` per character. `undefined`/empty indices
 *  (a blank query, or no match) renders the plain string. */
function renderMatchedPath(path: string, indices: number[] | undefined) {
  if (!indices || indices.length === 0) return path;
  const matchSet = new Set(indices);
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < path.length) {
    const isMatch = matchSet.has(i);
    let j = i + 1;
    while (j < path.length && matchSet.has(j) === isMatch) j++;
    const chunk = path.slice(i, j);
    nodes.push(isMatch ? <span key={i} className="font-semibold text-foreground">{chunk}</span> : chunk);
    i = j;
  }
  return nodes;
}
