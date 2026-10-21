import { randomUUID } from "node:crypto";
import { test, expect, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import {
  FAKE_CLAUDE_HANDOFF_PROMPT_MARKER as MARKER,
  boardCardById,
  boardScroller,
  cardVisibility,
  columnVisibility,
  contentRect,
  createPipelineRest,
  createPipelineTaskRest,
  createPlainTasksRest,
  createProfileRest,
  gotoAppSubscribed,
  makeStep,
  readScroll,
  scrollRange,
  scrollToOffsets,
  startTaskRest,
  waitForPipelineRest,
  type ScrollOffsets,
  type TaskRow,
} from "./scroll-memory-helpers";

/**
 * E2e coverage for the board's scroll-position memory across pipeline pages
 * (docs/plans/board-scroll-position.md §5, E1, scenarios B1-B6): the board
 * comes back at the exact `scrollLeft`/`scrollTop` the user left, and a
 * departure from a pipeline-parent CARD additionally reveals that card once
 * (minimum distance, only when it is entirely out of view).
 *
 * Every test seeds 12 plain backlog tasks (vertical overflow) plus its own
 * pipeline task(s) over REST on a `freshBackend` with the default fast fake
 * claude driver, and asserts its geometry preconditions explicitly.
 */

const TOAST_TIMEOUT = 20_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
// Narrow enough that a card which sat at the right edge of the 1280px board
// is entirely out of view after the viewport shrinks by 400px.
const NARROW_VIEWPORT = { width: 880, height: 720 } as const;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Seed {
  profileId: string;
  plain: TaskRow[];
}

/** One profile + 12 plain backlog tasks. */
async function seedBase(backend: E2EBackend): Promise<Seed> {
  const profileId = await createProfileRest(backend, "Runner");
  const plain = await createPlainTasksRest(backend, 12, "Plain");
  return { profileId, plain };
}

/** A single-step pipeline + one unstarted pipeline task on it. */
async function createSingleStepPipelineTask(
  backend: E2EBackend,
  profileId: string,
  label: string,
  handoff: "done" | "missing" = "done",
): Promise<TaskRow> {
  const step = makeStep({ id: randomUUID(), name: `${label} step`, agentProfileId: profileId });
  const pipelineId = await createPipelineRest(backend, `${label} pipeline`, [step], []);
  return createPipelineTaskRest(backend, `${label} ${randomUUID().slice(0, 8)}`, pipelineId, `Do it. ${MARKER}:${handoff}`);
}

/** Creates a task, starts it and waits until it is a finished run in Review. */
async function createFinishedTask(backend: E2EBackend, profileId: string, label: string): Promise<TaskRow> {
  const task = await createSingleStepPipelineTask(backend, profileId, label);
  await startTaskRest(backend, task.id);
  await waitForPipelineRest(backend, task.id, (t) => t.pipelineRun?.status === "done" && t.column === "review");
  return task;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Waits for the board scroller to be attached and asserts the overflow precondition. */
async function expectBoardOverflow(page: Page): Promise<{ maxLeft: number; maxTop: number }> {
  await expect(boardScroller(page)).toBeVisible();
  // The first task list arrives after the board first renders (empty).
  await expect
    .poll(async () => (await scrollRange(boardScroller(page))).maxTop, { message: "board must overflow vertically" })
    .toBeGreaterThan(100);
  const range = await scrollRange(boardScroller(page));
  expect(range.maxLeft, "board must overflow horizontally").toBeGreaterThan(100);
  return range;
}

/** The label of the status column the card currently sits in. */
function cardColumnLabel(page: Page, id: string): Promise<string | null> {
  return page.evaluate((taskId) => {
    const card = document.querySelector(`[data-task-id="${taskId}"]`);
    const col = card?.closest(".w-72");
    return col?.querySelector("h2")?.textContent?.trim() ?? null;
  }, id);
}

/**
 * Scrolls the board so the card is fully inside the client box, at the
 * horizontal offset `left` (default 0) and the largest vertical offset that
 * keeps the card fully visible (so `top` is as non-zero as the layout allows).
 * Asserts the card is `full` afterwards.
 */
async function scrollCardFullyIntoView(page: Page, id: string, left = 0): Promise<ScrollOffsets> {
  const scroller = boardScroller(page);
  const rect = await contentRect(page, id);
  const { maxTop, clientHeight } = await scrollRange(scroller);
  const lowest = Math.max(0, Math.ceil(rect.bottom - clientHeight));
  const top = Math.floor(Math.min(Math.max(rect.top, lowest), maxTop));
  const actual = await scrollToOffsets(scroller, { left, top });
  const vis = await cardVisibility(page, id);
  expect(vis.state, `card ${id} should be fully visible at ${JSON.stringify(actual)}`).toBe("full");
  return actual;
}

/** Waits for the board (after a return) and asserts the exact offsets. */
async function expectBoardAt(page: Page, expected: ScrollOffsets): Promise<void> {
  await expect(boardScroller(page)).toBeVisible();
  await expect.poll(() => readScroll(boardScroller(page))).toEqual(expected);
}

/**
 * Resolves once App's task list (the 2 s `/tasks` poll or a refetch) holds
 * the task in `column`, and has been applied: the matching response is
 * followed by one more `/tasks` response, so the first one's state update is
 * long committed. Register BEFORE the action that moves the task, await it
 * before the navigation that needs the card in place.
 */
function appSeesColumn(page: Page, id: string, column: string): Promise<void> {
  const isList = (url: string, method: string) => new URL(url).pathname === "/tasks" && method === "GET";
  return (async () => {
    await page.waitForResponse(
      async (r) => {
        if (!isList(r.url(), r.request().method())) return false;
        try {
          const body = (await r.json()) as TaskRow[] | { tasks: TaskRow[] };
          const rows = Array.isArray(body) ? body : body.tasks;
          return rows.some((t) => t.id === id && t.column === column);
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    await page.waitForResponse((r) => isList(r.url(), r.request().method()), { timeout: 30_000 });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  })();
}

function finishedToast(page: Page, title: string) {
  return page
    .locator("[data-sonner-toaster] [data-sonner-toast]")
    .filter({ hasText: "Pipeline finished" })
    .filter({ hasText: title });
}

async function openPipelinesPage(page: Page): Promise<void> {
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId("pipelines-back")).toBeVisible();
}

async function backFromRunView(page: Page): Promise<void> {
  await page.getByTestId("pipeline-run-back").click();
  await expect(boardScroller(page)).toBeVisible();
}

// ---------------------------------------------------------------------------
// B1 — exact offsets across non-card leaves
// ---------------------------------------------------------------------------

test.describe("board scroll position", () => {
  test("B1: the board returns at exactly the same offsets from the Pipelines page, Escape and the editor", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const step = makeStep({ id: randomUUID(), name: "Only", agentProfileId: profileId });
    await createPipelineRest(backend, "Editable pipeline", [step], []);

    await gotoApp(page, backend.bootBase);
    const { maxLeft, maxTop } = await expectBoardOverflow(page);
    const target = await scrollToOffsets(boardScroller(page), {
      left: Math.floor(maxLeft / 2),
      top: Math.floor(maxTop / 2),
    });
    expect(target.left).toBeGreaterThan(0);
    expect(target.top).toBeGreaterThan(0);

    // (a) header Pipelines button, then the page's Back.
    await openPipelinesPage(page);
    await page.getByTestId("pipelines-back").click();
    await expectBoardAt(page, target);

    // (b) Pipelines page, then Escape.
    await openPipelinesPage(page);
    await page.keyboard.press("Escape");
    await expectBoardAt(page, target);

    // (c) Pipelines page -> editor -> editor Back -> Pipelines Back.
    await openPipelinesPage(page);
    await page.getByTestId("pipelines-edit").first().click();
    await expect(page.getByTestId("pipeline-back")).toBeVisible();
    await page.getByTestId("pipeline-back").click();
    await expect(page.getByTestId("pipelines-back")).toBeVisible();
    await page.getByTestId("pipelines-back").click();
    await expectBoardAt(page, target);
  });

  // -------------------------------------------------------------------------
  // B2 — a toast leave never reveals
  // -------------------------------------------------------------------------

  test("B2: leaving through a toast restores the offsets and never reveals the finished card", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const P = await createSingleStepPipelineTask(backend, profileId, "Toast P");

    await gotoAppSubscribed(page, backend);
    const { maxTop } = await expectBoardOverflow(page);
    await expect(boardCardById(page, P.id)).toBeVisible();

    // A small non-zero left at which the Review column is entirely out of view.
    const target = await scrollToOffsets(boardScroller(page), { left: 40, top: Math.floor(maxTop / 2) });
    expect(target.left).toBeGreaterThan(0);
    expect(target.top).toBeGreaterThan(0);
    expect((await columnVisibility(page, "Review")).state, "precondition: Review column out of view").toBe("none");

    await startTaskRest(backend, P.id);
    const toast = finishedToast(page, P.title);
    await expect(toast).toBeVisible({ timeout: TOAST_TIMEOUT });
    // The card moved into Review (entirely out of view at this offset).
    await expect.poll(() => cardColumnLabel(page, P.id)).toBe("Review");
    expect((await cardVisibility(page, P.id)).state).toBe("none");
    // The card left the backlog column from above the viewport, so Chromium's
    // native scroll anchoring may have shifted `scrollTop` by the card's
    // height. That is the browser, not the feature: what must come back is
    // whatever offsets the board held when the user left.
    const leftAt = await readScroll(boardScroller(page));
    expect(leftAt.left).toBe(target.left);
    expect(leftAt.top).toBeGreaterThan(0);

    await toast.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await backFromRunView(page);

    await expectBoardAt(page, leftAt);
    expect((await cardVisibility(page, P.id)).state).toBe("none");
  });

  // -------------------------------------------------------------------------
  // B3 — card-body leave reveals the moved card, once
  // -------------------------------------------------------------------------

  test("B3: a card-body leave reveals the card after it moved off-screen, and the record is consumed", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const P = await createSingleStepPipelineTask(backend, profileId, "Reveal P");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, P.id)).toBeVisible();

    const before = await scrollCardFullyIntoView(page, P.id, 0);
    expect((await columnVisibility(page, "Review")).state, "precondition: Review column out of view").toBe("none");

    // Leave from the card body.
    await boardCardById(page, P.id).getByText(P.title, { exact: true }).first().click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    const appInReview = appSeesColumn(page, P.id, "review");
    await startTaskRest(backend, P.id);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: TOAST_TIMEOUT });
    await appInReview;

    await backFromRunView(page);
    await expect(boardCardById(page, P.id)).toBeVisible();
    await expect.poll(async () => (await cardVisibility(page, P.id)).state).toBe("full");
    expect(await cardColumnLabel(page, P.id)).toBe("Review");

    // Minimum distance per axis: unchanged, or flush with the edge it moved toward.
    const after = await readScroll(boardScroller(page));
    const vis = await cardVisibility(page, P.id);
    const rect = vis.target!;
    expect(after.left !== before.left || after.top !== before.top, "the board must have moved to reveal the card").toBe(true);
    if (after.left > before.left) expect(Math.abs(rect.right - vis.view.right)).toBeLessThanOrEqual(1);
    if (after.left < before.left) expect(Math.abs(rect.left - vis.view.left)).toBeLessThanOrEqual(1);
    if (after.top > before.top) expect(Math.abs(rect.bottom - vis.view.bottom)).toBeLessThanOrEqual(1);
    if (after.top < before.top) expect(Math.abs(rect.top - vis.view.top)).toBeLessThanOrEqual(1);

    // Second leg: the departure record was consumed by the first return.
    const { maxTop } = await scrollRange(boardScroller(page));
    const away = await scrollToOffsets(boardScroller(page), { left: 0, top: Math.floor(maxTop / 2) });
    expect((await cardVisibility(page, P.id)).state, "precondition: card out of view").toBe("none");
    await openPipelinesPage(page);
    await page.getByTestId("pipelines-back").click();
    await expectBoardAt(page, away);
    expect((await cardVisibility(page, P.id)).state).toBe("none");
  });

  // -------------------------------------------------------------------------
  // B4 — multi-hop reveals the original card
  // -------------------------------------------------------------------------

  test("B4: card A -> toast -> run view B -> Back reveals A", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const P1 = await createSingleStepPipelineTask(backend, profileId, "Hop One");
    const P2 = await createSingleStepPipelineTask(backend, profileId, "Hop Two");

    await gotoAppSubscribed(page, backend);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, P1.id)).toBeVisible();
    await scrollCardFullyIntoView(page, P1.id, 0);
    expect((await columnVisibility(page, "Review")).state, "precondition: Review column out of view").toBe("none");

    await boardCardById(page, P1.id).getByText(P1.title, { exact: true }).first().click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    const p1InReview = appSeesColumn(page, P1.id, "review");
    await startTaskRest(backend, P1.id);
    await startTaskRest(backend, P2.id);

    // The non-card hop: the "Pipeline finished" toast for the OTHER pipeline.
    const toast = finishedToast(page, P2.title);
    await expect(toast).toBeVisible({ timeout: TOAST_TIMEOUT });
    await toast.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: TOAST_TIMEOUT });
    await waitForPipelineRest(backend, P1.id, (t) => t.pipelineRun?.status === "done" && t.column === "review");
    await p1InReview;

    await backFromRunView(page);
    await expect(boardCardById(page, P1.id)).toBeVisible();
    await expect.poll(async () => (await cardVisibility(page, P1.id)).state).toBe("full");
    expect(await cardColumnLabel(page, P1.id)).toBe("Review");
  });

  // -------------------------------------------------------------------------
  // B5 — a partly visible card that did not move stays put
  // -------------------------------------------------------------------------

  test("B5: a partly visible card that did not move is not nudged", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const P = await createSingleStepPipelineTask(backend, profileId, "Partial P");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, P.id)).toBeVisible();

    // Vertically in view, horizontally cut by a left that clips the backlog column.
    const full = await scrollCardFullyIntoView(page, P.id, 0);
    const rect = await contentRect(page, P.id);
    const left = Math.floor(rect.left + (rect.right - rect.left) / 3);
    const target = await scrollToOffsets(boardScroller(page), { left, top: full.top });
    expect(target.left).toBeGreaterThan(0);
    expect((await cardVisibility(page, P.id)).state, "precondition: card partially visible").toBe("partial");

    // dispatchEvent avoids Playwright's own scroll-into-view / focus scroll.
    await boardCardById(page, P.id).dispatchEvent("click");
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await backFromRunView(page);

    await expectBoardAt(page, target);
    expect((await cardVisibility(page, P.id)).state).toBe("partial");
  });

  // -------------------------------------------------------------------------
  // B6 — the other three card paths record a departure; the control path does not
  // -------------------------------------------------------------------------

  /**
   * Scrolls (vertically to 0) so the card is fully visible with its right
   * edge within 24px of the view's right edge. Returns the offsets.
   */
  async function scrollCardToRightEdge(page: Page, id: string): Promise<ScrollOffsets> {
    const scroller = boardScroller(page);
    const rect = await contentRect(page, id);
    const { maxLeft, clientWidth } = await scrollRange(scroller);
    const left = Math.min(Math.max(Math.floor(rect.right - clientWidth + 12), 0), maxLeft);
    const actual = await scrollToOffsets(scroller, { left, top: 0 });
    const vis = await cardVisibility(page, id);
    expect(vis.state, "precondition: card fully visible").toBe("full");
    const gap = vis.view.right - vis.target!.right;
    expect(gap, "precondition: card right edge within 24px of the view's right edge").toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
    return actual;
  }

  /** On the run view: narrow the viewport, go back, assert the reveal, restore the viewport. */
  async function narrowBackAndExpectReveal(page: Page, id: string, before: ScrollOffsets): Promise<void> {
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await page.setViewportSize(NARROW_VIEWPORT);
    await backFromRunView(page);
    await expect(boardCardById(page, id)).toBeVisible();
    await expect.poll(async () => (await cardVisibility(page, id)).state).toBe("full");
    const after = await readScroll(boardScroller(page));
    expect(after.left, "scrollLeft changed to reveal the card").not.toBe(before.left);
    const vis = await cardVisibility(page, id);
    expect(Math.abs(vis.target!.right - vis.view.right), "card right edge flush with the view").toBeLessThanOrEqual(1);
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }

  test("B6a: the card's Open button records a departure", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const F = await createFinishedTask(backend, profileId, "Open F");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, F.id)).toBeVisible();
    const before = await scrollCardToRightEdge(page, F.id);

    await boardCardById(page, F.id).getByRole("button", { name: "Open", exact: true }).click();
    await narrowBackAndExpectReveal(page, F.id, before);
  });

  test("B6b: the card's amber Review button records a departure", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const K = await createSingleStepPipelineTask(backend, profileId, "Review K", "missing");
    await startTaskRest(backend, K.id);
    await waitForPipelineRest(backend, K.id, (t) => t.pipelineRun?.status === "blocked");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, K.id)).toBeVisible();
    await expect.poll(() => cardColumnLabel(page, K.id)).toBe("Blocked");
    const before = await scrollCardToRightEdge(page, K.id);

    await boardCardById(page, K.id).getByRole("button", { name: /^Review/ }).click();
    // The attention landing opens the run view PLUS the blocked step's run
    // panel; its full-screen backdrop covers the run view, so close it first.
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("run-panel-resize")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("run-panel-resize")).toHaveCount(0);
    await narrowBackAndExpectReveal(page, K.id, before);
  });

  test("B6c: the context menu's Open pipeline records a departure", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const F2 = await createFinishedTask(backend, profileId, "Menu F2");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, F2.id)).toBeVisible();
    const before = await scrollCardToRightEdge(page, F2.id);

    await boardCardById(page, F2.id).getByText(F2.title, { exact: true }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open pipeline" }).click();
    await narrowBackAndExpectReveal(page, F2.id, before);
  });

  test("B6 control: leaving through the Pipelines button records no departure", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const F = await createFinishedTask(backend, profileId, "Control F");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, F.id)).toBeVisible();
    const before = await scrollCardToRightEdge(page, F.id);

    await openPipelinesPage(page);
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.getByTestId("pipelines-back").click();
    await expectBoardAt(page, before);
    expect((await cardVisibility(page, F.id)).state, "the card stays where it was: no reveal").toBe("none");
    await page.setViewportSize(DEFAULT_VIEWPORT);
  });

  // -------------------------------------------------------------------------
  // B7 — a return inside the board's exit animation forgets the departure
  // -------------------------------------------------------------------------

  /**
   * App.tsx's fast-return guard. A card leave records the card as the
   * departure as soon as the navigation commits. Escape inside the board's
   * 0.18 s exit brings the "board" key back while it is still exiting, so
   * `<AnimatePresence mode="wait">` reuses the same element. Its callback ref
   * never re-runs, so the record is never consumed. Without the guard, the
   * stale record would reveal the card on some LATER, unrelated return —
   * here Pipelines → Back.
   *
   * The leave and the Escape happen in one `page.evaluate`: a click on the
   * card root, then Escape on the next task. React flushes a discrete
   * click's render, and its effects, before that task runs, so the run
   * view's Escape listener is attached by then. The in-page snapshot and the
   * element-identity check prove the fast path itself ran. A remount would
   * go through the ordinary restore instead, which B3 already covers.
   *
   * This relies on `motion/react`'s AnimatePresence re-entering a still-
   * exiting child when its key returns, instead of remounting it. If a
   * `motion` upgrade changes that, B7 reads "remounted" and goes red even
   * though the product is still correct (the ordinary restore then consumes
   * the record). Re-check this behavior before treating that as a product
   * bug.
   */
  test("B7: Escape inside the board's exit animation forgets the card departure", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const { profileId } = await seedBase(backend);
    const F = await createFinishedTask(backend, profileId, "Fast F");

    await gotoApp(page, backend.bootBase);
    await expectBoardOverflow(page);
    await expect(boardCardById(page, F.id)).toBeVisible();
    const before = await scrollCardToRightEdge(page, F.id);

    // Leave from the card root (TaskCard's own onClick → openTaskFromBoard,
    // fromBoardCard), then Escape on the next task, while the board exits.
    const atEscape = await page.evaluate(
      (id) =>
        new Promise<{ boardMounted: boolean; runViewMounted: boolean }>((resolve) => {
          const board = document.querySelector(".kanban-scroll");
          (window as unknown as { __e2eBoardBefore?: Element | null }).__e2eBoardBefore = board;
          const card = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
          if (!board || !card) throw new Error("board scroller or card not found");
          card.click();
          window.setTimeout(() => {
            const snapshot = {
              boardMounted: board.isConnected,
              runViewMounted: document.querySelector('[data-testid="pipeline-run-view"]') !== null,
            };
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            resolve(snapshot);
          }, 0);
        }),
      F.id,
    );
    expect(atEscape, "Escape must land while the leaving board is still mounted").toEqual({
      boardMounted: true,
      runViewMounted: false,
    });

    // The board comes back as the SAME element and finishes its re-entry.
    // If the Escape had been missed, the board would finish exiting and the
    // run view would mount instead ("gone"). A remount would read "remounted".
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const prev = (window as unknown as { __e2eBoardBefore?: Element | null }).__e2eBoardBefore;
            const now = document.querySelector(".kanban-scroll");
            if (!now) return "gone";
            if (now !== prev) return "remounted";
            for (let el: Element | null = now; el; el = el.parentElement) {
              if (getComputedStyle(el).opacity !== "1") return "animating";
            }
            return "reused";
          }),
        { message: "the board element is reused, not remounted" },
      )
      .toBe("reused");
    await expect(page.getByTestId("pipeline-run-view")).toHaveCount(0);
    await expectBoardAt(page, before);

    // A later, unrelated return must not act on the stale departure. The
    // narrower viewport puts the card entirely out of view, so a leftover
    // record would scroll to it.
    await openPipelinesPage(page);
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.getByTestId("pipelines-back").click();
    await expectBoardAt(page, before);
    expect((await cardVisibility(page, F.id)).state, "the departure was forgotten: no reveal").toBe("none");
    await page.setViewportSize(DEFAULT_VIEWPORT);
  });
});
