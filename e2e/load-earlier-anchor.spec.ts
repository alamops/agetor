import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E1 of docs/plans/first-load-reaches-last-user-message.md: proves
 * end-to-end that opening a task whose agent reply is longer than the SSE
 * replay cap (`EVENTS_REPLAY_LIMIT` = 800, src/shared/types.ts) still shows
 * the user's own prompt bubble on first load, with no "Load earlier
 * messages" click needed.
 *
 * The arithmetic: `startTask` always echoes the task's prompt as a `user`
 * stream event before the agent runs (orchestrator.ts, "Echo the initial
 * prompt as a 'user' event"), so that echo is the FIRST event ever
 * persisted for a fresh task. The fake claude driver's long-reply scenario
 * then appends 900 `assistant` chunks plus one closing `status` chunk — 902
 * events total. Pre-fix, the un-anchored SSE replay window keeps only the
 * newest 800 events (`EVENTS_REPLAY_LIMIT`), which excludes the prompt echo
 * (event #1) entirely — the user would see 800 assistant chunks and have to
 * click "Load earlier messages" to find their own message. Post-fix, the
 * window is anchored back to the newest main-stream `user` event whenever
 * the span from there to the newest event fits under
 * `EVENTS_REPLAY_ANCHOR_MAX_EVENTS` (3000) / `EVENTS_REPLAY_ANCHOR_MAX_BYTES`
 * (16 MB) — 902 events of short strings clears both ceilings easily, so the
 * window is extended all the way back to the prompt echo and "Load earlier
 * messages" never appears (there is nothing older to load: the anchor IS
 * the task's oldest event).
 *
 * The seam: `FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER` (`src/bun/agents.ts`),
 * optionally suffixed `:<count>` (default 900, clamped 1..5000), makes the
 * fake claude driver emit that many `assistant` chunks ("long reply chunk
 * i/N") then a `status` "turn complete" chunk. e2e specs cannot import from
 * `src/bun/*` (per that export's own doc comment), so the marker string is
 * copied here literally — see the constant below.
 *
 * Two cases:
 *   1. First open (plus a reopen after switching to a different task and
 *      back — RunPanel is one long-lived instance whose SSE subscription
 *      must re-anchor on every task switch, not just the very first mount)
 *      shows the prompt bubble attached with no "Load earlier messages"
 *      button and no click.
 *   2. A negative control that proves the seam actually creates the
 *      pre-fix failure mode it's meant to stand in for: reading the same
 *      902-event task through the un-anchored, unmodified-by-this-plan
 *      `/tasks/:id/events/page` route (paging is deliberately untouched —
 *      see plan §3) shows the newest-800 page really does exclude the user
 *      echo, while the next older page really does contain it. This is
 *      pure API traffic — no browser page needed (mirrors the API-only
 *      tests in `e2e/agent-profiles-api.spec.ts`) — and documents that case
 *      1 is exercising the anchor, not a coincidence of small transcripts.
 */

// Literal copy of `FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER`, exported from
// src/bun/agents.ts — its own doc comment says e2e specs must not import
// from src/bun/*, so this string is duplicated here on purpose.
const FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER = "__agetor_fake_claude_long_reply__";
const LONG_REPLY_DEFAULT_COUNT = 900;

interface TaskRow {
  id: string;
  title: string;
}

interface TaskDetail extends TaskRow {
  column: string;
}

interface RunRow {
  id: string;
  status: string;
}

interface EventsPageEvent {
  id: number;
  runId: string;
  taskId: string;
  stream: string;
  data: string;
  ts: number;
  subagentId: string | null;
}

interface EventsPageResponse {
  events: EventsPageEvent[];
  earliestId: number | null;
  hasMore: boolean;
}

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// Every task this spec creates, deleted in `afterAll` — the `backend`
// fixture is WORKER-scoped and shared by every spec file in the worker (see
// `e2e/fixtures.ts`), and the 900-event task seeded below is heavier than
// most leftovers: later specs would keep polling `/tasks` with it present,
// and absolute-count assertions elsewhere break on stray rows. Uses raw
// `fetch` rather than the test-scoped `request` fixture, mirroring
// `e2e/agent-profiles-api.spec.ts`'s own afterAll hook. Never blocks teardown.
const createdTaskIds: string[] = [];

test.afterAll(async ({ backend }) => {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
});

/** Create (isolation "none", a plain temp dir workdir — the fake driver
 *  never touches the filesystem) and start a task in one call. Mirrors
 *  `e2e/tagged-user-messages.spec.ts`'s identical helper. */
async function createAndStartTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  prompt: string,
): Promise<TaskRow> {
  const auth = authHeaders(backend);
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;
  createdTaskIds.push(task.id);

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

/** `GET /tasks/:id/runs` is newest-first — mirrors
 *  `e2e/task-switch-during-restore.spec.ts`'s identical helper. */
async function getRuns(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<RunRow[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: authHeaders(backend) });
  expect(res.ok(), `GET /tasks/${taskId}/runs -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as RunRow[];
}

/** Poll until the task's newest run has settled (status is no longer
 *  "running") AND the task column reflects it. The fake driver's long-reply
 *  scenario fires its 900 chunks + closing status line via two `setTimeout`s
 *  (5ms, 20ms) so this normally resolves almost instantly, but the timeout
 *  stays generous for a loaded machine. */
async function waitForRunSettled(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  timeout = 30_000,
): Promise<void> {
  await expect(async () => {
    const runs = await getRuns(request, backend, taskId);
    expect(runs.length, `task ${taskId} run count`).toBeGreaterThan(0);
    expect(runs[0]?.status, `task ${taskId} newest run status`).not.toBe("running");
  }).toPass({ timeout });
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's
 *  own sidebar is also an `<aside>`, mounted first. Mirrors every other
 *  spec's identical helper (e.g. `e2e/tagged-user-messages.spec.ts`). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  mirrors `e2e/task-switch-during-restore.spec.ts`'s identical helper. */
function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/** Click a task card by its exact title and wait for the composer textarea
 *  to mount as proof the run panel is open. Only valid when no panel is
 *  currently open (a plain card click is intercepted by RunPanel's
 *  full-screen backdrop once a panel is showing — see
 *  `openTaskWhilePanelOpen` below). */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** The scrollable message-log container (`data-testid="transcript-log"` on
 *  RunPanel.tsx's log `<div>`). Scoping assertions to this element (rather
 *  than the whole `panel`) is load-bearing: the collapsible "Task details"
 *  section also renders the raw prompt text verbatim in its own `<p>`, so an
 *  unscoped `panel.getByText(promptPrefix)` resolves to two elements and
 *  Playwright's strict mode throws — live-verified. */
function transcript(panel: Locator): Locator {
  return panel.getByTestId("transcript-log");
}

/**
 * Switch directly to a different task while a panel is already open —
 * copied from `e2e/task-switch-during-restore.spec.ts`'s identical helper
 * (see its doc comment for the full rationale): RunPanel's `fixed inset-0
 * z-30` backdrop intercepts a plain click on another board card while a
 * panel is open, but the task context menu's "Open details" action calls
 * `setSelected(t)` directly and portals above the backdrop, so a real
 * `contextmenu` DOM event dispatched straight at the card node (bypassing
 * Playwright's point-based actionability check, which would hit the same
 * backdrop interception a real right-click does) reaches it.
 */
async function openTaskWhilePanelOpen(page: Page, title: string): Promise<void> {
  await taskCard(page, title).dispatchEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  const openItem = page.locator('[data-testid="task-context-menu-open"]');
  await expect(openItem).toBeVisible();
  await openItem.click();
}

test.describe("first load reaches the last user message (docs/plans/first-load-reaches-last-user-message.md)", () => {
  test("opening a task with 900 assistant chunks after the prompt shows the prompt bubble on first load, with no 'Load earlier messages' click, and stays anchored after switching tasks and back", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);

    const marker = randomUUID();
    const promptPrefix = `first-load-anchor ${marker}`;
    const title = `load-earlier-anchor-${marker}`;
    // The marker rides on its own line so any markdown emphasis it might
    // trigger (double underscores) can't affect the distinct prefix text
    // asserted on below.
    const prompt = `${promptPrefix}\n\n${FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER}`;

    const task = await createAndStartTask(request, backend, title, prompt);
    await waitForRunSettled(request, backend, task.id);
    const settled = await getTask(request, backend, task.id);
    expect(settled.column, "long-reply task should settle in review").toBe("review");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    const log = transcript(panel);

    // The prompt bubble is present without any click — it will be scrolled
    // far above the viewport (900+ assistant chunks below it), so this must
    // be `toBeAttached()`, never `toBeVisible()`.
    await expect(log.getByText(promptPrefix, { exact: false })).toBeAttached({ timeout: 20_000 });

    // No "Load earlier messages" affordance: the anchor makes the prompt
    // echo (the task's very first persisted event) the window's floor, so
    // there is nothing older left to page in.
    await expect(panel.getByRole("button", { name: /load earlier messages/i })).toHaveCount(0);

    // All 900 assistant chunks actually rendered, not just the window's
    // metadata reporting them.
    await expect(log.getByText("long reply chunk 1/900", { exact: true })).toBeAttached({ timeout: 20_000 });
    await expect(
      log.getByText(`long reply chunk ${LONG_REPLY_DEFAULT_COUNT}/${LONG_REPLY_DEFAULT_COUNT}`, { exact: true }),
    ).toBeAttached({ timeout: 20_000 });

    // Switch to a second, unrelated task (RunPanel is one long-lived
    // instance — see CLAUDE.md — so this is a prop change, not a remount)
    // and back, proving the anchor is applied again on every (re)subscribe,
    // not just the very first mount.
    const otherMarker = randomUUID();
    const otherTitle = `load-earlier-anchor-other-${otherMarker}`;
    const otherTask = await createAndStartTask(request, backend, otherTitle, otherTitle);
    await waitForRunSettled(request, backend, otherTask.id);

    await openTaskWhilePanelOpen(page, otherTitle);
    await expect(log.getByText(`fake response to: ${otherTitle}`, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // The long-reply task's content must not have bled into the other
    // task's transcript.
    await expect(log.getByText(promptPrefix, { exact: false })).toHaveCount(0);

    await openTaskWhilePanelOpen(page, title);
    await expect(log.getByText(promptPrefix, { exact: false })).toBeAttached({ timeout: 20_000 });
    await expect(panel.getByRole("button", { name: /load earlier messages/i })).toHaveCount(0);
    await expect(
      log.getByText(`long reply chunk ${LONG_REPLY_DEFAULT_COUNT}/${LONG_REPLY_DEFAULT_COUNT}`, { exact: true }),
    ).toBeAttached({ timeout: 20_000 });
  });

  test("un-anchored /tasks/:id/events/page proves the seam: the newest-800 page excludes the last user message, the next page includes it", async ({
    request,
    backend,
  }) => {
    test.setTimeout(60_000);

    const marker = randomUUID();
    const promptPrefix = `seam-control-anchor ${marker}`;
    const title = `load-earlier-seam-control-${marker}`;
    const prompt = `${promptPrefix}\n\n${FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER}`;

    const task = await createAndStartTask(request, backend, title, prompt);
    await waitForRunSettled(request, backend, task.id);

    const auth = authHeaders(backend);
    // `/tasks/:id/events/page` is untouched by this plan (paging stays 800
    // events / 2 MB — plan §3) and requires a `beforeId`; a sentinel well
    // above any id this test could ever produce fetches the newest page.
    const SENTINEL_BEFORE_ID = 2_147_483_647;

    const page1Res = await request.get(
      `${backend.apiBase}/tasks/${task.id}/events/page?beforeId=${SENTINEL_BEFORE_ID}&limit=800`,
      { headers: auth },
    );
    expect(page1Res.ok(), `page1 -> ${page1Res.status()}: ${await page1Res.text()}`).toBeTruthy();
    const page1 = (await page1Res.json()) as EventsPageResponse;

    expect(page1.events.length, "newest page should be non-empty").toBeGreaterThan(0);
    expect(
      page1.events.some((e) => e.stream === "user"),
      "the newest-800 un-anchored page must NOT contain the prompt echo — that's the bug this plan fixes",
    ).toBe(false);
    expect(page1.earliestId, "page1 should report a real cursor to page further back from").not.toBeNull();

    const page2Res = await request.get(
      `${backend.apiBase}/tasks/${task.id}/events/page?beforeId=${page1.earliestId}`,
      { headers: auth },
    );
    expect(page2Res.ok(), `page2 -> ${page2Res.status()}: ${await page2Res.text()}`).toBeTruthy();
    const page2 = (await page2Res.json()) as EventsPageResponse;

    const userRow = page2.events.find((e) => e.stream === "user");
    expect(userRow, "the next older page must contain the prompt echo").toBeTruthy();
    expect(userRow?.data).toContain(promptPrefix);
  });
});
