import { test, expect, type Locator } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for `IDENTIFIER_INPUT_PROPS` (docs/plans/remove-autocorrect-
 * from-pickers.md §5, TT2) — the shared `autocorrect="off"` /
 * `autocapitalize="off"` / `spellcheck="false"` / `autocomplete="off"` set
 * spread onto every identifier input so macOS/WebKit's text-correction
 * services stop mangling typed identifiers (project names, branch names,
 * harness ids).
 *
 * These assertions check DOM **attributes**, not autocorrect **behaviour**:
 * Chromium (this harness) doesn't apply macOS's system text-correction
 * services the way the packaged app's WKWebView does, so there's nothing to
 * observe behaviourally here — confirming the opt-out attribute is present
 * is the correct and complete e2e check; a manual pass in the packaged app
 * is the residual verification for the behaviour itself (see the plan's
 * §3.5 assumption).
 *
 * Modeled on e2e/font-size.spec.ts's harness (real Chromium + the real
 * per-worker headless Bun backend via the `backend` fixture, no mocked
 * fetches) and on how e2e/issue-task.spec.ts drives the Branch picker
 * (`BRANCH_PICKER_TITLE` trigger tooltip + `getByPlaceholder` on the
 * search box, ~L80-110 and ~L575-600 there).
 *
 * Covers, all inside the New Task left panel (`<aside>`, expanded by
 * default in a fresh browser context) unless noted:
 *  1. Project picker search box (`SearchSelect`, via `ProjectPicker`).
 *  2. Branch picker search box (`SearchSelect`, via `BranchPicker` inside
 *     `WorktreeOptions`).
 *  3. The branch-name input (`branch-name-input`, visible because Isolate
 *     defaults on).
 *  4. The Kanban filter bar's harness filter search box (`MultiSearchSelect`)
 *     — a sibling primitive to `SearchSelect`, and the one surface this
 *     change reaches outside the New Task panel.
 *  5. Negative check: the Title input (a prose field) must NOT carry
 *     `autocorrect="off"` — pins the deliberate prose-vs-identifier split so
 *     a future "apply everywhere" change trips this test.
 *
 * No sleeps/screenshots; `toBeVisible()` with `CONVERGE_TIMEOUT` is used
 * wherever a popover needs to render before assertions run.
 */

// Tooltip WorktreeOptions puts on the Branch picker trigger while isolated
// (the default state) — see WorktreeOptions.tsx. Mirrors
// e2e/issue-task.spec.ts's identical constant.
const BRANCH_PICKER_TITLE =
  "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start.";

// Tooltip ProjectPicker's trigger carries, set by NewTaskForm.tsx.
const PROJECT_PICKER_TITLE =
  "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.";

// Generous but bounded convergence timeout for popovers to render — mirrors
// issue-task.spec.ts's identical constant.
const CONVERGE_TIMEOUT = 20_000;

/** Asserts the full `IDENTIFIER_INPUT_PROPS` set is present on `locator`.
 *  React renders `spellCheck={false}` as the DOM string `"false"` (not the
 *  attribute's absence), so all four are checked as string values via
 *  `toHaveAttribute`. */
async function expectIdentifierInput(locator: Locator): Promise<void> {
  await expect(locator).toHaveAttribute("autocorrect", "off");
  await expect(locator).toHaveAttribute("autocapitalize", "off");
  await expect(locator).toHaveAttribute("spellcheck", "false");
  await expect(locator).toHaveAttribute("autocomplete", "off");
}

test.describe("identifier inputs opt out of autocorrect", () => {
  test("New Task panel: Project picker, Branch picker, and branch-name input all carry the opt-out set", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);

    // The New Task panel is the left <aside> — it has no test id, so scope
    // by its own "New task" header text (there's exactly one <aside> with
    // that text; the other <aside> in the app, RunPanel's slide-over, only
    // mounts once a task is opened, which this spec never does).
    const newTaskPanel = page.locator("aside").filter({ hasText: "New task" });
    await expect(newTaskPanel).toBeVisible();

    // 1. Project picker search box.
    const projectTrigger = newTaskPanel.getByTitle(PROJECT_PICKER_TITLE);
    await projectTrigger.click();
    const projectSearch = newTaskPanel.getByPlaceholder("Search projects…");
    await expect(projectSearch).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInput(projectSearch);
    await page.keyboard.press("Escape");
    await expect(projectSearch).toBeHidden();

    // 2. Branch picker search box, inside worktree-options.
    const worktreeOptions = newTaskPanel.getByTestId("worktree-options");
    await expect(worktreeOptions).toBeVisible();
    const branchTrigger = worktreeOptions.getByTitle(BRANCH_PICKER_TITLE);
    await branchTrigger.click();
    const branchSearch = worktreeOptions.getByPlaceholder("Search branches…");
    await expect(branchSearch).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInput(branchSearch);
    await page.keyboard.press("Escape");
    await expect(branchSearch).toBeHidden();

    // 3. Branch-name input — visible because Isolate defaults on.
    const branchNameInput = worktreeOptions.getByTestId("branch-name-input");
    await expect(branchNameInput).toBeVisible();
    await expectIdentifierInput(branchNameInput);

    // 5 (negative check). The Title input is prose, not an identifier — it
    // must NOT have picked up the opt-out.
    const titleInput = newTaskPanel.getByPlaceholder("Short description");
    await expect(titleInput).toBeVisible();
    await expect(titleInput).not.toHaveAttribute("autocorrect", "off");
  });

  test("Kanban filter bar: harness filter search box carries the opt-out set", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);

    // "All harnesses" is the MultiSearchSelect trigger's empty-state label
    // (KanbanFilters.tsx) — a plain <button>, not inside the New Task panel,
    // so no extra scoping is needed. The New Task panel's own placeholder
    // "Search projects…" collides with the filter bar's repo filter, which
    // is why this spec never asserts on that placeholder unscoped.
    const harnessTrigger = page.getByRole("button", { name: "All harnesses", exact: true });
    await harnessTrigger.click();
    const harnessSearch = page.getByPlaceholder("Search harnesses…");
    await expect(harnessSearch).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInput(harnessSearch);
    await page.keyboard.press("Escape");
    await expect(harnessSearch).toBeHidden();
  });
});
