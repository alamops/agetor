import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import {
  branchRow,
  chooseProjects,
  gotoApp,
  openSelectProjects,
  selectBaseBranch,
  selectProjectsDialog,
} from "./helpers";
import { uniqueRepoSlugs } from "../src/shared/multi-repo.ts";

/**
 * E2E coverage for the combined Select Projects control (replaces the old
 * split between a single project picker and the separate multi-repository
 * dialog). One full-width button above Isolate is the only selection surface:
 * its label carries the project name / selected count, every selected project
 * gets the same inline Branch · Pull · Fetch row, and 2+ projects force and
 * disable Isolate. The issue dialog and the PR-conflict modal reuse the same
 * control (e2e/issue-task.spec.ts + e2e/resolve-conflicts.spec.ts).
 *
 * Scenarios:
 *  a. one project: non-current base ref rides the single-repository payload
 *     (`workdir` + top-level `baseRef`), no multi flag;
 *  b. two projects: `2 projects selected`, Isolate checked+disabled, each
 *     project's own non-current ref lands in `repositories[].baseRef`;
 *  c. a repo plus its own subdirectory dedupes to one project (button label,
 *     Isolate editable, single-repository task);
 *  d. outside clicks leave the dialog open; Escape and Cancel close it;
 *  e. search filters the rows;
 *  f. a zero draft disables Save and shows the hint;
 *  g. a submit keeps the selection and its refs while the branch name resets;
 *  h. a plain non-git folder alone with Isolate off creates with
 *     `workdir` + `isolation:"none"` (never a `repositories[]` payload).
 *
 * Non-current branch names are mandatory: a picker wired to nothing still
 * shows the current branch, so only a different ref proves the row reaches the
 * create payload.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 30_000;
const BRANCH = "topic";

interface TaskRepositoryRow {
  path: string;
  name: string;
  branch: string | null;
  baseRef: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  workdir: string;
  isolation: "worktree" | "none";
  baseRef: string | null;
  multiRepo?: boolean;
  repositories: TaskRepositoryRow[];
}

let repoA: string;
let repoB: string;
let repoChild: string;
let repoPlain: string;
let branchShaA: string;
let branchShaB: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepo(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `agetor-e2e-select-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), `${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function registerProject(
  request: APIRequestContext,
  backend: E2EBackend,
  projectPath: string,
  name: string,
): Promise<void> {
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { path: projectPath, name },
  });
  expect(res.ok()).toBeTruthy();
}

function newTaskForm(page: Page) {
  return page.locator("aside").filter({ hasText: "New task" });
}

async function findTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as TaskRow[];
  return rows.find((row) => row.title === title) ?? null;
}

async function awaitTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTask(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return task!;
}

const slugFor = (projectPath: string): string => uniqueRepoSlugs([projectPath])[0]!;

test.beforeAll(async ({ request, backend }) => {
  repoA = await initRepo("a");
  repoB = await initRepo("b");
  git(repoA, ["branch", BRANCH]);
  git(repoB, ["branch", BRANCH]);
  branchShaA = git(repoA, ["rev-parse", BRANCH]);
  branchShaB = git(repoB, ["rev-parse", BRANCH]);

  // A subdirectory of repoA, registered as its own project — it must dedupe
  // onto repoA's git root.
  repoChild = path.join(repoA, "packages", "child");
  await mkdir(repoChild, { recursive: true });
  await writeFile(path.join(repoChild, "child.txt"), "child\n");

  // A plain folder that is not a git repository at all.
  repoPlain = await mkdtemp(path.join(tmpdir(), "agetor-e2e-select-plain-"));
  await writeFile(path.join(repoPlain, "notes.txt"), "not a repo\n");

  await registerProject(request, backend, repoA, path.basename(repoA));
  await registerProject(request, backend, repoB, path.basename(repoB));
  await registerProject(request, backend, repoChild, path.basename(repoChild));
  await registerProject(request, backend, repoPlain, path.basename(repoPlain));
});

test("one project: name label, enabled Isolate, one Branch row, single-repo payload", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects single");
  await form.getByTestId("prompt-textarea").fill("one project please");

  await chooseProjects(page, form, [repoA]);
  const button = form.getByTestId("select-projects-button");
  await expect(button).toContainText(path.basename(repoA));
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(1);

  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeEnabled();

  await selectBaseBranch(page, form, slugFor(repoA), BRANCH);
  await expect(branchRow(form, slugFor(repoA))).toContainText(BRANCH);

  await form.getByRole("button", { name: "Run task", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects single");
  expect(created.workdir).toBe(repoA);
  expect(created.isolation).toBe("worktree");
  expect(created.baseRef).toBe(branchShaA);
  expect(created.multiRepo ?? false).toBe(false);
  expect(created.repositories.map((r) => r.path)).toEqual([repoA]);
});

test("two projects: count label, forced Isolate, per-project refs in repositories[]", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects multi");
  await form.getByTestId("prompt-textarea").fill("two projects please");

  await chooseProjects(page, form, [repoA, repoB]);
  await expect(form.getByTestId("select-projects-button")).toContainText("2 projects selected");
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(2);

  // Base refs live in the inline Branch rows, never in the dialog.
  await form.getByTestId("select-projects-button").click();
  const dialog = selectProjectsDialog(page);
  await expect(dialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(dialog.getByLabel(/^Base ref for /)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeDisabled();

  await selectBaseBranch(page, form, slugFor(repoA), BRANCH);
  await selectBaseBranch(page, form, slugFor(repoB), BRANCH);

  await form.getByRole("button", { name: "Run task", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects multi");
  expect(created.multiRepo).toBe(true);
  expect(created.isolation).toBe("worktree");
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories.map((r) => r.baseRef)).toEqual([branchShaA, branchShaB]);
});

test("a repo plus its own subdirectory dedupes to one project", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects dedupe");
  await form.getByTestId("prompt-textarea").fill("dedupe please");

  // Save resolves both paths' git root and keeps the first selected path.
  await chooseProjects(page, form, [repoA, repoChild]);
  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoA));
  await expect(form.getByTestId("select-projects-button")).not.toContainText("projects selected");
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(1);
  await expect(form.getByTestId("isolate-toggle")).toBeEnabled();

  await form.getByRole("button", { name: "To backlog", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects dedupe");
  expect(created.multiRepo ?? false).toBe(false);
  expect(created.workdir).toBe(repoA);
  expect(created.repositories.map((r) => r.path)).toEqual([repoA]);
});

test("outside clicks leave the dialog open; Escape and Cancel close it", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await openSelectProjects(page, form);
  await selectProjectsDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selectProjectsDialog(page)).toBeHidden();
});

test("search filters project rows", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  const search = dialog.getByTestId("select-projects-search");
  await search.fill(path.basename(repoB));
  await expect(dialog.getByLabel(`Select ${repoB}`, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(`Select ${repoA}`, { exact: true })).toBeHidden();
});

test("a zero draft disables Save and shows the hint", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  const boxes = dialog.locator('input[type="checkbox"]');
  const count = await boxes.count();
  for (let i = count - 1; i >= 0; i--) {
    const box = boxes.nth(i);
    if (await box.isDisabled()) continue;
    if (await box.isChecked()) await box.uncheck();
  }

  await expect(dialog.getByText("Select at least one project.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("a submit keeps the selection and refs and resets the branch name", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects persistence");
  await form.getByTestId("prompt-textarea").fill("keep my picks");

  await chooseProjects(page, form, [repoA]);
  await selectBaseBranch(page, form, slugFor(repoA), BRANCH);
  const branchName = form.getByTestId("branch-name-input");
  await branchName.fill("custom/one-off");
  await expect(branchName).toHaveValue("custom/one-off");

  await form.getByRole("button", { name: "To backlog", exact: true }).click();

  // The selection and its per-project ref survive; the branch-name field
  // resets to its live pattern for the next task.
  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoA));
  await expect(branchRow(form, slugFor(repoA))).toContainText(BRANCH);
  await expect(branchName).not.toHaveValue("custom/one-off");
});

test("a non-git folder with Isolate off creates with workdir and isolation none", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects plain folder");
  await form.getByTestId("prompt-textarea").fill("plain folder please");

  await chooseProjects(page, form, [repoPlain]);
  await form.getByTestId("isolate-toggle").uncheck();
  await expect(form.getByTestId("isolate-toggle")).not.toBeChecked();
  await expect(form.getByTestId("branch-name-input")).toHaveCount(0);

  await form.getByRole("button", { name: "To backlog", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects plain folder");
  expect(created.workdir).toBe(repoPlain);
  expect(created.isolation).toBe("none");
  expect(created.baseRef).toBeNull();
  expect(created.multiRepo ?? false).toBe(false);
  expect(created.repositories.map((r) => r.path)).toEqual([repoPlain]);
});
