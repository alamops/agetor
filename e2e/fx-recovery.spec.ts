import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, getPreferences, openSettingsGeneral } from "./helpers";
// Pure constants/types only (no bun/node runtime imports — see
// `src/shared/types.ts`'s own "Keep it free of runtime imports" rule), same
// established pattern as `e2e/fx-models.spec.ts`'s `AGENT_OPTIONS` import —
// safe for this Node-run Playwright process, unlike `src/bun/agents.ts`
// (see the marker-literal comments below for why THOSE stay copied).
import { FX_AUTO_RESUME_DELAY_PREF, FX_AUTO_RESUME_MAX, FX_AUTO_RESUME_PREF } from "../src/shared/types.ts";

/**
 * Prompt-marker trigger for the fake fx model-response-recovery scenario
 * (`makeFakeAgent` in `src/bun/agents.ts`, exported there as
 * `FAKE_FX_RECOVERY_PROMPT_MARKER`) — kept as a literal here, not an import,
 * for the same reason `e2e/fx-interactions.spec.ts`'s header comment gives
 * for its own two markers: `src/bun/*.ts` pulls in `bun:sqlite`/tmux-driver
 * modules that Node's ESM loader (which runs Playwright's own test process,
 * as opposed to the `bun` runtime the headless backend under test runs on)
 * can't resolve — a `bun:`-scheme specifier 404s the whole test file.
 *
 * Triggering this marker on turn 1 selects the "storm" variant documented in
 * `docs/plans/fix-fx-harness-rate-limit.md` §3: three retry-attempt
 * sentinels (at ~5/400/800ms) followed by a terminal `paused` sentinel (at
 * ~1500ms) once the fake's 3-attempt budget is exhausted. A *later* turn on
 * the same task started via `POST /tasks/:id/fx-resume` ignores this marker
 * entirely — `AgentRunOptions.continueRecovery: true` always wins and
 * selects the "continue" variant instead (a `recovered` sentinel + an
 * ordinary short turn) regardless of what the original prompt said.
 */
const FAKE_FX_RECOVERY_PROMPT_MARKER = "__agetor_fake_fx_recovery__";

/**
 * Fake Gateway URL the fake fx driver splices onto every `active`/`paused`
 * recovery message in this worker's backend — armed process-wide via
 * `AGETOR_FAKE_FX_RECOVERY_URL=1` in `e2e/fixtures.ts` (mirrors
 * `src/bun/agents.ts`'s `FAKE_FX_RECOVERY_URL_PROMPT_MARKER`/
 * `emitFakeFxRecoveryStorm`'s `urlSuffix` parameter — copied as a literal for
 * the same "can't import src/bun/agents.ts" reason as the marker above).
 * Because the env var is on for the whole worker, it applies to EVERY fake
 * fx recovery task this file creates, not just the ones written to test link
 * rendering specifically — hence `PAUSED_MESSAGE`/`PAUSED_SUMMARY_LINE`
 * below carry it unconditionally.
 */
const GATEWAY_URL = "https://example.invalid/upgrade";
const GATEWAY_URL_SUFFIX = ` · upgrade at ${GATEWAY_URL}`;

/**
 * The fake "storm" scenario's exact wire strings (`src/bun/agents.ts`,
 * mirrors `docs/plans/fix-fx-harness-rate-limit.md` §3's "Fake fx driver per
 * turn" spec) — copied here as literals for the same reason the marker above
 * is: this file can't import `src/bun/agents.ts`. Every attempt payload sets
 * an explicit non-empty `message`, so `fxRecoveryNoticeText`
 * (`src/shared/fx-recovery.ts`) just returns it verbatim — nothing here
 * needs to reproduce that function's composition logic, only its inputs.
 * `PAUSED_MESSAGE`/`PAUSED_SUMMARY_LINE` carry `GATEWAY_URL_SUFFIX` because
 * `AGETOR_FAKE_FX_RECOVERY_URL=1` is set worker-wide (see `GATEWAY_URL`'s
 * doc comment) — `RECOVERED_MESSAGE`/`REFUSED_STATUS_LINE` never carry it:
 * the fake never appends the suffix to a `recovered` payload (see
 * `emitFakeFxRecoveryStorm`'s doc comment), and the refused line is a fixed
 * string independent of the recovery payload entirely.
 */
const PAUSED_MESSAGE =
  `⚠ Rate limited · HTTP 429 · fake gateway limit · recovery paused after 3/3 attempts${GATEWAY_URL_SUFFIX}`;
const PAUSED_SUMMARY_LINE = `${PAUSED_MESSAGE} — resume once the limit clears, or send a new message.`;
const REFUSED_STATUS_LINE = "fx turn ended: refused (response paused after 3/3 attempts — resumable)";
const RECOVERED_MESSAGE = "✓ recovered · succeeded on attempt 1/3";
const RECOVERED_ASSISTANT_TEXT = "recovered answer";

/**
 * E2E coverage for `docs/plans/fix-fx-harness-rate-limit.md` TT6: an fx task
 * that hits the Vercel AI Gateway's rate limit must show live retry progress
 * while fx retries, a persisted explanation + Resume affordance once fx
 * gives up, and a working one-click Resume that continues the SAME paused
 * model response with no new user message — all driven through the real
 * orchestrator → SSE → RunPanel → `/tasks/:id/fx-resume` wiring via the
 * in-process fake fx driver (`AGETOR_FX_DRIVER=fake`, e2e/fixtures.ts), not a
 * stubbed component. The final test covers the unrelated default-mode change
 * (`AGENT_OPTIONS.fx.modes[0]` is now `yolo` "Full access") from the same
 * plan.
 *
 * fx ships disabled by default (migration 046, `enabled=0`), so every test
 * here needs the harness enabled first — done once in `beforeAll` since
 * `backend` is worker-scoped and the toggle persists across this file's
 * serial tests. `mode: "serial"` because tests 1-4 are one continuous
 * storyline against a single "storm" task (create → live retries → paused →
 * Resume → follow-up), same shape as `e2e/fx-interactions.spec.ts`.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Mirrors `TaskFxRecovery` (`src/shared/types.ts`) — the JSON shape
 *  `GET /tasks/:id` returns on `fxRecovery` once a run has paused. Declared
 *  locally (not imported) since it's a plain structural shape and the point
 *  is to assert on the wire JSON, not share a type. */
interface TaskFxRecoveryShape {
  state: "paused";
  runId: string;
  pausedAt: number;
  cause?: string;
  attempt?: number;
  attemptLimit?: number;
  message?: string;
  autoResume: { at: number; attempt: number; max: number; delaySec: number } | null;
  autoResumeCount: number;
  autoResumeStopped?: "exhausted" | "cancelled" | "disabled";
}

interface TaskDetail extends TaskRow {
  column: string;
  mode: string | null;
  fxRecovery?: TaskFxRecoveryShape | null;
}

interface RunRow {
  id: string;
  status: string;
}

/**
 * Ids of every task this file creates, deleted in `afterAll` — see
 * `e2e/fx-interactions.spec.ts`'s identical `createdTaskIds` comment for why
 * a leftover `workdir: tmpdir()` task matters to sibling specs sharing the
 * worker (a stale row can become `tasks[0]` and poison another file's Git
 * dialog default).
 */
const createdTaskIds: string[] = [];

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function enableFxHarness(backend: E2EBackend): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/fx`, {
    method: "PATCH",
    headers: { ...authHeaders(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /harnesses/fx -> ${res.status}: ${await res.text()}`);
  }
}

/** Create (but do not start) an fx task whose prompt embeds the recovery
 *  marker (isolation "none", a plain non-git temp dir as workdir — the fake
 *  driver never touches the filesystem), explicit `mode: "yolo"`. Deliberately
 *  split from starting (unlike `e2e/fx-interactions.spec.ts`'s
 *  `createAndStartFakeFxTask`, which does both): the fake "storm" scenario's
 *  active-retry window is only ~1.5s wall-clock (see the marker's doc
 *  comment above), and a `gotoApp` + click-to-open after the run has already
 *  started reliably burns past that window on its own (page navigation +
 *  React mount + initial `/tasks` fetch). Opening the panel FIRST, with the
 *  task not yet started, and only THEN calling `startFakeFxRecoveryTask`
 *  keeps the whole window available to the live-notice test below. */
async function createFakeFxRecoveryTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = authHeaders(backend);
  const prompt = `${FAKE_FX_RECOVERY_PROMPT_MARKER} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, agent: "fx", mode: "yolo", isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;
  // Recorded immediately (regardless of whether/when it's later started) so
  // afterAll cleanup always covers it.
  createdTaskIds.push(task.id);
  return task;
}

async function startFakeFxRecoveryTask(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<void> {
  const startRes = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: authHeaders(backend) });
  expect(
    startRes.ok(),
    `POST /tasks/${taskId}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();
}

/** Create AND start a storm task in one call — for the auto-resume tests
 *  below, which only care about the state the run settles into (paused,
 *  then auto-resumed), never the ~1.5s live-retry window the split
 *  create/start helpers above exist to catch (see
 *  `createFakeFxRecoveryTask`'s doc comment). Mirrors
 *  `e2e/fx-interactions.spec.ts`'s `createAndStartFakeFxTask`. */
async function createAndStartFakeFxRecoveryTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const task = await createFakeFxRecoveryTask(request, backend, title);
  await startFakeFxRecoveryTask(request, backend, task.id);
  return task;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<TaskDetail> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: authHeaders(backend) });
  expect(res.ok(), `GET /tasks/${taskId} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskDetail;
}

/** `GET /tasks/:id/runs` is newest-first (`runs.listForTask`, `ORDER BY
 *  started_at DESC`), so `runs[0]` is always the latest run. */
async function getRuns(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<RunRow[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: authHeaders(backend) });
  expect(res.ok(), `GET /tasks/${taskId}/runs -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as RunRow[];
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX. Mirrors
 *  `e2e/fx-interactions.spec.ts`'s identical helper. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible). Mirrors `e2e/fx-interactions.spec.ts`'s
 *  identical helper. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/**
 * Closes the run panel via the backdrop button and waits for the exit
 * transition to actually start — mirrors `e2e/board-search-shortcut.spec.ts`'s
 * identical `closeTaskPanel` helper (see its doc comment for why a corner
 * click, not the default center click, and why the backdrop button rather
 * than Escape). Needed here because a card whose own run panel is open can
 * sit directly under the panel `<aside>` (which covers the right ~35-45% of
 * the board on a default-width viewport) — a product discovery made writing
 * this file's context-menu tests: right-clicking such a card fails with
 * "element ... intercepts pointer events" until the panel is out of the way.
 */
async function closeTaskPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close task panel" }).click({ position: { x: 10, y: 10 } });
  await expect(runPanel(page)).toHaveClass(/translate-x-full/);
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  `TaskCard.tsx`'s root `<Card>` carries `cursor-grab` (drag handle
 *  styling, unique to board cards), so this can't accidentally match
 *  anything inside the run panel or the context menu. Mirrors
 *  `e2e/task-context-menu.spec.ts`'s identical helper. */
function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/**
 * Bring a card fully into view and let `.kanban-scroll`'s horizontal scroll
 * settle before it gets right-clicked — mirrors
 * `e2e/task-context-menu.spec.ts`'s identical helper (see that file's doc
 * comment: no longer load-bearing against the menu closing, since it now
 * dismisses on user `wheel` only, but still useful for deterministic click
 * coordinates).
 */
async function scrollCardIntoView(page: Page, title: string): Promise<void> {
  const card = taskCard(page, title);
  await card.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "center" }));
  await page.evaluate(async () => {
    const el = document.querySelector(".kanban-scroll");
    if (!el) return;
    let last = el.scrollLeft;
    let stable = 0;
    while (stable < 5) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (el.scrollLeft === last) {
        stable++;
      } else {
        stable = 0;
        last = el.scrollLeft;
      }
    }
  });
}

/** Right-clicks a card by its exact title (after settling any horizontal
 *  board scroll — see `scrollCardIntoView`). Unlike
 *  `e2e/task-context-menu.spec.ts`'s identical-in-spirit helper (which
 *  right-clicks via a bare `getByText(title).first()`, safe there since none
 *  of its cases have a run panel open for the SAME task at click time), this
 *  clicks within the `taskCard` scope specifically: several tests below
 *  right-click a card while that task's own run panel is open, and the panel
 *  also renders `task.title` as exact text (`RunPanel.tsx`'s header), so an
 *  unscoped text match would be ambiguous. */
async function rightClickCard(page: Page, title: string): Promise<void> {
  await scrollCardIntoView(page, title);
  await taskCard(page, title).click({ button: "right" });
}

/** The task context menu panel — `App.tsx` renders exactly one
 *  `<ContextMenu testId="task-context-menu" …>` for the whole board.
 *  Mirrors `e2e/task-context-menu.spec.ts`'s identical helper. */
function contextMenu(page: Page): Locator {
  return page.locator('[data-testid="task-context-menu"]');
}

/** One entry in the task context menu, by its `TaskMenuAction` id (e.g.
 *  `"resume-recovery"`, `"cancel-auto-resume"`). Mirrors
 *  `e2e/task-context-menu.spec.ts`'s identical `menuItem` helper. */
function menuItem(page: Page, action: string): Locator {
  return page.locator(`[data-testid="task-context-menu-${action}"]`);
}

/** Forces `App.tsx`'s own 2s `/tasks` poll (and RunPanel's own poll/kick, if
 *  a panel happens to be open) to refresh immediately instead of waiting out
 *  the natural interval — both `App.tsx`'s board-level `refresh()` and
 *  RunPanel's internal `kick()` are wired to `window`'s native `focus`
 *  event (`onVisible`/`onFocus` respectively), so one synthetic dispatch
 *  nudges both. Same trick the live-recovery-notice test above already uses
 *  to force RunPanel's own poll early; here it's what makes `task.fxRecovery`
 *  (board badge, context-menu gating) observable well inside the 2s
 *  `AGETOR_FX_AUTO_RESUME_DELAY_MS` auto-resume window instead of racing the
 *  natural poll cadence against the auto-resume timer. */
async function kickPolls(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

/** The New Task form's `<aside>` — mounted first in App.tsx's JSX, ahead of
 *  the run panel's own `<aside>` (`runPanel` above uses `.last()`). Mirrors
 *  `e2e/fx-interactions.spec.ts`/`e2e/fx-models.spec.ts`'s identical
 *  helper. */
function newTaskFormPanel(page: Page): Locator {
  return page.locator("aside").first();
}

/** Clicks the given harness's button in the New Task form's Harness picker
 *  — only enabled harnesses render here, so this doubles as an assertion the
 *  harness is enabled. Mirrors `e2e/fx-interactions.spec.ts`'s identical
 *  helper. */
async function selectHarness(page: Page, label: string): Promise<void> {
  const button = newTaskFormPanel(page).getByRole("button", { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
}

/** Registers `backend.dataDir` as a project under a distinctive name, so the
 *  New Task form's ProjectPicker has something to select without touching
 *  the native folder dialog (unavailable in this headless harness) — the
 *  form's `workdir` starts empty and "Run task" stays disabled until one is
 *  chosen, regardless of the isolate toggle. Mirrors
 *  `e2e/fx-interactions.spec.ts`'s identical helper. */
async function registerDataDirProject(backend: E2EBackend, name: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...authHeaders(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: backend.dataDir, name }),
  });
  if (!res.ok) {
    throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
  }
}

/** Selects `projectName` (registered via {@link registerDataDirProject}) in
 *  the New Task form's ProjectPicker. Mirrors
 *  `e2e/fx-interactions.spec.ts`'s identical helper. */
async function selectProject(form: Locator, projectName: string): Promise<void> {
  const trigger = form.getByTitle(
    "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.",
  );
  await trigger.click();
  const search = form.getByPlaceholder("Search projects…");
  await expect(search).toBeVisible();
  await search.fill(projectName);
  const row = form.getByRole("button", { name: projectName });
  await expect(row).toBeVisible();
  await row.click();
}

test.describe("fx recovery", () => {
  test.beforeAll(async ({ backend }) => {
    await enableFxHarness(backend);
  });

  /** Deletes every task this file created. Mirrors
   *  `e2e/fx-interactions.spec.ts`'s identical `afterAll` (see that file's
   *  header comment for why a leftover `workdir: tmpdir()` task matters to
   *  sibling specs sharing the worker). */
  test.afterAll(async ({ backend }) => {
    const auth = authHeaders(backend);
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
  });

  // Populated by the first test, read by the following three — one
  // continuous storyline against a single "storm" task, same shape as
  // `e2e/fx-interactions.spec.ts`.
  let stormTaskId: string;
  const stormTaskTitle = `fx-recovery-storm-e2e ${randomUUID()}`;

  test("live recovery notice: fx's retry progress shows while the run is in progress", async ({
    page,
    request,
    backend,
  }) => {
    const task = await createFakeFxRecoveryTask(request, backend, stormTaskTitle);
    stormTaskId = task.id;

    // Open the panel BEFORE starting — see `createFakeFxRecoveryTask`'s doc
    // comment for why this ordering (rather than start-then-navigate) is
    // what gives the ~1.5s active window a real chance: by the time the
    // panel is open and its SSE subscription is live, starting the task
    // delivers the fake driver's attempt sentinels over that already-open
    // stream instead of racing a full page load against them.
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stormTaskTitle);
    await startFakeFxRecoveryTask(request, backend, task.id);

    // The fake emits three retry-attempt sentinels at ~5/400/800ms, then
    // pauses at ~1500ms. The events themselves arrive live over SSE well
    // within that window, but RunPanel only force-refreshes its `runs`
    // snapshot (which `latestRun`/`liveRecoveryNotice` are derived from) on
    // an SSE-driven "life sign" kick debounced behind a ~1s post-connect
    // settle window (`CONNECT_SETTLE_MS`, RunPanel.tsx) or on window focus
    // (`onFocus` → `kick()`, unconditional) — the settle window alone can
    // eat the whole ~1.5s active window before the first forced refresh
    // fires. Dispatching a synthetic `focus` event on every retry nudges the
    // SAME refresh path a real user's browser regaining focus would trigger,
    // so this is polling for a real (if debounced) state, not sleeping past
    // it — every attempt message contains both substrings, so this passes
    // regardless of which attempt is showing at assertion time, as long as
    // the panel opened (and was started) before the pause fired.
    const notice = panel.getByTestId("fx-recovery-notice");
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(notice).toContainText("attempt");
      await expect(notice).toContainText("Rate limited");
    }).toPass({ timeout: 5_000, intervals: [50, 100, 200] });

    // --- Paused notice + auto-resume countdown + board badge -----------------
    // Deliberately continues within THIS SAME test rather than a fresh
    // `gotoApp` in the next one: the run settles paused at a fixed ~1500ms
    // mark and `AGETOR_FX_AUTO_RESUME_DELAY_MS=2000` (e2e/fixtures.ts) arms
    // the auto-resume timer the INSTANT it does — both on the backend's own
    // clock, independent of anything this test does. A fresh page load in a
    // follow-on test (navigation + React mount + initial `/tasks` fetch)
    // reliably burns past however much of that fixed 2000ms window is left
    // by the time settlement happens, so the only reliable place to observe
    // the countdown before it fires is right here, still inside the window
    // the live-notice assertion above already proved is open. `kickPolls`
    // forces both RunPanel's own poll/kick and App.tsx's board-level
    // `/tasks` poll to refresh immediately rather than waiting out their
    // natural 2s cadence — see its doc comment.
    // Single combined poll loop (rather than sequential bounded waits) for
    // "paused notice up" AND "countdown + badge both showing the schedule" —
    // every extra `toPass` round-trip here eats into the fixed ~2000ms
    // budget before the auto-resume timer fires, so this checks the whole
    // target state in one loop instead of waiting out one condition before
    // starting to poll for the next.
    const paused = panel.getByTestId("fx-recovery-paused");
    const countdown = panel.getByTestId("fx-recovery-countdown");
    const badge = taskCard(page, stormTaskTitle).getByTestId("fx-paused-badge");
    // Every inner `expect(locator)` call below is given an explicit SHORT
    // timeout (200ms) — without one, a web-first assertion that's still
    // false (e.g. the badge hasn't refreshed yet) retries internally for
    // Playwright's default 5000ms before this outer `toPass` iteration even
    // gets to retry, which single-handedly blows the ~2000ms real budget on
    // ONE failing iteration. A short inner timeout is what makes the OUTER
    // loop's own `intervals` (and repeated `kickPolls`) actually the thing
    // doing the polling, the way the rest of this test relies on.
    await expect(async () => {
      await kickPolls(page);
      await expect(paused).toBeVisible({ timeout: 200 });
      await expect(countdown).toHaveText(
        new RegExp(`^Auto-resume in \\d:\\d\\d \\(1/${FX_AUTO_RESUME_MAX}\\)$`),
        { timeout: 200 },
      );
      await expect(badge).toHaveText(/auto-resume \d:\d\d/, { timeout: 200 });
    }).toPass({ timeout: 3_000, intervals: [30, 60, 100, 150] });
    await expect(paused).toContainText("recovery paused after 3/3 attempts");
    await expect(paused).toContainText("resume once the limit clears");
    // The live (active-state) notice is mutually exclusive with the paused one.
    await expect(notice).toHaveCount(0);
    await expect(badge).toHaveAttribute("title", /recovery paused after 3\/3 attempts/);

    // --- Cancel the pending auto-resume RIGHT NOW, before doing anything
    // else — a product bug surfaced while writing this test: the badge and
    // countdown assertions above resolve quickly (often within one
    // `kickPolls` round-trip, since RunPanel's own live SSE state already
    // knows the run is paused well before any poll fires), but the fixed
    // ~2000ms `AGETOR_FX_AUTO_RESUME_DELAY_MS` window can already be more
    // than half spent by the time this test reaches this point (opening the
    // panel, waiting for a live "attempt" sentinel, then this block) — an
    // earlier version of this test that clicked the Gateway link BEFORE
    // cancelling hit exactly that: the auto-resume fired mid-click and
    // detached the notice out from under Playwright ("element was detached
    // from the DOM, retrying"), hanging for the full 30s test timeout. See
    // this file's header comment. Cancelling here removes the race for
    // every slower assertion that follows (the link click + toast, plus
    // whatever the next test does with this same task).
    // `handleCancelFxAutoResume` (RunPanel.tsx) only kicks the RUNS poll on
    // success, not the parent App.tsx `/tasks` poll `task.fxRecovery` itself
    // comes from — so this still needs its own `kickPolls` loop rather than
    // a bare assertion.
    await panel.getByTestId("fx-recovery-cancel-auto").click();
    await expect(async () => {
      await kickPolls(page);
      await expect(countdown).toHaveCount(0, { timeout: 200 });
    }).toPass({ timeout: 5_000, intervals: [100, 200, 300] });
    await expect(panel.getByText("Auto-resume cancelled.", { exact: true })).toBeVisible();

    // --- The Gateway URL inside the notice is a real, clickable link that
    // hands off to the OS default browser (never in-app navigation) via
    // `POST /open-external` — 501 in this headless harness (no native
    // bridge), surfaced as an error toast rather than a silent no-op. Safe
    // to do now (no more race): cancelling only clears the countdown line,
    // the notice (and its link) stays up until Resume or a new message.
    const urlBefore = page.url();
    const openExternalRequested = page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/open-external" && r.method() === "POST",
    );
    await paused.getByRole("link", { name: GATEWAY_URL }).click();
    await openExternalRequested;
    await expect(page.getByText("not available in headless mode")).toBeVisible();
    expect(page.url()).toBe(urlBefore);
  });

  test("after settlement: paused notice + Resume, persisted lines, run failed, task ready", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stormTaskTitle);

    // --- Paused notice + Resume affordance ----------------------------------
    // The auto-resume timer was already cancelled at the end of the previous
    // test, so this state is stable — no race against the 2s auto-fire here.
    const paused = panel.getByTestId("fx-recovery-paused");
    await expect(paused).toBeVisible({ timeout: 10_000 });
    await expect(paused).toContainText("recovery paused after 3/3 attempts");
    await expect(paused).toContainText("resume once the limit clears");
    await expect(panel.getByText("Auto-resume cancelled.", { exact: true })).toBeVisible();

    const resumeButton = panel.getByTestId("fx-recovery-resume");
    await expect(resumeButton).toBeVisible();
    await expect(resumeButton).toBeEnabled();

    // The live (active-state) notice from the first test must be gone —
    // mutually exclusive with the paused notice.
    await expect(panel.getByTestId("fx-recovery-notice")).toHaveCount(0);
    // No countdown any more — the schedule was cancelled.
    await expect(panel.getByTestId("fx-recovery-countdown")).toHaveCount(0);

    // --- Persisted plain transcript lines (written once by the driver at
    // the terminal transition, distinct from the ephemeral notice widget
    // above — `PAUSED_SUMMARY_LINE` is byte-identical to `paused`'s own text
    // since both come from the same `fxRecoverySummaryLine(payload)` call).
    await expect(panel.getByText(PAUSED_SUMMARY_LINE, { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(REFUSED_STATUS_LINE, { exact: true })).toBeVisible();
    await expect(panel.getByText("auto-resume cancelled", { exact: true })).toBeVisible();

    // --- The raw sentinel string must never render as transcript text ------
    // (`isInternalStatusSentinel` suppression, `shared/types.ts`).
    await expect(panel.getByText("fx-recovery:", { exact: false })).toHaveCount(0);

    // --- Board badge reflects the cancelled (no-schedule) state: "paused",
    // no countdown suffix.
    const badge = taskCard(page, stormTaskTitle).getByTestId("fx-paused-badge");
    await expect(badge).toHaveText("paused");

    // --- Server state: latest run failed, task back in Ready ---------------
    await expect(async () => {
      const runs = await getRuns(request, backend, stormTaskId);
      expect(runs[0]?.status).toBe("failed");
    }).toPass({ timeout: 10_000 });

    const task = await getTask(request, backend, stormTaskId);
    expect(task.column).toBe("ready");
    expect(task.fxRecovery?.state).toBe("paused");
    expect(task.fxRecovery?.autoResume).toBeNull();
    expect(task.fxRecovery?.autoResumeStopped).toBe("cancelled");
  });

  test("Resume: continues the same session with no new user bubble, and settles succeeded", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stormTaskTitle);

    await expect(panel.getByTestId("fx-recovery-paused")).toBeVisible({ timeout: 10_000 });

    // `UserMessageBlock` (RunPanel.tsx) always renders a "you" label — either
    // its own dedicated span (ordinary/command messages) or via
    // `MachineLabel` (a `tagged` message with authored content) — with no
    // other element in the panel using that exact text, so counting it is a
    // stable proxy for "how many user bubbles are in the transcript".
    const userBubbles = panel.getByText("you", { exact: true });
    const beforeCount = await userBubbles.count();
    expect(beforeCount).toBeGreaterThan(0); // sanity: the initial prompt bubble

    const runsBefore = await getRuns(request, backend, stormTaskId);
    const runIdBefore = runsBefore[0]?.id;
    expect(runIdBefore).toBeTruthy();

    const resumeButton = panel.getByTestId("fx-recovery-resume");
    await expect(resumeButton).toBeVisible();
    await resumeButton.click();

    // Paused notice disappears once the continue-recovery run starts.
    await expect(panel.getByTestId("fx-recovery-paused")).toHaveCount(0, { timeout: 10_000 });

    // Transcript gains the recovered summary line + the assistant answer.
    await expect(panel.getByText(RECOVERED_MESSAGE, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText(RECOVERED_ASSISTANT_TEXT, { exact: true })).toBeVisible();

    // No new user bubble was added — resuming sends no new prompt.
    const afterCount = await userBubbles.count();
    expect(afterCount).toBe(beforeCount);

    // Server state: a NEW run id, settled succeeded.
    await expect(async () => {
      const runs = await getRuns(request, backend, stormTaskId);
      expect(runs[0]?.id).not.toBe(runIdBefore);
      expect(runs[0]?.status).toBe("succeeded");
    }).toPass({ timeout: 20_000 });
  });

  test("follow-up after resume: composer send settles a new run with no recovery notice", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stormTaskTitle);

    // No recovery affordance carried over from the resumed run.
    await expect(panel.getByTestId("fx-recovery-paused")).toHaveCount(0);
    await expect(panel.getByTestId("fx-recovery-notice")).toHaveCount(0);

    const followUpText = `fx-recovery-followup ${randomUUID()}`;
    const textarea = panel.getByTestId("send-textarea");
    await expect(textarea).toBeVisible();
    await textarea.fill(followUpText);
    await panel.getByRole("button", { name: "Send" }).click();

    // A plain follow-up with no recovery marker hits the fake driver's
    // generic echo fallback (src/bun/agents.ts) — not the recovery scenario,
    // since only `continueRecovery: true` or a marker-carrying prompt
    // selects that branch.
    await expect(panel.getByText(`fake response to: ${followUpText}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await expect(panel.getByTestId("fx-recovery-paused")).toHaveCount(0);
    await expect(panel.getByTestId("fx-recovery-notice")).toHaveCount(0);
  });

  test("auto-resume fires on its own, recovers, and clears the board badge", async ({ page, request, backend }) => {
    const title = `fx-recovery-autofire-e2e ${randomUUID()}`;
    const task = await createAndStartFakeFxRecoveryTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const paused = panel.getByTestId("fx-recovery-paused");
    await expect(paused).toBeVisible({ timeout: 10_000 });

    const runsBefore = await getRuns(request, backend, task.id);
    const pausedRunId = runsBefore[0]?.id;
    expect(pausedRunId).toBeTruthy();

    // Nothing is clicked here — `AGETOR_FX_AUTO_RESUME_DELAY_MS=2000`
    // (e2e/fixtures.ts) means the orchestrator's own timer fires the resume.
    // The opening status line on an auto-fired continue-recovery run is
    // distinct from a manual one's (`turn.origin === "auto"` in
    // `spawnFxRun`, orchestrator.ts).
    await expect(
      panel.getByText(`auto-resuming paused fx response (1/${FX_AUTO_RESUME_MAX})`, { exact: false }),
    ).toBeVisible({ timeout: 8_000 });

    // Transcript gains the recovered summary line + the assistant answer,
    // same terminal shape as a manual Resume.
    await expect(panel.getByText(RECOVERED_MESSAGE, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText(RECOVERED_ASSISTANT_TEXT, { exact: true })).toBeVisible();

    // Paused notice is gone, and so is the board badge.
    await expect(paused).toHaveCount(0);
    await expect(async () => {
      await kickPolls(page);
      await expect(taskCard(page, title).getByTestId("fx-paused-badge")).toHaveCount(0, { timeout: 200 });
    }).toPass({ timeout: 5_000, intervals: [100, 200, 300] });

    // Server state: a NEW run id, settled succeeded; the fxRecovery row is
    // cleared entirely (the chain recovered).
    await expect(async () => {
      const runs = await getRuns(request, backend, task.id);
      expect(runs[0]?.id).not.toBe(pausedRunId);
      expect(runs[0]?.status).toBe("succeeded");
    }).toPass({ timeout: 10_000 });

    const finalTask = await getTask(request, backend, task.id);
    expect(finalTask.fxRecovery ?? null).toBeNull();
  });

  test("cancel via the paused notice, then Resume from the context menu", async ({ page, request, backend }) => {
    const title = `fx-recovery-cancel-then-menu-e2e ${randomUUID()}`;
    const task = await createFakeFxRecoveryTask(request, backend, title);

    // Open the panel BEFORE starting — same reasoning as the live-notice
    // test above: a fresh page load after starting would burn into the 2s
    // AGETOR_FX_AUTO_RESUME_DELAY_MS window this test needs to click Cancel
    // inside of.
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await startFakeFxRecoveryTask(request, backend, task.id);

    // Combined loop (paused notice up AND countdown showing) for the same
    // reason the live-notice test above does this: every extra `toPass`
    // round-trip eats into the fixed ~2000ms budget before the auto-resume
    // timer would fire on its own.
    const paused = panel.getByTestId("fx-recovery-paused");
    const countdown = panel.getByTestId("fx-recovery-countdown");
    // Short inner timeouts (200ms) on every web-first assertion below — see
    // the live-notice test's identical comment: without one, a still-false
    // assertion retries internally for Playwright's default 5000ms before
    // this outer loop even gets another `kickPolls`, which alone can blow
    // the ~2000ms real budget.
    await expect(async () => {
      await kickPolls(page);
      await expect(paused).toBeVisible({ timeout: 200 });
      await expect(countdown).toBeVisible({ timeout: 200 });
    }).toPass({ timeout: 3_500, intervals: [30, 60, 100, 150] });

    await panel.getByTestId("fx-recovery-cancel-auto").click();
    // `handleCancelFxAutoResume` only kicks the RUNS poll on success, not the
    // parent App.tsx `/tasks` poll `task.fxRecovery` itself comes from.
    await expect(async () => {
      await kickPolls(page);
      await expect(countdown).toHaveCount(0, { timeout: 200 });
    }).toPass({ timeout: 5_000, intervals: [100, 200, 300] });
    await expect(panel.getByText("Auto-resume cancelled.", { exact: true })).toBeVisible();
    await expect(panel.getByText("auto-resume cancelled", { exact: true })).toBeVisible();

    // Board badge: "paused", no countdown suffix.
    const badge = taskCard(page, title).getByTestId("fx-paused-badge");
    await expect(async () => {
      await kickPolls(page);
      await expect(badge).toHaveText("paused", { timeout: 200 });
    }).toPass({ timeout: 3_000, intervals: [100, 200] });

    // Server state confirms the cancel.
    await expect(async () => {
      const detail = await getTask(request, backend, task.id);
      expect(detail.fxRecovery?.autoResumeStopped).toBe("cancelled");
      expect(detail.fxRecovery?.autoResume).toBeNull();
    }).toPass({ timeout: 3_000 });

    // Close the run panel first — it covers the right ~35-45% of the board,
    // and this card can sit directly underneath it, which would make the
    // right-click below land on the panel instead (see `closeTaskPanel`'s
    // doc comment: a real product discovery made writing this test).
    await closeTaskPanel(page);

    // Context menu: "Resume paused response" offered, "Cancel auto-resume"
    // withheld (no schedule is pending any more).
    await kickPolls(page);
    await rightClickCard(page, title);
    await expect(contextMenu(page)).toBeVisible();
    await expect(menuItem(page, "resume-recovery")).toBeVisible();
    await expect(menuItem(page, "cancel-auto-resume")).toHaveCount(0);

    const runsBefore = await getRuns(request, backend, task.id);
    const pausedRunId = runsBefore[0]?.id;

    await menuItem(page, "resume-recovery").click();

    // Resumes: a new run starts and recovers, same as a click on the
    // notice's own Resume button — verified server-side (the panel is
    // closed at this point, so there's no live transcript to read).
    await expect(async () => {
      const runs = await getRuns(request, backend, task.id);
      expect(runs[0]?.id).not.toBe(pausedRunId);
      expect(runs[0]?.status).toBe("succeeded");
    }).toPass({ timeout: 10_000 });
  });

  test("context menu: Cancel auto-resume while the countdown is running", async ({ page, request, backend }) => {
    const title = `fx-recovery-menu-cancel-e2e ${randomUUID()}`;
    const task = await createFakeFxRecoveryTask(request, backend, title);

    // No need to open the run panel this time — the context menu acts
    // straight off the board card. `gotoApp` first so the board is already
    // mounted (and polling) by the time the storm settles + schedules.
    await gotoApp(page, backend.bootBase);
    await startFakeFxRecoveryTask(request, backend, task.id);

    // Wait for the BOARD's own (client-side) copy of `task.fxRecovery` to
    // have caught up with the server-armed schedule — `buildTaskContextMenu`
    // (task-context-menu.ts) builds its entries from App.tsx's polled
    // `tasks` snapshot, so right-clicking before that snapshot refreshes
    // would build a menu missing "Cancel auto-resume" even though the
    // server-side schedule already exists. The badge showing the countdown
    // pattern is a visible proxy for "the frontend's copy is fresh".
    const badge = taskCard(page, title).getByTestId("fx-paused-badge");
    await expect(async () => {
      await kickPolls(page);
      await expect(badge).toHaveText(/auto-resume \d:\d\d/, { timeout: 200 });
    }).toPass({ timeout: 3_500, intervals: [30, 60, 100, 150] });

    await rightClickCard(page, title);
    await expect(contextMenu(page)).toBeVisible();
    await expect(menuItem(page, "cancel-auto-resume")).toBeVisible();

    await menuItem(page, "cancel-auto-resume").click();

    await expect(async () => {
      await kickPolls(page);
      await expect(badge).toHaveText("paused", { timeout: 200 });
    }).toPass({ timeout: 3_000, intervals: [100, 200] });

    await expect(async () => {
      const detail = await getTask(request, backend, task.id);
      expect(detail.fxRecovery?.autoResumeStopped).toBe("cancelled");
      expect(detail.fxRecovery?.autoResume).toBeNull();
    }).toPass({ timeout: 3_000 });
  });

  test("Settings → General: fx auto-resume toggle and delay round-trip through preferences", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);

    const toggle = dialog.getByTestId("settings-fx-auto-resume");
    await expect(toggle).toBeChecked(); // on by default — no earlier test in this worker wrote either pref key.

    // Set the delay while the switch is ON — SettingsDialog.tsx disables the
    // input while auto-resume is off, so this has to happen before toggling
    // off below.
    const delayInput = dialog.getByTestId("settings-fx-auto-resume-delay");
    await expect(delayInput).toBeEnabled();
    await delayInput.fill("45");
    await delayInput.blur();
    await expect(async () => {
      const prefs = await getPreferences(request, backend);
      expect(prefs[FX_AUTO_RESUME_DELAY_PREF]).toBe("45");
    }).toPass({ timeout: 5_000 });

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(delayInput).toBeDisabled();
    await expect(async () => {
      const prefs = await getPreferences(request, backend);
      expect(prefs[FX_AUTO_RESUME_PREF]).toBe("off");
    }).toPass({ timeout: 5_000 });

    // Restore: back on, delay back to the 120s default — this worker's
    // backend is shared by every test in this file.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(delayInput).toBeEnabled();
    await delayInput.fill("120");
    await delayInput.blur();
    await expect(async () => {
      const prefs = await getPreferences(request, backend);
      expect(prefs[FX_AUTO_RESUME_PREF]).toBe("on");
      expect(prefs[FX_AUTO_RESUME_DELAY_PREF]).toBe("120");
    }).toPass({ timeout: 5_000 });
  });

  test("Task details: a null-mode fx task shows 'Full access' (yolo) in the Mode dropdown", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-recovery-null-mode-api-e2e ${randomUUID()}`;
    const createRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: authHeaders(backend),
      // No `mode` field at all — `createTask` stores `null` verbatim (plan
      // §3.6: the "Full access"/yolo resolution happens at spawn time and at
      // display time via `defaultModeFor`, never at create time).
      data: { title, prompt: title, agent: "fx", isolation: "none", workdir: tmpdir() },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const task = (await createRes.json()) as TaskDetail;
    createdTaskIds.push(task.id);
    expect(task.mode).toBeNull();

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // "Task details" is a native <details>/<summary> — collapsed by default.
    await panel.getByText("Task details", { exact: true }).click();

    // "Mode" (exact) is the <dt> label; its value lives in the immediately
    // following <dd>'s <select> — mirrors the New Task form test below's
    // xpath-sibling pattern, adapted for a dt/dd pair instead of a
    // label/button pair.
    const modeSelect = panel
      .getByText("Mode", { exact: true })
      .locator("xpath=following-sibling::dd[1]//select");
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toHaveValue("yolo");
    const label = await modeSelect.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent);
    expect(label).toBe("Full access");
  });

  test("New Task form: fx's mode picker defaults to 'Full access' (yolo) with no selection", async ({
    page,
    request,
    backend,
  }) => {
    const projectName = `fx-recovery-e2e-project-${randomUUID()}`;
    await registerDataDirProject(backend, projectName);

    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);

    await selectHarness(page, "fx.sh");

    // --- Default mode trigger reads "Full access" without ever opening the
    // picker or clicking a row — proves `AGENT_OPTIONS.fx.modes[0]` (the
    // `yolo` / "Full access" row) is what a fresh fx selection lands on.
    // Locator mirrors `e2e/fx-interactions.spec.ts`'s identical "Mode" row
    // xpath (no dedicated testid exists on the trigger).
    const modeLabel = form.getByText("Mode", { exact: true });
    const modeTrigger = modeLabel.locator("xpath=following-sibling::div[2]//button").first();
    await expect(modeTrigger).toHaveText("Full access");

    await selectProject(form, projectName);

    // --- Create + start without ever touching the mode picker, then
    // confirm the persisted id is "yolo" — proves the *value*, not just the
    // *label*, defaults correctly. Isolation off (same "run directly in a
    // plain non-git dir" shape `createFakeFxRecoveryTask` uses above)
    // sidesteps worktree/branch bookkeeping, which isn't this test's concern.
    const title = `fx-recovery-default-mode-e2e ${randomUUID()}`;
    await form.getByPlaceholder("Short description").fill(title);
    await form.getByTestId("prompt-textarea").fill(title);
    await form.getByTestId("worktree-options").getByTestId("isolate-toggle").uncheck();

    const runButton = form.getByRole("button", { name: "Run task", exact: true });
    await expect(runButton).toBeEnabled();
    await runButton.click();

    let task: TaskDetail | null = null;
    await expect(async () => {
      const res = await request.get(`${backend.apiBase}/tasks`, { headers: authHeaders(backend) });
      expect(res.ok()).toBeTruthy();
      const tasks = (await res.json()) as TaskDetail[];
      task = tasks.find((t) => t.title === title) ?? null;
      expect(task).not.toBeNull();
    }).toPass({ timeout: 15_000 });
    createdTaskIds.push(task!.id);

    // The stored id is still "yolo" — only the picker's label changed
    // (fx 0.0.8's own "Full access" naming; see AGENT_OPTIONS.fx.modes).
    expect(task!.mode).toBe("yolo");
  });
});
