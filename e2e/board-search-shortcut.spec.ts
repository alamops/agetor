import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

/**
 * E2E coverage for the Cmd/Ctrl+F board-search-focus feature
 * (docs/plans/cmd-f-board-search-focus.md, TT2). Pressing the platform find
 * chord — Meta+F on Mac, Ctrl+F elsewhere, `isFindShortcut` in
 * `src/mainview/lib/find-shortcut.ts` — while no task details panel is open
 * focuses the kanban board's free-text search box
 * (`src/mainview/components/kanban/KanbanFilters.tsx`, `aria-label="Search
 * tasks"`) and selects its contents; while a task's panel is open, the
 * panel's own Cmd/Ctrl+F (`src/mainview/components/kanban/RunPanel.tsx`
 * ~line 1637) owns the chord instead and opens its message-search bar
 * (`aria-label="Search messages"`); modal dialogs and non-escape-only
 * popovers outrank both, per `FIND_SHORTCUT_BLOCKING_LAYERS`. See
 * `App.tsx` ~line 640 for the board-side listener.
 *
 * Modeled on `e2e/font-size.spec.ts`'s harness (real Chromium against the
 * real webview + a per-worker headless Bun backend, `e2e/fixtures.ts`) and
 * `e2e/run-panel-header.spec.ts`'s task-creation/panel-opening idiom (task
 * helpers aren't shared across spec files, so `createAndStartFakeClaudeTask`
 * / `runPanel` / `openTask` are copied locally here). Assertions are
 * `document.activeElement` / focus / selection-range based rather than
 * screenshots — this is a keyboard-focus wiring test, and the DOM state is
 * exactly what the feature contract promises.
 *
 * Two gotchas from the team's knowledge base, both load-bearing here:
 *
 * 1. RunPanel's own Cmd/Ctrl+F listener is attached only once the panel's
 *    `open` state flips true, which lags task-selection by one
 *    `requestAnimationFrame` — the composer textarea being visible is NOT
 *    proof the listener is live. `openTask` below waits for the panel
 *    `<aside>` to carry `translate-x-0` (the class `open` drives) before any
 *    chord is pressed against it.
 * 2. The panel must never be closed with `keyboard.press("Escape")` — that
 *    key is claimed by several of the panel's own layers first. Close via
 *    the backdrop's "Close task panel" button and wait for the `<aside>` to
 *    carry `translate-x-full` before pressing the chord again.
 *
 * Serial: task (c) creates a real task via the API and leaves it on the
 * board for the remainder of the file/worker (same convention as every
 * sibling spec that creates fixture tasks) — harmless to the later tests,
 * which never assume an empty board.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", a plain non-git temp dir as workdir) and
 *  start it against the fake claude driver — same idiom as
 *  `e2e/run-panel-header.spec.ts`'s helper of the same name. */
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

/** The New Task sidebar — always the first `<aside>` in DOM order. */
function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

/** The run panel's slide-over `<aside>` — the later one in DOM order once a
 *  task has been opened (mirrors `e2e/run-panel-header.spec.ts`). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the panel to have
 *  actually finished its open transition — `translate-x-0` is what proves
 *  RunPanel's own Cmd/Ctrl+F listener (rAF-gated on `open`) is attached; the
 *  composer textarea rendering is not sufficient proof (knowledge gotcha
 *  #1 above). */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  await expect(panel).toHaveClass(/translate-x-0/);
  return panel;
}

/** Closes the run panel via the backdrop button — never `Escape`, which
 *  several of the panel's own layers claim first (knowledge gotcha #2) — and
 *  waits for the exit transition to have actually started before returning,
 *  so a chord pressed right after this call is guaranteed to land while the
 *  board (not the panel) owns it. The backdrop button is `fixed inset-0`
 *  (covers the whole viewport), so Playwright's default click point (the
 *  element's bounding-box center) can land underneath the panel `<aside>`
 *  itself — which sits on top in stacking order and intercepts the click —
 *  on a default-width (720px) panel over a ~1280px-wide Chromium viewport.
 *  Clicking a corner instead of the center keeps the click on backdrop that
 *  is actually uncovered, matching what a real user click there would hit. */
async function closeTaskPanel(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Close task panel" })
    .click({ position: { x: 10, y: 10 } });
  await expect(runPanel(page)).toHaveClass(/translate-x-full/);
}

/** Same in-page Meta/Control sniff the app itself uses (`isMacPlatform` in
 *  `src/mainview/lib/platform.ts`), evaluated in-page so the correct
 *  modifier is pressed regardless of the host platform Chromium reports —
 *  copied from `e2e/font-size.spec.ts`'s helper of the same name (not
 *  exported, so every spec that needs it keeps its own copy). */
async function shortcutModifier(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform || navigator.userAgent || ""));
  return isMac ? "Meta" : "Control";
}

async function pressFindChord(page: Page, mod: "Meta" | "Control"): Promise<void> {
  await page.keyboard.press(`${mod}+KeyF`);
}

/** The board's free-text filter box (`KanbanFilters.tsx`) — located by its
 *  accessible name, which also doubles as the stable e2e locator the plan
 *  calls for. */
function boardSearchBox(page: Page): Locator {
  return page.getByRole("textbox", { name: "Search tasks" });
}

/** `[selectionStart, selectionEnd]` of whatever element currently has
 *  focus — used to prove the chord not only focuses the board box but also
 *  selects its full existing contents. */
function activeElementSelectionRange(page: Page): Promise<[number | null, number | null]> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement;
    return [el.selectionStart, el.selectionEnd];
  });
}

test.describe("board search: Cmd/Ctrl+F focus", () => {
  test("(a) bare board: the chord focuses the search box and selects its existing text", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const box = boardSearchBox(page);

    await box.fill("hello");
    // Drop focus off the box onto neutral board chrome before pressing the
    // chord, so the assertion below proves the chord itself re-focuses it
    // rather than it having never lost focus.
    await page.locator("main").click();
    await expect(box).not.toBeFocused();

    const mod = await shortcutModifier(page);
    await pressFindChord(page, mod);

    await expect(box).toBeFocused();
    expect(await activeElementSelectionRange(page)).toEqual([0, 5]);
    await expect(box).toHaveValue("hello");
  });

  test("(b) chord from the New Task prompt textarea still jumps to the board box", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const textarea = newTaskForm(page).getByTestId("prompt-textarea");

    await textarea.click();
    await expect(textarea).toBeFocused();

    const mod = await shortcutModifier(page);
    await pressFindChord(page, mod);

    await expect(boardSearchBox(page)).toBeFocused();
  });

  test("(c) an open task panel owns the chord; closing it hands the chord back to the board", async ({
    page,
    request,
    backend,
  }) => {
    const prompt = `board-search-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, prompt);
    const mod = await shortcutModifier(page);

    await pressFindChord(page, mod);

    const messageSearchInput = panel.getByRole("textbox", { name: "Search messages" });
    await expect(messageSearchInput).toBeVisible();
    await expect(messageSearchInput).toBeFocused();
    await expect(boardSearchBox(page)).not.toBeFocused();

    await closeTaskPanel(page);

    await pressFindChord(page, mod);
    await expect(boardSearchBox(page)).toBeFocused();
  });

  test("(d) an open modal dialog blocks the chord on the board", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);
    const mod = await shortcutModifier(page);

    await pressFindChord(page, mod);

    await expect(boardSearchBox(page)).not.toBeFocused();
    await expect(dialog).toBeVisible();

    // Dialogs close on Escape (`ui/dialog.tsx`) — distinct from the run
    // panel's own Escape rules (knowledge gotcha #2 above), which don't
    // apply here since no task panel is open.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("(e) Escape blurs the focused board box but keeps the typed query", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const box = boardSearchBox(page);
    const mod = await shortcutModifier(page);

    await pressFindChord(page, mod);
    await expect(box).toBeFocused();

    await box.fill("keep me");
    await page.keyboard.press("Escape");

    await expect(box).not.toBeFocused();
    await expect(box).toHaveValue("keep me");
  });
});
