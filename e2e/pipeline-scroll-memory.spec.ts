import { randomUUID } from "node:crypto";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import {
  FAKE_CLAUDE_HANDOFF_PROMPT_MARKER,
  boardCardById,
  boardScroller,
  createPipelineRest,
  createPipelineTaskRest,
  createProfileRest,
  gotoAppSubscribed,
  makeStep,
  readScroll,
  restartPipelineRest,
  retryPipelineRest,
  scrollRange,
  scrollToOffsets,
  startTaskRest,
  waitForPipelineRest,
} from "./scroll-memory-helpers";

/**
 * E2e coverage for the Pipelines list and the run view's side panel
 * remembering their scroll position / expansion state across navigation
 * (docs/plans/board-scroll-position.md §5 E2: scenarios L1, S1, S2).
 *
 *  - L1: the Pipelines list keeps ONE vertical offset for the session.
 *  - S1: the run view's side panel restores its exact offset (plus the Goal
 *    toggle and expanded history rows) per pipeline task id when the run is
 *    unchanged since the user left.
 *  - S2: a changed run starts the panel at the top (Goal + expansion kept);
 *    a Restart collapses every history row (rows are keyed by run
 *    generation + seq).
 *
 * Pipelines are seeded over REST (`e2e/scroll-memory-helpers.ts`) with the
 * fake claude driver; every test uses its own `freshBackend`.
 */

const CYCLE_STEP_CAP = 14;
const CYCLE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Spec-local helpers
// ---------------------------------------------------------------------------

function pipelinesButton(page: Page): Locator {
  return page.getByTestId("pipelines-button");
}

function listScroller(page: Page): Locator {
  return page.getByTestId("pipelines-list-scroll");
}

function sidePanel(page: Page): Locator {
  return page.getByTestId("pipeline-run-side-panel");
}

function historyRows(page: Page): Locator {
  return page.locator('[data-testid="pipeline-run-history-row"]');
}

/** The history row whose button text starts with `#<seq> ` (newest-first list). */
function historyRowBySeq(page: Page, seq: number): Locator {
  return historyRows(page).filter({ hasText: new RegExp(`^#${seq} `) });
}

async function listTop(page: Page): Promise<number> {
  return (await readScroll(listScroller(page))).top;
}

async function panelTop(page: Page): Promise<number> {
  return (await readScroll(sidePanel(page))).top;
}

/** Opens the Pipelines list and waits for its scroller and the first row. */
async function openPipelinesList(page: Page): Promise<void> {
  await pipelinesButton(page).click();
  await expect(listScroller(page)).toBeVisible();
  await expect(page.getByTestId("pipelines-row").first()).toBeVisible();
}

/**
 * The first Pipelines-list row that lies entirely inside the list scroller's
 * client box, or throws. Clicking it can't make Playwright scroll the list.
 */
async function fullyVisibleRow(page: Page): Promise<Locator> {
  const rows = page.getByTestId("pipelines-row");
  const idx = await listScroller(page).evaluate((scroller) => {
    const sr = scroller.getBoundingClientRect();
    const view = {
      top: sr.top + scroller.clientTop,
      bottom: sr.top + scroller.clientTop + scroller.clientHeight,
    };
    const list = Array.from(scroller.querySelectorAll('[data-testid="pipelines-row"]'));
    return list.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= view.top && r.bottom <= view.bottom;
    });
  });
  if (idx < 0) throw new Error("no Pipelines-list row is fully visible");
  return rows.nth(idx);
}

/** Edit a fully visible row, wait for the editor, then come back with its Back button. */
async function editorRoundTrip(page: Page): Promise<void> {
  const row = await fullyVisibleRow(page);
  // A real mouse click at the button's centre: Locator.click() may run its own
  // scroll-into-view retry on the list, which would move the very offset
  // under test. The row is fully visible, so the button is hit as it stands.
  const edit = row.getByTestId("pipelines-edit");
  const box = await edit.boundingBox();
  if (!box) throw new Error("pipelines-edit has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(await edit.evaluate((el, pt) => el.contains(document.elementFromPoint(pt.x, pt.y)), { x, y })).toBe(true);
  await page.mouse.click(x, y);
  const back = page.getByTestId("pipeline-back");
  await expect(back).toBeVisible();
  await back.click();
  await expect(listScroller(page)).toBeVisible();
  await expect(page.getByTestId("pipelines-row").first()).toBeVisible();
}

/** Opens a pipeline task's run view by clicking its board card's title. */
async function openRunViewFromCard(page: Page, task: { id: string; title: string }): Promise<void> {
  await boardCardById(page, task.id).getByText(task.title, { exact: true }).click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
  await expect(sidePanel(page)).toBeVisible();
}

/** Run-view Back button, then wait until the board's scroller is mounted again. */
async function backToBoardViaButton(page: Page): Promise<void> {
  await page.getByTestId("pipeline-run-back").click();
  await expect(boardScroller(page)).toBeVisible();
}

/** Opens `task`'s run view and waits for `rows` history rows to render. */
async function openRunViewWithRows(
  page: Page,
  task: { id: string; title: string },
  rows: number,
): Promise<void> {
  await openRunViewFromCard(page, task);
  await expect(historyRows(page)).toHaveCount(rows, { timeout: 15_000 });
}

/** Asserts the side panel overflows enough to scroll, and returns ~60% of its max. */
async function panelTargetOffset(page: Page): Promise<number> {
  const range = await scrollRange(sidePanel(page));
  expect(range.maxTop, "side panel must overflow by > 150px").toBeGreaterThan(150);
  return Math.round(range.maxTop * 0.6);
}

/** Opens the Goal toggle and expands history row `#3`, asserting both took effect. */
async function openGoalAndExpandRow3(page: Page): Promise<void> {
  await page.getByTestId("pipeline-run-goal-toggle").click();
  await expect(page.getByTestId("pipeline-run-goal")).toBeVisible();
  const row3 = historyRowBySeq(page, 3);
  await expect(row3).toHaveCount(1);
  await row3.getByRole("button").first().click();
  await expect(row3.getByTestId("pipeline-run-history-handoff")).toBeVisible();
}

interface CycleSeed {
  pipelineId: string;
  newTask: (title: string) => Promise<{ id: string; title: string }>;
}

/** Cycle seed (plan §5): steps A<->B, `maxSteps` 14, fake handoff `:done` prompt. */
async function seedCycle(backend: E2EBackend): Promise<CycleSeed> {
  const profileId = await createProfileRest(backend, `Cycle profile ${randomUUID().slice(0, 8)}`);
  const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
  const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
  const pipelineId = await createPipelineRest(
    backend,
    "Cycle",
    [A, B],
    [
      { from: A.id, to: B.id },
      { from: B.id, to: A.id },
    ],
    CYCLE_STEP_CAP,
  );
  return {
    pipelineId,
    newTask: async (title) => {
      const task = await createPipelineTaskRest(
        backend,
        title,
        pipelineId,
        `Cycle. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
      );
      return { id: task.id, title };
    },
  };
}

/** Starts the task and waits until it blocks at the step cap with 14 history rows. */
async function runToCap(backend: E2EBackend, id: string): Promise<void> {
  await startTaskRest(backend, id);
  await waitForPipelineRest(
    backend,
    id,
    (t) =>
      t.pipelineRun?.status === "blocked" && t.pipelineRun.history.length === CYCLE_STEP_CAP,
    CYCLE_TIMEOUT,
  );
}

// ---------------------------------------------------------------------------
// L1 — Pipelines list
// ---------------------------------------------------------------------------

test.describe("pipeline scroll memory", () => {
  test("L1: the Pipelines list restores its offset after the editor, Back, and Escape", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "List profile");
    for (let i = 1; i <= 16; i++) {
      const step = makeStep({ id: randomUUID(), name: "Only", agentProfileId: profileId });
      await createPipelineRest(backend, `List pipeline ${String(i).padStart(2, "0")}`, [step], []);
    }

    await gotoAppSubscribed(page, backend);
    await openPipelinesList(page);
    await expect(page.getByTestId("pipelines-row")).toHaveCount(16);

    const list = listScroller(page);
    const range = await scrollRange(list);
    expect(range.maxTop, "Pipelines list must overflow by > 200px").toBeGreaterThan(200);
    const S = (await scrollToOffsets(list, { top: Math.round(range.maxTop * 0.6) })).top;
    expect(S).toBeGreaterThan(0);

    // 3. editor round trip (Edit -> editor Back) lands on the list at S.
    await editorRoundTrip(page);
    await expect.poll(() => listTop(page)).toBe(S);

    // 4. Pipelines Back to the board, then Pipelines again.
    await page.getByTestId("pipelines-back").click();
    await expect(boardScroller(page)).toBeVisible();
    await openPipelinesList(page);
    await expect.poll(() => listTop(page)).toBe(S);

    // 5. Escape to the board, then Pipelines again.
    await page.keyboard.press("Escape");
    await expect(boardScroller(page)).toBeVisible();
    await openPipelinesList(page);
    await expect.poll(() => listTop(page)).toBe(S);

    // 6. A different offset replaces the remembered one.
    const range2 = await scrollRange(list);
    const target2 = S > range2.maxTop / 2 ? Math.round(range2.maxTop * 0.25) : Math.round(range2.maxTop * 0.9);
    const S2 = (await scrollToOffsets(list, { top: target2 })).top;
    expect(S2).not.toBe(S);
    await editorRoundTrip(page);
    await expect.poll(() => listTop(page)).toBe(S2);
  });

  // -------------------------------------------------------------------------
  // S1 — side panel, unchanged run and per-task separation
  // -------------------------------------------------------------------------

  test("S1: the side panel restores offset, Goal and an expanded row per task when the run is unchanged", async ({
    page,
    freshBackend,
  }) => {
    test.setTimeout(150_000);
    const backend = freshBackend;
    const seed = await seedCycle(backend);
    const T1 = await seed.newTask(`Cycle one ${randomUUID().slice(0, 8)}`);
    const T2 = await seed.newTask(`Cycle two ${randomUUID().slice(0, 8)}`);
    await runToCap(backend, T1.id);
    await runToCap(backend, T2.id);

    await gotoAppSubscribed(page, backend);

    // 1-4. Open T1, Goal + row #3, scroll to ~60%.
    await openRunViewWithRows(page, T1, CYCLE_STEP_CAP);
    await openGoalAndExpandRow3(page);
    const S = (await scrollToOffsets(sidePanel(page), { top: await panelTargetOffset(page) })).top;
    expect(S).toBeGreaterThan(0);

    // 5. Another task starts clean: top, no Goal, no expanded row.
    await backToBoardViaButton(page);
    await openRunViewWithRows(page, T2, CYCLE_STEP_CAP);
    expect(await panelTop(page)).toBe(0);
    await expect(page.getByTestId("pipeline-run-goal")).toHaveCount(0);
    await expect(page.getByTestId("pipeline-run-history-handoff")).toHaveCount(0);

    // 6. Back to T1: exact offset, Goal and row #3 restored.
    await backToBoardViaButton(page);
    await openRunViewWithRows(page, T1, CYCLE_STEP_CAP);
    await expect.poll(() => panelTop(page)).toBe(S);
    await expect(page.getByTestId("pipeline-run-goal")).toBeVisible();
    await expect(historyRowBySeq(page, 3).getByTestId("pipeline-run-history-handoff")).toBeVisible();

    // 7. Escape to the board, reopen T1: still S.
    await page.keyboard.press("Escape");
    await expect(boardScroller(page)).toBeVisible();
    await openRunViewWithRows(page, T1, CYCLE_STEP_CAP);
    await expect.poll(() => panelTop(page)).toBe(S);
    await expect(page.getByTestId("pipeline-run-goal")).toBeVisible();
    await expect(historyRowBySeq(page, 3).getByTestId("pipeline-run-history-handoff")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // S2 — changed run starts at the top; Restart collapses rows
  // -------------------------------------------------------------------------

  test("S2: a changed run starts at the top (Goal and row kept); Restart collapses every row", async ({
    page,
    freshBackend,
  }) => {
    test.setTimeout(180_000);
    const backend = freshBackend;
    const seed = await seedCycle(backend);
    const T = await seed.newTask(`Cycle changed ${randomUUID().slice(0, 8)}`);
    await runToCap(backend, T.id);
    const firstStartedAt = (await waitForPipelineRest(backend, T.id, () => true)).pipelineRun?.startedAt;
    expect(firstStartedAt).not.toBeNull();

    await gotoAppSubscribed(page, backend);

    // 1. Goal, row #3, scroll to S > 0, Back.
    await openRunViewWithRows(page, T, CYCLE_STEP_CAP);
    await openGoalAndExpandRow3(page);
    const S = (await scrollToOffsets(sidePanel(page), { top: await panelTargetOffset(page) })).top;
    expect(S).toBeGreaterThan(0);
    await backToBoardViaButton(page);

    // 2. Retry extends the cap once: another 14 rows, blocked again.
    await retryPipelineRest(backend, T.id);
    await waitForPipelineRest(
      backend,
      T.id,
      (t) => t.pipelineRun?.status === "blocked" && t.pipelineRun.history.length === CYCLE_STEP_CAP * 2,
      CYCLE_TIMEOUT,
    );

    // 3. The run changed since the user left: top, but Goal and row #3 stay.
    await openRunViewWithRows(page, T, CYCLE_STEP_CAP * 2);
    await expect.poll(() => panelTop(page)).toBe(0);
    await expect(page.getByTestId("pipeline-run-goal")).toBeVisible();
    await expect(historyRowBySeq(page, 3).getByTestId("pipeline-run-history-handoff")).toBeVisible();

    // 4. Scroll to S2 > 0, then Back.
    const range = await scrollRange(sidePanel(page));
    expect(range.maxTop, "side panel must overflow by > 150px").toBeGreaterThan(150);
    const S2 = (await scrollToOffsets(sidePanel(page), { top: Math.round(range.maxTop * 0.6) })).top;
    expect(S2).toBeGreaterThan(0);
    await backToBoardViaButton(page);

    // 5. Restart: a fresh run (new startedAt), blocked at the cap again.
    await restartPipelineRest(backend, T.id);
    const restarted = await waitForPipelineRest(
      backend,
      T.id,
      (t) =>
        t.pipelineRun?.status === "blocked" &&
        t.pipelineRun.history.length === CYCLE_STEP_CAP &&
        t.pipelineRun.startedAt !== firstStartedAt,
      CYCLE_TIMEOUT,
    );
    expect(restarted.pipelineRun?.startedAt).not.toBe(firstStartedAt);

    // 6. Reopen: top, Goal still open (per task), every row collapsed.
    await openRunViewWithRows(page, T, CYCLE_STEP_CAP);
    await expect.poll(() => panelTop(page)).toBe(0);
    await expect(page.getByTestId("pipeline-run-goal")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-history-handoff")).toHaveCount(0);
  });
});
