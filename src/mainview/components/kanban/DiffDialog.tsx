import { useCallback, useEffect, useMemo, useState } from "react";
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
import { composeDiffMessage, groupSelectedRows, type DiffSelectionBlock } from "@/lib/diff-selection";
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

const SELECTABLE_KINDS = new Set<DiffRow["kind"]>(["ctx", "add", "del"]);

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

  // Gating data — same shape RunPanel uses to decide whether Send is safe.
  // Fetched lazily (below) once the composer first becomes visible, rather
  // than on every dialog open, since most diff views never select a line.
  const [runs, setRuns] = useState<Run[]>([]);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);

  useEffect(() => {
    // Reset selection + composer state on every dialog close/reopen and on
    // every diff refetch (this effect's deps mirror the fetch below).
    setSelected(new Map());
    setLastClicked(null);
    setDraft("");
    setHint(null);
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
  // sits in the same file (adding the contiguous selectable range), otherwise
  // it behaves like a plain click on the clicked row. `lastClicked` updates on
  // every selecting click (both branches).
  const handleRowClick = useCallback(
    (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => {
      const row = rows[index];
      if (!row || !SELECTABLE_KINDS.has(row.kind)) return;
      setSelected((prev) => {
        const next = new Map(prev);
        const current = new Set(next.get(path) ?? []);
        if (shiftKey && lastClicked && lastClicked.path === path) {
          const lo = Math.min(lastClicked.index, index);
          const hi = Math.max(lastClicked.index, index);
          for (let i = lo; i <= hi; i++) {
            const kind = rows[i]?.kind;
            if (kind && SELECTABLE_KINDS.has(kind)) current.add(i);
          }
        } else if (current.has(index)) {
          current.delete(index);
        } else {
          current.add(index);
        }
        if (current.size === 0) next.delete(path);
        else next.set(path, current);
        return next;
      });
      setLastClicked({ path, index });
    },
    [lastClicked],
  );

  const totalSelected = useMemo(() => {
    let n = 0;
    for (const set of selected.values()) n += set.size;
    return n;
  }, [selected]);
  const composerVisible = totalSelected > 0;

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
    setLastClicked(null);
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
              />
            ))}
          </div>
        )}
      </div>

      {composerVisible && (
        <div className="shrink-0 border-t border-border/60 p-3">
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
        </div>
      )}
    </Dialog>
  );
}

function FileBlock({
  file,
  open,
  onToggle,
  selectedIndices,
  onRowClick,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
  selectedIndices: Set<number> | undefined;
  onRowClick: (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => void;
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
            <DiffBody path={file.path} hunks={file.hunks} selectedIndices={selectedIndices} onRowClick={onRowClick} />
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

function DiffBody({
  path,
  hunks,
  selectedIndices,
  onRowClick,
}: {
  path: string;
  hunks: string;
  selectedIndices: Set<number> | undefined;
  onRowClick: (path: string, index: number, rows: DiffRow[], shiftKey: boolean) => void;
}) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  return (
    <div className="overflow-x-auto bg-card font-mono text-xs leading-relaxed">
      {rows.map((r, i) => {
        const selectable = SELECTABLE_KINDS.has(r.kind);
        const isSelected = selectable && (selectedIndices?.has(i) ?? false);
        return (
          <div
            key={i}
            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
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
}
