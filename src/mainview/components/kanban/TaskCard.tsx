import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, GitBranch, Play, Square, Trash2 } from "lucide-react";
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
}

export function TaskCard({ task, homeDir, onStart, onCancel, onDelete, onOpen }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  // Button precedence: Stop > Open > Run.
  //  - Stop while the agent process is live (running OR blocked-awaiting-user).
  //  - Open once any run has reached succeeded/running/orphaned — there's
  //    something worth re-reading; Run stays reachable from inside the panel.
  //  - Run otherwise (no openable history yet, or only failed/cancelled).
  const active = task.column === "running" || task.column === "blocked";
  const openable = task.hasOpenableRun;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "cursor-grab select-none border-border/60 hover:border-border transition-colors",
        isDragging && "opacity-50",
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
          {active ? (
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
          <Button size="icon" variant="ghost" onClick={() => onDelete(task)} title="Delete task">
            <Trash2 className="size-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
