// The Select Projects dialog's rendered contract: every checked project row
// carries its own branch picker (label, Pull, Fetch, trigger), opened in flow
// so the scrolling list can't clip it; unchecked rows carry none. Static
// markup, like WorktreeOptions.test.tsx — no effects run, so the draft is the
// `value` it opened with. The interactive flows (picking, Save, Cancel, Pull
// and Fetch per project) live in e2e/select-projects.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BASE_REF_OFF_TITLE, BASE_REF_TITLE, SelectProjectsDialog } from "./SelectProjectsDialog.tsx";
import type { RepoSelection } from "@/lib/repo-selection";

function render(value: RepoSelection[], over: { isolate?: boolean; lockedPath?: string } = {}): string {
  return renderToStaticMarkup(
    <SelectProjectsDialog open onClose={() => {}} value={value} onSave={() => {}} {...over} />,
  );
}

/** The markup of one dialog row, by its test id slug. */
function row(markup: string, slug: string): string {
  const start = markup.indexOf(`data-testid="select-projects-row-${slug}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('data-testid="select-projects-row-', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
}

const escapeAttr = (text: string): string => text.replace(/'/g, "&#x27;");

describe("SelectProjectsDialog — per-project branch pickers", () => {
  test("each selected project row has its own Branch picker with Pull and Fetch", () => {
    const markup = render([
      { path: "/repos/api", root: "/repos/api" },
      { path: "/repos/web", root: "/repos/web" },
    ]);
    for (const slug of ["api", "web"]) {
      const r = row(markup, slug);
      expect(r).toContain('data-testid="select-projects-branch"');
      expect(r).toContain(">Branch<");
      expect(r).toContain(">Pull<");
      expect(r).toContain(">Fetch<");
      expect(r).toContain("lucide-git-branch");
    }
    // Refs are picked here now; the old "set in the form" pointer is gone.
    expect(markup).not.toContain("are set in the form");
  });

  test("the picker shows the saved base ref for its project", () => {
    const markup = render([
      { path: "/repos/api", root: "/repos/api", baseRef: "release/2.4" },
      { path: "/repos/web", root: "/repos/web" },
    ]);
    expect(row(markup, "api")).toContain(">release/2.4<");
    // No ref yet: the trigger shows HEAD until the branch list loads and the
    // picker preselects the current branch.
    expect(row(markup, "web")).toContain(">HEAD<");
  });

  test("the picker tooltip follows Isolate, and 2+ projects are always isolated", () => {
    const one = [{ path: "/repos/api", root: "/repos/api" }];
    expect(render(one)).toContain(`title="${escapeAttr(BASE_REF_TITLE)}"`);
    expect(render(one, { isolate: false })).toContain(`title="${escapeAttr(BASE_REF_OFF_TITLE)}"`);
    const two = [...one, { path: "/repos/web", root: "/repos/web" }];
    expect(render(two, { isolate: false })).toContain(`title="${escapeAttr(BASE_REF_TITLE)}"`);
  });

  test("the locked issue repository keeps its picker but cannot be removed", () => {
    const markup = render([{ path: "/repos/api", root: "/repos/api" }], { lockedPath: "/repos/api" });
    const r = row(markup, "api");
    expect(r).toContain('data-testid="select-projects-branch"');
    expect(r).toMatch(/aria-label="Remove \/repos\/api"[^>]*disabled=""|disabled=""[^>]*aria-label="Remove \/repos\/api"/);
  });

  test("the dialog still hosts Add folder, Clone repository and Import sessions", () => {
    const markup = render([{ path: "/repos/api", root: "/repos/api" }]);
    expect(markup).toContain("Add folder");
    expect(markup).toContain('data-testid="project-clone-open"');
    expect(markup).toContain('data-testid="project-import-sessions-open"');
  });
});
