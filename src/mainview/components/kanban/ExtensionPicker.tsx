import { useEffect, useMemo, useRef, useState } from "react";
import { Blocks, BookText, ChevronDown, Plug, Puzzle, Sparkles } from "lucide-react";
import type { AvailableExtension } from "@/lib/api";
import type { SavedPrompt } from "../../../shared/types.ts";
import { filterPromptsForPicker } from "@/lib/prompt-picker";
import { cn } from "@/lib/utils";

interface Props {
  /** Available MCP / skill / plugin entries. Empty disables selection but the
   *  trigger still renders (with an empty-state hint inside the popover). */
  extensions: AvailableExtension[];
  /** User-global reusable prompt snippets, rendered as a fourth "Saved
   *  Prompts" group below MCP/skills/plugins. Omitted/empty just hides the
   *  group — the trigger and the other groups are unaffected. */
  savedPrompts?: SavedPrompt[];
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
  /** Fired when the popover opens — lets a caller refetch `savedPrompts` so
   *  edits made in Settings mid-session show up without a remount. */
  onPromptsOpen?: () => void;
}

const KINDS = [
  { kind: "mcp", label: "MCP Servers", Icon: Plug },
  { kind: "skill", label: "Skills", Icon: Sparkles },
  { kind: "plugin", label: "Plugins", Icon: Puzzle },
] as const;

/** A group row is either an MCP/skill/plugin entry or a saved prompt — the
 *  tag lets the flattened keyboard-nav list and the row renderer dispatch
 *  without conflating the two shapes. */
type Row = { tag: "ext"; ext: AvailableExtension } | { tag: "prompt"; prompt: SavedPrompt };

/**
 * "Extensions" picker that sits above the prompt / message textarea. A single
 * button opens a searchable, grouped popover of the MCP servers, skills,
 * plugins, and saved prompts reachable for the current agent + workdir.
 * Selecting an MCP/skill/plugin inserts its `insert` token (`/skill` or
 * `@mcp` / `@plugin`); selecting a saved prompt inserts its content.
 *
 * Complements — doesn't replace — the `/` SlashAutocomplete: that one is a
 * typeahead for slash-invokable commands; this is an always-available browse
 * affordance that also covers MCP servers and plugins, which aren't typeable.
 */
export function ExtensionPicker({
  extensions,
  savedPrompts,
  value,
  onChange,
  textareaRef,
  placement = "below",
  align = "left",
  disabled,
  onPromptsOpen,
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Consume Escape (while the popover is open — this effect only runs
      // then) before it reaches Dialog's document listener, which registered
      // earlier and would otherwise run first and close the whole dialog
      // instead of just this popover. See the data-popover-open convention
      // in dialog.tsx.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search box when the popover opens (and let the caller refetch
  // saved prompts so mid-session Settings edits show up); reset the query
  // when it closes.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
      onPromptsOpen?.();
    } else {
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: AvailableExtension) =>
      !q || (e.name + " " + e.description).toLowerCase().includes(q);
    const extGroups = KINDS.map(({ kind, label, Icon }) => ({
      key: kind as string,
      label,
      Icon,
      rows: extensions.filter((e) => e.kind === kind && match(e)).map((ext): Row => ({ tag: "ext", ext })),
    }));
    const promptRows = filterPromptsForPicker(savedPrompts ?? [], query).map((prompt): Row => ({ tag: "prompt", prompt }));
    // Saved Prompts always renders last, after mcp/skill/plugin.
    return [...extGroups, { key: "prompt", label: "Saved Prompts", Icon: BookText, rows: promptRows }]
      .filter((g) => g.rows.length > 0);
  }, [extensions, savedPrompts, query]);

  // Flattened, display-order list so ↑/↓ can move a single highlight across
  // group boundaries; the render derives each row's global index from this.
  const flat = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);

  // Reset the highlight whenever the filtered list changes so it never points
  // past the end.
  useEffect(() => { setActive(0); }, [query, flat.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Splice `text` into the textarea at the caret — shared by both `ext.insert`
  // tokens and saved-prompt content so the two selection paths never diverge.
  const insertText = (text: string) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    // Pad with a leading space when the caret isn't already at a boundary, and
    // a trailing space so the user keeps typing after the token.
    const needLead = before.length > 0 && !/\s$/.test(before);
    const piece = (needLead ? " " : "") + text + " ";
    const next = before + piece + after;
    onChange(next);
    const newCaret = before.length + piece.length;
    setOpen(false);
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      // Set the caret BEFORE focusing — SlashAutocomplete syncs its tracked
      // caret on the native `focus` event, so focusing first would make it
      // read the stale pre-insert offset (which can land inside a `/token`,
      // pop the slash menu, and swallow the next Enter via preventDefault).
      t.setSelectionRange(newCaret, newCaret);
      t.focus();
    });
  };

  const insert = (row: Row) => insertText(row.tag === "ext" ? row.ext.insert : row.prompt.content);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="extension-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Insert an MCP server, skill, plugin reference, or saved prompt"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/40 px-2 py-1 text-[11px] text-muted-foreground",
          "hover:bg-accent/40 hover:text-foreground disabled:opacity-50 disabled:hover:bg-card/40 disabled:hover:text-muted-foreground",
          open && "bg-accent/40 text-foreground",
        )}
      >
        <Blocks className="size-3" />
        <span>MCP · Skills · Plugins · Prompts</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          data-popover-open=""
          data-testid="extension-picker-popover"
          className={cn(
            "absolute z-30 w-72 max-w-[90vw] overflow-hidden rounded-md border border-border/60 bg-card text-card-foreground shadow-lg",
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="border-b border-border/60 p-1.5">
            <input
              ref={searchRef}
              data-testid="extension-picker-search"
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
              placeholder="Search…"
              className="w-full rounded bg-muted/40 px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
            {grouped.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                {extensions.length === 0 && (savedPrompts?.length ?? 0) === 0
                  ? "No MCP servers, skills, or plugins found for this project, and no saved prompts."
                  : "No matches."}
              </p>
            ) : (
              grouped.map((g, gi) => {
                // Global index of this group's first item in the flat list, so
                // the ↑/↓ highlight lines up with keyboard navigation.
                const base = grouped.slice(0, gi).reduce((n, x) => n + x.rows.length, 0);
                return (
                <div key={g.key}>
                  <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <g.Icon className="size-3 opacity-70" />
                    {g.label}
                  </div>
                  <ul>
                    {g.rows.map((row, i) => {
                      const idx = base + i;
                      return (
                      <li key={row.tag === "ext" ? `${row.ext.kind}:${row.ext.name}` : `prompt:${row.prompt.id}`}>
                        <button
                          type="button"
                          data-idx={idx}
                          data-testid="extension-picker-row"
                          // mousedown so the textarea doesn't blur before insert.
                          onMouseDown={(ev) => { ev.preventDefault(); insert(row); }}
                          onMouseEnter={() => setActive(idx)}
                          className={cn(
                            "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px]",
                            idx === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                          )}
                        >
                          {row.tag === "ext" ? (
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="font-mono">{row.ext.insert}</span>
                                <span
                                  className={cn(
                                    "rounded px-1 py-px text-[10px] uppercase tracking-wide",
                                    row.ext.source === "project"
                                      ? "bg-primary/20 text-primary"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {row.ext.source}
                                </span>
                              </span>
                              {row.ext.description && (
                                <span className="mt-0.5 block truncate text-muted-foreground">
                                  {row.ext.description}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="min-w-0 flex-1">
                              <span className="font-medium">{row.prompt.name}</span>
                              <span className="mt-0.5 block truncate text-muted-foreground">
                                {row.prompt.content}
                              </span>
                            </span>
                          )}
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
