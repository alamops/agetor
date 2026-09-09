import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

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
 * The fake "storm" scenario's exact wire strings (`src/bun/agents.ts`,
 * mirrors `docs/plans/fix-fx-harness-rate-limit.md` §3's "Fake fx driver per
 * turn" spec) — copied here as literals for the same reason the marker above
 * is: this file can't import `src/bun/agents.ts`. Every attempt payload sets
 * an explicit non-empty `message`, so `fxRecoveryNoticeText`
 * (`src/shared/fx-recovery.ts`) just returns it verbatim — nothing here
 * needs to reproduce that function's composition logic, only its inputs.
 */
const PAUSED_MESSAGE = "⚠ Rate limited · HTTP 429 · fake gateway limit · recovery paused after 3/3 attempts";
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

interface TaskDetail extends TaskRow {
  column: string;
  mode: string | null;
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
  });

  test("after settlement: paused notice + Resume, persisted lines, run failed, task ready", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stormTaskTitle);

    // --- Paused notice + Resume affordance ----------------------------------
    const paused = panel.getByTestId("fx-recovery-paused");
    await expect(paused).toBeVisible({ timeout: 10_000 });
    await expect(paused).toContainText("recovery paused after 3/3 attempts");
    await expect(paused).toContainText("resume once the limit clears");

    const resumeButton = panel.getByTestId("fx-recovery-resume");
    await expect(resumeButton).toBeVisible();
    await expect(resumeButton).toBeEnabled();

    // The live (active-state) notice from the first test must be gone —
    // mutually exclusive with the paused notice.
    await expect(panel.getByTestId("fx-recovery-notice")).toHaveCount(0);

    // --- Persisted plain transcript lines (written once by the driver at
    // the terminal transition, distinct from the ephemeral notice widget
    // above — `PAUSED_SUMMARY_LINE` is byte-identical to `paused`'s own text
    // since both come from the same `fxRecoverySummaryLine(payload)` call).
    await expect(panel.getByText(PAUSED_SUMMARY_LINE, { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(REFUSED_STATUS_LINE, { exact: true })).toBeVisible();

    // --- The raw sentinel string must never render as transcript text ------
    // (`isInternalStatusSentinel` suppression, `shared/types.ts`).
    await expect(panel.getByText("fx-recovery:", { exact: false })).toHaveCount(0);

    // --- Server state: latest run failed, task back in Ready ---------------
    await expect(async () => {
      const runs = await getRuns(request, backend, stormTaskId);
      expect(runs[0]?.status).toBe("failed");
    }).toPass({ timeout: 10_000 });

    const task = await getTask(request, backend, stormTaskId);
    expect(task.column).toBe("ready");
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
    }).toPass({ timeout: 10_000 });
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
