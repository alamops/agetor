import { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { api, type BranchInfo } from "@/lib/api";
import { SearchSelect } from "@/components/ui/search-select";

interface Props {
  /** Workdir whose branches to list. Empty = no project picked yet. */
  workdir: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
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
export function BranchPicker({ workdir, value, onChange, className, title, placement, disabled }: Props) {
  // Branches are tagged with the workdir they were fetched for. Without the
  // tag, switching projects would let the auto-select effect below see the
  // previous repo's `branches` array (state updates from `setBranches([])`
  // don't apply until the next render) and re-pick its "current" branch into
  // a freshly-cleared `value`.
  const [snap, setSnap] = useState<{ workdir: string; list: BranchInfo[] }>({ workdir: "", list: [] });
  const [error, setError] = useState<string | null>(null);
  const lastWorkdirRef = useRef(workdir);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Reset eagerly so the picker never shows the previous project's branches
    // while the new fetch is in flight.
    setSnap({ workdir, list: [] });
    // Workdir changed since last run — drop the previously selected ref so a
    // branch from the prior repo doesn't linger (and won't get rendered as a
    // "custom ref" entry against a repo that doesn't have it).
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
  }, [workdir]);

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
    <SearchSelect
      value={effective}
      onChange={(next) => onChange(next === HEAD_VALUE ? "" : next)}
      items={items}
      className={className}
      placement={placement}
      disabled={disabled}
      title={title ?? (error ? `Couldn't list branches: ${error}` : undefined)}
      placeholder="Search branches…"
      emptyLabel="HEAD"
      leadingIcon={<GitBranch className="size-3.5" />}
      displayValue={(v) => (v === HEAD_VALUE ? "HEAD" : v)}
    />
  );
}
