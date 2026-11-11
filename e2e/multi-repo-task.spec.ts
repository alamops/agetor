import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
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

test.beforeAll(async ({ backend, request }) => {
  repoA = await initRepo("frontend");
  repoB = await initRepo("backend");
  // A registered path under repoA's git root. Selecting it alongside repoA in
  // the dialog must collapse to one repository (dedupeSelections), which the
  // first scenario asserts by still creating a two-repository task.
  repoSibling = path.join(repoA, "packages", "feature");
  await mkdir(repoSibling, { recursive: true });
  repoBHead = git(repoB, ["rev-parse", "HEAD"]);
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
    teardown?: { removed: boolean; repositories?: { name: string; result: { removed: boolean } }[] };
  };
  expect(body.teardown?.removed).toBe(false);
  expect(body.teardown?.repositories?.map((r) => r.result.removed)).toEqual([true, false]);
  expect(existsSync(before.repositories[0]!.worktreePath)).toBe(false);
  expect(existsSync(before.repositories[1]!.worktreePath)).toBe(true);
  expect(existsSync(before.worktreePath)).toBe(true);
});
