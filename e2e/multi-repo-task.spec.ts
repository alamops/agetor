import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";
import { uniqueRepoSlugs } from "../src/shared/multi-repo.ts";

/**
 * E2E coverage for multi-repository tasks (issue #291).
 *
 * Arrange: two throwaway git repos, registered through the real
 * `POST /projects`, and one task created through `POST /tasks` with both
 * repositories. The worker backend already runs the fake claude driver, so
 * `POST /tasks/:id/start` materializes one worktree per repository without a
 * real CLI.
 *
 * Scenarios:
 *  1. create + start: both worktrees exist, the card shows the repository
 *     count, and the task row carries both entries.
 *  2. the diff dialog offers one tab per repository and switching tabs loads
 *     that repository's own changes.
 *  3. the "Commit & push" chip appears when only a sibling repository changed
 *     (the prompt is aggregate, not selected-tab-scoped).
 *  4. the terminal section defaults to the workspace root and follows the
 *     run-panel repository tab (issue #291 review M2).
 *  5. archive detaches both clean worktrees, keeps the branches, and
 *     unarchive restores them.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 30_000;

let repoA: string;
let repoB: string;
let taskId: string;
let singleTaskId: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

test.beforeAll(async ({ backend, request }) => {
  repoA = await initRepo("frontend");
  repoB = await initRepo("backend");
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  for (const p of [repoA, repoB]) {
    await request.post(`${backend.apiBase}/projects`, { headers: auth, data: { path: p } });
  }
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title: "Multi repository e2e",
      prompt: "make the change",
      agent: "claude-code",
      workdir: repoA,
      isolation: "worktree",
      repositories: [{ path: repoA }, { path: repoB }],
    },
  });
  expect(res.ok()).toBe(true);
  taskId = ((await res.json()) as { id: string }).id;

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

test("create + start materializes both worktrees and the card names both repositories", async ({ backend, page, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const started = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: auth });
  expect(started.ok()).toBe(true);

  const names = uniqueRepoSlugs([repoA, repoB]);
  await expect
    .poll(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
      const t = (await res.json()) as { worktreePath: string | null; repositories?: { worktreePath: string | null }[] };
      return t.repositories?.every((r) => !!r.worktreePath) ?? false;
    }, { timeout: CONVERGE_TIMEOUT })
    .toBe(true);

  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
  const task = (await res.json()) as {
    workdir: string;
    worktreePath: string;
    repositories: { name: string; worktreePath: string; branch: string }[];
  };
  expect(task.worktreePath).toBe(task.workdir);
  for (const name of names) {
    expect(existsSync(path.join(task.worktreePath, name))).toBe(true);
  }

  await gotoApp(page, backend.bootBase);
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

test("archive detaches both clean worktrees and keeps the branches", async ({ backend, request }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  // Make exactly one repository dirty (test 2 changed both; the chip test
  // cleaned the first).
  const before = (await (await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth })).json()) as {
    repositories: { worktreePath: string }[];
  };
  await rm(path.join(before.repositories[0]!.worktreePath, "front.txt"), { force: true });
  // `force` bypasses the Done-column gate (the Worktrees page's own delete
  // path); `stopRun` stops a still-live fake run first.
  const res = await request.post(`${backend.apiBase}/tasks/${taskId}/archive`, {
    headers: auth,
    data: { force: true, awaitTeardown: true, stopRun: true },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    repositories: { worktreePath: string; branch: string }[];
    teardown?: { removed: boolean; repositories?: { name: string; result: { removed: boolean } }[] };
  };
  // The two changed files make one repository dirty, so the aggregate teardown
  // reports not-removed and that repository's checkout (and the workspace)
  // stays; the clean one was detached and both branches survive.
  expect(body.teardown?.removed).toBe(false);
  expect(body.repositories.every((r) => r.branch.length > 0)).toBe(true);
  const dirty = body.repositories.filter((r) => existsSync(r.worktreePath));
  expect(dirty).toHaveLength(1);
});
