import { clampPercent, tierColorVar, worstMeter, worstTier } from "@/lib/usage";
import type { HarnessQuota } from "../../../shared/types.ts";

interface Props {
  quota: HarnessQuota;
}

// Tailwind's JIT scanner needs literal class strings — building
// `bg-${token}` at runtime would emit nothing (the undefined-token trap
// described in CLAUDE.md applies to dynamic strings too, not just missing
// tokens). Map explicitly instead.
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Compact fixed-size mini-bar for a harness chip in the topbar — shows only
 * the *worst* meter in the snapshot, colored by its warn tier. Renders
 * nothing when there's no usable data (`status !== "ok"` or no meters), so
 * the chip falls back to just its existing availability dot.
 */
export function UsageMeter({ quota }: Props) {
  if (quota.status !== "ok") return null;
  const m = worstMeter(quota.meters);
  if (!m) return null;
  const tier = worstTier(quota.meters);
  const fillClass = FILL_CLASS[tierColorVar(tier)];

  return (
    <span className="inline-block h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span
        className={`block h-full rounded-full ${fillClass}`}
        style={{ width: `${clampPercent(m.usedPercent)}%` }}
      />
    </span>
  );
}
