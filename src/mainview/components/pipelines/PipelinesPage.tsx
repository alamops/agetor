import { useState } from "react";
import { ArrowLeft, Copy, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { usePipelines } from "@/lib/pipelines";
import { api, ApiError } from "@/lib/api";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type { Pipeline } from "../../../shared/types.ts";

interface PipelinesPageProps {
  onOpenEditor: (id: string | null) => void;
  onBack: () => void;
}

/**
 * The pipelines list — one board-agnostic full-page view (D5,
 * `docs/plans/pipelines.md`) for creating, editing, duplicating, and
 * deleting {@link Pipeline}s. Editing itself happens in {@link
 * PipelineEditor}, opened via `onOpenEditor`.
 */
export function PipelinesPage({ onOpenEditor, onBack }: PipelinesPageProps) {
  const { pipelines, loading, error, refresh } = usePipelines();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleDuplicate = async (pipeline: Pipeline) => {
    setBusyId(pipeline.id);
    setActionError(null);
    try {
      const name = duplicateName(pipeline.name, pipelines);
      await api.createPipeline({
        name,
        description: pipeline.description,
        graph: pipeline.graph,
        maxSteps: pipeline.maxSteps,
      });
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to duplicate pipeline.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (pipeline: Pipeline) => {
    const ok = await confirm({
      title: `Delete "${pipeline.name}"?`,
      description:
        (pipeline.taskCount ?? 0) > 0
          ? `Used by ${pipeline.taskCount} task(s). Deleting it never affects tasks that already ran — they keep their frozen snapshot — but no new run can be started from it.`
          : "This can't be undone.",
      confirmLabel: "Delete pipeline",
      variant: "destructive",
    });
    if (!ok) return;
    setBusyId(pipeline.id);
    setActionError(null);
    try {
      await api.deletePipeline(pipeline.id);
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete pipeline.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" data-testid="pipelines-back" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <Workflow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          Pipelines
        </h1>
        <Button type="button" size="sm" data-testid="pipelines-new" onClick={() => onOpenEditor(null)} className="gap-1.5">
          <Plus className="size-4" aria-hidden />
          New pipeline
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {actionError && (
          <p data-testid="pipelines-error" className="mb-3 text-xs text-danger">
            {actionError}
          </p>
        )}
        {error && (
          <p data-testid="pipelines-load-error" className="mb-3 text-xs text-danger">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading pipelines…</p>
        ) : pipelines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
            <Workflow className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">No pipelines yet.</p>
            <Button type="button" size="sm" onClick={() => onOpenEditor(null)} className="gap-1.5">
              <Plus className="size-4" aria-hidden />
              Create your first pipeline
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pipelines.map((pipeline) => (
              <li
                key={pipeline.id}
                data-testid="pipelines-row"
                data-pipeline-id={pipeline.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpenEditor(pipeline.id)}
                    className="truncate text-left text-sm font-medium hover:underline"
                    title={pipeline.name}
                  >
                    {pipeline.name}
                  </button>
                  {pipeline.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{pipeline.description}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pipeline.graph.steps.length} step{pipeline.graph.steps.length === 1 ? "" : "s"} · Used by{" "}
                    {pipeline.taskCount ?? 0} task{(pipeline.taskCount ?? 0) === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Edit"
                    data-testid="pipelines-edit"
                    disabled={busyId === pipeline.id}
                    onClick={() => onOpenEditor(pipeline.id)}
                    className="size-8"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Duplicate"
                    data-testid="pipelines-duplicate"
                    disabled={busyId === pipeline.id}
                    onClick={() => void handleDuplicate(pipeline)}
                    className="size-8"
                  >
                    <Copy className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Delete"
                    data-testid="pipelines-delete"
                    disabled={busyId === pipeline.id}
                    onClick={() => void handleDelete(pipeline)}
                    className="size-8 text-danger hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** " (copy)" / " (copy 2)" / … suffix, capped at `PIPELINE_LIMITS.name`, that
 *  avoids colliding with an existing pipeline name (case-insensitive,
 *  trimmed — matching the server's own uniqueness rule). */
function duplicateName(base: string, existing: Pipeline[]): string {
  const used = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  const truncate = (s: string) => s.slice(0, PIPELINE_LIMITS.name);
  let candidate = truncate(`${base} (copy)`);
  if (!used.has(candidate.toLowerCase())) return candidate;
  let n = 2;
  do {
    candidate = truncate(`${base} (copy ${n})`);
    n += 1;
  } while (used.has(candidate.toLowerCase()) && n < 1000);
  return candidate;
}
