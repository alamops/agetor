import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BookText, Sparkles, Terminal } from "lucide-react";
import type { AvailableCommand } from "@/lib/api";
import type { SavedPrompt } from "../../../shared/types.ts";
import { filterPromptsForSlash } from "@/lib/prompt-picker";
import { cn } from "@/lib/utils";

interface Props {
  /** Available `/…` entries to suggest. Empty list disables the popover. */
  commands: AvailableCommand[];
  /** User-global reusable prompt snippets, matched by name and shown as a
   *  distinct "Saved Prompts" group below the command/skill results. */
  savedPrompts?: SavedPrompt[];
  /** Current textarea value. */
  value: string;
  /** Setter for the textarea value. */
  onChange: (next: string) => void;
  /** The textarea this autocomplete is decorating. We attach key handlers here. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Which side of the textarea the popover floats on. Default "below"
   *  matches the New Task form (room beneath the field). Pass "above" for
   *  chat-style send fields pinned to the bottom of a panel — otherwise
   *  the popover renders off-screen and the user never sees it. */
  placement?: "above" | "below";
}

/** A row in the combined popover: a command/skill, or a saved prompt. */
type Row = { tag: "cmd"; cmd: AvailableCommand } | { tag: "prompt"; prompt: SavedPrompt };

/**
 * The slice of text we treat as the active query: everything from a `/` that
 * sits at the start of input or right after whitespace, up to the caret. Returns
 * null when the caret isn't inside such a slice (so the popover closes).
 *
 * Importantly, the trigger only matches `/` when preceded by whitespace or BOF
 * — `https://example.com/foo` shouldn't pop the menu open while the user is
 * pasting a URL.
 */
function findActiveQuery(text: string, caret: number): {
  start: number;
  end: number;
  query: string;
} | null {
  if (caret === 0) return null;
  // Walk back from the caret to find the most recent `/` (stopping at any
  // whitespace, which would invalidate the trigger).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "/") {
      const before = i === 0 ? "" : text[i - 1]!;
      if (i !== 0 && !/\s/.test(before)) return null;
      // Query text is everything after `/` up to the caret. Reject if it
      // contains whitespace (the user typed past the command name).
      const query = text.slice(i + 1, caret);
      if (/\s/.test(query)) return null;
      return { start: i, end: caret, query };
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/**
 * Lightweight slash-command picker for the new-task prompt textarea. Opens when
 * the caret is in a `/<query>` slice, filters commands/skills by substring
 * match and saved prompts by name, and inserts the selection back into the
 * textarea on Enter / Tab / click — command names insert as-is, saved
 * prompts insert their content.
 *
 * Designed to live next to the textarea — it doesn't render the textarea
 * itself, so the form keeps full control over styling, placeholder, etc.
 */
export function SlashAutocomplete({ commands, savedPrompts, value, onChange, textareaRef, placement = "below" }: Props) {
  const [caret, setCaret] = useState<number>(0);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the caret state in sync without forcing the parent to manage it.
  // We poll on the events that move the caret; the textarea owns the truth.
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

  const slice = useMemo(() => findActiveQuery(value, caret), [value, caret]);

  // Escape dismisses the popover WITHOUT moving the caret — see the Escape
  // branch below for why forcing the caret to the end of the textarea was
  // buggy. Instead we record the query slice that was active when Escape
  // fired; `open`'s derivation treats an unchanged, identical slice as
  // dismissed. Any edit that produces a different slice (more typing, an
  // arrow-key or click caret move) naturally stops matching, which is what
  // lets the popover reopen — the effect below then clears the stale
  // dismissal so it can't reappear if the caret/text round-trips back to the
  // same slice later.
  const [dismissedSlice, setDismissedSlice] = useState<{ start: number; end: number; query: string } | null>(null);
  useEffect(() => {
    if (!dismissedSlice) return;
    if (!slice || slice.start !== dismissedSlice.start || slice.end !== dismissedSlice.end || slice.query !== dismissedSlice.query) {
      setDismissedSlice(null);
    }
  }, [slice, dismissedSlice]);

  const isDismissed = !!(dismissedSlice && slice
    && slice.start === dismissedSlice.start && slice.end === dismissedSlice.end && slice.query === dismissedSlice.query);
  const open = slice !== null && !isDismissed && (commands.length > 0 || (savedPrompts?.length ?? 0) > 0);

  // Commands first, saved prompts second — the render groups them under a
  // "Saved Prompts" label so the combined list stays visually distinct while
  // ↑/↓/Enter treat it as one flat sequence.
  const filtered = useMemo<Row[]>(() => {
    if (!slice) return [];
    const q = slice.query.toLowerCase();
    const cmdRows: Row[] = (q ? commands.filter((c) => {
      const hay = (c.name.slice(1) + " " + c.description).toLowerCase();
      return hay.includes(q);
    }) : commands).map((cmd) => ({ tag: "cmd", cmd }));
    const promptRows: Row[] = filterPromptsForSlash(savedPrompts ?? [], slice.query).map((prompt) => ({ tag: "prompt", prompt }));
    return [...cmdRows, ...promptRows];
  }, [commands, savedPrompts, slice]);

  const listboxId = useId();

  // ARIA combobox wiring (WAI-ARIA 1.2 pattern for an input with a popup
  // listbox), applied imperatively through the ref because this component
  // decorates a textarea it doesn't render. The `/` and `@` autocompletes
  // share one textarea and are never open at once (different trigger
  // guards), so each manages the dynamic trio (expanded/controls/
  // activedescendant) only while it owns the popup — the `aria-controls`
  // ownership check keeps a closing popover from clobbering the other's
  // state. `aria-autocomplete`/`aria-haspopup` are static and identical
  // from both, so setting them unconditionally is idempotent.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Claim the popup only once one is actually possible — see the same
    // guard in AtFileAutocomplete (set-once, never removed).
    if (commands.length > 0 || (savedPrompts?.length ?? 0) > 0) {
      el.setAttribute("aria-autocomplete", "list");
      el.setAttribute("aria-haspopup", "listbox");
    }
    const owns = () => el.getAttribute("aria-controls") === listboxId;
    if (open && filtered.length > 0) {
      el.setAttribute("aria-expanded", "true");
      el.setAttribute("aria-controls", listboxId);
      el.setAttribute("aria-activedescendant", `${listboxId}-opt-${active}`);
    } else if (owns()) {
      el.setAttribute("aria-expanded", "false");
      el.removeAttribute("aria-controls");
      el.removeAttribute("aria-activedescendant");
    }
    // Deliberately NO cleanup removal: React runs cleanup before the next
    // body, so removing here would strip the attributes right before the
    // closed-state branch checks `owns()` — leaving `aria-expanded` absent
    // instead of "false". The body's ownership gate is what prevents the two
    // popovers from clobbering each other; the one cost is a dangling
    // `aria-expanded="true"` if this popover unmounts while open (a scope
    // flipping to null mid-query — rare, and the textarea usually unmounts
    // with it).
  }, [open, filtered.length, active, listboxId, textareaRef, commands.length, savedPrompts?.length]);

  // Reset highlight when the filtered list changes — keyed on the ARRAY
  // ITSELF, not its length, so a same-length content swap (a focus-refetch
  // reordering commands under an unchanged query) can't leave `active`
  // pointing at a different row than the highlighted one. Mirrors
  // AtFileAutocomplete's reset.
  useEffect(() => { setActive(0); }, [slice?.query, filtered]);

  // Keep the highlighted row scrolled into view. `data-idx` (not positional
  // children) since the "Saved Prompts" group label is itself a list child.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const insert = (row: Row) => {
    if (!slice) return;
    const before = value.slice(0, slice.start);
    const after = value.slice(slice.end);
    const text = row.tag === "cmd" ? row.cmd.name : row.prompt.content;
    // Trailing space so the user can immediately type arguments / keep typing.
    const next = before + text + " " + after;
    onChange(next);
    // Restore caret right after the inserted text + space.
    const newCaret = before.length + text.length + 1;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  };

  // Hook key handling into the textarea via a one-time effect — saves callers
  // from having to plumb onKeyDown into their existing handlers.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!open || filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const choice = filtered[active];
        if (choice) insert(choice);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Dismiss unconditionally. We used to move the caret to the very end
        // of the textarea's value to fall out of the active slice — a no-op
        // (and therefore a popover stuck open) whenever the slice already
        // sat at the end, e.g. right after inserting one command and typing
        // another with nothing after it. Recording the slice here and
        // consulting it in `open`'s derivation above closes the popover
        // regardless of caret position.
        if (slice) setDismissedSlice(slice);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
    // `insert` depends on the current value/slice; rebinding on those changes
    // keeps the closure fresh without holding a stale snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, active, value, slice?.start, slice?.end]);

  if (!open || filtered.length === 0) return null;

  return (
    <div
      data-popover-open=""
      // This popover only cares about Escape (to dismiss itself first, ahead
      // of an enclosing Dialog) — it doesn't want to swallow other
      // document-level shortcuts like RunPanel's Cmd/Ctrl+F. See the
      // `:not([data-popover-keys="escape-only"])` clause on that handler.
      data-popover-keys="escape-only"
      data-testid="slash-autocomplete"
      className={cn(
        "absolute left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-md border border-border/60 bg-card text-card-foreground shadow-lg",
        // The textarea sits inside a `relative` wrapper provided by the
        // form. Anchor below (default) or above based on where the field
        // lives in the panel — a send field pinned to the bottom needs
        // "above" or the popover renders off-screen.
        placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      <ul ref={listRef} role="listbox" id={listboxId} aria-label="Command and prompt suggestions" className="py-1">
        {filtered.map((row, i) => {
          // Group label right before the first prompt row — commands (if any)
          // always come first, so this fires at most once.
          const showPromptLabel = row.tag === "prompt" && filtered[i - 1]?.tag !== "prompt";
          return (
          <li
            role="presentation"
            data-testid="slash-autocomplete-row"
            key={row.tag === "cmd" ? `${row.cmd.kind}:${row.cmd.name}` : `prompt:${row.prompt.id}`}
          >
            {showPromptLabel && (
              <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <BookText className="size-3 opacity-70" />
                Saved Prompts
              </div>
            )}
            <button
              type="button"
              role="option"
              id={`${listboxId}-opt-${i}`}
              aria-selected={i === active}
              tabIndex={-1}
              data-idx={i}
              // `onMouseDown` instead of `onClick` so the textarea doesn't lose
              // focus before the insertion runs (the popover handles its own
              // focus internally).
              onMouseDown={(e) => { e.preventDefault(); insert(row); }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px]",
                i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
              )}
            >
              {row.tag === "cmd" ? (
                <>
                  {row.cmd.kind === "skill" ? (
                    <Sparkles className="mt-0.5 size-3 shrink-0 opacity-70" />
                  ) : (
                    <Terminal className="mt-0.5 size-3 shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono">{row.cmd.name}</span>
                      <span
                        className={cn(
                          "rounded px-1 py-px text-[10px] uppercase tracking-wide",
                          row.cmd.source === "project"
                            ? "bg-primary/20 text-primary"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {row.cmd.source}
                      </span>
                    </span>
                    {row.cmd.description && (
                      <span className="mt-0.5 block truncate text-muted-foreground">
                        {row.cmd.description}
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <BookText className="mt-0.5 size-3 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{row.prompt.name}</span>
                    <span className="mt-0.5 block truncate text-muted-foreground">
                      {row.prompt.content}
                    </span>
                  </span>
                </>
              )}
            </button>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
