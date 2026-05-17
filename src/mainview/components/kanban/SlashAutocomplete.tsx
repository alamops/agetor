import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Terminal } from "lucide-react";
import type { AvailableCommand } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  /** Available `/…` entries to suggest. Empty list disables the popover. */
  commands: AvailableCommand[];
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
 * the caret is in a `/<query>` slice, filters by fuzzy substring match, and
 * inserts the selected command back into the textarea on Enter / Tab / click.
 *
 * Designed to live next to the textarea — it doesn't render the textarea
 * itself, so the form keeps full control over styling, placeholder, etc.
 */
export function SlashAutocomplete({ commands, value, onChange, textareaRef, placement = "below" }: Props) {
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
  const open = slice !== null && commands.length > 0;

  const filtered = useMemo(() => {
    if (!slice) return [];
    const q = slice.query.toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = (c.name.slice(1) + " " + c.description).toLowerCase();
      return hay.includes(q);
    });
  }, [commands, slice]);

  // Reset highlight when the filtered list changes (avoid a stale index that
  // points past the new list's length).
  useEffect(() => { setActive(0); }, [slice?.query, filtered.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[active] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const insert = (cmd: AvailableCommand) => {
    if (!slice) return;
    const before = value.slice(0, slice.start);
    const after = value.slice(slice.end);
    // Trailing space so the user can immediately type arguments after `/cmd`.
    const next = before + cmd.name + " " + after;
    onChange(next);
    // Restore caret right after the inserted command + space.
    const newCaret = before.length + cmd.name.length + 1;
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
        // Closing the popover means moving the caret out of the slice; the
        // simplest way is to clear the slice tracking by faking caret = end.
        const end = el.value.length;
        el.setSelectionRange(end, end);
        setCaret(end);
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
      className={cn(
        "absolute left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-md border border-border/60 bg-card text-card-foreground shadow-lg",
        // The textarea sits inside a `relative` wrapper provided by the
        // form. Anchor below (default) or above based on where the field
        // lives in the panel — a send field pinned to the bottom needs
        // "above" or the popover renders off-screen.
        placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      <ul ref={listRef} className="py-1">
        {filtered.map((c, i) => (
          <li key={`${c.kind}:${c.name}`}>
            <button
              type="button"
              // `onMouseDown` instead of `onClick` so the textarea doesn't lose
              // focus before the insertion runs (the popover handles its own
              // focus internally).
              onMouseDown={(e) => { e.preventDefault(); insert(c); }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px]",
                i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
              )}
            >
              {c.kind === "skill" ? (
                <Sparkles className="mt-0.5 size-3 shrink-0 opacity-70" />
              ) : (
                <Terminal className="mt-0.5 size-3 shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono">{c.name}</span>
                  <span
                    className={cn(
                      "rounded px-1 py-px text-[10px] uppercase tracking-wide",
                      c.source === "project"
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {c.source}
                  </span>
                </span>
                {c.description && (
                  <span className="mt-0.5 block truncate text-muted-foreground">
                    {c.description}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
