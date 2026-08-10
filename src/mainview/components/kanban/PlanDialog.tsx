import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ClipboardList, Loader2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ASSISTANT_MD_COMPONENTS, PlanStatusBadge } from "./RunPanel";
import type { Task, TaskPlan } from "../../../shared/types.ts";

interface Props {
  task: Task;
  /** The live plan record — resolved by the caller from `task.plans` on
   *  every render (see `RunPanelBody`'s `openPlan`), so an approval / edit
   *  made from this very dialog (or landing from the 2s poll) is reflected
   *  without a remount. Only genuinely switching to a DIFFERENT plan remounts
   *  this component (the caller keys it by `plan.id`), which is what resets
   *  the local `text`/`mode` state below back to a fresh baseline. */
  plan: TaskPlan;
  onClose: () => void;
  /** Called with the fresh `Task` after any successful mutation (save,
   *  revert, approve) — the caller re-syncs its `plans` mirror from it. This
   *  is the same "returned Task is authoritative" pattern the messages
   *  backlog mutations use (see `RunPanelBody`'s `addBacklogItem` etc.):
   *  there's no dedicated task-refresh channel from this panel up to App, so
   *  reflecting an approval immediately relies on the endpoint's own
   *  response rather than waiting for the next board poll. */
  onPlanUpdated: (task: Task) => void;
  /** Close (respecting the dirty-close prompt) and focus the run panel's
   *  composer — wired to `RunPanelBody`'s `sendRef` via the same
   *  `requestAnimationFrame` idiom `MessageHistoryPicker` uses. */
  focusComposer: () => void;
}

/**
 * Modal for a detected Cursor plan (`createPlanToolCall`). While `pending`,
 * the plan is editable and approvable; `approved`/`superseded` render a
 * read-only view. See `docs/plans/cursor-plan-approval.md` §3-4 for the full
 * approval-flow design this implements.
 */
export function PlanDialog({ task, plan, onClose, onPlanUpdated, focusComposer }: Props) {
  const pending = plan.status === "pending";
  const approved = plan.status === "approved";

  // Local draft text — seeded once from the plan the dialog opened with (this
  // component is keyed by `plan.id` at the call site, so a genuine plan
  // switch remounts and reseeds; the same plan's `editedContent` changing
  // in place — e.g. a stale-poll race — does NOT reseed, matching the house
  // "no autosave / no flush-on-unmount" rule: local edits are the source of
  // truth until an explicit Save action writes them out).
  const [text, setText] = useState(plan.editedContent ?? plan.content);
  const [mode, setMode] = useState<"preview" | "edit">("preview");

  // A plan can transition pending -> superseded WHILE this dialog is open
  // (a newer run lands another plan) since `plan` re-resolves from the live
  // `task.plans` on every render. Drop out of Edit mode when that happens so
  // a stale textarea doesn't linger under a now-read-only plan.
  useEffect(() => {
    if (!pending && mode === "edit") setMode("preview");
  }, [pending, mode]);

  const edited = pending && text !== plan.content;
  const dirty = pending && text !== (plan.editedContent ?? plan.content);
  const effectiveContent = approved ? (plan.editedContent ?? plan.content) : plan.content;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dirty-close interception: Escape / backdrop / the header X all route
  // through this. `afterClose`, when set, runs once the user has actually
  // decided to close (immediately if not dirty, or after they pick one of
  // the two options below) — "Chat about it" uses it to focus the composer
  // only once the dialog is really gone.
  const [confirmClose, setConfirmClose] = useState<{ afterClose?: () => void } | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const requestClose = (afterClose?: () => void) => {
    if (dirty) {
      setCloseError(null);
      setConfirmClose({ afterClose });
      return;
    }
    onClose();
    afterClose?.();
  };

  const closeWithoutSaving = () => {
    const afterClose = confirmClose?.afterClose;
    setConfirmClose(null);
    onClose();
    afterClose?.();
  };

  const saveAndClose = async () => {
    if (closeSaving) return;
    setCloseSaving(true);
    setCloseError(null);
    try {
      const updated = await api.savePlanEdit(task.id, plan.id, text);
      onPlanUpdated(updated);
      const afterClose = confirmClose?.afterClose;
      setConfirmClose(null);
      onClose();
      afterClose?.();
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloseSaving(false);
    }
  };

  const chatAboutIt = () => requestClose(focusComposer);

  // Re-check right before either approve variant delivers — load-bearing
  // recipe from DiffDialog's `doSend`: approving auto-sends a message to a
  // live agent, and a message reaching a native prompt would paste into the
  // prompt instead of the agent.
  const checkNoPendingInteractions = async () => {
    const list = await api.listPendingInteractions(task.id);
    if (list.length > 0) {
      throw new Error("A prompt is waiting for a response on this task — resolve it, then approve the plan.");
    }
  };

  const doApprove = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await checkNoPendingInteractions();
      const updated = await api.approvePlan(task.id, plan.id);
      onPlanUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const doSaveAndApprove = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await checkNoPendingInteractions();
      await api.savePlanEdit(task.id, plan.id, text);
      const updated = await api.approvePlan(task.id, plan.id);
      onPlanUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const doRevert = async () => {
    setText(plan.content);
    // No persisted draft to clear — a purely-local edit that was never
    // saved, so there's nothing to round-trip through the server.
    if (plan.editedContent === null) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.savePlanEdit(task.id, plan.id, null);
      onPlanUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || closeSaving;

  return (
    <Dialog
      open
      onClose={() => requestClose()}
      labelledBy="plan-dialog-title"
      className="flex max-h-[85vh] w-full max-w-2xl flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="plan-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{plan.name ?? "Implementation plan"}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <PlanStatusBadge status={plan.status} />
            {plan.status === "superseded" && (
              <span className="text-[10px] text-muted-foreground">
                A newer plan replaced this one before it was approved.
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => requestClose()} aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pending && (
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide",
                mode === "preview" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMode("edit")}
              disabled={busy}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide disabled:opacity-50",
                mode === "edit" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              Edit
            </button>
          </div>
        )}
        {pending && mode === "edit" ? (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            className="min-h-[320px] font-mono text-xs"
          />
        ) : (
          <div className="agetor-md text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS}>
              {pending ? text : effectiveContent}
            </ReactMarkdown>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 p-3">
        {error && (
          <div className="mb-2 flex items-center gap-2 text-xs text-danger">
            <AlertCircle className="size-3.5 shrink-0" /> {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {pending && edited && (
            <Button size="sm" variant="outline" onClick={() => void doRevert()} disabled={busy}>
              Revert Changes
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={chatAboutIt} disabled={busy}>
            Chat about it
          </Button>
          {pending && (
            <Button size="sm" onClick={() => void (edited ? doSaveAndApprove() : doApprove())} disabled={busy}>
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              {edited ? "Save & Approve" : "Approve Plan"}
            </Button>
          )}
          {approved && (
            <Button size="sm" disabled>
              Approved
            </Button>
          )}
        </div>
      </div>

      {confirmClose && (
        <Dialog open onClose={() => setConfirmClose(null)} labelledBy="plan-dialog-unsaved-title" className="max-w-sm">
          <h2 id="plan-dialog-unsaved-title" className="text-sm font-semibold">
            You have unsaved plan edits
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Save your edits as a draft before closing, or discard them.
          </p>
          {closeError && (
            <div className="mt-2 flex items-center gap-2 text-xs text-danger">
              <AlertCircle className="size-3.5 shrink-0" /> {closeError}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={closeWithoutSaving} disabled={closeSaving}>
              Close without saving
            </Button>
            <Button onClick={() => void saveAndClose()} disabled={closeSaving}>
              {closeSaving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Save & close
            </Button>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
