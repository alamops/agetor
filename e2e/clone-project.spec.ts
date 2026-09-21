import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2e coverage for docs/plans/clone-repository-launch-pickers.md §5 TT3: the
 * "Clone repository" dialog (`CloneProjectDialog.tsx`, opened from
 * `ProjectPicker.tsx`'s footer) lets the user pick an Agent profile or a
 * manual Harness/Mode/Model/Effort for the auto-created ELI5 explainer task,
 * exactly like the New Task form and the two shared launch dialogs
 * (`useTaskLaunch`/`TaskLaunchPickers` — see `e2e/agent-profiles-launch.spec
 * .ts` / `e2e/agent-profiles-dialogs.spec.ts`, which this file follows for
 * locator conventions).
 *
 * No network is used: `POST /projects/clone` (server.ts) shells out to
 * `git clone -- <url> <dest>`, but `src/bun/clone.ts`'s `cloneRepo` honors
 * `AGETOR_CLONE_SOURCE_OVERRIDE` as a test seam — when set, that local path
 * is cloned instead of the URL's real remote. The dialog's own URL field is
 * parsed by the shared, provider-generic `src/shared/clone-input.ts` parser
 * (`parseCloneInput`/`detectCloneProvider`) — every test here still types a
 * GitHub `owner/repo`-shaped string, since GitHub is the dialog's default
 * provider and that's all this file's scenarios (the launch pickers) need;
 * the Provider select, host detection, and the other two forges' parsing are
 * covered separately in `e2e/clone-providers.spec.ts`.
 *
 * Each test gets its OWN `freshBackend` (via `AGETOR_CLONE_SOURCE_OVERRIDE`
 * on `backendEnv`, e2e/fixtures.ts's `provisionBackend`/`freshBackend`
 * seam) rather than the file-shared worker `backend`, because that env var
 * has to be baked into the backend's env at spawn time — there is no
 * per-request override the way `AGETOR_FAKE_PICK_REFS_DIR` gets one. This
 * also gives every test its own isolated SQLite DB, so there is no task-
 * title collision to worry about across scenarios that all clone the same
 * fixture `owner/repo` URL.
 */

const SOURCE_REPO_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-source-"));
const CLONE_ROOT = mkdtempSync(path.join(tmpdir(), "agetor-e2e-clone-root-"));

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

// Synchronous, module-scope setup: `test.use({ backendEnv })` below needs a
// concrete path at file-evaluation time (it's a plain option value, not an
// async fixture), so the local fixture repo — standing in for the real
// GitHub remote via AGETOR_CLONE_SOURCE_OVERRIDE — has to exist before that
// call runs. Mirrors src/bun/clone-endpoint.test.ts's own beforeAll setup,
// just made synchronous for this reason.
git(SOURCE_REPO_DIR, ["init", "-q", "-b", "main"]);
git(SOURCE_REPO_DIR, ["config", "user.email", "e2e@example.com"]);
git(SOURCE_REPO_DIR, ["config", "user.name", "e2e"]);
git(SOURCE_REPO_DIR, ["config", "commit.gpgsign", "false"]);
execFileSync("sh", ["-c", `echo '# fixture repo' > README.md`], { cwd: SOURCE_REPO_DIR });
git(SOURCE_REPO_DIR, ["add", "-A"]);
git(SOURCE_REPO_DIR, ["commit", "-q", "-m", "initial commit"]);

test.use({ backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE: SOURCE_REPO_DIR } });

test.afterAll(async () => {
  await rm(SOURCE_REPO_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(CLONE_ROOT, { recursive: true, force: true }).catch(() => {});
});

const CONVERGE_TIMEOUT = 20_000;

// The URL typed into the dialog — parsed by the shared `clone-input.ts`
// parser as GitHub `owner/repo` shorthand (the dialog's default provider)
// regardless of AGETOR_CLONE_SOURCE_OVERRIDE actually supplying the bytes.
// Repo name "somerepo" drives the ELI5 task's title (`eli5TaskTitle` =
// "ELI5: somerepo") and the registered project's name.
const CLONE_URL = "someowner/somerepo";
const ELI5_TITLE = "ELI5: somerepo";

// Tooltip ProjectPicker's trigger carries, set by NewTaskForm.tsx — used to
// open the project popover the "Clone repository…" entry lives in.
const PROJECT_PICKER_TITLE =
  "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.";

function newTaskForm(page: Page): Locator {
  return page.locator("aside").filter({ hasText: "New task" });
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Opens the project popover and clicks "Clone repository…", landing on the
 *  open `CloneProjectDialog`. */
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
 *  fetch — the agent-profile picker only renders once `useTaskLaunch` is
 *  past both `loading` and `loadError` (CloneProjectDialog.tsx). */
async function waitForLaunchReady(dialog: Locator): Promise<void> {
  await expect(dialog.getByTestId("agent-profile-picker")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
}

/** Mirrors `e2e/agent-profiles-settings.spec.ts`'s `launchSelect`: the
 *  `TaskLaunchPickers` manual-block markup has no `htmlFor`/`aria-labelledby`
 *  wiring, so each `<label>` + `<Select>` pair is located structurally —
 *  the label's next sibling wraps the actual `<select>`. */
function launchSelect(container: Locator, label: string): Locator {
  return container
    .locator("label", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::*[1]//select");
}

async function selectProfileInDialog(dialog: Locator, profileId: string): Promise<void> {
  const picker = dialog.getByTestId("agent-profile-picker");
  await picker.getByTestId("agent-profile-picker-trigger").click();
  await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
  await picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${profileId}"]`).click();
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  model: string | null;
  isolation: "worktree" | "none";
  workdir: string;
  agentProfileId: string | null;
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

async function createProfileRest(
  request: APIRequestContext,
  backend: E2EBackend,
  body: { name: string; harness: string; model: string },
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/agent-profiles`, {
    headers: auth(backend),
    data: body,
  });
  expect(res.ok(), `POST /agent-profiles -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const created = (await res.json()) as { id: string };
  return created.id;
}

function uniqueDest(name: string): string {
  return path.join(CLONE_ROOT, `${name}-${randomUUID()}`);
}

test.describe("Clone repository dialog", () => {
  test("naming, switch gating, and empty-URL disables submit", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const form = newTaskForm(page);
    await form.getByTitle(PROJECT_PICKER_TITLE).click();

    const cloneEntry = page.getByTestId("project-clone-open");
    await expect(cloneEntry).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(cloneEntry).toContainText("Clone repository…");
    await cloneEntry.click();

    const dialog = page.getByTestId("clone-project-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2#clone-project-title")).toHaveText("Clone repository");

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toHaveText("Clone");
    // Empty URL: submit stays disabled regardless of the eli5 switch state.
    await expect(submit).toBeDisabled();

    // Switch defaults on — the launch pickers container is present.
    await expect(dialog.getByTestId("clone-eli5-switch")).toHaveAttribute("data-state", "checked");
    await expect(dialog.getByTestId("clone-launch")).toBeVisible();

    // Toggle off — the launch pickers unmount entirely.
    await dialog.getByTestId("clone-eli5-switch").click();
    await expect(dialog.getByTestId("clone-eli5-switch")).toHaveAttribute("data-state", "unchecked");
    await expect(dialog.getByTestId("clone-launch")).toHaveCount(0);

    // Toggle back on — pickers reappear.
    await dialog.getByTestId("clone-eli5-switch").click();
    await expect(dialog.getByTestId("clone-launch")).toBeVisible();
  });

  test("manual model selection lands on the ELI5 task", async ({ page, request, freshBackend }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("manual");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill(CLONE_URL);
    await dialog.getByTestId("clone-dest").fill(dest);

    const launch = dialog.getByTestId("clone-launch");
    await waitForLaunchReady(launch);
    // Default agent is the built-in claude-code harness (no preference set
    // on this fresh backend), so the curated claude-code model list — which
    // includes "sonnet-5" unconditionally (not catalog-scoped) — is what the
    // manual Model select renders.
    await expect(launch.getByText("Harness", { exact: true })).toBeVisible();
    await launchSelect(launch, "Model").selectOption("sonnet-5");

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitTaskByTitle(request, freshBackend, ELI5_TITLE);
    expect(task.model).toBe("sonnet-5");
    expect(task.isolation).toBe("none");
    expect(task.workdir).toBe(dest);
    expect(task.agentProfileId).toBeNull();

    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("agent profile selection binds agentProfileId and its model to the ELI5 task", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);
    const profileId = await createProfileRest(request, freshBackend, {
      name: "Clone Reviewer",
      harness: "claude-code",
      model: "haiku-4.5",
    });

    const dest = uniqueDest("profile");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill(CLONE_URL);
    await dialog.getByTestId("clone-dest").fill(dest);

    const launch = dialog.getByTestId("clone-launch");
    await waitForLaunchReady(launch);
    await selectProfileInDialog(launch, profileId);

    // "One selection" (plan D4/D5, mirroring the other launch surfaces): the
    // manual Harness block is replaced by the selected profile card.
    await expect(launch.getByText("Harness", { exact: true })).toHaveCount(0);
    const selectedCard = launch.locator(`[data-testid="agent-profile-card"][data-profile-id="${profileId}"]`).last();
    await expect(selectedCard).toBeVisible();

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    const task = await awaitTaskByTitle(request, freshBackend, ELI5_TITLE);
    expect(task.agentProfileId).toBe(profileId);
    expect(task.model).toBe("haiku-4.5");
    expect(task.isolation).toBe("none");
    expect(task.workdir).toBe(dest);

    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("switch off clones and registers the project without creating a task", async ({ page, request, freshBackend }) => {
    test.setTimeout(60_000);
    const dest = uniqueDest("no-eli5");
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openCloneDialog(page);

    await dialog.getByTestId("clone-url").fill(CLONE_URL);
    await dialog.getByTestId("clone-dest").fill(dest);
    await dialog.getByTestId("clone-eli5-switch").click();
    await expect(dialog.getByTestId("clone-launch")).toHaveCount(0);

    const submit = dialog.getByTestId("clone-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });

    await expect
      .poll(async () => (await listProjects(request, freshBackend)).some((p) => p.path === dest), {
        timeout: CONVERGE_TIMEOUT,
      })
      .toBe(true);

    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    // No task was created for this clone.
    const task = await findTaskByTitle(request, freshBackend, ELI5_TITLE);
    expect(task).toBeNull();
  });
});
