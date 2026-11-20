import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { placeContextMenu, placeSubmenu, moveMenuIndex } from "@/lib/context-menu";
import { cn } from "@/lib/utils";

export interface ContextMenuLeafItem {
  type?: "item";
  id: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** An item that opens a child panel of leaf items (hover, Enter or ArrowRight). */
export interface ContextMenuSubmenuItem {
  type: "submenu";
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  items: ContextMenuLeafItem[];
}

export type ContextMenuItem = ContextMenuLeafItem | ContextMenuSubmenuItem | { type: "separator"; id: string };

const ITEM_CLASS = (isActive: boolean, danger?: boolean, disabled?: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none transition-colors",
    "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
    isActive && "bg-accent text-accent-foreground",
    // `--danger`, not `--destructive`: the latter is 3.76:1 on the popover in
    // light mode and 1.77:1 in dark, `--danger` is 4.7:1 / 6.59:1.
    danger && "text-danger hover:text-danger focus-visible:text-danger",
    isActive && danger && "text-danger",
    disabled && "pointer-events-none opacity-50",
  );

export interface ContextMenuProps {
  open: boolean;
  /** Anchor position, viewport coordinates (typically the right-click's
   *  `clientX`/`clientY`, or a card rect's top-left for a keyboard-invoked
   *  open). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** aria-label on the `role="menu"` panel. */
  label?: string;
  /** Base for per-item `data-testid`s (`${testId}-${item.id}`) and the
   *  panel's own `data-testid`. Omit to render no test ids. */
  testId?: string;
}

/**
 * Generic controlled context menu: the caller (App.tsx) owns `open`/`x`/`y`/
 * `items` and reacts to `onClose` — this component holds no menu-content
 * state of its own, only positioning/focus/keyboard-nav mechanics. Modeled
 * on `ui/info-tip.tsx` and `ui/search-select.tsx`.
 *
 * Portaled to `document.body` and positioned with `position: fixed`: a
 * non-portaled `fixed` descendant breaks under the RunPanel `<aside>`'s
 * `translate-x` transform (a CSS transform on an ancestor turns `fixed`
 * into "fixed relative to that ancestor", not the viewport), so anything
 * meant to escape the panel's clipping — like a right-click on a card while
 * the panel happens to be open — has to leave the React tree via a portal.
 *
 * Carries `data-popover-open=""` on the panel: every enclosing Escape
 * handler (RunPanel's panel-close, the search/quote overlays) checks
 * `document.querySelector('[role="dialog"]...,[data-popover-open],...')`
 * and bails out when it matches, so this menu — not some ancestor — is the
 * thing that closes on the first Escape. Removing the marker would let an
 * Escape meant for this menu leak through and close the run panel instead.
 */
export function ContextMenu({ open, x, y, items, onClose, label = "Context menu", testId }: ContextMenuProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The open submenu (at most one), its panel position and its roving focus.
  const [sub, setSub] = useState<{ id: string } | null>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  const [subIndex, setSubIndex] = useState(-1);
  const subPanelRef = useRef<HTMLDivElement>(null);
  /** The anchor + item ids the open root menu was laid out for (null while closed). */
  const rootKeyRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Enabled-ness per item, in the same order as `items` — separators and
  // disabled items are never focus targets.
  const enabled = useMemo(
    () => items.map((it) => (it.type === "separator" ? false : !it.disabled)),
    [items],
  );
  const openSub = useMemo(
    () => items.find((it): it is ContextMenuSubmenuItem => it.type === "submenu" && it.id === sub?.id) ?? null,
    [items, sub],
  );
  const subEnabled = useMemo(() => (openSub ? openSub.items.map((it) => !it.disabled) : []), [openSub]);

  // Reset positioning + roving focus each time the menu (re)opens, so a
  // stale position/index from a previous open never flashes before the
  // layout effect below re-measures.
  useEffect(() => {
    if (!open) {
      setPos(null);
      setActiveIndex(-1);
      setSub(null);
      setSubPos(null);
      setSubIndex(-1);
    }
  }, [open]);

  // Place the submenu beside its parent item once it has rendered (measured
  // hidden at 0,0 first, like the root panel).
  useLayoutEffect(() => {
    if (!open || !sub) {
      setSubPos(null);
      return;
    }
    const panel = subPanelRef.current;
    const parent = panelRef.current?.querySelector<HTMLElement>(`[data-menu-id="${sub.id}"]`);
    if (!panel || !parent) return;
    const r = parent.getBoundingClientRect();
    setSubPos(
      placeSubmenu({
        anchor: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        width: panel.offsetWidth,
        height: panel.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [open, sub]);

  // Wait for the child panel's real position: until `subPos` is set it is
  // still `visibility: hidden`, which refuses focus, so focus would stay on
  // the parent and the next ArrowDown/Escape would act on the root menu.
  useEffect(() => {
    if (subIndex === -1 || !subPos) return;
    subPanelRef.current?.querySelector<HTMLElement>(`[data-sub-index="${subIndex}"]`)?.focus();
  }, [subIndex, subPos]);

  // Snapshot whatever had focus right before the menu opened, and restore it
  // once the menu closes OR is unmounted outright — the cleanup fires either
  // way, so a single effect (mirroring ui/dialog.tsx's trigger-focus effect)
  // covers both paths instead of needing a separate unmount handler.
  // `isConnected` guards the case where the trigger (e.g. a task card) was
  // itself removed from the DOM while the menu was open.
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    return () => {
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      rootKeyRef.current = null;
      return;
    }
    // A new anchor or item set while the menu stays open (a right-click on
    // another card closes and reopens it in one React batch, so `open` never
    // goes false) replaces the root menu: drop the old child so it can't
    // linger at the previous anchor. Compared by value, not array identity,
    // so an ordinary re-render of the same menu keeps its open child.
    const rootKey = `${x},${y}|${items.map((it) => (it.type === "separator" ? "-" : it.id)).join(",")}`;
    const replaced = rootKeyRef.current !== null && rootKeyRef.current !== rootKey;
    if (replaced) {
      setSub(null);
      setSubPos(null);
      setSubIndex(-1);
    }
    rootKeyRef.current = rootKey;
    const panel = panelRef.current;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    setPos(
      placeContextMenu({
        x,
        y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
    // Focus the first enabled item once the panel has a real position —
    // queued to the next microtask so it runs after this paint commits.
    queueMicrotask(() => {
      const first = moveMenuIndex(-1, 1, enabled);
      if (first === -1) return;
      setActiveIndex(first);
      // A replacement may leave `activeIndex` unchanged (the old menu's
      // first item was active too), so the effect below won't re-run; focus
      // directly, or focus stays on the removed child panel.
      if (replaced) panelRef.current?.querySelector<HTMLElement>(`[data-menu-index="${first}"]`)?.focus();
    });
    // `items` is frozen for the lifetime of one open (App hands a stable
    // array identity that only changes when the menu (re)opens), so this
    // only recomputes positioning + first-item focus on open/reopen, not on
    // every render.
  }, [open, x, y, items]);

  useEffect(() => {
    if (activeIndex === -1) return;
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-menu-index="${activeIndex}"]`);
    el?.focus();
  }, [activeIndex]);

  useEffect(() => {
    if (!open) return;

    const onMouseDown = (e: MouseEvent) => {
      // Right-button dismissal is deferred to the capture-phase contextmenu
      // listener below, not handled here. WebKit's right-click order is
      // pointerdown → mousedown → contextmenu → mouseup, so a bubble-phase
      // mousedown fires BEFORE contextmenu — closing the menu here would make
      // the contextmenu listener dead code and cycle `open` false→true on
      // every right-click, re-running the focus-restore cleanup each time.
      if (e.button === 2) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      if (subPanelRef.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const onContextMenuOutside = (e: MouseEvent) => {
      // A fresh right-click elsewhere should replace this menu, not stack —
      // close here and let App's own contextmenu handler open the new one.
      // This is where right-button dismissal actually happens (mousedown
      // above ignores button 2): registered in the CAPTURE phase, this runs
      // BEFORE React's root listener dispatches the card's onContextMenu, so
      // both state updates batch within the same event (close → open at the
      // new card) and the menu moves instead of flashing closed. Left/middle
      // clicks and Ctrl+click still dismiss via mousedown above.
      if (panelRef.current?.contains(e.target as Node)) return;
      if (subPanelRef.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Document-level Escape backstop for when focus is NOT inside the panel
      // (e.g. the initial focus() was refused). The panel's own onKeyDown
      // handles the focused case and stops propagation at React's root, so
      // the two never both fire for one keypress.
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    const onWheel = (e: WheelEvent) => {
      // Dismiss on USER scrolling only. A `scroll` listener (InfoTip's
      // convention) would also fire for programmatic scrolls elsewhere on
      // the page — RunPanel's stream auto-pin (`el.scrollTop =
      // el.scrollHeight` on every chunk) and xterm output — and dismiss a
      // freshly-opened menu the moment a streaming task produces output.
      // The menu is cursor-anchored, not element-anchored, so it doesn't
      // drift when something else scrolls; `wheel` captures trackpad/mouse
      // scrolling, scrollbar drags already dismiss via the outside-mousedown
      // path, and keyboard scrolling can't happen while the menu owns focus.
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      if (subPanelRef.current && e.target instanceof Node && subPanelRef.current.contains(e.target)) return;
      onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    const onBlur = () => onCloseRef.current();

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("contextmenu", onContextMenuOutside, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("contextmenu", onContextMenuOutside, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  if (!open) return null;

  const selectItem = (item: ContextMenuLeafItem) => {
    if (item.disabled) return;
    item.onSelect();
    onCloseRef.current();
  };

  const openSubmenu = (item: ContextMenuSubmenuItem, viaKeyboard: boolean) => {
    if (item.disabled || item.items.length === 0) return;
    setSub({ id: item.id });
    setSubIndex(viaKeyboard ? moveMenuIndex(-1, 1, item.items.map((it) => !it.disabled)) : -1);
  };

  const closeSubmenu = (refocusParent: boolean) => {
    const parentIndex = items.findIndex((it) => it.id === sub?.id);
    setSub(null);
    setSubIndex(-1);
    if (refocusParent && parentIndex !== -1) {
      setActiveIndex(parentIndex);
      panelRef.current?.querySelector<HTMLElement>(`[data-menu-index="${parentIndex}"]`)?.focus();
    }
  };

  const onSubKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Every key handled here stops at the child: its React events also bubble
    // to the root panel's handler (the child is a portal inside the root's tree).
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        setSubIndex((cur) => moveMenuIndex(cur, 1, subEnabled));
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        setSubIndex((cur) => moveMenuIndex(cur, -1, subEnabled));
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        setSubIndex(moveMenuIndex(-1, 1, subEnabled));
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        setSubIndex(moveMenuIndex(-1, -1, subEnabled));
        break;
      case "ArrowLeft":
      case "Escape":
        // The first Escape (or ArrowLeft) closes only the child; a second
        // Escape, now landing on the root panel, closes the menu.
        e.preventDefault();
        e.stopPropagation();
        closeSubmenu(true);
        break;
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        break;
      default:
        break;
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        setActiveIndex((cur) => moveMenuIndex(cur, 1, enabled));
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        setActiveIndex((cur) => moveMenuIndex(cur, -1, enabled));
        break;
      }
      case "Home": {
        e.preventDefault();
        setActiveIndex(moveMenuIndex(-1, 1, enabled));
        break;
      }
      case "End": {
        e.preventDefault();
        setActiveIndex(moveMenuIndex(-1, -1, enabled));
        break;
      }
      case "ArrowRight": {
        const cur = items[activeIndex];
        if (cur?.type === "submenu") {
          e.preventDefault();
          openSubmenu(cur, true);
        }
        break;
      }
      case "Escape": {
        // Consume here so no enclosing Escape handler (RunPanel, dialogs)
        // also reacts to the same keypress — data-popover-open is the
        // marker those handlers check, this is the belt-and-suspenders.
        e.preventDefault();
        e.stopPropagation();
        // One level at a time: a child opened by hover leaves focus on its
        // parent item, so this Escape closes that child first.
        if (sub) closeSubmenu(true);
        else onCloseRef.current();
        break;
      }
      case "Tab": {
        e.preventDefault();
        onCloseRef.current();
        break;
      }
      default:
        break;
    }
  };

  return createPortal(
    <>
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      data-popover-open=""
      data-testid={testId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      // The menu always owns right-clicks on itself: App's document-level
      // suppressor deliberately lets the native menu through while read-only
      // text is selected, and a stale selection elsewhere on the page must
      // not let WebKit's menu open on top of ours.
      onContextMenu={(e) => e.preventDefault()}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      className="fixed z-50 max-h-[calc(100vh-16px)] min-w-44 overflow-y-auto rounded-md border border-border bg-card p-1 text-sm text-card-foreground shadow-xl"
    >
      {items.map((item, index) => {
        if (item.type === "separator") {
          return <div key={item.id} role="separator" className="my-1 h-px bg-border" />;
        }
        const Icon = item.icon;
        const isActive = index === activeIndex;
        if (item.type === "submenu") {
          const expanded = sub?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={expanded}
              data-menu-index={index}
              data-menu-id={item.id}
              data-testid={testId ? `${testId}-${item.id}` : undefined}
              disabled={item.disabled}
              tabIndex={isActive ? 0 : -1}
              onClick={() => openSubmenu(item, true)}
              onMouseEnter={
                item.disabled
                  ? undefined
                  : () => {
                      setActiveIndex(index);
                      openSubmenu(item, false);
                    }
              }
              className={ITEM_CLASS(isActive || expanded, false, item.disabled)}
            >
              {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-menu-index={index}
            data-testid={testId ? `${testId}-${item.id}` : undefined}
            disabled={item.disabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => selectItem(item)}
            onMouseEnter={
              item.disabled
                ? undefined
                : () => {
                    setActiveIndex(index);
                    // Moving onto a plain item closes any open child.
                    if (sub) closeSubmenu(false);
                  }
            }
            className={ITEM_CLASS(isActive, item.danger, item.disabled)}
          >
            {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
    {openSub && (
      <div
        ref={subPanelRef}
        role="menu"
        aria-label={openSub.label}
        data-popover-open=""
        data-testid={testId ? `${testId}-${openSub.id}-submenu` : undefined}
        tabIndex={-1}
        onKeyDown={onSubKeyDown}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={subPos ? { top: subPos.top, left: subPos.left } : { top: 0, left: 0, visibility: "hidden" }}
        className="fixed z-50 max-h-[calc(100vh-16px)] min-w-44 overflow-y-auto rounded-md border border-border bg-card p-1 text-sm text-card-foreground shadow-xl"
      >
        {openSub.items.map((child, index) => {
          const ChildIcon = child.icon;
          const isActive = index === subIndex;
          return (
            <button
              key={child.id}
              type="button"
              role="menuitem"
              data-sub-index={index}
              data-testid={testId ? `${testId}-${child.id}` : undefined}
              disabled={child.disabled}
              tabIndex={isActive ? 0 : -1}
              onClick={() => selectItem(child)}
              onMouseEnter={child.disabled ? undefined : () => setSubIndex(index)}
              className={ITEM_CLASS(isActive, child.danger, child.disabled)}
            >
              {ChildIcon && <ChildIcon className="size-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{child.label}</span>
            </button>
          );
        })}
      </div>
    )}
    </>,
    document.body,
  );
}
