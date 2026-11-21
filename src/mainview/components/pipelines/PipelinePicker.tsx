import { useMemo } from "react";
import { Workflow, X } from "lucide-react";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import type { Pipeline } from "../../../shared/types.ts";

interface PipelinePickerProps {
  /** Selected pipeline id, or `null` for "No pipeline". */
  value: string | null;
  onChange: (id: string | null) => void;
  pipelines: Pipeline[];
  /** Renders a "Manage pipelines…" footer row; omit to hide it. */
  onManage?: () => void;
  disabled?: boolean;
  className?: string;
  /** `id` of the trigger, so a `<label htmlFor>` names the control. */
  id?: string;
  labelId?: string;
  "aria-describedby"?: string;
}

const NONE = "";

/**
 * Controlled pipeline picker, built on the launch surfaces' one `Picker` — a
 * trigger (the selected pipeline's name, or the "No pipeline" placeholder) plus
 * a searchable listbox of every pipeline. Picking a pipeline is the launch
 * form's "one selection" replacement for the manual agent picker (D1,
 * `docs/plans/pipelines.md`). The part test ids (`pipeline-picker-trigger|
 * popover|search|none|row|clear|manage`) are unchanged from the hand-rolled
 * version this replaced; `pipelines/StepPanel.tsx` shares the component.
 */
export function PipelinePicker({
  value,
  onChange,
  pipelines,
  onManage,
  disabled,
  className,
  id,
  labelId,
  "aria-describedby": describedBy,
}: PipelinePickerProps) {
  const selectedPipeline = value ? (pipelines.find((p) => p.id === value) ?? null) : null;
  const items = useMemo<PickerItem[]>(
    () => [
      { value: NONE, label: "No pipeline", testId: "pipeline-picker-none", searchText: "none no pipeline" },
      ...pipelines.map((p) => ({
        value: p.id,
        label: p.name,
        hint: `${p.graph.steps.length} step${p.graph.steps.length === 1 ? "" : "s"}`,
        testId: "pipeline-picker-row",
        dataAttrs: { "data-pipeline-id": p.id },
        searchText: p.description,
      })),
    ],
    [pipelines],
  );
  const byId = useMemo(() => new Map(pipelines.map((p) => [p.id, p])), [pipelines]);

  return (
    <div data-testid="pipeline-picker" className={cn("flex items-center gap-1", className)}>
      <Picker
        className="min-w-0 flex-1"
        partsTestId="pipeline-picker"
        id={id}
        aria-describedby={describedBy}
        aria-label="Pipeline"
        labelId={labelId}
        value={value ?? NONE}
        onChange={(v) => onChange(v === NONE ? null : v)}
        items={items}
        searchable
        emptyLabel="No matches."
        trailing={pipelines.length === 0 ? "No pipelines yet." : undefined}
        disabled={disabled}
        renderValue={() =>
          selectedPipeline ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Workflow className="size-4 shrink-0 text-info" aria-hidden />
              <span className="truncate">{selectedPipeline.name}</span>
            </span>
          ) : value ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning">
              <Workflow className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Selected pipeline is no longer available</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Workflow className="size-4 shrink-0" aria-hidden />
              <span className="truncate">No pipeline</span>
            </span>
          )
        }
        renderItem={(item) => {
          const p = byId.get(item.value);
          return p ? (
            <span className="flex items-start gap-1.5">
              <Workflow className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Workflow className="size-4 shrink-0" aria-hidden />
              No pipeline
            </span>
          );
        }}
        footer={
          onManage
            ? (close) => (
                <button
                  type="button"
                  data-testid="pipeline-picker-manage"
                  disabled={disabled}
                  onClick={() => {
                    close();
                    onManage();
                  }}
                  className="h-8 w-full rounded-sm px-2.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                >
                  Manage pipelines…
                </button>
              )
            : undefined
        }
      />
      {value && (
        <button
          type="button"
          data-testid="pipeline-picker-clear"
          onClick={() => onChange(null)}
          disabled={disabled}
          title="Clear pipeline"
          aria-label="Clear pipeline"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
