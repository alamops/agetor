import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, FolderGit2, Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { abbreviateHome } from "@/lib/utils";
import {
  COLUMNS,
  type ColumnId,
  type Project,
  type Task,
  type WorktreeGitStatus,
  type WorktreeInfo,
  type WorktreeStaleReason,
} from "../../../shared/types.ts";
import { buildDeleteConfirmCopy, triageDeleteOutcome } from "./worktree-delete-intent.ts";

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

/** On-demand `getWorktreeGitStatus` calls are subprocess-backed on the bun
 *  side, so the auto-fetch pool caps fan-out rather than firing one request
 *  per row simultaneously. */
const GIT_STATUS_CONCURRENCY = 5;

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
  // Live per-worktree dirty/ahead/merged, fetched on open + Refresh (not the
  // 5s poll — see fetchGitStatuses). "loading" is a sentinel, not the
  // WorktreeGitStatus shape itself.
  const [gitStatus, setGitStatus] = useState<Map<string, WorktreeGitStatus | "loading">>(new Map());
  // Bumped on every fetch pass so a superseding Refresh (or the dialog
  // closing) makes in-flight results from an older pass a no-op.
  const gitStatusRunRef = useRef(0);

  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [staleFilter, setStaleFilter] = useState<StaleFilter>("all");
  const [sortField, setSortField] = useState<SortField>("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Bounded-concurrency pool: fetches live git status for every row in
  // `list`, capped at GIT_STATUS_CONCURRENCY in flight. Marks all ids
  // "loading" up front so the spinner shows immediately, then fills in each
  // result (or drops the id on error — no badge, no toast spam) as it
  // resolves. `runId` lets a superseding pass (a fresh Refresh, or the
  // dialog closing) discard stale results instead of racing the map.
  const fetchGitStatuses = useCallback((list: WorktreeInfo[]) => {
    const runId = ++gitStatusRunRef.current;
    setGitStatus((cur) => {
      const next = new Map(cur);
      for (const w of list) next.set(w.id, "loading");
      return next;
    });
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        const w = list[idx];
        if (!w) return;
        try {
          const status = await api.getWorktreeGitStatus(w.id);
          if (gitStatusRunRef.current !== runId) return;
          setGitStatus((cur) => new Map(cur).set(w.id, status));
        } catch {
          if (gitStatusRunRef.current !== runId) return;
          setGitStatus((cur) => {
            const next = new Map(cur);
            next.delete(w.id);
            return next;
          });
        }
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(GIT_STATUS_CONCURRENCY, list.length) }, worker),
    );
  }, []);

  const refresh = useCallback(async (manual = false, fetchGit = false) => {
    if (manual) setRefreshing(true);
    try {
      const list = await api.listWorktrees();
      setWorktrees(list);
      setError(null);
      if (fetchGit) fetchGitStatuses(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [fetchGitStatuses]);

  // Fetch on open + poll every 5s while open; cleared on close/unmount.
  // Git status is auto-fetched on the initial open load and on manual
  // Refresh only — not on every 5s poll tick, to avoid a git subprocess
  // fan-out in the background while the dialog just sits open.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void refresh(false, true).finally(() => setLoading(false));
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Discard any in-flight git-status pass and drop stale badges when the
  // dialog closes (or unmounts) — reopening re-fetches fresh regardless.
  useEffect(() => {
    if (open) return;
    gitStatusRunRef.current++;
    setGitStatus(new Map());
  }, [open]);

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
    // Busy spans fetch → confirm → archive as one continuous stretch so the
    // trash icon spins the whole time (rather than appearing frozen during
    // the status fetch) and a second click can never double-fire while the
    // confirm dialog is up or the archive request is in flight.
    await withBusy(w.id, async () => {
      // The cached `gitStatus` map is only populated on open + manual
      // Refresh — by the time the user clicks delete it's frequently
      // "loading" or missing entirely, which would undersell what's about
      // to be discarded. Fetch fresh; a failed check falls back to the
      // no-warning copy rather than blocking the delete.
      let status: WorktreeGitStatus | null = null;
      try {
        status = await api.getWorktreeGitStatus(w.id);
      } catch {
        status = null;
      }
      const copy = buildDeleteConfirmCopy(w, status);
      const ok = await confirm({
        title: copy.title,
        description: (
          <>
            {copy.alreadyArchived ? (
              <>
                The ticket "<span className="font-medium text-foreground/80">{w.taskTitle}</span>" is
                already <strong>archived</strong>; its worktree directory will be removed. The git
                branch and full AI history are preserved.
              </>
            ) : (
              <>
                The ticket "<span className="font-medium text-foreground/80">{w.taskTitle}</span>" will
                be <strong>archived</strong> (hidden from the board, restorable via Unarchive) and its
                worktree directory removed. The git branch and full AI history are preserved.
              </>
            )}
            {copy.showDirtyWarning && (
              <div className="mt-2 font-medium text-danger">
                This worktree has uncommitted changes — they will be permanently discarded.
              </div>
            )}
            {copy.unknown && (
              <div className="mt-2 font-medium text-danger">
                agetor couldn't check this worktree for uncommitted changes — its git
                registration may be broken. Anything uncommitted will be permanently
                discarded.
              </div>
            )}
            {w.runActive && " An agent is still working on this task — archiving will stop it."}
          </>
        ),
        confirmLabel: copy.confirmLabel,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        const result = await api.archiveTask(taskId, {
          force: true,
          stopRun: true,
          forceWorktree: true,
          awaitTeardown: true,
        });
        const outcome = triageDeleteOutcome(result.teardown, w.branch);
        // Silent on success — the house convention for destructive list
        // mutations (SettingsDialog.tsx) is that the row vanishing from the
        // refreshed list IS the feedback. Only a genuine failure toasts.
        if (outcome.kind === "error") toast.error(outcome.message);
        await refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        await refresh();
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
            onClick={() => { void refresh(true, true); }}
          >
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" title="Close" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
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
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-danger">
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
              const status = gitStatus.get(w.id);
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
                      {w.runActive && <span className="text-success">running</span>}
                      {status === "loading" && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Loading git status" />
                      )}
                      {status && status !== "loading" && !status.ignored && (
                        <>
                          {status.dirty && (
                            <span className="text-warning" title="Has uncommitted changes">
                              uncommitted
                            </span>
                          )}
                          {status.ahead > 0 && (
                            <span
                              className="inline-flex items-center gap-0.5"
                              title={`${status.ahead} commit${status.ahead === 1 ? "" : "s"} ahead`}
                            >
                              <ArrowUp className="size-3" />
                              {status.ahead}
                            </span>
                          )}
                          {status.merged === true && (
                            <span
                              className="text-success"
                              title={
                                status.dirty
                                  ? "Merged into the default branch — committed work is safe to delete, but uncommitted changes would be lost"
                                  : "Already merged into the default branch — safe to delete"
                              }
                            >
                              merged
                            </span>
                          )}
                        </>
                      )}
                      {w.stale && (
                        <span className="text-muted-foreground">
                          {w.staleReasons.map((r) => STALE_REASON_LABEL[r]).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    title={
                      w.runActive
                        ? (w.taskId ? "Stop the running agent and delete worktree" : "Stop the run first")
                        : "Delete worktree"
                    }
                    aria-label="Delete worktree"
                    disabled={(w.runActive && !w.taskId) || busy}
                    onClick={() => { void (w.taskId ? deleteTaskBacked(w) : deleteOrphan(w)); }}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4 text-destructive" />
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
