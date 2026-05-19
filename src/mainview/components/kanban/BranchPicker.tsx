import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import { api, type BranchInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  const [createOpen, setCreateOpen] = useState(false);
  // Branches are tagged with the workdir they were fetched for. Without the
  // tag, switching projects would let the auto-select effect below see the
  // previous repo's `branches` array (state updates from `setBranches([])`
  // don't apply until the next render) and re-pick its "current" branch into
  // a freshly-cleared `value`.
  const [snap, setSnap] = useState<{ workdir: string; list: BranchInfo[] }>({ workdir: "", list: [] });
  const [error, setError] = useState<string | null>(null);
  const lastWorkdirRef = useRef(workdir);
  // Bumped to force a re-fetch (e.g. after creating a new branch). Keeping
  // this in state — not a ref — so the effect actually re-runs.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Workdir changed since last run — drop the previously selected ref AND
    // wipe the snap so a branch from the prior repo doesn't linger (and won't
    // get rendered as a "custom ref" entry against a repo that doesn't have
    // it). For reload-key bumps (e.g. after creating a branch), keep the
    // existing snap in place so an optimistic update isn't blown away
    // mid-flight — the fetch result will replace it below.
    const workdirChanged = lastWorkdirRef.current !== workdir;
    if (workdirChanged) {
      lastWorkdirRef.current = workdir;
      setSnap({ workdir, list: [] });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir, reloadKey]);

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

  // Only offer "Create new branch" when there's actually a repo to create
  // inside. With no workdir picked or no real branches yet (fresh `git init`,
  // pre-commit), git has nothing to branch off, so the footer would just
  // dead-end with an error.
  const canCreate = !!workdir && branches.length > 0;

  return (
    <>
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
        footer={canCreate ? (close) => (
          <button
            type="button"
            onClick={() => {
              close();
              setCreateOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            Create new branch…
          </button>
        ) : undefined}
      />
      <CreateBranchDialog
        open={createOpen}
        workdir={workdir}
        branches={branches}
        defaultFrom={value || branches.find((b) => b.current)?.name || ""}
        onClose={() => setCreateOpen(false)}
        onCreated={(name) => {
          setCreateOpen(false);
          // Optimistically prepend the new branch so the trigger doesn't flash
          // through the "custom ref" branch (and the create-footer doesn't
          // momentarily disappear) while the refetch is in flight. The
          // subsequent reload replaces this with the authoritative list.
          setSnap((s) =>
            s.workdir === workdir
              ? { workdir, list: [{ name, committedAt: Date.now(), current: false, remote: false }, ...s.list] }
              : s,
          );
          onChange(name);
          setReloadKey((k) => k + 1);
        }}
      />
    </>
  );
}

interface CreateBranchDialogProps {
  open: boolean;
  workdir: string;
  branches: BranchInfo[];
  defaultFrom: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}

/** New-branch sheet launched from the branch picker's footer. Creates the
 *  branch via `git branch <name> <from>` — no checkout, no working-tree
 *  touch on the source repo. */
function CreateBranchDialog({
  open,
  workdir,
  branches,
  defaultFrom,
  onClose,
  onCreated,
}: CreateBranchDialogProps) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset the form each time the dialog opens so a previous failed attempt
  // doesn't bleed into the next one. The source default is re-seeded from
  // whatever the parent currently has selected.
  useEffect(() => {
    if (!open) return;
    setName("");
    setFrom(defaultFrom);
    setError(null);
    setBusy(false);
  }, [open, defaultFrom]);

  const sourceItems = useMemo(
    () => branches.map((b) => ({
      value: b.name,
      label: b.name,
      hint: b.current ? "current" : (b.remote ? "remote" : undefined),
      pinned: b.current,
    })),
    [branches],
  );

  const trimmed = name.trim();
  const canSubmit = !!trimmed && !!from && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.createBranch({ path: workdir, name: trimmed, from });
      onCreated(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-md"
      labelledBy="create-branch-title"
      initialFocusRef={nameRef}
    >
      <div className="flex items-center gap-2 border-b border-border/60 pb-3">
        <GitBranch className="size-4 text-muted-foreground" />
        <h2 id="create-branch-title" className="text-base font-semibold">
          New branch
        </h2>
      </div>

      <div className="space-y-3 pt-4 text-xs">
        <div className="space-y-1">
          <label className="text-muted-foreground">Branch name</label>
          <Input
            ref={nameRef}
            placeholder="feature/my-branch"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="space-y-1">
          <label className="text-muted-foreground">Branch off</label>
          <SearchSelect
            value={from}
            onChange={setFrom}
            items={sourceItems}
            placement="bottom"
            placeholder="Search branches…"
            emptyLabel="Pick a source branch"
            leadingIcon={<GitBranch className="size-3.5" />}
          />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border/60 pt-3 mt-4">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? "Creating…" : "Create branch"}
        </Button>
      </div>
    </Dialog>
  );
}
