import type { GlobalEvent } from "../shared/types.ts";
import type { NotificationKind } from "../shared/os-notification.ts";
import { buildTaskNotifierPostArgs, resolveInstalledAppNotifier } from "../bun/notifier.ts";

const BELL = String.fromCharCode(7);

/**
 * The orchestrator stamps an additive `pipelineParentId` onto the task-
 * scoped `GlobalEvent` members (`run-status`, `column`, `interaction`,
 * `files-sent`, `fx-auto-resume`) whenever the event's task is a hidden
 * pipeline step, so a consumer can tell a step's event apart WITHOUT having
 * polled that step's row first (a step that settles before the first poll
 * would otherwise slip through a `hiddenTaskIds` lookup). Read defensively —
 * an older core (or a member that never carries it) yields `null`.
 */
export function eventPipelineParentId(e: GlobalEvent): string | null {
  const v = (e as { pipelineParentId?: unknown }).pipelineParentId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Map a global event to a desktop notification — only for the given task, and
 * only for state changes worth interrupting the user (terminal status + the
 * "needs you" block). Returns null otherwise.
 *
 * `opts.hidden` — true when `taskId` names a pipeline's hidden step task
 * (`pipelineParentId` set, docs/plans/pipelines.md D11) — suppresses the
 * notification even for a step task the caller explicitly resolved (e.g.
 * `agetor logs <stepTaskId> --notify`): the pipeline's parent task's own
 * `column`/pipeline-run transitions already cover the same information at
 * the level a step id, an implementation detail, isn't meaningful outside.
 */
export function notifyFor(
  e: GlobalEvent,
  taskId: string,
  opts?: { hidden?: boolean },
): { title: string; body: string; kind: NotificationKind } | null {
  if (opts?.hidden) return null;
  // The event itself says it belongs to a hidden step task — same
  // suppression, no caller lookup needed (see `eventPipelineParentId`).
  if (eventPipelineParentId(e) !== null) return null;
  const short = taskId.slice(0, 8);
  if (e.kind === "run-status" && e.taskId === taskId) {
    if (e.status === "succeeded") return { title: "Agetor — succeeded", body: short, kind: "succeeded" };
    if (e.status === "failed") return { title: "Agetor — failed", body: short, kind: "failed" };
    if (e.status === "orphaned") return { title: "Agetor — orphaned", body: short, kind: "failed" };
    return null; // cancelled: the user did it
  }
  if (e.kind === "column" && e.taskId === taskId && e.column === "blocked") {
    return {
      title: "Agetor — needs you",
      body: e.reason === "api-error" ? `${short} (API error)` : `${short} is waiting on you`,
      kind: blockedKind(e.reason),
    };
  }
  return null;
}

/** The notification kind for a `blocked` column event's reason (the same
 *  mapping the app uses: the reason picks the urgency and sound). */
function blockedKind(reason: string | undefined): NotificationKind {
  if (reason === "api-error") return "api-error";
  if (reason === "session-died") return "session-ended";
  if (reason === "unknown-command") return "unknown-command";
  return "blocked";
}

/** What `osNotify` posts. `taskId` and `kind` are optional — without a task id
 *  the post can't share Agetor's per-task notification entry, so it goes
 *  straight to osascript. */
export interface OsNotifyInput {
  title: string;
  body: string;
  taskId?: string;
  kind?: NotificationKind;
}

/** Test seams for `osNotify`; every one defaults to the real thing. */
export interface OsNotifyDeps {
  /** Post through the connected core (`POST /notifications`). Rejects on any
   *  failure, including the headless core's 501. */
  notifyCore?: (input: OsNotifyInput) => Promise<unknown>;
  /** Path of Agetor's notifier helper, or null when none is installed. */
  resolveBin?: () => string | null;
  /** Run `argv` to completion and resolve its exit code (null when it could
   *  not be run or did not finish). */
  spawn?: (argv: string[]) => Promise<number | null>;
  /** Ring the terminal bell. */
  bell?: () => void;
  /** The osascript fallback. */
  osascript?: (title: string, body: string) => void;
}

/** How long to wait for the helper before giving up on it (it may sit on a
 *  permission prompt). */
const HELPER_TIMEOUT_MS = 15_000;
/** Helper exit code for "notification permission denied / timed out"; the app
 *  does not fall back to osascript after one, and neither does the CLI. */
const HELPER_EXIT_PERMISSION_DENIED = 2;

/**
 * Direct helper posts are serialized per process so the newest post lands
 * last: two quick events for one task would otherwise race, and the helper
 * replaces the delivered entry by id, so the older one could win.
 */
let directHelperChain: Promise<void> = Promise.resolve();

function defaultBell(): void {
  try {
    process.stdout.write(BELL);
  } catch {
    /* closed stdout — nothing to ring */
  }
}

async function defaultSpawn(argv: string[]): Promise<number | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), HELPER_TIMEOUT_MS);
    try {
      return await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function defaultOsascript(title: string, body: string): void {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  try {
    Bun.spawn(
      ["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    /* osascript missing / not macOS — the bell still fired */
  }
}

/** Post through the installed helper. Resolves true when the post is settled
 *  (delivered, or refused for permission) and no fallback should follow. */
function postViaHelper(
  input: OsNotifyInput & { taskId: string },
  deps: Required<Pick<OsNotifyDeps, "resolveBin" | "spawn">>,
): Promise<boolean> {
  const run = directHelperChain.then(async () => {
    try {
      const bin = deps.resolveBin();
      if (!bin) return false;
      const code = await deps.spawn([
        bin,
        ...buildTaskNotifierPostArgs({
          title: input.title,
          body: input.body,
          taskId: input.taskId,
          kind: input.kind,
        }),
      ]);
      return code === 0 || code === HELPER_EXIT_PERMISSION_DENIED;
    } catch {
      return false;
    }
  });
  directHelperChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Best-effort desktop notification + a terminal bell. Never throws or rejects.
 *
 * The bell always rings first. With a task id the notification then goes
 * through Agetor so it shares the app's per-task entry and sound rules: first
 * the connected core, then — when that fails (e.g. the headless core's 501) —
 * the installed app's helper directly. Everything else, and every failure,
 * falls back to osascript.
 */
export async function osNotify(n: OsNotifyInput, deps: OsNotifyDeps = {}): Promise<void> {
  try {
    (deps.bell ?? defaultBell)();
  } catch {
    /* the bell is best effort */
  }
  try {
    const taskId = n.taskId;
    if (taskId) {
      if (deps.notifyCore) {
        try {
          await deps.notifyCore(n);
          return;
        } catch {
          /* 501 or any other failure — try the helper directly */
        }
      }
      const settled = await postViaHelper(
        { ...n, taskId },
        { resolveBin: deps.resolveBin ?? resolveInstalledAppNotifier, spawn: deps.spawn ?? defaultSpawn },
      );
      if (settled) return;
    }
    (deps.osascript ?? defaultOsascript)(n.title, n.body);
  } catch {
    /* never throw */
  }
}
