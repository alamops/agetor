import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iconForRef, refBasename } from "@/lib/file-icons";
import type { TaskReference } from "../../../shared/types.ts";

interface Props {
  refs: TaskReference[];
  onChange: (refs: TaskReference[]) => void;
  /** `expandable` = full <details> block w/ header (NewTaskForm).
   *  `inline`    = compact chip row above the send textarea (RunPanel). */
  variant: "expandable" | "inline";
  /** Label for the expandable summary. Ignored for `inline`. */
  label?: string;
  /** Extra className on the outer container. */
  className?: string;
}

// `File` in WKWebView (Electrobun) carries a non-standard `path` property that
// holds the absolute filesystem path. We rely on it for the picker AND drop
// paths — without it we can't build a `TaskReference`. Plain-browser drops
// fall back to a one-liner hint.
type ElectroFile = File & { path?: string };

/**
 * Derive a folder's absolute path from a single File in a `webkitdirectory`
 * pick. `webkitRelativePath` is `<folderName>/<…>/file`; if WKWebView
 * populated `path` on the file, peel matching tail segments to expose the
 * root. Returns null if `path` isn't exposed (plain-browser fallback).
 */
function deriveFolderRoot(file: ElectroFile): string | null {
  const rel = file.webkitRelativePath || "";
  const abs = file.path || "";
  if (!abs) return null;
  if (!rel) return abs;
  let a = abs.replace(/[\\/]+$/, "");
  let r = rel.replace(/[\\/]+$/, "");
  while (a && r) {
    const aSlash = Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\"));
    const rSlash = Math.max(r.lastIndexOf("/"), r.lastIndexOf("\\"));
    const aSeg = aSlash >= 0 ? a.slice(aSlash + 1) : a;
    const rSeg = rSlash >= 0 ? r.slice(rSlash + 1) : r;
    if (aSeg !== rSeg) break;
    a = aSlash >= 0 ? a.slice(0, aSlash) : "";
    r = rSlash >= 0 ? r.slice(0, rSlash) : "";
    if (!r) break;
  }
  return a || null;
}

export interface DropExtractResult {
  additions: TaskReference[];
  /** Items that lacked a filesystem path. Caller may want to show a hint
   *  when nothing was added. */
  skipped: number;
}

/**
 * Pure helper exported so containers (e.g. NewTaskForm's outer aside) can
 * forward drops to the picker without duplicating the WKWebView quirks.
 */
export function extractDroppedRefs(e: React.DragEvent | DragEvent): DropExtractResult {
  const additions: TaskReference[] = [];
  let skipped = 0;
  if (!e.dataTransfer) return { additions, skipped };
  const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile() as ElectroFile | null;
      const entry = item.webkitGetAsEntry?.();
      const isDir = entry?.isDirectory ?? false;
      const abs = file?.path ?? null;
      if (!abs) { skipped++; continue; }
      additions.push({ path: abs, isDirectory: isDir });
    }
  } else if (e.dataTransfer.files?.length) {
    for (const f of Array.from(e.dataTransfer.files) as ElectroFile[]) {
      if (!f.path) { skipped++; continue; }
      additions.push({ path: f.path, isDirectory: false });
    }
  }
  return { additions, skipped };
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
  className,
}: Props) {
  const [dragging, setDragging] = useState(false);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const append = (additions: TaskReference[]) => {
    const next = mergeRefs(refs, additions);
    if (next !== refs) onChange(next);
  };

  const remove = (p: string) => onChange(refs.filter((r) => r.path !== p));

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    setHint(null);
    const files = Array.from(e.target.files ?? []) as ElectroFile[];
    if (files.length && files.some((f) => !f.path)) {
      setHint("File picker did not expose absolute paths — drag from Finder instead.");
    }
    append(
      files
        .filter((f) => !!f.path)
        .map((f) => ({ path: f.path!, isDirectory: false })),
    );
    // Reset so picking the same file twice still fires `change`.
    e.target.value = "";
  };

  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    setHint(null);
    const files = Array.from(e.target.files ?? []) as ElectroFile[];
    if (!files.length) { e.target.value = ""; return; }
    // Walk every file, derive its folder root, dedupe — handles the (rare)
    // case where webkitRelativePath is only populated on a sibling, and is
    // future-proof if a webview ever returns multiple roots in one pick.
    const roots = new Set<string>();
    for (const f of files) {
      const r = deriveFolderRoot(f);
      if (r) roots.add(r);
    }
    if (!roots.size) {
      setHint("Folder picker did not expose absolute paths — drag from Finder instead.");
    } else {
      append([...roots].map((p) => ({ path: p, isDirectory: true })));
    }
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    setHint(null);
    const { additions, skipped } = extractDroppedRefs(e);
    if (skipped && !additions.length) {
      setHint("Drag from Finder — these items had no filesystem path.");
    }
    append(additions);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  };

  // Type-safe spread for non-standard HTML attributes. WKWebView and modern
  // Chromium both honour `webkitdirectory` alone; the older `directory`
  // attribute is dead weight.
  const dirAttrs = { webkitdirectory: "" } as Record<string, string>;

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
  // collapses/expands the section. The hidden file inputs share the same
  // tree, so their `change` events shouldn't bubble to summary either; we
  // stopPropagation there too as belt-and-braces.
  const buttons = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
      >
        <FilePlus className="size-3" /> Files
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={(e) => { e.stopPropagation(); dirInputRef.current?.click(); }}
      >
        <FolderPlus className="size-3" /> Folder
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={onPickFiles}
      />
      <input
        ref={dirInputRef}
        type="file"
        {...dirAttrs}
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={onPickFolder}
      />
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
          : <p className="text-[10px] text-muted-foreground">No files attached yet — pick or drag from Finder. Paths are inlined into the prompt as text; agetor never uploads them.</p>}
        {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      </div>
      {dropOverlay}
    </details>
  );
}
