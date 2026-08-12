import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for quote-on-select in the run panel's messages list
 * (docs/plans/quote-messages-list.md, §5 TT2). Runs Chromium against the
 * real webview + real Bun API/orchestrator (a per-worker instance
 * provisioned by the `backend` fixture in e2e/fixtures.ts) — no mocked
 * fetches, no component harness standing in for the actual DOM.
 *
 * Producing a rendered message without a real `claude` CLI or tmux: the
 * backend fixture sets `AGETOR_CLAUDE_DRIVER=fake` (see the comment there),
 * which makes `spawnAgent`'s claude-code branch return an in-process fake
 * agent (`makeFakeAgent` in `src/bun/agents.ts`) instead of shelling out to
 * tmux. That fake emits a plain `stdout` chunk — `"fake response to:
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
 * `test.describe.configure({ mode: "serial" })` below is future-proofing:
 * this file currently has one test, but a second test added later would
 * share the same worker's backend/DB (per e2e/fixtures.ts) and could race
 * this one's task/composer state without serial mode. `theme.spec.ts` runs
 * as a separate file (its own worker, browser context, and its own headless
 * backend) and never starts a run, so the two specs don't observe each
 * other's state regardless.
 */

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
    backend,
  }) => {
    const prompt = `quote-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);
    // The fake driver's canned reply — see the fake-response comment atop
    // this file. Unique per test via the prompt's uuid — this worker's
    // backend/DB is shared across every test in the file for the whole run
    // (per e2e/fixtures.ts), so if this file gains more tests the uuid keeps
    // the tree-walking text search below from matching another test's task.
    const responseMarker = `fake response to: ${prompt}`;

    await gotoApp(page, backend.bootBase);
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
