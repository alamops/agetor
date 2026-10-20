import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for "one notification per task" (docs/plans/duplicated-macos-
 * notifications.md §5 TT9): the in-app sonner slot (one toast per task, a newer
 * event replaces the older one, opening the task dismisses it) and the
 * webview -> core requests that drive the OS notification (`POST
 * /notifications` only while unfocused, `DELETE /notifications/:taskId` when
 * the entry no longer applies).
 *
 * Real Notification Center behavior is not observable here — the headless
 * backend 501s both `/notifications` routes — so the specs observe the
 * REQUESTS with `page.route` and fulfil them themselves (a 200, so the app
 * never sees an error). Window focus is faked by overriding
 * `document.hasFocus` (App.tsx reads `document.hasFocus()` when it handles a
 * global event) through an init script with a flippable flag.
 *
 * Tasks run the fake claude driver's sent-files scenario
 * (`FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER`): one `files-sent` event, then the
 * turn settles ~10ms later and the task goes to review ("Task succeeded"). The
 * scenario's timings are hard-wired (it ignores the fake driver's resolve-delay
 * seam), so the replaced files-sent toast is asserted through an in-page
 * observer log rather than a point-in-time visibility check.
 */

/** Mirrors `FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER` in `src/bun/agents.ts`
 *  (literal copy — see sent-files.spec.ts). */
const FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER = "__agetor_fake_claude_sent_files__";

const TOAST = "[data-sonner-toaster] [data-sonner-toast]";
const CONVERGE_TIMEOUT = 20_000;

interface TaskRow {
  id: string;
  title: string;
  column?: string;
}

interface CapturedRequest {
  method: "POST" | "DELETE";
  /** `/notifications` or `/notifications/<id>`. */
  pathname: string;
  /** Parsed JSON body of a POST. */
  body: { taskId?: string; kind?: string; title?: string } | null;
}

interface NotificationCapture {
  all: CapturedRequest[];
  /** Kinds of the POSTs naming `taskId`, in arrival order. */
  postKinds(taskId: string): (string | undefined)[];
  posts(taskId: string): CapturedRequest[];
  deletes(taskId: string): CapturedRequest[];
  clear(): void;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

/** Records every `POST /notifications` and `DELETE /notifications/:id` and
 *  answers them with a 200 (the headless core would 501). Preflights are
 *  answered here too: the webview and the API are different origins. */
async function captureNotifications(page: Page): Promise<NotificationCapture> {
  const all: CapturedRequest[] = [];
  await page.route(/\/notifications(\/[^?#]*)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (method === "POST" || method === "DELETE") {
      let body: CapturedRequest["body"] = null;
      if (method === "POST") {
        try {
          body = request.postDataJSON() as CapturedRequest["body"];
        } catch {
          body = null;
        }
      }
      all.push({ method, pathname: new URL(request.url()).pathname, body });
    }
    await route.fulfill({ status: 200, headers: CORS_HEADERS, contentType: "application/json", json: { ok: true } });
  });
  const posts = (taskId: string) => all.filter((r) => r.method === "POST" && r.body?.taskId === taskId);
  return {
    all,
    posts,
    postKinds: (taskId) => posts(taskId).map((r) => r.body?.kind),
    deletes: (taskId) =>
      all.filter((r) => r.method === "DELETE" && r.pathname === `/notifications/${encodeURIComponent(taskId)}`),
    clear: () => {
      all.length = 0;
    },
  };
}

/** Overrides `document.hasFocus()` with a flag the test can flip. Must run
 *  BEFORE `gotoApp` (init scripts apply from the next navigation). */
async function fakeWindowFocus(page: Page, focused: boolean): Promise<void> {
  await page.addInitScript((initial) => {
    const w = window as unknown as { __agetorFocused: boolean };
    w.__agetorFocused = initial;
    document.hasFocus = () => w.__agetorFocused;
  }, focused);
}

/** Records every sonner toast the moment it mounts (`window.__toastLog`).
 *  Toasts of one task replace each other within milliseconds, which a
 *  point-in-time visibility check can't catch. Must run BEFORE `gotoApp`. */
async function installToastLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __toastLog: { text: string }[] };
    w.__toastLog = [];
    const seen = new WeakSet<Element>();
    const scan = () => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        const text = el.textContent ?? "";
        if (!text || seen.has(el)) continue;
        seen.add(el);
        w.__toastLog.push({ text });
      }
    };
    new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

async function toastLog(page: Page): Promise<{ text: string }[]> {
  return page.evaluate(() => (window as unknown as { __toastLog: { text: string }[] }).__toastLog);
}

/** Navigates and waits for the app's `GET /events` subscription request, so a
 *  task started afterwards can't emit its live-only events before the page
 *  listens (see sent-files.spec.ts for why the REQUEST, not the response). */
async function gotoAppSubscribed(page: Page, backend: E2EBackend): Promise<void> {
  const globalEventsRequested = page.waitForRequest((r) => new URL(r.url()).pathname === "/events");
  await gotoApp(page, backend.bootBase);
  await globalEventsRequested;
}

function authHeaders(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

function uniqueTitle(label: string): string {
  return `one-notif-${label}-${randomUUID()}`;
}

/** Creates (and optionally starts) a fake sent-files task: isolation none, a
 *  fresh temp workdir. */
async function createSentFilesTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  opts: { start: boolean },
): Promise<TaskRow> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-one-notif-"));
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: authHeaders(backend),
    data: { title, prompt: `${FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER} ${title}`, isolation: "none", workdir },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;
  if (opts.start) {
    const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
      headers: authHeaders(backend),
    });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();
  }
  return task;
}

/** Creates the task (not started), waits until the board has polled its row —
 *  the toast copy resolves the task's title from that polled list and falls
 *  back to "Task <id7>" for a row it hasn't seen yet — and only then starts it. */
async function createOnBoardThenStart(
  page: Page,
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const task = await createSentFilesTask(request, backend, title, { start: false });
  await expect(taskCard(page, title)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: authHeaders(backend),
  });
  expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();
  return task;
}

async function waitForColumn(request: APIRequestContext, backend: E2EBackend, id: string, column: string) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: authHeaders(backend) });
        return ((await res.json()) as TaskRow).column;
      },
      { timeout: CONVERGE_TIMEOUT },
    )
    .toBe(column);
}

/** Waits until the task's slot holds exactly one live toast and it is the
 *  success one. The files-sent toast (sonner's default 4 s lifetime) would
 *  otherwise outlive the short timeout: only a REPLACEMENT clears it in time.
 *  `toHaveCount` retries, which absorbs the few ms the dismissed toast takes
 *  to flip `data-removed` after its successor mounts. */
async function expectSuccessToastReplacedOthers(page: Page, title: string): Promise<void> {
  await expect(liveToasts(page, title)).toHaveCount(1, { timeout: 2500 });
  await expect(liveToasts(page, title)).toContainText("Task succeeded");
}

/** Live (not being removed) toasts that name the task. */
function liveToasts(page: Page, title: string): Locator {
  return page.locator(`${TOAST}:not([data-removed='true'])`).filter({ hasText: title });
}

/** The board card for a unique title (see sent-files.spec.ts's `taskCard`). */
function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

async function openTaskCard(page: Page, title: string): Promise<Locator> {
  await taskCard(page, title).getByText(title, { exact: true }).click();
  const panel = page.locator("aside").last();
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("one notification per task: in-app slot", () => {
  test("(a) a task's files-sent toast is replaced by its Task succeeded toast", async ({ page, request, backend }) => {
    const title = uniqueTitle("replace");
    await installToastLog(page);
    await gotoAppSubscribed(page, backend);
    await createOnBoardThenStart(page, request, backend, title);

    // The files-sent toast was shown (and named the task)…
    await expect
      .poll(async () => (await toastLog(page)).some((e) => e.text.includes("2 files sent to you") && e.text.includes(title)), {
        timeout: CONVERGE_TIMEOUT,
      })
      .toBe(true);
    // …then the success toast took the slot: exactly one live toast names the
    // task, and it is the success one (the files-sent toast is gone well
    // before its own 4 s lifetime would have ended).
    await expectSuccessToastReplacedOthers(page, title);
    await expect(page.getByText("2 files sent to you")).toHaveCount(0);
  });

  test("(b) opening the card dismisses the task's toast", async ({ page, request, backend }) => {
    const title = uniqueTitle("open");
    await installToastLog(page);
    await gotoAppSubscribed(page, backend);
    await createOnBoardThenStart(page, request, backend, title);

    await expect
      .poll(async () => (await toastLog(page)).some((e) => e.text.includes("Task succeeded") && e.text.includes(title)), {
        timeout: CONVERGE_TIMEOUT,
      })
      .toBe(true);
    await expectSuccessToastReplacedOthers(page, title);
    await openTaskCard(page, title);
    await expect(liveToasts(page, title)).toHaveCount(0);
  });
});

test.describe("one notification per task: OS notification requests", () => {
  test("(c) an unfocused window posts one notification per event, files-sent then succeeded", async ({
    page,
    request,
    backend,
  }) => {
    const title = uniqueTitle("unfocused");
    await fakeWindowFocus(page, false);
    const capture = await captureNotifications(page);
    await gotoAppSubscribed(page, backend);
    const task = await createOnBoardThenStart(page, request, backend, title);

    await expect.poll(() => capture.postKinds(task.id), { timeout: CONVERGE_TIMEOUT }).toEqual(["files-sent", "succeeded"]);
    // Every POST names the task and carries a title/body; nothing was cleared
    // while the window was unfocused.
    for (const post of capture.posts(task.id)) expect(post.pathname).toBe("/notifications");
    expect(capture.deletes(task.id)).toHaveLength(0);
  });

  test("(d) a focused window posts nothing and clears the task's entry instead", async ({ page, request, backend }) => {
    const title = uniqueTitle("focused");
    await fakeWindowFocus(page, true);
    const capture = await captureNotifications(page);
    await gotoAppSubscribed(page, backend);
    const task = await createOnBoardThenStart(page, request, backend, title);

    // The in-app toast carries the news…
    await expectSuccessToastReplacedOthers(page, title);
    // …and the entry is removed (D7), never posted.
    await expect.poll(() => capture.deletes(task.id).length, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
    expect(capture.posts(task.id)).toHaveLength(0);
  });

  test("(f) the window regaining focus with a panel open clears that task's entry", async ({
    page,
    request,
    backend,
  }) => {
    const title = uniqueTitle("refocus");
    await fakeWindowFocus(page, true);
    const capture = await captureNotifications(page);
    const task = await createSentFilesTask(request, backend, title, { start: true });
    await waitForColumn(request, backend, task.id, "review");
    await gotoApp(page, backend.bootBase);
    await openTaskCard(page, title);

    // Let the open-panel effects settle, then only look at what the focus
    // event itself sends.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    capture.clear();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => capture.deletes(task.id).length, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (e) pipeline run view: its own backend, so the profile/pipeline rows need no
// cleanup.
// ---------------------------------------------------------------------------

test.describe("one notification per task: pipeline run view", () => {
  test("(e) opening a pipeline run view clears the parent's entry", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const headers = { ...authHeaders(backend), "content-type": "application/json" };

    const profileRes = await fetch(`${backend.apiBase}/agent-profiles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Runner", harness: "claude-code", model: "opus-5", instructions: "", skills: [] }),
    });
    expect(profileRes.ok, `POST /agent-profiles -> ${profileRes.status}`).toBeTruthy();
    const profileId = ((await profileRes.json()) as { id: string }).id;

    const stepId = randomUUID();
    const pipelineRes = await fetch(`${backend.apiBase}/pipelines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "One Notification Pipeline",
        description: "",
        graph: {
          steps: [
            {
              id: stepId,
              name: "Only",
              instructions: "",
              agentProfileId: profileId,
              position: { x: 0, y: 0 },
              subagents: { profileIds: [], cap: null },
              transition: "choose",
              join: "any",
            },
          ],
          edges: [],
          startStepId: stepId,
        },
        maxSteps: 25,
      }),
    });
    expect(pipelineRes.ok, `POST /pipelines -> ${pipelineRes.status}`).toBeTruthy();
    const pipelineId = ((await pipelineRes.json()) as { id: string }).id;

    const title = uniqueTitle("pipeline");
    const taskRes = await fetch(`${backend.apiBase}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, prompt: "Do the thing.", isolation: "none", workdir: tmpdir(), pipelineId }),
    });
    expect(taskRes.ok, `POST /tasks -> ${taskRes.status}`).toBeTruthy();
    const parent = (await taskRes.json()) as TaskRow;

    const capture = await captureNotifications(page);
    await gotoApp(page, backend.bootBase);
    // On the board with no panel and no run view, nothing is cleared.
    await expect(taskCard(page, title)).toBeVisible();
    expect(capture.deletes(parent.id)).toHaveLength(0);

    await taskCard(page, title).getByText(title, { exact: true }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect.poll(() => capture.deletes(parent.id).length, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
  });
});
