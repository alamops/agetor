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

export interface PdfDoc {
  numPages: number;
  /** Render `pageNo` (1-based) into `canvas`, fitted to `maxWidth` CSS
   *  pixels and scaled for the device pixel ratio so the canvas stays
   *  crisp on HiDPI displays. Resolves with the rendered CSS size. */
  renderPage(pageNo: number, canvas: HTMLCanvasElement, maxWidth: number): Promise<PdfPageSize>;
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

  // pdf.js detaches/consumes the ArrayBuffer it's handed; callers may want
  // to keep the original bytes around, so hand over a copy. `destroy()`
  // lives on the loading task, not the resolved PDFDocumentProxy — keep
  // both.
  const loadingTask = pdfjs.getDocument({ data: data.slice(0) });
  const doc = await loadingTask.promise;

  return {
    numPages: doc.numPages,
    async renderPage(pageNo, canvas, maxWidth) {
      const page = await doc.getPage(pageNo);
      const unscaled = page.getViewport({ scale: 1 });
      const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
      const cssScale = maxWidth / unscaled.width;
      const viewport = page.getViewport({ scale: cssScale * dpr });

      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

      if (!canvas.getContext("2d")) throw new Error("Canvas 2D context unavailable");

      await page.render({ canvas, viewport }).promise;

      return { width: Math.round(viewport.width / dpr), height: Math.round(viewport.height / dpr) };
    },
    async destroy() {
      await loadingTask.destroy();
    },
  };
}
