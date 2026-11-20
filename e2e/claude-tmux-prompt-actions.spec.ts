import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Mirrors `FAKE_CLAUDE_ENTER_PROMPT_MARKER` / `FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER`
 * in `src/bun/agents.ts` (literals, not imports: `src/bun/*.ts` pulls in
 * `bun:sqlite`, which Playwright's Node loader cannot resolve).
 */
const FAKE_CLAUDE_ENTER_PROMPT_MARKER = "__agetor_fake_claude_enter_prompt__";
const FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER = "__agetor_fake_claude_paste_code__";

/**
 * E2E for the Enter-only and OAuth-code `tmux_prompt` cards
 * (docs/plans/claude-enter-to-confirm-prompts.md, SC6/SC7, TT8). The fake claude
 * driver registers a fake pane through the SAME matcher chain the real scraper
 * uses and holds the turn until the card is answered through the real
 * `POST /tmux-prompts/:id/answer` route (closed allow-list, live re-read of the
 * pane, sentinel answers), so what is proven here is the real route, matcher
 * and card, not a stub of them. The real tmux/claude path is covered by the
 * stub-tmux integration tests and the live smoke.
 */

test.describe.configure({ mode: "serial" });

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function createAndStart(
  request: APIRequestContext,
  backend: E2EBackend,
  marker: string,
  title: string,
): Promise<string> {
  const create = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${marker} ${title}`, isolation: "none", workdir: tmpdir() },
  });
  expect(create.ok(), `POST /tasks -> ${create.status()}: ${await create.text()}`).toBeTruthy();
  const task = (await create.json()) as { id: string };
  const start = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(start.ok(), `POST /tasks/${task.id}/start -> ${start.status()}: ${await start.text()}`).toBeTruthy();
  return task.id;
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("Enter-only and OAuth-code cards", () => {
  test("Continue (press Enter) answers the card through the real route and the turn finishes", async ({ page, request, backend }) => {
    const title = `enter-e2e ${randomUUID()}`;
    const taskId = await createAndStart(request, backend, FAKE_CLAUDE_ENTER_PROMPT_MARKER, title);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const card = panel.getByTestId("tmux-prompt-enter-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Claude is waiting for Enter")).toBeVisible();
    await expect(card.getByText("Login successful. Press Enter to continue")).toBeVisible();
    await expect(card.getByRole("button", { name: "Open in Terminal" })).toBeVisible();

    await card.getByRole("button", { name: "Continue (press Enter)" }).click();
    await expect(card).toHaveCount(0);
    await expect(panel.getByText("continued", { exact: true })).toBeVisible();

    // The card is gone for good: nothing is pending for the task.
    await expect.poll(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}/interactions/pending`, { headers: auth(backend) });
      return ((await res.json()) as unknown[]).length;
    }).toBe(0);
  });

  test("the OAuth code box types the code through the real route, and the code never lands in the events or the DOM", async ({ page, request, backend }) => {
    const title = `code-e2e ${randomUUID()}`;
    const code = "test-code-123";
    const taskId = await createAndStart(request, backend, FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER, title);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const card = panel.getByTestId("tmux-prompt-code-card");
    await expect(card).toBeVisible();
    const input = card.getByTestId("tmux-prompt-code-input");
    const submit = card.getByTestId("tmux-prompt-code-submit");
    await expect(submit).toBeDisabled(); // nothing to submit yet
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("maxlength", "512");
    await expect(input).toHaveAttribute("spellcheck", "false");

    await input.fill(code);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(card).toHaveCount(0);
    await expect(panel.getByText("code received (13 chars)", { exact: true })).toBeVisible();

    // Neither the persisted events nor anything rendered carries the code.
    const events = await request.get(`${backend.apiBase}/tasks/${taskId}/events/page?beforeId=999999999&limit=500`, {
      headers: auth(backend),
    });
    expect(events.status()).toBe(200);
    const eventsText = await events.text();
    expect(eventsText).toContain("code received (13 chars)"); // the page really returned this run's events
    expect(eventsText).not.toContain(code);
    expect(await page.content()).not.toContain(code);
  });

  test("a second answer to a resolved card is harmless", async ({ page, request, backend }) => {
    const title = `enter-twice-e2e ${randomUUID()}`;
    await createAndStart(request, backend, FAKE_CLAUDE_ENTER_PROMPT_MARKER, title);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    const card = panel.getByTestId("tmux-prompt-enter-card");
    await expect(card).toBeVisible();

    // Grab the card id, answer it once through the API, then answer it again.
    const task = (await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json() as Array<{ id: string; title: string }>)
      .find((t) => t.title === title)!;
    const pending = (await (await request.get(`${backend.apiBase}/tasks/${task.id}/interactions/pending`, { headers: auth(backend) })).json()) as Array<{ id: string }>;
    const id = pending[0]!.id;
    const first = await request.post(`${backend.apiBase}/tmux-prompts/${id}/answer`, { headers: auth(backend), data: { enter: true } });
    expect(first.status()).toBe(200);
    const second = await request.post(`${backend.apiBase}/tmux-prompts/${id}/answer`, { headers: auth(backend), data: { enter: true } });
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ ok: false });
    await expect(card).toHaveCount(0);
  });

  test("the route refuses a code on an Enter card with a fixed message", async ({ request, backend }) => {
    const title = `enter-wrong-e2e ${randomUUID()}`;
    const taskId = await createAndStart(request, backend, FAKE_CLAUDE_ENTER_PROMPT_MARKER, title);
    await expect.poll(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${taskId}/interactions/pending`, { headers: auth(backend) });
      return ((await res.json()) as unknown[]).length;
    }).toBe(1);
    const pending = (await (await request.get(`${backend.apiBase}/tasks/${taskId}/interactions/pending`, { headers: auth(backend) })).json()) as Array<{ id: string }>;
    const res = await request.post(`${backend.apiBase}/tmux-prompts/${pending[0]!.id}/answer`, {
      headers: auth(backend),
      data: { code: "should-not-be-typed" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).not.toContain("should-not-be-typed");
  });
});
