import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { makeBareSourceRepo } from "../src/bun/clone-test-util.ts";
import { startSlowGitServer } from "./slow-git-server.ts";

/**
 * E2e coverage for docs/plans/clone-repository-all-providers.md (§3 D7, §5
 * TT5): the multi-provider parts of the "Clone repository" dialog
 * (`CloneProjectDialog.tsx`) — the Provider select, host detection from a
 * pasted URL (https/scp/ssh-url, all three forges), the shared
 * `src/shared/clone-input.ts` parser's client-side error surfacing, and the
 * server's own host-resolution layer (`src/bun/clone.ts`'s
 * `resolveCloneRepo`, which rejects a Bitbucket Server/Data Center host that
 * the client-side parser can't distinguish from Bitbucket Cloud on syntax
 * alone).
 *
 * Deliberately separate from `e2e/clone-project.spec.ts` (the peer spec for
 * this same dialog, covering the Agent-profile/harness launch pickers via
 * GitHub `owner/repo` shorthand — the default provider, so that file keeps
 * passing unchanged). This file owns everything provider-select- and
 * parser-shaped; locator conventions (test ids, `openCloneDialog`,
 * `waitForLaunchReady`, the REST polling helpers) are copied from that spec
 * rather than imported, since e2e spec files don't share code beyond
 * `fixtures.ts`/`helpers.ts`.
 *
 * No real network: every test that actually clones sets
 * `AGETOR_CLONE_SOURCE_OVERRIDE` (via `test.use({ backendEnv })`, same seam
 * the peer spec uses) so `src/bun/clone.ts`'s `cloneRepo` clones a local
 * fixture repo instead of hitting a real remote — the pasted URL only has to
 * parse; its actual reachability never matters. The one test that needs the
 * server's real host-resolution layer to behave deterministically
 * (Bitbucket Server rejection, which shells out to `ssh -G` to disambiguate
 * an alias from a genuine third-party domain) additionally points
 * `AGETOR_SSH_BIN` at a tiny stub script that mirrors real `ssh -G`'s
 * default "no config entry matched — echo the host back" behavior, so the
 * test's outcome can't depend on whatever `~/.ssh/config` happens to exist
 * on the machine running this suite.
 */

const SOURCE_REPO_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-providers-source-"));
const CLONE_ROOT = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-providers-root-"));
const SSH_STUB_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-providers-sshstub-"));
const SSH_STUB_BIN = path.join(SSH_STUB_DIR, "ssh");

// Second, SEPARATE clone source for the "progress streaming and cancel"
// describe block below (Addendum A) — those tests need the clone to
// actually take multi-second, OBSERVABLE wall-clock time (to see the
// progress row update, and to have a real window to click Cancel in), which
// a same-machine local-path clone (SOURCE_REPO_DIR above) can never provide:
// git's local-clone fast path hard-links objects and skips the whole
// `remote: …`/`Receiving objects: NN%` progress protocol entirely — verified
// empirically while building this fixture (`git clone --progress -- <local
// path> dest` completes in well under a second with only a single "Cloning
// into … done." line, no percentage lines at all). `startSlowGitServer`
// (./slow-git-server.ts) instead serves a bare repo over REAL smart-HTTP,
// with the response for the data-carrying request deliberately paced over a
// few seconds — see that module's own doc comment for why
// `startAuthGitServer`'s (clone-test-util.ts) `delayMs` option can't do this
// (it delays the response START, not the transfer, and a fully-computed CGI
// response then arrives in one instantaneous burst over loopback regardless
// of how long the wait was). Bound synchronously (`Bun.serve`'s ephemeral
// port is available the instant it returns — see that module's own doc
// comment), so the URL is ready in time for the `test.use({ backendEnv })`
// below.
const SLOW_SOURCE_ROOT = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-providers-slowsrc-"));
makeBareSourceRepo(SLOW_SOURCE_ROOT);
const slowGitServer = startSlowGitServer(SLOW_SOURCE_ROOT, { transferDelayMs: 3000, chunkCount: 15 });
const SLOW_CLONE_URL = `${slowGitServer.url}/repo.git`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

// Synchronous, module-scope setup — `test.use({ backendEnv })` below needs
// concrete paths at file-evaluation time (see clone-project.spec.ts's
// identical rationale for its own SOURCE_REPO_DIR).
git(SOURCE_REPO_DIR, ["init", "-q", "-b", "main"]);
git(SOURCE_REPO_DIR, ["config", "user.email", "e2e@example.com"]);
git(SOURCE_REPO_DIR, ["config", "user.name", "e2e"]);
git(SOURCE_REPO_DIR, ["config", "commit.gpgsign", "false"]);
execFileSync("sh", ["-c", `echo '# fixture repo' > README.md`], { cwd: SOURCE_REPO_DIR });
git(SOURCE_REPO_DIR, ["add", "-A"]);
git(SOURCE_REPO_DIR, ["commit", "-q", "-m", "initial commit"]);

// `apiHostForRemote` (src/bun/git-provider.ts) spawns `ssh -G -- <host>` and
// parses its `hostname <value>` line. Real ssh's own default behavior for a
// host with no matching `~/.ssh/config` entry is to echo the host back
// unresolved — this stub reproduces exactly that one invocation shape
// deterministically, so the Bitbucket-Server-rejection test below can't
// depend on the test machine's actual ssh config (e.g. a coincidental `Host
// bitbucket.company.com` entry would silently change the outcome).
writeFileSync(SSH_STUB_BIN, ['#!/bin/sh', 'echo "hostname $3"', "exit 0", ""].join("\n"));
chmodSync(SSH_STUB_BIN, 0o755);

test.use({ backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE: SOURCE_REPO_DIR } });

test.afterAll(async () => {
  slowGitServer.stop();
  await rm(SOURCE_REPO_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(CLONE_ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(SSH_STUB_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(SLOW_SOURCE_ROOT, { recursive: true, force: true }).catch(() => {});
});

const CONVERGE_TIMEOUT = 20_000;

// Mirrors clone-project.spec.ts's identical constant.
const PROJECT_PICKER_TITLE =
  "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.";

function newTaskForm(page: Page): Locator {
  return page.locator("aside").filter({ hasText: "New task" });
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Opens the project popover and clicks "Clone repository…", landing on the
 *  open `CloneProjectDialog`. Copied from clone-project.spec.ts's helper of
 *  the same name/behavior. */
async function openCloneDialog(page: Page): Promise<Locator> {
  const form = newTaskForm(page);
  await form.getByTitle(PROJECT_PICKER_TITLE).click();
  const cloneEntry = page.getByTestId("project-clone-open");
  await expect(cloneEntry).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await cloneEntry.click();
  const dialog = page.getByTestId("clone-project-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Waits for the launch pickers (`clone-launch`) to finish their harness
 *  fetch — only needed by the one test here that leaves the ELI5 switch on. */
async function waitForLaunchReady(dialog: Locator): Promise<void> {
  await expect(dialog.getByTestId("agent-profile-picker")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
}

/** Turns the ELI5 explainer switch off — every test here except the one
 *  that explicitly exercises the launch pickers does this so submit doesn't
 *  depend on harness/agent-profile readiness at all. */
async function turnEli5Off(dialog: Locator): Promise<void> {
  await dialog.getByTestId("clone-eli5-switch").click();
  await expect(dialog.getByTestId("clone-launch")).toHaveCount(0);
}

interface TaskRow {
  id: string;
  title: string;
  workdir: string;
  isolation: "worktree" | "none";
}

async function findTaskByTitle(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks -> ${res.status()}`).toBeTruthy();
  const list = (await res.json()) as TaskRow[];
  return list.find((t) => t.title === title) ?? null;
}

async function awaitTaskByTitle(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return task!;
}

interface ProjectRow {
  path: string;
  name: string;
}

async function listProjects(request: APIRequestContext, backend: E2EBackend): Promise<ProjectRow[]> {
  const res = await request.get(`${backend.apiBase}/projects`, { headers: auth(backend) });
  expect(res.ok(), `GET /projects -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as ProjectRow[];
}

async function awaitProjectRegistered(request: APIRequestContext, backend: E2EBackend, dest: string): Promise<ProjectRow> {
  let found: ProjectRow | null = null;
  await expect(async () => {
    const projects = await listProjects(request, backend);
    found = projects.find((p) => p.path === dest) ?? null;
    expect(found).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return found!;
}

function uniqueDest(name: string): string {
  return path.join(CLONE_ROOT, `${name}-${randomUUID()}`);
}

test.describe("Clone repository dialog — provider select and parsing", () => {
  test("defaults to GitHub, and the select is wired to its hint for a11y", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    const select = dialog.getByTestId("clone-provider");
    await expect(select).toHaveValue("github");
    await expect(select).toBeEnabled();
    await expect(select).toHaveAttribute("aria-describedby", "clone-provider-hint");

    const hint = dialog.getByTestId("clone-provider-detected");
    await expect(hint).toHaveText("Used for owner/repo shorthand");
    await expect(hint).toHaveAttribute("id", "clone-provider-hint");

    await expect(dialog.getByTestId("clone-url")).toHaveAttribute("placeholder", /github\.com/);
  });

  test("a GitLab nested URL locks the select, then clearing restores the manual pick", async ({
    page,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    const select = dialog.getByTestId("clone-provider");
    const url = dialog.getByTestId("clone-url");
    const hint = dialog.getByTestId("clone-provider-detected");

    // Manual pick first, so we have something to restore later.
    await select.selectOption("bitbucket");
    await expect(select).toHaveValue("bitbucket");

    await url.fill("https://gitlab.com/group/sub/project");
    await expect(select).toHaveValue("gitlab");
    await expect(select).toBeDisabled();
    await expect(hint).toHaveText("Detected from the URL: GitLab");
    await expect(dialog.getByTestId("clone-dest")).toHaveAttribute("placeholder", "default: ~/project");

    await url.fill("");
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("bitbucket");
  });

  test("scp and ssh-alias forms also detect the provider from the host", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    const select = dialog.getByTestId("clone-provider");
    const url = dialog.getByTestId("clone-url");

    await url.fill("git@bitbucket.org:ws/repo.git");
    await expect(select).toHaveValue("bitbucket");
    await expect(select).toBeDisabled();

    await url.fill("");
    await expect(select).toBeEnabled();

    // A per-identity ssh alias — no literal "gitlab.com" in sight — still
    // detects via the substring heuristic (detectProviderFromHost).
    await url.fill("git@gitlab-work:group/app.git");
    await expect(select).toHaveValue("gitlab");
    await expect(select).toBeDisabled();
  });

  test("picking GitLab manually with nested shorthand clones and registers the project", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("gitlab-nested");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-provider").selectOption("gitlab");
    await dialog.getByTestId("clone-url").fill("group/sub/project");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const toaster = page.locator("[data-sonner-toaster]");
    await expect(toaster.getByText("Cloned project")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const project = await awaitProjectRegistered(request, freshBackend, dest);
    expect(project.name).toBe("project");
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("an invalid 3-segment GitHub shorthand shows the parser's error, cleared by editing", async ({
    page,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    // Provider stays the default (GitHub) — GitHub shorthand permits only
    // owner/repo, so a 3-segment path is rejected outright rather than
    // truncated (trimAndValidateSegments, shorthand form).
    await dialog.getByTestId("clone-url").fill("group/sub/project");
    await dialog.getByTestId("clone-dest").fill(uniqueDest("invalid-shorthand"));
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    const error = dialog.getByTestId("clone-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText('invalid repository path "group/sub/project"');
    await expect(dialog).toBeVisible();

    // Editing the URL clears the stale error (even without fixing it).
    await dialog.getByTestId("clone-url").fill("group/sub/project/extra");
    await expect(dialog.getByTestId("clone-error")).toHaveCount(0);
  });

  test("an unsupported host shows the warning and surfaces the error on submit", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    const select = dialog.getByTestId("clone-provider");
    const hint = dialog.getByTestId("clone-provider-detected");

    await dialog.getByTestId("clone-url").fill("https://example.com/o/r");
    await expect(hint).toHaveText("Unrecognized host — only GitHub, GitLab and Bitbucket Cloud hosts are supported");
    await expect(select).toBeDisabled();

    const dest = uniqueDest("unsupported-host");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    const error = dialog.getByTestId("clone-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/unsupported host "example\.com"/);
    await expect(dialog).toBeVisible();
    expect(existsSync(dest)).toBe(false);
  });

  test("a GitHub scp-form URL clones via the source override", async ({ page, request, freshBackend }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("scp-github");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("git@github.com:someowner/somerepo8.git");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const project = await awaitProjectRegistered(request, freshBackend, dest);
    expect(project.name).toBe("somerepo8");
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("ELI5 explainer launches from a Bitbucket URL with the switch left on", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("bitbucket-eli5");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("https://bitbucket.org/someowner/biteli5repo");
    await dialog.getByTestId("clone-dest").fill(dest);

    const launch = dialog.getByTestId("clone-launch");
    await waitForLaunchReady(launch);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const toaster = page.locator("[data-sonner-toaster]");
    await expect(toaster.getByText("Cloned biteli5repo")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitTaskByTitle(request, freshBackend, "ELI5: biteli5repo");
    expect(task.workdir).toBe(dest);
    expect(task.isolation).toBe("none");
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });
});

test.describe("Clone repository dialog — server-side host rejection", () => {
  // This block's clones never actually need to succeed, but AGETOR_SSH_BIN
  // is additive to (not a replacement for) the base backendEnv above — a
  // nested test.use REPLACES the whole option object, so both keys must be
  // repeated here.
  test.use({ backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE: SOURCE_REPO_DIR, AGETOR_SSH_BIN: SSH_STUB_BIN } });

  test("a Bitbucket-Server-shaped host parses client-side but is rejected by the server", async ({
    page,
    freshBackend,
  }) => {
    const dest = uniqueDest("bitbucket-server");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("https://bitbucket.company.com/scm/proj/repo.git");
    // Client-side parsing succeeds (detectProviderFromHost matches on the
    // "bitbucket" substring) — the select shows it as detected, not
    // unsupported. The rejection can only come from the server's own
    // ssh -G-backed host resolution below.
    await expect(dialog.getByTestId("clone-provider-detected")).toHaveText("Detected from the URL: Bitbucket");
    await expect(dialog.getByTestId("clone-provider")).toHaveValue("bitbucket");

    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    const error = dialog.getByTestId("clone-error");
    await expect(error).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(error).toContainText("Bitbucket Server");
    await expect(dialog).toBeVisible();
    expect(existsSync(dest)).toBe(false);
  });
});

/** The dialog's single live-progress paragraph (docs/plans/clone-repository
 *  -all-providers.md Addendum A) — `aria-live="polite"` text inside the
 *  `clone-progress` row, e.g. "Starting…" / "Counting objects…" /
 *  "Receiving objects…". */
function progressPhaseText(dialog: Locator): Locator {
  return dialog.getByTestId("clone-progress").locator('p[aria-live="polite"]');
}

test.describe("Clone repository dialog — progress streaming and cancel", () => {
  // Addendum A. Points AGETOR_CLONE_SOURCE_OVERRIDE at the paced slow-git
  // server (module scope above) instead of the plain local SOURCE_REPO_DIR
  // every other describe block in this file uses — a nested `test.use`
  // REPLACES the whole backendEnv object, so this describe block gets none
  // of the other blocks' env keys (it needs none of them: AGETOR_SSH_BIN is
  // only for the Bitbucket-Server-rejection test above).
  test.use({ backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE: SLOW_CLONE_URL } });

  test("a progress row with a live phase label and bar appears while the clone runs, then it completes and registers the project", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("progress-row");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("someowner/somerepo-progress");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    const cancel = dialog.getByTestId("clone-cancel");
    await expect(submit).toBeEnabled();
    await submit.click();

    // The Clone button is replaced in place (same test id, new copy) rather
    // than removed — see CloneProjectDialog.tsx's footer: it always renders
    // `clone-submit`, just disabled with "Cloning…" text while busy, since
    // `canSubmit` is false whenever `busy` is true.
    await expect(submit).toHaveText("Cloning…");
    await expect(submit).toBeDisabled();
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeEnabled();
    await expect(cancel).toHaveText("Cancel clone");

    const progressRow = dialog.getByTestId("clone-progress");
    await expect(progressRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("clone-progress-bar")).toBeVisible();

    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const toaster = page.locator("[data-sonner-toaster]");
    await expect(toaster.getByText("Cloned somerepo-progress")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    const project = await awaitProjectRegistered(request, freshBackend, dest);
    expect(project.name).toBe("somerepo-progress");
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("the live phase text advances beyond Starting… while the clone is in flight", async ({
    page,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("phase-text");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("someowner/somerepo-phase");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(dialog.getByTestId("clone-progress")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const phaseText = progressPhaseText(dialog);
    // Starts on the synthetic "starting" phase (no real progress event has
    // necessarily arrived yet) …
    await expect(phaseText).toHaveText("Starting…");
    // … and — proof that `clone_progress` AppEvents actually reach the
    // dialog over `/app/events`, not just that the row renders a static
    // fallback — moves on to a real phase (`CLONE_PHASE_LABEL` in
    // CloneProjectDialog.tsx: "Counting objects…" / "Compressing
    // objects…" / "Receiving objects…" / "Resolving deltas…" / "Checking
    // out files…") well before the clone (and thus the dialog) closes.
    await expect(phaseText).not.toHaveText("Starting…", { timeout: 20_000 });

    // Let the clone finish so the fixture doesn't leak a running clone into
    // the next test.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });

  test("Cancel stops an in-flight clone, cleans up the destination, and shows an info toast", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("cancel");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill("someowner/somerepo-cancel");
    await dialog.getByTestId("clone-dest").fill(dest);
    await turnEli5Off(dialog);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    const cancel = dialog.getByTestId("clone-cancel");
    await expect(cancel).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(cancel).toBeEnabled();
    // Deliberately not asserting the transient "Cancelling…"/disabled state
    // here (CloneProjectDialog.tsx's `cancelling` flag) — against this
    // fixture, killing the local `git clone` process and the server
    // round-tripping the held `POST /projects/clone`'s 409 both resolve
    // well inside a single browser tick, so that state's visible window
    // turned out to be sub-frame and inherently un-observable from outside
    // the page: every polling strategy tried while writing this test
    // (sequential `expect(...).toHaveText()`/`toBeDisabled()`, a combined
    // `evaluate()` right after the click, and a `page.waitForFunction`
    // poll) found the button either not yet updated or already gone,
    // depending on exactly how much round-trip time it added. What's
    // actually load-bearing — the outcome a real user cares about — is
    // asserted below: the dialog closes, an info toast fires, and nothing
    // is left behind or registered.
    await cancel.click();

    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    const toaster = page.locator("[data-sonner-toaster]");
    await expect(toaster.getByText("Clone cancelled")).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    // Cancelled: nothing is left behind, and nothing was registered.
    expect(existsSync(dest)).toBe(false);
    const projects = await listProjects(request, freshBackend);
    expect(projects.find((p) => p.path === dest)).toBeUndefined();
  });
});
