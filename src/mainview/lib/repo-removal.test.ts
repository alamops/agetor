// The run panel's per-repository details and "Remove from task" rules for a
// multi-repository task (issue #291, round 15). See
// docs/architecture/multi-repo-tasks.md.
import { describe, expect, test } from "bun:test";
import {
  removalMergeFields,
  removeRepositoryBlockReason,
  removeRepositoryConfirmCopy,
  repositoryDetails,
  repositoryProblem,
} from "./repo-removal.ts";
import type { Task, TaskRepository } from "../../shared/types.ts";

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

const two = [repo({ name: "fe" }), repo({ name: "be" })];

describe("removeRepositoryBlockReason", () => {
  test("an idle multi task with two or more repositories can remove one", () => {
    expect(removeRepositoryBlockReason({ column: "review", runId: null, repositories: two })).toBeNull();
  });

  test("a running or blocked task, or one with a live run, can't", () => {
    expect(removeRepositoryBlockReason({ column: "running", runId: null, repositories: two })).toContain("running");
    expect(removeRepositoryBlockReason({ column: "blocked", runId: null, repositories: two })).toContain("running");
    expect(removeRepositoryBlockReason({ column: "ready", runId: "r1", repositories: two })).toContain("running");
  });

  test("a pipeline step points at its pipeline task", () => {
    expect(
      removeRepositoryBlockReason({ column: "review", runId: null, repositories: two, pipelineParentId: "p1" }),
    ).toContain("pipeline");
  });

  test("the last repository can't be removed", () => {
    expect(removeRepositoryBlockReason({ column: "review", runId: null, repositories: [repo({ name: "fe" })] }))
      .toContain("at least one repository");
  });
});

describe("removeRepositoryConfirmCopy", () => {
  test("names the detached checkout, the kept branch, the dirty refusal and that it can't be undone here", () => {
    const copy = removeRepositoryConfirmCopy(
      repo({ name: "be", path: "/src/be", branch: "agetor/abc-be", worktreePath: "/ws/be" }),
    );
    expect(copy.title).toBe("Remove be from this task?");
    const text = copy.lines.join("\n");
    expect(text).toContain("/ws/be is detached");
    expect(text).toContain("The branch agetor/abc-be is kept in /src/be");
    expect(text).toContain("Uncommitted changes in the checkout block the removal.");
    expect(text).toContain("can't be undone from here");
  });

  test("a repository with no checkout or branch yet says so", () => {
    const text = removeRepositoryConfirmCopy(repo({ name: "be" })).lines.join("\n");
    expect(text).toContain("no checkout yet");
    expect(text).toContain("No branch was created");
  });
});

describe("repositoryProblem", () => {
  test("an unreadable status flags the repository; a readable or unknown one doesn't", () => {
    expect(repositoryProblem(repo({ name: "be", worktreePath: "/ws/be" }), { ignored: true })).toContain("Checkout");
    expect(repositoryProblem(repo({ name: "be" }), { ignored: true })).toContain("Source repository");
    expect(repositoryProblem(repo({ name: "be" }), { ignored: false })).toBeNull();
    expect(repositoryProblem(repo({ name: "be" }), null)).toBeNull();
  });
});

describe("repositoryDetails", () => {
  test("shows branch, short base, checkout path and PR; drift reads the live branch", () => {
    const [fe, be] = repositoryDetails(
      [
        repo({
          name: "fe",
          branch: "agetor/x-fe",
          baseRef: "0123456789abcdef",
          worktreePath: "/ws/fe",
          prUrl: "https://github.com/o/fe/pull/3",
        }),
        repo({ name: "be", branch: "agetor/x-be", checkoutBranch: "agetor/x-be" }),
      ],
      (name) => (name === "fe" ? { ignored: false, branch: "hotfix" } : null),
    );
    expect(fe).toMatchObject({
      branchText: "on hotfix (drifted from agetor/x-fe)",
      drifted: true,
      base: "0123456789ab",
      checkoutText: "/ws/fe",
      checkoutCreated: true,
      prUrl: "https://github.com/o/fe/pull/3",
      problem: null,
    });
    expect(be).toMatchObject({
      branchText: "agetor/x-be",
      drifted: false,
      base: null,
      checkoutText: "not created yet",
      checkoutCreated: false,
      prUrl: null,
    });
  });

  test("an unreadable checkout falls back to the recorded checkout and is flagged", () => {
    const [be] = repositoryDetails(
      [repo({ name: "be", branch: "agetor/x-be", checkoutBranch: "other", worktreePath: "/ws/be" })],
      () => ({ ignored: true, branch: null }),
    );
    expect(be!.branchText).toBe("on other (drifted from agetor/x-be)");
    expect(be!.problem).toContain("missing");
  });
});

describe("removalMergeFields", () => {
  test("merges only the fields a removal changes", () => {
    const updated = {
      id: "t1",
      title: "stale title",
      repositories: [repo({ name: "fe" })],
      issueRepoPath: null,
      multiRepo: true,
    } as unknown as Task;
    expect(removalMergeFields(updated)).toEqual({
      repositories: [repo({ name: "fe" })],
      issueRepoPath: null,
      multiRepo: true,
    });
  });
});
