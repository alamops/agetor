import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp, selectProject } from "./helpers";
import {
  backlogButton,
  expectModel,
  modelOptionIds,
  expectPrimaryMode,
  expectTaskType,
  fillNewTask,
  harnessPicker,
  newTaskPanel,
  openMore,
  pickModel,
  pickSpeed,
  pickTaskType,
  runTaskButton,
  setPrimaryMode,
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
  // These tests measure the panel's rendered width. Its width change is a 200 ms CSS transition,
  // and under a loaded machine headless Chromium can stop producing the frames that advance it, so
  // the box sat mid-transition (441 px of a 420 -> 500 px change) for the whole poll while the
  // inline width was already right. Reduced motion turns the transition off
  // (`motion-reduce:transition-none`), so the geometry asserted is the settled one.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

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
      "agent-profile-picker",
      "launch-model-picker",
      "launch-effort-picker",
    ]) {
      await expect(panel.getByTestId(id)).toBeVisible();
    }
    await expect(panel.getByPlaceholder("Short description")).toBeVisible();
    // The rare ones are not rendered until the disclosure opens.
    await expect(panel.getByTestId("branch-name-input")).toHaveCount(0);
    await expect(panel.getByTestId("launch-mode")).toHaveCount(0);
    // The Agent (profile) picker sits right under Pipeline, above Harness.
    const order = await panel.locator('[data-testid="launch-pipeline-picker"], [data-testid="agent-profile-picker"], [data-testid="launch-harness-picker"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(order).toEqual(["launch-pipeline-picker", "agent-profile-picker", "launch-harness-picker"]);
    // The composer's MCP / Skills / Plugins / Prompts trigger spans the prompt's width and has no Agents group.
    const extTrigger = panel.getByTestId("extension-picker-trigger");
    await expect(extTrigger).toHaveText(/MCP · Skills · Plugins · Prompts/);
    await expect(extTrigger).not.toContainText("Agents");
    const [triggerBox, promptBox] = await Promise.all([extTrigger.boundingBox(), panel.getByTestId("prompt-textarea").boundingBox()]);
    expect(Math.abs(triggerBox!.width - promptBox!.width)).toBeLessThan(2);

    // Every field is reachable by its label (a real <label for> / aria-labelledby, not a sibling).
    await expect(panel.getByLabel("Title", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Prompt", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Projects", { exact: true })).toHaveCount(1);
    await expect(panel.getByLabel("Isolate (worktree)", { exact: true })).toHaveCount(1);
    await expect(panel.getByRole("radiogroup", { name: "Type" })).toHaveCount(1);
    await openMore(panel);
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

  test("a session that starts in a narrow window gives the saved width back when the window widens", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const full = page.viewportSize()!;
    await page.evaluate(() => localStorage.setItem("agetor:newTaskPanelWidth", "500"));
    // Start narrow: shown width is limited by the window (900 - 480 board), the saved one is not.
    await page.setViewportSize({ width: 900, height: full.height });
    await page.reload();
    const panel = newTaskPanel(page);
    const width = async () => Math.round((await panel.boundingBox())!.width);
    await expect.poll(width).toBe(420);
    await page.setViewportSize(full);
    await expect.poll(width).toBe(500);
    await expect(panel.getByTestId("new-task-panel-resize")).toHaveAttribute("aria-valuenow", "500");
  });

  test("a click or a key press that changes nothing, and a reset, never overwrite the saved width in a narrow window", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const full = page.viewportSize()!;
    await page.evaluate(() => localStorage.setItem("agetor:newTaskPanelWidth", "500"));
    await page.setViewportSize({ width: 900, height: full.height });
    await page.reload();
    const panel = newTaskPanel(page);
    const handle = panel.getByTestId("new-task-panel-resize");
    const saved = () => page.evaluate(() => localStorage.getItem("agetor:newTaskPanelWidth"));
    // The window limits what is shown (900 - 480 board = 420), and the handle's range with it.
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    await expect(handle).toHaveAttribute("aria-valuemax", "420");

    // A click without movement is not a resize.
    const box = (await handle.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // Neither is a key that is already at the limit.
    await handle.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    expect(await saved()).toBe("500");
    await page.setViewportSize(full);
    await expect(handle).toHaveAttribute("aria-valuenow", "500");

    // The reset is limited to the window too: never wider than the handle's own maximum.
    await page.setViewportSize({ width: 700, height: full.height });
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
    await handle.dblclick();
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
    await expect(handle).toHaveAttribute("aria-valuemax", "320");
    await page.setViewportSize(full);
    await expect(handle).toHaveAttribute("aria-valuenow", "384");
  });

  test("the panel collapses to the rail and back without losing the draft, and stays collapsed after a reload", async ({ page, freshBackend }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const projectName = `layout-rail-${randomUUID().slice(0, 8)}`;
    await registerProject(freshBackend, projectName);
    const projectFolder = createHash("sha1").update(projectName).digest("hex").slice(0, 12);
    await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
    const panel = newTaskPanel(page);
    await selectProject(page, panel, projectName);
    const projects = panel.getByTestId("select-projects-button");
    await expect(projects).toContainText(projectFolder);

    // A draft spread over every part of the form: the text fields, the Task section's Type, and
    // the Agent section's picks (which live in useTaskLaunch, not in the unmounted children).
    const title = `rail ${randomUUID().slice(0, 8)}`;
    await fillNewTask(page, { title, prompt: "keep this prompt" });
    // Every pick below differs from its default, so getting it back can't be a reset.
    await expectTaskType(panel, "Task");
    await expectPrimaryMode(panel, "code");
    // Wait for the CLI catalog first: before it lands the trigger shows a fallback, and a
    // negative check would pass on that alone.
    await expect.poll(() => modelOptionIds(panel), { timeout: 20_000 }).toContain("opus-6");
    await expect(panel.getByTestId("launch-model-picker-trigger")).not.toHaveAttribute("data-value", "opus-6");
    await pickTaskType(panel, "Bug");
    await pickModel(panel, "opus-6");
    await setPrimaryMode(panel, "plan");

    const toggle = panel.getByRole("button", { name: "Collapse new task panel", exact: true });
    await toggle.click();
    // The rail: 44 px, no form fields and no resize handle (nothing to drop into or drag).
    const expandToggle = panel.getByRole("button", { name: "Expand new task panel", exact: true });
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByPlaceholder("Short description")).toHaveCount(0);
    await expect(panel.getByTestId("new-task-panel-resize")).toHaveCount(0);
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(44);

    // The rail's own "New task" button brings the whole draft back at the default width.
    await panel.getByRole("button", { name: "New task", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Collapse new task panel", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByPlaceholder("Short description")).toHaveValue(title);
    await expect(panel.getByTestId("prompt-textarea")).toHaveValue("keep this prompt");
    await expect(projects).toContainText(projectFolder);
    await expectTaskType(panel, "Bug");
    await expectModel(panel, "opus-6");
    await expectPrimaryMode(panel, "plan");
    await expect(panel.getByTestId("new-task-panel-resize")).toHaveAttribute("aria-valuenow", "384");
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(384);

    // Collapsed is remembered across a reload; the header toggle expands it again.
    await panel.getByRole("button", { name: "Collapse new task panel", exact: true }).click();
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
    await expect(panel.getByPlaceholder("Short description")).toHaveCount(0);
    await expandToggle.click();
    await expect(panel.getByPlaceholder("Short description")).toBeVisible();
  });

  test("a picker opened before its rows load grows to show them when they arrive", async ({ page, freshBackend }) => {
    // The Harness picker can be opened while /harnesses is still loading (a slow boot). The
    // rows that arrive afterwards must fit inside the open popover, not be clipped to the
    // height it measured with one row (the picker re-measured its own capped height).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route((url) => url.pathname === "/harnesses", async (route) => {
      if (route.request().method() === "GET") await gate;
      await route.continue();
    });
    const panel = newTaskPanel(page);
    const pop = page.getByTestId("launch-harness-picker-popover");
    try {
      await gotoApp(page, freshBackend.bootBase, { launchMoreOpen: false });
      await harnessPicker(panel).click();
      await expect(pop).toBeVisible();
      // Opened small: the rows haven't arrived (an empty state, or a fallback row).
      expect(await pop.getByRole("option").count()).toBeLessThan(2);
    } finally {
      release();
    }
    await page.unrouteAll({ behavior: "wait" });

    await expect.poll(() => pop.getByRole("option").count(), { timeout: 20_000 }).toBeGreaterThan(1);
    // Every row lies inside the popover's box: nothing is cut off by a stale max-height.
    await expect
      .poll(async () => {
        const box = (await pop.boundingBox())!;
        const rows = await pop.getByRole("option").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom));
        return rows.every((bottom) => bottom <= box.y + box.height + 0.5);
      }, { timeout: 5_000 })
      .toBe(true);
  });
});
