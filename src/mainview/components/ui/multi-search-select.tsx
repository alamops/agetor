import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export interface MultiSearchSelectItem<T extends string = string> {
  value: T;
  label: string;
  /** Secondary text shown under the label. */
  hint?: string;
  /** Render at the top of the list above non-pinned items. */
  pinned?: boolean;
}

interface Props<T extends string> {
  values: T[];
  onChange: (next: T[]) => void;
  items: MultiSearchSelectItem<T>[];
  /** Search-box placeholder inside the popover. */
  placeholder?: string;
  /** Shown in the trigger when no value is selected. */
  emptyLabel: string;
  className?: string;
  /** Left-side icon in the trigger. */
  leadingIcon?: ReactNode;
  disabled?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  placement?: "top" | "bottom";
}

/**
 * Multi-select variant of SearchSelect: trigger button → popover with a search
 * box + a filtered list where clicking an item toggles it without closing.
 * Trigger label shows the single picked item's label, or "<n> selected", or
 * the empty-state label when nothing is picked. Clearing the selection is
 * done by the caller (e.g. an external "Clear" button) — keeping the trigger
 * single-purpose avoids nesting interactive elements inside the trigger
 * button and the keyboard/a11y issues that come with it.
 */
export function MultiSearchSelect<T extends string>({
  values,
  onChange,
  items,
  placeholder = "Search…",
  emptyLabel,
  className,
  leadingIcon,
  disabled,
  title,
  placement = "bottom",
}: Props<T>) {
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
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  const ordered = useMemo(() => {
    const pinned = filtered.filter((i) => i.pinned);
    const rest = filtered.filter((i) => !i.pinned);
    return [...pinned, ...rest];
  }, [filtered]);

  const valueSet = useMemo(() => new Set(values), [values]);

  const triggerLabel = useMemo(() => {
    if (values.length === 0) return emptyLabel;
    if (values.length === 1) {
      const only = items.find((i) => i.value === values[0]);
      return only?.label ?? values[0]!;
    }
    return `${values.length} selected`;
  }, [values, items, emptyLabel]);

  const toggle = (value: T) => {
    if (valueSet.has(value)) onChange(values.filter((v) => v !== value));
    else onChange([...values, value]);
  };

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
        <span className={cn("min-w-0 flex-1 truncate", values.length === 0 && "text-muted-foreground")}>
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
                const active = valueSet.has(item.value);
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => toggle(item.value)}
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
        </div>
      )}
    </div>
  );
}
