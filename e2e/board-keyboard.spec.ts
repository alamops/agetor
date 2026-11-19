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

test("Enter on a focused card opens its run panel", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `kbd-open ${randomUUID()}`);
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("aside").last().locator("textarea")).toBeVisible();
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
  // The run panel did not open out from under the drag, and the drag is still live.
  await expect(page.locator("aside").last().locator("textarea")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(liveRegion(page)).toContainText(`${title} is over Ready`);
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
  await page.keyboard.press("Space");

  await expect(page.getByText("This pipeline task's column is managed by its run.")).toBeVisible();
  expect(await columnOf(request, backend, task.id)).toBe("backlog");
});
