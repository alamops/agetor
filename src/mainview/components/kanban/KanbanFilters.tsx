import { Folder, Search, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { COLUMNS, type ColumnId, type Project } from "../../../shared/types.ts";

interface Props {
  textQuery: string;
  onTextQueryChange: (v: string) => void;
  repoFilter: string[];
  onRepoFilterChange: (v: string[]) => void;
  statusFilter: ColumnId[];
  onStatusFilterChange: (v: ColumnId[]) => void;
  projects: Project[];
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
  projects,
}: Props) {
  const repoItems = projects.map((p) => ({
    value: p.path,
    label: p.name || basename(p.path) || p.path,
    hint: p.path,
  }));
  const statusItems = COLUMNS.map((c) => ({ value: c.id, label: c.label } as const));
  const anyActive =
    textQuery !== "" || repoFilter.length > 0 || statusFilter.length > 0;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
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
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
