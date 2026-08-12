import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent,
} from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, FileWarning, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { loadPdfDocument, type PdfDoc } from "@/lib/pdf";

export type BinaryPreviewFileStatus = "added" | "modified" | "deleted" | "renamed";

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

type Side = "old" | "new";

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
    <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/20 p-2 text-center text-[11px] italic text-muted-foreground">
      {emptySideCopy(side, status)}
    </div>
  );
}

/* ------------------------------- Images -------------------------------- */

function ImagePane({ side, status, url, fileName }: { side: Side; status: BinaryPreviewFileStatus; url: string | null; fileName?: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setDims(null);
    setErrored(false);
  }, [url]);

  if (!url) return <EmptyPane side={side} status={status} />;

  if (errored) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-center">
        <ImageOff className="size-4 shrink-0 text-warning" />
        <span className="text-[11px] text-warning">Couldn't load image</span>
      </div>
    );
  }

  const label = side === "old" ? "previous" : "current";
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-40 items-center justify-center overflow-hidden rounded-md border border-border/60 p-2"
        style={CHECKERBOARD_STYLE}
      >
        <img
          src={url}
          alt={`${label} version of ${fileName ?? "file"}`}
          loading="lazy"
          decoding="async"
          className="max-h-72 max-w-full object-contain"
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setErrored(true)}
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
  | { status: "loading" }
  | { status: "ready"; doc: PdfDoc; numPages: number }
  | { status: "error"; kind: "too-large" | "missing" | "generic" };

function usePdfSide(url: string | null, fetchBytes: (url: string) => Promise<ArrayBuffer>): PdfSideState {
  const [state, setState] = useState<PdfSideState>(() => (url ? { status: "loading" } : { status: "idle" }));
  const docRef = useRef<PdfDoc | null>(null);

  useEffect(() => {
    docRef.current = null;
    if (!url) {
      setState({ status: "idle" });
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
  }, [url, fetchBytes]);

  return state;
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

const PDF_ERROR_COPY: Record<"too-large" | "missing" | "generic", string> = {
  "too-large": "Too large to preview — 20 MB limit",
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
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (state.status !== "ready" || !canvasRef.current || !width) return;
    if (page > state.numPages) return;
    let cancelled = false;
    void state.doc.renderPage(page, canvasRef.current, Math.max(1, Math.floor(width))).catch(() => {
      if (!cancelled) {
        // Render failures on a valid doc are rare (corrupt page); leave the
        // canvas as-is rather than tearing down the whole pane state.
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, page, width]);

  if (state.status === "idle") return <EmptyPane side={side} status={status} />;

  if (state.status === "loading") {
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

  const oldState = usePdfSide(kind === "pdf" ? oldUrl : null, doFetch);
  const newState = usePdfSide(kind === "pdf" ? newUrl : null, doFetch);

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
    <div className="flex flex-col gap-2">
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
