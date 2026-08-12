import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { AlertTriangle, FolderGit2, GitPullRequest, Settings, X } from "lucide-react";
import { api, type AgentModelMap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { clampFontSizePercent, COLUMNS, type AgentStatus, type ColumnId, type GlobalEvent, type Harness, type HarnessQuota, type Project, type Task, type TaskType } from "../shared/types.ts";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Column } from "@/components/kanban/Column";
import { DiffDialog } from "@/components/kanban/DiffDialog";
import { GitHubDialog, type GitHubPullDetailPrefill, type GitHubPullPrefill } from "@/components/kanban/GitHubDialog";
import { UsageMeter } from "@/components/usage/UsageMeter";
import { UsagePopover } from "@/components/usage/UsagePopover";
import { KanbanFilters } from "@/components/kanban/KanbanFilters";
import { NewTaskForm } from "@/components/kanban/NewTaskForm";
import { EXIT_DURATION_MS as RUN_PANEL_EXIT_MS, RunPanel } from "@/components/kanban/RunPanel";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { FontSizeProvider, useFontSize } from "@/components/font-size-provider";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { TmuxInstallDialog } from "@/components/tmux/TmuxInstallDialog";
import { TmuxMissingBanner, errorIsTmuxMissing, isTmuxMissing } from "@/components/tmux/TmuxMissingBanner";
import { UpdateBanner } from "@/components/updater/UpdateBanner";
import { WorktreesDialog } from "@/components/worktrees/WorktreesDialog";
import type { UpdateSnapshot } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { dismissPending, notifyWaitingInput, toastApiError, toastError, toastPending, toastSessionEnded, toastSuccess, toastUnknownCommand } from "@/lib/toasts";
import { PendingInputTracker } from "@/lib/pending-input-tracker";
import { findTaskById } from "@/lib/notification-open";
import { parseThemePreference } from "@/lib/theme";
import { parsePullNumber } from "@/lib/pr-url";
import { cn } from "@/lib/utils";
import iconUrl from "../assets/agetor.iconset/icon_32x32@2x.png";

/**
 * Floating top-right error toast. Auto-dismisses after 6s; the user can
 * also close it manually. Renders mounted with a translate animation so a
 * rapid succession of errors doesn't snap-jitter the layout.
 */
function ErrorToast({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  // Hold the last non-null message so the exit animation has something to
  // render after the parent clears the error.
  const [shown, setShown] = useState<string | null>(error);
  useEffect(() => {
    if (error) setShown(error);
    if (!error) return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [error, onDismiss]);
  // Drop the stale message ~250ms after dismissal so the slide-out completes
  // before the node unmounts.
  useEffect(() => {
    if (error) return;
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 250);
    return () => clearTimeout(t);
  }, [error, shown]);
  if (!shown) return null;
  return (
    <div
      role="alert"
      className={cn(
        "fixed top-14 right-4 z-50 flex max-w-md items-start gap-3 rounded-lg border border-destructive/60 bg-card px-4 py-3 text-sm shadow-2xl transition-all duration-200",
        error ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0",
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{shown}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Reconcile a freshly-fetched list against the previously-rendered one,
 * preserving object identity for entries that haven't actually changed.
 * Poll-driven fetches (`/tasks` every 2s, `/harnesses` every 15s) otherwise
 * hand back brand-new object graphs every tick even when nothing changed
 * server-side — that defeats `React.memo` on every downstream card/column
 * and force-renders the selected-task sync effect. Deep-equality here is a
 * plain `JSON.stringify` compare: cheap at this scale (hundreds of small
 * objects, once per poll) and robust against any field changing without a
 * corresponding `updatedAt` bump (e.g. `pendingInteractionCount`,
 * `runningSubagents`, `openTerminalCount` are all computed server-side per
 * request and aren't reflected in `updatedAt`).
 *
 * `cache`, when passed, memoizes each entry's serialized form by id so a
 * poll where nothing changed only has to `JSON.stringify` the freshly
 * fetched (`next`) side — the `prev` side is a cache hit as long as the
 * cached entry's object reference still matches what's actually in `prev`
 * (it can legitimately not: several call sites patch `tasks` state directly
 * for optimistic updates, bypassing this function, so a stale/mismatched
 * cache entry falls back to recomputing rather than trusting a stringified
 * form for a different object). Entries whose id no longer appears in
 * `next` are evicted so the cache doesn't grow unboundedly across a
 * session's worth of deleted/archived tasks.
 *
 * Returns `prev` itself (same array reference) when every entry, in the
 * same order, is unchanged — letting the caller's `setState` bail out
 * entirely instead of triggering a render.
 */
function reconcileById<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string,
  cache?: Map<string, { obj: T; json: string }>,
): T[] {
  const prevByKey = new Map(prev.map((item) => [keyOf(item), item] as const));
  const seen = new Set<string>();
  const merged = next.map((item) => {
    const key = keyOf(item);
    seen.add(key);
    const old = prevByKey.get(key);
    const nextJson = JSON.stringify(item);
    let unchanged = false;
    if (old !== undefined) {
      const cached = cache?.get(key);
      const oldJson = cached && cached.obj === old ? cached.json : JSON.stringify(old);
      unchanged = oldJson === nextJson;
    }
    const finalItem = unchanged ? old! : item;
    if (cache) cache.set(key, { obj: finalItem, json: nextJson });
    return finalItem;
  });
  if (cache) {
    for (const key of cache.keys()) {
      if (!seen.has(key)) cache.delete(key);
    }
  }
  if (merged.length === prev.length && merged.every((item, i) => item === prev[i])) {
    return prev;
  }
  return merged;
}

/**
 * The actual app tree. Split out from the default-exported `App` so it can
 * live *inside* `<ThemeProvider>` and call `useTheme()` — the provider must
 * wrap this component, not be called from within it.
 */
function AppInner() {
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const { setPercent: setFontSizePercent, percentRef: fontSizePercentRef, hasUserAdjustedRef: fontSizeUserAdjustedRef } = useFontSize();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelMap>({ "claude-code": [], codex: [], cursor: [], gemini: [] });
  // Per-harness quota/usage snapshots for the topbar chip mini-bar + popover
  // (D2). Seeded once on boot via `getAllUsage`, kept current afterwards by
  // the `harness_usage` AppEvent (see the `subscribeAppEvents` handler
  // below) — no polling here, the Bun-side poller drives freshness.
  const [usage, setUsage] = useState<Record<string, HarnessQuota>>({});
  const [selected, setSelected] = useState<Task | null>(null);
  const [diffTask, setDiffTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [textQuery, setTextQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<ColumnId[]>([]);
  const [archivedView, setArchivedView] = useState<"active" | "all" | "archived">("active");
  const [harnessFilter, setHarnessFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<TaskType[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  // Set by RunPanel's "Open PR" chip to open GitHubDialog pre-seeded for a
  // specific task; cleared when the dialog closes so a later plain "GitHub"
  // open (no prefill) doesn't inherit a stale project/task.
  const [githubPullPrefill, setGithubPullPrefill] = useState<GitHubPullPrefill | null>(null);
  // Set by RunPanel's "View PR" header affordance to open GitHubDialog
  // straight on that PR's detail subpage; cleared alongside `githubPullPrefill`
  // above (dialog close, or the other prefill kind winning a race) so only
  // one prefill kind is ever live at a time.
  const [githubPullDetailPrefill, setGithubPullDetailPrefill] = useState<GitHubPullDetailPrefill | null>(null);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [tmuxDialogOpen, setTmuxDialogOpen] = useState(false);
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  // Active data dir resolved server-side (~/.agetor for the packaged .app,
  // ~/.agetor-dev when launched via `bun run dev` / `dev:hmr`). Threaded to
  // SettingsDialog so new-harness HOME suggestions point under the current
  // data dir instead of always hard-coding the prod tree.
  const [dataDir, setDataDir] = useState<string>("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const confirm = useConfirm();

  // Fade out the boot splash (defined in index.html) once React has mounted,
  // with a minimum dwell so fast machines don't flash a 200ms splash. Not
  // gated on API fetches — a stuck Bun side shouldn't trap the user behind
  // the logo.
  useEffect(() => {
    const splash = document.getElementById("splash");
    if (!splash) return;
    const MIN_DWELL_MS = 800;
    const FADE_MS = 350;
    const remaining = Math.max(0, MIN_DWELL_MS - performance.now());
    const hideTimer = setTimeout(() => splash.classList.add("is-hidden"), remaining);
    const removeTimer = setTimeout(() => splash.remove(), remaining + FADE_MS);
    return () => { clearTimeout(hideTimer); clearTimeout(removeTimer); };
  }, []);

  // Reconcile the theme preference from the server once at boot. The boot
  // hash (read by ThemeProvider before this component even mounts) is
  // authoritative for first paint — this only catches the DB having been
  // edited out-of-band since then, so on the normal path `themePreference`
  // already matches and this is a silent no-op (no flash).
  // Reconcile the font-size preference from the same fetch, for the same
  // reason as theme above: the boot channel (window.__AGETOR / hash, read
  // synchronously by FontSizeProvider before this component even mounts) is
  // authoritative for first paint — this only catches the DB having been
  // edited out-of-band since then. Unlike theme, this compares against a
  // *live* ref (`fontSizePercentRef`) rather than the `fontSizePercent`
  // value this effect's closure would otherwise capture at mount — by the
  // time this async `.then()` resolves, a fast Cmd+= press could already
  // have moved the real state past that stale snapshot. It also bails
  // entirely once the user has touched the shortcut at all
  // (`fontSizeUserAdjustedRef`), since at that point a possibly-stale DB
  // read racing the user's own change should never win.
  useEffect(() => {
    api.listPreferences().then((prefs) => {
      const dbTheme = parseThemePreference(prefs.theme);
      if (dbTheme !== themePreference) setThemePreference(dbTheme);
      if (!fontSizeUserAdjustedRef.current) {
        const dbFontSize = clampFontSizePercent(prefs.fontSize);
        if (dbFontSize !== fontSizePercentRef.current) setFontSizePercent(dbFontSize);
      }
    }).catch(() => { /* keep the boot-seeded preferences */ });
    // Run once at boot only — intentionally not re-run when either local
    // preference changes (that would fight the user's own picker/shortcut).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-task serialized-form cache for `reconcileById` below — see that
  // function's doc comment. A ref (not state) since it's pure bookkeeping
  // that must survive across polls without itself triggering a render.
  const taskReconcileCacheRef = useRef(new Map<string, { obj: Task; json: string }>());

  /** Re-list tasks. Returns the fetched list so callers that need to inspect a
   *  task right after a mutation don't have to issue a second GET. `null` on
   *  failure — the last good snapshot stays rendered and the poll retries. */
  const refresh = useCallback(async (): Promise<Task[] | null> => {
    try {
      const list = await api.listTasks();
      // `list` (unreconciled) is what callers get back for immediate reads
      // (e.g. re-checking a just-created task's branch); the reconciled,
      // identity-preserving version is what actually lands in state.
      setTasks((prev) => reconcileById(prev, list, (t) => t.id, taskReconcileCacheRef.current));
      return list;
    } catch { return null; /* keep last good snapshot; retry next tick */ }
  }, []);
  const refreshAgents = useCallback(async () => {
    try {
      const payload = await api.listHarnesses();
      setHarnesses((prev) => reconcileById(prev, payload.harnesses, (h) => h.id));
      setAgents((prev) => reconcileById(prev, payload.statuses, (a) => a.harnessId));
    } catch { /* leave previous state */ }
  }, []);
  const refreshAgentModels = useCallback(async () => {
    try { setAgentModels(await api.listAgentModels()); } catch { /* leave previous state */ }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshAgents();
    void refreshAgentModels();
    // Load projects once for the repo filter picker. New projects added
    // mid-session via NewTaskForm won't show up until reload — matches the
    // session-only filter persistence model.
    api.listProjects().then(setProjects).catch(() => { /* leave empty */ });
    // Seed the topbar usage tracker with whatever the Bun side last
    // persisted, so chips show a meter immediately on boot rather than
    // waiting for the next poll or SSE push. Best-effort — a failure here
    // just means chips render without a mini-bar until the first
    // `harness_usage` event arrives.
    api.getAllUsage()
      .then((list) => setUsage(Object.fromEntries(list.map((q) => [q.harnessId, q]))))
      .catch(() => { /* leave empty */ });
    // Resolve the user's home dir once so SettingsDialog can expand `~/…`
    // template paths into concrete absolute paths before validation.
    // `/defaults` is small + local, but a hiccup at boot would now leave
    // dataDir empty for the whole session — SettingsDialog's "Add harness"
    // button stays disabled until dataDir is set. Retry every 2s until it
    // lands; the effect's cleanup clears the timer when App unmounts.
    let defaultsTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchDefaults = () => {
      void api.defaults().then((d) => {
        setHomeDir(d.home);
        setDataDir(d.dataDir);
        defaultsTimer = null;
      }).catch(() => {
        defaultsTimer = setTimeout(fetchDefaults, 2_000);
      });
    };
    fetchDefaults();
    // Prime the update snapshot. SSE is live-only, so without this a
    // freshly-opened webview wouldn't know about an update that was already
    // downloaded by the previous main-process tick.
    api.getUpdateStatus().then(setUpdateSnapshot).catch(() => { /* fine */ });
    // Skip poll ticks while the window is hidden — a backgrounded kanban
    // board has no reason to keep re-fetching + re-rendering every 2s/15s.
    // The intervals themselves keep running (cheap — it's just the fetch +
    // setState that's skipped) so there's nothing to re-arm; `visible`
    // fires an immediate refresh so returning to the window doesn't wait
    // out a stale tick. This mirrors the existing `flushNow`-on-visible
    // wiring in RunPanel and is mandatory, not an optimization: WKWebView
    // suspends rAF (not setInterval) while occluded, but a naive "just
    // gate the poll" change without an immediate on-return refresh would
    // reintroduce the same class of "frozen until you nudge the window"
    // bug previously fixed there.
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    const a = setInterval(() => { if (!document.hidden) void refreshAgents(); }, 15_000);
    const onVisible = () => {
      if (document.hidden) return;
      void refresh();
      void refreshAgents();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(t);
      clearInterval(a);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      if (defaultsTimer) clearTimeout(defaultsTimer);
    };
  }, [refresh, refreshAgents, refreshAgentModels]);

  // Keep the selected task in sync as the list refreshes.
  useEffect(() => {
    if (!selected) return;
    const fresh = tasks.find((t) => t.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [tasks, selected]);

  // Once the user opens a task's panel, any "Waiting on you" toast for that
  // task is noise — they're already looking at the prompt. Clearing it also
  // removes one more high-z-index click target that could otherwise sit on
  // top of the panel header and eat clicks meant for the X button.
  useEffect(() => {
    if (!selected) return;
    dismissPending(selected.id);
  }, [selected?.id]);

  // `panelMounted` follows `selected !== null` on open but lags by the
  // RunPanel's exit animation on close, so the Toaster doesn't snap back to
  // the right edge (and slide under the receding panel) for ~250ms.
  const [panelMounted, setPanelMounted] = useState(false);
  useEffect(() => {
    if (selected) {
      setPanelMounted(true);
      return;
    }
    const t = setTimeout(() => setPanelMounted(false), RUN_PANEL_EXIT_MS);
    return () => clearTimeout(t);
  }, [selected]);

  // Refs mirror the latest tasks + selected task so the global-events
  // subscription (which closes over its handler ONCE on mount) can read
  // current state without re-subscribing on every render.
  const tasksRef = useRef<Task[]>(tasks);
  const selectedIdRef = useRef<string | null>(selected?.id ?? null);
  // Tracks interaction ids awaiting an answer, keyed by task. Lets the
  // notification hook alert only on the FIRST prompt for a task (not once per
  // stacked prompt) and clear the alert only when the LAST one resolves.
  const pendingInputRef = useRef<PendingInputTracker>(new PendingInputTracker());
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { selectedIdRef.current = selected?.id ?? null; }, [selected]);

  // Confirm-on-quit. The main process emits `quit_request` over the app
  // SSE channel when Cmd+Q / window close lands while runs are active. We
  // surface a modal explaining tasks will keep running detached; on "Quit
  // anyway" the server arms a one-shot flag and re-issues Utils.quit().
  useEffect(() => {
    const cancel = api.subscribeAppEvents((ev) => {
      if (ev.type === "harness_usage") {
        setUsage((prev) => ({ ...prev, [ev.quota.harnessId]: ev.quota }));
        return;
      }
      if (ev.type === "open_task") {
        // A native notification deep-link (`agetor://task/<id>`) was
        // clicked. Open that task's RunPanel, fetching a fresh task list
        // first if it isn't loaded yet (e.g. the task was just created and
        // hasn't been picked up by the 2s poll). Mirrors the onOpen idiom
        // in the GlobalEvent handler below, but this handler closes over
        // its own scope, so the fresh list has to be fetched directly
        // rather than relying on `tasksRef` updating synchronously after
        // `setTasks`. No focusWindow() call here: this handler only fires
        // after the main process has already handled `open-url` and focused
        // the window itself, so a second call would be redundant.
        const fresh = findTaskById(tasksRef.current, ev.taskId);
        if (fresh) {
          setSelected(fresh);
          return;
        }
        void (async () => {
          try {
            const list = await api.listTasks();
            setTasks(list);
            const found = findTaskById(list, ev.taskId);
            if (found) {
              setSelected(found);
            }
            // else: silently no-op — the task doesn't exist (deleted?).
          } catch {
            // Best-effort — no-op on fetch failure.
          }
        })();
        return;
      }
      if (ev.type !== "quit_request") return;
      const n = ev.runningRunCount;
      const noun = n === 1 ? "task is" : "tasks are";
      const titlesPreview = ev.runningTaskTitles.length > 0
        ? ev.runningTaskTitles.slice(0, 3).join(", ")
          + (ev.runningTaskTitles.length > 3 ? ", …" : "")
        : null;
      void confirm({
        title: "Quit Agetor?",
        description: (
          <div className="space-y-2">
            <div>
              {n} {noun} still running. They will keep running in the background;
              you can reconnect to them next time you open Agetor.
            </div>
            {titlesPreview && (
              <div className="font-mono text-foreground/80">{titlesPreview}</div>
            )}
          </div>
        ),
        confirmLabel: "Quit anyway",
        cancelLabel: "Stay open",
      }).then((ok) => {
        if (ok) void api.forceQuit().catch(() => { /* response races process exit */ });
      });
    });
    return cancel;
  }, [confirm]);

  // App-wide lifecycle subscription. Drives toasts + native notifications.
  useEffect(() => {
    const handle = (ev: GlobalEvent) => {
      // Update events are app-scoped, not task-scoped — handle them before
      // reading any taskId-derived state.
      if (ev.kind === "update") {
        setUpdateSnapshot({
          status: ev.status,
          version: ev.version,
          error: ev.status === "error" ? ev.message : null,
          lastCheckedAt: ev.ts,
        });
        return;
      }
      const isSelected = ev.taskId === selectedIdRef.current;
      const isFocused = document.hasFocus();
      // Resolve a display title from the latest tasks snapshot; fall back to
      // a short id slice if the row hasn't been polled in yet.
      const task = tasksRef.current.find((t) => t.id === ev.taskId);
      const title = task?.title || `Task ${ev.taskId.slice(0, 7)}`;
      const subtitle = task?.agent;
      const onOpen = () => {
        const fresh = tasksRef.current.find((t) => t.id === ev.taskId);
        if (fresh) setSelected(fresh);
        // Best-effort: bring the agetor window forward when the user clicks
        // through from a toast. Unlike the open_task handler above, nothing
        // else focuses the window on this path — a WKWebView's own
        // `window.focus()` can't activate the host NSApplication, so it has
        // to round-trip through the main process.
        void api.focusWindow();
      };
      if (ev.kind === "interaction") {
        // A question / permission prompt opened or closed. The tracker raises
        // the alert only on the first prompt for a task and clears it only when
        // the last one resolves — stacked prompts don't re-alert.
        const tracker = pendingInputRef.current;
        if (ev.state === "pending") {
          if (tracker.add(ev.taskId, ev.interactionId)) {
            notifyWaitingInput({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
          }
        } else if (tracker.remove(ev.taskId, ev.interactionId)) {
          dismissPending(ev.taskId);
        }
        // Optimistically reflect the change in the card's pending count so the
        // "needs input" amber-pulse flag (TaskCard, gated on
        // pendingInteractionCount) appears the instant the prompt lands rather
        // than waiting up to 2s for the next /tasks poll, which then reconciles
        // the true count.
        setTasks((cur) =>
          cur.map((t) => {
            if (t.id !== ev.taskId) return t;
            const next = ev.state === "pending"
              ? t.pendingInteractionCount + 1
              : Math.max(0, t.pendingInteractionCount - 1);
            return { ...t, pendingInteractionCount: next };
          }),
        );
        return;
      }
      if (ev.kind === "run-status") {
        // Any terminal run state supersedes a pending-input prompt — clear the
        // "Waiting on you" toast so it doesn't linger next to the success/
        // failure toast (or silently after a cancel). Also drop the tracker's
        // entry: a run that ends with a modal still on the pane may never emit
        // a resolved interaction, and a stale id would otherwise suppress the
        // first-prompt alert for this task's next run.
        dismissPending(ev.taskId);
        pendingInputRef.current.clearTask(ev.taskId);
        if (ev.status === "succeeded") {
          toastSuccess({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
        } else if (ev.status === "failed" || ev.status === "orphaned") {
          toastError({
            taskId: ev.taskId,
            title,
            subtitle,
            isSelected,
            isFocused,
            onOpen,
            reason: ev.status === "orphaned" ? "agetor restarted while running" : undefined,
          });
        }
        // `cancelled` is intentionally silent — the user issued the cancel.
        return;
      }
      // column transitions. Patch `tasks` optimistically so the board and any
      // open run panel (via the selected-sync effect) reflect the new column
      // the instant the backend pushes it — rather than waiting up to 2s for
      // the next poll (and staying stale indefinitely if that poll lags). This
      // is what keeps the panel header + Stop button from lingering on a
      // `running` snapshot after the turn has actually finished.
      setTasks((cur) =>
        cur.map((t) => (t.id === ev.taskId ? { ...t, column: ev.column } : t)),
      );
      if (ev.column === "blocked") {
        if (ev.reason === "api-error") {
          toastApiError({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
        } else if (ev.reason === "session-died") {
          toastSessionEnded({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
        } else if (ev.reason === "unknown-command") {
          toastUnknownCommand({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
        } else {
          toastPending({ taskId: ev.taskId, title, subtitle, isSelected, isFocused, onOpen });
        }
      } else if (ev.prev === "blocked") {
        // Auto-clear the pending toast once the agent unblocks (the user
        // answered, the run was cancelled, etc.).
        dismissPending(ev.taskId);
      }
    };
    const cancel = api.subscribeGlobalEvents(handle);
    return cancel;
  }, []);

  // Text + repo filter applied here; status filter narrows the rendered
  // columns (not the task list) so an unselected status disappears entirely
  // rather than rendering an empty column.
  const visibleTasks = useMemo(() => {
    const q = textQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (q) {
        const hay = `${t.title}\n${t.prompt}\n${t.workdir}\n${t.branch ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (repoFilter.length > 0 && !repoFilter.includes(t.workdir)) return false;
      if (harnessFilter.length > 0 && !harnessFilter.includes(t.agent)) return false;
      if (typeFilter.length > 0 && !typeFilter.includes(t.taskType)) return false;
      if (archivedView === "active" && t.archivedAt != null) return false;
      if (archivedView === "archived" && t.archivedAt == null) return false;
      return true;
    });
  }, [tasks, textQuery, repoFilter, harnessFilter, typeFilter, archivedView]);

  const visibleColumns = useMemo(
    () => (statusFilter.length === 0 ? COLUMNS : COLUMNS.filter((c) => statusFilter.includes(c.id))),
    [statusFilter],
  );

  // Distinct harness ids referenced by any task — feeds the harness filter so
  // ids belonging to removed harnesses still show up as filter options.
  const taskAgentIds = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.agent))),
    [tasks],
  );

  // Every handler below is wrapped in `useCallback` so it keeps a stable
  // identity across App re-renders (poll ticks, unrelated state changes,
  // etc.) — they're passed straight down to `Column`/`TaskCard`, both
  // `React.memo`'d, and an unstable function prop would force every card in
  // every column to re-render on every tick regardless of the task-list
  // equality guard above. None of these actually need to read the current
  // `tasks`/`selected` state (they operate on the `t` argument the caller
  // already has), except `del`'s "is the deleted task the open one" check —
  // that reads `selectedIdRef` (already kept in sync by the effect above)
  // instead of `selected` directly, so `del` doesn't have to change identity
  // every time the user opens a different task.
  const surfaceError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const onDragEnd = useCallback(async (e: DragEndEvent) => {
    const id = String(e.active.id);
    const col = e.over?.id as ColumnId | undefined;
    if (!col) return;
    const t = tasksRef.current.find((x) => x.id === id);
    if (!t || t.column === col) return;
    setTasks((cur) => cur.map((x) => (x.id === id ? { ...x, column: col } : x)));
    try {
      setError(null);
      await api.moveTask(id, col);
    } catch (e) {
      surfaceError(e);
      // Server didn't accept the move — re-sync the optimistic UI.
      await refresh();
    }
  }, [refresh, surfaceError]);

  // `startTask` materializes the worktree, which can re-pin the branch when a
  // create-time uniqueness race is only detectable once the branch actually
  // exists. Surface the change so the user isn't left believing the name they
  // saw. Reads the new branch out of the refresh we already do — no extra GET.
  // Best-effort: if the refresh failed, the 2s poll still shows the real branch.
  const startAndNotifyBranch = useCallback(async (taskId: string, branchBefore: string | null) => {
    await api.startTask(taskId);
    const list = await refresh();
    if (!branchBefore || !list) return;
    const after = list.find((t) => t.id === taskId);
    if (after?.branch && after.branch !== branchBefore) {
      toast(`Branch changed to “${after.branch}” — “${branchBefore}” was already taken.`);
    }
  }, [refresh]);

  const start = useCallback(async (t: Task) => {
    try {
      setError(null);
      await startAndNotifyBranch(t.id, t.branch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // tmux-missing errors get a guided fix dialog instead of a toast — the
      // toast is a dead end, the dialog routes to a resolution.
      if (errorIsTmuxMissing(msg)) {
        setTmuxDialogOpen(true);
      } else {
        surfaceError(e);
      }
      void refreshAgents();
    }
  }, [startAndNotifyBranch, surfaceError, refreshAgents]);
  const cancel = useCallback(async (t: Task) => {
    if (!t.runId) return;
    try {
      setError(null);
      await api.cancelRun(t.runId);
    } catch (e) {
      surfaceError(e);
    }
  }, [surfaceError]);
  const markDone = useCallback(async (t: Task) => {
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, column: "done" } : x)));
    try {
      setError(null);
      await api.moveTask(t.id, "done");
      await refresh();
    } catch (e) {
      surfaceError(e);
      await refresh();
    }
  }, [refresh, surfaceError]);
  const archive = useCallback(async (t: Task) => {
    const active = t.column === "running" || t.column === "blocked";
    if (active) {
      const ok = await confirm({
        title: `Archive "${t.title}"?`,
        description:
          "An agent is still working on this task. Archiving will stop it.",
        confirmLabel: "Stop & archive",
        variant: "destructive",
      });
      if (!ok) return;
    }
    const now = Date.now();
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, archivedAt: now } : x)));
    try {
      setError(null);
      await api.archiveTask(t.id, active ? { force: true, stopRun: true } : undefined);
      await refresh();
    } catch (e) {
      surfaceError(e);
      await refresh();
    }
  }, [confirm, refresh, surfaceError]);
  const unarchive = useCallback(async (t: Task) => {
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, archivedAt: null } : x)));
    try {
      setError(null);
      await api.unarchiveTask(t.id);
      await refresh();
    } catch (e) {
      surfaceError(e);
      await refresh();
    }
  }, [refresh, surfaceError]);
  const del = useCallback(async (t: Task) => {
    const ok = await confirm({
      title: `Delete "${t.title}"?`,
      description: (
        <>
          The task and its run history will be removed.
          {t.worktreePath && (
            <>
              {" "}Its git worktree (
              <span className="font-mono text-foreground/80">{t.branch}</span>
              ) will also be torn down.
            </>
          )}
        </>
      ),
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      setError(null);
      await api.deleteTask(t.id);
      if (selectedIdRef.current === t.id) setSelected(null);
      await refresh();
    } catch (e) {
      surfaceError(e);
      // Refresh anyway so the UI matches the server.
      await refresh();
    }
  }, [confirm, refresh, surfaceError]);

  // Shared by GitHubDialog's `onClose` and `onOpenSettings` (the latter also
  // opens SettingsDialog) so the three-setter teardown can't drift out of
  // sync between the two call sites — both must clear the dialog's own open
  // state and both prefill kinds, or a later plain "GitHub" open (no
  // prefill) could inherit a stale project/task from whichever prefill path
  // was last used.
  const closeGithubDialog = useCallback(() => {
    setGithubOpen(false);
    setGithubPullPrefill(null);
    setGithubPullDetailPrefill(null);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Top app bar sits on the same row as the macOS traffic lights (see
          titleBarStyle: "hiddenInset" in src/bun/index.ts). `pl-20` clears the
          traffic-light cluster (≈64px wide + the 8px x-offset configured on
          the BrowserWindow). The bar itself is a drag region; the icon + h1
          inside have no click handlers, but if one is ever added the target
          must be wrapped in `electrobun-webkit-app-region-no-drag` or the
          mousedown will be swallowed by the window-move handler. */}
      {/* Double-click zooms the window — Electrobun's drag-region preload
          fires startWindowMove on mousedown but doesn't preventDefault, so
          React's synthesized dblclick still arrives. Guard against zooming
          when the click originates on a no-drag child (Settings, agent
          badges) to match AppKit's title-bar behavior — clicking a control
          there shouldn't zoom. */}
      <header
        className="electrobun-webkit-app-region-drag flex h-10 shrink-0 items-center justify-between border-b border-border/60 pl-20 pr-4"
        onDoubleClick={(e) => {
          if ((e.target as Element).closest(".electrobun-webkit-app-region-no-drag")) return;
          void api.toggleWindowZoom().catch(() => {});
        }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img src={iconUrl} alt="" className="block size-7 shrink-0 -translate-y-0.5 object-contain" />
            <h1 className="font-geist text-base font-semibold leading-none tracking-tight">Agetor</h1>
          </div>
          <div className="electrobun-webkit-app-region-no-drag flex items-center gap-2 text-xs text-muted-foreground">
            {agents.map((a) => {
              const harness = harnesses.find((h) => h.id === a.harnessId);
              const displayName = harness?.label ?? a.harnessId;
              const q = usage[a.harnessId];
              const dot = (
                <span
                  className={
                    "inline-block size-1.5 rounded-full " +
                    (a.available ? "bg-success-solid" : "bg-danger-solid")
                  }
                />
              );
              if (!q) {
                return (
                  <span
                    key={a.harnessId}
                    className="flex items-center gap-1"
                    title={a.reason ?? a.path ?? ""}
                  >
                    <AgentIcon kind={a.kind} className="size-3" />
                    {displayName}
                    {dot}
                  </span>
                );
              }
              const chip = (
                <span
                  className="flex items-center gap-1"
                  title={a.reason ?? a.path ?? ""}
                >
                  <AgentIcon kind={a.kind} className="size-3" />
                  {displayName}
                  <UsageMeter quota={q} />
                  {dot}
                </span>
              );
              return (
                <UsagePopover
                  key={a.harnessId}
                  quota={q}
                  harnessLabel={displayName}
                  onRefresh={async () => {
                    const fresh = await api.refreshHarnessUsage(a.harnessId);
                    setUsage((prev) => ({ ...prev, [fresh.harnessId]: fresh }));
                  }}
                >
                  {chip}
                </UsagePopover>
              );
            })}
          </div>
        </div>
        <div className="electrobun-webkit-app-region-no-drag flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {visibleTasks.length === tasks.length
              ? `${tasks.length} tasks`
              : `${visibleTasks.length} of ${tasks.length} tasks`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setGithubOpen(true)}
            aria-label="Git"
            title="Git pull requests and issues (GitHub, GitLab, Bitbucket)"
          >
            <GitPullRequest className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setWorktreesOpen(true)}
            aria-label="Worktrees"
            title="Worktrees"
          >
            <FolderGit2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <NewTaskForm
          agents={agents}
          harnesses={harnesses}
          agentModels={agentModels}
          onSubmit={async (input, { start }) => {
            try {
              setError(null);
              // "Run task" creates the row in `ready` (so it's briefly visible in
              // that column even when the agent starts immediately afterward),
              // then asks the orchestrator to start it — which moves the card to
              // `running`. "To backlog" just queues with no auto-start.
              const created = await api.createTask({
                ...input,
                column: start ? "ready" : "backlog",
              });
              // The server makes the branch unique within the repo, so the
              // pinned name can differ from what the sidebar showed (a
              // same-name task already exists). Surface the final name rather
              // than let the user assume the one they saw.
              if (input.branch && created.branch && created.branch !== input.branch) {
                toast(`Branch set to “${created.branch}” to keep it unique.`);
              }
              await refresh();
              if (start) {
                // Refreshes internally, so no second refresh here.
                await startAndNotifyBranch(created.id, created.branch);
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <UpdateBanner
            snapshot={updateSnapshot}
            onChange={() => { void api.getUpdateStatus().then(setUpdateSnapshot).catch(() => {}); }}
          />
          <TmuxMissingBanner
            show={isTmuxMissing(agents)}
            onResolve={() => setTmuxDialogOpen(true)}
          />
          <KanbanFilters
            textQuery={textQuery}
            onTextQueryChange={setTextQuery}
            repoFilter={repoFilter}
            onRepoFilterChange={setRepoFilter}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            archivedView={archivedView}
            onArchivedViewChange={setArchivedView}
            harnessFilter={harnessFilter}
            onHarnessFilterChange={setHarnessFilter}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            projects={projects}
            harnesses={harnesses}
            taskAgentIds={taskAgentIds}
          />
          <ErrorToast error={error} onDismiss={() => setError(null)} />
          <Toaster panelOpen={panelMounted} />
          {/* Kanban gets all remaining vertical space and scrolls horizontally
              on its own — the bottom bar stays anchored regardless of column
              count. */}
          <div className="kanban-scroll flex-1 overflow-x-scroll">
            <DndContext sensors={sensors} onDragEnd={onDragEnd}>
              <div className="flex gap-3 p-4">
                {visibleColumns.map((c) => (
                  <Column
                    key={c.id}
                    id={c.id}
                    label={c.label}
                    tasks={visibleTasks.filter((t) => t.column === c.id)}
                    homeDir={homeDir}
                    onStart={start}
                    onCancel={cancel}
                    onDelete={del}
                    onOpen={setSelected}
                    onDiff={setDiffTask}
                    onMarkDone={markDone}
                    onArchive={archive}
                    onUnarchive={unarchive}
                  />
                ))}
              </div>
            </DndContext>
          </div>
        </main>
      </div>
      <RunPanel
        task={selected}
        agents={agents}
        harnesses={harnesses}
        agentModels={agentModels}
        homeDir={homeDir}
        onClose={() => setSelected(null)}
        onShowDiff={setDiffTask}
        onArchive={archive}
        onUnarchive={unarchive}
        onOpenPullRequest={(prefill) => {
          setGithubPullPrefill(prefill);
          setGithubPullDetailPrefill(null);
          setGithubOpen(true);
        }}
        onViewPullRequest={({ projectPath, prUrl }) => {
          const number = parsePullNumber(prUrl);
          if (number == null) {
            // Can't drive the in-app detail subpage without a parsed PR
            // number — fall back to the plain external link rather than
            // silently doing nothing.
            void api.openExternal(prUrl).catch((err: unknown) => {
              toast.error(err instanceof Error ? err.message : "Could not open link");
            });
            return;
          }
          setGithubPullDetailPrefill({ projectPath, number, prUrl });
          setGithubPullPrefill(null);
          setGithubOpen(true);
        }}
      />
      <DiffDialog
        open={!!diffTask}
        task={diffTask ? (tasks.find((t) => t.id === diffTask.id) ?? diffTask) : null}
        onClose={() => setDiffTask(null)}
      />
      <GitHubDialog
        open={githubOpen}
        projects={projects}
        initialProjectPath={githubPullDetailPrefill?.projectPath ?? githubPullPrefill?.projectPath ?? repoFilter[0] ?? selected?.workdir ?? tasks[0]?.workdir ?? null}
        pullPrefill={githubPullPrefill}
        pullDetailPrefill={githubPullDetailPrefill}
        onClose={closeGithubDialog}
        onOpenSettings={() => {
          closeGithubDialog();
          setSettingsOpen(true);
        }}
      />
      <WorktreesDialog
        open={worktreesOpen}
        onClose={() => setWorktreesOpen(false)}
        tasks={tasks}
        projects={projects}
        homeDir={homeDir}
        onOpenTask={(t) => {
          setWorktreesOpen(false);
          setSelected(t);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={refreshAgents}
        homeDir={homeDir}
        dataDir={dataDir}
      />
      <TmuxInstallDialog
        open={tmuxDialogOpen}
        onClose={() => setTmuxDialogOpen(false)}
        onResolved={refreshAgents}
      />
    </div>
  );
}

/** Root export — mounts `ThemeProvider` and `FontSizeProvider` above
 *  everything so `AppInner` (and, transitively, `SettingsDialog`'s Theme
 *  picker) can call `useTheme()` / `useFontSize()`. */
export default function App() {
  return (
    <ThemeProvider>
      <FontSizeProvider>
        <AppInner />
      </FontSizeProvider>
    </ThemeProvider>
  );
}
