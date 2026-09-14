import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for the agent-profile picker inside the two shared launch
 * dialogs (`CreateTaskFromIssueDialog.tsx`, `ResolveConflictsDialog.tsx`),
 * both built on `TaskLaunchPickers`/`useTaskLaunch` (docs/plans/agent-
 * profiles.md §3 D9). Complements `e2e/agent-profiles.spec.ts` (which only
 * exercises the New Task form's picker) — TT7's "Settings/New Task/board/
 * transcript/freeze/delete" ground is already covered there, so this file
 * focuses on what's specific to the two dialogs: the picker replacing their
 * own manual block, an unavailable-harness profile disabling Start with a
 * visible reason (finding F2-3 in the plan), the resolve-conflicts
 * `existingBranch` path carrying a profile through, and the dialog-vs-
 * popover Escape contract (CLAUDE.md item 11) with the profile popover as
 * the carrier under test.
 *
 * Arrange: one throwaway git repo with `origin` -> `https://github.com/
 * e2e-org/e2e-repo.git`, `main` + a `feature-branch` one commit ahead (the
 * PR's head, mirroring `e2e/resolve-conflicts.spec.ts`'s `initRepo`),
 * registered as a project via `POST /projects`. One stub GitHub API
 * (`e2e/github-stub.ts`) serves BOTH an issue (#55) and a PR (#77) on the
 * same repo — the two route tables don't collide (`/issues$` vs `/pulls$`),
 * so one `beforeAll` covers every scenario in this file. Routes and repo
 * setup are copied (not imported) from `resolve-conflicts.spec.ts` /
 * `issue-task.spec.ts`, matching their own stated rationale: those two
 * files deliberately don't share a module, and this file follows suit.
 *
 * A REST-seeded claude-code agent profile ("Dialog Reviewer") is created
 * once in `beforeAll` and reused by every scenario that needs "a profile
 * that resolves cleanly" (tests 1, 3, 4); test 2 additionally enables the
 * built-in `cursor` harness (ships disabled — migration 032) via REST and
 * creates a second profile pointing at it, relying on `cursor-agent` NOT
 * being on this machine's PATH so `checkHarness` reports it unavailable —
 * exactly the "profile whose harness can't run" case `TaskLaunchPickers`
 * gates Start on (`effectiveStatus`, finding F2-3), then disables cursor
 * again afterward so it can't leak into another spec file sharing this
 * worker's backend.
 */

const REPO_PATH = "/repos/e2e-org/e2e-repo";
const ISSUE_NUMBER = 55;
const ISSUE_TITLE = "Board polling drops a task mid-drag";
const ISSUE_HTML_URL = `https://github.com/e2e-org/e2e-repo/issues/${ISSUE_NUMBER}`;
const COMMENT_BODY = "Repro: drag a card while a poll lands.";

const PR_NUMBER = 77;
const PR_TITLE = "e2e conflicted pull request for the dialog picker";
const HEAD_BRANCH = "feature-branch";
const BASE_BRANCH = "main";

const CONVERGE_TIMEOUT = 30_000;

let stub: GitHubStub;
let projectDir: string;
const createdTaskIds: string[] = [];

let dialogProfileId = "";
const DIALOG_PROFILE_NAME = "Dialog Reviewer";
const DIALOG_PROFILE_INSTRUCTIONS = "Check tests before editing.";

let cursorProfileId = "";
const CURSOR_PROFILE_NAME = "Dialog Cursor Agent";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-agent-profiles-dialogs-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", "https://github.com/e2e-org/e2e-repo.git"]);
  await writeFile(path.join(dir, "README.md"), "e2e fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);

  git(dir, ["checkout", "-q", "-b", HEAD_BRANCH]);
  await writeFile(path.join(dir, "CONFLICT.md"), "feature-branch marker\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature commit"]);
  git(dir, ["checkout", "-q", "main"]);

  return dir;
}

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
    body: "Steps to reproduce:\n1. Drag a card\n2. Let a poll land mid-drag\n\nExpected: card stays put.",
    labels: [] as unknown[],
    comments: 1,
    created_at: "2026-08-10T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
    closed_at: null,
    locked: false,
    draft: false,
  };
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

/** Shared aux routes both the issue detail view and the PR detail view need
 *  so their many per-item sections resolve cleanly instead of 404ing into
 *  the stub's unmatched-route log. Copied from `issue-task.spec.ts`'s /
 *  `resolve-conflicts.spec.ts`'s own `auxiliaryRoutes` (union of both —
 *  neither file's set is a strict subset of the other). None asserted on. */
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
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}/commits$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${PR_NUMBER}/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/check-runs$`), body: { check_runs: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/status$`), body: { state: "success", statuses: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${PR_NUMBER}/reactions$`), body: [] },
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

function routes(): StubRoute[] {
  return [
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues$`), body: [issuePayload()] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}$`), body: issuePayload() },
    {
      method: "GET",
      path: new RegExp(`^${REPO_PATH}/issues/${ISSUE_NUMBER}/comments$`),
      body: [commentPayload(201, "e2e-reporter", COMMENT_BODY, "2026-08-10T09:05:00Z")],
    },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls$`), body: [prPayload()] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/${PR_NUMBER}$`), body: prPayload() },
    ...auxiliaryRoutes(),
  ];
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function createProfile(
  backend: E2EBackend,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await fetch(`${backend.apiBase}/agent-profiles`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({
      name: DIALOG_PROFILE_NAME,
      harness: "claude-code",
      model: "opus-5",
      effort: "high",
      mode: "auto",
      instructions: DIALOG_PROFILE_INSTRUCTIONS,
      skills: ["code-review"],
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`POST /agent-profiles -> ${res.status}: ${await res.text()}`);
  const created = (await res.json()) as { id: string };
  return created.id;
}

/** A non-builtin harness whose `bin` is an absolute path to a file that does
 *  not exist — deterministically `available: false` regardless of what's
 *  actually installed on the machine running this suite (see the test that
 *  uses this for why relying on the real `cursor` harness was not safe
 *  here). Registered id is returned for `deleteHarness` cleanup. */
let unavailableHarnessId: string | null = null;
async function createUnavailableHarness(backend: E2EBackend): Promise<string> {
  const id = `agent-profiles-dialogs-unavailable-${Date.now()}`;
  const res = await fetch(`${backend.apiBase}/harnesses`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({
      id,
      kind: "claude-code",
      label: "Deliberately Unavailable Harness",
      bin: "/nonexistent/agetor-e2e-agent-profiles-dialogs/no-such-binary",
    }),
  });
  if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
  const created = (await res.json()) as { id: string };
  unavailableHarnessId = created.id;
  return created.id;
}

// ---- Locator helpers (mirror issue-task.spec.ts / resolve-conflicts.spec.ts) ----

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openGitDialog(page: Page, tab: "Issues" | "Pulls"): Promise<Locator> {
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const projectSelect = dialog.getByRole("combobox", { name: "Project" });
  await expect(projectSelect).toBeVisible();
  if ((await projectSelect.inputValue()) !== projectDir) {
    await projectSelect.selectOption({ value: projectDir });
  }

  if (tab === "Issues") {
    await dialog.getByRole("button", { name: "Issues", exact: true }).click();
  }

  return dialog;
}

async function openIssueTaskDialog(page: Page): Promise<Locator> {
  const dialog = await openGitDialog(page, "Issues");
  const row = dialog.getByRole("button", { name: `#${ISSUE_NUMBER} ${ISSUE_TITLE}` });
  await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await row.click();
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
  }).toPass({ timeout: CONVERGE_TIMEOUT });

  return issueTaskDialog;
}

async function openResolveConflictsDialog(page: Page): Promise<Locator> {
  const dialog = await openGitDialog(page, "Pulls");
  const row = dialog.getByRole("button", { name: `#${PR_NUMBER} ${PR_TITLE}` });
  await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await row.click();
  await expect(dialog.getByText(PR_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  const resolveButton = dialog.getByRole("button", { name: "Resolve with Agetor", exact: true });
  await expect(resolveButton).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await resolveButton.click();

  const dlg = page.getByTestId("resolve-conflicts-dialog");
  await expect(dlg).toBeVisible();
  return dlg;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  agentProfileId: string | null;
  agentProfile: { instructions: string; skills: string[] } | null;
  issueUrl: string | null;
  isolation: "worktree" | "none";
  branch: string | null;
  branchSource: "created" | "existing";
}

async function findTaskByTitle(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks -> ${res.status()}`).toBeTruthy();
  const list = (await res.json()) as TaskRow[];
  return list.find((t) => t.title === title) ?? null;
}

async function awaitCreatedTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  createdTaskIds.push(task!.id);
  return task!;
}

async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: string,
): Promise<void> {
  await expect(async () => {
    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) });
    expect(res.ok()).toBeTruthy();
    const task = (await res.json()) as TaskRow;
    expect(task.column).toBe(expected);
  }).toPass({ timeout: CONVERGE_TIMEOUT });
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  stub = await startGitHubStub(backend.githubStubPort, routes());
  dialogProfileId = await createProfile(backend);
});

test.afterAll(async ({ backend }) => {
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  await fetch(`${backend.apiBase}/agent-profiles/${dialogProfileId}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  if (cursorProfileId) {
    // Delete the profile BEFORE the harness it references — `DELETE
    // /harnesses/:id` refuses (409) while a profile still points at it.
    await fetch(`${backend.apiBase}/agent-profiles/${cursorProfileId}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  if (unavailableHarnessId) {
    await fetch(`${backend.apiBase}/harnesses/${unavailableHarnessId}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("agent profile picker in the shared launch dialogs", () => {
  test("create-from-issue dialog: picking a profile replaces the manual block; create & start carries agentProfileId + issueUrl + injected instructions", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const picker = issueTaskDialog.getByTestId("agent-profile-picker");
    await expect(picker).toBeVisible();
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    const row = picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${dialogProfileId}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // "One selection" (D5): the manual Harness block is gone, replaced by
    // the selected card.
    await expect(issueTaskDialog.getByText("Harness", { exact: true })).toHaveCount(0);
    const selectedCard = issueTaskDialog
      .locator(`[data-testid="agent-profile-card"][data-profile-id="${dialogProfileId}"]`)
      .last();
    await expect(selectedCard).toBeVisible();
    await expect(selectedCard).toContainText(DIALOG_PROFILE_NAME);

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const cardTitle = `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;
    const task = await awaitCreatedTask(request, backend, cardTitle);
    expect(task.agentProfileId).toBe(dialogProfileId);
    expect(task.agentProfile?.instructions).toBe(DIALOG_PROFILE_INSTRUCTIONS);
    expect(task.issueUrl).toBe(ISSUE_HTML_URL);

    await waitForColumn(request, backend, task.id, "review");

    // The GitHubDialog underneath stays open with a "Task created and
    // started" confirmation, and the just-settled run also fires a global
    // "Task succeeded" toast (the task isn't the open run panel) — both can
    // sit on top of / intercept interaction with the board, and neither a
    // "Close" click nor a bare Escape reliably cleared them here (observed:
    // the toast can keep re-obstructing for well beyond its own stated
    // duration). Server state is already confirmed via the REST polling
    // above, so force a genuine hard reload — navigate away to a different
    // URL first, since `page.goto` back to the identical boot URL was not
    // enough to reliably reset in-page (dialog/toast) state — and open the
    // task fresh from a clean board.
    await page.goto("about:blank");
    await gotoApp(page, backend.bootBase);

    // Transcript: the injected "Agent instructions" block precedes the
    // issue-derived "Your task:" body.
    await page.getByText(cardTitle, { exact: true }).first().click();
    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const instructionsBlock = panel.getByTestId("agent-instructions-block").first();
    await expect(instructionsBlock).toBeVisible();
    await instructionsBlock.getByRole("button").click();
    await expect(instructionsBlock).toContainText(DIALOG_PROFILE_INSTRUCTIONS);
    await expect(instructionsBlock).toContainText("/code-review");

    const bubble = instructionsBlock.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await expect(bubble).toContainText("Your task:");
    await expect(bubble).toContainText(`Issue #${ISSUE_NUMBER}`);

    await panel.getByRole("button", { name: "Close task details" }).click();
  });

  test("create-from-issue dialog: a profile on an unavailable harness disables Start and shows the reason; No agent restores it", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    // A synthetic non-builtin harness pinned to a bogus absolute `bin` path
    // (`resolveBin` returns `harness.bin` verbatim when set — see agents.ts
    // — and `resolveBinPath` treats an absolute path as unavailable unless
    // `existsSync`) is what makes "unavailable" deterministic here,
    // independent of what happens to be installed on the machine running
    // this suite — this dev environment turned out to have a real
    // `cursor-agent` on PATH (`~/.local/bin/cursor-agent`), so picking the
    // built-in `cursor` harness for this scenario was not reliable.
    const harnessId = await createUnavailableHarness(backend);
    cursorProfileId = await createProfile(backend, {
      name: CURSOR_PROFILE_NAME,
      harness: harnessId,
      model: "unused-model",
      effort: null,
      mode: "auto",
      instructions: "",
      skills: [],
    });

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const picker = issueTaskDialog.getByTestId("agent-profile-picker");
    await picker.getByTestId("agent-profile-picker-trigger").click();
    const row = picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${cursorProfileId}"]`);
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();

    const selectedCard = issueTaskDialog
      .locator(`[data-testid="agent-profile-card"][data-profile-id="${cursorProfileId}"]`)
      .last();
    await expect(selectedCard).toBeVisible();

    const hint = issueTaskDialog.getByTestId("launch-agent-unavailable-hint");
    await expect(hint).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(hint).toContainText("not found on PATH");

    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeDisabled();

    // Switch back to "No agent" — Start becomes enabled again (claude-code,
    // the default manual harness, is available under the fake driver).
    await picker.getByTestId("agent-profile-picker-clear").click();
    await expect(hint).toBeHidden();
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });

    await issueTaskDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  });

  test("resolve-conflicts dialog: picking a profile replaces the manual block; submit carries agentProfileId on the existingBranch task", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    await gotoApp(page, backend.bootBase);
    const dlg = await openResolveConflictsDialog(page);

    const picker = dlg.getByTestId("agent-profile-picker");
    await expect(picker).toBeVisible();
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    const row = picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${dialogProfileId}"]`);
    await expect(row).toBeVisible();
    await row.click();

    await expect(dlg.getByText("Harness", { exact: true })).toHaveCount(0);
    const selectedCard = dlg
      .locator(`[data-testid="agent-profile-card"][data-profile-id="${dialogProfileId}"]`)
      .last();
    await expect(selectedCard).toBeVisible();

    // The locked worktree row is unaffected by the profile selection — it
    // always shows the PR's head branch regardless of which agent is picked.
    await expect(dlg.getByTestId("locked-branch")).toHaveValue(HEAD_BRANCH);

    const submit = dlg.getByTestId("resolve-conflicts-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(dlg).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const cardTitle = `Resolve conflicts: PR #${PR_NUMBER} — ${PR_TITLE}`;
    const task = await awaitCreatedTask(request, backend, cardTitle);
    expect(task.agentProfileId).toBe(dialogProfileId);
    expect(task.branchSource).toBe("existing");
    expect(task.branch).toBe(HEAD_BRANCH);
    expect(task.agentProfile?.instructions).toBe(DIALOG_PROFILE_INSTRUCTIONS);

    const expectedBaseRef = gitOutput(projectDir, ["rev-parse", HEAD_BRANCH]);
    expect(gitOutput(projectDir, ["rev-parse", "--verify", expectedBaseRef])).toBeTruthy();

    // Overage warning label naming the profile's harness: not asserted here
    // — reaching it would require an instructions/prompt combination large
    // enough to trip `promptByteOverage` for claude-code, which has no
    // meaningfully small cap to aim at deterministically (unlike gemini's
    // 4096-byte argv budget) without an unreasonably large fixture string.
  });

  test("Escape closes the profile popover first, a second Escape closes the dialog underneath it", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    const picker = issueTaskDialog.getByTestId("agent-profile-picker");
    await picker.getByTestId("agent-profile-picker-trigger").click();
    const popover = picker.getByTestId("agent-profile-picker-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute("data-popover-open", "");

    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(issueTaskDialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  });
});
