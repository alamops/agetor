import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, registerGitProject, selectProject } from "./helpers";
import { fillNewTask, newTaskPanel, openMore, pickTaskType, runTaskButton } from "./launch-helpers";

/**
 * The New Task panel's Workspace → Branch name field and the Branch naming dialog it opens
 * (`WorktreeOptions.tsx`, `settings/BranchNamingDialog.tsx`, docs/architecture/task-launch-ui.md):
 * the dialog edits the selected project's naming rules and the panel's live branch name follows a
 * save; an invalid rule can't be saved and a cancelled edit stores nothing; an edited branch name
 * is announced on the closed More options row and "Reset to pattern" gives the pattern back; the
 * created task carries the branch the saved rule produces.
 */

const CATALOG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-branch-naming-"));
const LADDER = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = path.join(CATALOG_DIR, "models.json");
writeFileSync(
  CATALOG,
  JSON.stringify([
    { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: LADDER },
  ]),
);

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function storedPrefixes(backend: E2EBackend, dir: string): Promise<Record<string, string>> {
  const res = await fetch(`${backend.apiBase}/projects/settings?path=${encodeURIComponent(dir)}`, { headers: auth(backend) });
  if (!res.ok) throw new Error(`GET /projects/settings -> ${res.status}: ${await res.text()}`);
  const config = (await res.json()) as { rules: Record<string, { prefix: string }> };
  return Object.fromEntries(Object.entries(config.rules).map(([type, rule]) => [type, rule.prefix]));
}

test.describe("New Task panel: branch naming", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1", AGETOR_E2E_CLAUDE_MODELS_JSON: CATALOG } });

  test("the Branch naming dialog saves the project's rule and the panel's branch name follows it", async ({ page, freshBackend }) => {
    const projectName = `naming-${randomUUID().slice(0, 8)}`;
    const dir = await registerGitProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await fillNewTask(page, { title: "Fix login crash", prompt: "p" });
    await openMore(panel, "workspace");

    // Clean: the field renders the default Task pattern against the title.
    const branch = panel.getByTestId("branch-name-input");
    await expect(branch).toHaveValue(/^feature\/fix-login-crash/, { timeout: 20_000 });

    // The settings button opens the dialog for THIS project, focused on the first rule.
    await panel.getByRole("button", { name: "Configure branch naming", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Branch naming" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(dir);
    const taskPrefix = dialog.getByLabel("Task", { exact: true });
    await expect(taskPrefix).toBeFocused();
    await expect(taskPrefix).toHaveValue("feature/");

    // The example under the rule updates as it is typed; Save stores it and closes the dialog.
    await taskPrefix.fill("e2e/");
    await expect(dialog.getByText(/^e\.g\. e2e\//)).toBeVisible();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => storedPrefixes(freshBackend, dir)).toMatchObject({ task: "e2e/", bug: "fix/" });
    await expect(branch).toHaveValue(/^e2e\/fix-login-crash/);

    // The type picks the rule: Bug keeps its own prefix.
    await pickTaskType(panel, "Bug");
    await expect(branch).toHaveValue(/^fix\/fix-login-crash/);
  });

  test("an invalid rule can't be saved, and a dismissed dialog stores nothing", async ({ page, freshBackend }) => {
    const projectName = `naming-bad-${randomUUID().slice(0, 8)}`;
    const dir = await registerGitProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase);
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await fillNewTask(page, { title: "Some work", prompt: "p" });
    await openMore(panel, "workspace");
    await expect(panel.getByTestId("branch-name-input")).toHaveValue(/^feature\//, { timeout: 20_000 });

    const configure = panel.getByRole("button", { name: "Configure branch naming", exact: true });
    await configure.click();
    const dialog = page.getByRole("dialog", { name: "Branch naming" });
    const bugPrefix = dialog.getByLabel("Bug", { exact: true });
    await expect(bugPrefix).toHaveValue("fix/");
    await bugPrefix.fill("has space/");
    await expect(dialog.getByText(/"has space\/" is not a valid prefix/)).toBeVisible();
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();

    // Escape dismisses without saving; so do Cancel and the header ×.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await configure.click();
    await expect(dialog.getByLabel("Bug", { exact: true })).toHaveValue("fix/");
    await dialog.getByLabel("Task", { exact: true }).fill("other/");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await configure.click();
    await expect(dialog.getByLabel("Task", { exact: true })).toHaveValue("feature/");
    await dialog.getByLabel("Task", { exact: true }).fill("other/");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(await storedPrefixes(freshBackend, dir)).toMatchObject({ task: "feature/", bug: "fix/" });
    await expect(panel.getByTestId("branch-name-input")).toHaveValue(/^feature\//);
  });

  test("an edited branch name is announced while More options is closed, Reset to pattern undoes it, and Run uses the saved rule", async ({
    page,
    freshBackend,
  }) => {
    const projectName = `naming-reset-${randomUUID().slice(0, 8)}`;
    const dir = await registerGitProject(freshBackend, projectName);
    const saved = await fetch(`${freshBackend.apiBase}/projects/settings`, {
      method: "PUT",
      headers: { ...auth(freshBackend), "content-type": "application/json" },
      body: JSON.stringify({
        path: dir,
        config: { rules: { task: { prefix: "work/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } }, includeSlug: true },
      }),
    });
    expect(saved.ok, await saved.text()).toBe(true);

    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const title = `Reset ${randomUUID().slice(0, 6)}`;
    await fillNewTask(page, { title, prompt: "p" });
    const more = panel.getByTestId("launch-more-workspace");
    await openMore(panel, "workspace");
    const branch = panel.getByTestId("branch-name-input");
    await expect(branch).toHaveValue(/^work\/reset-/, { timeout: 20_000 });
    const reset = panel.getByRole("button", { name: "Reset to pattern", exact: true });
    await expect(reset).toHaveCount(0);

    await branch.fill("custom/by-hand");
    await expect(reset).toBeVisible();
    // Closed, the row says a hidden value differs from the pattern.
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toContainText("Branch name edited");
    await more.click();
    await expect(branch).toHaveValue("custom/by-hand");

    await reset.click();
    await expect(branch).toHaveValue(/^work\/reset-/);
    await expect(reset).toHaveCount(0);
    await more.click();
    await expect(more).not.toContainText("Branch name edited");

    // Run task creates the task on the branch the saved rule produces.
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });
    await runTaskButton(panel).click();
    await expect
      .poll(
        async () => {
          const res = await fetch(`${freshBackend.apiBase}/tasks`, { headers: auth(freshBackend) });
          const row = ((await res.json()) as Array<{ title: string; branch: string | null }>).find((t) => t.title === title);
          return row?.branch ?? null;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^work\/reset-/);
  });
});
