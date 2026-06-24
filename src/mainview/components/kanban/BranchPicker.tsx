import { useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { api, type BranchInfo } from "@/lib/api";
import { SearchSelect } from "@/components/ui/search-select";
import { cn } from "@/lib/utils";

interface Props {
  /** Workdir whose branches to list. Empty = no project picked yet. */
  workdir: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
  /**
   * Field label rendered above the picker. Sharing the label row with the
   * Git Fetch button keeps the picker trigger itself full-width, so long
   * branch names aren't clipped inside the narrow new-task sidebar.
   */
  label?: string;
  /** Tooltip on the trigger. */
  title?: string;
  placement?: "top" | "bottom";
  disabled?: boolean;
}

const HEAD_VALUE = "__HEAD__";

const formatAge = (ms: number): string => {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
};

/**
 * Base-ref picker: lists local branches of the selected project sorted by
 * most-recent commit. The current branch is pinned at the top. The explicit
 * "HEAD" row only shows up when the workdir has no real branches yet (fresh
 * `git init`) — once any branches exist, picking the current branch row
 * covers the "use what's checked out" intent without the extra entry. Empty
 * value still means "use HEAD" downstream so the picker can sit unselected.
 */
export function BranchPicker({ workdir, value, onChange, className, label, title, placement, disabled }: Props) {
  // Branches are tagged with the workdir they were fetched for. Without the
  // tag, switching projects would let the auto-select effect below see the
  // previous repo's `branches` array (state updates from `setBranches([])`
  // don't apply until the next render) and re-pick its "current" branch into
  // a freshly-cleared `value`.
  const [snap, setSnap] = useState<{ workdir: string; list: BranchInfo[] }>({ workdir: "", list: [] });
  // Listing failure (git for-each-ref / API). Kept separate from `fetchError`
  // so the picker tooltip never mislabels a `git fetch` failure as "couldn't
  // list branches".
  const [error, setError] = useState<string | null>(null);
  // `git fetch` failure, surfaced on the Fetch button only.
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Bumped by the Git Fetch button to re-run the listing effect after a
  // `git fetch` lands new remote branches, without touching `workdir`.
  const [refreshKey, setRefreshKey] = useState(0);
  const [fetching, setFetching] = useState(false);
  const lastWorkdirRef = useRef(workdir);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // A workdir/refresh change abandons any in-flight fetch's UI: clear its
    // spinner and error so they don't linger against the new project (the
    // fetch promise itself is also guarded below).
    setFetching(false);
    setFetchError(null);
    // Reset eagerly so the picker never shows the previous project's branches
    // while the new fetch is in flight.
    setSnap({ workdir, list: [] });
    // Workdir changed since last run — drop the previously selected ref so a
    // branch from the prior repo doesn't linger (and won't get rendered as a
    // "custom ref" entry against a repo that doesn't have it). Guarded so a
    // manual refresh (same workdir, bumped refreshKey) leaves the selection be.
    if (lastWorkdirRef.current !== workdir) {
      lastWorkdirRef.current = workdir;
      if (value) onChange("");
    }
    if (!workdir) return;
    (async () => {
      try {
        const list = await api.listBranches(workdir);
        if (!cancelled) setSnap({ workdir, list });
      } catch (e) {
        if (!cancelled) {
          setSnap({ workdir, list: [] });
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [workdir, refreshKey]);

  // Pull all remotes, then re-list branches so freshly pushed `origin/*`
  // branches appear in the picker. Network-bound, so the trigger spins while
  // it runs; failures surface on the Fetch button via `fetchError`. The fetch
  // is tagged with the workdir it started against so a project switch mid-fetch
  // can't apply a stale result/spinner/error to the new project.
  const handleFetch = async () => {
    if (!workdir || fetching) return;
    const dir = workdir;
    setFetching(true);
    setFetchError(null);
    try {
      await api.gitFetch(dir);
      if (dir === lastWorkdirRef.current) setRefreshKey((k) => k + 1);
    } catch (e) {
      if (dir === lastWorkdirRef.current) setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (dir === lastWorkdirRef.current) setFetching(false);
    }
  };

  // Only trust `branches` when its workdir matches the current one; otherwise
  // the data is stale from the prior project and would mislead both the
  // dropdown and the auto-select effect below.
  const branches = snap.workdir === workdir ? snap.list : [];

  // When branches arrive and no explicit value is set, pre-select the current
  // branch so the trigger doesn't show a misleading "HEAD" while a real ref is
  // already checked out. Guarded by `value` so we don't fight the user after
  // they pick something else.
  useEffect(() => {
    if (value) return;
    const current = branches.find((b) => b.current);
    if (current) onChange(current.name);
    // Intentionally not depending on onChange to avoid loops when the parent
    // doesn't memoize it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, value]);

  // Drop the synthetic "HEAD" row when there's at least one real branch — the
  // current-branch row already represents "what's checked out". On an empty
  // repo (no branches yet) we keep HEAD so the picker isn't blank.
  const items: { value: string; label: string; hint: string; pinned: boolean }[] = [];
  if (branches.length === 0) {
    items.push({
      value: HEAD_VALUE,
      label: "HEAD",
      hint: "Use the workdir's current HEAD when the task starts.",
      pinned: true,
    });
  }
  for (const b of branches) {
    items.push({
      value: b.name,
      label: b.name,
      hint: b.current ? `current · ${formatAge(b.committedAt)}` : formatAge(b.committedAt),
      pinned: b.current,
    });
  }

  // Treat empty string as HEAD so the trigger always shows something concrete.
  const effective = value || HEAD_VALUE;
  const displayedItem = items.find((i) => i.value === effective);
  if (!displayedItem && value) {
    // Custom value the user typed (e.g. a sha) — render an entry so the
    // trigger label matches what will actually be sent.
    items.push({ value, label: value, hint: "custom ref", pinned: false });
  }

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      {/* Label + Git Fetch share one row so the picker below stays full-width.
          The button sits flush-right (ml-auto) even when no label is given. */}
      <div className="flex items-center gap-2">
        {label && <label className="text-muted-foreground">{label}</label>}
        <button
          type="button"
          onClick={handleFetch}
          disabled={disabled || !workdir || fetching}
          title={
            fetchError
              ? `Git fetch failed: ${fetchError}`
              : "Fetch all branches from remote (git fetch --all --prune)"
          }
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            (disabled || !workdir || fetching) && "cursor-not-allowed opacity-50",
          )}
        >
          <RefreshCw className={cn("size-3", fetching && "animate-spin")} aria-hidden />
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>
      <SearchSelect
        value={effective}
        onChange={(next) => onChange(next === HEAD_VALUE ? "" : next)}
        items={items}
        className="w-full"
        placement={placement}
        disabled={disabled}
        title={title ?? (error ? `Couldn't list branches: ${error}` : undefined)}
        placeholder="Search branches…"
        emptyLabel="HEAD"
        leadingIcon={<GitBranch className="size-3.5" />}
        displayValue={(v) => (v === HEAD_VALUE ? "HEAD" : v)}
      />
    </div>
  );
}
