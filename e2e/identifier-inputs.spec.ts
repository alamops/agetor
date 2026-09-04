import { test, expect, type Locator } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

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
 *     — a sibling primitive to `SearchSelect`.
 *  5. Negative check: the Title input (a prose field) must NOT carry
 *     `autocorrect="off"` — pins the deliberate prose-vs-identifier split so
 *     a future "apply everywhere" change trips this test.
 *  6. Wave 3 — the New Task composer's Extensions picker search box
 *     (`ExtensionPicker.tsx`, `extension-picker-search`).
 *  7. Wave 3 — Settings → Git Integration's host input
 *     (`GitHubTokensSection.tsx`): carries the three correction attributes
 *     but deliberately NOT `autocomplete`, since it's paired with a
 *     `<datalist>` (`autoComplete={undefined}` after the spread — see
 *     identifier-input.ts's "one exception" paragraph).
 *  8. Wave 3 — the Settings additional-harness editor's Id/slug and Bin
 *     override inputs (`SettingsDialog.tsx`'s `Editor`).
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

/** Variant of `expectIdentifierInput` for the one documented exception in
 *  identifier-input.ts: an input paired with a `<datalist>` spreads
 *  `IDENTIFIER_INPUT_PROPS` and then sets `autoComplete={undefined}` right
 *  after it (React omits an `undefined` prop entirely, rather than
 *  rendering `autocomplete="off"`) so the datalist keeps suggesting. The
 *  three correction attributes still apply; `autocomplete` must be absent,
 *  not merely a different value. */
async function expectIdentifierInputNoAutocomplete(locator: Locator): Promise<void> {
  await expect(locator).toHaveAttribute("autocorrect", "off");
  await expect(locator).toHaveAttribute("autocapitalize", "off");
  await expect(locator).toHaveAttribute("spellcheck", "false");
  await expect(locator).not.toHaveAttribute("autocomplete");
}

// Distinctive, worker-unique project name for the Extensions-picker test
// below — searched for and clicked explicitly rather than relying on
// ProjectPicker's `autoSelectFirst`, since the `backend` fixture is
// worker-scoped and other spec files sharing this worker may have already
// registered their own projects (see e2e/issue-task.spec.ts's file header
// for the identical concern around `openGitDialog`).
const EXTENSIONS_TEST_PROJECT_NAME = "e2e-identifier-inputs-project";

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

  test("New Task panel: Extensions picker search box carries the opt-out set", async ({ page, backend }) => {
    // The Extensions trigger is disabled until the New Task panel has a
    // non-empty workdir (PromptComposer: `disabled={disabled ||
    // !workdir.trim()}`), so a project must be registered and selected
    // first. The worker's own `dataDir` is already guaranteed to exist and
    // is unrelated to this repo checkout, so pointing a project at it can't
    // touch a real git worktree — this test never starts a task.
    const projectRes = await page.request.post(`${backend.apiBase}/projects`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: { path: backend.dataDir, name: EXTENSIONS_TEST_PROJECT_NAME },
    });
    expect(projectRes.ok()).toBeTruthy();

    await gotoApp(page, backend.bootBase);

    const newTaskPanel = page.locator("aside").filter({ hasText: "New task" });
    await expect(newTaskPanel).toBeVisible();

    // Pick this test's project explicitly rather than relying on
    // ProjectPicker's `autoSelectFirst` (most-recently-used project) — see
    // EXTENSIONS_TEST_PROJECT_NAME's doc comment above.
    const projectTrigger = newTaskPanel.getByTitle(PROJECT_PICKER_TITLE);
    await projectTrigger.click();
    const projectSearch = newTaskPanel.getByPlaceholder("Search projects…");
    await expect(projectSearch).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await projectSearch.fill(EXTENSIONS_TEST_PROJECT_NAME);
    const projectRow = newTaskPanel.locator("button").filter({ hasText: EXTENSIONS_TEST_PROJECT_NAME });
    await expect(projectRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await projectRow.click();
    await expect(projectSearch).toBeHidden();

    // 6. Extensions picker search box. Its trigger label is "MCP · Skills ·
    // Plugins · Prompts" (ExtensionPicker.tsx) — the test id is more
    // robust than the label text, and is already used the same way by
    // e2e/issue-task.spec.ts and e2e/resolve-conflicts.spec.ts.
    const extTrigger = newTaskPanel.getByTestId("extension-picker-trigger");
    await expect(extTrigger).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await extTrigger.click();
    const extSearch = newTaskPanel.getByTestId("extension-picker-search");
    await expect(extSearch).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInput(extSearch);

    // The Extensions popover is a `data-popover-open` carrier that closes
    // itself on Escape (see ExtensionPicker.tsx and CLAUDE.md's carrier
    // list) — regression guard mirroring the Project/Branch pickers above.
    await page.keyboard.press("Escape");
    await expect(extSearch).toBeHidden();
  });

  test("Settings → Git Integration: host input carries the identifier set but not autocomplete", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);

    // 7. GitHubTokensSection stays mounted across sections (kept alive so an
    // in-progress edit survives switching tabs) but is hidden until "Git
    // Integration" is the active section — see SETTINGS_SECTIONS in
    // src/mainview/lib/settings-dialog-view.ts.
    await dialog.getByRole("button", { name: "Git Integration", exact: true }).click();
    const hostInput = dialog.getByPlaceholder("github.com / gitlab.com / bitbucket.org");
    await expect(hostInput).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInputNoAutocomplete(hostInput);
  });

  test("Settings harness editor: Id/slug and Bin override inputs carry the opt-out set", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);

    await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
    const addButton = dialog.getByRole("button", { name: "Add harness", exact: true });
    await expect(addButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await addButton.click();

    // Any template works for this assertion — its `kind` only changes the
    // (untested-here) HOME-override field's label text, not the Id/Bin
    // fields. The button's accessible name also includes the template's
    // description text, so match on the label via `hasText` rather than an
    // exact role-name match.
    const templateButton = dialog.getByRole("button").filter({ hasText: "Additional Claude Code" });
    await expect(templateButton).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await templateButton.click();

    // 8. Id/slug and Bin override inputs (SettingsDialog.tsx's `Editor`).
    const idInput = dialog.getByPlaceholder("claude-work");
    await expect(idInput).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expectIdentifierInput(idInput);

    const binInput = dialog.getByPlaceholder("/opt/homebrew/bin/claude");
    await expect(binInput).toBeVisible();
    await expectIdentifierInput(binInput);
  });
});

// Wave 4 — the rule widened from "identifier inputs" to "identifier inputs
// AND search/filter boxes" (a corrected query just finds nothing), so the
// Kanban bar's free-text box opts out too. It's always mounted on the board,
// so no popover to open.
test.describe("search/filter boxes opt out of autocorrect", () => {
  test("Kanban free-text filter box carries the opt-out set", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    await expectIdentifierInput(page.getByPlaceholder("Search title, prompt, workdir, branch…"));
  });
});
