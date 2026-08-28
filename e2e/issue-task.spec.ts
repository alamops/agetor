import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for "New task from a Git issue + its comment thread"
 * (docs/plans/new-task-from-git-issue.md §5 T4 — covers Tasks B, C, D, E):
 *
 *  1. Issue detail page -> "Work on this with Agetor" (`IssueActions` in
 *     `GitHubDialog.tsx`) -> the stacked `CreateTaskFromIssueDialog` ->
 *     create & start -> board card + durable `issueUrl`/snapshot reference
 *     -> run panel "View issue" -> task card context menu "View issue".
 *  2. New Task sidebar -> paste an issue URL -> seeded title/prompt/chip ->
 *     "To backlog" -> a linked backlog task.
 *  3. Pasting an issue URL for a *different* repository than the selected
 *     project is rejected with no chip.
 *
 * Arrange: one throwaway git repo with `origin` -> `https://github.com/
 * e2e-org/e2e-repo.git` (same recipe as `e2e/pr-merged-state.spec.ts`'s
 * `initRepo`), registered as a project through the real `POST /projects`.
 * Shared across all three tests (`beforeAll`/`afterAll`, serial mode) — the
 * three scenarios are really three views of the same issue #7. The stub
 * GitHub API (`e2e/github-stub.ts`) is started once on
 * `backend.githubStubPort` and its route table is installed once in
 * `beforeAll` (issue #7's data never changes across these tests, unlike
 * pr-merged-state's mid-test PR-state flips).
 *
 * `openGitDialog` explicitly selects this spec's project in the dialog's
 * Project combobox — see `pr-merged-state.spec.ts`'s file header for why
 * that's required whenever a worker-shared backend might have other specs'
 * tasks/projects registered.
 */

test.describe.configure({ mode: "serial" });

const REPO_PATH = "/repos/e2e-org/e2e-repo";
const ISSUE_NUMBER = 7;
const ISSUE_TITLE = "reconcileById loses task identity on rapid polls";
const ISSUE_HTML_URL = `https://github.com/e2e-org/e2e-repo/issues/${ISSUE_NUMBER}`;
const COMMENT_1_BODY = "Repro on 0.9.3 — reconcileById loses identity";
const COMMENT_2_BODY = "Confirmed on main";

// Generous but bounded convergence timeout — the create+start round trip
// involves a real worktree/branch creation against a real temp git repo, on
// top of the usual fetch/render settling. Mirrors pr-merged-state.spec.ts's
// CONVERGE_TIMEOUT.
const CONVERGE_TIMEOUT = 20_000;

let stub: GitHubStub;
let projectDir: string;
const createdTaskIds: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-issue-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", "https://github.com/e2e-org/e2e-repo.git"]);
  await writeFile(path.join(dir, "README.md"), "e2e fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
  return dir;
}

/** Registers `dir` as a project via the plain global `fetch` (not
 *  Playwright's `request` fixture, which is test-scoped and unavailable in
 *  `beforeAll`) — mirrors `pr-merged-state.spec.ts`'s `registerProject`. */
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

function commentPayload(id: number, login: string, body: string, createdAt: string) {
  return {
    id,
    body,
    html_url: `${ISSUE_HTML_URL}#issuecomment-${id}`,
    user: { login, avatar_url: null, html_url: null },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function issuePayload() {
  return {
    number: ISSUE_NUMBER,
    title: ISSUE_TITLE,
    state: "open",
    html_url: ISSUE_HTML_URL,
    user: { login: "e2e-reporter", avatar_url: null, html_url: null },
    assignees: [] as unknown[],
    milestone: null,
    body: "Steps to reproduce:\n1. Open two tabs\n2. Poll rapidly\n\nExpected: identity preserved.",
    labels: [] as unknown[],
    comments: 2,
    created_at: "2026-08-10T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
    closed_at: null,
    locked: false,
    draft: false,
    // Deliberately no `pull_request` key — that's the guard
    // `getGitHubIssueThread` (src/bun/github.ts) checks to reject a PR
    // payload from the shared `/issues/:n` endpoint.
  };
}

/** Routes every scenario needs regardless of which test is running — repo
 *  metadata, the label/milestone/assignee/reactions/sub-issues panels
 *  `IssueActions` renders, and the GraphQL pin-status probe. None of these
 *  are asserted on; they exist to keep the stub's unmatched-route stderr
 *  log quiet, mirroring `pr-merged-state.spec.ts`'s `auxiliaryRoutes`. */
function auxiliaryRoutes(): StubRoute[] {
  return [
    { method: "GET", path: "/user", body: { login: "e2e-user", id: 1 } },
    {
      method: "GET",
      path: new RegExp(`^${REPO_PATH}$`),
      body: { permissions: { push: true, admin: true, maintain: true }, default_branch: "main" },
    },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/labels$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/milestones$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/assignees$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/releases$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}/reactions$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}/sub_issues$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/comments/[0-9]+/reactions$`), body: [] },
    {
      method: "POST",
      path: "/graphql",
      // Same "one shape answers every query" idiom as pr-merged-state.spec
      // .ts's auxiliaryRoutes — each parser reads only the field it cares
      // about (issue pin status here) and ignores the rest.
      body: {
        data: {
          repository: {
            issue: { isPinned: false },
            pullRequest: {
              closingIssuesReferences: { nodes: [] },
              reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      },
    },
  ];
}

function issueRoutes(): StubRoute[] {
  return [
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues$`), body: [issuePayload()] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}$`), body: issuePayload() },
    {
      method: "GET",
      path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}/comments$`),
      body: [
        commentPayload(101, "e2e-reporter", COMMENT_1_BODY, "2026-08-10T09:05:00Z"),
        commentPayload(102, "e2e-maintainer", COMMENT_2_BODY, "2026-08-11T10:00:00Z"),
      ],
    },
    ...auxiliaryRoutes(),
  ];
}

/** The New Task sidebar's `<aside>` — mounted first in App.tsx's JSX (see
 *  e2e/quote.spec.ts / e2e/task-context-menu.spec.ts's identical helpers). */
function newTaskAside(page: Page): Locator {
  return page.locator("aside").first();
}

/** The run panel's slide-over `<aside>` — mounted after NewTaskForm, so
 *  `.last()` resolves it once a task is open. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

function menu(page: Page): Locator {
  return page.locator('[data-testid="task-context-menu"]');
}

function menuItem(page: Page, action: string): Locator {
  return page.locator(`[data-testid="task-context-menu-${action}"]`);
}

/** Right-clicks the board card by exact title — clicking the `.cursor-grab`
 *  card element itself (not a generic `getByText` match) so this is
 *  unambiguous even while the run panel for the same task is open, since the
 *  panel's own header repeats the task title as plain text. */
async function rightClickCard(page: Page, title: string): Promise<void> {
  const card = taskCard(page, title);
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
}

/** Opens the Git dialog (board toolbar button, aria-label "Git") and pins
 *  its Project combobox to this spec's own repo — same rationale as
 *  `pr-merged-state.spec.ts`'s `openGitDialog`: the worker-scoped backend is
 *  shared with other spec files, so the dialog's no-prefill default project
 *  isn't reliable. Always leaves the "Issues" tab selected (the dialog
 *  defaults to "Pulls"). */
async function openGitDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const projectSelect = dialog.getByRole("combobox", { name: "Project" });
  await expect(projectSelect).toBeVisible();
  if ((await projectSelect.inputValue()) !== projectDir) {
    await projectSelect.selectOption({ value: projectDir });
  }

  const issuesTab = dialog.getByRole("button", { name: "Issues", exact: true });
  await issuesTab.click();

  return dialog;
}

/** Selects `projectDir` in the New Task sidebar's Project field
 *  (`ProjectPicker` -> `SearchSelect`, a hand-rolled combobox — not a native
 *  `<select>`, so this drives its popover directly): opens the popover via
 *  the trigger button immediately following the plain-text "Project" label,
 *  types the directory's basename into the search box to filter down to
 *  exactly this project, then clicks the one matching row. */
async function selectProjectInForm(page: Page, dir: string): Promise<void> {
  const form = newTaskAside(page);
  const trigger = form.locator('label:text-is("Project") + div button').first();
  await trigger.click();
  const search = form.locator('input[placeholder="Search projects…"]');
  const base = path.basename(dir);
  await expect(search).toBeVisible();
  await search.fill(base);
  await form.getByRole("button", { name: base }).first().click();
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  stub = await startGitHubStub(backend.githubStubPort, issueRoutes());
});

test.afterAll(async ({ backend }) => {
  // Every test below deletes its own task as soon as it's done asserting
  // (via the `request` fixture), but a failed assertion mid-test would skip
  // that cleanup line — sweep any survivors here via the plain global
  // `fetch` (worker-scoped `beforeAll`/`afterAll` have no `request` fixture,
  // same reason `registerProject` above uses `fetch` directly).
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${backend.apiToken}` },
    }).catch(() => { /* best-effort cleanup */ });
  }
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
});

/** DELETE /tasks/:id via the `request` fixture — the per-test cleanup call.
 *  Falls out of `createdTaskIds` on success so `afterAll`'s sweep above
 *  doesn't double-delete. */
async function deleteTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  await request
    .delete(`${backend.apiBase}/tasks/${id}`, { headers: { authorization: `Bearer ${backend.apiToken}` } })
    .catch(() => { /* best-effort cleanup */ });
}

async function findTaskByTitle(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<{ id: string; issueUrl: string | null; references: { path: string; isDirectory: boolean }[]; column: string } | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as Array<{
    id: string;
    title: string;
    issueUrl: string | null;
    references: { path: string; isDirectory: boolean }[];
    column: string;
  }>;
  return rows.find((r) => r.title === title) ?? null;
}

test.describe("task from a Git issue", () => {
  test("dialog path: issue detail -> Work on this with Agetor -> create & start -> View issue", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    const cardTitle = `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

    await gotoApp(page, backend.bootBase);
    const dialog = await openGitDialog(page);

    const row = dialog.getByRole("button", { name: `#${ISSUE_NUMBER} ${ISSUE_TITLE}` });
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();

    // Detail subpage loaded — its header renders the issue's plain-text
    // title (GitHubDialog.tsx's `expandedItem.title` line).
    await expect(dialog.getByText(ISSUE_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const workButton = dialog.getByTestId("issue-work-with-agetor");
    await expect(workButton).toBeVisible();
    await workButton.click();

    const issueTaskDialog = page.getByTestId("issue-task-dialog");
    await expect(issueTaskDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const promptTextarea = issueTaskDialog.locator("textarea");
    await expect(promptTextarea).toBeVisible();
    await expect(async () => {
      const value = await promptTextarea.inputValue();
      expect(value).toContain(`Issue #${ISSUE_NUMBER}`);
      expect(value).toContain(COMMENT_1_BODY);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    const submit = page.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();

    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByText("Task created and started")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Board shows the new card, and GET /tasks agrees (poll via the bearer
    // token, per the task brief).
    let task: Awaited<ReturnType<typeof findTaskByTitle>> = null;
    await expect(async () => {
      task = await findTaskByTitle(request, backend, cardTitle);
      expect(task).not.toBeNull();
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    const taskId = task!.id;
    createdTaskIds.push(taskId);

    await expect(taskCard(page, cardTitle)).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // issueUrl + snapshot reference, both server-recorded at create time.
    expect(task!.issueUrl).toBe(ISSUE_HTML_URL);
    const snapshotRef = task!.references.find((r) => r.path.endsWith(`issue-${ISSUE_NUMBER}-thread.md`));
    expect(snapshotRef, `references: ${JSON.stringify(task!.references)}`).toBeTruthy();
    expect(existsSync(path.join(backend.dataDir, "issue-threads", taskId, `issue-${ISSUE_NUMBER}-thread.md`))).toBe(true);

    // Run panel shows the durable "View issue" affordance.
    await taskCard(page, cardTitle).click();
    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(panel.getByTestId("view-issue")).toBeVisible();

    // Close the run panel before right-clicking the card below — the panel
    // is a fixed 520px-wide overlay that can sit on top of a board card in
    // a narrow test viewport, which would otherwise intercept the click. The
    // panel never unmounts (App.tsx keeps it mounted and slides it off with
    // a `translate-x-full` CSS transform), so `toBeHidden()` never fires —
    // wait for that class instead, which is what actually clears it from the
    // click's hit-test.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveClass(/translate-x-full/, { timeout: CONVERGE_TIMEOUT });

    // Context menu also offers "View issue", and it reopens the Git dialog
    // on this exact issue.
    await rightClickCard(page, cardTitle);
    await expect(menu(page)).toBeVisible();
    const viewIssueEntry = menuItem(page, "view-issue");
    await expect(viewIssueEntry).toBeVisible();
    await viewIssueEntry.click();

    const reopenedDialog = page.getByRole("dialog");
    await expect(reopenedDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(reopenedDialog.getByText(ISSUE_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await deleteTask(request, backend, taskId);
    createdTaskIds.splice(createdTaskIds.indexOf(taskId), 1);
  });

  test("form path: New Task sidebar paste-URL seeds title/prompt/chip and links the created task", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);

    await selectProjectInForm(page, projectDir);

    const urlInput = page.getByTestId("issue-url-input");
    await expect(urlInput).toBeEnabled();
    await urlInput.fill(ISSUE_HTML_URL);
    await page.getByTestId("issue-url-load").click();

    const titleInput = page.getByPlaceholder("Short description");
    await expect(async () => {
      expect(await titleInput.inputValue()).toBe(`Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    const promptTextarea = page.getByPlaceholder("What should the agent do? Type / for commands.");
    await expect(async () => {
      expect(await promptTextarea.inputValue()).toContain(COMMENT_1_BODY);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    const chip = page.getByTestId("issue-link-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(`Issue #${ISSUE_NUMBER}`);

    await page.getByRole("button", { name: "To backlog", exact: true }).click();

    const formCardTitle = `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;
    let task: Awaited<ReturnType<typeof findTaskByTitle>> = null;
    await expect(async () => {
      task = await findTaskByTitle(request, backend, formCardTitle);
      expect(task).not.toBeNull();
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    const taskId = task!.id;
    createdTaskIds.push(taskId);

    expect(task!.column).toBe("backlog");
    expect(task!.issueUrl).toBe(ISSUE_HTML_URL);

    await deleteTask(request, backend, taskId);
    createdTaskIds.splice(createdTaskIds.indexOf(taskId), 1);
  });

  test("wrong repo: pasting an issue URL for a different repository is rejected with no chip", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);

    await selectProjectInForm(page, projectDir);

    const urlInput = page.getByTestId("issue-url-input");
    await urlInput.fill(`https://github.com/other-org/other-repo/issues/${ISSUE_NUMBER}`);
    await page.getByTestId("issue-url-load").click();

    await expect(page.getByText(/different repository/i)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("issue-link-chip")).toHaveCount(0);
  });
});
