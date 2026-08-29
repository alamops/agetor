import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clampPercent, formatResetsIn, formatUpdatedAgo, tierColorVar, warnTier } from "@/lib/usage";
import type { HarnessQuota } from "../../../shared/types.ts";

interface Props {
  /** The harness's latest usage snapshot, or `null` when none exists yet
   *  (unsupported kind, or first poll still pending) — the popover then
   *  renders `placeholder` guidance instead of meters. */
  quota: HarnessQuota | null;
  harnessLabel: string;
  children: ReactNode;
  onRefresh: () => Promise<void>;
  /** Guidance shown when `quota` is null: why there's no data and whether a
   *  manual Refresh could produce some (`canRefresh` gates the button). */
  placeholder?: { message: string; canRefresh: boolean };
}

// Same explicit map as UsageMeter — dynamic `bg-${token}` strings don't
// survive Tailwind's JIT scan.
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Click-toggled popover for a topbar harness chip: lists every meter the
 * provider reported (bar, percent, reset time), the plan type, a
 * "last updated" label, and a manual Refresh button. Open/close/outside-click
 * /Escape mechanics mirror `components/ui/info-tip.tsx`.
 *
 * `bg-popover`/`text-popover-foreground` are NOT defined in either
 * `index.css` or `tailwind.config.js` (checked at implementation time) — this
 * uses `bg-card`/`text-card-foreground` instead, which are.
 */
export function UsagePopover({ quota, harnessLabel, children, onRefresh, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // Best-effort — the parent's usage state is otherwise kept current via
      // the `harness_usage` SSE broadcast, so a failed manual refresh here
      // isn't fatal.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div ref={rootRef} className="electrobun-webkit-app-region-no-drag relative inline-flex">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="m-0 inline-flex cursor-pointer items-center rounded border-0 bg-transparent p-0 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ font: "inherit" }}
      >
        {children}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`${harnessLabel} usage`}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="electrobun-webkit-app-region-no-drag absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-card p-3 text-xs text-card-foreground shadow-md"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{harnessLabel}</span>
            {quota?.planType && <span className="text-muted-foreground">{quota.planType}</span>}
          </div>

          {quota === null ? (
            <div className="mt-2 text-muted-foreground">
              {placeholder?.message ?? "No usage data"}
            </div>
          ) : quota.meters.length === 0 ? (
            <div className="mt-2 text-muted-foreground">{quota.reason ?? "No usage data"}</div>
          ) : (
            <div className="mt-2 space-y-2.5">
              {quota.meters.map((m) => {
                const tier = warnTier(m.usedPercent);
                const fillClass = FILL_CLASS[tierColorVar(tier)];
                const resets = formatResetsIn(m.resetsAtMs, Date.now());
                return (
                  <div key={m.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {m.label}
                        {m.scope && <span className="text-muted-foreground"> · {m.scope}</span>}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{Math.round(m.usedPercent)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", fillClass)}
                        style={{ width: `${clampPercent(m.usedPercent)}%` }}
                      />
                    </div>
                    {resets && <div className="mt-0.5 text-muted-foreground">{resets}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {(quota !== null || placeholder?.canRefresh) && (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
              <span className="text-muted-foreground">
                {quota !== null ? formatUpdatedAgo(quota.fetchedAtMs, Date.now()) : ""}
              </span>
              {(quota !== null || placeholder?.canRefresh) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={refreshing}
                  aria-label="Refresh usage"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleRefresh();
                  }}
                >
                  <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
