import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/fx-0.0.14-and-cursor-updates.md E2 (D33 flow
 * 2): the speed tier (`off | fast | ultrafast`) end to end.
 *
 * fx only offers a tier when discovery says the model has it (fx ≥0.0.14's
 * `models --json` `models[].fast` / `.ultrafast`, copied onto the merged
 * picker row by `mergeModelOptions` rule 8). The worker-wide fx stub
 * (e2e/fixtures.ts) prints an id-only catalog, so this file adds its own fx
 * harness whose `env` points the stub at a `models[]` catalog of three
 * models: `openai/gpt-6.1-sol` (fast + ultrafast), `openai/gpt-5.2` (fast)
 * and `deepseek/deepseek-v4-flash` (neither). Cursor's Fast comes from the
 * curated variant table instead (`cursorModelSupportsFast`).
 *
 * Covered: the New Task form's picker per model and the Ultrafast cost hint;
 * the created task's stored `speed`; editing it in task details; the
 * `lastSpeed:<kind>` pref seeding the next form; the §3.1 reset rules (fx
 * drops a tier only on a user model change whose model lacks it, in the form
 * and in task details; cursor clears Fast whenever the model/effort loses
 * its variant); a stored fx tier the model doesn't offer kept as a disabled
 * "(not offered)" segment; the profile lock; cursor's Off/Fast; an Ultrafast
 * agent profile through Settings → Agents, the task-bound profile details
 * dialog, and a bundle export → import; and the fake driver's "isn't
 * offered" breadcrumb.
 */

/** Literal copy of `FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER` (src/bun/agents.ts)
 *  — specs can't import `src/bun/*` (see e2e/fx-interactions.spec.ts). */
const FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER = "__agetor_fake_fx_speed_unoffered__";

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const SPEED_HARNESS = { id: `fx-speed-e2e-${suffix}`, label: `fx.sh (speed e2e ${suffix})` };

const SOL = "openai/gpt-6.1-sol";
const GPT52 = "openai/gpt-5.2";
const DEEPSEEK = "deepseek/deepseek-v4-flash";

const createdTaskIds: string[] = [];
const createdProfileIds: string[] = [];
/** Shared across the serial tests: the task the New Task form creates. */
let formTaskTitle = "";
let formTaskId = "";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** fx ≥0.0.14's `models --json` envelope: `ids` plus a `models[]` entry per
 *  id. Names match the curated labels so the picker text stays predictable. */
function speedCatalog(): Record<string, unknown> {
  const models = [
    { id: SOL, name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max"], fast: true, ultrafast: true },
    { id: GPT52, name: "GPT-5.2", efforts: ["none", "low", "medium", "high", "xhigh"], fast: true, ultrafast: false },
    { id: DEEPSEEK, name: "DeepSeek V4 Flash", efforts: ["none", "low", "medium", "high"], fast: false, ultrafast: false },
  ];
  return {
    kind: "models",
    count: models.length,
    shown_count: models.length,
    more_count: 0,
    private_models_hidden: false,
    ids: models.map((m) => m.id),
    models,
  };
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

async function createTaskRest(
  request: APIRequestContext,
  backend: E2EBackend,
  data: Record<string, unknown>,
  start: boolean,
): Promise<{ id: string; title: string }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { isolation: "none", workdir: tmpdir(), ...data },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as { id: string; title: string };
  createdTaskIds.push(task.id);
  if (start) {
    const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
  }
  return task;
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

async function selectHarness(page: Page, label: string): Promise<void> {
  const button = newTaskFormPanel(page).getByRole("button", { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
}

/** The New Task form's Model `<select>` — see e2e/fx-models.spec.ts's
 *  identical helper for the structural locator. */
function newTaskModelSelect(page: Page): Locator {
  return newTaskFormPanel(page).getByTestId("refresh-models").locator("xpath=../..").locator("select");
}

/** Registers a per-name directory as a project (no native folder dialog in
 *  the headless harness) — mirrors e2e/fx-interactions.spec.ts. */
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

/** The task-details Model `<select>` — see e2e/fx-models.spec.ts's identical
 *  helper: the `<dd>` right after the `<dt>` holding the ↻ button. */
function detailsModelSelect(panel: Locator): Locator {
  return panel
    .getByTestId("refresh-models-details")
    .locator("xpath=ancestor::dt[1]/following-sibling::dd[1]")
    .locator("select");
}

/** `[model, speed]` of a stored task, for polling a PATCH the UI fired. */
async function modelAndSpeed(request: APIRequestContext, backend: E2EBackend, id: string): Promise<[string, string]> {
  const task = await getTask(request, backend, id);
  return [task.model as string, task.speed as string];
}

async function getPreferences(request: APIRequestContext, backend: E2EBackend): Promise<Record<string, string>> {
  const res = await request.get(`${backend.apiBase}/preferences`, { headers: auth(backend) });
  expect(res.ok(), `GET /preferences -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, string>;
}

/** fx tiers come from this file's harness discovery, which can still be in
 *  flight when a test runs alone (`--grep`) or on a loaded machine. */
const DISCOVERY_TIMEOUT = 20_000;

/** Asserts a `SpeedPicker` offers exactly `tiers` (in order) and none other.
 *  Waits up to DISCOVERY_TIMEOUT for the count, so it doubles as the
 *  discovery gate: before discovery an fx model's tiers are unknown. */
async function expectTiers(picker: Locator, testId: string, tiers: string[]): Promise<void> {
  await expect(picker).toBeVisible({ timeout: DISCOVERY_TIMEOUT });
  const segments = picker.locator(`[data-testid^="${testId}-"]`);
  await expect(segments).toHaveCount(tiers.length, { timeout: DISCOVERY_TIMEOUT });
  for (const tier of tiers) await expect(picker.getByTestId(`${testId}-${tier}`)).toBeVisible();
}

/** Opens Settings → Agents. */
async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

/** `TaskLaunchPickers`' labelled native `<select>` — see
 *  e2e/agent-profiles-settings.spec.ts's identical helper. */
function launchSelect(container: Locator, label: string): Locator {
  return container
    .locator("label", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::*[1]//select");
}

/** The `last*:fx` prefs the New Task form test's submit writes. They live on
 *  the worker-scoped backend, so a later spec file on the same worker would
 *  inherit them; afterAll puts back what was there before. */
const FX_FORM_PREF_KEYS = ["lastMode:fx", "lastModel:fx", "lastEffort:fx", "lastSpeed:fx", "lastMaxMode:fx"];
/** Value to write back for a key that wasn't set before this file ran (there
 *  is no preference DELETE): fx's own defaults. */
const FX_FORM_PREF_DEFAULTS: Record<string, string> = {
  "lastMode:fx": "yolo",
  "lastModel:fx": DEEPSEEK,
  "lastEffort:fx": "auto",
  "lastSpeed:fx": "off",
  "lastMaxMode:fx": "false",
};
let fxPrefsBefore: Record<string, string> = {};

async function fetchPreferences(backend: E2EBackend): Promise<Record<string, string>> {
  const res = await fetch(`${backend.apiBase}/preferences`, { headers: auth(backend) });
  if (!res.ok) throw new Error(`GET /preferences -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, string>;
}

test.describe("speed picker", () => {
  test.beforeAll(async ({ backend }) => {
    const prefs = await fetchPreferences(backend);
    fxPrefsBefore = {};
    for (const key of FX_FORM_PREF_KEYS) {
      const value = prefs[key];
      if (value !== undefined) fxPrefsBefore[key] = value;
    }
    await patchHarness(backend, "fx", { enabled: true });
    const dir = path.join(backend.dataDir, "speed-picker-e2e");
    mkdirSync(dir, { recursive: true });
    const catalogFile = path.join(dir, "models.json");
    writeFileSync(catalogFile, JSON.stringify(speedCatalog()));
    const res = await fetch(`${backend.apiBase}/harnesses`, {
      method: "POST",
      headers: { ...auth(backend), "content-type": "application/json" },
      body: JSON.stringify({
        id: SPEED_HARNESS.id,
        kind: "fx",
        label: SPEED_HARNESS.label,
        home: null,
        bin: null,
        env: { AGETOR_E2E_FX_MODELS_JSON: catalogFile },
      }),
    });
    if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    for (const id of createdProfileIds) {
      await fetch(`${backend.apiBase}/agent-profiles/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    await fetch(`${backend.apiBase}/harnesses/${SPEED_HARNESS.id}`, { method: "DELETE", headers: auth(backend) }).catch(
      () => {},
    );
    await patchHarness(backend, "cursor", { enabled: false }).catch(() => {});
    for (const key of FX_FORM_PREF_KEYS) {
      await fetch(`${backend.apiBase}/preferences/${key}`, {
        method: "PUT",
        headers: { ...auth(backend), "content-type": "application/json" },
        body: JSON.stringify({ value: fxPrefsBefore[key] ?? FX_FORM_PREF_DEFAULTS[key] }),
      }).catch(() => {});
    }
  });

  test("New Task form: tiers follow the discovered model — Off/Fast/Ultrafast, Off/Fast, none — and the task stores the pick", async ({
    page,
    request,
    backend,
  }) => {
    const projectName = `speed-e2e-project-${randomUUID()}`;
    await registerProject(backend, projectName);

    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);
    await selectHarness(page, SPEED_HARNESS.label);
    await selectProject(form, projectName);

    const modelSelect = newTaskModelSelect(page);
    // This harness's own catalog, curated order (the catalogOnly Sol row is
    // in because discovery has it).
    await expect
      .poll(async () => modelSelect.locator("option").allTextContents(), { timeout: 20_000 })
      .toEqual(["DeepSeek V4 Flash", "GPT-5.2", "GPT-6.1 Sol"]);

    // The default model offers no tier, so there's no picker at all.
    await expect(modelSelect).toHaveValue(DEEPSEEK);
    const picker = form.getByTestId("new-task-speed");
    await expect(picker).toHaveCount(0);

    await modelSelect.selectOption(SOL);
    await expectTiers(picker, "new-task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "off");
    await expect(picker.getByTestId("new-task-speed-ultrafast")).toHaveAttribute("title", /costs more per token/);

    await modelSelect.selectOption(GPT52);
    await expectTiers(picker, "new-task-speed", ["off", "fast"]);
    await expect(picker.getByTestId("new-task-speed-ultrafast")).toHaveCount(0);

    await modelSelect.selectOption(DEEPSEEK);
    await expect(picker).toHaveCount(0);

    await modelSelect.selectOption(SOL);
    await picker.getByTestId("new-task-speed-ultrafast").click();
    await expect(picker).toHaveAttribute("data-value", "ultrafast");
    await expect(picker.getByTestId("new-task-speed-ultrafast")).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByTestId("new-task-speed-off")).toHaveAttribute("aria-pressed", "false");

    formTaskTitle = `speed-picker-form-e2e ${randomUUID()}`;
    await form.getByPlaceholder("Short description").fill(formTaskTitle);
    await form.getByTestId("prompt-textarea").fill(formTaskTitle);
    await form.getByTestId("worktree-options").getByTestId("isolate-toggle").uncheck();
    await form.getByRole("button", { name: "To backlog", exact: true }).click();

    let row: Record<string, any> | null = null;
    await expect(async () => {
      row = await findTaskByTitle(request, backend, formTaskTitle);
      expect(row).not.toBeNull();
    }).toPass({ timeout: 15_000 });
    formTaskId = row!.id as string;
    createdTaskIds.push(formTaskId);

    const stored = await getTask(request, backend, formTaskId);
    expect(stored.agent).toBe(SPEED_HARNESS.id);
    expect(stored.model).toBe(SOL);
    expect(stored.speed).toBe("ultrafast");
  });

  test("Task details: the stored tier shows and can be edited", async ({ page, request, backend }) => {
    expect(formTaskId, "the New Task form test must run first").not.toBe("");
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, formTaskTitle);
    await panel.getByText("Task details", { exact: true }).click();

    const picker = panel.getByTestId("task-speed");
    await expectTiers(picker, "task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "ultrafast");

    await picker.getByTestId("task-speed-fast").click();
    await expect(picker).toHaveAttribute("data-value", "fast");
    await expect.poll(async () => (await getTask(request, backend, formTaskId)).speed).toBe("fast");

    await picker.getByTestId("task-speed-off").click();
    await expect(picker).toHaveAttribute("data-value", "off");
    await expect.poll(async () => (await getTask(request, backend, formTaskId)).speed).toBe("off");
  });

  // NewTaskForm writes `lastSpeed:<kind>` on submit (it replaced
  // `lastFast:<kind>`) and seeds the next form from it. The first test's
  // submit picked Ultrafast on GPT-6.1 Sol.
  test("New Task form: the last fx pick is remembered (lastSpeed:fx) and seeds the next form", async ({
    page,
    request,
    backend,
  }) => {
    expect(formTaskId, "the New Task form test must run first").not.toBe("");
    await expect
      .poll(async () => {
        const prefs = await getPreferences(request, backend);
        return [prefs["lastSpeed:fx"], prefs["lastModel:fx"]];
      })
      .toEqual(["ultrafast", SOL]);
    expect(Object.keys(await getPreferences(request, backend)).filter((k) => k.startsWith("lastFast:"))).toEqual([]);

    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);
    await selectHarness(page, SPEED_HARNESS.label);
    await expect(newTaskModelSelect(page)).toHaveValue(SOL);
    const picker = form.getByTestId("new-task-speed");
    await expectTiers(picker, "new-task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "ultrafast");
  });

  // Plan §3.1: fx resets a tier only on a USER model change, and only when
  // the new model's tiers are known and exclude it.
  test("New Task form: an fx model change drops a tier the new model lacks and keeps one it has", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);
    await selectHarness(page, SPEED_HARNESS.label);
    const modelSelect = newTaskModelSelect(page);
    // Discovery is in once the catalogOnly Sol row is listed.
    await expect
      .poll(async () => modelSelect.locator("option").allTextContents(), { timeout: 20_000 })
      .toEqual(["DeepSeek V4 Flash", "GPT-5.2", "GPT-6.1 Sol"]);
    const picker = form.getByTestId("new-task-speed");

    await modelSelect.selectOption(SOL);
    await picker.getByTestId("new-task-speed-ultrafast").click();
    await expect(picker).toHaveAttribute("data-value", "ultrafast");

    // GPT-5.2 has no Ultrafast lane → back to Off.
    await modelSelect.selectOption(GPT52);
    await expectTiers(picker, "new-task-speed", ["off", "fast"]);
    await expect(picker).toHaveAttribute("data-value", "off");

    // Fast survives a move to a model that also has it.
    await picker.getByTestId("new-task-speed-fast").click();
    await expect(picker).toHaveAttribute("data-value", "fast");
    await modelSelect.selectOption(SOL);
    await expectTiers(picker, "new-task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "fast");

    // DeepSeek offers no tier: reset to Off, so the picker is gone entirely
    // (not a stale "Fast (not offered)" segment).
    await modelSelect.selectOption(DEEPSEEK);
    await expect(picker).toHaveCount(0);
    await modelSelect.selectOption(SOL);
    await expect(picker).toHaveAttribute("data-value", "off");
  });

  test("Task details (fx): a model change drops a tier the new model lacks and keeps one it has", async ({
    page,
    request,
    backend,
  }) => {
    const title = `speed-details-model-change-e2e ${randomUUID()}`;
    const task = await createTaskRest(
      request,
      backend,
      { title, prompt: title, agent: SPEED_HARNESS.id, model: SOL, speed: "ultrafast" },
      false,
    );
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByText("Task details", { exact: true }).click();
    const picker = panel.getByTestId("task-speed");
    // All three tiers listed ⇒ discovery for this harness is in.
    await expectTiers(picker, "task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "ultrafast");
    const modelSelect = detailsModelSelect(panel);

    await modelSelect.selectOption(GPT52);
    await expect.poll(() => modelAndSpeed(request, backend, task.id)).toEqual([GPT52, "off"]);
    await expectTiers(picker, "task-speed", ["off", "fast"]);
    await expect(picker).toHaveAttribute("data-value", "off");

    await picker.getByTestId("task-speed-fast").click();
    await expect.poll(() => modelAndSpeed(request, backend, task.id)).toEqual([GPT52, "fast"]);
    await modelSelect.selectOption(SOL);
    await expect.poll(() => modelAndSpeed(request, backend, task.id)).toEqual([SOL, "fast"]);
    await expect(picker).toHaveAttribute("data-value", "fast");

    await modelSelect.selectOption(DEEPSEEK);
    await expect.poll(() => modelAndSpeed(request, backend, task.id)).toEqual([DEEPSEEK, "off"]);
    await expect(picker).toHaveCount(0);
  });

  // fx is never auto-cleared on load (its tiers come from discovery alone):
  // a stored tier the model doesn't offer stays visible, disabled, until the
  // user picks another one.
  test("Task details (fx): a stored tier the model doesn't offer shows as a disabled '(not offered)' segment and is kept", async ({
    page,
    request,
    backend,
  }) => {
    const title = `speed-details-not-offered-e2e ${randomUUID()}`;
    const task = await createTaskRest(
      request,
      backend,
      { title, prompt: title, agent: SPEED_HARNESS.id, model: DEEPSEEK, speed: "fast" },
      false,
    );
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByText("Task details", { exact: true }).click();
    // Wait for discovery (the catalogOnly Sol row only shows once it's in),
    // so the "not offered" verdict below is against the real tier list.
    await expect
      .poll(async () => detailsModelSelect(panel).locator("option").allTextContents(), { timeout: 20_000 })
      .toContain("GPT-6.1 Sol");

    const picker = panel.getByTestId("task-speed");
    await expect(picker).toHaveAttribute("data-value", "fast");
    await expect(picker.locator('[data-testid^="task-speed-"]')).toHaveCount(2);
    const stale = picker.getByTestId("task-speed-fast");
    await expect(stale).toHaveText("Fast (not offered)");
    await expect(stale).toBeDisabled();
    await expect(stale).toHaveAttribute("aria-pressed", "true");
    await expect(stale).toHaveAttribute("title", /isn't offered for this model/);
    await expect(picker.getByTestId("task-speed-off")).toBeEnabled();
    expect((await getTask(request, backend, task.id)).speed).toBe("fast");

    await picker.getByTestId("task-speed-off").click();
    await expect.poll(async () => (await getTask(request, backend, task.id)).speed).toBe("off");
    // Off is the only tier left, so the row disappears.
    await expect(picker).toHaveCount(0);
  });

  test("Task details: a profile-bound task's speed picker is locked like the other launch fields", async ({
    page,
    request,
    backend,
  }) => {
    const profileRes = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { name: `Locked Sol ${suffix}`, harness: SPEED_HARNESS.id, model: SOL, speed: "ultrafast" },
    });
    expect(profileRes.ok(), `POST /agent-profiles -> ${profileRes.status()}: ${await profileRes.text()}`).toBeTruthy();
    const profile = (await profileRes.json()) as { id: string };
    createdProfileIds.push(profile.id);
    const title = `speed-details-locked-e2e ${randomUUID()}`;
    const task = await createTaskRest(request, backend, { title, prompt: title, agentProfileId: profile.id }, false);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByText("Task details", { exact: true }).click();
    await expect(panel.getByTestId("task-agent-profile-open")).toBeVisible();
    const picker = panel.getByTestId("task-speed");
    await expectTiers(picker, "task-speed", ["off", "fast", "ultrafast"]);
    await expect(picker).toHaveAttribute("data-value", "ultrafast");
    for (const tier of ["off", "fast", "ultrafast"]) {
      await expect(picker.getByTestId(`task-speed-${tier}`)).toBeDisabled();
    }
    // RunPanel also locks launch fields while a task is running/blocked; this
    // task never started, so the profile is what disables the segments.
    const stored = await getTask(request, backend, task.id);
    expect(stored.column).toBe("backlog");
    expect(stored.agentProfileId).toBe(profile.id);
    expect(stored.speed).toBe("ultrafast");
  });

  test("New Task form (cursor): Fast is cleared when the model loses its Fast variant", async ({ page, backend }) => {
    await patchHarness(backend, "cursor", { enabled: true });
    try {
      await gotoApp(page, backend.bootBase);
      const form = newTaskFormPanel(page);
      await selectHarness(page, "Cursor");
      const modelSelect = newTaskModelSelect(page);
      const picker = form.getByTestId("new-task-speed");

      await modelSelect.selectOption("gpt-5.3-codex");
      await picker.getByTestId("new-task-speed-fast").click();
      await expect(picker).toHaveAttribute("data-value", "fast");

      // Cursor's "Auto" model has no -fast variant.
      await modelSelect.selectOption("auto");
      await expect(picker).toHaveCount(0);

      // Coming back does not restore Fast — it was cleared, not hidden.
      await modelSelect.selectOption("gpt-5.3-codex");
      await expectTiers(picker, "new-task-speed", ["off", "fast"]);
      await expect(picker).toHaveAttribute("data-value", "off");
    } finally {
      await patchHarness(backend, "cursor", { enabled: false });
    }
  });

  test("Task details (cursor): a model change that loses the Fast variant clears speed to off", async ({
    page,
    request,
    backend,
  }) => {
    await patchHarness(backend, "cursor", { enabled: true });
    try {
      const title = `speed-details-cursor-clear-e2e ${randomUUID()}`;
      const task = await createTaskRest(
        request,
        backend,
        { title, prompt: title, agent: "cursor", model: "gpt-5.3-codex", effort: "high", speed: "fast" },
        false,
      );
      await gotoApp(page, backend.bootBase);
      const panel = await openTask(page, title);
      await panel.getByText("Task details", { exact: true }).click();
      const picker = panel.getByTestId("task-speed");
      await expectTiers(picker, "task-speed", ["off", "fast"]);
      await expect(picker).toHaveAttribute("data-value", "fast");

      await detailsModelSelect(panel).selectOption("auto");
      await expect.poll(() => modelAndSpeed(request, backend, task.id)).toEqual(["auto", "off"]);
      await expect(picker).toHaveCount(0);
    } finally {
      await patchHarness(backend, "cursor", { enabled: false });
    }
  });

  test("cursor: a Fast-capable model offers Off/Fast, never Ultrafast", async ({ page, backend }) => {
    await patchHarness(backend, "cursor", { enabled: true });
    try {
      await gotoApp(page, backend.bootBase);
      const form = newTaskFormPanel(page);
      await selectHarness(page, "Cursor");

      // Codex 5.3 has a Fast variant at every effort it offers
      // (`CURSOR_MODEL_SPECS["gpt-5.3-codex"].fastEfforts`).
      await newTaskModelSelect(page).selectOption("gpt-5.3-codex");
      const picker = form.getByTestId("new-task-speed");
      await expectTiers(picker, "new-task-speed", ["off", "fast"]);
      await expect(picker.getByTestId("new-task-speed-ultrafast")).toHaveCount(0);
      await picker.getByTestId("new-task-speed-fast").click();
      await expect(picker).toHaveAttribute("data-value", "fast");
    } finally {
      await patchHarness(backend, "cursor", { enabled: false });
    }
  });

  test("agent profile: Ultrafast round-trips through Settings → Agents, the profile details dialog and a bundle export → import", async ({
    page,
    request,
    backend,
  }) => {
    const name = `Ultrafast Sol ${suffix}`;
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    await dialog.getByTestId("agent-profile-add").click();
    const form = dialog.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();
    await form.getByTestId("agent-profile-name").fill(name);
    await form.getByRole("button", { name: SPEED_HARNESS.label, exact: true }).click();
    await launchSelect(form, "Model").selectOption(SOL);

    const picker = form.getByTestId("launch-speed");
    await expectTiers(picker, "launch-speed", ["off", "fast", "ultrafast"]);
    await picker.getByTestId("launch-speed-ultrafast").click();
    await expect(picker).toHaveAttribute("data-value", "ultrafast");
    await form.getByTestId("agent-profile-save").click();
    await expect(form).toBeHidden();

    const listRes = await request.get(`${backend.apiBase}/agent-profiles`, { headers: auth(backend) });
    const list = (await listRes.json()) as Array<Record<string, any>>;
    const profile = list.find((p) => p.name === name);
    expect(profile, `no agent profile named "${name}"`).toBeTruthy();
    createdProfileIds.push(profile!.id as string);
    expect(profile!.harness).toBe(SPEED_HARNESS.id);
    expect(profile!.model).toBe(SOL);
    expect(profile!.speed).toBe("ultrafast");

    // Reopening the editor seeds the stored tier.
    const row = dialog.locator('[data-testid="agent-profile-row"]').filter({ hasText: name });
    await row.getByTestId("agent-profile-edit").click();
    const editForm = dialog.getByTestId("agent-profile-form");
    await expect(editForm.getByTestId("launch-speed")).toHaveAttribute("data-value", "ultrafast");
    await editForm.getByTestId("agent-profile-cancel").click();
    await expect(editForm).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // A task launched from the profile copies the tier, and the bound
    // profile's details dialog shows it.
    const boundTitle = `speed-profile-bound-e2e ${randomUUID()}`;
    const bound = await createTaskRest(
      request,
      backend,
      { title: boundTitle, prompt: boundTitle, agentProfileId: profile!.id },
      false,
    );
    expect((await getTask(request, backend, bound.id)).speed).toBe("ultrafast");
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    const panel = await openTask(page, boundTitle);
    await panel.getByText("Task details", { exact: true }).click();
    await panel.getByTestId("task-agent-profile-open").click();
    await expect(page.getByTestId("agent-profile-details-speed")).toHaveText("Ultrafast");

    // Bundle export → import (REST): the imported copy keeps the tier.
    const exportRes = await request.post(`${backend.apiBase}/bundle/export`, {
      headers: auth(backend),
      data: { agentIds: [profile!.id] },
    });
    expect(exportRes.ok(), `POST /bundle/export -> ${exportRes.status()}: ${await exportRes.text()}`).toBeTruthy();
    const { text } = (await exportRes.json()) as { text: string };
    const bundle = JSON.parse(text) as { agents: Array<Record<string, any>> };
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0]!.speed).toBe("ultrafast");

    const importRes = await request.post(`${backend.apiBase}/bundle/import`, {
      headers: auth(backend),
      data: { text },
    });
    expect(importRes.status(), await importRes.text()).toBe(201);
    const imported = (await importRes.json()) as { agents: Array<Record<string, any>> };
    expect(imported.agents).toHaveLength(1);
    const copy = imported.agents[0]!;
    createdProfileIds.push(copy.id as string);
    expect(copy.name).toBe(`${name} (imported)`);
    expect(copy.harness).toBe(SPEED_HARNESS.id);
    expect(copy.model).toBe(SOL);
    expect(copy.speed).toBe("ultrafast");
  });

  test("speed-unoffered marker: one 'isn't offered' breadcrumb for the task's tier, none for off", async ({
    page,
    request,
    backend,
  }) => {
    const ultraTitle = `speed-unoffered-ultra-e2e ${randomUUID()}`;
    await createTaskRest(
      request,
      backend,
      {
        title: ultraTitle,
        prompt: `${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER} ${ultraTitle}`,
        agent: SPEED_HARNESS.id,
        model: SOL,
        speed: "ultrafast",
      },
      true,
    );
    const fastTitle = `speed-unoffered-fast-e2e ${randomUUID()}`;
    await createTaskRest(
      request,
      backend,
      {
        title: fastTitle,
        prompt: `${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER} ${fastTitle}`,
        agent: "fx",
        model: GPT52,
        speed: "fast",
      },
      true,
    );
    const offTitle = `speed-unoffered-off-e2e ${randomUUID()}`;
    await createTaskRest(
      request,
      backend,
      {
        title: offTitle,
        prompt: `${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER} ${offTitle}`,
        agent: "fx",
        model: GPT52,
        speed: "off",
      },
      true,
    );

    await gotoApp(page, backend.bootBase);
    let panel = await openTask(page, ultraTitle);
    const ultraLine = panel.getByText(`fx: Ultrafast isn't offered for ${SOL} — running without it`, { exact: true });
    await expect(ultraLine).toBeVisible({ timeout: 15_000 });
    await expect(ultraLine).toHaveCount(1);
    await page.keyboard.press("Escape");

    panel = await openTask(page, fastTitle);
    const fastLine = panel.getByText(`fx: Fast isn't offered for ${GPT52} — running without it`, { exact: true });
    await expect(fastLine).toBeVisible({ timeout: 15_000 });
    await expect(fastLine).toHaveCount(1);
    await page.keyboard.press("Escape");

    panel = await openTask(page, offTitle);
    await expect(panel.getByText(`fake response to: ${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER} ${offTitle}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByText("isn't offered for")).toHaveCount(0);
  });
});
