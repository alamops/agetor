import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "./fixtures";
import { gotoApp, waitForTerminalReady } from "./helpers";
import { startGitHubStub, type GitHubStub } from "./github-stub";

/**
 * Worktree branch drift is tolerated, never corrected
 * (docs/plans/codex-terminal-worktree-error.md, U9).
 *
 * The bug: opening a terminal on a task whose worktree had drifted off
 * `task.branch` ran `git checkout <task.branch>` in the worktree; with a
 * conflicting uncommitted edit that failed and the user got a red toast
 * ("worktree is on X not Y and could not be switched"), and on a clean tree it
 * silently switched the branch under the agent.
 *
 * Arrange: a throwaway repo whose `origin` is the e2e GitHub stub's repo URL;
 * one worktree task run once under the fake claude driver (materializing the
 * worktree on its own branch). The test then drifts the worktree by hand —
 * new branch, a commit, a local remote-tracking ref (so the branch reads as
 * pushed + synced with no network), and a conflicting uncommitted edit.
 *
 * Act/assert: the terminal opens (PTY live, no toast) and HEAD is untouched;
 * the run panel's drift chip and details rows show the live branch; the
 * terminal open recorded it, so the board card shows it on the next poll;
 * "Create PR" prefills the drifted branch as head; Delete's confirm names
 * both branches it would remove (cancelled); and when the teardown preview
 * fails, the confirm falls back to the task row and names the drifted branch
 * as one the delete may also remove (cancelled).
 *
 * `SHELL=/bin/sh` (via `backendEnv`, which only `freshBackend` reads) for the
 * same reason `terminals.test.ts` pins it: the assertion is about the
 * manager + checkout, not the developer's own login shell.
 */

test.use({ backendEnv: { SHELL: "/bin/sh" } });

const CONVERGE_TIMEOUT = 20_000;
const DRIFT_BRANCH = "implement/e2e-drift";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-terminal-drift-"));
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

/** The run panel's slide-over `<aside>` (NewTaskForm's sidebar is also an
 *  `<aside>`, mounted first — see sent-files.spec.ts). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

test("a drifted worktree opens a terminal in place and every surface shows the live branch", async ({ page, request, freshBackend }) => {
  const backend = freshBackend;
  const stub: GitHubStub = await startGitHubStub(backend.githubStubPort, [
    { method: "GET", path: "/user", body: { login: "e2e-user", id: 1 } },
    {
      method: "GET",
      path: /^\/repos\/e2e-org\/e2e-repo$/,
      body: { permissions: { push: true, admin: true, maintain: true }, default_branch: "main" },
    },
    // The PR composer's pickers — empty is fine, only the head is asserted.
    ...["labels", "milestones", "releases", "assignees", "pulls"].map((p) => ({
      method: "GET",
      path: new RegExp(`^/repos/e2e-org/e2e-repo/${p}$`),
      body: [] as unknown[],
    })),
  ]);
  try {
    const repo = await initRepo();
    const auth = { authorization: `Bearer ${backend.apiToken}` };
    const title = `terminal-drift ${randomUUID()}`;

    const createRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth,
      data: { title, prompt: title, isolation: "worktree", workdir: repo },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const { id: taskId } = (await createRes.json()) as { id: string };
    const startRes = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: auth });
    expect(startRes.ok(), `start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();

    // Wait for the fake turn to settle; then read where the worktree lives.
    let task: { branch: string; worktreePath: string; column: string } | null = null;
    await expect(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
      task = (await res.json()) as { branch: string; worktreePath: string; column: string };
      expect(task.column).toBe("review");
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    const { branch: taskBranch, worktreePath: wt } = task!;
    expect(taskBranch).toBeTruthy();

    // Drift the worktree like an agent cutting its own branch would.
    git(wt, ["checkout", "-q", "-b", DRIFT_BRANCH]);
    await writeFile(path.join(wt, "README.md"), "drifted\n");
    git(wt, ["commit", "-q", "-am", "work on the drifted branch"]);
    // "Pushed" without a network: a local remote-tracking ref + upstream.
    git(wt, ["update-ref", `refs/remotes/origin/${DRIFT_BRANCH}`, "HEAD"]);
    git(wt, ["branch", "-q", `--set-upstream-to=origin/${DRIFT_BRANCH}`]);
    // The conflicting uncommitted edit that made the old checkout fail.
    await writeFile(path.join(wt, "README.md"), "uncommitted conflicting edit\n");

    await gotoApp(page, backend.bootBase);
    await page.getByText(title, { exact: true }).first().click();
    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible();

    // ── Terminal opens in place ──────────────────────────────────────────
    await panel.locator('[data-testid="terminals-section"] > summary').click();
    await panel.locator('[data-testid="terminal-open"]').first().click();
    await waitForTerminalReady(panel);
    await expect(page.getByText(/could not be switched/)).toHaveCount(0);
    await expect(page.getByText(/Could not open/i)).toHaveCount(0);
    expect(git(wt, ["symbolic-ref", "--short", "HEAD"])).toBe(DRIFT_BRANCH);
    expect(git(wt, ["status", "--porcelain"])).toContain("README.md");

    // ── Run panel: drift chip + details rows (live, 5 s git-status poll) ─
    await expect(panel.getByTestId("run-panel-branch-drift")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(panel.getByTestId("run-panel-branch-drift")).toHaveAttribute("title", `task branch: ${taskBranch}`);
    await expect(panel.getByTestId("task-details-checkout-branch")).toHaveText(DRIFT_BRANCH);
    await expect(panel.getByTestId("task-details-task-branch")).toHaveText(taskBranch);

    // ── Board card: the terminal open recorded the live branch ───────────
    const card = taskCard(page, title);
    await expect(card.getByTestId("task-card-branch-drift")).toBeAttached({ timeout: CONVERGE_TIMEOUT });
    await expect(card).toContainText(DRIFT_BRANCH);
    const recorded = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth });
    expect(((await recorded.json()) as { checkoutBranch: string | null }).checkoutBranch).toBe(DRIFT_BRANCH);

    // ── Create PR prefills the drifted branch as head ───────────────────
    await panel.getByRole("button", { name: "Create PR" }).click();
    await expect(page.getByPlaceholder("Head branch")).toHaveValue(DRIFT_BRANCH, { timeout: CONVERGE_TIMEOUT });
    // Escape first leaves the composer subpage, then closes the Git dialog.
    const gitDialog = page.locator('[role="dialog"][aria-labelledby="github-dialog-title"]');
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(gitDialog).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // ── Delete confirm names both branches (cancelled) ──────────────────
    await panel.getByRole("button", { name: "Close task details" }).click();
    await card.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "center" }));
    await page.getByText(title, { exact: true }).first().click({ button: "right" });
    await page.locator('[data-testid="task-context-menu-delete"]').click();
    const dialog = page.getByRole("dialog");
    const branches = dialog.getByTestId("delete-confirm-branches");
    await expect(branches).toContainText(taskBranch);
    await expect(branches).toContainText(DRIFT_BRANCH);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    // Cancelled: nothing was torn down.
    expect(git(repo, ["branch", "--list", DRIFT_BRANCH])).toContain(DRIFT_BRANCH);

    // ── Preview unavailable: the confirm falls back to the task row ─────
    // An older core (or a failed preview request) can't plan the teardown,
    // so the confirm names `task.branch` and, as a "possibly", the drifted
    // branch the worktree was last seen on.
    // The app calls the API cross-origin: without the ACAO header the browser
    // would block the response and the app would see a network error instead.
    let previewRequests = 0;
    await page.route((url) => url.pathname === `/tasks/${taskId}/teardown-preview`, (route) => {
      previewRequests++;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: "teardown preview unavailable" }),
      });
    });
    try {
      await page.getByText(title, { exact: true }).first().click({ button: "right" });
      await page.locator('[data-testid="task-context-menu-delete"]').click();
      const fallback = page.getByRole("dialog");
      await expect(fallback.getByTestId("delete-confirm-maybe-branch")).toHaveText(DRIFT_BRANCH);
      expect(previewRequests).toBeGreaterThan(0);
      await expect(fallback).toContainText(`Its git worktree (${taskBranch}) will also be torn down`);
      await expect(fallback.getByTestId("delete-confirm-branches")).toHaveCount(0);
      await fallback.getByRole("button", { name: "Cancel" }).click();
      await expect(fallback).toBeHidden();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
    expect(git(repo, ["branch", "--list", DRIFT_BRANCH])).toContain(DRIFT_BRANCH);
    expect(git(repo, ["branch", "--list", taskBranch])).toContain(taskBranch);
  } finally {
    await stub.close();
  }
});
