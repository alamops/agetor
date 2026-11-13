import { useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, FolderPlus, GitBranch, Import, Loader2, Search, Trash2, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import {
  dedupeSelections,
  projectDisplayName,
  projectRowLabels,
  selectionNames,
  tooManyRepositories,
  type RepoSelection,
} from "@/lib/repo-selection";
import { createSessionGuard, describeRootConflict, mergeSelectionsByRoot, type RootConflict } from "@/lib/multi-repo-ui";
import { uniqueRepoSlugs } from "../../../shared/multi-repo.ts";
import type { Project } from "../../../shared/types.ts";
import { CloneProjectDialog } from "./CloneProjectDialog";
import { ImportSessionsDialog } from "./ImportSessionsDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The current selection (paths + already-resolved roots/refs). */
  value: RepoSelection[];
  /** Called with the deduped, ordered selection on Save. */
  onSave: (next: RepoSelection[]) => void;
  /** A path that must stay selected (the issue / PR dialog's own repository).
   *  The row cannot be unchecked or removed; it is always first. */
  lockedPath?: string | null;
}

/**
 * The combined project picker behind the full-width Select Projects button.
 * One dialog for one project and for many: pick at least one registered
 * project (or add a folder), search the list, and dedupe by git root on Save.
 *
 * This dialog owns **selection only**. Every selected project's base ref is
 * picked in the form's own inline `Branch · <project>` rows, which is why there
 * is no per-project ref input here and why the list can stay a scrolling box
 * (a `SearchSelect` branch popover would be clipped by it — see
 * `docs/architecture/multi-repo-tasks.md`).
 *
 * Save resolves each path's git root before applying: two subdirectories of one
 * repository collapse to the first selected path (the server's own dedupe), a
 * base ref set on a collapsed duplicate survives, and two different refs on one
 * root block the save with a message naming both. Unchecking and re-checking a
 * project within one dialog session restores its opening root and base ref, so
 * a round-trip through the list can't silently drop a pin.
 *
 * Closing (Cancel, Escape) while a root lookup is in flight abandons it — the
 * result is never applied after the user walked away. Outside clicks do not
 * close it (`closeOnBackdrop={false}`): the draft only changes through Save.
 */
export function SelectProjectsDialog({ open, onClose, value, onSave, lockedPath }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<RepoSelection[]>(value);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<RootConflict[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The entries this dialog opened with, so uncheck → recheck restores a root
  // and base ref instead of rebuilding a bare `{ path, root: null }`.
  const [opened, setOpened] = useState<RepoSelection[]>(value);
  // Invalidated on every open, close and save attempt. A save's root lookup
  // only applies while its own session is current.
  const sessionRef = useRef(createSessionGuard());

  const refreshProjects = async () => {
    try { setProjects(await api.listProjects()); }
    catch { /* leave the previous list; the dialog still shows the draft */ }
  };

  useEffect(() => {
    sessionRef.current.invalidate();
    setBusy(false);
    setConflicts([]);
    setQuery("");
    if (!open) return;
    const seed = value;
    setDraft(seed);
    setOpened(seed);
    api.listProjects().then(setProjects).catch(() => setProjects([]));
    // Re-seed only when the dialog opens; edits inside must not be reset by a
    // parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const paths = useMemo(() => new Set(draft.map((entry) => entry.path)), [draft]);
  const names = useMemo(() => selectionNames(draft), [draft]);
  const dedupedCount = useMemo(() => dedupeSelections(draft).length, [draft]);
  // Every row shown, in a stable order: registered projects, then draft extras
  // (from "Add folder"). Test ids are derived from the whole list so two
  // projects sharing a basename (`/a/api`, `/b/api`) stay distinguishable.
  const displayPaths = useMemo(() => {
    const all = [
      ...projects.map((project) => project.path),
      ...draft.map((entry) => entry.path).filter((path) => !projects.some((p) => p.path === path)),
    ];
    return [...new Set(all)];
  }, [projects, draft]);
  const labels = useMemo(() => projectRowLabels(displayPaths), [displayPaths]);
  const rowTestIds = useMemo(() => uniqueRepoSlugs(displayPaths), [displayPaths]);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.path, project.name])),
    [projects],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return displayPaths.map((path, i) => ({ path, label: labels[i]!, testId: rowTestIds[i]! }));
    return displayPaths
      .map((path, i) => ({ path, label: labels[i]!, testId: rowTestIds[i]! }))
      .filter((row) =>
        row.label.toLowerCase().includes(q)
        || row.path.toLowerCase().includes(q)
        // A project can be registered under a friendly name that differs from
        // its directory basename; users search for the name they gave it.
        || (projectNames.get(row.path) ?? "").toLowerCase().includes(q));
  }, [displayPaths, labels, rowTestIds, projectNames, query]);

  const close = () => {
    sessionRef.current.invalidate();
    setBusy(false);
    onClose();
  };

  const toggle = (path: string) => {
    if (path === lockedPath) return;
    setConflicts([]);
    setDraft((cur) => {
      if (cur.some((entry) => entry.path === path)) return cur.filter((entry) => entry.path !== path);
      const original = opened.find((entry) => entry.path === path);
      return [...cur, original ? { ...original } : { path, root: null }];
    });
  };

  const addFolder = async () => {
    setPicking(true);
    try {
      const picked = await api.pickProject();
      if (!picked.project) return;
      const path = picked.project.path;
      if (!paths.has(path)) setDraft((cur) => [...cur, { path, root: null }]);
      if (!projects.some((project) => project.path === path)) {
        setProjects((cur) => [picked.project!, ...cur]);
      }
    } catch {
      /* the native picker can be cancelled or fail; nothing to do */
    } finally {
      setPicking(false);
    }
  };

  const save = async () => {
    if (draft.length === 0) return;
    const session = sessionRef.current.begin();
    setBusy(true);
    setConflicts([]);
    try {
      // Resolve git roots so two paths under one repository collapse to the
      // first selected path. A failure leaves the root unknown (kept).
      const resolved = await Promise.all(
        draft.map(async (entry) => {
          if (entry.root) return entry;
          try {
            const { root } = await api.getProjectRepoRoot(entry.path);
            return { ...entry, root };
          } catch {
            return entry;
          }
        }),
      );
      // Cancelled, closed or reopened while the lookup ran: not ours to apply.
      if (!sessionRef.current.isCurrent(session)) return;
      const merged = mergeSelectionsByRoot(resolved);
      if (merged.conflicts.length > 0) {
        // Keep the dialog open on the resolved roots so the user can settle
        // the refs in the inline Branch rows and reopen.
        setDraft(resolved);
        setConflicts(merged.conflicts);
        return;
      }
      onSave(merged.kept);
      onClose();
    } finally {
      if (sessionRef.current.isCurrent(session)) setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        labelledBy="select-projects-dialog-title"
        closeOnBackdrop={false}
        className="w-[32rem] max-w-[92vw]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="select-projects-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
              <FolderGit2 className="h-4 w-4" /> Select projects
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Pick one or more projects. Each selected project gets its own branch row with Pull and Fetch;
              two or more use worktree isolation.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void addFolder()} disabled={picking}>
            {picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
            Add folder
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
          <Search className="size-3.5 shrink-0 opacity-60" aria-hidden />
          <Input
            data-testid="select-projects-search"
            {...IDENTIFIER_INPUT_PROPS}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="h-7 border-0 px-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto" data-testid="select-projects-list">
          {visible.length === 0 ? (
            query.trim() ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No matches.</p>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <p>No projects yet.</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void addFolder()}
                  disabled={picking}
                >
                  <FolderPlus className="h-3.5 w-3.5" /> Add folder
                </Button>
              </div>
            )
          ) : null}
          {visible.map(({ path, label, testId }) => {
            const selected = paths.has(path);
            const idx = draft.findIndex((entry) => entry.path === path);
            const lockedRow = path === lockedPath;
            return (
              <div
                key={path}
                className="rounded-md border border-border/60 px-2 py-1.5"
                data-testid={`select-projects-row-${testId}`}
              >
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={lockedRow}
                    onChange={() => toggle(path)}
                    aria-label={`Select ${path}`}
                  />
                  <span className="min-w-0 shrink-0 truncate font-medium">{label}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{path}</span>
                  {selected ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{names[idx]}</span>
                  ) : null}
                </label>
                {selected ? (
                  <div className="mt-1 flex items-center justify-between gap-2 pl-6">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                      {projectDisplayName(path)} — branch, Pull and Fetch are set in the form.
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Remove ${path}`}
                      disabled={lockedRow}
                      title={lockedRow ? "The issue's repository is always included" : undefined}
                      onClick={() => toggle(path)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {tooManyRepositories(dedupedCount) ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="h-3.5 w-3.5" />
            {dedupedCount} repositories — preparation may be slow. There is no hard limit.
          </p>
        ) : null}

        {conflicts.length > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive" role="alert" data-testid="select-projects-save-error">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {conflicts.map(describeRootConflict).join(" ")}
          </p>
        ) : null}

        {draft.length === 0 ? (
          <p className="mt-2 text-xs text-warning">Select at least one project.</p>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {draft.length} selected
            {draft.length !== dedupeSelections(draft).length ? " (some share a git root)" : ""}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="project-clone-open"
              onClick={() => setCloneOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <GitBranch className="size-3.5" aria-hidden />
              Clone repository…
            </button>
            <button
              type="button"
              data-testid="project-import-sessions-open"
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Import className="size-3.5" aria-hidden />
              Import sessions…
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || draft.length === 0}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </Dialog>
      {/* Mounted as siblings of the dialog (not in its scrolling body): the
          nested dialog takes focus, and a footer inside the panel would be
          unmounted mid-flow on some browsers. */}
      <CloneProjectDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onCloned={() => { void refreshProjects(); }}
      />
      <ImportSessionsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void refreshProjects(); }}
      />
    </>
  );
}
