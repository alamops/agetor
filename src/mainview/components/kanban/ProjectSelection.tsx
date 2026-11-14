import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderOpen, Lock } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dedupeSelections, type RepoSelection } from "@/lib/repo-selection";

/**
 * The combined single/multi project selection that replaced the old split
 * between a single project trigger and a separate multi-repository dialog.
 * `repos` is the single source of truth for the selection *and* every
 * per-project base ref; `workdir` is derived from its first entry and there is
 * no separate selected-project state.
 *
 * Base refs are picked in the Select Projects dialog, one branch picker per
 * selected project, and only reach `repos` through the dialog's Save. The
 * dialog drops each picker's automatic "current branch" seed before saving
 * (`keepUserPickedRefs`), so every `baseRef` in `repos` is one the user chose.
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
  /** True while any selected project carries a base ref. Because only user
   *  picks are ever saved (see above), this is the issue dialog's "discard this
   *  draft?" signal for branch changes. */
  refDirty: boolean;
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

  const workdir = repos[0]?.path ?? "";
  const multiRepo = useMemo(() => dedupeSelections(repos).length > 1, [repos]);
  const refDirty = useMemo(() => repos.some((entry) => !!entry.baseRef?.trim()), [repos]);

  return { repos, setRepos, workdir, multiRepo, refDirty };
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
          : "Pick one or more projects and the branch each one starts from (with Pull and Fetch)."
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
