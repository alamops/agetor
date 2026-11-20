import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type CardChipTone = "neutral" | "info" | "warning" | "success";

const TONE: Record<CardChipTone, string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-info/40 text-info",
  warning: "border-warning/40 text-warning",
  success: "border-success/40 text-success",
};

/**
 * The board card's one chip: h-5, 10 px, fully rounded. Use it only where the
 * colour carries a meaning (account stack, fx pause, branch drift); a plain
 * activity count is a {@link CardStat}. A chip is never fixed-width and never
 * `shrink-0` around variable text: the text sits in an inner `truncate` span,
 * so a long value shortens instead of pushing a sibling out of the card.
 */
export function CardChip({ tone, className, ...rest }: { tone: CardChipTone } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[10px] font-medium leading-none",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** A quiet activity count: icon + number, no border. It is a fixed-size
 *  glyph pair (`shrink-0` is safe: its text is a short count, never a name). */
export function CardStat({
  icon: Icon,
  className,
  children,
  ...rest
}: { icon: LucideIcon } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] leading-4 tabular-nums text-muted-foreground", className)}
      {...rest}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {children}
    </span>
  );
}
