import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Cursor `cursor/ask_question` uses the same ask card as Claude Code.
 * The worker backend already sets `AGETOR_CURSOR_DRIVER=fake` (e2e/fixtures.ts),
 * so the prompt marker never launches a real `cursor-agent`.
 */
const FAKE_CURSOR_ASK_PROMPT_MARKER = "__agetor_fake_cursor_ask__";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function setCursorEnabled(backend: E2EBackend, enabled: boolean): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/cursor`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`PATCH /harnesses/cursor -> ${res.status}: ${await res.text()}`);
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Record<string, unknown>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, unknown>;
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

test.describe("cursor ask card (worker backend)", () => {
  test.describe.configure({ mode: "serial" });
  const createdTaskIds: string[] = [];

  test.beforeAll(async ({ backend }) => {
    await setCursorEnabled(backend, true);
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    await setCursorEnabled(backend, false).catch(() => {});
  });

  async function launch(
    request: APIRequestContext,
    backend: E2EBackend,
    title: string,
    prompt: string,
  ): Promise<string> {
    const createRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: {
        title,
        prompt,
        agent: "cursor",
        isolation: "none",
        workdir: tmpdir(),
      },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const task = (await createRes.json()) as { id: string };
    createdTaskIds.push(task.id);
    const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
    return task.id;
  }

  test("the card shows Cursor is waiting, the question, and Skip; submitting finishes the run", async ({
    page,
    request,
    backend,
  }) => {
    const title = `cursor-ask-e2e ${randomUUID()}`;
    const taskId = await launch(request, backend, title, `${FAKE_CURSOR_ASK_PROMPT_MARKER} ${title}`);

    await gotoApp(page, backend.bootBase);
    const board = page.locator(`[data-task-id="${taskId}"]`);
    await expect(board.getByRole("button", { name: "Answer", exact: true })).toBeVisible({ timeout: 20_000 });
    await board.getByText(title, { exact: true }).click();

    const panel = runPanel(page);
    const card = panel.getByTestId("ask-questions-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    const heading = card.getByTestId("ask-questions-title");
    await expect(heading).toHaveText(/Cursor is waiting/);
    await expect(heading).not.toHaveText(/Claude is asking/);
    await expect(card.getByText("Which option?", { exact: true })).toBeVisible();
    await expect(card.getByText("Alpha", { exact: true })).toBeVisible();
    await expect(card.getByText("Beta", { exact: true })).toBeVisible();
    await expect(card.getByPlaceholder("Custom answer — replaces the selection")).toBeVisible();
    await expect(card.getByTestId("ask-questions-skip")).toBeVisible();

    const tool = panel.getByTestId("cursor-ask-tool-body");
    await expect(tool).toContainText("Pick one");
    await expect(tool).toContainText("Which option?");
    await expect(tool).toContainText("Alpha");

    await card.getByRole("radio", { name: "Alpha" }).check();
    await card.getByRole("button", { name: "Review answers →" }).click();
    await card.getByRole("button", { name: "Submit answers" }).click();
    await expect(card).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => (await getTask(request, backend, taskId)).column, { timeout: 15_000 }).toBe("review");
  });

  test("Skip closes the card and the run finishes", async ({ page, request, backend }) => {
    const title = `cursor-ask-skip-e2e ${randomUUID()}`;
    const taskId = await launch(request, backend, title, `${FAKE_CURSOR_ASK_PROMPT_MARKER} ${title}`);

    await gotoApp(page, backend.bootBase);
    const board = page.locator(`[data-task-id="${taskId}"]`);
    await expect(board.getByRole("button", { name: "Answer", exact: true })).toBeVisible({ timeout: 20_000 });
    await board.getByText(title, { exact: true }).click();

    const panel = runPanel(page);
    const card = panel.getByTestId("ask-questions-card");
    await expect(card.getByTestId("ask-questions-title")).toHaveText(/Cursor is waiting/);
    await expect(card.getByTestId("ask-questions-title")).not.toHaveText(/Claude is asking/);
    await card.getByTestId("ask-questions-skip").click();
    await expect(card).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => (await getTask(request, backend, taskId)).column, { timeout: 15_000 }).toBe("review");
  });

  test("the :2 marker shows two cards at once", async ({ page, request, backend }) => {
    const title = `cursor-ask-two-e2e ${randomUUID()}`;
    const taskId = await launch(request, backend, title, `${FAKE_CURSOR_ASK_PROMPT_MARKER}:2 ${title}`);

    await gotoApp(page, backend.bootBase);
    const board = page.locator(`[data-task-id="${taskId}"]`);
    await expect(board.getByRole("button", { name: "Answer (2)", exact: true })).toBeVisible({ timeout: 20_000 });
    await board.getByText(title, { exact: true }).click();

    const panel = runPanel(page);
    const cards = panel.getByTestId("ask-questions-card");
    await expect(cards).toHaveCount(2, { timeout: 15_000 });
    await expect(cards.nth(0).getByTestId("ask-questions-title")).toHaveText(/Cursor is waiting/);
    await expect(cards.nth(1).getByTestId("ask-questions-title")).toHaveText(/Cursor is waiting/);
    await expect(panel.getByText("Claude is asking")).toHaveCount(0);
    await expect(cards.nth(0).getByText("Which option?", { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText("Which other?", { exact: true })).toBeVisible();
    const tools = panel.getByTestId("cursor-ask-tool-body");
    await expect(tools).toHaveCount(2);
    await expect(tools.nth(0)).toContainText("Which option?");
    await expect(tools.nth(1)).toContainText("Which other?");

    await cards.nth(0).getByTestId("ask-questions-skip").click();
    await expect(cards).toHaveCount(1);
    await cards.nth(0).getByTestId("ask-questions-skip").click();
    await expect(cards).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await getTask(request, backend, taskId)).column, { timeout: 15_000 }).toBe("review");
  });
});
