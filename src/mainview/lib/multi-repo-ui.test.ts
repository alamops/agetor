// Multi-repository webview rules (issue #291) that the New Task form, the
// issue dialog, the Repositories dialog, the board and the run panel delegate
// to. See docs/architecture/multi-repo-tasks.md.
import { afterEach, describe, expect, test } from "bun:test";
import {
  beginPrBatch,
  createSessionGuard,
  describeRootConflict,
  endPrBatch,
  isPrBatchRunning,
  markRepositoryPrOpened,
  mergeSelectionsByRoot,
  multiRepoDeleteFallback,
  openFolderUnavailableReason,
  repositoriesForPrBatch,
  resetPrBatchesForTest,
  repositoryCountLabel,
  resolveConflictsKey,
  selectedRepositoryName,
  subscribePrBatches,
  taskSearchText,
} from "./multi-repo-ui.ts";
import type { TaskRepository } from "../../shared/types.ts";

function repo(over: Partial<TaskRepository> & { name: string }): TaskRepository {
  return {
    path: `/src/${over.name}`,
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    checkoutBranch: null,
    prUrl: null,
    ...over,
  };
}

describe("mergeSelectionsByRoot (W5)", () => {
  test("a base ref set on a collapsed duplicate survives on the kept entry", () => {
    const { kept, merges, conflicts } = mergeSelectionsByRoot([
      { path: "/repo/a", root: "/repo" },
      { path: "/repo/b", root: "/repo", baseRef: "release/1.2" },
      { path: "/other", root: "/other" },
    ]);
    expect(kept).toEqual([
      { path: "/repo/a", root: "/repo", baseRef: "release/1.2" },
      { path: "/other", root: "/other" },
    ]);
    expect(merges).toEqual([{ path: "/repo/a", merged: ["/repo/b"] }]);
    expect(conflicts).toEqual([]);
  });

  test("the kept entry's own base ref wins when both agree", () => {
    const { kept, conflicts } = mergeSelectionsByRoot([
      { path: "/repo/a", root: "/repo", baseRef: "main" },
      { path: "/repo/b", root: "/repo", baseRef: " main " },
    ]);
    expect(kept).toEqual([{ path: "/repo/a", root: "/repo", baseRef: "main" }]);
    expect(conflicts).toEqual([]);
  });

  test("two different base refs on one root are a conflict naming both", () => {
    const { conflicts } = mergeSelectionsByRoot([
      { path: "/repo/a", root: "/repo", baseRef: "main" },
      { path: "/repo/b", root: "/repo", baseRef: "dev" },
    ]);
    expect(conflicts).toEqual([{ entries: [{ path: "/repo/a", baseRef: "main" }, { path: "/repo/b", baseRef: "dev" }] }]);
    expect(describeRootConflict(conflicts[0]!)).toContain("/repo/a (main) and /repo/b (dev)");
  });

  test("unknown roots are always kept", () => {
    expect(mergeSelectionsByRoot([{ path: "/a", root: null }, { path: "/b", root: null }]).kept).toHaveLength(2);
  });
});

describe("taskSearchText (S13)", () => {
  test("a multi task is found by any repository's branch or checkout branch", () => {
    const text = taskSearchText({
      title: "t",
      prompt: "p",
      workdir: "/ws",
      branch: null,
      repositories: [
        repo({ name: "fe", branch: "feature/auth" }),
        repo({ name: "be", branch: "feature/auth-2", checkoutBranch: "hotfix/Drift" }),
      ],
    });
    expect(text).toContain("feature/auth-2");
    expect(text).toContain("hotfix/drift");
  });

  test("a single task's text is unchanged (no checkout branch folded in)", () => {
    const t = {
      title: "T",
      prompt: "P",
      workdir: "/w",
      branch: "b",
      repositories: [repo({ name: "w", path: "/w", branch: "b", checkoutBranch: "drift" })],
    };
    expect(taskSearchText(t)).toBe("t\np\n/w\nb\nw /w");
  });

  test("a multi task left with one repository still folds its branches in (round 15)", () => {
    const text = taskSearchText({
      title: "t",
      prompt: "p",
      workdir: "/ws",
      branch: null,
      multiRepo: true,
      repositories: [repo({ name: "fe", branch: "feature/auth", checkoutBranch: "hotfix/Drift" })],
    });
    expect(text).toContain("feature/auth");
    expect(text).toContain("hotfix/drift");
  });
});

describe("multiRepoDeleteFallback (N6a)", () => {
  test("names each repository's branch and drifted checkout", () => {
    expect(
      multiRepoDeleteFallback([
        repo({ name: "fe", branch: "feature/x" }),
        repo({ name: "be", branch: "feature/x", checkoutBranch: "other" }),
      ]),
    ).toEqual({ branches: "fe: feature/x, be: feature/x", maybeDrifted: "be: other" });
  });

  test("no branches yields null instead of an empty parenthetical", () => {
    expect(multiRepoDeleteFallback([repo({ name: "fe" }), repo({ name: "be" })])).toEqual({
      branches: null,
      maybeDrifted: null,
    });
  });
});

describe("openFolderUnavailableReason (S11)", () => {
  test("a never-started multi task has no folder yet", () => {
    expect(openFolderUnavailableReason({ worktreePath: null, repositories: [{}, {}] })).toContain("first runs");
  });

  test("a materialized multi task and any single task can open", () => {
    expect(openFolderUnavailableReason({ worktreePath: "/ws", repositories: [{}, {}] })).toBeNull();
    expect(openFolderUnavailableReason({ worktreePath: null, repositories: [{}] })).toBeNull();
    expect(openFolderUnavailableReason({ worktreePath: null })).toBeNull();
  });

  test("a never-started multi task left with one repository has no folder yet either (round 15)", () => {
    expect(openFolderUnavailableReason({ worktreePath: null, multiRepo: true, repositories: [{}] })).toContain("first runs");
    expect(openFolderUnavailableReason({ worktreePath: null, multiRepo: false, repositories: [{}] })).toBeNull();
  });
});

describe("selectedRepositoryName (round 15)", () => {
  const two = { multiRepo: true, repositories: [{ name: "fe" }, { name: "be" }] };
  test("keeps a selection that is still on the task, else the first repository", () => {
    expect(selectedRepositoryName(two, "be")).toBe("be");
    expect(selectedRepositoryName(two, null)).toBe("fe");
    // The selected repository was removed from the task.
    expect(selectedRepositoryName({ multiRepo: true, repositories: [{ name: "fe" }] }, "be")).toBe("fe");
  });

  test("a multi task left with one repository still has its tab; a single task has none", () => {
    expect(selectedRepositoryName({ multiRepo: true, repositories: [{ name: "fe" }] }, null)).toBe("fe");
    expect(selectedRepositoryName({ multiRepo: false, repositories: [{ name: "w" }] }, "w")).toBeNull();
    // An older core's JSON (no `multiRepo`) still decides by the count.
    expect(selectedRepositoryName({ repositories: [{ name: "w" }] }, null)).toBeNull();
    expect(selectedRepositoryName({ repositories: [{ name: "a" }, { name: "b" }] }, null)).toBe("a");
  });
});

describe("repositoryCountLabel (round 15)", () => {
  test("is singular for one repository", () => {
    expect(repositoryCountLabel(1)).toBe("1 repository");
    expect(repositoryCountLabel(3)).toBe("3 repositories");
  });
});

describe("resolveConflictsKey (N6b)", () => {
  test("is per repository tab for a multi task and constant for a single task", () => {
    expect(resolveConflictsKey(true, "fe")).not.toBe(resolveConflictsKey(true, "be"));
    expect(resolveConflictsKey(false, "fe")).toBe(resolveConflictsKey(false, null));
  });
});

describe("Create all PRs registry (S12)", () => {
  afterEach(() => resetPrBatchesForTest());

  test("only one walk per task, independent of other tasks", () => {
    expect(beginPrBatch("a")).toBe(true);
    expect(beginPrBatch("a")).toBe(false);
    expect(isPrBatchRunning("a")).toBe(true);
    expect(isPrBatchRunning("b")).toBe(false);
    expect(beginPrBatch("b")).toBe(true);
    endPrBatch("a");
    expect(isPrBatchRunning("a")).toBe(false);
    expect(beginPrBatch("a")).toBe(true);
  });

  test("subscribers hear begin and end", () => {
    let calls = 0;
    const off = subscribePrBatches(() => { calls += 1; });
    beginPrBatch("a");
    endPrBatch("a");
    endPrBatch("a"); // already ended: no extra notification
    off();
    beginPrBatch("a");
    expect(calls).toBe(2);
  });

  test("a repository opened by an earlier walk is skipped before the poll stamps it", () => {
    const repos = [repo({ name: "fe" }), repo({ name: "be" }), repo({ name: "db", prUrl: "https://x/pull/1" })];
    expect(repositoriesForPrBatch("t", repos).map((r) => r.name)).toEqual(["fe", "be"]);
    markRepositoryPrOpened("t", "fe");
    expect(repositoriesForPrBatch("t", repos).map((r) => r.name)).toEqual(["be"]);
    // Scoped to its task.
    expect(repositoriesForPrBatch("other", repos).map((r) => r.name)).toEqual(["fe", "be"]);
  });
});

describe("createSessionGuard (S10)", () => {
  test("a save abandoned by close/cancel is stale and must not apply", () => {
    const guard = createSessionGuard();
    const token = guard.begin();
    expect(guard.isCurrent(token)).toBe(true);
    guard.invalidate(); // Cancel / Escape while the root lookup is in flight
    expect(guard.isCurrent(token)).toBe(false);
  });

  test("a newer save supersedes an older one", () => {
    const guard = createSessionGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
