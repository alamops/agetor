import { memo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, ArrowRight, Bot, CheckCircle2, FolderOpen, GitBranch, GitCompare, ListTodo, MessageCircleQuestion, Play, Square, Terminal, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { abbreviateHome, cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { taskTypeMeta, type Task } from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";

interface Props {
  task: Task;
  homeDir: string;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** True when this task is the one currently open in the run panel — App.tsx
   *  passes `task.id === selected?.id`. Suppresses the unread dot while the
   *  user is actively watching the task (messages streamed while open are
   *  marked seen on close, not shown as unread in the meantime). */
  isOpen?: boolean;
  /** Right-click (or keyboard menu-key) on the card. `pos` is where App.tsx's
   *  task context menu should anchor — omitted entirely when the caller
   *  doesn't wire it up (no menu to open). */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
}

function TaskCardImpl({ task, homeDir, onStart, onCancel, onDelete, onOpen, onDiff, onMarkDone, onArchive, onUnarchive, isOpen, onContextMenu }: Props) {
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
  //  - Answer when at least one interaction (AskUserQuestion / ExitPlanMode /
  //    tool-approval) is pending OR codex flipped the task to
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

  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);
  const runningSubagents = task.runningSubagents ?? 0;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative cursor-grab select-none border-border/60 border-l-4 hover:border-border transition-colors",
        type.borderClass,
        isDragging && "opacity-50",
        awaiting && "ring-2 ring-warning/60 ring-offset-2 ring-offset-background animate-awaiting-pulse motion-reduce:animate-none",
        archived && "cursor-default opacity-60",
      )}
      // `onClick` (open) stays untouched by the addition below — a
      // right-click never opens the panel, only `onContextMenu` fires for it.
      onClick={() => onOpen(task)}
      // dnd-kit's `useDraggable` above is unaffected by right-click: its
      // `PointerSensor` bails on `event.button !== 0`, so a right-click can
      // never arm a drag — `{...listeners}` and this handler don't fight.
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onContextMenu) return;
        // Keyboard-invoked context menus (Shift+F10 / the menu key) report
        // clientX/Y = 0,0 — anchor those to the card instead of the
        // viewport corner.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(task, fromKeyboard ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY });
      }}
      // The card is focusable (dnd-kit's `attributes` below add
      // `tabIndex=0`), so a right-click would otherwise focus it and WebKit
      // scrolls a partially-visible card into view inside `.kanban-scroll`;
      // the board would visibly jump (and focus would land on the card)
      // under the freshly-opened menu. Only suppress the default for the
      // right button — left-click focus/drag
      // behavior (dnd-kit's `PointerSensor`, wired via `{...listeners}`
      // below as `onPointerDown`, so there's no prop collision here) is
      // untouched, and `contextmenu` still fires after a default-prevented
      // `mousedown`.
      onMouseDown={(e) => {
        if (e.button === 2) e.preventDefault();
      }}
      {...listeners}
      {...attributes}
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet" —
        // deliberately unanimated (the amber awaiting-pulse ring is the only
        // animated attention state). Pinned to the corner so it coexists
        // with that ring (an outline) without visual conflict, and sits
        // above the header badge stack in the DOM/paint order.
        <span
          // -1.5 offsets keep the dot's background halo clear of the
          // awaiting state's ring-offset outline instead of notching it.
          className="absolute -top-1.5 -right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"
          title="New messages"
          role="img"
          aria-label="New messages"
        />
      )}
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <TypeIcon
              className={cn("mt-0.5 size-3.5 shrink-0", type.iconClass)}
              aria-label={type.label}
            />
            <CardTitle className="text-sm min-w-0 flex-1 break-words">{task.title}</CardTitle>
          </div>
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
            {task.openTerminalCount > 0 && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px]"
                title={`${task.openTerminalCount} open terminal${task.openTerminalCount > 1 ? "s" : ""}`}
              >
                <Terminal className="size-3" />
                {task.openTerminalCount}
              </Badge>
            )}
            {runningSubagents > 0 && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px]"
                title={`${runningSubagents} background task${runningSubagents > 1 ? "s" : ""} running`}
              >
                <Bot className="size-3" />
                {runningSubagents}
              </Badge>
            )}
            {task.todoProgress && task.todoProgress.total > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 text-[10px]",
                  task.todoProgress.completed === task.todoProgress.total
                    ? "text-success"
                    : "text-muted-foreground",
                )}
                title={`${task.todoProgress.completed} of ${task.todoProgress.total} tasks done`}
              >
                <ListTodo className="size-3" />
                {task.todoProgress.completed}/{task.todoProgress.total}
              </Badge>
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
          {!archived && (task.column === "done" || active) && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onArchive(task)}
              title={active ? "Stop the running agent and archive task" : "Archive task"}
            >
              <Archive className="size-3" />
            </Button>
          )}
          {archived && (
            <Button size="icon" variant="ghost" onClick={() => onUnarchive(task)} title="Unarchive task">
              <ArchiveRestore className="size-3" />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => onDiff(task)} title="View changes (git diff)">
            <GitCompare className="size-3" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => onDelete(task)} title="Delete task">
            <Trash2 className="size-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, and every other prop is either a primitive (`homeDir`) or a
// `useCallback`-stabilized handler. dnd-kit's `useDraggable` lives inside
// the component body, so memoizing the outer function doesn't interfere
// with drag state — that's driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
