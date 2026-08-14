import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  text: ReactNode;
  className?: string;
  /** Accessible label on the trigger button. */
  label?: string;
  /** Which side of the icon the popover opens toward. */
  side?: "top" | "bottom";
  /** Which side of the icon the popover aligns to horizontally. */
  align?: "left" | "right";
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

/**
 * Click-toggled (i) info popover. Used to move always-visible helper copy
 * out of the layout and behind an icon the user opts into reading.
 *
 * The panel is portaled to document.body and positioned `fixed`, clamped to
 * the viewport — an ancestor with overflow clipping (the New Task sidebar,
 * dialog panes) must not be able to cut it off.
 */
export function InfoTip({ text, className, label = "More info", side = "bottom", align = "right" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The fixed panel would drift away from its anchor on scroll/resize;
    // closing matches the outside-interaction dismissal model.
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = rootRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const r = trigger.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const left = clamp(
      align === "left" ? r.left : r.right - pw,
      VIEWPORT_MARGIN,
      window.innerWidth - pw - VIEWPORT_MARGIN,
    );
    const top = clamp(
      side === "top" ? r.top - ph - TRIGGER_GAP : r.bottom + TRIGGER_GAP,
      VIEWPORT_MARGIN,
      window.innerHeight - ph - VIEWPORT_MARGIN,
    );
    setPos({ top, left });
  }, [open, side, align]);

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="note"
            // Marker for enclosing Esc handlers to bail and let this popover
            // consume Escape first (mirrors search-select.tsx).
            data-popover-open=""
            // Portaled, but React events still bubble through the React tree —
            // the panel sits inside a <details><summary> at one call site, so
            // an unstopped click/mousedown would toggle the section.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            className="fixed z-50 max-w-[min(16rem,calc(100vw-2rem))] w-64 rounded-md border border-border bg-card p-2 text-left text-[11px] leading-snug text-muted-foreground shadow-xl"
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}
