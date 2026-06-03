import { useEffect, useMemo, useRef, useState } from "react";
import { Blocks, ChevronDown, Plug, Puzzle, Sparkles } from "lucide-react";
import type { AvailableExtension } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  /** Available MCP / skill / plugin entries. Empty disables selection but the
   *  trigger still renders (with an empty-state hint inside the popover). */
  extensions: AvailableExtension[];
  /** Current textarea value. */
  value: string;
  /** Setter for the textarea value. */
  onChange: (next: string) => void;
  /** The textarea this picker inserts into — we read/restore the caret here. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Which side the popover floats on. "below" (New Task form, room beneath)
   *  or "above" (chat-style send field pinned to the panel bottom). */
  placement?: "above" | "below";
  /** Horizontal edge the popover aligns to. "left" (default) anchors the
   *  popover's left to the trigger; "right" anchors its right — use that when
   *  the trigger sits near a container's right edge (e.g. the right-aligned
   *  label row in the New Task sidebar) so the popover stays on-screen. */
  align?: "left" | "right";
  /** Disables the trigger (e.g. before a workdir is picked / no live session). */
  disabled?: boolean;
}

const KINDS = [
  { kind: "mcp", label: "MCP Servers", Icon: Plug },
  { kind: "skill", label: "Skills", Icon: Sparkles },
  { kind: "plugin", label: "Plugins", Icon: Puzzle },
] as const;

/**
 * "Extensions" picker that sits above the prompt / message textarea. A single
 * button opens a searchable, grouped popover of the MCP servers, skills, and
 * plugins reachable for the current agent + workdir. Selecting one inserts its
 * `insert` token (`/skill` or `@mcp` / `@plugin`) at the caret.
 *
 * Complements — doesn't replace — the `/` SlashAutocomplete: that one is a
 * typeahead for slash-invokable commands; this is an always-available browse
 * affordance that also covers MCP servers and plugins, which aren't typeable.
 */
export function ExtensionPicker({
  extensions,
  value,
  onChange,
  textareaRef,
  placement = "below",
  align = "left",
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search box when the popover opens; reset the query when it closes.
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setQuery("");
  }, [open]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: AvailableExtension) =>
      !q || (e.name + " " + e.description).toLowerCase().includes(q);
    return KINDS.map(({ kind, label, Icon }) => ({
      kind,
      label,
      Icon,
      items: extensions.filter((e) => e.kind === kind && match(e)),
    })).filter((g) => g.items.length > 0);
  }, [extensions, query]);

  // Flattened, display-order list so ↑/↓ can move a single highlight across
  // group boundaries; the render derives each row's global index from this.
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // Reset the highlight whenever the filtered list changes so it never points
  // past the end.
  useEffect(() => { setActive(0); }, [query, flat.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const insert = (ext: AvailableExtension) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    // Pad with a leading space when the caret isn't already at a boundary, and
    // a trailing space so the user keeps typing after the token.
    const needLead = before.length > 0 && !/\s$/.test(before);
    const piece = (needLead ? " " : "") + ext.insert + " ";
    const next = before + piece + after;
    onChange(next);
    const newCaret = before.length + piece.length;
    setOpen(false);
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(newCaret, newCaret);
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Insert an MCP server, skill, or plugin reference"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/40 px-2 py-1 text-[11px] text-muted-foreground",
          "hover:bg-accent/40 hover:text-foreground disabled:opacity-50 disabled:hover:bg-card/40 disabled:hover:text-muted-foreground",
          open && "bg-accent/40 text-foreground",
        )}
      >
        <Blocks className="size-3" />
        <span>MCP · Skills · Plugins</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-30 w-72 max-w-[90vw] overflow-hidden rounded-md border border-border/60 bg-card text-card-foreground shadow-lg",
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="border-b border-border/60 p-1.5">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (flat.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => (i + 1) % flat.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => (i - 1 + flat.length) % flat.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const choice = flat[active];
                  if (choice) insert(choice);
                }
              }}
              placeholder="Search extensions…"
              className="w-full rounded bg-muted/40 px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
            {grouped.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                {extensions.length === 0
                  ? "No MCP servers, skills, or plugins found for this project."
                  : "No matches."}
              </p>
            ) : (
              grouped.map((g, gi) => {
                // Global index of this group's first item in the flat list, so
                // the ↑/↓ highlight lines up with keyboard navigation.
                const base = grouped.slice(0, gi).reduce((n, x) => n + x.items.length, 0);
                return (
                <div key={g.kind}>
                  <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <g.Icon className="size-3 opacity-70" />
                    {g.label}
                  </div>
                  <ul>
                    {g.items.map((e, i) => {
                      const idx = base + i;
                      return (
                      <li key={`${e.kind}:${e.name}`}>
                        <button
                          type="button"
                          data-idx={idx}
                          // mousedown so the textarea doesn't blur before insert.
                          onMouseDown={(ev) => { ev.preventDefault(); insert(e); }}
                          onMouseEnter={() => setActive(idx)}
                          className={cn(
                            "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px]",
                            idx === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="font-mono">{e.insert}</span>
                              <span
                                className={cn(
                                  "rounded px-1 py-px text-[10px] uppercase tracking-wide",
                                  e.source === "project"
                                    ? "bg-primary/20 text-primary"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {e.source}
                              </span>
                            </span>
                            {e.description && (
                              <span className="mt-0.5 block truncate text-muted-foreground">
                                {e.description}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
