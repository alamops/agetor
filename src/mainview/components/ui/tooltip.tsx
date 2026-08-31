import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  /** Horizontal alignment of the bubble relative to the trigger. */
  align?: "center" | "end";
  /** Which side of the trigger the bubble appears on. Use `"top"` for
   *  triggers near the bottom of the viewport (composer send, backlog tray). */
  side?: "bottom" | "top";
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

/** Gap between the trigger and the bubble. */
const GAP_PX = 4;

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
 * The bubble PORTALS to `document.body` with `position: fixed`. Two reasons,
 * both repo traps: an in-place `absolute` bubble clips inside any
 * `overflow-y-auto` ancestor (the backlog tray's capped scroll window), and
 * `fixed` inside the RunPanel `<aside>` would be rebased by its `translate-x`
 * transform — but `document.body` is untransformed, so `fixed` is safe there
 * (same reasoning as ui/context-menu.tsx). Position is measured from the
 * trigger on open, clamped to the viewport horizontally, and the bubble hides
 * on any scroll/resize rather than tracking (it re-shows on the next hover).
 *
 * The visible bubble is `aria-hidden`: the trigger keeps its `aria-label` as
 * the accessible name, and a permanent `sr-only` twin of the label (inside
 * the wrapper, not portaled) is wired to the trigger via `aria-describedby`,
 * preserving the descriptive channel the native `title` used to provide
 * (worktree paths, longer explanations).
 *
 * Current scope: RunPanel's icon-only buttons (header, search bar, backlog
 * tray, composer send, refresh-models). Text-labeled buttons intentionally
 * keep native `title` — their visible text is already the label.
 *
 * Deliberately does NOT set `data-popover-open` and does NOT handle Escape.
 * That marker/contract is for real popovers (dialogs, menus, SearchSelect…)
 * whose Escape should be caught before an enclosing panel's Escape handler
 * closes the whole panel — see ui/context-menu.tsx and dialog.tsx. A
 * transient hover bubble must never participate in that: it should just
 * disappear on mouseleave/blur, not block Escape-to-close-panel.
 */
export function Tooltip({ label, align = "center", side = "bottom", className, children }: Props) {
  const descId = useId();
  // Hover and keyboard focus are independent show reasons: a mouse passing
  // over (and off) a keyboard-focused trigger must not kill its bubble, and
  // focus wandering must not kill a hover-opened one.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  // Anchor position measured from the trigger when the bubble opens; the
  // bubble renders only once this is known (layout effects run before paint,
  // so there is no unpositioned flash).
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [shiftX, setShiftX] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
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

  // Anchor the bubble to the trigger's current rect.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setShiftX(0);
      return;
    }
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect == null) return;
    const style: CSSProperties =
      side === "top"
        ? { bottom: window.innerHeight - rect.top + GAP_PX }
        : { top: rect.bottom + GAP_PX };
    if (align === "end") {
      style.right = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - rect.right);
    } else {
      style.left = rect.left + rect.width / 2;
    }
    setPos(style);
  }, [open, align, side, label]);

  // Clamp horizontally once the bubble has a size: keep both edges inside the
  // viewport margin (a long label on a left-most trigger would otherwise run
  // past the window edge).
  useLayoutEffect(() => {
    if (pos == null) return;
    const el = bubbleRef.current;
    if (el == null) return;
    const rect = el.getBoundingClientRect();
    const overflowLeft = Math.max(0, VIEWPORT_MARGIN_PX - rect.left);
    const overflowRight = Math.min(0, window.innerWidth - VIEWPORT_MARGIN_PX - rect.right);
    const shift = overflowLeft > 0 ? overflowLeft : overflowRight;
    if (shift !== 0) setShiftX((prev) => prev + shift);
  }, [pos]);

  // A stale fixed-position bubble after a scroll or resize would float over
  // the wrong content — hide instead of tracking.
  useEffect(() => {
    if (!open) return;
    const hide = () => {
      setHovered(false);
      setFocused(false);
    };
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  const translate =
    align === "center"
      ? `translateX(calc(-50% + ${shiftX}px))`
      : shiftX !== 0
        ? `translateX(${shiftX}px)`
        : undefined;

  return (
    <span
      ref={wrapperRef}
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
      {open && pos != null &&
        createPortal(
          <span
            ref={bubbleRef}
            aria-hidden="true"
            data-testid="tooltip"
            className="pointer-events-none fixed z-50 max-w-64 break-words rounded border border-border bg-card px-2 py-1 text-xs text-card-foreground shadow-md"
            style={{ ...pos, transform: translate }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
