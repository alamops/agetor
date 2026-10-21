import { toast } from "sonner";
import type { NotificationKind } from "../../shared/os-notification.ts";
import { api } from "./api";
import { filesSentCopy, shouldToastFilesSent } from "./files-sent-notify";
import { FocusedForcedPosts, TaskToastSlots, type TaskToastKind } from "./toast-slots";

/**
 * Args common to every toast helper. `isSelected` / `isFocused` are evaluated
 * at fire time (App.tsx reads `document.hasFocus()` and the `selected` ref);
 * the helpers do not snapshot them. If the affected task is the currently
 * mounted RunPanel we suppress every kind — the user can see the panel live.
 *
 * `subtitle` is rendered alongside the task title in the toast description so
 * users with several similarly-named tasks can disambiguate at a glance
 * (typically "<agent> · <column>" or a short duration).
 */
export interface ToastArgs {
  taskId: string;
  title: string;
  /** Optional short context line (agent kind, duration, etc.). */
  subtitle?: string;
  isSelected: boolean;
  isFocused: boolean;
  onOpen: () => void;
}

// One in-app toast slot per task (D12/D13). Every task-event toast below goes
// through `showTaskToast`: a newer event for a task dismisses that task's
// previous toast and takes the front, so two event toasts for one task never
// coexist. The slot is released when the toast goes away on its own — swipe or
// close (`onDismiss`), timeout (`onAutoClose`) or its "Open" action click.
// sonner fires `onDismiss` for a programmatic `toast.dismiss(id)` too, but the
// release is id-guarded, so the displaced toast can't free its successor's slot.
// "Reason" toasts (waiting / blocked / api-error / session-ended /
// unknown-command) are the ones `dismissPending` clears when the task leaves
// `blocked`; `hasPendingToast` reports them. Action-feedback toasts in App.tsx
// ("Copied", …) are not task events and stay outside the slot.
const slots = new TaskToastSlots();
// Tasks whose OS entry was posted while focused because the event forced it;
// D7 leaves that entry alone until the task is opened (see FocusedForcedPosts).
const focusedForcedPosts = new FocusedForcedPosts();

/** What `showTaskToast`'s `show` callback wires into the sonner call. */
interface SlotLifecycle {
  /** Pass as `onDismiss` and `onAutoClose`. */
  release: () => void;
  /** The "Open" action; releases the slot (sonner's action click fires
   *  neither `onDismiss` nor `onAutoClose`) after running `onOpen`. */
  openAction: { label: string; onClick: (event: { defaultPrevented: boolean }) => void };
}

function showTaskToast(
  taskId: string | undefined,
  kind: TaskToastKind,
  onOpen: () => void,
  show: (lifecycle: SlotLifecycle) => string | number,
): void {
  const prior = taskId ? slots.get(taskId) : undefined;
  if (prior) toast.dismiss(prior.id);
  let id: string | number | undefined;
  const release = () => {
    if (taskId && id !== undefined) slots.release(taskId, id);
  };
  id = show({
    release,
    openAction: {
      label: "Open",
      onClick: (event) => {
        onOpen();
        if (!event.defaultPrevented) release();
      },
    },
  });
  if (taskId) slots.set(taskId, id, kind);
}

function describe(args: ToastArgs): string {
  return args.subtitle ? `${args.title} · ${args.subtitle}` : args.title;
}

function maybeNotifyOS(
  args: ToastArgs,
  kind: NotificationKind,
  heading: string,
  detail?: string,
  opts?: { force?: boolean },
): void {
  const action = focusedForcedPosts.decide(args.taskId, {
    isFocused: args.isFocused,
    force: opts?.force === true,
  });
  if (action === "keep") return;
  if (action === "clear") {
    // D7: the in-app toast carries the news while the window is focused, so the
    // task's older Notification Center entry (if any) is removed, not replaced.
    api.clearTaskNotification(args.taskId).catch(() => { /* ignore */ });
    return;
  }
  // Fire-and-forget — failure (e.g. user denied macOS permission) is silent.
  api.notifyOS({ title: heading, body: detail, taskId: args.taskId, kind }).catch(() => { /* ignore */ });
}

export function toastSuccess(args: ToastArgs & { kind?: "succeeded" | "pipeline-finished" }): void {
  if (args.isSelected) return;
  const kind = args.kind ?? "succeeded";
  const detail = describe(args);
  showTaskToast(args.taskId, kind, args.onOpen, ({ release, openAction }) =>
    toast.success("Task succeeded", {
      description: detail,
      duration: 6000,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
  maybeNotifyOS(args, kind, "Task succeeded", detail);
}

export function toastError(args: ToastArgs & { reason?: string }): void {
  if (args.isSelected) return;
  const base = describe(args);
  const detail = args.reason ? `${base} — ${args.reason}` : base;
  showTaskToast(args.taskId, "failed", args.onOpen, ({ release, openAction }) =>
    toast.error("Task failed", {
      description: detail,
      duration: Infinity,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
  maybeNotifyOS(args, "failed", "Task failed", detail);
}

/** Shared lifecycle for the `blocked`-column toasts (`toastPending` for
 *  permission prompts, plus the api-error / session-ended / unknown-command
 *  variants). All of them:
 *    • bail when the affected task is the currently mounted panel,
 *    • take the task's one toast slot (`showTaskToast` dismisses any prior
 *      toast, so we don't stack duplicates if the column re-enters `blocked`),
 *      which is what lets a `column-leaves-blocked` transition clear it via
 *      `dismissPending`,
 *    • use `duration: Infinity` (only user/programmatic dismissal cleans up),
 *    • mirror the heading to the OS notification when the app is unfocused.
 *  Only the sonner severity (warning vs error), the heading and the kind differ
 *  — keep those at the call site so adding another variant is a two-line
 *  change. */
function showBlockingToast(
  variant: {
    method: typeof toast.warning | typeof toast.error;
    heading: string;
    kind: NotificationKind;
  },
  args: ToastArgs,
): void {
  if (args.isSelected) return;
  const detail = describe(args);
  showTaskToast(args.taskId, variant.kind, args.onOpen, ({ release, openAction }) =>
    variant.method(variant.heading, {
      description: detail,
      duration: Infinity,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
  maybeNotifyOS(args, variant.kind, variant.heading, detail);
}

export function toastPending(args: ToastArgs): void {
  showBlockingToast({ method: toast.warning, heading: "Waiting on you", kind: "blocked" }, args);
}

/** Variant of `toastPending` for the `blocked → api-error` transition.
 *  The heading/copy reads as a transient failure to retry rather than
 *  "the agent is waiting on your answer." */
export function toastApiError(args: ToastArgs): void {
  showBlockingToast({ method: toast.error, heading: "API error — retry", kind: "api-error" }, args);
}

/** Variant of `toastPending` for the `blocked → session-died` transition —
 *  the task's tmux session ended unexpectedly mid-run. Reads as an unexpected
 *  interruption to re-run, not "the agent is waiting on you." */
export function toastSessionEnded(args: ToastArgs): void {
  showBlockingToast({ method: toast.error, heading: "Session ended", kind: "session-ended" }, args);
}

/** Variant of `toastPending` for the `blocked → unknown-command` transition —
 *  claude's TUI rejected the pasted message as an unrecognized slash command,
 *  so the turn never started. Reads as "your message didn't go through," not
 *  "the agent is waiting on you." */
export function toastUnknownCommand(args: ToastArgs): void {
  showBlockingToast(
    { method: toast.error, heading: "Message not delivered", kind: "unknown-command" },
    args,
  );
}

/**
 * Alert the user that a question / permission prompt is waiting on them.
 * Distinct from `toastPending` (the `blocked`-column path) in one crucial way:
 * it fires the native OS notification when the window is unfocused **even if
 * the prompted task is the currently-open panel**. That case — panel open but
 * the agetor window backgrounded behind a long workflow — is exactly when the
 * occluded webview can't repaint the question card, so the notification is the
 * only thing that pulls the user back. The in-app sonner toast is still
 * suppressed for the open panel (the card is already there, or will be the
 * instant the window repaints on focus).
 */
export function notifyWaitingInput(args: ToastArgs): void {
  maybeNotifyOS(args, "waiting", "Waiting on you", describe(args));
  if (args.isSelected) return;
  const detail = describe(args);
  showTaskToast(args.taskId, "waiting", args.onOpen, ({ release, openAction }) =>
    toast.warning("Waiting on you", {
      description: detail,
      duration: Infinity,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
}

/**
 * Alert the user that Claude delivered files via `SendUserFile` (the
 * `files-sent` `GlobalEvent` — see `src/shared/types.ts` and
 * `src/mainview/lib/files-sent-notify.ts` for the pure decision logic this
 * composes). Deliberately not a "reason" toast — a delivered-
 * files toast isn't "waiting on you" and has no blocked-column counterpart
 * to auto-dismiss it, so it's a plain, self-dismissing `toast.info` like
 * `toastSuccess`/`toastError`, not one of the `showBlockingToast` variants.
 * It still takes the task's one toast slot (as a non-reason kind), so
 * `dismissPending` leaves it alone.
 * The native notification bypasses the usual focused-window gate
 * (`maybeNotifyOS`'s `force` option) for a `proactive` send — Claude
 * volunteered the files unprompted, so there's no other signal something
 * just landed, focused window or not. A focused, not-proactive send goes
 * through `maybeNotifyOS` too, which then removes the task's older entry (D7).
 * A forced post made while focused is kept by D7 until the task is opened
 * (`FocusedForcedPosts`), so the turn's own next event doesn't remove it.
 */
export function notifyFilesSent(
  args: ToastArgs & { count: number; caption: string | null; proactive: boolean },
): void {
  const { title, body } = filesSentCopy({ count: args.count, caption: args.caption });
  const description = body ? `${describe(args)} — ${body}` : describe(args);
  // Posts when unfocused or proactive (`force`: Claude volunteered the files,
  // so there's no other signal); a focused, not-proactive send removes the
  // task's older entry instead.
  maybeNotifyOS(args, "files-sent", title, description, { force: args.proactive });
  if (shouldToastFilesSent({ isSelected: args.isSelected, isFocused: args.isFocused })) {
    showTaskToast(args.taskId, "files-sent", args.onOpen, ({ release, openAction }) =>
      toast.info(title, {
        description,
        action: openAction,
        onDismiss: release,
        onAutoClose: release,
      }),
    );
  }
}

/**
 * Alert the user that a message they sent never reached the agent — the
 * `send-failed` `GlobalEvent`, emitted when `sendInput`'s bounded pre-dispatch
 * (session restore, worktree restore, …) finished AFTER the HTTP response had
 * already returned `pending: true`, so the late failure has no request left to
 * carry it. When `savedToBacklog` the server re-stashed the text into the
 * task's backlog tray, so nothing typed is lost.
 *
 * Deliberately NOT gated on `isSelected`/`isFocused`, unlike its siblings: the
 * composer already cleared on the `pending` acceptance, and no run status line
 * exists for this failure (there may be no run at all), so a toast is the only
 * place the user can learn the message didn't go. Self-dismissing after 10 s
 * (long enough to read a sentence-length reason). Like `notifyFilesSent` it
 * takes the task's slot as a non-reason kind — it isn't a "waiting on you"
 * state with a blocked-column counterpart to auto-clear it.
 */
export function toastSendFailed(
  args: Pick<ToastArgs, "taskId" | "title" | "subtitle" | "onOpen"> & {
    reason: string;
    savedToBacklog: boolean;
  },
): void {
  const base = args.subtitle ? `${args.title} · ${args.subtitle}` : args.title;
  const tail = args.savedToBacklog ? " — saved to the task's backlog" : "";
  showTaskToast(args.taskId, "send-failed", args.onOpen, ({ release, openAction }) =>
    toast.warning("Message not sent", {
      description: `${base} — ${args.reason}${tail}`,
      duration: 10_000,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
}

/**
 * Alert the user that the orchestrator's own `fx-auto-resume` engine fired a
 * resume for a paused fx task (see `TaskFxRecovery` / the `fx-auto-resume`
 * `GlobalEvent` in `src/shared/types.ts`). Live-only, like
 * `notifyFilesSent` — a replayed historical `fired` must not re-toast — and
 * deliberately does NOT call `maybeNotifyOS`: auto-resume outcomes are
 * toast-only by design (the plan's §8 explicitly defers an OS notification).
 * Self-dismissing (`toast.info`), matching `toastSuccess`.
 */
export function toastFxAutoResumeFired(args: ToastArgs & { attempt: number; max: number }): void {
  if (args.isSelected) return;
  showTaskToast(args.taskId, "fx-auto-resume-fired", args.onOpen, ({ release, openAction }) =>
    toast.info(`Auto-resuming paused fx response (${args.attempt}/${args.max})…`, {
      description: describe(args),
      duration: 6000,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
}

/**
 * Alert the user that the auto-resume chain hit `FX_AUTO_RESUME_MAX` with no
 * further timer scheduled — the pause is still there, but only a manual
 * Resume will clear it from here. Same live-only / no-OS-notification
 * contract as `toastFxAutoResumeFired`; `duration: Infinity` (like
 * `toastError`) since this needs the user to act, not just notice.
 */
export function toastFxAutoResumeExhausted(args: ToastArgs & { max: number }): void {
  if (args.isSelected) return;
  showTaskToast(args.taskId, "fx-auto-resume-exhausted", args.onOpen, ({ release, openAction }) =>
    toast.error(`Auto-resume gave up after ${args.max} attempts — resume manually once the limit clears`, {
      description: describe(args),
      duration: Infinity,
      action: openAction,
      onDismiss: release,
      onAutoClose: release,
    }),
  );
}

/** Whether a "needs attention" (reason-family) toast is still live in
 *  `taskId`'s slot — i.e. `toastPending`/`toastApiError`/`toastSessionEnded`/
 *  `toastUnknownCommand`/`notifyWaitingInput` showed one and neither the user,
 *  a newer event toast, nor `dismissPending` has cleared it since. App.tsx
 *  reads this for a pipeline PARENT: a hidden step task's own interaction
 *  toast is retargeted at the parent (same `taskId`, same slot), so the
 *  parent's own `blocked`/`pipeline` "Pipeline needs you" toast is suppressed
 *  while that retargeted toast is still up — otherwise one underlying block
 *  would notify twice. */
export function hasPendingToast(taskId: string): boolean {
  return slots.isReason(taskId);
}

/** Clear the reason-family toast for a task (called when the task leaves
 *  `blocked`). Any other toast in the slot (success, failed, files sent, …)
 *  is left alone. */
export function dismissPending(taskId: string): void {
  const entry = slots.take(taskId, { onlyReason: true });
  if (entry) toast.dismiss(entry.id);
}

/** Dismiss whatever event toast holds `taskId`'s slot, whatever its kind
 *  (called when the task's panel or run view is opened, and on archive or
 *  delete). The task's OS entry is removed on those same paths, so a forced
 *  focused post stops being protected from D7 too. */
export function dismissTaskToast(taskId: string): void {
  focusedForcedPosts.forget(taskId);
  const entry = slots.take(taskId);
  if (entry) toast.dismiss(entry.id);
}

/** `dismissTaskToast` for several tasks (a pipeline parent plus its steps). */
export function dismissTaskToastsFor(taskIds: Iterable<string>): void {
  for (const taskId of taskIds) dismissTaskToast(taskId);
}
