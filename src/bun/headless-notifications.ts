/**
 * OS notifications for a core that has no desktop app around it (the
 * background login-item core, `agetor daemon start`): the same
 * notifications the webview raises through `maybeNotifyOS`
 * (src/mainview/lib/toasts.ts, call sites in App.tsx's global-event handler),
 * minus the rules that depend on a window — nothing here knows whether a
 * panel is open or the app is focused, so every qualifying event posts. The
 * titles, bodies and kinds are copied from the webview so a headless
 * notification reads exactly like an app one, and the task notifier posts it
 * under the same per-task id (`taskNotificationId`), so the entry replaces
 * and escalates the way the app's does.
 *
 * `headlessNotificationFor` is the pure policy (event + task lookup in,
 * notification out); `installHeadlessNotifications` wires it to the global
 * event bus, the task notifier and the removal hooks. There is no plain
 * `Utils.showNotification` fallback headless — without the AgetorNotifier
 * helper nothing is shown (D12/C19).
 *
 * No side effects at module load.
 */

import { tasks } from "./db.ts";
import { installNotificationRemovalHooks } from "./notification-hooks.ts";
import { subscribeGlobal } from "./orchestrator.ts";
import type { ApiNative } from "./server.ts";
import { createTaskNotifier, type TaskNotification } from "./task-notifier.ts";
import type { TaskNotificationRemoval } from "../shared/os-notification.ts";
import type { GlobalEvent, PipelineRunStatus } from "../shared/types.ts";

/** What the installer hands to the core's notifier; the same shape `startApiServer` takes. */
export type HeadlessNotificationSink = {
  post(n: Parameters<ApiNative["showNotification"]>[0]): void;
  remove(r: TaskNotificationRemoval): void;
};

/** The slice of a task row the policy needs for display. */
export interface HeadlessTaskInfo {
  title: string;
  /** The harness id; the webview's toast subtitle for an ordinary task. */
  agent?: string | null;
  /** A pipeline parent's run name, used to trim a step title's prefix. */
  pipelineName?: string | null;
}

export type HeadlessTaskLookup = (taskId: string) => HeadlessTaskInfo | null;

/** State the pure policy cannot derive from one event. */
export interface HeadlessNotificationContext {
  /** The pipeline parent's previous run status; "done" is notified on the transition only. */
  prevPipelineStatus?: PipelineRunStatus | null;
}

/** The reason text the webview shows for an orphaned run (App.tsx). */
const ORPHANED_REASON = "agetor restarted while running";

// Same copy as src/mainview/lib/files-sent-notify.ts `filesSentCopy`; that
// module sits on the webview side of the process split, so the few lines are
// repeated here rather than imported across it.
const CAPTION_BODY_MAX_CHARS = 120;

function filesSentCopy(count: number, caption: string | null): { title: string; body: string | null } {
  const title = count === 1 ? "1 file sent to you" : `${count} files sent to you`;
  if (caption === null) return { title, body: null };
  const firstLine = caption.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return { title, body: null };
  return {
    title,
    body: firstLine.length > CAPTION_BODY_MAX_CHARS ? firstLine.slice(0, CAPTION_BODY_MAX_CHARS) + "…" : firstLine,
  };
}

/** A step row's title is `<pipeline name> · <step name>`; the toast names only the step. */
function stepSubtitle(step: HeadlessTaskInfo | null, parent: HeadlessTaskInfo | null): string | undefined {
  if (!step) return undefined;
  const prefix = parent?.pipelineName;
  const sep = " · ";
  if (prefix && step.title.startsWith(`${prefix}${sep}`)) return step.title.slice(prefix.length + sep.length);
  return step.title;
}

function stepParentIdOf(ev: GlobalEvent): string | null {
  if (!("pipelineParentId" in ev)) return null;
  return ev.pipelineParentId ? ev.pipelineParentId : null;
}

function stepParentTitleOf(ev: GlobalEvent): string | null {
  if (!("pipelineParentTitle" in ev)) return null;
  return ev.pipelineParentTitle ? ev.pipelineParentTitle : null;
}

/**
 * The notification a global event implies, or null.
 *
 * Mirrors the webview, without its window rules:
 * - `interaction` pending → "Waiting on you". (The webview raises it once per
 *   task, on the first of several stacked prompts; that bookkeeping needs
 *   state across events, so the installer owns it.)
 * - `run-status` succeeded → "Task succeeded"; failed / orphaned → "Task
 *   failed"; cancelled → none (the user asked for it).
 * - `column` → blocked, by reason: api-error, session-died ("Session ended"),
 *   unknown-command, pipeline (none — a step's question already notified),
 *   anything else "Waiting on you".
 * - `files-sent` → "N files sent to you".
 * - `pipeline` → done, on the transition into it → "Task succeeded" with the
 *   `pipeline-finished` kind.
 *
 * A hidden pipeline step's events are retargeted at its parent (title = the
 * parent's, body names the step, `taskId` = the parent) for the user-facing
 * kinds; a step's own run settling or blocked transition is never notified.
 */
export function headlessNotificationFor(
  ev: GlobalEvent,
  lookup: HeadlessTaskLookup,
  ctx: HeadlessNotificationContext = {},
): TaskNotification | null {
  if (ev.kind === "update" || ev.kind === "send-failed" || ev.kind === "fx-auto-resume") return null;

  const stepParentId = stepParentIdOf(ev);

  if (ev.kind === "pipeline") {
    if (ev.status !== "done" || ctx.prevPipelineStatus === "done") return null;
    const title = lookup(ev.taskId)?.title || `Pipeline ${ev.taskId.slice(0, 7)}`;
    return {
      title: "Task succeeded",
      body: `${title} · Pipeline finished`,
      taskId: ev.taskId,
      kind: "pipeline-finished",
    };
  }

  // Resolve who the notification names: the task itself, or for a hidden step
  // its pipeline parent with the step as the subtitle.
  const task = lookup(ev.taskId);
  let taskId = ev.taskId;
  let title = task?.title || `Task ${ev.taskId.slice(0, 7)}`;
  let subtitle: string | undefined = task?.agent || undefined;
  if (stepParentId) {
    const parent = lookup(stepParentId);
    taskId = stepParentId;
    title = parent?.title || stepParentTitleOf(ev) || `Pipeline ${stepParentId.slice(0, 7)}`;
    subtitle = stepSubtitle(task, parent);
  }
  const describe = subtitle ? `${title} · ${subtitle}` : title;

  switch (ev.kind) {
    case "interaction":
      if (ev.state !== "pending") return null;
      return { title: "Waiting on you", body: describe, taskId, kind: "waiting" };

    case "run-status": {
      // A step's own run settling never notifies; the parent's pipeline
      // events are the user-facing signal.
      if (stepParentId) return null;
      if (ev.status === "succeeded") {
        return { title: "Task succeeded", body: describe, taskId, kind: "succeeded" };
      }
      if (ev.status === "failed" || ev.status === "orphaned") {
        const body = ev.status === "orphaned" ? `${describe} — ${ORPHANED_REASON}` : describe;
        return { title: "Task failed", body, taskId, kind: "failed" };
      }
      return null;
    }

    case "column": {
      if (ev.column !== "blocked" || stepParentId) return null;
      if (ev.reason === "api-error") {
        return { title: "API error — retry", body: describe, taskId, kind: "api-error" };
      }
      if (ev.reason === "session-died") {
        return { title: "Session ended", body: describe, taskId, kind: "session-ended" };
      }
      if (ev.reason === "unknown-command") {
        return { title: "Message not delivered", body: describe, taskId, kind: "unknown-command" };
      }
      // The parent's "pipeline" block: the step's own question already posted
      // "Waiting on you" for this parent.
      if (ev.reason === "pipeline") return null;
      return { title: "Waiting on you", body: describe, taskId, kind: "blocked" };
    }

    case "files-sent": {
      const copy = filesSentCopy(ev.count, ev.caption);
      return {
        title: copy.title,
        body: copy.body ? `${describe} — ${copy.body}` : describe,
        taskId,
        kind: "files-sent",
      };
    }

    default:
      return null;
  }
}

/**
 * Whether this core should post OS notifications. `AGETOR_HEADLESS_NOTIFICATIONS`:
 * "0" turns it off anywhere, "1" forces it on; unset it is on except under
 * `NODE_ENV=test` (the e2e backend sets "0" for the same reason). Only macOS
 * has the helper.
 */
export function isHeadlessNotificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "darwin") return false;
  const flag = env.AGETOR_HEADLESS_NOTIFICATIONS;
  if (flag === "0") return false;
  if (flag === "1") return true;
  return env.NODE_ENV !== "test";
}

function lookupTask(taskId: string): HeadlessTaskInfo | null {
  try {
    const t = tasks.get(taskId);
    if (!t) return null;
    return { title: t.title, agent: t.agent, pipelineName: t.pipelineRun?.pipelineName ?? null };
  } catch {
    return null;
  }
}

/** Bound on remembered pipeline statuses; a core runs for days, pipelines accumulate. */
const PIPELINE_STATUS_CAP = 500;

/**
 * Builds the core's task notifier, seeds it, installs the removal hooks and
 * subscribes the notification policy to the global event bus. `sink` is what
 * `startApiServer` takes as `notifications`, so `POST /notifications` and
 * `DELETE /notifications/:taskId` share the notifier's queue and dedupe.
 */
export function installHeadlessNotifications(): { sink: HeadlessNotificationSink; dispose(): void } {
  // No plain fallback: without the helper there is nothing to show (C19).
  const notifier = createTaskNotifier({ plain: () => {} });
  void notifier.seed().catch(() => { /* a failed seed only skips removal pruning */ });
  const unhook = installNotificationRemovalHooks((r) => notifier.remove(r));

  // The webview's once-per-task rule for stacked prompts, keyed on whoever
  // the notification names (a step's prompts collapse onto its parent).
  const pendingByTarget = new Map<string, Set<string>>();
  const pipelineStatus = new Map<string, PipelineRunStatus>();

  const handle = (ev: GlobalEvent): void => {
    const target = stepParentIdOf(ev) ?? ("taskId" in ev ? ev.taskId : "");
    let prevPipelineStatus: PipelineRunStatus | null = null;

    if (ev.kind === "interaction") {
      let set = pendingByTarget.get(target);
      if (ev.state === "pending") {
        if (!set) pendingByTarget.set(target, (set = new Set()));
        const first = set.size === 0;
        set.add(ev.interactionId);
        if (!first) return;
      } else {
        set?.delete(ev.interactionId);
        if (set && set.size === 0) pendingByTarget.delete(target);
        return;
      }
    } else if (ev.kind === "run-status") {
      // A terminal run supersedes its prompts; a stale id would suppress the
      // first-prompt alert of the next run.
      pendingByTarget.delete(ev.taskId);
    } else if (ev.kind === "pipeline") {
      prevPipelineStatus = pipelineStatus.get(ev.taskId) ?? null;
      pipelineStatus.delete(ev.taskId);
      pipelineStatus.set(ev.taskId, ev.status);
      if (pipelineStatus.size > PIPELINE_STATUS_CAP) {
        const oldest = pipelineStatus.keys().next().value;
        if (oldest !== undefined) pipelineStatus.delete(oldest);
      }
      if (ev.status !== "blocked") pendingByTarget.delete(ev.taskId);
    }

    const n = headlessNotificationFor(ev, lookupTask, { prevPipelineStatus });
    if (n) notifier.post(n);
  };

  const unsubscribe = subscribeGlobal((ev) => {
    try {
      handle(ev);
    } catch (err) {
      console.error("[agetor] headless notification failed:", err);
    }
  });

  return {
    sink: {
      post: (n) => notifier.post(n),
      remove: (r) => notifier.remove(r),
    },
    dispose() {
      unsubscribe();
      unhook();
    },
  };
}
