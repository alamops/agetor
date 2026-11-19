import * as React from "react";
import { cn } from "@/lib/utils";

export interface ResizeHandleProps {
  value: number;
  min: number;
  max: number;
  /** Called continuously while dragging / on each key press with the live width. */
  onChange: (width: number) => void;
  /** Called once a drag or key press settles (persist here). */
  onCommit: (width: number) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
  /** Accessible name, e.g. "Resize new task panel". */
  label: string;
  testId?: string;
  /** Which edge of the panel the handle sits on: dragging right grows a
   *  panel whose handle is on its `right` edge. */
  side?: "right";
  /** Keyboard step in px. */
  step?: number;
  className?: string;
}

/** A vertical separator that resizes a panel by pointer drag and by keyboard
 *  (ArrowLeft/Right ±`step`, Shift ×4, Home = min, End = max). Mirrors the
 *  RunPanel's handle (`role="separator"`, `aria-valuenow`). */
export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  onCommit,
  onReset,
  label,
  testId,
  step = 16,
  className,
}: ResizeHandleProps) {
  const drag = React.useRef<{ startX: number; startWidth: number; last: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  // The window listeners below outlive a render: read the latest callbacks through a ref.
  const cbs = React.useRef({ onChange, onCommit, min, max });
  cbs.current = { onChange, onCommit, min, max };
  const cleanup = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => cleanup.current?.(), []);

  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));

  // The drag listens on `window`, not on the 6 px handle: the pointer leaves it at once, and
  // pointer capture is not guaranteed for every pointer (a synthetic or touch pointer).
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const d = { startX: e.clientX, startWidth: value, last: value, moved: false };
    drag.current = d;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const { min: lo, max: hi } = cbs.current;
      const next = Math.min(hi, Math.max(lo, Math.round(d.startWidth + (ev.clientX - d.startX))));
      if (next !== d.last) {
        d.last = next;
        d.moved = true;
        cbs.current.onChange(next);
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cleanup.current = null;
      drag.current = null;
      setDragging(false);
      // A click without movement is not a resize: committing would persist the (possibly
      // window-limited) shown width over the width the user saved. `moved`, not a changed
      // width, so a drag that returns to its start still ends the consumer's `resizing`.
      if (d.moved) cbs.current.onCommit(d.last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.shiftKey ? step * 4 : step;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = clamp(value + delta);
    else if (e.key === "ArrowLeft") next = clamp(value - delta);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    // Already at the limit: nothing changes, so nothing is saved.
    if (next === value) return;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none data-[dragging]:bg-primary/40",
        className,
      )}
    />
  );
}
