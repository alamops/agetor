import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export interface SearchSelectItem {
  value: string;
  label: string;
  /** Secondary text shown under the label. */
  hint?: string;
  /** Render at the top of the list above non-pinned items (e.g. current branch). */
  pinned?: boolean;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  items: SearchSelectItem[];
  placeholder?: string;
  /** Shown in the trigger when no value is selected. */
  emptyLabel?: string;
  /** Optional row rendered below the list (e.g. "Browse for folder"). */
  footer?: ReactNode;
  /** Override the trigger label for an arbitrary value (e.g. show basename for a path). */
  displayValue?: (value: string) => string;
  className?: string;
  /** Left-side icon in the trigger. */
  leadingIcon?: ReactNode;
  disabled?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  /**
   * Where the popover opens relative to the trigger. Default "top" suits the
   * always-anchored-at-the-bottom new-task form; dialogs that render the
   * picker near the top of a modal should pass "bottom".
   */
  placement?: "top" | "bottom";
}

/**
 * Generic combobox: trigger button → popover with a search box + a filtered
 * list + an optional footer slot. Native `<select>` doesn't support search or
 * arbitrary trailing actions, hence the hand-rolled popover.
 */
export function SearchSelect({
  value,
  onChange,
  items,
  placeholder = "Select…",
  emptyLabel,
  footer,
  displayValue,
  className,
  leadingIcon,
  disabled,
  title,
  placement = "top",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    // Focus the search box once the panel is mounted.
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset the query each time the panel closes so the next open starts clean.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      i.label.toLowerCase().includes(q)
      || i.value.toLowerCase().includes(q)
      || (i.hint?.toLowerCase().includes(q) ?? false));
  }, [items, query]);

  // Show pinned matches at the top of the filtered view.
  const ordered = useMemo(() => {
    const pinned = filtered.filter((i) => i.pinned);
    const rest = filtered.filter((i) => !i.pinned);
    return [...pinned, ...rest];
  }, [filtered]);

  const triggerLabel = value
    ? (displayValue ? displayValue(value) : value)
    : (emptyLabel ?? placeholder);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-1 text-left text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {leadingIcon && <span className="shrink-0 text-muted-foreground">{leadingIcon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
          {triggerLabel}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-xl",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <Search className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {ordered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            ) : (
              ordered.map((item) => {
                const active = item.value === value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/60",
                      active && "bg-accent/40",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        active ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      {item.hint && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {item.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {footer && (
            <div className="border-t border-border/60">{footer}</div>
          )}
        </div>
      )}
    </div>
  );
}
