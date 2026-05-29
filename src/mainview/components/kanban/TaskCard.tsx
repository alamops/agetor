import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, ArrowRight, CheckCircle2, FolderOpen, GitBranch, MessageCircleQuestion, Play, Square, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { abbreviateHome, cn } from "@/lib/utils";
import type { Task } from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";

interface Props {
  task: Task;
  homeDir: string;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
}

export function TaskCard({ task, homeDir, onStart, onCancel, onDelete, onOpen, onMarkDone, onArchive, onUnarchive }: Props) {
  const archived = task.archivedAt != null;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first.
    disabled: archived,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  // Button precedence: Answer > Stop > Open > Run.
  //  - Answer when at least one interaction (ask_user / AskUserQuestion /
  //    ExitPlanMode / tool-approval) is pending OR codex flipped the task to
  //    `blocked` via the approval-prompt heuristic. Opens the run panel; Stop
  //    moves to a trailing icon slot so the user can still cancel.
  //  - Stop while the agent process is live (running OR blocked-awaiting-user).
  //  - Open once any run has reached succeeded/running/orphaned — there's
  //    something worth re-reading; Run stays reachable from inside the panel.
  //  - Run otherwise (no openable history yet, or only failed/cancelled).
  const active = task.column === "running" || task.column === "blocked";
  const openable = task.hasOpenableRun;
  // Combine structured interactions with codex's narrative `blocked` signal.
  // The latter has no answerable payload — the user resolves it from the run
  // panel — but it represents the same "waiting on you" state to the user.
  // When the only signal is `blocked` (no structured questions), we label the
  // call-to-action "Review" instead of "Answer" to avoid promising a Q&A flow
  // the panel can't deliver.
  const pendingCount = task.pendingInteractionCount;
  const blocked = task.column === "blocked";
  const awaiting = pendingCount > 0 || blocked;
  const awaitingLabel =
    pendingCount > 1 ? `Answer (${pendingCount})`
    : pendingCount === 1 ? "Answer"
    : "Review";

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "cursor-grab select-none border-border/60 hover:border-border transition-colors",
        isDragging && "opacity-50",
        awaiting && "ring-2 ring-amber-500/60 ring-offset-2 ring-offset-background animate-awaiting-pulse motion-reduce:animate-none",
        archived && "cursor-default opacity-60",
      )}
      onClick={() => onOpen(task)}
      {...listeners}
      {...attributes}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm">{task.title}</CardTitle>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant="secondary" className="gap-1">
              <AgentIcon kind={task.agent} className="size-3" />
              {task.agent}
            </Badge>
            {(task.model || task.mode) && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {[task.model, task.mode].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground line-clamp-2">{task.prompt}</p>
        <p
          className="text-[10px] text-muted-foreground/70 font-mono truncate"
          title={task.workdir}
        >
          {abbreviateHome(task.workdir, homeDir)}
        </p>
        {(task.branch || task.baseRef) && (
          <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">
              {task.branch ?? "(not yet created)"}
              {task.baseRef && (
                <span className="ml-1 opacity-70">· {task.baseRef.slice(0, 7)}</span>
              )}
            </span>
          </div>
        )}
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {archived ? (
            <Button size="sm" variant="secondary" onClick={() => onOpen(task)}>
              <FolderOpen className="size-3" /> Open
            </Button>
          ) : awaiting ? (
            <Button
              size="sm"
              className="gap-1 bg-amber-500 text-amber-950 hover:bg-amber-500/90 focus-visible:ring-amber-500"
              onClick={() => onOpen(task)}
              title={pendingCount > 0 ? "Open run panel to answer" : "Agent is waiting on you — open the run panel"}
            >
              <MessageCircleQuestion className="size-3" />
              {awaitingLabel}
              <ArrowRight className="size-3" />
            </Button>
          ) : active ? (
            <Button size="sm" variant="destructive" onClick={() => onCancel(task)}>
              <Square className="size-3" /> Stop
            </Button>
          ) : openable ? (
            <Button size="sm" variant="secondary" onClick={() => onOpen(task)}>
              <FolderOpen className="size-3" /> Open
            </Button>
          ) : (
            <Button size="sm" onClick={() => onStart(task)}>
              <Play className="size-3" /> Run
            </Button>
          )}
          {!archived && awaiting && active && (
            <Button size="icon" variant="ghost" onClick={() => onCancel(task)} title="Stop">
              <Square className="size-3" />
            </Button>
          )}
          {!archived && task.column === "review" && (
            <Button size="sm" variant="outline" onClick={() => onMarkDone(task)} title="Mark this task as done">
              <CheckCircle2 className="mr-1 size-3" /> Done
            </Button>
          )}
          {!archived && task.column === "done" && (
            <Button size="icon" variant="ghost" onClick={() => onArchive(task)} title="Archive task">
              <Archive className="size-3" />
            </Button>
          )}
          {archived && (
            <Button size="icon" variant="ghost" onClick={() => onUnarchive(task)} title="Unarchive task">
              <ArchiveRestore className="size-3" />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => onDelete(task)} title="Delete task">
            <Trash2 className="size-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
