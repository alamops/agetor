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
  newTaskPanel,
  pickModel,
  pickSpeed,
  runTaskButton,
} from "./launch-helpers";

/**
 * What the New Task panel SUBMITS (docs/architecture/task-launch-ui.md):
 *
 * - B1: Fast chosen in the panel reaches the stored task for claude-code (it
 *   used to be dropped to "off" for every kind but cursor and fx).
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
