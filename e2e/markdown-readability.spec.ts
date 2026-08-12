import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the message-markdown reading rhythm inside the Task
 * Details stream's `.agetor-md` class (src/mainview/index.css). Modeled
 * directly on e2e/quote.spec.ts's harness (real Chromium against the real
 * webview + a per-worker headless Bun backend, no mocked fetches) and
 * e2e/font-size.spec.ts's style-assertion conventions (computed-style
 * assertions rather than screenshots/pixel constants — a user font-size
 * control tunes the rem-based values these rules use, so any pixel constant
 * would fall out of sync).
 *
 * Producing a real `.agetor-md` block with arbitrary, test-authored markdown:
 * the fake claude driver (`AGETOR_CLAUDE_DRIVER=fake`, set by the `backend`
 * fixture) only emits a *fixed* canned reply ("fake response to: <prompt>")
 * on the `stdout` stream, which the run panel renders through the generic
 * `RawText` block — plain text, not markdown (see quote.spec.ts's header
 * comment). There is no test hook to control the fake driver's `assistant`-
 * stream text. What orchestrator.ts *does* do unconditionally on every
 * `startTask` is echo the task's own prompt back as a `user` stream event
 * (orchestrator.ts, "Echo the initial prompt as a 'user' event so the panel
 * renders it") — and the "you" bubble that renders (`RunPanel.tsx`) feeds
 * that prompt straight through `ReactMarkdown` inside a `className="agetor-md
 * ..."` wrapper, using `USER_MD_COMPONENTS`. That components map only
 * overrides `a`/`code`/`pre` (`md-components.tsx`) — headings, paragraphs,
 * and lists render as plain default tags, identical to what
 * `ASSISTANT_MD_COMPONENTS` would produce for the same markdown — so seeding
 * the *prompt* with our test markdown exercises exactly the same `.agetor-md`
 * CSS rules the assistant stream would, without needing a real/controllable
 * assistant reply.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", a plain non-git temp dir as workdir — the
 *  fake driver never touches the filesystem) with a distinct title/prompt and
 *  start it, so orchestrator.ts's prompt-echo puts `prompt` on the `user`
 *  stream as a real `.agetor-md`-rendered block. Fails loudly via `expect`
 *  rather than leaving a silent 400 for a later step to trip on. */
async function createAndStartTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  prompt: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir: tmpdir() },
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

/** The run panel's slide-over `<aside>` — see quote.spec.ts's identical
 *  helper for why `.last()` is the right pick (RunPanel mounts after
 *  NewTaskForm's own always-present `<aside>` sidebar). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the composer textarea
 *  to mount as proof the run panel is open. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Computed `margin-top`, in px, as a number — `getComputedStyle` via
 *  `locator.evaluate`, per the task's structural-assertion requirement
 *  (never a hardcoded pixel constant; only relative/zero comparisons). */
async function marginTopPx(locator: Locator): Promise<number> {
  const value = await locator.evaluate((el) => getComputedStyle(el).marginTop);
  return Number.parseFloat(value);
}

test.describe("markdown readability", () => {
  test("message markdown block follows the .agetor-md reading rhythm: heading/paragraph/list spacing", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `markdown-e2e ${marker}`;
    // First-child heading, a paragraph, a second paragraph, another heading,
    // then a list — exactly the shape the rhythm rules key off of.
    const prompt =
      `## Reading Rhythm ${marker}\n\n` +
      `para one line\n\n` +
      `para two line\n\n` +
      `### Section ${marker}\n\n` +
      `- item a\n- item b`;

    await createAndStartTask(request, backend, title, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // Exactly one `.agetor-md` block should exist in the panel: the "you"
    // bubble rendering our seeded prompt. The fake driver's canned assistant
    // reply renders as plain `RawText`, not markdown, so it contributes none.
    const blocks = panel.locator(".agetor-md");
    await expect(blocks).toHaveCount(1);
    const container = blocks.first();

    // Wait for the whole markdown tree to have committed in one shot
    // (ReactMarkdown renders synchronously, not streamed piecemeal) before
    // taking any measurements — two `<li>`s is a reliable proxy for "the
    // headings and paragraphs above it are there too."
    await expect(container.locator("li")).toHaveCount(2);
    await expect(container.locator("p")).toHaveCount(2);
    await expect(container.locator("h3")).toHaveCount(1);
    await expect(container.locator("ul")).toHaveCount(1);

    const firstChild = container.locator("> :first-child");
    const paragraphs = container.locator("p");
    const secondHeading = container.locator("h3");
    const list = container.locator("ul");

    // --- first child: no leading gap above the block's own first line ----
    expect(await marginTopPx(firstChild)).toBe(0);

    // --- paragraph -> paragraph gap: the owl (`> * + *`) rhythm reaches
    //     paragraphs now that the old `p { margin: 0 }` reset is gone -------
    const secondParagraphMarginTop = await marginTopPx(paragraphs.nth(1));
    expect(secondParagraphMarginTop).toBeGreaterThan(0);

    // --- heading prominence: a non-first heading gets more top margin than
    //     an ordinary paragraph ------------------------------------------
    const headingMarginTop = await marginTopPx(secondHeading);
    expect(headingMarginTop).toBeGreaterThan(secondParagraphMarginTop);

    // --- snug-below: the element right after a heading sits closer than
    //     the heading's own top margin, so the heading reads as attached to
    //     what follows it -------------------------------------------------
    const afterHeadingMarginTop = await marginTopPx(list);
    expect(afterHeadingMarginTop).toBeLessThan(headingMarginTop);
  });
});
