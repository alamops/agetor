import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/github-copilot-harness.md TT7: the GitHub
 * Copilot harness (`copilot` AgentKind, "GitHub Copilot", Experimental, seeded
 * ENABLED) through the in-process fake driver (`AGETOR_COPILOT_DRIVER=fake`,
 * set on every backend by e2e/fixtures.ts) feeding the REAL `mapCopilotEvent`.
 *
 * Copilot is seeded enabled, so unlike the opt-in fx/cursor harnesses the
 * availability probe is what needs a seam: `AGETOR_E2E_COPILOT_STUB=1` (in
 * `backendEnv`, below) makes the fixture point `AGETOR_COPILOT_BIN` at a stub
 * script answering `--version` ("GitHub Copilot CLI 1.0.104.") and
 * `help config` (the model block). Every test here gets its own fresh
 * backend, so `test.use` applies the stub to all of them and no worker-shared
 * state leaks between scenarios.
 *
 * 1. Settings → Harnesses row (Experimental badge, enabled, available) and
 *    the `copilot-additional` template's COPILOT_HOME help.
 * 2. New Task form defaults: Auto model + discovered-only `gpt-5.4-mini`,
 *    "Model default" effort, no Speed control, Auto / Plan / Read-only modes.
 * 3. The stream marker's canned turn: thinking, tool card, "auto picked"
 *    status line, usage chip, and a live subagent tab with its nested tool call.
 * 4. The plan marker in Plan mode: plan card → dialog → edit → approve → the
 *    task flips to Auto with the status line.
 * 5. The auth marker: the login status line and a failed run.
 * 6. A follow-up sent mid-turn runs as the next turn with the "resuming
 *    GitHub Copilot session" status.
 */

/** Literal copies of the `FAKE_COPILOT_*_PROMPT_MARKER`s (src/bun/copilot-fake.ts)
 *  — a Playwright spec can't import `src/bun/*` (`bun:sqlite` doesn't resolve
 *  under Node's loader), same rationale as e2e/cursor-stream.spec.ts. */
const FAKE_COPILOT_STREAM_PROMPT_MARKER = "__agetor_fake_copilot_stream__";
const FAKE_COPILOT_PLAN_PROMPT_MARKER = "__agetor_fake_copilot_plan__";
const FAKE_COPILOT_AUTH_PROMPT_MARKER = "__agetor_fake_copilot_auth__";

const COPILOT_LOGIN_STATUS_TEXT =
  "GitHub Copilot isn't logged in — run `copilot login` in a terminal (or set COPILOT_GITHUB_TOKEN in this harness's env)";
const PLAN_APPROVED_STATUS = "plan approved — switched this task to Auto so GitHub Copilot can implement it";

/** How long the fake subagent stays "running" in the stream scenario — long
 *  enough to see its tab, open it and read the nested tool call even on a
 *  loaded machine; the assertions wait on UI state, never on this timer. */
const SUBAGENT_MS = 12_000;

test.use({
  backendEnv: {
    AGETOR_E2E_COPILOT_STUB: "1",
    AGETOR_FAKE_COPILOT_SUBAGENT_MS: String(SUBAGENT_MS),
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Record<string, any>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, any>;
}

async function listRuns(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/runs -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

/** Every persisted event of a task (newest page; these tasks are tiny). */
async function taskEvents(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<Array<{ stream: string; data: string }>> {
  const res = await request.get(
    `${backend.apiBase}/tasks/${id}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}&limit=500`,
    { headers: auth(backend) },
  );
  expect(res.ok(), `GET /tasks/${id}/events/page -> ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { events: Array<{ stream: string; data: string }> };
  return body.events;
}

/** Creates a Copilot task (isolation "none", a plain non-git temp dir) and
 *  returns its row WITHOUT starting it, so a spec can open the panel first
 *  and watch the breadcrumbs arrive live. */
async function createCopilotTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt, agent: "copilot", isolation: "none", workdir: tmpdir(), ...extra },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

async function startTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  expect(res.ok(), `POST /tasks/${id}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

function newTaskFormPanel(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

async function registerProject(backend: E2EBackend, name: string): Promise<void> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
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

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

/** The bordered card around one harness row, found from one of its controls. */
function harnessRow(control: Locator): Locator {
  return control.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-md ')][1]");
}

/** The New Task form's Model `<select>` (see e2e/fx-models.spec.ts for the
 *  structural-locator rationale: the refresh button sits in a row that is the
 *  previous sibling of the `<select>`, both inside one wrapper). */
function newTaskModelSelect(page: Page): Locator {
  return page.getByTestId("refresh-models").locator("xpath=../..").locator("select");
}

/** The New Task form's Effort `<select>` (same wrapper shape as Model's). */
function newTaskEffortSelect(form: Locator): Locator {
  return form.getByText("Effort", { exact: true }).locator("xpath=..").locator("select");
}

test.describe("GitHub Copilot harness", () => {
  // The stream scenarios hold a turn open for SUBAGENT_MS on purpose and boot
  // a fresh backend each; give them room beyond the 30 s default.
  test.describe.configure({ timeout: 120_000 });

  test("Settings → Harnesses: Experimental, enabled and available; the additional-account template shows the COPILOT_HOME help", async ({
    page,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openSettingsHarnesses(page);

    // Enabled out of the box: the switch offers to DISABLE it.
    const toggle = dialog.getByRole("switch", { name: "Disable GitHub Copilot", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const row = harnessRow(toggle);
    await expect(row.getByText("GitHub Copilot", { exact: true })).toBeVisible();
    await expect(row.getByText("built-in", { exact: true })).toBeVisible();
    await expect(row.getByText("experimental", { exact: true })).toBeVisible();
    await expect(row.getByText("disabled", { exact: true })).toHaveCount(0);
    // Available: the green status dot, and the version the stub printed.
    await expect(row.locator("span.bg-success-solid")).toBeVisible({ timeout: 15_000 });
    await expect(row.locator("span.bg-danger-solid")).toHaveCount(0);
    await expect(row).toContainText("copilot · copilot");
    await expect(row).toContainText("GitHub Copilot CLI 1.0.104");

    // Add harness → the copilot-additional template → the editor's help copy.
    await dialog.getByRole("button", { name: /Add harness/ }).click();
    const template = dialog.getByRole("button", { name: /Additional GitHub Copilot/ });
    await expect(template).toBeVisible();
    await expect(template.getByText("Experimental", { exact: true })).toBeVisible();
    await template.click();
    await expect(dialog.getByText("COPILOT_HOME override (absolute path; optional)", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Sets COPILOT_HOME on spawn/)).toBeVisible();
    await expect(dialog.getByText(/COPILOT_HOME=<path> copilot login/)).toBeVisible();
    await expect(dialog.getByPlaceholder(/copilot-2/)).toBeVisible();
  });

  test("New Task: Auto model with the discovered-only gpt-5.4-mini, Model default effort, no Speed, Auto / Plan / Read-only modes", async ({
    page,
    freshBackend,
  }) => {
    const projectName = `copilot-form-e2e-project-${randomUUID()}`;
    await registerProject(freshBackend, projectName);

    await gotoApp(page, freshBackend.bootBase);
    const form = newTaskFormPanel(page);
    const copilotButton = form.getByRole("button", { name: "GitHub Copilot", exact: true });
    await expect(copilotButton).toBeVisible({ timeout: 20_000 });
    await copilotButton.click();
    await selectProject(form, projectName);

    // Model: Auto is the default and first row; the discovered catalog adds
    // `gpt-5.4-mini`, which has no curated row, as a bare-id option.
    const modelSelect = newTaskModelSelect(page);
    await expect(modelSelect).toHaveValue("auto");
    await expect
      .poll(async () => modelSelect.locator("option").allTextContents(), {
        timeout: 15_000,
        message: "copilot model picker never listed the discovered-only gpt-5.4-mini",
      })
      .toContain("gpt-5.4-mini");
    const modelLabels = await modelSelect.locator("option").allTextContents();
    expect(modelLabels[0]).toBe("Auto");
    expect(modelLabels).toContain("Claude Opus 5.5");

    // Effort: "Model default" (`auto`) is the default.
    const effortSelect = newTaskEffortSelect(form);
    await expect(effortSelect).toHaveValue("auto");
    await expect(effortSelect.locator("option:checked")).toHaveText("Model default");

    // No Speed control for Copilot (only cursor/fx render one).
    await expect(form.getByText("Speed", { exact: true })).toHaveCount(0);
    await expect(form.getByTestId("new-task-speed")).toHaveCount(0);

    // Modes: Auto (default), Plan, Read-only.
    const modeLabel = form.getByText("Mode", { exact: true });
    const modeTrigger = modeLabel.locator("xpath=following-sibling::div[2]//button").first();
    await expect(modeTrigger).toHaveText("Auto");
    await modeTrigger.click();
    const popover = form.locator("[data-popover-open]");
    await expect(popover).toBeVisible();
    await expect(popover.locator("span.block.truncate")).toHaveText(["Auto", "Plan", "Read-only"]);
    await popover.getByRole("button", { name: /^Plan/ }).click();
    await expect(modeTrigger).toHaveText("Plan");
    // The Code/Plan pill routes to Copilot's own `--mode plan`.
    await expect(
      modeLabel.locator("xpath=following-sibling::div[1]").getByRole("button", { name: "Plan", exact: true }),
    ).toHaveAttribute("title", /--mode plan/);
  });

  test("stream marker: thinking, tool card, auto-picked line, usage chip and a live subagent tab with its nested tool call", async ({
    page,
    request,
    freshBackend,
  }) => {
    const title = `copilot-stream-e2e ${randomUUID()}`;
    const task = await createCopilotTask(request, freshBackend, title, `${FAKE_COPILOT_STREAM_PROMPT_MARKER} ${title}`);

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);
    await expect(panel.getByTestId("transcript-loading")).toHaveCount(0);
    // Started with the panel open, so the `started — …` breadcrumb arrives live.
    await startTask(request, freshBackend, task.id);

    // The opening breadcrumb names the harness, the Auto model and the Auto mode.
    await expect(panel.getByText(/^started — .*agent=copilot, model=auto, mode=auto$/)).toBeVisible({
      timeout: 15_000,
    });

    // A subagent tab while the subagent is running.
    const subagentTab = panel.getByTestId("subagent-tab");
    await expect(subagentTab).toHaveCount(1, { timeout: 30_000 });
    await expect(subagentTab).toContainText("explore");
    await expect(subagentTab).toContainText("Scan the repository for entry points");

    // Main stream so far: thinking block, the `bash` tool card, the model line.
    await expect(panel.getByText("Let me look at the repository layout first.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "thinking" })).toHaveCount(1);
    await expect(panel.locator("span.font-mono.font-medium", { hasText: /^bash$/ })).toBeVisible();
    await expect(panel.getByText("GitHub Copilot auto picked claude-sonnet-5.5", { exact: true })).toBeVisible();
    // The nested tool call lives in the subagent's own stream, not Main's.
    await expect(panel.locator("span.font-mono.font-medium", { hasText: /^grep$/ })).toHaveCount(0);

    // Open the subagent tab: its transcript shows the nested `grep` call.
    await subagentTab.click();
    await expect(subagentTab).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator("span.font-mono.font-medium", { hasText: /^grep$/ })).toBeVisible({ timeout: 15_000 });

    // The turn finishes: final message, a settled task, and the usage chip
    // (per-turn tokens only → the compact ↑in ↓out form; the tooltip lists the
    // token counts and never an unverified AI-credits figure).
    await expect
      .poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 60_000 })
      .toBe("review");
    await expect(panel.getByTestId("subagent-tab")).toHaveCount(0, { timeout: 15_000 });
    await expect(panel.getByText("All done — the fake Copilot turn finished.", { exact: true })).toBeVisible();
    const usageChip = panel.getByTestId("fx-usage-chip");
    await expect(usageChip).toBeVisible();
    await expect(usageChip).toHaveText("↑1.2k ↓340");
    await expect(usageChip).toHaveAttribute("title", /cache read 800/);
    await expect(usageChip).toHaveAttribute("title", /reasoning 60/);
    await expect(usageChip).not.toHaveAttribute("title", /AI credits/);
    // The raw sentinel never renders as a transcript line.
    await expect(panel.getByText("fx-usage:", { exact: false })).toHaveCount(0);

    // Persisted: one thinking row for the single reasoning block.
    const events = await taskEvents(request, freshBackend, task.id);
    expect(events.filter((e) => e.stream === "thinking")).toHaveLength(1);
  });

  test("plan marker in Plan mode: plan card → dialog → edit → Approve flips the task to Auto with a status line", async ({
    page,
    request,
    freshBackend,
  }) => {
    const title = `copilot-plan-e2e ${randomUUID()}`;
    const task = await createCopilotTask(request, freshBackend, title, `${FAKE_COPILOT_PLAN_PROMPT_MARKER} ${title}`, {
      mode: "plan",
    });
    expect((await getTask(request, freshBackend, task.id)).mode).toBe("plan");
    await startTask(request, freshBackend, task.id);

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);

    const planCard = panel.getByRole("button", { name: /View plan/ });
    await expect(planCard).toBeVisible({ timeout: 60_000 });
    // The run has to settle before the plan is approvable.
    await expect
      .poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 60_000 })
      .toBe("review");
    await planCard.click();

    // Edit the plan, then approve the edited version.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const planText = page.locator("textarea.font-mono");
    await expect(planText).toBeVisible();
    await expect(planText).toHaveValue(/# Fake plan/);
    await planText.fill("# Fake plan (edited)\n\n1. Inspect the repository\n2. Make the edited change\n");
    const approve = page.getByRole("button", { name: "Save & Approve", exact: true });
    await expect(approve).toBeVisible();
    await approve.click();

    // A successful approve closes the dialog itself.
    await expect(approve).toBeHidden();
    await expect
      .poll(async () => (await getTask(request, freshBackend, task.id)).mode, { timeout: 15_000 })
      .toBe("auto");
    await expect(panel.getByText(PLAN_APPROVED_STATUS, { exact: true })).toBeVisible({ timeout: 15_000 });

    // The approval went out with the edited plan EMBEDDED (Copilot writes no
    // plan file) — and says it was edited.
    let approval: string | undefined;
    await expect
      .poll(async () => {
        approval = (await taskEvents(request, freshBackend, task.id)).find(
          (e) => e.stream === "user" && e.data.includes("The plan is approved"),
        )?.data;
        return approval !== undefined;
      })
      .toBe(true);
    expect(approval).toContain("approved with edits");
    expect(approval).toContain("Make the edited change");

    // Task details show the flipped mode. The follow-up approval turn has to
    // settle first so the inline editor (idle tasks only) is what we read.
    await expect
      .poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 60_000 })
      .toBe("review");
    await panel.getByText("Task details", { exact: true }).click();
    const modeValue = panel.locator("dt", { hasText: /^Mode$/ }).locator("xpath=following-sibling::dd[1]");
    await expect
      .poll(async () => modeValue.evaluate((el) => el.querySelector("select")?.value ?? el.textContent?.trim() ?? ""))
      .toBe("auto");
  });

  test("auth marker: the login status line and a failed run", async ({ page, request, freshBackend }) => {
    const title = `copilot-auth-e2e ${randomUUID()}`;
    const task = await createCopilotTask(request, freshBackend, title, `${FAKE_COPILOT_AUTH_PROMPT_MARKER} ${title}`);
    await startTask(request, freshBackend, task.id);

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);

    await expect(panel.getByText(COPILOT_LOGIN_STATUS_TEXT, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await listRuns(request, freshBackend, task.id))[0]?.status, { timeout: 30_000 })
      .toBe("failed");
    const [run] = await listRuns(request, freshBackend, task.id);
    expect(run?.exitCode).toBe(1);
    // The login line is emitted once per run, not once per stderr line.
    const events = await taskEvents(request, freshBackend, task.id);
    expect(events.filter((e) => e.stream === "status" && e.data.includes("isn't logged in"))).toHaveLength(1);
  });

  test("a follow-up sent mid-turn runs as the next turn with a 'resuming GitHub Copilot session' status", async ({
    page,
    request,
    freshBackend,
  }) => {
    const title = `copilot-followup-e2e ${randomUUID()}`;
    const task = await createCopilotTask(request, freshBackend, title, `${FAKE_COPILOT_STREAM_PROMPT_MARKER} ${title}`);

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);
    await startTask(request, freshBackend, task.id);

    // The first turn is provably in flight while its subagent tab is up.
    await expect(panel.getByTestId("subagent-tab")).toHaveCount(1, { timeout: 30_000 });

    // Send the follow-up (no marker → the plain fake turn) from the composer.
    const followUp = `follow-up ${randomUUID().slice(0, 8)}`;
    const composer = panel.getByTestId("send-textarea");
    await composer.fill(followUp);
    // The panel's `task` snapshot is polled: until it carries the live run id
    // the composer can't send, and Enter would stash the draft in the backlog
    // instead. An enabled Send button is the signal that it can.
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 15_000 });
    await composer.press("Enter");

    // It queues behind the running turn, then runs as a NEW run on the same
    // session: the resume status line, the user bubble and the reply.
    await expect(panel.getByText(/^resuming GitHub Copilot session \S{8}…$/)).toBeVisible({ timeout: 90_000 });
    await expect(panel.getByText("Hello from fake GitHub Copilot.", { exact: true })).toBeVisible({ timeout: 30_000 });
    // (Like every one-shot harness, the bubble is echoed when queued and again
    // when the queued turn starts — only its presence matters here.)
    await expect(panel.getByText(followUp, { exact: true }).first()).toBeVisible();

    await expect
      .poll(async () => (await listRuns(request, freshBackend, task.id)).length, { timeout: 30_000 })
      .toBe(2);
    await expect
      .poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 30_000 })
      .toBe("review");
    const runs = await listRuns(request, freshBackend, task.id);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
    // Both turns share one self-issued session id.
    const sessionIds = new Set(runs.map((r) => r.copilotSessionId));
    expect(sessionIds.size).toBe(1);
    expect([...sessionIds][0]).toMatch(/^fake-copilot-session-/);
  });
});
