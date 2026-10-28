import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the OpenCode harness (docs/plans/add-opencode-harness.md
 * §5 W3-T2, flow 1). Turns run through the in-process fake driver
 * (`AGETOR_OPENCODE_DRIVER=fake`, canned v2 NDJSON fed through the real
 * mapper); every other CLI call goes to the stub `opencode` binary that
 * e2e/fixtures.ts writes (`opencode v2.1.4`, `auth list` → `[]`).
 *
 * - (a) New Task → OpenCode: the model reads "OpenCode default", the server
 *   picker defaults to Shared; the run renders assistant text, a thinking
 *   block, a tool card, the TODO card plus its board badge and the usage
 *   chip; a follow-up resumes the same session.
 * - (b) Task details → Standalone: the next turn's D-19 breadcrumb reads
 *   `server=standalone`.
 * - (c) Settings → Add harness → "Additional OpenCode": the home copy shows,
 *   and the harness's tasks show the locked Standalone note.
 * - (d) The subagent marker: a subagent tab appears and holds the child
 *   transcript after the turn.
 * - (e) Settings shows the "No OpenCode credentials found" notice.
 * - (f) A stored variant on a model discovery doesn't list is kept when the
 *   task is opened (RunPanel's effort cascade sends no PATCH).
 */

/** Literal copy of `FAKE_OPENCODE_SUBAGENT_PROMPT_MARKER` (src/bun/agents.ts)
 *  — specs can't import `src/bun/*` (see e2e/fx-interactions.spec.ts). */
const FAKE_OPENCODE_SUBAGENT_PROMPT_MARKER = "__agetor_fake_opencode_subagent__";

/** The pinned picker copy (OpencodeServerPicker.tsx `HOME_LOCK_REASON`). */
const HOME_LOCK_REASON =
  "This harness has its own home, so it always runs OpenCode standalone (a shared server would mix accounts).";

/** Runs settle in a few hundred ms on an idle box; the e2e machine is often
 *  under heavy load, so every wait on server-side progress gets headroom. */
const CONVERGE_TIMEOUT = 30_000;

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const createdTaskIds: string[] = [];
let addedHarnessId: string | null = null;

/** Shared by (a) and (b): the task the New Task form creates. */
let formTaskTitle = "";
let formTaskId = "";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function patchHarness(backend: E2EBackend, id: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/${id}`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH /harnesses/${id} -> ${res.status}: ${await res.text()}`);
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Record<string, any>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, any>;
}

async function findTaskByTitle(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<Record<string, any> | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  if (!res.ok()) return null;
  const list = (await res.json()) as Array<Record<string, any>>;
  return list.find((t) => t.title === title) ?? null;
}

async function taskRuns(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/runs -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

/** Polls until the task's newest run has settled and the card left
 *  `running`, returning the runs (newest first). */
async function waitForIdle(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
  runCount: number,
): Promise<Array<Record<string, any>>> {
  let runs: Array<Record<string, any>> = [];
  await expect
    .poll(
      async () => {
        runs = await taskRuns(request, backend, id);
        const task = await getTask(request, backend, id);
        return runs.length >= runCount && runs.every((r) => r.status !== "running") && task.column !== "running";
      },
      { timeout: CONVERGE_TIMEOUT },
    )
    .toBe(true);
  return runs;
}

/** A project folder under the backend's data dir, registered over REST (no
 *  native folder panel in the headless harness). Returns its path. */
async function registerProject(backend: E2EBackend, name: string): Promise<string> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
  return dir;
}

async function createTaskRest(
  request: APIRequestContext,
  backend: E2EBackend,
  data: Record<string, unknown>,
): Promise<{ id: string; title: string }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { isolation: "none", ...data },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as { id: string; title: string };
  createdTaskIds.push(task.id);
  return task;
}

async function startTaskRest(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  expect(res.ok(), `POST /tasks/${id}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

function newTaskFormPanel(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea").first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(panel.getByTestId("transcript-loading")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
  return panel;
}

async function selectHarness(page: Page, label: string): Promise<void> {
  const button = newTaskFormPanel(page).getByRole("button", { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await button.click();
}

async function selectProject(form: Locator, projectName: string): Promise<void> {
  await form
    .getByTitle(
      "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.",
    )
    .click();
  const search = form.getByPlaceholder("Search projects…");
  await expect(search).toBeVisible();
  await search.fill(projectName);
  const row = form.getByRole("button", { name: projectName });
  await expect(row).toBeVisible();
  await row.click();
}

/** The New Task form's Model `<select>` (see e2e/fx-models.spec.ts). */
function newTaskModelSelect(page: Page): Locator {
  return newTaskFormPanel(page).getByTestId("refresh-models").locator("xpath=../..").locator("select");
}

/** Types a follow-up into the run panel's composer and sends it. */
async function sendFollowUp(panel: Locator, text: string): Promise<void> {
  const textarea = panel.getByTestId("send-textarea");
  await expect(textarea).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await textarea.fill(text);
  const send = panel.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await send.click();
}

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

/** One harness row in Settings → Harnesses, found by its `<id> · <kind>`
 *  line (the rows carry no test id of their own). */
function harnessRow(dialog: Locator, id: string, kind: string): Locator {
  return dialog
    .getByText(new RegExp(`^${id} · ${kind}`))
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-md ')][1]");
}

/** A D-19 opening breadcrumb with the given server. */
function breadcrumb(server: string): RegExp {
  return new RegExp(`^opencode 2\\.x · server=${server} · model=OpenCode default · effort=auto · mode=\\S+$`);
}

test.describe("OpenCode harness (fake driver + stub CLI)", () => {
  test.beforeAll(async ({ backend }) => {
    await patchHarness(backend, "opencode", { enabled: true });
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    if (addedHarnessId) {
      await fetch(`${backend.apiBase}/harnesses/${addedHarnessId}`, { method: "DELETE", headers: auth(backend) }).catch(
        () => {},
      );
    }
    // OpenCode ships disabled — leave the worker-shared backend that way.
    await patchHarness(backend, "opencode", { enabled: false }).catch(() => {});
  });

  test("(a) New Task → OpenCode defaults, a full turn renders, and a follow-up resumes the session", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(180_000);
    const projectName = `opencode-e2e-project-${suffix}`;
    await registerProject(backend, projectName);

    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);
    await selectHarness(page, "OpenCode");

    // The model is the pinned sentinel, the server picker sits at Shared.
    const modelSelect = newTaskModelSelect(page);
    await expect(modelSelect).toHaveValue("opencode-default", { timeout: CONVERGE_TIMEOUT });
    await expect(modelSelect.locator("option:checked")).toHaveText("OpenCode default");
    const server = form.getByTestId("new-task-opencode-server");
    await expect(server).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(server).toHaveAttribute("data-value", "shared");
    await expect(server.getByTestId("new-task-opencode-server-shared")).toHaveAttribute("aria-pressed", "true");
    await expect(server.getByTestId("new-task-opencode-server-standalone")).toHaveAttribute("aria-pressed", "false");
    await expect(form.getByTestId("opencode-server-locked-note")).toHaveCount(0);

    await selectProject(form, projectName);
    formTaskTitle = `opencode-e2e ${suffix}`;
    const prompt = `list the files ${suffix}`;
    await form.getByPlaceholder("Short description").fill(formTaskTitle);
    await form.getByTestId("prompt-textarea").fill(prompt);
    await form.getByTestId("worktree-options").getByTestId("isolate-toggle").uncheck();
    await form.getByRole("button", { name: "To backlog", exact: true }).click();

    let row: Record<string, any> | null = null;
    await expect(async () => {
      row = await findTaskByTitle(request, backend, formTaskTitle);
      expect(row).not.toBeNull();
    }).toPass({ timeout: CONVERGE_TIMEOUT });
    formTaskId = row!.id as string;
    createdTaskIds.push(formTaskId);
    const stored = await getTask(request, backend, formTaskId);
    expect(stored.agent).toBe("opencode");
    expect(stored.model).toBe("opencode-default");
    expect(stored.opencodeServer).toBe("shared");

    const card = taskCard(page, formTaskTitle);
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "Run", exact: true }).click();
    const panel = await openTask(page, formTaskTitle);

    // The canned turn: assistant text, the persisted D-19 breadcrumb, a
    // thinking block, a `shell` tool card, the TODO card and the usage chip.
    await expect(panel.getByText(`fake response to: ${prompt}`, { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(panel.getByText(breadcrumb("shared"))).toHaveCount(1);
    const thinking = panel.getByRole("button", { name: "thinking" });
    await expect(thinking).toHaveCount(1);
    await thinking.click();
    await expect(panel.getByText("fake opencode reasoning", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /shell/ }).first()).toBeVisible();
    await expect(panel.getByText("2 tasks·1 done·1 open")).toBeVisible();
    await expect(panel.getByText("answer the user", { exact: true }).first()).toBeVisible();
    const usageChip = panel.getByTestId("fx-usage-chip").first();
    await expect(usageChip).toBeVisible();
    await expect(usageChip).toContainText("↑");
    await expect(panel.getByText("fx-usage:", { exact: false })).toHaveCount(0);

    // Board badge: 1 of the 2 todos is done. The board polls every 2 s.
    const badge = card.locator('[title="1 of 2 tasks done"]');
    await expect(badge).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(badge.getByText("1/2", { exact: true })).toBeVisible();

    const firstRuns = await waitForIdle(request, backend, formTaskId, 1);
    const sessionId = firstRuns[0]!.opencodeSessionId as string;
    expect(sessionId).toMatch(/^ses_fake/);

    // A follow-up is a new turn in the SAME OpenCode session.
    await sendFollowUp(panel, `second turn ${suffix}`);
    await expect(panel.getByText("resuming OpenCode session ses_fake…", { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(panel.getByText(`fake response to: second turn ${suffix}`, { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    const runs = await waitForIdle(request, backend, formTaskId, 2);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.opencodeSessionId)).toEqual([sessionId, sessionId]);
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  test("(b) Task details → Standalone: the next turn's breadcrumb reads server=standalone", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    expect(formTaskId, "(a) must have run first").toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, formTaskTitle);
    await panel.getByText("Task details", { exact: true }).click();
    const picker = panel.getByTestId("task-opencode-server");
    await expect(picker).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(picker).toHaveAttribute("data-value", "shared");
    await expect(picker.getByTestId("task-opencode-server-shared")).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByTestId("opencode-server-locked-note")).toHaveCount(0);

    await picker.getByTestId("task-opencode-server-standalone").click();
    await expect.poll(async () => (await getTask(request, backend, formTaskId)).opencodeServer, {
      timeout: CONVERGE_TIMEOUT,
    }).toBe("standalone");
    await expect(picker.getByTestId("task-opencode-server-standalone")).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByTestId("task-opencode-server-shared")).toHaveAttribute("aria-pressed", "false");
    // Fold Task details back up: expanded, it pushes the composer below the
    // 720 px viewport.
    await panel.getByText("Task details", { exact: true }).click();
    await expect(picker).toBeHidden();

    // The change applies to the next turn only: the earlier breadcrumbs stay
    // `server=shared`, the new one reads `server=standalone`.
    await sendFollowUp(panel, `third turn ${suffix}`);
    await expect(panel.getByText(breadcrumb("standalone"))).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(panel.getByText(breadcrumb("shared"))).toHaveCount(2);
    await expect(panel.getByText(`fake response to: third turn ${suffix}`, { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    const runs = await waitForIdle(request, backend, formTaskId, 3);
    expect(new Set(runs.map((r) => r.opencodeSessionId)).size).toBe(1);
  });

  test("(c) Settings → Add harness → Additional OpenCode: home copy, then its tasks show the locked Standalone note", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(180_000);
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsHarnesses(page);
    const addButton = dialog.getByRole("button", { name: "Add harness", exact: true });
    await expect(addButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await addButton.click();

    // The template button's accessible name also holds its description, so
    // match on the label text.
    const template = dialog.getByRole("button").filter({ hasText: "Additional OpenCode" });
    await expect(template).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await template.click();

    // The editor shows OpenCode's own home copy and pre-fills the home.
    await expect(dialog.getByText("HOME override (absolute path; optional)", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/OpenCode has no dedicated config-dir env var/)).toBeVisible();
    await expect(dialog.getByText(/XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and XDG_CACHE_HOME/)).toBeVisible();
    const idInput = dialog.getByPlaceholder("claude-work");
    await expect(idInput).toHaveValue(/^opencode-\d+$/);
    const harnessId = await idInput.inputValue();
    const label = `OpenCode (e2e home ${suffix})`;
    await dialog.getByPlaceholder("Claude (work)").fill(label);
    await expect(dialog.getByPlaceholder(/harnesses\/opencode-2$/)).toHaveValue(new RegExp(`harnesses/${harnessId}$`));
    await dialog.getByRole("button", { name: "Add harness", exact: true }).click();

    let created: Record<string, any> | undefined;
    await expect
      .poll(
        async () => {
          const res = await request.get(`${backend.apiBase}/harnesses`, { headers: auth(backend) });
          const body = (await res.json()) as { harnesses: Array<Record<string, any>> };
          created = body.harnesses.find((h) => h.id === harnessId);
          return created ? { kind: created.kind, enabled: created.enabled, home: !!created.home } : null;
        },
        { timeout: CONVERGE_TIMEOUT },
      )
      .toEqual({ kind: "opencode", enabled: true, home: true });
    addedHarnessId = harnessId;
    await expect(harnessRow(dialog, harnessId, "opencode")).toContainText(label, { timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeHidden();

    // New Task form on that harness: the picker is forced to Standalone.
    await gotoApp(page, backend.bootBase);
    await selectHarness(page, label);
    const formPicker = newTaskFormPanel(page).getByTestId("new-task-opencode-server");
    await expect(formPicker).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(formPicker).toHaveAttribute("data-locked", "true");
    await expect(formPicker).toHaveAttribute("data-value", "standalone");
    await expect(formPicker.getByTestId("new-task-opencode-server-shared")).toBeDisabled();
    await expect(newTaskFormPanel(page).getByTestId("opencode-server-locked-note")).toHaveText(HOME_LOCK_REASON);

    // A task on it stores Shared but shows — and runs — Standalone.
    const workdir = await registerProject(backend, `opencode-e2e-home-${suffix}`);
    const title = `opencode-home-e2e ${suffix}`;
    const task = await createTaskRest(request, backend, {
      title,
      prompt: title,
      agent: harnessId,
      workdir,
      opencodeServer: "shared",
    });
    expect((await getTask(request, backend, task.id)).opencodeServer).toBe("shared");
    await startTaskRest(request, backend, task.id);
    await waitForIdle(request, backend, task.id, 1);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await expect(panel.getByText(breadcrumb("standalone"))).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await panel.getByText("Task details", { exact: true }).click();
    const picker = panel.getByTestId("task-opencode-server");
    await expect(picker).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(picker).toHaveAttribute("data-locked", "true");
    await expect(picker).toHaveAttribute("data-value", "standalone");
    await expect(picker.getByTestId("task-opencode-server-standalone")).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByTestId("task-opencode-server-shared")).toBeDisabled();
    await expect(panel.getByTestId("opencode-server-locked-note")).toHaveText(HOME_LOCK_REASON);
  });

  test("(d) the subagent marker opens a subagent tab that holds the child transcript after the turn", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    const workdir = await registerProject(backend, `opencode-e2e-subagent-${suffix}`);
    const title = `opencode-subagent-e2e ${suffix}`;
    const task = await createTaskRest(request, backend, {
      title,
      prompt: `${FAKE_OPENCODE_SUBAGENT_PROMPT_MARKER} delegate a listing`,
      agent: "opencode",
      workdir,
    });
    await startTaskRest(request, backend, task.id);
    // The child's transcript only arrives with the turn-end export (D-11),
    // so assert after the turn has settled.
    await waitForIdle(request, backend, task.id, 1);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    const tab = panel.getByTestId("subagent-tab");
    await expect(tab).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(tab).toHaveAttribute("title", "Fake child task");
    await expect(tab).toContainText("explore");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByText("The directory has a.txt and b.txt.", { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(panel.getByText("Looking at the directory.", { exact: true })).toBeVisible();

    // Still there after a reload (the app reopens the panel it had open, on
    // the same tab): the row is completed, not dropped.
    await gotoApp(page, backend.bootBase);
    const reopened = runPanel(page);
    await expect(reopened.getByText(title, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const again = reopened.getByTestId("subagent-tab");
    await expect(again).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await again.click();
    await expect(reopened.getByText("The directory has a.txt and b.txt.", { exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
  });

  test("(e) Settings shows the no-credentials notice for OpenCode", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsHarnesses(page);
    const row = harnessRow(dialog, "opencode", "opencode");
    const notice = row.getByTestId("harness-status-notice");
    await expect(notice).toHaveText("No OpenCode credentials found — run `opencode auth login`", {
      timeout: CONVERGE_TIMEOUT,
    });
    // An OpenCode 2 install gets no upgrade line.
    await expect(row.getByText(/OpenCode 2 is available/)).toHaveCount(0);
  });

  test("(f) a stored variant on a model discovery doesn't list survives opening the task (no effort PATCH)", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    // The stub's catalog lists two Zen ids; this model is neither, so its
    // variants are unknown. RunPanel's effort cascade must keep the stored
    // variant instead of PATCHing it to "auto" (`retainableEfforts`).
    const model = `acme/e2e-unlisted-${suffix}`;
    const workdir = await registerProject(backend, `opencode-e2e-effort-${suffix}`);
    const title = `opencode-effort-e2e ${suffix}`;
    const task = await createTaskRest(request, backend, { title, prompt: title, agent: "opencode", workdir, model });
    const patched = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
      headers: auth(backend),
      data: { effort: "high" },
    });
    expect(patched.ok(), `PATCH /tasks/${task.id} -> ${patched.status()}: ${await patched.text()}`).toBeTruthy();
    const stored = await getTask(request, backend, task.id);
    expect(stored.model).toBe(model);
    expect(stored.effort).toBe("high");

    const effortPatches: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "PATCH" || !req.url().endsWith(`/tasks/${task.id}`)) return;
      const body = req.postData() ?? "";
      if (body.includes('"effort"')) effortPatches.push(body);
    });

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByText("Task details", { exact: true }).click();
    const effort = panel.getByText("Effort", { exact: true }).locator("xpath=following-sibling::dd[1]").locator("select");
    await expect(effort).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(effort).toHaveValue("high");

    // The cascade re-runs on every render. Let two board polls (2 s apart)
    // and the harness-model poll land, then check nothing reset the value.
    const isTaskList = (url: string, method: string) => method === "GET" && new URL(url).pathname.endsWith("/tasks");
    for (let i = 0; i < 2; i++) {
      await page.waitForResponse((r) => isTaskList(r.url(), r.request().method()), { timeout: CONVERGE_TIMEOUT });
    }
    await expect(effort).toHaveValue("high");
    expect(effortPatches).toEqual([]);
    expect((await getTask(request, backend, task.id)).effort).toBe("high");
  });
});
