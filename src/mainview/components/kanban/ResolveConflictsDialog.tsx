import { useEffect, useRef, useState } from "react";
import { AlertCircle, GitMerge, Loader2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { buildResolveConflictsPrompt } from "@/lib/resolve-conflicts-prompt";
import { createAndStartTask, TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";

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
}

export function ResolveConflictsDialog({ open, onClose, context, onCreated }: Props) {
  const launch = useTaskLaunch(open);

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset per-open transient state (prompt dirtiness, errors) so a previous
  // PR's edits don't leak into the next one. Harness/model/prefs fetching is
  // owned by useTaskLaunch.
  useEffect(() => {
    if (!open) return;
    setPromptDirty(false);
    setSubmitError(null);
  }, [open]);

  // Seed (and re-seed) the prompt from the context, but only while the user
  // hasn't started editing it — matches the composer's usual "don't clobber
  // what you typed" rule.
  useEffect(() => {
    if (!open || !context || promptDirty) return;
    setPrompt(buildResolveConflictsPrompt(context));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, context, promptDirty]);

  const canSubmit = !!context && prompt.trim().length > 0 && !!launch.selectedStatus?.available && !submitting;

  const submit = async () => {
    if (!context || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAndStartTask({
        title: `Resolve conflicts: PR #${context.number} — ${context.title}`,
        prompt: prompt.trim(),
        agent: launch.agent,
        workdir: context.path,
        isolation: "worktree" as const,
        existingBranch: context.headRef,
        mode: launch.mode,
        model: launch.model,
        effort: launch.effort,
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="resolve-conflicts-dialog-title"
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="resolve-conflicts-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitMerge className="size-4 shrink-0 text-muted-foreground" />
            Resolve with Agetor
          </div>
          {context && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              PR #{context.number} — {context.title}
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
          <div className="space-y-3">
            {context && (
              <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                Merges <span className="font-mono">origin/{context.baseRef}</span> into{" "}
                <span className="font-mono">{context.headRef}</span> in a worktree checked out on that
                branch. The agent commits locally; it never pushes.
              </div>
            )}

            <div className="space-y-1">
              <label className="text-muted-foreground">Prompt</label>
              <Textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
                rows={8}
                className="resize-none"
              />
            </div>

            <TaskLaunchPickers launch={launch} />

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
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? (
            <>
              <Loader2 className="mr-1 size-3.5 animate-spin" /> Creating…
            </>
          ) : (
            "Create & start"
          )}
        </Button>
      </div>
    </Dialog>
  );
}
