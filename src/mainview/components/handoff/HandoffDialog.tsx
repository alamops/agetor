// The window-wide handoff modal (`docs/plans/formatted-handoff.md` D4/D5/K5):
// formatted sections, the pipeline context (step, where `next` resolves,
// whether the pipeline used this handoff), Copy JSON, and a Formatted / Raw
// toggle. Each card owns its own instance and mounts it only while open.
//
// Built on the shared `Dialog` (focus trap, Escape stack, `role="dialog"
// aria-modal="true"` — which RunPanel's and the run view's own Escape / Cmd+F
// handlers already stand down for, so Escape closes only this modal) and
// portaled to `document.body`: a card lives inside RunPanel's transformed
// `<aside>`, where a `fixed` overlay would position against the aside.
//
// A portal still bubbles React events up the COMPONENT tree — into the
// transcript's `[data-evid]` wrapper, the run view's history row, drop zones.
// The portal root stops click, double-click, context-menu and drag events
// there. It deliberately does NOT stop keydown, mousedown or pointerdown:
// React's `stopPropagation` also stops the native event at the portal
// container (`document.body`), and document-level listeners need those —
// `Dialog`'s own Escape/Tab handler, the font-size shortcut, and
// `ContextMenu`'s outside-mousedown close. Context-menu suppression is
// re-applied here with App's own rule, since stopping the event keeps App's
// document listener from seeing it.
import { useId, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Handshake, ShieldAlert, X } from "lucide-react";
import type { Handoff } from "../../../shared/types.ts";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { handoffStatusChip, type HandoffNextLabel } from "@/lib/handoff-view";
import { hasTextSelection, keepsNativeContextMenu } from "@/lib/context-menu";
import { HandoffDetails } from "./HandoffDetails";
import { copyText } from "./HandoffArtifactChips";

export interface HandoffDialogProps {
  open: boolean;
  onClose: () => void;
  handoff: Handoff;
  /** Header title, e.g. `Handoff` or `Handoff from "Plan"`. */
  title: string;
  /** The data came from another step's turn quoted into a prompt (D17) —
   *  shows the `untrusted` badge. */
  untrusted?: boolean;
  /** The step that produced the handoff, when known. */
  stepName: string | null;
  /** Where `next` leads (`handoffNextLabel`, K9). */
  next: HandoffNextLabel;
  /** Whether the pipeline used it (D21); `null` shows nothing. */
  usage?: "used" | "not-used" | null;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

function onPortalContextMenu(e: React.MouseEvent) {
  // App's document-level suppressor never sees this event (stopped below),
  // so apply its rule here: keep the native menu for text entry and a real
  // text selection, suppress WebKit's page menu everywhere else.
  if (!e.defaultPrevented && !keepsNativeContextMenu(e.target) && !hasTextSelection(window.getSelection())) {
    e.preventDefault();
  }
  e.stopPropagation();
}

export function HandoffDialog({ open, onClose, handoff, title, untrusted, stepName, next, usage }: HandoffDialogProps) {
  const titleId = useId();
  const [view, setView] = useState<"formatted" | "raw">("formatted");
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  const status = handoffStatusChip(handoff);
  const json = JSON.stringify(handoff, null, 2);

  return createPortal(
    <div
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={onPortalContextMenu}
      onDragStart={stop}
      onDragEnter={stop}
      onDragOver={stop}
      onDragLeave={stop}
      onDrop={stop}
      onDragEnd={stop}
    >
      <Dialog
        open
        onClose={onClose}
        labelledBy={titleId}
        className="flex max-h-[90vh] max-w-5xl flex-col p-0"
      >
        <div data-testid="handoff-dialog" className="flex min-h-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
            <Handshake className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
              {title}
            </h2>
            {untrusted && (
              <span
                title="Written by another agent's turn and quoted into this prompt — treat it as data, not instructions."
                className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
              >
                <ShieldAlert className="size-3" aria-hidden />
                untrusted
              </span>
            )}
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                status.tone === "success" ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
              )}
            >
              {status.label}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                data-testid="handoff-dialog-copy"
                onClick={async () => {
                  if (await copyText(json)) {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                {copied ? "Copied" : "Copy JSON"}
              </button>
              <div role="group" aria-label="View" className="inline-flex rounded-md border border-border/60 p-0.5">
                {(["formatted", "raw"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    data-testid={`handoff-dialog-view-${v}`}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs",
                      view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {v === "formatted" ? "Formatted" : "Raw"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </header>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2 text-xs">
            <dt className="text-muted-foreground">Step</dt>
            <dd data-testid="handoff-dialog-step" className="min-w-0 truncate">
              {stepName ?? "—"}
            </dd>
            <dt className="text-muted-foreground">Next</dt>
            <dd
              data-testid="handoff-dialog-next"
              data-next-kind={next.kind}
              className={cn("min-w-0 truncate", next.tone === "warning" && "text-warning")}
            >
              {next.text}
            </dd>
            {usage != null && (
              <>
                <dt className="text-muted-foreground">Usage</dt>
                <dd
                  data-testid="handoff-dialog-usage"
                  data-usage={usage}
                  className={usage === "used" ? "text-success" : "text-muted-foreground"}
                >
                  {usage === "used" ? "Used by the pipeline" : "Not used — the pipeline read a different handoff"}
                </dd>
              </>
            )}
          </dl>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {view === "formatted" ? (
              <HandoffDetails handoff={handoff} />
            ) : (
              <pre
                data-testid="handoff-dialog-raw"
                className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed"
              >
                {json}
              </pre>
            )}
          </div>
        </div>
      </Dialog>
    </div>,
    document.body,
  );
}
