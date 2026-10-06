import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { agentProfileTextDirty, duplicateAgentName } from "@/lib/agent-profile-form";
import { cn } from "@/lib/utils";
import { AGENT_PROFILE_LIMITS } from "../../../shared/agent-profile.ts";
import type { AgentProfile } from "../../../shared/types.ts";
import { SkillsPicker } from "./SkillsPicker";
import { TaskLaunchPickers, useTaskLaunch, type TaskLaunch } from "./TaskLaunchPickers";

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
  /** When `profileId` is null, opens a create form prefilled from this
   *  existing agent (name suffixed to stay unique). Save still creates a
   *  new agent. Ignored when `profileId` is set. */
  duplicateFromId?: string | null;
  onSaved: (profile: AgentProfile) => void;
  onCancel: () => void;
  /** Focuses the Name field on mount when true. Defaults to `false` so a
   *  dialog-hosted form can opt in via `initialFocusRef` instead (the
   *  dialog's own focus-management already handles that case). */
  autoFocus?: boolean;
  /** Reports whether the form holds unsaved edits — a text field differing
   *  from what the form opened with, or any harness/mode/model/effort/fast/
   *  max-mode pick the user made. Fires when the flag flips and reports
   *  `false` again when the form unmounts, so a host can keep a plain
   *  "is dirty" ref without tracking mount state itself. */
  onDirtyChange?: (dirty: boolean) => void;
  /** `"card"` (default) draws the form as a bordered card, for embedding
   *  inside a dialog body; `"page"` drops the card chrome and gives the
   *  footer a top border, for hosting as a whole subpage (Settings → Agents'
   *  editor). Test ids, labels and disabled rules are identical in both. */
  variant?: "card" | "page";
  /** Page variant only: shows a Duplicate button on an edit form. */
  onDuplicate?: () => void;
}

const CARD_ROOT_CLASS = "rounded-md border border-border/60 p-3";
const PAGE_FOOTER_CLASS = "border-t border-border/60 pt-3";

/**
 * The agent-profile create/edit form — name, harness/mode/model/effort/fast/
 * maxMode (via `<TaskLaunchPickers hideProfilePicker>`), instructions and
 * skills. Extracted out of `AgentProfilesSection` (Settings → Agents) so it
 * can be hosted twice without duplicating the save/validation logic: as the
 * Settings modal's agent-editor subpage (`variant="page"`) and inside
 * `AgentProfileFormDialog` below (a pipeline step's inline "create an
 * agent" affordance). Every test id, label, placeholder
 * and disabled rule from the original inline form is preserved unchanged.
 *
 * This outer component only RESOLVES the profile being edited from the
 * shared cache; the actual form (`AgentProfileFormBody`) is mounted only
 * once that profile is known — keyed on its id — so its `useTaskLaunch`
 * pickers and name/instructions/skills buffer are always seeded from the
 * real row on their very first render (L-A9). Before this split the body
 * mounted immediately with defaults and seeded from a `useEffect` once the
 * list landed; a slow first `useAgentProfiles()` fetch left an edit form
 * that could be Saved — overwriting the real profile with the defaults —
 * before it had ever seeded. Now a not-yet-loaded edit target renders a
 * "Loading…" line (no Save button at all) and a genuinely-missing one an
 * error with only Cancel.
 */
export function AgentProfileForm({
  profileId,
  duplicateFromId = null,
  onSaved,
  onCancel,
  autoFocus,
  onDirtyChange,
  variant = "card",
  onDuplicate,
}: AgentProfileFormProps) {
  const { profiles, loaded, refresh } = useAgentProfiles();

  const duplicating = profileId === null && typeof duplicateFromId === "string" && duplicateFromId !== "";
  const duplicateSource = duplicating ? (profiles.find((p) => p.id === duplicateFromId) ?? null) : null;

  if (duplicateSource) {
    const seed: AgentProfile = {
      ...duplicateSource,
      name: duplicateAgentName(
        duplicateSource.name,
        profiles.map((p) => p.name),
      ),
    };
    return (
      <AgentProfileFormBody
        key={`dup-${duplicateSource.id}`}
        profileId={null}
        editingProfile={seed}
        duplicateFromId={duplicateSource.id}
        onSaved={onSaved}
        onCancel={onCancel}
        autoFocus={autoFocus}
        onDirtyChange={onDirtyChange}
        variant={variant}
        refreshProfiles={refresh}
      />
    );
  }

  if (profileId === null && !duplicating) {
    return (
      <AgentProfileFormBody
        key="new"
        profileId={null}
        editingProfile={null}
        onSaved={onSaved}
        onCancel={onCancel}
        autoFocus={autoFocus}
        onDirtyChange={onDirtyChange}
        variant={variant}
        refreshProfiles={refresh}
      />
    );
  }

  const editingProfile = profileId === null ? null : (profiles.find((p) => p.id === profileId) ?? null);
  if (editingProfile) {
    return (
      <AgentProfileFormBody
        key={editingProfile.id}
        profileId={editingProfile.id}
        editingProfile={editingProfile}
        onDuplicate={onDuplicate}
        onSaved={onSaved}
        onCancel={onCancel}
        autoFocus={autoFocus}
        onDirtyChange={onDirtyChange}
        variant={variant}
        refreshProfiles={refresh}
      />
    );
  }

  return (
    <div data-testid="agent-profile-form" className={cn("space-y-3", variant === "card" && CARD_ROOT_CLASS)}>
      {loaded ? (
        <div
          data-testid="agent-profile-form-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
        >
          This agent no longer exists — it may have been deleted elsewhere.
        </div>
      ) : (
        <div data-testid="agent-profile-form-loading" className="text-xs text-muted-foreground">
          Loading…
        </div>
      )}
      <div className={cn("flex justify-end gap-2", variant === "page" && PAGE_FOOTER_CLASS)}>
        <Button variant="outline" size="sm" data-testid="agent-profile-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface AgentProfileFormBodyProps extends AgentProfileFormProps {
  /** The already-resolved row used to seed the form — never `null` when
   *  `profileId` isn't. It is also non-null with a null `profileId` for a
   *  duplicate seed (a create form prefilled from another agent);
   *  `profileId` is non-null only for a real edit. The outer `AgentProfileForm` guarantees this by
   *  only mounting the body once the profile is known (and keys it on the
   *  id), so every `useState` initializer below can seed straight from it. */
  editingProfile: AgentProfile | null;
  refreshProfiles: () => Promise<void>;
}

function AgentProfileFormBody({
  profileId,
  editingProfile,
  onSaved,
  onCancel,
  autoFocus,
  onDirtyChange,
  variant = "card",
  duplicateFromId = null,
  onDuplicate,
  refreshProfiles,
}: AgentProfileFormBodyProps) {
  const [copyTasks, setCopyTasks] = useState(false);
  const [form, setForm] = useState<FormState>(() =>
    editingProfile
      ? { name: editingProfile.name, instructions: editingProfile.instructions, skills: editingProfile.skills }
      : EMPTY_FORM,
  );
  // What the form opened with — `editingProfile` is fixed for this body's
  // lifetime (the parent keys the body on its id), so the first render's
  // values are the baseline for the whole life of the form.
  const baselineRef = useRef<FormState>(form);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // `editingProfile` is fixed for this body's lifetime (the parent keys the
  // body on its id), so `opts.initial` is stable and `useTaskLaunch`'s own
  // open-effect seeds the pickers from it in the same render where the
  // profile is known — never via a later effect that could race the hook's
  // async harness fetch (see `useTaskLaunch`'s `initial` doc comment).
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

  // The picker block is tracked by interaction, not by value: `useTaskLaunch`
  // seeds mode/model/effort asynchronously (preferences, harness fetch) and
  // its reset effects call its own internal setters, so a value diff would
  // read an untouched form as dirty. Only a pick made through the setters
  // `TaskLaunchPickers` calls marks the form touched.
  const [launchTouched, setLaunchTouched] = useState(false);
  const trackedLaunch = useMemo<TaskLaunch>(
    () => ({
      ...launch,
      switchAgent: (id) => {
        if (id !== launch.agent) setLaunchTouched(true);
        launch.switchAgent(id);
      },
      setMode: (mode) => {
        if (mode !== launch.mode) setLaunchTouched(true);
        launch.setMode(mode);
      },
      setModel: (model) => {
        if (model !== launch.model) setLaunchTouched(true);
        launch.setModel(model);
      },
      setEffort: (effort) => {
        if (effort !== launch.effort) setLaunchTouched(true);
        launch.setEffort(effort);
      },
      setFast: (fast) => {
        if (fast !== launch.fast) setLaunchTouched(true);
        launch.setFast(fast);
      },
      setMaxMode: (maxMode) => {
        if (maxMode !== launch.maxMode) setLaunchTouched(true);
        launch.setMaxMode(maxMode);
      },
    }),
    [launch],
  );

  // While a save is in flight the edits are being persisted, not discarded —
  // report clean so leaving mid-save doesn't ask "Discard unsaved changes?".
  // A failed save flips `saving` back and the form reads dirty again.
  const dirty = (agentProfileTextDirty(form, baselineRef.current) || launchTouched) && !saving;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  // A save can resolve after the body is gone (the user left mid-save, or the
  // host reopened onto a fresh form) — a late `onSaved` would then act on
  // whichever form is showing NOW, so it and the state writes are skipped.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      let saved: AgentProfile;
      let copyErrors: { sourceTaskId: string; error: string }[] = [];
      if (typeof duplicateFromId === "string" && duplicateFromId !== "") {
        const result = await api.duplicateAgentProfile(duplicateFromId, { ...input, copyTasks });
        saved = result.profile;
        copyErrors = result.taskCopyErrors;
      } else {
        saved = profileId ? await api.updateAgentProfile(profileId, input) : await api.createAgentProfile(input);
      }
      await refreshProfiles();
      if (mountedRef.current) {
        if (copyErrors.length > 0) {
          const first = copyErrors[0]?.error ?? "";
          toast.error(
            `${copyErrors.length} task${copyErrors.length === 1 ? "" : "s"} couldn't be copied${first ? `: ${first}` : ""}`,
          );
        }
        onSaved(saved);
      }
    } catch (e) {
      if (mountedRef.current) setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div data-testid="agent-profile-form" className={cn("space-y-3", variant === "card" && CARD_ROOT_CLASS)}>
      {/* Every draft-changing control is inert while a save is in flight: the
          form reports clean then (see `dirty` above) and pops on success, so
          an edit typed after Save captured its values would be dropped
          without a confirm. `TaskLaunchPickers` has no `disabled` prop — the
          fieldset reaches its selects/buttons/switches natively. */}
      <fieldset disabled={saving} className="m-0 min-w-0 space-y-3 border-0 p-0">
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

      <TaskLaunchPickers launch={trackedLaunch} hideProfilePicker />

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
          disabled={saving}
        />
      </div>

      {typeof duplicateFromId === "string" && duplicateFromId !== "" && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            data-testid="agent-profile-copy-tasks"
            className="mt-0.5"
            checked={copyTasks}
            onChange={(e) => setCopyTasks(e.target.checked)}
          />
          <span className="space-y-0.5">
            <span className="block text-xs">Also copy tasks that use this agent</span>
            <span className="block text-xs text-muted-foreground">
              New backlog cards. Runs and pipeline steps stay on the original.
            </span>
          </span>
        </label>
      )}
      </fieldset>

      {saveError && (
        <div
          data-testid="agent-profile-form-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
        >
          {saveError}
        </div>
      )}

      <div className={cn("flex justify-end gap-2", variant === "page" && PAGE_FOOTER_CLASS)}>
        {variant === "page" && typeof profileId === "string" && profileId !== "" && (
          <Button
            variant="outline"
            size="sm"
            data-testid="agent-profile-form-duplicate"
            onClick={() => onDuplicate?.()}
            disabled={saving}
          >
            Duplicate
          </Button>
        )}
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
 * Agents does not use it — its Add/Edit open the Settings modal's own
 * agent-editor subpage, which hosts `AgentProfileForm` directly.
 *
 * Escape, a backdrop click and the header X all route through
 * `requestClose`, which asks "Discard unsaved changes?" when the form
 * reports dirty; the form's own Cancel and a successful Save close at once.
 */
export function AgentProfileFormDialog({ open, profileId, onClose, onSaved }: AgentProfileFormDialogProps) {
  const title = profileId ? "Edit agent" : "New agent";
  const confirm = useConfirm();
  const dirtyRef = useRef(false);
  const confirmingRef = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const requestClose = useCallback(async () => {
    if (!dirtyRef.current) {
      onClose();
      return;
    }
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        description: "Your edits to this agent will be lost.",
        confirmLabel: "Discard",
        variant: "destructive",
      });
      if (ok) onClose();
    } finally {
      confirmingRef.current = false;
    }
  }, [confirm, onClose]);
  return (
    <Dialog
      open={open}
      onClose={() => void requestClose()}
      labelledBy="agent-profile-form-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      <div data-testid="agent-profile-form-dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div id="agent-profile-form-dialog-title" className="text-sm font-semibold">
            {title}
          </div>
          <Button variant="ghost" size="icon" className="shrink-0" title="Close" aria-label="Close" onClick={() => void requestClose()}>
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
            onDirtyChange={handleDirtyChange}
          />
        </div>
      </div>
    </Dialog>
  );
}
