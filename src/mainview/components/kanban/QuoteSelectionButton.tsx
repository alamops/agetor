import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TextQuote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatQuote } from "@/lib/quote-selection";

/** Margin kept between the pill and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;
/** Vertical gap between the pill and the selection rect it's anchored to. */
const SELECTION_GAP = 8;
/** Rough footprint used to clamp the pill before it's actually measured —
 *  cheap and good enough since the pill's real size only differs by a few
 *  px, well inside VIEWPORT_MARGIN. */
const PILL_WIDTH = 84;
const PILL_HEIGHT = 32;

interface Position {
  top: number;
  left: number;
}

interface Props {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** When true, the pill never shows — used to gate the pill closed while a
   *  send is in flight or the backlog is busy, matching how
   *  ExtensionPicker/MessageHistoryPicker/Save-for-later gate themselves in
   *  RunPanel. Without this, a quote clicked mid-send gets wiped by the
   *  resolving `setInput("")` + `clearTaskDraft`. */
  disabled?: boolean;
  onQuote: (quoted: string) => void;
}

/** Whether `node` lives inside `container` — Range.commonAncestorContainer
 *  can be a text node, so this walks up through `parentNode` rather than
 *  relying on `Element.contains`. */
function isNodeInside(node: Node | null, container: HTMLElement): boolean {
  let el: Node | null = node;
  while (el) {
    if (el === container) return true;
    el = el.parentNode;
  }
  return false;
}

/** The single source of truth for "is there a selection worth quoting, and
 *  what is it" — shared by the recompute/positioning path and the button's
 *  own `onClick` so what the pill shows-for and what it actually quotes can
 *  never drift apart. Valid means: a selection exists, has at least one
 *  range, isn't collapsed, has non-whitespace text, and both its anchor and
 *  focus nodes live inside `container`. */
function readValidSelection(container: HTMLElement): Selection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (sel.toString().trim() === "") return null;
  if (!isNodeInside(sel.anchorNode, container) || !isNodeInside(sel.focusNode, container)) return null;
  return sel;
}

/** Compute the pill's `position: fixed` coordinates from a selection rect:
 *  centered above the selection, falling back to below it when there isn't
 *  room, then clamped to the viewport with a small margin. */
function computePosition(rect: DOMRect): Position {
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - PILL_WIDTH / 2, VIEWPORT_MARGIN),
    window.innerWidth - PILL_WIDTH - VIEWPORT_MARGIN,
  );

  const above = rect.top - PILL_HEIGHT - SELECTION_GAP;
  const top = above >= VIEWPORT_MARGIN ? above : rect.bottom + SELECTION_GAP;
  const clampedTop = Math.min(Math.max(top, VIEWPORT_MARGIN), window.innerHeight - PILL_HEIGHT - VIEWPORT_MARGIN);

  return { top: clampedTop, left };
}

/**
 * Floating "Quote" pill that appears while a non-collapsed, non-whitespace
 * text selection lives inside `containerRef` (the run panel's messages
 * viewport). Clicking it turns the selection into a markdown blockquote and
 * hands it to `onQuote`.
 *
 * Entirely imperative — `document.selectionchange` + `resize` + capture-phase
 * `scroll` listeners recompute a `{ top, left } | null` position via
 * `requestAnimationFrame`, never synchronously per event. This keeps
 * selection handling fully outside the message stream's render path (no
 * selection state is threaded through `RunEventList`/`sections`).
 */
export function QuoteSelectionButton({ containerRef, disabled = false, onQuote }: Props) {
  const [position, setPosition] = useState<Position | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirrors `position !== null` but readable synchronously inside listeners
  // without depending on the latest render's closure.
  const visibleRef = useRef(false);
  // Captured into a ref (same idiom as RunPanel's `onCloseRef`) so the main
  // effect doesn't need `disabled` in its deps — toggling it (e.g. every
  // send) would otherwise tear down + re-add all these listeners.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Hide immediately when disabled flips true mid-selection (e.g. a send
  // kicks off while the pill is showing) instead of waiting for the next
  // selectionchange/scroll/resize to notice.
  useEffect(() => {
    if (!disabled) return;
    visibleRef.current = false;
    setPosition(null);
  }, [disabled]);

  useEffect(() => {
    const schedule = (fn: () => void) => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(fn);
    };

    const recompute = () => {
      const container = containerRef.current;
      if (disabledRef.current || !container) {
        visibleRef.current = false;
        setPosition(null);
        return;
      }

      const sel = readValidSelection(container);
      if (!sel) {
        visibleRef.current = false;
        setPosition(null);
        return;
      }

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = container.getBoundingClientRect();
      // The selection's anchor lives inside `container` in the DOM sense,
      // but may not be visible there right now (a zero-area rect — e.g. a
      // collapsed ancestor — or a rect that's scrolled entirely above/below
      // the container's own viewport slice). Hide rather than clamp: a
      // clamped pill pointing at content that isn't actually on screen is
      // misleading.
      const zeroArea = rect.width === 0 && rect.height === 0;
      const outsideContainer = rect.bottom < box.top || rect.top > box.bottom;
      if (zeroArea || outsideContainer) {
        visibleRef.current = false;
        setPosition(null);
        return;
      }

      visibleRef.current = true;
      setPosition(computePosition(rect));
    };

    const onSelectionChange = () => {
      if (disabledRef.current) return;
      // Cheap early-bail before the rAF-scheduled work: this listener fires
      // on every composer keystroke (selectionchange isn't scoped to our
      // container), so when the pill isn't already showing and the current
      // selection isn't even a plausible candidate (none, empty, or
      // collapsed), skip scheduling a frame entirely. The full containment/
      // whitespace check still has to happen inside `recompute` once
      // something IS scheduled, since `getSelection()` here may not reflect
      // the final selection yet (some browsers fire `selectionchange`
      // mid-drag).
      const sel = window.getSelection();
      if (!visibleRef.current && (!sel || sel.rangeCount === 0 || sel.isCollapsed)) return;
      schedule(recompute);
    };
    const onReposition = () => {
      if (!visibleRef.current) return;
      schedule(recompute);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !visibleRef.current) return;
      visibleRef.current = false;
      setPosition(null);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", onReposition);
    // Capture phase: the messages list scrolls an inner div, not the
    // window/document, and scroll events don't bubble.
    document.addEventListener("scroll", onReposition, true);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("scroll", onReposition, true);
      document.removeEventListener("keydown", onKeyDown);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef]);

  if (disabled || !position) return null;

  // Portaled to `document.body`: RunPanel's slide-over `<aside>` carries a
  // `translate-x-*` transform, which makes it the containing block for any
  // `position: fixed` descendant (per the CSS spec, a transformed ancestor
  // becomes the containing block for fixed descendants). Left in place, the
  // pill's "viewport" coordinates would actually be relative to the aside
  // and paint off-screen. Portaling out from under it restores true
  // viewport-relative fixed positioning; `z-50` now applies globally rather
  // than only within the aside's stacking context.
  return createPortal(
    <div
      // RunPanel's Escape listeners check for `[data-quote-open]` before
      // closing the panel/search bar — without this attribute, dismissing
      // the pill with Escape would also close a layer underneath it. Not
      // `data-popover-open`: that marker also gates the panel's Cmd/Ctrl+F
      // guard, and a passive text selection must not suppress find-in-panel.
      data-quote-open=""
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-50"
    >
      <Button
        size="sm"
        variant="secondary"
        className="h-8 gap-1.5 px-2.5 text-xs shadow"
        // Prevent the mousedown from collapsing the selection before onClick
        // gets a chance to read it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const container = containerRef.current;
          const sel = container ? readValidSelection(container) : null;
          const quoted = sel ? formatQuote(sel.toString()) : "";
          if (quoted) onQuote(quoted);
          sel?.removeAllRanges();
          visibleRef.current = false;
          setPosition(null);
        }}
      >
        <TextQuote className="size-3.5" />
        Quote
      </Button>
    </div>,
    document.body,
  );
}
