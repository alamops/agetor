import { useState } from "react";
import { Download, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import { AgentProfileCard } from "@/components/kanban/AgentProfileCard";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { BundleToolbar, useBundleList } from "@/components/bundle";
import { cn } from "@/lib/utils";

/** Render `p.taskCount` (server-derived, rides on the same `/agent-profiles`
 *  payload `useAgentProfiles` already fetches — no extra request) as the
 *  row's "Used by N task(s)" line. `undefined` (a payload from a server that
 *  predates this field) reads as 0 rather than blank. */
function taskCountLabel(taskCount: number | undefined): string {
  const n = taskCount ?? 0;
  if (n === 0) return "Not used by any task yet";
  return `Used by ${n} task${n === 1 ? "" : "s"}`;
}

interface Props {
  /** Live harness rows — resolves each row's icon/label (a live
   *  `AgentProfile` carries only a harness id, not its kind/label — see
   *  `AgentProfileCard`'s `resolveHarnessDisplay`). Passed down from
   *  `SettingsDialog`, which already loads them for the Harnesses section. */
  harnesses: Harness[];
  /** Open the create form — `SettingsDialog` navigates to its agent-editor
   *  subpage. */
  onAdd: () => void;
  /** Open the edit form for `profile` (same subpage, keyed on its id). */
  onEdit: (profile: AgentProfile) => void;
  /** Open the create form prefilled from `profile` (same subpage). */
  onDuplicate: (profile: AgentProfile) => void;
  /** After a bundle import — `SettingsDialog` reloads its harness list when
   *  the import enabled a harness. */
  onImported?: (result: { enabledHarnesses: string[] }) => void;
}

/**
 * Settings → Agents — the list of reusable {@link AgentProfile} launch
 * presets, with delete. List-only: Add, Edit and Duplicate hand off through
 * `onAdd` / `onEdit` / `onDuplicate` to `SettingsDialog`, which navigates its own agent-editor subpage
 * to `AgentProfileForm` (`@/components/kanban/AgentProfileFormDialog`, also
 * reused by a pipeline step's inline "New agent…" affordance via
 * `AgentProfileFormDialog`). Export/import (per-row Export, multi-select,
 * Export all, Import, and dropping a .json file onto the list) runs through
 * `useBundleList` — docs/plans/agents-pipelines-import-export.md C13.
 */
export function AgentProfilesSection({ harnesses, onAdd, onEdit, onDuplicate, onImported }: Props) {
  const { profiles, loading, error: loadError, refresh } = useAgentProfiles();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const confirm = useConfirm();
  const bundle = useBundleList({ ids: profiles.map((p) => p.id), kind: "agent", onImported });

  const remove = async (p: AgentProfile) => {
    const n = p.taskCount ?? 0;
    const ok = await confirm({
      title: `Delete agent "${p.name}"?`,
      description:
        n > 0
          ? `${n} task${n === 1 ? "" : "s"} are bound to it and keep their own frozen copy; they will show it as deleted.`
          : "Tasks that already used it keep their own copy.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setDeletingId(p.id);
    try {
      await api.deleteAgentProfile(p.id);
      await refresh();
      // No success toast — matches SavedPromptsSection/HarnessesSection: a
      // row disappearing from the list below is confirmation enough.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't delete "${p.name}"`, { description: message, duration: Infinity });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      data-testid="agent-profiles-section"
      data-dragging={bundle.dragging ? "" : undefined}
      className={cn("space-y-4 rounded-md pt-3 text-sm", bundle.dragging && "ring-2 ring-info ring-offset-2 ring-offset-card")}
      {...bundle.dropProps}
    >
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">Agents</label>
        <Button variant="outline" size="sm" data-testid="agent-profile-add" onClick={onAdd}>
          <Plus className="mr-1 size-3.5" /> Add agent
        </Button>
      </div>

      <BundleToolbar {...bundle.toolbarProps} />

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {loadError}
        </div>
      )}

      {!loading && (
        <div className="space-y-1.5">
          {profiles.map((p) => (
            <div
              key={p.id}
              data-testid="agent-profile-row"
              data-profile-id={p.id}
              className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2"
            >
              <input
                type="checkbox"
                data-testid="bundle-row-select"
                className="mt-1 size-3.5 shrink-0 accent-primary"
                checked={bundle.isSelected(p.id)}
                onChange={() => bundle.toggle(p.id)}
                aria-label={`Select ${p.name}`}
              />
              <div className="min-w-0 flex-1">
                <AgentProfileCard profile={p} harnesses={harnesses} variant="row" />
                <p data-testid="agent-profile-task-count" className="mt-1 text-xs text-muted-foreground">
                  {taskCountLabel(p.taskCount)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bundle-row-export"
                  title={`Export "${p.name}"`}
                  aria-label={`Export ${p.name}`}
                  onClick={() => bundle.exportOne(p.id)}
                >
                  <Download className="size-3.5" aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" data-testid="agent-profile-edit" onClick={() => onEdit(p)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" data-testid="agent-profile-duplicate" onClick={() => onDuplicate(p)}>
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="agent-profile-delete"
                  onClick={() => void remove(p)}
                  disabled={deletingId === p.id}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {profiles.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No agents yet. Bundle a harness, model, effort, and instructions into a reusable preset you can
              pick on task launch.
            </p>
          )}
        </div>
      )}
      {bundle.dialogs}
    </div>
  );
}
