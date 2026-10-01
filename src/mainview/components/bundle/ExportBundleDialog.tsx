import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clipboard, Download, FolderOpen, PackageOpen, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { countsSummary } from "@/lib/bundle";
import type { BundleExportResponse, BundleSelection } from "../../../shared/bundle.ts";

const TITLE_ID = "bundle-export-title";

type Action = "downloads" | "folder" | "copy";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Export Agents and/or Pipelines as an agetor bundle
 * (docs/plans/agents-pipelines-import-export.md K7/K9). On open it fetches
 * the export once — the summary, the export-time warnings and the text Copy
 * JSON uses — then offers three ways out, since there is no native save
 * dialog: Save to Downloads (revealed in Finder), Copy JSON, or Choose
 * folder. Only one request runs at a time.
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
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open || !selection) return;
    const seq = ++requestRef.current;
    setSummary(null);
    setError(null);
    setBusy(null);
    api.exportBundle(selection).then(
      (res) => {
        if (seq === requestRef.current) setSummary(res);
      },
      (e: unknown) => {
        if (seq === requestRef.current) setError(message(e));
      },
    );
    return () => {
      // A close (or a new selection) drops whatever is still in flight.
      requestRef.current++;
    };
  }, [open, selection]);

  if (!open || !selection) return null;

  const save = async (target: "downloads" | "folder") => {
    setBusy(target);
    try {
      const res = await api.saveBundle(selection, target);
      if ("cancelled" in res) return;
      toast.success(`Exported ${countsSummary(res.counts)}`, {
        description: res.revealed ? `Saved ${res.filename} — revealed in Finder` : `Saved to ${res.path}`,
      });
      onClose();
    } catch (e) {
      const description =
        e instanceof ApiError && e.status === 501
          ? "Choosing a folder isn't available here — use Save to Downloads or Copy JSON."
          : message(e);
      toast.error("Couldn't export", { description, duration: Infinity });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!summary) return;
    setBusy("copy");
    try {
      await navigator.clipboard.writeText(summary.text);
      toast.success(`Copied ${countsSummary(summary.counts)} as JSON`);
      onClose();
    } catch (e) {
      toast.error("Couldn't copy to the clipboard", { description: message(e), duration: Infinity });
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null || summary === null;

  return createPortal(
    <Dialog open={open} onClose={onClose} labelledBy={TITLE_ID} className="max-w-md p-0">
      <div data-testid="bundle-export-dialog" className="flex flex-col">
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
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>

        <div className="space-y-2 p-3 text-xs">
          <div data-testid="bundle-export-summary" className="rounded-md border border-border/60 px-3 py-2">
            {error ? (
              <span className="text-danger">{error}</span>
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
            disabled={disabled}
            onClick={() => void save("folder")}
          >
            <FolderOpen className="mr-1 size-3.5" aria-hidden />
            {busy === "folder" ? "Choosing…" : "Choose folder…"}
          </Button>
          <Button size="sm" variant="outline" data-testid="bundle-export-copy" disabled={disabled} onClick={() => void copy()}>
            <Clipboard className="mr-1 size-3.5" aria-hidden />
            Copy JSON
          </Button>
          <Button size="sm" data-testid="bundle-export-downloads" disabled={disabled} onClick={() => void save("downloads")}>
            <Download className="mr-1 size-3.5" aria-hidden />
            {busy === "downloads" ? "Saving…" : "Save to Downloads"}
          </Button>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
