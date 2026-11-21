import { useState } from "react";
import { ArrowLeftRight, History, Layers, RefreshCw, Settings2 } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatResetClock } from "@/lib/stack-badge";
import type { FailoverTask, StackUnit } from "@/lib/harness-bar";
import { AccountUsageRow } from "./AccountUsageRow";
import { BarMeter } from "./BarMeter";
import { StatusDot } from "./StatusDot";

export interface PanelActions {
  onRefreshUsage: (harnessId: string) => Promise<void>;
  onOpenHarnessSettings: () => void;
  onOpenStackHistory: (stackId: string) => void;
  onOpenFailoverTask: (taskId: string) => void;
}

interface Props extends PanelActions {
  unit: StackUnit;
  now: number;
}

/** One failover task, as a button under its stack: the title, what it is
 *  doing, and a click that opens the task. Provider-independent text only. */
export function FailoverTaskRow({ task, onOpen }: { task: FailoverTask; onOpen: (taskId: string) => void }) {
  return (
    <button
      type="button"
      data-testid={`harnesses-panel-failover-${task.taskId}`}
      onClick={() => onOpen(task.taskId)}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeftRight className="size-3 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{task.title}</span>
      <span className="shrink-0 text-muted-foreground">{task.text}</span>
    </button>
  );
}

/**
 * A live Harness Stack in the Harnesses panel: the heading (kind, a "Stack"
 * marker in words, one dot per member, the headroom meter and the earliest
 * reset), the tasks currently failing over, each member's usage row, and the
 * stack actions. Rendered only for stacks `buildHarnessBarModel` kept live.
 */
export function StackSection({ unit, now, onRefreshUsage, onOpenHarnessSettings, onOpenStackHistory, onOpenFailoverTask }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const { stack } = unit;
  const refreshable = unit.members.filter((m) => m.state !== "disabled" && m.usageSupported);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled(refreshable.map((m) => onRefreshUsage(m.harnessId)));
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section data-testid={`harnesses-panel-stack-${stack.id}`} aria-label={`${stack.label} stack`} className="py-1">
      <div className="px-3 pb-1 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon kind={stack.kind} className="size-3.5 shrink-0" />
          <h3 className="min-w-0 truncate text-sm font-semibold">{stack.label}</h3>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-info/40 bg-info/10 px-1.5 py-0.5 text-[11px] leading-none text-info">
            <Layers className="size-3" aria-hidden="true" />
            Stack
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {unit.members.map((m) => (
              <StatusDot key={m.harnessId} tone={m.tone} label={`${m.label}: ${m.statusText}`} />
            ))}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{unit.kindLabel}</span>
          {unit.usableCount === 0 ? (
            <span className="text-warning">
              all out{unit.blockedUntil !== null ? ` · resets ${formatResetClock(unit.blockedUntil, now)}` : ""}
            </span>
          ) : (
            unit.headroomPercent !== null && (
              <span className="inline-flex items-center gap-1.5" title={unit.headroomSource ? `Best account: ${unit.headroomSource}` : undefined}>
                <BarMeter usedPercent={unit.headroomPercent} stale={unit.stale} />
                <span className="tabular-nums">{Math.round(unit.headroomPercent)}%</span>
                {unit.stale && <span>stale</span>}
              </span>
            )
          )}
        </div>
      </div>
      {unit.failoverTasks.length > 0 && (
        <div className="px-1 pb-1">
          {unit.failoverTasks.map((t) => (
            <FailoverTaskRow key={t.taskId} task={t} onOpen={onOpenFailoverTask} />
          ))}
        </div>
      )}
      <div className="divide-y divide-border/60">
        {unit.members.map((m) => (
          <AccountUsageRow key={m.harnessId} {...m} now={now} onRefresh={onRefreshUsage} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pt-1">
        {refreshable.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" disabled={refreshing} onClick={() => void refreshAll()}>
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} aria-hidden="true" />
            Refresh usage
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onOpenHarnessSettings}>
          <Settings2 className="size-3" aria-hidden="true" />
          Manage stack…
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => onOpenStackHistory(stack.id)}>
          <History className="size-3" aria-hidden="true" />
          Swap history
        </Button>
      </div>
    </section>
  );
}
