import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { latestCloneProgress, subscribeCloneProgress, type CloneProgressEvent } from "@/lib/clone-progress";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { buildEli5Prompt } from "../../../shared/clone-eli5.ts";
import { CLONE_PROVIDERS, detectCloneProvider, parseCloneInput } from "../../../shared/clone-input.ts";
import { PROVIDER_CAPS, type GitProvider } from "../../../shared/types.ts";
import { TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";

/** Human copy for each in-progress `CloneProgressPhase` — the two terminal
 *  phases the dialog can actually observe live (`failed`/`cancelled`) never
 *  reach this map because `submit()`'s `finally` clears `progress` back to
 *  `null` (and the row goes back to its visually-hidden, non-`busy` state)
 *  the moment its `await` settles (an error, or a close-on-cancel). */
const CLONE_PHASE_LABEL: Record<Exclude<CloneProgressEvent["phase"], "failed" | "cancelled">, string> = {
  starting: "Starting…",
  counting: "Counting objects…",
  compressing: "Compressing objects…",
  receiving: "Receiving objects…",
  resolving: "Resolving deltas…",
  "checking-out": "Checking out files…",
  done: "Finishing…",
};

/** Narrows an `ApiError`'s parsed JSON body to the shape the 409 response
 *  for a cancelled clone carries (`{ error, cancelled: true }`), so `submit`
 *  can tell that apart from any other 409 the route might one day return. */
function isCancelledCloneError(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { cancelled?: unknown }).cancelled === true;
}

/** Phase label for the live progress row — falls back to the sanitized raw
 *  `line` text for the two terminal phases (`failed`/`cancelled`) that
 *  `CLONE_PHASE_LABEL` deliberately omits (see its own doc comment) but
 *  which can, in a narrow race, still arrive over `/app/events` moments
 *  before the held `cloneProject` POST's own rejection reaches this
 *  component and clears `progress`. */
function cloneProgressLabel(e: CloneProgressEvent): string {
  return (CLONE_PHASE_LABEL as Partial<Record<CloneProgressEvent["phase"], string>>)[e.phase] ?? e.line;
}

/** Folds a freshly-published `clone_progress` event onto the previous one for
 *  the progress bar's `value` — git's own stderr lines don't carry a percent
 *  on every line (a phase-change banner, a "done" summary, …), and without
 *  this a percent-bearing line followed by a percent-less one on the SAME
 *  phase would flip the `<progress>` bar back to indeterminate and then
 *  forward again, reading as the clone stalling and restarting. Carries the
 *  last known percent forward only within a phase; a genuine phase change
 *  (git counts, compresses, then receives — each its own 0-100% span)
 *  always resets to whatever the new event reports, indeterminate included. */
function mergeCloneProgress(prev: CloneProgressEvent | null, next: CloneProgressEvent): CloneProgressEvent {
  if (prev && prev.phase === next.phase && next.percent == null && prev.percent != null) {
    return { ...next, percent: prev.percent };
  }
  return next;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful clone so the parent refreshes its project list. */
  onCloned: () => void;
}

/** Repository-field placeholder, one per provider — shown for whichever
 *  provider is currently effective (detected from the URL, or picked in the
 *  Provider select). */
const REPO_PLACEHOLDER: Record<GitProvider, string> = {
  github: "https://github.com/owner/repo, git@github.com:owner/repo.git or owner/repo",
  gitlab: "https://gitlab.com/group/project, git@gitlab.com:group/project.git or group/project",
  bitbucket: "https://bitbucket.org/workspace/repo, git@bitbucket.org:workspace/repo.git or workspace/repo",
};

/**
 * "Clone repository" flow for the Projects sidebar: paste a GitHub, GitLab or
 * Bitbucket Cloud repository URL in https/ssh form (or bare `owner/repo`
 * shorthand, resolved against the Provider select below), optionally
 * override the destination folder, and choose whether agetor should auto-run
 * an explainer task that writes ELI5.md at the clone's root. Parsing and
 * provider detection come from the shared, pure `src/shared/clone-input.ts`
 * parser — one implementation the server also uses, so "what counts as a
 * valid clone input" can't drift between the two; the server remains the
 * authority and layers the git integration's real host-resolution rules
 * (ssh alias resolution, Bitbucket Server rejection, per-host GitLab token
 * scoping) on top of what this dialog can check client-side. While the
 * explainer switch is on, the same shared launch pickers the other launch
 * dialogs use (`useTaskLaunch`/`TaskLaunchPickers`) let the user pick an
 * Agent profile or a manual Harness/Mode/Model/Effort for the explainer task
 * — mirroring `ResolveConflictsDialog`. With the switch off, a plain clone is
 * always possible even if harness data failed to load. The clone request
 * stays in flight while the dialog shows a busy state — big repos can take a
 * while.
 */
export function CloneProjectDialog({ open, onClose, onCloned }: Props) {
  const launch = useTaskLaunch(open);

  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<GitProvider>("github");
  const [dest, setDest] = useState("");
  const [eli5, setEli5] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The in-flight clone's live progress (`null` until the first event
  // arrives) and whether a Cancel request is itself in flight — both reset
  // per-open below and cleared in `submit()`'s `finally`. `cloneIdRef` is a
  // ref, not state: it's minted once per submit, read by the Cancel handler,
  // and never drives a render on its own.
  const [progress, setProgress] = useState<CloneProgressEvent | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cloneIdRef = useRef<string | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);

  // Fresh form every open — a stale URL from the previous clone is never
  // what the user wants pre-filled. Harness/model/prefs fetching is owned
  // by useTaskLaunch, which re-seeds the manual block on every open but
  // never clears the selected profile — and this dialog stays mounted
  // (ProjectPicker renders it permanently), so clear it here too.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setProvider("github");
    setDest("");
    setEli5(true);
    setError(null);
    setProgress(null);
    setCancelling(false);
    cloneIdRef.current = null;
    launch.setAgentProfileId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // `detected` locks the Provider select to whatever a full URL's own host
  // names (a full URL's host always wins); `provider` is the user's own pick,
  // used only for shorthand — kept separate so typing a full URL and then
  // deleting it back to shorthand doesn't lose a manual pick.
  const detected = detectCloneProvider(url);
  const effectiveProvider = detected ?? provider;
  const parsed = parseCloneInput(url, effectiveProvider);
  const repo = parsed.ok ? parsed.value.repo : null;
  // A full URL whose host names none of the three supported providers: the
  // Provider select can't help (there's no shorthand to disambiguate), so it
  // stays disabled and the helper explains why instead of implying a pick
  // would fix it.
  const unsupportedHost = !parsed.ok && parsed.code === "unsupported-host";
  const providerHint =
    detected !== null
      ? `Detected from the URL: ${PROVIDER_CAPS[detected].providerName}`
      : unsupportedHost
        ? "Unrecognized host — only GitHub, GitLab and Bitbucket Cloud hosts are supported"
        : "Used for owner/repo shorthand";

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
    if (!trimmed) return;
    // The client-side parser is non-blocking while typing (a half-typed URL
    // is always "invalid"), but a click/Enter with an unparseable value must
    // surface the parser's own error rather than silently doing nothing —
    // the server stays the ultimate authority and still re-parses on its own.
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    // Mint the id and subscribe BEFORE awaiting the clone request — the
    // server can start emitting `clone_progress` events the moment it
    // accepts the POST, and subscribing after the await would miss
    // everything up to the first progress-triggered re-render (there isn't
    // one, since nothing else about this call causes a render in between,
    // but the ordering is the contract `clone-progress.ts` is written to).
    const cloneId = crypto.randomUUID();
    cloneIdRef.current = cloneId;
    setProgress(latestCloneProgress(cloneId));
    const unsubscribe = subscribeCloneProgress(cloneId, (e) => setProgress((prev) => mergeCloneProgress(prev, e)));
    try {
      const result = await api.cloneProject({
        url: trimmed,
        provider: effectiveProvider,
        dest: dest.trim() || undefined,
        eli5,
        cloneId,
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
      // The 409 the server answers the held POST with once `cancelClone`
      // kills the git process — a user-initiated cancel, not a failure, so
      // it closes the dialog with an info toast instead of the inline
      // `clone-error` banner every other failure gets.
      if (err instanceof ApiError && err.status === 409 && isCancelledCloneError(err.body)) {
        onClose();
        toast.info("Clone cancelled");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      unsubscribe();
      cloneIdRef.current = null;
      setProgress(null);
      setCancelling(false);
      setBusy(false);
    }
  };

  const cancelClone = async () => {
    const id = cloneIdRef.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelClone(id);
      // Success just means the kill was issued — the held `cloneProject`
      // call above is what actually observes the outcome (its 409 catch
      // branch closes the dialog and toasts). Nothing to do here but wait.
    } catch (err) {
      // A 404 means the clone already finished (succeeded or failed) on its
      // own between the click and this request landing — a benign race,
      // not something to surface. Anything else is unexpected but shouldn't
      // block the user from trying again or waiting out the still-running
      // clone, so it's a toast, not the inline banner.
      if (!(err instanceof ApiError && err.status === 404)) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      setCancelling(false);
    }
  };

  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
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
            <label htmlFor="clone-provider" className="text-xs font-medium text-muted-foreground">
              Provider
            </label>
            <Select
              id="clone-provider"
              data-testid="clone-provider"
              value={effectiveProvider}
              onChange={(e) => {
                setProvider(e.target.value as GitProvider);
                setError(null);
              }}
              disabled={busy || detected !== null || unsupportedHost}
              aria-describedby="clone-provider-hint"
            >
              {CLONE_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_CAPS[p].providerName}
                </option>
              ))}
            </Select>
            <p
              id="clone-provider-hint"
              aria-live="polite"
              className={unsupportedHost ? "text-[11px] text-warning" : "text-[11px] text-muted-foreground"}
              data-testid="clone-provider-detected"
            >
              {providerHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="clone-url" className="text-xs font-medium text-muted-foreground">
              Repository
            </label>
            <Input
              id="clone-url"
              data-testid="clone-url"
              ref={urlRef}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={onEnter}
              placeholder={REPO_PLACEHOLDER[effectiveProvider]}
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
              onChange={(e) => {
                setDest(e.target.value);
                setError(null);
              }}
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
            <p
              role="alert"
              data-testid="clone-error"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          {/* Rides the `clone_progress` AppEvent forwarded through
           *  clone-progress.ts's module store (see the import above) — never
           *  its own EventSource, per the store's own doc comment. `progress`
           *  starts `null` (no event yet, e.g. the server hasn't started
           *  `git clone` itself) — the phase label falls back to "Starting…"
           *  and the bar renders indeterminate.
           *
           *  Mounted unconditionally (visually hidden via `sr-only` while
           *  `!busy`) rather than only while busy: an `aria-live` region
           *  that's inserted into the DOM already containing its first bit
           *  of text is a mount, not an update, and screen readers skip a
           *  live region's initial content on mount — only SUBSEQUENT
           *  changes to an already-present region get announced. Keeping it
           *  in the DOM from the start means the very first phase text still
           *  lands as a real update. */}
          <div
            data-testid="clone-progress"
            className={
              busy
                ? "space-y-1.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
                : "sr-only"
            }
          >
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {busy ? (progress ? cloneProgressLabel(progress) : "Starting…") : ""}
            </p>
            <progress
              data-testid="clone-progress-bar"
              max={100}
              value={busy ? progress?.percent ?? undefined : undefined}
              aria-label="Clone progress"
              aria-valuetext={busy ? (progress ? cloneProgressLabel(progress) : "Starting…") : undefined}
              className="h-1.5 w-full accent-primary"
            />
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-4 py-3">
          {busy ? (
            // Replaces the plain "Cancel" (close) button's role while a
            // clone is in flight — Escape/backdrop still can't abandon it
            // (see the `onClose` prop above), so this is the only way out.
            // Stays enabled (not tied to `canSubmit`) for the whole time a
            // clone runs, including while the explainer-picker fieldset is
            // disabled.
            <Button
              data-testid="clone-cancel"
              variant="ghost"
              size="sm"
              onClick={() => void cancelClone()}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel clone"}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button data-testid="clone-submit" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Cloning…" : "Clone"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
