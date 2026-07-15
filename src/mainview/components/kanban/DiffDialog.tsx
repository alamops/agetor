import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus,
  FileSymlink, GitCompare, Loader2,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toRows } from "@/lib/diff-rows";
import type { DiffFile, Task, TaskDiff } from "../../../shared/types.ts";

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
 * Read-only viewer for everything a task's worktree changed vs its pinned base
 * ref. Fetches on open, renders a per-file collapsible unified diff. When the
 * task has no worktree (or nothing changed) the server returns a friendly
 * `note` which we show in place of the file list.
 */
export function DiffDialog({ open, task, onClose }: Props) {
  const taskId = task?.id ?? null;
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
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
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function FileBlock({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
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
            <DiffBody hunks={file.hunks} />
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

function DiffBody({ hunks }: { hunks: string }) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  return (
    <div className="overflow-x-auto bg-card font-mono text-xs leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            "flex",
            r.kind === "add" && "bg-emerald-500/10",
            r.kind === "del" && "bg-rose-500/10",
            r.kind === "hunk" && "bg-sky-500/10 text-sky-300",
            r.kind === "meta" && "text-muted-foreground",
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
      ))}
    </div>
  );
}
