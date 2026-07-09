import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  Archive, ArchiveRestore, Bot, Check, ClipboardList, Copy, CornerDownRight, Eye, FolderOpen, FileText, FilePenLine, FilePlus, Folder,
  GitCommit, GitCompare, Globe, HelpCircle, ListTodo, Plug, Search, Send, Slash,
  Sparkles, Square, Terminal, Wrench, X,
} from "lucide-react";
import { api, COMMIT_PUSH_PROMPT, type AgentModelMap, type AvailableCommand, type AvailableExtension, type PendingInteraction } from "@/lib/api";
import { shouldShowSubagentTabs, resolveActiveStream, splitTabsForOverflow } from "@/lib/subagent-tabs";
import { shouldOfferCommitPush, type TaskGitStatus } from "@/lib/commit-push";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { abbreviateHome, cn } from "@/lib/utils";
import { iconForRef, refBasename } from "@/lib/file-icons";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentStatus,
  type Harness,
  type Run,
  type RunEvent,
  type Subagent,
  type SubagentEvent,
  type Task,
  type TaskReference,
} from "../../../shared/types.ts";
import { appendReferences } from "../../../shared/refs.ts";
import { createEventDeduper } from "@/lib/event-dedup";
import { createEventBuffer } from "@/lib/event-buffer";
import { AgentIcon } from "./AgentIcon";
import {
  ReferencesPicker,
  captureDroppedOrPastedItems,
  mergeRefs,
  type CapturedItem,
} from "./ReferencesPicker";
import { spliceAtSelection, readCaret, restoreCaret } from "@/lib/textarea-insert";
import { SlashAutocomplete } from "./SlashAutocomplete";
import { ExtensionPicker } from "./ExtensionPicker";
import { TerminalView } from "./TerminalView";

/**
 * Resolve a task's harness id to its underlying kind. Falls back to
 * claude-code when the id doesn't match any known harness (e.g. the alias
 * was just deleted) — every kind-keyed lookup downstream expects a valid
 * AgentKind, and claude-code is the safer default than codex.
 */
function harnessKindOf(harnessId: string, harnesses: Harness[]): AgentKind {
  return harnesses.find((h) => h.id === harnessId)?.kind ?? "claude-code";
}

interface Props {
  /** When null, the panel slides off-screen and unmounts after the exit animation. */
  task: Task | null;
  agents: AgentStatus[];
  /** Registered harnesses — needed so the panel's agent dropdown can list
   *  every known harness (built-ins + aliases). */
  harnesses: Harness[];
  agentModels: AgentModelMap;
  homeDir: string;
  onClose: () => void;
  /** Open the git diff viewer for the given task. */
  onShowDiff: (task: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
}

const STATUS_VARIANT: Record<Run["status"], "default" | "secondary" | "outline" | "destructive"> = {
  running: "default",
  succeeded: "secondary",
  cancelled: "outline",
  orphaned: "outline",
  failed: "destructive",
};

export const EXIT_DURATION_MS = 250;

function formatDuration(r: Run): string {
  const end = r.endedAt ?? Date.now();
  const ms = end - r.startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Right-side overlay that shows a task's run history + the live log of the
 * selected run. Renders as a fixed-position panel with a blurred backdrop so
 * the kanban behind it stays visible but de-emphasized. The panel keeps the
 * last task mounted during the exit animation so the slide-out doesn't snap.
 */
export function RunPanel({ task, agents, harnesses, agentModels, homeDir, onClose, onShowDiff, onArchive, onUnarchive }: Props) {
  // `mountedTask` lags behind `task` so that when the parent sets task → null
  // we keep rendering the old contents while the exit animation plays.
  const [mountedTask, setMountedTask] = useState<Task | null>(task);
  const [open, setOpen] = useState<boolean>(!!task);

  useEffect(() => {
    if (task) {
      setMountedTask(task);
      // Defer the open flip to the next frame so the panel mounts at
      // translate-x-full first, then animates to translate-x-0. Cancel on
      // cleanup: without this, a pending rAF from a truthy run can fire AFTER
      // a later task→null run set open=false, wedging the panel open (open=true
      // while task=null, so every close path's setSelected(null) is a no-op).
      // The 2s kanban poll re-creates `selected` — and so re-runs this effect —
      // every tick, which is what made the bug intermittent.
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
    setOpen(false);
  }, [task]);

  // After the exit animation completes, drop the mountedTask so we don't keep
  // a stale subscription / poll loop alive. The timer is cancelled if the user
  // re-opens the panel before it fires.
  useEffect(() => {
    if (open || !mountedTask) return;
    const t = setTimeout(() => setMountedTask(null), EXIT_DURATION_MS);
    return () => clearTimeout(t);
  }, [open, mountedTask]);

  // Escape closes the panel — but only when no higher-priority dismissable
  // layer is up: a modal Dialog (confirm, edit, settings, tmux-missing —
  // each renders `[role="dialog"][aria-modal="true"]`) or an open
  // search-select / multi-search-select popover (marked with
  // `[data-popover-open]`). Esc peels one layer at a time, top down.
  //
  // Note: stopPropagation/stopImmediatePropagation can't help here because
  // both the panel and the popovers attach to `document`, so DOM markers
  // are the order-independent way to coordinate the handoff.
  //
  // onClose is captured into a ref because the parent passes an inline arrow
  // function — depending on it directly would tear down + re-add the listener
  // on every kanban poll (every 2s).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open]')) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!mountedTask) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close task panel"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/40 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-40 flex h-full w-[520px] max-w-[90vw] flex-col border-l border-border/60 bg-card shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <RunPanelBody
          task={mountedTask}
          agents={agents}
          harnesses={harnesses}
          agentModels={agentModels}
          homeDir={homeDir}
          onClose={onClose}
          onShowDiff={onShowDiff}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      </aside>
    </>
  );
}

/**
 * Inner content of the slide-over. Split out so the wrapper can manage mount /
 * animation state without re-running effects every animation tick.
 */
function RunPanelBody({
  task,
  agents,
  harnesses,
  agentModels,
  homeDir,
  onClose,
  onShowDiff,
  onArchive,
  onUnarchive,
}: {
  task: Task;
  agents: AgentStatus[];
  harnesses: Harness[];
  agentModels: AgentModelMap;
  homeDir: string;
  onClose: () => void;
  onShowDiff: (task: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
}) {
  const archived = task.archivedAt != null;
  const kind = harnessKindOf(task.agent, harnesses);
  const [runs, setRuns] = useState<Run[]>([]);
  /** Structured event stream — one entry per claude JSONL block or per
   *  codex stdout/stderr chunk. The renderer dispatches on `stream` to
   *  pick a component (assistant text, thinking, tool call, tool result,
   *  status divider, error). Events from EVERY run of the task are
   *  merged here so the user sees one unified scrollback. */
  const [events, setEvents] = useState<RunEvent[]>([]);
  /** When the user clicks "Rebuild from session JSONL" (or the auto-
   *  rebuild fires after a run finishes), we patch the latest claude
   *  session's events with the freshly-parsed on-disk version.
   *  `sessionId` is the `claudeSessionId` the rebuild covers — used at
   *  render time to splice the rebuilt events into the unified stream
   *  in place of the live ones for runs that share that session id.
   *  Null means "use the live streamed events as normal". */
  const [rebuilt, setRebuilt] = useState<{ sessionId: string; events: RunEvent[] } | null>(null);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  /** Background/sub agents this task's main agent has spawned. Seeded from the
   *  snapshot endpoint on open + kept live by `stream: "subagent"` SSE deltas
   *  and a 2s poll backstop. Drives the read-only tab strip. */
  const [subagentList, setSubagentList] = useState<Subagent[]>([]);
  /** Which stream the log is showing: "main" (the task's own agent) or a
   *  subagent id. Background-agent streams are READ-ONLY — the composer is
   *  hidden while one is active. */
  const [activeStream, setActiveStream] = useState<string>("main");
  const logRef = useRef<HTMLDivElement>(null);
  // Tracks whether the log was scrolled near the bottom at the last user
  // interaction. Auto-scroll-to-bottom on new events only fires when this is
  // true, so a user who scrolls up to read history isn't yanked back down on
  // every streamed chunk.
  const nearBottomRef = useRef(true);

  // Reset on task switch (no remount because we no longer key on task.id).
  // Re-arm the auto-scroll heuristic so opening a different task pins the
  // viewport to the most recent message instead of inheriting the previous
  // task's scrolled-up position.
  useEffect(() => {
    setEvents([]);
    setRebuilt(null);
    setRebuildNote(null);
    setInteractions([]);
    setSubagentList([]);
    setActiveStream("main");
    nearBottomRef.current = true;
  }, [task.id]);

  // Latest run for this task — drives the send button, indicator, and
  // JSONL rebuild target. Newest first in `runs`.
  const latestRun = runs[0] ?? null;

  const rebuildFromJsonl = async () => {
    if (!latestRun || !latestRun.claudeSessionId || rebuildBusy) return;
    setRebuildBusy(true);
    setRebuildNote(null);
    try {
      const res = await api.rebuildRunEvents(latestRun.id);
      if (res.events.length === 0) {
        setRebuildNote(res.reason ?? "no events found in JSONL");
        return;
      }
      setRebuilt({ sessionId: latestRun.claudeSessionId, events: res.events });
      setRebuildNote(`Loaded ${res.events.length} events from session JSONL.`);
    } catch (e) {
      setRebuildNote(`rebuild failed: ${(e as Error).message}`);
    } finally {
      setRebuildBusy(false);
    }
  };

  // Bootstrap any interactions that fired before the panel opened (race
  // between claude tool calls and the panel mount). The SSE subscription
  // picks up new ones from here on.
  useEffect(() => {
    let cancelled = false;
    void api.listPendingInteractions(task.id).then((list) => {
      if (cancelled) return;
      setInteractions(list);
    }).catch(() => { /* ignore — empty start is fine */ });
    return () => { cancelled = true; };
  }, [task.id]);

  // Stable identity so RunEventList's memoized section tree isn't invalidated
  // on every parent re-render (e.g. the 2s runs poll). `setInteractions` is a
  // stable setter, so the empty dep list is correct.
  const dismissInteraction = useCallback(
    (id: string) => setInteractions((cur) => cur.filter((x) => x.id !== id)),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await api.listRuns(task.id);
        if (cancelled) return;
        setRuns(list);
      } catch { /* task may have been deleted */ }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [task.id, task.runId]);

  // Snapshot + poll the task's background/sub agents. The SSE `subagent` deltas
  // keep this fresh live; the poll is a reopen/reconnect backstop (mirrors the
  // runs poll). Merge rather than replace so an in-flight SSE delta isn't
  // clobbered by a slightly-stale poll.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await api.listSubagents(task.id);
        if (cancelled) return;
        setSubagentList((cur) => {
          // Union by id: the poll (DB) is authoritative on status, but keep any
          // id we only know from a just-arrived SSE delta that the poll query
          // raced. Sort by spawn order so tabs don't reshuffle.
          const byId = new Map<string, Subagent>();
          for (const s of cur) byId.set(s.id, s);
          for (const s of list) byId.set(s.id, s);
          return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
        });
      } catch { /* task may have been deleted */ }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [task.id]);

  // One unified task-level stream: every event from every run, merged in
  // chronological order. Replaces the old per-run subscription so the
  // panel shows the whole conversation as a single scrollback.
  useEffect(() => {
    setEvents([]);
    // Collapse the dual-emit + replay duplicates the server stream carries
    // (live echo + JSONL twin per user message; full-history replay on every
    // reconnect). The deduper keeps `user` keys in a never-trimmed set so a
    // follow-up folded into a long in-flight turn — whose live echo and JSONL
    // twin are separated by thousands of intervening events — still collapses
    // to a single bubble. See `event-dedup.ts`.
    const dedupe = createEventDeduper();
    // Coalesce the open-time replay burst into one state update per batch. On
    // connect the server streams the whole history as one SSE frame per event;
    // each `onmessage` is its own event-loop task, so React can't auto-batch
    // them. Appending one-at-a-time meant N renders of the full list = O(N²) on
    // open. Buffering + a single flush makes it O(N). Dedup (below) stays
    // synchronous so it's unaffected by the batching.
    //
    // BUT a raw rAF is not a safe *delivery* guarantee: Electrobun runs in a
    // native macOS WKWebView, which suspends requestAnimationFrame while its
    // window is occluded / minimized / on another Space. If the user
    // backgrounds agetor mid-turn, the scheduled rAF never fires, buffered
    // events pile up, and the stream looks frozen until the window is
    // re-activated (which is why "open the tmux session" — i.e. clicking back
    // into agetor — appeared to "refresh" it). So the buffer races the rAF
    // against a setTimeout fallback (for when the webview isn't painting), and
    // we also drain on visibility/focus the instant the window returns. The
    // arm/flush bookkeeping (and the re-arm-after-flush invariant that fixes
    // the freeze) lives in `createEventBuffer` so it can be unit-tested.
    const FLUSH_FALLBACK_MS = 250;
    const buffer = createEventBuffer<RunEvent>(
      (batch) => setEvents((cur) => [...cur, ...batch]),
      (flush) => {
        const raf = requestAnimationFrame(flush);
        const timer = setTimeout(flush, FLUSH_FALLBACK_MS);
        return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
      },
    );
    // When the window comes back to the foreground, drain immediately rather
    // than waiting for a throttled timer/rAF to resume on its own.
    const onVisible = () => { if (document.visibilityState === "visible") buffer.flushNow(); };
    const onFocus = () => buffer.flushNow();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const unsub = api.subscribeTask(task.id, (e) => {
      if (!dedupe.accept(e)) return;
      if (e.stream === "interaction") {
        try {
          const req = JSON.parse(e.data) as PendingInteraction;
          setInteractions((cur) => cur.some((x) => x.id === req.id) ? cur : [...cur, req]);
        } catch { /* ignore malformed */ }
        return;
      }
      if (e.stream === "subagent") {
        // Live lifecycle delta for a background/sub agent — upsert into the tab
        // list instead of pushing to the log buffer. The agent's actual
        // transcript rides the normal user/assistant/tool_* streams (tagged
        // via `subagentId`) and flows through to `buffer.push` below.
        try {
          const { subagent } = JSON.parse(e.data) as SubagentEvent;
          setSubagentList((cur) => {
            const i = cur.findIndex((s) => s.id === subagent.id);
            if (i === -1) return [...cur, subagent];
            const next = cur.slice();
            next[i] = subagent;
            return next;
          });
        } catch { /* ignore malformed */ }
        return;
      }
      if (e.stream === "interaction_resolved") {
        // Server-side resolution (scraper auto-cancel, run cancellation,
        // delete) — drop the matching card so the UI doesn't keep
        // showing a stale prompt. The card's own submit handler also
        // calls `dismissInteraction(id)` directly; both paths are
        // idempotent under `id`-based filtering.
        try {
          const { id } = JSON.parse(e.data) as { id: string };
          setInteractions((cur) => cur.filter((x) => x.id !== id));
        } catch { /* ignore malformed */ }
        return;
      }
      buffer.push(e);
    });
    return () => {
      buffer.dispose();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      unsub();
    };
  }, [task.id]);

  // Two complementary pin-to-bottom paths, both gated on `nearBottomRef` so
  // a user who scrolled up to read history is never yanked back down:
  //   1. On every event / rebuild / interaction change, scroll once after
  //      the React commit. Handles the steady-state streaming case.
  //   2. On task switch, additionally loop on rAF for a short window. Events
  //      stream in over multiple frames and rendered children (markdown,
  //      code, tool results) keep growing scrollHeight after their initial
  //      mount, so a single post-commit scroll can leave us short. The loop
  //      bails the moment the user scrolls (nearBottomRef flips to false).
  useEffect(() => {
    if (!nearBottomRef.current) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, rebuilt, interactions.length, activeStream]);

  useEffect(() => {
    let cancelled = false;
    const deadline = performance.now() + 600;
    const pin = () => {
      if (cancelled || !nearBottomRef.current) return;
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (performance.now() < deadline) requestAnimationFrame(pin);
    };
    requestAnimationFrame(pin);
    return () => { cancelled = true; };
  }, [task.id]);

  // Auto-rebuild from the latest run's on-disk JSONL when the run is
  // finished and has a claude session id. The persisted `run_events`
  // rows were truncated by an older agetor mapper (tool inputs capped
  // at 500 chars), so the JSONL is the canonical source. Skips while
  // a run is in flight (live tailing is still appending) and codex
  // (no JSONL transcript).
  useEffect(() => {
    if (!latestRun) return;
    if (latestRun.status === "running") return;
    if (!latestRun.claudeSessionId) return;
    const sessionId = latestRun.claudeSessionId;
    let cancelled = false;
    void api.rebuildRunEvents(latestRun.id).then((res) => {
      if (cancelled) return;
      if (res.events.length > 0) {
        setRebuilt({ sessionId, events: res.events });
        setRebuildNote(`Loaded ${res.events.length} events from session JSONL.`);
      } else if (res.reason) {
        setRebuildNote(res.reason);
      }
    }).catch(() => { /* network blip — stay on streamed events silently */ });
    return () => { cancelled = true; };
  }, [latestRun?.id, latestRun?.status, latestRun?.claudeSessionId]);

  /** All run ids that share `rebuilt.sessionId`. A single claude session
   *  spans every turn within one tmux session, and each turn is its own
   *  run row, so the rebuild's events stand in for events from any run
   *  with that sessionId — not just the latest one. */
  const rebuiltRunIds = useMemo(() => {
    if (!rebuilt) return null;
    const ids = new Set<string>();
    for (const r of runs) {
      if (r.claudeSessionId === rebuilt.sessionId) ids.add(r.id);
    }
    return ids;
  }, [rebuilt, runs]);

  /** The task's own (main) agent events — everything not tagged to a subagent.
   *  The rebuild-from-JSONL path only ever covers the main session transcript,
   *  so it splices against these. */
  const mainEvents = useMemo(() => events.filter((e) => !e.subagentId), [events]);

  /** Background/sub-agent events bucketed by subagent id, in arrival order. */
  const subagentEventsById = useMemo(() => {
    const m = new Map<string, RunEvent[]>();
    for (const e of events) {
      if (!e.subagentId) continue;
      const arr = m.get(e.subagentId);
      if (arr) arr.push(e);
      else m.set(e.subagentId, [e]);
    }
    return m;
  }, [events]);

  /** Events for whichever stream the tab strip has selected. For "main", splice
   *  `rebuilt` in by dropping events from runs that share its sessionId and
   *  appending the rebuilt set (earlier sessions stay visible). A subagent tab
   *  shows that subagent's transcript directly (no rebuild path applies). */
  const displayedEvents = useMemo(() => {
    if (activeStream !== "main") return subagentEventsById.get(activeStream) ?? [];
    if (!rebuilt || !rebuiltRunIds) return mainEvents;
    const others = mainEvents.filter((e) => !rebuiltRunIds.has(e.runId));
    return [...others, ...rebuilt.events];
  }, [activeStream, subagentEventsById, mainEvents, rebuilt, rebuiltRunIds]);

  /** Indicator mode for the bottom-pinned heartbeat. A follow-up sent while
   *  the agent is working is folded into the active run (the backend pastes it
   *  into the live session — no new run row), so there's only ever one
   *  in-flight run per task: the heartbeat is simply on ("Agent is working…")
   *  or off. Hidden while an interaction card is up. */
  const indicatorMode: RunIndicatorMode = useMemo(() => {
    // A background-agent tab's heartbeat tracks that subagent's own status,
    // independent of the main turn (the parent turn may already be in `review`
    // while a background workflow keeps running).
    if (activeStream !== "main") {
      const s = subagentList.find((x) => x.id === activeStream);
      return s?.status === "running" ? "active" : "off";
    }
    if (interactions.length > 0) return "off";
    return runs.some((r) => r.status === "running") ? "active" : "off";
  }, [activeStream, subagentList, interactions.length, runs]);

  // The run-status RunEventList uses to gate its bottom heartbeat. On a
  // background-agent tab this must reflect THAT subagent's status, not the main
  // run's — otherwise a subagent still running after the parent turn resolved
  // to `review` (the core background-workflow case) would have its heartbeat
  // suppressed because the main run reads `succeeded`. Map the subagent's
  // status onto the Run["status"] shape the child expects.
  const activeRunStatus: Run["status"] | null = useMemo(() => {
    if (activeStream === "main") return latestRun?.status ?? null;
    return subagentList.find((s) => s.id === activeStream)?.status === "running"
      ? "running"
      : "succeeded";
  }, [activeStream, subagentList, latestRun?.status]);

  // Tabs are shown only while background agents are active (see
  // `shouldShowSubagentTabs`). Logic is extracted + unit-tested in
  // lib/subagent-tabs.ts (the repo has no DOM test harness).
  const parentRunRunning = useMemo(() => runs.some((r) => r.status === "running"), [runs]);
  const showSubagentTabs = useMemo(
    () => shouldShowSubagentTabs(subagentList, parentRunRunning),
    [subagentList, parentRunRunning],
  );

  // When the strip collapses (or the active subagent disappears), fall back to
  // the Main stream so the log + composer can't be stranded on a hidden tab.
  useEffect(() => {
    const resolved = resolveActiveStream(activeStream, showSubagentTabs, subagentList);
    if (resolved !== activeStream) setActiveStream(resolved);
  }, [showSubagentTabs, subagentList, activeStream]);

  // Two separate affordances:
  //   • `canControl` — Stop button is only meaningful when there's an in-flight
  //     turn (column running/blocked). Stopping a finished run is a no-op.
  //   • `canSend`   — once the task has ever been run, the user can keep
  //     talking to it. When the tmux session is dead (orphan-reconciled, app
  //     restarted, run cancelled, …), the backend's `spawnResumedSession`
  //     spins up a fresh tmux + `claude --resume <claudeSessionId>` so the
  //     conversation continues from the same JSONL transcript. `task.runId`
  //     is null in that orphan-reconciled state, so we fall back to the most
  //     recent run id to identify which task → which claude session to
  //     resume. Codex has no resume mechanism; restrict to claude-code.
  const liveRunId = task.runId;
  // Reconcile against the independently-polled runs list: if the live run has
  // already resolved (succeeded/failed/cancelled/orphaned), the task isn't
  // running regardless of what `task.column` says. `task.column` is a snapshot
  // polled into the board and can briefly lag the DB; `runs` is polled here
  // (with its own error handling) so a resolved live run is the more
  // trustworthy "no longer running" signal. When the live run hasn't been
  // polled in yet (freshly started — not in `runs` yet), `liveRun` is null and
  // we fall back to trusting `task.column`, so Stop never hides on a genuinely
  // in-flight turn.
  const liveRun = liveRunId ? runs.find((r) => r.id === liveRunId) ?? null : null;
  const liveRunTerminal = !!liveRun && liveRun.status !== "running";
  const canControl = !!liveRunId
    && (task.column === "running" || task.column === "blocked")
    && !liveRunTerminal;
  const resumableRunId = liveRunId
    ?? (kind === "claude-code" && runs.length > 0 ? runs[0]!.id : null);
  // Send is enabled whenever the task has ever been run. While a turn is
  // in flight, the backend pastes the new prompt into the live tmux session —
  // claude queues it in its TUI input buffer and replays it as part of the
  // current response. The message folds into the active run (recorded in the
  // conversation stream, no new run row), so the task stays a single in-flight
  // run rather than stacking queued rows that could strand "running".
  const canSend = !!resumableRunId;
  // While a native modal (question / plan / permission prompt) is pending,
  // claude is blocked on it in the tmux REPL — a typed message would paste
  // into the modal instead of reaching claude (and the run would hang
  // "working"). So gate the send box: answer via the card above, or press Stop
  // to cancel cleanly first. AskUserQuestion's own card carries a per-question
  // "Custom answer" field, so custom input isn't lost.
  const modalPending = interactions.length > 0;

  const [input, setInput] = useState("");
  const [sendRefs, setSendRefs] = useState<TaskReference[]>([]);
  const [sending, setSending] = useState(false);
  const [sendHint, setSendHint] = useState<string | null>(null);
  // The task's live git status (uncommitted changes / unpushed commits).
  // Drives the "Commit & push" action chip above the textarea via
  // `shouldOfferCommitPush`. Deliberately independent of run status —
  // background agents can dirty the worktree (or add unpushed commits)
  // while the latest run is still `running`, so the chip must be able to
  // surface then too, not just after a run succeeds. `null` means unknown
  // (not yet polled, or the last poll failed) and hides the chip. A
  // polling effect keeps this in sync with the actual git state for as
  // long as the panel is mounted.
  const [gitStatus, setGitStatus] = useState<TaskGitStatus | null>(null);
  const [sendDragging, setSendDragging] = useState(false);
  // `/`-command and skill autocomplete for the send field. Same list the
  // New Task form uses — depends on (agent, workdir, branch) so a slash
  // command available in this project shows up here too.
  const [sendCommands, setSendCommands] = useState<AvailableCommand[]>([]);
  // MCP / skill / plugin entries for the Extensions picker above the send box.
  const [sendExtensions, setSendExtensions] = useState<AvailableExtension[]>([]);
  const sendRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!task.workdir.trim()) { setSendCommands([]); setSendExtensions([]); return; }
    let cancelled = false;
    // Use the same (agent, workdir, branch) shape NewTaskForm uses so the
    // discovery sources never disagree. We pick `task.branch` (the worktree's
    // working branch, or null for isolation=none → falls back to repo HEAD on
    // the backend) rather than `task.baseRef` (a pinned SHA used only for
    // reproducibility) — discovery runs against the live branch context, not
    // the historical base. Pass the harness id (task.agent) so aliased
    // multi-account harnesses read their own per-harness config.
    const branch = task.branch?.trim() || undefined;
    api
      .listAgentCapabilities({ agent: task.agent, workdir: task.workdir.trim(), branch })
      .then(({ commands, extensions }) => {
        if (cancelled) return;
        setSendCommands(commands);
        setSendExtensions(extensions);
      })
      .catch(() => { if (!cancelled) { setSendCommands([]); setSendExtensions([]); } });
    return () => { cancelled = true; };
  }, [task.agent, task.workdir, task.branch]);

  // Poll the task's git status every 5s for as long as the panel is
  // mounted, regardless of run status — with background agents, most of a
  // task's life is spent `running`, and the worktree can get dirty (or
  // gain unpushed commits) during that window, not just after a run
  // succeeds. The 5s cadence also lets the chip disappear if the agent (or
  // the user, from a separate terminal) commits the changes through
  // another path. The loop is sequential (each tick waits for the
  // previous git status to resolve before sleeping) so a slow `git
  // status` can't produce out-of-order setGitStatus calls.
  //
  // Deps are `[task.id]` ONLY — App.tsx polls /tasks every 2s and rebuilds
  // the task object each tick, so depending on `latestRun`/`task` fields
  // here would restart this effect (and its poll cadence) every 2s.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      while (!cancelled) {
        try {
          const res = await api.getTaskGitStatus(task.id);
          if (cancelled) return;
          setGitStatus(res);
        } catch {
          if (cancelled) return;
          setGitStatus(null);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [task.id]);

  const send = async () => {
    const line = input.trim();
    if (!line && !sendRefs.length) return;
    if (!resumableRunId) return;
    setSending(true);
    setSendHint(null);
    const body = appendReferences(line, sendRefs);
    try {
      const res = await api.sendRunInput(resumableRunId, body);
      if (!res.delivered) {
        setSendHint(res.reason);
      } else {
        setInput("");
        setSendRefs([]);
        // Drop the frozen JSONL snapshot — the auto-rebuild effect set
        // it from the last finished run, and the live SSE stream now
        // carries the new turn's events. Without this, the display
        // stays pinned on the pre-send transcript and the user's own
        // message never appears.
        setRebuilt(null);
        setRebuildNote(null);
        // Refresh the runs list right away so the new run row appears
        // immediately, rather than waiting up to 2s for the next poll.
        void api.listRuns(task.id).then((list) => setRuns(list)).catch(() => {});
        // Pin the view to the newest content the moment the message is
        // accepted — the user's own message lands first, followed by
        // streamed assistant chunks. The unified task-level stream picks
        // up the new turn's events automatically; no run-switching needed.
        // Flip nearBottom so the streamed chunks that follow keep auto-
        // scrolling until the user manually scrolls up again.
        nearBottomRef.current = true;
        requestAnimationFrame(() => {
          logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
        });
      }
    } catch (e) {
      setSendHint(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!liveRunId) return;
    try { await api.cancelRun(liveRunId); } catch { /* surfaced via log */ }
  };

  // One-click follow-up: ask the agent to commit & push the changes it just
  // made. Reuses the same `sendRunInput` plumbing as a typed message so the
  // resulting turn shows up as a normal run row with streamed events.
  const sendCommitPush = async () => {
    if (!resumableRunId || sending) return;
    const message = COMMIT_PUSH_PROMPT;
    // Intentionally leaves `input` / `sendRefs` alone — Commit & push is a
    // side action that shouldn't discard text the user has typed for the
    // next turn. `send()` clears those because it consumed them.
    setSending(true);
    setSendHint(null);
    try {
      const res = await api.sendRunInput(resumableRunId, message);
      if (!res.delivered) {
        setSendHint(res.reason);
      } else {
        setRebuilt(null);
        setRebuildNote(null);
        void api.listRuns(task.id).then((list) => setRuns(list)).catch(() => {});
        nearBottomRef.current = true;
        requestAnimationFrame(() => {
          logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
        });
      }
    } catch (e) {
      setSendHint(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Drag/drop + paste capture for the message textarea. Mirrors the
  // NewTaskForm sidebar flow: pathful files come straight through, blob
  // screenshots (macOS floating thumbnail, clipboard paste) get uploaded
  // to `~/.agetor/screenshots/` first. Captured items land both as chips
  // in `sendRefs` *and* as `[basename]` markers at the cursor.
  const applySendCaptured = (items: CapturedItem[]) => {
    if (!items.length) return;
    setSendRefs((cur) => mergeRefs(cur, items.map((i) => i.ref)));
    const marker = items.map((i) => `[${i.basename}]`).join(" ");
    const selection = readCaret(sendRef.current);
    let caret = 0;
    setInput((cur) => {
      const r = spliceAtSelection(cur, selection, marker);
      caret = r.caret;
      return r.next;
    });
    restoreCaret(sendRef.current, caret);
  };
  const onSendDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    // Always preventDefault on a file dragover so WKWebView doesn't fall back
    // to its native handler (navigate / open). The visual ring only lights up
    // when canSend is true, but the wrapper still claims the drop.
    e.preventDefault();
    if (canSend) setSendDragging(true);
  };
  const onSendDragLeave = (e: React.DragEvent) => {
    // Always clear when `canSend` flipped to false mid-drag — otherwise the
    // ring can outlive the drag if the task transitioned out of running.
    if (!canSend) { setSendDragging(false); return; }
    if (e.currentTarget === e.target) setSendDragging(false);
  };
  const reportSendCapture = ({ items, skipped, error }: {
    items: CapturedItem[];
    skipped: number;
    error?: string;
  }) => {
    if (error) setSendHint(`Couldn't save screenshot: ${error}`);
    else if (skipped && !items.length) setSendHint("Nothing to attach — drag a file from Finder, or a screenshot blob.");
  };
  const onSendDrop = async (e: React.DragEvent) => {
    // preventDefault unconditionally so a stray drop while !canSend doesn't
    // hand the file to WKWebView's native handler.
    e.preventDefault();
    setSendDragging(false);
    if (!canSend) return;
    setSendHint(null);
    const result = await captureDroppedOrPastedItems(e.dataTransfer);
    reportSendCapture(result);
    applySendCaptured(result.items);
  };
  const onSendPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const hasFile = Array.from(cd.items ?? []).some((it) => it.kind === "file");
    if (!hasFile) return;
    e.preventDefault();
    setSendHint(null);
    const result = await captureDroppedOrPastedItems(cd);
    reportSendCapture(result);
    applySendCaptured(result.items);
  };

  return (
    <>
      <header className="flex items-start justify-between gap-2 border-b border-border/60 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{task.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {task.agent} · {task.column}
            {task.branch && <> · <span className="font-mono">{task.branch}</span></>}
            {task.baseRef && (
              <> · <span className="font-mono opacity-70">base {task.baseRef.slice(0, 7)}</span></>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onShowDiff(task)}
            title="View this task's changes (git diff)"
          >
            <GitCompare className="mr-1 size-3" /> Diff
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void api.openPath({
                path: task.worktreePath ?? task.workdir,
                taskId: task.id,
              }).catch(() => { /* swallowed — openPath failures are best-effort */ })
            }
            title={
              task.worktreePath
                ? `Open the worktree in your file manager: ${task.worktreePath}`
                : `Open the project workdir in your file manager: ${task.workdir}`
            }
          >
            <FolderOpen className="mr-1 size-3" /> Open
          </Button>
          {/* Stop targets the main run. Hide it while viewing a read-only
              background-agent tab so the control doesn't read as "stop this
              agent" — switch back to Main to stop the task. */}
          {!archived && canControl && activeStream === "main" && (
            <Button size="sm" variant="destructive" onClick={stop}>
              <Square className="mr-1 size-3" /> Stop
            </Button>
          )}
          {!archived && task.column === "done" && (
            <Button size="sm" variant="outline" onClick={() => onArchive(task)} title="Archive task">
              <Archive className="mr-1 size-3" /> Archive
            </Button>
          )}
          {archived && (
            <Button size="sm" variant="outline" onClick={() => onUnarchive(task)} title="Unarchive task">
              <ArchiveRestore className="mr-1 size-3" /> Unarchive
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <FileMentions task={task} events={events} />

      {/* Task details. Editable inline when the task is idle — agent / mode /
          model / effort each PATCH the task on change, and if a live claude
          tmux session exists the backend mirrors the change via slash commands
          so the conversation context survives the edit. */}
      <TaskDetails
        task={task}
        agents={agents}
        harnesses={harnesses}
        agentModels={agentModels}
        homeDir={homeDir}
        tmuxSession={latestRun?.tmuxSession ?? null}
      />

      <RunsList runs={runs} />

      <TerminalsSection task={task} />

      {showSubagentTabs && (
        <SubagentTabs
          subagents={subagentList}
          active={activeStream}
          onSelect={(id) => {
            nearBottomRef.current = true; // pin the new stream to its latest message
            setActiveStream(id);
          }}
        />
      )}

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        // `min-w-0` lets the inner content actually shrink when long
        // unbreakable strings (paths, URLs) try to exceed the panel
        // width; `overflow-x-hidden` keeps the panel from gaining a
        // horizontal scrollbar — text wraps via `break-all` on the
        // problematic spots instead.
        className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 text-xs leading-relaxed"
      >
        {runs.length === 0 ? (
          <div className="text-muted-foreground">(no runs yet — press Run to start the agent)</div>
        ) : displayedEvents.length === 0 ? (
          <div className="text-muted-foreground">Waiting for the first event…</div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              {activeStream === "main" && latestRun?.claudeSessionId ? (
                <button
                  type="button"
                  onClick={() => void rebuildFromJsonl()}
                  disabled={rebuildBusy}
                  className="rounded-md border border-border/60 bg-card px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
                  title="Re-parse the latest run's events from claude's on-disk session JSONL. Useful when the stored events were truncated by an older agetor version."
                >
                  {rebuildBusy
                    ? "Reloading…"
                    : rebuilt
                      ? `Reload from JSONL (${rebuilt.events.length} events)`
                      : "Load from session JSONL"}
                </button>
              ) : <span />}
              {rebuildNote && (
                <span className="text-[10px] text-muted-foreground">{rebuildNote}</span>
              )}
            </div>
            <RunEventList
              events={displayedEvents}
              interactions={interactions}
              onInteractionResolved={dismissInteraction}
              runStatus={activeRunStatus}
              indicatorMode={indicatorMode}
            />
          </>
        )}
      </div>

      {/* Bottom-fixed input. Enabled the moment the task has had at least one
          run — the backend reattaches to the live tmux session if there is one,
          or spawns a fresh one seeded with the previous turn's last response
          when the original session is gone. The button is given the same fixed
          height as the textarea so they baseline together. The whole dock is
          one drop zone so dragging a screenshot anywhere over the input area
          (chips, textarea, send button gap) routes through the same capture
          path. */}
      {archived ? (
        <div className="shrink-0 border-t border-border/60 p-3 text-[11px] text-muted-foreground">
          This task is archived. Unarchive it to send messages.
        </div>
      ) : activeStream !== "main" ? (
        // Background-agent streams are read-only — you can watch them but not
        // talk to them. Switch back to Main to send a message.
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 p-3 text-[11px] text-muted-foreground">
          <Eye className="size-3 shrink-0" />
          <span>
            Viewing a background agent — read-only.{" "}
            <button
              type="button"
              onClick={() => setActiveStream("main")}
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              Back to Main
            </button>{" "}
            to send a message.
          </span>
        </div>
      ) : (
        <div
          className={cn(
            "relative shrink-0 space-y-1.5 border-t border-border/60 p-2",
            sendDragging && "ring-2 ring-inset ring-primary",
          )}
          onDragOver={onSendDragOver}
          onDragLeave={onSendDragLeave}
          onDrop={onSendDrop}
        >
          {canSend && (
            <ReferencesPicker
              variant="inline"
              refs={sendRefs}
              onChange={setSendRefs}
              startingFolder={task.worktreePath ?? task.workdir}
            />
          )}
          {canSend && (
            // Picker on the left; "Commit & push" (when offered) pushed to the
            // right so it isn't stacked directly on top of the picker.
            <div className="flex items-center justify-between gap-2">
              <ExtensionPicker
                extensions={sendExtensions}
                value={input}
                onChange={setInput}
                textareaRef={sendRef}
                placement="above"
                // Already gated by the enclosing `canSend &&`, so only the
                // in-flight send needs to disable the trigger here.
                disabled={sending}
              />
              {shouldOfferCommitPush(gitStatus) && !sending && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void sendCommitPush()}
                  title="Ask the agent to commit the working-tree changes and push the current branch to origin."
                >
                  <GitCommit className="mr-1 size-3" /> Commit &amp; push
                </Button>
              )}
            </div>
          )}
          <div className="flex items-stretch gap-2">
            <div className="relative flex-1">
              <Textarea
                ref={sendRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onSendPaste}
                onKeyDown={(e) => {
                  // Enter to send; Shift+Enter for a newline. SlashAutocomplete
                  // attaches a native keydown listener that calls preventDefault
                  // when it picks a suggestion — bail here so we don't *also*
                  // send the message in the same keystroke. React fires the
                  // synthetic handler even when the native default was
                  // prevented; `defaultPrevented` is the discriminator.
                  if (e.defaultPrevented) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  modalPending
                    ? "Answer the prompt above — or press Stop to cancel, then send a new message."
                    : canSend
                    ? task.column === "running"
                      ? "Agent is working — your message will be added to the current turn. Type / for commands."
                      : task.column === "blocked"
                        ? "Answer the question, or send any follow-up. Type / for commands."
                        : "Send a message — resumes the conversation in a fresh session. Type / for commands."
                    : "Press Run task first to start a conversation."
                }
                rows={2}
                disabled={!canSend || sending || modalPending}
                className="h-16 min-h-0 w-full resize-none text-xs"
              />
              <SlashAutocomplete
                commands={sendCommands}
                value={input}
                onChange={setInput}
                textareaRef={sendRef}
                // Send field is pinned to the bottom of the panel — anchor
                // the popover above the textarea so it doesn't render below
                // the visible window.
                placement="above"
              />
            </div>
            <Button
              size="icon"
              onClick={() => void send()}
              disabled={!canSend || sending || modalPending || (!input.trim() && sendRefs.length === 0)}
              title={
                // Distinguish "live session exists" from "needs resume" — not
                // "turn in flight". `liveRunId` (task.runId) stays set while the
                // tmux session is alive (including between turns) and is only
                // null once the session is gone (orphan-reconciled), which is the
                // resume path. Keying off `canControl` here would mislabel the
                // common "session alive, no turn in flight" state as a resume.
                liveRunId
                  ? "Send to the live agent"
                  : "Resume the conversation with this message"
              }
              className="h-16 w-12 shrink-0"
            >
              <Send className="size-4" />
            </Button>
          </div>
          {sendHint && (
            <p className="mt-1 text-[10px] text-muted-foreground">{sendHint}</p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Heuristic file-path harvester. Pulls likely file paths out of the streamed
 * log so the user can one-click open them (plan files, freshly-written
 * artifacts, the file the agent just edited). Two patterns:
 *   1. Absolute paths starting with `/` (macOS / Linux).
 *   2. Inside a worktree, paths that include known file-extension hints
 *      (`.md`, `.ts`, `.tsx`, `.json`, `.txt`, …) — these are resolved
 *      relative to the worktree's cwd on click.
 *
 * Extension allow-list rather than open-ended: a bare word with a dot in it
 * (e.g. `1.5x`) would otherwise false-positive. Surfaces results as small
 * clickable chips above the log; dedup'd and ordered by first appearance.
 */
const FILE_EXTENSIONS = [
  "md", "mdx", "txt", "json", "yaml", "yml", "toml",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "sql", "sh", "css", "scss", "html",
];
const ABS_PATH_RE = /(\/(?:[\w.\-]+\/)+[\w.\-]+)/g;
const REL_PATH_RE = new RegExp(
  `(?:^|[\\s\\(\\[])([\\w./\\-]+\\.(?:${FILE_EXTENSIONS.join("|")}))(?=[\\s,\\):;]|$)`,
  "gm",
);

// Internal paths claude/agetor write to as part of normal operation —
// session JSONLs, our own data dir scratch files. The user didn't ask the
// agent to work on these; surfacing them in the "Files mentioned" chip row
// is just noise.
function isInternalPath(p: string): boolean {
  return (
    // Claude's own per-session transcript: ~/.claude/projects/<encoded>/<uuid>.jsonl
    /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p)
    // Agetor's own data dir scratch: ~/.agetor/**
    || /\/\.agetor\//.test(p)
  );
}

function extractFileMentions(events: RunEvent[]): string[] {
  if (events.length === 0) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p) || isInternalPath(p)) return;
    seen.add(p);
    order.push(p);
  };
  // Concatenate the data strings into one corpus so the existing regex
  // pair (absolute path + extension-anchored relative path) keeps working.
  // Skips interaction-stream JSON noise.
  const corpus = events
    .filter((e) => e.stream !== "interaction")
    .map((e) => e.data)
    .join("\n");
  for (const m of corpus.matchAll(ABS_PATH_RE)) push(m[1]!);
  for (const m of corpus.matchAll(REL_PATH_RE)) push(m[1]!);
  return order.slice(0, 20);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Read-only tab strip for switching the log between the task's own (Main)
 * agent stream and each background/sub agent it has spawned. Shown only while
 * background agents are active (see `showSubagentTabs`). The Main tab is always
 * first and visually emphasised — it's the one stream you can actually talk to;
 * the background tabs are watch-only. A running agent shows a pulsing green dot,
 * a finished one a check.
 */
function SubagentTab({ s, selected, onSelect }: { s: Subagent; selected: boolean; onSelect: (id: string) => void }) {
  const label = s.agentType ?? "agent";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(s.id)}
      title={s.description ?? label}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
        selected
          ? "bg-accent text-accent-foreground ring-1 ring-border"
          : "text-muted-foreground hover:bg-muted/40",
      )}
    >
      {/* Nested agents (spawned by another subagent, not the main agent) get a
          depth marker so the hierarchy is legible in a flat strip. */}
      {s.spawnDepth > 1 && <CornerDownRight className="size-3 shrink-0 text-muted-foreground/60" />}
      {s.status === "running" ? (
        <span className="relative inline-flex size-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
      ) : (
        <Check className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="max-w-[10rem] truncate">{label}</span>
      {s.description && (
        <span className="max-w-[12rem] truncate text-muted-foreground/70">· {s.description}</span>
      )}
    </button>
  );
}

function SubagentTabs({
  subagents,
  active,
  onSelect,
}: {
  subagents: Subagent[];
  active: string;
  onSelect: (id: string) => void;
}) {
  // Collapse a large fan-out behind a "+N" pill; expanding wraps the strip onto
  // multiple rows rather than forcing a long horizontal scroll. A running or
  // currently-active tab is never hidden (see `splitTabsForOverflow`).
  const [expanded, setExpanded] = useState(false);
  const { visible, overflow } = splitTabsForOverflow(subagents, active);
  const shown = expanded ? subagents : visible;

  return (
    <div
      role="tablist"
      aria-label="Agent streams"
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border/60 bg-card/40 px-2 py-1.5",
        expanded ? "flex-wrap" : "overflow-x-auto",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "main"}
        onClick={() => onSelect("main")}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          // Main is always emphasised (primary accent) so it reads as the
          // controllable stream even when a background tab is selected.
          active === "main"
            ? "bg-primary/15 text-primary ring-1 ring-primary/40"
            : "text-primary/80 hover:bg-primary/10",
        )}
      >
        <Bot className="size-3" />
        Main
      </button>
      {shown.map((s) => (
        <SubagentTab key={s.id} s={s} selected={active === s.id} onSelect={onSelect} />
      ))}
      {overflow.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/40"
          title={expanded ? "Collapse background-agent tabs" : `Show ${overflow.length} more background agent${overflow.length === 1 ? "" : "s"}`}
        >
          {expanded ? "Show less" : `+${overflow.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Read-only summary of the task's run history. The panel below shows a
 * unified, merged stream of every run's events, so the list here doesn't
 * gate the view — it's purely informational. Collapsed: one summary row
 * for the latest run (status, ordinal, time, duration). Expanded: every
 * prior run in reverse-chronological order.
 */
function RunsList({ runs }: { runs: Run[] }) {
  const [open, setOpen] = useState(false);

  if (runs.length === 0) {
    return (
      <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        No runs yet for this task.
      </div>
    );
  }

  // Resolve ordinal so the user sees #1 for the first run, growing upward.
  const ordinalFor = (id: string) => runs.length - runs.findIndex((r) => r.id === id);
  const latest = runs[0]!;
  const canExpand = runs.length > 1;

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => canExpand && setOpen((o) => !o)}
        disabled={!canExpand}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs",
          canExpand && "cursor-pointer hover:bg-muted/30",
          !canExpand && "cursor-default",
        )}
        aria-expanded={canExpand ? open : undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant={STATUS_VARIANT[latest.status]} className="shrink-0">
            {latest.status}
          </Badge>
          <span className="truncate">
            Run #{ordinalFor(latest.id)} · {formatTime(latest.startedAt)}
          </span>
          {canExpand && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {open ? `${runs.length} runs` : `+${runs.length - 1} earlier`}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>{formatDuration(latest)}</span>
          {latest.exitCode !== null && latest.exitCode !== 0 && (
            <span className="text-destructive">exit {latest.exitCode}</span>
          )}
          {canExpand && (
            <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
          )}
        </span>
      </button>
      {open && canExpand && (
        <ul className="border-t border-border/40 bg-card/50" aria-label="Run history">
          {runs.slice(1).map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 border-b border-border/30 px-3 py-1.5 text-xs last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant={STATUS_VARIANT[r.status]} className="shrink-0">
                  {r.status}
                </Badge>
                <span className="truncate text-muted-foreground">
                  #{ordinalFor(r.id)} · {formatTime(r.startedAt)}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {formatDuration(r)}
                {r.exitCode !== null && r.exitCode !== 0 && (
                  <span className="ml-1 text-destructive">exit {r.exitCode}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileMentions({ task, events }: { task: Task; events: RunEvent[] }) {
  const files = useMemo(() => extractFileMentions(events), [events]);
  if (files.length === 0) return null;
  return (
    <details className="border-b border-border/60 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wide">
          Files mentioned <span className="font-mono normal-case">({files.length})</span>
        </span>
      </summary>
      <div className="mt-2 flex flex-wrap gap-1">
        {files.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() =>
              void api
                .openPath({ path: f, taskId: task.id })
                .catch(() => { /* surfaced elsewhere — chip just no-ops */ })
            }
            title={`Open ${f}`}
            className="flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-0.5 text-[11px] hover:bg-accent/40"
          >
            <FileText className="size-3 shrink-0 opacity-70" />
            <span className="truncate font-mono">{basename(f)}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

/**
 * Collapsible terminal section. Mounts {@link TerminalView} for the lifetime of
 * the panel so background tabs keep streaming even while collapsed; the PTYs
 * themselves live on the bun side and survive the panel closing entirely.
 * Defaults open when the task already has terminals (`openTerminalCount`).
 */
function TerminalsSection({ task }: { task: Task }) {
  const count = task.openTerminalCount;
  // Seed open from the count at mount, then let the user own the toggle —
  // binding `open` to the polled count would re-expand the section whenever
  // the count changes (e.g. closing one of two terminals). RunPanel remounts
  // on task switch (keyed by id), so this re-seeds per task.
  const [open, setOpen] = useState(count > 0);
  return (
    <details
      className="border-b border-border/60"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wide">
          Terminal{count > 0 && <span className="font-mono normal-case"> ({count})</span>}
        </span>
      </summary>
      <div className="h-80 border-t border-border/60">
        <TerminalView taskId={task.id} />
      </div>
    </details>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Run log renderers — one component per RunEvent.stream kind.
 *
 * Codex (and any unstructured agent) sends raw stdout/stderr chunks; claude
 * sends typed events parsed out of its JSONL transcript. We dispatch on
 * `stream` and pick a renderer:
 *   stdout/stderr/status  — flat text (no styling for stdout, red for
 *                           stderr, divider for status)
 *   assistant             — markdown-ish text block
 *   thinking              — collapsed-by-default muted card
 *   tool_use              — call card with per-tool input formatter
 *   tool_result           — result card, paired to its tool_use by id
 *
 * Adjacent same-stream text events (stdout, assistant) are visually merged
 * by the surrounding spacing; we don't pre-coalesce in state because
 * dedup + replay invariants are easier when each event stays atomic.
 * ────────────────────────────────────────────────────────────────────────── */

type RunIndicatorMode = "off" | "active";

function RunEventList({
  events,
  interactions = [],
  onInteractionResolved,
  runStatus,
  indicatorMode = "off",
}: {
  events: RunEvent[];
  interactions?: PendingInteraction[];
  onInteractionResolved?: (id: string) => void;
  runStatus?: Run["status"] | null;
  indicatorMode?: RunIndicatorMode;
}) {
  // Index tool_results by their tool_use_id so the tool-use card can show
  // Normalise legacy `[tool: Name] {...}` / `[thinking] ...` / `[result] ...`
  // stdout strings (persisted before the structured-event refactor) into the
  // same shape live events use. Without this, replayed history from older
  // runs renders as ugly prefixed text while only the in-flight events get
  // proper cards.
  const normalised = useMemo(() => events.map(normalizeLegacyEvent), [events]);

  // Index tool_results by their tool_use_id so the tool-use card can show
  // the result inline beneath it. Falls back to a standalone tool-result
  // card when no matching tool_use was seen (legacy `[result]` strings have
  // no id and always render orphan).
  const resultByToolId = useMemo(() => {
    const map = new Map<string, ParsedToolResult>();
    for (const e of normalised) {
      if (e.stream !== "tool_result") continue;
      const parsed = safeParse<ParsedToolResult>(e.data);
      if (parsed?.toolUseId) map.set(parsed.toolUseId, parsed);
    }
    return map;
  }, [normalised]);

  // Interleave events and interaction cards by timestamp. Interactions
  // already carry a `createdAt`; pair each with the first event-index
  // whose ts is >= createdAt so it lands next to the agent activity that
  // prompted it. Anything still unmatched after the last event spills
  // out below as "since the run finished" — usually means a question
  // fired right at end_turn.
  const sortedInteractions = useMemo(
    () => [...interactions].sort((a, b) => a.createdAt - b.createdAt),
    [interactions],
  );
  const interactionByIndex = useMemo(() => {
    const slots = new Map<number, PendingInteraction[]>();
    let idx = 0;
    for (const it of sortedInteractions) {
      while (idx < normalised.length && (normalised[idx]?.ts ?? 0) <= it.createdAt) idx++;
      const bucket = slots.get(idx) ?? [];
      bucket.push(it);
      slots.set(idx, bucket);
    }
    return slots;
  }, [normalised, sortedInteractions]);

  // Group events into sections delimited by user messages. Each section
  // wraps its user message (sticky) and the events that followed it, so
  // the user-message bubble pins to the top of the scroll viewport only
  // for the duration of its own section — when the next user message
  // appears in view, the previous one releases naturally rather than
  // stacking on top of it.
  //
  // Memoized over the parsed inputs: this rebuilds the rendered element tree
  // only when the events / interactions / tool-result map actually change.
  // A bare `setRuns` poll re-render (every 2s) hits the cache, so React gets
  // the identical element references and bails out of the whole subtree —
  // without this, the O(n) loop + every block's markdown re-parsed on each
  // poll is what made long conversations lag. `renderEvent`/`renderInteraction`
  // live inside so their captured deps (`resultByToolId`, `onInteractionResolved`)
  // are tracked explicitly.
  const sections = useMemo(() => {
    const renderEvent = (e: RunEvent, key: string): React.ReactNode[] => {
      switch (e.stream) {
        case "user":
          return [<UserMessageBlock key={key} text={e.data} />];
        case "assistant":
          return [<AssistantBlock key={key} text={e.data} />];
        case "thinking":
          return [<ThinkingBlock key={key} text={e.data} />];
        case "tool_use": {
          const parsed = safeParse<ParsedToolUse>(e.data);
          if (!parsed) return [<RawText key={key} text={e.data} muted />];
          const result = resultByToolId.get(parsed.id);
          return [<ToolUseBlock key={key} call={parsed} result={result} />];
        }
        case "tool_result": {
          const parsed = safeParse<ParsedToolResult>(e.data);
          if (parsed && parsed.toolUseId && resultByToolId.get(parsed.toolUseId)) return [];
          return [<ToolResultBlock key={key} result={parsed} />];
        }
        case "status":
          return [<StatusDivider key={key} text={e.data} />];
        case "stderr":
          return [<ErrorBlock key={key} text={e.data} />];
        case "stdout":
        case "interaction":
        default:
          if (e.stream === "interaction") return [];
          return [<RawText key={key} text={e.data} />];
      }
    };
    const renderInteraction = (it: PendingInteraction) => {
      const onResolved = onInteractionResolved ?? (() => {});
      switch (it.kind) {
        case "ask_questions":
          return <AskQuestionsCard key={`int-${it.id}`} req={it} onResolved={onResolved} />;
        case "tmux_prompt":
          return <TmuxPromptCard key={`int-${it.id}`} req={it} onResolved={onResolved} />;
      }
    };

    const out: { key: string; header: React.ReactNode; body: React.ReactNode[] }[] = [];
    // Stable per-section key = the key of the section's first event (`ts-index`,
    // unique and append-stable), so appending events keeps earlier sections'
    // identity instead of reindexing them as the old `sec-${idx}` key did.
    let current: { key: string; header: React.ReactNode; body: React.ReactNode[] } = { key: "", header: null, body: [] };
    for (let i = 0; i < normalised.length; i++) {
      const e = normalised[i]!;
      const key = `${e.ts}-${i}`;
      const before = (interactionByIndex.get(i) ?? []).map(renderInteraction);
      if (e.stream === "user") {
        if (current.header !== null || current.body.length > 0) out.push(current);
        current = { key, header: renderEvent(e, key)[0] ?? null, body: [...before] };
      } else {
        if (current.key === "") current.key = key;
        current.body.push(...before, ...renderEvent(e, key));
      }
    }
    const tail = (interactionByIndex.get(normalised.length) ?? []).map(renderInteraction);
    current.body.push(...tail);
    if (current.header !== null || current.body.length > 0) out.push(current);
    return out;
  }, [normalised, interactionByIndex, resultByToolId, onInteractionResolved]);

  return (
    <div className="flex flex-col gap-4">
      {sections.map((s, idx) => (
        <section key={s.key || `sec-${idx}`} className="flex flex-col gap-4">
          {s.header}
          {s.body}
        </section>
      ))}
      {indicatorMode !== "off" && runStatus === "running" && (
        <RunningIndicator />
      )}
    </div>
  );
}

/**
 * Pinned-at-bottom heartbeat shown while the agent is mid-turn. Hidden
 * when an interaction card is up — the card is the right affordance for
 * "waiting on you" and the spinner would compete with it. Follow-ups sent
 * while the agent is working fold into the active run, so there's no separate
 * "queued" state to surface — it's simply working or not.
 */
function RunningIndicator() {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="relative inline-flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <span>Agent is working…</span>
    </div>
  );
}

/**
 * Map an old `stdout` event with one of the pre-refactor prefixes
 * (`[tool: Name] {...}`, `[thinking] ...`, `[result] ...`) into the
 * structured shape live events now use. Anything that doesn't match is
 * returned unchanged. Pure; safe to memoise.
 *
 * The legacy mapper truncated tool input to 500 chars with a `…`
 * ellipsis, so JSON.parse on those rows fails. We try `repairTruncatedJson`
 * to recover whatever's parseable — at least the early fields like
 * AskUserQuestion's first question + leading options come back as a real
 * object so the per-tool renderer can show *something* useful.
 */
function normalizeLegacyEvent(e: RunEvent): RunEvent {
  // Old user-message events were emitted as `status` with a "you: " prefix.
  // Hoist them onto the dedicated "user" stream so they render as bubbles.
  if (e.stream === "status" && e.data.startsWith("you: ")) {
    return { ...e, stream: "user", data: e.data.slice("you: ".length) };
  }
  if (e.stream !== "stdout" || !e.data) return e;
  const toolMatch = e.data.match(/^\[tool: ([^\]]+)\]\s*([\s\S]*)$/);
  if (toolMatch) {
    const rawInput = toolMatch[2] ?? "";
    let input: unknown;
    try {
      input = JSON.parse(rawInput);
    } catch {
      const repaired = repairTruncatedJson(rawInput);
      input = repaired ?? rawInput;
    }
    return {
      ...e,
      stream: "tool_use",
      data: JSON.stringify({ id: "", name: toolMatch[1], input }),
    };
  }
  const thinkingMatch = e.data.match(/^\[thinking\]\s*([\s\S]*)$/);
  if (thinkingMatch) {
    return { ...e, stream: "thinking", data: thinkingMatch[1]! };
  }
  const resultMatch = e.data.match(/^\[result\]\s*([\s\S]*)$/);
  if (resultMatch) {
    return {
      ...e,
      stream: "tool_result",
      data: JSON.stringify({ toolUseId: "", content: resultMatch[1] }),
    };
  }
  return e;
}

/**
 * Best-effort repair for legacy 500-char-truncated tool-input JSON. Walks
 * the string tracking quote and bracket/brace state, then closes whatever's
 * still open. Returns the parsed object on success, or null if the repair
 * doesn't yield valid JSON (some truncations are unrecoverable — e.g. cut
 * inside a number literal or a `\u` escape).
 *
 * The intent is "salvage the early fields the user can act on" — perfect
 * recovery is impossible since the tail bytes are gone.
 */
function repairTruncatedJson(input: string): unknown | null {
  let clean = input.replace(/…\s*$/u, "").replace(/\s+$/u, "");
  if (!clean) return null;
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of clean) {
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // If we cut mid-escape (`\` is the last char before the cut), drop it —
  // otherwise the closer-injection will produce an invalid `\<closer>`.
  if (escape) clean = clean.slice(0, -1);
  let repaired = clean;
  if (inString) repaired += '"';
  // Trailing commas would invalidate the repair — strip before closing.
  repaired = repaired.replace(/,\s*$/u, "");
  while (stack.length) repaired += stack.pop()!;
  try { return JSON.parse(repaired); } catch { return null; }
}

interface ParsedToolUse { id: string; name: string; input: unknown; serverSide?: boolean }
interface ParsedToolResult { toolUseId: string; content: unknown; isError?: boolean }

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return null;
}

// Hoisted ReactMarkdown `components` maps. Defined once at module scope so the
// prop identity is stable across renders. The previous shape built a fresh
// `components={{…}}` object inside every render of every markdown block, which
// forced ReactMarkdown to re-parse/re-render — the dominant cost once a run log
// is long. The two maps differ only in the code-block background.
type MdComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>;

// External links open in the system browser via the OS handler.
const mdRenderLink: NonNullable<MdComponents["a"]> = ({ href, children, ...rest }) => (
  <ExternalLink {...rest} href={href}>
    {children}
  </ExternalLink>
);

const mdRenderCode: NonNullable<MdComponents["code"]> = ({ className, children, ...props }) => {
  const isBlock = /language-/.test(className ?? "");
  if (isBlock) {
    return (
      <code className={cn(className, "font-mono text-[11px]")} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code
      className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px] text-foreground"
      {...props}
    >
      {children}
    </code>
  );
};

const USER_MD_COMPONENTS: MdComponents = {
  a: mdRenderLink,
  code: mdRenderCode,
  pre: ({ children }) => <CodeBlock bgClassName="bg-background/60">{children}</CodeBlock>,
};

const ASSISTANT_MD_COMPONENTS: MdComponents = {
  a: mdRenderLink,
  code: mdRenderCode,
  pre: ({ children }) => <CodeBlock bgClassName="bg-muted/40">{children}</CodeBlock>,
};

const UserMessageBlock = memo(function UserMessageBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Carries the pre-toggle measurements from the click handler into the
  // useLayoutEffect below — used to compensate the scroll container by the
  // bubble's height delta so content below the bubble stays at the same
  // visual position after expand/collapse.
  const pendingAdjustRef = useRef<{ scroller: HTMLElement; prevHeight: number } | null>(null);

  // Default to the collapsed ~3-line cap and measure once mounted. The cap
  // is always rendered so short messages don't flash full-height first;
  // the toggle button only surfaces when scrollHeight exceeds clientHeight,
  // i.e. content actually overflows the cap.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setNeedsToggle(el.scrollHeight > el.clientHeight + 2);
  }, [text]);

  // After expand/collapse commits, apply the saved scroll-top compensation.
  useLayoutEffect(() => {
    const pending = pendingAdjustRef.current;
    if (!pending || !bubbleRef.current) return;
    const delta = bubbleRef.current.offsetHeight - pending.prevHeight;
    if (delta !== 0) pending.scroller.scrollTop += delta;
    pendingAdjustRef.current = null;
  }, [expanded]);

  const onToggle = () => {
    const bubble = bubbleRef.current;
    if (bubble) {
      const scroller = findScrollParent(bubble);
      if (scroller) {
        pendingAdjustRef.current = { scroller, prevHeight: bubble.offsetHeight };
      }
    }
    setExpanded((v) => !v);
  };

  return (
    <div className="sticky top-0 z-10 flex justify-end">
      <div ref={bubbleRef} className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/30 bg-card/50 px-3 py-1.5 text-foreground shadow-sm backdrop-blur-md">
        <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary/80">
          you
        </div>
        <div
          ref={contentRef}
          className={cn(
            "agetor-md",
            expanded
              ? "max-h-[40vh] overflow-y-auto"
              : "max-h-[4.5rem] overflow-hidden",
          )}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={USER_MD_COMPONENTS}>
            {text}
          </ReactMarkdown>
        </div>
        {needsToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="mt-1 text-[10px] font-medium uppercase tracking-wide text-primary/70 hover:text-primary"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
});

const AssistantBlock = memo(function AssistantBlock({ text }: { text: string }) {
  return (
    <div className="agetor-md text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function nodeToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return nodeToText((node as { props: { children: unknown } }).props.children);
  }
  return "";
}

function CodeBlock({
  children,
  bgClassName,
}: {
  children: React.ReactNode;
  bgClassName: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const text = nodeToText(children).replace(/\n$/, "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };
  return (
    <div className="group relative my-2">
      <pre
        className={cn(
          "overflow-auto rounded-md border border-border/40 p-2 pr-9 font-mono text-[11px] leading-relaxed",
          bgClassName,
        )}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy"}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

const RawText = memo(function RawText({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap font-mono text-[11px]",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {text}
    </div>
  );
});

const ErrorBlock = memo(function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
      {text}
    </div>
  );
});

const StatusDivider = memo(function StatusDivider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>{text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
});

const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>thinking</span>
      </button>
      <div className="mt-1 whitespace-pre-wrap text-[11px] italic text-muted-foreground">
        {open ? text : preview}
      </div>
    </div>
  );
});

/** Tool-call card with input rendered per-tool, plus the matched result
 *  collapsed underneath (expand to read full output). Special-cases:
 *  AskUserQuestion + ExitPlanMode get prominent styling because the user
 *  *needs to act on them* — claude is blocked waiting for an answer that
 *  agetor's UI doesn't otherwise prompt for. */
const ToolUseBlock = memo(function ToolUseBlock({ call, result }: { call: ParsedToolUse; result?: ParsedToolResult }) {
  const summary = formatToolInputSummary(call.name, call.input);
  const isInteractive = call.name === "AskUserQuestion" || call.name === "ExitPlanMode";
  // MCP convention: `mcp__<server>__<tool>`. The server name is always the
  // first segment after the `mcp__` prefix; everything after the next `__`
  // is the literal tool name (which itself may contain `__`). We rebuild
  // the tool half via `slice(1).join("__")` so deep names survive.
  const mcpParts = call.name.startsWith("mcp__") ? call.name.slice(5).split("__") : null;
  const Icon = toolIcon(call.name);
  return (
    <div
      className={cn(
        "rounded-md border bg-card",
        isInteractive ? "border-primary/60 ring-1 ring-primary/40" : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-2 py-1.5 text-[11px]">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {mcpParts && mcpParts.length >= 2 ? (
          <span className="flex items-center gap-1 font-mono">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">mcp · {mcpParts[0]}</Badge>
            <span className="font-medium">{mcpParts.slice(1).join("__")}</span>
          </span>
        ) : (
          <span className="font-mono font-medium">{call.name}</span>
        )}
        {call.serverSide && (
          <Badge variant="secondary" className="px-1 py-0 text-[9px] uppercase">server</Badge>
        )}
        {summary && <span className="truncate text-muted-foreground">· {summary}</span>}
      </div>
      <ToolInputBody name={call.name} input={call.input} />
      {result && <ToolResultBody result={result} />}
      {isInteractive && !result && (
        <div className="border-t border-primary/40 bg-primary/10 px-2 py-1.5 text-[11px] text-foreground">
          {call.name === "AskUserQuestion"
            ? "Claude is asking — answer it in the card above (it has a custom-answer field for anything not listed)."
            : "Claude is waiting for plan approval — use the card above. To reject or request changes, press Stop, then send a message."}
        </div>
      )}
    </div>
  );
});

const ToolResultBlock = memo(function ToolResultBlock({ result }: { result: ParsedToolResult | null }) {
  if (!result) return null;
  return (
    <div className="rounded-md border border-border/40 bg-muted/20">
      <div className="border-b border-border/30 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        tool result (orphan)
      </div>
      <ToolResultBody result={result} />
    </div>
  );
});

/**
 * Anchor that hands off http(s)/mailto navigation to the OS default browser
 * via Electrobun's `Utils.openExternal`. The webview is sandboxed —
 * `target="_blank"` is a no-op there — so every link in agent output has to
 * round-trip through the main process to reach a real browser.
 */
function ExternalLink({
  href,
  className,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const safe = typeof href === "string" && /^(https?|mailto):/i.test(href) ? href : null;
  return (
    <a
      {...rest}
      href={safe ?? "#"}
      onClick={(e) => {
        e.preventDefault();
        if (!safe) return;
        void api.openExternal(safe).catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : "Could not open link");
        });
      }}
      className={cn("text-primary underline-offset-2 hover:underline", className)}
    >
      {children}
    </a>
  );
}

/** Tiny labeled-row helper for tool input bodies. Keeps the markup terse. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/**
 * Long-content body with a per-card "Show more / Show less" toggle. Used
 * for any tool field that can be arbitrarily long — plan bodies, file
 * contents, edit diffs, subagent prompts, etc. Defaults to a ~12-line
 * preview, expandable to full content. The `className` prop controls the
 * code-block tint per use site (red for diff `-`, green for `+`, neutral).
 */
function ExpandableBlock({
  text,
  prefix,
  className,
  previewLimit = 600,
}: {
  text: string;
  prefix?: string;
  className?: string;
  previewLimit?: number;
}) {
  const [open, setOpen] = useState(false);
  const full = (prefix ?? "") + text;
  const isLong = full.length > previewLimit;
  return (
    <div className="mt-1">
      <pre
        className={cn(
          "overflow-auto whitespace-pre-wrap break-words rounded p-1.5 font-mono text-[10px]",
          className ?? "bg-muted/40",
          // Collapsed view caps at ~12 lines via max-height so a
          // monstrous file content doesn't dominate the panel.
          !open && "max-h-48",
        )}
      >
        {open || !isLong ? full : full.slice(0, previewLimit) + "…"}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? "Show less" : `Show more (${full.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function ToolInputBody({ name, input }: { name: string; input: unknown }) {
  // Per-tool pretty rendering. Anything not specifically handled falls
  // through to a collapsed JSON block at the bottom.
  if (name === "Bash" && isRecord(input) && typeof input.command === "string") {
    return (
      <div className="px-2 py-1.5">
        <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono text-[11px]">
          <span className="select-none text-muted-foreground">$ </span>{input.command}
        </pre>
        {typeof input.description === "string" && input.description && (
          <div className="pt-1 text-[10px] text-muted-foreground">{input.description}</div>
        )}
        {input.run_in_background === true && (
          <Badge variant="secondary" className="mt-1 px-1.5 py-0 text-[9px] uppercase">background</Badge>
        )}
      </div>
    );
  }
  if ((name === "Read" || name === "Glob" || name === "LS") && isRecord(input)) {
    const target = (input.file_path ?? input.path ?? input.pattern) as string | undefined;
    const offset = input.offset, limit = input.limit;
    return target ? (
      <div className="px-2 py-1.5 font-mono text-[11px]">
        <span className="break-all">{target}</span>
        {(typeof offset === "number" || typeof limit === "number") && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            {typeof offset === "number" ? `from line ${offset}` : ""}
            {typeof limit === "number" ? ` · ${limit} lines` : ""}
          </span>
        )}
      </div>
    ) : <RawJsonBody input={input} />;
  }
  if ((name === "Write" || name === "Edit" || name === "NotebookEdit") && isRecord(input) && typeof input.file_path === "string") {
    return (
      <div className="px-2 py-1.5">
        <div className="mb-1 break-all font-mono text-[11px]">{input.file_path}</div>
        {typeof input.old_string === "string" && (
          <ExpandableBlock
            text={input.old_string}
            prefix="- "
            className="bg-destructive/10 text-destructive"
          />
        )}
        {typeof input.new_string === "string" && (
          <ExpandableBlock
            text={input.new_string}
            prefix="+ "
            className="bg-green-500/10 text-green-600 dark:text-green-400"
          />
        )}
        {typeof input.content === "string" && (
          <ExpandableBlock text={input.content} />
        )}
        {input.replace_all === true && (
          <Badge variant="secondary" className="mt-1 px-1.5 py-0 text-[9px] uppercase">replace all</Badge>
        )}
      </div>
    );
  }
  if (name === "Grep" && isRecord(input)) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        <Field label="pattern">
          <code className="rounded bg-muted/40 px-1 font-mono">{String(input.pattern ?? "")}</code>
        </Field>
        {typeof input.path === "string" && <Field label="in"><span className="font-mono">{input.path}</span></Field>}
        {typeof input.glob === "string" && <Field label="glob"><span className="font-mono">{input.glob}</span></Field>}
        {typeof input.type === "string" && <Field label="type"><span className="font-mono">{input.type}</span></Field>}
        {typeof input.output_mode === "string" && <Field label="mode"><span className="font-mono">{input.output_mode}</span></Field>}
      </div>
    );
  }
  if ((name === "Agent" || name === "Task") && isRecord(input)) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        {typeof input.subagent_type === "string" && (
          <Field label="subagent">
            <Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">{input.subagent_type}</Badge>
          </Field>
        )}
        {typeof input.description === "string" && (
          <Field label="task"><span className="text-foreground">{input.description}</span></Field>
        )}
        {typeof input.prompt === "string" && (
          <ExpandableBlock text={input.prompt} previewLimit={400} />
        )}
      </div>
    );
  }
  if (name === "TodoWrite" && isRecord(input) && Array.isArray(input.todos)) {
    return (
      <ul className="space-y-0.5 px-2 py-1.5 text-[11px]">
        {(input.todos as Array<Record<string, unknown>>).map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="shrink-0 text-muted-foreground">
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"}
            </span>
            <span className={cn(t.status === "completed" && "line-through text-muted-foreground")}>
              {String(t.content ?? "")}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (name === "AskUserQuestion" && isRecord(input) && Array.isArray(input.questions)) {
    return (
      <div className="px-2 py-1.5 text-[11px]">
        {(input.questions as Array<Record<string, unknown>>).map((q, i) => (
          <div key={i} className={cn(i > 0 && "mt-2 border-t border-border/30 pt-2")}>
            <div className="font-medium">{String(q.question ?? "")}</div>
            {Array.isArray(q.options) && (
              <ul className="mt-1 space-y-0.5">
                {(q.options as Array<Record<string, unknown>>).map((o, j) => (
                  <li key={j} className="text-muted-foreground">
                    · <span className="font-medium text-foreground">{String(o.label ?? "")}</span>
                    {typeof o.description === "string" && <> — {o.description}</>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (name === "ExitPlanMode" && isRecord(input) && typeof input.plan === "string") {
    return (
      <div className="px-2 py-1.5">
        <ExpandableBlock text={input.plan} previewLimit={600} />
      </div>
    );
  }
  // Claude-code's deferred-tool discovery — surfaces the *next* tool claude
  // wants to call. Useful breadcrumb for understanding why a particular tool
  // suddenly appeared mid-session.
  if (name === "ToolSearch" && isRecord(input)) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        <Field label="query">
          <code className="rounded bg-muted/40 px-1 font-mono">{String(input.query ?? "")}</code>
        </Field>
        {typeof input.max_results === "number" && (
          <Field label="max"><span className="font-mono">{input.max_results}</span></Field>
        )}
      </div>
    );
  }
  if (name === "WebFetch" && isRecord(input)) {
    // Whitelist http/https before rendering as a clickable anchor.
    // Without this, a `javascript:`-scheme URL would execute in the
    // webview's CSP context on click — narrow but real XSS vector since
    // claude is steered by the user's prompt.
    const rawUrl = typeof input.url === "string" ? input.url : null;
    const safeUrl = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
    return (
      <div className="space-y-1 px-2 py-1.5">
        {rawUrl && (
          <Field label="url">
            {safeUrl ? (
              <ExternalLink className="font-mono" href={safeUrl}>{safeUrl}</ExternalLink>
            ) : (
              <span className="font-mono text-muted-foreground" title="non-http(s) URL — rendered as plain text for safety">{rawUrl}</span>
            )}
          </Field>
        )}
        {typeof input.prompt === "string" && (
          <Field label="prompt"><ExpandableBlock text={input.prompt} previewLimit={240} /></Field>
        )}
      </div>
    );
  }
  if (name === "WebSearch" && isRecord(input)) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        <Field label="query">
          <code className="rounded bg-muted/40 px-1 font-mono">{String(input.query ?? "")}</code>
        </Field>
        {Array.isArray(input.allowed_domains) && input.allowed_domains.length > 0 && (
          <Field label="allow">
            <span className="flex flex-wrap gap-1">
              {(input.allowed_domains as unknown[]).map((d, i) => (
                <Badge key={i} variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{String(d)}</Badge>
              ))}
            </span>
          </Field>
        )}
        {Array.isArray(input.blocked_domains) && input.blocked_domains.length > 0 && (
          <Field label="block">
            <span className="flex flex-wrap gap-1">
              {(input.blocked_domains as unknown[]).map((d, i) => (
                <Badge key={i} variant="destructive" className="px-1.5 py-0 font-mono text-[10px]">{String(d)}</Badge>
              ))}
            </span>
          </Field>
        )}
      </div>
    );
  }
  if (name === "SlashCommand" && isRecord(input) && typeof input.command === "string") {
    return (
      <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
        {input.command}
      </pre>
    );
  }
  if (name === "Skill" && isRecord(input)) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        {typeof input.skill === "string" && (
          <Field label="skill">
            <Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">{input.skill}</Badge>
          </Field>
        )}
        {typeof input.args === "string" && input.args && (
          <Field label="args"><span className="whitespace-pre-wrap">{truncateString(input.args, 240)}</span></Field>
        )}
      </div>
    );
  }
  if ((name === "BashOutput" || name === "KillShell") && isRecord(input) && typeof input.shell_id === "string") {
    return (
      <div className="px-2 py-1.5 font-mono text-[11px]">shell {input.shell_id}</div>
    );
  }
  return <RawJsonBody input={input} />;
}

function RawJsonBody({ input }: { input: unknown }) {
  // Strings come through when legacy truncated tool-input JSON couldn't be
  // repaired; render them raw rather than re-JSON-stringifying (which would
  // wrap the whole thing in quotes and escape every inner `"` — exactly
  // what the user saw).
  const body = typeof input === "string"
    ? input
    : JSON.stringify(input, null, 2);
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
      {body}
    </pre>
  );
}

function ToolResultBody({ result }: { result: ParsedToolResult }) {
  const [open, setOpen] = useState(false);
  const text = stringifyResult(result.content);
  const isLong = text.length > 280;
  const preview = isLong ? text.slice(0, 280) + "…" : text;
  return (
    <div className={cn("border-t border-border/40", result.isError && "bg-destructive/10")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>{result.isError ? "error result" : "result"}</span>
      </button>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-2 pb-1.5 font-mono text-[11px]">
        {open || !isLong ? text : preview}
      </pre>
    </div>
  );
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // claude returns content as an array of blocks ({type:"text",text:"…"})
    // for tools that return rich output (eg the Agent tool's report).
    return content
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : JSON.stringify(b)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

function truncateString(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lucide icon for a tool name. Picks something semantically close —
 * Bash → Terminal, Read → FileText, Write → FilePlus, … — and falls
 * back to a generic Wrench for tools we don't have a specific icon for
 * yet. Used by ToolUseBlock's header.
 */
function toolIcon(name: string): ComponentType<{ className?: string; "aria-hidden"?: boolean }> {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return Terminal;
    case "Read":
    case "NotebookRead":
      return FileText;
    case "Write":
      return FilePlus;
    case "Edit":
    case "NotebookEdit":
      return FilePenLine;
    case "LS":
      return Folder;
    case "Glob":
    case "Grep":
    case "ToolSearch":
      return Search;
    case "Agent":
    case "Task":
      return Bot;
    case "TodoWrite":
      return ListTodo;
    case "AskUserQuestion":
      return HelpCircle;
    case "ExitPlanMode":
      return ClipboardList;
    case "WebFetch":
    case "WebSearch":
      return Globe;
    case "SlashCommand":
      return Slash;
    case "Skill":
      return Sparkles;
    default:
      // MCP tools get their own icon so the user can spot "this is a
      // third-party server's tool" at a glance.
      if (name.startsWith("mcp__")) return Plug;
      return Wrench;
  }
}

/** One-line summary of a tool call's input, shown next to the tool name in
 *  the card header so a collapsed log is still scannable. */
function formatToolInputSummary(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  if (name === "Bash" && typeof input.command === "string") return truncateString(input.command, 80);
  if ((name === "Read" || name === "Glob" || name === "LS") && (typeof input.file_path === "string" || typeof input.path === "string" || typeof input.pattern === "string")) {
    return String(input.file_path ?? input.path ?? input.pattern);
  }
  if ((name === "Write" || name === "Edit" || name === "NotebookEdit") && typeof input.file_path === "string") return input.file_path;
  if (name === "Grep" && typeof input.pattern === "string") return String(input.pattern);
  if ((name === "Agent" || name === "Task") && typeof input.description === "string") return input.description;
  if (name === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.length > 0) {
    const q0 = input.questions[0] as Record<string, unknown>;
    return typeof q0?.question === "string" ? truncateString(q0.question, 80) : `${input.questions.length} question(s)`;
  }
  if (name === "ExitPlanMode") return "plan ready for approval";
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as Array<Record<string, unknown>>;
    const done = todos.filter((t) => t.status === "completed").length;
    return `${done}/${todos.length} done`;
  }
  if (name === "ToolSearch" && typeof input.query === "string") return truncateString(input.query, 80);
  if (name === "WebFetch" && typeof input.url === "string") return truncateString(input.url, 80);
  if (name === "WebSearch" && typeof input.query === "string") return truncateString(input.query, 80);
  if (name === "SlashCommand" && typeof input.command === "string") return truncateString(input.command, 80);
  if (name === "Skill" && typeof input.skill === "string") return String(input.skill);
  if ((name === "BashOutput" || name === "KillShell") && typeof input.shell_id === "string") return String(input.shell_id);
  // MCP tools: the header already shows `mcp · server / tool` via a Badge
  // pair, so we leave the summary empty to avoid double-labeling.
  return "";
}

/**
 * Compact summary of the task's saved configuration. Behavioural fields
 * (agent / mode / model / effort) become inline selects whenever the task is
 * idle — running / blocked tasks render the same values as plain text with a
 * "stop the run to edit" hint, mirroring how the workdir lock works in the
 * EditTaskDialog. Project / isolation / branch / base are always read-only
 * here — those touch worktree setup that isn't safe to mutate on the fly.
 */
function TaskDetails({
  task,
  agents,
  harnesses,
  agentModels,
  homeDir,
  tmuxSession,
}: {
  task: Task;
  agents: AgentStatus[];
  harnesses: Harness[];
  agentModels: AgentModelMap;
  homeDir: string;
  /** Tmux session name from the latest run (claude-code only). `null` when
   *  no run has spawned a session yet — the Tmux row hides itself in that
   *  case rather than presenting an Attach button that's guaranteed to 404. */
  tmuxSession: string | null;
}) {
  const editable = task.column !== "running" && task.column !== "blocked";
  const kind = harnessKindOf(task.agent, harnesses);

  const save = async (patch: Partial<Task>) => {
    try {
      await api.updateTask(task.id, patch);
    } catch {
      // Swallow — the parent's poll picks the row back up on the next 2s tick
      // and the dropdown reverts on its own. We could surface this through
      // the global error toast, but for now keeping it quiet matches the
      // optimistic-UI pattern the rest of the panel uses.
    }
  };

  // Effort is per (agent, model) — e.g. xhigh isn't valid for Sonnet 4.6,
  // and Haiku 4.5 doesn't accept the effort param at all. When the user picks
  // a model that no longer supports the saved effort, drop it back to the
  // kind's default effort (if supported) or null when the model is the
  // Haiku-style "no effort" case. Same pattern as the new-task form.
  const supportedEffortsForModel = useMemo(
    () => supportedEfforts(kind, task.model),
    [kind, task.model],
  );
  const allowedEfforts = useMemo(
    () => new Set(supportedEffortsForModel.map((o) => o.id)),
    [supportedEffortsForModel],
  );
  useEffect(() => {
    if (task.effort && allowedEfforts.has(task.effort)) return;
    if (supportedEffortsForModel.length === 0) {
      if (task.effort !== null) void save({ effort: null });
      return;
    }
    const fallback = allowedEfforts.has(DEFAULT_EFFORT[kind])
      ? DEFAULT_EFFORT[kind]
      : supportedEffortsForModel[0]!.id;
    if (task.effort !== fallback) void save({ effort: fallback });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedEfforts, task.effort, supportedEffortsForModel]);

  const onAgentChange = (nextId: string) => {
    if (nextId === task.agent) return;
    // Switching harness wipes the current mode / model / effort context —
    // those ids belong to the old harness's kind option set. Reset to the
    // new harness's kind defaults (DEFAULT_MODEL + DEFAULT_EFFORT) and let
    // the user re-pick if they want something specific. Sent as one PATCH
    // so the server-side reconcile only fires once.
    const nextKind = harnessKindOf(nextId, harnesses);
    const nextMode = AGENT_OPTIONS[nextKind].modes[0]?.id ?? "auto";
    const nextModel = DEFAULT_MODEL[nextKind];
    const nextEfforts = supportedEfforts(nextKind, nextModel);
    const nextEffort = nextEfforts.length === 0
      ? null
      : nextEfforts.some((e) => e.id === DEFAULT_EFFORT[nextKind])
        ? DEFAULT_EFFORT[nextKind]
        : nextEfforts[0]!.id;
    void save({ agent: nextId, mode: nextMode, model: nextModel, effort: nextEffort });
  };

  return (
    <details className="border-b border-border/60 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">Task details</summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Prompt</div>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-snug">{task.prompt}</p>
        </div>

        {!editable && (
          <p className="text-[10px] italic text-muted-foreground">
            Stop the run to change agent / mode / model / effort.
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-muted-foreground">Agent</dt>
          <dd className="min-w-0">
            {editable ? (
              <AgentSelect
                value={task.agent}
                harnesses={harnesses}
                agents={agents}
                onChange={onAgentChange}
              />
            ) : (
              <span className="inline-flex items-center gap-1">
                <AgentIcon kind={kind} className="size-3" /> {task.agent}
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">Mode</dt>
          <dd className="min-w-0">
            {editable ? (
              <CompactSelect
                value={task.mode ?? supportedModes(kind, task.model)[0]?.id ?? "bypass"}
                options={supportedModes(kind, task.model)}
                onChange={(mode) => void save({ mode })}
              />
            ) : (
              <span>{task.mode ?? "—"}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Model</dt>
          <dd className="min-w-0">
            {editable ? (
              <CompactSelect
                value={task.model ?? DEFAULT_MODEL[kind]}
                options={mergedModels(kind, agentModels)}
                onChange={(model) => void save({ model })}
              />
            ) : (
              <span>{task.model ?? "—"}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Effort</dt>
          <dd className="min-w-0">
            {editable ? (
              <CompactSelect
                value={task.effort ?? ""}
                options={supportedEffortsForModel}
                onChange={(effort) => void save({ effort })}
                disabled={supportedEffortsForModel.length === 0}
                placeholder="n/a"
              />
            ) : (
              <span>{task.effort ?? "—"}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Project</dt>
          <dd className="min-w-0 truncate font-mono" title={task.workdir}>
            {abbreviateHome(task.workdir, homeDir)}
          </dd>

          <dt className="text-muted-foreground">Isolation</dt>
          <dd className="min-w-0">{task.isolation}</dd>

          {task.branch && (
            <>
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="min-w-0 truncate font-mono">{task.branch}</dd>
            </>
          )}
          {task.baseRef && (
            <>
              <dt className="text-muted-foreground">Base</dt>
              <dd className="min-w-0 truncate font-mono">{task.baseRef.slice(0, 12)}</dd>
            </>
          )}
          {kind === "claude-code" && tmuxSession && (
            <>
              <dt className="text-muted-foreground">Tmux</dt>
              <dd className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono" title={tmuxSession}>
                  {tmuxSession}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={() => {
                    void api.openTmux(task.id).catch((err: unknown) => {
                      const msg = err instanceof Error ? err.message : "Could not attach to tmux session";
                      toast.error(msg);
                    });
                  }}
                  title={`Attach to the tmux session in a new Terminal window (tmux attach -t ${tmuxSession})`}
                >
                  <Terminal className="mr-1 size-3" /> Attach
                </Button>
              </dd>
            </>
          )}
          {task.references.length > 0 && (
            <>
              <dt className="text-muted-foreground self-start">Files</dt>
              <dd className="min-w-0">
                <details open>
                  <summary className="cursor-pointer text-muted-foreground">
                    <span className="font-mono">({task.references.length})</span>{" "}
                    files / folders
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {task.references.map((r) => {
                      const Icon = iconForRef(r);
                      return (
                        <li
                          key={r.path}
                          title={r.path}
                          className="flex items-center gap-1"
                        >
                          <Icon className="size-3 shrink-0 opacity-70" />
                          <button
                            type="button"
                            onClick={() =>
                              void api
                                .openPath({ path: r.path, taskId: task.id })
                                .catch(() => {})
                            }
                            className="truncate font-mono text-left hover:underline"
                          >
                            {refBasename(r.path)}{r.isDirectory ? "/" : ""}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </dd>
            </>
          )}
        </dl>
      </div>
    </details>
  );
}

/** Merge curated AGENT_OPTIONS models with CLI-discovered ones (same logic as
 *  NewTaskForm) so the inline editor surfaces every model the user can pick. */
function mergedModels(agent: AgentKind, agentModels: AgentModelMap) {
  const stat = AGENT_OPTIONS[agent].models;
  const known = new Set(stat.map((m) => m.id));
  const extras = (agentModels[agent] ?? [])
    .filter((m) => !known.has(m.id))
    .map((m): typeof stat[number] => ({ id: m.id, label: m.label ?? m.id }));
  return [...stat, ...extras];
}

function CompactSelect({
  value,
  options,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 text-[11px]"
      disabled={disabled}
    >
      {options.length === 0 && placeholder ? (
        <option value="">{placeholder}</option>
      ) : (
        options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))
      )}
    </Select>
  );
}

function AgentSelect({
  value,
  harnesses,
  agents,
  onChange,
}: {
  /** Current harness id stored on the task. */
  value: string;
  harnesses: Harness[];
  agents: AgentStatus[];
  onChange: (next: string) => void;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 text-[11px]"
    >
      {harnesses.map((h) => {
        const available = agents.find((a) => a.harnessId === h.id)?.available ?? true;
        return (
          <option key={h.id} value={h.id}>
            {h.label}{available ? "" : " (unavailable)"}
          </option>
        );
      })}
    </Select>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Interaction cards: tool-call approvals + clarifying questions
 * ────────────────────────────────────────────────────────────────────────── */

/** One-line summary for the tool's primary input — Bash → command,
 *  Edit/Write/Read → file_path, others → JSON-stringified, truncated. */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (toolName === "Bash" && typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
    if (typeof o.path === "string") return o.path;
  }
  const s = typeof input === "string" ? input : JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

/**
 * Card for claude's built-in AskUserQuestion (scraper-sourced from the tmux
 * pane). One claude tool call can carry multiple sub-questions; we render
 * each with its own radio/checkbox group + free-text "Custom answer"
 * field. A single Send button at the bottom commits all of them.
 *
 * The wire format includes rich `options` with descriptions, and the answer
 * round-trip goes through `/ask-questions/:id/answer` — the server plans the
 * keystrokes from the user's picks and drives them into the native modal.
 */
function AskQuestionsCard({
  req,
  onResolved,
}: {
  req: Extract<PendingInteraction, { kind: "ask_questions" }>;
  onResolved: (id: string) => void;
}) {
  // One entry per question. selected = picked option labels; custom = optional free-text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; custom: string }>>(
    () => req.questions.map(() => ({ selected: [], custom: "" })),
  );
  const [submitting, setSubmitting] = useState(false);
  // Two-phase flow mirroring claude's native modal: answer every question,
  // then a review screen ("✔ Submit" tab) before the final submit.
  const [phase, setPhase] = useState<"answer" | "review">("answer");

  const togglePick = (qi: number, label: string, multi: boolean) => {
    setAnswers((cur) =>
      cur.map((a, i) => {
        if (i !== qi) return a;
        if (multi) {
          return a.selected.includes(label)
            ? { ...a, selected: a.selected.filter((s) => s !== label) }
            : { ...a, selected: [...a.selected, label] };
        }
        return { ...a, selected: [label] };
      }),
    );
  };

  const setCustom = (qi: number, value: string) =>
    setAnswers((cur) => cur.map((a, i) => (i === qi ? { ...a, custom: value } : a)));

  // Every question needs at least one of selected/custom non-empty before
  // we let the user send. Mirrors the contract claude expects — empty
  // answers would confuse its next turn.
  const canSubmit = answers.every(
    (a) => a.selected.length > 0 || a.custom.trim().length > 0,
  );

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await api.answerAskQuestions(req.id, {
        answers: answers.map((a) => ({
          selected: a.selected,
          custom: a.custom.trim() || undefined,
        })),
      });
      onResolved(req.id);
    } finally {
      setSubmitting(false);
    }
  };

  /** One-line summary of the user's answer to question `qi` (picked labels +
   *  any custom text), for the review screen. Mirrors the native "→ a, b". */
  const answerSummary = (qi: number): string => {
    const a = answers[qi] ?? { selected: [], custom: "" };
    const pieces = [...a.selected];
    if (a.custom.trim()) pieces.push(a.custom.trim());
    return pieces.length ? pieces.join(", ") : "(no answer)";
  };

  return (
    <div className="rounded-md border border-primary/60 bg-card p-3 ring-1 ring-primary/40">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-primary">
          <HelpCircle className="size-3.5" aria-hidden />
          {phase === "review" ? "Review your answers" : "Claude is asking"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {phase === "review"
            ? "before submitting"
            : req.questions.length === 1 ? "1 question" : `${req.questions.length} questions`}
        </span>
      </div>

      {phase === "review" ? (
        <>
          <div className="space-y-2">
            {req.questions.map((q, qi) => (
              <div key={qi} className="rounded-md border border-border/40 bg-muted/20 p-2">
                <div className="text-[12px] font-medium">{q.question}</div>
                <div className="mt-0.5 text-[12px] text-primary">→ {answerSummary(qi)}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => setPhase("answer")} disabled={submitting}>
              ← Back
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit || submitting} size="sm">
              {submitting ? "Submitting…" : "Submit answers"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-3">
            {req.questions.map((q, qi) => (
              <div key={qi} className="rounded-md border border-border/40 bg-muted/20 p-2">
                <div className="mb-1.5 text-[13px] font-medium">{q.question}</div>
                <div className="space-y-1">
                  {q.options.map((opt) => {
                    const picked = answers[qi]?.selected.includes(opt.label) ?? false;
                    return (
                      <label
                        key={opt.label}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded border border-transparent px-1.5 py-1 hover:bg-accent/30",
                          picked && "border-primary/40 bg-primary/10",
                        )}
                      >
                        <input
                          type={q.multiSelect ? "checkbox" : "radio"}
                          name={`q-${req.id}-${qi}`}
                          checked={picked}
                          onChange={() => togglePick(qi, opt.label, Boolean(q.multiSelect))}
                          className="mt-0.5"
                        />
                        <span className="text-[12px]">
                          <span className="font-medium">{opt.label}</span>
                          {opt.description && (
                            <span className="block text-[11px] text-muted-foreground">{opt.description}</span>
                          )}
                          {opt.preview && (
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1.5 font-mono text-[10px] leading-snug text-muted-foreground">{opt.preview}</pre>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <Textarea
                  value={answers[qi]?.custom ?? ""}
                  onChange={(e) => setCustom(qi, e.target.value)}
                  placeholder="Custom answer (optional)"
                  rows={2}
                  className="mt-2 text-[12px]"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end">
            <Button onClick={() => setPhase("review")} disabled={!canSubmit || submitting} size="sm">
              Review answers →
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Card for a REPL modal the tmux pane scraper caught — typically a
 * plan-mode safety dialog, `/login`, model picker, or any prompt the
 * PreToolUse hook system never sees. Clicking a choice ships the
 * literal key (e.g. `"1"`) back to the server, which `tmux send-keys`-es
 * it into the pane so claude reads it as the user's keypress.
 *
 * The card's appearance is intentionally pane-like (monospace, dark
 * background) so the user recognises that they're looking at what's
 * actually on the tmux screen, not an agetor-synthesised question.
 */
/** claude's TUI keyboard-shortcut footers — meaningless when answering through
 *  agetor's buttons, and they bury the actual prompt. Stripped from the scraped
 *  pane before display. Display-only; the parsed choices are unaffected. */
const PROMPT_NOISE_RE = [
  /^esc to cancel\b/i,
  /^enter to (confirm|select|continue)\b/i,
  /^↑\/↓/,
  /^tab to amend\b/i,
  /\bctrl\+e to explain\b/i,
  /\(ctrl\+b ctrl\+b/i,
  /to run in background\)/i,
];
function cleanPromptPane(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (PROMPT_NOISE_RE.some((re) => re.test(line.trim()))) continue;
    if (out.length > 0 && out[out.length - 1] === line) continue; // repaint dup row
    out.push(line);
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

function TmuxPromptCard({
  req,
  onResolved,
}: {
  req: Extract<PendingInteraction, { kind: "tmux_prompt" }>;
  onResolved: (id: string) => void;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (key: string) => {
    if (submitting) return;
    setSubmitting(key);
    setError(null);
    try {
      // Only clear the card once the server has handled it. Resolving
      // optimistically (the old behaviour) made a failed keystroke briefly
      // hide the card, then the scraper re-detected the still-present modal
      // and re-registered it — the "flicker that stays" the user saw.
      //
      // `{ ok: false }` (HTTP 200) means the prompt was already resolved
      // server-side (scraper auto-cancel, double-click) — the card should
      // just go away, not show an error. Genuine delivery failures come
      // back as 410/500 and throw, landing in the catch below.
      await api.answerTmuxPrompt(req.id, key === "__reject__" ? { reject: true } : { key });
      onResolved(req.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send choice.");
    } finally {
      setSubmitting(null);
    }
  };
  // ExitPlanMode's native approval modal is a numbered prompt the scraper
  // catches like any other, but it deserves a first-class card (not the raw
  // pane dump) — same polish as the AskUserQuestion card. Detect it by its
  // signature and render labelled buttons; the plan markdown itself is already
  // shown just above in the ExitPlanMode tool-use card.
  const isPlan = /written up a plan|Would you like to proceed/i.test(req.paneText);
  if (isPlan) {
    const planLabel = (label: string): string => {
      const l = label.toLowerCase();
      if (/auto/.test(l)) return "Approve — auto-accept edits";
      if (/manual/.test(l)) return "Approve — review each edit";
      if (/tell claude/.test(l)) return "Tell Claude what to change";
      if (/^no\b|refine|keep planning/.test(l)) return "Keep planning (don't proceed)";
      return label;
    };
    return (
      <div className="rounded-md border border-primary/60 bg-card p-3 ring-1 ring-primary/40">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-primary">
          <ClipboardList className="size-3.5" aria-hidden /> Claude’s plan is ready
        </div>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Claude finished a plan (shown above) and is ready to execute. How should it proceed?
        </p>
        <div className="flex flex-col gap-1.5">
          {req.choices
            // Only the two "Yes, …" approvals are genuine one-click actions.
            // Claude's own "No, refine with Ultraplan…" jumps to the web and
            // "Tell Claude what to change" opens an inline TUI field a button
            // can't fill — so we offer our own Reject (below) instead, which
            // Esc's the modal and lets the user redirect via the message box.
            .filter((c) => /^yes\b/i.test(c.label.trim()))
            .map((c) => (
              <Button
                key={c.key}
                onClick={() => void send(c.key)}
                size="sm"
                variant="secondary"
                disabled={submitting !== null}
                className="justify-start"
              >
                {submitting === c.key ? "Sending…" : planLabel(c.label)}
              </Button>
            ))}
          <Button
            onClick={() => void send("__reject__")}
            size="sm"
            variant="outline"
            disabled={submitting !== null}
            className="justify-start"
          >
            {submitting === "__reject__" ? "Dismissing…" : "Reject — don’t approve"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Rejecting dismisses the plan; then describe your changes in the message box below.
        </p>
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/60 bg-card p-3 ring-1 ring-amber-500/40">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-500">
          <Terminal className="size-3.5" aria-hidden /> Claude is paused on a prompt
        </span>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/40 p-2 font-mono text-[11px] leading-snug">
        {cleanPromptPane(req.paneText)}
      </pre>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {req.choices.map((c) => {
          // Visual hint only: dim out the "negative" choice so it doesn't
          // sit at equal weight with the primary one. Anchor the regex
          // so labels like "Notify me" or "Nominate" don't accidentally
          // get styled as a destructive action.
          const isNegative = c.key.toLowerCase() === "n"
            || /^(no|reject|cancel|deny|abort|quit)\b/i.test(c.label.trim());
          return (
            <Button
              key={c.key}
              onClick={() => void send(c.key)}
              size="sm"
              variant={isNegative ? "outline" : "secondary"}
              disabled={submitting !== null}
            >
              {submitting === c.key ? "Sending…" : `${c.key}. ${c.label}`}
            </Button>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-right text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );
}
