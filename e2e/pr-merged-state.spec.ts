import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { startGitHubStub, type GitHubStub, type StubRoute } from "./github-stub";

/**
 * E2E coverage for the PR modal's merge-status refresh + merged-state banner
 * (docs/plans/pr-modal-refresh-merge-status-and-merged-banner.md §10, esp.
 * T7) — the "Actions" section of the Git dialog's PR detail view
 * (`PullActions`/`PullActionGrid`/`MergedPullCard` in
 * `src/mainview/components/kanban/GitHubDialog.tsx`):
 *
 *   1. a PR that was merged *outside* agetor (GitHub web UI, another agetor
 *      window, ...) is caught by the refresh-on-detail-entry effect
 *      (`refreshPullDetail`) even when the cached list still says "open",
 *      and the purple merged card replaces the mergeability banner + action
 *      grid;
 *   2. that refresh fires on *every* entry into the detail view (list ->
 *      detail(A) -> list -> detail(A) refetches, not just the first visit);
 *   3. merging from inside agetor flips the card in place, with no need to
 *      leave the detail view or re-navigate.
 *
 * Arrange: one throwaway git repo (`git init` + `commit.gpgsign false`, one
 * commit, `origin` pointed at `https://github.com/e2e-org/e2e-repo.git` so
 * the backend's remote-parsing resolves it to owner `e2e-org` / repo
 * `e2e-repo` — see `repoForDir` in src/bun/github.ts) registered as a
 * project through the real `POST /projects` API. Shared across all three
 * tests below (`beforeAll`/`afterAll`, serial mode) rather than one repo per
 * test: the three scenarios are really three views of the *same* PR #42
 * over time (open -> merged), so a single registered project avoids the
 * "multiple projects registered, which one does the dialog auto-select"
 * question entirely — there is always exactly one.
 *
 * The stub GitHub API (`e2e/github-stub.ts`) is started once on
 * `backend.githubStubPort` (the backend was launched with
 * `AGETOR_GITHUB_API_BASE` already pointed there — see e2e/fixtures.ts) and
 * each test installs its own route table via `setRoutes` so the previous
 * test's PR state can't leak into the next. Route bodies are closures over a
 * test-local `merged` flag (mutated either directly, to simulate an
 * out-of-band merge, or by the stubbed `PUT .../merge` handler, to simulate
 * an in-app one) rather than static payloads, so "the PR just changed
 * state" needs no second `setRoutes` call — the next matching request just
 * reads the current flag.
 *
 * Deliberately NOT stubbed with any care: pull commits/comments/review
 * comments/check-runs/commit-status/labels/milestones/assignees/releases/
 * reactions and the GraphQL linked-issues/review-threads queries the detail
 * view also fires on entry — all answered with cheap empty payloads (see
 * `auxiliaryRoutes`) purely to keep the stub's unmatched-route stderr log
 * quiet; none of them affect the Actions section these tests assert on.
 */

test.describe.configure({ mode: "serial" });

const REPO_PATH = "/repos/e2e-org/e2e-repo";
const PR_TITLE = "e2e test pull request";

// The refresh-on-entry effect chains a project-select render, an item-list
// fetch, and (for the merged assertions) the entry-refresh + mergeability
// fetches settling and re-rendering — generous but bounded, rather than a
// fixed sleep, so a loaded CI/dev machine doesn't flake on the default 5s
// expect timeout while a normal machine still fails fast on a real bug.
const CONVERGE_TIMEOUT = 15_000;

let stub: GitHubStub;
let projectDir: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-pr-merged-"));
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

/** Registers `dir` as a project directly against the worker backend's API,
 *  using the plain global `fetch` (not Playwright's `request` fixture) so
 *  this can run from `test.beforeAll`, which only has worker-scoped fixtures
 *  (`backend`) available — `request` is test-scoped. */
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

interface PrOverrides {
  state?: "open" | "closed";
  merged?: boolean;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string;
}

/** A minimally-shaped GitHub pull request JSON object — enough for
 *  `normalizeItem` (number/title/state/html_url/user/assignees/milestone/
 *  body/labels/comments/created_at/updated_at/closed_at/merged_at/draft/
 *  locked) AND `normalizeMergeability` (head/base/mergeable/mergeable_state/
 *  rebaseable/merged/auto_merge) to both accept it — the same `GET
 *  .../pulls/42` stub route serves the detail fetch, the mergeability poll,
 *  and (harmlessly, since it degrades to "no diff") the `.diff`-media-type
 *  fetch. */
function prPayload(overrides: PrOverrides = {}) {
  return {
    number: 42,
    title: PR_TITLE,
    state: overrides.state ?? "open",
    html_url: "https://github.com/e2e-org/e2e-repo/pull/42",
    user: { login: "e2e-author", avatar_url: null, html_url: null },
    assignees: [] as unknown[],
    milestone: null,
    body: "",
    labels: [] as unknown[],
    comments: 0,
    created_at: "2026-08-18T09:00:00Z",
    updated_at: "2026-08-19T09:00:00Z",
    closed_at: overrides.closedAt ?? null,
    merged_at: overrides.mergedAt ?? null,
    locked: false,
    draft: false,
    head: {
      ref: "feature-branch",
      sha: "abc123deadbeef0000000000000000000000000",
      repo: { full_name: "e2e-org/e2e-repo" },
    },
    base: { ref: "main", repo: { full_name: "e2e-org/e2e-repo" } },
    mergeable: overrides.mergeable ?? true,
    mergeable_state: overrides.mergeableState ?? "clean",
    rebaseable: true,
    merged: overrides.merged ?? false,
    auto_merge: null,
  };
}

/** Routes every scenario needs regardless of PR state, so the detail view's
 *  many per-item sections (commits, conversation + review comments, check
 *  runs, combined commit status, repo labels/milestones/assignees, and the
 *  linked-issues/review-threads GraphQL queries) resolve cleanly instead of
 *  404ing into the stub's unmatched-route log. None of these are asserted on
 *  — only the Actions section is. */
function auxiliaryRoutes(): StubRoute[] {
  return [
    { method: "GET", path: "/user", body: { login: "e2e-user", id: 1 } },
    {
      method: "GET",
      path: new RegExp(`^${REPO_PATH}$`),
      body: { permissions: { push: true, admin: true, maintain: true }, default_branch: "main" },
    },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/42/commits$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/42/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/42/comments$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/check-runs$`), body: { check_runs: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/commits/[^/]+/status$`), body: { state: "success", statuses: [] } },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/labels$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/milestones$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/assignees$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/releases$`), body: [] },
    { method: "GET", path: new RegExp(`^${REPO_PATH}/issues/42/reactions$`), body: [] },
    {
      method: "POST",
      path: "/graphql",
      // Same shape answers both the linked-issues and review-threads
      // queries — each parser only reads the one field it cares about and
      // ignores the rest.
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

/** Opens the Git dialog (board toolbar button, aria-label "Git") and returns
 *  its `role="dialog"` locator once rendered. */
async function openGitDialog(page: Page) {
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
  stub = await startGitHubStub(backend.githubStubPort);
});

test.afterAll(async () => {
  await stub.close();
  await rm(projectDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  // Each test calls `stub.setRoutes(...)` with its own full table before
  // navigating (below) — deliberately NOT reset to `[]` here first: the
  // previous test's page can still have a trailing background fetch in
  // flight (comments/checks/commit-status, fired automatically on detail
  // entry but never awaited by any assertion) when this hook runs, and an
  // empty-routes window would turn that harmless straggler into a logged
  // "unmatched" 404. Leaving the previous table live until the new test
  // overwrites it means a straggler either lands on the outgoing test's
  // routes or the incoming one — both well-formed either way. Only the call
  // log needs a clean slate per test (for the hit-count assertions above).
  stub.calls.length = 0;
});

test.describe("PR detail: merge status refresh + merged banner", () => {
  test("a PR merged outside agetor is caught on detail entry: merged card, no Merge button, Merged tag", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    // The list still says "open" (as if agetor's cached view predates the
    // merge); the per-PR detail/mergeability fetch says merged. Entering the
    // detail view must resolve to the merged truth, not the stale list.
    stub.setRoutes([
      { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls$`), body: [prPayload({ state: "open" })] },
      {
        method: "GET",
        path: new RegExp(`^${REPO_PATH}/pulls/42$`),
        body: prPayload({
          state: "closed",
          merged: true,
          mergedAt: "2026-08-20T12:00:00Z",
          closedAt: "2026-08-20T12:00:00Z",
        }),
      },
      ...auxiliaryRoutes(),
    ]);

    await gotoApp(page, backend.bootBase);
    const dialog = await openGitDialog(page);

    const row = dialog.getByRole("button", { name: `#42 ${PR_TITLE}` });
    await expect(row).toBeVisible();
    await row.click();

    const mergedCard = dialog.getByRole("status");
    await expect(mergedCard).toContainText("Pull request successfully merged", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByText("Merge status")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Merged", { exact: true })).toBeVisible();
  });

  test("refreshes on every detail entry: open+mergeable grid, then a merge that happened while back on the list is picked up on re-entry", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    let merged = false;
    const pr = () =>
      merged
        ? prPayload({ state: "closed", merged: true, mergedAt: "2026-08-21T10:00:00Z", closedAt: "2026-08-21T10:00:00Z" })
        : prPayload({ state: "open" });

    stub.setRoutes([
      { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls$`), body: () => [pr()] },
      { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/42$`), body: () => pr() },
      ...auxiliaryRoutes(),
    ]);

    await gotoApp(page, backend.bootBase);
    const dialog = await openGitDialog(page);

    const row = dialog.getByRole("button", { name: `#42 ${PR_TITLE}` });
    await expect(row).toBeVisible();
    await row.click();

    // First entry: open + mergeable -> the ordinary action grid renders.
    await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByText("Ready to merge")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const hitsBeforeReentry = stub.callsMatching(/\/pulls\/42$/, "GET");

    // Back to the list, flip the PR to merged (simulating it happening
    // elsewhere while the user was looking at the list), then re-enter the
    // same detail view.
    await dialog.getByRole("button", { name: "Back" }).click();
    merged = true;
    await row.click();

    const mergedCard = dialog.getByRole("status");
    await expect(mergedCard).toContainText("Pull request successfully merged", { timeout: CONVERGE_TIMEOUT });

    const hitsAfterReentry = stub.callsMatching(/\/pulls\/42$/, "GET");
    expect(hitsAfterReentry).toBeGreaterThan(hitsBeforeReentry);
  });

  test("merging in-app flips the card in place, with no navigation and no green success line", async ({
    page,
    backend,
  }) => {
    test.setTimeout(60_000);
    let merged = false;
    const pr = () =>
      merged
        ? prPayload({ state: "closed", merged: true, mergedAt: "2026-08-22T08:00:00Z", closedAt: "2026-08-22T08:00:00Z" })
        : prPayload({ state: "open" });

    stub.setRoutes([
      { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls$`), body: () => [pr()] },
      { method: "GET", path: new RegExp(`^${REPO_PATH}/pulls/42$`), body: () => pr() },
      {
        method: "PUT",
        path: new RegExp(`^${REPO_PATH}/pulls/42/merge$`),
        body: () => {
          merged = true;
          return { merged: true, sha: "abc123", message: "Pull Request successfully merged" };
        },
      },
      ...auxiliaryRoutes(),
    ]);

    await gotoApp(page, backend.bootBase);
    const dialog = await openGitDialog(page);

    const row = dialog.getByRole("button", { name: `#42 ${PR_TITLE}` });
    await expect(row).toBeVisible();
    await row.click();

    const mergeButton = dialog.getByRole("button", { name: "Merge", exact: true });
    await expect(mergeButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await mergeButton.click();

    const mergedCard = dialog.getByRole("status");
    await expect(mergedCard).toContainText("Pull request successfully merged", { timeout: CONVERGE_TIMEOUT });
    // Still on the detail subpage — merging didn't navigate away.
    await expect(dialog.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(dialog.getByText("Merged", { exact: true })).toBeVisible();
    // The green success line is suppressed once merged — the card + "Merged"
    // tag already say it (U2).
    await expect(dialog.getByText(/Pull Request successfully merged/)).toHaveCount(0);

    // Optional (T7 "4"): the header's Refresh button still works on a merged
    // PR and re-hits the detail endpoint.
    const hitsBeforeRefresh = stub.callsMatching(/\/pulls\/42$/, "GET");
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect
      .poll(() => stub.callsMatching(/\/pulls\/42$/, "GET"), { timeout: CONVERGE_TIMEOUT })
      .toBeGreaterThan(hitsBeforeRefresh);
  });
});
