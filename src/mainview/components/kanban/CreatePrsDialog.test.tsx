// The Create-PRs confirm list's rendered contract (static markup, like
// SelectProjectsDialog.test.tsx — no effects run). The planning flow and the
// walk are covered by pr-plan.test.ts and e2e/multi-repo-task.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CreatePrsDialogView,
  createBlocked,
  creatableRowCount,
  resolvePrRootTitle,
  type CreatePrsDialogViewProps,
} from "./CreatePrsDialog.tsx";
import type { PrRow, PrRowResult } from "@/lib/pr-plan";

const row = (over: Partial<PrRow> = {}): PrRow => ({
  key: "app::feature/login",
  repoName: "app",
  projectPath: "/work/app",
  remote: "origin",
  head: "feature/login",
  isLiveHead: true,
  checked: true,
  disabledReason: null,
  base: "topic",
  baseSource: "task",
  baseOptions: [
    { name: "main", onRemote: true },
    { name: "topic", onRemote: true },
    { name: "gone", onRemote: false },
  ],
  baseError: null,
  hints: [],
  title: "Add login",
  body: "Adds login to app.",
  hasProposal: true,
  ...over,
});

function render(rows: PrRow[], over: Partial<CreatePrsDialogViewProps> = {}): string {
  return renderToStaticMarkup(
    <CreatePrsDialogView
      open
      onClose={() => {}}
      phase="ready"
      error={null}
      rows={rows}
      results={{}}
      running={false}
      finished={false}
      onEdit={() => {}}
      onSubmit={() => {}}
      {...over}
    />,
  );
}

describe("CreatePrsDialogView", () => {
  test("each row has a checkbox, a head → base select, the base's origin badge, a title input and a collapsed description", () => {
    const markup = render([row()]);
    expect(markup).toContain('data-testid="create-prs-row-app-feature-login"');
    expect(markup).toContain('data-testid="create-prs-check-app-feature-login"');
    expect(markup).toContain('data-testid="create-prs-base-app-feature-login"');
    expect(markup).toContain("from the task");
    expect(markup).toContain('data-testid="create-prs-title-app-feature-login"');
    expect(markup).toContain('value="Add login"');
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Adds login to app.");
  });

  test("the base options list the remote branches and flag one that isn't on the remote", () => {
    const markup = render([row()]);
    expect(markup).toContain(">main</option>");
    expect(markup).toContain("gone (not on origin)</option>");
    expect(markup).toContain('<option value="topic" selected');
  });

  test("a live row renders checked, an extra row unchecked, a disabled row disabled with its reason", () => {
    const markup = render([
      row(),
      row({ key: "app::docs", head: "docs", isLiveHead: false, checked: false }),
      row({ key: "app::ghost", head: "ghost", isLiveHead: false, checked: false, disabledReason: "branch `ghost` isn't on origin" }),
    ]);
    const checkbox = (slug: string) => {
      const start = markup.indexOf(`data-testid="create-prs-check-${slug}"`);
      return markup.slice(Math.max(0, start - 200), start + 200);
    };
    expect(checkbox("app-feature-login")).toContain('checked=""');
    expect(checkbox("app-docs")).not.toContain('checked=""');
    expect(checkbox("app-ghost")).toContain('disabled=""');
    expect(markup).toContain("isn&#x27;t on origin");
  });

  test("hints, the base source badge and a base error show; a no-proposal row says so", () => {
    const markup = render([
      row({ baseSource: "agent", hints: ["stored base `topic` looks stale: the branch was moved off it"], baseError: "Base branch `gone` isn't on origin.", base: "gone" }),
    ]);
    expect(markup).toContain("from the agent");
    expect(markup).toContain("looks stale");
    expect(markup).toContain('data-testid="create-prs-base-error-app-feature-login"');
  });

  test("the submit button counts creatable rows and is disabled with none or with a base error", () => {
    const ready = render([row(), row({ key: "k2", head: "h2" })]);
    expect(ready).toContain("Create 2 pull requests");
    expect(render([row()])).toContain("Create 1 pull request<");
    const none = render([row({ checked: false })]);
    expect(none).toContain("Create 0 pull requests");
    expect(none).toMatch(/data-testid="create-prs-submit"[^>]*disabled=""|disabled=""[^>]*data-testid="create-prs-submit"/);
    const bad = render([row({ baseError: "same branch" })]);
    expect(bad).toMatch(/data-testid="create-prs-submit"[^>]*disabled=""|disabled=""[^>]*data-testid="create-prs-submit"/);
  });

  test("createBlocked / creatableRowCount agree with the rules", () => {
    expect(creatableRowCount([row(), row({ checked: false }), row({ disabledReason: "x" })])).toBe(1);
    expect(createBlocked([])).toBe(true);
    expect(createBlocked([row()])).toBe(false);
    expect(createBlocked([row({ baseError: "e" })])).toBe(true);
    expect(createBlocked([row({ title: "  " })])).toBe(true);
    expect(createBlocked([row(), row({ key: "k2", checked: false, title: "" })])).toBe(false);
    // An unchecked row's error doesn't block the others.
    expect(createBlocked([row(), row({ key: "k2", checked: false, baseError: "e" })])).toBe(false);
  });

  test("per-row results render creating, created with a link, already open with a link, and failed with the message", () => {
    const results: Record<string, PrRowResult> = {
      a: { status: "creating" },
      b: { status: "created", url: "https://github.com/o/r/pull/1" },
      c: { status: "already-open", url: "https://github.com/o/r/pull/2" },
      d: { status: "failed", error: "422 nope" },
    };
    const markup = render(
      ["a", "b", "c", "d"].map((k) => row({ key: k, head: k })),
      { results, running: true },
    );
    expect(markup).toContain("Creating…");
    expect(markup).toContain('href="https://github.com/o/r/pull/1"');
    expect(markup).toContain("Already open");
    expect(markup).toContain('href="https://github.com/o/r/pull/2"');
    expect(markup).toContain("Failed: 422 nope");
  });

  test("planning shows a loading state, an error shows its message, an empty plan says every branch has a PR, and finishing leaves only Close", () => {
    expect(render([], { phase: "planning" })).toContain('data-testid="create-prs-loading"');
    expect(render([], { phase: "error", error: "boom" })).toContain("boom");
    expect(render([])).toContain("Every branch already has a pull request.");
    const done = render([row()], { finished: true });
    expect(done).toContain(">Close<");
    expect(done).not.toContain('data-testid="create-prs-submit"');
  });
});

describe("resolvePrRootTitle", () => {
  test("a pipeline step task takes its parent task's title, not its own `<pipeline> · <step>` title", async () => {
    const asked: string[] = [];
    const title = await resolvePrRootTitle(
      { title: "Release pipeline · Commit And Push", pipelineParentId: "parent-1" },
      async (id) => {
        asked.push(id);
        return { title: "Fix the login redirect" };
      },
    );
    expect(title).toBe("Fix the login redirect");
    expect(asked).toEqual(["parent-1"]);
  });

  test("a task that isn't a pipeline step keeps its own title and never reads another task", async () => {
    let calls = 0;
    const getTask = async () => {
      calls++;
      return { title: "should not be used" };
    };
    expect(await resolvePrRootTitle({ title: "Plain task", pipelineParentId: null }, getTask)).toBe("Plain task");
    expect(await resolvePrRootTitle({ title: "Plain task" }, getTask)).toBe("Plain task");
    expect(calls).toBe(0);
  });

  test("when the parent can't be read (deleted, network), the step's own title is the fallback", async () => {
    const title = await resolvePrRootTitle(
      { title: "Release pipeline · Commit And Push", pipelineParentId: "gone" },
      async () => {
        throw new Error("404 task not found");
      },
    );
    expect(title).toBe("Release pipeline · Commit And Push");
  });
});
