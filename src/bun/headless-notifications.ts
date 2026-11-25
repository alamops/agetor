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
 * The event → notification rules live in `notification-events.ts` (re-exported here) and the window rules (selected, focused,
 * presence) in `notification-policy.ts`; this module installs both for a core with no window of its own.
 *
 * No side effects at module load.
 */

import { tasks } from "./db-async.ts";

import { resolveNotifier } from "./notifier.ts";
import { installNotificationRemovalHooks } from "./notification-hooks.ts";
import { installNotificationPolicy } from "./notification-policy.ts";
import { subscribeGlobal } from "./orchestrator.ts";
import type { ApiNative } from "./server.ts";
import { createTaskNotifier } from "./task-notifier.ts";
import type { TaskNotificationRemoval } from "../shared/os-notification.ts";
import type { Task } from "../shared/types.ts";

export * from "./notification-events.ts";

/** What the installer hands to the core's notifier; the same shape `startApiServer` takes. */
export type HeadlessNotificationSink = {
  post(n: Parameters<ApiNative["showNotification"]>[0]): void;
  remove(r: TaskNotificationRemoval): void;
};

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

/**
 * Whether this core should wire the notification sink: the policy above AND a
 * notifier helper that actually resolves (the same `resolveNotifier` the task
 * notifier posts through). With no helper there is nothing to show — there is
 * no plain fallback headless — so a sink would swallow `POST /notifications`
 * as a 200 and the CLI's `logs --notify` would never fall back to the installed
 * app's helper. Without a sink that route stays 501 and the fallback runs.
 * `resolve` is a test seam.
 */
export function shouldPostHeadlessNotifications(
  env: NodeJS.ProcessEnv = process.env,
  resolve: () => string | null = () => resolveNotifier({ env }),
): boolean {
  return isHeadlessNotificationsEnabled(env) && resolve() !== null;
}

/** Task rows for `ids`, read together; an id that cannot be read maps to null. */
async function fetchTaskRows(ids: readonly string[]): Promise<Map<string, Task | null>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  const rows = await Promise.all(unique.map(async (id) => {
    try {
      return [id, (await tasks.get(id)) ?? null] as const;
    } catch {
      return [id, null] as const;
    }
  }));
  return new Map(rows);
}

/**
 * Builds the core's task notifier, seeds it, installs the removal hooks and
 * subscribes the notification policy to the global event bus. `sink` is what
 * `startApiServer` takes as `notifications`, so `POST /notifications` and
 * `DELETE /notifications/:taskId` share the notifier's queue and dedupe. The
 * headless core installs its own removal hooks here (the desktop app installs
 * them in index.ts instead), so an answered or unblocked task's entry goes away.
 *
 * A headless core has no window: presence says "not focused, nothing selected" (see presence.ts),
 * so every qualifying event posts, as it always did.
 */
export function installHeadlessNotifications(): {
  sink: HeadlessNotificationSink;
  policy: ReturnType<typeof installNotificationPolicy>;
  dispose(): void;
} {
  // No plain fallback: without the helper there is nothing to show (C19).
  const notifier = createTaskNotifier({ plain: () => {} });
  void notifier.seed().catch(() => { /* a failed seed only skips removal pruning */ });

  const policy = installNotificationPolicy({
    subscribe: subscribeGlobal,
    loadRows: async (ids): Promise<ReadonlyMap<string, Task | null>> => await fetchTaskRows(ids),
  });
  const unregister = policy.registerSink({
    id: "os",
    deliver: (d) => notifier.post(d.notification),
    remove: (r) => notifier.remove(r),
  });
  const unhook = installNotificationRemovalHooks((r) => policy.remove(r));

  return {
    sink: {
      post: (n) => notifier.post(n),
      remove: (r) => policy.remove(r),
    },
    policy,
    dispose() {
      policy.dispose();
      unregister();
      unhook();
    },
  };
}
