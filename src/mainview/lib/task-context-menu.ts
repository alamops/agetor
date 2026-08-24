import type { Task } from "../../shared/types.ts";

/** Every action the task context menu can offer. A subset of App.tsx's
 *  existing card callbacks (`start`/`cancel`/`markDone`/`archive`/
 *  `unarchive`/`del`), plus the details-panel actions the menu additionally
 *  surfaces as quick actions. T3 maps each id to its App.tsx handler. */
export type TaskMenuAction =
  | "open"
  | "start"
  | "stop"
  | "mark-done"
  | "archive"
  | "unarchive"
  | "diff"
  | "open-in-finder"
  | "view-pr"
  | "mark-read"
  | "mark-unread"
  | "copy-branch"
  | "copy-worktree-path"
  | "delete";

/** Visual/semantic grouping — T3 inserts a separator between consecutive
 *  entries whose `group` differs, so the order below also defines where the
 *  dividers land. */
export type TaskMenuGroup = "primary" | "inspect" | "read" | "copy" | "danger";

export interface TaskMenuEntry {
  action: TaskMenuAction;
  label: string;
  group: TaskMenuGroup;
  /** Danger-styled entry (destructive text color). Only `delete` sets this. */
  danger?: boolean;
}

/**
 * Builds the task card's right-click quick-action list, in display order,
 * per the §1 table in `docs/plans/task-context-menu.md`. Pure and
 * side-effect-free: no React, no `api` calls — App.tsx resolves each
 * returned `action` to its real handler and renders the entries.
 *
 * Gating mirrors `TaskCard`'s own button precedence exactly (see the
 * "Button precedence: Answer > Stop > Open > Run" comment in TaskCard.tsx)
 * so the menu never offers an action the card's own hover buttons wouldn't:
 * `awaiting`/`active`/`openable` are computed the same way, and "Run" is
 * hidden whenever the card would instead show "Answer"/"Review"/"Stop"/
 * "Open" — re-running from the menu while a turn is live or unread output
 * is waiting would be surprising, not a shortcut.
 *
 * `ctx.isOpen` mirrors `TaskCard`'s `isOpen` prop (`task.id ===
 * selected?.id`): the read/unread entries are suppressed while the run
 * panel for this task is already open, matching the card's own dot
 * suppression (messages streamed while open are marked seen on close, not
 * mid-session).
 */
export function buildTaskContextMenu(task: Task, ctx: { isOpen: boolean }): TaskMenuEntry[] {
  const archived = task.archivedAt != null;
  const active = task.column === "running" || task.column === "blocked";
  const awaiting = task.pendingInteractionCount > 0 || task.column === "blocked";
  const openable = task.hasOpenableRun;

  const entries: TaskMenuEntry[] = [];

  // primary
  entries.push({ action: "open", label: "Open details", group: "primary" });
  if (!archived && !awaiting && !active && !openable) {
    entries.push({ action: "start", label: "Run", group: "primary" });
  }
  if (active && !archived) {
    entries.push({ action: "stop", label: "Stop", group: "primary" });
  }
  if (task.column === "review" && !archived) {
    entries.push({ action: "mark-done", label: "Mark done", group: "primary" });
  }
  if (!archived && (task.column === "done" || active)) {
    entries.push({ action: "archive", label: active ? "Stop & archive…" : "Archive", group: "primary" });
  }
  if (archived) {
    entries.push({ action: "unarchive", label: "Unarchive", group: "primary" });
  }

  // inspect
  entries.push({ action: "diff", label: "View changes", group: "inspect" });
  entries.push({ action: "open-in-finder", label: "Open in Finder", group: "inspect" });
  if (task.prUrl) {
    entries.push({ action: "view-pr", label: "View pull request", group: "inspect" });
  }

  // read — "unread" is only ever honest to flip when the task has actually
  // produced an assistant message; `hasAssistantMessages` is what lets
  // "Mark as unread" avoid re-flagging a task that never said anything.
  if (task.unread === true && !ctx.isOpen) {
    entries.push({ action: "mark-read", label: "Mark as read", group: "read" });
  }
  if (!task.unread && !ctx.isOpen && task.hasAssistantMessages === true) {
    entries.push({ action: "mark-unread", label: "Mark as unread", group: "read" });
  }

  // copy
  if (task.branch) {
    entries.push({ action: "copy-branch", label: "Copy branch name", group: "copy" });
  }
  if (task.worktreePath) {
    entries.push({ action: "copy-worktree-path", label: "Copy worktree path", group: "copy" });
  }

  // danger — always last.
  entries.push({ action: "delete", label: "Delete…", group: "danger", danger: true });

  return entries;
}
