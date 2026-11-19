import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference, selectProject } from "./helpers";
import {
  backlogButton,
  expectEffort,
  expectHarness,
  expectModel,
  expectSpeed,
  fillNewTask,
  newTaskPanel,
  openMore,
  pickEffort,
  pickHarness,
  pickModel,
  pickSpeed,
  runTaskButton,
  setPrimaryMode,
  expectPrimaryMode,
} from "./launch-helpers";
import { plantFakeCodexAppServer, writeFakeCodexCatalog, type FakeCodexModel } from "../src/bun/test-codex-app-server.ts";
import { CODE_PLAN_MODE } from "../src/shared/types.ts";

/**
 * The behaviors the New Task panel's launch state carries that no field-level
 * spec sees (docs/architecture/task-launch-ui.md, "Hidden behaviors"). Each
 * scenario drives the assembled panel through the UI and reads the result
 * back through the stored task or after a page reload, so it does not depend
 * on the DOM beyond `launch-helpers.ts`:
 *
 * P1 per-kind cache: codex → Claude Code → codex keeps each kind's picks.
 * P2 remembered picks per kind (mode, model, effort, speed) after a backlog
 *    submit and a reload.
 * P3 a remembered model only the CLI's catalog knows is applied once the
 *    catalog lands.
 * P4 the `defaultHarness` preference selects its harness on reload.
 * P5 a selected pipeline deleted on the Pipelines page is cleared from the form.
 * P6 a selected agent profile deleted through the API is cleared too.
 * P7 Isolate stays as set across two submits.
 * P8 a remembered Fast tier is dropped when the remembered model (applied once the catalog lands)
 *    offers no Fast tier.
 * P9 a selected pipeline that cannot start blocks Run task (with its reason) but not Add to backlog.
 *
 * The backend's claude is the opt-in stub with a model catalog that carries a
 * Fast-capable `opus-6`; its codex is the app-server stub with a catalog of
 * two models, one of them Fast-capable.
 */

const LADDER = ["low", "medium", "high", "xhigh", "max"];
const WORK_DIR = mkdtempSync(path.join("/tmp", "agetor-e2e-launch-behaviors-"));
const CLAUDE_CATALOG = path.join(WORK_DIR, "claude-models.json");
writeFileSync(
  CLAUDE_CATALOG,
  JSON.stringify([
    { value: "default", resolvedModel: "claude-opus-6", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
    { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: LADDER },
  ]),
);

const CODEX_FAST = "gpt-7-e2e";
const CODEX_PLAIN = "gpt-6.1-sol";
// Known only to the CLI's catalog (not the curated rows) and without a Fast tier: P8's remembered model.
const CODEX_LITE = "gpt-7-e2e-lite";
const CODEX_CATALOG: FakeCodexModel[] = [
  { id: CODEX_FAST, displayName: "GPT-7 E2E", efforts: ["low", "high"], defaultEffort: "low", fast: true },
  { id: CODEX_PLAIN, displayName: "GPT-6.1 Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: CODEX_LITE, displayName: "GPT-7 E2E Lite", efforts: ["low"], defaultEffort: "low" },
];
const CODEX_BIN = (() => {
  const dir = path.join(WORK_DIR, "codex");
  mkdirSync(dir, { recursive: true });
  const catalogFile = path.join(dir, "model-list.json");
  writeFakeCodexCatalog(catalogFile, CODEX_CATALOG);
  return plantFakeCodexAppServer({ pages: [], dir, version: "codex-cli 0.166.0", catalogFile });
})();

const CLAUDE_MODEL = "opus-6";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}
function json(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { ...auth(backend), "content-type": "application/json" };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** A registered project: a plain directory, or a git repo with one commit. */
async function registerProject(backend: E2EBackend, name: string, opts: { git?: boolean } = {}): Promise<void> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  if (opts.git) {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "e2e@example.com"]);
    git(dir, ["config", "user.name", "e2e"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(dir, "README.md"), "e2e fixture\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: json(backend),
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
}

async function enableCodexAndWait(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: json(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await expect
    .poll(
      async () => {
        const r = await request.get(`${backend.apiBase}/agent-models/harnesses`, { headers: auth(backend) });
        const body = (await r.json()) as { byHarness: Record<string, { id: string }[]> };
        return (body.byHarness.codex ?? []).map((m) => m.id);
      },
      { timeout: 20_000, message: "the core never loaded the codex stub's model list" },
    )
    .toContain(CODEX_FAST);
}

async function waitForClaudeCatalog(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${backend.apiBase}/agent-models`, { headers: auth(backend) });
        const body = (await r.json()) as Record<string, { id: string }[]>;
        return (body["claude-code"] ?? []).map((m) => m.id);
      },
      { timeout: 20_000, message: "the core never loaded the claude stub's model list" },
    )
    .toContain(CLAUDE_MODEL);
}

async function listTasks(request: APIRequestContext, backend: E2EBackend): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

async function taskByTitle(request: APIRequestContext, backend: E2EBackend, title: string): Promise<Record<string, any>> {
  let found: Record<string, any> | undefined;
  await expect
    .poll(async () => (found = (await listTasks(request, backend)).find((t) => t.title === title)) !== undefined, {
      timeout: 20_000,
      message: `the task "${title}" was never stored`,
    })
    .toBe(true);
  return found!;
}

/** Fills Title + Prompt and clicks Add to backlog; returns the stored task. */
async function submitToBacklog(page: Page, request: APIRequestContext, backend: E2EBackend, label: string): Promise<Record<string, any>> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  await fillNewTask(page, { title, prompt: "p" });
  const backlog = backlogButton(newTaskPanel(page));
  await expect(backlog).toBeEnabled({ timeout: 20_000 });
  await backlog.click();
  return taskByTitle(request, backend, title);
}

test.describe("New Task panel: assembled launch behaviors", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({
    backendEnv: {
      AGETOR_E2E_CLAUDE_STUB: "1",
      AGETOR_E2E_CLAUDE_MODELS_JSON: CLAUDE_CATALOG,
      AGETOR_CODEX_BIN: CODEX_BIN,
    },
  });

  test("P1: each kind keeps its own picks across codex → Claude Code → codex", async ({ page, request, freshBackend }) => {
    await enableCodexAndWait(request, freshBackend);
    await waitForClaudeCatalog(request, freshBackend);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);

    await pickHarness(panel, "Codex");
    await pickModel(panel, CODEX_FAST);
    await pickEffort(panel, "high");
    await pickSpeed(panel, "fast");
    await setPrimaryMode(panel, "plan");

    await pickHarness(panel, "Claude Code");
    await pickModel(panel, CLAUDE_MODEL);
    await pickEffort(panel, "max");
    await expectPrimaryMode(panel, "code");

    await pickHarness(panel, "Codex");
    await expectModel(panel, CODEX_FAST);
    await expectEffort(panel, "high");
    await expectSpeed(panel, "fast");
    await expectPrimaryMode(panel, "plan");

    await pickHarness(panel, "Claude Code");
    await expectModel(panel, CLAUDE_MODEL);
    await expectEffort(panel, "max");
    await expectPrimaryMode(panel, "code");
  });

  test("P2: a backlog submit remembers mode, model, effort and speed per kind across a reload", async ({ page, request, freshBackend }) => {
    await enableCodexAndWait(request, freshBackend);
    await waitForClaudeCatalog(request, freshBackend);
    const project = `launch-behaviors-p2-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, project);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, project);

    await pickHarness(panel, "Codex");
    await pickModel(panel, CODEX_FAST);
    await pickEffort(panel, "high");
    await pickSpeed(panel, "fast");
    await setPrimaryMode(panel, "plan");
    const stored = await submitToBacklog(page, request, freshBackend, "p2-codex");
    expect(stored).toMatchObject({ agent: "codex", model: CODEX_FAST, effort: "high", speed: "fast", mode: CODE_PLAN_MODE.codex.plan });

    await pickHarness(panel, "Claude Code");
    await pickModel(panel, CLAUDE_MODEL);
    await pickEffort(panel, "max");
    await pickSpeed(panel, "fast");
    const storedClaude = await submitToBacklog(page, request, freshBackend, "p2-claude");
    expect(storedClaude).toMatchObject({ agent: "claude-code", model: CLAUDE_MODEL, effort: "max", speed: "fast" });

    const prefsRes = await request.get(`${freshBackend.apiBase}/preferences`, { headers: auth(freshBackend) });
    const prefs = (await prefsRes.json()) as Record<string, string>;
    expect(prefs).toMatchObject({
      "lastModel:codex": CODEX_FAST,
      "lastSpeed:codex": "fast",
      "lastModel:claude-code": CLAUDE_MODEL,
      "lastSpeed:claude-code": "fast",
    });
    // Reload: nothing is carried in memory, so every pick below comes from the remembered preferences.
    await page.reload();
    const reloaded = newTaskPanel(page);
    await expectHarness(reloaded, "Claude Code");
    await expectModel(reloaded, CLAUDE_MODEL);
    await expectEffort(reloaded, "max");
    await expectSpeed(reloaded, "fast");
    await pickHarness(reloaded, "Codex");
    await expectModel(reloaded, CODEX_FAST);
    await expectEffort(reloaded, "high");
    await expectSpeed(reloaded, "fast");
    await expectPrimaryMode(reloaded, "plan");
  });

  test("P3: a remembered model only the CLI's catalog knows is applied once the catalog lands", async ({ page, request, freshBackend }) => {
    await putPreference(request, freshBackend, "lastModel:claude-code", CLAUDE_MODEL);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    // `expectModel` reads the trigger's `data-value`, so it fails while the form is still on the default row.
    await expectModel(panel, CLAUDE_MODEL);
  });

  test("P4: the defaultHarness preference selects its harness on reload", async ({ page, request, freshBackend }) => {
    await enableCodexAndWait(request, freshBackend);
    await gotoApp(page, freshBackend.bootBase);
    await expectHarness(newTaskPanel(page), "Claude Code");

    await putPreference(request, freshBackend, "defaultHarness", "codex");
    await page.reload();
    await expectHarness(newTaskPanel(page), "Codex");
  });

  test("P5: a selected pipeline deleted on the Pipelines page is cleared from the form", async ({ page, request, freshBackend }) => {
    const name = `P5 pipeline ${randomUUID().slice(0, 6)}`;
    const created = await request.post(`${freshBackend.apiBase}/pipelines`, {
      headers: json(freshBackend),
      data: {
        name,
        description: "",
        graph: {
          steps: [
            {
              id: "s1",
              name: "Step one",
              instructions: "",
              agentProfileId: null,
              position: { x: 0, y: 0 },
              subagents: { profileIds: [], cap: null },
              transition: "choose",
              join: "any",
            },
          ],
          edges: [],
          startStepId: "s1",
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = (await created.json()) as { id: string };

    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    const picker = panel.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker");
    await picker.getByTestId("pipeline-picker-trigger").click();
    const popover = page.getByTestId("pipeline-picker-popover");
    await expect(popover).toBeVisible();
    await popover.locator(`[data-testid="pipeline-picker-row"][data-pipeline-id="${id}"]`).click();
    await expect(panel.getByTestId("launch-pipeline-summary")).toBeVisible();

    // Delete it from the Pipelines page (which refreshes the shared list) and come back: the panel
    // stays mounted underneath, still holding the selection until the refreshed list drops it.
    await page.getByTestId("pipelines-button").click();
    const row = page.getByTestId("pipelines-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await row.getByTestId("pipelines-delete").click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete pipeline", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByTestId("pipelines-back").click();
    // The selection clears and the harness block returns.
    await expect(panel.getByTestId("launch-pipeline-summary")).toHaveCount(0, { timeout: 20_000 });
    await expect(panel.getByTestId("launch-harness-picker-trigger")).toBeVisible();
  });

  test("P6: a selected agent profile deleted through the API is cleared from the form", async ({ page, request, freshBackend }) => {
    const name = `P6 profile ${randomUUID().slice(0, 6)}`;
    const created = await request.post(`${freshBackend.apiBase}/agent-profiles`, {
      headers: json(freshBackend),
      data: { name, harness: "claude-code", model: "opus-5", instructions: "", skills: [] },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = (await created.json()) as { id: string };

    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await panel.getByTestId("agent-profile-picker-trigger").click();
    const popover = page.getByTestId("agent-profile-picker-popover");
    await expect(popover).toBeVisible();
    await popover.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${id}"]`).click();
    const selected = panel.locator(`[data-testid="agent-profile-card"][data-profile-id="${id}"]`);
    await expect(selected.first()).toBeVisible();
    // A profile owns the harness: the manual picker is gone while it is selected.
    await expect(panel.getByTestId("launch-harness-picker-trigger")).toHaveCount(0);

    // Delete it behind the form's back; closing Settings refreshes the shared profile list.
    const del = await request.delete(`${freshBackend.apiBase}/agent-profiles/${id}`, { headers: auth(freshBackend) });
    expect(del.ok(), await del.text()).toBeTruthy();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog");
    await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(selected).toHaveCount(0, { timeout: 20_000 });
    await expect(panel.getByTestId("launch-harness-picker-trigger")).toBeVisible();
  });

  test("P7: Isolate stays as set across two submits", async ({ page, request, freshBackend }) => {
    const project = `launch-behaviors-p7-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, project, { git: true });
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, project);

    const isolate = panel.getByTestId("isolate-toggle");
    await expect(isolate).toBeChecked();
    await isolate.uncheck();
    const first = await submitToBacklog(page, request, freshBackend, "p7-first");
    expect(first.isolation).toBe("none");

    // The form is reset for the next task, but Isolate (and the project) are not.
    await expect(isolate).not.toBeChecked();
    const second = await submitToBacklog(page, request, freshBackend, "p7-second");
    expect(second.isolation).toBe("none");

    await isolate.check();
    const third = await submitToBacklog(page, request, freshBackend, "p7-third");
    expect(third.isolation).toBe("worktree");
  });

  test("P8: a remembered Fast tier is dropped when the remembered model offers none", async ({ page, request, freshBackend }) => {
    await enableCodexAndWait(request, freshBackend);
    // Fast was remembered for a model the catalog now lists without a Fast tier: the seed applies the
    // model once the catalog lands, and the tier must be judged against THAT model, not the default.
    await putPreference(request, freshBackend, "defaultHarness", "codex");
    await putPreference(request, freshBackend, "lastModel:codex", CODEX_LITE);
    await putPreference(request, freshBackend, "lastSpeed:codex", "fast");
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await expectHarness(panel, "Codex");
    await expectModel(panel, CODEX_LITE);
    // The Speed control only shows while a tier is on or the model offers one; with the tier dropped
    // and no tier on offer it is gone, whereas a kept "fast" would leave the picker on screen.
    await openMore(panel);
    // openMore is a no-op when the toggle is missing, so prove the section is really open first:
    // otherwise the negative check below would pass on a closed section.
    await expect(panel.getByTestId("launch-more-agent")).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByTestId("launch-speed")).toHaveCount(0);
  });

  test("P9: a pipeline that cannot start blocks Run task with its reason, and Add to backlog stays enabled", async ({ page, request, freshBackend }) => {
    const name = `P9 pipeline ${randomUUID().slice(0, 6)}`;
    // A saved draft: its only step has no agent, which the server refuses at create.
    const created = await request.post(`${freshBackend.apiBase}/pipelines`, {
      headers: json(freshBackend),
      data: {
        name,
        description: "",
        graph: {
          steps: [
            {
              id: "s1",
              name: "Plan",
              instructions: "",
              agentProfileId: null,
              position: { x: 0, y: 0 },
              subagents: { profileIds: [], cap: null },
              transition: "choose",
              join: "any",
            },
          ],
          edges: [],
          startStepId: "s1",
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = (await created.json()) as { id: string };
    const project = `launch-behaviors-p9-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, project);

    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, project);
    await fillNewTask(page, { title: "p9 title", prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });

    await panel.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker-trigger").click();
    await page.getByTestId("pipeline-picker-popover").locator(`[data-testid="pipeline-picker-row"][data-pipeline-id="${id}"]`).click();
    const problem = panel.getByTestId("launch-pipeline-problem");
    await expect(problem).toContainText('step "Plan" has no agent', { timeout: 20_000 });
    await expect(runTaskButton(panel)).toBeDisabled();
    await expect(panel.getByTestId("launch-run-blocked-reason")).toBeVisible();
    // Backlog is the "queue it anyway" path: the server still validates the graph on create.
    await expect(backlogButton(panel)).toBeEnabled();

    // Clearing the pipeline restores a normal launch.
    await panel.getByTestId("launch-pipeline-change").click();
    await expect(problem).toHaveCount(0);
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });
  });
});
