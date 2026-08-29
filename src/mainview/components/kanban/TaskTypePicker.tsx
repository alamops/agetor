import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { TASK_TYPES, type TaskType } from "../../../shared/types.ts";

/**
 * The Type grid — Task / Bug / Spike buttons, each with its icon and hint
 * tooltip. Lifted verbatim out of `NewTaskForm.tsx` (its original home) so
 * `CreateTaskFromIssueDialog` can reuse the exact same control (seeded from
 * the issue's labels via `inferTaskTypeFromLabels`, see `issue-task.ts`)
 * without the two surfaces drifting.
 */
export function TaskTypePicker({
  value,
  onChange,
  className,
}: {
  value: TaskType;
  onChange: (t: TaskType) => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)} data-testid="task-type-picker">
      <label className="text-muted-foreground">Type</label>
      <div className="grid grid-cols-3 gap-1">
        {TASK_TYPES.map((t) => {
          const Icon = taskTypeIcon(t.icon);
          const selected = value === t.id;
          return (
            <Button
              key={t.id}
              size="sm"
              variant={selected ? "default" : "outline"}
              onClick={() => onChange(t.id)}
              title={t.hint}
              className="justify-start"
            >
              <Icon className={cn("mr-1 size-3.5", !selected && t.iconClass)} />
              <span className="truncate">{t.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
