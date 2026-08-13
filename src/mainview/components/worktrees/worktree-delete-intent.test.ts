import { describe, expect, test } from "bun:test";
import { buildDeleteConfirmCopy, triageDeleteOutcome } from "./worktree-delete-intent.ts";
import type { WorktreeGitStatus, WorktreeInfo, WorktreeTeardownResult } from "../../../shared/types.ts";

function worktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    id: "task-1",
    path: "/home/user/.agetor/worktrees/task-1",
    taskId: "task-1",
    taskTitle: "Do the thing",
    column: "ready",
    archivedAt: null,
    taskUpdatedAt: 1700000000000,
    branch: "agetor/task-1-do-the-thing",
    workdir: "/home/user/project",
    runActive: false,
    heldByBackgroundAgents: false,
    stale: false,
    staleReasons: [],
    ...overrides,
  };
}

function gitStatus(overrides: Partial<WorktreeGitStatus> = {}): WorktreeGitStatus {
  return {
    dirty: false,
    ahead: 0,
    merged: null,
    ignored: false,
    ...overrides,
  };
}

describe("buildDeleteConfirmCopy", () => {
  describe("dirty classification (three-state, mutually exclusive)", () => {
    test("confirmed-clean: status resolved with dirty=false, ignored=false -> no warning, non-destructive label", () => {
      const copy = buildDeleteConfirmCopy(worktree(), gitStatus({ dirty: false, ignored: false }));
      expect(copy.showDirtyWarning).toBe(false);
      expect(copy.unknown).toBe(false);
      expect(copy.confirmLabel).toBe("Archive & delete");
    });

    test("confirmed-dirty: status resolved with dirty=true, ignored=false -> dirty warning, destructive label", () => {
      const copy = buildDeleteConfirmCopy(worktree(), gitStatus({ dirty: true, ignored: false }));
      expect(copy.showDirtyWarning).toBe(true);
      expect(copy.unknown).toBe(false);
      expect(copy.confirmLabel).toBe("Discard changes & delete");
    });

    test("unknown: status is null -> unknown flag, destructive label, no dirty warning", () => {
      const copy = buildDeleteConfirmCopy(worktree(), null);
      expect(copy.unknown).toBe(true);
      expect(copy.showDirtyWarning).toBe(false);
      expect(copy.confirmLabel).toBe("Discard changes & delete");
    });

    // Load-bearing case: the server's worktreeGitStatus sets ignored: true
    // precisely when hasUncommittedChanges returned null (not a git repo, or
    // `git status` failed on a broken worktree registration) — it means
    // "couldn't determine", never "clean". Before this was fixed, a status
    // with ignored: true but dirty: false (its zero-value default) was
    // treated as confirmed-clean, so the UI force-deleted the worktree
    // (deleteTaskBacked always sends forceWorktree: true) with no warning at
    // all, silently discarding whatever uncommitted work was actually there.
    test("unknown: status.ignored=true (even with dirty=false) is NOT treated as clean — must not silently force-delete uncommitted work", () => {
      const copy = buildDeleteConfirmCopy(worktree(), gitStatus({ dirty: false, ignored: true }));
      expect(copy.unknown).toBe(true);
      expect(copy.showDirtyWarning).toBe(false);
      expect(copy.confirmLabel).toBe("Discard changes & delete");
    });

    test("unknown: status.ignored=true with dirty=true is still classified unknown, not dirty", () => {
      const copy = buildDeleteConfirmCopy(worktree(), gitStatus({ dirty: true, ignored: true }));
      expect(copy.unknown).toBe(true);
      expect(copy.showDirtyWarning).toBe(false);
    });

    test("the three states are mutually exclusive: showDirtyWarning and unknown are never both true", () => {
      const cases: Array<WorktreeGitStatus | null> = [
        null,
        gitStatus({ dirty: false, ignored: false }),
        gitStatus({ dirty: true, ignored: false }),
        gitStatus({ dirty: false, ignored: true }),
        gitStatus({ dirty: true, ignored: true }),
      ];
      for (const status of cases) {
        const copy = buildDeleteConfirmCopy(worktree(), status);
        expect(copy.showDirtyWarning && copy.unknown).toBe(false);
      }
    });

    test("the three states are exhaustive across the input space: every case is clean, dirty, or unknown", () => {
      const cases: Array<WorktreeGitStatus | null> = [
        null,
        gitStatus({ dirty: false, ignored: false }),
        gitStatus({ dirty: true, ignored: false }),
        gitStatus({ dirty: false, ignored: true }),
        gitStatus({ dirty: true, ignored: true }),
      ];
      for (const status of cases) {
        const copy = buildDeleteConfirmCopy(worktree(), status);
        const isClean = !copy.showDirtyWarning && !copy.unknown;
        const isDirty = copy.showDirtyWarning && !copy.unknown;
        const isUnknown = !copy.showDirtyWarning && copy.unknown;
        // Exactly one of the three states is true.
        expect([isClean, isDirty, isUnknown].filter(Boolean).length).toBe(1);
      }
    });
  });

  describe("alreadyArchived crossed with dirty classification", () => {
    test("not archived + confirmed-clean", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: null }), gitStatus({ dirty: false }));
      expect(copy.alreadyArchived).toBe(false);
      expect(copy.showDirtyWarning).toBe(false);
    });

    test("not archived + confirmed-dirty", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: null }), gitStatus({ dirty: true }));
      expect(copy.alreadyArchived).toBe(false);
      expect(copy.showDirtyWarning).toBe(true);
    });

    test("not archived + unknown", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: null }), null);
      expect(copy.alreadyArchived).toBe(false);
      expect(copy.unknown).toBe(true);
    });

    test("already archived + confirmed-clean", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: 1700000000000 }), gitStatus({ dirty: false }));
      expect(copy.alreadyArchived).toBe(true);
      expect(copy.showDirtyWarning).toBe(false);
    });

    test("already archived + confirmed-dirty", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: 1700000000000 }), gitStatus({ dirty: true }));
      expect(copy.alreadyArchived).toBe(true);
      expect(copy.showDirtyWarning).toBe(true);
    });

    test("already archived + unknown", () => {
      const copy = buildDeleteConfirmCopy(worktree({ archivedAt: 1700000000000 }), null);
      expect(copy.alreadyArchived).toBe(true);
      expect(copy.unknown).toBe(true);
    });
  });

  describe("title", () => {
    test("uses the branch name when present", () => {
      const copy = buildDeleteConfirmCopy(worktree({ branch: "agetor/abc-fix-thing" }), gitStatus());
      expect(copy.title).toBe('Delete worktree "agetor/abc-fix-thing"?');
    });

    test("falls back to the worktree id when branch is null", () => {
      const copy = buildDeleteConfirmCopy(worktree({ branch: null, id: "orphan-dir-1" }), gitStatus());
      expect(copy.title).toBe('Delete worktree "orphan-dir-1"?');
    });
  });
});

describe("triageDeleteOutcome", () => {
  test("removed: true -> silent (the obvious success case)", () => {
    const teardown: WorktreeTeardownResult = { removed: true };
    expect(triageDeleteOutcome(teardown, "feature-branch")).toEqual({ kind: "silent" });
  });

  test("undefined teardown -> silent (caller didn't await teardown; list refresh speaks for itself)", () => {
    expect(triageDeleteOutcome(undefined, "feature-branch")).toEqual({ kind: "silent" });
  });

  test('reason "no-worktree" -> silent, NOT an error: nothing left to remove is success, not failure', () => {
    const teardown: WorktreeTeardownResult = { removed: false, reason: "no-worktree" };
    expect(triageDeleteOutcome(teardown, "feature-branch")).toEqual({ kind: "silent" });
  });

  test('reason "already-absent" -> silent, NOT an error: nothing left to remove is success, not failure', () => {
    const teardown: WorktreeTeardownResult = { removed: false, reason: "already-absent" };
    expect(triageDeleteOutcome(teardown, "feature-branch")).toEqual({ kind: "silent" });
  });

  test('reason "dirty" -> error, naming the branch', () => {
    const teardown: WorktreeTeardownResult = { removed: false, reason: "dirty" };
    const outcome = triageDeleteOutcome(teardown, "feature-branch");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("feature-branch");
      expect(outcome.message).toContain("uncommitted");
    }
  });

  test('reason "failed" -> error, naming the branch', () => {
    const teardown: WorktreeTeardownResult = { removed: false, reason: "failed" };
    const outcome = triageDeleteOutcome(teardown, "feature-branch");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("feature-branch");
      expect(outcome.message).toContain("removal");
    }
  });

  test("unrecognized/absent reason with removed: false falls into the default arm -> error", () => {
    // Cast to bypass the reason union — simulating a future/unknown server value
    // reaching the default arm, which the switch must still treat as a failure.
    const teardown = { removed: false } as WorktreeTeardownResult;
    const outcome = triageDeleteOutcome(teardown, "feature-branch");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("feature-branch");
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  test("error messages fall back sensibly when branch is null", () => {
    const teardown: WorktreeTeardownResult = { removed: false, reason: "failed" };
    const outcome = triageDeleteOutcome(teardown, null);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("this worktree");
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });
});
