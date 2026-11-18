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
  const drag = React.useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: value, last: value };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = clamp(d.startWidth + (e.clientX - d.startX));
    if (next !== d.last) {
      d.last = next;
      onChange(next);
    }
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onCommit(d.last);
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
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none data-[dragging]:bg-primary/40",
        className,
      )}
    />
  );
}
