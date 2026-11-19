import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, selectProject } from "./helpers";
import {
  backlogButton,
  fillNewTask,
  newTaskPanel,
  openMore,
  pickModel,
  pickSpeed,
  runTaskButton,
} from "./launch-helpers";

/**
 * Layout of the New Task panel (docs/architecture/task-launch-ui.md): sections and
 * More options (default state, summaries, announcements, persistence across a reload),
 * every field reachable by its label, and the resizable width. These specs open the
 * page with `launchMoreOpen: false`, i.e. the REAL default (More options closed).
 */

const CATALOG_DIR = mkdtempSync(path.join(tmpdir(), "agetor-e2e-launch-layout-"));
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

async function registerProject(backend: E2EBackend, name: string): Promise<void> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
}

test.describe("New Task panel layout", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ backendEnv: { AGETOR_E2E_CLAUDE_STUB: "1", AGETOR_E2E_CLAUDE_MODELS_JSON: CATALOG } });

  test("the frequent fields are visible with More options closed, and every field has an associated label", async ({ page, freshBackend }) => {
    const projectName = `layout-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);

    // More options is closed by default in both sections.
    await expect(panel.getByTestId("launch-more-agent")).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("launch-more-workspace")).toHaveAttribute("aria-expanded", "false");

    // The frequent fields never hide behind it.
    for (const id of [
      "task-type-picker",
      "prompt-textarea",
      "select-projects-button",
      "isolate-toggle",
      "launch-harness-picker",
      "launch-mode",
      "launch-model-picker",
      "launch-effort-picker",
    ]) {
      await expect(panel.getByTestId(id)).toBeVisible();
    }
    await expect(panel.getByPlaceholder("Short description")).toBeVisible();
    // The rare ones are not rendered until the disclosure opens.
    await expect(panel.getByTestId("branch-name-input")).toHaveCount(0);
    await expect(panel.getByTestId("agent-profile-picker")).toHaveCount(0);

    // Every field is reachable by its label (a real <label for> / aria-labelledby, not a sibling).
    await expect(panel.getByLabel("Title", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Prompt", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Projects", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Isolate (worktree)", { exact: true })).toHaveCount(1);
    await expect(panel.getByRole("radiogroup", { name: "Type" })).toHaveCount(1);
    await expect(panel.getByRole("radiogroup", { name: "Mode" })).toHaveCount(1);
    for (const [id, name] of [
      ["launch-harness-picker-trigger", /^Harness\b/],
      ["launch-model-picker-trigger", /^Model\b/],
      ["launch-effort-picker-trigger", /^Effort\b/],
    ] as const) {
      await expect(panel.getByTestId(id)).toHaveAccessibleName(name);
    }
  });

  test("Workspace and Agent collapse to a summary line, and stay collapsed after a reload", async ({ page, freshBackend }) => {
    const projectName = `layout-collapse-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);

    const workspace = panel.getByTestId("launch-section-workspace-toggle");
    const agent = panel.getByTestId("launch-section-agent-toggle");
    await expect(panel.getByTestId("launch-section-agent-summary")).toHaveCount(0);
    await agent.click();
    await workspace.click();
    await expect(agent).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("launch-section-agent-summary")).toContainText("Claude Code");
    // `<project folder> · current branch · isolated · <branch>` (lib/launch-summary.ts).
    await expect(panel.getByTestId("launch-section-workspace-summary")).toContainText("current branch · isolated");
    // Collapsed means the body is gone from the DOM and the tab order.
    await expect(panel.getByTestId("launch-model-picker")).toHaveCount(0);

    await page.reload();
    await expect(panel.getByTestId("launch-section-agent-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("launch-section-workspace-toggle")).toHaveAttribute("aria-expanded", "false");
    // …and the choice is only the section's: reopening restores the fields.
    await panel.getByTestId("launch-section-agent-toggle").click();
    await expect(panel.getByTestId("launch-model-picker")).toBeVisible();
  });

  test("a non-default rare value behind a closed More options is announced on its row; the state persists", async ({ page, freshBackend }) => {
    const projectName = `layout-note-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await pickModel(panel, "opus-6");

    await openMore(panel);
    await pickSpeed(panel, "fast");
    await panel.getByTestId("launch-more-agent").click(); // close it again
    await expect(panel.getByTestId("launch-more-agent")).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("launch-more-agent")).toContainText("Speed: Fast");

    // Open More options stays open across a reload (it is per-surface layout state).
    await panel.getByTestId("launch-more-agent").click();
    await page.reload();
    await expect(panel.getByTestId("launch-more-agent")).toHaveAttribute("aria-expanded", "true");
  });

  test("an invalid branch name behind a closed More options is announced, and blocks Run and Add to backlog with a reason", async ({ page, freshBackend }) => {
    const projectName = `layout-branch-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    await fillNewTask(page, { title: "branch check", prompt: "p" });
    await expect(runTaskButton(panel)).toBeEnabled({ timeout: 20_000 });

    await openMore(panel, "workspace");
    await panel.getByTestId("branch-name-input").fill("bad name with spaces");
    await panel.getByTestId("launch-more-workspace").click(); // close it
    await expect(panel.getByTestId("launch-more-workspace-note")).toContainText("Branch name is invalid");
    await expect(panel.getByTestId("launch-more-workspace-note")).toHaveAttribute("data-tone", "danger");
    await expect(runTaskButton(panel)).toBeDisabled();
    await expect(backlogButton(panel)).toBeDisabled();
    await expect(panel.getByTestId("launch-run-blocked-reason")).toContainText("Fix the branch name first");
  });

  test("the panel resizes by keyboard and by drag, clamps to 320–560, resets on double-click, and persists", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    const handle = panel.getByTestId("new-task-panel-resize");
    const width = async () => Math.round((await panel.boundingBox())!.width);

    await expect(handle).toHaveAttribute("aria-valuenow", "384");
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "400");
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "560");
    await expect.poll(width).toBe(560);

    await handle.dblclick();
    await expect(handle).toHaveAttribute("aria-valuenow", "384");
    // The width animates (200 ms); measure the handle only once the panel has settled.
    await expect.poll(width).toBe(384);

    // Drag: +116 px from the default lands on 500, and survives a reload.
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.move(x + 116, y, { steps: 4 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute("aria-valuenow", "500");
    await page.reload();
    await expect(panel.getByTestId("new-task-panel-resize")).toHaveAttribute("aria-valuenow", "500");
    await expect.poll(width).toBe(500);

    // A smaller window clamps what is shown (the board keeps 480 px), not what the user chose.
    const full = page.viewportSize()!;
    await page.setViewportSize({ width: 900, height: full.height });
    await expect.poll(width).toBe(420);
    await page.setViewportSize(full);
    await expect.poll(width).toBe(500);
  });
});
