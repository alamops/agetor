import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import {
  branchRow,
  chooseProjects,
  dialogBranchPicker,
  gotoApp,
  openSelectProjects,
  pickDialogBranch,
  selectBaseBranch,
  selectProjectsDialog,
} from "./helpers";
import { uniqueRepoSlugs } from "../src/shared/multi-repo.ts";

/**
 * E2E coverage for the combined Select Projects control (replaces the old
 * split between a single project picker and the separate multi-repository
 * dialog). One full-width button above Isolate is the only selection surface:
 * its label carries the project name / selected count, every checked project
 * in its dialog gets the same branch picker with Pull and Fetch, the form shows
 * a read-only `Branch · <project>` summary line per project, and 2+ projects
 * force and disable Isolate. The issue dialog and the PR-conflict modal reuse the same
 * control (e2e/issue-task.spec.ts + e2e/resolve-conflicts.spec.ts).
 *
 * Scenarios:
 *  a. one project: non-current base ref rides the single-repository payload
 *     (`workdir` + top-level `baseRef`), no multi flag;
 *  b. two projects: `2 projects selected`, Isolate checked+disabled, each
 *     project's own non-current ref lands in `repositories[].baseRef`;
 *  c. a repo plus its own subdirectory dedupes to one project (button label,
 *     Isolate editable, single-repository task);
 *  c2. two repositories sharing a basename keep path-disambiguated row labels
 *      and distinct workspace test ids;
 *  c3. Isolate unchecked on one project → 2+ forces it on → collapsing back to
 *      one leaves it checked and editable (the load-bearing forced-on effect);
 *  d. outside clicks leave the dialog open; Escape and Cancel close it; the
 *     backdrop covers the whole window (no inherited sibling margin);
 *  e. search filters the rows (and the box is focused on open);
 *  f. a zero draft disables Save and shows the hint;
 *  g. a submit keeps the selection and its refs while the branch name resets;
 *  h. a plain non-git folder alone with Isolate off creates with
 *     `workdir` + `isolation:"none"` (never a `repositories[]` payload);
 *  i. with no project registered the form cannot create a task;
 *  j. Cancel discards the dialog's draft and reopening reseeds from the saved
 *     selection;
 *  k. unchecking and re-checking a project inside one dialog keeps its base
 *     ref (the opening entry's root/ref are restored, not rebuilt empty);
 *  l. each project's own Pull and Fetch act on that project's checkout, not
 *     on the first selected one;
 *  m. while a Save's git-root lookup is in flight the draft controls are
 *     disabled (a late edit cannot overwrite the resolved snapshot);
 *  o. a branch picked in the dialog is a draft: Cancel discards it;
 *  p. a picker's automatic current-branch seed is never saved: the summary
 *     reads "current branch" and the task gets the HEAD sha;
 *  q. the dialog's branch list opens in flow, so the scrolling project list
 *     never clips it;
 *  n. Add folder opens at the current selection and selects what it adds;
 *  n2. a folder pick that answers after the dialog closed and reopened is
 *      dropped instead of landing in the new draft.
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
let repoDupA: string;
let repoDupB: string;
let branchShaA: string;
let branchShaB: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepoAt(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), `${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function initRepo(name: string): Promise<string> {
  return initRepoAt(await mkdtemp(path.join(tmpdir(), `agetor-e2e-select-${name}-`)), name);
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

/** The webview and the per-worker API are different origins, so a routed
 *  answer must carry the preflight/permissive headers the real core sends. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

/** Holds every request whose pathname is `pathname` until `release()` runs. */
async function holdRequests(
  page: Page,
  pathname: string,
): Promise<{ release: () => void; seen: () => number }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let count = 0;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      count += 1;
      await gate;
      await route.continue();
    },
  );
  return { release, seen: () => count };
}

/** Answers the native folder panel (headless 501 in a real e2e backend) with
 *  `projectPath` and records the request body, so the starting folder and the
 *  add+select behavior are both observable. */
async function stubPick(
  page: Page,
  projectPath: string,
  name: string,
): Promise<() => { startingFolder?: string } | null> {
  let body: { startingFolder?: string } | null = null;
  await page.route(
    (url) => url.pathname === "/projects/pick",
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: CORS_HEADERS });
        return;
      }
      body = route.request().postDataJSON() as { startingFolder?: string } | null;
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          project: { path: projectPath, name, addedAt: Date.now(), branchConfig: null },
        }),
      });
    },
  );
  return () => body;
}

/** Answers /projects/pick only after `release()`, so a test can close the
 *  dialog while the native folder panel is still open. */
async function holdPick(
  page: Page,
  projectPath: string,
  name: string,
): Promise<{ release: () => void; seen: () => number }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  await page.route(
    (url) => url.pathname === "/projects/pick",
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: CORS_HEADERS });
        return;
      }
      seen += 1;
      await gate;
      await route.fulfill({
        status: 200,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          project: { path: projectPath, name, addedAt: Date.now(), branchConfig: null },
        }),
      });
    },
  );
  return { release: () => release(), seen: () => seen };
}

test.beforeAll(async ({ request, backend }) => {
  repoA = await initRepo("a");
  repoB = await initRepo("b");
  // A commit that exists only on `topic`. With the branch pointing at `main`,
  // a baseRef wired to HEAD would produce the same sha and pass by accident.
  for (const [dir, name] of [[repoA, "a"], [repoB, "b"]] as const) {
    git(dir, ["checkout", "-q", "-b", BRANCH]);
    await writeFile(path.join(dir, `${name}-topic.txt`), `${name} topic\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", `${name} topic`]);
    git(dir, ["checkout", "-q", "main"]);
  }
  branchShaA = git(repoA, ["rev-parse", BRANCH]);
  branchShaB = git(repoB, ["rev-parse", BRANCH]);
  expect(branchShaA).not.toBe(git(repoA, ["rev-parse", "main"]));
  expect(branchShaB).not.toBe(git(repoB, ["rev-parse", "main"]));
  expect(branchShaA).not.toBe(branchShaB);

  // repoB gets a real upstream so its inline row's Pull button is enabled:
  // Pull only makes sense for a local branch tracking a remote. The push
  // doesn't move main, so every `branchShaB` assertion above stays exact.
  const origin = await mkdtemp(path.join(tmpdir(), "agetor-e2e-select-origin-"));
  git(origin, ["init", "-q", "--bare"]);
  git(repoB, ["remote", "add", "origin", origin]);
  git(repoB, ["push", "-q", "-u", "origin", "main"]);

  // A subdirectory of repoA, registered as its own project — it must dedupe
  // onto repoA's git root.
  repoChild = path.join(repoA, "packages", "child");
  await mkdir(repoChild, { recursive: true });
  await writeFile(path.join(repoChild, "child.txt"), "child\n");

  // A plain folder that is not a git repository at all.
  repoPlain = await mkdtemp(path.join(tmpdir(), "agetor-e2e-select-plain-"));
  await writeFile(path.join(repoPlain, "notes.txt"), "not a repo\n");

  // Two different repositories whose basename collides. The collision test
  // registers them on its own fresh backend, so the shared worker's project
  // list (and its auto-selected project) stays as the other specs expect.
  repoDupA = path.join(await mkdtemp(path.join(tmpdir(), "agetor-e2e-select-dup-a-")), "api");
  repoDupB = path.join(await mkdtemp(path.join(tmpdir(), "agetor-e2e-select-dup-b-")), "api");
  await initRepoAt(repoDupA, "dup-a");
  await initRepoAt(repoDupB, "dup-b");

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
  await expect(branchRow(form, slugFor(repoA))).toContainText(`Branch · ${path.basename(repoA)}`);

  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeEnabled();

  // Until a branch is picked the summary reads "current branch".
  await expect(branchRow(form, slugFor(repoA))).toContainText("current branch");
  await selectBaseBranch(page, form, repoA, BRANCH);
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

  // The form only summarizes: no branch picker, Pull or Fetch lives there.
  const worktreeOptions = form.getByTestId("worktree-options");
  await expect(worktreeOptions.getByTestId("branch-picker-trigger")).toHaveCount(0);
  await expect(worktreeOptions.getByRole("button", { name: "Pull", exact: true })).toHaveCount(0);
  await expect(worktreeOptions.getByRole("button", { name: "Fetch", exact: true })).toHaveCount(0);

  // Clicking the summary reopens the dialog, where every checked project has
  // the same picker the single project had, with its own Pull and Fetch —
  // and an unchecked project has none.
  await form.getByTestId("selected-branches").click();
  const dialog = selectProjectsDialog(page);
  await expect(dialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  for (const repo of [repoA, repoB]) {
    const picker = dialogBranchPicker(dialog, repo);
    await expect(picker.getByTestId("branch-picker-trigger")).toContainText("main", { timeout: CONVERGE_TIMEOUT });
    await expect(picker.getByRole("button", { name: "Pull", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Fetch", exact: true })).toBeVisible();
  }
  await expect(dialogBranchPicker(dialog, repoPlain)).toHaveCount(0);
  // The old free-text per-repository base-ref inputs stay gone.
  await expect(dialog.getByLabel(/^Base ref for /)).toHaveCount(0);
  // The dialog hosts every management entry the spec promises.
  await expect(dialog.getByRole("button", { name: "Add folder", exact: true })).toBeVisible();
  await expect(dialog.getByTestId("project-clone-open")).toBeVisible();
  await expect(dialog.getByTestId("project-import-sessions-open")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeDisabled();

  // Both picks in one dialog session, applied by one Save.
  const picking = await openSelectProjects(page, form);
  await pickDialogBranch(picking, repoA, BRANCH);
  await pickDialogBranch(picking, repoB, BRANCH);
  await picking.getByRole("button", { name: "Save", exact: true }).click();
  await expect(picking).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  await expect(branchRow(form, slugFor(repoA))).toContainText(BRANCH);
  await expect(branchRow(form, slugFor(repoB))).toContainText(BRANCH);

  await form.getByRole("button", { name: "Run task", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects multi");
  expect(created.multiRepo).toBe(true);
  expect(created.isolation).toBe("worktree");
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories.map((r) => r.baseRef)).toEqual([branchShaA, branchShaB]);
});

test("unchecking and rechecking a project inside one dialog keeps its base ref", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects recheck ref");
  await form.getByTestId("prompt-textarea").fill("the pinned ref must survive a recheck");

  await chooseProjects(page, form, [repoA, repoB]);
  // Pin a NON-current ref on B. If the recheck rebuilt the draft entry as a
  // bare `{ path, root: null }` the ref would be gone by Save.
  await selectBaseBranch(page, form, repoB, BRANCH);
  await expect(branchRow(form, slugFor(repoB))).toContainText(BRANCH);

  const dialog = await openSelectProjects(page, form);
  const b = dialog.getByLabel(`Select ${repoB}`, { exact: true });
  await b.uncheck();
  await expect(b).not.toBeChecked();
  await b.check();
  await expect(b).toBeChecked();
  await expect(dialogBranchPicker(dialog, repoB).getByTestId("branch-picker-trigger")).toContainText(BRANCH);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

  await expect(form.getByTestId("select-projects-button")).toContainText("2 projects selected");
  await expect(branchRow(form, slugFor(repoB))).toContainText(BRANCH);

  await form.getByRole("button", { name: "Run task", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects recheck ref");
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories.find((r) => r.path === repoB)?.baseRef).toBe(branchShaB);
});

test("each project's Pull and Fetch act on that project's own checkout", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [repoA, repoB]);

  const dialog = await openSelectProjects(page, form);
  const rowB = dialogBranchPicker(dialog, repoB);
  // Both pickers auto-select their own current branch, so B's Pull is enabled
  // (its `main` tracks origin/main) and its actions carry B's path.
  const pullB = rowB.getByRole("button", { name: "Pull", exact: true });
  await expect(pullB).toBeEnabled({ timeout: CONVERGE_TIMEOUT });

  const fetchRequest = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname === "/projects/fetch",
  );
  await rowB.getByRole("button", { name: "Fetch", exact: true }).click();
  expect((await fetchRequest).postDataJSON()).toEqual({ path: repoB });

  const pullRequest = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname === "/projects/pull",
  );
  await pullB.click();
  expect((await pullRequest).postDataJSON()).toEqual({ path: repoB, branch: "main" });
});

test("unchecking Isolate, going multi, then collapsing keeps it checked", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const isolate = form.getByTestId("isolate-toggle");

  // Start from the one state that makes the forced-on effect load-bearing: a
  // single project whose Isolate the user turned OFF. Without the
  // `forceIsolate → setIsolate(true)` effect the raw toggle stays false through
  // the 2+ detour, so the collapse assertion below goes red.
  await chooseProjects(page, form, [repoA]);
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeEnabled();
  await isolate.uncheck();
  await expect(isolate).not.toBeChecked();
  await expect(form.getByTestId("branch-name-input")).toHaveCount(0);

  // 2+ projects force isolation: checked and disabled.
  await chooseProjects(page, form, [repoA, repoB]);
  await expect(form.getByTestId("select-projects-button")).toContainText("2 projects selected");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeDisabled();

  // Save a selection that drops back to a single project.
  const dialog = await openSelectProjects(page, form);
  await dialog.getByLabel(`Select ${repoB}`, { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoA));
  await expect(form.getByTestId("select-projects-button")).not.toContainText("projects selected");
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(1);

  // The forced state is gone but the toggle stays checked (owner decision),
  // and it is a normal editable checkbox again.
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeEnabled();
  await expect(form.getByTestId("branch-name-input")).toBeVisible();

  await isolate.uncheck();
  await expect(isolate).not.toBeChecked();
  await expect(form.getByTestId("branch-name-input")).toHaveCount(0);
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

test("projects sharing a basename keep distinct labeled rows and test ids", async ({ page, request, freshBackend }) => {
  // A test-scoped backend keeps these two colliding project names away from
  // the shared worker's list (whose most recently added project is what the
  // New Task form auto-selects).
  await registerProject(request, freshBackend, repoDupA, "dup-a");
  await registerProject(request, freshBackend, repoDupB, "dup-b");
  await gotoApp(page, freshBackend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [repoDupA, repoDupB]);

  const [slugA, slugB] = uniqueRepoSlugs([repoDupA, repoDupB]);
  expect(slugA).toBe("api");
  expect(slugB).toBe("api-2");

  await expect(form.getByTestId("select-projects-button")).toContainText("2 projects selected");
  // Rows are labelled with the project name, disambiguated by its parent
  // when two names collide — never by the sanitized workspace slug alone.
  await expect(branchRow(form, slugA!)).toContainText(`Branch · ${path.basename(path.dirname(repoDupA))}/api`);
  await expect(branchRow(form, slugB!)).toContainText(`Branch · ${path.basename(path.dirname(repoDupB))}/api`);
  // The full path is one hover away on each line.
  await expect(branchRow(form, slugA!).locator(`[title="${repoDupA}"]`)).toHaveCount(1);

  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeDisabled();
});

test("outside clicks leave the dialog open; Escape and Cancel close it", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  // The backdrop covers the whole window. The dialog renders inside
  // WorktreeOptions' `space-y-3` column, whose sibling margin once pushed the
  // fixed overlay 12px down and left a strip of the board uncovered on top.
  const viewport = page.viewportSize()!;
  const box = await dialog.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });

  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await openSelectProjects(page, form);
  await selectProjectsDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selectProjectsDialog(page)).toBeHidden();
});

test("Cancel discards the draft and reopening reseeds from the saved selection", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [repoA]);
  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoA));

  // A check inside the dialog is a draft: only Save applies it.
  const dialog = await openSelectProjects(page, form);
  await dialog.getByLabel(`Select ${repoB}`, { exact: true }).check();
  await expect(dialog.getByLabel(`Select ${repoB}`, { exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoA));
  await expect(form.getByTestId("select-projects-button")).not.toContainText("projects selected");
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(1);

  // Reopening reseeds from the saved value, not the abandoned draft.
  const reopened = await openSelectProjects(page, form);
  await expect(reopened.getByLabel(`Select ${repoA}`, { exact: true })).toBeChecked();
  await expect(reopened.getByLabel(`Select ${repoB}`, { exact: true })).not.toBeChecked();
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reopened).toBeHidden();
});

test("search filters project rows", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  const search = dialog.getByTestId("select-projects-search");
  // The dialog opens with the cursor in the search box.
  await expect(search).toBeFocused();
  await search.fill(path.basename(repoB));
  await expect(dialog.getByLabel(`Select ${repoB}`, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(`Select ${repoA}`, { exact: true })).toBeHidden();
});

test("Add folder opens at the current selection and selects what it adds", async ({ page, request, freshBackend }) => {
  const base = await initRepo("add-folder-base");
  const added = await initRepo("add-folder-added");
  await registerProject(request, freshBackend, base, "add-folder-base");
  await gotoApp(page, freshBackend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [base]);
  const dialog = await openSelectProjects(page, form);

  const pickedBody = await stubPick(page, added, "add-folder-added");
  await dialog.getByRole("button", { name: "Add folder", exact: true }).click();
  // The native panel starts where the selection already is (the retired
  // single-project picker's behavior), not at the home directory.
  await expect.poll(pickedBody, { timeout: CONVERGE_TIMEOUT }).toEqual({ startingFolder: base });
  // Adding a folder also selects it, and the Save then includes both.
  await expect(dialog.getByLabel(`Select ${added}`, { exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  await expect(form.getByTestId("select-projects-button")).toContainText("2 projects selected");
  await expect(branchRow(form, slugFor(added))).toBeVisible();
});

test("a pending Add folder result cannot leak into a reopened dialog", async ({ page, request, freshBackend }) => {
  const base = await initRepo("stale-pick-base");
  const stale = await initRepo("stale-pick-result");
  await registerProject(request, freshBackend, base, "stale-pick-base");
  await gotoApp(page, freshBackend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [base]);

  const dialog = await openSelectProjects(page, form);
  const held = await holdPick(page, stale, "stale-pick-result");
  await dialog.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect.poll(held.seen, { timeout: CONVERGE_TIMEOUT }).toBe(1);

  // Walk away while the native panel is still open, then start a new session.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  const reopened = await openSelectProjects(page, form);

  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/projects/pick",
    { timeout: CONVERGE_TIMEOUT },
  );
  held.release();
  await answered;
  // Let React commit any state update the late response produced.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  // The old session's pick is dropped: no row, and the reopened draft is
  // still exactly the project it opened with.
  await expect(reopened.getByLabel(`Select ${stale}`, { exact: true })).toHaveCount(0);
  await expect(reopened.locator('[data-testid^="select-projects-row-"]')).toHaveCount(1);
  await expect(reopened.getByRole("button", { name: "Add folder", exact: true })).toBeEnabled();
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
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

test("a Save in flight disables the draft while the git roots resolve", async ({ page, request, freshBackend }) => {
  // A fresh backend whose projects were never selected before: their roots
  // are still unknown, so this Save actually calls /projects/repo-root.
  const repoX = await initRepo("save-lock-x");
  const repoY = await initRepo("save-lock-y");
  await registerProject(request, freshBackend, repoX, "save-lock-x");
  await registerProject(request, freshBackend, repoY, "save-lock-y");
  await gotoApp(page, freshBackend.bootBase);
  const form = newTaskForm(page);
  const dialog = await openSelectProjects(page, form);

  const boxes = dialog.locator('input[type="checkbox"]');
  for (let i = (await boxes.count()) - 1; i >= 0; i--) {
    const box = boxes.nth(i);
    if (await box.isDisabled()) continue;
    if (await box.isChecked()) await box.uncheck();
  }
  await dialog.getByLabel(`Select ${repoX}`, { exact: true }).check();

  const gate = await holdRequests(page, "/projects/repo-root");
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect.poll(gate.seen, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add folder", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel(`Select ${repoX}`, { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel(`Remove ${repoX}`, { exact: true })).toBeDisabled();
  await expect(dialogBranchPicker(dialog, repoX).getByTestId("branch-picker-trigger")).toBeDisabled();

  gate.release();
  await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  await expect(form.getByTestId("select-projects-button")).toContainText(path.basename(repoX));
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(1);
});

test("a submit keeps the selection and refs and resets the branch name", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects persistence");
  await form.getByTestId("prompt-textarea").fill("keep my picks");

  await chooseProjects(page, form, [repoA]);
  await selectBaseBranch(page, form, repoA, BRANCH);
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

test("with no project selected the form cannot create a task", async ({ page, freshBackend }) => {
  // `freshBackend` (test-scoped) starts with zero registered projects, so the
  // form's auto-select has nothing to promote — the one state where the
  // form-side "at least one project" guard is observable.
  await gotoApp(page, freshBackend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("no project selected");
  await form.getByTestId("prompt-textarea").fill("this must not be submittable");

  await expect(form.getByTestId("select-projects-button")).toContainText("Select projects…");
  await expect(form.getByTestId("select-projects-empty")).toBeVisible();
  await expect(form.getByRole("button", { name: "To backlog", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "Run task", exact: true })).toBeDisabled();
});

test("a branch picked in the dialog is a draft: Cancel discards it", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [repoA]);
  await expect(branchRow(form, slugFor(repoA))).toContainText("current branch");

  const dialog = await openSelectProjects(page, form);
  await pickDialogBranch(dialog, repoA, BRANCH);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Nothing was applied, and reopening reseeds from the saved selection: the
  // picker is back on the project's current branch.
  await expect(branchRow(form, slugFor(repoA))).toContainText("current branch");
  await expect(branchRow(form, slugFor(repoA))).not.toContainText(BRANCH);
  const reopened = await openSelectProjects(page, form);
  await expect(dialogBranchPicker(reopened, repoA).getByTestId("branch-picker-trigger")).toContainText("main", {
    timeout: CONVERGE_TIMEOUT,
  });
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("a picker's automatic current-branch seed is not saved as a pick", async ({ page, request, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await form.getByPlaceholder("Short description").fill("select-projects seed not saved");
  await form.getByTestId("prompt-textarea").fill("leave the branch alone");
  await chooseProjects(page, form, [repoA, repoB]);

  // Open, let both pickers preselect `main`, pick only B, and Save.
  const dialog = await openSelectProjects(page, form);
  await expect(dialogBranchPicker(dialog, repoA).getByTestId("branch-picker-trigger")).toContainText("main", {
    timeout: CONVERGE_TIMEOUT,
  });
  await pickDialogBranch(dialog, repoB, BRANCH);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

  // A's seed was only shown in the trigger; B's pick is saved.
  await expect(branchRow(form, slugFor(repoA))).toContainText("current branch");
  await expect(branchRow(form, slugFor(repoB))).toContainText(BRANCH);

  await form.getByRole("button", { name: "To backlog", exact: true }).click();
  const created = await awaitTask(request, backend, "select-projects seed not saved");
  // No ref for A means HEAD at create time, which is A's `main`.
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories[0]!.baseRef).toBe(git(repoA, ["rev-parse", "main"]));
  expect(created.repositories[1]!.baseRef).toBe(branchShaB);
});

test("the dialog's branch list opens in flow and is never clipped by the project list", async ({ page, backend }) => {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await chooseProjects(page, form, [repoB, repoA]);

  // `/projects` lists the newest first, so repoA (registered first) is the
  // bottom row: a floating popover there would hang below the list's
  // scrolling box and be cut off.
  const dialog = await openSelectProjects(page, form);
  const picker = dialogBranchPicker(dialog, repoA);
  await picker.getByTestId("branch-picker-trigger").click();
  const popover = picker.locator("[data-popover-open]");
  await expect(popover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(popover.getByText(BRANCH, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  const list = dialog.getByTestId("select-projects-list");
  await expect.poll(async () => {
    const [p, l] = await Promise.all([popover.boundingBox(), list.boundingBox()]);
    if (!p || !l) return false;
    return p.y >= l.y - 1 && p.y + p.height <= l.y + l.height + 1;
  }, { timeout: CONVERGE_TIMEOUT }).toBe(true);

  // Escape closes the branch list first, then the dialog.
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
