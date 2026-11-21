import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, selectProject } from "./helpers";
import { effortField, modelField, newTaskPanel, openMore, type PickerHandle } from "./launch-helpers";

/**
 * E2E coverage for docs/plans/dynamic-model-catalog.md E1 (acceptance #31, C1,
 * C2, C8 for claude, C9): a model the Claude Code CLI reports that agetor has
 * no row for shows up in every surface with the CLI's own effort ladder, with
 * no agetor change.
 *
 * The backend's claude is the opt-in stub (`AGETOR_E2E_CLAUDE_STUB=1`,
 * e2e/fixtures.ts `writeClaudeStubBin`): it answers `--version` and the
 * `initialize` control request the model-discovery probe sends, with the
 * `models[]` array in the file `AGETOR_E2E_CLAUDE_MODELS_JSON` names. The
 * stub's response also carries a planted account block (email, organization)
 * that must never reach the picker or the persisted catalog.
 *
 * 1. A catalog with `claude-opus-6` (a ladder with an effort agetor has never
 *    heard of, `turbo`, and Fast support): Opus 6 leads the New Task picker,
 *    its ladder shows with "Turbo", Speed appears and shows the Fast notice; a
 *    task created on it shows "Opus 6" on the card and in the run panel
 *    editor; the stored catalog holds no account data.
 * 2. A stub that reports no catalog (an old CLI): the curated picker, Opus
 *    5.5 by default, no Speed control.
 */

const CATALOG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-claude-models-"));
const LADDER = ["low", "medium", "high", "turbo", "max"];

function writeCatalog(name: string, models: unknown[]): string {
  const file = path.join(CATALOG_DIR, name);
  writeFileSync(file, JSON.stringify(models));
  return file;
}

const OPUS_6_CATALOG = writeCatalog("opus-6.json", [
  { value: "default", resolvedModel: "claude-opus-6", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
  { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
  { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
]);

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
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

function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** The New Task form's Model `<select>` (the refresh button sits in the row
 *  before it, both inside one wrapper — see e2e/fx-models.spec.ts). */
function modelSelect(page: Page): PickerHandle {
  return modelField(newTaskPanel(page));
}

function effortSelect(form: Locator): PickerHandle {
  return effortField(form);
}

test.describe("Claude Code model catalog from the CLI", () => {
  test.describe.configure({ timeout: 90_000 });

  test.describe("a CLI that reports a model agetor has no row for", () => {
    test.use({
      backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1", AGETOR_E2E_CLAUDE_MODELS_JSON: OPUS_6_CATALOG },
    });

    test("Opus 6 leads the New Task picker with the CLI's own effort ladder and Speed; a task on it shows Opus 6 everywhere", async ({
      page,
      request,
      freshBackend,
    }) => {
      const projectName = `claude-models-e2e-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await gotoApp(page, freshBackend.bootBase);
      const form = newTaskForm(page);
      await selectProject(page, form, projectName);

      // CLI order: the model the CLI added leads, Opus 5.5 follows with its
      // curated label, rows the CLI did not list come after.
      const select = modelSelect(page);
      await expect
        .poll(async () => (await select.optionLabels())[0], {
          timeout: 20_000,
          message: "the picker never listed the CLI's Opus 6 first",
        })
        .toBe("Opus 6");
      const labels = await select.optionLabels();
      expect(labels.indexOf("Opus 5.5")).toBeGreaterThan(0);
      expect(labels).toContain("Mythos 5.2"); // curated-only rows are kept
      expect(new Set(labels).size).toBe(labels.length); // no doubled rows

      // The owner's default stays on Opus 5.5 (it is in the catalog).
      await select.expectValue("opus-5.5");

      // Picking Opus 6 shows ITS ladder, including the effort agetor never heard of.
      await select.selectOption("opus-6");
      const efforts = effortSelect(form);
      await expect
        .poll(async () => efforts.optionLabels(), { timeout: 10_000 })
        .toEqual(["Max thinking", "Turbo", "High", "Medium", "Low"]);

      // Speed: the model supports Fast, so the control appears with the notice.
      await openMore(form);
      const speed = form.getByTestId("launch-speed");
      await expect(speed).toBeVisible();
      await form.getByTestId("launch-speed-fast").click();
      await expect(form.getByTestId("launch-speed-hint")).toContainText("Fast mode");
      // A model without Fast support takes the control away again and falls back to Off.
      await select.selectOption("opus-5.5");
      await expect(form.getByTestId("launch-speed")).toHaveCount(0);

      // A task created on it (through the API, as `agetor add --model opus-6 --effort turbo` would).
      const title = `Opus 6 task ${randomUUID().slice(0, 8)}`;
      const created = await request.post(`${freshBackend.apiBase}/tasks`, {
        headers: auth(freshBackend),
        data: { title, prompt: "p", agent: "claude-code", model: "opus-6", effort: "turbo", isolation: "none", workdir: tmpdirFor(freshBackend) },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.reload();
      await gotoApp(page, freshBackend.bootBase);
      const card = page.getByText(title, { exact: true }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      // The board card names the model as a person reads it.
      await expect(page.locator("span.font-mono", { hasText: /^Opus 6( · .*)?$/ }).first()).toBeVisible();
      await card.click();
      const panel = runPanel(page);
      await panel.getByText("Task details", { exact: true }).click();
      const panelModel = panel.locator("select").filter({ has: page.locator('option[value="opus-6"]') }).first();
      await expect(panelModel).toHaveValue("opus-6");
      await expect(panelModel.locator("option:checked")).toHaveText("Opus 6");
      const panelEffort = panel.locator("select").filter({ has: page.locator('option[value="turbo"]') }).first();
      await expect(panelEffort).toHaveValue("turbo");
      await expect(panelEffort.locator("option:checked")).toHaveText("Turbo");
      // Speed is editable in the details too, and it says when it applies.
      await expect(panel.getByTestId("task-speed")).toBeVisible();
      await expect(panel.getByTestId("task-speed-note")).toContainText("next run");

      // The probe's account block never reaches the API surface.
      const models = await (await request.get(`${freshBackend.apiBase}/agent-models`, { headers: auth(freshBackend) })).text();
      expect(models).toContain("opus-6");
      expect(models).not.toMatch(/e2e-leak|E2E Leak Org|account|organization/);
      const prefs = await (await request.get(`${freshBackend.apiBase}/preferences`, { headers: auth(freshBackend) })).text();
      expect(prefs).not.toContain("modelCatalog:"); // server-managed rows are never listed
    });
  });

  test.describe("a CLI that reports no catalog (older or failing)", () => {
    test.use({ backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1" } });

    test("the picker is today's curated list, Opus 5.5 by default, with no Speed control", async ({ page, freshBackend }) => {
      const projectName = `claude-models-old-e2e-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await gotoApp(page, freshBackend.bootBase);
      const form = newTaskForm(page);
      await selectProject(page, form, projectName);
      const select = modelSelect(page);
      await select.expectValue("opus-5.5");
      const labels = await select.optionLabels();
      expect(labels[0]).toBe("Mythos 5.2"); // curated order: nothing discovered
      expect(labels).toContain("Opus 5.5");
      expect(labels).not.toContain("Opus 6");
      await expect(form.getByTestId("launch-speed")).toHaveCount(0);
    });
  });
});

/** An existing directory for a non-isolated task's workdir. */
function tmpdirFor(backend: E2EBackend): string {
  const dir = path.join(backend.dataDir, "e2e-task-workdir");
  mkdirSync(dir, { recursive: true });
  return dir;
}
