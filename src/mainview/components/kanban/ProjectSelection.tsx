import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderOpen, Lock } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  dedupeSelections,
  updateSelectionBaseRef,
  type RepoSelection,
} from "@/lib/repo-selection";

/**
 * The combined single/multi project selection that replaced the old split
 * between a single project trigger and a separate multi-repository dialog.
 * `repos` is the single source of truth for the selection *and* every
 * per-project base ref; `workdir` is derived from its first entry and there is
 * no separate selected-project state.
 */
export interface ProjectSelectionState {
  repos: RepoSelection[];
  setRepos: Dispatch<SetStateAction<RepoSelection[]>>;
  /** The first selected project (drives the branch-name preview, the `@`
   *  scope and `startingFolder`; empty when nothing is selected). */
  workdir: string;
  /** True when 2+ *deduped* projects are selected. Feeds the forced isolate
   *  state and the `@` multi-scope list — never the raw checkbox count. */
  multiRepo: boolean;
  /** A user-picked base ref for one project (marks the draft dirty). */
  setBaseRef: (path: string, baseRef: string) => void;
  /** `BranchPicker`'s "preselect the current branch" seed — not a user pick. */
  setBaseRefAuto: (path: string, baseRef: string) => void;
  /** True once the user picked any non-blank base ref that is still selected.
   *  The issue dialog's "discard this draft?" check reads this instead of a
   *  per-ref comparison, because a ref could be an automatic seed. */
  refDirty: boolean;
  /** Clears the user-pick markers (post-submit / fresh-open reset). */
  resetRefDirty: () => void;
}

/**
 * Owns the project selection. `autoSelect` keeps the historical behavior of
 * promoting the most recently added project when the form opens with nothing
 * selected (several e2e flows and returning users rely on it).
 * `enabled` lets a dialog that is mounted unconditionally skip the fetch until
 * it opens.
 */
export function useProjectSelection({
  autoSelect = false,
  enabled = true,
}: { autoSelect?: boolean; enabled?: boolean } = {}): ProjectSelectionState {
  const [repos, setRepos] = useState<RepoSelection[]>([]);
  // Paths the user picked a ref for themselves (as opposed to the picker's
  // automatic current-branch seed). Deriving `refDirty` from the live selection
  // means removing a project can never leave a stale dirty flag behind.
  const [userRefPaths, setUserRefPaths] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!autoSelect || !enabled) return;
    let cancelled = false;
    api.listProjects()
      .then((projects) => {
        if (cancelled || projects.length === 0) return;
        const path = projects[0]!.path;
        // One-shot: never fight a selection the user made while the list was
        // still in flight.
        setRepos((cur) => (cur.length === 0 ? [{ path, root: null }] : cur));
      })
      .catch(() => { /* no projects / backend not ready: the form shows its hint */ });
    return () => { cancelled = true; };
  }, [autoSelect, enabled]);

  const setBaseRef = (path: string, baseRef: string) => {
    setRepos((cur) => updateSelectionBaseRef(cur, path, baseRef));
    setUserRefPaths((cur) => {
      const next = new Set(cur);
      if (baseRef.trim()) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const setBaseRefAuto = (path: string, baseRef: string) => {
    setRepos((cur) => updateSelectionBaseRef(cur, path, baseRef));
  };

  const resetRefDirty = () => setUserRefPaths(new Set());

  // Drop user-pick markers for projects that are no longer selected. Without
  // this, removing a project (e.g. through the dialog's Save) and later adding
  // it back would resurrect the old marker and read as dirty even though the
  // re-added entry starts with a fresh automatic ref.
  useEffect(() => {
    setUserRefPaths((cur) => {
      if (cur.size === 0) return cur;
      const selected = new Set(repos.map((entry) => entry.path));
      const next = new Set([...cur].filter((path) => selected.has(path)));
      return next.size === cur.size ? cur : next;
    });
  }, [repos]);

  const workdir = repos[0]?.path ?? "";
  const multiRepo = useMemo(() => dedupeSelections(repos).length > 1, [repos]);
  const refDirty = useMemo(
    () => repos.some((entry) => userRefPaths.has(entry.path) && !!entry.baseRef?.trim()),
    [repos, userRefPaths],
  );

  return {
    repos,
    setRepos,
    workdir,
    multiRepo,
    setBaseRef,
    setBaseRefAuto,
    refDirty,
    resetRefDirty,
  };
}

interface ButtonProps {
  label: string;
  onClick: () => void;
  /** Locked variant (the PR-conflicts dialog): shows the fixed project and a
   *  lock, and is not clickable. */
  locked?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * The full-width Select Projects control that sits above the Isolate
 * checkbox. One button for both the single- and multi-project cases; its label
 * carries the selected count. In the locked variant it renders the fixed
 * project's name, disabled, with a lock icon.
 */
export function SelectProjectsButton({ label, onClick, locked = false, disabled = false, className }: ButtonProps) {
  return (
    <button
      type="button"
      data-testid="select-projects-button"
      onClick={onClick}
      disabled={disabled || locked}
      aria-haspopup={locked ? undefined : "dialog"}
      title={
        locked
          ? "The PR's repository is fixed for this task."
          : "Pick one or more projects. Each selected project gets its own branch, Pull and Fetch row."
      }
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5 text-left text-xs",
        "transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-background",
        className,
      )}
    >
      {locked
        ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        : <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!locked && <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />}
    </button>
  );
}
