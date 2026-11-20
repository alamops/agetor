import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, registerGitProject, selectProject } from "./helpers";
import { backlogButton, expandLaunch, fillNewTask, modelPicker, newTaskPanel, runTaskButton } from "./launch-helpers";

/**
 * The keyboard contract of the launch surfaces (docs/architecture/task-launch-ui.md):
 * Cmd/Ctrl+Enter runs the task from the panel and is inert while a picker is open, inside any open
 * popover, or while Run is disabled (an escape-only popover elsewhere, like the @ notice, doesn't block it); arrow keys and Enter drive a picker; Escape closes a picker first; Tab moves through
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
  return (await taskRows(backend)).map((t) => t.title);
}

interface TaskRow {
  title: string;
  prompt: string;
  column: string;
  mode: string | null;
  taskType: string;
}

async function taskRows(backend: E2EBackend): Promise<TaskRow[]> {
  const res = await fetch(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  if (!res.ok) throw new Error(`GET /tasks -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as TaskRow[];
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
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("launch-model-picker-popover")).toHaveCount(0);

    // With the picker closed the same chord runs the form under a second title. Had an earlier
    // chord fired, its submit would have cleared the title and prompt, the second chord would be
    // inert on the emptied form, and the poll below would time out. The fresh backend holds no
    // other task, so exactly one task proves neither the Run-disabled nor the picker chord fired.
    const second = `kbd after ${randomUUID().slice(0, 8)}`;
    const titleField = panel.getByPlaceholder("Short description");
    await titleField.fill(second);
    await titleField.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => taskTitles(freshBackend), { timeout: 20_000 }).toContain(second);
    expect(await taskTitles(freshBackend)).toEqual([second]);
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

  test("a radio group is driven by arrow keys: they wrap, move focus with the check, and the picks they land on are submitted", async ({ page, freshBackend }) => {
    const projectName = `kbd-radio-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await expandLaunch(panel);
    const title = `kbd radio ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });

    // Type: Task ← wraps to Spike, → wraps back to Task, ↓ moves on to Bug.
    const type = panel.getByTestId("task-type-picker");
    const taskRadio = type.getByTestId("task-type-task");
    const bugRadio = type.getByTestId("task-type-bug");
    const spikeRadio = type.getByTestId("task-type-spike");
    await expect(taskRadio).toBeChecked();
    await taskRadio.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(spikeRadio).toBeChecked();
    await expect(spikeRadio).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(taskRadio).toBeChecked();
    await expect(taskRadio).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(bugRadio).toBeChecked();
    await expect(bugRadio).toBeFocused();
    // Roving tabindex: only the checked radio is a Tab stop.
    await expect(bugRadio).toHaveAttribute("tabindex", "0");
    await expect(taskRadio).toHaveAttribute("tabindex", "-1");
    await expect(spikeRadio).toHaveAttribute("tabindex", "-1");

    // Mode: Code → Plan with the right arrow, back with the up arrow, then forward again.
    const code = panel.getByTestId("launch-mode-code");
    const plan = panel.getByTestId("launch-mode-plan");
    await expect(code).toBeChecked();
    await code.focus();
    await page.keyboard.press("ArrowRight");
    await expect(plan).toBeChecked();
    await expect(plan).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(code).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(plan).toBeChecked();

    // What the keys picked is what the task is stored with.
    await backlogButton(panel).click();
    await expect.poll(async () => (await taskRows(freshBackend)).some((t) => t.title === title), { timeout: 20_000 }).toBe(true);
    const row = (await taskRows(freshBackend)).find((t) => t.title === title)!;
    expect(row.column).toBe("backlog");
    expect(row.taskType).toBe("bug");
    expect(row.mode).toBe("plan");
  });

  test("Cmd/Ctrl+Enter while the @ suggestions are open picks the suggestion instead of running the task", async ({ page, freshBackend }) => {
    const projectName = `kbd-at-${randomUUID().slice(0, 8)}`;
    await registerGitProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const title = `kbd at ${randomUUID().slice(0, 8)}`;
    await panel.getByPlaceholder("Short description").fill(title);
    const prompt = panel.getByTestId("prompt-textarea");
    await prompt.click();
    await page.keyboard.type("see @REA");
    const suggestions = panel.getByTestId("at-file-autocomplete");
    await expect(suggestions.locator('[data-testid="at-file-autocomplete-row"][data-path="README.md"]')).toBeVisible({ timeout: 20_000 });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });

    // The chord completes the token and closes the list.
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(prompt).toHaveValue("see @README.md ");
    await expect(suggestions).toHaveCount(0);

    // With nothing open, the same chord runs the task. Its stored prompt carries the completed
    // token, so the first chord did not also submit the half-typed "@REA".
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(async () => (await taskRows(freshBackend)).filter((t) => t.title === title).length, { timeout: 20_000 }).toBe(1);
    const row = (await taskRows(freshBackend)).find((t) => t.title === title)!;
    expect(row.prompt.trim()).toBe("see @README.md");
    expect(row.column).not.toBe("backlog");
  });

  test("Cmd/Ctrl+Enter still runs the task while the @ notice says the project's files can't be listed", async ({ page, freshBackend }) => {
    // A plain directory can't be listed, so typing "@" shows a passive notice with nothing to
    // pick. AtFileAutocomplete's contract for that notice is "everything but Escape behaves as if
    // no popover were up", and it marks itself `data-popover-keys="escape-only"`
    // (docs/architecture/prompt-composer.md): the run chord must not be swallowed by it.
    const projectName = `kbd-at-error-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const title = `kbd at error ${randomUUID().slice(0, 8)}`;
    await panel.getByPlaceholder("Short description").fill(title);
    const prompt = panel.getByTestId("prompt-textarea");
    await prompt.click();
    await page.keyboard.type("look at @x");
    await expect(panel.getByTestId("at-file-error")).toBeVisible({ timeout: 20_000 });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });

    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => taskTitles(freshBackend), { timeout: 20_000 }).toContain(title);
  });

  test("Cmd/Ctrl+Enter typed inside the Extensions popover's search does not run the task", async ({ page, freshBackend }) => {
    // The Extensions popover is escape-only too, so it no longer blocks the chord from elsewhere,
    // but a key typed inside it belongs to it: its search box handles Enter in a React handler
    // that runs after the form's listener, so the form must hold the chord back itself.
    const projectName = `kbd-ext-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const title = `kbd ext ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });

    await panel.getByTestId("extension-picker-trigger").click();
    const search = panel.getByTestId("extension-picker-search");
    await search.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("Escape");
    await expect(panel.getByTestId("extension-picker-popover")).toHaveCount(0);

    // With the popover closed the chord runs the form under a second title. Had the first chord
    // fired, its submit would have cleared the form and the poll below would time out; exactly one
    // task on the fresh backend proves it didn't.
    const second = `kbd ext after ${randomUUID().slice(0, 8)}`;
    const titleField = panel.getByPlaceholder("Short description");
    await titleField.fill(second);
    await titleField.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => taskTitles(freshBackend), { timeout: 20_000 }).toContain(second);
    expect(await taskTitles(freshBackend)).toEqual([second]);
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
