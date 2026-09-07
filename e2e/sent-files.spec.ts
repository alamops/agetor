import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the "files sent to the user" `SendUserFile` cards
 * (docs/plans/send-files-to-user.md §5 TT1): a canned fake-driver scenario
 * runs a real turn through the real orchestrator, and this spec asserts the
 * derived UI lands everywhere a user sees it — the RunPanel's `SentFilesCard`
 * (delivered + error variants), the tile menu, the board `TaskCard`'s
 * paperclip badge, and the `files-sent` toast — proving the chunks ->
 * `parseSentFilesToolUse`/`parseSentFilesToolResult` (shared/sent-files.ts)
 * -> `tasks.sent_files` -> UI loop end to end.
 *
 * Mirrors `e2e/todo-progress.spec.ts`'s structure throughout.
 *
 * Product-bug note (Phase 8, not fixed here per this agent's file scope):
 * `GET /events` and `GET /app/events` (src/bun/server.ts:5111 and :5198)
 * never enqueue an initial chunk in their `ReadableStream`'s `start()` the
 * way `GET /tasks/:id/events` (:5387) does with its replay-meta frame — so
 * on a fresh connection with no other global/app-level activity, Bun does
 * not flush any response bytes to the client until either a real event
 * fires or the 15s keepalive ping does. Measured live: a freshly-connected
 * client's `/events` request got no observable HTTP response for ~14.7-15s
 * (three isolated repro runs, ~16.2-16.5s wall time each, all attributable
 * to this one gap — see the git history of this file for the instrumented
 * request/response timing log that pinned it down). The subscription itself
 * is registered synchronously while handling the request (this spec relies
 * on exactly that to avoid the same latency — see the comment at its use
 * below), so no event is ever lost, but a real event that happens to land
 * in a fresh client's first ~15s is delayed by however long is left until
 * that window closes, and the *connection itself* is not observably "open"
 * (no response headers) until then either. Fix suggestion for Phase 8: send
 * an immediate sentinel/comment frame (or a `: connected\n\n` SSE comment)
 * in both routes' `start()`, mirroring the immediate frame the per-task
 * route already sends.
 */

/**
 * Mirrors `FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER` in `src/bun/agents.ts` (kept
 * as a literal, not an import — see todo-progress.spec.ts's identical
 * comment for why `src/bun/*.ts` can't be imported from Playwright's Node
 * process while `src/shared/*.ts` can).
 */
const FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER = "__agetor_fake_claude_sent_files__";

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task whose prompt embeds the sent-files scenario marker
 *  (isolation "none", a fresh per-test temp dir as workdir — the fake
 *  driver writes real files under `<workdir>/agetor-sent/`, and a fresh dir
 *  per test keeps those paths, and thus every `data-path`/`title` assertion
 *  below, predictable and collision-free across tests sharing this worker's
 *  backend) and start it. Returns the created task plus the workdir so
 *  callers can compute the exact absolute paths the fake driver will write. */
async function createAndStartFakeSentFilesTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<{ task: TaskRow; workdir: string; pngPath: string; mdPath: string; sentDir: string }> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-sent-"));
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `${FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir },
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

  const sentDir = path.join(workdir, "agetor-sent");
  return {
    task,
    workdir,
    pngPath: path.join(sentDir, "chart.png"),
    mdPath: path.join(sentDir, "report.md"),
    sentDir,
  };
}

/** The run panel's slide-over `<aside>` — see quote.spec.ts's identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is
 *  also an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as quote.spec.ts's `openTask`.
 *  `.first()` resolves the board `CardTitle` over any later text-match
 *  inside the (not-yet-open) panel. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** The board `TaskCard` for a given (unique, uuid-suffixed) title — same
 *  idiom as binary-diff.spec.ts's `taskCard`: `TaskCard.tsx` puts
 *  `cursor-grab` on the Card root unconditionally, the only stable hook
 *  available since board cards carry no `data-testid`. */
function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

/** Waits for the scenario's final assistant chunk ("Done.", emitted just
 *  before "turn complete") so every assertion below runs against the fully
 *  streamed + persisted turn, regardless of whether the (very fast) fake
 *  turn already finished before the page navigated here — replayed either
 *  way over the task's unified SSE event stream. Scoped to `panel` since a
 *  bare page-wide "Done." text match could cross another test's task. */
async function waitForScenarioComplete(panel: Locator) {
  await expect(panel.getByText("Done.", { exact: true })).toBeVisible();
}

function sentFilesCards(panel: Locator) {
  return panel.locator('[data-testid="sent-files-card"]');
}

test.describe("sent files to user", () => {
  test("delivered card renders tiles, error card renders the folder tile, and both survive a reload", async ({
    page,
    request,
    backend,
  }) => {
    const title = `sent-files-e2e ${randomUUID()}`;
    const { pngPath, mdPath, sentDir } = await createAndStartFakeSentFilesTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForScenarioComplete(panel);

    // --- exactly 2 cards: one delivered, one errored ----------------------
    const cards = sentFilesCards(panel);
    await expect(cards).toHaveCount(2);

    const deliveredCard = cards.nth(0);
    const errorCard = cards.nth(1);

    // --- (1) delivered card -------------------------------------------
    await expect(deliveredCard.getByText("Fake delivery — a chart and its report")).toBeVisible();

    const deliveredTiles = deliveredCard.locator('[data-testid="sent-file-tile"]');
    await expect(deliveredTiles).toHaveCount(2);

    const pngTile = deliveredCard.locator(`[data-testid="sent-file-tile"][data-path="${pngPath}"]`);
    await expect(pngTile).toHaveAttribute("data-kind", "image");
    await expect(pngTile).toHaveAttribute("title", pngPath);
    const pngImg = pngTile.locator("img");
    await expect(pngImg).toHaveCount(1);
    await expect.poll(() => pngImg.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const mdTile = deliveredCard.locator(`[data-testid="sent-file-tile"][data-path="${mdPath}"]`);
    await expect(mdTile).toHaveAttribute("data-kind", "file");
    await expect(mdTile).toHaveAttribute("title", mdPath);
    await expect(mdTile.getByText("report.md", { exact: true })).toBeVisible();
    await expect(mdTile.locator("svg")).toHaveCount(1);

    await expect(deliveredCard.locator('[data-testid="sent-files-status"]')).toHaveText("2 files delivered");

    // --- (2) error card -------------------------------------------------
    await expect(errorCard.locator('[data-testid="sent-files-status"]')).toContainText("is not a regular file");

    const errorTiles = errorCard.locator('[data-testid="sent-file-tile"]');
    await expect(errorTiles).toHaveCount(1);
    const folderTile = errorTiles.first();
    await expect(folderTile).toHaveAttribute("data-path", sentDir);
    await expect(folderTile).toHaveAttribute("data-kind", "folder");
    await expect(folderTile.getByText("agetor-sent", { exact: true })).toBeVisible();

    // Evidence hook (opt-in): `AGETOR_E2E_SHOT_DIR=<dir>` saves a PNG of the
    // run panel with both cards rendered, for reports/PR descriptions.
    if (process.env.AGETOR_E2E_SHOT_DIR) {
      await panel.screenshot({ path: `${process.env.AGETOR_E2E_SHOT_DIR}/sent-files-cards.png` });
    }

    // --- (7) historical render: reload and re-open from persisted events --
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    const reopenedPanel = await openTask(page, title);
    const reopenedCards = sentFilesCards(reopenedPanel);
    await expect(reopenedCards).toHaveCount(2);
    await expect(reopenedCards.nth(0).getByText("Fake delivery — a chart and its report")).toBeVisible();
    await expect(reopenedCards.nth(0).locator('[data-testid="sent-files-status"]')).toHaveText(
      "2 files delivered",
    );
    await expect(reopenedCards.nth(1).locator('[data-testid="sent-files-status"]')).toContainText(
      "is not a regular file",
    );
    const reopenedPngTile = reopenedCards
      .nth(0)
      .locator(`[data-testid="sent-file-tile"][data-path="${pngPath}"]`);
    await expect(reopenedPngTile).toHaveAttribute("data-kind", "image");
    await expect.poll(() => reopenedPngTile.locator("img").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  test("clicking a tile opens the headless 'Couldn't open' dialog", async ({ page, request, backend }) => {
    const title = `sent-files-e2e-open ${randomUUID()}`;
    const { mdPath } = await createAndStartFakeSentFilesTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForScenarioComplete(panel);

    const deliveredCard = sentFilesCards(panel).nth(0);
    const mdTile = deliveredCard.locator(`[data-testid="sent-file-tile"][data-path="${mdPath}"]`);
    await expect(mdTile).toBeVisible();
    await mdTile.click();

    const dialogTitle = page.locator("#attachment-open-error-title");
    await expect(dialogTitle).toBeVisible();

    // Scoped to the dialog itself and exact-matched — "Close" is a
    // substring of both "Close task panel" and "Close task details"
    // (RunPanel's own overlay/close buttons), which a page-wide,
    // substring-matched getByRole would ambiguously also match.
    const openErrorDialog = page.getByRole("dialog").filter({ has: dialogTitle });
    await openErrorDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialogTitle).toHaveCount(0);
  });

  test("tile menu offers Open / Reveal in Finder / Copy path, and Escape closes only the menu", async ({
    page,
    request,
    backend,
  }) => {
    const title = `sent-files-e2e-menu ${randomUUID()}`;
    const { pngPath } = await createAndStartFakeSentFilesTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForScenarioComplete(panel);

    const deliveredCard = sentFilesCards(panel).nth(0);
    const pngTile = deliveredCard.locator(`[data-testid="sent-file-tile"][data-path="${pngPath}"]`);
    await expect(pngTile).toBeVisible();
    await pngTile.hover();

    const menuButton = pngTile.locator('xpath=following-sibling::button[@data-testid="sent-file-tile-menu"]');
    await expect(menuButton).toHaveAttribute("aria-label", "File actions");
    await menuButton.click();

    const menu = page.locator('[data-testid="sent-file-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();

    // Regression check: RunPanel's own Escape/panel-close handler must yield
    // to the popover (data-popover-open) — the first Escape should close
    // only the menu, never the run panel underneath it.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(panel.locator("textarea")).toBeVisible();
  });

  test("board TaskCard shows the paperclip badge with the delivered count", async ({ page, request, backend }) => {
    const title = `sent-files-e2e-badge ${randomUUID()}`;
    await createAndStartFakeSentFilesTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForScenarioComplete(panel);

    const card = taskCard(page, title);
    const badge = card.locator('[data-testid="sent-files-badge"]');
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("2");
    await expect(badge).toHaveAttribute("title", /chart\.png/);
  });

  test("a files-sent toast appears for a task that is not open", async ({ page, request, backend }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(String(err));
    });

    // Navigate FIRST so the app-level GlobalEvent SSE subscription
    // (api.subscribeGlobalEvents in App.tsx, which opens `GET /events`) is
    // live before the task starts — `files-sent` is a live-only signal (no
    // replay, see server.ts's "/events" route comment and App.tsx's handler
    // comment), so starting the task before the page's subscription is
    // actually registered server-side would miss the toast entirely.
    //
    // Deliberately waits for the `GET /events` REQUEST, not its response:
    // `/events`'s route handler (server.ts) registers the subscription
    // (`subscribeGlobal`) synchronously while handling the request, but
    // never enqueues an initial chunk the way `/tasks/:id/events` does with
    // its replay-meta frame — so Bun doesn't flush any response bytes (and
    // Playwright never observes a "response") until the first real event or
    // the 15s keepalive ping, whichever comes first. Waiting on the request
    // event avoids riding that latency while still proving the effect that
    // opens the EventSource has fired — see the product-bug note in this
    // spec's header comment for the underlying latency issue itself.
    const globalEventsRequested = page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/events",
    );
    await gotoApp(page, backend.bootBase);
    await globalEventsRequested;

    const title = `sent-files-e2e-toast ${randomUUID()}`;
    await createAndStartFakeSentFilesTask(request, backend, title);

    await expect(page.getByText("2 files sent to you")).toBeVisible();

    // Best-effort product-bug detector (Phase 8 concern, not this test's to
    // fail on): api.notifyOS is fire-and-forget with its own .catch, so this
    // is expected to stay empty, but report it if it ever isn't.
    const notifyOsNoise = consoleErrors.filter((line) => /notifyOS|notifications/i.test(line));
    if (notifyOsNoise.length > 0) {
      // eslint-disable-next-line no-console -- deliberate: surfaced as a
      // Phase 8 product-bug lead, not a test failure.
      console.log(`[e2e] possible unhandled api.notifyOS rejection:\n${notifyOsNoise.join("\n")}`);
    }
  });
});
