import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Archive removes the task's worktree, uncommitted changes included, after a
 * confirmation (`ArchiveUncommittedChanges`, docs/architecture/task-lifecycle.md).
 * The core answers 409 `uncommitted-changes` to a plain archive of a dirty
 * worktree; the board asks, and only a confirmed archive (`forceWorktree`)
 * goes ahead. A clean worktree archives without a question.
 */

const CONVERGE_TIMEOUT = 20_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-archive-uncommitted-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "e2e fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
  return dir;
}

interface TaskRow { id: string; branch: string; worktreePath: string; column: string; archivedAt: number | null }

/** A worktree task the fake agent has run once, moved to Done. */
async function doneWorktreeTask(request: APIRequestContext, backend: E2EBackend, repo: string, title: string): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: title, isolation: "worktree", workdir: repo },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const { id } = (await createRes.json()) as { id: string };
  const startRes = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth });
  expect(startRes.ok(), `start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
  await expect(async () => {
    const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth });
    expect(((await res.json()) as TaskRow).column).toBe("review");
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  const done = await request.patch(`${backend.apiBase}/tasks/${id}`, { headers: auth, data: { column: "done" } });
  expect(done.ok(), `PATCH done -> ${done.status()}: ${await done.text()}`).toBeTruthy();
  return (await done.json()) as TaskRow;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  return (await res.json()) as TaskRow;
}

/** Opens the card's context menu and picks Archive. */
async function archiveFromMenu(page: Page, id: string): Promise<void> {
  const card = page.locator(`[data-task-id="${id}"]`);
  await card.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "center" }));
  await card.dispatchEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  const item = page.locator('[data-testid="task-context-menu-archive"]');
  await expect(item).toBeVisible();
  await item.click();
}

test.describe("archive with uncommitted changes", () => {
  test("asks first; Cancel keeps the task and its changes, confirming archives and removes the worktree", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    const repo = await initRepo();
    const title = `archive-dirty ${randomUUID()}`;
    const task = await doneWorktreeTask(request, backend, repo, title);
    const wt = task.worktreePath;
    await writeFile(path.join(wt, "wip.txt"), "uncommitted\n");

    await gotoApp(page, backend.bootBase);
    await archiveFromMenu(page, task.id);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Discard uncommitted changes in "${title}"?`)).toBeVisible();
    await expect(dialog).toContainText("This task's worktree has uncommitted changes");

    // Cancel: nothing changed, the card stays, the file is still there.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
    expect((await getTask(request, backend, task.id)).archivedAt).toBeNull();
    expect(existsSync(path.join(wt, "wip.txt"))).toBe(true);

    // Confirm: archived, and the worktree is removed with the change; the
    // branch is kept.
    await archiveFromMenu(page, task.id);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Discard & archive" }).click();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveCount(0);
    await expect.poll(async () => (await getTask(request, backend, task.id)).archivedAt).not.toBeNull();
    await expect.poll(() => existsSync(wt), { timeout: CONVERGE_TIMEOUT }).toBe(false);
    expect(git(repo, ["branch", "--list", task.branch])).toContain(task.branch);
  });

  test("a clean worktree archives without asking and is removed", async ({ page, request, backend }) => {
    test.setTimeout(90_000);
    const repo = await initRepo();
    const task = await doneWorktreeTask(request, backend, repo, `archive-clean ${randomUUID()}`);

    await gotoApp(page, backend.bootBase);
    await archiveFromMenu(page, task.id);
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => existsSync(task.worktreePath), { timeout: CONVERGE_TIMEOUT }).toBe(false);
  });
});
