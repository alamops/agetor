import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

/**
 * Click-toggled (i) info popover. Used to move always-visible helper copy
 * out of the layout and behind an icon the user opts into reading.
 */
export function InfoTip({ text, className, label = "More info", side = "bottom", align = "right" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

      {open && (
        <div
          id={panelId}
          role="note"
          // Marker for enclosing Esc handlers to bail and let this popover
          // consume Escape first (mirrors search-select.tsx).
          data-popover-open=""
          // The panel sits inside a <details><summary> at one call site —
          // an unstopped click/mousedown inside it bubbles up and toggles
          // the section, same reason the trigger button stops propagation.
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute z-50 max-w-[min(16rem,calc(100vw-2rem))] w-64 rounded-md border border-border bg-card p-2 text-left text-[11px] leading-snug text-muted-foreground shadow-xl",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            align === "left" ? "left-0" : "right-0",
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}
