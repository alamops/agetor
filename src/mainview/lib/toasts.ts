import { toast } from "sonner";
import { api } from "./api";

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

// Track active pending toasts so a column-leaves-blocked transition can
// dismiss the matching toast without the caller carrying the id around.
const pendingByTask = new Map<string, string | number>();

function describe(args: ToastArgs): string {
  return args.subtitle ? `${args.title} · ${args.subtitle}` : args.title;
}

function maybeNotifyOS(args: ToastArgs, heading: string, detail?: string): void {
  if (args.isFocused) return;
  // Fire-and-forget — failure (e.g. user denied macOS permission) is silent.
  api.notifyOS({ title: heading, body: detail }).catch(() => { /* ignore */ });
}

export function toastSuccess(args: ToastArgs): void {
  if (args.isSelected) return;
  const detail = describe(args);
  toast.success("Task succeeded", {
    description: detail,
    duration: 6000,
    action: { label: "Open", onClick: args.onOpen },
  });
  maybeNotifyOS(args, "Task succeeded", detail);
}

export function toastError(args: ToastArgs & { reason?: string }): void {
  if (args.isSelected) return;
  const base = describe(args);
  const detail = args.reason ? `${base} — ${args.reason}` : base;
  toast.error("Task failed", {
    description: detail,
    duration: Infinity,
    action: { label: "Open", onClick: args.onOpen },
  });
  maybeNotifyOS(args, "Task failed", detail);
}

/** Shared lifecycle for the two `blocked`-column toasts (`toastPending` for
 *  permission prompts, `toastApiError` for API failures). Both:
 *    • bail when the affected task is the currently mounted panel,
 *    • dismiss any prior pending toast for this task so we don't stack
 *      duplicates if the column re-enters `blocked`,
 *    • register the toast id in `pendingByTask` so a `column-leaves-blocked`
 *      transition can clear it via `dismissPending`,
 *    • use `duration: Infinity` (only user/programmatic dismissal cleans up),
 *    • mirror the heading to the OS notification when the app is unfocused.
 *  Only the sonner severity (warning vs error) and the heading differ — keep
 *  those at the call site so adding a third variant is a two-line change. */
function showBlockingToast(
  variant: { method: typeof toast.warning | typeof toast.error; heading: string },
  args: ToastArgs,
): void {
  if (args.isSelected) return;
  const prior = pendingByTask.get(args.taskId);
  if (prior !== undefined) toast.dismiss(prior);
  const detail = describe(args);
  const id = variant.method(variant.heading, {
    description: detail,
    duration: Infinity,
    action: { label: "Open", onClick: args.onOpen },
    onDismiss: () => {
      if (pendingByTask.get(args.taskId) === id) pendingByTask.delete(args.taskId);
    },
  });
  pendingByTask.set(args.taskId, id);
  maybeNotifyOS(args, variant.heading, detail);
}

export function toastPending(args: ToastArgs): void {
  showBlockingToast({ method: toast.warning, heading: "Waiting on you" }, args);
}

/** Variant of `toastPending` for the `blocked → api-error` transition.
 *  The heading/copy reads as a transient failure to retry rather than
 *  "the agent is waiting on your answer." */
export function toastApiError(args: ToastArgs): void {
  showBlockingToast({ method: toast.error, heading: "API error — retry" }, args);
}

/** Clear the pending toast for a task (called when the task leaves `blocked`). */
export function dismissPending(taskId: string): void {
  const id = pendingByTask.get(taskId);
  if (id === undefined) return;
  toast.dismiss(id);
  pendingByTask.delete(taskId);
}
