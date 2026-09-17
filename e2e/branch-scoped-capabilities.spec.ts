import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for branch-scoped skills/commands discovery (docs/plans/
 * branch-scoped-capabilities.md §1, §5 E1): the New Task form's `/` slash
 * autocomplete and its Extensions picker (MCP · Skills · Plugins) must list
 * PROJECT-level skills/commands from the git ref the worktree will actually
 * be cut from, not from whatever happens to be checked out on disk.
 *
 * Fixture repo: `main` with a committed README.md; branch `feature/skills`
 * (cut from main) committing a project skill (`.claude/skills/e2e-branch-
 * only/SKILL.md`) and a project command (`.claude/commands/e2e-branch-
 * cmd.md`); back on `main`, an UNTRACKED skill
 * (`.claude/skills/e2e-untracked/SKILL.md`) written to disk but never
 * `git add`-ed. All fixture names carry an `e2e-` prefix so they can never
 * collide with anything a developer's real `~/.claude` might have installed
 * (claude-code's USER-level discovery reads the real home directory —
 * see e2e/at-file-autocomplete.spec.ts / e2e/issue-task.spec.ts for the same
 * caveat) — but the slash menu and extension picker can still contain other,
 * unrelated rows from that real home, so every assertion here is scoped to
 * the exact `e2e-*` row text, never row order or row count as a whole.
 *
 * Only one project is registered per test file, and the New Task form
 * auto-selects the sole registered project as its workdir (same as
 * e2e/at-file-autocomplete.spec.ts), so there's no explicit project-picker
 * step here.
 *
 * `test.describe.configure({ mode: "serial" })` because each test re-
 * navigates (`gotoApp`) to get a clean New Task form — Isolate/base-ref
 * selections don't need to carry across tests, and starting fresh each time
 * avoids having to reason about residual BranchPicker state.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 15_000;

const BRANCH_PICKER_TITLE =
  "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start.";

let projectDir: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

const SKILL_FRONTMATTER = (desc: string) => `---\ndescription: ${desc}\n---\n`;

/**
 * `main`: committed README.md.
 * `feature/skills` (from main): commits a project skill
 * (`.claude/skills/e2e-branch-only/SKILL.md`) and a project command
 * (`.claude/commands/e2e-branch-cmd.md`).
 * Back on `main`: an UNTRACKED skill (`.claude/skills/e2e-untracked/
 * SKILL.md`) written to disk but never `git add`-ed — only the live
 * (non-isolated) scope should ever surface it.
 */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-branch-caps-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(dir, "README.md"), "e2e branch-scoped-capabilities fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);

  git(dir, ["checkout", "-q", "-b", "feature/skills"]);
  await mkdir(path.join(dir, ".claude", "skills", "e2e-branch-only"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "skills", "e2e-branch-only", "SKILL.md"),
    `${SKILL_FRONTMATTER("Branch-only e2e skill")}# e2e-branch-only\n`,
  );
  await mkdir(path.join(dir, ".claude", "commands"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "commands", "e2e-branch-cmd.md"),
    `${SKILL_FRONTMATTER("Branch-only e2e command")}Do the thing.\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add branch-only skill + command"]);

  git(dir, ["checkout", "-q", "main"]);
  await mkdir(path.join(dir, ".claude", "skills", "e2e-untracked"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "skills", "e2e-untracked", "SKILL.md"),
    `${SKILL_FRONTMATTER("Untracked e2e skill")}# e2e-untracked\n`,
  );
  // Deliberately never `git add`-ed.

  return dir;
}

/** Registers `dir` as a project via the plain global `fetch` (not
 *  Playwright's `request` fixture, unavailable in `beforeAll`) — mirrors
 *  e2e/at-file-autocomplete.spec.ts's `registerProject`. */
async function registerProject(apiBase: string, apiToken: string, dir: string): Promise<void> {
  const res = await fetch(`${apiBase}/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  if (!res.ok) {
    throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
  }
}

/** The New Task sidebar — always the first `<aside>` in DOM order. Mirrors
 *  e2e/at-file-autocomplete.spec.ts's identical convention. */
function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function promptTextarea(scope: Locator): Locator {
  return scope.getByTestId("prompt-textarea");
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
});

test.afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("branch-scoped skills/commands discovery", () => {
  test("Isolate ON + blank base ref (HEAD = main): neither the untracked nor the branch-only skill is offered", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();

    // Warm-up: prove the capability listing has loaded at all before making
    // any negative assertion — /init is a curated claude-code builtin,
    // always present regardless of project/ref.
    await page.keyboard.type("/ini");
    const slashMenu = form.getByTestId("slash-autocomplete");
    const initRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/init" });
    await expect(initRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await textarea.fill("");
    await page.keyboard.type("/e2e-");
    // The menu may close entirely when nothing matches the query — assert on
    // row count, not menu visibility.
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-untracked" })).toHaveCount(
      0,
    );
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-branch-only" }),
    ).toHaveCount(0);

    const extTrigger = form.getByTestId("extension-picker-trigger");
    const extPopover = form.getByTestId("extension-picker-popover");
    const extSearch = form.getByTestId("extension-picker-search");
    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await extSearch.fill("e2e-");
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-untracked" })).toHaveCount(0);
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-branch-only" })).toHaveCount(
      0,
    );

    await page.keyboard.press("Escape");
    await expect(extPopover).toBeHidden();
  });

  test("Pick feature/skills as the base ref: branch-only skill + command appear, untracked skill does not", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);

    const worktreeOptions = form.getByTestId("worktree-options");
    await expect(worktreeOptions.getByTestId("isolate-toggle")).toBeChecked();

    const branchTrigger = worktreeOptions.getByTitle(BRANCH_PICKER_TITLE);
    await branchTrigger.scrollIntoViewIfNeeded();
    await branchTrigger.click();

    const search = worktreeOptions.getByPlaceholder("Search branches…");
    await expect(search).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await search.fill("feature/skills");

    const popover = worktreeOptions.locator("[data-popover-open]");
    const branchRow = popover.locator("button").filter({ hasText: "feature/skills" }).first();
    await expect(branchRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await branchRow.scrollIntoViewIfNeeded();
    await branchRow.click();

    await textarea.click();
    await page.keyboard.type("/e2e-");
    const slashMenu = form.getByTestId("slash-autocomplete");
    const branchOnlyRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-branch-only" });
    const branchCmdRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-branch-cmd" });
    await expect(branchOnlyRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(branchCmdRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-untracked" }),
    ).toHaveCount(0);

    const extTrigger = form.getByTestId("extension-picker-trigger");
    const extPopover = form.getByTestId("extension-picker-popover");
    const extSearch = form.getByTestId("extension-picker-search");
    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await extSearch.fill("e2e-");
    const extBranchOnlyRow = extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-branch-only" });
    await expect(extBranchOnlyRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(extPopover).toBeHidden();

    // Clicking the slash-menu row inserts it into the textarea.
    await branchOnlyRow.click();
    await expect(async () => {
      expect(await textarea.inputValue()).toContain("/e2e-branch-only");
    }).toPass({ timeout: CONVERGE_TIMEOUT });
  });

  test("Isolate OFF: untracked skill on disk is offered, branch-only skill/command are not", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);

    const worktreeOptions = form.getByTestId("worktree-options");
    const isolateToggle = worktreeOptions.getByTestId("isolate-toggle");
    await expect(isolateToggle).toBeChecked();
    await isolateToggle.uncheck();

    await textarea.click();
    await page.keyboard.type("/e2e-");
    const slashMenu = form.getByTestId("slash-autocomplete");
    const untrackedRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-untracked" });
    await expect(untrackedRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-branch-only" }),
    ).toHaveCount(0);
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-branch-cmd" }),
    ).toHaveCount(0);
  });
});
