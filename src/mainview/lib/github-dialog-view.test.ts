import { describe, expect, test } from "bun:test";
import {
  backToList,
  openCompose,
  openDetail,
  openPanel,
  resolveEscape,
  togglePanel,
  type GitHubPanelKind,
} from "./github-dialog-view.ts";
import type { GitHubListItem } from "../../shared/types.ts";

function item(overrides: Partial<GitHubListItem>): GitHubListItem {
  return {
    kind: "issues",
    number: 1,
    title: "Something broke",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/o/r/issues/1",
    author: null,
    assignees: [],
    milestone: null,
    body: "",
    labels: [],
    comments: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: null,
    ...overrides,
  };
}

const PANEL_KINDS: GitHubPanelKind[] = [
  "labels",
  "milestones",
  "releases",
  "notifications",
  "actions",
  "projects",
  "discussions",
];

describe("openDetail", () => {
  test("opens the detail view for a PR-kind item", () => {
    const pr = item({ kind: "pulls", number: 42, title: "Add feature" });
    expect(openDetail(pr)).toEqual({ kind: "detail", item: pr });
  });

  test("opens the detail view for an issue-kind item", () => {
    const issue = item({ kind: "issues", number: 7, title: "Bug report" });
    expect(openDetail(issue)).toEqual({ kind: "detail", item: issue });
  });
});

test("backToList returns the list view", () => {
  expect(backToList()).toEqual({ kind: "list" });
});

test("backToList returns the list view from a compose view", () => {
  const view = openCompose();
  expect(view).toEqual({ kind: "compose" });
  expect(backToList()).toEqual({ kind: "list" });
});

describe("openCompose", () => {
  test("opens the compose view", () => {
    expect(openCompose()).toEqual({ kind: "compose" });
  });
});

describe("openPanel", () => {
  for (const panel of PANEL_KINDS) {
    test(`opens the ${panel} panel`, () => {
      expect(openPanel(panel)).toEqual({ kind: "panel", panel });
    });
  }
});

describe("togglePanel", () => {
  test("from the list view, opens the requested panel", () => {
    expect(togglePanel({ kind: "list" }, "labels")).toEqual({ kind: "panel", panel: "labels" });
  });

  test("re-clicking the same open panel closes it back to the list (toggle-off)", () => {
    const view = openPanel("milestones");
    expect(togglePanel(view, "milestones")).toEqual({ kind: "list" });
  });

  test("clicking a different panel switches directly to it", () => {
    const view = openPanel("labels");
    expect(togglePanel(view, "releases")).toEqual({ kind: "panel", panel: "releases" });
  });

  test("from a detail view, opens the requested panel (current implementation replaces detail; it does not restore the underlying list/detail on toggle-off)", () => {
    const view = openDetail(item({ kind: "pulls", number: 3 }));
    expect(togglePanel(view, "actions")).toEqual({ kind: "panel", panel: "actions" });
  });

  test("from a compose view, opens the requested panel (current implementation replaces compose; it does not restore the underlying list/compose on toggle-off)", () => {
    const view = openCompose();
    expect(togglePanel(view, "actions")).toEqual({ kind: "panel", panel: "actions" });
  });
});

describe("resolveEscape", () => {
  test("closes the modal from the list view", () => {
    expect(resolveEscape({ kind: "list" })).toBe("close");
  });

  test("pops to the list from a detail view", () => {
    expect(resolveEscape(openDetail(item({})))).toBe("pop");
  });

  test("pops to the list from a panel view", () => {
    expect(resolveEscape(openPanel("discussions"))).toBe("pop");
  });

  test("pops to the list from a compose view", () => {
    expect(resolveEscape(openCompose())).toBe("pop");
  });
});
