import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E regression coverage for
 * `docs/plans/task-details-blank-while-session-restores.md` (E1): opening a
 * different task's details while another task's claude session is mid-
 * restore (a slow `claude --resume` spawn) must render the new task's
 * transcript within ~1-2s, independent of how long the other task's spawn
 * takes — not the pre-fix behavior, where the held `POST /runs/:id/input`
 * (or `/tasks/:id/start`) starved the webview's shared per-host connection
 * budget and the second task's details panel sat blank until the first
 * task's spawn settled.
 *
 * The seam: `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS` (src/bun/agents.ts) makes
 * the in-process fake claude-code driver's `spawnAgent` call itself take
 * that long to resolve, reproducing a slow `spawnClaudeViaTmux` without
 * touching tmux. `SPAWN_RESPONSE_BUDGET_MS` (src/shared/types.ts) is 1500ms,
 * so with a 6000ms delay `POST /runs/:id/input` and `POST /tasks/:id/start`
 * both return well before the underlying spawn settles, carrying
 * `pending: true` — the run row, the `running` column flip, and the initial
 * `user` event are already persisted by then, which is what lets the panel
 * render regardless.
 *
 * This delay applies to EVERY claude-code fake spawn on the backend it's
 * set on (fresh start and resume alike — `spawnAgent`'s fake branch doesn't
 * distinguish), and env vars are fixed for the lifetime of a spawned
 * backend process, so there's no way to enable the delay only for the
 * follow-up send while leaving the two tasks' initial starts fast. Both
 * tests that need it below (T1, T2) therefore pay the 6s delay on every
 * spawn they trigger, including the initial starts, and poll with generous
 * timeouts — this is the documented fallback in the work order, not a
 * workaround for a fixtures.ts limitation.
 *
 * Uses `freshBackend` (test-scoped, its own headless backend process) via
 * the additive `backendEnv` fixture option added to `e2e/fixtures.ts` for
 * this spec, since the delay must be set as an env var on a dedicated
 * backend process and must not leak into other specs sharing the
 * worker-scoped `backend` fixture.
 */

test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "6000" } });

interface TaskRow {
  id: string;
  title: string;
}

interface TaskDetail extends TaskRow {
  column: string;
  runId: string | null;
}

interface RunRow {
  id: string;
  status: string;
}

interface SendInputPendingResult {
  delivered: true;
  runId: string;
  pending?: true;
}

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Create (isolation "none", a plain temp dir workdir — the fake driver
 *  never touches the filesystem) and start a claude-code task in one call.
 *  `title` is also used as the prompt, so the fake driver's generic
 *  fallback echoes it back as `fake response to: <title>` — a stable,
 *  per-task-unique string to assert on (mirrors `e2e/run-panel-header
 *  .spec.ts`'s `createAndStartFakeClaudeTask`). */
async function createAndStartFakeClaudeTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = authHeaders(backend);
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<TaskDetail> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: authHeaders(backend) });
  expect(res.ok(), `GET /tasks/${taskId} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskDetail;
}

/** `GET /tasks/:id/runs` is newest-first, so `runs[0]` is always the latest
 *  run — mirrors `e2e/fx-recovery.spec.ts`'s identical helper. */
async function getRuns(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<RunRow[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: authHeaders(backend) });
  expect(res.ok(), `GET /tasks/${taskId}/runs -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as RunRow[];
}

async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  column: string,
  timeout = 20_000,
): Promise<void> {
  await expect(async () => {
    const task = await getTask(request, backend, taskId);
    expect(task.column, `task ${taskId} column`).toBe(column);
  }).toPass({ timeout });
}

/** Poll until the task has at least `minRuns` runs AND the newest one has
 *  settled to `status`. */
async function waitForRunSettled(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  minRuns: number,
  status: string,
  timeout = 20_000,
): Promise<RunRow[]> {
  let runs: RunRow[] = [];
  await expect(async () => {
    runs = await getRuns(request, backend, taskId);
    expect(runs.length, `task ${taskId} run count`).toBeGreaterThanOrEqual(minRuns);
    expect(runs[0]?.status, `task ${taskId} newest run status`).toBe(status);
  }).toPass({ timeout });
  return runs;
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX. Mirrors
 *  every other spec's identical helper (e.g. `e2e/fx-recovery.spec.ts`). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the composer textarea
 *  to mount as proof the panel is open. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  `TaskCard.tsx`'s root `<Card>` carries `cursor-grab` (drag-handle
 *  styling unique to board cards), so this can't accidentally match text
 *  inside the run panel or a menu. Mirrors `e2e/task-context-menu.spec.ts`'s
 *  identical helper. */
function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/**
 * Open a DIFFERENT task's details while the current one's panel is still
 * showing — the actual regression scenario, and NOT reachable via a plain
 * card click: `RunPanel.tsx` renders a `fixed inset-0 z-30` backdrop button
 * ("Close task panel") the entire time a panel is open, which sits above
 * every board card (cards carry no explicit z-index) and intercepts any
 * pointer event aimed at them — confirmed live (a plain `.click()` on
 * another card times out with "<button aria-label=\"Close task panel\">
 * intercepts pointer events"). In the real app this is why
 * `e2e/fx-interactions.spec.ts` closes a panel before opening the next task
 * by card click.
 *
 * But the app DOES support switching directly (task prop A→B with no
 * intervening `null`, so `RunPanelBody` never unmounts — see
 * `RunPanel.tsx`'s `mountedTask`/`[task.id]` effect and CLAUDE.md's
 * "RunPanel is ONE long-lived instance" note): the task context menu's
 * "Open details" action calls `setSelected(t)` directly
 * (`App.tsx`'s `runTaskMenuAction`, case `"open"`), and that menu portals to
 * `document.body` at `z-50` (`context-menu.tsx`) — above the backdrop and
 * the aside — so it, and the card that opens it, aren't blocked by the
 * overlay. `TaskCard.tsx` explicitly supports invoking it from the
 * keyboard too (Shift+F10 / the menu key report `clientX/Y = 0,0`, which
 * `TaskCard` anchors to the card's own bounding box) — this helper
 * reproduces exactly that: `dispatchEvent` fires a real `contextmenu` DOM
 * event straight at the card node (bypassing Playwright's own
 * point-based "is this element topmost here" actionability check, which
 * would otherwise hit the same backdrop-interception problem a real
 * `{ button: "right" }` click does), with `clientX`/`clientY` left at 0 so
 * `TaskCard`'s own `fromKeyboard` branch fires — the same code path a
 * keyboard user's Shift+F10 takes in production.
 */
async function openTaskWhilePanelOpen(page: Page, title: string): Promise<void> {
  await taskCard(page, title).dispatchEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  const openItem = page.locator('[data-testid="task-context-menu-open"]');
  await expect(openItem).toBeVisible();
  await openItem.click();
}

test.describe("task details stay responsive while another task's session restores", () => {
  test("switching to task B while task A's follow-up is spawning shows B's own transcript immediately, and A's follow-up still lands", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(120_000);

    const suffix = randomUUID();
    const titleA = `switch-restore-a-${suffix}`;
    const titleB = `switch-restore-b-${suffix}`;

    // Both initial starts pay the 6s fake-spawn delay too (see the file
    // doc comment) — `createAndStartFakeClaudeTask`'s own POST returns
    // quickly (bounded by SPAWN_RESPONSE_BUDGET_MS), but the task doesn't
    // reach `review` until the detached spawn actually settles and the
    // fake driver's turn completes, hence the generous waits below.
    const taskA = await createAndStartFakeClaudeTask(request, freshBackend, titleA);
    const taskB = await createAndStartFakeClaudeTask(request, freshBackend, titleB);

    await waitForColumn(request, freshBackend, taskA.id, "review", 20_000);
    await waitForColumn(request, freshBackend, taskB.id, "review", 20_000);

    await gotoApp(page, freshBackend.bootBase);

    const panel = await openTask(page, titleA);
    await expect(panel.getByText(`fake response to: ${titleA}`, { exact: true })).toBeVisible();

    const followUpText = `follow-up-during-restore-${suffix}`;
    const textareaA = panel.getByTestId("send-textarea");
    await textareaA.fill(followUpText);
    // Enter (no Shift) sends — mirrors the composer's own keydown handler.
    // This POSTs /runs/<A's run>/input, which the backend bounds at
    // SPAWN_RESPONSE_BUDGET_MS (1.5s) and returns `pending: true` well
    // before the 6s fake spawn actually settles. We deliberately do NOT
    // await that network round-trip here — the whole point of this test is
    // that switching tasks doesn't have to wait for it.
    await textareaA.press("Enter");

    // Immediately (no wait) open task B's details — via the task context
    // menu's "Open details" (see `openTaskWhilePanelOpen`'s doc comment for
    // why this, not a plain card click, is the way to switch directly while
    // A's panel is still showing).
    await openTaskWhilePanelOpen(page, titleB);

    // Within ~2s, B's own panel content is up — not stuck on A's stream,
    // not showing A's loading skeleton forever, and not carrying A's
    // in-flight `sending` state.
    await expect(panel.getByTestId("transcript-loading")).toHaveCount(0, { timeout: 2_000 });
    await expect(panel.getByText(`fake response to: ${titleB}`, { exact: true })).toBeVisible({
      timeout: 2_000,
    });
    // A's follow-up text must not have bled into B's transcript.
    await expect(panel.getByText(followUpText, { exact: true })).toHaveCount(0);
    // B's composer is live, not stuck disabled by A's `sending` flag (the
    // per-task reset effect — RunPanel.tsx's `[task.id]` effect — is what
    // this pins).
    const textareaB = panel.getByTestId("send-textarea");
    await expect(textareaB).toBeEnabled({ timeout: 2_000 });

    // Server-side ground truth: B has exactly its own single run (the
    // follow-up went to A, never touched B).
    const runsB = await getRuns(request, freshBackend, taskB.id);
    expect(runsB.length).toBe(1);

    // A's follow-up still lands: a second run appears and settles
    // `succeeded` once the detached 6s spawn finishes.
    const runsA = await waitForRunSettled(request, freshBackend, taskA.id, 2, "succeeded", 20_000);
    expect(runsA.length).toBeGreaterThanOrEqual(2);
  });

  test("POST /runs/:id/input returns bounded (pending: true) while the spawn keeps running, and the new run still settles", async ({
    request,
    freshBackend,
  }) => {
    test.setTimeout(60_000);

    const suffix = randomUUID();
    const title = `bounded-response-${suffix}`;
    const task = await createAndStartFakeClaudeTask(request, freshBackend, title);
    await waitForColumn(request, freshBackend, task.id, "review", 20_000);

    const detail = await getTask(request, freshBackend, task.id);
    expect(detail.runId, "task should carry its last run id in review").toBeTruthy();
    const firstRunId = detail.runId as string;

    const followUpText = `bounded-follow-up-${suffix}`;
    const startedAt = Date.now();
    const res = await request.post(`${freshBackend.apiBase}/runs/${firstRunId}/input`, {
      headers: authHeaders(freshBackend),
      data: { line: followUpText },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(res.ok(), `POST /runs/${firstRunId}/input -> ${res.status()}: ${await res.text()}`).toBeTruthy();
    // Bounded well under the full 6s spawn delay — SPAWN_RESPONSE_BUDGET_MS
    // is 1.5s, budget of 3s leaves headroom for CI/load without weakening
    // the assertion (a regression here would take ~6s, not ~1.5-3s).
    expect(elapsedMs, `POST /runs/${firstRunId}/input took ${elapsedMs}ms`).toBeLessThan(3_000);

    const body = (await res.json()) as SendInputPendingResult;
    expect(body.delivered).toBe(true);
    expect(body.pending).toBe(true);
    expect(typeof body.runId).toBe("string");
    expect(body.runId).not.toBe(firstRunId);

    // The detached spawn keeps running and the new run settles.
    await waitForRunSettled(request, freshBackend, task.id, 2, "succeeded", 20_000);
  });
});

test.describe("terminals section is scoped per task", () => {
  /** The `<details>`/`<summary>` disclosure `TerminalsSection` renders
   *  (RunPanel.tsx) — no dedicated test id. Root-caused live (via a debug
   *  dump of `allInnerTexts()`): the summary's text renders through a
   *  `uppercase` Tailwind class, and Playwright's text-matching reads the
   *  RENDERED text — i.e. "TERMINAL", not the DOM's literal "Terminal" — so
   *  a case-sensitive match against "Terminal" never matches. A direct
   *  case-insensitive substring `hasText` filter on the `<details>` itself
   *  (not a `.filter({ has: <nested summary locator> })` combinator, which
   *  — even fixed for case — never actually matched live here, for reasons
   *  that didn't repay further digging) is what reliably works: `hasText`
   *  matches an element's full descendant-inclusive text, so `/terminal/i`
   *  finds the one `<details>` whose `<summary>` text is "Terminal" without
   *  anchoring — the only other disclosure in the panel is "Task details",
   *  whose text never contains "terminal" as a substring, and the test's
   *  own task titles are chosen (below) to avoid containing it too. */
  function terminalsDetails(panel: Locator): Locator {
    return panel.locator("details").filter({ hasText: /terminal/i });
  }

  async function isTerminalsOpen(panel: Locator): Promise<boolean> {
    return terminalsDetails(panel).evaluate((el) => (el as HTMLDetailsElement).open);
  }

  test("expanding task D's terminals section does not leak into task E, and collapses again on returning to D", async ({
    page,
    request,
    backend,
  }) => {
    const suffix = randomUUID();
    const titleD = `panel-switch-d-${suffix}`;
    const titleE = `panel-switch-e-${suffix}`;

    // No spawn delay needed here (plain worker-scoped `backend`) — the fake
    // driver settles near-instantly with no `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS`.
    const taskD = await createAndStartFakeClaudeTask(request, backend, titleD);
    const taskE = await createAndStartFakeClaudeTask(request, backend, titleE);
    await waitForColumn(request, backend, taskD.id, "review", 10_000);
    await waitForColumn(request, backend, taskE.id, "review", 10_000);

    await gotoApp(page, backend.bootBase);

    const panel = await openTask(page, titleD);
    await expect(terminalsDetails(panel)).toBeVisible();
    expect(await isTerminalsOpen(panel), "D's terminals section starts collapsed (0 terminals)").toBe(false);

    await terminalsDetails(panel).locator("summary").click();
    expect(await isTerminalsOpen(panel), "D's terminals section is open after the manual toggle").toBe(true);

    // Switch to E without touching its terminals section at all — via the
    // context menu (see `openTaskWhilePanelOpen`'s doc comment): D's panel
    // is still open, so a plain card click on E would be intercepted by
    // the panel's backdrop.
    await openTaskWhilePanelOpen(page, titleE);
    await expect(panel.getByText(`fake response to: ${titleE}`, { exact: true })).toBeVisible({ timeout: 5_000 });
    expect(
      await isTerminalsOpen(panel),
      "E's terminals section must not inherit D's manually-opened state",
    ).toBe(false);

    // Switch back to D — a fresh `TerminalsSection` mount re-seeds from
    // `openTerminalCount > 0` (still 0), so the earlier manual expand does
    // not survive the round trip either.
    await openTaskWhilePanelOpen(page, titleD);
    await expect(panel.getByText(`fake response to: ${titleD}`, { exact: true })).toBeVisible({ timeout: 5_000 });
    expect(
      await isTerminalsOpen(panel),
      "D's terminals section is collapsed again on return — its earlier manual expand did not survive the remount",
    ).toBe(false);
  });
});
