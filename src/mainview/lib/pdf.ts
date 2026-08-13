/**
 * Lazy pdf.js loader for binary-diff PDF previews.
 *
 * Nothing pdf.js-related may load at board startup — `loadPdfDocument` does
 * a dynamic `import("pdfjs-dist")` so the ~1MB library + worker only enter
 * the bundle graph as a separate Vite chunk, fetched the first time a PDF
 * preview pane actually mounts (BinaryFilePreview.tsx).
 *
 * Worker wiring: the worker script itself (`pdf.worker.min.mjs`) is a
 * separate file pdf.js `postMessage`s work to. We resolve its URL via the
 * `new URL(<bare-specifier>, import.meta.url)` pattern, which is Vite's
 * documented way to get an asset URL for a package-relative path — Vite's
 * import-analysis plugin statically recognizes this exact call shape and
 * rewrites it to a hashed asset URL at build time, without needing an
 * ambient `*.mjs?url` module declaration (this repo has no `vite/client`
 * types reference, so a `?url`-suffixed static import wouldn't type-check).
 * Confirmed against the installed pdfjs-dist version's `build/` layout
 * (`node_modules/pdfjs-dist/build/pdf.worker.min.mjs` — pdfjs-dist@6.2.108).
 */

export interface PdfPageSize {
  width: number;
  height: number;
}

/** Name pdf.js stamps on the error a render rejects with when it's
 *  cancelled via `RenderTask.cancel()` (confirmed against the installed
 *  pdfjs-dist@6.2.108's `RenderingCancelledException`, which extends its
 *  `BaseException` and sets `this.name = "RenderingCancelledException"` in
 *  the base constructor). Exported so callers can distinguish an expected
 *  cancellation (overlapping renders, unmount) from a real render failure
 *  without importing pdf.js themselves. */
export const RENDERING_CANCELLED_NAME = "RenderingCancelledException";

export function isRenderCancelledError(err: unknown): boolean {
  return !!err && typeof err === "object" && "name" in err && err.name === RENDERING_CANCELLED_NAME;
}

/** A single `renderPage` call in flight. `result` settles once (resolve on
 *  success, reject on cancellation or a real render error); `cancel()` is
 *  idempotent and safe to call at any point, including before pdf.js's own
 *  `RenderTask` exists yet (the async gap while awaiting `getPage`) and
 *  after `result` has already settled (no-op). */
export interface PdfRenderTask {
  result: Promise<PdfPageSize>;
  cancel(): void;
}

export interface PdfDoc {
  numPages: number;
  /** Render `pageNo` (1-based) into `canvas`, fitted to `maxWidth` CSS
   *  pixels and scaled for the device pixel ratio so the canvas stays
   *  crisp on HiDPI displays. Returns a cancellable handle rather than a
   *  bare promise — pdf.js refuses to run two `render()` calls against the
   *  same canvas concurrently, so a caller that might re-invoke this before
   *  the previous call finished (a double-click, or a ResizeObserver width
   *  change mid-render) MUST cancel the stale call first. */
  renderPage(pageNo: number, canvas: HTMLCanvasElement, maxWidth: number): PdfRenderTask;
  /** Release the underlying pdf.js document (and its worker-side state).
   *  Call on unmount / before loading a different document. */
  destroy(): Promise<void>;
}

let workerConfigured = false;

export async function loadPdfDocument(data: ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await import("pdfjs-dist");

  if (!workerConfigured) {
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString();
    workerConfigured = true;
  }

  // pdf.js detaches/consumes the ArrayBuffer it's handed. The only caller
  // (usePdfSide in BinaryFilePreview.tsx) fetches fresh bytes per doc load
  // and discards its own reference afterwards, so there's no one left who
  // needs the original buffer preserved — hand it over directly rather than
  // copying. `destroy()` lives on the loading task, not the resolved
  // PDFDocumentProxy — keep both.
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;

  return {
    numPages: doc.numPages,
    renderPage(pageNo, canvas, maxWidth) {
      let cancelled = false;
      // pdf.js's own RenderTask, once `page.render()` has actually been
      // called — undefined during the async gap while awaiting `getPage`.
      let renderTask: { cancel(): void } | null = null;

      function cancelledError(): Error {
        const e = new Error(`Rendering cancelled, page ${pageNo}`);
        e.name = RENDERING_CANCELLED_NAME;
        return e;
      }

      const result = (async (): Promise<PdfPageSize> => {
        const page = await doc.getPage(pageNo);
        if (cancelled) throw cancelledError();

        const unscaled = page.getViewport({ scale: 1 });
        const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
        const cssScale = maxWidth / unscaled.width;
        const viewport = page.getViewport({ scale: cssScale * dpr });

        if (!canvas.getContext("2d")) throw new Error("Canvas 2D context unavailable");

        // Mutating the canvas is gated behind this second cancellation
        // check (cancel() can fire during the `getPage` await above, before
        // `renderTask` exists to cancel) so a cancelled render can't clear
        // dimensions a newer, still-live render already painted into.
        if (cancelled) throw cancelledError();

        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

        const task = page.render({ canvas, viewport });
        renderTask = task;
        if (cancelled) task.cancel();
        await task.promise;

        return { width: Math.round(viewport.width / dpr), height: Math.round(viewport.height / dpr) };
      })();

      return {
        result,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          renderTask?.cancel();
        },
      };
    },
    async destroy() {
      await loadingTask.destroy();
    },
  };
}
