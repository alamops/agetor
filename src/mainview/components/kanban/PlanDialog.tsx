import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ClipboardList, Info, Loader2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { ASSISTANT_MD_COMPONENTS } from "./md-components";
import type { AgentKind, Task, TaskPlan } from "../../../shared/types.ts";

/** Status pill for a plan card / the PlanDialog header — same four-state
 *  vocabulary throughout (`pending` / `approved` / `superseded` / `rejected`),
 *  styled with semantic tokens only. Exported so `RunPanel`'s `PlanCard` can
 *  reuse it verbatim rather than re-deriving the label/color mapping — a
 *  one-way import (RunPanel -> PlanDialog) since RunPanel already imports the
 *  `PlanDialog` component from this module. */
export function PlanStatusBadge({ status }: { status: TaskPlan["status"] }) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="border-primary/50 text-primary">
          Awaiting approval
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="outline" className="border-success/50 text-success">
          Approved
        </Badge>
      );
    case "superseded":
      return (
        <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">
          Superseded
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="border-danger/50 text-danger">
          Rejected
        </Badge>
      );
  }
}

interface Props {
  task: Task;
  /** The live plan record — resolved by the caller from `task.plans` on
   *  every render (see `RunPanelBody`'s `openPlan`), so an approval / edit
   *  made from this very dialog (or landing from the 2s poll) is reflected
   *  without a remount. Only genuinely switching to a DIFFERENT plan remounts
   *  this component (the caller keys it by `plan.id`), which is what resets
   *  the local `text`/`mode` state below back to a fresh baseline. */
  plan: TaskPlan;
  /** The task's resolved harness kind (`RunPanelBody`'s `kind`, already
   *  derived via `harnessKindOf` at the call site). Cursor plans are
   *  editable/approvable from this dialog (writes a `.plan.md` file + sends
   *  an approval message via the mutation routes below); claude-code plans
   *  are read-only history — approval happens live in the tmux modal
   *  (`TmuxPromptCard`'s plan branch in RunPanel.tsx), so this dialog only
   *  ever displays a claude plan's content/status, never edits or approves
   *  it. Every mutation affordance (Edit, Revert, Approve, Save & Approve)
   *  is gated on `!claude` below. */
  agentKind: AgentKind;
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
 * Modal for a detected plan — Cursor's `createPlanToolCall` or claude-code's
 * `ExitPlanMode`. For a Cursor plan, `pending` is editable and approvable
 * from here (`editable`, below); `approved`/`superseded` render a read-only
 * view. See `docs/plans/cursor-plan-approval.md` §3-4 for the full
 * approval-flow design this implements. A claude-code plan (`agentKind ===
 * "claude-code"`) is ALWAYS read-only regardless of status — its approval
 * lives entirely in the live tmux modal (`TmuxPromptCard`'s plan branch in
 * RunPanel.tsx), so this dialog is a viewer onto `task.plans` history for
 * claude: content (edited text wins when present), status badge, no
 * edit/approve/revert affordances, per docs/plans/claude-code-plan-mode-and-todo-tracker.md T4.
 */
export function PlanDialog({ task, plan, agentKind, onClose, onPlanUpdated, focusComposer }: Props) {
  const pending = plan.status === "pending";
  const approved = plan.status === "approved";
  // Claude plans are read-only history — approval already happened (or
  // didn't) via the live tmux modal, not through this dialog. `pending`
  // still means "awaiting approval" for a claude plan (set the moment
  // `ExitPlanMode` fires, cleared once the matching tool_result resolves
  // it to `approved`/`rejected`), but there's no in-dialog action that can
  // resolve it, so every edit/approve/revert affordance below is gated on
  // `editable` (= cursor AND pending) rather than bare `pending`.
  const claude = agentKind === "claude-code";
  const editable = !claude && pending;

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
    if (!editable && mode === "edit") setMode("preview");
  }, [editable, mode]);

  // Whitespace-only edits don't count as "edited" — the server rejects a
  // whitespace-only `editedContent` with 400, so an emptied textarea should
  // fall back to approving the original plan (plain "Approve Plan") rather
  // than offering "Save & Approve" against text that will just bounce.
  // Gated on `editable` (not bare `pending`) so a claude plan — which never
  // enters Edit mode, so `text` can only diverge from `plan.content` when
  // `editedContent` was already set at mount (an approved-with-edits plan,
  // which isn't `pending` anyway) — never spuriously shows "Save & Approve".
  const edited = editable && text !== plan.content && text.trim() !== "";
  // NOT gated on `pending`: a plan can supersede while the textarea still
  // holds unsaved text (see the effect above that drops out of Edit mode),
  // and closing should still prompt to save-or-discard that draft even
  // though the plan is no longer pending. The button set shown below is
  // still driven by `status` + `edited`, not `dirty`.
  const dirty = text !== (plan.editedContent ?? plan.content);
  // Read-only views (approved OR superseded) show the persisted edit when
  // there is one — previously this only applied to `approved`, so a
  // superseded plan silently hid an `editedContent` draft behind the
  // original `content`.
  const effectiveContent = plan.editedContent ?? plan.content;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once an approve call fails AFTER the approval message was already
  // delivered to the agent (`ApiError.body.messageSent === true` — the
  // server writes the plan file / auto-sends the message before persisting
  // the `approved` status, so that ordering can fail independently). Once
  // set, Approve/Save & Approve are disabled permanently for this dialog
  // instance — retrying would send a SECOND approval message to the agent.
  const [sentButUnconfirmed, setSentButUnconfirmed] = useState(false);

  // Dirty-close interception: Escape / backdrop / the header X all route
  // through this. `afterClose`, when set, runs once the user has actually
  // decided to close (immediately if not dirty, or after they pick one of
  // the two options below) — "Chat about it" uses it to focus the composer
  // only once the dialog is really gone.
  const [confirmClose, setConfirmClose] = useState<{ afterClose?: () => void } | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const requestClose = (afterClose?: () => void) => {
    // Never close mid-mutation: unmounting while `approvePlan` is in flight
    // would lose the `sentButUnconfirmed` latch, and a reopened dialog (fresh
    // mount, plan still `pending`) would let a second approval message reach
    // the live agent — exactly what the latch exists to prevent.
    if (saving || closeSaving) return;
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

  // Shared by both approve variants below. A 409/404 whose body carries
  // `messageSent: true` means the approval message already reached the
  // live agent session even though the server couldn't persist the plan's
  // `approved` status — that's not a retryable failure (re-clicking Approve
  // would send a second approval message), so it latches
  // `sentButUnconfirmed` instead of leaving the button re-enabled.
  const handleApproveError = (e: unknown) => {
    if (
      e instanceof ApiError &&
      e.body && typeof e.body === "object" &&
      (e.body as { messageSent?: boolean }).messageSent === true
    ) {
      setSentButUnconfirmed(true);
    }
    setError(e instanceof Error ? e.message : String(e));
  };

  const doApprove = async () => {
    // Defensive — the Approve button is never rendered for a claude plan
    // (gated on `editable` below), but guard the mutation itself too: these
    // are cursor-only routes (`api.approvePlan` writes a `.plan.md` file and
    // auto-sends an approval message) and a claude plan's approval already
    // happened live in the tmux modal, so calling this would be a no-op
    // 4xx at best and a wrong second approval message at worst.
    if (claude || saving || sentButUnconfirmed) return;
    setSaving(true);
    setError(null);
    try {
      await checkNoPendingInteractions();
      // The preview shows `text` (the original content on this path), but the
      // server approves `editedContent ?? content` — a stale persisted draft
      // can still exist here (e.g. a revert whose server-side clear failed),
      // and approving it would deliver text the user isn't looking at. Clear
      // it first so what's approved is what's on screen.
      if (plan.editedContent !== null && text === plan.content) {
        onPlanUpdated(await api.savePlanEdit(task.id, plan.id, null));
      }
      const updated = await api.approvePlan(task.id, plan.id);
      onPlanUpdated(updated);
      // Approval succeeded and the message reached the agent — the dialog's
      // job is done. Close directly (not `requestClose`): any persisted draft
      // was reconciled above, so the only local divergence left is a
      // whitespace-only edit that was never saved — an "unsaved edits" prompt
      // after approving would be noise.
      onClose();
    } catch (e) {
      handleApproveError(e);
    } finally {
      setSaving(false);
    }
  };

  const doSaveAndApprove = async () => {
    // Same guard as `doApprove` — cursor-only mutation route.
    if (claude || saving || sentButUnconfirmed) return;
    setSaving(true);
    setError(null);
    try {
      await checkNoPendingInteractions();
      // Publish the save result immediately — if the approve below fails, the
      // parent's `plans` mirror already carries the persisted edit, so the
      // dialog doesn't read falsely dirty until the next poll catches up.
      onPlanUpdated(await api.savePlanEdit(task.id, plan.id, text));
      const updated = await api.approvePlan(task.id, plan.id);
      onPlanUpdated(updated);
      // Same as doApprove — the edit was just persisted, so nothing is dirty.
      onClose();
    } catch (e) {
      handleApproveError(e);
    } finally {
      setSaving(false);
    }
  };

  const doRevert = async () => {
    // Same guard — a claude plan never has a local draft to discard (see
    // `edited`'s comment above), and `api.savePlanEdit` is a cursor-only
    // route, so this must be a no-op for a claude plan regardless.
    if (claude) return;
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
        {editable && (
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
        {editable && mode === "edit" ? (
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
        {sentButUnconfirmed ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" /> The approval was delivered to the agent, but the plan record
            could not be updated — it may refresh shortly.
          </div>
        ) : error && (
          <div className="mb-2 flex items-center gap-2 text-xs text-danger">
            <AlertCircle className="size-3.5 shrink-0" /> {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {editable && edited && (
            <Button size="sm" variant="outline" onClick={() => void doRevert()} disabled={busy}>
              Revert Changes
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={chatAboutIt} disabled={busy}>
            Chat about it
          </Button>
          {editable && (
            <Button
              size="sm"
              onClick={() => void (edited ? doSaveAndApprove() : doApprove())}
              disabled={busy || sentButUnconfirmed}
            >
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
