import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2e coverage for actually RUNNING a pipeline (docs/plans/pipelines.md
 * §5 row E2): New Task's Pipeline picker, the board's pipeline badge,
 * the full-page run view (node/edge visual states, history, blocked +
 * manual advance, Stop + Retry, fan-out/join, per-step subagent delegation
 * guidance in the composed step prompt), clicking a step node to open
 * its RunPanel with the pipeline strip, Settings' pipelines link, and the
 * step-attention highlight + "attention" landings
 * (docs/plans/pipeline-blocked-step-highlight.md, the "step attention"
 * describes at the end of the file).
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
// Mirrors `FAKE_CLAUDE_SUBAGENT_PROMPT_MARKER` in `src/bun/agents.ts` (literal
// copy — see that constant's doc comment): inside a fake handoff turn, spawn
// one subagent row for `:<ms>` described as `[<text>]`, then hand off.
const FAKE_CLAUDE_SUBAGENT_PROMPT_MARKER = "__agetor_fake_claude_subagent__";
// Long enough that the run view's 2s poll (+ its per-active-step
// `listSubagents` fetch) reliably observes the satellite in its "working"
// state before the fake subagent settles, even under load.
const SUBAGENT_RUN_MS = 6000;
// Wide enough that a step's "active" visual is observable at all — the fake
// driver's default (~30ms) resolves before the run view could even poll it.
// Tests that assert on "active" additionally open the run view BEFORE
// starting the task (see the linear scenario), since even 3s is not enough
// headroom for a full page load under parallel-run load.
const RESOLVE_DELAY_MS = "3000";
const CONVERGE_TIMEOUT = 20_000;
// A "handoff-missing"/"handoff-invalid" classification now costs TWO
// fake-driver turns before the run actually blocks (65f8a75): the original
// turn, then the runner's one automatic reminder round-trip (a fresh
// `sendInput` turn on the same step task, which itself pays the same
// RESOLVE_DELAY_MS). Scenarios that exercise that reminder path need extra
// headroom over the single-turn CONVERGE_TIMEOUT above.
const REMINDER_TIMEOUT = 35_000;

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
  subagents?: { profileIds: string[]; cap: number | null };
}

function makeStep(input: StepInput) {
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions ?? "",
    agentProfileId: input.agentProfileId,
    position: { x: 0, y: 0 },
    subagents: input.subagents ?? { profileIds: [], cap: null },
    transition: input.transition ?? "choose",
    join: input.join ?? "any",
  };
}

async function createProfileRest(
  backend: E2EBackend,
  name: string,
  opts: { instructions?: string; skills?: string[] } = {},
): Promise<string> {
  const res = await fetch(`${backend.apiBase}/agent-profiles`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({
      name,
      harness: "claude-code",
      model: "opus-5",
      instructions: opts.instructions ?? "",
      skills: opts.skills ?? [],
    }),
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
  pendingInteractionCount?: number;
  pipelineId: string | null;
  pipelineParentId?: string | null;
  pipelineRun: {
    status: string;
    startedAt: number | null;
    active: { stepId: string; taskId: string }[];
    blocked: { taskId: string | null; stepId: string | null; kind: string; message: string }[];
    history: { stepId: string; taskId: string; outcome: string | null; startedAt: number }[];
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

// `run.history` renders newest-first (`[...run.history].reverse()` in
// PipelineRunView), so a linear pipeline's history rows are NOT in step
// execution order — pick a step's own row by the "#<seq> <stepName>" text
// `HistoryRow` renders at the start of its button, rather than relying on
// list position. No `\b`/whitespace after the step name: the button's
// "#<seq> <stepName>" span and the outcome span right after it
// (`succeeded · 3s`) are separate DOM text nodes with no literal space
// between them, so `textContent` glues them together (e.g. "#1 Asucceeded
// · 6s") — a trailing `\b` would never match. The step names used in this
// file are single, non-prefixing letters (A/B/C/D), so a bare prefix match
// is unambiguous.
function historyRowFor(page: Page, stepName: string): Locator {
  return page
    .locator('[data-testid="pipeline-run-history-row"]')
    .filter({ hasText: new RegExp(`^#\\d+ ${stepName}`) });
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

  // Fixed regression (was `test.fixme`): `PipelineRunView` used to throw a
  // React "Maximum update depth exceeded" error — reproducible on every run
  // of this test, and of the "blocked on a missing handoff" and
  // "fan-out/join" tests below — as soon as the run view had to re-render a
  // graph with at least one EDGE and a step transition/advance actually
  // happened (React Flow's `<StoreUpdater>` fed a perpetually-new `edges`
  // reference because `latestTransition(run)` was computed inline in the
  // render body). Root-caused and fixed in `PipelineRunView.tsx` — see its
  // class doc comment for the full three-part fix (content-stable
  // `transition`, signature-keyed merge effects, identity-stable mergers).
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
    // Open the run view FIRST (a pipeline card routes to the run view even
    // before its first run — the view falls back to the live graph until a
    // snapshot exists), THEN start: otherwise the page load can outlast the
    // fake driver's RESOLVE_DELAY_MS under parallel-run load and the first
    // step is already "done" by the time this test looks for "active".
    await openPipelineRunFromBoard(page, backend, title);
    await startTaskRest(backend, task.id);

    // Node visuals cycle: A active, then B active (A done), then C active
    // (B done), then all done.
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "done");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "done");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done");

    // The handoff token rides the LATEST transition's edge — after the run
    // settles that's B->C (C's own record is terminal), so exactly one
    // token is painted, on that edge, and both edges read traversed.
    const tokens = page.locator('[data-testid="pipeline-step-edge-token"]');
    await expect(tokens).toHaveCount(1);
    await expect(page.locator('[data-testid="pipeline-step-edge"][data-visual="traversed"]')).toHaveCount(2);

    const historyRows = page.locator('[data-testid="pipeline-run-history-row"]');
    await expect(historyRows).toHaveCount(3);
    // 65f8a75 added a response-kind chip under each row's toggle button
    // (`responseKind` is now stamped on every settled record, not just a
    // reminded one), which grew the row's height enough that a plain
    // click on the row's own center can miss the button — click the
    // button itself instead of relying on that coincidence.
    await historyRows.first().getByRole("button").first().click();
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
    // "Open pipeline" closes the RunPanel before navigating (m22b: the
    // run view would otherwise open behind the non-portaled `<aside>`,
    // reading as if the click did nothing) — so there's no panel left to
    // close afterward; go straight back to the board.
    await panel.getByTestId("run-panel-open-pipeline").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    // Back to board -> card is visible (in Review).
    await page.getByTestId("pipeline-run-back").click();
    await expect(boardCard(page, title)).toBeVisible();
  });

  // Per-step subagent delegation is prompt-injected guidance only (agetor
  // never controls a harness's real subagents — docs/plans/pipelines.md
  // D6): the step task's composed prompt carries a `## Delegation` section
  // naming each allowed profile (name / harness / model / effort /
  // instructions / skills) and the cap, or "Do not spawn subagents for
  // this step." when the step allows none. The composed prompt is what
  // `startTask`'s prompt echo renders as the step task's first user bubble,
  // so opening a step's RunPanel from the run view is the one surface that
  // proves what the agent was actually told.
  test("step subagents: the step task's prompt carries the injected Delegation guidance (allowed profiles + cap), and none for a step without delegates", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const helperOneId = await createProfileRest(backend, "Helper One", {
      instructions: "Review every test file twice before reporting.",
      skills: ["code-review"],
    });
    const helperTwoId = await createProfileRest(backend, "Helper Two");
    const A = makeStep({
      id: randomUUID(),
      name: "A",
      agentProfileId: profileId,
      // A's own instructions also make the fake driver "spawn" one subagent
      // whose description names Helper One — the run view attributes it to
      // that persona's satellite.
      instructions: `${FAKE_CLAUDE_SUBAGENT_PROMPT_MARKER}:${SUBAGENT_RUN_MS}[Helper One: review the tests]`,
      subagents: { profileIds: [helperOneId, helperTwoId], cap: 2 },
    });
    const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Delegation Pipeline", [A, B], [{ from: A.id, to: B.id }]);
    const title = `Delegation Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    // Open the run view FIRST (see the linear scenario for why), then start.
    await openPipelineRunFromBoard(page, backend, title);
    // Satellites render from the pipeline's graph before the first run:
    // A's two personas + none for B, all idle, each linked to its step.
    const helperOneNode = page.locator(`[data-testid="pipeline-subagent-node"][data-profile-id="${helperOneId}"]`);
    const helperTwoNode = page.locator(`[data-testid="pipeline-subagent-node"][data-profile-id="${helperTwoId}"]`);
    await expect(helperOneNode).toHaveAttribute("data-step-id", A.id);
    await expect(helperTwoNode).toHaveAttribute("data-visual", "idle");
    await expect(page.locator(`[data-testid="pipeline-subagent-node"][data-step-id="${B.id}"]`)).toHaveCount(0);
    await expect(page.locator('[data-testid="pipeline-subagent-edge"]')).toHaveCount(2);
    await startTaskRest(backend, task.id);

    // While A's fake subagent runs, Helper One's satellite (and only that
    // one) animates as working — its edge marches too — then reads done
    // once the subagent settled, and stays done after the whole run ends.
    await expect(helperOneNode).toHaveAttribute("data-visual", "working", { timeout: CONVERGE_TIMEOUT });
    await expect(helperTwoNode).toHaveAttribute("data-visual", "idle");
    await expect(
      page.locator(`[data-testid="pipeline-subagent-edge"][data-visual="working"]`),
    ).toHaveCount(1);
    await expect(helperOneNode).toHaveAttribute("data-visual", "done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await waitForColumn(backend, task.id, "review");
    await expect(helperOneNode).toHaveAttribute("data-visual", "done");
    await expect(helperTwoNode).toHaveAttribute("data-visual", "idle");

    // Clicking a satellite opens that persona's details: its profile, the
    // step that delegates to it, and every helper spawned for it — here the
    // one fake helper, finished — each openable on its own transcript tab.
    await helperOneNode.click({ force: true });
    const details = page.getByTestId("subagent-details-dialog");
    await expect(details).toBeVisible();
    await expect(details.getByTestId("subagent-details-name")).toHaveText("Helper One");
    await expect(details.getByTestId("subagent-details-instructions")).toContainText("Review every test file twice");
    await expect(details).toContainText("at most 2 subagents");
    const instance = details.locator('[data-testid="subagent-details-instance"]');
    await expect(instance).toHaveCount(1);
    await expect(instance).toHaveAttribute("data-status", "completed");
    await expect(instance).toContainText("Helper One: review the tests");
    const helperSubagentId = await instance.getAttribute("data-subagent-id");
    await details.getByTestId("subagent-details-open-transcript").click();
    await expect(details).toBeHidden();
    // The step task's panel opens ON that helper's tab (kept visible even
    // though everything has finished), not on the Main stream.
    let helperPanel = page.locator("aside").last();
    await expect(helperPanel.getByTestId("run-panel-pipeline-strip")).toContainText("A");
    const helperTab = helperPanel.locator(`[data-testid="subagent-tab"][data-subagent-id="${helperSubagentId}"]`);
    await expect(helperTab).toHaveAttribute("aria-selected", "true", { timeout: CONVERGE_TIMEOUT });
    await helperPanel.getByTestId("run-panel-open-pipeline").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    // Helper Two never ran: its details say so and list no helpers.
    await helperTwoNode.click({ force: true });
    await expect(details).toBeVisible();
    await expect(details.getByTestId("subagent-details-name")).toHaveText("Helper Two");
    await expect(details.getByTestId("subagent-details-none")).toBeVisible();
    await details.getByTestId("subagent-details-close").click();
    await expect(details).toBeHidden();

    // B allows no delegates -> the explicit "do not spawn" line, and none
    // of A's helper names leak into B's prompt.
    await stepNode(page, B.id).click();
    let panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toContainText("B");
    let log = panel.getByTestId("transcript-log");
    await expect(log).toContainText("Do not spawn subagents for this step.", { timeout: CONVERGE_TIMEOUT });
    await expect(log).not.toContainText("Helper One");
    await panel.getByTestId("run-panel-open-pipeline").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    // A: the cap line plus one row per allowed profile, with Helper One's
    // instructions and skill rendered so the step can brief its subagents.
    await stepNode(page, A.id).click();
    panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toContainText("A");
    log = panel.getByTestId("transcript-log");
    await expect(log).toContainText("Delegation", { timeout: CONVERGE_TIMEOUT });
    await expect(log).toContainText("You may delegate to subagents. Limit: 2 subagent(s).");
    await expect(log).toContainText("Helper One");
    await expect(log).toContainText("Helper Two");
    await expect(log).toContainText("Review every test file twice before reporting.");
    await expect(log).toContainText("/code-review");
    await expect(log).not.toContainText("Do not spawn subagents for this step.");

    // Leave the guidance on screen for the end-of-test screenshot: expand
    // the (long) prompt bubble if it's folded, then scroll the section into
    // view.
    const showMore = log.getByRole("button", { name: "Show more", exact: true });
    if ((await showMore.count()) > 0) await showMore.first().click();
    await log.getByText("You may delegate to subagents. Limit: 2 subagent(s).").scrollIntoViewIfNeeded();
  });

  // Fixed regression (was `test.fixme`) — same "Maximum update depth
  // exceeded" / React Flow `StoreUpdater` crash documented on the "linear
  // A->B->C run" test above, which used to strike right after the manual
  // Advance here (a real edge/step transition).
  //
  // 65f8a75: a "handoff-missing" response no longer blocks the run
  // immediately — the runner first sends ONE automatic reminder (an
  // ordinary follow-up `sendInput` turn on A's own step task) and only
  // blocks if A's NEXT reply still lacks a valid `<handoff>`. A's own
  // `:missing` marker (from the goal text, unqualified by any
  // `-then-<token>` suffix) behaves identically on every turn, so the
  // reminder doesn't fix anything here — it just costs one extra
  // RESOLVE_DELAY_MS round trip before the run actually blocks.
  test("blocked on a missing handoff: sends one reminder, then blocks with 'handoff-missing'; manual advance to the next step finishes the run", async ({
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

    // The reminder round-trip: A's first reply lacks a `<handoff>`, so the
    // runner sends the one automatic reminder and the execution stays
    // active (no block yet) — the reminder chip lands on A's own history
    // row well before the run ever reaches "Blocked".
    await expect(page.getByTestId("pipeline-run-reminder")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(
      page.locator('[data-testid="pipeline-run-response-kind"][data-kind="handoff-missing"]'),
    ).toBeVisible();

    // A's second reply is still marker-less (`:missing` has no `-then-`
    // suffix, so it behaves the same on every turn) — the run now blocks,
    // and the message is prefixed to say a reminder already went out.
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked", { timeout: REMINDER_TIMEOUT });
    const blocked = page.getByTestId("pipeline-run-blocked");
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText("handoff-missing");
    await expect(blocked).toContainText("after one reminder");

    // Step A's own board column is "review" (the generic exit-0 settle
    // path) even though the pipeline itself never advanced past it — but
    // `PipelineRunView`'s `reviewActive` deliberately excludes any active
    // execution that ALSO has a `run.blocked` entry for the same taskId (a
    // fixed dedup finding: it used to render a second "Awaiting review"
    // Advance form for the same execution already shown in the blocked
    // section above). So the "Awaiting review" section does NOT appear
    // here — only the one Advance form, inside the blocked entry itself.
    await expect(page.getByTestId("pipeline-run-review")).toHaveCount(0);

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

  // 65f8a75: same one-reminder-then-block flow as the "missing handoff"
  // scenario above — A's plain `:invalid` marker (no `-then-` suffix)
  // behaves identically across both turns, so this still ends up blocked,
  // just after one extra RESOLVE_DELAY_MS round trip for the reminder.
  test("blocked on an invalid handoff shows 'handoff-invalid' after the one reminder", async ({ page, freshBackend }) => {
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
    await expect(page.getByTestId("pipeline-run-reminder")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked", { timeout: REMINDER_TIMEOUT });
    const blocked = page.getByTestId("pipeline-run-blocked");
    await expect(blocked).toContainText("handoff-invalid");
    await expect(blocked).toContainText("after one reminder");
  });

  // 65f8a75: `:missing-then-done` behaves like `:missing` (no `<handoff>`
  // block) on a step task's FIRST fake-driver turn, and like `:done` (a
  // valid terminal handoff) on every turn after — i.e. exactly what the
  // runner's one automatic reminder is supposed to fix. A only carries the
  // marker via its own `instructions` (not the shared goal text), so B
  // never sees it and needs its own `:done` override to finish cleanly.
  test("missing-then-done: A gets one automatic reminder, then hands off cleanly with no blocked banner", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({
      id: randomUUID(),
      name: "A",
      agentProfileId: profileId,
      instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-done`,
    });
    const B = makeStep({
      id: randomUUID(),
      name: "B",
      agentProfileId: profileId,
      instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    });
    const pipelineId = await createPipelineRest(
      backend,
      "Missing Then Done Pipeline",
      [A, B],
      [{ from: A.id, to: B.id }],
    );
    const title = `Missing Then Done ${randomUUID()}`;
    const task = await createPipelineTaskRest(backend, title, pipelineId, "Do the thing.");
    // Open the run view FIRST (a pipeline card routes to the run view even
    // before its first run — the view falls back to the live graph until a
    // snapshot exists), THEN start: otherwise the page load can outlast the
    // fake driver's RESOLVE_DELAY_MS under parallel-run load and the first
    // step is already "done" by the time this test looks for "active".
    await openPipelineRunFromBoard(page, backend, title);
    await startTaskRest(backend, task.id);

    // A goes active, misses the handoff on its first reply, and gets
    // reminded while still active — the glyph only renders on an ACTIVE
    // node, so poll for it rather than a one-shot check.
    await expect(stepNode(page, A.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, A.id).getByTestId("pipeline-step-reminded")).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });

    // The reminder fixes it: A's second reply carries a valid handoff, the
    // run advances to B, and B finishes the whole thing — no blocked
    // banner anywhere along the way.
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: REMINDER_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-blocked")).toHaveCount(0);
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(2);

    const rowA = historyRowFor(page, "A");
    await expect(rowA).toHaveCount(1);
    await expect(rowA.getByTestId("pipeline-run-reminder")).toBeVisible();
    await expect(rowA.locator('[data-testid="pipeline-run-response-kind"][data-kind="handoff"]')).toBeVisible();

    // Opening A's step RunPanel shows the reminder itself as an ordinary
    // user bubble — the runner delivers it through `sendInput`, exactly
    // like a human-typed follow-up.
    await stepNode(page, A.id).click();
    const panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible();
    // The marker line itself is hidden from the rendered bubble (display-only);
    // the bubble carries an "Automatic handoff reminder" badge instead, and
    // the body still shows the contract the reminder repeats.
    await expect(panel.getByTestId("handoff-reminder-badge").first()).toBeVisible();
    const reminderBubble = panel
      .locator("div.rounded-2xl.rounded-br-md")
      .filter({ hasText: "Reply with ONLY the handoff block" });
    await expect(reminderBubble.first()).toBeVisible();

    await waitForColumn(backend, task.id, "review");
  });

  // 65f8a75: `:invalid-then-done` is `:invalid`'s two-turn sibling — an
  // unparsable `<handoff>` JSON on the first turn, a valid one on the
  // second. Single-step pipeline (no B) so the final history record is
  // unambiguous: one row, carrying both the reminder and the eventual
  // "handoff" classification.
  test("invalid-then-done: one automatic reminder after an unparsable handoff, then hands off cleanly", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({
      id: randomUUID(),
      name: "A",
      agentProfileId: profileId,
      instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid-then-done`,
    });
    const pipelineId = await createPipelineRest(backend, "Invalid Then Done Pipeline", [A], []);
    const title = `Invalid Then Done ${randomUUID()}`;
    const task = await createPipelineTaskRest(backend, title, pipelineId, "Do the thing.");
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: REMINDER_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-blocked")).toHaveCount(0);

    const rows = page.locator('[data-testid="pipeline-run-history-row"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('[data-testid="pipeline-run-response-kind"][data-kind="handoff"]')).toBeVisible();
    await expect(rows.getByTestId("pipeline-run-reminder")).toBeVisible();

    await waitForColumn(backend, task.id, "review");
  });

  // Fixed regression (was `test.fixme`) — same "Maximum update depth
  // exceeded" / React Flow `StoreUpdater` crash documented on the "linear
  // A->B->C run" test above. This pipeline has four edges and two real
  // transitions (the fan-out and the join), so it used to hit the crash too.
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
    // Open the run view FIRST (a pipeline card routes to the run view even
    // before its first run — the view falls back to the live graph until a
    // snapshot exists), THEN start: otherwise the page load can outlast the
    // fake driver's RESOLVE_DELAY_MS under parallel-run load and the first
    // step is already "done" by the time this test looks for "active".
    await openPipelineRunFromBoard(page, backend, title);
    await startTaskRest(backend, task.id);

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
    // One fan-out record launched BOTH branches, so a handoff token is
    // painted on each of A's outgoing edges — not just the first target.
    // Asserted in the same tick as the two-active observation above (the
    // tokens derive from the same fetched run), before either branch can
    // hand off to D and move the latest transition.
    await expect(page.locator('[data-testid="pipeline-step-edge-token"]')).toHaveCount(2);

    // D only runs once both arrive, then the whole run finishes.
    await expect(stepNode(page, D.id)).toHaveAttribute("data-visual", "active", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(4);

    const finalTask = await getTask(backend, task.id);
    expect(finalTask.pipelineRun?.history.filter((h) => h.stepId === D.id)).toHaveLength(1);
  });

  // A running helper whose description names NO configured persona renders
  // as a transient `kind="live"` satellite (labelled from its own
  // description) for as long as it runs, then disappears — the configured
  // persona it did NOT match stays idle throughout.
  test("a running subagent matching no persona renders as a transient live satellite, gone once it finishes", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const helperOneId = await createProfileRest(backend, "Helper One");
    const A = makeStep({
      id: randomUUID(),
      name: "A",
      agentProfileId: profileId,
      // "Scout" is nobody's persona name — the attribution must fail and
      // fall through to a live satellite rather than claim Helper One.
      instructions: `${FAKE_CLAUDE_SUBAGENT_PROMPT_MARKER}:${SUBAGENT_RUN_MS}[Scout: look around the repo]`,
      subagents: { profileIds: [helperOneId], cap: null },
    });
    const pipelineId = await createPipelineRest(backend, "Live Satellite Pipeline", [A], []);
    const title = `Live Satellite Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await openPipelineRunFromBoard(page, backend, title);
    const helperOneNode = page.locator(`[data-testid="pipeline-subagent-node"][data-profile-id="${helperOneId}"]`);
    await expect(helperOneNode).toHaveAttribute("data-visual", "idle");
    await startTaskRest(backend, task.id);

    const live = page.locator(`[data-testid="pipeline-subagent-node"][data-kind="live"][data-step-id="${A.id}"]`);
    await expect(live).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(live).toHaveAttribute("data-visual", "working");
    await expect(live).toContainText("Scout: look around the repo");
    await expect(page.locator('[data-testid="pipeline-subagent-edge"][data-visual="working"]')).toHaveCount(1);
    await expect(helperOneNode).toHaveAttribute("data-visual", "idle");

    // Finished unmatched helpers aren't shown — nothing to attribute them to.
    await expect(live).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(helperOneNode).toHaveAttribute("data-visual", "idle");
    await expect(live).toHaveCount(0);
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
    // Open the run view FIRST (a pipeline card routes to the run view even
    // before its first run — the view falls back to the live graph until a
    // snapshot exists), THEN start: otherwise the page load can outlast the
    // fake driver's RESOLVE_DELAY_MS under parallel-run load and the first
    // step is already "done" by the time this test looks for "active".
    await openPipelineRunFromBoard(page, backend, title);
    await startTaskRest(backend, task.id);
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

  test("Restart runs a finished pipeline again from the top: confirm dialog, status cycles running->done, history restarts", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Restart Pipeline", [A], []);
    const title = `Restart Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);

    await openPipelineRunFromBoard(page, backend, title);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(1);

    const beforeRestart = await getTask(backend, task.id);
    const firstRunStartedAt = beforeRestart.pipelineRun?.startedAt ?? null;
    const firstHistoryStartedAt = beforeRestart.pipelineRun?.history[0]?.startedAt ?? null;
    expect(firstRunStartedAt).not.toBeNull();
    expect(firstHistoryStartedAt).not.toBeNull();

    await page.getByTestId("pipeline-run-restart").click();
    const confirmDialog = page.getByRole("dialog").filter({ hasText: "Restart this pipeline?" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(confirmDialog).toBeHidden();

    // A genuine fresh run: status cycles back through "Running" (`launchStep`
    // pushes a new, still-`outcome: null` history record the moment the
    // restarted step launches, so the history list is never observably
    // empty — it's a FRESH single-entry list from the very first tick, not
    // the same list emptied out) and back to "Done" once the single step
    // re-completes, still with exactly one history row — not two, which
    // would mean the old run's history survived instead of being replaced.
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Running", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.locator('[data-testid="pipeline-run-history-row"]')).toHaveCount(1);
    await waitForColumn(backend, task.id, "review");

    // Not a no-op: the run's own `startedAt` and its (sole) history entry's
    // `startedAt` both moved forward, proving a fresh run actually happened
    // rather than the prior run's state being redisplayed untouched.
    const afterRestart = await getTask(backend, task.id);
    expect(afterRestart.pipelineRun?.startedAt).not.toBe(firstRunStartedAt);
    expect(afterRestart.pipelineRun?.history[0]?.startedAt).not.toBe(firstHistoryStartedAt);

    // Restart is offered again once the new run has itself finished.
    await expect(page.getByTestId("pipeline-run-restart")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Stopping ONE branch of a fan-out from that step's own RunPanel (the
// ordinary per-task Stop, not the run view's whole-pipeline Stop): the
// runner records a per-task `step-failed` "was stopped" block on that
// execution so the run reads Blocked — never Cancelled (the sibling branch
// is still genuinely live), and never a silently-stuck Running. Its own
// describe so the fake driver's resolve delay can be widened well past the
// other scenarios': the branch has to still be mid-turn when the panel's
// Stop is clicked, after the run view observed both branches active and
// the branch's RunPanel finished opening.
// ---------------------------------------------------------------------------

const BRANCH_STOP_RESOLVE_DELAY_MS = "10000";

test.describe("pipelines run: stopping one fan-out branch", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: BRANCH_STOP_RESOLVE_DELAY_MS } });
  // Three fake turns of BRANCH_STOP_RESOLVE_DELAY_MS each (A, then the B/C
  // fan-out) plus the settle round-trips already exceed the default 30 s
  // budget under parallel-run load — the sibling C's "done" is the last
  // thing asserted and lands ~25 s in on a quiet machine.
  test.setTimeout(90_000);

  test("Stop on one branch's step task records a 'was stopped' block; the run reads Blocked while the sibling finishes", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, transition: "all" });
    const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId });
    const C = makeStep({ id: randomUUID(), name: "C", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(
      backend,
      "Branch Stop Pipeline",
      [A, B, C],
      [
        { from: A.id, to: B.id },
        { from: A.id, to: C.id },
      ],
    );
    const title = `Branch Stop Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await openPipelineRunFromBoard(page, backend, title);
    await startTaskRest(backend, task.id);

    // A finishes (one resolve delay), then B and C run in parallel.
    await expect
      .poll(
        async () => page.locator('[data-testid="pipeline-step-node"][data-visual="active"]').count(),
        { timeout: CONVERGE_TIMEOUT },
      )
      .toBe(2);
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "active");
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "active");

    // Open B's own RunPanel and press ITS Stop (the per-task cancel).
    await stepNode(page, B.id).click();
    const panel = page.locator("aside").last();
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toContainText("B");
    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    // Back to the run view (the panel sits on top of it).
    await panel.getByTestId("run-panel-open-pipeline").click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();

    // The stopped branch is blocked with the runner's "was stopped" copy;
    // the run reads Blocked — not Cancelled, since C is still live.
    await expect(page.getByTestId("pipeline-run-blocked")).toContainText("was stopped", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked");
    await expect(stepNode(page, B.id)).toHaveAttribute("data-visual", "blocked");
    await expect(page.getByTestId("pipeline-run-stop")).toBeVisible(); // C is still running

    // C finishes on its own; the block just sits there until a Retry or an
    // Advance resolves it, so the run stays Blocked rather than flipping to
    // Done or Cancelled.
    await expect(stepNode(page, C.id)).toHaveAttribute("data-visual", "done", { timeout: CONVERGE_TIMEOUT });
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Blocked");
    await expect(page.getByTestId("pipeline-run-blocked")).toContainText("was stopped");

    const finalTask = await waitForPipelineStatus(backend, task.id, "blocked");
    const stoppedBlock = finalTask.pipelineRun?.blocked.find((b) => b.message.includes("was stopped"));
    expect(stoppedBlock?.taskId).toBeTruthy();
    expect(stoppedBlock?.stepId).toBe(B.id);
    expect(finalTask.pipelineRun?.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Step attention (docs/plans/pipeline-blocked-step-highlight.md): a step
// that needs the user wears the board card's amber look on the run-view
// canvas (`data-attention` + the `pipeline-step-attention` chip), and the
// "attention" paths — the card's amber Answer/Review button and the toasts —
// land on the run view PLUS that step's RunPanel, while the card body stays a
// run-view-only "browse" path that closes any leftover panel.
// ---------------------------------------------------------------------------

// Mirrors `FAKE_FX_PERMISSION_PROMPT_MARKER` in `src/bun/agents.ts` (literal
// copy, same reason as the handoff marker above): a fake turn whose prompt
// carries it registers a real pending `fx_permission` card on its task and
// only resolves once that card is answered — so a step whose own
// instructions carry it sits mid-turn "asking the user", aggregated onto the
// pipeline parent's `pendingInteractionCount`. Checked AFTER the handoff
// marker, so the goal text of these scenarios must not carry one.
const FAKE_FX_PERMISSION_PROMPT_MARKER = "__agetor_fake_fx_permission__";
// The fake driver registers that card the instant its turn spawns — before
// the runner's own post-launch `persist`, whose `pipeline` event (status
// `running`) makes App drop the parent's pending "Waiting on you" toast.
// Delaying the fake SPAWN past `SPAWN_RESPONSE_BUDGET_MS` (1.5 s) lets the
// launch return `pending` and persist first, so the question — and its
// toast — land afterwards, the way a real agent's question does.
const ASK_SPAWN_DELAY_MS = "3000";

/** Open the board and wait until the app's single global-events
 *  `EventSource` (`GET /events`) has been requested — toasts are live-only,
 *  so a task started before the subscription exists never toasts. Waits on
 *  the REQUEST, not a response: see `e2e/sent-files.spec.ts`'s identical
 *  wait for why. */
async function gotoAppSubscribed(page: Page, backend: E2EBackend): Promise<void> {
  const globalEventsRequested = page.waitForRequest((r) => new URL(r.url()).pathname === "/events");
  await gotoApp(page, backend.bootBase);
  await globalEventsRequested;
}

async function waitForPendingCount(backend: E2EBackend, id: string, expected: number): Promise<void> {
  await expect(async () => {
    const row = await getTask(backend, id);
    expect(row.pendingInteractionCount ?? 0).toBe(expected);
  }).toPass({ timeout: CONVERGE_TIMEOUT });
}

/** Wait until the board's own 2 s `/tasks` poll has delivered a step row of
 *  `parentId` (with a pending question, when `pending` is set). The
 *  attention landings resolve the step from App's already-polled list and
 *  never fetch (plan D13) — a click inside the poll window after a step was
 *  created lands on the run view alone, by design — so a test clicking an
 *  attention path waits for the poll first. */
async function waitForPolledStep(page: Page, parentId: string, opts: { pending?: boolean } = {}): Promise<void> {
  await page.waitForResponse(
    async (r) => {
      if (r.request().method() !== "GET" || new URL(r.url()).pathname !== "/tasks") return false;
      const rows = (await r.json().catch(() => [])) as TaskRow[];
      return rows.some(
        (t) => t.pipelineParentId === parentId && (!opts.pending || (t.pendingInteractionCount ?? 0) > 0),
      );
    },
    { timeout: CONVERGE_TIMEOUT },
  );
}

function attentionChip(page: Page, stepId: string): Locator {
  return stepNode(page, stepId).getByTestId("pipeline-step-attention");
}

function waitingToast(page: Page): Locator {
  return page.locator("[data-sonner-toaster] [data-sonner-toast]").filter({ hasText: "Waiting on you" });
}

/** "No run panel at all" — RunPanel returns null once closed (after its
 *  exit animation), so its resize handle is the reliable probe. */
function runPanelHandle(page: Page): Locator {
  return page.getByTestId("run-panel-resize");
}

/** Pipeline "Asker" -> "Follower" whose first step asks the user mid-turn
 *  (a pending `fx_permission` card), with the goal text carrying no
 *  handoff marker. */
async function createAskingPipelineTask(
  backend: E2EBackend,
): Promise<{ asker: ReturnType<typeof makeStep>; follower: ReturnType<typeof makeStep>; task: TaskRow; title: string }> {
  const profileId = await createProfileRest(backend, "Runner");
  const asker = makeStep({
    id: randomUUID(),
    name: "Asker",
    agentProfileId: profileId,
    instructions: `Ask before writing. ${FAKE_FX_PERMISSION_PROMPT_MARKER}`,
  });
  const follower = makeStep({ id: randomUUID(), name: "Follower", agentProfileId: profileId });
  const pipelineId = await createPipelineRest(
    backend,
    "Attention Pipeline",
    [asker, follower],
    [{ from: asker.id, to: follower.id }],
  );
  const title = `Attention Run ${randomUUID()}`;
  const task = await createPipelineTaskRest(backend, title, pipelineId, "Do the thing.");
  return { asker, follower, task, title };
}

test.describe("pipelines run: step attention — a step asking mid-turn", () => {
  test.use({
    backendEnv: {
      AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: RESOLVE_DELAY_MS,
      AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: ASK_SPAWN_DELAY_MS,
    },
  });

  test("the card's Answer opens the run view plus the asking step's panel; the node reads Answer in amber", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const { asker, follower, task, title } = await createAskingPipelineTask(backend);
    await gotoAppSubscribed(page, backend);
    await startTaskRest(backend, task.id);
    await waitForPendingCount(backend, task.id, 1);
    // The question raised the parent-keyed "Waiting on you" toast.
    await expect(waitingToast(page)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await waitForPolledStep(page, task.id, { pending: true });

    const answer = boardCard(page, title).getByRole("button", { name: "Answer", exact: true });
    await expect(answer).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await answer.click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("run-panel-pipeline-strip")).toContainText("step Asker");
    // Amber over blue: the asking step is still mid-turn (`data-visual`
    // stays "active"), but it wears the attention look and says Answer.
    await expect(stepNode(page, asker.id)).toHaveAttribute("data-attention", "answer", { timeout: CONVERGE_TIMEOUT });
    await expect(stepNode(page, asker.id)).toHaveAttribute("data-visual", "active");
    await expect(attentionChip(page, asker.id)).toHaveText("Answer");
    await expect(attentionChip(page, asker.id)).toHaveAttribute("title", "Waiting for your answer");
    await expect(stepNode(page, follower.id)).not.toHaveAttribute("data-attention", /.+/);
    // Landing on the step dismissed the parent-keyed toast too.
    await expect(waitingToast(page)).toHaveCount(0);
  });

  test("the card body stays a run-view-only path: no step panel opens", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { asker, task, title } = await createAskingPipelineTask(backend);
    await gotoApp(page, backend.bootBase);
    await startTaskRest(backend, task.id);
    await waitForPendingCount(backend, task.id, 1);
    await waitForPolledStep(page, task.id, { pending: true });
    await expect(boardCard(page, title).getByRole("button", { name: "Answer", exact: true })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });

    await boardCard(page, title).getByText(title, { exact: true }).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(stepNode(page, asker.id)).toHaveAttribute("data-attention", "answer", { timeout: CONVERGE_TIMEOUT });
    await expect(runPanelHandle(page)).toHaveCount(0);
  });

  test("the 'Waiting on you' toast's Open lands on the step that asked", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const { asker, task, title } = await createAskingPipelineTask(backend);
    await gotoAppSubscribed(page, backend);
    await startTaskRest(backend, task.id);

    const toastEl = waitingToast(page);
    await expect(toastEl).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    // Retargeted at the parent: its title, with the asking step named.
    await expect(toastEl).toContainText(title);
    await waitForPolledStep(page, task.id);
    await toastEl.getByRole("button", { name: "Open", exact: true }).click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("run-panel-pipeline-strip")).toContainText("step Asker");
    await expect(stepNode(page, asker.id)).toHaveAttribute("data-attention", "answer", { timeout: CONVERGE_TIMEOUT });
    await expect(waitingToast(page)).toHaveCount(0);
  });
});

test.describe("pipelines run: step attention — run-view-only landings", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: RESOLVE_DELAY_MS } });

  // A panel can only be "left over" under a run-view-only landing through a
  // path that's clickable while it's open — the panel's backdrop covers the
  // board and the run view, but not the toasts. Here: another task's panel
  // is open when the "Pipeline finished" toast (a run-view-only landing)
  // is clicked.
  test("a run-view-only landing closes another task's run panel left open", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    await gotoAppSubscribed(page, backend);

    const plainTitle = `Plain Task ${randomUUID()}`;
    const plainRes = await fetch(`${backend.apiBase}/tasks`, {
      method: "POST",
      headers: auth(backend),
      body: JSON.stringify({ title: plainTitle, prompt: "Just finish.", isolation: "none", workdir: tmpdir() }),
    });
    if (!plainRes.ok) throw new Error(`POST /tasks -> ${plainRes.status}: ${await plainRes.text()}`);
    const plain = (await plainRes.json()) as TaskRow;
    await startTaskRest(backend, plain.id);
    await waitForColumn(backend, plain.id, "review");

    await boardCard(page, plainTitle).getByText(plainTitle, { exact: true }).click();
    await expect(runPanelHandle(page)).toHaveCount(1);

    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "Only", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Finishing Pipeline", [A], []);
    const title = `Finishing Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);

    const finished = page
      .locator("[data-sonner-toaster] [data-sonner-toast]")
      .filter({ hasText: "Pipeline finished" });
    await expect(finished).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await finished.getByRole("button", { name: "Open", exact: true }).click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done");
    await expect(runPanelHandle(page)).toHaveCount(0);
  });
});

test.describe("pipelines run: step attention — an errored step", () => {
  // A nested `test.use` REPLACES the whole `backendEnv` object, so the
  // resolve delay has to be listed again next to the error seam.
  test.use({
    backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: RESOLVE_DELAY_MS, AGETOR_FAKE_CLAUDE_API_ERROR: "1" },
  });

  test("the card's Review opens the run view plus the errored step's panel; the node reads Review", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "Errored", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "Error Pipeline", [A], []);
    const title = `Error Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(backend, title, pipelineId, "Do the thing.");
    await startTaskRest(backend, task.id);
    // The step's own `blocked` column lands first (a column-reasoned
    // block); the settled run then records the final `step-failed` one —
    // wait for that, since its message is what the chip's tooltip shows.
    let blockMessage = "";
    await expect(async () => {
      const row = await getTask(backend, task.id);
      const block = row.pipelineRun?.blocked.find((b) => b.stepId === A.id && b.kind === "step-failed");
      expect(block).toBeTruthy();
      expect(row.column).toBe("blocked");
      blockMessage = block!.message;
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    await gotoApp(page, backend.bootBase);
    const review = boardCard(page, title).getByRole("button", { name: "Review", exact: true });
    await expect(review).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await review.click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("run-panel-pipeline-strip")).toContainText("step Errored");
    await expect(stepNode(page, A.id)).toHaveAttribute("data-attention", "review", { timeout: CONVERGE_TIMEOUT });
    await expect(attentionChip(page, A.id)).toHaveText("Review");
    await expect(attentionChip(page, A.id)).toHaveAttribute("title", blockMessage);
  });
});

test.describe("pipelines run: step attention — blocks", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: RESOLVE_DELAY_MS } });

  test("a missing handoff: the 'Pipeline needs you' toast opens the blocked step; the node reads Review with the block message", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "Handoff", agentProfileId: profileId });
    const B = makeStep({ id: randomUUID(), name: "Next", agentProfileId: profileId });
    const pipelineId = await createPipelineRest(backend, "No Handoff Pipeline", [A, B], [{ from: A.id, to: B.id }]);
    const title = `No Handoff Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
    );
    await gotoAppSubscribed(page, backend);
    await startTaskRest(backend, task.id);

    // One automatic reminder round-trip first, then the block.
    let blockMessage = "";
    await expect(async () => {
      const row = await getTask(backend, task.id);
      const block = row.pipelineRun?.blocked.find((b) => b.kind === "handoff-missing");
      expect(block).toBeTruthy();
      blockMessage = block!.message;
    }).toPass({ timeout: REMINDER_TIMEOUT });

    const toastEl = waitingToast(page).filter({ hasText: "Pipeline needs you" });
    await expect(toastEl).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await waitForPolledStep(page, task.id);
    await toastEl.getByRole("button", { name: "Open", exact: true }).click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(page.getByTestId("run-panel-pipeline-strip")).toContainText("step Handoff");
    await expect(stepNode(page, A.id)).toHaveAttribute("data-attention", "review", { timeout: CONVERGE_TIMEOUT });
    await expect(attentionChip(page, A.id)).toHaveText("Review");
    await expect(attentionChip(page, A.id)).toHaveAttribute("title", blockMessage);
    await expect(waitingToast(page)).toHaveCount(0);
  });

  test("a run-level block (step cap) highlights the step it's stuck at; the card's Review lands on the run view only", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const profileId = await createProfileRest(backend, "Runner");
    const A = makeStep({ id: randomUUID(), name: "First", agentProfileId: profileId });
    const B = makeStep({ id: randomUUID(), name: "Capped", agentProfileId: profileId });
    // maxSteps = 1: A's single outgoing edge is taken unconditionally, and
    // launching B hits the cap — a run-level `step-cap` block naming B,
    // with no step task of its own.
    const pipelineId = await createPipelineRest(backend, "Capped Pipeline", [A, B], [{ from: A.id, to: B.id }], 1);
    const title = `Capped Run ${randomUUID()}`;
    const task = await createPipelineTaskRest(
      backend,
      title,
      pipelineId,
      `Do the thing. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`,
    );
    await startTaskRest(backend, task.id);
    await expect(async () => {
      const row = await getTask(backend, task.id);
      const block = row.pipelineRun?.blocked.find((b) => b.kind === "step-cap");
      expect(block?.stepId).toBe(B.id);
      expect(block?.taskId ?? null).toBeNull();
      expect(row.column).toBe("blocked");
    }).toPass({ timeout: CONVERGE_TIMEOUT });

    await gotoApp(page, backend.bootBase);
    const review = boardCard(page, title).getByRole("button", { name: "Review", exact: true });
    await expect(review).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await review.click();

    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
    await expect(stepNode(page, B.id)).toHaveAttribute("data-attention", "review", { timeout: CONVERGE_TIMEOUT });
    await expect(attentionChip(page, B.id)).toHaveText("Review");
    await expect(stepNode(page, A.id)).not.toHaveAttribute("data-attention", /.+/);
    await expect(runPanelHandle(page)).toHaveCount(0);
  });
});
