import { useEffect, useRef } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The export/import strip above an Agents or Pipelines list
 * (docs/plans/agents-pipelines-import-export.md C13): a select-all checkbox,
 * Import, Export selected and Export all. "Export all" exports every Agent
 * and every Pipeline whichever list it sits on (K10); exporting just this
 * list is select-all + Export selected.
 */
export function BundleToolbar({
  selectedCount,
  totalCount,
  allSelected,
  onToggleAll,
  onImport,
  onExportSelected,
  onExportAll,
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onImport: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const some = selectedCount > 0 && !allSelected;
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = some;
  }, [some]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2 py-1.5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          ref={checkboxRef}
          type="checkbox"
          data-testid="bundle-select-all"
          className="size-3.5 accent-primary"
          checked={totalCount > 0 && allSelected}
          disabled={totalCount === 0}
          onChange={onToggleAll}
          aria-label="Select all"
        />
        {selectedCount > 0 ? `${selectedCount} selected` : "Select"}
      </label>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" data-testid="bundle-import-open" onClick={onImport} className="gap-1">
          <Upload className="size-3.5" aria-hidden /> Import
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bundle-export-selected"
          disabled={selectedCount === 0}
          onClick={onExportSelected}
          className="gap-1"
        >
          <Download className="size-3.5" aria-hidden />
          {selectedCount > 0 ? `Export selected (${selectedCount})` : "Export selected"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="bundle-export-all"
          onClick={onExportAll}
          className="gap-1"
          title="Export every Agent and every Pipeline"
        >
          <Download className="size-3.5" aria-hidden /> Export all
        </Button>
      </div>
    </div>
  );
}
