import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clampPercent, formatResetsIn, formatUpdatedAgo, tierColorVar, warnTier } from "@/lib/usage";
import type { AgentKind, HarnessQuota } from "../../../shared/types.ts";
import type { CooldownChip } from "@/lib/stack-editor";
import { StatusDot } from "./StatusDot";

// Same literal-class rule as BarMeter.
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

const TONE_TEXT: Record<"danger" | "warning" | "success" | "muted", string> = {
  danger: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  success: "border-success/40 bg-success/10 text-success",
  muted: "border-border bg-muted text-muted-foreground",
};

/** The `AccountState` fields this row reads (`lib/harness-bar.ts`); passing the
 *  whole object typechecks structurally. */
export interface AccountUsageRowProps {
  harnessId: string;
  kind: AgentKind;
  label: string;
  tone: "danger" | "warning" | "success" | "muted";
  statusText: string;
  /** CLI reason / authHelp / path: third-party text, rendered as text only. */
  detail: string | null;
  quota: HarnessQuota | null;
  stale: boolean;
  cooldowns: CooldownChip[];
  runningTasks: number;
  usageSupported: boolean;
  /** "Primary" | "Backup 1" … for a stack member. */
  positionLabel?: string;
  now: number;
  onRefresh: (harnessId: string) => Promise<void>;
}

/**
 * One account in the Harnesses panel: icon, name, position, a status chip,
 * running count, the usage meters (every meter the provider reported), the
 * "updated N ago" line, cooldown chips and a Refresh button. The state text
 * is always spelled out: color is never the only signal.
 */
export function AccountUsageRow(p: AccountUsageRowProps) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await p.onRefresh(p.harnessId);
    } catch {
      // Best-effort, as before: usage also arrives over the `harness_usage`
      // event, so a failed manual refresh is not fatal.
    } finally {
      setRefreshing(false);
    }
  };
  const q = p.quota;
  const canRefresh = q !== null || p.usageSupported;
  return (
    <div data-testid={`harnesses-panel-account-${p.harnessId}`} className="px-3 py-2.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon kind={p.kind} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{p.label}</span>
        {p.positionLabel && <span className="shrink-0 text-muted-foreground">{p.positionLabel}</span>}
        {q?.planType && <span className="shrink-0 text-muted-foreground">{q.planType}</span>}
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none",
            TONE_TEXT[p.tone],
          )}
        >
          <StatusDot tone={p.tone} label={p.statusText} className="size-1.5" />
          {p.statusText}
        </span>
      </div>
      {p.runningTasks > 0 && (
        <div className="mt-1 text-muted-foreground">
          {p.runningTasks} running task{p.runningTasks === 1 ? "" : "s"}
        </div>
      )}
      {p.detail && <div className="mt-1 break-words text-muted-foreground">{p.detail}</div>}
      {p.cooldowns.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {p.cooldowns.map((c) => (
            <li
              key={c.key}
              data-testid="harness-cooldown-chip"
              aria-label={c.ariaLabel}
              title={c.message ?? undefined}
              className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] text-warning"
            >
              {c.text}
              {c.message && <span className="sr-only">: {c.message}</span>}
            </li>
          ))}
        </ul>
      )}

      {q === null ? (
        <div className="mt-2 text-muted-foreground">
          {p.usageSupported
            ? "No usage data yet — the first poll runs shortly, or refresh now."
            : "Usage tracking isn't supported for this harness yet."}
        </div>
      ) : q.meters.length === 0 ? (
        <div className="mt-2 break-words text-muted-foreground">{q.reason ?? "No usage data"}</div>
      ) : (
        <div className="mt-2 space-y-2">
          {q.meters.map((m) => {
            const fill = FILL_CLASS[tierColorVar(warnTier(m.usedPercent))];
            const resets = formatResetsIn(m.resetsAtMs, p.now);
            return (
              <div key={m.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {m.label}
                    {m.scope && <span className="text-muted-foreground"> · {m.scope}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(m.usedPercent)}%</span>
                </div>
                <div
                  className={cn("mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted", p.stale && "opacity-60")}
                  aria-hidden="true"
                >
                  <div className={cn("h-full rounded-full", fill)} style={{ width: `${clampPercent(m.usedPercent)}%` }} />
                </div>
                {resets && <div className="mt-0.5 text-muted-foreground">{resets}</div>}
              </div>
            );
          })}
        </div>
      )}

      {(q !== null || canRefresh) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className={cn("text-muted-foreground", p.stale && "opacity-70")}>
            {q !== null ? `${p.stale ? "stale · " : ""}${formatUpdatedAgo(q.fetchedAtMs, p.now)}` : ""}
          </span>
          {canRefresh && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={refreshing}
              aria-label="Refresh usage"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
