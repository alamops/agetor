import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ColumnId, Task } from "../../../shared/types.ts";
import { TaskCard } from "./TaskCard";

interface Props {
  id: ColumnId;
  label: string;
  tasks: Task[];
  homeDir: string;
  onStart: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
}

/** Array is considered unchanged when same length and every element is the
 *  same object reference at the same index. Relies on the caller (App.tsx's
 *  `reconcileById`) preserving task identity across polls for tasks that
 *  didn't actually change — that's what lets an unaffected column bail out
 *  below even though `visibleTasks.filter(...)` in App.tsx produces a new
 *  array reference on every render. */
function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

function ColumnImpl({ id, label, tasks, homeDir, onStart, onCancel, onDelete, onOpen, onDiff, onMarkDone, onArchive, onUnarchive }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-3 rounded-lg border border-border/40 bg-muted/30 p-3",
        isOver && "border-primary/60 bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <Badge variant="outline">{tasks.length}</Badge>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            homeDir={homeDir}
            onStart={onStart}
            onCancel={onCancel}
            onDelete={onDelete}
            onOpen={onOpen}
            onDiff={onDiff}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        ))}
      </div>
    </div>
  );
}

/** Custom comparator instead of the default shallow-props compare: `tasks`
 *  is an array, so the default `Object.is` per-prop check would see a new
 *  reference on every render (App.tsx's `visibleTasks.filter(...)` always
 *  allocates a fresh array) and re-render every column on every tick. With
 *  `sameTasks` doing an element-wise identity check instead, a column whose
 *  member tasks are all reference-unchanged bails out — so a single task
 *  update (which only changes that one task's object identity, per
 *  App.tsx's `reconcileById`) only re-renders the column(s) that actually
 *  contain the changed task. */
export const Column = memo(ColumnImpl, (prev, next) => (
  prev.id === next.id &&
  prev.label === next.label &&
  prev.homeDir === next.homeDir &&
  prev.onStart === next.onStart &&
  prev.onCancel === next.onCancel &&
  prev.onDelete === next.onDelete &&
  prev.onOpen === next.onOpen &&
  prev.onDiff === next.onDiff &&
  prev.onMarkDone === next.onMarkDone &&
  prev.onArchive === next.onArchive &&
  prev.onUnarchive === next.onUnarchive &&
  sameTasks(prev.tasks, next.tasks)
));
