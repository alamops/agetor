import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2e coverage for actually RUNNING a pipeline (docs/plans/pipelines.md
 * §5 row E2): New Task's Pipeline picker, the board's pipeline badge,
 * the full-page run view (node/edge visual states, history, blocked +
 * manual advance, Stop + Retry, fan-out/join), clicking a step node to open
 * its RunPanel with the pipeline strip, and Settings' pipelines link.
 *
 * `e2e/pipelines-editor.spec.ts` owns building/saving/deleting pipelines in
 * the canvas editor — every pipeline here is created directly over the REST
 * API so this file can focus purely on run behavior.
 *
 * The fake claude driver (`AGETOR_CLAUDE_DRIVER=fake`, wired by
 * `e2e/fixtures.ts` on every worker backend) drives each step task via
 * `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` (`src/bun/agents.ts`): the marker's
 * optional `:<token>` suffix picks the scripted outcome, and the LAST
 * occurrence in a step's fully-composed prompt (goal text, then that step's
 * own instructions) wins — so a plain marker in the task's goal prompt
 * gives every step the same default outcome, and a step whose own
 * `instructions` field repeats the marker with a different suffix overrides
 * it for that one step. See `src/shared/pipeline.ts`'s `composeStepPrompt`
 * for the exact section ordering that makes "last occurrence wins" work.
 *
 * Every run-behavior scenario uses `freshBackend` with a widened
 * `AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS` (default in the fake driver is
 * ~30ms — too fast for `expect.poll`/UI screenshots to reliably observe an
 * "active" node, and far too fast to reliably click Stop mid-turn) rather
 * than the worker-shared `backend` other spec files use — a nice side
 * effect is that each test's pipeline/profile/task data is torn down for
 * free with the backend, so there's no manual REST cleanup to do for those
 * scenarios (only the lightweight New-Task-picker scenario, which never
 * starts a run, uses the shared `backend` and cleans up after itself).
 */

const FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__";
// Wide enough that `openPipelineRunFromBoard`'s full page (re)load — which
// happens AFTER `startTaskRest` already kicked the first step off — can't
// race past the step's "active" state before this test ever gets to observe
// it; the fake driver's default (~30ms) resolves long before a page load
// would even finish.
const RESOLVE_DELAY_MS = "3000";
const CONVERGE_TIMEOUT = 20_000;

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

interface StepInput {
  id: string;
  name: string;
  instructions?: string;
  agentProfileId: string;
  transition?: "choose" | "all";
  join?: "any" | "all";
}

function makeStep(input: StepInput) {
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions ?? "",
    agentProfileId: input.agentProfileId,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: input.transition ?? "choose",
    join: input.join ?? "any",
  };
}

async function createProfileRest(backend: E2EBackend, name: string): Promise<string> {
  const res = await fetch(`${backend.apiBase}/agent-profiles`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ name, harness: "claude-code", model: "opus-5", instructions: "", skills: [] }),
  });
  if (!res.ok) throw new Error(`POST /agent-profiles -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function createPipelineRest(
  backend: E2EBackend,
  name: string,
  steps: ReturnType<typeof makeStep>[],
  edges: { from: string; to: string }[],
  maxSteps = 25,
): Promise<string> {
  // Space steps out left-to-right — `makeStep` defaults every step's
  // position to the origin, and without this every node in a
  // REST-constructed graph would stack exactly on top of the others,
  // making the run view's canvas nodes unclickable (whichever one happens
  // to render on top intercepts every click).
  const positionedSteps = steps.map((s, i) => ({ ...s, position: { x: i * 300, y: 0 } }));
  const res = await fetch(`${backend.apiBase}/pipelines`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({
      name,
      description: "",
      graph: {
        steps: positionedSteps,
        edges: edges.map((e) => ({ id: randomUUID(), from: e.from, to: e.to, label: "" })),
        startStepId: steps[0]?.id ?? null,
      },
      maxSteps,
    }),
  });
  if (!res.ok) throw new Error(`POST /pipelines -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  pipelineId: string | null;
  pipelineRun: {
    status: string;
    active: { stepId: string; taskId: string }[];
    blocked: { taskId: string | null; stepId: string | null; kind: string; message: string }[];
    history: { stepId: string; taskId: string; outcome: string | null }[];
  } | null;
}

async function createPipelineTaskRest(
  backend: E2EBackend,
  title: string,
  pipelineId: string,
  prompt: string,
): Promise<TaskRow> {
  const res = await fetch(`${backend.apiBase}/tasks`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ title, prompt, isolation: "none", workdir: tmpdir(), pipelineId }),
  });
  if (!res.ok) throw new Error(`POST /tasks -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as TaskRow;
}

async function startTaskRest(backend: E2EBackend, id: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}/start`, { method: "POST", headers: auth(backend) });
  if (!res.ok) throw new Error(`POST /tasks/${id}/start -> ${res.status}: ${await res.text()}`);
}

async function getTask(backend: E2EBackend, id: string): Promise<TaskRow> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  if (!res.ok) throw new Error(`GET /tasks/${id} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as TaskRow;
}

async function waitForColumn(backend: E2EBackend, id: string, expected: string): Promise<TaskRow> {
  let last: TaskRow | null = null;
  await expect(async () => {
    last = await getTask(backend, id);
    expect(last.column).toBe(expected);
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return last!;
}

async function waitForPipelineStatus(backend: E2EBackend, id: string, expected: string): Promise<TaskRow> {
  let last: TaskRow | null = null;
  await expect(async () => {
    last = await getTask(backend, id);
    expect(last.pipelineRun?.status).toBe(expected);
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  return last!;
}

function boardCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

function stepNode(page: Page, stepId: string): Locator {
  return page.locator(`[data-testid="pipeline-step-node"][data-step-id="${stepId}"]`);
}

async function openPipelineRunFromBoard(page: Page, backend: E2EBackend, title: string): Promise<void> {
  await gotoApp(page, backend.bootBase);
  await boardCard(page, title).click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Scenario 1: New Task form's Pipeline picker (no run started) — shared
// worker backend, since it never starts a task.
// ---------------------------------------------------------------------------

test.describe("pipelines run: New Task form picker", () => {
  const createdPipelineIds: string[] = [];

  test.afterAll(async ({ backend }) => {
    for (const id of createdPipelineIds.splice(0)) {
      await fetch(`${backend.apiBase}/pipelines/${id}`, { method: "DELETE", headers: auth(backend) }).catch(
        () => {},
      );
    }
  });

  test("picking a pipeline shows its summary and hides the manual Agent block; clearing restores it", async ({
    page,
    backend,
  }) => {
    const pipelineName = `Picker Pipeline ${randomUUID()}`;
    const step = { ...makeStep({ id: randomUUID(), name: "Only step", agentProfileId: "unused" }), agentProfileId: null };
    const id = await createPipelineRest(backend, pipelineName, [step as never], []);
    createdPipelineIds.push(id);

    await gotoApp(page, backend.bootBase);
    const form = page.locator("aside").first();
    const picker = form.getByTestId("new-task-pipeline-picker").getByTestId("pipeline-picker");
    await expect(form.getByText("Agent", { exact: true })).toBeVisible();

    await picker.getByTestId("pipeline-picker-trigger").click();
    const popover = picker.getByTestId("pipeline-picker-popover");
    await expect(popover).toBeVisible();
    await popover.locator(`[data-testid="pipeline-picker-row"][data-pipeline-id="${id}"]`).click();
    await expect(popover).toBeHidden();

    const summary = form.getByTestId("new-task-pipeline-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(pipelineName);
    await expect(summary).toContainText("1 step");
    await expect(form.getByText("Agent", { exact: true })).toHaveCount(0);

    await summary.getByTestId("new-task-pipeline-clear").click();
    await expect(form.getByTestId("new-task-pipeline-summary")).toHaveCount(0);
    await expect(form.getByText("Agent", { exact: true })).toBeVisible();
    await expect(picker.getByTestId("pipeline-picker-trigger")).toContainText("No pipeline");
  });
});

// ---------------------------------------------------------------------------
// Scenarios 2-6: actually running a pipeline — each gets its own fresh
// backend with a widened fake-driver resolve delay (see file header).
// ---------------------------------------------------------------------------

test.describe("pipelines run: executing a run", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: RESOLVE_DELAY_MS } });

  test("linear A->B->C run: board badge, node/edge visuals, history, ends in Review; opening a done step's RunPanel", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
    const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
    const C = makeStep({ id: randomUUID(), name: "C", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(
      backend,
      "Linear Pipeline",
      [A, B, C],
      [
        { from: A.id, to: B.id },
        { from: B.id, to: C.id },
      ],
    );
    const title = `Linear Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);

    // Node visuals cycle: A active, then B active (A done), then C active
    // (B done), then all done.
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "done");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "done");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done");

    const historyRows = page.locator('[data-testid="pipeline-run-history-row"]');
    await expect(historyRows).toHaveCount(3);
    await historyRows.first().click();
    await expect(historyRows.first().getByTestId("pipeline-run-history-handoff")).toBeVisible();
    await expect(historyRows.first().getByTestId("pipeline-run-history-handoff")).toContainText("schemaVersion");

    await waitForColumn(backend, task.id, "review");

    // Board badge — checked once the run has settled, on a fresh load of
    // the board (a badge doesn't depend on run status, so checking it here
    // rather than mid-run avoids racing the fake driver's resolve delay).
    await page.getByTestId("pipeline-run-back").click();
    await expect(boardCard(page, title).getByTestId("task-card-pipeline")).toBeVisible();
    await boardCard(page, title).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    // Click a done node -> RunPanel with the pipeline strip.
    await stepNode(page, A.id).click();
    const panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toContainText("Linear Pipeline");
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toContainText("A");
    await panel.getByTestId("run-panel-open-pipeline").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await panel.getByRole("button", { name: "Close task details" }).click();

    // Back to board -> card is visible (in Review).
    await page.getByTestId("pipeline-run-back").click();
    await expect(boardCard(page, title)).toBeVisible();
  });

  test("blocked on a missing handoff: shows 'handoff-missing'; manual advance to the next step finishes the run", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
    // B overrides the goal's ":missing" marker with its own ":done" so a
    // manual advance to it actually finishes the run cleanly.
    const B = makeStep({
      id: randomUUID(),
      name: "B",
      agentProfileId: profileId,
      instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    });
    const pipelineId = await createPipelineRest(backend, "Missing Handoff Pipeline", [A, B], [{ from: A.id, to: B.id }]);
    const title = `Missing Handoff ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked", { timeout: CONVERGE_TIMEOUT });
    const blocked = page.getByTestId("pipeline-run-blocked");
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText("handoff-missing");

    const advance = blocked.getByTestId("pipeline-run-advance");
    await advance.getByRole("button", { name: "Pick next step(s)…" }).click();
    await advance.getByRole("button", { name: "B", exact: true }).click();
    // Close the popover before hitting Advance.
    await page.keyboard.press("Escape");
    await advance.getByRole("button", { name: "Advance", exact: true }).click();

    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(2);
    await waitForColumn(backend, task.id, "review");
  });

  test("blocked on an invalid handoff shows 'handoff-invalid'", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
    const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Invalid Handoff Pipeline", [A, B], [{ from: A.id, to: B.id }]);
    const title = `Invalid Handoff ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-blocked")).toContainText("handoff-invalid");
  });

  test("fan-out/join: A fans out to B and C in parallel; both show active at once; D (join: all) runs once and finishes", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, transition: "all" });
    const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
    const C = makeStep({ id: randomUUID(), name: "C", agentProfileId: profileId });
    const D = makeStep({ id: randomUUID(), name: "D", agentProfileId: profileId, join: "all" });
    const pipelineId = await createPipelineRest(
      backend,
      "Fan-out Join Pipeline",
      [A, B, C, D],
      [
        { from: A.id, to: B.id },
        { from: A.id, to: C.id },
        { from: B.id, to: D.id },
        { from: C.id, to: D.id },
      ],
    );
    const title = `Fan Out Join ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);

    // A active, then fans out: both B and C active at the same time.
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect
      .poll(
        async () => page.locator('[data-testid="pipeline-step-node"][data-visual="active"]').count(),
        { timeout: CONVERGE_TIMEOUT },
      )
      .toBe(2);
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "active");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "active");

    // D only runs once both arrive, then the whole run finishes.
    await expect(stepNode(page, D.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(4);

    const finalTask = await getTask(backend, task.id);
    expect(finalTask.pipelineRun?.history.filter((h) => h.stepId === D.id)).toHaveLength(1);
  });

  test("Stop cancels the run; Retry re-runs the same step task and it finishes", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Retry Pipeline", [A], []);
    const title = `Retry Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });

    await page.getByTestId("pipeline-run-stop").click();
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Cancelled", { timeout: CONVERGE_TIMEOUT });
    await waitForColumn(backend, task.id, "ready");

    const beforeRetry = await getTask(backend, task.id);
    expect(beforeRetry.pipelineRun?.active).toHaveLength(1);

    await page.getByTestId("pipeline-run-retry").click();
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Running", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });

    const finalTask = await getTask(backend, task.id);
    expect(finalTask.pipelineRun?.history).toHaveLength(1);
    expect(finalTask.column).toBe("review");
  });
});
