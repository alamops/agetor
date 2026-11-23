import { useId, type ReactNode } from "react";
import { RefreshCw, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, Label, fieldDescriptionId } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { Switch } from "@/components/ui/switch";
import { PipelinePicker } from "@/components/pipelines/PipelinePicker";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { refreshPipelines } from "@/lib/pipelines";
import { speedNoticeFor } from "../../../shared/model-catalog.ts";
import { speedLabel } from "../../../shared/speed.ts";
import { defaultModeFor } from "../../../shared/types.ts";
import { effortTooltip, STACK_FALLBACK_HINT, usageNote } from "@/lib/launch-copy";
import { agentSummary, moreOptionsNotes } from "@/lib/launch-summary";
import type { TaskLaunch } from "@/lib/use-task-launch";
import { AgentProfileCard } from "./AgentProfileCard";
import { AgentProfilePicker } from "./AgentProfilePicker";
import { HarnessAuthHint } from "./HarnessAuthHint";
import { HarnessPicker } from "./HarnessPicker";
import { LaunchSection } from "./LaunchSection";
import { ModeControl, ModeVariantPicker } from "./ModeControl";
import { showsSpeedPicker, SpeedPicker } from "./SpeedPicker";
import type { LaunchSurface } from "@/lib/panel-collapse";

// The launch state itself — fetching, seeding, the per-kind pick cache, the
// remembered picks, the model catalog — lives in `lib/use-task-launch.ts` and
// is shared by every launch surface (docs/architecture/task-launch-ui.md).
// This file re-exports it so existing imports keep compiling, and holds the
// picker VIEW the panel, both Git dialogs, Clone and Settings → Agents render,
// plus `createAndStartTask`.
//
// The view changes picks ONLY through the hook's tracked setters
// (`switchAgent`, `setMode`, `setModel`, `setEffort`, `setSpeed`, `setMaxMode`,
// `setAgentProfileId`, `setPipelineId`): Settings → Agents' dirtiness tracker
// (`lib/agent-profile-form.ts`, `LAUNCH_INTERACTION_SETTERS`) wraps exactly
// those, and a static test enforces it.
export { useTaskLaunch, type TaskLaunch, type LaunchSource } from "@/lib/use-task-launch";

interface Props {
  launch: TaskLaunch;
  /** `sections` renders the Agent `LaunchSection` (with More options) — the
   *  panel and the Git dialogs. `flat` renders the same fields with no section
   *  and no disclosure — Clone's "Explain" block and the Settings → Agents form. */
  layout?: "sections" | "flat";
  /** Which surface's persisted section state the Agent section uses. */
  surface?: LaunchSurface;
  hideProfilePicker?: boolean;
  /** Renders the profile picker's "Manage agents…" row when supplied. */
  onManageProfiles?: () => void;
  /** Renders the pipeline picker's "Manage pipelines…" row when supplied. */
  onManagePipelines?: () => void;
  /** Busy/read-only gate for the pipeline controls (a submit in flight). */
  disabled?: boolean;
}

/**
 * The launch pickers every task-launch surface renders from one `useTaskLaunch`
 * (docs/architecture/task-launch-ui.md). Order, in the Agent section:
 *
 *  1. Pipeline — its loading/error/empty hints, or the summary card;
 *  2. with no pipeline: the Agent (profile) picker, then the selected profile's
 *     card, or the Harness picker with its unavailable / auth / stack-fallback
 *     hints directly under it, then Model (with ↻) and Effort, then the usage note;
 *  3. More options: Code | Plan, the code-variant picker, Speed and Max Mode (a
 *     non-default value is announced on the row while it is closed).
 *
 * The `flat` layout keeps Code | Plan between Harness and Model (Clone, and the
 * Settings → Agents form, where the mode is part of the record being edited).
 */
export function TaskLaunchPickers({
  launch,
  layout = "sections",
  surface = "dialog",
  hideProfilePicker,
  onManageProfiles,
  onManagePipelines,
  disabled,
}: Props) {
  const uid = useId();
  const {
    harnesses, stacks, availableHarnesses, agents, agent, selectedStatus,
    effectiveAgent, effectiveStatus, effectiveStackFallback, effectiveLaunchable,
    mode, model, models, effort, efforts, speed, maxMode, speedOptions, maxModeAvailable,
    kind, modes, codeVariants, primaryMode,
    agentProfileId, profiles, selectedProfile,
    withPipelines, pipelines, pipelinesLoaded, pipelinesLoading, pipelinesError,
    pipelineId, selectedPipeline, pipelineState, pipelineProblem, pipelineStartProfile,
  } = launch;

  // The current account can't start this launch on its own, but its stack has a
  // usable backup the core will move to (see `stackBackupCanServe`): say so, so
  // an enabled Run next to a red hint isn't a puzzle.
  const effectiveHarnessRow = harnesses.find((h) => h.id === effectiveAgent);
  const showStackFallback =
    effectiveStackFallback &&
    (!effectiveHarnessRow?.enabled || !effectiveStatus?.available || effectiveStatus.loggedIn === false);

  // Only a failed FIRST fetch disables the picker — a transient refetch failure
  // keeps the stale-but-known list usable (`usePipelines`).
  const pipelinesUnavailable = withPipelines && pipelinesError !== null && !pipelinesLoaded && pipelines.length === 0;
  const id = (name: string) => `${uid}-${name}`;

  const speedNotice = speedNoticeFor(kind, model, speed, models);
  const modelRow = models.find((m) => m.id === model);
  const note = usageNote(kind, model, modelRow?.label);

  // ---- Hints under the harness (or the profile card) ------------------------
  // The wrapper carries the field's description id (it hides itself while empty), so the harness
  // picker's `aria-describedby` reads the hints a sighted user sees under it.
  const availabilityHints = (status: typeof selectedStatus, testIdSuffix = "", descriptionId?: string) => (
    <div id={descriptionId} className="space-y-1.5 empty:hidden">
      {status && !status.available && !effectiveStackFallback ? (
        <Notice tone="danger" data-testid={`launch-agent-unavailable-hint${testIdSuffix}`}>
          <div className="font-medium">{status.reason}</div>
          {status.installHint && <div className="font-mono opacity-80">{status.installHint}</div>}
        </Notice>
      ) : null}
      <HarnessAuthHint status={status} />
      {showStackFallback ? (
        <p data-testid="launch-stack-fallback-hint" className="text-2xs text-muted-foreground">{STACK_FALLBACK_HINT}</p>
      ) : null}
    </div>
  );

  // ---- 1. Pipeline -------------------------------------------------------------
  const pipelineBlock = withPipelines ? (
    <>
      <Field controlId={id("pipeline")}>
        <FieldLabel id={id("pipeline-label")}>Pipeline</FieldLabel>
        <div data-testid="launch-pipeline-picker">
          <PipelinePicker
            id={id("pipeline")}
            labelId={id("pipeline-label")}
            value={pipelineId}
            onChange={launch.setPipelineId}
            pipelines={pipelines}
            onManage={onManagePipelines}
            disabled={disabled || pipelinesUnavailable}
            aria-describedby={fieldDescriptionId(id("pipeline"))}
          />
        </div>
        <div id={fieldDescriptionId(id("pipeline"))} className="empty:hidden">
          {pipelinesLoading && pipelines.length === 0 ? (
            <p data-testid="launch-pipelines-loading" className="text-2xs text-muted-foreground">Loading pipelines…</p>
          ) : pipelinesUnavailable ? (
            <p data-testid="launch-pipelines-error" className="text-2xs text-danger">
              Couldn't load pipelines {pipelinesError ? `— ${pipelinesError}` : ""}
            </p>
          ) : pipelines.length === 0 && pipelineId === null ? (
            <p className="text-2xs text-muted-foreground">No pipelines yet. Create one on the Pipelines page.</p>
          ) : null}
        </div>
      </Field>

      {selectedPipeline ? (
        <div data-testid="launch-pipeline-summary" className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
              <Workflow className="size-3.5 shrink-0 text-info" aria-hidden />
              <span className="truncate">{selectedPipeline.name}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="launch-pipeline-change"
              onClick={() => launch.setPipelineId(null)}
              disabled={disabled}
              className="shrink-0 text-muted-foreground"
            >
              Change
            </Button>
          </div>
          <p className="text-2xs text-muted-foreground">
            {selectedPipeline.graph.steps.length} step{selectedPipeline.graph.steps.length === 1 ? "" : "s"}
            {pipelineStartProfile && <> · starts with {pipelineStartProfile.name}</>}
          </p>
          {pipelineState === "checking" ? (
            <p data-testid="launch-pipeline-checking" className="text-2xs text-muted-foreground">
              Checking the start step's agent…
            </p>
          ) : pipelineProblem ? (
            <Notice tone="danger" data-testid="launch-pipeline-problem">{pipelineProblem}</Notice>
          ) : showStackFallback ? (
            <p data-testid="launch-stack-fallback-hint" className="text-2xs text-muted-foreground">{STACK_FALLBACK_HINT}</p>
          ) : null}
        </div>
      ) : null}
    </>
  ) : null;

  // ---- 2. Profile card or the manual block ------------------------------------
  const profilePicker =
    !hideProfilePicker && !selectedPipeline ? (
      <Field controlId={id("profile")}>
        <FieldLabel id={id("profile-label")}>Agent</FieldLabel>
        <AgentProfilePicker
          id={id("profile")}
          labelId={id("profile-label")}
          value={agentProfileId}
          onChange={launch.setAgentProfileId}
          profiles={profiles}
          // Full list, not `availableHarnesses`: the picker/card resolve each
          // profile's icon+label from it and must resolve a disabled harness too,
          // so they render the "(harness disabled)" marker (finding F2-4).
          harnesses={harnesses}
          onManage={onManageProfiles}
        />
      </Field>
    ) : null;

  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title="Refresh model list"
      aria-label="Refresh model list"
      data-testid="launch-refresh-models"
      disabled={launch.refreshingModels || disabled}
      onClick={() => void launch.refreshModels()}
      className="-my-1 size-8 shrink-0 px-0 text-muted-foreground"
    >
      <RefreshCw aria-hidden className={cn("size-3.5", launch.refreshingModels && "animate-spin")} />
    </Button>
  );

  const modelItems: PickerItem[] = models.map((m) => ({
    value: m.id,
    label: m.label,
    hint: m.unlisted ? m.hint : undefined,
    title: m.unlisted ? m.hint : undefined,
  }));
  const effortItems: PickerItem[] = efforts.map((e) => ({ value: e.id, label: e.label }));

  const modeField = (
    <div className="space-y-1.5">
      <Label id={id("mode-label")}>Mode</Label>
      <ModeControl
        kind={kind}
        mode={mode}
        primary={primaryMode}
        onModeChange={launch.setMode}
        disabled={disabled}
        aria-labelledby={id("mode-label")}
      />
    </div>
  );

  // `withMode`: the flat layout keeps Code | Plan inline; the sections layout
  // moves it into More options.
  const manualBlock = (withMode: boolean) => (
    <>
      <Field controlId={id("harness")}>
        <FieldLabel id={id("harness-label")}>Harness</FieldLabel>
        <HarnessPicker
          id={id("harness")}
          labelId={id("harness-label")}
          value={agent}
          onChange={launch.switchAgent}
          harnesses={availableHarnesses}
          agents={agents}
          stacks={stacks}
          disabled={disabled}
          statusTone={launch.statusTone}
          aria-describedby={fieldDescriptionId(id("harness"))}
        />
        {availabilityHints(selectedStatus, "", fieldDescriptionId(id("harness")))}
      </Field>

      {withMode ? modeField : null}

      <div className="grid grid-cols-2 gap-2">
        <Field controlId={id("model")} className="min-w-0">
          <div className="flex items-center justify-between gap-1">
            <FieldLabel id={id("model-label")}>Model</FieldLabel>
            {refreshButton}
          </div>
          <Picker
            testId="launch-model-picker"
            id={id("model")}
            labelId={id("model-label")}
            aria-label="Model"
            value={model}
            onChange={launch.setModel}
            items={modelItems}
            searchable={modelItems.length > 8}
            disabled={disabled}
            aria-describedby={note ? fieldDescriptionId(id("model")) : undefined}
          />
        </Field>
        <Field controlId={id("effort")} className="min-w-0">
          <FieldLabel id={id("effort-label")}>Effort</FieldLabel>
          <Picker
            testId="launch-effort-picker"
            id={id("effort")}
            labelId={id("effort-label")}
            aria-label="Effort"
            value={effort}
            onChange={launch.setEffort}
            items={effortItems}
            placeholder="n/a"
            disabled={disabled || efforts.length === 0}
            title={effortTooltip(kind, efforts.length > 0)}
          />
        </Field>
      </div>
      {note ? (
        <p id={fieldDescriptionId(id("model"))} data-testid="launch-usage-note" className="text-2xs text-muted-foreground">{note}</p>
      ) : null}
    </>
  );

  const profileBlock = selectedProfile ? (
    <>
      <AgentProfileCard profile={selectedProfile} harnesses={harnesses} variant="selected" />
      {/* Same availability/auth hint the manual branch shows, keyed off the
          PROFILE's harness: an unavailable or logged-out profile harness must
          not leave Run blocked with no visible reason (finding F2-3). */}
      {availabilityHints(effectiveStatus)}
    </>
  ) : null;

  // ---- 3. More options -----------------------------------------------------------
  const modeShown = !selectedProfile && !selectedPipeline;
  const variantsShown = !selectedProfile && !selectedPipeline && codeVariants.length > 1;
  const speedShown = !selectedProfile && !selectedPipeline && showsSpeedPicker(speedOptions, speed);
  const maxModeShown = !selectedProfile && !selectedPipeline && kind === "cursor" && (maxModeAvailable || maxMode);
  // Plan is announced too: Code is the default, so a Plan pick must not hide
  // behind a closed More options.
  const variantLabel = !modeShown
    ? null
    : primaryMode === "plan"
      ? "Plan"
      : variantsShown && mode !== defaultModeFor(kind)
        ? (modes.find((m) => m.id === mode)?.label ?? mode)
        : null;
  const notes = moreOptionsNotes({
    speed: speedShown ? speed : null,
    speedLabel: speedLabel(speed),
    maxMode: maxModeShown && maxMode,
    modeVariantLabel: variantLabel,
  });

  const variantField = variantsShown ? (
    <Field controlId={id("variant")}>
      <FieldLabel id={id("variant-label")}>Approvals</FieldLabel>
      <ModeVariantPicker
        id={id("variant")}
        labelId={id("variant-label")}
        mode={mode}
        variants={codeVariants}
        onModeChange={launch.setMode}
        disabled={disabled}
        aria-describedby={fieldDescriptionId(id("variant"))}
      />
      <FieldDescription>How much the agent asks before it edits files or runs commands. Applies to Code.</FieldDescription>
    </Field>
  ) : null;

  const speedField = speedShown ? (
    <div className="space-y-1.5">
      <Label id={id("speed-label")}>Speed</Label>
      <SpeedPicker testId="launch-speed" options={speedOptions} value={speed} onChange={launch.setSpeed} disabled={disabled} {...speedNotice} />
    </div>
  ) : null;

  const maxModeField = maxModeShown ? (
    <Field controlId={id("max-mode")}>
      <div
        data-testid="launch-max-mode-toggle"
        className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-input bg-background px-3"
      >
        <FieldLabel className="flex-1 cursor-pointer text-sm font-normal text-foreground">Max Mode</FieldLabel>
        <Switch
          id={id("max-mode")}
          checked={maxMode}
          onCheckedChange={launch.setMaxMode}
          disabled={!maxModeAvailable || disabled}
          aria-label="Use Cursor Max Mode context"
        />
      </div>
    </Field>
  ) : null;

  const moreChildren: ReactNode = (
    <>
      {modeShown ? modeField : null}
      {variantField}
      {speedField}
      {maxModeField}
    </>
  );
  const hasMore = modeShown || variantsShown || speedShown || maxModeShown;

  const mainFields = (
    <>
      {pipelineBlock}
      {selectedPipeline ? null : (
        <>
          {profilePicker}
          {selectedProfile ? profileBlock : manualBlock(false)}
        </>
      )}
    </>
  );

  if (layout === "flat") {
    return (
      <div className="space-y-3">
        {pipelineBlock}
        {selectedPipeline ? null : (
          <>
            {profilePicker}
            {selectedProfile ? profileBlock : manualBlock(true)}
            {variantField}
            {speedField}
            {maxModeField}
          </>
        )}
      </div>
    );
  }

  const harnessLabel = harnesses.find((h) => h.id === effectiveAgent)?.label ?? effectiveAgent;
  const danger = (effectiveStatus !== undefined && !effectiveLaunchable) || pipelineState === "blocked";
  const summary = agentSummary({
    pipelineName: selectedPipeline?.name,
    profileName: selectedProfile?.name,
    harnessLabel,
    modelLabel: modelRow?.label ?? model,
    effortLabel: efforts.find((e) => e.id === effort)?.label ?? null,
    primary: primaryMode,
  });

  return (
    <LaunchSection
      id="agent"
      surface={surface}
      title="Agent"
      summary={summary}
      tone={danger ? "danger" : "default"}
      more={hasMore ? { notes, children: moreChildren } : undefined}
    >
      {mainFields}
    </LaunchSection>
  );
}

/**
 * `createTask` → `startTask`, with a delete-rollback on start failure so a
 * retry doesn't trip the taken-branch guard on the row this call just
 * created. Mirrors `ResolveConflictsDialog`'s inline `submit()` body
 * (lines 194-207) exactly, including both error message shapes. Resolves to
 * the created task's id.
 *
 * A successful pipeline create fires `refreshPipelines()` (not awaited) so
 * the module-cached list's server-derived `taskCount` ("Used by N task(s)")
 * is current the next time a picker or the Pipelines page renders.
 */
export async function createAndStartTask(input: Parameters<typeof api.createTask>[0]): Promise<string> {
  const created = await api.createTask(input);
  try {
    await api.startTask(created.id);
  } catch (startErr) {
    const detail = startErr instanceof Error ? startErr.message : String(startErr);
    const rolledBack = await api.deleteTask(created.id).then(() => true, () => false);
    throw new Error(
      rolledBack
        ? `couldn't start the task: ${detail}`
        : `task was created but couldn't start (${detail}) — find it on the board and start it manually`,
    );
  }
  if (input.pipelineId) void refreshPipelines().catch(() => {});
  return created.id;
}
