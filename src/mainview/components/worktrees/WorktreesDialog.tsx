import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, FolderGit2, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { abbreviateHome, cn } from "@/lib/utils";
import {
  COLUMNS,
  type ColumnId,
  type Project,
  type Task,
  type WorktreeInfo,
  type WorktreeStaleReason,
} from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  projects: Project[];
  onOpenTask: (task: Task) => void;
  /** For abbreviating absolute paths as "~/…" in the row subtitles — mirrors
   *  every other path-displaying surface (TaskCard, RunPanel, SettingsDialog). */
  homeDir: string;
}

const POLL_MS = 5_000;

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

const STALE_REASON_LABEL: Record<WorktreeStaleReason, string> = {
  orphaned: "orphaned",
  archived: "archived, not cleaned up",
  inactive: "inactive > 7 days",
};

/** "5m ago" / "3h ago" / "2d ago" — coarse relative age for the Updated
 *  column. No existing relative-time helper covers a raw ms epoch (the one
 *  in GitHubDialog.tsx takes an ISO date string for GitHub API payloads), so
 *  this is a small local formatter per the plan brief. */
function formatAge(ms: number | null): string {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** `Project.name || basename(p.path)` chain (KanbanFilters.tsx:58-62),
 *  extended with the orphan/unowned fallbacks the plan calls for. */
function resolveProjectLabel(workdir: string | null, projects: Project[]): string {
  if (!workdir) return "—";
  const p = projects.find((pr) => pr.path === workdir);
  if (p) return p.name || basename(p.path) || p.path;
  return basename(workdir) || "—";
}

/** Filter/sort value for a row's status — distinct from its display label so
 *  "Archived" can be filtered/sorted independently of the underlying column. */
function statusValue(w: WorktreeInfo): string {
  if (w.archivedAt != null) return "archived";
  return w.column ?? "";
}

function statusLabel(w: WorktreeInfo): string {
  if (w.column == null) return "";
  return COLUMNS.find((c) => c.id === w.column)?.label ?? w.column;
}

type SortField = "updated" | "project" | "status" | "branch";
type StaleFilter = "all" | "stale" | "fresh";

export function WorktreesDialog({ open, onClose, tasks, projects, onOpenTask, homeDir }: Props) {
  const confirm = useConfirm();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [staleFilter, setStaleFilter] = useState<StaleFilter>("all");
  const [sortField, setSortField] = useState<SortField>("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const list = await api.listWorktrees();
      setWorktrees(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  // Fetch on open + poll every 5s while open; cleared on close/unmount.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Reset filters each time the dialog is reopened — a stale filter carried
  // across sessions would silently hide rows the user doesn't expect.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setProjectFilter([]);
    setStatusFilter([]);
    setStaleFilter("all");
    setSortField("updated");
    setSortDir("desc");
  }, [open]);

  const projectValue = useCallback((w: WorktreeInfo) => w.workdir ?? "__none__", []);
  const projectLabel = useCallback((w: WorktreeInfo) => resolveProjectLabel(w.workdir, projects), [projects]);

  const projectItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const w of worktrees) {
      const v = projectValue(w);
      if (!seen.has(v)) seen.set(v, projectLabel(w));
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
  }, [worktrees, projectValue, projectLabel]);

  const statusItems = useMemo(
    () => [...COLUMNS.map((c) => ({ value: c.id as string, label: c.label })), { value: "archived", label: "Archived" }],
    [],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return worktrees.filter((w) => {
      if (q) {
        const hay = `${w.taskTitle ?? ""}\n${w.branch ?? ""}\n${projectLabel(w)}\n${w.path}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (projectFilter.length > 0 && !projectFilter.includes(projectValue(w))) return false;
      if (statusFilter.length > 0 && !statusFilter.includes(statusValue(w))) return false;
      if (staleFilter === "stale" && !w.stale) return false;
      if (staleFilter === "fresh" && w.stale) return false;
      return true;
    });
  }, [worktrees, query, projectFilter, statusFilter, staleFilter, projectLabel, projectValue]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortField) {
        case "updated":
          return ((a.taskUpdatedAt ?? 0) - (b.taskUpdatedAt ?? 0)) * dir;
        case "project":
          return projectLabel(a).localeCompare(projectLabel(b)) * dir;
        case "status":
          return statusLabel(a).localeCompare(statusLabel(b)) * dir;
        case "branch":
          return (a.branch ?? "").localeCompare(b.branch ?? "") * dir;
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sortField, sortDir, projectLabel]);

  const anyFilterActive =
    query !== "" || projectFilter.length > 0 || statusFilter.length > 0 || staleFilter !== "all";

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((cur) => new Set(cur).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  const deleteTaskBacked = async (w: WorktreeInfo) => {
    if (!w.taskId) return;
    const taskId = w.taskId;
    const ok = await confirm({
      title: `Delete worktree "${w.branch ?? w.id}"?`,
      description: (
        <>
          The ticket "<span className="font-medium text-foreground/80">{w.taskTitle}</span>" will be{" "}
          <strong>archived</strong> (hidden from the board, restorable via Unarchive) and its worktree
          directory removed. The git branch and full AI history are preserved. If the worktree has
          uncommitted changes, it is left in place to protect your work.
        </>
      ),
      confirmLabel: "Archive & delete",
      variant: "destructive",
    });
    if (!ok) return;
    await withBusy(w.id, async () => {
      try {
        await api.archiveTask(taskId, { force: true });
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const deleteOrphan = async (w: WorktreeInfo) => {
    const ok = await confirm({
      title: "Delete orphaned worktree?",
      description: "No ticket owns this directory; it will be permanently removed.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    await withBusy(w.id, async () => {
      try {
        await api.deleteWorktree(w.id);
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="worktrees-dialog-title"
      className="flex max-h-[86vh] w-full max-w-6xl flex-col p-0"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="worktrees-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            Worktrees
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {worktrees.length === sorted.length
              ? `${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"}`
              : `${sorted.length} of ${worktrees.length} worktrees`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            title="Refresh"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={() => { void refresh(true); }}
          >
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, branch, project, path…"
            className="pl-8"
          />
        </div>
        <MultiSearchSelect
          values={projectFilter}
          onChange={setProjectFilter}
          items={projectItems}
          emptyLabel="All projects"
          placeholder="Search projects…"
          className="w-48"
        />
        <MultiSearchSelect
          values={statusFilter}
          onChange={setStatusFilter}
          items={statusItems}
          emptyLabel="All statuses"
          placeholder="Search statuses…"
          className="w-44"
        />
        <Select
          value={staleFilter}
          onChange={(e) => setStaleFilter(e.target.value as StaleFilter)}
          className="w-36"
          title="Filter by staleness"
        >
          <option value="all">All</option>
          <option value="stale">Stale only</option>
          <option value="fresh">Fresh only</option>
        </Select>
        <Select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="w-32"
          title="Sort field"
        >
          <option value="updated">Updated</option>
          <option value="project">Project</option>
          <option value="status">Status</option>
          <option value="branch">Branch</option>
        </Select>
        <Button
          size="icon"
          variant="outline"
          title={sortDir === "asc" ? "Ascending" : "Descending"}
          aria-label="Toggle sort direction"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
        >
          {sortDir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
        </Button>
        {anyFilterActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setProjectFilter([]);
              setStatusFilter([]);
              setStaleFilter("all");
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-rose-400">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}

        {loading && worktrees.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading worktrees…
          </div>
        )}

        {!loading && !error && worktrees.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <FolderGit2 className="size-6 opacity-40" />
            No worktrees on disk.
          </div>
        )}

        {!loading && !error && worktrees.length > 0 && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <FolderGit2 className="size-6 opacity-40" />
            No worktrees match these filters.
          </div>
        )}

        {sorted.length > 0 && (
          <div className="flex flex-col gap-2">
            {sorted.map((w) => {
              const task = w.taskId ? tasks.find((t) => t.id === w.taskId) : undefined;
              const busy = busyIds.has(w.id);
              return (
                <div key={w.id} className="flex items-start gap-3 rounded-md border border-border/60 bg-card p-3">
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {task ? (
                        <button
                          type="button"
                          className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                          onClick={() => onOpenTask(task)}
                          title="Open task"
                        >
                          {task.title}
                        </button>
                      ) : w.taskId ? (
                        <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                          {w.taskTitle}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">no ticket</span>
                      )}
                      {w.column != null && (
                        <Badge variant="outline">{statusLabel(w)}</Badge>
                      )}
                      {w.archivedAt != null && <Badge variant="secondary">Archived</Badge>}
                      {w.stale && (
                        <Badge
                          variant="destructive"
                          title={w.staleReasons.map((r) => STALE_REASON_LABEL[r]).join(", ")}
                        >
                          Stale
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{w.branch ?? "—"}</span>
                      <span>{projectLabel(w)}</span>
                      <span className="min-w-0 truncate" title={w.path}>{abbreviateHome(w.path, homeDir)}</span>
                      <span>updated {formatAge(w.taskUpdatedAt)}</span>
                      {w.runActive && <span className="text-emerald-400">running</span>}
                      {w.stale && (
                        <span className="text-rose-400/80">
                          {w.staleReasons.map((r) => STALE_REASON_LABEL[r]).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    title={w.runActive ? "Stop the run first" : "Delete worktree"}
                    aria-label="Delete worktree"
                    disabled={w.runActive || busy}
                    onClick={() => { void (w.taskId ? deleteTaskBacked(w) : deleteOrphan(w)); }}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className={cn("size-4", !w.runActive && "text-destructive")} />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
