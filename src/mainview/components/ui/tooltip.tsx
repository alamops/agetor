import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  /** Horizontal alignment of the bubble relative to the trigger. */
  align?: "center" | "end";
  className?: string;
  children: ReactNode;
}

/** Hover/focus delay before the bubble appears — long enough that a cursor
 *  passing over the trigger on its way elsewhere doesn't flash a tooltip. */
export const TOOLTIP_SHOW_DELAY_MS = 300;

/**
 * Lightweight hover/focus tooltip for icon-only buttons — a `title`
 * attribute equivalent that actually shows on keyboard focus (native title
 * never does) and shows sooner than a browser's ~1s hover delay.
 *
 * Every trigger this wraps already carries its own `aria-label` as the
 * accessible name, so the bubble below is a purely visual aid: it renders
 * with `aria-hidden`, not `role="tooltip"`, and there is no `aria-describedby`
 * plumbing back to the trigger.
 *
 * Deliberately does NOT set `data-popover-open` and does NOT handle Escape.
 * That marker/contract is for real popovers (dialogs, menus, SearchSelect…)
 * whose Escape should be caught before an enclosing panel's Escape handler
 * closes the whole panel — see ui/context-menu.tsx and dialog.tsx. A
 * transient hover bubble must never participate in that: it should just
 * disappear on mouseleave/blur, not block Escape-to-close-panel.
 */
export function Tooltip({ label, align = "center", className, children }: Props) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => {
        clearTimer();
        timerRef.current = setTimeout(() => setOpen(true), TOOLTIP_SHOW_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimer();
        setOpen(false);
      }}
      onFocusCapture={(e) => {
        // Only a keyboard-driven focus should show the bubble immediately —
        // a mouse click that happens to focus the trigger already has the
        // hover path (with its delay) covering it, and showing on every
        // programmatic/mouse focus too would make click targets feel noisy.
        if ((e.target as HTMLElement).matches?.(":focus-visible")) {
          clearTimer();
          setOpen(true);
        }
      }}
      onBlurCapture={() => {
        clearTimer();
        setOpen(false);
      }}
      onMouseDown={() => {
        // A click is about to happen — don't leave a stale bubble hanging
        // over whatever it opens (e.g. a dialog).
        clearTimer();
        setOpen(false);
      }}
    >
      {children}
      {open && (
        <span
          aria-hidden="true"
          data-testid="tooltip"
          className={cn(
            "pointer-events-none absolute top-full z-50 mt-1 max-w-64 break-words rounded border border-border bg-card px-2 py-1 text-xs text-card-foreground shadow-md",
            align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
