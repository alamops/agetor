import { cn } from "@/lib/utils";
import { clampPercent, tierColorVar, warnTier } from "@/lib/usage";

interface Props {
  /** 0..100 used. Out-of-range and non-finite values clamp for the width. */
  usedPercent: number;
  /** A snapshot older than the failover believes: dimmed. */
  stale?: boolean;
  className?: string;
  "data-testid"?: string;
}

// Tailwind's JIT scanner needs literal class strings — a runtime `bg-${token}`
// would emit nothing (the undefined-token trap in CLAUDE.md).
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Compact usage bar for the Harnesses button, the stack headings and the
 * account rows. Decorative: the percent next to it (or the row's meter list)
 * carries the number, so it is `aria-hidden`. The fill color follows
 * `warnTier` (70 % warn, 90 % crit).
 */
export function BarMeter({ usedPercent, stale = false, className, "data-testid": testId }: Props) {
  const fill = FILL_CLASS[tierColorVar(warnTier(usedPercent))];
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={cn("inline-block h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted", stale && "opacity-60", className)}
    >
      <span className={cn("block h-full rounded-full", fill)} style={{ width: `${clampPercent(usedPercent)}%` }} />
    </span>
  );
}
