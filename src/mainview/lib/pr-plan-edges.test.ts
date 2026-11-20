// Edge cases of the Create-all-PRs planner and batch runner that the main
// suite (pr-plan.test.ts) leaves open: the batch's own re-check of a tampered
// row, retry after a failed walk, user edits on the confirm list, names the core
// would refuse, an incomplete branch listing, and the per-repository inputs
// `planReposForTask` derives from a task row
// (docs/plans/create-all-prs-title-and-base.md T10, C1, C2, C4).
import { beforeEach, describe, expect, test } from "bun:test";
import type { PullTargetsResult, RunEvent, Task, TaskPr, TaskRepository } from "../../shared/types.ts";
import { resetPrBatchesForTest } from "./multi-repo-ui.ts";
import {
  appendIssueCloseDirective,
  buildPrPlan,
  editPrRow,
  planReposForTask,
  runPrBatch,
  type PrPlanDeps,
  type PrPlanInput,
  type PrPlanRepo,
  type PrRow,
  type PrRowResult,
  type PullTargetsQuery,
} from "./pr-plan.ts";

beforeEach(() => resetPrBatchesForTest());

const block = (title: string, desc: string) =>
  ["PR title:", "```", title, "```", "", "PR description:", "````", desc, "````"].join("\n");

const ev = (data: string): RunEvent => ({ runId: "r1", taskId: "t1", stream: "assistant", data, ts: 0 }) as RunEvent;

const repo = (over: Partial<PrPlanRepo> = {}): PrPlanRepo => ({
  name: "app",
  projectPath: "/work/app",
  liveHead: "feature/login",
  branch: "feature/login",
  prs: [],
  storedBase: null,
  storedBaseSha: null,
  isIssueRepo: false,
  identity: { host: "github.com", owner: "acme", name: "app" },
  ...over,
});

const targets = (over: Partial<PullTargetsResult> = {}): PullTargetsResult => ({
  provider: "github",
  host: "github.com",
  owner: "acme",
  name: "app",
  remote: "origin",
  remotes: ["origin"],
  defaultBranch: "main",
  branches: ["main", "develop", "feature/login"],
  branchesTruncated: false,
  branchesError: null,
  heads: [],
  storedBase: null,
  ...over,
});

/** Answers every query with `over`, filling `heads` from the query against the listing. */
function deps(over: Partial<PullTargetsResult> = {}, calls: PullTargetsQuery[] = []): PrPlanDeps {
  return {
    providerInfo: async () => null,
    pullTargets: async (q) => {
      calls.push(q);
      const t = targets(over);
      return { ...t, heads: q.heads.map((name) => ({ name, onRemote: t.branches.includes(name) })) };
    },
  };
}

const input = (over: Partial<PrPlanInput> = {}): PrPlanInput => ({
  taskId: "t1",
  repos: [repo()],
  events: [],
  rootTitle: "Root title",
  issueUrl: null,
  multi: false,
  ...over,
});

const row = (over: Partial<PrRow> = {}): PrRow => ({
  key: "app::feature/login",
  repoName: "app",
  projectPath: "/work/app",
  remote: "origin",
  head: "feature/login",
  isLiveHead: true,
  checked: true,
  disabledReason: null,
  base: "main",
  baseSource: "default",
  baseOptions: [
    { name: "main", onRemote: true },
    { name: "develop", onRemote: true },
    { name: "ghost", onRemote: false },
  ],
  baseError: null,
  hints: [],
  title: "T",
  body: "",
  hasProposal: true,
  ...over,
});

describe("runPrBatch re-checks every row it is handed", () => {
  test("a checked row that carries a disabled reason is skipped with that reason and never created", async () => {
    const results: Array<[string, PrRowResult]> = [];
    const created: string[] = [];
    const summary = await runPrBatch(
      "t1",
      [row({ key: "extra", head: "feature/ghost", isLiveHead: false, checked: true, disabledReason: "branch `feature/ghost` isn't on origin" })],
      {
        createPull: async (r) => {
          created.push(r.head);
          return { url: "https://x/1" };
        },
        onResult: (k, r) => results.push([k, r]),
      },
    );
    expect(created).toEqual([]);
    expect(summary).toMatchObject({ created: 0, alreadyOpen: 0, failed: [] });
    expect(results).toEqual([["extra", { status: "skipped", reason: "branch `feature/ghost` isn't on origin" }]]);
  });

  test("a failed create is not remembered: the walk ends, a new walk may start, and a re-plan offers the row again", async () => {
    const first = await runPrBatch("t1", [row()], {
      createPull: async () => {
        throw new Error("500 boom");
      },
      onResult: () => {},
    });
    expect(first.failed).toEqual(["app (feature/login): 500 boom"]);
    expect(first.busy).toBeUndefined();

    const rows = await buildPrPlan(input(), deps());
    expect(rows.map((r) => r.head)).toEqual(["feature/login"]);
    expect(rows[0]!.checked).toBe(true);

    const second = await runPrBatch("t1", rows, { createPull: async () => ({ url: "https://x/2" }), onResult: () => {} });
    expect(second).toMatchObject({ created: 1, failed: [] });
    expect(second.busy).toBeUndefined();
  });

  test("walks are per task: another task's walk is not refused while one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = runPrBatch("t1", [row()], {
      createPull: async () => {
        await gate;
        return { url: "https://x/1" };
      },
      onResult: () => {},
    });
    const other = await runPrBatch("t2", [row()], { createPull: async () => ({ url: "https://x/2" }), onResult: () => {} });
    expect(other).toMatchObject({ created: 1 });
    expect(other.busy).toBeUndefined();
    release();
    expect((await slow).created).toBe(1);
  });
});

describe("editPrRow", () => {
  test("checking a disabled row leaves it unchecked; unchecking an enabled one sticks", () => {
    expect(editPrRow(row({ checked: false, disabledReason: "branch is not pushed yet" }), { checked: true }).checked).toBe(false);
    expect(editPrRow(row(), { checked: false }).checked).toBe(false);
    expect(editPrRow(row({ checked: false }), { checked: true }).checked).toBe(true);
  });

  test("a base the user picks is marked 'user' and checked against the row's options", () => {
    const listed = editPrRow(row({ baseError: "Base branch `x` isn't on origin." }), { base: "develop" });
    expect(listed).toMatchObject({ base: "develop", baseSource: "user", baseError: null });

    const missing = editPrRow(row(), { base: "ghost" });
    expect(missing.baseError).toBe("Base branch `ghost` isn't on origin.");

    // Not in the options at all: existence unknown, so not an error.
    expect(editPrRow(row(), { base: "unlisted" }).baseError).toBeNull();

    expect(editPrRow(row(), { base: "" }).baseError).toBe("No base branch could be determined; pick one.");
    expect(editPrRow(row(), { base: "feature/login" }).baseError).toContain("same branch");
  });

  test("a title edit keeps the base and its source", () => {
    const edited = editPrRow(row({ base: "develop", baseSource: "task" }), { title: "New title" });
    expect(edited).toMatchObject({ title: "New title", base: "develop", baseSource: "task", baseError: null });
  });

  test("the edit returns a new row and leaves the original untouched", () => {
    const original = row();
    const edited = editPrRow(original, { base: "develop", title: "x", checked: false });
    expect(original).toMatchObject({ base: "main", baseSource: "default", title: "T", checked: true });
    expect(edited).not.toBe(original);
  });
});

describe("buildPrPlan input safety and incomplete facts", () => {
  test("a proposed head git would refuse never reaches the pull-targets query, and its row is disabled", async () => {
    const reply = ["https://github.com/acme/app/pull/new/bad~name", block("Bad", "d")].join("\n");
    const calls: PullTargetsQuery[] = [];
    const rows = await buildPrPlan(input({ events: [ev(reply)] }), deps({}, calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.heads).toEqual(["feature/login"]);
    const bad = rows.find((r) => r.head === "bad~name")!;
    expect(bad).toBeDefined();
    expect(bad.checked).toBe(false);
    expect(bad.disabledReason).toBe("`bad~name` isn't a valid branch name");
  });

  test("a base missing from a truncated listing is unknown, not an error; the same base on a complete listing is an error", async () => {
    const reply = ["Base: release/9", block("Login", "d")].join("\n");
    const [truncated] = await buildPrPlan(input({ events: [ev(reply)] }), deps({ branchesTruncated: true }));
    expect(truncated).toMatchObject({ base: "release/9", baseSource: "agent", baseError: null, checked: true });
    expect(truncated!.baseOptions).toContainEqual({ name: "release/9", onRemote: null });

    const [complete] = await buildPrPlan(input({ events: [ev(reply)] }), deps());
    expect(complete!.baseError).toBe("Base branch `release/9` isn't on origin.");
  });

  test("a failed branch listing says so in the hints and doesn't turn the base into an error", async () => {
    const reply = ["Base: develop", block("Login", "d")].join("\n");
    const [r] = await buildPrPlan(
      input({ events: [ev(reply)] }),
      deps({ branches: [], branchesError: "403 rate limited" }),
    );
    expect(r).toMatchObject({ base: "develop", baseError: null, checked: true });
    expect(r!.hints).toContain("couldn't list branches: 403 rate limited");
  });

  test("the base error names the remote the identity came from", async () => {
    const [r] = await buildPrPlan(
      input({ repos: [repo({ storedBase: "gone" })] }),
      deps({ remote: "upstream", remotes: ["upstream"], storedBase: { name: "gone", onRemote: false, stale: false } }),
    );
    expect(r!.baseError).toBe("Base branch `gone` isn't on upstream.");
  });
});

describe("appendIssueCloseDirective", () => {
  test("a Bitbucket issue gets 'Issue #N'; an empty body gets the directive alone", () => {
    expect(appendIssueCloseDirective("body", "https://bitbucket.org/ws/repo/issues/12")).toBe("body\n\nIssue #12");
    expect(appendIssueCloseDirective("", "https://github.com/acme/app/issues/7")).toBe("Closes #7");
    expect(appendIssueCloseDirective("x", "not a url")).toBe("x");
  });
});

describe("planReposForTask derives each repository's planner input from the task row", () => {
  const synced = { branch: "agetor/x", isDefaultBranch: false, ignored: false, remoteSynced: true };
  const entry = (over: Partial<TaskRepository>): TaskRepository => ({
    path: "/src/app",
    name: "app",
    branch: "agetor/x",
    branchSource: "created",
    worktreePath: "/wt/app",
    baseRef: "a".repeat(40),
    checkoutBranch: null,
    prUrl: null,
    baseBranch: "develop",
    prs: [],
    ...over,
  });
  const pr: TaskPr = { url: "https://github.com/acme/infra/pull/3", head: "agetor/x", base: "main", number: 3, createdAt: 1 };

  test("multi: each entry's worktree, stored base and sha, PRs, and only the issue's repository closes it", () => {
    const task = {
      workdir: "/workspace",
      isolation: "worktree",
      branch: null,
      branchSource: "created",
      worktreePath: "/workspace",
      baseRef: null,
      checkoutBranch: null,
      prUrl: null,
      prs: [],
      baseBranch: null,
      multiRepo: true,
      issueUrl: "https://github.com/acme/infra/issues/4",
      issueRepoPath: "/src/infra",
      repositories: [
        entry({}),
        entry({ path: "/src/infra", name: "infra", worktreePath: null, baseRef: null, baseBranch: null, prs: [pr] }),
      ],
    } as unknown as Task;
    const status = {
      repositories: [
        { name: "app", ...synced },
        { name: "infra", ...synced },
      ],
    } as never;
    const [app, infra] = planReposForTask(task, status);
    expect(app).toMatchObject({
      name: "app",
      projectPath: "/wt/app",
      liveHead: "agetor/x",
      storedBase: "develop",
      storedBaseSha: "a".repeat(40),
      isIssueRepo: false,
      prs: [],
    });
    // No worktree yet: forge calls run in the selected source path.
    expect(infra).toMatchObject({
      name: "infra",
      projectPath: "/src/infra",
      storedBase: null,
      storedBaseSha: null,
      isIssueRepo: true,
      prs: [pr],
    });
  });

  test("single: the task's workdir, base branch and pinned sha; an issue task closes its issue; a legacy prUrl counts as a PR", () => {
    const task = {
      workdir: "/src/app",
      isolation: "worktree",
      branch: "agetor/x",
      branchSource: "created",
      worktreePath: "/wt/app",
      baseRef: "b".repeat(40),
      checkoutBranch: null,
      prUrl: "https://github.com/acme/app/pull/9",
      baseBranch: "release/1.2",
      repositories: undefined,
      multiRepo: false,
      issueUrl: "https://github.com/acme/app/issues/8",
      issueRepoPath: null,
    } as unknown as Task;
    const [r] = planReposForTask(task, synced as never);
    expect(r).toMatchObject({
      projectPath: "/src/app",
      liveHead: "agetor/x",
      storedBase: "release/1.2",
      storedBaseSha: "b".repeat(40),
      isIssueRepo: true,
    });
    // JSON from an older core (prUrl, no prs): the PR still covers the live head.
    expect(r!.prs.map((p) => p.url)).toEqual(["https://github.com/acme/app/pull/9"]);
  });

  test("an unsynced single-repo checkout has no live head, so the chip has nothing to open", () => {
    const task = {
      workdir: "/src/app",
      isolation: "worktree",
      branch: "agetor/x",
      branchSource: "created",
      worktreePath: "/wt/app",
      baseRef: null,
      checkoutBranch: null,
      prUrl: null,
      prs: [],
      baseBranch: null,
      repositories: undefined,
      multiRepo: false,
      issueUrl: null,
      issueRepoPath: null,
    } as unknown as Task;
    const [r] = planReposForTask(task, { ...synced, remoteSynced: false } as never);
    expect(r).toMatchObject({ liveHead: null, branch: "agetor/x", isIssueRepo: false });
  });
});
