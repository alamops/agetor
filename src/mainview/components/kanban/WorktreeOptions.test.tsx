// The shared worktree block's rendered contract (issue #291): one full-width
// Select Projects control above Isolate, one read-only Branch · <project>
// summary line per selected project (the pickers themselves live in the
// Select Projects dialog), and the forced/disabled Isolate state for 2+
// projects — plus the locked PR-conflict variant. Static markup, like StackBadge.test.tsx;
// the interactive flows live in e2e/select-projects.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorktreeOptions, type WorktreeOptionsState } from "./WorktreeOptions.tsx";
import { branchFieldState } from "@/lib/branch-field";
import { DEFAULT_BRANCH_CONFIG } from "../../../shared/types.ts";
import type { RepoSelection } from "@/lib/repo-selection";

/** A complete hook-shaped state object; only the fields the render reads move. */
function state(over: Partial<WorktreeOptionsState> = {}): WorktreeOptionsState {
  return {
    isolate: true,
    setIsolate: () => {},
    forceIsolate: false,
    effectiveIsolate: true,
    branchConfig: DEFAULT_BRANCH_CONFIG,
    branchOverride: "",
    setBranchOverride: () => {},
    branchDirty: false,
    setBranchDirty: () => {},
    branchToken: "abcdef",
    branchSettingsOpen: false,
    setBranchSettingsOpen: () => {},
    branchField: branchFieldState({
      dirty: false,
      override: "",
      pattern: "feature/<slug>",
      title: "a task",
      projectName: "api",
      taskType: "task",
      token: "abcdef",
    }),
    branchValidation: { ok: true },
    valid: true,
    resetAfterSubmit: () => {},
    resetForOpen: () => {},
    onBranchConfigSaved: () => {},
    workdir: "/repos/api",
    taskType: "task",
    ...over,
  };
}

function live(repos: RepoSelection[], over: Partial<WorktreeOptionsState> = {}): string {
  return renderToStaticMarkup(
    <WorktreeOptions
      state={state({ workdir: repos[0]?.path ?? "", ...over })}
      repos={repos}
      onReposChange={() => {}}
    />,
  );
}

function openingTag(markup: string, testId: string): string {
  const at = markup.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}

const disabled = (tag: string): boolean => /\sdisabled(=""|\s|>)/.test(tag);

const repo = (path: string): RepoSelection => ({ path, root: path });

describe("WorktreeOptions — live", () => {
  test("the Select Projects button sits above the Isolate checkbox (SC1)", () => {
    const markup = live([repo("/repos/api")]);
    const projects = markup.indexOf('data-testid="select-projects-button"');
    const isolate = markup.indexOf('data-testid="isolate-toggle"');
    expect(projects).toBeGreaterThan(-1);
    expect(isolate).toBeGreaterThan(projects);
  });

  test("no selection shows the prompt label and the select-a-project hint", () => {
    const markup = live([]);
    expect(markup).toContain(">Select projects…<");
    expect(markup).toContain('data-testid="select-projects-empty"');
    expect(markup).not.toContain('data-testid="branch-row-');
    // With nothing selected there is no branch row, but the historical
    // default (isolate on) still shows the branch-name field.
    expect(disabled(openingTag(markup, "isolate-toggle"))).toBe(false);
    expect(openingTag(markup, "isolate-toggle")).toContain("checked");
    expect(markup).toContain('data-testid="branch-name-input"');
  });

  test("one project gets its own Branch · <project> line and an editable Isolate", () => {
    const markup = live([repo("/repos/api")]);
    expect(markup).toContain('data-testid="branch-row-api"');
    expect(markup).toContain("Branch · api");
    expect(markup).not.toContain("projects selected");
    expect(openingTag(markup, "isolate-toggle")).toContain("checked");
    expect(disabled(openingTag(markup, "isolate-toggle"))).toBe(false);
    expect(markup).not.toContain("Always on when more than one project is selected.");
    expect(markup).toContain('data-testid="branch-name-input"');
  });

  test("2+ projects force Isolate on and disabled, with one row each (SC2/SC4)", () => {
    // The raw toggle is false for one render after 2+ is first selected; the
    // checkbox must read `effectiveIsolate` (forced), never the raw toggle.
    const markup = live([repo("/repos/api"), repo("/repos/web")], { isolate: false, forceIsolate: true });
    expect(markup).toContain(">2 projects selected<");
    expect(markup).toContain('data-testid="branch-row-api"');
    expect(markup).toContain('data-testid="branch-row-web"');
    expect(markup).toContain("Branch · api");
    expect(markup).toContain("Branch · web");
    const isolate = openingTag(markup, "isolate-toggle");
    expect(isolate).toContain("checked");
    expect(disabled(isolate)).toBe(true);
    expect(markup).toContain("Always on when more than one project is selected.");
    // The shared branch name is used in every repository, with the server's
    // `-N` fallback where one already exists.
    expect(markup).toContain("This name is used in every project");
  });

  test("isolate off hides the branch-name field but keeps every project's line", () => {
    const markup = live([repo("/repos/api")], { isolate: false, effectiveIsolate: false });
    expect(markup).toContain('data-testid="branch-row-api"');
    expect(openingTag(markup, "isolate-toggle")).not.toContain("checked");
    expect(markup).not.toContain('data-testid="branch-name-input"');
  });

  test("two projects sharing a basename get path-qualified labels and distinct ids (R-S1)", () => {
    const markup = live([repo("/a/api"), repo("/b/api")]);
    expect(markup).toContain('data-testid="branch-row-api"');
    expect(markup).toContain('data-testid="branch-row-api-2"');
    expect(markup).toContain("Branch · api — /a/api");
    expect(markup).toContain("Branch · api — /b/api");
  });
});

describe("WorktreeOptions — branch summary", () => {
  test("is read-only: no branch picker, Pull or Fetch in the form", () => {
    const markup = live([repo("/repos/api"), repo("/repos/web")], { forceIsolate: true });
    // The pickers moved into the Select Projects dialog; the form only shows
    // what was saved.
    expect(markup).not.toContain("Search branches");
    expect(markup).not.toContain(">Pull<");
    expect(markup).not.toContain(">Fetch<");
    expect(markup).not.toContain("lucide-refresh-cw");
  });

  test("an untouched project reads as its current branch", () => {
    const markup = live([repo("/repos/api")]);
    expect(markup).toContain(">current branch<");
  });

  test("each project shows the base ref picked for it", () => {
    const markup = live([
      { path: "/repos/api", root: "/repos/api", baseRef: "release/2.4" },
      { path: "/repos/web", root: "/repos/web" },
    ], { forceIsolate: true });
    const api = markup.slice(markup.indexOf('data-testid="branch-row-api"'), markup.indexOf('data-testid="branch-row-web"'));
    const web = markup.slice(markup.indexOf('data-testid="branch-row-web"'));
    expect(api).toContain(">release/2.4<");
    expect(api).not.toContain("current branch");
    expect(web).toContain(">current branch<");
  });

  test("the summary is one button that reopens the dialog", () => {
    const tag = openingTag(live([repo("/repos/api")]), "selected-branches");
    expect(tag.startsWith("<button")).toBe(true);
    expect(tag).toContain('type="button"');
    expect(disabled(tag)).toBe(false);
  });

  test("no selection renders no summary", () => {
    expect(live([])).not.toContain('data-testid="selected-branches"');
  });
});

describe("WorktreeOptions — locked (PR-conflict dialog)", () => {
  test("shows the PR's repository, a read-only branch and checked/disabled Isolate", () => {
    const markup = renderToStaticMarkup(<WorktreeOptions locked={{ branch: "fix/pr-head", projectPath: "/repos/api" }} />);
    expect(markup).toContain('data-testid="worktree-options-locked"');
    const button = openingTag(markup, "select-projects-button");
    expect(disabled(button)).toBe(true);
    expect(markup).toContain(">api<");
    expect(markup).toContain("lucide-lock");
    const branch = openingTag(markup, "locked-branch");
    expect(branch).toContain("readOnly");
    expect(branch).toContain('value="fix/pr-head"');
    const isolate = openingTag(markup, "isolate-toggle");
    expect(isolate).toContain("checked");
    expect(disabled(isolate)).toBe(true);
    // A locked PR task never edits the shared branch name.
    expect(markup).not.toContain('data-testid="branch-name-input"');
  });

  test("falls back to the generic Project label when no path is carried", () => {
    const markup = renderToStaticMarkup(<WorktreeOptions locked={{ branch: "main" }} />);
    expect(markup).toContain(">Project<");
  });
});
