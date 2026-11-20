import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, selectProject } from "./helpers";
import {
  backlogButton,
  expectSpeed,
  fillNewTask,
  maxModeToggle,
  newTaskPanel,
  pickHarness,
  pickModel,
  pickSpeed,
  runTaskButton,
} from "./launch-helpers";
import { plantFakeCodexAppServer, writeFakeCodexCatalog } from "../src/bun/test-codex-app-server.ts";

/**
 * What the New Task panel SUBMITS (docs/architecture/task-launch-ui.md):
 *
 * - B1: Fast chosen in the panel reaches the stored task for claude-code,
 *   codex and cursor (it used to be dropped to "off" for every kind but cursor
 *   and fx). Cursor's Max Mode travels with it.
 * - S5: Run task is gated on a launchable harness — available here, so it is
 *   enabled and the reason line is absent — while Add to backlog is a separate
 *   action. (The unavailable-harness half lives in copilot-harness-availability.)
 */

const CATALOG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-new-task-submit-"));
const LADDER = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = path.join(CATALOG_DIR, "opus-6.json");
writeFileSync(
  CATALOG,
  JSON.stringify([
    { value: "default", resolvedModel: "claude-opus-6", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
    { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: LADDER, supportsFastMode: true },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: LADDER },
  ]),
);

const CODEX_FAST_MODEL = "gpt-7-e2e";
const CODEX_BIN = (() => {
  const dir = path.join(CATALOG_DIR, "codex");
  mkdirSync(dir, { recursive: true });
  const catalogFile = path.join(dir, "model-list.json");
  writeFakeCodexCatalog(catalogFile, [{ id: CODEX_FAST_MODEL, displayName: "GPT-7 E2E", efforts: ["low", "high"], fast: true }]);
  return plantFakeCodexAppServer({ pages: [], dir, version: "codex-cli 0.166.0", catalogFile });
})();

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

test.describe("New Task panel submit", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1", AGETOR_E2E_CLAUDE_MODELS_JSON: CATALOG } });

  test("B1: Fast picked for claude-code is stored on the task (Add to backlog)", async ({ page, request, freshBackend }) => {
    const projectName = `new-task-submit-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await pickModel(panel, "opus-6");
    await pickSpeed(panel, "fast");
    await expectSpeed(panel, "fast");

    const title = `fast-submit ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });
    await expect(backlogButton(panel)).toBeEnabled();
    await backlogButton(panel).click();

    await expect
      .poll(
        async () => {
          const res = await request.get(`${freshBackend.apiBase}/tasks`, { headers: auth(freshBackend) });
          const list = (await res.json()) as Array<Record<string, any>>;
          return list.find((t) => t.title === title)?.speed ?? null;
        },
        { timeout: 20_000, message: "the stored task never carried speed=fast" },
      )
      .toBe("fast");
  });

  test("S5: Run task is enabled for an available harness, with no blocked reason", async ({ page, freshBackend }) => {
    const projectName = `new-task-run-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await fillNewTask(page, { title: `run ${randomUUID().slice(0, 8)}`, prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });
    await expect(panel.getByTestId("launch-run-blocked-reason")).toHaveCount(0);
  });

  test("the reason Run is blocked is visible while the form is incomplete", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await expect(runTaskButton(panel)).toBeDisabled();
    await expect(panel.getByTestId("launch-run-blocked-reason")).toContainText("Add a title, a prompt and a project");
    await expect(backlogButton(panel)).toBeDisabled();
  });
});

test.describe("New Task panel submit: Fast on the other harnesses", () => {
  test.describe.configure({ timeout: 120_000 });

  async function storedTask(request: import("./fixtures").APIRequestContext, backend: E2EBackend, title: string) {
    let found: Record<string, any> | undefined;
    await expect
      .poll(
        async () => {
          const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
          found = ((await res.json()) as Array<Record<string, any>>).find((t) => t.title === title);
          return found !== undefined;
        },
        { timeout: 20_000, message: `the task "${title}" was never stored` },
      )
      .toBe(true);
    return found!;
  }

  test.describe("codex", () => {
    test.use({ backendEnv: { AGETOR_CODEX_BIN: CODEX_BIN } });

    test("B1: Fast picked for codex is stored on the task", async ({ page, request, freshBackend }) => {
      const projectName = `new-task-codex-fast-${randomUUID().slice(0, 8)}`;
      await registerProject(freshBackend, projectName);
      const enabled = await request.patch(`${freshBackend.apiBase}/harnesses/codex`, {
        headers: { ...auth(freshBackend), "content-type": "application/json" },
        data: { enabled: true },
      });
      expect(enabled.ok(), await enabled.text()).toBeTruthy();
      await expect
        .poll(
          async () => {
            const res = await request.get(`${freshBackend.apiBase}/agent-models/harnesses`, { headers: auth(freshBackend) });
            const body = (await res.json()) as { byHarness: Record<string, { id: string }[]> };
            return (body.byHarness.codex ?? []).map((m) => m.id);
          },
          { timeout: 20_000, message: "the core never loaded the codex stub's model list" },
        )
        .toContain(CODEX_FAST_MODEL);

      await gotoApp(page, freshBackend.bootBase);
      const panel = newTaskPanel(page);
      await selectProject(page, panel, projectName);
      await pickHarness(panel, "Codex");
      await pickModel(panel, CODEX_FAST_MODEL);
      await pickSpeed(panel, "fast");
      await expectSpeed(panel, "fast");

      const title = `codex-fast ${randomUUID().slice(0, 8)}`;
      await fillNewTask(page, { title, prompt: "p" });
      await backlogButton(panel).click();
      const task = await storedTask(request, freshBackend, title);
      expect(task).toMatchObject({ agent: "codex", model: CODEX_FAST_MODEL, speed: "fast" });
    });
  });

  test("B1: Fast and Max Mode picked for cursor are stored on the task", async ({ page, request, freshBackend }) => {
    const projectName = `new-task-cursor-fast-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    const enabled = await request.patch(`${freshBackend.apiBase}/harnesses/cursor`, {
      headers: { ...auth(freshBackend), "content-type": "application/json" },
      data: { enabled: true },
    });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();

    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await pickHarness(panel, "Cursor");
    // Codex 5.3 offers both the Fast variant and Max Mode at cursor's default effort.
    await pickModel(panel, "gpt-5.3-codex");
    await pickSpeed(panel, "fast");
    await expectSpeed(panel, "fast");
    await (await maxModeToggle(panel)).click();

    const title = `cursor-fast ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });
    await backlogButton(panel).click();
    const task = await storedTask(request, freshBackend, title);
    expect(task).toMatchObject({ agent: "cursor", model: "gpt-5.3-codex", speed: "fast", maxMode: true });
  });
});
