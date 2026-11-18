import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The toggle row's label. */
  label: React.ReactNode;
  /** A trailing note on the row, shown while closed (e.g. "Speed: Fast"). */
  note?: React.ReactNode;
  /** Colors the note as an error. */
  noteTone?: "default" | "danger";
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

/** A button + region disclosure (`aria-expanded` / `aria-controls`). The
 *  region is not rendered while closed, so its controls leave the tab order. */
export function Disclosure({
  open,
  onOpenChange,
  label,
  note,
  noteTone = "default",
  testId,
  className,
  children,
}: DisclosureProps) {
  const regionId = React.useId();
  return (
    <div className={className}>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span>{label}</span>
        {!open && note ? (
          <span
            data-testid={testId ? `${testId}-note` : undefined}
            data-tone={noteTone}
            className={cn(
              "min-w-0 flex-1 truncate text-right text-2xs font-normal",
              noteTone === "danger" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {note}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={regionId} role="region" data-testid={testId ? `${testId}-region` : undefined} className="pt-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
