import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import { AgentProfileCard } from "@/components/kanban/AgentProfileCard";
import { useAgentProfiles } from "@/lib/agent-profiles";

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
}

/**
 * Settings → Agents — the list of reusable {@link AgentProfile} launch
 * presets, with delete. List-only: Add and Edit hand off through `onAdd` /
 * `onEdit` to `SettingsDialog`, which navigates its own agent-editor subpage
 * to `AgentProfileForm` (`@/components/kanban/AgentProfileFormDialog`, also
 * reused by a pipeline step's inline "New agent…" affordance via
 * `AgentProfileFormDialog`).
 */
export function AgentProfilesSection({ harnesses, onAdd, onEdit }: Props) {
  const { profiles, loading, error: loadError, refresh } = useAgentProfiles();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const confirm = useConfirm();

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
    <div data-testid="agent-profiles-section" className="space-y-4 pt-3 text-sm">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">Agents</label>
        <Button variant="outline" size="sm" data-testid="agent-profile-add" onClick={onAdd}>
          <Plus className="mr-1 size-3.5" /> Add agent
        </Button>
      </div>

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
              <div className="min-w-0 flex-1">
                <AgentProfileCard profile={p} harnesses={harnesses} variant="row" />
                <p data-testid="agent-profile-task-count" className="mt-1 text-xs text-muted-foreground">
                  {taskCountLabel(p.taskCount)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                <Button size="sm" variant="ghost" data-testid="agent-profile-edit" onClick={() => onEdit(p)}>
                  Edit
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
    </div>
  );
}
