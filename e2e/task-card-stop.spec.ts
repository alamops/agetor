import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { newStep } from "../src/shared/pipeline.ts";
import type { PipelineRunState, Task } from "../src/shared/types.ts";

/**
 * Stop from the board (docs/architecture/task-card.md, "Actions"). The card's
 * Stop button and the `⋯` menu's Stop both go through App's `stopFromBoard`:
 * a pipeline PARENT asks "Stop this pipeline?" first (its Stop cancels live
 * steps and dismisses a pending review), and declining stops nothing. Every
 * other task keeps the one-click Stop. The action row owns its clicks, so
 * pressing Stop or `⋯` never also opens the card, and `⋯` toggles its menu.
 *
 * Each task is real (created over the API, isolation "none", a temp dir, never
 * started). The board's `GET /tasks` row is merged with the running state a
 * real run would need, and the two cancel routes are fulfilled in the page and
 * counted, so no agent or pipeline ever runs.
 */

test.describe.configure({ mode: "serial" });

// The board polls `GET /tasks` every 2 s, so a merge handler can be mid-fetch
// when the test ends; closing the page under it hangs the context teardown.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<Task> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: "stop e2e", isolation: "none", workdir: tmpdir(), agent: "claude-code" },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Task;
}

const STEPS = [newStep({ id: "s1", name: "Plan" }), newStep({ id: "s2", name: "Implement" })];
const runningPipeline = (): PipelineRunState => ({
  pipelineId: "pipe-stop",
  pipelineName: "Stop Confirmation Pipeline",
  snapshot: { graph: { steps: STEPS, edges: [], startStepId: "s1" }, maxSteps: 25, profiles: {}, capturedAt: 1 },
  status: "running",
  active: [{ stepId: "s2", taskId: "step-2", seq: 2 }],
  joins: {},
  blocked: [],
  history: [
    { seq: 1, stepId: "s1", taskId: "step-1", startedAt: 1, endedAt: 2, outcome: "succeeded", handoff: null, nextStepIds: ["s2"] },
    { seq: 2, stepId: "s2", taskId: "step-2", startedAt: 2, endedAt: null, outcome: null, handoff: null, nextStepIds: [] },
  ],
  stepCount: 2,
  startedAt: 1,
  endedAt: null,
});

/** The board reads `id`'s row with `patch` merged in. */
async function mergeRow(page: Page, backend: E2EBackend, id: string, patch: Partial<Task>): Promise<void> {
  await page.route(`${backend.apiBase}/tasks`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as Task[];
    await route.fulfill({ response, json: rows.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  });
}

/** Fulfils every POST to `url` with `json` and returns how many arrived. The
 *  webview calls the API cross-origin, so the reply carries an ACAO header
 *  like the suite's other API fakes; the CORS preflight (OPTIONS) still goes
 *  to the real core. */
async function countPosts(page: Page, url: string, json: unknown): Promise<() => number> {
  let n = 0;
  await page.route(url, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    n += 1;
    await route.fulfill({ json, headers: { "access-control-allow-origin": "*" } });
  });
  return () => n;
}

const cardOf = (page: Page, id: string): Locator => page.locator(`[data-task-id="${id}"]`);
const stopButton = (card: Locator): Locator => card.getByRole("button", { name: "Stop", exact: true });
const pipelineDialog = (page: Page): Locator => page.getByRole("dialog").filter({ hasText: "Stop this pipeline?" });
// The run panel is the `<aside>` holding its resize handle (see board-keyboard.spec.ts).
const runPanel = (page: Page): Locator => page.locator("aside").filter({ has: page.getByTestId("run-panel-resize") });
// A pipeline parent's card opens its full-page run view, not the run panel
// (App's `openTaskFromBoard`), so "the card did not open" is checked there.
const runView = (page: Page): Locator => page.getByTestId("pipeline-run-view");

/** A running pipeline parent on the board, with its cancel route counted. */
async function runningPipelineCard(page: Page, request: APIRequestContext, backend: E2EBackend, label: string) {
  const task = await createTask(request, backend, `${label} ${randomUUID()}`);
  await mergeRow(page, backend, task.id, { column: "running", pipelineId: "pipe-stop", pipelineRun: runningPipeline() });
  const cancels = await countPosts(page, `${backend.apiBase}/tasks/${task.id}/pipeline/cancel`, { ...task, column: "ready" });
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(card.getByTestId("task-card-pipeline")).toBeVisible({ timeout: 10_000 });
  return { card, cancels };
}

test("the card's Stop on a running pipeline asks first; Cancel stops nothing, Stop stops it once", async ({ page, request, backend }) => {
  const { card, cancels } = await runningPipelineCard(page, request, backend, "stop-card");

  await stopButton(card).click();
  const dialog = pipelineDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Live steps will be cancelled and the pending review dismissed. History is kept.");
  // Pressing Stop did not also open the card under the dialog.
  await expect(runView(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
  await expect(dialog).toHaveCount(0);

  await stopButton(card).click();
  await pipelineDialog(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(pipelineDialog(page)).toHaveCount(0);
  await expect.poll(cancels).toBeGreaterThan(0);
  // Exactly one: the declined confirm above sent nothing. (A cancel sent on
  // decline would have arrived first, so it would be counted by now.)
  expect(cancels()).toBe(1);
  await expect(runView(page)).toHaveCount(0);
  await expect(card).toBeVisible();
});

test("the ⋯ menu's Stop on a running pipeline asks too; declining stops nothing", async ({ page, request, backend }) => {
  const { card, cancels } = await runningPipelineCard(page, request, backend, "stop-menu");
  const menuStop = async () => {
    await card.getByTestId("task-card-more").click();
    await page.getByTestId("task-context-menu").getByRole("menuitem", { name: "Stop", exact: true }).click();
  };

  await menuStop();
  await expect(pipelineDialog(page)).toBeVisible();
  await pipelineDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(pipelineDialog(page)).toHaveCount(0);

  await menuStop();
  await pipelineDialog(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(cancels).toBeGreaterThan(0);
  expect(cancels()).toBe(1);
  await expect(runView(page)).toHaveCount(0);
});

test("Stop on a plain running task stops it at once: no dialog, and the card does not open", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `stop-plain ${randomUUID()}`);
  const runId = `run-${randomUUID()}`;
  await mergeRow(page, backend, task.id, { column: "running", runId, hasOpenableRun: true });
  const cancels = await countPosts(page, `${backend.apiBase}/runs/${runId}/cancel`, { cancelled: true });
  await gotoApp(page, backend.bootBase);
  const card = cardOf(page, task.id);
  await expect(stopButton(card)).toBeVisible({ timeout: 10_000 });

  await stopButton(card).click();
  await expect.poll(cancels).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(runPanel(page)).toHaveCount(0);
});

test("⋯ opens the task menu without opening the card, and a second click closes it", async ({ page, request, backend }) => {
  const task = await createTask(request, backend, `more-click ${randomUUID()}`);
  await gotoApp(page, backend.bootBase);
  const more = cardOf(page, task.id).getByTestId("task-card-more");
  await expect(more).toBeVisible({ timeout: 10_000 });

  await more.click();
  await expect(page.getByTestId("task-context-menu")).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(runPanel(page)).toHaveCount(0);

  // ⋯ toggles: the press closes the menu, and its click does not reopen it.
  await more.click();
  await expect(page.getByTestId("task-context-menu")).toHaveCount(0);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(page.getByTestId("task-context-menu")).toBeVisible();
});
