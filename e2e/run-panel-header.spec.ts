import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the restructured task-details header in
 * `RunPanel.tsx` (~lines 2562-2716): row 1 is a right-aligned row of
 * icon-only buttons (each carrying a static `aria-label`), row 2 the task
 * title, row 3 the subtitle (`agent · column ...`).
 *
 * Mirrors the boot/task-creation/panel-opening idiom from
 * `e2e/quote.spec.ts` and `e2e/unread-indicator.spec.ts`: a per-worker
 * headless backend (`e2e/fixtures.ts`'s `backend` fixture) with
 * `AGETOR_CLAUDE_DRIVER=fake`, an isolation:"none" task in a plain temp dir
 * (the fake driver never touches the filesystem), started via the real
 * HTTP API so the run panel has real content to render.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", a plain non-git temp dir as workdir)
 *  and start it — same idiom as `e2e/quote.spec.ts`'s
 *  `createAndStartFakeClaudeTask`. Agent is left unset so the server's
 *  default (`"claude-code"`, `src/bun/orchestrator.ts`) applies, which is
 *  what the subtitle-row assertion below checks for. */
async function createAndStartFakeClaudeTask(
  request: APIRequestContext,
  backend: E2EBackend,
  prompt: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title: prompt, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: auth,
  });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** The run panel's slide-over `<aside>` — see `e2e/quote.spec.ts`'s
 *  identical helper for why `.last()` is the right pick (NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the composer textarea
 *  to mount as proof the panel is open — same idiom as `e2e/quote.spec.ts`'s
 *  `openTask`. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** The header `<header>` element at the top of the run panel — scoping
 *  queries here (rather than to the whole panel or the whole page) is what
 *  keeps "Close task details" (the header button, RunPanel.tsx:2704) from
 *  colliding with "Close task panel" (a *different* element: the backdrop
 *  button at RunPanel.tsx:335, present at the same time the panel is
 *  open). */
function panelHeader(page: Page) {
  return runPanel(page).locator("header").first();
}

test.describe("task details header", () => {
  test("row 1 is icon-only header buttons, row 2/3 are title/subtitle, and Close task details closes the panel", async ({
    page,
    request,
    backend,
  }) => {
    const prompt = `header-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, prompt);
    const header = panelHeader(page);

    // --- (1) always-present header buttons are visible by accessible name,
    // scoped to the header row (not the whole page, not the whole panel —
    // see panelHeader()'s doc comment for the "Close task panel" backdrop
    // button this must not match). ------------------------------------
    const viewDiffButton = header.getByRole("button", { name: "View diff" });
    const openFolderButton = header.getByRole("button", { name: "Open working folder" });
    const searchButton = header.getByRole("button", { name: "Search messages" });
    const closeButton = header.getByRole("button", { name: "Close task details" });

    await expect(viewDiffButton).toBeVisible();
    await expect(openFolderButton).toBeVisible();
    await expect(searchButton).toBeVisible();
    await expect(closeButton).toBeVisible();

    // The distinct backdrop "Close task panel" button also exists while the
    // panel is open, but only outside the header — confirms the two labels
    // really are two different elements, not a scoping fluke.
    await expect(page.getByRole("button", { name: "Close task panel" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Close task panel" })).toHaveCount(0);

    // --- (2) icon-only: no visible text on the icon buttons ---------------
    await expect(async () => {
      expect((await viewDiffButton.innerText()).trim()).toBe("");
      expect((await openFolderButton.innerText()).trim()).toBe("");
    }).toPass();

    // --- (3) title row (task title) and subtitle row (agent · column),
    // both rendered below the button row. ----------------------------------
    const buttonRowBox = await header.locator("div").first().boundingBox();
    const titleRow = header.getByText(prompt, { exact: true });
    const subtitleRow = header.getByText(/claude-code/);

    await expect(titleRow).toBeVisible();
    await expect(subtitleRow).toBeVisible();
    await expect(subtitleRow).toContainText("claude-code");

    expect(buttonRowBox, "header's button row should have a bounding box").not.toBeNull();
    const titleBox = await titleRow.boundingBox();
    const subtitleBox = await subtitleRow.boundingBox();
    expect(titleBox, "title row should have a bounding box").not.toBeNull();
    expect(subtitleBox, "subtitle row should have a bounding box").not.toBeNull();
    if (buttonRowBox && titleBox && subtitleBox) {
      expect(titleBox.y).toBeGreaterThan(buttonRowBox.y);
      expect(subtitleBox.y).toBeGreaterThan(titleBox.y);
    }

    // --- (4) clicking "Close task details" closes the panel ---------------
    await closeButton.click();
    await expect(panel).toHaveClass(/translate-x-full/);
  });

  test("header icon buttons show a hover tooltip and carry no native title", async ({
    page,
    request,
    backend,
  }) => {
    const prompt = `header-tooltip-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);

    await gotoApp(page, backend.bootBase);
    await openTask(page, prompt);
    const header = panelHeader(page);
    const viewDiffButton = header.getByRole("button", { name: "View diff" });
    const tooltip = header.getByTestId("tooltip");

    // --- (1) hovering the button shows the `Tooltip` bubble (auto-waiting
    // covers the 300ms `TOOLTIP_SHOW_DELAY_MS` from tooltip.tsx) with the
    // expected label text. -------------------------------------------------
    await expect(tooltip).not.toBeVisible();
    await viewDiffButton.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText("View this task's changes (git diff)");

    // --- (2) moving the mouse away hides the bubble (mouseleave) -----------
    await page.mouse.move(0, 0);
    await expect(tooltip).not.toBeVisible();

    // --- (3) the wrapped button no longer carries a native `title` attribute
    // — guards against the double-tooltip regression (native title tooltip
    // stacking on top of the new hover bubble). -----------------------------
    await expect(viewDiffButton).not.toHaveAttribute("title");
  });
});
