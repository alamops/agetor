import { beforeEach, describe, expect, test } from "bun:test";
import type { PullTargetsResult, RunEvent, TaskPr } from "../../shared/types.ts";
import { resetPrBatchesForTest } from "./multi-repo-ui.ts";
import {
  alreadyOpenOf,
  appendIssueCloseDirective,
  attributeProposals,
  buildPrPlan,
  chooseBase,
  editPrRow,
  normalizeAgentBase,
  proposalHeadsNeedingPr,
  runPrBatch,
  type PrPlanDeps,
  type PrPlanInput,
  type PrPlanRepo,
  type PrRow,
  type PrRowResult,
} from "./pr-plan.ts";
import { collectRunProposals } from "./pr-proposal.ts";

beforeEach(() => resetPrBatchesForTest());

const block = (title: string, desc: string) =>
  ["PR title:", "```", title, "```", "", "PR description:", "````", desc, "````"].join("\n");

const ev = (data: string, runId = "r1"): RunEvent =>
  ({ runId, taskId: "t1", stream: "assistant", data, ts: 0 }) as RunEvent;

// The shape of a real reply: unlabeled, bare pull/new links, one extra head for app.
const REAL_REPLY = [
  "Pushed all branches.",
  "",
  "**PR-1: app**",
  "https://github.com/acme/app/pull/new/feature/login",
  block("Add login", "Adds login to app."),
  "",
  "**PR-2: infra**",
  "https://github.com/acme/infra/pull/new/feature/login",
  block("Add login infra", "Infra for login."),
  "",
  "**PR-3: app docs**",
  "https://github.com/acme/app/pull/new/feature/docs",
  block("Docs for login", "Docs."),
].join("\n");

const repo = (over: Partial<PrPlanRepo> & { name: string }): PrPlanRepo => ({
  projectPath: `/work/${over.name}`,
  liveHead: "feature/login",
  branch: "feature/login",
  prs: [],
  storedBase: null,
  storedBaseSha: null,
  isIssueRepo: false,
  identity: { host: "github.com", owner: "acme", name: over.name },
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
  branches: ["main", "develop", "feature/login", "feature/docs"],
  branchesTruncated: false,
  branchesError: null,
  heads: [],
  storedBase: null,
  ...over,
});

/** A pullTargets dep that answers per project path and fills `heads` from the query. */
function depsFor(byPath: Record<string, Partial<PullTargetsResult>>, calls: unknown[] = []): PrPlanDeps {
  return {
    providerInfo: async () => null,
    pullTargets: async (q) => {
      calls.push(q);
      const t = targets(byPath[q.path] ?? {});
      const heads = q.heads.map((name) => ({ name, onRemote: t.branches.includes(name) }));
      const storedBase =
        q.storedBase && !("storedBase" in (byPath[q.path] ?? {}))
          ? { name: q.storedBase, onRemote: t.branches.includes(q.storedBase), stale: false }
          : t.storedBase;
      return { ...t, heads, storedBase };
    },
  };
}

const input = (over: Partial<PrPlanInput> & Pick<PrPlanInput, "repos" | "events">): PrPlanInput => ({
  taskId: "t1",
  rootTitle: "Root task title",
  issueUrl: null,
  multi: true,
  ...over,
});

describe("buildPrPlan — real three-PR reply", () => {
  test("each live-head row gets its own proposal, never the task title or a sibling's; the second app branch is an extra, unchecked row", async () => {
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app" }), repo({ name: "infra" })], events: [ev(REAL_REPLY)] }),
      depsFor({}),
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(rows).toHaveLength(3);
    const app = byKey["app::feature/login"]!;
    const infra = byKey["infra::feature/login"]!;
    const docs = byKey["app::feature/docs"]!;
    expect([app.title, app.body]).toEqual(["Add login", "Adds login to app."]);
    expect([infra.title, infra.body]).toEqual(["Add login infra", "Infra for login."]);
    expect([docs.title, docs.body]).toEqual(["Docs for login", "Docs."]);
    expect([app.checked, infra.checked, docs.checked]).toEqual([true, true, false]);
    expect(docs.isLiveHead).toBe(false);
    expect(docs.disabledReason).toBeNull();
  });

  test("no proposal at all falls back to the root title, an empty body and a hint", async () => {
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [] }), depsFor({}));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Root task title", body: "", hasProposal: false });
    expect(rows[0]!.hints.join(" ")).toContain("no proposal");
  });
});

describe("base precedence", () => {
  test("a stored base that isn't stale wins, with the agent's suggestion as a hint", async () => {
    const reply = ["Base: main", "https://github.com/acme/infra/pull/new/feature/login", block("T", "D")].join("\n");
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "infra", storedBase: "feature-base" })], events: [ev(reply)] }),
      depsFor({ "/work/infra": { branches: ["main", "feature-base", "feature/login"] } }),
    );
    expect(rows[0]).toMatchObject({ base: "feature-base", baseSource: "task", baseError: null });
    expect(rows[0]!.hints.join(" ")).toContain("agent suggests `main`");
  });

  test("a stale stored base with no agent base falls to the default and says why", async () => {
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", storedBase: "develop" })], events: [] }),
      depsFor({ "/work/app": { storedBase: { name: "develop", onRemote: true, stale: true } } }),
    );
    expect(rows[0]).toMatchObject({ base: "main", baseSource: "default" });
    expect(rows[0]!.hints.join(" ")).toContain("looks stale");
  });

  test("a stale stored base gives way to the agent's base before the default", async () => {
    const reply = ["Base: develop", block("T", "D")].join("\n");
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", storedBase: "old" })], events: [ev(reply)], multi: false }),
      depsFor({ "/work/app": { storedBase: { name: "old", onRemote: true, stale: true } } }),
    );
    expect(rows[0]).toMatchObject({ base: "develop", baseSource: "agent" });
  });

  test("with no stored base the agent's base comes before the default", async () => {
    const reply = ["Base: develop", block("T", "D")].join("\n");
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app" })], events: [ev(reply)], multi: false }),
      depsFor({}),
    );
    expect(rows[0]).toMatchObject({ base: "develop", baseSource: "agent" });
  });

  test("the Base: line beats the link's base, with a mismatch hint", async () => {
    const reply = [
      "Base: develop",
      "https://github.com/acme/app/compare/main...feature/login?quick_pull=1",
      block("T", "D"),
    ].join("\n");
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [ev(reply)] }), depsFor({}));
    expect(rows[0]!.base).toBe("develop");
    expect(rows[0]!.hints.join(" ")).toContain("the link says `main`");
  });

  test("an extra head never uses the stored base", async () => {
    const reply = [
      "https://github.com/acme/app/pull/new/feature/docs",
      block("Docs", "D"),
    ].join("\n");
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", storedBase: "develop" })], events: [ev(reply)] }),
      depsFor({}),
    );
    const docs = rows.find((r) => r.head === "feature/docs")!;
    expect(docs.base).toBe("main");
    expect(docs.baseSource).toBe("default");
  });

  test("a stored base missing on the remote errors the row, and editing the base clears it", async () => {
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", storedBase: "gone" })], events: [] }),
      depsFor({ "/work/app": { storedBase: { name: "gone", onRemote: false, stale: false } } }),
    );
    expect(rows[0]!.baseError).toContain("isn't on origin");
    const fixed = editPrRow(rows[0]!, { base: "develop" });
    expect(fixed.baseError).toBeNull();
    expect(fixed.baseSource).toBe("user");
  });

  test("a base equal to the head is an error", async () => {
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [] }), depsFor({}));
    expect(editPrRow(rows[0]!, { base: "feature/login" }).baseError).toContain("same branch");
  });

  test("an agent base of origin/develop normalizes to develop", async () => {
    const reply = ["Base: origin/develop", block("T", "D")].join("\n");
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app" })], events: [ev(reply)], multi: false }),
      depsFor({}),
    );
    expect(rows[0]!.base).toBe("develop");
  });
});

describe("chooseBase / normalizeAgentBase", () => {
  test("nothing known gives no base", () => {
    expect(chooseBase({ isLiveHead: true, storedBase: null, storedStale: null, agentBase: null, defaultBase: null }).base).toBeNull();
  });
  test("an unknown staleness keeps the stored base", () => {
    expect(
      chooseBase({ isLiveHead: true, storedBase: "x", storedStale: null, agentBase: "y", defaultBase: "main" }).base,
    ).toBe("x");
  });
  test("strips refs/heads/ and configured remotes, drops invalid names", () => {
    expect(normalizeAgentBase("refs/heads/develop", ["origin"])).toBe("develop");
    expect(normalizeAgentBase("origin/release/1.2", ["origin"])).toBe("release/1.2");
    expect(normalizeAgentBase("feature/x", ["origin"])).toBe("feature/x");
    expect(normalizeAgentBase("bad name", ["origin"])).toBeNull();
    expect(normalizeAgentBase("--evil", ["origin"])).toBeNull();
    expect(normalizeAgentBase(null, ["origin"])).toBeNull();
  });
});

describe("attribution", () => {
  const proposals = (text: string, runId = "r1") => collectRunProposals([ev(text, runId)]);
  const app = { name: "app", liveHead: "feature/login", identity: { host: "github.com", owner: "acme", name: "app" } };
  const infra = { name: "infra", liveHead: "feature/login", identity: { host: "github.com", owner: "acme", name: "infra" } };

  test("a labeled block whose link names another repository is ignored for that repository", () => {
    const text = ["Repository: app", "https://github.com/acme/infra/compare/main...feature/login", block("T", "D")].join("\n");
    const att = attributeProposals(proposals(text), [app, infra], { multi: true });
    expect(att.get("app")).toBeUndefined();
    expect(att.get("infra")?.get("feature/login")?.title).toBe("T");
  });

  test("a multi-repo unlabeled linkless proposal is unattributed; a single-repo one goes to the live head", () => {
    const text = block("T", "D");
    expect(attributeProposals(proposals(text), [app, infra], { multi: true }).size).toBe(0);
    const single = attributeProposals(proposals(text), [app], { multi: false });
    expect(single.get("app")?.get("feature/login")?.title).toBe("T");
  });

  test("a single-repo proposal whose link names another repository or head is never re-attributed", () => {
    const other = ["https://github.com/acme/other/compare/main...x", block("T", "D")].join("\n");
    expect(attributeProposals(proposals(other), [app], { multi: false }).size).toBe(0);
  });

  test("a label with no link attributes to the live head", () => {
    const text = ["Repository: infra", block("T", "D")].join("\n");
    const att = attributeProposals(proposals(text), [app, infra], { multi: true });
    expect(att.get("infra")?.get("feature/login")?.title).toBe("T");
  });

  test("the newest proposal per (repository, head) wins across runs", () => {
    const old = collectRunProposals([ev(["Repository: app", block("Old", "d")].join("\n"), "r1")]);
    const fresh = collectRunProposals([ev(["Repository: app", block("New", "d")].join("\n"), "r2")]);
    const all = [...old, ...fresh.map((p) => ({ ...p, order: p.order + 10 }))];
    const att = attributeProposals(all, [app], { multi: true });
    expect(att.get("app")?.get("feature/login")?.title).toBe("New");
  });

  test("a fork head is never attributed", () => {
    const text = ["https://github.com/acme/app/compare/main...someone:feature", block("T", "D")].join("\n");
    expect(attributeProposals(proposals(text), [app], { multi: false }).size).toBe(0);
  });
});

describe("row states", () => {
  test("an extra head that isn't on the remote, or whose status is unknown, is disabled", async () => {
    const reply = [
      "https://github.com/acme/app/pull/new/feature/ghost",
      block("Ghost", "d"),
    ].join("\n");
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [ev(reply)] }), depsFor({}));
    const ghost = rows.find((r) => r.head === "feature/ghost")!;
    expect(ghost.disabledReason).toContain("isn't on origin");
    expect(ghost.checked).toBe(false);

    const failing: PrPlanDeps = {
      providerInfo: async () => null,
      pullTargets: async () => {
        throw new Error("boom");
      },
    };
    const degraded = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [ev(reply)] }), failing);
    const live = degraded.find((r) => r.isLiveHead)!;
    const extra = degraded.find((r) => r.head === "feature/ghost")!;
    expect(live.checked).toBe(true);
    expect(extra.disabledReason).toContain("can't confirm");
    expect(live.hints.join(" ")).toContain("boom");
  });

  test("a head already in prs, or opened this session, has no row", async () => {
    const pr: TaskPr = { url: "https://x/1", head: "feature/login", base: "main", number: 1, createdAt: 1 };
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app", prs: [pr] })], events: [] }), depsFor({}));
    expect(rows).toHaveLength(0);
  });

  test("a repository with no live head and no PR gets one disabled 'not pushed yet' row", async () => {
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", liveHead: null, branch: "feature/login" })], events: [] }),
      depsFor({}),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disabledReason: "branch is not pushed yet", checked: false });
  });

  test("Closes #N goes only on the issue repository's live-head row", async () => {
    const reply = [
      "https://github.com/acme/app/pull/new/feature/login",
      block("A", "app body"),
      "",
      "https://github.com/acme/app/pull/new/feature/docs",
      block("B", "docs body"),
    ].join("\n");
    const rows = await buildPrPlan(
      input({
        repos: [repo({ name: "app", isIssueRepo: true }), repo({ name: "infra" })],
        events: [ev(reply)],
        issueUrl: "https://github.com/acme/app/issues/291",
      }),
      depsFor({}),
    );
    expect(rows.find((r) => r.head === "feature/login" && r.repoName === "app")!.body).toContain("Closes #291");
    expect(rows.find((r) => r.head === "feature/docs")!.body).toBe("docs body");
  });

  test("liveHeadOnly plans the live head only", async () => {
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app" })], events: [ev(REAL_REPLY)], liveHeadOnly: true }),
      depsFor({}),
    );
    expect(rows.map((r) => r.head)).toEqual(["feature/login"]);
  });

  test("the forge identity is resolved through providerInfo when not supplied", async () => {
    const reply = ["https://github.com/acme/app/pull/new/feature/login", block("T", "D")].join("\n");
    const deps: PrPlanDeps = {
      ...depsFor({}),
      providerInfo: async () => ({ host: "github.com", owner: "acme", name: "app" }),
    };
    const rows = await buildPrPlan(
      input({ repos: [repo({ name: "app", identity: undefined })], events: [ev(reply)] }),
      deps,
    );
    expect(rows[0]!.title).toBe("T");
  });
});

describe("proposalHeadsNeedingPr", () => {
  test("lists attributed heads without a PR", () => {
    const pr: TaskPr = { url: "https://x/1", head: "feature/login", base: null, number: 1, createdAt: 1 };
    const out = proposalHeadsNeedingPr({
      taskId: "t1",
      multi: true,
      proposals: collectRunProposals([ev(REAL_REPLY)]),
      repos: [repo({ name: "app", prs: [pr] }), repo({ name: "infra" })],
    });
    expect(out).toEqual([
      { repoName: "app", head: "feature/docs" },
      { repoName: "infra", head: "feature/login" },
    ]);
  });
});

describe("runPrBatch", () => {
  const mkRow = (over: Partial<PrRow>): PrRow => ({
    key: "app::a",
    repoName: "app",
    projectPath: "/work/app",
    remote: "origin",
    head: "a",
    isLiveHead: true,
    checked: true,
    disabledReason: null,
    base: "main",
    baseSource: "default",
    baseOptions: [],
    baseError: null,
    hints: [],
    title: "T",
    body: "",
    hasProposal: true,
    ...over,
  });

  test("walks checked, error-free rows in order, best effort; a failure doesn't stop the walk", async () => {
    const results: Array<[string, PrRowResult["status"]]> = [];
    const order: string[] = [];
    const summary = await runPrBatch(
      "t1",
      [
        mkRow({ key: "r1", head: "h1" }),
        mkRow({ key: "r2", head: "h2" }),
        mkRow({ key: "r3", head: "h3", checked: false }),
        mkRow({ key: "r4", head: "h4", baseError: "bad" }),
        mkRow({ key: "r5", head: "h5" }),
      ],
      {
        createPull: async (row) => {
          order.push(row.head);
          if (row.head === "h2") throw new Error("422 nope");
          return { url: `https://x/${row.head}` };
        },
        onResult: (key, r) => results.push([key, r.status]),
      },
    );
    expect(order).toEqual(["h1", "h2", "h5"]);
    expect(summary.created).toBe(2);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toContain("422 nope");
    expect(results).toContainEqual(["r4", "skipped"]);
    expect(results).toContainEqual(["r2", "failed"]);
    expect(results.find(([k]) => k === "r3")).toBeUndefined();
  });

  test("an already-exists answer is 'already open' with its URL, not a failure", async () => {
    const results: PrRowResult[] = [];
    const err = Object.assign(new Error("exists"), { body: { code: "already-exists", existingUrl: "https://x/9" } });
    const summary = await runPrBatch("t1", [mkRow({})], {
      createPull: async () => {
        throw err;
      },
      onResult: (_k, r) => results.push(r),
    });
    expect(summary).toMatchObject({ created: 0, alreadyOpen: 1, failed: [] });
    expect(results.at(-1)).toEqual({ status: "already-open", url: "https://x/9" });
  });

  test("one walk per task: a second runPrBatch while one runs is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runPrBatch("t1", [mkRow({})], {
      createPull: async () => {
        await gate;
        return { url: "https://x/1" };
      },
      onResult: () => {},
    });
    const second = await runPrBatch("t1", [mkRow({})], { createPull: async () => ({ url: "u" }), onResult: () => {} });
    expect(second.busy).toBe(true);
    release();
    expect((await first).created).toBe(1);
  });

  test("a created PR is remembered for the session so a re-plan excludes it", async () => {
    await runPrBatch("t1", [mkRow({ head: "feature/login" })], {
      createPull: async () => ({ url: "https://x/1" }),
      onResult: () => {},
    });
    const rows = await buildPrPlan(input({ repos: [repo({ name: "app" })], events: [] }), depsFor({}));
    expect(rows).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("alreadyOpenOf reads the passthrough body", () => {
    expect(alreadyOpenOf({ body: { code: "already-exists" } })).toEqual({ url: null });
    expect(alreadyOpenOf({ body: { code: "other" } })).toBeNull();
    expect(alreadyOpenOf(new Error("x"))).toBeNull();
  });
  test("appendIssueCloseDirective never double-appends and respects word boundaries", () => {
    const url = "https://github.com/acme/app/issues/7";
    expect(appendIssueCloseDirective("body", url)).toBe("body\n\nCloses #7");
    expect(appendIssueCloseDirective("fixes #7 already", url)).toBe("fixes #7 already");
    expect(appendIssueCloseDirective("mentions #71", url)).toBe("mentions #71\n\nCloses #7");
    expect(appendIssueCloseDirective("body", null)).toBe("body");
  });
});
