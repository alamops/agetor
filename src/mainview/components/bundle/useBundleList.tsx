import { useCallback, useEffect, useMemo, useState } from "react";
import type { BundleSelection } from "../../../shared/bundle.ts";
import { ExportBundleDialog } from "./ExportBundleDialog";
import { ImportBundleDialog } from "./ImportBundleDialog";
import { useBundleFileDrop } from "./useBundleFileDrop";

/**
 * Everything one Agents or Pipelines list needs for export/import
 * (docs/plans/agents-pipelines-import-export.md T5): row selection (cleared
 * as rows disappear), the `BundleToolbar` props, a per-row export, a drop
 * zone that opens the import dialog with the dropped file's text, and the
 * list's one `ExportBundleDialog` + one `ImportBundleDialog` (render
 * `dialogs` anywhere in the list). Shared by Settings → Agents, Settings →
 * Pipelines and the Pipelines page so the three can't drift.
 */
export function useBundleList({
  ids,
  kind,
  onImported,
}: {
  /** The list's row ids, in display order. */
  ids: string[];
  kind: "agent" | "pipeline";
  onImported?: (result: { enabledHarnesses: string[] }) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [exportSelection, setExportSelection] = useState<BundleSelection | null>(null);
  const [importState, setImportState] = useState<{ open: boolean; text: string | null }>({ open: false, text: null });

  // A selected row that leaves the list (deleted elsewhere) leaves the selection.
  const idsKey = ids.join("\u0000");
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(ids);
      const kept = [...prev].filter((id) => live.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    // Keyed on `idsKey` (the content of `ids`), not the array's identity.
  }, [idsKey]);

  const selectionOf = useCallback(
    (list: string[]): BundleSelection =>
      kind === "agent"
        ? { agentIds: list, pipelineIds: [], all: false }
        : { agentIds: [], pipelineIds: list, all: false },
    [kind],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedIds = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected]);
  const allSelected = ids.length > 0 && selectedIds.length === ids.length;

  const { dropProps, dragging } = useBundleFileDrop((text) => setImportState({ open: true, text }));

  const toolbarProps = {
    selectedCount: selectedIds.length,
    totalCount: ids.length,
    allSelected,
    onToggleAll: () => setSelected(allSelected ? new Set() : new Set(ids)),
    onImport: () => setImportState({ open: true, text: null }),
    onExportSelected: () => {
      if (selectedIds.length > 0) setExportSelection(selectionOf(selectedIds));
    },
    onExportAll: () => setExportSelection({ agentIds: [], pipelineIds: [], all: true }),
  };

  const dialogs = (
    <>
      <ExportBundleDialog
        open={exportSelection !== null}
        selection={exportSelection}
        onClose={() => setExportSelection(null)}
      />
      <ImportBundleDialog
        open={importState.open}
        initialText={importState.text}
        onClose={() => setImportState({ open: false, text: null })}
        onImported={onImported}
      />
    </>
  );

  return {
    toolbarProps,
    isSelected: (id: string) => selected.has(id),
    toggle,
    exportOne: (id: string) => setExportSelection(selectionOf([id])),
    dropProps,
    dragging,
    dialogs,
  };
}
