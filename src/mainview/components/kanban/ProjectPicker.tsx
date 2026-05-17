import { useEffect, useState } from "react";
import { Folder, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { SearchSelect } from "@/components/ui/search-select";
import type { Project } from "../../../shared/types.ts";

interface Props {
  value: string;
  onChange: (path: string) => void;
  className?: string;
  disabled?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  /** Optional placeholder shown when value is empty. */
  emptyLabel?: string;
  placement?: "top" | "bottom";
  /**
   * If true and `value` is empty when projects load, automatically fire
   * `onChange` with the most-recently-used project (top of the list). Used by
   * the new-task form so a returning user lands on their previous project
   * without re-introducing the auto-OS-default behaviour.
   */
  autoSelectFirst?: boolean;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/**
 * Workdir picker: choose from previously-used projects or open the native
 * folder dialog to register a new one. The dialog is opened by the Bun side
 * (Electrobun's `Utils.openFileDialog`) — see `/projects/pick` in the API.
 */
export function ProjectPicker({
  value,
  onChange,
  className,
  disabled,
  title,
  emptyLabel,
  placement,
  autoSelectFirst,
}: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [picking, setPicking] = useState(false);

  const refresh = async () => {
    try { setProjects(await api.listProjects()); }
    catch { /* leave previous state */ }
  };

  useEffect(() => { void refresh(); }, []);

  // One-shot: when projects first arrive and the parent has no value yet,
  // promote the most-recently-used one. `projects.list()` is sorted by
  // `added_at DESC`, so projects[0] is always the last project the user
  // touched. Guarded by `value` so editing flows that explicitly want an
  // empty initial value (none exist today, but defensive) aren't overridden,
  // and so we don't fight the user after they clear the selection.
  useEffect(() => {
    if (!autoSelectFirst) return;
    if (value) return;
    if (projects.length === 0) return;
    onChange(projects[0]!.path);
    // We intentionally don't depend on `onChange` — callers don't memoize it
    // and we only want this to fire on the projects-arrival / cleared-value
    // edges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, value, autoSelectFirst]);

  const items = projects.map((p) => ({
    value: p.path,
    label: p.name || basename(p.path) || p.path,
    hint: p.path,
  }));

  // Ensure the currently-selected value renders an entry in the list even if
  // it hasn't been persisted yet (e.g. legacy task with a workdir that was
  // never auto-upserted as a project).
  if (value && !items.some((i) => i.value === value)) {
    items.unshift({ value, label: basename(value) || value, hint: value });
  }

  const onBrowse = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const { project } = await api.pickProject(value || undefined);
      if (project) {
        await refresh();
        onChange(project.path);
      }
    } catch { /* surface elsewhere — the picker just no-ops on failure */ }
    finally { setPicking(false); }
  };

  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      items={items}
      className={className}
      disabled={disabled}
      title={title}
      placement={placement}
      placeholder="Search projects…"
      emptyLabel={emptyLabel ?? "Select project…"}
      leadingIcon={<Folder className="size-3.5" />}
      displayValue={(v) => basename(v) || v}
      footer={
        <button
          type="button"
          onClick={onBrowse}
          disabled={picking}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/60 disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden />
          {picking ? "Opening folder dialog…" : "Browse for folder…"}
        </button>
      }
    />
  );
}
