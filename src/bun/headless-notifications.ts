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
import type { GlobalEvent, PipelineRunState, PipelineRunStatus } from "../shared/types.ts";

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
  /**
   * A question is pending for the notification's target (a pipeline parent's
   * own, or any of its steps'). A parent's `reason: "pipeline"` block then
   * stays silent: the step's retargeted "Waiting on you" already holds the
   * task's one notification, and the "Pipeline needs you" alert is owed
   * instead (see {@link decideOwedPipelineAlert}).
   */
  hasPendingQuestion?: boolean;
}

/** The body of the "Pipeline needs you" notification, as the webview words it. */
function pipelineNeedsYou(taskId: string, lookup: HeadlessTaskLookup): TaskNotification {
  const title = lookup(taskId)?.title || `Pipeline ${taskId.slice(0, 7)}`;
  return { title: "Waiting on you", body: `${title} · Pipeline needs you`, taskId, kind: "blocked" };
}

/**
 * What to do with a pipeline parent's owed "Pipeline needs you" alert given its
 * current row — the headless twin of `OwedPipelineAlerts.decide`
 * (src/mainview/lib/owed-pipeline-alerts.ts; that module is on the webview side
 * of the process split, so the rule is repeated here). `raise` while the run is
 * blocked on something other than a question the user already answered
 * (`answered` step task ids: the runner records an unanswered-at-settle
 * question as a `step-blocked` block that lasts until the step runs again) or a
 * step that runs again (the runner clears that step's blocks asynchronously);
 * `wait` while those are the only blocks; `drop` once the run left `blocked` or
 * the parent is archived or gone.
 */
export function decideOwedPipelineAlert(
  answered: ReadonlySet<string>,
  parent: { archivedAt?: number | null; pipelineRun?: Pick<PipelineRunState, "status" | "blocked"> | null } | null,
  isStepRunning: (taskId: string) => boolean,
): "raise" | "wait" | "drop" {
  const run = parent?.pipelineRun;
  if (!parent || parent.archivedAt != null || !run || run.status !== "blocked") return "drop";
  const blocked = run.blocked.some((b) => {
    if (b.taskId === null) return true;
    if (b.kind === "step-blocked" && answered.has(b.taskId)) return false;
    return !isStepRunning(b.taskId);
  });
  return blocked ? "raise" : "wait";
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
 *   unknown-command, pipeline ("Pipeline needs you", unless a question is
 *   pending — see `ctx.hasPendingQuestion`), anything else "Waiting on you".
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
      // The parent's "pipeline" block ("Pipeline needs you"): silent only while
      // a step's question holds the parent's notification; a block with no
      // question behind it (step-failed, handoff-missing, step-cap, …) would
      // otherwise never reach the user.
      if (ev.reason === "pipeline") {
        return ctx.hasPendingQuestion ? null : pipelineNeedsYou(taskId, lookup);
      }
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

/** What the stateful handler needs from the outside; injected so tests drive it without the bus or the db. */
export interface HeadlessHandlerDeps {
  lookup: HeadlessTaskLookup;
  /** A task row's column and pipeline run, or null when unknown. */
  readTask(taskId: string): {
    column?: string | null;
    archivedAt?: number | null;
    pipelineRun?: Pick<PipelineRunState, "status" | "blocked"> | null;
  } | null;
  post(n: TaskNotification): void;
}

/**
 * The stateful half of the policy: the once-per-task rule for stacked prompts,
 * the done-transition memory and the owed "Pipeline needs you" alerts, on top
 * of the pure {@link headlessNotificationFor}. Returns the per-event handler.
 */
export function createHeadlessNotificationHandler(deps: HeadlessHandlerDeps): (ev: GlobalEvent) => void {
  const { lookup: lookupTask, readTask } = deps;
  const notifier = { post: deps.post };

  // The webview's once-per-task rule for stacked prompts, keyed on whoever
  // the notification names (a step's prompts collapse onto its parent).
  const pendingByTarget = new Map<string, Set<string>>();
  const pipelineStatus = new Map<string, PipelineRunStatus>();
  // Pipeline parents whose "Pipeline needs you" alert is owed (a step's question
  // held the parent's notification while the run was, or became, blocked), each
  // with the step tasks whose questions were answered since. Mirrors the
  // webview's OwedPipelineAlerts.
  const owed = new Map<string, Set<string>>();

  const hasPending = (target: string): boolean => (pendingByTarget.get(target)?.size ?? 0) > 0;
  const owe = (parentId: string): void => {
    if (!owed.has(parentId)) owed.set(parentId, new Set());
  };
  /** Raises the owed alert once no question is left and the run is still blocked on something else. */
  const settleOwed = (parentId: string): void => {
    const answered = owed.get(parentId);
    if (!answered || hasPending(parentId)) return;
    const decision = decideOwedPipelineAlert(answered, readTask(parentId), (id) => readTask(id)?.column === "running");
    if (decision === "wait") return;
    owed.delete(parentId);
    if (decision === "raise") notifier.post(pipelineNeedsYou(parentId, lookupTask));
  };

  const handle = (ev: GlobalEvent): void => {
    const stepParentId = stepParentIdOf(ev);
    const target = stepParentId ?? ("taskId" in ev ? ev.taskId : "");
    let prevPipelineStatus: PipelineRunStatus | null = null;

    if (ev.kind === "interaction") {
      let set = pendingByTarget.get(target);
      if (ev.state === "pending") {
        if (!set) pendingByTarget.set(target, (set = new Set()));
        const first = set.size === 0;
        set.add(ev.interactionId);
        if (!first) return;
        // The question takes over the parent's one notification; if the run is
        // already blocked, the "Pipeline needs you" it replaces is owed again
        // once the question is answered.
        if (stepParentId) {
          const parent = readTask(stepParentId);
          if (parent?.column === "blocked" || parent?.pipelineRun?.status === "blocked") owe(stepParentId);
        }
      } else {
        set?.delete(ev.interactionId);
        if (set && set.size === 0) pendingByTarget.delete(target);
        if (stepParentId) owed.get(stepParentId)?.add(ev.taskId);
        settleOwed(target);
        return;
      }
    } else if (ev.kind === "run-status") {
      // A terminal run supersedes its prompts; a stale id would suppress the
      // first-prompt alert of the next run.
      pendingByTarget.delete(ev.taskId);
    } else if (ev.kind === "column") {
      // A step running again ends the "answered question" exemption for its blocks.
      if (stepParentId && ev.column === "running") owed.get(stepParentId)?.delete(ev.taskId);
      if (!stepParentId && ev.column === "blocked" && ev.reason === "pipeline" && hasPending(ev.taskId)) {
        owe(ev.taskId);
      }
    } else if (ev.kind === "pipeline") {
      prevPipelineStatus = pipelineStatus.get(ev.taskId) ?? null;
      pipelineStatus.delete(ev.taskId);
      pipelineStatus.set(ev.taskId, ev.status);
      if (pipelineStatus.size > PIPELINE_STATUS_CAP) {
        const oldest = pipelineStatus.keys().next().value;
        if (oldest !== undefined) pipelineStatus.delete(oldest);
      }
      if (ev.status !== "blocked") {
        pendingByTarget.delete(ev.taskId);
        owed.delete(ev.taskId);
      } else {
        settleOwed(ev.taskId);
      }
    }

    const n = headlessNotificationFor(ev, lookupTask, { prevPipelineStatus, hasPendingQuestion: hasPending(target) });
    if (n) notifier.post(n);
  };

  return handle;
}

/**
 * Builds the core's task notifier, seeds it, installs the removal hooks and
 * subscribes the notification policy to the global event bus. `sink` is what
 * `startApiServer` takes as `notifications`, so `POST /notifications` and
 * `DELETE /notifications/:taskId` share the notifier's queue and dedupe. The
 * headless core installs its own removal hooks here (the desktop app installs
 * them in index.ts instead), so an answered or unblocked task's entry goes away.
 */
export function installHeadlessNotifications(): { sink: HeadlessNotificationSink; dispose(): void } {
  // No plain fallback: without the helper there is nothing to show (C19).
  const notifier = createTaskNotifier({ plain: () => {} });
  void notifier.seed().catch(() => { /* a failed seed only skips removal pruning */ });
  const unhook = installNotificationRemovalHooks((r) => notifier.remove(r));

  const handle = createHeadlessNotificationHandler({
    lookup: lookupTask,
    readTask: (taskId) => {
      try {
        return tasks.get(taskId) ?? null;
      } catch {
        return null;
      }
    },
    post: (n) => notifier.post(n),
  });

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
