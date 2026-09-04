import { Cpu, Folder, Search, Shapes, Tag } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { COLUMNS, TASK_TYPES, type ColumnId, type Harness, type Project, type TaskType } from "../../../shared/types.ts";

export type ArchivedView = "active" | "all" | "archived";

interface Props {
  textQuery: string;
  onTextQueryChange: (v: string) => void;
  repoFilter: string[];
  onRepoFilterChange: (v: string[]) => void;
  statusFilter: ColumnId[];
  onStatusFilterChange: (v: ColumnId[]) => void;
  archivedView: ArchivedView;
  onArchivedViewChange: (v: ArchivedView) => void;
  harnessFilter: string[];
  onHarnessFilterChange: (v: string[]) => void;
  typeFilter: TaskType[];
  onTypeFilterChange: (v: TaskType[]) => void;
  projects: Project[];
  harnesses: Harness[];
  /** Distinct harness ids referenced by any current task. Used to surface
   *  orphan ids (referenced by tasks but no longer registered) as filter
   *  options, so users can still narrow to historical runs of a removed
   *  harness. */
  taskAgentIds: string[];
  /** Attaches directly to the free-text search `<Input>` — App.tsx's
   *  Cmd/Ctrl+F handler focuses (and selects) the box through it when no
   *  task details panel is open. */
  searchInputRef?: React.Ref<HTMLInputElement>;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

export function KanbanFilters({
  textQuery,
  onTextQueryChange,
  repoFilter,
  onRepoFilterChange,
  statusFilter,
  onStatusFilterChange,
  archivedView,
  onArchivedViewChange,
  harnessFilter,
  onHarnessFilterChange,
  typeFilter,
  onTypeFilterChange,
  projects,
  harnesses,
  taskAgentIds,
  searchInputRef,
}: Props) {
  const repoItems = projects.map((p) => ({
    value: p.path,
    label: p.name || basename(p.path) || p.path,
    hint: p.path,
  }));
  const statusItems = COLUMNS.map((c) => ({ value: c.id, label: c.label } as const));
  // Order: enabled harnesses first, then disabled (marked with a hint), then
  // orphan ids referenced by tasks but no longer registered as a harness — so
  // historical runs of a removed harness stay filterable.
  const known = new Set(harnesses.map((h) => h.id));
  const enabledItems = harnesses.filter((h) => h.enabled).map((h) => ({
    value: h.id,
    label: h.label,
    icon: <AgentIcon kind={h.kind} className="size-3.5" />,
  }));
  const disabledItems = harnesses.filter((h) => !h.enabled).map((h) => ({
    value: h.id,
    label: h.label,
    hint: "disabled",
    icon: <AgentIcon kind={h.kind} className="size-3.5" />,
  }));
  const orphanItems = taskAgentIds
    .filter((id) => !known.has(id))
    .map((id) => ({ value: id, label: id, hint: "removed" }));
  const harnessItems = [...enabledItems, ...disabledItems, ...orphanItems];
  const typeItems = TASK_TYPES.map((t) => {
    const Icon = taskTypeIcon(t.icon);
    return {
      value: t.id,
      label: t.label,
      icon: <Icon className={cn("size-3.5", t.iconClass)} />,
    };
  });
  const anyActive =
    textQuery !== ""
    || repoFilter.length > 0
    || statusFilter.length > 0
    || archivedView !== "active"
    || harnessFilter.length > 0
    || typeFilter.length > 0;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
      <MultiSearchSelect
        values={harnessFilter}
        onChange={onHarnessFilterChange}
        items={harnessItems}
        emptyLabel="All harnesses"
        placeholder="Search harnesses…"
        leadingIcon={<Cpu className="size-3.5" />}
        className="w-48"
      />
      <div className="relative flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          ref={searchInputRef}
          value={textQuery}
          onChange={(e) => onTextQueryChange(e.target.value)}
          placeholder="Search title, prompt, workdir, branch…"
          aria-label="Search tasks"
          className="pl-8"
          onKeyDown={(e) => {
            // Owner decision: Escape leaves the field but keeps the query
            // (no clear) — just blur so focus returns to the board.
            // `preventDefault` only, no `stopPropagation`: document-level
            // Escape listeners in this app coordinate through DOM markers
            // (see the comment block in RunPanel.tsx ~line 381-392), and
            // `ui/dialog.tsx` already honors `defaultPrevented`.
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.currentTarget.blur();
          }}
        />
      </div>
      <MultiSearchSelect
        values={repoFilter}
        onChange={onRepoFilterChange}
        items={repoItems}
        emptyLabel="All repos"
        placeholder="Search projects…"
        leadingIcon={<Folder className="size-3.5" />}
        className="w-56"
      />
      <MultiSearchSelect
        values={statusFilter}
        onChange={onStatusFilterChange}
        items={statusItems}
        emptyLabel="All statuses"
        placeholder="Search statuses…"
        leadingIcon={<Tag className="size-3.5" />}
        className="w-48"
      />
      <MultiSearchSelect
        values={typeFilter}
        onChange={onTypeFilterChange}
        items={typeItems}
        emptyLabel="All types"
        placeholder="Search types…"
        leadingIcon={<Shapes className="size-3.5" />}
        className="w-44"
      />
      <Select
        value={archivedView}
        onChange={(e) => onArchivedViewChange(e.target.value as ArchivedView)}
        className="w-36"
        title="Filter by archive state"
      >
        <option value="active">Active only</option>
        <option value="all">All</option>
        <option value="archived">Archived only</option>
      </Select>
      {anyActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onTextQueryChange("");
            onRepoFilterChange([]);
            onStatusFilterChange([]);
            onArchivedViewChange("active");
            onHarnessFilterChange([]);
            onTypeFilterChange([]);
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
