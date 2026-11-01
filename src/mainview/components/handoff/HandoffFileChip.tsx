// The handoff-file reference chip on a step's prompt bubble
// (`docs/plans/formatted-handoff.md` D18). The runner attaches every previous
// handoff it hands to a step as a path-only reference to
// `dataDir/pipeline-runs/<parentId>/handoff-<gen>-<seq>-from-<fromSeq>.json`;
// instead of OS-opening that JSON, the chip finds the history record it was
// written from (same run generation, `record.seq === fromSeq`) and opens the
// formatted modal. When the record is gone — a Restart replaced the run — it
// falls back to opening the file, like any other attachment chip.
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileJson } from "lucide-react";
import type { PipelineGraph, PipelineRunState, PipelineStepRecord } from "../../../shared/types.ts";
import { findHandoffRecordForFile, parseHandoffFilePath } from "../../../shared/pipeline.ts";
import { api, ApiError } from "@/lib/api";
import { refBasename } from "@/lib/file-icons";
import { handoffNextLabel } from "@/lib/handoff-view";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { AttachmentNotFoundDialog, AttachmentOpenErrorDialog } from "@/components/kanban/AttachmentDialogs";
import { HandoffDialog } from "./HandoffDialog";
import { stepNameFor, useHandoffView } from "./handoff-context";

/** The history record a runner handoff file at `path` was written from, or
 *  `null` (not a handoff file of this pipeline, a different run generation,
 *  no such record, or no parent known). */
export function handoffRecordForFile(
  path: string | null,
  parentId: string | null,
  run: PipelineRunState | null,
): PipelineStepRecord | null {
  if (path === null || parentId === null) return null;
  const file = parseHandoffFilePath(path, parentId);
  return file === null ? null : findHandoffRecordForFile(run, file);
}

/** Open / reveal one file path through `/open-path` / `/reveal-path`, with
 *  the attachment not-found (404) and couldn't-open (anything else) dialogs,
 *  portaled to `document.body` while one is showing. */
export function useFileOpener(taskId: string | undefined) {
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);

  const run = useCallback(
    async (path: string, action: "open" | "reveal") => {
      try {
        const ok =
          action === "open"
            ? (await api.openPath({ path, taskId })).opened
            : (await api.revealPath({ path, taskId })).revealed;
        if (!ok) {
          setOpenError({
            path,
            message: action === "open" ? "The OS declined to open this file." : "The OS declined to reveal this file.",
          });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setNotFoundPath(path);
        else setOpenError({ path, message: e instanceof Error ? e.message : String(e) });
      }
    },
    [taskId],
  );

  const dialogs =
    notFoundPath !== null || openError !== null
      ? createPortal(
          <>
            <AttachmentNotFoundDialog path={notFoundPath} onClose={() => setNotFoundPath(null)} />
            <AttachmentOpenErrorDialog
              path={openError?.path ?? null}
              message={openError?.message ?? null}
              onClose={() => setOpenError(null)}
            />
          </>,
          document.body,
        )
      : null;

  return { openFile: (path: string) => void run(path, "open"), revealFile: (path: string) => void run(path, "reveal"), dialogs };
}

/** The modal for a recorded handoff reached through a file reference (this
 *  chip, or a prompt placeholder card): prompt-sourced, so `untrusted`. */
export function RecordHandoffDialog({
  record,
  graph,
  onClose,
}: {
  record: PipelineStepRecord;
  graph: PipelineGraph | null;
  onClose: () => void;
}) {
  if (record.handoff === null) return null;
  const stepName = stepNameFor(graph, record.stepId) ?? record.stepId;
  return (
    <HandoffDialog
      open
      onClose={onClose}
      handoff={record.handoff}
      title={`Handoff from "${stepName}"`}
      untrusted
      stepName={stepName}
      next={handoffNextLabel(record.handoff, graph, record.stepId)}
    />
  );
}

export function HandoffFileChip({ path, taskId }: { path: string; taskId?: string }) {
  const ctx = useHandoffView();
  const record = useMemo(() => handoffRecordForFile(path, ctx.parentId, ctx.run), [path, ctx.parentId, ctx.run]);
  const stepName = record ? (stepNameFor(ctx.graph, record.stepId) ?? record.stepId) : null;
  const label = stepName !== null ? `Handoff from "${stepName}"` : refBasename(path);
  const { openFile, revealFile, dialogs } = useFileOpener(taskId ?? ctx.taskId);
  const [modalOpen, setModalOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const items: ContextMenuItem[] = [
    { id: "open", label: "Open file", onSelect: () => openFile(path) },
    { id: "reveal", label: "Reveal in Finder", onSelect: () => revealFile(path) },
  ];

  return (
    <>
      <button
        type="button"
        data-testid="handoff-file-chip"
        title={path}
        onClick={() => (record ? setModalOpen(true) : openFile(path))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60"
      >
        <FileJson className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
        label="Handoff file actions"
        testId="handoff-file-menu"
      />
      {modalOpen && record && (
        <RecordHandoffDialog record={record} graph={ctx.graph} onClose={() => setModalOpen(false)} />
      )}
      {dialogs}
    </>
  );
}
