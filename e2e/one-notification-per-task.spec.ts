import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, injectSseFrame, installSseInjector } from "./helpers";

/**
 * E2E coverage for "one notification per task" (docs/plans/duplicated-macos-
 * notifications.md §5 TT9): the in-app sonner slot (one toast per task, a newer
 * event replaces the older one, opening the task dismisses it) and the OS
 * notification the CORE decides (docs/architecture/notifications.md, grill D5).
 *
 * The decision moved out of the webview: the core posts and removes through its
 * notifier helper from the global event bus and the window's presence, which the
 * webview reports with `PUT /app/presence`. So these specs run against a backend
 * with `AGETOR_HEADLESS_NOTIFICATIONS=1` whose `AGETOR_NOTIFIER_BIN` is the
 * recording stub `e2e/notification-stub.ts`, and observe its log: one `post` line
 * per notification the core made, one `remove` line per entry it removed. (A
 * removal for a task that never had an entry is skipped by the notifier, so the
 * "clears the older entry" rule is pinned by the policy unit tests in
 * src/bun/notification-policy.test.ts; here only removals of delivered entries
 * show.) Window focus is faked by overriding `document.hasFocus` through an init
 * script with a flippable flag; the webview reports it as presence.
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
  /** The notifier's request id, `agetor.task.<taskId>`. */
  pathname: string;
  /** What the stub recorded for a post. */
  body: { taskId?: string; kind?: string; title?: string } | null;
}

interface NotificationCapture {
  all: CapturedRequest[];
  /** Kinds of the posts naming `taskId`, in arrival order. */
  postKinds(taskId: string): (string | undefined)[];
  posts(taskId: string): CapturedRequest[];
  deletes(taskId: string): CapturedRequest[];
  clear(): void;
}

/** The recording stub's log (`e2e/notification-stub.ts`): one file for the file's backends; every test keys its assertions by its own task id. */
const NOTIFIER_STUB = path.join(fileURLToPath(new URL(".", import.meta.url)), "notification-stub.ts");
const NOTIFIER_LOG = path.join(mkdtempSync(path.join(tmpdir(), "agetor-e2e-notifier-")), "notifier.log");
writeFileSync(NOTIFIER_LOG, "");
const NOTIFIER_ENV = {
  AGETOR_HEADLESS_NOTIFICATIONS: "1",
  AGETOR_NOTIFIER_BIN: NOTIFIER_STUB,
  AGETOR_E2E_NOTIFIER_LOG: NOTIFIER_LOG,
};
// Every spec in this file runs against its own core with the recording notifier on.
test.use({ backendEnv: NOTIFIER_ENV });

/** Reads the stub's log: each line is one helper call the core made. */
function captureNotifications(_page?: Page): NotificationCapture {
  let cleared = 0;
  const read = (): CapturedRequest[] => {
    let text = "";
    try {
      text = readFileSync(NOTIFIER_LOG, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter(Boolean).slice(cleared);
    const out: CapturedRequest[] = [];
    for (const line of lines) {
      const e = JSON.parse(line) as { op: string; id?: string; kind?: string; title?: string };
      const taskId = e.id?.replace(/^agetor\.task\./, "");
      if (e.op === "post") out.push({ method: "POST", pathname: e.id ?? "", body: { taskId, kind: e.kind, title: e.title } });
      else if (e.op === "remove") out.push({ method: "DELETE", pathname: e.id ?? "", body: null });
    }
    return out;
  };
  const posts = (taskId: string) => read().filter((r) => r.method === "POST" && r.body?.taskId === taskId);
  return {
    get all() {
      return read();
    },
    posts,
    postKinds: (taskId) => posts(taskId).map((r) => r.body?.kind),
    deletes: (taskId) => read().filter((r) => r.method === "DELETE" && r.pathname === `agetor.task.${taskId}`),
    clear: () => {
      cleared += read().length;
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

/** Installs the `/events` stream injector (see `installSseInjector`) so a test
 *  can deliver synthetic `GlobalEvent` frames through the same `onMessage` path
 *  a real SSE frame takes. Needed for facts the fake driver can't produce — its
 *  sent-files scenario always reports `status: "normal"`, never a proactive
 *  send. Must run BEFORE `gotoApp`. */
async function installGlobalEventSink(page: Page): Promise<void> {
  await installSseInjector(page, "/events");
}

async function deliverGlobalEvent(page: Page, event: Record<string, unknown>): Promise<void> {
  await injectSseFrame(page, "/events", event);
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
 *  The success toast is awaited FIRST: a count of 1 alone also matches the
 *  moment before it mounts, when only the files-sent toast is live, and the
 *  text check then caught both toasts during the few ms the dismissed one
 *  takes to flip `data-removed`. `toHaveCount` retries through that flip. */
async function expectSuccessToastReplacedOthers(page: Page, title: string): Promise<void> {
  await expect(liveToasts(page, title).filter({ hasText: "Task succeeded" })).toHaveCount(1);
  // A replacement drops the old toast within a few ms, so 1 s after the
  // success toast mounts is far inside the files-sent toast's own lifetime.
  await expect(liveToasts(page, title)).toHaveCount(1, { timeout: 1000 });
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
  test("(a) a task's files-sent toast is replaced by its Task succeeded toast", async ({ page, request, freshBackend: backend }) => {
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

  test("(b) opening the card dismisses the task's toast", async ({ page, request, freshBackend: backend }) => {
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
  test("(c) an unfocused window posts one notification per event, files-sent then succeeded", async ({ page, request, freshBackend: backend }) => {
    const title = uniqueTitle("unfocused");
    await fakeWindowFocus(page, false);
    const capture = captureNotifications(page);
    await gotoAppSubscribed(page, backend);
    const task = await createOnBoardThenStart(page, request, backend, title);

    await expect.poll(() => capture.postKinds(task.id), { timeout: CONVERGE_TIMEOUT }).toEqual(["files-sent", "succeeded"]);
    // Every post is under the task's one fixed notification id; nothing was
    // removed while the window was unfocused.
    for (const post of capture.posts(task.id)) expect(post.pathname).toBe(`agetor.task.${task.id}`);
    expect(capture.deletes(task.id)).toHaveLength(0);
  });

  test("(d) a focused window posts nothing (the core clears an older entry instead)", async ({ page, request, freshBackend: backend }) => {
    const title = uniqueTitle("focused");
    await fakeWindowFocus(page, true);
    const capture = captureNotifications(page);
    await gotoAppSubscribed(page, backend);
    const task = await createOnBoardThenStart(page, request, backend, title);

    // The in-app toast carries the news…
    await expectSuccessToastReplacedOthers(page, title);
    // …and nothing is posted (D7). Removing an older entry is the policy's other
    // half; with no entry delivered the notifier skips it, so that part is pinned
    // by the unit tests (src/bun/notification-policy.test.ts).
    await page.waitForTimeout(750);
    expect(capture.posts(task.id)).toHaveLength(0);
  });

  test("(f) opening the task's panel removes the entry the core posted for it", async ({
    page,
    request,
    freshBackend: backend,
  }) => {
    const title = uniqueTitle("open");
    await fakeWindowFocus(page, false);
    const capture = captureNotifications(page);
    const task = await createSentFilesTask(request, backend, title, { start: true });
    await waitForColumn(request, backend, task.id, "review");
    await gotoApp(page, backend.bootBase);
    // The unfocused core had no window to hold the news back, so it posted... (the task finished before the page loaded; the
    // core posts from its own event bus, not from what any page saw)
    await expect.poll(() => capture.postKinds(task.id), { timeout: CONVERGE_TIMEOUT }).toContain("succeeded");
    expect(capture.deletes(task.id)).toHaveLength(0);
    await openTaskCard(page, title);
    // ...and opening the task is reported as presence, so the core removes its entry.
    await expect.poll(() => capture.deletes(task.id).length, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
  });

  test("the webview reports what the window shows with PUT /app/presence", async ({ page, request, freshBackend: backend }) => {
    const title = uniqueTitle("presence");
    await fakeWindowFocus(page, true);
    const task = await createSentFilesTask(request, backend, title, { start: true });
    await waitForColumn(request, backend, task.id, "review");
    const reports: Array<{ focused: boolean; selectedTaskId: string | null; view: string | null }> = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && new URL(r.url()).pathname === "/app/presence") reports.push(r.postDataJSON());
    });
    await gotoApp(page, backend.bootBase);
    await expect.poll(() => reports.some((r) => r.focused && r.selectedTaskId === null), { timeout: CONVERGE_TIMEOUT }).toBe(true);
    await openTaskCard(page, title);
    await expect.poll(() => reports.some((r) => r.selectedTaskId === task.id && r.view === "run-panel"), { timeout: CONVERGE_TIMEOUT }).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { __agetorFocused: boolean }).__agetorFocused = false;
      window.dispatchEvent(new Event("blur"));
    });
    await expect.poll(() => reports.some((r) => !r.focused && r.selectedTaskId === task.id), { timeout: CONVERGE_TIMEOUT }).toBe(true);
  });

  // (g) "a focused proactive files-sent keeps its OS entry through the turn's succeeded event until the task is opened" is pinned by
  // src/bun/notification-policy.test.ts: it needs a synthetic core-side `files-sent` event, which a page-side SSE injector cannot
  // produce now that the core decides.
});

// ---------------------------------------------------------------------------
// (e) pipeline run view: its own backend, so the profile/pipeline rows need no
// cleanup.
// ---------------------------------------------------------------------------

test.describe("one notification per task: pipeline run view", () => {
  test("(e) opening a pipeline run view is reported as the parent being open", async ({ page, freshBackend }) => {
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

    const reports: Array<{ focused: boolean; selectedTaskId: string | null; view: string | null }> = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && new URL(r.url()).pathname === "/app/presence") reports.push(r.postDataJSON());
    });
    await gotoApp(page, backend.bootBase);
    // On the board with no panel and no run view, no task is reported open.
    await expect(taskCard(page, title)).toBeVisible();
    await expect.poll(() => reports.length, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
    expect(reports.every((r) => r.selectedTaskId === null)).toBe(true);

    await taskCard(page, title).getByText(title, { exact: true }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    // The run view counts as opening the parent: the webview reports it, and the core removes the parent's entry.
    await expect
      .poll(() => reports.some((r) => r.selectedTaskId === parent.id && r.view === "pipeline"), { timeout: CONVERGE_TIMEOUT })
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (h)/(i) an owed "Pipeline needs you" alert. A step's question takes the
// pipeline parent's one toast slot (and its one OS entry) while the run is
// already blocked on something else, so the block alert is displaced. Once
// the question is answered, from any client, App.tsx raises the alert again
// because the run is still blocked (OwedPipelineAlerts).
//
// The pipeline: Start fans out (`transition: "all"`) to Asker and Capped,
// with `maxSteps: 2`. Start counts 1 and Asker 2, so launching Capped hits
// the cap: a run-level `step-cap` block (no step task) keeps the run blocked
// while Asker asks the user (a pending `fx_permission` card). The widened
// spawn delay makes Asker's question land after the run is blocked, the way a
// real agent's question would (see pipelines-run.spec.ts's ASK_SPAWN_DELAY_MS).
// ---------------------------------------------------------------------------

/** Mirrors `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` in `src/bun/agents.ts`. */
const FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__";
/** Mirrors `FAKE_FX_PERMISSION_PROMPT_MARKER` in `src/bun/agents.ts`: the fake
 *  turn registers a pending `fx_permission` card and resolves only once it is
 *  answered. */
const FAKE_FX_PERMISSION_PROMPT_MARKER = "__agetor_fake_fx_permission__";

interface PipelineParentRow extends TaskRow {
  pendingInteractionCount?: number;
  pipelineRun: {
    status: string;
    active: { stepId: string; taskId: string }[];
    blocked: { taskId: string | null; stepId: string | null; kind: string }[];
  } | null;
}

interface PendingInteraction {
  id: string;
  kind: string;
  taskId: string;
}

function jsonHeaders(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { ...authHeaders(backend), "content-type": "application/json" };
}

async function postJson<T>(backend: E2EBackend, pathname: string, body: unknown): Promise<T> {
  const res = await fetch(`${backend.apiBase}${pathname}`, {
    method: "POST",
    headers: jsonHeaders(backend),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function getParent(backend: E2EBackend, id: string): Promise<PipelineParentRow> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}`, { headers: authHeaders(backend) });
  if (!res.ok) throw new Error(`GET /tasks/${id} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as PipelineParentRow;
}

function pipelineStep(id: string, name: string, agentProfileId: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    instructions: "",
    agentProfileId,
    position: { x, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...extra,
  };
}

/** Creates the Start → {Asker, Capped} pipeline and its (not started) parent task. */
async function createOwedAlertPipelineTask(
  backend: E2EBackend,
): Promise<{ parent: PipelineParentRow; title: string; askerStepId: string; cappedStepId: string }> {
  const { id: profileId } = await postJson<{ id: string }>(backend, "/agent-profiles", {
    name: "Runner",
    harness: "claude-code",
    model: "opus-5",
    instructions: "",
    skills: [],
  });
  const startId = randomUUID();
  const askerStepId = randomUUID();
  const cappedStepId = randomUUID();
  const { id: pipelineId } = await postJson<{ id: string }>(backend, "/pipelines", {
    name: "Owed Alert Pipeline",
    description: "",
    graph: {
      steps: [
        pipelineStep(startId, "Start", profileId, 0, {
          transition: "all",
          instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
        }),
        pipelineStep(askerStepId, "Asker", profileId, 300, {
          instructions: `Ask before writing. ${FAKE_FX_PERMISSION_PROMPT_MARKER}`,
        }),
        pipelineStep(cappedStepId, "Capped", profileId, 600),
      ],
      // Edge order is launch order: Asker takes the second slot, Capped hits the cap.
      edges: [
        { id: randomUUID(), from: startId, to: askerStepId, label: "" },
        { id: randomUUID(), from: startId, to: cappedStepId, label: "" },
      ],
      startStepId: startId,
    },
    maxSteps: 2,
  });
  const title = uniqueTitle("owed-alert");
  // The goal text carries no fake marker: Asker's own instructions pick its turn.
  const parent = await postJson<PipelineParentRow>(backend, "/tasks", {
    title,
    prompt: "Do the thing.",
    isolation: "none",
    workdir: tmpdir(),
    pipelineId,
  });
  return { parent, title, askerStepId, cappedStepId };
}

/** Starts the run and waits until it is blocked on the step cap (naming
 *  Capped) while Asker, the one active execution, has its question pending. */
async function startUntilAskingWhileBlocked(
  backend: E2EBackend,
  run: { parent: PipelineParentRow; askerStepId: string; cappedStepId: string },
): Promise<void> {
  await postJson(backend, `/tasks/${run.parent.id}/start`, {});
  await expect(async () => {
    const row = await getParent(backend, run.parent.id);
    expect(row.column).toBe("blocked");
    expect(row.pipelineRun?.status).toBe("blocked");
    const cap = row.pipelineRun?.blocked.find((b) => b.kind === "step-cap");
    expect(cap?.stepId).toBe(run.cappedStepId);
    expect(cap?.taskId ?? null).toBeNull();
    expect(row.pipelineRun?.active.map((a) => a.stepId)).toEqual([run.askerStepId]);
    expect(row.pendingInteractionCount ?? 0).toBe(1);
  }).toPass({ timeout: 30_000 });
}

/** Answers the step's question over REST, the way `agetor answer` would: the
 *  parent's pending list unions its steps' cards. */
async function answerStepQuestion(backend: E2EBackend, parentId: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${parentId}/interactions/pending`, {
    headers: authHeaders(backend),
  });
  expect(res.ok, `GET /tasks/${parentId}/interactions/pending -> ${res.status}`).toBeTruthy();
  const pending = (await res.json()) as PendingInteraction[];
  const card = pending.find((p) => p.kind === "fx_permission");
  expect(card, `pending interactions: ${JSON.stringify(pending)}`).toBeTruthy();
  const answer = await postJson<{ ok: boolean }>(backend, `/fx-permissions/${card!.id}/answer`, {
    optionId: "reject-once",
  });
  expect(answer.ok).toBe(true);
}

test.describe("one notification per task: an owed 'Pipeline needs you' alert", () => {
  test.use({
    backendEnv: {
      ...NOTIFIER_ENV,
      AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "3000",
      AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "3000",
    },
  });

  test("(h) unfocused: answering the step's question re-raises the block alert, toast and OS post", async ({
    page,
    freshBackend,
  }) => {
    test.setTimeout(90_000);
    const backend = freshBackend;
    await fakeWindowFocus(page, false);
    const capture = captureNotifications(page);
    const run = await createOwedAlertPipelineTask(backend);
    await gotoAppSubscribed(page, backend);
    // The toast copy reads the parent's title from the polled list.
    await expect(taskCard(page, run.title)).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await startUntilAskingWhileBlocked(backend, run);
    // The step's question holds the parent's one slot: exactly one live toast
    // names the pipeline, and it is the question, not the block alert.
    await expect(liveToasts(page, run.title)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(liveToasts(page, run.title)).toContainText("Waiting on you");
    await expect(liveToasts(page, run.title)).not.toContainText("Pipeline needs you");
    // The question took the parent's OS entry too (one `waiting` post).
    await expect.poll(() => capture.postKinds(run.parent.id), { timeout: CONVERGE_TIMEOUT }).toContain("waiting");
    expect(capture.postKinds(run.parent.id).at(-1)).toBe("waiting");

    capture.clear();
    await answerStepQuestion(backend, run.parent.id);

    // The run is still blocked on the step cap, so the owed alert comes back:
    // one live toast, now the block alert.
    await expect(liveToasts(page, run.title)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(liveToasts(page, run.title)).toContainText("Pipeline needs you", { timeout: CONVERGE_TIMEOUT });
    // …and, unfocused, it replaces the parent's OS entry with a `blocked` post.
    await expect.poll(() => capture.postKinds(run.parent.id)[0], { timeout: CONVERGE_TIMEOUT }).toBe("blocked");
    // Server side the run really is still blocked, with nothing left to answer.
    const after = await getParent(backend, run.parent.id);
    expect(after.pipelineRun?.status).toBe("blocked");
    expect(after.pendingInteractionCount ?? 0).toBe(0);
  });

  test("(i) focused: the re-raised block alert is a toast only, and posts no OS notification (D7)", async ({
    page,
    freshBackend,
  }) => {
    test.setTimeout(90_000);
    const backend = freshBackend;
    await fakeWindowFocus(page, true);
    const capture = captureNotifications(page);
    const run = await createOwedAlertPipelineTask(backend);
    await gotoAppSubscribed(page, backend);
    await expect(taskCard(page, run.title)).toBeVisible({ timeout: CONVERGE_TIMEOUT });

    await startUntilAskingWhileBlocked(backend, run);
    await expect(liveToasts(page, run.title)).toContainText("Waiting on you", { timeout: CONVERGE_TIMEOUT });

    capture.clear();
    await answerStepQuestion(backend, run.parent.id);

    await expect(liveToasts(page, run.title)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(liveToasts(page, run.title)).toContainText("Pipeline needs you", { timeout: CONVERGE_TIMEOUT });
    await page.waitForTimeout(750);
    expect(capture.posts(run.parent.id)).toHaveLength(0);
  });
});
