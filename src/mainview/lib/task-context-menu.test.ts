import { describe, expect, test } from "bun:test";
import { buildTaskContextMenu, type TaskMenuAction, type TaskMenuGroup } from "./task-context-menu.ts";
import type { PipelineRunState, Task, TaskFxRecovery } from "../../shared/types.ts";

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
  "open-pipeline": "primary",
  start: "primary",
  stop: "primary",
  "resume-recovery": "primary",
  "cancel-auto-resume": "primary",
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

  describe("view-issue (inspect group)", () => {
    test("absent when issueUrl is null", () => {
      const task = makeTask({ issueUrl: null });
      expect(actions(buildTaskContextMenu(task, { isOpen: false }))).not.toContain("view-issue");
    });

    test("absent when issueUrl is undefined (legacy fixture)", () => {
      const task = makeTask();
      expect(actions(buildTaskContextMenu(task, { isOpen: false }))).not.toContain("view-issue");
    });

    test("present, right after open-in-finder, when only issueUrl is set", () => {
      const task = makeTask({ issueUrl: "https://github.com/o/r/issues/9" });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open", "start", "diff", "open-in-finder", "view-issue", "delete"]);
      const openInFinderIdx = actions(entries).indexOf("open-in-finder");
      const viewIssueIdx = actions(entries).indexOf("view-issue");
      expect(viewIssueIdx).toBe(openInFinderIdx + 1);

      const entry = entries.find((e) => e.action === "view-issue")!;
      expect(entry.label).toBe("View issue");
      expect(entry.group).toBe("inspect");
    });

    test("present, immediately after view-pr, when both prUrl and issueUrl are set", () => {
      const task = makeTask({
        prUrl: "https://github.com/o/r/pull/1",
        issueUrl: "https://github.com/o/r/issues/9",
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual([
        "open",
        "start",
        "diff",
        "open-in-finder",
        "view-pr",
        "view-issue",
        "delete",
      ]);
      const viewPrIdx = actions(entries).indexOf("view-pr");
      const viewIssueIdx = actions(entries).indexOf("view-issue");
      expect(viewIssueIdx).toBe(viewPrIdx + 1);
    });

    test("present on an archived task (mirrors view-pr: inspect entries don't depend on archived state)", () => {
      const task = makeTask({
        column: "done",
        hasOpenableRun: true,
        archivedAt: Date.now(),
        issueUrl: "https://github.com/o/r/issues/9",
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });
      expect(actions(entries)).toContain("view-issue");
    });

    test("present while the run panel for this task is open (mirrors view-pr: inspect entries don't depend on isOpen)", () => {
      const task = makeTask({ issueUrl: "https://github.com/o/r/issues/9" });
      const entries = buildTaskContextMenu(task, { isOpen: true });
      expect(actions(entries)).toContain("view-issue");
    });
  });

  describe("resume-recovery / cancel-auto-resume (primary group, fx pause — docs/plans/fx-recovery-follow-ups.md)", () => {
    // Minimal TaskFxRecovery fixture: `state: "paused"` plus `autoResume` are
    // all `isTaskFxPaused`/`buildTaskContextMenu` actually read off it, but
    // every field is required by the type.
    function pausedFxRecovery(autoResume: TaskFxRecovery["autoResume"] = null): TaskFxRecovery {
      return {
        state: "paused",
        runId: "run-1",
        pausedAt: Date.now(),
        autoResume,
        autoResumeCount: 0,
      };
    }

    test("shown for a paused fx task sitting in ready, right after Start (the task isn't awaiting/active/openable, so Start still shows too)", () => {
      const task = makeTask({ column: "ready", fxRecovery: pausedFxRecovery() });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open", "start", "resume-recovery", "diff", "open-in-finder", "delete"]);
      const entry = entries.find((e) => e.action === "resume-recovery")!;
      expect(entry.label).toBe("Resume paused response");
      expect(entry.group).toBe("primary");
    });

    test("hidden when column is 'running' (isTaskFxPaused requires column !== running)", () => {
      const task = makeTask({ column: "running", fxRecovery: pausedFxRecovery() });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).not.toContain("resume-recovery");
      expect(actions(entries)).not.toContain("cancel-auto-resume");
    });

    test("hidden when fxRecovery is null", () => {
      const task = makeTask({ column: "ready", fxRecovery: null });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).not.toContain("resume-recovery");
      expect(actions(entries)).not.toContain("cancel-auto-resume");
    });

    test("hidden when fxRecovery is undefined (legacy fixture, field never set)", () => {
      const task = makeTask({ column: "ready" });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).not.toContain("resume-recovery");
      expect(actions(entries)).not.toContain("cancel-auto-resume");
    });

    test("hidden on an archived task, even with a paused fxRecovery", () => {
      const task = makeTask({
        column: "done",
        hasOpenableRun: true,
        archivedAt: Date.now(),
        fxRecovery: pausedFxRecovery(),
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).not.toContain("resume-recovery");
      expect(actions(entries)).not.toContain("cancel-auto-resume");
    });

    test("cancel-auto-resume absent when fxRecovery.autoResume is null (no pending timer)", () => {
      const task = makeTask({ column: "ready", fxRecovery: pausedFxRecovery(null) });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toContain("resume-recovery");
      expect(actions(entries)).not.toContain("cancel-auto-resume");
    });

    test("cancel-auto-resume present, right after resume-recovery, when fxRecovery.autoResume is set", () => {
      const task = makeTask({
        column: "ready",
        fxRecovery: pausedFxRecovery({ at: Date.now() + 60_000, attempt: 1, max: 3, delaySec: 120 }),
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual([
        "open",
        "start",
        "resume-recovery",
        "cancel-auto-resume",
        "diff",
        "open-in-finder",
        "delete",
      ]);
      const entry = entries.find((e) => e.action === "cancel-auto-resume")!;
      expect(entry.label).toBe("Cancel auto-resume");
      expect(entry.group).toBe("primary");
    });

    test("resume-recovery renders right after Stop when the task is also 'blocked' (awaiting + active)", () => {
      // blocked -> active=true, awaiting=true -> Stop shows; a paused
      // fxRecovery is an orthogonal field (column !== "running" still holds),
      // so both entries appear together, Stop first.
      const task = makeTask({ column: "blocked", fxRecovery: pausedFxRecovery() });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual([
        "open",
        "stop",
        "resume-recovery",
        "archive",
        "diff",
        "open-in-finder",
        "delete",
      ]);
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

  describe("pipeline tasks (docs/plans/pipelines.md D9/D11)", () => {
    test("a pipeline PARENT task gets 'open-pipeline' instead of 'open details'", () => {
      const task = makeTask({ pipelineId: "pipe-1" });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open-pipeline", "start", "diff", "open-in-finder", "delete"]);
      expect(entries.find((e) => e.action === "open-pipeline")?.label).toBe("Open pipeline");
      for (const e of entries) {
        expect(e.group).toBe(ACTION_GROUP[e.action]);
      }
    });

    test("a pipeline PARENT task still gets archive/unarchive/delete like any other task", () => {
      const running = buildTaskContextMenu(makeTask({ pipelineId: "pipe-1", column: "running" }), { isOpen: false });
      expect(actions(running)).toContain("archive");
      expect(actions(running)).toContain("delete");
      // L-A1: without a `running` pipelineRun there's nothing the cancel
      // route would honour — no Stop, even though the column says running.
      expect(actions(running)).not.toContain("stop");

      const archived = buildTaskContextMenu(
        makeTask({ pipelineId: "pipe-1", archivedAt: Date.now() }),
        { isOpen: false },
      );
      expect(actions(archived)).toContain("unarchive");
    });

    test("a hidden STEP task hides archive/unarchive/delete — the parent owns its lifecycle", () => {
      const running = buildTaskContextMenu(
        makeTask({ pipelineParentId: "pipe-parent-1", column: "running" }),
        { isOpen: false },
      );
      expect(actions(running)).toEqual(["open", "stop", "diff", "open-in-finder"]);
      expect(actions(running)).not.toContain("archive");
      expect(actions(running)).not.toContain("delete");

      const done = buildTaskContextMenu(
        makeTask({ pipelineParentId: "pipe-parent-1", column: "done" }),
        { isOpen: false },
      );
      expect(actions(done)).not.toContain("archive");
      expect(actions(done)).not.toContain("delete");

      const archived = buildTaskContextMenu(
        makeTask({ pipelineParentId: "pipe-parent-1", archivedAt: Date.now() }),
        { isOpen: false },
      );
      expect(actions(archived)).not.toContain("unarchive");
      expect(actions(archived)).not.toContain("delete");
    });

    test("a hidden STEP task still gets plain 'open' — it's not a pipeline parent", () => {
      const task = makeTask({ pipelineParentId: "pipe-parent-1" });
      const entries = buildTaskContextMenu(task, { isOpen: false });
      expect(entries[0]).toEqual({ action: "open", label: "Open details", group: "primary" });
    });

    // M15 (review): a pipeline parent with run history is "openable" — Run
    // must not show alongside Open pipeline once there's something to open.
    function pipelineRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
      return {
        pipelineId: "pipe-1",
        pipelineName: "Pipe",
        snapshot: null,
        status: "idle",
        active: [],
        joins: {},
        blocked: [],
        history: [],
        stepCount: 0,
        startedAt: null,
        endedAt: null,
        ...overrides,
      };
    }

    test("M15: a pipeline parent with pipelineRun.history.length > 0 omits 'start' — Retry/Restart live in the run view", () => {
      const task = makeTask({
        pipelineId: "pipe-1",
        column: "ready",
        pipelineRun: pipelineRun({
          status: "done",
          history: [
            { seq: 1, stepId: "s1", taskId: "step-task-1", startedAt: Date.now(), endedAt: Date.now(), outcome: "succeeded", handoff: null, nextStepIds: [] },
          ],
        }),
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open-pipeline", "diff", "open-in-finder", "delete"]);
      expect(actions(entries)).not.toContain("start");
    });

    test("M15: an idle pipeline parent (pipelineRun set, empty history) still shows 'start'", () => {
      const task = makeTask({
        pipelineId: "pipe-1",
        pipelineRun: pipelineRun(),
      });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open-pipeline", "start", "diff", "open-in-finder", "delete"]);
    });

    test("L-A1: a pipeline parent's Stop gates on pipelineRun.status === 'running', not the column", () => {
      const running = buildTaskContextMenu(
        makeTask({ pipelineId: "pipe-1", column: "running", pipelineRun: pipelineRun({ status: "running", active: [{ stepId: "s1", taskId: "step-1", seq: 1 }] }) }),
        { isOpen: false },
      );
      expect(actions(running)).toContain("stop");

      // A `blocked` run with nothing live — the cancel route 409s
      // ("pipeline is not running"), so the card/menu must not offer Stop.
      const blocked = buildTaskContextMenu(
        makeTask({ pipelineId: "pipe-1", column: "blocked", pipelineRun: pipelineRun({ status: "blocked", active: [{ stepId: "s1", taskId: "step-1", seq: 1 }] }) }),
        { isOpen: false },
      );
      expect(actions(blocked)).not.toContain("stop");

      // A plain (non-pipeline) blocked task keeps the column-based rule.
      const plainBlocked = buildTaskContextMenu(makeTask({ column: "blocked" }), { isOpen: false });
      expect(actions(plainBlocked)).toContain("stop");
    });

    test("M15: a pipeline parent with no pipelineRun at all (never run) still shows 'start'", () => {
      const task = makeTask({ pipelineId: "pipe-1", pipelineRun: null });
      const entries = buildTaskContextMenu(task, { isOpen: false });

      expect(actions(entries)).toEqual(["open-pipeline", "start", "diff", "open-in-finder", "delete"]);
    });
  });
});
