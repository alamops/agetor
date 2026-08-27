import { describe, expect, test } from "bun:test";
import { buildTaskContextMenu, type TaskMenuAction, type TaskMenuGroup } from "./task-context-menu.ts";
import type { Task } from "../../shared/types.ts";

/** Minimal hand-built Task fixture, mirroring `task-unread.test.ts`'s
 *  `makeTaskRow` for the required fields. Defaults to a fresh backlog task
 *  with nothing set (no run history, no branch/worktree/PR, not archived,
 *  not awaiting, unread/hasAssistantMessages omitted like a legacy row). */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "t",
    prompt: "p",
    column: "backlog",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    ...overrides,
  };
}

/** action -> group, per the plan's §1 table / the source's group comments.
 *  Used to assert every entry lands in the group the plan assigns it. */
const ACTION_GROUP: Record<TaskMenuAction, TaskMenuGroup> = {
  open: "primary",
  start: "primary",
  stop: "primary",
  "mark-done": "primary",
  archive: "primary",
  unarchive: "primary",
  diff: "inspect",
  "open-in-finder": "inspect",
  "view-pr": "inspect",
  "view-issue": "inspect",
  "mark-read": "utility",
  "mark-unread": "utility",
  "copy-branch": "utility",
  "copy-worktree-path": "utility",
  delete: "danger",
};

const actions = (entries: ReturnType<typeof buildTaskContextMenu>) => entries.map((e) => e.action);

describe("buildTaskContextMenu", () => {
  test("backlog task, nothing set -> open, start, diff, open-in-finder, delete", () => {
    const task = makeTask();
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "start", "diff", "open-in-finder", "delete"]);

    // delete is last and danger-styled.
    const last = entries[entries.length - 1]!;
    expect(last.action).toBe("delete");
    expect(last.danger).toBe(true);
    expect(entries.filter((e) => e.danger).map((e) => e.action)).toEqual(["delete"]);

    // Every entry's group matches the plan's grouping.
    for (const e of entries) {
      expect(e.group).toBe(ACTION_GROUP[e.action]);
    }
  });

  test("hasOpenableRun: true (review column) -> no start, has mark-done", () => {
    const task = makeTask({ column: "review", hasOpenableRun: true });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "mark-done", "diff", "open-in-finder", "delete"]);
    expect(actions(entries)).not.toContain("start");
    expect(entries.find((e) => e.action === "mark-done")?.label).toBe("Mark done");
  });

  test("running -> stop, archive labeled 'Stop & archive…', no start", () => {
    const task = makeTask({ column: "running" });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "stop", "archive", "diff", "open-in-finder", "delete"]);
    expect(actions(entries)).not.toContain("start");
    expect(entries.find((e) => e.action === "archive")?.label).toBe("Stop & archive…");
  });

  test("blocked -> same as running (awaiting) and no start", () => {
    const task = makeTask({ column: "blocked" });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "stop", "archive", "diff", "open-in-finder", "delete"]);
    expect(actions(entries)).not.toContain("start");
    expect(entries.find((e) => e.action === "archive")?.label).toBe("Stop & archive…");
  });

  test("pendingInteractionCount: 1 on ready -> no start (awaiting)", () => {
    const task = makeTask({ column: "ready", pendingInteractionCount: 1 });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "diff", "open-in-finder", "delete"]);
    expect(actions(entries)).not.toContain("start");
    expect(actions(entries)).not.toContain("stop");
  });

  test("done -> archive labeled 'Archive', no mark-done", () => {
    const task = makeTask({ column: "done", hasOpenableRun: true });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual(["open", "archive", "diff", "open-in-finder", "delete"]);
    expect(actions(entries)).not.toContain("mark-done");
    expect(entries.find((e) => e.action === "archive")?.label).toBe("Archive");
  });

  test("archived (archivedAt set) on done -> only open, unarchive in primary; no start/stop/mark-done/archive", () => {
    const task = makeTask({ column: "done", hasOpenableRun: true, archivedAt: Date.now() });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    const primary = entries.filter((e) => e.group === "primary").map((e) => e.action);
    expect(primary).toEqual(["open", "unarchive"]);

    for (const forbidden of ["start", "stop", "mark-done", "archive"] as const) {
      expect(actions(entries)).not.toContain(forbidden);
    }
  });

  test("prUrl -> view-pr after open-in-finder; branch -> copy-branch; worktreePath -> copy-worktree-path; both -> branch then worktree", () => {
    const task = makeTask({
      prUrl: "https://github.com/o/r/pull/1",
      branch: "agetor/abc123-feature",
      worktreePath: "/Users/x/.agetor/worktrees/task-1",
    });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual([
      "open",
      "start",
      "diff",
      "open-in-finder",
      "view-pr",
      "copy-branch",
      "copy-worktree-path",
      "delete",
    ]);

    const openInFinderIdx = actions(entries).indexOf("open-in-finder");
    const viewPrIdx = actions(entries).indexOf("view-pr");
    expect(viewPrIdx).toBe(openInFinderIdx + 1);

    const branchIdx = actions(entries).indexOf("copy-branch");
    const worktreeIdx = actions(entries).indexOf("copy-worktree-path");
    expect(branchIdx).toBeLessThan(worktreeIdx);
  });

  describe("read/unread entries (utility group)", () => {
    test("unread: true, isOpen: false -> mark-read only", () => {
      const task = makeTask({ unread: true });
      const entries = buildTaskContextMenu(task, { isOpen: false });
      const read = entries.filter((e) => e.group === "utility").map((e) => e.action);
      expect(read).toEqual(["mark-read"]);
      expect(entries.find((e) => e.action === "mark-read")?.label).toBe("Mark as read");
    });

    test("unread: false, hasAssistantMessages: true, isOpen: false -> mark-unread only", () => {
      const task = makeTask({ unread: false, hasAssistantMessages: true });
      const entries = buildTaskContextMenu(task, { isOpen: false });
      const read = entries.filter((e) => e.group === "utility").map((e) => e.action);
      expect(read).toEqual(["mark-unread"]);
      expect(entries.find((e) => e.action === "mark-unread")?.label).toBe("Mark as unread");
    });

    test("unread: false, hasAssistantMessages: false -> neither", () => {
      const task = makeTask({ unread: false, hasAssistantMessages: false });
      const entries = buildTaskContextMenu(task, { isOpen: false });
      expect(entries.filter((e) => e.group === "utility")).toEqual([]);
    });

    test("isOpen: true -> neither, regardless of unread/hasAssistantMessages", () => {
      const unreadTask = makeTask({ unread: true, hasAssistantMessages: true });
      expect(buildTaskContextMenu(unreadTask, { isOpen: true }).filter((e) => e.group === "utility")).toEqual([]);

      const unseenButHasMessagesTask = makeTask({ unread: false, hasAssistantMessages: true });
      expect(
        buildTaskContextMenu(unseenButHasMessagesTask, { isOpen: true }).filter((e) => e.group === "utility"),
      ).toEqual([]);
    });

    test("unread undefined (legacy fixture) treated as false", () => {
      // hasAssistantMessages also omitted -> no read entries at all.
      const bareLegacyTask = makeTask();
      expect(buildTaskContextMenu(bareLegacyTask, { isOpen: false }).filter((e) => e.group === "utility")).toEqual([]);

      // hasAssistantMessages true, unread omitted -> treated as unread=false,
      // so mark-unread (not mark-read) is offered.
      const legacyWithMessages = makeTask({ hasAssistantMessages: true });
      const read = buildTaskContextMenu(legacyWithMessages, { isOpen: false })
        .filter((e) => e.group === "utility")
        .map((e) => e.action);
      expect(read).toEqual(["mark-unread"]);
    });
  });

  test("kitchen sink: review + branch + worktreePath + prUrl + unread -> full sequence in order", () => {
    const task = makeTask({
      column: "review",
      hasOpenableRun: true,
      branch: "agetor/xyz-feature",
      worktreePath: "/Users/x/.agetor/worktrees/task-1",
      prUrl: "https://github.com/o/r/pull/42",
      unread: true,
    });
    const entries = buildTaskContextMenu(task, { isOpen: false });

    expect(actions(entries)).toEqual([
      "open",
      "mark-done",
      "diff",
      "open-in-finder",
      "view-pr",
      "mark-read",
      "copy-branch",
      "copy-worktree-path",
      "delete",
    ]);

    // Spot-check labels along the full sequence.
    expect(entries.find((e) => e.action === "open")?.label).toBe("Open details");
    expect(entries.find((e) => e.action === "mark-done")?.label).toBe("Mark done");
    expect(entries.find((e) => e.action === "diff")?.label).toBe("View changes");
    expect(entries.find((e) => e.action === "open-in-finder")?.label).toBe("Open in Finder");
    expect(entries.find((e) => e.action === "view-pr")?.label).toBe("View pull request");
    expect(entries.find((e) => e.action === "mark-read")?.label).toBe("Mark as read");
    expect(entries.find((e) => e.action === "copy-branch")?.label).toBe("Copy branch name");
    expect(entries.find((e) => e.action === "copy-worktree-path")?.label).toBe("Copy worktree path");
    expect(entries.find((e) => e.action === "delete")?.label).toBe("Delete…");

    // Every entry's group matches the plan's grouping, and delete is last + danger.
    for (const e of entries) {
      expect(e.group).toBe(ACTION_GROUP[e.action]);
    }
    const lastEntry = entries[entries.length - 1]!;
    expect(lastEntry.action).toBe("delete");
    expect(lastEntry.danger).toBe(true);
  });
});
