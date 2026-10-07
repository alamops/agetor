import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * End-to-end coverage for Cursor and fx skill discovery plus the Agent
 * skill box's leading-slash filter.
 *
 * Built-in harness rows refuse a home edit, so each case uses an alias
 * whose `home` (and, for one Cursor alias, `env.HOME`) points at a temp
 * directory. Names are prefixed `e2e-` so they cannot collide with skills
 * on the machine that runs the test. Assertions name those rows; they
 * never count the whole menu.
 *
 * The project is registered for this file and removed in `afterAll`. The
 * New Task form auto-selects the first project, which is this repo when
 * the file runs on its own worker.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 15_000;

const CURSOR_ID = "e2e-cursor";
const CURSOR_ENV_ID = "e2e-cursor-env";
const CURSOR_EMPTY_ID = "e2e-cursor-empty";
const FX_ID = "e2e-fx";

let projectDir: string;
let cursorHome: string;
let envHome: string;
let emptyHome: string;
let fxHome: string;
let taskId = "";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function writeSkill(root: string, rel: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, rel, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\ndescription: ${description}\n---\n# ${name}\n`);
}

async function api(
  apiBase: string,
  token: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${apiBase}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

async function pickHarness(scope: Locator, label: string): Promise<void> {
  const button = scope.getByRole("button", { name: label, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

test.beforeAll(async ({ backend }) => {
  cursorHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-cursor-home-"));
  envHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-cursor-env-"));
  emptyHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-cursor-empty-"));
  fxHome = await mkdtemp(path.join(tmpdir(), "agetor-e2e-fx-home-"));

  await writeSkill(cursorHome, ".cursor/skills", "e2e-cursor-user", "cursor user");
  await writeSkill(cursorHome, ".cursor/skills", "e2e-cursor-shared", "from user");
  await writeSkill(cursorHome, ".cursor/skills-cursor", "e2e-cursor-shared", "from builtin");
  await writeSkill(cursorHome, ".cursor/skills-cursor", "e2e-cursor-builtin", "builtin only");
  await writeSkill(cursorHome, ".agents/skills", "e2e-cursor-agents", "from agents");
  await writeFile(
    path.join(cursorHome, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "e2e-cursor-user-mcp": { url: "https://example.test/mcp", headers: { Authorization: "secret-token" } },
      },
    }),
  );
  await writeSkill(envHome, ".cursor/skills", "e2e-cursor-env", "from env");
  await writeSkill(fxHome, ".fx/skills", "e2e-fx-user", "fx user");
  await writeSkill(fxHome, ".config/opencode/skills", "e2e-fx-oc", "fx opencode");

  projectDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-cursor-fx-repo-"));
  git(projectDir, ["init", "-q", "-b", "main"]);
  git(projectDir, ["config", "user.email", "e2e@example.com"]);
  git(projectDir, ["config", "user.name", "e2e"]);
  git(projectDir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(projectDir, "README.md"), "e2e cursor/fx skill fixture\n");
  await writeSkill(projectDir, ".claude/skills", "e2e-claude-keep", "claude still listed");
  await writeSkill(projectDir, ".cursor/skills", "e2e-cursor-committed", "committed cursor skill");
  await writeFile(
    path.join(projectDir, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { "e2e-cursor-mcp-proj": { command: "true" } } }),
  );
  await writeSkill(projectDir, ".fx/skills", "e2e-fx-proj", "committed fx skill");
  await writeSkill(projectDir, "skills", "e2e-fx-bare", "committed bare skill");
  git(projectDir, ["add", "-A"]);
  git(projectDir, ["commit", "-q", "-m", "skills"]);
  await writeSkill(projectDir, ".cursor/skills", "e2e-cursor-dirty", "uncommitted cursor skill");
  await writeFile(
    path.join(projectDir, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { "e2e-cursor-mcp-dirty": { command: "true" } } }),
  );
  await writeSkill(projectDir, ".opencode/skills", "e2e-fx-dirty", "uncommitted fx skill");

  const { apiBase, apiToken } = backend;
  for (const body of [
    { id: CURSOR_ID, kind: "cursor", label: "E2E Cursor", home: cursorHome },
    { id: CURSOR_ENV_ID, kind: "cursor", label: "E2E Cursor Env", home: cursorHome, env: { HOME: envHome } },
    { id: CURSOR_EMPTY_ID, kind: "cursor", label: "E2E Cursor Empty", home: emptyHome },
    { id: FX_ID, kind: "fx", label: "E2E fx", home: fxHome },
  ]) {
    const res = await api(apiBase, apiToken, "POST", "/harnesses", body);
    if (!res.ok) throw new Error(`POST /harnesses ${body.id} -> ${res.status}: ${await res.text()}`);
  }
  const project = await api(apiBase, apiToken, "POST", "/projects", { path: projectDir });
  if (!project.ok) throw new Error(`POST /projects -> ${project.status}: ${await project.text()}`);
});

test.afterAll(async ({ backend }) => {
  const { apiBase, apiToken } = backend;
  if (taskId) await api(apiBase, apiToken, "DELETE", `/tasks/${taskId}`).catch(() => {});
  for (const id of [CURSOR_ID, CURSOR_ENV_ID, CURSOR_EMPTY_ID, FX_ID]) {
    await api(apiBase, apiToken, "DELETE", `/harnesses/${id}`).catch(() => {});
  }
  if (projectDir) {
    await api(apiBase, apiToken, "DELETE", "/projects", { path: projectDir }).catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  }
  for (const dir of [cursorHome, envHome, emptyHome, fxHome]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test.describe("cursor and fx skill discovery", () => {
  test("Claude still lists its own project skill and does not list a Cursor skill", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = form.getByTestId("prompt-textarea");
    await textarea.click();
    await page.keyboard.type("/ini");
    const slashMenu = form.getByTestId("slash-autocomplete");
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/init" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });

    await textarea.fill("");
    await page.keyboard.type("/e2e-claude-keep");
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-claude-keep" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });

    await textarea.fill("");
    await page.keyboard.type("/e2e-cursor-committed");
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-cursor-committed" }),
    ).toHaveCount(0);
  });

  test("New Task Cursor slash menu lists home, builtin, and committed skills, and hides the uncommitted one", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    await pickHarness(form, "E2E Cursor");
    const textarea = form.getByTestId("prompt-textarea");
    await textarea.click();

    const slashMenu = form.getByTestId("slash-autocomplete");
    for (const name of ["e2e-cursor-user", "e2e-cursor-builtin", "e2e-cursor-agents", "e2e-cursor-committed"]) {
      await textarea.fill("");
      await page.keyboard.type(`/${name}`);
      await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: `/${name}` })).toBeVisible({
        timeout: CONVERGE_TIMEOUT,
      });
    }

    await textarea.fill("");
    await page.keyboard.type("/e2e-cursor-shared");
    const shared = slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-cursor-shared" });
    await expect(shared).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(shared).toContainText("from user");

    await textarea.fill("");
    await page.keyboard.type("/e2e-cursor-dirty");
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-cursor-dirty" })).toHaveCount(
      0,
    );

    const extTrigger = form.getByTestId("extension-picker-trigger");
    await extTrigger.click();
    const extPopover = form.getByTestId("extension-picker-popover");
    await expect(extPopover).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await form.getByTestId("extension-picker-search").fill("e2e-cursor-committed");
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-cursor-committed" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await form.getByTestId("extension-picker-search").fill("e2e-cursor-dirty");
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-cursor-dirty" })).toHaveCount(0);

    const userMcp = extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-cursor-user-mcp" });
    await form.getByTestId("extension-picker-search").fill("e2e-cursor-user-mcp");
    await expect(userMcp).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(userMcp).toContainText("example.test");
    await expect(userMcp).not.toContainText("secret-token");

    await form.getByTestId("extension-picker-search").fill("e2e-cursor-mcp-proj");
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-cursor-mcp-proj" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await form.getByTestId("extension-picker-search").fill("e2e-cursor-mcp-dirty");
    await expect(extPopover.getByTestId("extension-picker-row").filter({ hasText: "e2e-cursor-mcp-dirty" })).toHaveCount(
      0,
    );
  });

  test("Agent skill box matches a leading slash and prefers the user skill over the builtin", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    await dialog.getByTestId("agent-profile-add").click();
    const form = dialog.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();
    await pickHarness(form, "E2E Cursor");

    const picker = form.getByTestId("skills-picker");
    const input = picker.getByTestId("skills-picker-input");
    await input.click();
    await input.fill("/e2e-cursor-user");
    const userRow = picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-user"]');
    await expect(userRow).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await userRow.click();
    await expect(picker.locator('[data-testid="skills-picker-chip"][data-skill="e2e-cursor-user"]')).toBeVisible();

    await input.fill("/e2e-cursor-committed");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-committed"]')).toHaveCount(0);

    await input.fill("/e2e-cursor-shared");
    const shared = picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-shared"]');
    await expect(shared).toHaveCount(1);
    await expect(shared).toContainText("from user");
    await expect(shared).not.toContainText("from builtin");
  });

  test("An explicit harness env HOME wins over the harness home", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    await dialog.getByTestId("agent-profile-add").click();
    const form = dialog.getByTestId("agent-profile-form");
    await pickHarness(form, "E2E Cursor Env");

    const picker = form.getByTestId("skills-picker");
    const input = picker.getByTestId("skills-picker-input");
    await input.click();
    await input.fill("/e2e-cursor-env");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-env"]')).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await input.fill("/e2e-cursor-user");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-user"]')).toHaveCount(0);
  });

  test("A Cursor home with no skills leaves the unique names unmatched and the box usable", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    await dialog.getByTestId("agent-profile-add").click();
    const form = dialog.getByTestId("agent-profile-form");
    await pickHarness(form, "E2E Cursor Empty");

    const picker = form.getByTestId("skills-picker");
    const input = picker.getByTestId("skills-picker-input");
    await input.click();
    await input.fill("/e2e-cursor-user");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-cursor-user"]')).toHaveCount(0);
    await input.fill("typed-skill");
    await input.press("Enter");
    await expect(picker.locator('[data-testid="skills-picker-chip"][data-skill="typed-skill"]')).toBeVisible();
  });

  test("New Task fx slash menu lists user and committed project skills, and hides the uncommitted one", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    await pickHarness(form, "E2E fx");
    const textarea = form.getByTestId("prompt-textarea");
    await textarea.click();
    const slashMenu = form.getByTestId("slash-autocomplete");

    for (const name of ["e2e-fx-user", "e2e-fx-oc", "e2e-fx-proj", "e2e-fx-bare"]) {
      await textarea.fill("");
      await page.keyboard.type(`/${name}`);
      await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: `/${name}` })).toBeVisible({
        timeout: CONVERGE_TIMEOUT,
      });
    }

    await textarea.fill("");
    await page.keyboard.type("/e2e-fx-dirty");
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-fx-dirty" })).toHaveCount(0);
  });

  test("Agent skill box lists fx user skills and not a project-only skill", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    await dialog.getByTestId("agent-profile-add").click();
    const form = dialog.getByTestId("agent-profile-form");
    await pickHarness(form, "E2E fx");
    const picker = form.getByTestId("skills-picker");
    const input = picker.getByTestId("skills-picker-input");
    await input.click();
    await input.fill("/e2e-fx-oc");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-fx-oc"]')).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await input.fill("/e2e-fx-bare");
    await expect(picker.locator('[data-testid="skills-picker-row"][data-skill="e2e-fx-bare"]')).toHaveCount(0);
  });

  test("Task message composer lists the committed Cursor skill and hides the uncommitted one", async ({
    page,
    request,
    backend,
  }) => {
    const created = await request.post(`${backend.apiBase}/tasks`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: {
        title: "e2e cursor skill composer",
        prompt: "look at the skills",
        agent: CURSOR_ID,
        workdir: projectDir,
        isolation: "worktree",
        baseRef: "main",
      },
    });
    expect(created.ok(), `POST /tasks -> ${created.status()}: ${await created.text()}`).toBeTruthy();
    taskId = ((await created.json()) as { id: string }).id;

    await gotoApp(page, backend.bootBase);
    await page.getByText("e2e cursor skill composer", { exact: true }).first().click();
    const panel = runPanel(page);
    const textarea = panel.getByTestId("send-textarea");
    await expect(textarea).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await textarea.click();
    await page.keyboard.type("/e2e-cursor-committed");
    const slashMenu = panel.getByTestId("slash-autocomplete");
    await expect(
      slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-cursor-committed" }),
    ).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await textarea.fill("");
    await page.keyboard.type("/e2e-cursor-dirty");
    await expect(slashMenu.getByTestId("slash-autocomplete-row").filter({ hasText: "/e2e-cursor-dirty" })).toHaveCount(
      0,
    );
  });
});
