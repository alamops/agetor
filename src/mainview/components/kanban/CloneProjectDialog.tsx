import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { buildEli5Prompt } from "../../../shared/clone-eli5.ts";
import { TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful clone so the parent refreshes its project list. */
  onCloned: () => void;
}

/** Client-side mirror of the server's repo-name extraction — used only to
 *  preview the default destination in the placeholder. The server re-parses
 *  and is the authority. */
const repoNameFrom = (url: string): string | null => {
  const m = url
    .trim()
    .match(/(?:github\.com[:/][^/\s]+\/|^[^/\s:@]+\/)([^/\s:@]+?)(?:\.git)?\/?$/i);
  return m ? (m[1] ?? null) : null;
};

/**
 * "Clone repository" flow for the Projects sidebar: paste a repo URL (or
 * owner/repo), optionally override the destination folder, and choose whether
 * agetor should auto-run an explainer task that writes ELI5.md at the clone's
 * root. While that switch is on, the same shared launch pickers the other
 * launch dialogs use (`useTaskLaunch`/`TaskLaunchPickers`) let the user pick
 * an Agent profile or a manual Harness/Mode/Model/Effort for the explainer
 * task — mirroring `ResolveConflictsDialog`. With the switch off, a plain
 * clone is always possible even if harness data failed to load. The clone
 * request stays in flight while the dialog shows a busy state — big repos
 * can take a while.
 */
export function CloneProjectDialog({ open, onClose, onCloned }: Props) {
  const launch = useTaskLaunch(open);

  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [eli5, setEli5] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);

  // Fresh form every open — a stale URL from the previous clone is never
  // what the user wants pre-filled. Harness/model/prefs fetching is owned
  // by useTaskLaunch, which re-seeds the manual block on every open but
  // never clears the selected profile — and this dialog stays mounted
  // (ProjectPicker renders it permanently), so clear it here too.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setDest("");
    setEli5(true);
    setError(null);
    launch.setAgentProfileId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const repo = repoNameFrom(url);

  const overage = eli5
    ? promptByteOverage(
        launch.effectiveKind,
        composeLaunchPrompt(launch.selectedProfile, buildEli5Prompt(repo ?? "repo")),
      )
    : null;
  // Names the harness a launch will ACTUALLY run under — the selected
  // profile's harness when one is picked, else the manually-picked one
  // (mirrors ResolveConflictsDialog).
  const selectedHarnessLabel = launch.harnesses.find((h) => h.id === launch.effectiveAgent)?.label ?? launch.effectiveAgent;

  const canSubmit =
    url.trim().length > 0 &&
    !busy &&
    (!eli5 ||
      (!launch.loading &&
        !launch.loadError &&
        !!launch.effectiveStatus?.available &&
        // `startTask` hard-refuses a logged-out harness. Everywhere else that
        // costs a rolled-back task; here it would cost a finished clone plus a
        // dead explainer task, so gate on it up front.
        launch.effectiveStatus.loggedIn !== false &&
        overage == null));

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.cloneProject({
        url: trimmed,
        dest: dest.trim() || undefined,
        eli5,
        // Only forward launch fields when the explainer is actually
        // running — and, when it is, a bound profile wins outright (never
        // send it alongside the manual fields, and never send it as null).
        ...(eli5
          ? launch.agentProfileId
            ? { agentProfileId: launch.agentProfileId }
            : {
                agent: launch.agent,
                mode: launch.mode,
                model: launch.model,
                effort: launch.effort,
                fast: launch.fast,
                maxMode: launch.maxMode,
              }
          : {}),
      });
      if (eli5 && result.eli5TaskId) launch.rememberPicks();
      onCloned();
      onClose();
      toast.success(`Cloned ${result.project.name}`, {
        description: result.eli5TaskId
          ? "Explainer task started — watch it on the board; it writes ELI5.md at the repo root."
          : result.eli5Error
            ? `Clone succeeded, but the explainer task failed: ${result.eli5Error}`
            : result.project.path,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (canSubmit) void submit();
  };

  return (
    <Dialog
      open={open}
      // Don't let Escape/backdrop abandon a clone mid-flight with no feedback.
      onClose={busy ? () => {} : onClose}
      labelledBy="clone-project-title"
      initialFocusRef={urlRef}
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      {/* `display: contents` keeps this test-id wrapper out of the flex
       *  layout below — header/body/footer still act as direct flex items
       *  of the Dialog panel (which needs that for its max-h/overflow
       *  scroll region to work), while still giving e2e a stable node to
       *  find the whole dialog by. Dialog's own props don't forward
       *  arbitrary data-* attributes onto the panel. */}
      <div data-testid="clone-project-dialog" className="contents">
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 id="clone-project-title" className="text-sm font-semibold">
            Clone repository
          </h2>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="size-7"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
          <div className="space-y-1.5">
            <label htmlFor="clone-url" className="text-xs font-medium text-muted-foreground">
              Repository
            </label>
            <Input
              id="clone-url"
              data-testid="clone-url"
              ref={urlRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onEnter}
              placeholder="https://github.com/owner/repo or owner/repo"
              spellCheck={false}
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="clone-dest" className="text-xs font-medium text-muted-foreground">
              Destination folder
            </label>
            <Input
              id="clone-dest"
              data-testid="clone-dest"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              onKeyDown={onEnter}
              placeholder={repo ? `default: ~/${repo}` : "default: ~/<repo>"}
              spellCheck={false}
              disabled={busy}
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-xs font-medium">Explain this repo</span>
              <span className="block text-[11px] text-muted-foreground">
                Runs a task that writes an ELI5.md guide at the repo root
              </span>
            </span>
            <Switch data-testid="clone-eli5-switch" checked={eli5} onCheckedChange={setEli5} disabled={busy} />
          </label>

          {eli5 && (
            <div data-testid="clone-launch" className="space-y-3">
              {launch.loading && (
                <div role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading harnesses…
                </div>
              )}

              {!launch.loading && launch.loadError && (
                <div role="alert" className="space-y-1 text-xs">
                  <div className="flex items-center gap-2 text-danger">
                    <AlertCircle className="size-4 shrink-0" /> {launch.loadError}
                  </div>
                  <div className="text-muted-foreground">
                    Turn off "Explain this repo" above to clone without picking an agent.
                  </div>
                </div>
              )}

              {!launch.loading && !launch.loadError && (
                // Frozen while the (possibly multi-minute) clone is in flight:
                // the payload is already sent, and `rememberPicks()` reads the
                // live picker state afterwards — a mid-flight change would
                // persist picks that never launched.
                <fieldset disabled={busy} className="m-0 min-w-0 space-y-3 border-0 p-0">
                  <TaskLaunchPickers launch={launch} />

                  {!launch.effectiveStatus && (
                    <div role="alert" className="text-[11px] text-muted-foreground">
                      No enabled harness to run the explainer on — enable one in Settings → Harnesses,
                      or turn off "Explain this repo" to clone without it.
                    </div>
                  )}

                  {overage && (
                    <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                      This prompt is {Math.ceil(overage.bytes / 1024)} KB — {selectedHarnessLabel}'s
                      one-shot launch caps prompts at {Math.floor(overage.limit / 1024)} KB. Pick
                      another agent or harness, or turn off "Explain this repo".
                    </div>
                  )}
                </fieldset>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button data-testid="clone-submit" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Cloning…" : "Clone"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
