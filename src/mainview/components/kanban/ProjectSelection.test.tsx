// The full-width Select Projects control behind the combined single/multi
// project selection (issue #291). Rendered to static markup, like
// StackBadge.test.tsx, because the repo has no DOM harness — the interactive
// flows live in e2e/select-projects.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectProjectsButton } from "./ProjectSelection.tsx";
import { projectSelectionLabel } from "@/lib/repo-selection";

function html(props: Parameters<typeof SelectProjectsButton>[0]): string {
  return renderToStaticMarkup(<SelectProjectsButton {...props} />);
}

/** The button's opening tag, so "disabled" is asserted on the element and not
 *  mistaken for the always-present `disabled:` utility classes. */
function openingTag(markup: string): string {
  const end = markup.indexOf(">");
  expect(end).toBeGreaterThan(0);
  return markup.slice(0, end);
}

const disabled = (tag: string): boolean => /\sdisabled(=""|\s|>)/.test(tag);

describe("SelectProjectsButton", () => {
  test("labels the zero / one / many selection the same way the picker always has", () => {
    expect(html({ label: projectSelectionLabel([]), onClick: () => {} })).toContain("Select projects…");
    expect(html({ label: projectSelectionLabel([{ path: "/repos/frontend", root: "/repos/frontend" }]), onClick: () => {} }))
      .toContain("frontend");
    expect(
      html({
        label: projectSelectionLabel([
          { path: "/repos/frontend", root: "/repos/frontend" },
          { path: "/repos/backend", root: "/repos/backend" },
        ]),
        onClick: () => {},
      }),
    ).toContain("2 projects selected");
  });

  test("is a full-width button that opens a dialog and advertises the per-project branch pickers", () => {
    const markup = html({ label: "api", onClick: () => {} });
    const tag = openingTag(markup);
    expect(tag).toContain('data-testid="select-projects-button"');
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-haspopup="dialog"');
    expect(disabled(tag)).toBe(false);
    // The single control is the only selection surface, so it must span the
    // form and hint at the Branch/Pull/Fetch row every project gets.
    expect(tag).toContain("w-full");
    expect(markup).toContain("Pick one or more projects and the branch each one starts from (with Pull and Fetch).");
    expect(markup).toContain("lucide-folder-open");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).toContain(">api<");
  });

  test("the locked variant (PR-conflict dialog) is disabled, locked and chevron-free", () => {
    const markup = html({ label: "api", onClick: () => {}, locked: true });
    const tag = openingTag(markup);
    expect(tag).toContain('data-testid="select-projects-button"');
    expect(disabled(tag)).toBe(true);
    // A locked picker isn't a menu: no dialog affordance, no expand chevron.
    expect(tag).not.toContain("aria-haspopup");
    expect(markup).toContain("lucide-lock");
    expect(markup).not.toContain("lucide-chevron-down");
    expect(markup).toContain("The PR&#x27;s repository is fixed for this task.");
    expect(markup).toContain(">api<");
  });

  test("an explicitly disabled button stays disabled even when it is not locked", () => {
    const markup = html({ label: "api", onClick: () => {}, disabled: true });
    expect(disabled(openingTag(markup))).toBe(true);
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).not.toContain("lucide-lock");
  });
});
