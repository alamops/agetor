import { useCallback, useRef, useState } from "react";
import type React from "react";
import { toast } from "sonner";
import { dragHasFiles, pickBundleDropFile } from "@/lib/bundle";

/**
 * Drop-a-file import (docs/plans/agents-pipelines-import-export.md K8): spread
 * `dropProps` on a list (or the import dialog) and a dropped `.json` file's
 * text is handed to `onText`. The file is read in the webview with
 * `File.text()` — no path and no server round trip, the same bytes the drop
 * ladder in `capture-refs.ts` already reads. A non-`.json` or over-size drop
 * toasts an error instead. Drags that carry no files are left alone, and a
 * handled drag stops propagating so a zone nested in another zone (the import
 * dialog opened from a list) handles it once.
 */
export function useBundleFileDrop(onText: (text: string) => void): {
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

  const onDragOver = useCallback<React.DragEventHandler>((e) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.stopPropagation();
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
    // Read the list synchronously — the DataTransfer is dead after a yield.
    const picked = pickBundleDropFile(Array.from(e.dataTransfer.files));
    if ("error" in picked) {
      toast.error("Can't import that file", { description: picked.error });
      return;
    }
    picked.file.text().then(
      (text) => onTextRef.current(text),
      (err: unknown) =>
        toast.error("Couldn't read the dropped file", {
          description: err instanceof Error ? err.message : String(err),
        }),
    );
  }, []);

  return { dropProps: { onDragOver, onDragLeave, onDrop }, dragging };
}
