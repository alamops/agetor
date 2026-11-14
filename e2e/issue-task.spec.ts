import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { dialogBranchPicker, gotoApp, openSelectProjects, selectBaseBranch } from "./helpers";
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
 * branch-from test's Branch picker. With Isolate on (the dialog's default),
 * discovery reads the selected ref's COMMITTED tree — the dialog's
 * `fileScope` carries `ref: baseRef || "HEAD"` (`src/shared/file-scope.ts`'s
 * `fileScopeForTask`, the same table `GET /agent-discovery`'s `branch` param
 * now honors as a git ref) rather than the live working tree — so these
 * fixtures must be committed, not just present on disk; needs no claude
 * binary — `CLAUDE_BUILTINS` (e.g. `/code-review`) are always listed
 * regardless.
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
const CONVERGE_TIMEOUT = 30_000;

let stub: GitHubStub;
let projectDir: string;
let extraRepoDir: string;
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
  // discoverMcpAndPluginExtensions (src/bun/commands.ts) read these off the
  // git ref the dialog's `fileScope` resolves to (with Isolate on, that's
  // `baseRef || "HEAD"`'s COMMITTED tree, not this working tree — see the
  // file header). A project skill's slash-invokable name is its folder name
  // (discoverSkills) — the SKILL.md frontmatter only needs `description:` —
  // and a project .mcp.json's `mcpServers` keys surface as `@name` mention
  // extensions (mcpServersToExtensions). COMMITTING these before the
  // `develop` branch below forks off `main` (so it inherits them too) is
  // load-bearing, not just tidy — an uncommitted fixture would be invisible
  // to a ref-scoped discovery read; committing incidentally also keeps `git
  // status` clean for the worktree machinery.
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
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The Git dialog keeps its last detail view across a close/reopen by design
  // (`GitHubDialog`'s view state survives a generic close), so a manage-row
  // test that navigates to Pipelines and back reopens straight onto the issue
  // detail — no Project combobox to drive. Wait for EITHER the list view's
  // combobox or the detail's "Work with Agetor" button, then navigate only in
  // the list case.
  const projectSelect = dialog.getByRole("combobox", { name: "Project" });
  const workButton = dialog.getByTestId("issue-work-with-agetor");
  await expect(projectSelect.or(workButton).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  if (await projectSelect.isVisible()) {
    if ((await projectSelect.inputValue()) !== projectDir) {
      await projectSelect.selectOption({ value: projectDir });
    }
    const issuesTab = dialog.getByRole("button", { name: "Issues", exact: true });
    await issuesTab.click();
    const row = dialog.getByRole("button", { name: `#${ISSUE_NUMBER} ${ISSUE_TITLE}` });
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await row.click();
    // Detail subpage loaded — its header renders the issue's plain-text title
    // (GitHubDialog.tsx's `expandedItem.title` line).
    await expect(dialog.getByText(ISSUE_TITLE, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  }

  await expect(workButton).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await workButton.click();

  const issueTaskDialog = page.getByTestId("issue-task-dialog");
  await expect(issueTaskDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

  // The composer only mounts once BOTH the issue thread and the launch
  // pickers' harness statuses have loaded (`loading = launch.loading ||
  // threadLoading` in CreateTaskFromIssueDialog); `/harnesses` runs a probe
  // per harness, which under parallel-run load outlasts the 5s default.
  const promptTextarea = issueTaskDialog.getByTestId("prompt-textarea");
  await expect(promptTextarea).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(async () => {
    const value = await promptTextarea.inputValue();
    expect(value).toContain(`Issue #${ISSUE_NUMBER}`);
    expect(value).toContain(COMMENT_1_BODY);
  }).toPass({ timeout: CONVERGE_TIMEOUT });

  return issueTaskDialog;
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  extraRepoDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  await registerProject(backend.apiBase, backend.apiToken, extraRepoDir);
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
  // Pipeline fixtures: pipeline first (profiles/harnesses may be in use by a
  // running step otherwise), then profiles, then the throwaway harness.
  for (const fixture of pipelineFixtures.splice(0)) {
    await fetch(`${backend.apiBase}/pipelines/${fixture.pipelineId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${backend.apiToken}` },
    }).catch(() => { /* best-effort cleanup */ });
    for (const profileId of fixture.profileIds) {
      await fetch(`${backend.apiBase}/agent-profiles/${profileId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${backend.apiToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
    for (const harnessId of fixture.harnessIds) {
      await fetch(`${backend.apiBase}/harnesses/${harnessId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${backend.apiToken}` },
      }).catch(() => { /* best-effort cleanup */ });
    }
  }
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(extraRepoDir, { recursive: true, force: true });
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
  pipelineId: string | null;
  agentProfileId: string | null;
  pipelineRun: { status: string } | null;
  repositories?: { path: string; name: string }[];
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
    pipelineId?: string | null;
    agentProfileId?: string | null;
    pipelineRun?: { status: string } | null;
    repositories?: { path: string; name: string }[];
  }>;
  const row = rows.find((r) => r.title === title);
  if (!row) return null;
  return {
    ...row,
    pipelineId: row.pipelineId ?? null,
    agentProfileId: row.agentProfileId ?? null,
    pipelineRun: row.pipelineRun ?? null,
  };
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

// ---------------------------------------------------------------------------
// Pipeline fixtures (REST)
//
// Copied in shape from `e2e/pipelines-run.spec.ts`'s own helpers rather than
// imported — this repo's specs deliberately don't cross-import (see
// `resolve-conflicts.spec.ts`'s file header). Every fixture this spec creates
// is tracked and best-effort-deleted in `afterAll` (the worker-shared backend
// outlives the spec file).
// ---------------------------------------------------------------------------

interface PipelineFixture {
  pipelineId: string;
  profileIds: string[];
  harnessIds: string[];
}

const pipelineFixtures: PipelineFixture[] = [];

function trackPipelineFixture(pipelineId: string, profileIds: string[] = [], harnessIds: string[] = []): void {
  pipelineFixtures.push({ pipelineId, profileIds, harnessIds });
}

function authHeaders(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function createProfileRest(
  backend: E2EBackend,
  name: string,
  harness: string = "claude-code",
): Promise<string> {
  const res = await fetch(`${backend.apiBase}/agent-profiles`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({ name, harness, model: "opus-5", instructions: "", skills: [] }),
  });
  if (!res.ok) throw new Error(`POST /agent-profiles -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** A non-builtin harness whose `bin` points at a path that cannot exist —
 *  deterministically `available: false` regardless of what the machine
 *  running the suite has installed (helper mirrored from
 *  `agent-profiles-dialogs.spec.ts`). `label` is caller-supplied so more than
 *  one test in this spec can register one without making a role locator
 *  ambiguous (the fixtures outlive their test; cleanup is in `afterAll`). */
async function createUnavailableHarnessRest(
  backend: E2EBackend,
  label = "Deliberately Unavailable Harness",
): Promise<string> {
  const id = `e2e-issue-task-unavailable-${Date.now()}`;
  const res = await fetch(`${backend.apiBase}/harnesses`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({
      id,
      kind: "claude-code",
      label,
      bin: "/nonexistent/agetor-e2e-issue-task/no-such-binary",
    }),
  });
  if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

function makeStep(input: { id: string; name: string; agentProfileId: string | null }) {
  return {
    id: input.id,
    name: input.name,
    instructions: "",
    agentProfileId: input.agentProfileId,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose" as const,
    join: "any" as const,
  };
}

async function createPipelineRest(
  backend: E2EBackend,
  name: string,
  steps: ReturnType<typeof makeStep>[],
  edges: { from: string; to: string }[] = [],
): Promise<string> {
  const res = await fetch(`${backend.apiBase}/pipelines`, {
    method: "POST",
    headers: authHeaders(backend),
    body: JSON.stringify({
      name,
      description: "",
      graph: {
        steps,
        edges: edges.map((e, i) => ({ id: `edge-${i}-${steps[0]?.id ?? "none"}`, from: e.from, to: e.to, label: "" })),
        startStepId: steps[0]?.id ?? null,
      },
    }),
  });
  if (!res.ok) throw new Error(`POST /pipelines -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Selects `pipelineId` in the dialog's Pipeline picker. */
async function pickPipeline(dialog: Locator, pipelineId: string): Promise<void> {
  const picker = dialog.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker");
  await picker.getByTestId("pipeline-picker-trigger").click();
  const popover = picker.getByTestId("pipeline-picker-popover");
  await expect(popover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await popover.locator(`[data-testid="pipeline-picker-row"][data-pipeline-id="${pipelineId}"]`).click();
  await expect(popover).toBeHidden();
}

/** Opens the Pipeline picker's popover so its "Manage pipelines…" row is
 *  clickable. */
async function openPipelineManageRow(dialog: Locator): Promise<Locator> {
  const picker = dialog.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker");
  await picker.getByTestId("pipeline-picker-trigger").click();
  const popover = picker.getByTestId("pipeline-picker-popover");
  await expect(popover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  const manage = popover.getByTestId("pipeline-picker-manage");
  await expect(manage).toBeVisible();
  return manage;
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
    // is a fixed-position overlay (default 720px wide) that can sit on top of a board card in
    // a narrow test viewport, which would otherwise intercept the click. The
    // panel never unmounts (App.tsx keeps it mounted and slides it off with
    // a `translate-x-full` CSS transform), so `toBeHidden()` never fires —
    // wait for that class instead, which is what actually clears it from the
    // click's hit-test.
    //
    // Close via the header button, NOT `keyboard.press("Escape")`: the
    // panel's document-level Escape listener is gated on RunPanel's `open`
    // state, which flips true only in a requestAnimationFrame scheduled a
    // render after `mountedTask` commits (mount at translate-x-full, then
    // animate in). The textarea/view-issue visibility waits above resolve
    // before that rAF fires — `toBeVisible()` ignores transforms — so under
    // full-suite CPU load a single Escape can land in the window where no
    // listener is attached yet and the panel never closes (observed as a
    // 20s timeout load-flake). The button's `onClick={onClose}` is wired
    // unconditionally on an always-rendered element, so the click is
    // race-free regardless of rAF timing (same pattern as
    // unread-indicator.spec.ts).
    //
    // The header X ("Close task details"), NOT the backdrop scrim: the scrim
    // spans the whole viewport but the resizable panel `<aside>` overlays an
    // arbitrary share of it, so any scrim click coordinate is silently
    // coupled to the panel width and the test viewport. The header X lives
    // INSIDE the panel, so the panel can never occlude it.
    await panel.getByRole("button", { name: "Close task details" }).click();
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

  test("select projects: the issue's repository is locked and an extra repo is added", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // The old separate "Repositories / Manage" control is gone: the same
    // full-width Select Projects button New Task uses is the only surface.
    await expect(issueTaskDialog.getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
    await issueTaskDialog.getByTestId("select-projects-button").click();
    const reposDialog = page.getByRole("dialog", { name: "Select projects" });
    await expect(reposDialog).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // The issue's own repository is pinned by `lockedPath`: it starts
    // checked, can't be unchecked, and its remove button is disabled.
    const locked = reposDialog.getByLabel(`Select ${projectDir}`, { exact: true });
    await expect(locked).toBeChecked();
    await expect(locked).toBeDisabled();
    await expect(reposDialog.getByLabel(`Remove ${projectDir}`, { exact: true })).toBeDisabled();
    await locked.click({ force: true }).catch(() => {});
    await expect(locked).toBeChecked();

    await reposDialog.getByLabel(`Select ${extraRepoDir}`, { exact: true }).check();
    await reposDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(reposDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(issueTaskDialog.getByTestId("select-projects-button")).toContainText("2 projects selected");
    // Two projects force (and disable) worktree isolation.
    await expect(issueTaskDialog.getByTestId("isolate-toggle")).toBeChecked();
    await expect(issueTaskDialog.getByTestId("isolate-toggle")).toBeDisabled();

    await expect(issueTaskDialog.getByTestId("issue-task-submit")).toBeEnabled({
      timeout: CONVERGE_TIMEOUT,
    });
    await issueTaskDialog.getByTestId("issue-task-submit").click();

    // Poll for THIS task (the baseline scenario shares its title): the set
    // must stay issue-repo-first and include the extra repository.
    let taskId: string | null = null;
    await expect(async () => {
      const res = await request.get(`${backend.apiBase}/tasks`, {
        headers: { authorization: `Bearer ${backend.apiToken}` },
      });
      expect(res.ok()).toBeTruthy();
      const rows = (await res.json()) as Array<{ id: string; repositories?: { path: string }[] }>;
      taskId = rows.find((r) => r.repositories?.some((repo) => repo.path === extraRepoDir))?.id ?? null;
      expect(taskId).not.toBeNull();
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    const task = (await res.json()) as { repositories?: { path: string }[] };
    expect(task.repositories?.map((repo) => repo.path)).toEqual([projectDir, extraRepoDir]);

    createdTaskIds.push(taskId!);
    await deleteTask(request, backend, taskId!);
    createdTaskIds.splice(createdTaskIds.indexOf(taskId!), 1);
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

    // The issue repo's branch picker lives under its row in the Select
    // Projects dialog (nested in this one). Its trigger carries this exact
    // tooltip while isolated (SelectProjectsDialog.tsx's BASE_REF_TITLE).
    const projects = await openSelectProjects(page, issueTaskDialog);
    const branchTrigger = projects.getByTitle(BRANCH_PICKER_TITLE);
    await branchTrigger.click();

    const search = projects.getByPlaceholder("Search branches…");
    await expect(search).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await search.fill("develop");

    const popover = projects.locator("[data-popover-open]");
    const developRow = popover.locator("button").filter({ hasText: "develop" }).first();
    await expect(developRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await developRow.click();
    await projects.getByRole("button", { name: "Save", exact: true }).click();
    await expect(projects).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(worktreeOptions.getByTestId("selected-branches")).toContainText("develop");

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
    // `plantPicks` clears the (worker-shared) dir first, so an earlier
    // spec's leftover files can't leak into this test's chip-count
    // assertions.
    await backend.plantPicks({ "notes.md": "notes\n", "spec.txt": "spec\n" });

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // Expand the (initially collapsed, since references start empty) refs
    // section before poking at its buttons/dropzone.
    const summary = issueTaskDialog.getByTestId("refs-summary");
    await summary.click();

    const dropzone = issueTaskDialog.getByTestId("refs-dropzone-expandable");
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

  // -------------------------------------------------------------------------
  // Pipeline picker (docs/plans/pipeline-picker-git-modals.md)
  // -------------------------------------------------------------------------

  test("pipeline picker: summary, one selection, create & start as a pipeline parent, task-count refresh", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    const suffix = Date.now();
    const pipelineName = `E2E issue pipeline ${suffix}`;
    const profileId = await createProfileRest(backend, `E2E issue pipeline profile ${suffix}`);
    const pipelineId = await createPipelineRest(backend, pipelineName, [
      makeStep({ id: `step-${suffix}`, name: "Plan", agentProfileId: profileId }),
    ]);
    trackPipelineFixture(pipelineId, [profileId]);

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // Baseline: the Agent picker is visible and there's no pipeline summary.
    await expect(issueTaskDialog.getByText("Agent", { exact: true })).toBeVisible();
    await expect(issueTaskDialog.getByTestId("launch-pipeline-summary")).toHaveCount(0);
    await expect(issueTaskDialog.getByTestId("launch-pipeline-picker")).toBeVisible();

    // One-selection: picking a profile first, then a pipeline, drops the
    // profile card (the Agent block disappears entirely behind the summary).
    const agentPicker = issueTaskDialog.getByTestId("agent-profile-picker");
    await agentPicker.getByTestId("agent-profile-picker-trigger").click();
    await agentPicker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${profileId}"]`).click();
    // The picker's own trigger renders a chip with the same test id, so the
    // selected card is the last one.
    await expect(issueTaskDialog.getByTestId("agent-profile-card").last()).toBeVisible();

    await pickPipeline(issueTaskDialog, pipelineId);

    const summary = issueTaskDialog.getByTestId("launch-pipeline-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(pipelineName);
    await expect(summary).toContainText("1 step");
    await expect(summary).toContainText("starts with");
    await expect(issueTaskDialog.getByTestId("agent-profile-card")).toHaveCount(0);
    await expect(issueTaskDialog.getByText("Agent", { exact: true })).toHaveCount(0);
    await expect(issueTaskDialog.getByTestId("launch-pipeline-problem")).toHaveCount(0);

    // Change clears the selection and restores the Agent block.
    await summary.getByTestId("launch-pipeline-change").click();
    await expect(issueTaskDialog.getByTestId("launch-pipeline-summary")).toHaveCount(0);
    await expect(issueTaskDialog.getByText("Agent", { exact: true })).toBeVisible();
    // The profile picked before the pipeline stays cleared — Change restores
    // the manual block, not the profile it replaced (New Task parity).
    await expect(issueTaskDialog.getByTestId("agent-profile-card")).toHaveCount(0);
    await expect(
      issueTaskDialog.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker-trigger"),
    ).toContainText("No pipeline");

    // Re-pick and submit.
    await pickPipeline(issueTaskDialog, pipelineId);
    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitCreatedTask(request, backend, CARD_TITLE);
    await expect(async () => {
      const row = await findTaskByTitle(request, backend, CARD_TITLE);
      expect(row?.pipelineId).toBe(pipelineId);
      // The body never carries both ids; the server records no profile on a
      // pipeline parent.
      expect(row?.agentProfileId ?? null).toBeNull();
      expect(row?.pipelineRun ?? null).not.toBeNull();
      // The issue metadata rides along unchanged.
      expect(row?.issueUrl).toBe(ISSUE_HTML_URL);
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    // `createAndStartTask` fires `refreshPipelines()` after a pipeline
    // create, so the Pipelines page's server-derived task count is current.
    // Dispatch instead of click: the parent run legitimately raises a sticky
    // "Pipeline needs you" toast in the header's top-right corner, which sits
    // over both the dialog's Close button and the header Pipelines button.
    const gitDialog = page.getByRole("dialog");
    await gitDialog.getByRole("button", { name: "Close", exact: true }).dispatchEvent("click");
    await expect(gitDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await page.getByTestId("pipelines-button").dispatchEvent("click");
    await expect(page.getByTestId("pipelines-page")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const pipelineRow = page.locator(`[data-testid="pipelines-row"][data-pipeline-id="${pipelineId}"]`);
    await expect(async () => {
      await expect(pipelineRow).toContainText("Used by 1 task");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    await deleteTask(request, backend, task.id);
    createdTaskIds.splice(createdTaskIds.indexOf(task.id), 1);
  });

  test("pipeline picker: an unrunnable pipeline is listed but blocks Create & start", async ({ page, backend }) => {
    test.setTimeout(90_000);
    const suffix = Date.now();
    const pipelineName = `E2E unrunnable pipeline ${suffix}`;
    // A saved graph may have a step with no profile (an editor draft) — the
    // server rejects it at task-create, and the dialog must block first.
    const pipelineId = await createPipelineRest(backend, pipelineName, [
      makeStep({ id: `step-${suffix}`, name: "Plan", agentProfileId: null }),
    ]);
    trackPipelineFixture(pipelineId);

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);
    await pickPipeline(issueTaskDialog, pipelineId);

    const problem = issueTaskDialog.getByTestId("launch-pipeline-problem");
    await expect(problem).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(problem).toContainText('step "Plan" has no agent');
    await expect(issueTaskDialog.getByTestId("issue-task-submit")).toBeDisabled();

    // Clearing the pipeline restores a normal single-agent launch.
    await issueTaskDialog.getByTestId("launch-pipeline-change").click();
    await expect(problem).toHaveCount(0);
    await expect(issueTaskDialog.getByTestId("issue-task-submit")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  });

  test("pipeline picker: the start-step harness — not the manual picker — decides availability", async ({
    page,
    backend,
  }) => {
    test.setTimeout(90_000);
    const suffix = Date.now();
    const harnessId = await createUnavailableHarnessRest(backend);
    const profileId = await createProfileRest(backend, `E2E unavailable harness profile ${suffix}`, harnessId);
    const pipelineName = `E2E unavailable harness pipeline ${suffix}`;
    const pipelineId = await createPipelineRest(backend, pipelineName, [
      makeStep({ id: `step-${suffix}`, name: "Plan", agentProfileId: profileId }),
    ]);
    trackPipelineFixture(pipelineId, [profileId], [harnessId]);

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // The manual picker (claude-code, available in the fixture env) would
    // pass — the pipeline's own start-step harness must still block it.
    await pickPipeline(issueTaskDialog, pipelineId);
    const problem = issueTaskDialog.getByTestId("launch-pipeline-problem");
    await expect(problem).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(problem).toContainText("Deliberately Unavailable Harness is not available");
    await expect(issueTaskDialog.getByTestId("issue-task-submit")).toBeDisabled();

    // Change restores the manual launch, which stays enabled in the same
    // dialog — proving the effective identity is the start-step profile's.
    await issueTaskDialog.getByTestId("launch-pipeline-change").click();
    await expect(problem).toHaveCount(0);
    await expect(issueTaskDialog.getByTestId("issue-task-submit")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  });

  test("pipeline picker: an available start-step harness overrides an unavailable manual pick", async ({
    page,
    backend,
  }) => {
    // The mirror image of the test above, and the one that can actually fail
    // if the launch identity regresses to the hidden manual picker: the
    // PREFLIGHT alone would still block the unavailable-pipeline case, so
    // only a pipeline that is runnable while the manual pick is not proves
    // `effectiveStatus`/`canSubmit` read the start-step profile.
    test.setTimeout(90_000);
    const suffix = Date.now();
    const manualHarnessLabel = `Deliberately Unavailable Manual Harness ${suffix}`;
    const harnessId = await createUnavailableHarnessRest(backend, manualHarnessLabel);
    // The pipeline's start profile uses the available built-in claude-code
    // harness (the fixture env runs the fake claude driver).
    const profileId = await createProfileRest(backend, `E2E available start profile ${suffix}`);
    const pipelineName = `E2E available start pipeline ${suffix}`;
    const pipelineId = await createPipelineRest(backend, pipelineName, [
      makeStep({ id: `step-${suffix}`, name: "Plan", agentProfileId: profileId }),
    ]);
    trackPipelineFixture(pipelineId, [profileId], [harnessId]);

    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);

    // Manually pick the deterministically unavailable harness: a plain
    // single-agent launch must be blocked by it.
    await issueTaskDialog.getByRole("button", { name: manualHarnessLabel }).click();
    const hint = issueTaskDialog.getByTestId("launch-agent-unavailable-hint");
    await expect(hint).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(hint).toContainText("not found on PATH");
    const submit = issueTaskDialog.getByTestId("issue-task-submit");
    await expect(submit).toBeDisabled();

    // Picking a pipeline whose start profile uses an AVAILABLE harness must
    // clear that block: the pipeline's start-step profile is the effective
    // launch identity, so the hidden manual pick's unavailable harness is
    // irrelevant. A regression that kept gating on `selectedStatus` (or on
    // the manual `agent`) would leave submit disabled here.
    await pickPipeline(issueTaskDialog, pipelineId);
    await expect(issueTaskDialog.getByTestId("launch-pipeline-problem")).toHaveCount(0);
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });

    // Change drops the pipeline and returns to the still-unavailable manual
    // harness — submit is blocked again, so the enabled state above really
    // came from the pipeline, not from a stale enabled button.
    await issueTaskDialog.getByTestId("launch-pipeline-change").click();
    await expect(submit).toBeDisabled();
  });

  test("pipeline picker: Manage pipelines closes both dialogs, confirming a dirty draft first", async ({ page, backend }) => {
    test.setTimeout(90_000);
    await gotoApp(page, backend.bootBase);

    // Dirty: a typed prompt asks before discarding.
    let issueTaskDialog = await openIssueTaskDialog(page);
    await issueTaskDialog.getByTestId("prompt-textarea").fill("draft that must not be lost silently");
    let manage = await openPipelineManageRow(issueTaskDialog);
    await manage.click();

    const confirmTitle = page.getByText("Discard this task draft and open Pipelines?");
    const confirmDialog = page
      .locator('[role="dialog"]')
      .filter({ has: page.getByText("Discard this task draft and open Pipelines?") });
    await expect(confirmTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmTitle).toBeHidden();
    await expect(issueTaskDialog).toBeVisible();
    await expect(page.getByTestId("pipelines-page")).toHaveCount(0);

    // Confirming navigates and closes both stacked dialogs first.
    manage = await openPipelineManageRow(issueTaskDialog);
    await manage.click();
    await expect(confirmTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await confirmDialog.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipelines-page")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Clean: a fresh dialog goes straight through, no confirm.
    await page.getByTestId("pipelines-back").click();
    await expect(page.getByTestId("pipelines-page")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    issueTaskDialog = await openIssueTaskDialog(page);
    // Open Select Projects, let BranchPicker's automatic "preselect the
    // current branch" seed (`main`) land, and Save without touching it: the
    // seed is dropped on Save, so it must not count as a user edit, or a
    // pristine draft would ask "Discard…?" here.
    const projects = await openSelectProjects(page, issueTaskDialog);
    await expect(dialogBranchPicker(projects, projectDir).getByTitle(BRANCH_PICKER_TITLE)).toContainText("main", {
      timeout: CONVERGE_TIMEOUT,
    });
    await projects.getByRole("button", { name: "Save", exact: true }).click();
    await expect(projects).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(issueTaskDialog.getByTestId("selected-branches")).toContainText("current branch");
    manage = await openPipelineManageRow(issueTaskDialog);
    await manage.click();
    await expect(issueTaskDialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipelines-page")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("pipeline picker: a user-picked base ref counts as a dirty draft", async ({ page, backend }) => {
    test.setTimeout(90_000);
    await gotoApp(page, backend.bootBase);
    const issueTaskDialog = await openIssueTaskDialog(page);
    const summary = issueTaskDialog.getByTestId("worktree-options").getByTestId("selected-branches");

    // BranchPicker's automatic "preselect the current branch" seed must not
    // count as a user edit (covered by the clean case above), but a ref the
    // user picks themselves and saves must: only picks are saved, and a saved
    // ref is what sets `refDirty`.
    await selectBaseBranch(page, issueTaskDialog, projectDir, "develop");
    await expect(summary).toContainText("develop", { timeout: CONVERGE_TIMEOUT });

    const manage = await openPipelineManageRow(issueTaskDialog);
    await manage.click();
    await expect(page.getByText("Discard this task draft and open Pipelines?")).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    // Cancel keeps the dialog and the picked ref.
    const confirmDialog = page
      .locator('[role="dialog"]')
      .filter({ has: page.getByText("Discard this task draft and open Pipelines?") });
    await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(issueTaskDialog).toBeVisible();
    await expect(summary).toContainText("develop");
  });
});
