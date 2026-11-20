import { Bot, ListTodo, Paperclip, PauseCircle, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCountdown, fxPausedBadgeText, fxPausedBadgeTitle } from "@/lib/fx-auto-resume";
import { activeCooldown, resolvedTaskModel, stackBadgeStateFor } from "@/lib/stack-badge";
import type { HarnessLimitState, HarnessStack, Task } from "../../../shared/types.ts";
import { asAgentKind, modelDisplayName } from "../../../shared/model-display.ts";
import { isTaskFxPaused } from "../../../shared/fx-recovery.ts";
import { sentFileBasename } from "../../../shared/sent-files.ts";
import { AgentIcon } from "./AgentIcon";
import { CardChip, CardStat } from "./CardChip";
import { StackBadge } from "./StackBadge";

/**
 * The line under the title that says who is doing the work: agent (or the
 * saved profile's name), model and mode, as ONE truncating text span. It has
 * no fixed slot and no sibling that must stay visible, so a 25-character
 * profile name and a 38-character model can never push anything out of the
 * card (the header-overflow bug this replaced). A pipeline parent names no
 * agent: the profile is per step, so only the model and mode remain.
 */
export function TaskCardIdentity({ task }: { task: Task }) {
  // `pipelineId`, not `pipelineRun`: a pipeline parent that has never run has
  // no run yet, and still names no agent (as `taskActionFlags` decides).
  const isPipeline = task.pipelineId != null;
  const kind = task.agentProfile?.harnessKind ?? asAgentKind(task.agent);
  const name = isPipeline ? null : (task.agentProfile?.name ?? task.agent);
  const detail = [task.model ? modelDisplayName(kind, task.model) : null, task.mode].filter(Boolean).join(" · ");
  if (!name && !detail) return null;
  const text = [name, detail].filter(Boolean).join(" · ");
  return (
    <div data-part="identity" className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground" title={text}>
      {name && <AgentIcon kind={task.agentProfile?.harnessKind ?? task.agent} className="size-3 shrink-0" />}
      <span className="min-w-0 truncate">
        {name && (
          <>
            <span
              className="font-medium text-foreground"
              // The profile name carries the harness id as its tooltip, as the
              // old badge did; a plain agent has no profile test id.
              data-testid={task.agentProfile ? "task-card-agent-profile" : undefined}
              title={task.agentProfile ? task.agent : undefined}
            >
              {name}
            </span>
            {detail && <span aria-hidden="true"> · </span>}
          </>
        )}
        {detail && <span className="font-mono text-[10px]">{detail}</span>}
      </span>
    </div>
  );
}

/**
 * The status row: quiet counts (icon + number) first, then the chips that
 * carry a colour meaning (account stack, fx pause). Renders nothing, and takes
 * no gap, when the task has none of them.
 */
export function TaskCardStatus({ task, stacks, limitStates }: { task: Task; stacks: HarnessStack[]; limitStates: HarnessLimitState[] }) {
  // Called unconditionally so hook order is stable whether or not this task is
  // paused right now; it ticks only while an auto-resume time is set.
  const fxAutoResumeCountdown = useCountdown(task.fxRecovery?.autoResume?.at ?? null);
  // Model-aware: a per-model cooldown row counts only for the model this task
  // resolves to; an account-wide row always counts.
  const cooldown = activeCooldown(limitStates, task.agent, resolvedTaskModel(task, stacks), Date.now());
  const subagents = task.runningSubagents ?? 0;
  const todo = task.todoProgress && task.todoProgress.total > 0 ? task.todoProgress : null;
  const sent = task.sentFiles && task.sentFiles.length > 0 ? task.sentFiles : null;
  return (
    <div
      data-part="status"
      // Sits 4 px under the identity line (the card's 8 px gap minus 4), and
      // takes no gap at all when it is empty and hidden.
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 empty:hidden [[data-part=identity]+&]:-mt-1"
    >
      {subagents > 0 && (
        <CardStat icon={Bot} title={`${subagents} background task${subagents > 1 ? "s" : ""} running`}>
          {subagents}
        </CardStat>
      )}
      {task.openTerminalCount > 0 && (
        <CardStat icon={Terminal} title={`${task.openTerminalCount} open terminal${task.openTerminalCount > 1 ? "s" : ""}`}>
          {task.openTerminalCount}
        </CardStat>
      )}
      {todo && (
        <CardStat
          icon={ListTodo}
          className={cn(todo.completed === todo.total && "text-success")}
          title={`${todo.completed} of ${todo.total} tasks done`}
        >
          {todo.completed}/{todo.total}
        </CardStat>
      )}
      {sent && (
        <CardStat
          icon={Paperclip}
          data-testid="sent-files-badge"
          title={`${sent.length} file${sent.length === 1 ? "" : "s"} sent · ${[...sent]
            .sort((a, b) => b.sentAt - a.sentAt)
            .slice(0, 5)
            .map((f) => sentFileBasename(f.path))
            .join(", ")}`}
        >
          {sent.length}
        </CardStat>
      )}
      <StackBadge
        state={stackBadgeStateFor(task, stacks)}
        coolingUntilMs={cooldown?.exhaustedUntilMs ?? null}
        coolingModel={cooldown?.model ?? null}
        running={task.column === "running"}
      />
      {/* fx's response is paused on a resumable Gateway checkpoint
       *  (`Task.fxRecovery`, server-managed). Gated on the shared
       *  `isTaskFxPaused`, never on `task.agent`. Text and title come from
       *  `@/lib/fx-auto-resume`: "paused" or a live "auto-resume m:ss". */}
      {isTaskFxPaused(task) && task.fxRecovery && (
        <CardChip tone="warning" data-testid="fx-paused-badge" title={fxPausedBadgeTitle(task.fxRecovery)}>
          <PauseCircle className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{fxPausedBadgeText(task.fxRecovery, fxAutoResumeCountdown)}</span>
        </CardChip>
      )}
    </div>
  );
}
