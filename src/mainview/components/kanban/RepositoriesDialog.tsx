import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, GitFork, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  dedupeSelections,
  selectionName,
  selectionNames,
  tooManyRepositories,
  type RepoSelection,
} from "@/lib/repo-selection";
import { createSessionGuard, describeRootConflict, mergeSelectionsByRoot, type RootConflict } from "@/lib/multi-repo-ui";
import { uniqueRepoSlugs } from "../../../shared/multi-repo.ts";
import type { Project } from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The current selection (paths). */
  value: RepoSelection[];
  /** Called with the deduped, ordered selection on Save. */
  onSave: (next: RepoSelection[]) => void;
  /** A path that must stay selected (the issue dialog's own repository). The
   *  row cannot be unchecked or removed; it is always re-added on save. */
  lockedPath?: string | null;
}

/**
 * Multi-repository selector (issue #291). One dialog shared by the New Task
 * form and the create-from-issue modal: pick two or more registered projects
 * (or add a folder), optionally pin a per-repository base ref, remove rows,
 * and dedupe by git root. Above {@link MANY_REPOSITORIES} it shows a
 * non-blocking warning (the owner decided against a hard cap). A `lockedPath`
 * (the issue's own repository) cannot be deselected — the issue dialog always
 * includes it, so letting the user uncheck it only meant pinPrimaryRepository
 * silently re-added it after save.
 *
 * A per-repository base ref is only offered for a genuinely multi selection
 * (two or more entries after git-root dedupe). A single-repository task keeps
 * the historical inline `WorktreeOptions` base ref, and the create payload
 * never carries `repositories[]` for it — offering a second, ignored base-ref
 * input here silently discarded whatever the user typed. The parent seeds the
 * first entry with that inline base ref (`seedRepositoriesDialogValue`), so it
 * shows in the first row's input as soon as a second repository is added, and
 * a selection saved back down to one entry hands that entry's base ref back
 * (`applyRepositoriesSave`).
 *
 * Save resolves git roots before it applies. Closing the dialog (Cancel,
 * Escape) while that lookup is in flight abandons it: the result is dropped,
 * never applied after the user walked away. Entries that collapse onto one
 * root keep the base ref set on any of them; two different base refs on one
 * root block the save with a message naming both.
 */
export function RepositoriesDialog({ open, onClose, value, onSave, lockedPath }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<RepoSelection[]>(value);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  // Base-ref conflicts found by the last save (two entries under one git root
  // pinned to different refs). Shown as an error; their inputs stay visible
  // so the user can settle them even when the set collapses to one root.
  const [conflicts, setConflicts] = useState<RootConflict[]>([]);
  // Invalidated on every open, close and save attempt. A save's root lookup
  // only applies while its own session is still current, so a Cancel/Escape
  // during the lookup (or a reopen) drops the stale result instead of
  // applying it.
  const sessionRef = useRef(createSessionGuard());

  useEffect(() => {
    sessionRef.current.invalidate();
    setBusy(false);
    setConflicts([]);
    if (!open) return;
    setDraft(value);
    void api.listProjects().then(setProjects).catch(() => setProjects([]));
    // Re-seed only when the dialog opens; edits inside must not be reset by
    // a parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const paths = useMemo(() => new Set(draft.map((e) => e.path)), [draft]);
  const names = useMemo(() => selectionNames(draft), [draft]);
  // Whether a per-repository base ref is meaningful for this draft. Two
  // entries under one git root collapse to a single-repository task on save
  // (`dedupeSelections`), so they must not offer a second base-ref control
  // either — the inline Branch picker owns that task's base ref.
  const dedupedCount = useMemo(() => dedupeSelections(draft).length, [draft]);
  const multiSelection = dedupedCount > 1;
  const conflictPaths = useMemo(
    () => new Set(conflicts.flatMap((c) => c.entries.map((e) => e.path))),
    [conflicts],
  );
  // Rows rendered below: every registered project, then any extra draft paths
  // (from "Add folder"), deduped by path. Test ids are derived from the whole
  // displayed list so two projects sharing a basename (`/a/api`, `/b/api`) get
  // distinct ids — `selectionName` alone gave both rows the same one.
  const displayPaths = useMemo(() => {
    const all = [
      ...projects.map((p) => p.path),
      ...draft.map((e) => e.path).filter((p) => !projects.some((x) => x.path === p)),
    ];
    return [...new Set(all)];
  }, [projects, draft]);
  const rowTestIds = useMemo(() => uniqueRepoSlugs(displayPaths), [displayPaths]);

  const close = () => {
    sessionRef.current.invalidate();
    setBusy(false);
    onClose();
  };

  const toggle = (path: string) => {
    if (path === lockedPath) return;
    setConflicts([]);
    setDraft((cur) =>
      cur.some((e) => e.path === path)
        ? cur.filter((e) => e.path !== path)
        : [...cur, { path, root: null }],
    );
  };

  const addFolder = async () => {
    setPicking(true);
    try {
      const picked = await api.pickProject();
      if (!picked.project) return;
      const path = picked.project.path;
      if (!paths.has(path)) setDraft((cur) => [...cur, { path, root: null }]);
      if (!projects.some((p) => p.path === path)) {
        setProjects((cur) => [picked.project!, ...cur]);
      }
    } catch {
      /* the native picker can be cancelled or fail; nothing to do */
    } finally {
      setPicking(false);
    }
  };

  const setBaseRef = (path: string, baseRef: string) => {
    setConflicts([]);
    setDraft((cur) => cur.map((e) => (e.path === path ? { ...e, baseRef } : e)));
  };

  const save = async () => {
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
        // Keep the dialog open on the resolved roots (so the "share a git
        // root" hint shows) and let the user pick which base ref wins.
        setDraft(resolved);
        setConflicts(merged.conflicts);
        return;
      }
      // A single kept entry still carries its base ref: the parent hands it
      // back to the inline Branch picker (`applyRepositoriesSave`) and stores
      // the entry without it, so it can't resurface from here later.
      onSave(merged.kept);
      onClose();
    } finally {
      if (sessionRef.current.isCurrent(session)) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} labelledBy="repositories-dialog-title" className="w-[32rem] max-w-[92vw]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="repositories-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitFork className="h-4 w-4" /> Repositories
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Each repository gets its own worktree and branch inside this task's workspace. Requires worktree isolation.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void addFolder()} disabled={picking}>
          {picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
          Add folder
        </Button>
      </div>

      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {projects.length === 0 && draft.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No projects yet — add a folder to begin.</p>
        ) : null}
        {displayPaths.map((path, i) => {
          const selected = paths.has(path);
          const idx = draft.findIndex((e) => e.path === path);
          const entry = idx >= 0 ? draft[idx]! : null;
          return (
            <div
              key={path}
              className="rounded-md border border-border/60 px-2 py-1.5"
              data-testid={`repositories-row-${rowTestIds[i]}`}
            >
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={path === lockedPath}
                  onChange={() => toggle(path)}
                  aria-label={`Select ${path}`}
                />
                <span className="truncate font-medium">{selectionName({ path })}</span>
                <span className="truncate text-muted-foreground">{path}</span>
                {entry ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{names[idx]}</span> : null}
              </label>
              {entry ? (
                <div className="mt-1 flex items-center gap-2 pl-6">
                  {multiSelection || conflictPaths.has(path) ? (
                    <Input
                      value={entry.baseRef ?? ""}
                      onChange={(e) => setBaseRef(path, e.target.value)}
                      placeholder="Base ref (default HEAD)"
                      className="h-7 text-xs"
                      aria-label={`Base ref for ${path}`}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                      Branches from the Branch field's base ref.
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Remove ${path}`}
                    disabled={path === lockedPath}
                    title={path === lockedPath ? "The issue's repository is always included" : undefined}
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
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert" data-testid="repositories-save-error">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {conflicts.map(describeRootConflict).join(" ")}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {draft.length} selected{draft.length !== dedupeSelections(draft).length ? " (some share a git root)" : ""}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || draft.length === 0}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
