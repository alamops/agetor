import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Keyboard access to the kanban board (docs/architecture/task-card.md,
 * "Keyboard"): Tab reaches a card, Enter opens it, Space picks it up, ← →
 * move it between columns, Space drops it, Escape or Tab puts it back (Enter
 * is ignored while it is held), and the card's `⋯` button opens the task menu from the keyboard without starting a
 * drag. Tasks are created over the API (isolation "none", a temp dir) and
 * never started, so no agent runs.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { title, prompt: "keyboard e2e", isolation: "none", workdir: tmpdir(), agent: "claude-code" },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as TaskRow;
}

async function patchColumn(request: APIRequestContext, backend: E2EBackend, id: string, column: string): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/tasks/${id}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { column },
  });
  expect(res.ok(), `PATCH /tasks/${id} -> ${res.status()}`).toBeTruthy();
}

async function columnOf(request: APIRequestContext, backend: E2EBackend, id: string): Promise<string> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: { authorization: `Bearer ${backend.apiToken}` } });
  return ((await res.json()) as { column: string }).column;
}

const cardOf = (page: Page, id: string): Locator => page.locator(`[data-task-id="${id}"]`);
const liveRegion = (page: Page): Locator => page.locator('[role="status"][id^="DndLiveRegion"]');
const taskMenu = (page: Page): Locator => page.getByTestId("task-context-menu");
const boardSearch = (page: Page): Locator => page.getByPlaceholder(/^Search title, prompt/);
// The run panel is the `<aside>` holding its resize handle. `aside.last()` is
// not a test for "closed": with no panel mounted, the last aside is the New task
// sidebar, which has a textarea of its own. The panel unmounts after its exit
// animation, so `toHaveCount(0)` means it is closed.
const runPanel = (page: Page): Locator => page.locator("aside").filter({ has: page.getByTestId("run-panel-resize") });

test("Enter on a focused card opens its run panel", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `kbd-open ${randomUUID()}`);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(runPanel(page).locator("textarea")).toBeVisible();
});

test("Space, →, Space moves a card to the next column; the live region names the task, not its id", async ({ page, request, backend }) => {
  const title = `kbd-move ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  // The pick-up announcement is replaced at once by "is over Backlog" (the card
  // starts over its own column), so the first stable text is the over-message.
  await expect(liveRegion(page)).toContainText(`${title} is over Backlog`);
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  // The announcement carries the title and the column label, never the UUID.
  await expect(liveRegion(page)).not.toContainText(task.id);
  await page.keyboard.press("Space");
  await expect(liveRegion(page)).toContainText(`${title} was dropped in Ready`);

  await expect.poll(() => columnOf(request, backend, task.id), { timeout: 10_000 }).toBe("ready");
});

test("Escape cancels a keyboard drag and leaves the card in its column", async ({ page, request, backend }) => {
  const title = `kbd-cancel ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("Escape");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("Enter while a card is held does not open it, and Escape still puts it back", async ({ page, request, backend }) => {
  const title = `kbd-held-enter ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await expect(liveRegion(page)).toContainText(`${title} is over Backlog`);
  await page.keyboard.press("Enter");
  // The drag is still live: the arrow moves the card. Asserting this first
  // gives the Enter keydown time to have opened the panel, were it going to.
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  // The run panel did not open out from under the drag.
  await expect(runPanel(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("Tab cancels a keyboard drag, so keys typed afterwards cannot move the card", async ({ page, request, backend }) => {
  const title = `kbd-tab-cancel ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("Tab");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  // The document-level key listener is gone: another ArrowRight / Escape does nothing.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("a click elsewhere cancels a keyboard drag, so keys typed afterwards cannot move the card", async ({ page, request, backend }) => {
  const title = `kbd-click-cancel ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  // A press on the board's search box, outside the card: dnd-kit alone would
  // keep the drag live (it ends only on its own keys).
  await boardSearch(page).click();
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  // dnd-kit's focus restore must not pull focus back to the card either.
  await page.waitForTimeout(300);
  await expect(boardSearch(page)).toBeFocused();
  // Space and an arrow typed now go to the input, not to the held card.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect(boardSearch(page)).toHaveValue(" ");
  await expect(liveRegion(page)).not.toContainText("was dropped");
  // A drop would PATCH within a few frames; a poll that is true at once cannot
  // tell, so give it that time and check once.
  await page.waitForTimeout(500);
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("a press on the held card itself cancels the drag, so it cannot stay held while a button acts", async ({ page, request, backend }) => {
  const title = `kbd-self-press ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await card.click();
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  await page.waitForTimeout(500);
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("focus moved off a held card by Cmd/Ctrl+F stays on the board search box", async ({ page, request, backend }) => {
  const title = `kbd-find-cancel ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  await expect(boardSearch(page)).toBeFocused();
  // dnd-kit re-focuses the card a frame after a drag ends with focus elsewhere;
  // the search box must still own focus after that.
  await page.waitForTimeout(300);
  await expect(boardSearch(page)).toBeFocused();
  await expect(card).not.toBeFocused();
});

test("Escape that cancels a keyboard drag does not also close the open run panel", async ({ page, request, backend }) => {
  const title = `kbd-esc-panel ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  const composer = runPanel(page).locator("textarea");
  await expect(composer).toBeVisible();
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("Escape");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  // A panel that was closed stays mounted through its 250 ms exit animation, so
  // "still visible" right away proves nothing: wait it out, then it must still
  // be there and on screen.
  await page.waitForTimeout(600);
  await expect(runPanel(page)).toHaveCount(1);
  await expect(runPanel(page)).toHaveClass(/translate-x-0/);
  // With no drag held, Escape closes the panel as before.
  await page.keyboard.press("Escape");
  await expect(runPanel(page)).toHaveCount(0);
});

test("Escape that cancels a keyboard drag does not also close the run panel's message search", async ({ page, request, backend }) => {
  const title = `kbd-esc-search ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  await panel.getByRole("button", { name: "Search messages" }).click();
  const searchBar = panel.locator("[data-search-open]");
  await expect(searchBar).toBeVisible();
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("Escape");
  await expect(liveRegion(page)).toContainText(`Moving ${title} was cancelled`);
  await page.waitForTimeout(300);
  await expect(searchBar).toBeVisible();
  // With no drag held, Escape peels the search bar first, as before.
  await page.keyboard.press("Escape");
  await expect(searchBar).toHaveCount(0);
  await expect(runPanel(page)).toHaveCount(1);
});

test("a review card reaches Done, even when that column is scrolled off-screen", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `kbd-done ${randomUUID()}`);
  await patchColumn(request, backend, task.id, "review");
  // A narrow viewport pushes the Done column off-screen: the sensor must scroll the board to it.
  await page.setViewportSize({ width: 900, height: 800 });
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  // The board scrolls to Done smoothly: drop only once the card is over it.
  await expect(liveRegion(page)).toContainText("is over Done", { timeout: 10_000 });
  await page.keyboard.press("Space");

  await expect.poll(() => columnOf(request, backend, task.id), { timeout: 10_000 }).toBe("done");
});

test("Space on the ⋯ button opens the task menu and does not pick the card up", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `kbd-more ${randomUUID()}`);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const more = card.getByTestId("task-card-more");
  await more.focus();
  await page.keyboard.press("Space");

  await expect(taskMenu(page)).toBeVisible();
  // No drag started: a pick-up is announced at once as "<title> is over
  // <column>", and nothing was.
  await expect(liveRegion(page)).not.toContainText("is over");
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});

test("⋯ menu by keyboard: Enter opens it, the first item is focused, Escape closes and returns focus", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `kbd-menu ${randomUUID()}`);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const more = card.getByTestId("task-card-more");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await more.focus();
  await page.keyboard.press("Enter");
  await expect(taskMenu(page)).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(taskMenu(page).getByRole("menuitem").first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(taskMenu(page)).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
});

test("a pipeline parent moved by keyboard keeps its column and says why", async ({ page, request, backend }) => {
  const title = `kbd-pipe ${randomUUID()}`;
  const task = await createTask(request, backend, title);
  // Fixture: the board reads this task as a pipeline parent. The refusal is
  // client-side (App's onDragEnd), so no real pipeline run is needed.
  await page.route(`${backend.apiBase}/tasks`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as { id: string }[];
    await route.fulfill({
      response,
      json: rows.map((t) => (t.id === task.id ? { ...t, pipelineId: "pipe-1", pipelineRun: null } : t)),
    });
  });
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
  await page.keyboard.press("Space");

  await expect(page.getByText("This pipeline task's column is managed by its run.")).toBeVisible();
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});
