import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, selectProject } from "./helpers";
import { fillNewTask, modelPicker, newTaskPanel, runTaskButton } from "./launch-helpers";

/**
 * The keyboard contract of the launch surfaces (docs/architecture/task-launch-ui.md):
 * Cmd/Ctrl+Enter runs the task from the panel and is inert while a popover is open or Run is
 * disabled; arrow keys and Enter drive a picker; Escape closes a picker first; Tab moves through
 * the panel in visual order; and the RunPanel send box keeps Enter / Shift+Enter / Cmd+Enter.
 */

const CATALOG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-launch-keyboard-"));
const LADDER = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = path.join(CATALOG_DIR, "models.json");
writeFileSync(
  CATALOG,
  JSON.stringify([
    { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: LADDER },
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

async function taskTitles(backend: E2EBackend): Promise<string[]> {
  const res = await fetch(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  return ((await res.json()) as Array<{ title: string }>).map((t) => t.title);
}

test.describe("launch keyboard", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1", AGETOR_E2E_CLAUDE_MODELS_JSON: CATALOG } });

  test("Cmd/Ctrl+Enter from the Title field runs the task in the panel", async ({ page, freshBackend }) => {
    const projectName = `kbd-run-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const title = `kbd run ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });
    await panel.getByPlaceholder("Short description").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    // Run task creates the card in Ready/Running — never the backlog.
    await expect
      .poll(async () => {
        const res = await fetch(`${freshBackend.apiBase}/tasks`, { headers: auth(freshBackend) });
        const row = ((await res.json()) as Array<{ title: string; column: string }>).find((t) => t.title === title);
        return row?.column ?? null;
      }, { timeout: 20_000 })
      .not.toBeNull();
    const res = await fetch(`${freshBackend.apiBase}/tasks`, { headers: auth(freshBackend) });
    const row = ((await res.json()) as Array<{ title: string; column: string }>).find((t) => t.title === title)!;
    expect(row.column).not.toBe("backlog");
  });

  test("the shortcut does nothing while Run is disabled, or while a picker is open", async ({ page, freshBackend }) => {
    const projectName = `kbd-inert-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);

    // Run disabled: no title or prompt yet.
    await panel.getByPlaceholder("Short description").focus();
    await page.keyboard.press("ControlOrMeta+Enter");

    // A complete form with the Model picker open: the shortcut must not run the task.
    const title = `kbd inert ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });
    await modelPicker(panel).click();
    await expect(page.getByTestId("launch-model-picker-popover")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(1_500);
    expect(await taskTitles(freshBackend)).not.toContain(title);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("launch-model-picker-popover")).toHaveCount(0);
  });

  test("a picker is driven by arrow keys and Enter, and Escape closes it first", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    const trigger = modelPicker(panel);
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const before = await trigger.getAttribute("data-value");
    await trigger.focus();
    await page.keyboard.press("ArrowDown"); // opens
    const popover = page.getByTestId("launch-model-picker-popover");
    await expect(popover).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);
    await expect(trigger).not.toHaveAttribute("data-value", before ?? "");
    // The trigger keeps focus after a pick.
    await expect(trigger).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // Escape did not collapse anything else on the page.
    await expect(panel.getByTestId("launch-model-picker")).toBeVisible();
  });

  test("Tab moves through the panel fields in visual order without a trap", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await panel.getByPlaceholder("Short description").focus();
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("data-testid") ?? el?.getAttribute("aria-label") ?? el?.tagName ?? "";
      });
      seen.push(id);
    }
    // The prompt comes after the title, Workspace before Agent, and focus is never stuck.
    expect(seen.indexOf("prompt-textarea")).toBeGreaterThanOrEqual(0);
    const projects = seen.indexOf("select-projects-button");
    const harness = seen.indexOf("launch-harness-picker-trigger");
    expect(projects).toBeGreaterThan(seen.indexOf("prompt-textarea"));
    expect(harness === -1 || harness > projects).toBe(true);
    expect(new Set(seen).size).toBeGreaterThan(6);
  });

  test("the send box keeps its keys: Enter sends, Shift+Enter inserts a new line, Cmd/Ctrl+Enter sends", async ({ page, request, freshBackend }) => {
    const title = `kbd send ${randomUUID().slice(0, 8)}`;
    const created = await request.post(`${freshBackend.apiBase}/tasks`, {
      headers: auth(freshBackend),
      data: { title, prompt: "first turn", agent: "claude-code", isolation: "none", workdir: tmpdir() },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const task = (await created.json()) as { id: string };
    const started = await request.post(`${freshBackend.apiBase}/tasks/${task.id}/start`, { headers: auth(freshBackend) });
    expect(started.ok(), await started.text()).toBeTruthy();

    await gotoApp(page, freshBackend.bootBase);
    await page.getByText(title, { exact: true }).first().click();
    const box = page.getByTestId("send-textarea");
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(box).toBeEnabled({ timeout: 20_000 });

    // Shift+Enter is a new line, not a send.
    await box.fill("line one");
    await box.press("Shift+Enter");
    await box.pressSequentially("line two");
    await expect(box).toHaveValue("line one\nline two");

    // Enter sends and clears the field.
    await box.press("Enter");
    await expect(box).toHaveValue("", { timeout: 20_000 });

    // Cmd/Ctrl+Enter sends too.
    await box.fill("second message");
    await box.press("ControlOrMeta+Enter");
    await expect(box).toHaveValue("", { timeout: 20_000 });
  });
});
