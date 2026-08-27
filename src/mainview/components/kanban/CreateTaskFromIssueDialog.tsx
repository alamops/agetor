import { useEffect, useState } from "react";
import { AlertCircle, Bot, Loader2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { GitHubIssueThreadResult } from "../../../shared/types.ts";
import {
  buildIssueTaskPrompt,
  issueTaskTitle,
  normalizeIssueUrl,
  renderIssueThreadMarkdown,
} from "../../../shared/issue-task.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";

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
 * `./TaskLaunchPickers`). Fetches the full issue thread on open, seeds an
 * editable prompt from it, and creates + starts a task on a fresh worktree
 * branch with the thread embedded (inline in the prompt, and in full as a
 * referenced snapshot file).
 */
export function CreateTaskFromIssueDialog({ open, onClose, context, onCreated }: Props) {
  const launch = useTaskLaunch(open);

  const [thread, setThread] = useState<GitHubIssueThreadResult | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset per-open transient state, then fetch the thread this dialog was
  // opened for. Mirrors useTaskLaunch's own on-open fetch, but this one is
  // keyed on `context` too since it needs the issue's path/number.
  useEffect(() => {
    setPromptDirty(false);
    setSubmitError(null);
    setThread(null);
    setThreadError(null);
    if (!open || !context) return;
    setThreadLoading(true);
    let cancelled = false;
    api.getGitHubIssueThread(context.path, context.number)
      .then((result) => {
        if (cancelled) return;
        if (normalizeIssueUrl(result.item.htmlUrl) !== normalizeIssueUrl(context.url)) {
          setThreadError("That issue belongs to a different repository than this project.");
          return;
        }
        setThread(result);
      })
      .catch((e) => { if (!cancelled) setThreadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context]);

  // Seed (and re-seed) the prompt from the fetched thread, but only while
  // the user hasn't started editing it — matches ResolveConflictsDialog's
  // "don't clobber what you typed" rule.
  useEffect(() => {
    if (!thread || promptDirty) return;
    setPrompt(buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, promptDirty]);

  const loading = launch.loading || threadLoading;
  const error = launch.loadError ?? threadError;

  const overage = promptByteOverage(launch.kind, prompt);
  const selectedHarnessLabel = launch.harnesses.find((h) => h.id === launch.agent)?.label ?? launch.agent;

  const canSubmit =
    !!context &&
    !!thread &&
    prompt.trim().length > 0 &&
    !!launch.selectedStatus?.available &&
    !submitting &&
    promptByteOverage(launch.kind, prompt) == null;

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
        isolation: "worktree",
        mode: launch.mode,
        model: launch.model,
        effort: launch.effort,
        column: "ready",
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
                Creates a task on a fresh branch in its own worktree. The issue and its{" "}
                {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}{" "}
                {thread.comments.length === 1 ? "is" : "are"} embedded in the prompt and saved as a
                referenced snapshot file. The agent commits locally; it never pushes.
                {thread.truncated && " Thread truncated at the fetch cap."}
                {thread.refetchCommand && (
                  <div className="mt-1">
                    Re-fetch: <code className="font-mono">{thread.refetchCommand}</code>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-muted-foreground">Prompt</label>
                <Textarea
                  value={prompt}
                  onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
                  rows={12}
                  className="resize-none"
                />
              </div>

              <TaskLaunchPickers launch={launch} />

              {overage && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                  This prompt is {Math.ceil(overage.bytes / 1024)} KB — {selectedHarnessLabel}'s one-shot
                  launch caps prompts at {Math.floor(overage.limit / 1024)} KB. Pick another harness or
                  trim the prompt.
                </div>
              )}

              {submitError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
                  {submitError}
                </div>
              )}
            </div>
          )}
        </div>

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
