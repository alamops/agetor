import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  /** Horizontal alignment of the bubble relative to the trigger. */
  align?: "center" | "end";
  className?: string;
  /** A single trigger element — it receives `aria-describedby` pointing at a
   *  visually-hidden twin of the label, so the descriptive text stays
   *  reachable by assistive tech (the trigger's own `aria-label` remains the
   *  accessible name). */
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/** Hover delay before the bubble appears — long enough that a cursor passing
 *  over the trigger on its way elsewhere doesn't flash a tooltip. */
const TOOLTIP_SHOW_DELAY_MS = 300;

/** Bubbles never sit closer than this to the viewport edge (same margin as
 *  ui/info-tip.tsx uses for its clamp). */
const VIEWPORT_MARGIN_PX = 8;

// Only one bubble should ever be painted at once — a keyboard-focused tooltip
// on trigger A plus a hover-opened one on trigger B would double up (and turn
// the shared data-testid into a Playwright strict-mode violation). Each
// instance registers a closer when it opens and closes the previous one.
let closeActive: (() => void) | null = null;

/**
 * Lightweight hover/focus tooltip for icon-only buttons — a `title`
 * attribute equivalent that actually shows on keyboard focus (native title
 * never does) and shows sooner than a browser's ~1s hover delay.
 *
 * The visible bubble is `aria-hidden`: the trigger keeps its `aria-label` as
 * the accessible name, and a permanent `sr-only` twin of the label is wired
 * to the trigger via `aria-describedby`, preserving the descriptive channel
 * the native `title` used to provide (worktree paths, longer explanations).
 *
 * Current scope: RunPanel's header + search-bar icon buttons. Other icon-only
 * buttons in the app (e.g. the backlog tray) intentionally still use native
 * `title` — converting them is a separate sweep, not an oversight here.
 *
 * Deliberately does NOT set `data-popover-open` and does NOT handle Escape.
 * That marker/contract is for real popovers (dialogs, menus, SearchSelect…)
 * whose Escape should be caught before an enclosing panel's Escape handler
 * closes the whole panel — see ui/context-menu.tsx and dialog.tsx. A
 * transient hover bubble must never participate in that: it should just
 * disappear on mouseleave/blur, not block Escape-to-close-panel.
 */
export function Tooltip({ label, align = "center", className, children }: Props) {
  const descId = useId();
  // Hover and keyboard focus are independent show reasons: a mouse passing
  // over (and off) a keyboard-focused trigger must not kill its bubble, and
  // focus wandering must not kill a hover-opened one.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const [shiftX, setShiftX] = useState(0);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setHovered(false);
      setFocused(false);
    };
    if (closeActive !== null && closeActive !== close) closeActive();
    closeActive = close;
    return () => {
      if (closeActive === close) closeActive = null;
    };
  }, [open]);

  // Clamp against the viewport's left edge: an `align="end"` bubble under a
  // left-most trigger can extend past the window on narrow panels. Measured
  // with shiftX reset to 0 (the close path below resets it), so the rect is
  // the bubble's natural position.
  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const el = bubbleRef.current;
    if (el == null) return;
    const rect = el.getBoundingClientRect();
    const overflowLeft = Math.max(0, VIEWPORT_MARGIN_PX - rect.left);
    if (overflowLeft > 0) setShiftX(overflowLeft);
  }, [open, label]);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => {
        clearTimer();
        timerRef.current = setTimeout(() => setHovered(true), TOOLTIP_SHOW_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimer();
        setHovered(false);
      }}
      onFocusCapture={(e) => {
        // Only a keyboard-driven focus should show the bubble immediately —
        // a mouse click that happens to focus the trigger already has the
        // hover path (with its delay) covering it, and showing on every
        // programmatic/mouse focus too would make click targets feel noisy.
        if ((e.target as HTMLElement).matches?.(":focus-visible")) {
          setFocused(true);
        }
      }}
      onBlurCapture={() => setFocused(false)}
      onMouseDown={() => {
        // A click is about to happen — don't leave a stale bubble hanging
        // over whatever it opens (e.g. a dialog). Clears both show reasons;
        // hover re-arms only on the next mouseenter.
        clearTimer();
        setHovered(false);
        setFocused(false);
      }}
    >
      {cloneElement(children, { "aria-describedby": descId })}
      <span id={descId} className="sr-only">
        {label}
      </span>
      {open && (
        <span
          ref={bubbleRef}
          aria-hidden="true"
          data-testid="tooltip"
          className={cn(
            "pointer-events-none absolute top-full z-50 mt-1 max-w-64 break-words rounded border border-border bg-card px-2 py-1 text-xs text-card-foreground shadow-md",
            align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
          )}
          style={
            shiftX > 0
              ? align === "end"
                ? { right: -shiftX }
                : { left: `calc(50% + ${shiftX}px)` }
              : undefined
          }
        >
          {label}
        </span>
      )}
    </span>
  );
}
