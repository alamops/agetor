import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iconForRef, refBasename } from "@/lib/file-icons";
import { captureDroppedOrPastedItems } from "@/lib/capture-refs";
import { api } from "@/lib/api";
import type { TaskReference } from "../../../shared/types.ts";

export { captureDroppedOrPastedItems, type CapturedItem, type CaptureResult } from "@/lib/capture-refs";

interface Props {
  refs: TaskReference[];
  onChange: (refs: TaskReference[]) => void;
  /** `expandable` = full <details> block w/ header (NewTaskForm).
   *  `inline`    = compact chip row above the send textarea (RunPanel). */
  variant: "expandable" | "inline";
  /** Label for the expandable summary. Ignored for `inline`. */
  label?: string;
  /** Folder the native picker opens in. Usually the task's workdir. */
  startingFolder?: string;
  /** Extra className on the outer container. */
  className?: string;
}

/** Dedupe additions against an existing list, returning a new array. */
export function mergeRefs(
  existing: TaskReference[],
  additions: TaskReference[],
): TaskReference[] {
  if (!additions.length) return existing;
  const seen = new Set(existing.map((r) => r.path));
  const fresh = additions.filter((r) => r.path && !seen.has(r.path));
  if (!fresh.length) return existing;
  return [...existing, ...fresh];
}

export function ReferencesPicker({
  refs,
  onChange,
  variant,
  label = "Files / Folders",
  startingFolder,
  className,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Local open state for the expandable variant. We auto-open the section
  // the first time refs flip from empty → non-empty so adding the first
  // file reveals the list — but never force it open afterwards, so the
  // user can collapse the section while there's still content inside.
  const [open, setOpen] = useState(refs.length > 0);
  const wasEmptyRef = useRef(refs.length === 0);
  useEffect(() => {
    if (wasEmptyRef.current && refs.length > 0) setOpen(true);
    wasEmptyRef.current = refs.length === 0;
  }, [refs.length]);
  const append = (additions: TaskReference[]) => {
    const next = mergeRefs(refs, additions);
    if (next !== refs) onChange(next);
  };

  const remove = (p: string) => onChange(refs.filter((r) => r.path !== p));

  // Native macOS open-panel. WKWebView never exposes `File.path`, so an
  // `<input type=file>` can't give us a real path — the native panel can.
  const pick = async (mode: "files" | "folder") => {
    if (picking) return;
    setHint(null);
    setPicking(true);
    try {
      const picked = await api.pickRefs(mode, startingFolder);
      if (picked.length) append(picked);
    } catch (e) {
      setHint(`Couldn't open the picker: ${(e as Error).message}`);
    } finally {
      setPicking(false);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    setHint(null);
    const { items, skipped, error } = await captureDroppedOrPastedItems(e.dataTransfer);
    if (error) {
      setHint(`Couldn't save screenshot: ${error}`);
    } else if (skipped && !items.length) {
      setHint("Drag a file from Finder, or a screenshot from the macOS thumbnail.");
    }
    append(items.map((i) => i.ref));
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  };

  const chips = refs.length > 0 && (
    <ul className="flex flex-wrap gap-1">
      {refs.map((r) => {
        const Icon = iconForRef(r);
        return (
          <li
            key={r.path}
            title={r.path}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          >
            <Icon className="size-3 shrink-0 opacity-70" />
            <span className="truncate font-mono">
              {refBasename(r.path)}{r.isDirectory ? "/" : ""}
            </span>
            <button
              type="button"
              onClick={() => remove(r.path)}
              className="-mr-0.5 ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/40"
              title="Remove"
            >
              <X className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );

  // Buttons used in both variants. The expandable variant nests them inside
  // a `<summary>`, which auto-toggles `<details>` on any click — so we have
  // to stop propagation on the button clicks, or else picking files also
  // collapses/expands the section.
  const buttons = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={picking}
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={(e) => { e.stopPropagation(); void pick("files"); }}
      >
        <FilePlus className="size-3" /> Files
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={picking}
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={(e) => { e.stopPropagation(); void pick("folder"); }}
      >
        <FolderPlus className="size-3" /> Folder
      </Button>
    </div>
  );

  const dropOverlay = dragging && (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/10 text-xs font-medium text-primary">
      Drop files or folders to attach
    </div>
  );

  if (variant === "inline") {
    // When empty, render a single compact row (no placeholder strip) — the
    // send box already has the textarea below to spell out the intent.
    return (
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative rounded-md border border-dashed border-border/60 bg-card/40 px-1.5 py-1",
          dragging && "border-primary/60 bg-primary/5",
          className,
        )}
      >
        {refs.length > 0 ? (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">{chips}</div>
              {buttons}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end">{buttons}</div>
        )}
        {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
        {dropOverlay}
      </div>
    );
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className={cn(
        "relative rounded-md border border-border/60 bg-card/40 px-2 py-1.5",
        dragging && "border-primary/60 bg-primary/5",
        className,
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {label}{" "}
          {refs.length > 0 && <span className="font-mono">({refs.length})</span>}
        </span>
        {buttons}
      </summary>
      <div className="mt-1.5 space-y-1">
        {refs.length > 0
          ? chips
          : <p className="text-[10px] text-muted-foreground">No files attached yet — use the buttons or drag from Finder. Absolute paths are inlined into the prompt as text.</p>}
        {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      </div>
      {dropOverlay}
    </details>
  );
}
