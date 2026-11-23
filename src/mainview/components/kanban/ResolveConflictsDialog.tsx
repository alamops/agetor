import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, GitMerge, Info, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { useConfirm } from "@/components/ui/confirm";
import { buildResolveConflictsPrompt } from "@/lib/resolve-conflicts-prompt";
import type { TaskReference } from "../../../shared/types.ts";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";
import { WorkspaceSection } from "./WorkspaceSection";
import { LaunchFooter } from "./LaunchFooter";
import { PromptComposer } from "./PromptComposer";
import { useWorktreeOptions } from "./WorktreeOptions";
import { launchGate, submitPicks } from "@/lib/launch-state";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";

export interface ResolveConflictsContext {
  path: string;
  repo: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: ResolveConflictsContext | null;
  onCreated?: (taskId: string) => void;
  /** Closes this dialog (after any draft confirmation) and navigates to the
   *  Pipelines page. Optional so other mounts render no manage row. */
  onManagePipelines?: () => void;
  /** Closes this dialog (after any draft confirmation) and opens Settings →
   *  Agents. Optional so other mounts render no manage row. */
  onManageAgents?: () => void;
}

/**
 * "Resolve with Agetor" dialog for a PR's merge conflicts. Creates a task ON
 * the PR's head branch (`existingBranch: context.headRef`), which the server
 * requires worktree isolation for and ignores `baseRef` on — so this dialog
 * renders `WorktreeOptions`' `locked` variant (a read-only "Branch" row +
 * a checked/disabled isolate checkbox) instead of the live picker, and
 * shares the same `PromptComposer` (`/` autocomplete, drag/paste-to-attach,
 * References picker) `CreateTaskFromIssueDialog` uses, rather than a bare
 * `Textarea`.
 */
export function ResolveConflictsDialog({ open, onClose, context, onCreated, onManagePipelines, onManageAgents }: Props) {
  const launch = useTaskLaunch(open, { withPipelines: true });
  const confirm = useConfirm();

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [references, setReferences] = useState<TaskReference[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // `@` file-reference scope: the worktree is locked to the PR's head branch
  // (`context.headRef`) — `listProjectFiles` falls back to
  // `origin/<headRef>` when it only exists as a remote-tracking ref. Gated
  // on `open` so a closed dialog never fetches; memoized so
  // `useProjectFiles`'s effect doesn't refire on every unrelated re-render.
  const fileScope = useMemo(
    () => (open && context ? { dir: context.path, ref: context.headRef } : null),
    [open, context?.path, context?.headRef],
  );

  // Reset per-open transient state (prompt dirtiness, errors, references,
  // pipeline selection) so a previous PR's edits don't leak into the next
  // one — on open AND when the PR identity changes while open. Keyed on the
  // context's primitive fields: `PullActions` rebuilds `resolveContext` on
  // every board poll, and an equal-valued but new-identity object must not
  // wipe the draft. Harness/model/prefs fetching is owned by useTaskLaunch.
  useEffect(() => {
    if (!open) return;
    setPromptDirty(false);
    setSubmitError(null);
    setReferences([]);
    launch.setPipelineId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context?.path, context?.number, context?.headRef]);

  // Seed (and re-seed) the prompt from the context, but only while the user
  // hasn't started editing it — matches the composer's usual "don't clobber
  // what you typed" rule.
  useEffect(() => {
    if (!open || !context || promptDirty) return;
    setPrompt(buildResolveConflictsPrompt(context));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context, promptDirty]);

  const overage = launch.overageKind === null
    ? null
    : promptByteOverage(
        launch.overageKind,
        // Raw prompt for a pipeline task (the step prompt wraps it — New Task
        // parity); the profile's instructions preamble otherwise.
        launch.pipelineId ? prompt : composeLaunchPrompt(launch.selectedProfile, prompt),
      );

  // The single Run rule (`launchGate`) — the PR's title is derived, so none is
  // required, and the worktree is locked to the PR head (always valid) — plus
  // this dialog's own conditions: a context and no submit in flight.
  const gate = launchGate({
    title: "",
    prompt,
    requireTitle: false,
    reposCount: context ? 1 : 0,
    worktreeValid: true,
    overage: overage != null,
    effectiveLaunchable: launch.effectiveLaunchable,
    effectiveHarnessLabel: launch.harnesses.find((h) => h.id === launch.effectiveAgent)?.label ?? launch.effectiveAgent,
    effectiveReason: launch.effectiveStatus?.reason ?? null,
    statusKnown: launch.effectiveStatus !== undefined,
    pipelineSelected: launch.selectedPipeline !== null,
    pipelineReady: launch.pipelineReady,
    pipelineState: launch.pipelineState,
    pipelineProblem: launch.pipelineProblem,
  });
  const canSubmit = !!context && !submitting && gate.canRun;
  // The gate's reason is about the form, which is only on screen once the harnesses have loaded
  // and the PR still has a resolve context: while they load, after a failed fetch, or once the
  // PR's state changed, the footer must not ask for a project or a harness the user cannot pick.
  const formShown = !launch.loading && !launch.loadError && !!context;
  const footerReason = formShown ? gate.runBlockedReason : launch.loading ? "Loading harnesses…" : null;

  // Changed since the dialog opened: the prompt, attached references, or a
  // selected pipeline (the worktree row is locked to the PR head).
  const draftDirty = promptDirty || references.length > 0 || launch.pipelineId !== null;

  /** "Manage pipelines…" / "Manage agents…": confirm before discarding a dirty
   *  draft, then close this dialog (the inner one) so the App callback can close
   *  the Git dialog beneath without leaving a stacked overlay above the
   *  destination page. */
  const leaveForPage = async (destination: string, navigate: (() => void) | undefined) => {
    if (submitting) return;
    if (draftDirty) {
      const ok = await confirm({
        title: `Discard this task draft and open ${destination}?`,
        description: "Your prompt edits, references and selections will be lost.",
        confirmLabel: "Discard draft",
        variant: "destructive",
      });
      if (!ok) return;
    }
    onClose();
    navigate?.();
  };

  const submit = async () => {
    if (!context || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAndStartTask({
        title: `Resolve conflicts: PR #${context.number} — ${context.title}`,
        prompt: prompt.trim(),
        // Start-step profile's harness for a pipeline; the selected profile's
        // otherwise; else the manual pick (finding F2-3).
        agent: launch.effectiveAgent,
        workdir: context.path,
        isolation: "worktree" as const,
        existingBranch: context.headRef,
        references,
        // The same one mapping New Task uses (`submitPicks`).
        ...submitPicks({
          kind: launch.kind,
          picks: { mode: launch.mode, model: launch.model, effort: launch.effort, speed: launch.speed, maxMode: launch.maxMode },
          profile: launch.selectedProfile,
        }),
        // Omit entirely when no profile/pipeline is selected (finding F2-1) —
        // see NewTaskForm.submit's matching comment. Mutually exclusive by
        // construction, so the body never carries both.
        ...(launch.pipelineId ? { pipelineId: launch.pipelineId } : {}),
        ...(launch.agentProfileId ? { agentProfileId: launch.agentProfileId } : {}),
        column: "ready" as const,
      });
      launch.rememberPicks();
      onCreated?.(created);
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Cmd/Ctrl+Enter runs the task from anywhere inside the dialog.
  const contentRef = useRef<HTMLDivElement>(null);
  useSubmitShortcut(contentRef, () => void submit(), canSubmit);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="resolve-conflicts-dialog-title"
      className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col p-0 md:h-[min(40rem,calc(100vh-2rem))]"
    >
      {/* `display: contents` keeps this test-id wrapper out of the flex layout
       *  below — header/body/footer still act as direct flex items of the Dialog
       *  panel (which needs that for its max-h/overflow scroll region to work),
       *  while still giving e2e a stable node to find the whole dialog by and the
       *  shortcut a scope to listen on. Dialog's own props don't forward
       *  arbitrary data-* attributes onto the panel. */}
      <div ref={contentRef} data-testid="resolve-conflicts-dialog" className="contents">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle id="resolve-conflicts-dialog-title" className="flex items-center gap-2">
              <GitMerge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Resolve with Agetor
            </DialogTitle>
            {context && (
              <DialogDescription className="truncate">
                PR #{context.number} — {context.title}
              </DialogDescription>
            )}
          </div>
          <DialogClose disabled={submitting} onClick={onClose} title="Close" />
        </DialogHeader>

        <DialogBody className="p-0 md:overflow-hidden">
          {launch.loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading harnesses…
            </div>
          )}

          {!launch.loading && launch.loadError && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-danger">
              <AlertCircle className="size-4" /> {launch.loadError}
            </div>
          )}

          {!launch.loading && !launch.loadError && !context && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <AlertCircle className="size-4" /> The PR's state changed — close and reopen this dialog if
              you still want to resolve conflicts.
            </div>
          )}

          {!launch.loading && !launch.loadError && !!context && (
            // Two columns from the `md` breakpoint (768 px), each scrolling on its
            // own; one column with one scroll below it. The footer sits outside.
            <div className="md:grid md:h-full md:min-h-0 md:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="space-y-4 px-5 py-4 md:min-h-0 md:overflow-y-auto">
                <Notice tone="info" icon={<Info className="size-3.5" />}>
                  Merges <span className="font-mono">origin/{context.baseRef}</span> into{" "}
                  <span className="font-mono">{context.headRef}</span> in a worktree checked out on that
                  branch. The agent commits locally; it never pushes.
                </Notice>

                <PromptComposer
                  value={prompt}
                  extensionPickerVariant="launch"
                  onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                  agent={launch.effectiveAgent}
                  references={references}
                  onReferencesChange={setReferences}
                  setReferences={setReferences}
                  fileScope={fileScope}
                  startingFolder={context.path}
                  rows={8}
                  footer={overage && (
                    <Notice tone="warning">
                      This prompt is {Math.ceil(overage.bytes / 1024)} KB — {launch.overageLabel}'s one-shot
                      launch caps prompts at {Math.floor(overage.limit / 1024)} KB. Pick another harness or
                      trim the prompt.
                    </Notice>
                  )}
                />
              </div>

              <div className="space-y-3 border-t border-border bg-muted/20 px-5 py-4 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
                <WorkspaceSection
                  surface="dialog"
                  locked={{ branch: context.headRef, projectPath: context.path }}
                />

                <TaskLaunchPickers
                  launch={launch}
                  layout="sections"
                  surface="dialog"
                  // The manage rows are optional (see the prop comments): a mount
                  // without them must render no row, not one that closes this
                  // dialog and goes nowhere.
                  onManagePipelines={onManagePipelines ? () => { void leaveForPage("Pipelines", onManagePipelines); } : undefined}
                  onManageProfiles={onManageAgents ? () => { void leaveForPage("Settings → Agents", onManageAgents); } : undefined}
                  disabled={submitting}
                />
              </div>
            </div>
          )}
        </DialogBody>

        <DialogFooter className="block">
          <LaunchFooter
            reason={footerReason}
            error={submitError}
            cancel={{ label: "Cancel", onClick: onClose, disabled: submitting, testId: "launch-cancel" }}
            primary={{ label: "Run task", onClick: () => void submit(), disabled: !canSubmit, testId: "resolve-conflicts-submit", busy: submitting }}
          />
        </DialogFooter>
      </div>
    </Dialog>
  );
}
