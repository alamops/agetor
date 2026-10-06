import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clipboard, Download, FolderOpen, PackageOpen, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { countsSummary, requestFailureText } from "@/lib/bundle";
import { ApiUnreachableError } from "@/lib/net-retry";
import type { BundleExportResponse, BundleSelection } from "../../../shared/bundle.ts";

const TITLE_ID = "bundle-export-title";

type Action = "downloads" | "folder" | "copy";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The live-region text: what a screen reader user would otherwise only see
 *  on the buttons (a running action) or in the summary box. After a failed
 *  action it goes quiet: the error toast announces the failure, and "Ready
 *  to export" would read as if the action had worked. */
function exportStatusText(
  busy: Action | null,
  error: string | null,
  summary: BundleExportResponse | null,
  actionFailed: boolean,
): string {
  if (busy === "downloads") return "Saving to Downloads…";
  if (busy === "folder") return "Choosing a folder…";
  if (busy === "copy") return "Copying…";
  if (error) return `Export failed: ${error}`;
  if (actionFailed) return "";
  return summary ? `Ready to export ${countsSummary(summary.counts)}` : "Preparing export…";
}

/**
 * Export Agents and/or Pipelines as an agetor bundle
 * (docs/plans/agents-pipelines-import-export.md K7/K9). On open it fetches
 * the export once — the summary, the export-time warnings and the text Copy
 * JSON uses — then offers three ways out, since there is no native save
 * dialog: Save to Downloads (revealed in Finder), Copy JSON, or Choose
 * folder. Only one request runs at a time, and the dialog stays open until
 * it settles.
 *
 * A stacked `Dialog` (so Escape closes this before Settings), portaled to
 * `document.body` because the Pipelines page animates with a transform that
 * would otherwise re-anchor the `fixed` backdrop.
 */
export function ExportBundleDialog({
  open,
  selection,
  onClose,
}: {
  open: boolean;
  selection: BundleSelection | null;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<BundleExportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  // The last Save/Copy failed (its toast says why).
  const [actionFailed, setActionFailed] = useState(false);
  // A 400 is the core refusing this selection (nothing left to export, an
  // export import would refuse): asking again can only fail the same way,
  // so only other failures offer Retry.
  const [errorRetryable, setErrorRetryable] = useState(true);
  // Bumped by Retry: re-runs the export fetch after a failure.
  const [loadCount, setLoadCount] = useState(0);
  // Where focus goes when Retry (inside it) unmounts.
  const summaryRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open || !selection) return;
    const seq = ++requestRef.current;
    setSummary(null);
    setError(null);
    setBusy(null);
    setActionFailed(false);
    api.exportBundle(selection).then(
      (res) => {
        if (seq === requestRef.current) setSummary(res);
      },
      (e: unknown) => {
        if (seq !== requestRef.current) return;
        setError(requestFailureText(e));
        setErrorRetryable(!(e instanceof ApiError && e.status === 400));
      },
    );
    return () => {
      // A close (or a new selection) drops whatever is still in flight.
      requestRef.current++;
    };
  }, [open, selection, loadCount]);

  if (!open || !selection) return null;

  // The dialog can't be closed while an action runs (a native panel may be
  // up, or a file half-written), but the host can still unmount or reopen
  // it: an answer from an earlier open must never close a later one.
  const save = async (target: "downloads" | "folder") => {
    const seq = requestRef.current;
    setBusy(target);
    setActionFailed(false);
    try {
      const res = await api.saveBundle(selection, target);
      if ("cancelled" in res) return;
      // The file is written either way, so the toast is still true.
      toast.success(`Exported ${countsSummary(res.counts)}`, {
        description: res.revealed ? `Saved ${res.filename} — revealed in Finder` : `Saved to ${res.path}`,
      });
      if (seq === requestRef.current) onClose();
    } catch (e) {
      const where = target === "downloads" ? "Downloads" : "the folder you chose";
      // No HTTP answer at all. With the core not answering its health check
      // either, the request most likely never ran. Otherwise the connection
      // dropped (or the webview gave up on a request held open by the
      // native panel) after the core took it: it may still have written the
      // file, so saving again could leave a duplicate.
      const description =
        e instanceof ApiError && e.status === 501
          ? "Choosing a folder isn't available here — use Save to Downloads or Copy JSON."
          : e instanceof ApiError
            ? message(e)
            : e instanceof ApiUnreachableError
              ? `${requestFailureText(e)}, so the export most likely didn't run; if a file shows up in ${where} anyway, check it before saving again.`
              : target === "folder"
                ? `${requestFailureText(e)} — if the folder panel is still open, close it; the file may still have been saved to ${where}, so check there before saving again.`
                : `${requestFailureText(e)} — the file may still have been saved to ${where}; check there before saving again.`;
      toast.error("Couldn't export", { description, duration: Infinity });
      if (seq === requestRef.current) setActionFailed(true);
    } finally {
      if (seq === requestRef.current) setBusy(null);
    }
  };

  const copy = async () => {
    if (!summary) return;
    const seq = requestRef.current;
    setBusy("copy");
    setActionFailed(false);
    try {
      await navigator.clipboard.writeText(summary.text);
      toast.success(`Copied ${countsSummary(summary.counts)} as JSON`);
      if (seq === requestRef.current) onClose();
    } catch (e) {
      toast.error("Couldn't copy to the clipboard", { description: message(e), duration: Infinity });
      if (seq === requestRef.current) setActionFailed(true);
    } finally {
      if (seq === requestRef.current) setBusy(null);
    }
  };

  // The actions disable themselves while one runs. `aria-disabled` rather
  // than `disabled`: a natively disabled button drops keyboard focus to
  // <body>, so it would be gone from the dialog when the action fails.
  const disabled = busy !== null || summary === null;
  const softDisabled = {
    "aria-disabled": disabled || undefined,
    className: "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
  };
  const requestClose = () => {
    if (busy === null) onClose();
  };

  return createPortal(
    <Dialog open={open} onClose={requestClose} labelledBy={TITLE_ID} className="max-w-md p-0">
      <div data-testid="bundle-export-dialog" className="flex flex-col">
        {/* Outside the aria-busy subtree: assistive tech holds back updates
            inside a busy region, which would swallow these announcements. */}
        <div role="status" aria-live="polite" data-testid="bundle-export-status" className="sr-only">
          {exportStatusText(busy, error, summary, actionFailed)}
        </div>
        <div aria-busy={busy !== null || (summary === null && !error)} className="flex flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
            <div className="min-w-0">
              <h2 id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
                <PackageOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                Export
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                A portable JSON file. Each Agent keeps its harness and the built-in harness it wraps, so it
                still imports on a machine without that account.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              data-testid="bundle-export-close"
              onClick={requestClose}
              disabled={busy !== null}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </header>

          <div className="space-y-2 p-3 text-xs">
            <div
              ref={summaryRef}
              tabIndex={-1}
              role="region"
              aria-label="Export summary"
              data-testid="bundle-export-summary"
              className="rounded-md border border-border/60 px-3 py-2 outline-none"
            >
              {error ? (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-danger">{error}</span>
                  {errorRetryable && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="bundle-export-retry"
                      className="shrink-0"
                      onClick={() => {
                        setLoadCount((n) => n + 1);
                        // Retry unmounts itself with the error; keep focus in
                        // the dialog rather than let it fall to <body>.
                        summaryRef.current?.focus();
                      }}
                    >
                      <RotateCw className="mr-1 size-3.5" aria-hidden />
                      Retry
                    </Button>
                  )}
                </div>
              ) : summary ? (
                <>
                  <div className="text-sm font-medium">{countsSummary(summary.counts)}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={summary.filename}>
                    {summary.filename}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">Preparing export…</span>
              )}
            </div>
            {summary?.warnings.map((w, i) => (
              <p
                key={i}
                data-testid="bundle-export-warning"
                className="rounded-md bg-warning/10 px-2 py-1 text-warning"
              >
                {w}
              </p>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 p-3">
            <Button
              size="sm"
              variant="outline"
              data-testid="bundle-export-folder"
              {...softDisabled}
              onClick={() => {
                if (!disabled) void save("folder");
              }}
            >
              <FolderOpen className="mr-1 size-3.5" aria-hidden />
              {busy === "folder" ? "Choosing…" : "Choose folder…"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="bundle-export-copy"
              {...softDisabled}
              onClick={() => {
                if (!disabled) void copy();
              }}
            >
              <Clipboard className="mr-1 size-3.5" aria-hidden />
              Copy JSON
            </Button>
            <Button
              size="sm"
              data-testid="bundle-export-downloads"
              {...softDisabled}
              onClick={() => {
                if (!disabled) void save("downloads");
              }}
            >
              <Download className="mr-1 size-3.5" aria-hidden />
              {busy === "downloads" ? "Saving…" : "Save to Downloads"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
