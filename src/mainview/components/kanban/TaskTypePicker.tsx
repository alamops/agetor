import { SegmentedControl } from "@/components/ui/segmented-control";
import { Label } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { TASK_TYPES, type TaskType } from "../../../shared/types.ts";

/**
 * The Type control — Task / Bug / Spike as a radiogroup, each with its icon and
 * hint tooltip. Shared by the New Task panel and `CreateTaskFromIssueDialog`
 * (seeded from the issue's labels via `inferTaskTypeFromLabels`, see
 * `issue-task.ts`) so the two surfaces don't drift.
 */
export function TaskTypePicker({
  value,
  onChange,
  className,
  disabled,
}: {
  value: TaskType;
  onChange: (t: TaskType) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label id="task-type-picker-label">Type</Label>
      <div data-testid="task-type-picker">
        <SegmentedControl
          aria-labelledby="task-type-picker-label"
          value={value}
          onChange={(v) => onChange(v as TaskType)}
          disabled={disabled}
          items={TASK_TYPES.map((t) => {
            const Icon = taskTypeIcon(t.icon);
            return {
              value: t.id,
              label: t.label,
              title: t.hint,
              testId: `task-type-${t.id}`,
              icon: <Icon className={cn("size-3.5", value !== t.id && t.iconClass)} />,
            };
          })}
        />
      </div>
    </div>
  );
}
