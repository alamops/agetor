import {
  useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent,
} from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, FileWarning, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { loadPdfDocument, isRenderCancelledError, type PdfDoc } from "@/lib/pdf";
import { MAX_BLOB_PREVIEW_BYTES } from "../../../shared/attachments.ts";
import type { DiffFile } from "../../../shared/types.ts";

export type BinaryPreviewFileStatus = DiffFile["status"];

export interface BinaryFilePreviewProps {
  kind: "image" | "pdf";
  status: BinaryPreviewFileStatus;
  /** null = this side doesn't exist (added → oldUrl null; deleted → newUrl null). */
  oldUrl: string | null;
  newUrl: string | null;
  /** Injected for PDF panes, which fetch bytes via `fetch` rather than an
   *  `<img>` tag. Defaults to `api.fetchBlobBytes`; overridable for tests. */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** Used in alt text / placeholder copy. */
  fileName?: string;
}

export type Side = "old" | "new";

/** Build the `{ oldUrl, newUrl }` pair `BinaryFilePreview` wants from a diff
 *  file entry, applying the same added/deleted-side-is-null rule and rename
 *  (`oldPath ?? path`) handling both DiffDialog's and GitHubDialog's binary
 *  preview wrappers need. `urlFor` is the caller's one-line closure over
 *  whichever blob-URL builder applies (`api.taskDiffBlobUrl` for a task
 *  diff, `api.pullBlobUrl` for a GitHub PR diff). */
export function binaryPreviewSides(
  file: Pick<DiffFile, "path" | "oldPath" | "status">,
  urlFor: (path: string, side: Side) => string,
): { oldUrl: string | null; newUrl: string | null } {
  return {
    oldUrl: file.status === "added" ? null : urlFor(file.oldPath ?? file.path, "old"),
    newUrl: file.status === "deleted" ? null : urlFor(file.path, "new"),
  };
}

/** `file.path` is always the NEW-state path (renames included), so this is
 *  the right basename for both preview panes' alt text / labels. */
export function binaryFileBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Two-layer CSS checkerboard behind image panes, so transparent PNG/SVG
 *  content is visually distinguishable from an opaque white/black area.
 *  Built from `--muted-foreground` at low alpha via the raw
 *  `hsl(var(--x) / <alpha>)` syntax (the CSS vars in index.css already
 *  store bare "H S% L%" triples), so it reads correctly in both themes
 *  without a bespoke token. */
const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage: [
    "linear-gradient(45deg, hsl(var(--muted-foreground) / 0.14) 25%, transparent 25%)",
    "linear-gradient(-45deg, hsl(var(--muted-foreground) / 0.14) 25%, transparent 25%)",
    "linear-gradient(45deg, transparent 75%, hsl(var(--muted-foreground) / 0.14) 75%)",
    "linear-gradient(-45deg, transparent 75%, hsl(var(--muted-foreground) / 0.14) 75%)",
  ].join(", "),
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
};

function paneLabel(side: Side): { text: string; cls: string } {
  return side === "old"
    ? { text: "Before", cls: "border-danger/30 bg-danger/10 text-danger" }
    : { text: "After", cls: "border-success/30 bg-success/10 text-success" };
}

function emptySideCopy(side: Side, status: BinaryPreviewFileStatus): string {
  if (side === "old") return status === "added" ? "Added — no previous version" : "No previous version";
  return status === "deleted" ? "Deleted — no new version" : "No new version";
}

function Pane({ side, status, children }: { side: Side; status: BinaryPreviewFileStatus; children: React.ReactNode }) {
  const label = paneLabel(side);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span
        className={cn(
          "inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
          label.cls,
        )}
      >
        {label.text}
      </span>
      {children}
    </div>
  );
}

function EmptyPane({ side, status }: { side: Side; status: BinaryPreviewFileStatus }) {
  return (
    <div className="flex h-56 items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/20 p-2 text-center text-[11px] italic text-muted-foreground">
      {emptySideCopy(side, status)}
    </div>
  );
}

/** Size cap in whole MB, for the too-large copy below — derived from the
 *  shared constant rather than hardcoded so the image and PDF panes (and
 *  the server-side limit they mirror) can't drift apart. */
const MAX_BLOB_PREVIEW_MB = Math.round(MAX_BLOB_PREVIEW_BYTES / 1_000_000);

/* ------------------------------- Images -------------------------------- */

type ImageErrorKind = "too-large" | "missing" | "generic";

const IMAGE_ERROR_COPY: Record<ImageErrorKind, string> = {
  "too-large": `Too large to preview — ${MAX_BLOB_PREVIEW_MB} MB limit`,
  "missing": "Not present on this side",
  "generic": "Couldn't load image",
};

function ImagePane({ side, status, url, fileName }: { side: Side; status: BinaryPreviewFileStatus; url: string | null; fileName?: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [errorKind, setErrorKind] = useState<ImageErrorKind | null>(null);

  useEffect(() => {
    setDims(null);
    setErrorKind(null);
  }, [url]);

  // SF-10: a bare 404/413 both surface through `onError` as the same
  // generic broken-image icon — the browser gives no status code to an
  // `<img>` load failure. Re-probe the URL (status only, body cancelled
  // unread — see `api.probeBlobStatus`) so the pane can distinguish "too
  // large to preview" and "not present on this side" from a genuine
  // decode/network failure. Only runs on error, so no steady-state cost.
  const handleError = useCallback(() => {
    setErrorKind("generic");
    if (!url) return;
    void api.probeBlobStatus(url).then((kind) => {
      setErrorKind(kind === "too-large" ? "too-large" : kind === "missing" ? "missing" : "generic");
    });
  }, [url]);

  if (!url) return <EmptyPane side={side} status={status} />;

  if (errorKind) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-center">
        <ImageOff className="size-4 shrink-0 text-warning" />
        <span className="text-[11px] text-warning">{IMAGE_ERROR_COPY[errorKind]}</span>
      </div>
    );
  }

  const label = side === "old" ? "previous" : "current";
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-56 items-center justify-center overflow-hidden rounded-md border border-border/60 p-2"
        style={CHECKERBOARD_STYLE}
      >
        <img
          src={url}
          alt={`${label} version of ${fileName ?? "file"}`}
          loading="lazy"
          decoding="async"
          className="max-h-full max-w-full object-contain"
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={handleError}
        />
      </div>
      <span className="text-center font-mono text-[11px] tabular-nums text-muted-foreground">
        {dims ? `${dims.w} × ${dims.h} px` : " "}
      </span>
    </div>
  );
}

/* -------------------------------- PDFs ---------------------------------- */

type PdfSideState =
  | { status: "idle" }
  // A url exists but we're deliberately not fetching it yet (SF-7: waiting
  // for the pane to scroll into view) — rendered identically to "loading"
  // below so there's no misleading "no version" flash for a side that in
  // fact has content, just not-yet-fetched content.
  | { status: "deferred" }
  | { status: "loading" }
  | { status: "ready"; doc: PdfDoc; numPages: number }
  | { status: "error"; kind: "too-large" | "missing" | "generic" };

function usePdfSide(
  url: string | null,
  active: boolean,
  fetchBytes: (url: string) => Promise<ArrayBuffer>,
): PdfSideState {
  const [state, setState] = useState<PdfSideState>(
    () => (!url ? { status: "idle" } : active ? { status: "loading" } : { status: "deferred" }),
  );
  const docRef = useRef<PdfDoc | null>(null);

  useEffect(() => {
    docRef.current = null;
    if (!url) {
      setState({ status: "idle" });
      return;
    }
    if (!active) {
      setState({ status: "deferred" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const bytes = await fetchBytes(url);
        const doc = await loadPdfDocument(bytes);
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setState({ status: "ready", doc, numPages: doc.numPages });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "";
        const kind = msg === "too-large" ? "too-large" : msg === "missing" ? "missing" : "generic";
        setState({ status: "error", kind });
      }
    })();
    return () => {
      cancelled = true;
      if (docRef.current) {
        void docRef.current.destroy();
        docRef.current = null;
      }
    };
  }, [url, active, fetchBytes]);

  return state;
}

/** Tracks an element's content-box width across mount/branch-swaps via a
 *  ref callback (React 19's ref-cleanup form) instead of a `[]`
 *  `useLayoutEffect` over a `useRef` — the latter only ever observes
 *  whichever node was mounted at first render, so a later render that swaps
 *  in a differently-branched element sharing this ref (as `PdfPane`'s
 *  idle/loading/ready/error returns do) silently stops tracking width
 *  (NTH-12). A callback ref re-fires on every attach/detach, so the
 *  observed node always matches what's actually on screen. */
function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);

  const setRef = useCallback((el: T | null) => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return [setRef, width];
}

/** Fires once when its attached element first enters the viewport, then
 *  disconnects (SF-7) — gates PDF byte-fetching so a diff with many binary
 *  blocks (every block defaults open) doesn't pull every PDF on both sides
 *  down at once. Images don't need this: `<img loading="lazy">` already
 *  defers them natively. */
function useVisibleOnce<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [visible, setVisible] = useState(false);
  const seenRef = useRef(false);

  const setRef = useCallback((el: T | null) => {
    if (!el || seenRef.current) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO support (non-browser test runtime) — fetch eagerly rather
      // than never rendering a preview at all.
      seenRef.current = true;
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seenRef.current = true;
      setVisible(true);
      io.disconnect();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return [setRef, visible];
}

const PDF_ERROR_COPY: Record<"too-large" | "missing" | "generic", string> = {
  "too-large": `Too large to preview — ${MAX_BLOB_PREVIEW_MB} MB limit`,
  "missing": "File not found",
  "generic": "Couldn't load PDF",
};

function PdfPane({
  side, status, state, page, width, containerRef,
}: {
  side: Side;
  status: BinaryPreviewFileStatus;
  state: PdfSideState;
  page: number;
  width: number;
  containerRef: (el: HTMLDivElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Render failures distinct from a document-level load error (state.error)
  // — a corrupt page on an otherwise-valid doc, surfaced instead of the
  // old silent `.catch(() => {})` that left the canvas permanently blank.
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    setRenderError(false);
    if (state.status !== "ready" || !canvasRef.current || !width) return;
    if (page > state.numPages) return;
    // MF-1: a page render mid-flight when this effect re-fires (double
    // click, or a ResizeObserver width change racing the first render)
    // would otherwise collide with pdf.js's "Cannot use the same canvas
    // during multiple render() operations" and leave the pane permanently
    // blank. `renderPage` now returns a cancellable handle — cancel the
    // in-flight render on cleanup and only swallow the resulting (expected)
    // cancellation; any other render failure surfaces to `renderError`.
    const task = state.doc.renderPage(page, canvasRef.current, Math.max(1, Math.floor(width)));
    task.result.catch((err) => {
      if (isRenderCancelledError(err)) return;
      setRenderError(true);
    });
    return () => {
      task.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, page, width]);

  if (state.status === "idle") return <EmptyPane side={side} status={status} />;

  if (state.status === "loading" || state.status === "deferred") {
    return (
      <div ref={containerRef} className="flex h-72 w-full animate-pulse items-center justify-center rounded-md border border-border/60 bg-muted/40" />
    );
  }

  if (state.status === "error") {
    const Icon = state.kind === "too-large" ? FileWarning : AlertTriangle;
    return (
      <div ref={containerRef} className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2 text-center">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[11px] italic text-muted-foreground">{PDF_ERROR_COPY[state.kind]}</span>
      </div>
    );
  }

  if (page > state.numPages) {
    return (
      <div ref={containerRef} className="flex h-40 items-center justify-center rounded-md border border-border/60 bg-muted/20 p-2 text-center text-[11px] italic text-muted-foreground">
        No page {page}
      </div>
    );
  }

  if (renderError) {
    return (
      <div ref={containerRef} className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2 text-center">
        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[11px] italic text-muted-foreground">Couldn't render page {page}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/10 p-1">
      <canvas ref={canvasRef} className="max-w-full" />
    </div>
  );
}

/* ------------------------------ Component -------------------------------- */

export function BinaryFilePreview({ kind, status, oldUrl, newUrl, fetchBytes, fileName }: BinaryFilePreviewProps) {
  const doFetch = fetchBytes ?? api.fetchBlobBytes;
  const [page, setPage] = useState(1);

  // SF-7: every binary block defaults open, so gate the (potentially
  // 20MB-per-side) PDF byte fetch on the pane actually being scrolled into
  // view rather than firing for every PDF in the diff on mount.
  const [pdfRootRef, pdfVisible] = useVisibleOnce<HTMLDivElement>();
  const oldState = usePdfSide(kind === "pdf" ? oldUrl : null, pdfVisible, doFetch);
  const newState = usePdfSide(kind === "pdf" ? newUrl : null, pdfVisible, doFetch);

  const [oldRef, oldWidth] = useElementWidth<HTMLDivElement>();
  const [newRef, newWidth] = useElementWidth<HTMLDivElement>();

  const oldPages = oldState.status === "ready" ? oldState.numPages : 0;
  const newPages = newState.status === "ready" ? newState.numPages : 0;
  const totalPages = Math.max(1, oldPages, newPages);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const goPrev = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setPage((p) => Math.max(1, p - 1));
  }, []);
  const goNext = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setPage((p) => Math.min(totalPages, p + 1));
  }, [totalPages]);
  const stopMouseDown = useCallback((e: ReactMouseEvent) => e.stopPropagation(), []);

  if (kind === "image") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Pane side="old" status={status}>
          <ImagePane side="old" status={status} url={oldUrl} fileName={fileName} />
        </Pane>
        <Pane side="new" status={status}>
          <ImagePane side="new" status={status} url={newUrl} fileName={fileName} />
        </Pane>
      </div>
    );
  }

  const showPager = (oldUrl !== null || newUrl !== null) && totalPages > 1;

  return (
    <div ref={pdfRootRef} className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Pane side="old" status={status}>
          <PdfPane side="old" status={status} state={oldState} page={page} width={oldWidth} containerRef={oldRef} />
        </Pane>
        <Pane side="new" status={status}>
          <PdfPane side="new" status={status} state={newState} page={page} width={newWidth} containerRef={newRef} />
        </Pane>
      </div>
      {showPager && (
        <div className="flex items-center justify-center gap-2" onMouseDown={stopMouseDown}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={page <= 1}
            onMouseDown={stopMouseDown}
            onClick={goPrev}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="min-w-[5.5rem] text-center font-mono text-[11px] tabular-nums text-muted-foreground">
            Page {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={page >= totalPages}
            onMouseDown={stopMouseDown}
            onClick={goNext}
            aria-label="Next page"
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
