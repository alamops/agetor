import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Bot, Info, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { DEFAULT_TASK_TYPE, type GitHubIssueThreadResult, type TaskReference, type TaskType } from "../../../shared/types.ts";
import {
  buildIssueTaskPrompt,
  inferTaskTypeFromLabels,
  issueTaskTitle,
  renderIssueThreadMarkdown,
  sameIssueUrl,
} from "../../../shared/issue-task.ts";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";
import { useWorktreeOptions } from "./WorktreeOptions";
import { WorkspaceSection } from "./WorkspaceSection";
import { LaunchFooter } from "./LaunchFooter";
import { launchGate, submitPicks } from "@/lib/launch-state";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";
import { useProjectSelection } from "./ProjectSelection";
import { repositoryFileScopes } from "@/lib/repo-selection";
import { selectionPayload } from "@/lib/worktree-payload";
import { PromptComposer } from "./PromptComposer";
import { TaskTypePicker } from "./TaskTypePicker";

/** The exact sibling of `ResolveConflictsContext` for issues: enough to
 *  refetch the thread and know where to put the resulting task. */
export interface IssueTaskContext {
  path: string;
  number: number;
  url: string;
  title: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: IssueTaskContext | null;
  onCreated?: (taskId: string) => void;
  /** Closes this dialog (after any draft confirmation) and navigates to the
   *  Pipelines page. Optional so other mounts render no manage row. */
  onManagePipelines?: () => void;
  /** Closes this dialog (after any draft confirmation) and opens Settings →
   *  Agents. Optional so other mounts render no manage row. */
  onManageAgents?: () => void;
}

/**
 * "Work on this with Agetor" dialog for a Git issue — the issue-tracker
 * sibling of `ResolveConflictsDialog`, built on the same generic launch
 * machinery (`useTaskLaunch`/`TaskLaunchPickers`/`createAndStartTask` from
 * `./TaskLaunchPickers`), and now on the same worktree row + prompt composer
 * as the New Task left panel via `useWorktreeOptions`/`WorktreeOptions`
 * (`./WorktreeOptions`) and `PromptComposer` (`./PromptComposer`) — so the
 * panel and the two modals can't drift. Fetches the full issue thread on
 * open, seeds an editable prompt from it, seeds the Type picker
 * (`TaskTypePicker`) from the issue's own labels via `inferTaskTypeFromLabels`
 * (so e.g. a `bug`-labelled issue defaults to `"bug"` instead of every issue
 * task landing on the blanket `"task"` default), and creates + starts a task
 * (on a fresh worktree branch by default, same as the panel) with the thread
 * embedded (inline in the prompt, and in full as a referenced snapshot
 * file).
 */
export function CreateTaskFromIssueDialog({ open, onClose, context, onCreated, onManagePipelines, onManageAgents }: Props) {
  const launch = useTaskLaunch(open, { withPipelines: true });
  const confirm = useConfirm();

  const [thread, setThread] = useState<GitHubIssueThreadResult | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [references, setReferences] = useState<TaskReference[]>([]);

  // This modal now has a Type picker (`TaskTypePicker`, mirroring the New
  // Task form), seeded from the issue's own labels via
  // `inferTaskTypeFromLabels` once the thread loads — see the seeding effect
  // below. `typeDirty` mirrors `promptDirty`'s "don't clobber what the user
  // picked" rule: once the user touches the picker themselves, label-driven
  // re-seeding stops.
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [typeDirty, setTypeDirty] = useState(false);

  // Combined project selection, seeded from the issue's own repository on
  // open. The issue repo is always first and locked; extras are added through
  // the same Select Projects control New Task uses. No auto-select here: the
  // issue's repo is the only correct starting point.
  const { repos, setRepos, multiRepo, refDirty } = useProjectSelection({ enabled: open });

  // The branch-name field derives live from the current title + taskType
  // (same `issueTaskTitle` the submit path uses), so it shows e.g.
  // `fix/issue-7-…` for a bug-labelled issue once the thread loads. 2+
  // projects force worktree isolation — the same one derivation as New Task.
  const wt = useWorktreeOptions({
    workdir: context?.path ?? "",
    title: thread ? issueTaskTitle(thread.item) : "",
    taskType,
    // `IssueActions` (GitHubDialog.tsx) mounts this dialog unconditionally,
    // so the branch-config fetch must stay off until it's actually open.
    enabled: open,
    forceIsolate: multiRepo,
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // `@` file-reference scope — gated on `open` since `IssueActions` mounts
  // this dialog unconditionally (same reason `useWorktreeOptions` above
  // takes `enabled: open`): a closed dialog must never fetch a listing.
  // Memoized so `useProjectFiles`'s effect doesn't refire on every
  // unrelated re-render.
  const fileScope = useMemo(() => {
    if (!open) return null;
    // The issue repo's own ref is its entry's; multi tasks use `fileScopes`.
    const ref = repos[0]?.baseRef?.trim() || "HEAD";
    return { dir: context?.path ?? "", ref: wt.effectiveIsolate ? ref : null };
  }, [open, context?.path, repos, wt.effectiveIsolate]);
  // Multi-repository `@` scopes (issue #291): the same union New Task builds —
  // each selected repository lists at its own path and pinned/HEAD ref, and
  // entries are prefixed with its workspace name. Without this the flagship
  // issue flow could only `@` files in the issue's own repository, and a
  // valid `@backend/...` token was flagged unresolved.
  const fileScopes = useMemo(
    () => (multiRepo ? repositoryFileScopes(repos, wt.effectiveIsolate) : null),
    [multiRepo, repos, wt.effectiveIsolate],
  );

  // Reset per-open transient state, then fetch the thread this dialog was
  // opened for. Mirrors useTaskLaunch's own on-open fetch, but this one is
  // keyed on `context` too since it needs the issue's path/number. Keyed on
  // `context`'s primitive fields rather than the object itself — the caller
  // (GitHubDialog's `IssueActions`) re-renders on every board poll, and an
  // equal-valued-but-new-identity `context` object must NOT re-trigger this
  // (it would refetch the thread and reset `promptDirty`, wiping edits).
  // `wt.resetForOpen()`, `setReferences([])`, and the `taskType`/`typeDirty`
  // reset are here for the same reason as `setPromptDirty(false)`: a
  // previous issue's branch-name edits, isolate-toggle choice, attached
  // references, or manually-picked Type must not leak into the next open.
  // The pipeline selection clears here too (owner D5: no "last used
  // pipeline") — on every open AND on a context change.
  useEffect(() => {
    setPromptDirty(false);
    setSubmitError(null);
    setThread(null);
    setThreadError(null);
    wt.resetForOpen();
    setReferences([]);
    setTaskType(DEFAULT_TASK_TYPE);
    setTypeDirty(false);
    // A fresh seed carries no base ref, so `refDirty` starts false.
    setRepos(context?.path ? [{ path: context.path, root: null }] : []);
    launch.setPipelineId(null);
    if (!open || !context) return;
    setThreadLoading(true);
    let cancelled = false;
    api.getGitHubIssueThread(context.path, context.number)
      .then((result) => {
        if (cancelled) return;
        if (!sameIssueUrl(result.item.htmlUrl, context.url)) {
          setThreadError("That issue belongs to a different repository than this project.");
          return;
        }
        setThread(result);
      })
      .catch((e) => { if (!cancelled) setThreadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context?.path, context?.number, context?.url]);

  // Seed (and re-seed) the prompt from the fetched thread, but only while
  // the user hasn't started editing it — matches ResolveConflictsDialog's
  // "don't clobber what you typed" rule.
  useEffect(() => {
    if (!thread || promptDirty) return;
    setPrompt(buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, promptDirty]);

  // Seed (and re-seed) the Type picker from the fetched thread's labels, but
  // only while the user hasn't picked one themselves — same "don't clobber
  // what the user picked" rule as the prompt-seeding effect above.
  useEffect(() => {
    if (!thread || typeDirty) return;
    setTaskType(inferTaskTypeFromLabels(thread.item.labels));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, typeDirty]);

  const loading = launch.loading || threadLoading;
  const error = launch.loadError ?? threadError;

  const overage = launch.overageKind === null
    ? null
    : promptByteOverage(
        launch.overageKind,
        // A pipeline task's prompt is wrapped by `composeStepPrompt` (a strict
        // upper bound on bytes), so the raw prompt is the honest lower-bound
        // pre-check — New Task parity. A profile's instructions preamble DOES
        // ride the same one-shot launch, so it's included there.
        launch.pipelineId ? prompt : composeLaunchPrompt(launch.selectedProfile, prompt),
      );

  // The single Run rule (`launchGate`) — the issue's title is derived, so none
  // is required — plus this dialog's own conditions: the thread has loaded and
  // no submit is in flight.
  const gate = launchGate({
    title: "",
    prompt,
    requireTitle: false,
    reposCount: repos.length,
    worktreeValid: wt.valid,
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
  const canSubmit = !!context && !!thread && !submitting && gate.canRun;

  // Anything the user changed since the dialog opened: the prompt, attached
  // references, the Type picker, a worktree option, a base ref picked in the
  // Select Projects dialog, a second project, or a selected pipeline. The
  // pickers' automatic current-branch seeds are never saved (so never count),
  // and neither does the automatic issue-repo seed.
  const draftDirty =
    promptDirty ||
    references.length > 0 ||
    typeDirty ||
    !wt.effectiveIsolate ||
    refDirty ||
    wt.branchDirty ||
    repos.length > 1 ||
    launch.pipelineId !== null;

  /** "Manage pipelines…" / "Manage agents…": confirm before discarding a dirty
   *  draft, then close this dialog (the inner one) so the Git dialog beneath can
   *  be closed by the App callback without leaving a stacked overlay above the
   *  destination page. Cancel keeps everything open. */
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
    if (!context || !thread || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAndStartTask({
        title: issueTaskTitle(thread.item),
        prompt: prompt.trim(),
        // A pipeline's launch identity is its start-step profile's harness (the
        // server overrides this from the pipeline anyway); a selected profile's
        // own harness otherwise; else the manual pick (finding F2-3).
        agent: launch.effectiveAgent,
        // The same one mapping New Task uses: one project keeps the
        // single-repository shape, 2+ forces worktree isolation with one
        // entry per project (see `selectionPayload`).
        ...selectionPayload({
          repos,
          isolate: wt.effectiveIsolate,
          branchSubmitValue: wt.branchField.submitValue,
        }),
        // The same one mapping New Task uses (`submitPicks`): Fast is submitted
        // for every kind, and a selected profile's own values replace the manual
        // picks (the server re-resolves from the profile either way).
        ...submitPicks({
          kind: launch.kind,
          picks: { mode: launch.mode, model: launch.model, effort: launch.effort, speed: launch.speed, maxMode: launch.maxMode },
          profile: launch.selectedProfile,
        }),
        // Omit entirely when no profile/pipeline is selected (finding F2-1) —
        // see NewTaskForm.submit's matching comment. The two are mutually
        // exclusive by construction (each setter clears the other), so the
        // body never carries both.
        ...(launch.pipelineId ? { pipelineId: launch.pipelineId } : {}),
        ...(launch.agentProfileId ? { agentProfileId: launch.agentProfileId } : {}),
        column: "ready",
        references,
        taskType,
        issueUrl: thread.item.htmlUrl,
        issueSnapshot: renderIssueThreadMarkdown(thread),
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
      labelledBy="create-task-from-issue-dialog-title"
      className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col p-0 md:h-[min(46rem,calc(100vh-2rem))]"
    >
      {/* `display: contents` keeps this test-id wrapper out of the flex layout
       *  below — header/body/footer still act as direct flex items of the Dialog
       *  panel (which needs that for its max-h/overflow scroll region to work),
       *  while still giving e2e a stable node to find the whole dialog by and the
       *  shortcut a scope to listen on. Dialog's own props don't forward
       *  arbitrary data-* attributes onto the panel. */}
      <div ref={contentRef} data-testid="issue-task-dialog" className="contents">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle id="create-task-from-issue-dialog-title" className="flex items-center gap-2">
              <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Work on this with Agetor
            </DialogTitle>
            {context && (
              <DialogDescription className="truncate">
                #{context.number} — {context.title}
              </DialogDescription>
            )}
          </div>
          <DialogClose disabled={submitting} onClick={onClose} title="Close" />
        </DialogHeader>

        <DialogBody className="p-0 md:overflow-hidden">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-danger">
              <AlertCircle className="size-4" /> {error}
            </div>
          )}

          {!loading && !error && !context && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <AlertCircle className="size-4" /> The issue's state changed — close and reopen this dialog.
            </div>
          )}

          {!loading && !error && !!context && !!thread && (
            // Two columns from the `md` breakpoint (768 px), each scrolling on its
            // own; one column with one scroll below it. The footer sits outside.
            <div className="md:grid md:h-full md:min-h-0 md:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="space-y-4 px-5 py-4 md:min-h-0 md:overflow-y-auto">
                <Notice tone="info" icon={<Info className="size-3.5" />}>
                  <p>
                    {wt.effectiveIsolate
                      ? "Creates a task on a fresh branch in its own worktree."
                      : "Runs the agent directly in the project checkout — it commits onto your current branch, in your working tree."}{" "}
                    {thread.commentsError ? (
                      "The issue is embedded in the prompt (comments couldn't be fetched) and saved as a referenced snapshot file."
                    ) : (
                      <>
                        The issue and its {thread.comments.length} comment
                        {thread.comments.length === 1 ? "" : "s"}{" "}
                        {thread.comments.length === 1 ? "is" : "are"} embedded in the prompt and saved as a
                        referenced snapshot file.
                      </>
                    )}
                    {wt.effectiveIsolate && " The agent commits locally; it never pushes."}
                    {thread.truncated && " Thread truncated at the fetch cap."}
                  </p>
                  {thread.refetchCommand && (
                    <p>
                      Re-fetch: <code className="font-mono">{thread.refetchCommand}</code>
                    </p>
                  )}
                </Notice>

                {thread.commentsError && (
                  <Notice tone="warning" icon={<AlertTriangle className="size-3.5" />}>
                    <div>Comments weren't fetched — {thread.commentsError}</div>
                    {thread.refetchCommand && (
                      <div>The agent can fetch them itself with the re-fetch command in the prompt.</div>
                    )}
                  </Notice>
                )}

                <TaskTypePicker
                  value={taskType}
                  onChange={(t) => { setTaskType(t); setTypeDirty(true); }}
                />

                <PromptComposer
                  value={prompt}
                  onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                  agent={launch.effectiveAgent}
                  references={references}
                  onReferencesChange={setReferences}
                  setReferences={setReferences}
                  fileScope={fileScope}
                  fileScopes={fileScopes}
                  startingFolder={context.path}
                  rows={12}
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
                  state={wt}
                  repos={repos}
                  onReposChange={setRepos}
                  lockedPath={context.path}
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
            reason={gate.runBlockedReason}
            error={submitError}
            cancel={{ label: "Cancel", onClick: onClose, disabled: submitting, testId: "launch-cancel" }}
            primary={{ label: "Run task", onClick: () => void submit(), disabled: !canSubmit, testId: "issue-task-submit", busy: submitting }}
          />
        </DialogFooter>
      </div>
    </Dialog>
  );
}
