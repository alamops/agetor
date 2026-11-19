import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { isTypeAheadKey, navigate, typeAhead } from "@/lib/listbox-nav";
import { placePopover, type PopoverPlacement } from "@/lib/popover-position";

export interface PickerItem {
  value: string;
  label: string;
  /** Secondary text under the label. */
  hint?: string;
  disabled?: boolean;
  /** Rows sharing a `group` render under one small header, in list order. */
  group?: string;
  /** Native tooltip on the row. */
  title?: string;
  /** Extra text the search box matches (not displayed). */
  searchText?: string;
  /** Overrides the row's test id (default `${parts}-option`) — for a caller
   *  whose rows were already pinned by an older id (`…-row`, `…-none`). */
  testId?: string;
  /** Extra `data-*` attributes on the row (e.g. `{ "data-profile-id": id }`). */
  dataAttrs?: Record<string, string>;
}

export interface PickerProps {
  value: string | null;
  onChange: (value: string) => void;
  items: PickerItem[];
  /** Custom row content; the option's accessible name stays the item's label. */
  renderItem?: (item: PickerItem, state: { selected: boolean; active: boolean }) => React.ReactNode;
  /** Custom trigger content for the current selection. */
  renderValue?: (item: PickerItem | undefined) => React.ReactNode;
  /** Show a search box that filters rows (label, value, hint). */
  searchable?: boolean;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Text under the list when no row matches. */
  emptyLabel?: string;
  /** Content after the last row, inside the listbox (e.g. "No agents yet." when
   *  the only row is the "none" choice). Not selectable. */
  trailing?: React.ReactNode;
  /** A row under the list (e.g. "Manage agents…"), rendered inside the
   *  popover. A function receives `close` so the row can dismiss the popover. */
  footer?: React.ReactNode | ((close: () => void) => React.ReactNode);
  disabled?: boolean;
  /** `id` of the trigger, for `<label htmlFor>`. */
  id?: string;
  /** Root test id. The trigger is `${parts}-trigger`, the popover `-popover`,
   *  the search box `-search` and each row `-option` (with `data-value`), where
   *  `parts` is `partsTestId` when given, else `testId`. */
  testId?: string;
  /** Prefix for the derived part ids, when the root's own id belongs to a
   *  wrapper that also holds sibling controls (e.g. a clear button). */
  partsTestId?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
  /** `id` of the visible label element. The trigger is named by that label AND
   *  its own content ("Harness Claude Code"), the listbox by the label alone. */
  labelId?: string;
  /** `popover` floats over the page (portaled to `document.body`); `inline`
   *  renders the panel in flow under the trigger, for a container that would
   *  clip a floating panel. */
  placement?: "popover" | "inline";
  /** Which side the popover prefers when both fit. */
  prefer?: "above" | "below";
  className?: string;
  triggerClassName?: string;
  /** Left-side icon on the trigger. */
  leadingIcon?: React.ReactNode;
  /** Native tooltip on the trigger. */
  title?: string;
  /** Tone of the trigger border: `danger` for an error state. */
  tone?: "default" | "danger";
}

const MAX_LIST_HEIGHT = 288;

/**
 * The launch surfaces' one picker (docs/architecture/task-launch-ui.md):
 * a trigger `<button>` that opens a listbox with arrow-key navigation, an
 * optional search box, type-ahead, a row render prop and a footer slot.
 *
 * Popover contract (docs/architecture/prompt-composer.md): `data-popover-open`
 * sits on the ROOT element (the trigger's subtree, so a surrounding `Dialog`
 * sees it) and only while the popover is open, never on the portaled panel.
 * While focus is inside the panel the picker handles Escape and Tab itself
 * with `preventDefault` — React's listener on the portal container runs before
 * `Dialog`'s document listener, which returns early on `defaultPrevented`.
 *
 * Every trigger is a native `<button>`, so a `<fieldset disabled>` ancestor
 * (Clone's busy state) disables it.
 */
export function Picker({
  value,
  onChange,
  items,
  renderItem,
  renderValue,
  searchable = false,
  placeholder = "Select…",
  emptyLabel = "No matches",
  footer,
  trailing,
  disabled,
  id,
  testId,
  partsTestId,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-label": ariaLabel,
  labelId,
  placement = "popover",
  prefer = "below",
  className,
  triggerClassName,
  leadingIcon,
  title,
  tone = "default",
}: PickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(-1);
  const [place, setPlace] = React.useState<PopoverPlacement | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const typeBuffer = React.useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const parts = partsTestId ?? testId;
  const reactId = React.useId();
  const triggerId = id ?? `${reactId}-trigger`;
  const listboxId = `${reactId}-listbox`;
  const optionId = (i: number) => `${reactId}-opt-${i}`;

  const filtered = React.useMemo(() => {
    if (!searchable) return items;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.value.toLowerCase().includes(q) ||
        (i.hint?.toLowerCase().includes(q) ?? false) ||
        (i.searchText?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query, searchable]);

  const selected = items.find((i) => i.value === value);

  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setPlace(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openPanel = () => {
    if (disabled) return;
    const idx = filtered.findIndex((i) => i.value === value && !i.disabled);
    setActive(idx >= 0 ? idx : navigate(filtered, -1, "Home") ?? -1);
    setOpen(true);
  };

  // Position the floating panel once it has rendered (so its height is known),
  // and re-clamp on the next frame after the list changes size.
  React.useLayoutEffect(() => {
    if (!open || placement !== "popover") return;
    const trig = triggerRef.current;
    const panel = panelRef.current;
    if (!trig || !panel) return;
    const r = trig.getBoundingClientRect();
    setPlace(
      placePopover({
        trigger: { top: r.top, left: r.left, width: r.width, height: r.height },
        popoverHeight: panel.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        prefer,
      }),
    );
  }, [open, placement, prefer, filtered.length, query]);

  // Focus the search box (or the listbox) when the panel opens.
  React.useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (placement === "inline") panelRef.current?.scrollIntoView({ block: "nearest" });
      // Never let focusing the panel scroll the page: a scroll would close it
      // (the outside-scroll rule below) the moment it opened.
      if (searchable) searchRef.current?.focus({ preventScroll: true });
      else listRef.current?.focus({ preventScroll: true });
    });
  }, [open, searchable, placement]);

  // Close on an outside mousedown, an outside scroll, or a resize.
  React.useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      !!(t instanceof Node) && (rootRef.current?.contains(t) || panelRef.current?.contains(t));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close(false);
    };
    const openedAt = Date.now();
    const onScroll = (e: Event) => {
      if (placement !== "popover") return;
      // Only a scroll of something that CONTAINS the trigger moves the trigger
      // out from under a fixed popover; ignore scrolls inside the popover, and
      // the settling scrolls of the first instants after opening.
      if (Date.now() - openedAt < 150) return;
      const t = e.target;
      const scrolledAncestor = t === document || (t instanceof Node && t.contains(triggerRef.current));
      if (scrolledAncestor && !inside(t)) close(false);
    };
    const onResize = () => {
      if (placement === "popover") close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, placement, close]);

  // Keep the active row scrolled into view.
  React.useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // Clamp the active row when the filter shrinks the list.
  React.useEffect(() => {
    if (!open) return;
    setActive((a) => (a >= filtered.length ? navigate(filtered, -1, "Home") ?? -1 : a));
  }, [filtered, open]);

  const choose = (i: number) => {
    const item = filtered[i];
    if (!item || item.disabled) return;
    onChange(item.value);
    close(true);
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) choose(active);
      return;
    }
    // Home/End belong to the caret while a search box has focus.
    if ((e.key === "Home" || e.key === "End") && searchable) return;
    const next = navigate(filtered, active, e.key);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (!searchable && isTypeAheadKey(e)) {
      const now = Date.now();
      const buf = typeBuffer.current;
      buf.text = now - buf.at > 700 ? e.key : buf.text + e.key;
      buf.at = now;
      const hit = typeAhead(filtered, active, buf.text);
      if (hit >= 0) setActive(hit);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      openPanel();
    }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const panel = open ? (
    <div
      ref={panelRef}
      data-testid={parts ? `${parts}-popover` : undefined}
      onKeyDown={onPanelKeyDown}
      // Click, context-menu and drag events must not bubble through the React
      // tree: a drag over the panel would otherwise arm the New Task aside's
      // drop zone, and a click would reach a wrapper's handlers. Keydown and
      // mousedown are NOT stopped: Dialog's Escape/Tab, the font-size shortcut
      // and outside-click closing all need them.
      onClick={stop}
      onContextMenu={stop}
      onDragEnter={stop}
      onDragOver={stop}
      onDrop={stop}
      className={cn(
        "z-[60] flex flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-lg",
        placement === "popover" ? "fixed" : "relative mt-1",
      )}
      style={
        placement === "popover"
          ? place
            ? { top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }
            : { top: 0, left: 0, visibility: "hidden", width: triggerRef.current?.offsetWidth }
          : undefined
      }
    >
      {searchable && (
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search"}
            data-testid={parts ? `${parts}-search` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            {...IDENTIFIER_INPUT_PROPS}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        aria-label={labelId ? undefined : ariaLabel}
        aria-labelledby={labelId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        className="min-h-0 flex-1 overflow-y-auto p-1 outline-none"
        style={{ maxHeight: MAX_LIST_HEIGHT }}
      >
        {filtered.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
        ) : (
          filtered.map((item, i) => {
            const isSelected = item.value === value;
            const isActive = i === active;
            const showGroup = item.group !== undefined && item.group !== filtered[i - 1]?.group;
            return (
              <React.Fragment key={item.value}>
                {showGroup && (
                  <div role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                    {item.group}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={item.disabled || undefined}
                  aria-label={item.label}
                  title={item.title}
                  data-value={item.value}
                  data-testid={item.testId ?? (parts ? `${parts}-option` : undefined)}
                  {...item.dataAttrs}
                  onMouseMove={() => {
                    if (!item.disabled && active !== i) setActive(i);
                  }}
                  onClick={() => choose(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm",
                    isActive && "bg-accent text-accent-foreground",
                    item.disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {renderItem ? (
                      renderItem(item, { selected: isSelected, active: isActive })
                    ) : (
                      <>
                        <div className="truncate">{item.label}</div>
                        {item.hint && <div className="truncate text-2xs text-muted-foreground">{item.hint}</div>}
                      </>
                    )}
                  </div>
                  {isSelected && <Check aria-hidden className="size-3.5 shrink-0 text-primary" />}
                </div>
              </React.Fragment>
            );
          })
        )}
        {trailing ? <div className="px-2.5 py-2 text-xs text-muted-foreground">{trailing}</div> : null}
      </div>
      {footer && (
        <div className="shrink-0 border-t border-border p-1">
          {typeof footer === "function" ? footer(() => close(false)) : footer}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      // The marker lives on the ROOT, only while open (see the doc comment).
      data-popover-open={open ? "" : undefined}
      className={cn("relative", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        data-testid={parts ? `${parts}-trigger` : undefined}
        data-value={value ?? ""}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-label={labelId ? undefined : ariaLabel}
        aria-labelledby={labelId ? `${labelId} ${triggerId}` : undefined}
        onClick={() => (open ? close(true) : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 py-1 text-left text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          tone === "danger" || invalid ? "border-danger/60" : "border-input",
          triggerClassName,
        )}
      >
        {leadingIcon && <span className="shrink-0 text-muted-foreground">{leadingIcon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>
          {renderValue ? renderValue(selected) : (selected?.label ?? placeholder)}
        </span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {placement === "inline" ? panel : panel && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </div>
  );
}
