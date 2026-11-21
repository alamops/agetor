import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedItem {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  disabled?: boolean;
  testId?: string;
}

export interface SegmentedControlProps {
  value: string | null;
  onChange: (value: string) => void;
  items: SegmentedItem[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  testId?: string;
  size?: "default" | "sm";
  disabled?: boolean;
  className?: string;
  /** Lay the radios out in a grid of N columns instead of one wrapping row. */
  columns?: number;
}

/**
 * A radiogroup rendered as a row of buttons: one value, always visible,
 * arrow-key navigable (roving tabindex). The selected state is subtle on
 * purpose (accent fill, primary border) so a primary action elsewhere on the
 * page is the only filled `bg-primary` control. A native `<button>` per radio,
 * so a surrounding `<fieldset disabled>` disables it.
 */
export function SegmentedControl({
  value,
  onChange,
  items,
  testId,
  size = "default",
  disabled,
  className,
  columns,
  ...aria
}: SegmentedControlProps) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = items.findIndex((i) => i.value === value && !i.disabled);
  const tabbableIndex = checkedIndex >= 0 ? checkedIndex : items.findIndex((i) => !i.disabled);

  const move = (from: number, dir: 1 | -1) => {
    const n = items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + dir * step) % n) + n) % n;
      if (!items[i]!.disabled) {
        refs.current[i]?.focus();
        onChange(items[i]!.value);
        return;
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn(columns ? "grid gap-1.5" : "flex flex-wrap gap-1.5", className)}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {items.map((item, i) => {
        const checked = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabbableIndex ? 0 : -1}
            disabled={disabled || item.disabled}
            title={item.title}
            data-testid={item.testId}
            data-value={item.value}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              "inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "h-8 text-xs" : "h-9",
              checked
                ? "border-primary/60 bg-accent text-accent-foreground"
                : "border-input bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {item.icon ? <span aria-hidden className="shrink-0">{item.icon}</span> : null}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
