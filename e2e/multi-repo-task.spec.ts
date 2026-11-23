import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import {
  branchRow,
  chooseProjects,
  gotoApp,
  selectBaseBranch,
  selectProjectsDialog,
} from "./helpers";
import { githubRepoRoutes, startGitHubStub, type StubRequest, type StubRoute } from "./github-stub";
import { uniqueRepoSlugs } from "../src/shared/multi-repo.ts";

/**
 * E2E coverage for multi-repository tasks (issue #291).
 *
 * Arrange: two throwaway git repos, registered through the real
 * `POST /projects`. The FIRST scenario creates the multi-repository task
 * through the real New Task form's combined Select Projects control (pick
 * both repositories, then a non-current base ref in each project's own branch
 * picker inside the same dialog), then "Run task" starts it — so the multi selection, the
 * per-project refs and the create payload are exercised end to end, not just
 * through `POST /tasks`. The worker backend already runs the fake claude
 * driver, so the start materializes one worktree per repository without a real
 * CLI.
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
 * 10. Create all PRs opens one PR per repository from the confirm list: each
 *     PR carries its own repository's proposed title and body, targets the base
 *     the task was created from (not the repo default), and `Closes #N` lands
 *     only on the issue's repository (S1).
 * 11. A task branch reset off its stored base targets the agent's base (S2).
 * 12. Extra heads: a proposal for another branch is an unchecked row, enabled
 *     only when the forge lists it (S3).
 * 13. A single-repository task with two heads gets Create all PRs and a header
 *     menu of its PRs (S4).
 * 14. Create all PRs is per-repository best effort, and a reloaded retry shows
 *     an "already exists" answer as already open (S5).
 * 15. The single Create PR chip prefills the composer's base (S6).
 * 16. The Commit & push chip's message names the base the task was created
 *     from and asks for a link that targets it (C3), single- and
 *     multi-repository.
 *
 * The proposals come from the fake claude driver's PR-proposal marker: a
 * literal copy of `FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER` (specs can't import
 * from `src/bun/*`) followed by a base64url reply template whose
 * `{{branch:<repo>}}` placeholders the driver resolves from the task row.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 30_000;
const TITLE = "Multi repository e2e";

let repoA: string;
let repoB: string;
let repoSibling: string;
/** A non-current branch created in both repos: a row wired to nothing would
 *  still show the current branch, so only a different ref proves the per-project
 *  picker reaches the create payload. */
const TOPIC_BRANCH = "topic";
let topicShaA: string;
let topicShaB: string;
let taskId: string;
let singleTaskId: string;

interface TaskPrRow {
  url: string;
  head: string | null;
  base: string | null;
  number: number | null;
}

interface TaskRepositoryRow {
  path: string;
  name: string;
  branch: string | null;
  baseRef: string | null;
  baseBranch?: string | null;
  worktreePath: string | null;
  prs?: TaskPrRow[];
  prUrl?: string | null;
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
  opts: {
    title: string;
    issueUrl?: string;
    /** The task-level base ref both repositories start from. */
    baseRef?: string;
    /** Task prompt (a PR-proposal marker rides here). */
    prompt?: string;
    /** Runs after the branches are pushed and before the sync wait, e.g. to move a branch. */
    afterPush?: (task: TaskRow) => void;
  },
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
      prompt: opts.prompt ?? "p",
      agent: "claude-code",
      isolation: "worktree",
      repositories: [{ path: repoA }, { path: repoB }],
      ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
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
  opts.afterPush?.(task);
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

/** A literal copy of `FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER` (src/bun/agents.ts). */
const PR_PROPOSAL_MARKER = "__agetor_fake_claude_pr_proposal__";

/** A task prompt that makes the fake claude driver print `template` (with `{{branch…}}` placeholders resolved). */
function proposalPrompt(template: string): string {
  return `make the change ${PR_PROPOSAL_MARKER}:${Buffer.from(template, "utf8").toString("base64url")}`;
}

/** One proposal block in the shape `commitPushPrompt` asks the agent for. */
function proposalBlock(o: { repo?: string; base: string; link: string; title: string; body: string }): string {
  return [
    ...(o.repo ? [`Repository: ${o.repo}`] : []),
    `Base: ${o.base}`,
    o.link,
    "PR title:",
    "```",
    o.title,
    "```",
    "PR description:",
    "````",
    o.body,
    "````",
    "",
  ].join("\n");
}

interface PullRecord {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/**
 * Stub routes for one e2e repository: the repo-level reads Create all PRs makes
 * (default branch, branch listing) plus a `POST …/pulls` that records the body.
 */
function repoStubRoutes(
  repo: "frontend" | "backend",
  records: PullRecord[],
  firstNumber: number,
  branches: Record<string, string>,
): StubRoute[] {
  return [
    ...githubRepoRoutes("agetor-e2e", repo, { defaultBranch: "main", branches }),
    {
      method: "POST",
      path: new RegExp(`^/repos/agetor-e2e/${repo}/pulls$`),
      body: (req: StubRequest) => {
        records.push(req.body as PullRecord);
        const number = firstNumber + records.length - 1;
        return { number, title: `${repo} PR`, state: "open", html_url: `https://github.com/agetor-e2e/${repo}/pull/${number}` };
      },
    },
  ];
}

const FAKE_TIP = "f".repeat(40);

async function getTaskRow(request: APIRequestContext, backend: E2EBackend, id: string) {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  return (await res.json()) as TaskRow & { prs?: TaskPrRow[]; prUrl?: string | null; baseBranch?: string | null };
}

/**
 * Create a single-repository task on `repoA`, start it, push its worktree branch
 * to a throwaway local bare remote, and wait for the git-status poll to report
 * it synced. The GitHub-shaped `origin` comes from beforeAll.
 */
async function createPushedSingleTask(
  request: APIRequestContext,
  backend: E2EBackend,
  opts: { title: string; prompt?: string; baseRef?: string },
): Promise<{ taskId: string; branch: string; bareDir: string }> {
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const bare = await mkdtemp(path.join(tmpdir(), "agetor-e2e-bare-single-"));
  git(bare, ["init", "-q", "--bare"]);
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title: opts.title,
      prompt: opts.prompt ?? "p",
      agent: "claude-code",
      workdir: repoA,
      isolation: "worktree",
      ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as TaskRow).id;
  const started = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => (await getTaskRow(request, backend, id)).worktreePath, { timeout: CONVERGE_TIMEOUT })
    .not.toBeNull();
  const row = (await getTaskRow(request, backend, id)) as TaskRow & { branch: string };
  setLocalRemote(row.worktreePath!, bare);
  git(row.worktreePath!, ["push", "-q", "-u", "local", row.branch]);
  await expect
    .poll(async () => {
      const status = await request.get(`${backend.apiBase}/tasks/${id}/git-status`, { headers: auth });
      return ((await status.json()) as { remoteSynced?: boolean }).remoteSynced ?? false;
    }, { timeout: CONVERGE_TIMEOUT })
    .toBe(true);
  return { taskId: id, branch: row.branch, bareDir: bare };
}

test.beforeAll(async ({ backend, request }) => {
  repoA = await initRepo("frontend");
  repoB = await initRepo("backend");
  // A commit that exists only on `topic` in each repository: with the branch
  // pointing at `main`, a baseRef wired to HEAD would produce the same sha and
  // the payload assertion would pass by accident.
  for (const [dir, name] of [[repoA, "frontend"], [repoB, "backend"]] as const) {
    git(dir, ["checkout", "-q", "-b", TOPIC_BRANCH]);
    await writeFile(path.join(dir, `${name}-topic.txt`), `${name} topic\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", `${name} topic`]);
    git(dir, ["checkout", "-q", "main"]);
  }
  topicShaA = git(repoA, ["rev-parse", TOPIC_BRANCH]);
  topicShaB = git(repoB, ["rev-parse", TOPIC_BRANCH]);
  expect(topicShaA).not.toBe(git(repoA, ["rev-parse", "main"]));
  expect(topicShaB).not.toBe(git(repoB, ["rev-parse", "main"]));
  expect(topicShaA).not.toBe(topicShaB);
  // A registered path under repoA's git root. Selecting it alongside repoA in
  // the dialog must collapse to one repository (dedupeSelections), which the
  // first scenario asserts by still creating a two-repository task.
  repoSibling = path.join(repoA, "packages", "feature");
  await mkdir(repoSibling, { recursive: true });
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

test("create via the real UI: Select Projects sends both repos and start materializes both worktrees", async ({ backend, page, request }) => {
  await gotoApp(page, backend.bootBase);
  const form = page.locator("aside").first();

  await form.getByPlaceholder("Short description").fill(TITLE);
  await form.getByTestId("prompt-textarea").fill("make the change");

  // The combined control is the only project surface. `chooseProjects` clears
  // every row the auto-select may have checked, then checks the requested set
  // in order (the first path wins a same-git-root dedupe), so the resulting
  // selection is deterministic across the shared worker backend.
  await chooseProjects(page, form, [repoA, repoB, repoSibling]);
  const button = form.getByTestId("select-projects-button");
  await expect(button).toContainText("2 projects selected");
  const dialog = selectProjectsDialog(page);

  // Each project's base ref is picked in its own branch picker inside the
  // Select Projects dialog; the form shows one read-only summary line each.
  await expect(dialog).toBeHidden();
  const names = uniqueRepoSlugs([repoA, repoB]);
  await expect(form.locator('[data-testid^="branch-row-"]')).toHaveCount(2);
  await selectBaseBranch(page, form, repoA, TOPIC_BRANCH);
  await selectBaseBranch(page, form, repoB, TOPIC_BRANCH);
  await expect(branchRow(form, names[0]!)).toContainText(TOPIC_BRANCH);
  await expect(branchRow(form, names[1]!)).toContainText(TOPIC_BRANCH);

  // 2+ projects force and disable Isolate.
  const isolate = form.getByTestId("isolate-toggle");
  await expect(isolate).toBeChecked();
  await expect(isolate).toBeDisabled();

  const runButton = form.getByRole("button", { name: "Run task", exact: true });
  await expect(runButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await runButton.click();

  const created = await awaitTask(request, backend, TITLE);
  taskId = created.id;
  expect(created.repositories.map((r) => r.path)).toEqual([repoA, repoB]);
  expect(created.repositories.map((r) => r.baseRef)).toEqual([topicShaA, topicShaB]);

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
  // One badge per repository row. Address the badge directly: the row also
  // renders the repository's project label (the same basename here), so a
  // plain text lookup is ambiguous by design.
  const repoBadges = dialog.getByTitle("Repository in this task's workspace");
  for (const name of uniqueRepoSlugs([repoA, repoB])) {
    await expect(repoBadges.filter({ hasText: name })).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
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

test("opened Task details (the repository list included) never push the send box below the fold", async ({ backend, page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await gotoApp(page, backend.bootBase);
  await page.getByText("Multi repository e2e", { exact: true }).first().click();
  const send = page.getByTestId("send-textarea");
  await expect(send).toBeInViewport({ timeout: CONVERGE_TIMEOUT });
  await page.locator("summary", { hasText: "Task details" }).click();
  await expect(page.getByTestId("task-details-repositories")).toBeAttached();
  // The details scroll on their own (capped at 45% of the window) and give up
  // height first, so the send box stays fully on screen.
  const scroller = page.getByTestId("task-details-scroll");
  expect((await scroller.boundingBox())!.height).toBeLessThanOrEqual(640 * 0.45 + 1);
  await expect(send).toBeInViewport({ ratio: 1 });
  await page.getByTestId("task-details-repositories").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("task-details-repositories")).toBeInViewport();
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

/** The confirm-list test-id slug for a row (mirrors `prRowSlug` in src/mainview/lib/pr-plan.ts). */
function rowSlug(repoName: string, head: string): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${slug(repoName)}-${slug(head)}`;
}

/** Open the task's panel and the Create-PRs confirm list once its plan has loaded. */
async function openCreatePrsDialog(page: Page, backend: E2EBackend, title: string) {
  await gotoApp(page, backend.bootBase);
  await page.getByText(title, { exact: true }).first().click();
  const button = page.getByTestId("create-all-prs");
  await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(button).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await button.click();
  const dialog = page.getByTestId("create-prs-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("create-prs-loading")).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  return dialog;
}

test("Create all PRs: each PR gets its own repository's title and body, targets the task's base branch, and Closes goes only on the issue repository (S1)", async ({
  backend,
  page,
  request,
}) => {
  // The reported bug, end to end: the PR title/body came from the wrong
  // proposal, and the base was always the repo default. Both repositories were
  // created from `topic`, so every POST must say `base: "topic"`, and each
  // POST must carry that repository's own proposal.
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const [feName, beName] = uniqueRepoSlugs([repoA, repoB]);
  const prTitle = "Multi repository PRs e2e";
  const fe: PullRecord[] = [];
  const be: PullRecord[] = [];
  const branches = { main: "a".repeat(40), [TOPIC_BRANCH]: "b".repeat(40) };
  const stub = await startGitHubStub(backend.githubStubPort, [
    ...repoStubRoutes("frontend", fe, 11, branches),
    ...repoStubRoutes("backend", be, 12, branches),
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const template =
      proposalBlock({
        repo: feName,
        base: TOPIC_BRANCH,
        link: `https://github.com/agetor-e2e/frontend/compare/${TOPIC_BRANCH}...{{branch:${feName}}}?quick_pull=1`,
        title: "Frontend proposal title",
        body: "Frontend proposal body",
      }) +
      proposalBlock({
        repo: beName,
        base: TOPIC_BRANCH,
        link: `https://github.com/agetor-e2e/backend/compare/${TOPIC_BRANCH}...{{branch:${beName}}}?quick_pull=1`,
        title: "Backend proposal title",
        body: "Backend proposal body",
      });
    const prepared = await createPushedMultiTask(request, backend, {
      title: prTitle,
      issueUrl: "https://github.com/agetor-e2e/frontend/issues/291",
      baseRef: TOPIC_BRANCH,
      prompt: proposalPrompt(template),
    });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const [feRepo, beRepo] = prepared.task.repositories;
    expect(feRepo!.baseBranch).toBe(TOPIC_BRANCH);
    expect(beRepo!.baseBranch).toBe(TOPIC_BRANCH);

    const dialog = await openCreatePrsDialog(page, backend, prTitle);
    const rows = dialog.locator('[data-testid^="create-prs-row-"]');
    await expect(rows).toHaveCount(2);
    const feSlug = rowSlug(feName!, feRepo!.branch!);
    const beSlug = rowSlug(beName!, beRepo!.branch!);
    await expect(dialog.getByTestId(`create-prs-title-${feSlug}`)).toHaveValue("Frontend proposal title");
    await expect(dialog.getByTestId(`create-prs-title-${beSlug}`)).toHaveValue("Backend proposal title");
    await expect(dialog.getByTestId(`create-prs-base-${feSlug}`)).toHaveValue(TOPIC_BRANCH);
    await expect(dialog.getByTestId(`create-prs-base-${beSlug}`)).toHaveValue(TOPIC_BRANCH);
    // The agetor/<id>-<slug> head makes the row label long; the base select
    // must still be wide enough to read, not squeezed to zero by the label.
    for (const slug of [feSlug, beSlug]) {
      const box = await dialog.getByTestId(`create-prs-base-${slug}`).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(100);
    }
    await expect(dialog.getByTestId(`create-prs-base-source-${feSlug}`)).toContainText("from the task");
    await expect(dialog.getByTestId("create-prs-submit")).toContainText("Create 2 pull requests");
    await dialog.getByTestId("create-prs-submit").click();

    await expect.poll(() => fe.length + be.length, { timeout: CONVERGE_TIMEOUT }).toBe(2);
    expect(fe[0]).toMatchObject({
      title: "Frontend proposal title",
      head: feRepo!.branch,
      base: TOPIC_BRANCH,
    });
    expect(be[0]).toMatchObject({
      title: "Backend proposal title",
      head: beRepo!.branch,
      base: TOPIC_BRANCH,
    });
    // Each body is its own repository's, and `Closes #291` is only on the issue's.
    expect(fe[0]!.body).toContain("Frontend proposal body");
    expect(fe[0]!.body).toContain("Closes #291");
    expect(be[0]!.body).toBe("Backend proposal body");

    await expect
      .poll(async () => (await getTaskRow(request, backend, prepared.taskId)).repositories.map((r) => r.prs?.length ?? 0), {
        timeout: CONVERGE_TIMEOUT,
      })
      .toEqual([1, 1]);
    const detail = await getTaskRow(request, backend, prepared.taskId);
    expect(detail.repositories[0]!.prs![0]).toMatchObject({
      url: "https://github.com/agetor-e2e/frontend/pull/11",
      head: feRepo!.branch,
      base: TOPIC_BRANCH,
      number: 11,
    });
    expect(detail.repositories[0]!.prUrl).toBe("https://github.com/agetor-e2e/frontend/pull/11");
    expect(detail.repositories[1]!.prs![0]!.url).toBe("https://github.com/agetor-e2e/backend/pull/12");
    expect(detail.prUrl).toBeNull();
    expect(detail.prs ?? []).toEqual([]);
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs: a task branch reset off its stored base targets the agent's base (S2)", async ({
  backend,
  page,
  request,
}) => {
  // Backend's branch is reset onto `main` after the task was created from
  // `topic`, so the pinned `topic` sha is no longer in its history: the stored
  // base is stale and the agent's `Base: main` wins. Frontend still contains its
  // pinned sha and keeps `topic`.
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const [feName, beName] = uniqueRepoSlugs([repoA, repoB]);
  const prTitle = "Multi repository stale base e2e";
  const fe: PullRecord[] = [];
  const be: PullRecord[] = [];
  // The forge's `topic` tip is an object the local repositories don't have, so
  // staleness rests on the pinned sha alone.
  const branches = { main: "a".repeat(40), [TOPIC_BRANCH]: FAKE_TIP };
  const stub = await startGitHubStub(backend.githubStubPort, [
    ...repoStubRoutes("frontend", fe, 31, branches),
    ...repoStubRoutes("backend", be, 32, branches),
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const template =
      proposalBlock({
        repo: feName,
        base: TOPIC_BRANCH,
        link: `https://github.com/agetor-e2e/frontend/compare/${TOPIC_BRANCH}...{{branch:${feName}}}?quick_pull=1`,
        title: "Frontend stale title",
        body: "Frontend stale body",
      }) +
      proposalBlock({
        repo: beName,
        base: "main",
        link: `https://github.com/agetor-e2e/backend/compare/main...{{branch:${beName}}}?quick_pull=1`,
        title: "Backend stale title",
        body: "Backend stale body",
      });
    const prepared = await createPushedMultiTask(request, backend, {
      title: prTitle,
      baseRef: TOPIC_BRANCH,
      prompt: proposalPrompt(template),
      afterPush: (task) => {
        const backend = task.repositories[1]!;
        git(backend.worktreePath!, ["reset", "-q", "--hard", "main"]);
        writeFileSync(path.join(backend.worktreePath!, "after-reset.txt"), "moved off topic\n");
        git(backend.worktreePath!, ["add", "."]);
        git(backend.worktreePath!, ["commit", "-q", "-m", "after reset"]);
        git(backend.worktreePath!, ["push", "-q", "-f", "local", backend.branch!]);
      },
    });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const [feRepo, beRepo] = prepared.task.repositories;

    const dialog = await openCreatePrsDialog(page, backend, prTitle);
    const feSlug = rowSlug(feName!, feRepo!.branch!);
    const beSlug = rowSlug(beName!, beRepo!.branch!);
    await expect(dialog.getByTestId(`create-prs-base-${feSlug}`)).toHaveValue(TOPIC_BRANCH);
    await expect(dialog.getByTestId(`create-prs-base-${beSlug}`)).toHaveValue("main");
    await expect(dialog.getByTestId(`create-prs-base-source-${beSlug}`)).toContainText("from the agent");
    await expect(dialog.getByTestId(`create-prs-hint-${beSlug}`).first()).toContainText("looks stale");
    await dialog.getByTestId("create-prs-submit").click();

    await expect.poll(() => fe.length + be.length, { timeout: CONVERGE_TIMEOUT }).toBe(2);
    expect(fe[0]!.base).toBe(TOPIC_BRANCH);
    expect(be[0]!.base).toBe("main");
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs: an extra head is an unchecked row, enabled only when the forge lists it (S3)", async ({
  backend,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const [feName, beName] = uniqueRepoSlugs([repoA, repoB]);
  const prTitle = "Multi repository extra heads e2e";
  const fe: PullRecord[] = [];
  const be: PullRecord[] = [];
  const feLink = (head: string) => `https://github.com/agetor-e2e/frontend/compare/main...${head}?quick_pull=1`;
  const stub = await startGitHubStub(backend.githubStubPort, [
    ...repoStubRoutes("frontend", fe, 41, { main: "a".repeat(40), "e2e-extra": "c".repeat(40) }),
    ...repoStubRoutes("backend", be, 42, { main: "a".repeat(40) }),
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const template =
      proposalBlock({
        repo: feName,
        base: "main",
        link: feLink(`{{branch:${feName}}}`),
        title: "Frontend live title",
        body: "live body",
      }) +
      proposalBlock({ repo: feName, base: "main", link: feLink("e2e-extra"), title: "Extra head title", body: "extra body" }) +
      proposalBlock({ repo: feName, base: "main", link: feLink("e2e-missing"), title: "Missing head title", body: "missing body" }) +
      proposalBlock({
        repo: beName,
        base: "main",
        link: `https://github.com/agetor-e2e/backend/compare/main...{{branch:${beName}}}?quick_pull=1`,
        title: "Backend live title",
        body: "backend body",
      });
    const prepared = await createPushedMultiTask(request, backend, {
      title: prTitle,
      prompt: proposalPrompt(template),
    });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const [feRepo, beRepo] = prepared.task.repositories;

    const dialog = await openCreatePrsDialog(page, backend, prTitle);
    await expect(dialog.locator('[data-testid^="create-prs-row-"]')).toHaveCount(4);
    const extraSlug = rowSlug(feName!, "e2e-extra");
    const missingSlug = rowSlug(feName!, "e2e-missing");
    // The extra head starts unchecked; the missing one is disabled with a reason.
    await expect(dialog.getByTestId(`create-prs-check-${extraSlug}`)).not.toBeChecked();
    await expect(dialog.getByTestId(`create-prs-check-${missingSlug}`)).toBeDisabled();
    await expect(dialog.getByTestId(`create-prs-disabled-${missingSlug}`)).toContainText("isn't on origin");
    await expect(dialog.getByTestId("create-prs-submit")).toContainText("Create 2 pull requests");

    await dialog.getByTestId(`create-prs-check-${extraSlug}`).check();
    await expect(dialog.getByTestId("create-prs-submit")).toContainText("Create 3 pull requests");
    await dialog.getByTestId("create-prs-submit").click();

    await expect.poll(() => fe.length + be.length, { timeout: CONVERGE_TIMEOUT }).toBe(3);
    expect(fe.map((p) => p.head).sort()).toEqual([feRepo!.branch, "e2e-extra"].sort());
    expect(fe.find((p) => p.head === "e2e-extra")).toMatchObject({ title: "Extra head title", base: "main" });
    expect([...fe, ...be].some((p) => p.head === "e2e-missing")).toBe(false);
    expect(be[0]!.head).toBe(beRepo!.branch);

    await expect
      .poll(async () => (await getTaskRow(request, backend, prepared.taskId)).repositories[0]!.prs?.length, {
        timeout: CONVERGE_TIMEOUT,
      })
      .toBe(2);

    // The task card's context menu lists every PR, one item each.
    // A reload closes the run panel, whose backdrop would otherwise sit over the card.
    await page.reload();
    await expect(page.getByText(prTitle, { exact: true }).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.getByText(prTitle, { exact: true }).first().click({ button: "right" });
    const items = page.locator('[data-testid^="task-context-menu-view-pr"]');
    await expect(items).toHaveCount(3);
    await expect(page.getByTestId("task-context-menu")).toContainText(`View ${feName} PR: e2e-extra`);
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs: a single-repository task with two heads gets the button and a header PR menu (S4)", async ({
  backend,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const prTitle = "Single repository two heads e2e";
  const fe: PullRecord[] = [];
  const stub = await startGitHubStub(
    backend.githubStubPort,
    repoStubRoutes("frontend", fe, 51, { main: "a".repeat(40), "e2e-single-extra": "d".repeat(40) }),
  );
  let prTaskId: string | null = null;
  let bareDir: string | null = null;
  try {
    const link = (head: string) => `https://github.com/agetor-e2e/frontend/compare/main...${head}?quick_pull=1`;
    const template =
      proposalBlock({ base: "main", link: link("{{branch}}"), title: "Single live title", body: "single live body" }) +
      proposalBlock({ base: "main", link: link("e2e-single-extra"), title: "Single extra title", body: "single extra body" });
    const prepared = await createPushedSingleTask(request, backend, { title: prTitle, prompt: proposalPrompt(template) });
    prTaskId = prepared.taskId;
    bareDir = prepared.bareDir;

    const dialog = await openCreatePrsDialog(page, backend, prTitle);
    const liveSlug = rowSlug(uniqueRepoSlugs([repoA])[0]!, prepared.branch);
    await expect(dialog.locator('[data-testid^="create-prs-row-"]')).toHaveCount(2);
    await expect(dialog.getByTestId(`create-prs-title-${liveSlug}`)).toHaveValue("Single live title");
    // Both rows are creatable: the live head is checked, the extra one is ticked here.
    await dialog.locator('[data-testid^="create-prs-check-"][data-testid$="e2e-single-extra"]').check();
    await expect(dialog.getByTestId("create-prs-submit")).toContainText("Create 2 pull requests");
    await dialog.getByTestId("create-prs-submit").click();

    await expect.poll(() => fe.length, { timeout: CONVERGE_TIMEOUT }).toBe(2);
    expect(fe.map((p) => p.title).sort()).toEqual(["Single extra title", "Single live title"]);
    await expect
      .poll(async () => (await getTaskRow(request, backend, prepared.taskId)).prs?.length, { timeout: CONVERGE_TIMEOUT })
      .toBe(2);
    const detail = await getTaskRow(request, backend, prepared.taskId);
    expect(detail.prUrl).toBe(detail.prs![0]!.url);

    // The header's View PR is a menu of both pull requests.
    await page.getByTestId("create-prs-close").click();
    await page.getByTestId("view-pr-menu-button").click();
    const menu = page.getByTestId("run-panel-pr-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu).toContainText(`View PR: ${prepared.branch} → main`);
    await expect(menu).toContainText("View PR: e2e-single-extra → main");
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    if (bareDir) await rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs keeps going after one repository fails; a reloaded retry shows an existing PR as already open (S5)", async ({
  backend,
  page,
  request,
}) => {
  // Spec: "A single Create all PRs action walks the repos with per-repo best
  // effort: one repo's failure does not block the others; results and retries
  // are per repo." The FIRST repository fails, so the second one's PR proves
  // the loop kept going. On the retry the forge says a PR already exists for
  // that head: it shows as already open (with its link), not as a failure, and
  // the already-opened sibling is never re-created.
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const [feName, beName] = uniqueRepoSlugs([repoA, repoB]);
  const prTitle = "Multi repository PR retry e2e";
  const be: PullRecord[] = [];
  let frontendCalls = 0;
  const branches = { main: "a".repeat(40) };
  const stub = await startGitHubStub(backend.githubStubPort, [
    ...githubRepoRoutes("agetor-e2e", "frontend", { defaultBranch: "main", branches }),
    {
      method: "POST",
      path: /^\/repos\/agetor-e2e\/frontend\/pulls$/,
      body: () => {
        frontendCalls += 1;
        if (frontendCalls === 1) return { status: 500, body: { message: "stub: frontend pull failed" } };
        return {
          status: 422,
          body: {
            message: "Validation Failed",
            errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for agetor-e2e:head." }],
          },
        };
      },
    },
    {
      method: "GET",
      path: /^\/repos\/agetor-e2e\/frontend\/pulls$/,
      body: [{ html_url: "https://github.com/agetor-e2e/frontend/pull/21" }],
    },
    ...repoStubRoutes("backend", be, 22, branches),
  ]);
  let prTaskId: string | null = null;
  let bareDirs: string[] = [];
  try {
    const template =
      proposalBlock({
        repo: feName,
        base: "main",
        link: `https://github.com/agetor-e2e/frontend/compare/main...{{branch:${feName}}}?quick_pull=1`,
        title: "Retry frontend title",
        body: "retry frontend body",
      }) +
      proposalBlock({
        repo: beName,
        base: "main",
        link: `https://github.com/agetor-e2e/backend/compare/main...{{branch:${beName}}}?quick_pull=1`,
        title: "Retry backend title",
        body: "retry backend body",
      });
    const prepared = await createPushedMultiTask(request, backend, { title: prTitle, prompt: proposalPrompt(template) });
    prTaskId = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const [feRepo, beRepo] = prepared.task.repositories;
    const feSlug = rowSlug(feName!, feRepo!.branch!);
    const beSlug = rowSlug(beName!, beRepo!.branch!);

    let dialog = await openCreatePrsDialog(page, backend, prTitle);
    await dialog.getByTestId("create-prs-submit").click();
    // First pass: frontend failed but the walk continued, so the backend PR exists.
    await expect(dialog.getByTestId(`create-prs-result-${feSlug}`)).toContainText("Failed", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId(`create-prs-result-${beSlug}`)).toContainText("Created", { timeout: CONVERGE_TIMEOUT });
    await expect
      .poll(async () => (await getTaskRow(request, backend, prepared.taskId)).repositories.map((r) => r.prs?.length ?? 0), {
        timeout: CONVERGE_TIMEOUT,
      })
      .toEqual([0, 1]);
    expect(frontendCalls).toBe(1);

    // Reload before retrying: a fresh load is the deterministic per-repository
    // retry surface. (`page.reload()`, not a second gotoApp: navigating to the
    // same URL is a same-document hash change.)
    await page.reload();
    await expect(page.getByText(prTitle, { exact: true }).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.getByText(prTitle, { exact: true }).first().click();
    const button = page.getByTestId("create-all-prs");
    await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(button).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await button.click();
    dialog = page.getByTestId("create-prs-dialog");
    await expect(page.getByTestId("create-prs-loading")).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    // Only the failed repository is offered again.
    await expect(dialog.locator('[data-testid^="create-prs-row-"]')).toHaveCount(1);
    await dialog.getByTestId("create-prs-submit").click();
    const result = dialog.getByTestId(`create-prs-result-${feSlug}`);
    await expect(result).toContainText("Already open", { timeout: CONVERGE_TIMEOUT });
    await expect(result.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "https://github.com/agetor-e2e/frontend/pull/21",
    );
    expect(frontendCalls).toBe(2);
    // The already-stamped backend was never re-opened, and an existing PR found
    // by the forge is not stamped onto the task.
    expect(be).toHaveLength(1);
    expect((await getTaskRow(request, backend, prepared.taskId)).repositories[0]!.prs ?? []).toEqual([]);
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bareDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("the single Create PR chip opens the composer on the task's base branch (S6)", async ({
  backend,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const prTitle = "Single chip base e2e";
  const fe: PullRecord[] = [];
  const stub = await startGitHubStub(
    backend.githubStubPort,
    repoStubRoutes("frontend", fe, 61, { main: "a".repeat(40), [TOPIC_BRANCH]: "b".repeat(40) }),
  );
  let prTaskId: string | null = null;
  let bareDir: string | null = null;
  try {
    const prepared = await createPushedSingleTask(request, backend, { title: prTitle, baseRef: TOPIC_BRANCH });
    prTaskId = prepared.taskId;
    bareDir = prepared.bareDir;
    expect((await getTaskRow(request, backend, prepared.taskId)).baseBranch).toBe(TOPIC_BRANCH);

    await gotoApp(page, backend.bootBase);
    await page.getByText(prTitle, { exact: true }).first().click();
    const chip = page.getByRole("button", { name: "Create PR", exact: true });
    await expect(chip).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await chip.click();
    await expect(page.getByPlaceholder("Base branch")).toHaveValue(TOPIC_BRANCH, { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByPlaceholder("Head branch")).toHaveValue(prepared.branch);
  } finally {
    if (prTaskId) await request.delete(`${backend.apiBase}/tasks/${prTaskId}`, { headers: auth }).catch(() => {});
    await stub.close();
    if (bareDir) await rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Create all PRs: a batch still pending for one task never locks or finishes the plan opened for another (S8)", async ({
  backend,
  page,
  request,
}) => {
  // RunPanel is one long-lived instance; the dialog inside it is keyed per task
  // (`create-prs-dialog-<id>`), so a batch that outlives a task switch writes
  // only to its own, unmounted instance. Task A's POST is held open, the
  // dialog is opened on task B, and B's plan must stay editable and
  // submittable and must not turn "finished" when A's batch ends. (Without the
  // key, B's rows open locked.) The same task can't reopen mid-batch: its
  // button is disabled while `isPrBatchRunning`.
  test.setTimeout(150_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const titleA = "Pending batch task A e2e";
  const titleB = "Reopened plan task B e2e";
  const extraA = "e2e-gen-extra-a";
  const extraB = "e2e-gen-extra-b";
  const posted: PullRecord[] = [];
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let headA = "";
  const routes = repoStubRoutes("frontend", posted, 81, { main: "a".repeat(40), [extraA]: "c".repeat(40), [extraB]: "d".repeat(40) });
  const pullsPost = routes.find((r) => r.method === "POST")!;
  const record = pullsPost.body as (req: StubRequest) => unknown;
  // Task A's create waits for the gate; anything else answers at once.
  pullsPost.body = async (req: StubRequest) => {
    if ((req.body as PullRecord).head === headA) await gateA;
    return record(req);
  };
  const stub = await startGitHubStub(backend.githubStubPort, routes);
  const ids: string[] = [];
  const bares: string[] = [];
  try {
    const link = (head: string) => `https://github.com/agetor-e2e/frontend/compare/main...${head}?quick_pull=1`;
    const prompt = (extra: string, who: string) =>
      proposalPrompt(
        proposalBlock({ base: "main", link: link("{{branch}}"), title: `${who} live title`, body: `${who} body` }) +
          proposalBlock({ base: "main", link: link(extra), title: `${who} extra title`, body: `${who} extra body` }),
      );
    const a = await createPushedSingleTask(request, backend, { title: titleA, prompt: prompt(extraA, "A") });
    ids.push(a.taskId);
    bares.push(a.bareDir);
    headA = a.branch;
    const b = await createPushedSingleTask(request, backend, { title: titleB, prompt: prompt(extraB, "B") });
    ids.push(b.taskId);
    bares.push(b.bareDir);
    const repoName = uniqueRepoSlugs([repoA])[0]!;

    // Start A's batch and leave its POST pending.
    const dialogA = await openCreatePrsDialog(page, backend, titleA);
    await expect(dialogA.getByTestId("create-prs-submit")).toContainText("Create 1 pull request");
    await dialogA.getByTestId("create-prs-submit").click();
    await expect(dialogA.getByTestId("create-prs-submit")).toContainText("Creating…");
    await page.getByTestId("create-prs-close").click();
    await expect(page.getByTestId("create-prs-dialog")).toBeHidden();

    // Switch to B without closing the panel (see the repo-tab reset test) and open its plan.
    await page.getByText(titleB, { exact: true }).first().dispatchEvent("click");
    const buttonB = page.getByTestId("create-all-prs");
    await expect(buttonB).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await buttonB.click();
    const dialogB = page.getByTestId("create-prs-dialog");
    await expect(page.getByTestId("create-prs-loading")).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    const liveB = rowSlug(repoName, b.branch);
    await expect(dialogB.getByTestId(`create-prs-title-${liveB}`)).toHaveValue("B live title");
    await expect(dialogB.getByTestId(`create-prs-title-${liveB}`)).toBeEnabled();
    await expect(dialogB.getByTestId(`create-prs-check-${liveB}`)).toBeEnabled();
    await expect(dialogB.getByTestId("create-prs-submit")).toBeEnabled();
    await expect(dialogB.getByTestId("create-prs-submit")).toContainText("Create 1 pull request");

    // A's batch ends while B's plan is open: B stays a fresh, submittable plan.
    releaseA();
    await expect.poll(() => posted.filter((p) => p.head === a.branch).length, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    await expect.poll(async () => (await getTaskRow(request, backend, a.taskId)).prs?.length ?? 0, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    await expect(dialogB.getByTestId("create-prs-submit")).toBeVisible();
    await expect(dialogB.getByTestId("create-prs-submit")).toBeEnabled();
    await expect(dialogB.getByTestId("create-prs-close")).toHaveText("Cancel");
    await expect(dialogB.getByTestId(`create-prs-result-${liveB}`)).toHaveCount(0);

    await dialogB.getByTestId("create-prs-submit").click();
    await expect.poll(() => posted.filter((p) => p.head === b.branch).length, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    expect(posted.find((p) => p.head === b.branch)).toMatchObject({ title: "B live title", base: "main" });
    await expect(dialogB.getByTestId("create-prs-close")).toHaveText("Close", { timeout: CONVERGE_TIMEOUT });
  } finally {
    releaseA();
    for (const id of ids) await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth }).catch(() => {});
    await stub.close();
    for (const dir of bares) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__";

test("Create all PRs on a pipeline step task: a PR with no proposal takes the root task's title, not the step's (S7)", async ({
  backend,
  page,
  request,
}) => {
  // The runner titles a step task `<pipeline> · <step>`. A PR opened from the
  // step's panel must carry the pipeline's root task title instead
  // (`resolvePrRootTitle`). The step proposes a PR for an extra branch only, so
  // the live head's row has no proposal and falls back to the root title.
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const rootTitle = "Pipeline root task PR title e2e";
  const pipelineName = "PR title pipeline e2e";
  const stepName = "Commit And Push";
  const extraHead = "e2e-step-extra";
  const fe: PullRecord[] = [];
  const stub = await startGitHubStub(
    backend.githubStubPort,
    repoStubRoutes("frontend", fe, 71, { main: "a".repeat(40), [extraHead]: "e".repeat(40) }),
  );
  let parentId: string | null = null;
  let pipelineId: string | null = null;
  let profileId: string | null = null;
  let bareDir: string | null = null;
  try {
    const profile = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth,
      data: { name: "PR title step runner e2e", harness: "claude-code", model: "opus-5", instructions: "", skills: [] },
    });
    expect(profile.ok()).toBe(true);
    profileId = ((await profile.json()) as { id: string }).id;
    const stepId = randomUUID();
    const pipeline = await request.post(`${backend.apiBase}/pipelines`, {
      headers: auth,
      data: {
        name: pipelineName,
        description: "",
        graph: {
          steps: [
            {
              id: stepId,
              name: stepName,
              instructions: "",
              agentProfileId: profileId,
              position: { x: 0, y: 0 },
              subagents: { profileIds: [], cap: null },
              transition: "choose",
              join: "any",
            },
          ],
          edges: [],
          startStepId: stepId,
        },
        maxSteps: 25,
      },
    });
    expect(pipeline.ok()).toBe(true);
    pipelineId = ((await pipeline.json()) as { id: string }).id;

    const template = proposalBlock({
      base: "main",
      link: `https://github.com/agetor-e2e/frontend/compare/main...${extraHead}?quick_pull=1`,
      title: "Step extra title",
      body: "step extra body",
    });
    const created = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth,
      data: {
        title: rootTitle,
        prompt: `${proposalPrompt(template)} ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
        agent: "claude-code",
        workdir: repoA,
        isolation: "worktree",
        pipelineId,
      },
    });
    expect(created.ok()).toBe(true);
    parentId = ((await created.json()) as { id: string }).id;
    const started = await request.post(`${backend.apiBase}/tasks/${parentId}/start`, { headers: auth });
    expect(started.ok()).toBe(true);

    type PipelineParentRow = TaskRow & {
      branch: string | null;
      pipelineRun: { status: string; history: { stepId: string; taskId: string }[] } | null;
    };
    let parent: PipelineParentRow | null = null;
    await expect(async () => {
      parent = (await getTaskRow(request, backend, parentId!)) as PipelineParentRow;
      expect(parent.pipelineRun?.status).toBe("done");
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    const root = parent! as PipelineParentRow;
    const stepTaskId = root.pipelineRun!.history.find((h) => h.stepId === stepId)!.taskId;
    const step = (await getTaskRow(request, backend, stepTaskId)) as PipelineParentRow;
    expect(step.title).toBe(`${pipelineName} · ${stepName}`);
    expect(step.worktreePath).toBe(root.worktreePath);
    const branch = root.branch!;

    const bare = await mkdtemp(path.join(tmpdir(), "agetor-e2e-bare-step-"));
    bareDir = bare;
    git(bare, ["init", "-q", "--bare"]);
    setLocalRemote(root.worktreePath!, bare);
    git(root.worktreePath!, ["push", "-q", "-u", "local", branch]);
    await expect
      .poll(async () => {
        const status = await request.get(`${backend.apiBase}/tasks/${stepTaskId}/git-status`, { headers: auth });
        return ((await status.json()) as { remoteSynced?: boolean }).remoteSynced ?? false;
      }, { timeout: CONVERGE_TIMEOUT })
      .toBe(true);

    // Open the step's panel the way a user does: the root card opens the run
    // view, the step node opens the step task's RunPanel.
    await gotoApp(page, backend.bootBase);
    await page.locator(".cursor-grab").filter({ has: page.getByText(rootTitle, { exact: true }) }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await page.locator(`[data-testid="pipeline-step-node"][data-step-id="${stepId}"]`).click();
    const panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible();
    const button = panel.getByTestId("create-all-prs");
    await expect(button).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await button.click();
    const dialog = page.getByTestId("create-prs-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("create-prs-loading")).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const repoName = uniqueRepoSlugs([repoA])[0]!;
    const liveSlug = rowSlug(repoName, branch);
    await expect(dialog.locator('[data-testid^="create-prs-row-"]')).toHaveCount(2);
    await expect(dialog.getByTestId(`create-prs-title-${liveSlug}`)).toHaveValue(rootTitle);
    await expect(dialog.getByTestId(`create-prs-title-${rowSlug(repoName, extraHead)}`)).toHaveValue("Step extra title");
    await expect(dialog.getByTestId("create-prs-submit")).toContainText("Create 1 pull request");
    await dialog.getByTestId("create-prs-submit").click();

    await expect.poll(() => fe.length, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    expect(fe[0]).toMatchObject({ title: rootTitle, head: branch, base: "main" });
  } finally {
    if (parentId) await request.delete(`${backend.apiBase}/tasks/${parentId}`, { headers: auth }).catch(() => {});
    if (pipelineId) await request.delete(`${backend.apiBase}/pipelines/${pipelineId}`, { headers: auth }).catch(() => {});
    if (profileId) await request.delete(`${backend.apiBase}/agent-profiles/${profileId}`, { headers: auth }).catch(() => {});
    await stub.close();
    if (bareDir) await rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Every persisted event of a task, oldest first (one page is plenty here). */
async function taskEvents(request: APIRequestContext, backend: E2EBackend, id: string) {
  const res = await request.get(
    `${backend.apiBase}/tasks/${id}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}&limit=500`,
    { headers: { authorization: `Bearer ${backend.apiToken}` } },
  );
  expect(res.ok(), `GET /tasks/${id}/events/page -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { events: Array<{ stream: string; data: string }> }).events;
}

/** Click the run panel's Commit & push chip and return the message it delivered to the agent. */
async function sendCommitPush(page: Page, request: APIRequestContext, backend: E2EBackend, id: string, title: string) {
  await gotoApp(page, backend.bootBase);
  await page.getByText(title, { exact: true }).first().click();
  const chip = page.getByRole("button", { name: "Commit & push" });
  await expect(chip).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await chip.click();
  let sent: string | undefined;
  await expect
    .poll(
      async () => {
        sent = (await taskEvents(request, backend, id)).find(
          (e) => e.stream === "user" && e.data.includes("Commit all changes"),
        )?.data;
        return sent !== undefined;
      },
      { timeout: CONVERGE_TIMEOUT },
    )
    .toBe(true);
  return sent!;
}

// C3 (docs/plans/create-all-prs-title-and-base.md): the Commit & push chip's
// message asks for a `Base:` line naming the base recorded when the task was
// created (not the repo default), and for a link built to target it, because
// git's push-output link always targets the default branch.
test("Commit & push asks for a Base: line naming the branch the task was created from, and a link that targets it", async ({
  backend,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const title = "Commit push base single e2e";
  let id: string | null = null;
  let bareDir: string | null = null;
  try {
    const prepared = await createPushedSingleTask(request, backend, { title, baseRef: TOPIC_BRANCH });
    id = prepared.taskId;
    bareDir = prepared.bareDir;
    const row = await getTaskRow(request, backend, id);
    expect(row.baseBranch).toBe(TOPIC_BRANCH);
    // Uncommitted work is what offers the chip.
    await writeFile(path.join(row.worktreePath!, "commit-push.txt"), "change\n");

    const sent = await sendCommitPush(page, request, backend, id, title);
    expect(sent).toContain(`git push -u origin '${prepared.branch}'`);
    expect(sent).toContain('"Base: <branch>"');
    expect(sent).toContain(`the base recorded for this task, '${TOPIC_BRANCH}'`);
    expect(sent).toContain("compare/<base>...<head>?quick_pull=1");
    expect(sent).toContain("always targets the default branch");
    // The Base line comes before the link, and both before the PR blocks.
    expect(sent.indexOf('"Base: <branch>"')).toBeLessThan(sent.indexOf("full link to open a"));
    expect(sent.indexOf("full link to open a")).toBeLessThan(sent.indexOf('"PR title:"'));
  } finally {
    if (id) await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth }).catch(() => {});
    if (bareDir) await rm(bareDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Commit & push on a multi-repository task lists each repository's own recorded base", async ({
  backend,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const auth = { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
  const title = "Commit push base multi e2e";
  let id: string | null = null;
  let bareDirs: string[] = [];
  try {
    const prepared = await createPushedMultiTask(request, backend, { title, baseRef: TOPIC_BRANCH });
    id = prepared.taskId;
    bareDirs = prepared.bareDirs;
    const row = await getTaskRow(request, backend, id);
    expect(row.repositories.map((r) => r.baseBranch)).toEqual([TOPIC_BRANCH, TOPIC_BRANCH]);
    await writeFile(path.join(row.repositories[1]!.worktreePath!, "commit-push.txt"), "change\n");

    const sent = await sendCommitPush(page, request, backend, id, title);
    for (const repo of row.repositories) {
      expect(sent).toContain(`- ${repo.name}: branch '${repo.branch}', base '${TOPIC_BRANCH}'`);
    }
    expect(sent).toContain('a "Repository: <name>" line; a "Base: <branch>" line');
    expect(sent).toContain("merge_request[target_branch]=<base>");
    expect(sent).toContain("dest=<base>");
  } finally {
    if (id) await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth }).catch(() => {});
    for (const d of bareDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
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
