import { useState } from "react";
import { ExternalLink, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { usePipelines } from "@/lib/pipelines";
import { api, ApiError } from "@/lib/api";
import type { Pipeline } from "../../../shared/types.ts";

interface Props {
  /** Navigate the app-level `view` to the pipelines page — `id: null` +
   *  `editing: false` for the list ("Open pipelines page"), or `id` +
   *  `editing: true` for a specific pipeline's editor ("Edit"/"New
   *  pipeline"). The caller (App.tsx) also closes the Settings dialog. */
  onOpenPipelines: (id: string | null, editing: boolean) => void;
}

/**
 * Settings → Pipelines — a lightweight list (name, step count, "used by N
 * task(s)", Edit, Delete) that hands off to the full-page canvas editor for
 * actual editing (T8, `docs/plans/pipelines.md`). Mirrors
 * `AgentProfilesSection`'s CRUD posture but doesn't render the editor
 * inline — the editor is a full-page React Flow canvas, not a form that
 * fits in the Settings pane.
 */
export function PipelinesSection({ onOpenPipelines }: Props) {
  const { pipelines, loading, error: loadError, refresh } = usePipelines();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (p: Pipeline) => {
    const n = p.taskCount ?? 0;
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      description:
        n > 0
          ? `Used by ${n} task(s). Deleting it never affects tasks that already ran — they keep their frozen snapshot — but no new run can be started from it.`
          : "This can't be undone.",
      confirmLabel: "Delete pipeline",
      variant: "destructive",
    });
    if (!ok) return;
    setBusyId(p.id);
    setActionError(null);
    try {
      await api.deletePipeline(p.id);
      await refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Failed to delete pipeline.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div data-testid="pipelines-section" className="space-y-4 pt-3 text-sm">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">Pipelines</label>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid="pipelines-section-open"
            onClick={() => onOpenPipelines(null, false)}
            className="gap-1"
          >
            <ExternalLink className="size-3.5" /> Open pipelines page
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="pipelines-section-new"
            onClick={() => onOpenPipelines(null, true)}
          >
            <Plus className="mr-1 size-3.5" /> New pipeline
          </Button>
        </div>
      </div>

      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      {loadError && <p className="text-xs text-danger">{loadError}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading pipelines…</p>
      ) : pipelines.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
          <Workflow className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-xs text-muted-foreground">No pipelines yet.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pipelines.map((p) => (
            <li
              key={p.id}
              data-testid="pipelines-section-row"
              data-pipeline-id={p.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              <Workflow className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onOpenPipelines(p.id, true)}
                  className="truncate text-left text-sm font-medium hover:underline"
                  title={p.name}
                >
                  {p.name}
                </button>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {p.graph.steps.length} step{p.graph.steps.length === 1 ? "" : "s"} · Used by{" "}
                  {p.taskCount ?? 0} task{(p.taskCount ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Edit"
                  data-testid="pipelines-section-edit"
                  disabled={busyId === p.id}
                  onClick={() => onOpenPipelines(p.id, true)}
                  className="size-8"
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Delete"
                  data-testid="pipelines-section-delete"
                  disabled={busyId === p.id}
                  onClick={() => void remove(p)}
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
  );
}
