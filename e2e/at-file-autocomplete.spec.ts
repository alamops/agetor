import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for the `@` file-reference feature (docs/plans/at-file-
 * references.md §1, §3.3-§3.5, §5 TT1): the `AtFileAutocomplete` popover, the
 * `AtHighlightBackdrop` in-field highlight, and server-side expansion of
 * `@token`s into absolute paths at send/start time — across the New Task
 * form, the RunPanel send dock, and the "Work on this with Agetor" issue
 * dialog. Drives Chromium against the real webview + real Bun API/
 * orchestrator (a per-worker instance from `e2e/fixtures.ts`'s `backend`
 * fixture) with the fake claude-code driver (`AGETOR_CLAUDE_DRIVER=fake`,
 * wired by the fixture) standing in for tmux + the real CLI.
 *
 * One throwaway git repo (`initRepo`, mirrors `e2e/issue-task.spec.ts`'s
 * recipe) with `README.md`, `src/app.ts`, `docs/my notes.md` committed, plus
 * an untracked `scratch.txt` — registered as a project via the real
 * `POST /projects`. A tmp-dir repo is fine here: `isTransientPath` only
 * filters `/tmp`/`/var/folders` for drag/drop refs, not for `@` listings.
 * `test.describe.configure({ mode: "serial" })` because the last two
 * scenarios share one created task (set via module-level `startedTaskId`/
 * `startedTaskTitle`) and every scenario shares the one registered project.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 15_000;

const REPO_ORG_SLUG = "atref-org/atref-repo";
const REPO_PATH = `/repos/${REPO_ORG_SLUG}`;
const ISSUE_NUMBER = 42;
const ISSUE_TITLE = "at-ref e2e fixture issue";
const ISSUE_HTML_URL = `https://github.com/${REPO_ORG_SLUG}/issues/${ISSUE_NUMBER}`;

let projectDir: string;
let stub: GitHubStub;
const createdTaskIds: string[] = [];
// Set by the "start" scenario, consumed by the RunPanel-composer scenario
// right after it (serial mode guarantees the ordering).
let startedTaskId = "";
let startedTaskTitle = "";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** Temp git repo with committed README.md/src/app.ts/"docs/my notes.md" (the
 *  file with a space in its name exercises the quoted-token form) plus an
 *  untracked scratch.txt and a gitignored-but-present ignored.log
 *  (exercises the live-vs-ref listing-scope split and the unresolved-warning stat rescue —
 *  see §3.3: isolated tasks list tracked files at the pinned base ref via
 *  `git ls-tree`, live/uniisolated tasks list `git ls-files` including
 *  untracked-not-ignored files). A GitHub `origin` remote is wired so the
 *  issue-dialog scenario's "Work on this with Agetor" flow resolves a
 *  provider/repo for this project. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-at-refs-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", `https://github.com/${REPO_ORG_SLUG}.git`]);

  await writeFile(path.join(dir, "README.md"), "e2e at-file-references fixture repo\n");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "app.ts"), "export {};\n");
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "my notes.md"), "notes with a space in the filename\n");
  // Committed ignore rule for the unresolved-warning test: `ignored.log`
  // exists on disk but is absent from every listing mode.
  await writeFile(path.join(dir, ".gitignore"), "ignored.log\n");

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);

  // Deliberately never `git add`-ed — only the live (non-ref) listing mode
  // should ever surface this.
  await writeFile(path.join(dir, "scratch.txt"), "untracked scratch file\n");
  await writeFile(path.join(dir, "ignored.log"), "gitignored but present on disk\n");

  return dir;
}

/** Registers `dir` as a project via the plain global `fetch` (not
 *  Playwright's `request` fixture, unavailable in `beforeAll`) — mirrors
 *  `e2e/issue-task.spec.ts`'s `registerProject`. */
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

function issuePayload() {
  return {
    number: ISSUE_NUMBER,
    title: ISSUE_TITLE,
    state: "open",
    html_url: ISSUE_HTML_URL,
    user: { login: "e2e-reporter", avatar_url: null, html_url: null },
    assignees: [] as unknown[],
    milestone: null,
    body: "Fixture issue for the @ file-reference e2e spec.",
    labels: [] as unknown[],
    comments: 0,
    created_at: "2026-08-10T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
    closed_at: null,
    locked: false,
    draft: false,
  };
}

/** Routes needed just to render the issue detail page + open the dialog —
 *  a trimmed-down copy of `e2e/issue-task.spec.ts`'s `auxiliaryRoutes`,
 *  scoped to this file's own repo/issue. */
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
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}/comments$`), body: [] },
    ...auxiliaryRoutes(),
  ];
}

// ---- Locator helpers ------------------------------------------------------

/** The New Task sidebar — always the first `<aside>` in DOM order (RunPanel,
 *  when mounted, comes after it). Mirrors `e2e/quote.spec.ts` /
 *  `e2e/task-context-menu.spec.ts`'s identical convention. */
function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

/** The run panel's slide-over `<aside>` — the later one in DOM order once a
 *  task has been opened. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function promptTextarea(scope: Locator): Locator {
  return scope.getByTestId("prompt-textarea");
}

function atPopover(scope: Locator): Locator {
  return scope.getByTestId("at-file-autocomplete");
}

/** A specific popover row by its exact listed path (`data-path`) — never
 *  "the first match", per the design brief's own caution about fuzzy
 *  ranking assumptions. */
function atRow(scope: Locator, filePath: string): Locator {
  return scope.locator(`[data-testid="at-file-autocomplete-row"][data-path="${filePath}"]`);
}

function highlightMarks(scope: Locator): Locator {
  return scope.getByTestId("at-highlight-mark");
}

function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

// ---- Task API helpers -------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  worktreePath: string | null;
  column: string;
}

async function findTaskByTitle(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as TaskRow[];
  return rows.find((r) => r.title === title) ?? null;
}

/** Polls `GET /tasks` until a task with `title` shows up, registers it for
 *  cleanup, and returns it. */
async function awaitCreatedTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  createdTaskIds.push(task!.id);
  return task!;
}

async function getTaskById(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  if (!res.ok()) return null;
  return (await res.json()) as TaskRow;
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  stub = await startGitHubStub(backend.githubStubPort, issueRoutes());
});

test.afterAll(async ({ backend }) => {
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${backend.apiToken}` },
    }).catch(() => { /* best-effort cleanup */ });
  }
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("@ file references", () => {
  test("New Task form: @REA popover lists README.md; Enter commits it and highlights it", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("see @REA");

    const row = atRow(form, "README.md");
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await page.keyboard.press("Enter");

    await expect(textarea).toHaveValue("see @README.md ");
    await expect(atPopover(form)).toBeHidden();
    await expect(highlightMarks(form)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
  });

  test("Tab descends into a directory row; Enter commits the narrowed child file", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("@sr");

    const srcRow = atRow(form, "src/");
    await expect(srcRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    // Make the src/ row the active one before Tab (Tab acts on whichever row
    // is currently highlighted) — hover sets `active` via onMouseEnter,
    // deterministic regardless of fuzzy-ranking assumptions.
    await srcRow.hover();
    await page.keyboard.press("Tab");

    await expect(textarea).toHaveValue("@src/");
    await expect(atPopover(form)).toBeVisible();

    const appRow = atRow(form, "src/app.ts");
    await expect(appRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await page.keyboard.press("Enter");
    await expect(textarea).toHaveValue("@src/app.ts ");
  });

  test("Quoted form: picking a file whose name has a space auto-quotes the token", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    // Bare-form active queries can never contain whitespace (findActiveAtQuery
    // rejects it — a real "@token" can't span a space) so we narrow with the
    // whitespace-free prefix "my", which uniquely matches "docs/my notes.md"
    // among this repo's fixture files, then commit it — the row's commit
    // handler is `onMouseDown` (so the textarea never loses focus), which
    // `.click()`'s own mousedown-then-mouseup sequence already satisfies
    // (same pattern proven by e2e/issue-task.spec.ts's SlashAutocomplete row
    // click, an identical onMouseDown row).
    await page.keyboard.type("@my");

    const row = atRow(form, "docs/my notes.md");
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();

    await expect(textarea).toHaveValue('@"docs/my notes.md" ');
    await expect(highlightMarks(form)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
  });

  test("Highlighting: only @ tokens that resolve to a real file get a mark", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();

    await textarea.fill("@README.md @nope.md @github");
    // `.fill()` sets the value programmatically without firing the native
    // keyup AtFileAutocomplete's caret-sync listener relies on — a keyup
    // (unrelated to the caret itself here) is harmless, but dispatching one
    // matches the intended "sync after a programmatic fill" idiom.
    await textarea.dispatchEvent("keyup");

    await expect(highlightMarks(form)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(highlightMarks(form)).toHaveText("@README.md");

    await textarea.fill("@nope.md");
    await textarea.dispatchEvent("keyup");
    await expect(highlightMarks(form)).toHaveCount(0);
  });

  test("Escape closes only the @ popover, leaving the New Task form open", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("@RE");

    await expect(atPopover(form)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");

    await expect(atPopover(form)).toBeHidden();
    await expect(textarea).toHaveValue("@RE");
    await expect(form).toBeVisible();
  });

  test("Isolate scope: untracked scratch.txt is listed only in the live (non-isolated) scope", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();

    // Warm-up: prove the listing has loaded via a query that matches
    // regardless of isolation mode, so the negative assertion below can't be
    // a false pass from "listing not loaded yet".
    await page.keyboard.type("@REA");
    await expect(atRow(form, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await textarea.fill("");
    await page.keyboard.type("@scr");
    // Isolate is ON by default — the scope lists tracked files at the pinned
    // base ref (`git ls-tree`), which never includes an untracked file.
    await expect(atRow(form, "scratch.txt")).toHaveCount(0);

    const worktreeOptions = form.getByTestId("worktree-options");
    const isolateToggle = worktreeOptions.getByTestId("isolate-toggle");
    await expect(isolateToggle).toBeChecked();
    await isolateToggle.uncheck();

    // Scope flips to the live tree (`git ls-files`, untracked-not-ignored
    // included) — same typed query, no need to retype it.
    await expect(atRow(form, "scratch.txt")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("Unresolved @ references warn under the composer; gitignored-but-present files don't (live scope)", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    const warning = form.getByTestId("at-unresolved-warning");
    await textarea.click();

    // Warm-up: the warning is suppressed until the listing has loaded, so
    // first prove it's live (same trick as the isolate-scope test).
    await page.keyboard.type("@REA");
    await expect(atRow(form, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // Ref scope (Isolate ON default): a typo'd token warns straight off the
    // listing verdict; the resolvable token isn't named in the warning.
    await textarea.fill("see @nope.md and @README.md");
    await expect(warning).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(warning).toContainText("@nope.md");
    await expect(warning).not.toContainText("@README.md");

    // Fixing the token clears the warning.
    await textarea.fill("see @README.md");
    await expect(warning).toBeHidden();

    // Live scope (Isolate OFF): a gitignored file is absent from the listing
    // but exists on disk — the debounced /refs/resolve stat check rescues it
    // (send-time expansion WILL resolve it). The warning may flash while the
    // stat is in flight; toBeHidden polls until it settles.
    const worktreeOptions = form.getByTestId("worktree-options");
    await worktreeOptions.getByTestId("isolate-toggle").uncheck();
    await textarea.fill("read @ignored.log");
    await expect(warning).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    // A live-scope typo still warns — the stat check finds nothing to rescue.
    await textarea.fill("read @nope.md");
    await expect(warning).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("Start: @README.md expands to the worktree's absolute path; task.prompt keeps the token", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);

    const title = "at-ref start task";
    await form.getByPlaceholder("Short description").fill(title);

    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("look at @README.md");

    // Isolate stays ON (default) — "Run task" creates + starts in one step.
    const runButton = form.getByRole("button", { name: "Run task", exact: true });
    await expect(runButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await runButton.click();

    const task = await awaitCreatedTask(request, backend, title);
    startedTaskId = task.id;
    startedTaskTitle = title;

    expect(task.prompt).toBe("look at @README.md");

    await expect(async () => {
      const t = await getTaskById(request, backend, task.id);
      expect(t?.worktreePath).toBeTruthy();
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    await expect(taskCard(page, title)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await taskCard(page, title).click();

    const panel = runPanel(page);
    await expect(panel.locator("textarea").first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const expectedPath = `${backend.dataDir}/worktrees/${task.id}/README.md`;
    // Both the echoed launch prompt ("user" event) and the fake driver's own
    // "fake response to: <prompt>" stdout echo carry the expanded path —
    // `.first()` avoids a strict-mode violation from the double match.
    await expect(page.getByText(expectedPath).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("RunPanel composer: a follow-up @ reference expands to the worktree's absolute path", async ({ page, backend }) => {
    test.setTimeout(60_000);
    expect(startedTaskId, "the prior 'Start' scenario must have run first").toBeTruthy();

    await gotoApp(page, backend.bootBase);
    await taskCard(page, startedTaskTitle).click();

    const panel = runPanel(page);
    const textarea = panel.getByTestId("send-textarea");
    await expect(textarea).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await textarea.click();
    await page.keyboard.type("and @src/a");

    const popover = atPopover(panel);
    await expect(popover).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // First Enter commits the (sole) match, src/app.ts.
    await page.keyboard.press("Enter");
    await expect(textarea).toHaveValue("and @src/app.ts ");
    await expect(popover).toBeHidden();

    // Second Enter now reaches RunPanel's own Enter-to-send handler.
    await page.keyboard.press("Enter");

    const expectedPath = `${backend.dataDir}/worktrees/${startedTaskId}/src/app.ts`;
    await expect(page.getByText(expectedPath).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // Display-only shortening: the user bubble folds the expanded absolute
    // path back to the typed mention, while the stdout echo above keeps the
    // absolute path (what the agent actually received).
    await expect(panel.getByText("and @src/app.ts").first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("Run-settle refresh: a file created after the listing loaded appears without blur/refocus", async ({ page, backend }) => {
    test.setTimeout(60_000);
    expect(startedTaskId, "the prior 'Start' scenario must have run first").toBeTruthy();

    await gotoApp(page, backend.bootBase);
    await taskCard(page, startedTaskTitle).click();
    const panel = runPanel(page);
    const textarea = panel.getByTestId("send-textarea");
    await expect(textarea).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // Load the listing (focus-refetch) and prove it's live BEFORE the new
    // file exists.
    await textarea.click();
    await page.keyboard.type("@REA");
    await expect(atRow(panel, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await textarea.fill("");

    // "The agent creates a file mid-session" — the fake driver writes no
    // files, so the test does: on disk, but absent from the listing above.
    await writeFile(
      path.join(backend.dataDir, "worktrees", startedTaskId!, "fresh-file.ts"),
      "export const fresh = true;\n",
    );

    // Focus never left the textarea → no focus-refetch → the popover must
    // not know the file yet.
    await page.keyboard.type("@fres");
    await expect(atPopover(panel)).toBeHidden();

    // A column transition (here via the API; in real life the run settling)
    // is the refresh trigger: the still-open query re-ranks against the
    // fresh listing with no blur/refocus anywhere.
    const patch = await fetch(`${backend.apiBase}/tasks/${startedTaskId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ column: "ready" }),
    });
    expect(patch.ok).toBe(true);
    await expect(atRow(panel, "fresh-file.ts")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("Backlog tray inline editor: @ popover + highlight parity", async ({ page, backend }) => {
    test.setTimeout(60_000);
    expect(startedTaskId, "the prior 'Start' scenario must have run first").toBeTruthy();

    // Seed a draft via the API, then edit it in the tray.
    const seeded = await fetch(`${backend.apiBase}/tasks/${startedTaskId}/backlog`, {
      method: "POST",
      headers: { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "note to self" }),
    });
    expect(seeded.ok).toBe(true);

    await gotoApp(page, backend.bootBase);
    await taskCard(page, startedTaskTitle).click();
    const panel = runPanel(page);
    await panel.getByTitle("Edit").first().click();

    // Put the caret at the end of the seeded text deterministically (autoFocus
    // caret position is engine-dependent), then type an @ query.
    const editor = panel.locator('textarea:not([data-testid="send-textarea"])');
    await expect(editor).toBeVisible();
    await editor.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    });
    await page.keyboard.type(" @REA");
    await expect(atRow(panel, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Enter");

    // Committed into the editor draft (not saved, not sent) and highlighted —
    // the send box is empty, so the panel's one mark belongs to the editor.
    await expect(editor).toHaveValue("note to self @README.md ");
    await expect(highlightMarks(panel)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await panel.getByRole("button", { name: "Cancel" }).click();
  });

  test("DiffDialog composer: @ popover + highlight parity; a popover Enter never sends", async ({ page, backend }) => {
    test.setTimeout(60_000);
    expect(startedTaskId, "the prior 'Start' scenario must have run first").toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, startedTaskTitle);
    await expect(card).toBeVisible();
    await card.getByTitle("View changes (git diff)").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // `fresh-file.ts` was written into the worktree by the run-settle
    // scenario — it shows as an added (untracked) line; selecting it reveals
    // the compose-from-diff box.
    await dialog.getByText("export const fresh = true;").first().click();
    const composer = dialog.getByPlaceholder("Add a message about the selected lines… (optional)");
    await expect(composer).toBeVisible();

    await composer.click();
    await page.keyboard.type("@REA");
    await expect(atRow(dialog, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Enter");

    // The popover's Enter commits the suggestion; the composer's own
    // Enter-to-send must NOT also fire (`e.defaultPrevented` guard) — the
    // draft is intact, highlighted, and the dialog is still open.
    await expect(composer).toHaveValue("@README.md ");
    await expect(dialog.getByTestId("at-highlight-mark")).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(dialog).toBeVisible();
  });

  test("Issue dialog: @REA popover works inside it; Escape leaves the dialog open", async ({ page, backend }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);

    await page.getByRole("button", { name: "Git", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const projectSelect = dialog.getByRole("combobox", { name: "Project" });
    await expect(projectSelect).toBeVisible();
    if ((await projectSelect.inputValue()) !== projectDir) {
      await projectSelect.selectOption({ value: projectDir });
    }
    await dialog.getByRole("button", { name: "Issues", exact: true }).click();

    const row = dialog.getByRole("button", { name: `#${ISSUE_NUMBER} ${ISSUE_TITLE}` });
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();

    await expect(dialog.getByText(ISSUE_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const workButton = dialog.getByTestId("issue-work-with-agetor");
    await expect(workButton).toBeVisible();
    await workButton.click();

    const issueTaskDialog = page.getByTestId("issue-task-dialog");
    await expect(issueTaskDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const textarea = issueTaskDialog.getByTestId("prompt-textarea");
    await expect(textarea).toBeVisible();
    await textarea.click();
    // Caret to the very end (the field is pre-seeded with the issue's
    // rendered thread text), then a leading "\n" so "@" satisfies the
    // BOF-or-whitespace trigger guard.
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await page.keyboard.type("\n@REA");

    await expect(atRow(issueTaskDialog, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await page.keyboard.press("Escape");
    await expect(atPopover(issueTaskDialog)).toBeHidden();
    await expect(issueTaskDialog).toBeVisible();

    await issueTaskDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  });
});
