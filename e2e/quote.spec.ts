import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_PORT, E2E_API_TOKEN, E2E_BASE_URL } from "../playwright.config";

/**
 * E2E coverage for quote-on-select in the run panel's messages list
 * (docs/plans/quote-messages-list.md, §5 TT2). Runs Chromium against the
 * real webview + real Bun API/orchestrator (both started by
 * `playwright.config.ts`'s `webServer`) — no mocked fetches, no component
 * harness standing in for the actual DOM.
 *
 * Producing a rendered message without a real `claude` CLI or tmux: the
 * config's `webServer.env` sets `AGETOR_CLAUDE_DRIVER=fake` (see the comment
 * there), which makes `spawnAgent`'s claude-code branch return an in-process
 * fake agent (`makeFakeAgent` in `src/bun/agents.ts`) instead of shelling out
 * to tmux. That fake emits a plain `stdout` chunk — `"fake response to:
 * <prompt>"` — ~5ms after start, which the run panel renders through the
 * generic `RawText` block (`RunPanel.tsx`'s `case "stdout"`), i.e. plain
 * selectable text inside a `[data-evid]` wrapper. `AGETOR_CLAUDE_BIN` /
 * `AGETOR_TMUX_BIN` point at `/bin/echo` only to satisfy `checkHarness`'s
 * start-task pre-flight probe (which is a separate code path from the driver
 * override and always resolves a claude-shaped + tmux binary) — the fake
 * driver never actually spawns either.
 *
 * Selection is simulated by building a `Range` over the rendered text node
 * via `page.evaluate` and adding it to `window.getSelection()`, rather than
 * a pixel-level drag — `selectionchange` fires automatically on `addRange`
 * in Chromium, which is all `QuoteSelectionButton` listens for. No pixel or
 * screenshot assertions (WKWebView, the app's real target, renders
 * differently from Chromium) — everything here asserts DOM state: the
 * pill's `data-quote-open` marker + accessible name, and the composer
 * textarea's value/caret.
 *
 * Serial within this file since both tests below would otherwise race the
 * one task/composer they share; `theme.spec.ts` runs as a separate file
 * (separate worker/browser context) and never starts a run, so the two
 * specs don't observe each other's state.
 */

const API_BASE = `http://127.0.0.1:${E2E_API_PORT}`;
const BOOT_URL = `${E2E_BASE_URL}/#api=${E2E_API_PORT}&token=${E2E_API_TOKEN}`;
const AUTH = { authorization: `Bearer ${E2E_API_TOKEN}` };

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", a plain non-git temp dir as workdir —
 *  the fake driver never touches the filesystem, so it doesn't need to be a
 *  real repo) and start it. Returns the created task row. Fails loudly (via
 *  `expect`) rather than leaving a silent 400 for a later step to trip on. */
async function createAndStartFakeClaudeTask(
  request: APIRequestContext,
  prompt: string,
): Promise<TaskRow> {
  const createRes = await request.post(`${API_BASE}/tasks`, {
    headers: AUTH,
    data: { title: prompt, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${API_BASE}/tasks/${task.id}/start`, { headers: AUTH });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** Navigate to the app boot URL and wait for real rendered content — same
 *  pattern as theme.spec.ts's `gotoApp`. */
async function gotoApp(page: Page): Promise<void> {
  await page.goto(BOOT_URL);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

/** The run panel's slide-over `<aside>`. `RunPanel` is mounted after
 *  `NewTaskForm` (whose own `<aside>` sidebar is always present) in
 *  `App.tsx`'s JSX, so once a task is open there are exactly two `<aside>`
 *  elements and the run panel is the later one in DOM order. */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title (cards render `task.title` verbatim,
 *  and the card's `onClick` opens the run panel) and wait for the composer
 *  textarea to mount as proof the panel is open.
 *
 *  `.first()`: `TaskCard` also shows `task.prompt` as a preview line below
 *  the title (`line-clamp-2`), and this test uses the same string for both
 *  title and prompt — so the exact-text match resolves two elements. Either
 *  one bubbles the click up to the same `Card`'s `onClick`, so picking the
 *  first (the `CardTitle`, which renders first in DOM order) is enough. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

function quotePill(page: Page) {
  return page.locator("[data-quote-open]");
}

/** Build a native `Range` over the first text node anywhere in the document
 *  whose content includes `needle`, and install it as the window's live
 *  selection — the DOM end-state of a real text-drag, without simulating
 *  pixel-level mouse movement. Returns whether a match was found. */
async function selectTextContaining(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((marker) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(marker)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        if (!sel) return false;
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
    }
    return false;
  }, needle);
}

test.describe("quote-on-select", () => {
  test("selecting a rendered message shows the Quote pill; quoting it twice stacks blockquotes in the composer", async ({
    page,
    request,
  }) => {
    const prompt = `quote-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, prompt);
    // The fake driver's canned reply — see the fake-response comment atop
    // this file. Unique per test run via the prompt's uuid, so the
    // tree-walking text search below can never match stale content from a
    // prior run sharing the disposable e2e data dir.
    const responseMarker = `fake response to: ${prompt}`;

    await gotoApp(page);
    const panel = await openTask(page, prompt);

    // Replayed over the task's unified SSE event stream regardless of
    // whether the (very fast, ~20ms) fake turn already finished before we
    // navigated here.
    await expect(page.getByText(responseMarker)).toBeVisible();

    const textarea = panel.locator("textarea");
    await expect(textarea).toHaveValue("");

    // --- (1) selecting the message text shows the floating Quote pill ----
    const found1 = await selectTextContaining(page, responseMarker);
    expect(found1, `no text node containing "${responseMarker}" to select`).toBeTruthy();

    const pill = quotePill(page);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("data-quote-open", "");
    // Portaled to document.body (not left under RunPanel's transformed
    // `<aside>`) — see QuoteSelectionButton's doc comment on why that
    // matters for `position: fixed` to be viewport-relative.
    expect(await pill.evaluate((el) => el.parentElement === document.body)).toBe(true);

    const pillButton = page.getByRole("button", { name: /Quote/ });
    await expect(pillButton).toBeVisible();

    // --- (2) clicking it inserts a markdown blockquote into the composer -
    await pillButton.click();
    await expect(quotePill(page)).toHaveCount(0);

    const quotedLine = `> ${responseMarker}`;
    const afterFirst = `${quotedLine}\n\n`;
    await expect(textarea).toHaveValue(afterFirst);

    // Caret-before-focus (RunPanel.tsx's handleQuote) both happen inside a
    // requestAnimationFrame callback scheduled the moment the click handler
    // runs — after `toHaveValue` above resolves, `setInput` has definitely
    // committed, but the rAF callback isn't guaranteed to have fired yet
    // (headless Chromium can delay a frame relative to Playwright's own
    // polling cadence). Poll for focus rather than reading state exactly
    // once right after the value settles.
    await expect
      .poll(() => textarea.evaluate((el: HTMLTextAreaElement) => document.activeElement === el))
      .toBe(true);

    const first = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      value: el.value,
      selectionStart: el.selectionStart,
    }));
    expect(first.selectionStart).toBe(first.value.length);

    // --- (3) quoting a second time stacks a second `> ` block below it ---
    const found2 = await selectTextContaining(page, responseMarker);
    expect(found2, `no text node containing "${responseMarker}" to select (second pass)`).toBeTruthy();
    await expect(quotePill(page)).toBeVisible();

    await page.getByRole("button", { name: /Quote/ }).click();
    await expect(quotePill(page)).toHaveCount(0);

    const afterSecond = `${quotedLine}\n\n${quotedLine}\n\n`;
    await expect(textarea).toHaveValue(afterSecond);

    const second = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      value: el.value,
      selectionStart: el.selectionStart,
    }));
    expect(second.selectionStart).toBe(second.value.length);
  });
});
