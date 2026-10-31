import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * TT7 of docs/plans/event-stream-forward-resume.md: the task event stream
 * resumes from `Last-Event-ID` after a drop instead of re-fetching the whole
 * window, and degrades to a fresh snapshot (with a visible notice) when the
 * gap is too long to replay.
 *
 * The seam is the test-only `POST /test/drop-task-streams { taskId, holdMs }`
 * (enabled by `AGETOR_TEST_DROP_STREAMS_ROUTE=1`, src/bun/server.ts): it
 * closes the task's open `/tasks/:id/events` streams and parks the NEXT stream
 * request server-side for `holdMs`, so everything the task does meanwhile is a
 * gap the reconnect has to cover. `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS=2000`
 * (src/bun/agents.ts) delays the fake claude SPAWN, not the prompt echo: the
 * `user` event is persisted straight away, and the `started — …` line plus the
 * reply only land ~2 s later — inside the hold, as long as the drop happens
 * within that 2 s window (we drop the moment the prompt bubble is on screen).
 *
 * Each test uses `freshBackend` (test-scoped), so its tasks vanish with the
 * backend; the `afterEach` still deletes them, per the plan, while it is up.
 *
 * Marker strings are copied literally — e2e specs can't import src/bun/*.
 */

const FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER = "__agetor_fake_claude_long_reply__";
const FAKE_FX_PERMISSION_PROMPT_MARKER = "__agetor_fake_fx_permission__";
const GAP_NOTICE_TEXT = "Reconnected after a long gap — showing the latest messages";

// The fixture merges `backendEnv` over its own defaults (provisionBackend's
// `...extraEnv`), so this only adds the two seams.
test.use({
  backendEnv: {
    AGETOR_TEST_DROP_STREAMS_ROUTE: "1",
    AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "2000",
  },
});

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

const createdTaskIds: string[] = [];

test.afterEach(async ({ freshBackend }) => {
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${freshBackend.apiBase}/tasks/${id}`, {
      method: "DELETE",
      headers: authHeaders(freshBackend),
    }).catch(() => {});
  }
});

/** Create (without starting) a task in a plain temp dir with isolation off —
 *  the fake drivers never touch the filesystem. */
async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  data: Record<string, unknown>,
): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: authHeaders(backend),
    data: { isolation: "none", workdir: tmpdir(), ...data },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as TaskRow;
  createdTaskIds.push(task.id);
  return task;
}

/** Fire `POST /tasks/:id/start` and hand back the pending call. With the
 *  2 s spawn delay the route answers `pending` after the 1.5 s spawn budget,
 *  so callers must not block on it before dropping the stream. */
function startTask(request: APIRequestContext, backend: E2EBackend, taskId: string) {
  return request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: authHeaders(backend) });
}

async function dropStreams(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  holdMs: number,
): Promise<void> {
  const res = await request.post(`${backend.apiBase}/test/drop-task-streams`, {
    headers: authHeaders(backend),
    data: { taskId, holdMs },
  });
  expect(res.ok(), `POST /test/drop-task-streams -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as { closed: number };
  // The panel's stream must have been open, otherwise nothing was dropped
  // and the rest of the test would prove nothing.
  expect(body.closed, "open event streams closed by the drop").toBeGreaterThan(0);
}

function isEventsUrl(url: string, taskId: string): boolean {
  return new URL(url).pathname === `/tasks/${taskId}/events`;
}

/** Poll the task until its run settled into `column`. */
async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  column: string,
): Promise<{ runId: string | null }> {
  let last: { column?: string; runId?: string | null } = {};
  await expect
    .poll(
      async () => {
        const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: authHeaders(backend) });
        last = (await res.json()) as typeof last;
        return last.column;
      },
      { timeout: 60_000 },
    )
    .toBe(column);
  return { runId: last.runId ?? null };
}

function isEventsPageUrl(url: string, taskId: string): boolean {
  return new URL(url).pathname === `/tasks/${taskId}/events/page`;
}

function pageBeforeId(url: string): number {
  return Number(new URL(url).searchParams.get("beforeId"));
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Open the task's panel from its board card and wait for the composer. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Scoped to the transcript: the Task details section repeats the prompt. */
function transcript(panel: Locator): Locator {
  return panel.getByTestId("transcript-log");
}

/** Open the panel and wait until its event stream is actually attached, so a
 *  later drop closes something. */
async function openTaskWithStream(page: Page, taskId: string, title: string): Promise<Locator> {
  const attached = page.waitForResponse((r) => isEventsUrl(r.url(), taskId));
  const panel = await openTask(page, title);
  await attached;
  return panel;
}

test.describe("task event stream forward resume (docs/plans/event-stream-forward-resume.md TT7)", () => {
  test("a drop during a turn resumes from Last-Event-ID: no duplicates, no gap notice", async ({
    page,
    request,
    freshBackend: backend,
  }) => {
    test.setTimeout(120_000);

    const marker = randomUUID();
    const title = `stream-resume-${marker}`;
    const prompt = `resume e2e ${marker}`;
    const task = await createTask(request, backend, { title, prompt });

    await gotoApp(page, backend.bootBase);
    const panel = await openTaskWithStream(page, task.id, title);
    const log = transcript(panel);

    // Kick the run off without waiting: the route holds ~1.5 s on the spawn
    // delay, and the drop has to land before the spawn finishes (2 s).
    const started = startTask(request, backend, task.id);
    // The prompt echo is the cursor the reconnect will carry.
    await expect(log.getByText(prompt, { exact: true })).toHaveCount(1);

    // Register BEFORE the drop: the reconnect request is issued as soon as the
    // stream closes, then parked server-side for the hold.
    const reconnect = page.waitForRequest(
      (r) => isEventsUrl(r.url(), task.id) && !!r.headers()["last-event-id"],
      { timeout: 30_000 },
    );
    await dropStreams(request, backend, task.id, 4_000);
    const reconnectReq = await reconnect;
    expect(Number(reconnectReq.headers()["last-event-id"])).toBeGreaterThan(0);

    // The `started —` line and the reply land during the hold and arrive via
    // the resumed stream.
    const reply = log.getByText(`fake response to: ${prompt}`, { exact: true });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply).toHaveCount(1);
    await expect(log.getByText(/^started — /)).toHaveCount(1);
    await expect(log.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(panel.getByTestId("transcript-gap-notice")).toHaveCount(0);

    // Let a few polls/keepalives pass: still no duplicate, no late notice.
    await page.waitForTimeout(1_500);
    await expect(reply).toHaveCount(1);
    await expect(log.getByText(/^started — /)).toHaveCount(1);
    await expect(panel.getByTestId("transcript-gap-notice")).toHaveCount(0);

    await started;
  });

  test("a permission card raised while the stream was down is recovered by the reconnect refetch", async ({
    page,
    request,
    freshBackend: backend,
  }) => {
    test.setTimeout(120_000);

    // fx ships disabled; the fresh backend is discarded afterwards, so no
    // restore is needed.
    const enable = await request.patch(`${backend.apiBase}/harnesses/fx`, {
      headers: authHeaders(backend),
      data: { enabled: true },
    });
    expect(enable.ok(), `PATCH /harnesses/fx -> ${enable.status()}: ${await enable.text()}`).toBeTruthy();

    const title = `stream-resume-card-${randomUUID()}`;
    // "ask" mode: under the default full-access mode the fake scenario
    // auto-allows and never registers a card.
    const task = await createTask(request, backend, {
      title,
      prompt: `${FAKE_FX_PERMISSION_PROMPT_MARKER} ${title}`,
      agent: "fx",
      mode: "ask",
    });

    await gotoApp(page, backend.bootBase);
    const panel = await openTaskWithStream(page, task.id, title);

    await dropStreams(request, backend, task.id, 3_000);

    // Start while the stream is down: the `interaction` frame is live-only, so
    // the reconnecting stream can't replay it — only the refetch of pending
    // interactions on reconnect can bring the card back.
    const startRes = await startTask(request, backend, task.id);
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();

    await expect(panel.getByText("Fx is requesting permission")).toBeVisible({ timeout: 30_000 });
  });

  test("a gap past the replay cap falls back to a fresh snapshot with the gap notice", async ({
    page,
    request,
    freshBackend: backend,
  }) => {
    test.setTimeout(180_000);

    const marker = randomUUID();
    const title = `stream-resume-snapshot-${marker}`;
    // Single line, marker on its own token: the prompt bubble is matched
    // exactly, and the long-reply scenario doesn't echo the prompt back.
    const prompt = `snapshot e2e ${marker} ${FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER}:900`;
    const task = await createTask(request, backend, { title, prompt });

    await gotoApp(page, backend.bootBase);
    const panel = await openTaskWithStream(page, task.id, title);
    const log = transcript(panel);

    const started = startTask(request, backend, task.id);
    await expect(log.getByText(`snapshot e2e ${marker}`, { exact: false })).toHaveCount(1);

    // 900 chunks land during the hold, past EVENTS_REPLAY_LIMIT (800), so the
    // reconnect gets `snapshotRequired` instead of a resume.
    await dropStreams(request, backend, task.id, 5_000);

    await expect(panel.getByTestId("transcript-gap-notice")).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId("transcript-gap-notice")).toHaveText(GAP_NOTICE_TEXT);

    // The fresh window is anchored back to the newest user message (prompt +
    // 900 chunks + status fit the anchor ceilings), so both ends are present,
    // each exactly once — the snapshot replaced the old state, it didn't
    // append to it.
    await expect(log.getByText("long reply chunk 900/900", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await expect(log.getByText("long reply chunk 1/900", { exact: true })).toHaveCount(1);
    await expect(log.getByText(`snapshot e2e ${marker}`, { exact: false })).toHaveCount(1);

    await started;
  });

  test("a Load earlier page still in flight across a snapshot reset is dropped, not prepended", async ({
    page,
    request,
    freshBackend: backend,
  }) => {
    test.setTimeout(180_000);

    const marker = randomUUID();
    const title = `stream-resume-load-earlier-${marker}`;
    // 4000 rows after the only user message: past the anchor ceiling (3000),
    // so the first window is the plain newest 800 and "Load earlier" shows.
    const task = await createTask(request, backend, {
      title,
      prompt: `load-earlier e2e ${marker} ${FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER}:4000`,
    });
    const startRes = await startTask(request, backend, task.id);
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();
    const { runId } = await waitForColumn(request, backend, task.id, "review");
    expect(runId).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const panel = await openTaskWithStream(page, task.id, title);
    const log = transcript(panel);
    await expect(log.getByText("long reply chunk 4000/4000", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    const loadEarlier = panel.getByRole("button", { name: "Load earlier messages" });
    await expect(loadEarlier).toBeVisible();

    // Hold the FIRST page request until the snapshot has replaced the window;
    // later ones go straight through.
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    let pageRequests = 0;
    await page.route(
      (url) => isEventsPageUrl(url.toString(), task.id),
      async (route) => {
        if (pageRequests++ === 0) await held;
        await route.continue();
      },
    );

    const firstPageReq = page.waitForRequest((r) => isEventsPageUrl(r.url(), task.id));
    await loadEarlier.click();
    const firstBeforeId = pageBeforeId((await firstPageReq).url());
    await expect(panel.getByRole("button", { name: "Loading…" })).toBeVisible();

    // A follow-up whose 900-row reply lands while the stream is down: past
    // EVENTS_REPLAY_LIMIT, so the reconnect gets `snapshotRequired`.
    const followUp = `follow-up ${marker} ${FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER}:900`;
    const sent = request.post(`${backend.apiBase}/runs/${runId}/input`, {
      headers: authHeaders(backend),
      data: { line: followUp },
    });
    await expect(log.getByText(`follow-up ${marker}`, { exact: false })).toHaveCount(1, { timeout: 30_000 });
    await dropStreams(request, backend, task.id, 5_000);

    await expect(panel.getByTestId("transcript-gap-notice")).toBeVisible({ timeout: 60_000 });
    await expect(log.getByText("long reply chunk 900/900", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    // The reset freed the button even though the old page is still pending.
    await expect(loadEarlier).toBeEnabled();

    // Let the stale page answer; it must change nothing.
    const staleResponse = page.waitForResponse((r) => isEventsPageUrl(r.url(), task.id));
    releaseHeld();
    await staleResponse;
    await page.waitForTimeout(500);
    // Those rows sit before the OLD window's front (turn 1's chunks 2401–3200);
    // prepending them onto the fresh window would leave an unfillable hole.
    await expect(log.getByText("long reply chunk 3000/4000", { exact: true })).toHaveCount(0);
    await expect(log.getByText("long reply chunk 4000/4000", { exact: true })).toHaveCount(0);
    await expect(loadEarlier).toBeEnabled();

    // The cursor is the fresh window's front, not the stale page's: paging
    // continues from right before the follow-up turn, not from turn 1's middle.
    const nextPageReq = page.waitForRequest((r) => isEventsPageUrl(r.url(), task.id));
    await loadEarlier.click();
    expect(pageBeforeId((await nextPageReq).url())).toBeGreaterThan(firstBeforeId);
    await expect(log.getByText("long reply chunk 4000/4000", { exact: true })).toHaveCount(1, { timeout: 30_000 });

    expect((await sent).ok()).toBeTruthy();
  });
});
