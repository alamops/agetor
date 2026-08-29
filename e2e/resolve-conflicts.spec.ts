import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for the "Resolve with Agetor" dialog
 * (`src/mainview/components/kanban/ResolveConflictsDialog.tsx`), added by
 * docs/plans/issue-pr-modal-worktree-composer-parity.md to share the New
 * Task left panel's prompt composer (`PromptComposer.tsx`: `/` autocomplete,
 * the MCP·Skills·Plugins·Prompts extension picker, Files/Folders refs) and a
 * LOCKED worktree row (`WorktreeOptions.tsx`'s `locked` variant — a
 * read-only "Branch" input showing the PR head plus a checked/disabled
 * "Isolate (worktree)" checkbox) rather than the live picker: the task is
 * created ON the PR's head branch via `existingBranch`, which
 * `src/bun/orchestrator.ts`'s `createTask` requires worktree isolation for
 * and ignores `baseRef` on.
 *
 * The dialog is reachable only through the PR detail view's "Resolve with
 * Agetor" button, which `GitHubDialog.tsx`'s `canResolveConflicts` gates on
 * (all of): GitHub provider, `item.state === "open"`, a fetched
 * `mergeability` verdict, `mergeability.mergeableState === "dirty"`,
 * `!mergeability.crossRepo` (head repo === base repo, case-insensitively),
 * and `!mergeability.merged`. No push-permission gate. The stub PR below is
 * shaped to satisfy exactly that: open, `mergeable: false`,
 * `mergeable_state: "dirty"`, head/base repo both `e2e-org/e2e-repo`.
 *
 * Arrange: one throwaway git repo (recipe copied from
 * `e2e/pr-merged-state.spec.ts`'s `initRepo` — `main` with one commit,
 * `origin` -> `https://github.com/e2e-org/e2e-repo.git` so the backend's
 * remote-parsing resolves the GitHub provider) registered as a project via
 * the real `POST /projects`, PLUS a local `feature-branch` (the PR's head
 * per `prPayload`) one commit ahead of `main`, with the checkout left back
 * on `main` afterward.
 *
 * `prPayload`/`auxiliaryRoutes` below are copied (not imported) from
 * `pr-merged-state.spec.ts` — extracting a shared module would mean editing
 * a file this task doesn't own.
 *
 * Known hazard (see `createTask`'s existingBranch path,
 * `src/bun/worktree.ts:536`'s `fetchBranch`): before resolving/checking out
 * a pre-existing branch, agetor best-effort `git fetch origin
 * <branch>`s against the *real* `https://github.com/e2e-org/e2e-repo.git`
 * (the stub only intercepts this app's REST/GraphQL calls, not raw git
 * network traffic). Verified by hand in this environment: with `stdin:
 * "ignore"` (see `git()` in worktree.ts), that fetch fails in well under a
 * second (GitHub answers "Repository not found" — no interactive credential
 * prompt to hang on), then `createTask` falls back to the local
 * `refs/heads/feature-branch` ref, which exists. No bare-clone workaround
 * needed; the generous `CONVERGE_TIMEOUT` below is enough headroom if a
 * slower/offline machine makes that fetch hang up to its own internal
 * timeout instead.
 */

const REPO_PATH = "/repos/e2e-org/e2e-repo";
const PR_NUMBER = 42;
const PR_TITLE = "e2e conflicted pull request";
const HEAD_BRANCH = "feature-branch";
const BASE_BRANCH = "main";

// Generous but bounded convergence timeout — the submit step's create+start
// round trip materializes a real worktree/branch against a real temp git
// repo, on top of the usual fetch/render settling. Mirrors
// `issue-task.spec.ts`'s CONVERGE_TIMEOUT.
const CONVERGE_TIMEOUT = 30_000;

let stub: GitHubStub;
let projectDir: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-resolve-conflicts-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", "https://github.com/e2e-org/e2e-repo.git"]);
  await writeFile(path.join(dir, "README.md"), "e2e fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);

  // The PR's head branch — one commit ahead of `main` — so
  // `createTask`'s existingBranch path finds a real local ref to check
  // out once its best-effort `git fetch origin feature-branch` fails
  // against the fake origin (see file header). Checked out back to `main`
  // afterward so the fixture repo's own checkout is unaffected.
  git(dir, ["checkout", "-q", "-b", HEAD_BRANCH]);
  await writeFile(path.join(dir, "CONFLICT.md"), "feature-branch marker\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature commit"]);
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

/** A minimally-shaped GitHub pull request JSON object, copied from
 *  `pr-merged-state.spec.ts`'s `prPayload` (not imported — see file header)
 *  and adjusted so `canResolveConflicts` gates true by default: open,
 *  `mergeable: false`, `mergeable_state: "dirty"`, head/base repo matching
 *  (not cross-repo). Serves both the PR-list route and the detail/
 *  mergeability route (same underlying GitHub endpoint). */
function prPayload(overrides: { mergeable?: boolean | null; mergeableState?: string } = {}) {
  return {
    number: PR_NUMBER,
    title: PR_TITLE,
    state: "open",
    html_url: `https://github.com/e2e-org/e2e-repo/pull/${PR_NUMBER}`,
    user: { login: "e2e-author", avatar_url: null, html_url: null },
    assignees: [] as unknown[],
    milestone: null,
    body: "",
    labels: [] as unknown[],
    comments: 0,
    created_at: "2026-08-18T09:00:00Z",
    updated_at: "2026-08-19T09:00:00Z",
    closed_at: null,
    merged_at: null,
    locked: false,
    draft: false,
    head: {
      ref: HEAD_BRANCH,
      sha: "abc123deadbeef0000000000000000000000000",
      repo: { full_name: "e2e-org/e2e-repo" },
    },
    base: { ref: BASE_BRANCH, repo: { full_name: "e2e-org/e2e-repo" } },
    mergeable: overrides.mergeable ?? false,
    mergeable_state: overrides.mergeableState ?? "dirty",
    rebaseable: false,
    merged: false,
    auto_merge: null,
  };
}

/** Routes every scenario needs so the detail view's many per-item sections
 *  resolve cleanly instead of 404ing into the stub's unmatched-route log —
 *  copied from `pr-merged-state.spec.ts`'s `auxiliaryRoutes` (not imported;
 *  see file header). None of these are asserted on. */
function auxiliaryRoutes(): StubRoute[] {
  return [
    { method: "GET", path: "/user", body: { login: "e2e-user", id: 1 } },
    {
      method: "GET",
      path: new RegExp(`^${REPO_PATH}$`),
      body: { permissions: { push: true, admin: true, maintain: true }, default_branch: "main" },
    },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}/commits$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${PR_NUMBER}/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/check-runs$`), body: { check_runs: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/status$`), body: { state: "success", statuses: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/labels$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/milestones$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/assignees$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/releases$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${PR_NUMBER}/reactions$`), body: [] },
    {
      method: "POST",
      path: "/graphql",
      body: {
        data: {
          repository: {
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

function routes(): StubRoute[] {
  return [
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls$`), body: [prPayload()] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}$`), body: prPayload() },
    ...auxiliaryRoutes(),
  ];
}

/** Opens the Git dialog and pins its Project combobox to this spec's own
 *  repo — same rationale as `pr-merged-state.spec.ts`'s `openGitDialog`: the
 *  worker-scoped backend is shared with other spec files, so the dialog's
 *  no-prefill default project isn't reliable. */
async function openGitDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const projectSelect = dialog.getByRole("combobox", { name: "Project" });
  await expect(projectSelect).toBeVisible();
  if ((await projectSelect.inputValue()) !== projectDir) {
    await projectSelect.selectOption({ value: projectDir });
  }

  return dialog;
}

interface TaskRow {
  id: string;
  title: string;
  isolation: "worktree" | "none";
  branch: string | null;
  branchSource: "created" | "existing";
  baseRef: string | null;
  worktreePath: string | null;
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

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  stub = await startGitHubStub(backend.githubStubPort, routes());
});

test.afterAll(async () => {
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("Resolve with Agetor dialog", () => {
  test("locked worktree row + shared composer + create-on-existing-branch, and the branch survives task deletion", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);

    await gotoApp(page, backend.bootBase);
    const gitDialog = await openGitDialog(page);

    const row = gitDialog.getByRole("button", { name: `#${PR_NUMBER} ${PR_TITLE}` });
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();

    await expect(gitDialog.getByText(PR_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const resolveButton = gitDialog.getByRole("button", { name: "Resolve with Agetor", exact: true });
    await expect(resolveButton).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await resolveButton.click();

    const dlg = page.getByTestId("resolve-conflicts-dialog");
    await expect(dlg).toBeVisible();

    // --- Locked worktree row ---
    await expect(dlg.getByTestId("worktree-options-locked")).toBeVisible();
    const isolateToggle = dlg.getByTestId("isolate-toggle");
    await expect(isolateToggle).toBeChecked();
    await expect(isolateToggle).toBeDisabled();
    const lockedBranch = dlg.getByTestId("locked-branch");
    await expect(lockedBranch).toHaveValue(HEAD_BRANCH);
    await expect(lockedBranch).toHaveAttribute("readonly");

    // --- Seeded prompt ---
    const promptTextarea = dlg.getByTestId("prompt-textarea");
    await expect(promptTextarea).toBeVisible();
    await expect(async () => {
      const value = await promptTextarea.inputValue();
      expect(value).toContain(`origin/${BASE_BRANCH}`);
      expect(value).toContain(HEAD_BRANCH);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // --- Composer: slash autocomplete inserts on click (not Enter) ---
    await promptTextarea.click();
    await promptTextarea.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await page.keyboard.type("\n/code-");

    const slashMenu = dlg.getByTestId("slash-autocomplete");
    await expect(slashMenu).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const codeReviewRow = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/code-review" });
    await expect(codeReviewRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    // Click the exact row rather than pressing Enter — the developer's real
    // `~/.claude/skills` leak into discovery and can reorder rows (see
    // issue-task.spec.ts's identical rationale).
    await codeReviewRow.click();
    await expect(async () => {
      expect(await promptTextarea.inputValue()).toContain("/code-review ");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // --- Escape yields to the popover, not the dialog underneath it ---
    await page.keyboard.type(" tail");
    await page.keyboard.type("\n/co");
    await expect(slashMenu).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(slashMenu).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(dlg).toBeVisible();

    const extTrigger = dlg.getByTestId("extension-picker-trigger");
    const extPopover = dlg.getByTestId("extension-picker-popover");
    await extTrigger.click();
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(extPopover).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(dlg).toBeVisible();

    // --- Submit: create & start on the PR's head branch ---
    const submit = dlg.getByTestId("resolve-conflicts-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(dlg).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const cardTitle = `Resolve conflicts: PR #${PR_NUMBER} — ${PR_TITLE}`;
    let task: TaskRow | null = null;
    await expect(async () => {
      task = await findTaskByTitle(request, backend, cardTitle);
      expect(task).not.toBeNull();
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    task = task!;

    const expectedBaseRef = gitOutput(projectDir, ["rev-parse", HEAD_BRANCH]);

    await expect(async () => {
      task = await findTaskByTitle(request, backend, cardTitle);
      expect(task?.isolation).toBe("worktree");
      expect(task?.branch).toBe(HEAD_BRANCH);
      expect(task?.branchSource).toBe("existing");
      expect(task?.baseRef).toBe(expectedBaseRef);
      expect(task?.worktreePath).toBeTruthy();
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    task = task!;
    const worktreePath = task.worktreePath!;

    // --- Delete: the existing branch survives, the worktree dir doesn't ---
    const delRes = await request.delete(`${backend.apiBase}/tasks/${task.id}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(delRes.ok()).toBeTruthy();

    await expect(async () => {
      expect(existsSync(worktreePath)).toBe(false);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // Invariant: agetor never deletes a `branchSource: "existing"` branch —
    // it's the user's own (here, the PR's real head branch), not one agetor
    // minted.
    expect(() => gitOutput(projectDir, ["rev-parse", "--verify", HEAD_BRANCH])).not.toThrow();
  });
});
