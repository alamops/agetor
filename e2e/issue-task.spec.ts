import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for "task from a Git issue + its comment thread" via the
 * issue detail page's "Work on this with Agetor" dialog
 * (`CreateTaskFromIssueDialog.tsx`), which — per
 * docs/plans/issue-pr-modal-worktree-composer-parity.md — now carries the
 * New Task left panel's worktree row (`WorktreeOptions`) and prompt composer
 * (`PromptComposer`) via shared modules, so the two can't drift. The panel's
 * own "From issue" paste-URL row was removed on this branch (issue tasks are
 * still created from this dialog and from `agetor add --issue`), so the
 * form-path tests that used to live here are gone too.
 *
 * Six scenarios, all against the same fixture issue #7 (which now carries a
 * "bug" label — see `issuePayload()` — for scenario 5 below):
 *
 *  1. Dialog path (baseline): issue detail -> "Work on this with Agetor" ->
 *     the stacked `CreateTaskFromIssueDialog` -> create & start (default
 *     Isolate ON) -> board card + durable `issueUrl`/snapshot reference ->
 *     run panel "View issue" -> task card context menu "View issue".
 *  2. Isolate off: unchecking `isolate-toggle` swaps the info-box copy, hides
 *     the branch-name field, and creates a task with `isolation: "none"` and
 *     no branch/worktree.
 *  3. Branch-from + custom name: picking a non-default branch in the
 *     `WorktreeOptions` Branch picker and typing a custom branch name sends
 *     both through — `baseRef` resolves server-side to that branch's sha.
 *  4. Composer: the `/` slash autocomplete and the "MCP · Skills · Plugins ·
 *     Prompts" extension picker both insert into the prompt textarea, Escape
 *     closes an open popover without closing the dialog underneath it (the
 *     `dialog.tsx` / `data-popover-open` fix), and the Files/Folders
 *     references picker renders (its native file panel isn't e2e-drivable).
 *  5. Label-inferred type: the issue's "bug" label seeds `TaskTypePicker` on
 *     "Bug" (`inferTaskTypeFromLabels`), which drives the branch-name field's
 *     `fix/…` prefix; clicking Spike/Bug swaps both the picker selection and
 *     the derived prefix, and the created task carries `taskType: "bug"`.
 *  6. References picker: `refs-pick-files`/`refs-pick-folder` (via the
 *     `AGETOR_FAKE_PICK_REFS_DIR` test seam) and a real drag-drop (a
 *     non-transient file from this repo checkout, resolved through
 *     `POST /refs/resolve`) all attach chips; removing one leaves the rest,
 *     and the created task's `references` carries exactly those paths plus
 *     the issue-snapshot reference.
 *
 * Arrange: one throwaway git repo with `origin` -> `https://github.com/
 * e2e-org/e2e-repo.git` (same recipe as `e2e/pr-merged-state.spec.ts`'s
 * `initRepo`), registered as a project through the real `POST /projects`.
 * Shared across all four tests (`beforeAll`/`afterAll`, serial mode) — the
 * four scenarios are really four views of the same issue #7 and the same
 * fixture repo. The stub GitHub API (`e2e/github-stub.ts`) is started once on
 * `backend.githubStubPort` and its route table is installed once in
 * `beforeAll` (issue #7's data never changes across these tests, unlike
 * pr-merged-state's mid-test PR-state flips).
 *
 * The fixture repo also carries a `.claude/skills/e2e-skill/SKILL.md` and a
 * root `.mcp.json` (committed on `main`, present on `develop` too) so
 * `listAgentCapabilities`'s claude-code discovery (src/bun/commands.ts) has
 * something project-scoped to surface in the composer test's extension
 * picker, plus a `develop` branch (one commit ahead of `main`) for the
 * branch-from test's Branch picker. Discovery reads the *source* repo on
 * disk (the dialog's `workdir`), not a worktree, and needs no claude binary
 * — `CLAUDE_BUILTINS` (e.g. `/code-review`) are always listed regardless.
 *
 * `openGitDialog` explicitly selects this spec's project in the dialog's
 * Project combobox — see `pr-merged-state.spec.ts`'s file header for why
 * that's required whenever a worker-shared backend might have other specs'
 * tasks/projects registered.
 */

test.describe.configure({ mode: "serial" });

// Same recipe as `e2e/fixtures.ts`'s own `REPO_ROOT` — resolves to this repo
// checkout's root, used by the references-picker test below to drop a
// non-transient real file (`README.md`) that survives `isTransientPath`'s
// `/tmp`/`/var/folders` filter (see `src/mainview/lib/capture-refs.ts`).
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const REPO_PATH = "/repos/e2e-org/e2e-repo";
const ISSUE_NUMBER = 7;
const ISSUE_TITLE = "reconcileById loses task identity on rapid polls";
const ISSUE_HTML_URL = `https://github.com/e2e-org/e2e-repo/issues/${ISSUE_NUMBER}`;
const COMMENT_1_BODY = "Repro on 0.9.3 — reconcileById loses identity";
const COMMENT_2_BODY = "Confirmed on main";
const CARD_TITLE = `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

// Tooltip WorktreeOptions puts on the Branch picker trigger while isolated —
// see WorktreeOptions.tsx. Used to find the trigger without depending on
// BranchPicker's internal DOM structure (label and picker aren't siblings).
const BRANCH_PICKER_TITLE =
  "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start.";

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

  // Discovery fixtures for the composer test — listAvailableCommands /
  // discoverMcpAndPluginExtensions (src/bun/commands.ts) read these straight
  // off this SOURCE repo on disk, not a worktree. A project skill's
  // slash-invokable name is its folder name (discoverSkills) — the SKILL.md
  // frontmatter only needs `description:` — and a project .mcp.json's
  // `mcpServers` keys surface as `@name` mention extensions
  // (mcpServersToExtensions). Planted and committed on `main` (before the
  // `develop` branch below forks off it, so it inherits them too) so `git
  // status` stays clean for the worktree machinery.
  await mkdir(path.join(dir, ".claude", "skills", "e2e-skill"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "skills", "e2e-skill", "SKILL.md"),
    "---\ndescription: An e2e fixture skill.\n---\nDo the e2e thing.\n",
  );
  await writeFile(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "e2e-mcp": { command: "true" } } }),
  );

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);

  // A second branch, one commit ahead of `main`, purely for the branch-from
  // test's Branch picker (BranchPicker lists local branches of the project).
  // Switch back to `main` afterward so the fixture's checked-out branch (and
  // hence claude-code's discovery read of this same `dir`) is unaffected by
  // whichever base ref a test later *picks* in the dialog.
  git(dir, ["checkout", "-q", "-b", "develop"]);
  await writeFile(path.join(dir, "DEVELOP.md"), "develop marker\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "develop commit"]);
  git(dir, ["checkout", "-q", "main"]);

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
    // A "bug" label — read by `inferTaskTypeFromLabels` (src/shared/issue-
    // task.ts) to seed the dialog's Type picker. No existing test in this
    // file string-matches the prompt's "Labels: (none)" line, so this is
    // safe to add without touching any other assertion.
    labels: [{ name: "bug", color: "d73a4a" }] as unknown[],
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

/** Drives the issue detail page's "Work on this with Agetor" button and
 *  waits for `CreateTaskFromIssueDialog` (`issue-task-dialog`) to be up with
 *  its prompt seeded from the fetched thread — the common setup every test
 *  below needs before it starts poking at the worktree row or the composer.
 *  Scoped locators throughout: once this dialog is open, two `role=dialog`s
 *  are stacked (`GitHubDialog` underneath), so every subsequent locator in a
 *  test should be rooted at the returned `issueTaskDialog`, not `page`. */
async function openIssueTaskDialog(page: Page): Promise<Locator> {
  const dialog = await openGitDialog(page);

  const row = dialog.getByRole("button", { name: `#${ISSUE_NUMBER} ${ISSUE_TITLE}` });
  await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await row.click();

  // Detail subpage loaded — its header renders the issue's plain-text title
  // (GitHubDialog.tsx's `expandedItem.title` line).
  await expect(dialog.getByText(ISSUE_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  const workButton = dialog.getByTestId("issue-work-with-agetor");
  await expect(workButton).toBeVisible();
  await workButton.click();

  const issueTaskDialog = page.getByTestId("issue-task-dialog");
  await expect(issueTaskDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  const promptTextarea = issueTaskDialog.getByTestId("prompt-textarea");
  await expect(promptTextarea).toBeVisible();
  await expect(async () => {
    const value = await promptTextarea.inputValue();
    expect(value).toContain(`Issue #${ISSUE_NUMBER}`);
    expect(value).toContain(COMMENT_1_BODY);
  }).toPass({ timeout: CONVERGE_TIMEOUT });

  return issueTaskDialog;
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
): Promise<{
  id: string;
  issueUrl: string | null;
  references: { path: string; isDirectory: boolean }[];
  column: string;
  isolation: "worktree" | "none";
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  branchSource: "created" | "existing";
  taskType: "task" | "bug" | "spike";
} | null> {
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
    isolation: "worktree" | "none";
    branch: string | null;
    baseRef: string | null;
    taskType: "task" | "bug" | "spike";
    worktreePath: string | null;
    branchSource: "created" | "existing";
  }>;
  return rows.find((r) => r.title === title) ?? null;
}

/** Polls `GET /tasks` until a task with `title` shows up, registers it for
 *  cleanup, and returns it. Shared by every test below that creates a task. */
async function awaitCreatedTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<NonNullable<Awaited<ReturnType<typeof findTaskByTitle>>>> {
  let task: Awaited<ReturnType<typeof findTaskByTitle>> = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  createdTaskIds.push(task!.id);
  return task!;
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

  test("isolate off: unchecking Isolate creates a task with no worktree", async ({ page, request, backend }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const worktreeOptions = issueTaskDialog.getByTestId("worktree-options");
    const isolateToggle = worktreeOptions.getByTestId("isolate-toggle");
    await expect(isolateToggle).toBeChecked();
    await isolateToggle.uncheck();

    await expect(
      issueTaskDialog.getByText(/Runs the agent directly in the project checkout/),
    ).toBeVisible();
    await expect(worktreeOptions.getByTestId("branch-name-input")).toHaveCount(0);

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitCreatedTask(request, backend, CARD_TITLE);

    expect(task.isolation).toBe("none");
    expect(task.branch).toBeNull();
    expect(task.worktreePath).toBeNull();

    await deleteTask(request, backend, task.id);
    createdTaskIds.splice(createdTaskIds.indexOf(task.id), 1);
  });

  test("branch-from + custom name: picking develop as the base ref and a custom branch name sends both", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const worktreeOptions = issueTaskDialog.getByTestId("worktree-options");

    // BranchPicker's label and its SearchSelect trigger aren't DOM siblings
    // (the label shares a flex row with the Git Pull/Fetch buttons), so find
    // the trigger by its tooltip instead — WorktreeOptions.tsx sets this
    // exact title while isolated.
    const branchTrigger = worktreeOptions.getByTitle(BRANCH_PICKER_TITLE);
    await branchTrigger.scrollIntoViewIfNeeded();
    await branchTrigger.click();

    const search = worktreeOptions.getByPlaceholder("Search branches…");
    await expect(search).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await search.fill("develop");

    const popover = worktreeOptions.locator("[data-popover-open]");
    const developRow = popover.locator("button").filter({ hasText: "develop" }).first();
    await expect(developRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await developRow.scrollIntoViewIfNeeded();
    await developRow.click();

    const branchNameInput = worktreeOptions.getByTestId("branch-name-input");
    await expect(branchNameInput).toBeVisible();
    await branchNameInput.fill("feature/e2e-custom");

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitCreatedTask(request, backend, CARD_TITLE);

    const expectedBaseRef = execFileSync("git", ["rev-parse", "develop"], { cwd: projectDir })
      .toString()
      .trim();

    expect(task.isolation).toBe("worktree");
    expect(task.branch).toBe("feature/e2e-custom");
    expect(task.baseRef).toBe(expectedBaseRef);

    await deleteTask(request, backend, task.id);
    createdTaskIds.splice(createdTaskIds.indexOf(task.id), 1);
  });

  test("composer: slash autocomplete, extension picker, Escape yields to the popover, references picker renders", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const promptTextarea = issueTaskDialog.getByTestId("prompt-textarea");

    // Place the caret at the end of the seeded prompt, then type a `/`
    // trigger — SlashAutocomplete only opens for a `/` at line-start or
    // after whitespace, hence the leading `\n`.
    await promptTextarea.click();
    await promptTextarea.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await page.keyboard.type("\n/code-");

    const slashMenu = issueTaskDialog.getByTestId("slash-autocomplete");
    await expect(slashMenu).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const codeReviewRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/code-review" });
    await expect(codeReviewRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // Click the row directly rather than pressing Enter (which inserts
    // whichever row is "active" — index 0 by default): claude-code's user-
    // level discovery reads the REAL machine's `~/.claude/skills`
    // (commands.ts has no way to fake `os.homedir()`, same limitation
    // commands.test.ts documents), and a real installed skill can
    // legitimately mention "code-review" in its own description (e.g. a
    // parenthetical "(code-review)") and so also match the `code-` query —
    // sorting ahead of `/code-review` alphabetically would make Enter
    // non-deterministic across machines. Clicking the exact row keeps this
    // assertion about the autocomplete's matching/inserting behavior
    // regardless of what else is installed locally.
    await codeReviewRow.click();
    await expect(async () => {
      expect(await promptTextarea.inputValue()).toContain("/code-review ");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // Reopen the menu, then Escape it — regression guard for the
    // dialog.tsx `data-popover-open` fix: Escape must close the popover,
    // not the dialog underneath it. Trailing filler text (typed first, then
    // the caret is moved back before it) is deliberate: SlashAutocomplete's
    // own Escape handler exits the query slice by moving the caret to
    // `el.value.length` (the document's absolute end) — a no-op when the
    // `/query` is already sitting at that exact position, which it would be
    // if we typed it with nothing after it. With real trailing content, the
    // same handler genuinely exits the slice, so this exercises the popover
    // actually closing (not just the dialog surviving the keypress).
    await page.keyboard.type(" x");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("/co");
    await expect(slashMenu).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(slashMenu).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(issueTaskDialog).toBeVisible();

    // Extension picker: a project skill inserts as `/name`.
    const extTrigger = issueTaskDialog.getByTestId("extension-picker-trigger");
    const extPopover = issueTaskDialog.getByTestId("extension-picker-popover");
    const extSearch = issueTaskDialog.getByTestId("extension-picker-search");

    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await extSearch.fill("e2e-skill");
    const skillRow = extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-skill" });
    await expect(skillRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await skillRow.click();
    await expect(async () => {
      expect(await promptTextarea.inputValue()).toContain("/e2e-skill ");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // A project MCP server inserts as `@name`.
    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await extSearch.fill("e2e-mcp");
    const mcpRow = extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-mcp" });
    await expect(mcpRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await mcpRow.click();
    await expect(async () => {
      expect(await promptTextarea.inputValue()).toContain("@e2e-mcp ");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // Reopen once more with nothing selected, then Escape it — same
    // regression guard as the slash menu above, for the second popover kind.
    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(extPopover).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(issueTaskDialog).toBeVisible();

    // Files/Folders references picker renders (its native open-panel isn't
    // e2e-drivable — only presence is asserted).
    await expect(issueTaskDialog.getByText("Files / Folders")).toBeVisible();

    // No task should be created by this test — just close the dialog.
    await issueTaskDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  });

  test("label-inferred type: the issue's bug label seeds Bug + fix/ branch prefix", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const typePicker = issueTaskDialog.getByTestId("task-type-picker");
    const taskButton = typePicker.getByRole("button", { name: "Task", exact: true });
    const bugButton = typePicker.getByRole("button", { name: "Bug", exact: true });
    const spikeButton = typePicker.getByRole("button", { name: "Spike", exact: true });

    // Seeded from the fixture issue's "bug" label (inferTaskTypeFromLabels,
    // src/shared/issue-task.ts) once the thread loads — Bug renders with the
    // `default` Button variant (`bg-primary` in its class list, per
    // TaskTypePicker.tsx), Task/Spike stay on the `outline` variant, which
    // never emits `bg-primary`.
    await expect(bugButton).toHaveClass(/bg-primary/, { timeout: CONVERGE_TIMEOUT });
    await expect(taskButton).not.toHaveClass(/bg-primary/);
    await expect(spikeButton).not.toHaveClass(/bg-primary/);

    const worktreeOptions = issueTaskDialog.getByTestId("worktree-options");
    const branchNameInput = worktreeOptions.getByTestId("branch-name-input");
    await expect(branchNameInput).toBeVisible();
    await expect(async () => {
      expect(await branchNameInput.inputValue()).toMatch(/^fix\//);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // Picking Spike swaps both the selected button and the derived prefix
    // (DEFAULT_BRANCH_CONFIG.rules.spike.prefix === "spike/").
    await spikeButton.click();
    await expect(spikeButton).toHaveClass(/bg-primary/);
    await expect(bugButton).not.toHaveClass(/bg-primary/);
    await expect(async () => {
      expect(await branchNameInput.inputValue()).toMatch(/^spike\//);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // Picking Bug back swaps them again (fix/ per DEFAULT_BRANCH_CONFIG).
    await bugButton.click();
    await expect(bugButton).toHaveClass(/bg-primary/);
    await expect(spikeButton).not.toHaveClass(/bg-primary/);
    await expect(async () => {
      expect(await branchNameInput.inputValue()).toMatch(/^fix\//);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitCreatedTask(request, backend, CARD_TITLE);

    expect(task.taskType).toBe("bug");
    expect(task.isolation).toBe("worktree");
    expect(task.branch).toMatch(/^fix\//);

    await deleteTask(request, backend, task.id);
    createdTaskIds.splice(createdTaskIds.indexOf(task.id), 1);
  });

  test("references picker: Files/Folder picks + drag-drop attach, remove leaves the rest", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);

    // Plant two regular files for the fake-picker seam
    // (AGETOR_FAKE_PICK_REFS_DIR, see server.ts's POST /refs/pick) to return.
    await writeFile(path.join(backend.fakePickDir, "notes.md"), "notes\n");
    await writeFile(path.join(backend.fakePickDir, "spec.txt"), "spec\n");

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // Expand the (initially collapsed, since references start empty) refs
    // section before poking at its buttons/dropzone.
    const summary = issueTaskDialog.getByTestId("refs-summary");
    await summary.click();

    const dropzone = issueTaskDialog.getByTestId("refs-dropzone");
    const chips = issueTaskDialog.getByTestId("refs-chip");

    // "files" mode lists fakePickDir's regular files — notes.md + spec.txt.
    await issueTaskDialog.getByTestId("refs-pick-files").click();
    await expect(chips).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });
    await expect(dropzone.getByText("notes.md", { exact: true })).toBeVisible();
    await expect(dropzone.getByText("spec.txt", { exact: true })).toBeVisible();

    // "folder" mode returns fakePickDir itself (isDirectory: true, rendered
    // with a trailing "/").
    await issueTaskDialog.getByTestId("refs-pick-folder").click();
    await expect(chips).toHaveCount(3, { timeout: CONVERGE_TIMEOUT });
    const fakeDirBasename = path.basename(backend.fakePickDir);
    await expect(dropzone.getByText(`${fakeDirBasename}/`, { exact: true })).toBeVisible();

    // Drag-drop a real, non-transient file (README.md from this repo
    // checkout — isTransientPath would reject anything under /tmp or
    // /var/folders) as a text/uri-list `file://` line, exactly what WebKit
    // puts on a Finder drag. Built in page context since a DataTransfer
    // can't cross the Node/browser boundary any other way.
    const readmePath = path.join(REPO_ROOT, "README.md");
    const dt = await page.evaluateHandle((fileUrl) => {
      const d = new DataTransfer();
      d.setData("text/uri-list", fileUrl);
      return d;
    }, "file://" + encodeURI(readmePath));
    await dropzone.dispatchEvent("dragover", { dataTransfer: dt });
    await dropzone.dispatchEvent("drop", { dataTransfer: dt });

    await expect(chips).toHaveCount(4, { timeout: CONVERGE_TIMEOUT });
    await expect(dropzone.getByText("README.md", { exact: true })).toBeVisible();

    // Remove spec.txt's chip — three remain: notes.md, the folder, README.md.
    const specChip = chips.filter({ hasText: "spec.txt" });
    await specChip.getByTestId("refs-remove").click();
    await expect(chips).toHaveCount(3, { timeout: CONVERGE_TIMEOUT });
    await expect(dropzone.getByText("spec.txt", { exact: true })).toBeHidden();

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitCreatedTask(request, backend, CARD_TITLE);

    const paths = task.references.map((r) => r.path);
    expect(paths).toContain(path.join(backend.fakePickDir, "notes.md"));
    expect(paths).toContain(backend.fakePickDir);
    expect(paths).toContain(readmePath);
    expect(paths).not.toContain(path.join(backend.fakePickDir, "spec.txt"));

    // Plus the issue-snapshot reference every created issue task carries —
    // exactly four references total, nothing extra.
    const snapshotRef = task.references.find((r) => r.path.endsWith(`issue-${ISSUE_NUMBER}-thread.md`));
    expect(snapshotRef, `references: ${JSON.stringify(task.references)}`).toBeTruthy();
    expect(task.references.length).toBe(4);

    await deleteTask(request, backend, task.id);
    createdTaskIds.splice(createdTaskIds.indexOf(task.id), 1);
  });
});
