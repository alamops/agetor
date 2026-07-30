import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertCircle, BookmarkPlus, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus,
  FileSymlink, GitCompare, Loader2, Send, X,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, type PendingInteraction } from "@/lib/api";
import { toRows, type DiffRow } from "@/lib/diff-rows";
import {
  addRangeToSelection, composeDiffMessage, groupSelectedRows, isRowInDragRange, isSelectableKind,
  type DiffDragRange, type DiffSelectionBlock,
} from "@/lib/diff-selection";
import type { AgentKind, DiffFile, Harness, Run, Task, TaskDiff } from "../../../shared/types.ts";

interface Props {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

const STATUS_META: Record<DiffFile["status"], { label: string; icon: typeof FilePlus; cls: string }> = {
  added: { label: "added", icon: FilePlus, cls: "text-emerald-400" },
  modified: { label: "modified", icon: FilePen, cls: "text-amber-400" },
  deleted: { label: "deleted", icon: FileMinus, cls: "text-rose-400" },
  renamed: { label: "renamed", icon: FileSymlink, cls: "text-sky-400" },
};

/**
 * Resolve a task's harness id to its underlying kind. Duplicated (rather than
 * imported) from RunPanel.tsx's private `harnessKindOf` — that function isn't
 * exported, and this dialog is scoped to touch only this file, so a small
 * local copy is cheaper than widening RunPanel's surface for one call site.
 */
function harnessKindOf(harnessId: string, harnesses: Harness[]): AgentKind {
  return harnesses.find((h) => h.id === harnessId)?.kind ?? "claude-code";
}

// Edge auto-scroll tuning for the drag gesture below: start scrolling once
// the pointer is within this many px of the scroll container's top/bottom,
// at a speed proportional to how deep into that zone the pointer is (capped).
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_MAX_SPEED = 15;

/** Resolve the `data-diff-path`/`data-diff-index` row a DOM node sits inside
 *  (or is itself), via the nearest `[data-diff-index]` ancestor. Fed whatever
 *  element `resolveHitTarget` below decided to hit-test — either the native
 *  event's `target`, or an `elementFromPoint` lookup (auto-scroll re-resolve,
 *  or the pointer-outside-container clamp). */
function resolveRowFromElement(el: Element | null): { path: string; index: number } | null {
  const rowEl = el?.closest<HTMLElement>("[data-diff-index]");
  if (!rowEl) return null;
  const path = rowEl.dataset.diffPath;
  const indexStr = rowEl.dataset.diffIndex;
  if (!path || indexStr === undefined) return null;
  const index = Number(indexStr);
  return Number.isNaN(index) ? null : { path, index };
}

function firstSelectableIndex(rows: DiffRow[]): number {
  const idx = rows.findIndex((r) => isSelectableKind(r.kind));
  return idx === -1 ? 0 : idx;
}

function lastSelectableIndex(rows: DiffRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isSelectableKind(rows[i]!.kind)) return i;
  }
  return rows.length - 1;
}

/**
 * Read-only viewer for everything a task's worktree changed vs its pinned base
 * ref, plus click-to-select diff lines that compose into a message you can
 * send to the agent or park on the task's messages backlog. Fetches on open,
 * renders a per-file collapsible unified diff. When the task has no worktree
 * (or nothing changed) the server returns a friendly `note` which we show in
 * place of the file list.
 */
export function DiffDialog({ open, task, onClose }: Props) {
  const taskId = task?.id ?? null;
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  // Selection: file path -> selected row indices into that file's `toRows`
  // output. `lastClicked` anchors shift-click range extension.
  const [selected, setSelected] = useState<Map<string, Set<number>>>(new Map());
  const [lastClicked, setLastClicked] = useState<{ path: string; index: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // Click-and-drag multi-line selection. `dragRange` is the *pending* drag's
  // React-visible state — it stays null while a drag is armed-but-not-yet-
  // activated (a plain mousedown+mouseup on one row must fall through to the
  // ordinary click path below untouched) and only becomes non-null once the
  // pointer crosses onto a different row. Refs mirror what the document-level
  // listeners and the rAF auto-scroll loop need without waiting for a render:
  // `dragRangeRef` is the authoritative in-flight range, `didDragRef` flags
  // "a real drag happened" (suppresses the trailing click on the anchor row),
  // `anchorRowsRef` holds the anchor file's rows for clamping/committing,
  // `bodyRefs` maps file path -> that file's row-list DOM node (for the
  // same-file clamp's bounding-rect check), and `containerRectRef` caches the
  // scroll container's own bounding rect for the lifetime of one drag (it's
  // captured once at arm time — scrolling the container doesn't move the
  // container element itself, so there's no need to re-measure every frame).
  const [dragRange, setDragRange] = useState<DiffDragRange | null>(null);
  const dragRangeRef = useRef<DiffDragRange | null>(null);
  const didDragRef = useRef(false);
  const lastClientRef = useRef({ x: 0, y: 0 });
  const anchorRowsRef = useRef<DiffRow[]>([]);
  const bodyRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const containerRectRef = useRef<DOMRect | null>(null);
  // Latest-value ref mirroring `cancelDrag` (defined further below) so
  // earlier-defined callbacks — and the diff-refetch effect — can invoke the
  // cancel path without taking a dependency on it (that dependency would
  // otherwise churn the effect's deps every time the drag-callback chain is
  // touched, risking a refetch loop).
  const cancelDragRef = useRef<() => void>(() => {});
  // Latest-value ref mirroring `lastClicked` so `handleRowClick` can read the
  // shift-click anchor without depending on the state value itself — that
  // dependency would otherwise recreate `handleRowClick` on every click,
  // defeating the `DiffBody` memoization below (a new `onRowClick` identity
  // busts memo for every file, not just the one that changed).
  const lastClickedRef = useRef<{ path: string; index: number } | null>(null);

  const registerBody = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) bodyRefs.current.set(path, el);
    else bodyRefs.current.delete(path);
  }, []);

  const updateLastClicked = useCallback((value: { path: string; index: number } | null) => {
    lastClickedRef.current = value;
    setLastClicked(value);
  }, []);

  // Stable indirection to the in-flight `cancelDrag` (via the ref above) —
  // used both as the window `blur` listener (needs a fixed identity to add
  // once and remove later) and inline wherever a cancel is needed without
  // creating a dependency on `cancelDrag` itself.
  const handleDragCancelSignal = useCallback(() => {
    cancelDragRef.current();
  }, []);

  // Resolve the DOM element to hit-test for drag row-resolution. When the
  // pointer is vertically inside the cached scroll-container rect, prefer
  // the already-known `target` (a native mousemove event's target) to avoid
  // an extra `elementFromPoint` call; when there's no known target (the
  // auto-scroll loop, which has no live event) fall back to
  // `elementFromPoint` at the real position. When the pointer is vertically
  // *outside* the container (dragged onto the composer below it, or above it
  // onto the header), hit-test at the container's own clipped edge instead
  // of the real, out-of-bounds point — that lands on whatever row is still
  // visible right at the edge, rather than on unrelated content laid out
  // below/above the scroll area (which would never resolve to a row at all).
  const resolveHitTarget = useCallback(
    (x: number, y: number, target: Element | null): Element | null => {
      const rect = containerRectRef.current;
      if (!rect) return target ?? document.elementFromPoint(x, y);
      if (y < rect.top || y > rect.bottom) {
        const clampedY = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
        return document.elementFromPoint(x, clampedY);
      }
      return target ?? document.elementFromPoint(x, y);
    },
    [],
  );

  // Resolve which row index the drag should report as `currentIndex` given a
  // hit-tested DOM element (from `resolveHitTarget` above). When the hit
  // lands on a row in the anchor file, use it directly (even a non-selectable
  // hunk/meta row — downstream range math filters to selectable kinds).
  // Otherwise (a different file, or dead space `resolveHitTarget` couldn't
  // resolve to a row) clamp against the anchor file's row-list bounding
  // rect: above it -> first selectable row, below it -> last selectable row,
  // inside its vertical span but unresolved -> `null` (hold the previous
  // index).
  const resolveDragIndex = useCallback(
    (drag: DiffDragRange, clientY: number, hitTarget: Element | null): number | null => {
      const resolved = resolveRowFromElement(hitTarget);
      if (resolved && resolved.path === drag.path) return resolved.index;
      const container = bodyRefs.current.get(drag.path);
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      if (clientY < rect.top) return firstSelectableIndex(anchorRowsRef.current);
      if (clientY > rect.bottom) return lastSelectableIndex(anchorRowsRef.current);
      return null;
    },
    [],
  );

  // Apply a newly-resolved hovered index at row-boundary granularity only
  // (a no-op if it matches the current index, so pixel-level mousemove churn
  // doesn't cascade into re-renders). Crossing away from the anchor row for
  // the first time flips `didDragRef` — the drag-activation signal that the
  // `dragActive` effect below reacts to (clearing native selection, starting
  // auto-scroll).
  const applyDragIndex = useCallback((newIndex: number) => {
    const drag = dragRangeRef.current;
    if (!drag || newIndex === drag.currentIndex) return;
    if (newIndex !== drag.anchorIndex) didDragRef.current = true;
    const nextRange: DiffDragRange = { ...drag, currentIndex: newIndex };
    dragRangeRef.current = nextRange;
    setDragRange(nextRange);
  }, []);

  // The rAF auto-scroll loop. Does *not* unconditionally reschedule itself —
  // when the pointer isn't in an edge zone (`dy === 0`) this frame is the
  // loop's last one; `maybeArmAutoScroll` (below) re-starts it from the
  // mousemove handler once the pointer re-enters an edge zone. This keeps a
  // drag that never nears an edge from paying for a permanent 60Hz loop.
  const autoScrollStep = useCallback(() => {
    rafRef.current = null;
    const container = scrollContainerRef.current;
    const drag = dragRangeRef.current;
    const rect = containerRectRef.current;
    if (!container || !drag || !rect) return;
    const { x, y } = lastClientRef.current;
    let dy = 0;
    if (y < rect.top + AUTOSCROLL_EDGE_PX) {
      dy = -Math.min(AUTOSCROLL_MAX_SPEED, (rect.top + AUTOSCROLL_EDGE_PX - y) / 2);
    } else if (y > rect.bottom - AUTOSCROLL_EDGE_PX) {
      dy = Math.min(AUTOSCROLL_MAX_SPEED, (y - (rect.bottom - AUTOSCROLL_EDGE_PX)) / 2);
    }
    if (dy === 0) return;
    container.scrollTop += dy;
    // mousemove doesn't fire while the container scrolls under a stationary
    // pointer, so re-resolve the hovered row from the last known pointer
    // position after each scroll step.
    const hit = resolveHitTarget(x, y, null);
    const idx = resolveDragIndex(drag, y, hit);
    if (idx !== null) applyDragIndex(idx);
    rafRef.current = requestAnimationFrame(autoScrollStep);
  }, [resolveDragIndex, applyDragIndex, resolveHitTarget]);

  // Re-arm the auto-scroll loop from the mousemove handler when the pointer
  // (re-)enters an edge zone and the loop isn't already running — the
  // counterpart to `autoScrollStep` letting itself go idle above.
  const maybeArmAutoScroll = useCallback(
    (y: number) => {
      if (rafRef.current !== null) return;
      const rect = containerRectRef.current;
      if (!rect) return;
      if (y < rect.top + AUTOSCROLL_EDGE_PX || y > rect.bottom - AUTOSCROLL_EDGE_PX) {
        rafRef.current = requestAnimationFrame(autoScrollStep);
      }
    },
    [autoScrollStep],
  );

  const handleDocumentMouseMove = useCallback(
    (e: MouseEvent) => {
      // A lost mouseup (release outside the WKWebView) leaves `buttons`
      // reporting no buttons held on the next mousemove we do see — treat
      // that as a cancel: tear down without committing, since the actual
      // release was never observed.
      if (e.buttons === 0) {
        cancelDragRef.current();
        return;
      }
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      const drag = dragRangeRef.current;
      if (!drag) return;
      const hitTarget = resolveHitTarget(e.clientX, e.clientY, e.target as Element | null);
      const idx = resolveDragIndex(drag, e.clientY, hitTarget);
      if (idx !== null) applyDragIndex(idx);
      if (didDragRef.current) maybeArmAutoScroll(e.clientY);
    },
    [resolveHitTarget, resolveDragIndex, applyDragIndex, maybeArmAutoScroll],
  );

  const handleDocumentMouseUp = useCallback(() => {
    document.removeEventListener("mousemove", handleDocumentMouseMove);
    document.removeEventListener("mouseup", handleDocumentMouseUp);
    window.removeEventListener("blur", handleDragCancelSignal);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const drag = dragRangeRef.current;
    // Only commit if the drag actually activated (crossed a row boundary) —
    // a same-row mousedown+mouseup never activates, so the native `click`
    // fires and today's toggle path handles it untouched.
    if (drag && didDragRef.current) {
      const rows = anchorRowsRef.current;
      setSelected((prev) => addRangeToSelection(prev, drag.path, rows, drag.anchorIndex, drag.currentIndex));
      updateLastClicked({ path: drag.path, index: drag.currentIndex });
    }
    dragRangeRef.current = null;
    anchorRowsRef.current = [];
    containerRectRef.current = null;
    setDragRange(null);
    // `didDragRef` is deliberately left as-is here — the next row mousedown
    // (`handleRowMouseDown`) unconditionally consumes and resets it, so the
    // trailing click on the anchor row (if any) gets suppressed even when
    // this mouseup didn't land on a row at all.
  }, [handleDocumentMouseMove, handleDragCancelSignal, updateLastClicked]);

  // Arm a pending drag on primary-button mousedown over a selectable row.
  // No preventDefault here (within-row native text selection must still be
  // able to start) — the shift-click preventDefault stays put separately
  // below. Document/window listeners are attached only for the lifetime of
  // this drag (removed in handleDocumentMouseUp / cancelDrag).
  const handleRowMouseDown = useCallback(
    (path: string, index: number, rows: DiffRow[], selectable: boolean, e: ReactMouseEvent<HTMLDivElement>) => {
      // Unconditional and first: if the previous drag's mouseup didn't land
      // on a row (released over dead space, the composer, or outside the
      // WKWebView entirely), `didDragRef` would otherwise stay `true`
      // forever and silently swallow the *next* click or shift-click
      // anywhere in the dialog.
      didDragRef.current = false;
      if (e.shiftKey) {
        e.preventDefault();
        return;
      }
      if (!selectable || e.button !== 0) return;
      dragRangeRef.current = { path, anchorIndex: index, currentIndex: index };
      anchorRowsRef.current = rows;
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      containerRectRef.current = scrollContainerRef.current?.getBoundingClientRect() ?? null;
      document.addEventListener("mousemove", handleDocumentMouseMove);
      document.addEventListener("mouseup", handleDocumentMouseUp);
      window.addEventListener("blur", handleDragCancelSignal);
    },
    [handleDocumentMouseMove, handleDocumentMouseUp, handleDragCancelSignal],
  );

  // Abandon any in-flight drag without committing — used when the dialog
  // closes/reopens or switches tasks mid-drag, on unmount, when a mouseup is
  // lost (release outside the WKWebView), and on window blur.
  const cancelDrag = useCallback(() => {
    document.removeEventListener("mousemove", handleDocumentMouseMove);
    document.removeEventListener("mouseup", handleDocumentMouseUp);
    window.removeEventListener("blur", handleDragCancelSignal);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragRangeRef.current = null;
    didDragRef.current = false;
    anchorRowsRef.current = [];
    containerRectRef.current = null;
    setDragRange(null);
  }, [handleDocumentMouseMove, handleDocumentMouseUp, handleDragCancelSignal]);

  cancelDragRef.current = cancelDrag;

  // Derived, not stored: `dragRange` only goes non-null once a drag has
  // activated (see applyDragIndex), so this doubles as "is a real drag in
  // progress" for the select-none styling below.
  const dragActive = dragRange !== null;

  // Start the edge auto-scroll loop when a drag activates; cleanup (dragActive
  // flipping false, or unmount) guarantees the rAF loop can't outlive the
  // drag or the dialog — including any later iteration re-armed by
  // `maybeArmAutoScroll` from the mousemove handler.
  useEffect(() => {
    if (!dragActive) return;
    window.getSelection()?.removeAllRanges();
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(autoScrollStep);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [dragActive, autoScrollStep]);

  // Belt-and-suspenders: the document/window listeners above are attached
  // imperatively from an event handler (not from an effect), so guarantee
  // their removal on unmount even if a drag was somehow still in flight.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleDocumentMouseMove);
      document.removeEventListener("mouseup", handleDocumentMouseUp);
      window.removeEventListener("blur", handleDragCancelSignal);
    };
  }, [handleDocumentMouseMove, handleDocumentMouseUp, handleDragCancelSignal]);

  // Gating data — same shape RunPanel uses to decide whether Send is safe.
  // Fetched lazily (below) once the composer first becomes visible, rather
  // than on every dialog open, since most diff views never select a line.
  const [runs, setRuns] = useState<Run[]>([]);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);

  useEffect(() => {
    // Reset selection + composer state on every dialog close/reopen and on
    // every diff refetch (this effect's deps mirror the fetch below), and
    // abandon any drag that was still in flight (e.g. the dialog was closed
    // mid-drag). Reads `cancelDrag` through the ref rather than depending on
    // it directly — this effect also owns the diff fetch, so a dependency on
    // the drag-callback chain would risk a refetch loop on future dep churn
    // there; the ref keeps this effect's deps to just `[open, taskId]`.
    setSelected(new Map());
    updateLastClicked(null);
    setDraft("");
    setHint(null);
    cancelDragRef.current();
    if (!open || !taskId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);
    api
      .getTaskDiff(taskId)
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
        // Expand everything by default for small change sets; keep large ones
        // collapsed so the dialog stays responsive.
        setOpenFiles(d.files.length <= 8 ? new Set(d.files.map((f) => f.path)) : new Set());
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // Key on task?.id, not `task` itself — the parent polls /tasks every 2s,
    // so a new `task` object identity arrives constantly and would otherwise
    // refetch the diff on every poll tick.
  }, [open, taskId]);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return files.reduce(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { additions: 0, deletions: 0 },
    );
  }, [diff]);

  const toggle = (path: string) =>
    setOpenFiles((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const allOpen = !!diff && diff.files.length > 0 && openFiles.size === diff.files.length;
  const setAll = (on: boolean) =>
    setOpenFiles(on && diff ? new Set(diff.files.map((f) => f.path)) : new Set());

  // Plain click toggles a row; shift-click extends from `lastClicked` when it
  // sits in the same file (adding the contiguous selectable range, via the
  // same `addRangeToSelection` helper the drag-commit path uses), otherwise
  // it behaves like a plain click on the clicked row. `lastClicked` updates on
  // every selecting click (both branches). Reads the shift-click anchor via
  // `lastClickedRef` (kept in sync by `updateLastClicked`) instead of the
  // `lastClicked` state directly, so this callback's identity stays stable
  // across clicks — see the `DiffBody` memoization below, which relies on
  // `onRowClick` not changing per-render for non-anchor files to bail out.
  const handleRowClick = useCallback(
    (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => {
      // A real drag just ended on (or through) this row — suppress the
      // trailing synthetic click so the anchor row isn't toggled back off;
      // the drag already committed its range in handleDocumentMouseUp.
      if (didDragRef.current) {
        didDragRef.current = false;
        return;
      }
      const row = rows[index];
      if (!row || !isSelectableKind(row.kind)) return;
      const anchor = lastClickedRef.current;
      if (shiftKey && anchor && anchor.path === path) {
        setSelected((prev) => addRangeToSelection(prev, path, rows, anchor.index, index));
      } else {
        setSelected((prev) => {
          const next = new Map(prev);
          const current = new Set(next.get(path) ?? []);
          if (current.has(index)) current.delete(index);
          else current.add(index);
          if (current.size === 0) next.delete(path);
          else next.set(path, current);
          return next;
        });
      }
      updateLastClicked({ path, index });
    },
    [updateLastClicked],
  );

  const totalSelected = useMemo(() => {
    let n = 0;
    for (const set of selected.values()) n += set.size;
    return n;
  }, [selected]);
  const composerVisible = totalSelected > 0;

  // A new selection starting (composer reappearing) supersedes whatever hint
  // was left over from the last send/save — e.g. the "Sent to agent." success
  // hint from a moment ago shouldn't linger once the user starts picking new
  // lines. Only fires on the false->true edge (a selection existing while the
  // composer is already visible doesn't retrigger this).
  useEffect(() => {
    if (composerVisible) setHint(null);
  }, [composerVisible]);

  // Success/error hints are otherwise sticky (no toast system to auto-dismiss
  // them) — self-clear after a few seconds so a "Sent to agent." confirmation
  // doesn't sit there forever once the composer has collapsed away.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(timer);
  }, [hint]);

  // Fetch gating data the moment the composer first becomes visible
  // (selection empty -> non-empty). Not refetched on every additional click —
  // the effect only reruns when `composerVisible` flips or the task changes.
  useEffect(() => {
    if (!composerVisible || !taskId) return;
    let cancelled = false;
    Promise.all([
      api.listRuns(taskId),
      api.listPendingInteractions(taskId),
      api.listHarnesses(),
    ])
      .then(([runList, interactionList, harnessPayload]) => {
        if (cancelled) return;
        setRuns(runList);
        setInteractions(interactionList);
        setHarnesses(harnessPayload.harnesses);
      })
      .catch(() => { /* gating falls back to safe (disabled) defaults */ });
    return () => { cancelled = true; };
  }, [composerVisible, taskId]);

  const kind = task ? harnessKindOf(task.agent, harnesses) : "claude-code";
  const liveRunId = task?.runId ?? null;
  // Mirrors RunPanel.tsx's `resumableRunId`: claude-code can resume from its
  // most recent run even once `task.runId` has been cleared (orphan-
  // reconciled); codex has no resume mechanism.
  const resumableRunId = liveRunId ?? (kind === "claude-code" && runs.length > 0 ? runs[0]!.id : null);
  const modalPending = interactions.length > 0;
  const archived = task?.archivedAt != null;
  const canSend = !!resumableRunId && !modalPending && !busy;

  const blocks = useMemo<DiffSelectionBlock[]>(() => {
    if (!diff) return [];
    const result: DiffSelectionBlock[] = [];
    for (const f of diff.files) {
      const indices = selected.get(f.path);
      if (!indices || indices.size === 0) continue;
      result.push(...groupSelectedRows(f.path, toRows(f.hunks), indices));
    }
    return result;
  }, [diff, selected]);

  const clearSelection = () => {
    setSelected(new Map());
    updateLastClicked(null);
    setDraft("");
    setHint(null);
  };

  const doSend = async () => {
    if (!task || !resumableRunId || modalPending || busy) return;
    setBusy(true);
    setHint(null);
    try {
      // Re-check right before delivering — load-bearing: a message reaching a
      // live tmux native prompt pastes into the modal instead of the agent.
      const pending = await api.listPendingInteractions(task.id);
      if (pending.length > 0) {
        setInteractions(pending);
        setHint("A prompt is waiting for a response — answer it, or Save for later instead.");
        return;
      }
      const composed = composeDiffMessage(draft.trim(), blocks);
      const res = await api.sendRunInput(resumableRunId, composed);
      if (!res.delivered) {
        setHint(res.reason);
        return;
      }
      clearSelection();
      setHint("Sent to agent.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    if (!task || archived || busy) return;
    setBusy(true);
    setHint(null);
    try {
      const composed = composeDiffMessage(draft.trim(), blocks);
      await api.addBacklogItem(task.id, { text: composed, references: [] });
      clearSelection();
      setHint("Saved to backlog.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="diff-dialog-title"
      className="flex max-h-[85vh] w-full max-w-4xl flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="diff-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitCompare className="size-4 shrink-0 text-muted-foreground" />
            Changes
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {task?.title ?? "Task"}
            {diff?.base && <> · vs base <span className="font-mono">{diff.base}</span></>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {diff && diff.files.length > 0 && (
            <div className="flex shrink-0 items-center gap-3 text-xs">
              <span className="font-mono">
                {diff.files.length} {diff.files.length === 1 ? "file" : "files"}
                {" "}
                <span className="text-emerald-400">+{totals.additions}</span>{" "}
                <span className="text-rose-400">−{totals.deletions}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setAll(!allOpen)}>
                {allOpen ? "Collapse all" : "Expand all"}
              </Button>
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div
        ref={scrollContainerRef}
        className={cn("min-h-0 flex-1 overflow-y-auto p-3", dragActive && "select-none")}
      >
        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading diff…
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-rose-400">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}

        {!loading && !error && diff && diff.files.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <GitCompare className="size-6 opacity-40" />
            {diff.note ?? "No changes to show."}
          </div>
        )}

        {!loading && !error && diff && diff.files.length > 0 && (
          <div className="flex flex-col gap-2">
            {diff.note && (
              <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {diff.note}
              </div>
            )}
            {diff.files.map((f) => (
              <FileBlock
                key={f.path}
                file={f}
                open={openFiles.has(f.path)}
                onToggle={() => toggle(f.path)}
                selectedIndices={selected.get(f.path)}
                onRowClick={handleRowClick}
                onRowMouseDown={handleRowMouseDown}
                dragRange={dragRange?.path === f.path ? dragRange : null}
                registerBody={registerBody}
              />
            ))}
          </div>
        )}
      </div>

      {(composerVisible || hint) && (
        <div className="shrink-0 border-t border-border/60 p-3">
          {composerVisible ? (
            <>
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {totalSelected} {totalSelected === 1 ? "line" : "lines"} in{" "}
                  {selected.size} {selected.size === 1 ? "file" : "files"}
                </span>
                <Button size="sm" variant="ghost" onClick={clearSelection} disabled={busy}>
                  <X className="mr-1 size-3" /> Clear
                </Button>
              </div>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) {
                      void doSend();
                    } else if (!archived) {
                      void doSave();
                    }
                  }
                }}
                placeholder="Add a message about the selected lines… (optional)"
                rows={2}
                disabled={busy}
                className="h-16 min-h-0 w-full resize-none text-xs"
              />
              {archived && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Sending will unarchive this task and restore its worktree.
                </p>
              )}
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void doSave()}
                  disabled={archived || busy}
                  title={archived ? "Unarchive the task to save drafts." : "Save this message to the backlog to send later."}
                >
                  <BookmarkPlus className="mr-1 size-3" /> Save for later
                </Button>
                <Button
                  size="sm"
                  onClick={() => void doSend()}
                  disabled={!canSend}
                  title={
                    !resumableRunId
                      ? "This task hasn't run yet — Save for later instead."
                      : modalPending
                        ? "A prompt is waiting for a response — answer it, or Save for later instead."
                        : "Send to the agent"
                  }
                >
                  <Send className="mr-1 size-3" /> Send to agent
                </Button>
              </div>
              {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
            </>
          ) : (
            // Hint-only mode: the selection was cleared (success, or a Save
            // that emptied it) but the confirmation still needs to be visible
            // for a beat — without this branch the composer's collapse-on-
            // success behavior would unmount the hint in the same render it
            // was set, so it was never seen.
            hint && <p className="text-[10px] text-muted-foreground">{hint}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Fires on every row's `onMouseDown` — even non-selectable (hunk/meta) rows
 *  and shift-held/non-primary clicks — so `didDragRef` can be reset
 *  unconditionally before any of those early-return (see handleRowMouseDown
 *  in DiffDialog). `selectable` is computed by the caller (DiffBody already
 *  needs it for styling) rather than re-derived here. */
type RowMouseDownHandler = (
  path: string,
  index: number,
  rows: DiffRow[],
  selectable: boolean,
  e: ReactMouseEvent<HTMLDivElement>,
) => void;

function FileBlock({
  file,
  open,
  onToggle,
  selectedIndices,
  onRowClick,
  onRowMouseDown,
  dragRange,
  registerBody,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
  selectedIndices: Set<number> | undefined;
  onRowClick: (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => void;
  onRowMouseDown: RowMouseDownHandler;
  dragRange: DiffDragRange | null;
  registerBody: (path: string, el: HTMLDivElement | null) => void;
}) {
  const meta = STATUS_META[file.status];
  const Icon = meta.icon;
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-muted/40 px-2 py-1.5 text-left hover:bg-muted/70"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <Icon className={cn("size-3.5 shrink-0", meta.cls)} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {file.binary ? "binary" : <><span className="text-emerald-400">+{file.additions}</span> <span className="text-rose-400">−{file.deletions}</span></>}
        </span>
      </button>
      {open && (
        file.binary ? (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">Binary file — no textual diff.</div>
        ) : (
          <>
            <DiffBody
              path={file.path}
              hunks={file.hunks}
              selectedIndices={selectedIndices}
              onRowClick={onRowClick}
              onRowMouseDown={onRowMouseDown}
              dragRange={dragRange}
              registerBody={registerBody}
            />
            {file.truncated && (
              <div className="border-t border-border/60 px-3 py-1.5 text-[11px] italic text-muted-foreground">
                Diff truncated — this file's changes are too large to display in full.
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

// Memoized so a drag's row-boundary crossings — which re-render the anchor
// file's DiffBody on every index change — don't cascade into re-rendering
// every OTHER expanded file's rows too. For this to pay off, every non-anchor
// file must receive referentially-stable props: DiffDialog passes each file
// a `dragRange` that's `null` (a stable primitive) unless it's the anchor
// file, `onRowClick`/`onRowMouseDown`/`registerBody` are all stable
// `useCallback`s, and `selectedIndices` is only a new `Set` reference for the
// file whose selection actually changed (the `Map` clone in `setSelected`
// keeps other files' `Set`s by reference).
const DiffBody = memo(function DiffBody({
  path,
  hunks,
  selectedIndices,
  onRowClick,
  onRowMouseDown,
  dragRange,
  registerBody,
}: {
  path: string;
  hunks: string;
  selectedIndices: Set<number> | undefined;
  onRowClick: (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => void;
  onRowMouseDown: RowMouseDownHandler;
  dragRange: DiffDragRange | null;
  registerBody: (path: string, el: HTMLDivElement | null) => void;
}) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  // Stable per (path, registerBody) so the ref callback doesn't detach/
  // reattach on every unrelated re-render (e.g. a selection change elsewhere
  // in the same file re-renders every row).
  const setBodyRef = useCallback((el: HTMLDivElement | null) => registerBody(path, el), [path, registerBody]);
  return (
    <div ref={setBodyRef} className="overflow-x-auto bg-card font-mono text-xs leading-relaxed">
      {rows.map((r, i) => {
        const selectable = isSelectableKind(r.kind);
        const isSelected = selectable && ((selectedIndices?.has(i) ?? false) || isRowInDragRange(dragRange, path, i));
        return (
          <div
            key={i}
            data-diff-path={path}
            data-diff-index={i}
            onMouseDown={(e) => onRowMouseDown(path, i, rows, selectable, e)}
            onClick={selectable ? (e) => onRowClick(path, i, rows, e.shiftKey) : undefined}
            className={cn(
              "flex border-l-2 border-transparent",
              r.kind === "add" && "bg-emerald-500/10",
              r.kind === "del" && "bg-rose-500/10",
              r.kind === "hunk" && "bg-sky-500/10 text-sky-300",
              r.kind === "meta" && "text-muted-foreground",
              selectable && "cursor-pointer hover:bg-muted/40",
              isSelected && "border-primary bg-primary/15",
            )}
          >
            <span className="w-10 shrink-0 select-none border-r border-border/40 px-1 text-right text-muted-foreground/60">
              {r.old ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-border/40 px-1 text-right text-muted-foreground/60">
              {r.neu ?? ""}
            </span>
            <span
              className={cn(
                "shrink-0 select-none px-1 text-center",
                r.kind === "add" && "text-emerald-400",
                r.kind === "del" && "text-rose-400",
              )}
            >
              {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
            </span>
            <span className="whitespace-pre px-1">{r.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
});
