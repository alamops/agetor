import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { AGENT_PROFILE_LIMITS } from "../../../shared/agent-profile.ts";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import { AgentProfileCard } from "@/components/kanban/AgentProfileCard";
import { SkillsPicker } from "@/components/kanban/SkillsPicker";
import { TaskLaunchPickers, useTaskLaunch, type TaskLaunch } from "@/components/kanban/TaskLaunchPickers";
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
}

/** Local edit-buffer shape for the inline create/edit form — the two fields
 *  `TaskLaunchPickers` doesn't own (name, and the composition-only
 *  instructions/skills pair; harness/mode/model/effort/fast/maxMode live on
 *  the `useTaskLaunch` hook below instead of being duplicated here). */
interface FormState {
  id: string | null;
  name: string;
  instructions: string;
  skills: string[];
}

/**
 * Settings → Agents — CRUD for reusable {@link AgentProfile} launch presets.
 * Mirrors `SavedPromptsSection`'s shape (load/save/delete, a single inline
 * form shared by create and edit) but the harness/mode/model/effort/fast/
 * maxMode fields are delegated entirely to `useTaskLaunch` +
 * `<TaskLaunchPickers hideProfilePicker />` (plan D9) rather than a second
 * hand-rolled picker block — editing seeds the hook via `useTaskLaunch`'s
 * `opts.initial` (see `editingProfile` below), not a second effect racing
 * the hook's own open-effect (that used to be a real bug — see the comment
 * on `TaskLaunchPickers`'s `initial` option for the full race).
 */
export function AgentProfilesSection({ harnesses }: Props) {
  const { profiles, loading, error: loadError, refresh } = useAgentProfiles();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const confirm = useConfirm();

  // The profile being edited, resolved synchronously from the already-
  // loaded `profiles` list (the rows below are rendered from it, so it's
  // guaranteed loaded before an Edit button exists to click) — `null` for
  // a create form or while no form is open. Passed straight into
  // `useTaskLaunch` as `opts.initial` so the hook's own open-effect seeds
  // from it directly, in the SAME render where `form`/`open` transition,
  // instead of via a second effect that raced the hook's async harness
  // fetch (the bug this replaces — see `TaskLaunchPickers`'s `initial` doc
  // comment for the full race). `editingProfile` and `open` change
  // identity together in that one render, so the hook's effect body
  // (which reads `initial` from its closure, not from a dep-array entry)
  // always captures the matching value.
  const editingProfile = form && form.id !== null ? (profiles.find((p) => p.id === form.id) ?? null) : null;

  // The form's own picker state — fetches harnesses only while a form is
  // actually open, mirrors `ResolveConflictsDialog`'s `useTaskLaunch(open)`.
  // `withProfiles: false` — this hook backs the *editor* for a profile, not
  // a picker over profiles, so it never needs its own `GET /agent-profiles`.
  const launch = useTaskLaunch(form !== null, {
    withProfiles: false,
    initial: editingProfile
      ? {
          agent: editingProfile.harness,
          mode: editingProfile.mode,
          model: editingProfile.model,
          effort: editingProfile.effort,
          fast: editingProfile.fast,
          maxMode: editingProfile.maxMode,
        }
      : undefined,
  });

  const openCreate = () => setForm({ id: null, name: "", instructions: "", skills: [] });
  const openEdit = (p: AgentProfile) =>
    setForm({ id: p.id, name: p.name, instructions: p.instructions, skills: p.skills });
  const closeForm = () => {
    setForm(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = {
        name,
        harness: launch.agent,
        model: launch.model,
        effort: launch.effort,
        mode: launch.mode,
        fast: launch.fast,
        maxMode: launch.maxMode,
        instructions: form.instructions,
        skills: form.skills,
      };
      form.id ? await api.updateAgentProfile(form.id, input) : await api.createAgentProfile(input);
      await refresh();
      closeForm();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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
        {!form && (
          <Button variant="outline" size="sm" data-testid="agent-profile-add" onClick={openCreate}>
            <Plus className="mr-1 size-3.5" /> Add agent
          </Button>
        )}
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
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="agent-profile-edit"
                  onClick={() => openEdit(p)}
                  disabled={form !== null}
                >
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

      {form && (
        <AgentProfileForm
          form={form}
          onChange={setForm}
          launch={launch}
          saving={saving}
          error={saveError}
          onSave={() => void save()}
          onCancel={closeForm}
        />
      )}
    </div>
  );
}

function AgentProfileForm({
  form,
  onChange,
  launch,
  saving,
  error,
  onSave,
  onCancel,
}: {
  form: FormState;
  onChange: (next: FormState) => void;
  launch: TaskLaunch;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const disabled = saving || !form.name.trim();
  return (
    <div data-testid="agent-profile-form" className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Name</label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          data-testid="agent-profile-name"
          value={form.name}
          maxLength={AGENT_PROFILE_LIMITS.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="Bug fixer"
        />
      </div>

      <TaskLaunchPickers launch={launch} hideProfilePicker />

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Instructions</label>
        <Textarea
          data-testid="agent-profile-instructions"
          value={form.instructions}
          maxLength={AGENT_PROFILE_LIMITS.instructions}
          onChange={(e) => onChange({ ...form, instructions: e.target.value })}
          rows={5}
          placeholder="General instructions this agent should always follow…"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Skills</label>
        <SkillsPicker
          value={form.skills}
          onChange={(skills) => onChange({ ...form, skills })}
          harnessId={launch.agent}
        />
      </div>

      {error && (
        <div
          data-testid="agent-profile-form-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
        >
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" data-testid="agent-profile-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" data-testid="agent-profile-save" onClick={onSave} disabled={disabled}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
