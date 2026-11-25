/**
 * The ONE notification decision (grill D5, docs/specs/remote-readiness-spec.md "Push notifications").
 *
 * Before this change two places decided: `headlessNotificationFor` in the headless core and the webview's `maybeNotifyOS`
 * in the open app. Now the core decides, from the same event rules (`notification-events.ts`) and the window facts in
 * `presence.ts`, and tells every registered sink:
 *
 *  - the OS sink (macOS Notification Center through the notifier helper) gets the window rules the webview used to apply:
 *    the task that is open in the window gets no post (unless its kind is exempt), a focused window clears the task's
 *    older entry instead of posting (D7) unless the event forces its post, and everything else posts;
 *  - the phone sink (`remote/push.ts`) gets every decision and applies its own presence rule (needs-you kinds only,
 *    nothing within two minutes of focus).
 *
 * One entry per task is the notifier's job (it posts under `taskNotificationId`). The webview keeps its in-app toasts and
 * no longer calls the notification routes.
 */

import { FocusedForcedPosts } from "../shared/focused-forced-posts.ts";
import {
  notificationUrgency,
  type NotificationKind,
  type NotificationUrgency,
  type TaskNotificationRemoval,
} from "../shared/os-notification.ts";
import type { GlobalEvent, Task } from "../shared/types.ts";
import { createHeadlessNotificationHandler, lookupTaskIn, type NotificationMeta } from "./notification-events.ts";
import * as presenceModule from "./presence.ts";
import type { TaskNotification } from "./task-notifier.ts";

export interface NotificationDecision {
  notification: TaskNotification;
  kind: NotificationKind | undefined;
  urgency: NotificationUrgency;
  meta: NotificationMeta;
}

export interface NotificationSink {
  id: "os" | "phone";
  /** Show or send this notification. For the OS sink this is only called when the decision is "post". */
  deliver(d: NotificationDecision): void | Promise<void>;
  /** Remove a task's entry (answered, unblocked, archived, deleted, or cleared because the window is focused). */
  remove?(r: TaskNotificationRemoval): void;
  /** A notification about a device (paired, revoked), under its own id; only the OS sink handles it. */
  deliverDevice?(n: { deviceId: string; title: string; body: string }): void;
}

/** What the policy does with a notification for the Mac. */
export type OsDecision = "post" | "clear" | "keep" | "skip";

export interface PresenceApi {
  presence: typeof presenceModule.presence;
  onPresenceChange: typeof presenceModule.onPresenceChange;
}

/**
 * The OS decision for one notification. Pure given the presence and the forced-post memory.
 * `skip`: the task is open in the window and its kind is not exempt (the webview returned before `maybeNotifyOS`).
 * `post` / `clear` / `keep`: the D7 rule in `FocusedForcedPosts`.
 */
export function decideOsAction(
  taskId: string | undefined,
  meta: NotificationMeta,
  p: { focused: boolean; selectedTaskId: string | null },
  forced: FocusedForcedPosts,
): OsDecision {
  if (taskId === undefined) return "post";
  if (p.selectedTaskId === taskId && !meta.whenSelected) return "skip";
  return forced.decide(taskId, { isFocused: p.focused, force: meta.force === true });
}

export interface NotificationPolicyDeps {
  /** Subscribe to the global event bus (`subscribeGlobal`). */
  subscribe(fn: (ev: GlobalEvent) => void): () => void;
  /** Read the task rows the handler may need for one event, together. An id that cannot be read maps to null. */
  loadRows(ids: readonly string[]): Promise<ReadonlyMap<string, Task | null>>;
  presence?: PresenceApi;
}

export interface NotificationPolicy {
  registerSink(sink: NotificationSink): () => void;
  /** Remove a task's entry from every sink and forget its forced-post protection. */
  remove(r: TaskNotificationRemoval): void;
  /** Feed one global event; resolves when it has been handled. Used by tests and by the subscription. */
  handleEvent(ev: GlobalEvent): Promise<void>;
  /** Route a notification the caller already built (the CLI's `POST /notifications`) through the same rules. */
  post(n: TaskNotification, meta?: NotificationMeta): void;
  dispose(): void;
}

let installed: NotificationPolicy | null = null;

export function installNotificationPolicy(deps: NotificationPolicyDeps): NotificationPolicy {
  const pres = deps.presence ?? presenceModule;
  const sinks = new Set<NotificationSink>();
  const forced = new FocusedForcedPosts();

  const route = (n: TaskNotification, meta: NotificationMeta = {}): void => {
    const p = pres.presence();
    const decision: NotificationDecision = { notification: n, kind: n.kind, urgency: notificationUrgency(n.kind), meta };
    for (const sink of [...sinks]) {
      try {
        if (sink.id === "os") {
          const action = decideOsAction(n.taskId, meta, p, forced);
          if (action === "post") void Promise.resolve(sink.deliver(decision)).catch(() => { /* a failed post is silent */ });
          else if (action === "clear" && n.taskId) sink.remove?.({ taskId: n.taskId });
        } else {
          void Promise.resolve(sink.deliver(decision)).catch(() => { /* a failed push is silent */ });
        }
      } catch {
        /* one sink must not stop the others */
      }
    }
  };

  // Rows are loaded per event before the synchronous handler reads them.
  let rows: ReadonlyMap<string, Task | null> = new Map();
  const handler = createHeadlessNotificationHandler({
    lookup: (taskId) => lookupTaskIn(rows, taskId),
    readTask: (taskId) => rows.get(taskId) ?? null,
    post: route,
  });

  // Events are handled one at a time, in arrival order: the handler's state depends on it, and `rows` is per event.
  let chain: Promise<void> = Promise.resolve();
  const handleEvent = (ev: GlobalEvent): Promise<void> => {
    chain = chain.then(async () => {
      try {
        rows = await deps.loadRows(handler.taskIdsFor(ev));
        handler(ev);
      } catch (err) {
        console.error("[agetor] notification policy failed:", err);
      }
    });
    return chain;
  };
  const unsubscribe = deps.subscribe((ev) => void handleEvent(ev));

  // Opening a task ends the protection of a forced post made while the window was focused (was `dismissTaskToast`).
  let lastSelected: string | null = pres.presence().selectedTaskId;
  const unwatch = pres.onPresenceChange((p) => {
    if (p.selectedTaskId !== null && p.selectedTaskId !== lastSelected) forced.forget(p.selectedTaskId);
    lastSelected = p.selectedTaskId;
  });

  const policy: NotificationPolicy = {
    registerSink(sink) {
      sinks.add(sink);
      return () => void sinks.delete(sink);
    },
    remove(r) {
      forced.forget(r.taskId);
      for (const sink of [...sinks]) {
        try {
          sink.remove?.(r);
        } catch {
          /* ignore */
        }
      }
    },
    handleEvent,
    post: route,
    dispose() {
      unsubscribe();
      unwatch();
      sinks.clear();
      if (installed === policy) installed = null;
    },
  };
  installed = policy;
  return policy;
}

/** A notification about a device (paired, revoked, a session ended). Goes through the OS sink under its own id; a no-op without one. */
export function postDeviceNotification(n: { deviceId: string; title: string; body: string }): void {
  // Reads the installed policy's sinks through a registered device hook so remote modules need no policy handle.
  for (const hook of deviceHooks) {
    try {
      hook(n);
    } catch {
      /* ignore */
    }
  }
}

const deviceHooks = new Set<(n: { deviceId: string; title: string; body: string }) => void>();

/** The OS sink registers here to receive device notifications. Returns an unregister function. */
export function registerDeviceNotificationHook(fn: (n: { deviceId: string; title: string; body: string }) => void): () => void {
  deviceHooks.add(fn);
  return () => void deviceHooks.delete(fn);
}

export function currentNotificationPolicy(): NotificationPolicy | null {
  return installed;
}
