import { useCallback, useRef, useState } from "react";
import type React from "react";
import { toast } from "sonner";
import { bundleTextTooLarge, dragHasFiles, pickBundleDropFile } from "@/lib/bundle";

/**
 * Drop-a-file import (docs/plans/agents-pipelines-import-export.md K8): spread
 * `dropProps` on a list (or the import dialog) and a dropped `.json` file's
 * text is handed to `onText`. The file is read in the webview with
 * `File.text()` — no path and no server round trip, the same bytes the drop
 * ladder in `capture-refs.ts` already reads. A drop of several files, a
 * non-`.json` file, or one too large to import (or, once escaped as JSON, to
 * send) toasts an error instead. Drags that carry no files are left alone, and a
 * handled drag stops propagating so a zone nested in another zone (the import
 * dialog opened from a list) handles it once.
 *
 * A file drag over a portaled child of the zone — a dialog the list renders —
 * still bubbles here through the React tree although its DOM target sits
 * outside the zone. Such a drag is refused (no drop, no import) instead of
 * opening Import on top of the dialog. `disabled` refuses every file drag the
 * same way (the import dialog while it imports), and is checked again once
 * the file has been read, since the zone may have been disabled meanwhile.
 */
export function useBundleFileDrop(
  onText: (text: string) => void,
  opts: { disabled?: boolean } = {},
): {
  dropProps: {
    onDragOver: React.DragEventHandler;
    onDragLeave: React.DragEventHandler;
    onDrop: React.DragEventHandler;
  };
  dragging: boolean;
} {
  const [dragging, setDragging] = useState(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const disabledRef = useRef(opts.disabled ?? false);
  disabledRef.current = opts.disabled ?? false;

  /** True when this drag is one the zone must not take: it bubbled up from a
   *  portal outside the zone's DOM, or the zone is disabled. */
  const refused = (e: React.DragEvent): boolean =>
    disabledRef.current || (e.target instanceof Node && !e.currentTarget.contains(e.target));

  const onDragOver = useCallback<React.DragEventHandler>((e) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.stopPropagation();
    if (refused(e)) {
      e.dataTransfer.dropEffect = "none";
      setDragging(false);
      return;
    }
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }, []);

  const onDragLeave = useCallback<React.DragEventHandler>((e) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDragging(false);
  }, []);

  const onDrop = useCallback<React.DragEventHandler>((e) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (refused(e)) return;
    // Read the list synchronously — the DataTransfer is dead after a yield.
    const picked = pickBundleDropFile(Array.from(e.dataTransfer.files));
    if ("error" in picked) {
      toast.error("Can't import that file", { description: picked.error });
      return;
    }
    const file = picked.file;
    file.text().then(
      (text) => {
        // The read yields: the zone may have been disabled meanwhile (a
        // Confirm click starting an import). The drop was taken, so say why
        // nothing happened rather than loading text into a locked preview.
        if (disabledRef.current) {
          toast.error("Can't import that file now", {
            description: "Wait for the import to finish, then drop the file again.",
          });
          return;
        }
        const tooLarge = bundleTextTooLarge(text, `"${file.name}"`);
        if (tooLarge) {
          toast.error("Can't import that file", { description: tooLarge });
          return;
        }
        onTextRef.current(text);
      },
      (err: unknown) =>
        toast.error("Couldn't read the dropped file", {
          description: err instanceof Error ? err.message : String(err),
        }),
    );
  }, []);

  return { dropProps: { onDragOver, onDragLeave, onDrop }, dragging };
}
