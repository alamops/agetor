import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type StubRequest } from "./github-stub";
import { uniqueRepoSlugs } from "../src/shared/multi-repo.ts";

/**
 * E2E coverage for multi-repository tasks (issue #291).
 *
 * Arrange: two throwaway git repos, registered through the real
 * `POST /projects`. The FIRST scenario creates the multi-repository task
 * through the real New Task form and its `Repositories` dialog (select the
 * second repository, pin its base ref, save), then "Run task" starts it — so
 * `RepositoriesDialog`'s multi-select, per-repository base ref and the
 * create payload are exercised end to end, not just through `POST /tasks`.
 * The worker backend already runs the fake claude driver, so the start
 * materializes one worktree per repository without a real CLI.
 *
 * Scenarios:
 *  1. create via the real UI + start: both worktrees exist, the card shows
 *     the repository count, and the task row carries both entries.
 *  2. the diff dialog offers one tab per repository and switching tabs loads
 *     that repository's own changes.
 *  3. the "Commit & push" chip appears when only a sibling repository changed
 *     (the prompt is aggregate, not selected-tab-scoped).
 *  4. the terminal section defaults to the workspace root and follows the
 *     run-panel repository tab (issue #291 review M2).
 *  5. the selected repository tab resets on a task switch.
 *  6. archive detaches every clean repository worktree (keeping the branches)
 *     and unarchive restores them.
 *  7. a later archive that finds one repository dirty leaves just that
 *     checkout and the workspace in place.
 *  8. text search and the repo filter match any selected repository (never
 *     the non-git workspace root alone).
 *  9. the Worktrees page lists one row per repository, not the workspace root.
 * 10. Create all PRs opens one PR per repository, stamps each entry, and adds
 *     `Closes #N` only to the issue's repository.
 * 11. Create all PRs is per-repository best effort: one repository's failure
 *     does not block the others, and a reloaded retry opens only the failed
 *     one.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 30_000;
const TITLE = "Multi repository e2e";

let repoA: string;
let repoB: string;
let repoSibling: string;
let repoBHead: string;
let taskId: string;
let singleTaskId: string;

interface TaskRepositoryRow {
  path: string;
  name: string;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  workdir: string;
  worktreePath: string | null;
  repositories: TaskRepositoryRow[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/** Remotes are shared by every worktree of one source repo, so a later
 *  scenario re-points the throwaway `local` remote instead of adding it. */
function setLocalRemote(cwd: string, url: string): void {
  try {
    git(cwd, ["remote", "set-url", "local", url]);
  } catch {
    git(cwd, ["remote", "add", "local", url]);
  }
}

async function initRepo(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `agetor-e2e-multi-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), `${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
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

async function awaitTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return task!;
}

/**
 * Create a multi-repository task through the real API, start it, push each
 * worktree branch to a throwaway local bare remote (so the run panel's
 * git-status poll reports `remoteSynced`), and return the row. Used by the
 * Create-all-PRs scenarios; the GitHub-shaped `origin` comes from beforeAll.
 */
async function createPushedMultiTask(
  request: APIRequestContext,
  backend: E2EBackend,
  opts: { title: string; issueUrl?: string },
): Promise<{ taskId: string; task: TaskRow; bareDirs: string[] }> {
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const bareA = await mkdtemp(path.join(tmpdir(), "agetor-e2e-bare-a-"));
  const bareB = await mkdtemp(path.join(tmpdir(), "agetor-e2e-bare-b-"));
  git(bareA, ["init", "-q", "--bare"]);
  git(bareB, ["init", "-q", "--bare"]);
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title: opts.title,
      prompt: "p",
      agent: "claude-code",
      isolation: "worktree",
      repositories: [{ path: repoA }, { path: repoB }],
      ...(opts.issueUrl ? { issueUrl: opts.issueUrl } : {}),
    },
  });
  expect(created.ok()).toBe(true);
  const taskId = ((await created.json()) as TaskRow).id;
  const started = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: auth });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
      const row = (await res.json()) as TaskRow;
      return row.repositories.every((repo) => !!repo.worktreePath);
    }, { timeout: CONVERGE_TIMEOUT })
    .toBe(true);
  const detail = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
  const task = (await detail.json()) as TaskRow;
  for (const repo of task.repositories) {
    const bare = repo.path === repoA ? bareA : bareB;
    setLocalRemote(repo.worktreePath!, bare);
    git(repo.worktreePath!, ["push", "-q", "-u", "local", repo.branch!]);
  }
  // The Create-all-PRs chip is gated on the 5 s git-status poll reporting a
  // synced upstream; wait on the same API the poll reads.
  await expect
    .poll(async () => {
      const status = await request.get(`${backend.apiBase}/tasks/${taskId}/git-status`, { headers: auth });
      const body = (await status.json()) as { repositories?: Array<{ remoteSynced: boolean }> };
      return body.repositories?.every((r) => r.remoteSynced) ?? false;
    }, { timeout: CONVERGE_TIMEOUT })
    .toBe(true);
  return { taskId, task, bareDirs: [bareA, bareB] };
}

test.beforeAll(async ({ backend, request }) => {
  repoA = await initRepo("frontend");
  repoB = await initRepo("backend");
  // A registered path under repoA's git root. Selecting it alongside repoA in
  // the dialog must collapse to one repository (dedupeSelections), which the
  // first scenario asserts by still creating a two-repository task.
  repoSibling = path.join(repoA, "packages", "feature");
  await mkdir(repoSibling, { recursive: true });
  repoBHead = git(repoB, ["rev-parse", "HEAD"]);
  // GitHub-shaped origins for the issue-sourced / Create-all-PRs scenario.
  // Pushing uses a separate local bare remote, so nothing leaves the machine
  // while `repoForDir`/`providerRepoForDir` still resolve a GitHub identity.
  git(repoA, ["remote", "add", "origin", "https://github.com/agetor-e2e/frontend.git"]);
  git(repoB, ["remote", "add", "origin", "https://github.com/agetor-e2e/backend.git"]);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  for (const p of [repoA, repoB, repoSibling]) {
    await request.post(`${backend.apiBase}/projects`, { headers: auth, data: { path: p } });
  }

  // A second, single-repository task gives the per-task reset test something
  // to switch to and back from without changing the multi row under test.
  const single = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title: "Single repository e2e",
      prompt: "make the change",
      agent: "claude-code",
      workdir: repoA,
      isolation: "worktree",
    },
  });
  expect(single.ok()).toBe(true);
  singleTaskId = ((await single.json()) as { id: string }).id;
});

test.afterAll(async ({ backend, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  for (const id of [taskId, singleTaskId]) {
    if (id) {
      await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth }).catch(() => {});
    }
  }
  for (const dir of [repoA, repoB]) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("create via the real UI: the Repositories dialog sends both repos and start materializes both worktrees", async ({ backend, page, request }) => {
  await gotoApp(page, backend.bootBase);
  const form = page.locator("aside").first();

  await form.getByPlaceholder("Short description").fill(TITLE);
  await form.getByTestId("prompt-textarea").fill("make the change");

  // Pin the form's single project first (the worker backend is shared across
  // spec files, so `autoSelectFirst` is not a stable choice). Wait for that
  // one-shot auto-selection to land before overriding it — otherwise it can
  // fire after this pick and swap the project back. Then add the second
  // repository through the dialog. This is the `RepositoriesDialog` path the
  // plan's T16 names — multi-select, per-repository base ref, dedupe, save.
  const projectTrigger = form.getByTitle(/Pick the working directory/);
  await expect(projectTrigger).not.toContainText("Select project", { timeout: CONVERGE_TIMEOUT });
  await projectTrigger.click();
  await form.getByText(repoA, { exact: true }).click();
  await expect(projectTrigger).toContainText(path.basename(repoA));

  await form.getByRole("button", { name: "Use multiple repositories…" }).click();
  const reposDialog = page.getByRole("dialog", { name: "Repositories" });
  await expect(reposDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(reposDialog.getByLabel(`Select ${repoA}`, { exact: true })).toBeChecked();
  // A single-repository selection keeps the inline Branch field's base ref:
  // no per-repository input may be offered, or whatever the user typed there
  // was silently discarded at create time (review round six).
  await expect(reposDialog.getByLabel(`Base ref for ${repoA}`, { exact: true })).toHaveCount(0);
  await reposDialog.getByLabel(`Select ${repoB}`, { exact: true }).check();
  await expect(reposDialog.getByLabel(`Base ref for ${repoA}`, { exact: true })).toBeVisible();
  await reposDialog.getByLabel(`Base ref for ${repoB}`, { exact: true }).fill("main");
  // A same-git-root sibling is selectable but must dedupe away on save.
  await reposDialog.getByLabel(`Select ${repoSibling}`, { exact: true }).check();
  await reposDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(reposDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  await expect(form.getByTestId("new-task-repositories")).toContainText("2 repositories");

  const runButton = form.getByRole("button", { name: "Run task", exact: true });
  await expect(runButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await runButton.click();

  const created = await awaitTask(request, backend, TITLE);
  taskId = created.id;
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories[1]!.baseRef).toBe(repoBHead);

  await expect
    .poll(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${backend.apiToken}` },
      });
      const t = (await res.json()) as TaskRow;
      return t.repositories?.every((r) => !!r.worktreePath) ?? false;
    }, { timeout: CONVERGE_TIMEOUT })
    .toBe(true);

  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  const task = (await res.json()) as TaskRow;
  expect(task.worktreePath).toBe(task.workdir);
  const names = uniqueRepoSlugs([repoA, repoB]);
  for (const name of names) {
    expect(existsSync(path.join(task.worktreePath!, name))).toBe(true);
  }

  await expect(page.getByTestId("task-card-repositories").first()).toContainText("2 repositories", {
    timeout: CONVERGE_TIMEOUT,
  });
});

test("text search and the repo filter match any selected repository", async ({ backend, page }) => {
  // Spec: "Repo filter and text search match any selected repo." A multi
  // task's workdir is its non-git workspace root, so matching only that (the
  // pre-#291 behavior) would hide the card for every repository name.
  await gotoApp(page, backend.bootBase);
  const search = page.getByLabel("Search tasks");
  const secondName = path.basename(repoB);

  // Text search: the second repository's basename appears in title/prompt/
  // workdir nowhere, only in `repositories[]`.
  await search.fill(secondName);
  await expect(page.getByText("Multi repository e2e", { exact: true }).first()).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  await expect(page.getByText("Single repository e2e", { exact: true })).toHaveCount(0);
  await search.fill("no-such-repository-xyz");
  await expect(page.getByText("Multi repository e2e", { exact: true })).toHaveCount(0);
  await search.fill("");

  // Repo filter: selecting the second repository keeps the multi card and
  // hides the single-repo one; a registered project the task never selected
  // hides it.
  await page.getByRole("button", { name: "All repos", exact: true }).click();
  await page.getByText(repoB, { exact: true }).click();
  await expect(page.getByText("Multi repository e2e", { exact: true }).first()).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  await expect(page.getByText("Single repository e2e", { exact: true })).toHaveCount(0);

  // The popover stays open across toggles: deselect the second repository and
  // select a registered project the task never picked (a sibling directory of
  // repoA — the filter matches selected paths, not git roots).
  await page.getByText(repoB, { exact: true }).click();
  await page.getByText(repoSibling, { exact: true }).click();
  await expect(page.getByText("Multi repository e2e", { exact: true })).toHaveCount(0);
});

test("the diff dialog has one tab per repository and loads each repository's changes", async ({ backend, page, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
  const task = (await res.json()) as {
    worktreePath: string;
    repositories: { name: string; worktreePath: string }[];
  };
  const [first, second] = task.repositories;
  expect(first && second).toBeTruthy();
  await writeFile(path.join(first!.worktreePath, "front.txt"), "front\n");
  await writeFile(path.join(second!.worktreePath, "back.txt"), "back\n");

  await gotoApp(page, backend.bootBase);
  await page.getByText("Multi repository e2e", { exact: true }).first().click();
  await page.getByRole("button", { name: "View diff" }).first().click();
  await expect(page.getByTestId(`diff-repo-tab-${first!.name}`)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(page.getByText("front.txt")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  // Compose-from-diff on a multi task must label the selection with the
  // repository's workspace prefix: the message is delivered to the agent at
  // the workspace root, where `src/a.ts` alone does not exist (review M2).
  const addRows = page.locator('[data-diff-path="front.txt"][data-diff-index]');
  await addRows.last().click();
  await expect(page.getByPlaceholder(/Add a message about the selected lines/)).toBeVisible();
  await page.getByRole("button", { name: "Save for later" }).click();
  await expect
    .poll(async () => {
      const detail = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
      const row = (await detail.json()) as { backlog?: { text: string }[] };
      return (row.backlog ?? []).map((item) => item.text).join("\n");
    }, { timeout: CONVERGE_TIMEOUT })
    .toContain(`${first!.name}/front.txt`);

  await page.getByTestId(`diff-repo-tab-${second!.name}`).click();
  await expect(page.getByText("back.txt")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
});

test("the commit & push chip is offered when only a sibling repository changed", async ({ backend, page, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
  const task = (await res.json()) as {
    repositories: { worktreePath: string }[];
  };
  // Test 2 wrote one file in each worktree; clear the first so the selected
  // (first) repository is clean and only its sibling has changes. Gating on
  // the selected tab alone would hide the chip; the aggregate prompt must
  // still offer it.
  await rm(path.join(task.repositories[0]!.worktreePath, "front.txt"), { force: true });

  await gotoApp(page, backend.bootBase);
  await page.getByText("Multi repository e2e", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Commit & push" })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
});

test("the Worktrees page lists one row per repository of a multi task, not the workspace root", async ({ backend, page }) => {
  // T13: `listWorktrees` emits `<taskId>__<slug>` rows (one per repository)
  // and skips the non-git workspace root; the dialog badges each row with its
  // repository name. A single workspace-root row here would mean nested ids
  // were never parsed or the root leaked into the listing.
  await gotoApp(page, backend.bootBase);
  await page.getByRole("button", { name: "Worktrees", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Worktrees" });
  await expect(dialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  for (const name of uniqueRepoSlugs([repoA, repoB])) {
    await expect(dialog.getByText(name, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  }
  // One row per repository, both attributed to the same task — not one row for
  // the task's workspace root.
  await expect(dialog.getByText("Multi repository e2e", { exact: true })).toHaveCount(2);
});

test("the terminal section defaults to the workspace and follows the repository tab", async ({ backend, page }) => {
  // Review M2 regression: TerminalView's repo state was never set, had no UI,
  // and always opened in repositories[0] instead of the documented workspace
  // root; the run panel's repository tab never reached it.
  await gotoApp(page, backend.bootBase);
  await page.getByText("Multi repository e2e", { exact: true }).first().click();
  const section = page.getByTestId("terminals-section");
  await section.locator("summary").click();
  const select = page.getByTestId("terminal-repo-select");
  await expect(select).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(select).toHaveValue("");
  await expect(select.locator("option").first()).toHaveText("Workspace");

  const name = uniqueRepoSlugs([repoA, repoB])[1]!;
  await page.getByTestId(`run-repo-tab-${name}`).click();
  await expect(select).toHaveValue(name);
});

test("the selected repository tab resets on a task switch (sibling of the allPrsBusy reset)", async ({ backend, page }) => {
  // Review S4 regression: `repoTab`/`allPrsBusy` are RunPanelBody-local state
  // and the panel is not remounted between tasks. Without the `[task.id]`
  // reset, task B opens on task A's tab (and could inherit A's in-flight
  // "Creating PRs…" flag). Selecting the second tab here then switching away
  // and back proves the selection is reset, not carried over.
  await gotoApp(page, backend.bootBase);
  const [firstName, secondName] = uniqueRepoSlugs([repoA, repoB]);
  await page.getByText("Multi repository e2e", { exact: true }).first().click();
  const firstTab = page.getByTestId(`run-repo-tab-${firstName}`);
  const secondTab = page.getByTestId(`run-repo-tab-${secondName}`);
  await expect(firstTab).toHaveAttribute("aria-selected", "true", { timeout: CONVERGE_TIMEOUT });

  await secondTab.click();
  await expect(secondTab).toHaveAttribute("aria-selected", "true");

  // Switch tasks WITHOUT closing the panel: dispatching the card's click
  // bypasses the panel's backdrop (which would normally intercept a board
  // click). This is the exact path the reset protects — RunPanelBody stays
  // mounted and receives a new `task` prop.
  await page.getByText("Single repository e2e", { exact: true }).first().dispatchEvent("click");
  await expect(secondTab).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  await page.getByText("Multi repository e2e", { exact: true }).first().dispatchEvent("click");

  await expect(firstTab).toHaveAttribute("aria-selected", "true", { timeout: CONVERGE_TIMEOUT });
  await expect(secondTab).toHaveAttribute("aria-selected", "false");
});

test("Create all PRs opens one PR per repository and adds Closes only to the issue repository", async ({
  backend,
  page,
  request,
}) => {
  // Spec requirement 4: each repository's PR URL stamps its own entry and only
  // the repository the issue came from prefills `Closes #N`. The whole walk is
  // exercised through the real button → /github/pull-create → GitHub stub, so
  // a per-repo loop that used the wrong repo identity or always appended the
  // directive would fail here.
  test.setTimeout(90_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const pullBodies: Array<{ body?: string }> = [];
  const prTitle = "Multi repository PRs e2e";
  const stub = await startGitHubStub(backend.githubStubPort, [
    {
      method: "POST",
      path: /^\/repos\/agetor-e2e\/frontend\/pulls$/,
      body: (req: StubRequest) => {
        pullBodies.push(req.body as { body?: string });
        return { number: 11, title: "frontend PR", state: "open", html_url: "https://github.com/agetor-e2e/frontend/pull/11" };
      },
    },
    {
      method: "POST",
      path: /^\/repos\/agetor-e2e\/backend\/pulls$/,
      body: (req: StubRequest) => {
        pullBodies.push(req.body as { body?: string });
        return { number: 12, title: "backend PR", state: "open", html_url: "https://github.com/agetor-e2e/backend/pull/12" };
      },
    },
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const prepared = await createPushedMultiTask(request, backend, {
      title: prTitle,
      issueUrl: "https://github.com/agetor-e2e/frontend/issues/291",
    });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const task = prepared.task;

    await gotoApp(page, backend.bootBase);
    await page.getByText(prTitle, { exact: true }).first().click();
    const button = page.getByTestId("create-all-prs");
    await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await button.click();

    await expect.poll(() => pullBodies.length, { timeout: CONVERGE_TIMEOUT }).toBe(2);
    const withCloses = pullBodies.filter((b) => (b.body ?? "").includes("Closes #291"));
    expect(withCloses).toHaveLength(1);
    // The directive belongs to the issue's repository (frontend), not the
    // sibling.
    expect(withCloses[0]).toBe(pullBodies[0]);

    await expect
      .poll(async () => {
        const detail = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth });
        const t = (await detail.json()) as { prUrl: string | null; repositories: Array<{ prUrl: string | null }> };
        return t.repositories.map((repo) => repo.prUrl);
      }, { timeout: CONVERGE_TIMEOUT })
      .toEqual([
        "https://github.com/agetor-e2e/frontend/pull/11",
        "https://github.com/agetor-e2e/backend/pull/12",
      ]);
    const detail = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth });
    expect(((await detail.json()) as { prUrl: string | null }).prUrl).toBeNull();
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs keeps going after one repository fails and retries only the failed one", async ({
  backend,
  page,
  request,
}) => {
  // Spec: "A single Create all PRs action walks the repos with per-repo best
  // effort: one repo's failure does not block the others; results and retries
  // are per repo." The FIRST repository fails, so the second one's PR proves
  // the loop kept going; a reloaded retry then opens only the failed one.
  test.setTimeout(90_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const prTitle = "Multi repository PR retry e2e";
  let frontendCalls = 0;
  const stub = await startGitHubStub(backend.githubStubPort, [
    {
      method: "POST",
      path: /^\/repos\/agetor-e2e\/frontend\/pulls$/,
      body: () => {
        frontendCalls += 1;
        if (frontendCalls === 1) return { status: 500, body: { message: "stub: frontend pull failed" } };
        return { number: 21, title: "frontend PR", state: "open", html_url: "https://github.com/agetor-e2e/frontend/pull/21" };
      },
    },
    {
      method: "POST",
      path: /^\/repos\/agetor-e2e\/backend\/pulls$/,
      body: { number: 22, title: "backend PR", state: "open", html_url: "https://github.com/agetor-e2e/backend/pull/22" },
    },
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const prepared = await createPushedMultiTask(request, backend, { title: prTitle });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;

    await gotoApp(page, backend.bootBase);
    await page.getByText(prTitle, { exact: true }).first().click();
    const button = page.getByTestId("create-all-prs");
    await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await button.click();

    // First pass: frontend failed but the walk continued, so the backend PR
    // exists; the action is offered again for the failed repository only.
    await expect
      .poll(async () => {
        const detail = await request.get(`${backend.apiBase}/tasks/${prepared.taskId}`, { headers: auth });
        const t = (await detail.json()) as { repositories: Array<{ prUrl: string | null }> };
        return t.repositories.map((repo) => repo.prUrl);
      }, { timeout: CONVERGE_TIMEOUT })
      .toEqual([null, "https://github.com/agetor-e2e/backend/pull/22"]);
    expect(frontendCalls).toBe(1);
    // Reload before retrying: the board's `/tasks` snapshot is the source of
    // `repositoriesNeedingPr`, and the stamp is deliberately not an
    // `updated_at` bump, so a panel still holding the pre-stamp snapshot can
    // re-attempt the successful sibling. A fresh load is the deterministic
    // per-repository retry surface. (`page.reload()`, not a second gotoApp:
    // navigating to the same URL is a same-document hash change.)
    await page.reload();
    await expect(page.getByText(prTitle, { exact: true }).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.getByText(prTitle, { exact: true }).first().click();
    await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(button).toBeEnabled({ timeout: CONVERGE_TIMEOUT });

    await button.click();
    await expect
      .poll(async () => {
        const detail = await request.get(`${backend.apiBase}/tasks/${prepared.taskId}`, { headers: auth });
        const t = (await detail.json()) as { repositories: Array<{ prUrl: string | null }> };
        return t.repositories.map((repo) => repo.prUrl);
      }, { timeout: CONVERGE_TIMEOUT })
      .toEqual([
        "https://github.com/agetor-e2e/frontend/pull/21",
        "https://github.com/agetor-e2e/backend/pull/22",
      ]);
    // The already-stamped backend was never re-opened on the retry.
    expect(stub.callsMatching(/^\/repos\/agetor-e2e\/backend\/pulls$/, "POST")).toBe(1);
    expect(frontendCalls).toBe(2);
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("archive detaches every clean worktree (keeping the branches) and unarchive restores them", async ({ backend, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  // Test 2 wrote one file into each worktree; clean both so the teardown has
  // no dirty repository to protect.
  const before = (await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth })).json()) as {
    worktreePath: string;
    repositories: { path: string; worktreePath: string; branch: string }[];
  };
  for (const repo of before.repositories) {
    await rm(path.join(repo.worktreePath, "front.txt"), { force: true });
    await rm(path.join(repo.worktreePath, "back.txt"), { force: true });
  }

  // `force` bypasses the Done-column gate (the Worktrees page's own delete
  // path); `stopRun` stops a still-live fake run first.
  const res = await request.post(`${backend.apiBase}/tasks/${taskId}/archive`, {
    headers: auth,
    data: { force: true, awaitTeardown: true, stopRun: true },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    repositories: { path: string; worktreePath: string; branch: string }[];
    teardown?: { removed: boolean; repositories?: { name: string; result: { removed: boolean } }[] };
  };
  expect(body.teardown?.removed).toBe(true);
  expect(body.teardown?.repositories?.map((r) => r.result.removed)).toEqual([true, true]);
  expect(existsSync(before.worktreePath)).toBe(false);
  for (const repo of body.repositories) {
    expect(existsSync(repo.worktreePath)).toBe(false);
    // Branches (and every commit on them) survive the detach.
    expect(git(repo.path, ["rev-parse", "--verify", `refs/heads/${repo.branch}`])).not.toBe("");
  }

  // Unarchive re-materializes every repository at the same deterministic
  // paths, back on the task branch.
  const unarchived = await request.post(`${backend.apiBase}/tasks/${taskId}/unarchive`, { headers: auth });
  expect(unarchived.ok()).toBe(true);
  const restored = (await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth })).json()) as {
    repositories: { worktreePath: string; branch: string }[];
  };
  for (const repo of restored.repositories) {
    expect(existsSync(repo.worktreePath)).toBe(true);
    expect(git(repo.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(repo.branch);
  }
});

test("archive leaves a dirty repository's checkout and the workspace in place", async ({ backend, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const before = (await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth })).json()) as {
    worktreePath: string;
    repositories: { worktreePath: string }[];
  };
  // Only the second repository is dirty; the first must still be detached.
  await writeFile(path.join(before.repositories[1]!.worktreePath, "dirty.txt"), "uncommitted\n");
  const res = await request.post(`${backend.apiBase}/tasks/${taskId}/archive`, {
    headers: auth,
    data: { force: true, awaitTeardown: true, stopRun: true },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    archivedAt: number | null;
    teardown?: { removed: boolean; reason?: string; repositories?: { name: string; result: { removed: boolean } }[] };
  };
  // Acceptance #5: one dirty repository never blocks the archive itself.
  expect(body.archivedAt).not.toBeNull();
  const reread = (await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth })).json()) as {
    archivedAt: number | null;
  };
  expect(reread.archivedAt).not.toBeNull();
  expect(body.teardown?.removed).toBe(false);
  expect(body.teardown?.reason).toBe("dirty");
  expect(body.teardown?.repositories?.map((r) => r.result.removed)).toEqual([true, false]);
  expect(existsSync(before.repositories[0]!.worktreePath)).toBe(false);
  expect(existsSync(before.repositories[1]!.worktreePath)).toBe(true);
  expect(existsSync(before.worktreePath)).toBe(true);
  // The kept checkout still holds the uncommitted work.
  expect(git(before.repositories[1]!.worktreePath, ["status", "--porcelain"])).toContain("dirty.txt");
});
