/**
 * The desktop app's OS-notification driver: posts and removes a task's one
 * Notification Center entry through the AgetorNotifier helper
 * (native/notifier/, argv built by notifier.ts).
 *
 * - **One entry per task.** Every post for a task uses the same request id
 *   (`taskNotificationId`). macOS replaces the delivered entry and shows the
 *   newest on top. The helper decides the sound from what is still delivered
 *   (see src/shared/os-notification.ts).
 * - **Serialized per task (D15).** Each task has one FIFO of helper
 *   operations, with at most one helper child running for it at a time, so
 *   the newest event always lands last. Different tasks run in parallel.
 * - **Removal is gated by a may-be-delivered set.** Without it every panel
 *   switch, unblock and focused event would spawn a helper process. The set
 *   is a superset of what Notification Center holds: a post adds its task,
 *   and an unconditional remove that exits 0 takes the task out. `seed()`
 *   fills it from the helper's `--list` at boot, so entries from before a
 *   restart are still removed. Until the seed succeeds nothing is skipped
 *   (correctness over cost).
 * - **Fallback discipline** (a notifier problem must never mean NO
 *   notification), unchanged from the original `index.ts` code:
 *   - no taskId or no helper → `plain` (Electrobun's Utils.showNotification);
 *   - a synchronous spawn throw or a rejected `exited` → `plain`;
 *   - helper exit 2 (notification permission denied or never answered) →
 *     no fallback. The plain path posts under agetor's MAIN bundle id, a
 *     second "Agetor" identity, and would re-prompt for a permission the
 *     user just declined;
 *   - any other non-zero exit → `plain`.
 *
 * No Electrobun import, so the module runs under `bun test` with an injected
 * spawn.
 */

import { buildTaskDeepLink, parseTaskDeepLink } from "./deep-link.ts";
import {
  buildNotifierListArgs,
  buildNotifierRemoveArgs,
  buildTaskNotifierPostArgs,
  resolveNotifier,
} from "./notifier.ts";
import {
  taskNotificationId,
  type NotificationKind,
  type TaskNotificationRemoval,
} from "../shared/os-notification.ts";

/** One task notification; the argument of `ApiNative.showNotification`. */
export interface TaskNotification {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  taskId?: string;
  kind?: NotificationKind;
}

type SpawnFn = (
  argv: string[],
  opts: { stdout: "pipe" | "ignore" },
) => { exited: Promise<number>; stdout?: ReadableStream<Uint8Array> | null };

export interface TaskNotifierDeps {
  /** The non-deduped fallback: Electrobun's plain notification. */
  plain: (n: TaskNotification) => void;
  /** The helper executable, or null when none resolves. Defaults to `resolveNotifier`. */
  resolveBin?: () => string | null;
  /** Spawns a helper child. Defaults to `Bun.spawn` with stderr ignored. */
  spawn?: SpawnFn;
  log?: (msg: string, err?: unknown) => void;
}

export interface TaskNotifier {
  post(n: TaskNotification): void;
  remove(r: TaskNotificationRemoval): void;
  /** Seeds the may-be-delivered set from the helper's `--list`. Idempotent. */
  seed(): Promise<void>;
  /** Resolves once every task's queue is drained (a test seam). */
  whenIdle(): Promise<void>;
}

type Op =
  | { type: "post"; bin: string; n: TaskNotification & { taskId: string } }
  | { type: "remove"; bin: string; r: TaskNotificationRemoval; postGen: number };

interface TaskQueue {
  pending: Op[];
}

const defaultSpawn: SpawnFn = (argv, opts) =>
  Bun.spawn(argv, { stdout: opts.stdout, stderr: "ignore", stdin: "ignore" });

const defaultLog = (msg: string, err?: unknown) => {
  if (err === undefined) console.error(`[agetor] ${msg}`);
  else console.error(`[agetor] ${msg}`, err);
};

export function createTaskNotifier(deps: TaskNotifierDeps): TaskNotifier {
  const resolveBin = deps.resolveBin ?? resolveNotifier;
  const spawn = deps.spawn ?? defaultSpawn;
  const log = deps.log ?? defaultLog;

  /** Tasks whose queue is draining; absent = idle. */
  const queues = new Map<string, TaskQueue>();
  const maybeDelivered = new Set<string>();
  /** Bumped on every post, so a remove that finishes after a newer post was
   *  enqueued doesn't take that task out of `maybeDelivered`. */
  const postGenerations = new Map<string, number>();
  let seeded = false;
  let seedPromise: Promise<void> | null = null;
  let idleWaiters: Array<() => void> = [];

  const plain = (n: TaskNotification) => {
    try {
      deps.plain(n);
    } catch (err) {
      log("plain notification failed:", err);
    }
  };

  const enqueue = (taskId: string, op: Op) => {
    const existing = queues.get(taskId);
    if (existing) {
      existing.pending.push(op);
      return;
    }
    const queue: TaskQueue = { pending: [op] };
    queues.set(taskId, queue);
    void drain(taskId, queue);
  };

  const drain = async (taskId: string, queue: TaskQueue) => {
    for (let op = queue.pending.shift(); op; op = queue.pending.shift()) {
      await run(taskId, op);
    }
    queues.delete(taskId);
    if (queues.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  const run = async (taskId: string, op: Op): Promise<void> => {
    if (op.type === "post") {
      let code: number;
      try {
        code = await spawn([op.bin, ...buildTaskNotifierPostArgs(op.n)], { stdout: "ignore" }).exited;
      } catch (err) {
        log("notifier helper failed, falling back to plain notification:", err);
        plain(op.n);
        return;
      }
      if (code === 0) return;
      if (code === 2) {
        log("notifier helper: notification permission not granted; skipping fallback");
        return;
      }
      log(`notifier helper exited ${code}, falling back to plain notification`);
      plain(op.n);
      return;
    }

    const argv = [
      op.bin,
      ...buildNotifierRemoveArgs({
        id: taskNotificationId(taskId),
        url: buildTaskDeepLink(taskId),
        ifKinds: op.r.ifKinds,
      }),
    ];
    let code: number;
    try {
      code = await spawn(argv, { stdout: "ignore" }).exited;
    } catch (err) {
      log("notifier helper remove failed:", err);
      return;
    }
    if (code !== 0) {
      log(`notifier helper remove exited ${code}`);
      return;
    }
    // Only an unconditional remove proves the task has nothing delivered: a
    // conditional one may have left an entry of another kind in place.
    if (op.r.ifKinds === undefined && (postGenerations.get(taskId) ?? 0) === op.postGen) {
      maybeDelivered.delete(taskId);
    }
  };

  const post = (n: TaskNotification) => {
    const taskId = n.taskId;
    if (!taskId) {
      plain(n);
      return;
    }
    const bin = resolveBin();
    if (!bin) {
      plain(n);
      return;
    }
    maybeDelivered.add(taskId);
    postGenerations.set(taskId, (postGenerations.get(taskId) ?? 0) + 1);
    enqueue(taskId, { type: "post", bin, n: { ...n, taskId } });
  };

  const remove = (r: TaskNotificationRemoval) => {
    const bin = resolveBin();
    if (!bin) return;
    if (seeded && !maybeDelivered.has(r.taskId)) return;
    if (r.ifKinds === undefined) {
      // Opening (or archiving/deleting) the task makes any post still waiting
      // to start moot; dropping it avoids a banner flashing up only to be
      // removed a moment later.
      const queue = queues.get(r.taskId);
      if (queue) queue.pending = queue.pending.filter((op) => op.type !== "post");
    }
    enqueue(r.taskId, { type: "remove", bin, r, postGen: postGenerations.get(r.taskId) ?? 0 });
  };

  const runSeed = async (): Promise<void> => {
    const bin = resolveBin();
    // No helper means remove() is a no-op anyway; nothing to seed.
    if (!bin) return;
    try {
      const child = spawn([bin, ...buildNotifierListArgs()], { stdout: "pipe" });
      const [code, text] = await Promise.all([
        child.exited,
        child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
      ]);
      if (code !== 0) {
        log(`notifier helper --list exited ${code}; removals won't be skipped`);
        return;
      }
      for (const line of text.split("\n")) {
        const taskId = parseTaskDeepLink(line.trim());
        if (taskId) maybeDelivered.add(taskId);
      }
      seeded = true;
    } catch (err) {
      log("notifier helper --list failed; removals won't be skipped:", err);
    }
  };

  return {
    post,
    remove,
    seed: () => (seedPromise ??= runSeed()),
    whenIdle: () =>
      queues.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
  };
}
