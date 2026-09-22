import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { AGENT_PROFILE_LIMITS } from "../../../shared/agent-profile.ts";
import type { AgentProfile } from "../../../shared/types.ts";
import { SkillsPicker } from "./SkillsPicker";
import { TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";

/** Local edit-buffer shape for the create/edit form — the two fields
 *  `TaskLaunchPickers` doesn't own (name, and the composition-only
 *  instructions/skills pair; harness/mode/model/effort/fast/maxMode live on
 *  the `useTaskLaunch` hook instead of being duplicated here). Mirrors
 *  `AgentProfilesSection`'s original inline `FormState`. */
interface FormState {
  name: string;
  instructions: string;
  skills: string[];
}

const EMPTY_FORM: FormState = { name: "", instructions: "", skills: [] };

export interface AgentProfileFormProps {
  /** `null` for a create form; an existing profile's id for an edit form —
   *  the form loads that profile from the shared `useAgentProfiles()` cache
   *  (the same module-cached list every other profile consumer reads), so
   *  a caller never has to pass the `AgentProfile` object itself. */
  profileId: string | null;
  onSaved: (profile: AgentProfile) => void;
  onCancel: () => void;
  /** Focuses the Name field on mount when true. Defaults to `false` so a
   *  dialog-hosted form can opt in via `initialFocusRef` instead (the
   *  dialog's own focus-management already handles that case). */
  autoFocus?: boolean;
}

/**
 * The agent-profile create/edit form — name, harness/mode/model/effort/fast/
 * maxMode (via `<TaskLaunchPickers hideProfilePicker>`), instructions and
 * skills. Extracted out of `AgentProfilesSection` (Settings → Agents) so a
 * second consumer (a pipeline step's inline "create an agent" affordance,
 * via `AgentProfileFormDialog` below) can reuse it verbatim rather than
 * duplicating the save/validation logic. Owns its own `useTaskLaunch` +
 * save/error state — every test id, label, placeholder and disabled rule
 * from the original inline form is preserved unchanged.
 */
export function AgentProfileForm({ profileId, onSaved, onCancel, autoFocus }: AgentProfileFormProps) {
  const { profiles, refresh } = useAgentProfiles();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The profile being edited, resolved from the already-loaded `profiles`
  // list — `null` for a create form or before the list has loaded for an
  // edit form. Passed straight into `useTaskLaunch` as `opts.initial` so the
  // hook's own open-effect seeds from it directly in the same render where
  // `profileId` is known, instead of via a second effect that could race the
  // hook's async harness fetch — see `useTaskLaunch`'s `initial` doc comment
  // for the full race this avoids.
  const editingProfile = profileId !== null ? (profiles.find((p) => p.id === profileId) ?? null) : null;

  const launch = useTaskLaunch(true, {
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

  // Seed the name/instructions/skills fields once the profile being edited
  // resolves (or immediately, for a create form). Reruns only when the
  // *target* profile identity changes — not on every `profiles` refresh —
  // so mid-edit typing isn't clobbered by an unrelated background refetch.
  useEffect(() => {
    if (profileId === null) {
      setForm(EMPTY_FORM);
      return;
    }
    if (editingProfile) {
      setForm({ name: editingProfile.name, instructions: editingProfile.instructions, skills: editingProfile.skills });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, editingProfile !== null]);

  const disabled = saving || !form.name.trim();

  const save = async () => {
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
      const saved = profileId ? await api.updateAgentProfile(profileId, input) : await api.createAgentProfile(input);
      await refresh();
      onSaved(saved);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="agent-profile-form" className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Name</label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          data-testid="agent-profile-name"
          value={form.name}
          maxLength={AGENT_PROFILE_LIMITS.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Bug fixer"
          autoFocus={autoFocus}
        />
      </div>

      <TaskLaunchPickers launch={launch} hideProfilePicker />

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Instructions</label>
        <Textarea
          data-testid="agent-profile-instructions"
          value={form.instructions}
          maxLength={AGENT_PROFILE_LIMITS.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          rows={5}
          placeholder="General instructions this agent should always follow…"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Skills</label>
        <SkillsPicker
          value={form.skills}
          onChange={(skills) => setForm({ ...form, skills })}
          harnessId={launch.agent}
        />
      </div>

      {saveError && (
        <div
          data-testid="agent-profile-form-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
        >
          {saveError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" data-testid="agent-profile-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" data-testid="agent-profile-save" onClick={() => void save()} disabled={disabled}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface AgentProfileFormDialogProps {
  open: boolean;
  profileId: string | null;
  onClose: () => void;
  onSaved: (profile: AgentProfile) => void;
}

/**
 * Modal wrapper around {@link AgentProfileForm} — lets a surface that isn't
 * Settings (e.g. a Pipelines step's "New agent…" affordance) create or edit
 * an {@link AgentProfile} inline without leaving its own flow. Settings →
 * Agents keeps rendering `AgentProfileForm` inline (not through this
 * dialog) — see `AgentProfilesSection`.
 */
export function AgentProfileFormDialog({ open, profileId, onClose, onSaved }: AgentProfileFormDialogProps) {
  const title = profileId ? "Edit agent" : "New agent";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="agent-profile-form-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      <div data-testid="agent-profile-form-dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div id="agent-profile-form-dialog-title" className="text-sm font-semibold">
            {title}
          </div>
          <Button variant="ghost" size="icon" className="shrink-0" title="Close" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
          <AgentProfileForm
            profileId={profileId}
            onSaved={(p) => {
              onSaved(p);
              onClose();
            }}
            onCancel={onClose}
            autoFocus
          />
        </div>
      </div>
    </Dialog>
  );
}
