import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Bot, FileText, Loader2, SlidersHorizontal, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, type IssueTaskTemplate } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { DEFAULT_TASK_TYPE, type GitHubIssueThreadResult, type TaskReference, type TaskType } from "../../../shared/types.ts";
import {
  buildIssueTaskPrompt,
  inferTaskTypeFromLabels,
  issueRepoSlug,
  issueTaskTitle,
  renderIssueTaskTemplate,
  renderIssueThreadMarkdown,
  sameIssueUrl,
} from "../../../shared/issue-task.ts";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";
import { useWorktreeOptions, WorktreeOptions } from "./WorktreeOptions";
import { PromptComposer } from "./PromptComposer";
import { TaskTypePicker } from "./TaskTypePicker";
import { IssueTaskTemplateDialog } from "@/components/settings/IssueTaskTemplateDialog";

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
 *
 * A project can replace that starting point with its own issue task template
 * (`Project.issueTaskTemplate`, edited through "Configure issue template"):
 * the prompt is then seeded from `renderIssueTaskTemplate` instead of
 * `buildIssueTaskPrompt`, and the template's agent profile is preselected
 * when it still exists. Only the seed changes — the prompt stays editable,
 * the snapshot file is still attached, and the same-repo check still runs.
 */
export function CreateTaskFromIssueDialog({ open, onClose, context, onCreated }: Props) {
  const launch = useTaskLaunch(open);

  const [thread, setThread] = useState<GitHubIssueThreadResult | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);

  // The project's issue task template (null = none, or the fetch failed —
  // both fall back to the stock prompt). Fetched on open alongside the
  // thread; `templateLoading` holds the dialog in its loading state so the
  // stock prompt never flashes before the template replaces it.
  const [template, setTemplate] = useState<IssueTaskTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  // Per-open latch: the template's agent is preselected at most once (and
  // again only when the template itself is re-saved), so a user who then
  // picks another agent is never overridden. `seededProfileRef` remembers
  // which profile the template put there, so the next open can undo it —
  // a template-driven pick must not leak into an issue from another project.
  const [profileSeeded, setProfileSeeded] = useState(false);
  const seededProfileRef = useRef<string | null>(null);
  const { loaded: profilesLoaded } = useAgentProfiles({ enabled: open });
  const [references, setReferences] = useState<TaskReference[]>([]);

  // This modal now has a Type picker (`TaskTypePicker`, mirroring the New
  // Task form), seeded from the issue's own labels via
  // `inferTaskTypeFromLabels` once the thread loads — see the seeding effect
  // below. `typeDirty` mirrors `promptDirty`'s "don't clobber what the user
  // picked" rule: once the user touches the picker themselves, label-driven
  // re-seeding stops.
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [typeDirty, setTypeDirty] = useState(false);

  // The branch-name field derives live from the current title + taskType
  // (same `issueTaskTitle` the submit path uses), so it shows e.g.
  // `fix/issue-7-…` for a bug-labelled issue once the thread loads.
  const wt = useWorktreeOptions({
    workdir: context?.path ?? "",
    title: thread ? issueTaskTitle(thread.item) : "",
    taskType,
    // `IssueActions` (GitHubDialog.tsx) mounts this dialog unconditionally,
    // so the branch-config fetch must stay off until it's actually open.
    enabled: open,
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // `@` file-reference scope — gated on `open` since `IssueActions` mounts
  // this dialog unconditionally (same reason `useWorktreeOptions` above
  // takes `enabled: open`): a closed dialog must never fetch a listing.
  // Memoized so `useProjectFiles`'s effect doesn't refire on every
  // unrelated re-render.
  const fileScope = useMemo(
    () => (open ? { dir: context?.path ?? "", ref: wt.isolate ? (wt.baseRef.trim() || "HEAD") : null } : null),
    [open, context?.path, wt.isolate, wt.baseRef],
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
  useEffect(() => {
    setPromptDirty(false);
    setSubmitError(null);
    setThread(null);
    setThreadError(null);
    wt.resetForOpen();
    setReferences([]);
    setTaskType(DEFAULT_TASK_TYPE);
    setTypeDirty(false);
    setTemplate(null);
    setTemplateLoading(false);
    setProfileSeeded(false);
    if (seededProfileRef.current !== null) {
      if (launch.agentProfileId === seededProfileRef.current) launch.setAgentProfileId(null);
      seededProfileRef.current = null;
    }
    if (!open || !context) return;
    setThreadLoading(true);
    setTemplateLoading(true);
    let cancelled = false;
    api.getProjectIssueTemplate(context.path)
      .then((t) => { if (!cancelled) setTemplate(t); })
      .catch(() => { /* unregistered project / older core — use the stock prompt */ })
      .finally(() => { if (!cancelled) setTemplateLoading(false); });
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

  // Seed (and re-seed) the prompt from the fetched thread — through the
  // project's issue template when it has one — but only while the user
  // hasn't started editing it — matches ResolveConflictsDialog's "don't
  // clobber what you typed" rule.
  useEffect(() => {
    if (!thread || promptDirty) return;
    setPrompt(
      template
        ? renderIssueTaskTemplate(template.prompt, {
          number: thread.item.number,
          title: thread.item.title,
          url: thread.item.htmlUrl,
          repo: issueRepoSlug(thread.item.htmlUrl),
        })
        : buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, promptDirty, template]);

  // Preselect the template's agent profile once the profile list is known.
  // A profile that no longer exists is skipped silently — the stored id is a
  // soft reference, and the manual pickers are a fine fallback.
  useEffect(() => {
    if (!open || profileSeeded || !template?.agentProfileId || !profilesLoaded) return;
    setProfileSeeded(true);
    const id = template.agentProfileId;
    if (!launch.profiles.some((p) => p.id === id)) return;
    launch.setAgentProfileId(id);
    seededProfileRef.current = id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profileSeeded, template, profilesLoaded, launch.profiles]);

  // Seed (and re-seed) the Type picker from the fetched thread's labels, but
  // only while the user hasn't picked one themselves — same "don't clobber
  // what the user picked" rule as the prompt-seeding effect above.
  useEffect(() => {
    if (!thread || typeDirty) return;
    setTaskType(inferTaskTypeFromLabels(thread.item.labels));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, typeDirty]);

  const loading = launch.loading || threadLoading || templateLoading;
  const error = launch.loadError ?? threadError;

  const overage = promptByteOverage(launch.effectiveKind, composeLaunchPrompt(launch.selectedProfile, prompt));
  // Names the harness a launch will ACTUALLY run under — the selected
  // profile's harness when one is picked, else the manually-picked one
  // (finding F2-3; `launch.agent`/`selectedStatus` stay pinned to the
  // manual picker and go stale once a profile hides that block).
  const selectedHarnessLabel = launch.harnesses.find((h) => h.id === launch.effectiveAgent)?.label ?? launch.effectiveAgent;

  const canSubmit =
    !!context &&
    !!thread &&
    prompt.trim().length > 0 &&
    !!launch.effectiveStatus?.available &&
    !submitting &&
    overage == null &&
    wt.valid;

  const submit = async () => {
    if (!context || !thread || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAndStartTask({
        title: issueTaskTitle(thread.item),
        prompt: prompt.trim(),
        agent: launch.agent,
        workdir: context.path,
        ...wt.payload(),
        mode: launch.mode,
        model: launch.model,
        effort: launch.effort,
        fast: launch.fast,
        maxMode: launch.maxMode,
        // Omit entirely when no profile is selected (finding F2-1) — see
        // NewTaskForm.submit's matching comment.
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="create-task-from-issue-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      {/* `display: contents` keeps this test-id wrapper out of the flex
       *  layout below — header/body/footer still act as direct flex items
       *  of the Dialog panel (which needs that for its max-h/overflow
       *  scroll region to work), while still giving e2e a stable node to
       *  find the whole dialog by. Dialog's own props don't forward
       *  arbitrary data-* attributes onto the panel. */}
      <div data-testid="issue-task-dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id="create-task-from-issue-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
              <Bot className="size-4 shrink-0 text-muted-foreground" />
              Work on this with Agetor
            </div>
            {context && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                #{context.number} — {context.title}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="Close"
            aria-label="Close"
            disabled={submitting}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
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
            <div className="space-y-3">
              <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                {wt.isolate
                  ? "Creates a task on a fresh branch in its own worktree."
                  : "Runs the agent directly in the project checkout — it commits onto your current branch, in your working tree."}{" "}
                {template ? (
                  "The prompt comes from this project's issue template; the issue thread is saved as a referenced snapshot file."
                ) : thread.commentsError ? (
                  "The issue is embedded in the prompt (comments couldn't be fetched) and saved as a referenced snapshot file."
                ) : (
                  <>
                    The issue and its {thread.comments.length} comment
                    {thread.comments.length === 1 ? "" : "s"}{" "}
                    {thread.comments.length === 1 ? "is" : "are"} embedded in the prompt and saved as a
                    referenced snapshot file.
                  </>
                )}
                {wt.isolate && " The agent commits locally; it never pushes."}
                {thread.truncated && " Thread truncated at the fetch cap."}
                {thread.refetchCommand && (
                  <div className="mt-1">
                    Re-fetch: <code className="font-mono">{thread.refetchCommand}</code>
                  </div>
                )}
              </div>

              {thread.commentsError && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <div>Comments weren't fetched — {thread.commentsError}</div>
                    {thread.refetchCommand && (
                      <div className="mt-1">
                        The agent can fetch them itself with the re-fetch command in the prompt.
                      </div>
                    )}
                  </div>
                </div>
              )}

              <TaskTypePicker
                value={taskType}
                onChange={(t) => { setTaskType(t); setTypeDirty(true); }}
              />

              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                {template ? (
                  <span data-testid="issue-template-hint" className="flex min-w-0 items-center gap-1">
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">Prompt from this project&apos;s issue template</span>
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  data-testid="issue-template-configure"
                  onClick={() => setTemplateDialogOpen(true)}
                  title="Set the prompt and agent every issue in this project starts with"
                  className="flex shrink-0 items-center gap-1 transition-colors hover:text-foreground"
                >
                  <SlidersHorizontal className="size-3" />
                  Configure issue template
                </button>
              </div>

              <PromptComposer
                value={prompt}
                onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                agent={launch.effectiveAgent}
                references={references}
                onReferencesChange={setReferences}
                setReferences={setReferences}
                fileScope={fileScope}
                startingFolder={context.path}
                rows={12}
                footer={overage && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                    This prompt is {Math.ceil(overage.bytes / 1024)} KB — {selectedHarnessLabel}'s one-shot
                    launch caps prompts at {Math.floor(overage.limit / 1024)} KB. Pick another harness or
                    trim the prompt.
                  </div>
                )}
              />

              <WorktreeOptions state={wt} />

              <TaskLaunchPickers launch={launch} />

              {submitError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
                  {submitError}
                </div>
              )}
            </div>
          )}
        </div>

        {context && (
          <IssueTaskTemplateDialog
            open={templateDialogOpen}
            onClose={() => setTemplateDialogOpen(false)}
            projectPath={context.path}
            harnesses={launch.harnesses}
            previewIssue={thread ? {
              number: thread.item.number,
              title: thread.item.title,
              url: thread.item.htmlUrl,
              repo: issueRepoSlug(thread.item.htmlUrl),
            } : undefined}
            onSaved={(t) => {
              // Re-arm the agent preselection for the new template. The
              // prompt re-seeds through the effect above — unless the user
              // already edited it, which still wins.
              setTemplate(t);
              setProfileSeeded(false);
            }}
          />
        )}

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 p-3">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button data-testid="issue-task-submit" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-3.5 animate-spin" /> Creating…
              </>
            ) : (
              "Create & start"
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
