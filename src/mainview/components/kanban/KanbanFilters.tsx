import { Cpu, Folder, Search, Tag } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { COLUMNS, type ColumnId, type Harness, type Project } from "../../../shared/types.ts";

interface Props {
  textQuery: string;
  onTextQueryChange: (v: string) => void;
  repoFilter: string[];
  onRepoFilterChange: (v: string[]) => void;
  statusFilter: ColumnId[];
  onStatusFilterChange: (v: ColumnId[]) => void;
  harnessFilter: string[];
  onHarnessFilterChange: (v: string[]) => void;
  projects: Project[];
  harnesses: Harness[];
  /** Distinct harness ids referenced by any current task. Used to surface
   *  orphan ids (referenced by tasks but no longer registered) as filter
   *  options, so users can still narrow to historical runs of a removed
   *  harness. */
  taskAgentIds: string[];
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
  harnessFilter,
  onHarnessFilterChange,
  projects,
  harnesses,
  taskAgentIds,
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
  const anyActive =
    textQuery !== ""
    || repoFilter.length > 0
    || statusFilter.length > 0
    || harnessFilter.length > 0;

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
          value={textQuery}
          onChange={(e) => onTextQueryChange(e.target.value)}
          placeholder="Search title, prompt, workdir, branch…"
          className="pl-8"
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
      {anyActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onTextQueryChange("");
            onRepoFilterChange([]);
            onStatusFilterChange([]);
            onHarnessFilterChange([]);
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
