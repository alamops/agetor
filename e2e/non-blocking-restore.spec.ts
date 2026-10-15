import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, queryBackendScalar } from "./helpers";

/**
 * E2E coverage for `docs/plans/non-blocking-session-restore.md` (TT8 / §8 A6):
 * while an idle claude task's session is being restored — the follow-up that
 * re-attaches the REAL subagent watcher over tens of MB of sidechain
 * transcripts — the rest of the app must keep answering. The same scenario
 * `e2e/task-switch-during-restore.spec.ts` pins for a slow SPAWN, but here
 * the cost is CPU/IO on the core's own event loop (the watcher's rehydrate
 * seed + offset-0 replay), the part the cooperative watcher work made
 * non-blocking.
 *
 * What this pins (structural properties, not a latency benchmark — the
 * timing claim itself lives in the drift unit test; the budgets below are the
 * plan's user-visible ones, deliberately generous enough for a loaded box):
 *
 *   1. During A's follow-up (re-attach in flight), another task's panel
 *      renders its transcript within 3 s.
 *   2. During the same window, a pipeline's run view opens within 3 s.
 *   3. During the same window, `GET /health` answers every time within
 *      500 ms (10 probes, 200 ms apart) — the core's event loop is never
 *      held for long.
 *   4. The re-attach loses and duplicates nothing: all 60 subagent rows are
 *      still there and the persisted subagent-event count is IDENTICAL to
 *      what the first turn wrote (the offset-0 replay dedupes to zero).
 *
 * The seam is `FAKE_CLAUDE_REAL_WATCHER_PROMPT_MARKER` (`src/bun/agents.ts`):
 * turn 1 writes `60` claude-shaped sidechain transcripts of ~512 KB each into
 * the task's workdir and attaches the real watcher (awaiting its first pass);
 * every later turn (the follow-up, found via the task's stored prompt) only
 * re-attaches, then detaches — a genuine rehydrate + replay per turn.
 *
 * Subagent tabs: RunPanel shows the tab strip only while a subagent or the
 * parent run is running (and caps it at six visible tabs), so a settled
 * task with 60 completed subagents shows no strip — the 60 is asserted
 * through `GET /tasks/:id/subagents`, the same list the strip is built from.
 */

const WATCHER_MARKER = "__agetor_fake_claude_real_watcher__";
const HANDOFF_MARKER = "__agetor_fake_claude_handoff__";
const SUBAGENT_FILES = 60;
const SUBAGENT_KB = 512;

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

interface TaskDetail {
  id: string;
  title: string;
  column: string;
  runId: string | null;
  pipelineRun?: { status: string } | null;
}

interface RunRow {
  id: string;
  status: string;
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  body: Record<string, unknown>,
): Promise<TaskDetail> {
  const res = await request.post(`${backend.apiBase}/tasks`, { headers: auth(backend), data: body });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskDetail;
}

async function startTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  expect(res.ok(), `POST /tasks/${id}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskDetail> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as TaskDetail;
}

async function getRuns(request: APIRequestContext, backend: E2EBackend, id: string): Promise<RunRow[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/runs -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as RunRow[];
}

async function waitForRunSettled(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
  minRuns: number,
  timeout: number,
): Promise<void> {
  await expect(async () => {
    const runs = await getRuns(request, backend, id);
    expect(runs.length, `task ${id} run count`).toBeGreaterThanOrEqual(minRuns);
    expect(runs[0]?.status, `task ${id} newest run status`).toBe("succeeded");
  }).toPass({ timeout });
}

async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
  column: string,
  timeout: number,
): Promise<void> {
  await expect(async () => {
    expect((await getTask(request, backend, id)).column, `task ${id} column`).toBe(column);
  }).toPass({ timeout });
}

async function listSubagentIds(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
): Promise<string[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/subagents`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${taskId}/subagents -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { id: string }[]).map((s) => s.id);
}

/** Persisted subagent-stream events of a task — straight from the backend's
 *  SQLite file, the ground truth for "the replay added nothing". */
function subagentEventCount(backend: E2EBackend, taskId: string): number {
  return queryBackendScalar(
    backend,
    `SELECT COUNT(*) AS n FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE r.task_id = ? AND e.subagent_id IS NOT NULL`,
    [taskId],
  );
}

function boardCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

test.describe("non-blocking session restore", () => {
  test("a follow-up re-attaching a 60-transcript real watcher leaves other tasks, pipelines and /health responsive, and loses nothing", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(300_000);
    const backend = freshBackend;
    const suffix = randomUUID();
    const titleA = `nbr-a-${suffix}`;
    const titleB = `nbr-b-${suffix}`;
    const titleP = `nbr-pipeline-${suffix}`;

    // The fake real-watcher driver writes its transcripts under the task's
    // cwd, so A needs its own (empty) directory, not the shared tmpdir().
    const workdirA = await mkdtemp(path.join(tmpdir(), "agetor-e2e-nbr-"));
    const taskA = await createTask(request, backend, {
      title: titleA,
      prompt: `restore stress ${WATCHER_MARKER}:${SUBAGENT_FILES}x${SUBAGENT_KB}`,
      isolation: "none",
      workdir: workdirA,
    });
    await startTask(request, backend, taskA.id);
    // Turn 1 writes ~30 MB and awaits the watcher's first full pass.
    await waitForRunSettled(request, backend, taskA.id, 1, 150_000);
    await waitForColumn(request, backend, taskA.id, "review", 30_000);

    // A one-step pipeline P (fake driver handoff scenario), run to `done`.
    const profileRes = await request.post(`${backend.apiBase}/agent-profiles`, {
      headers: auth(backend),
      data: { name: `Runner ${suffix}`, harness: "claude-code", model: "opus-5", instructions: "", skills: [] },
    });
    expect(profileRes.ok(), `POST /agent-profiles -> ${profileRes.status()}`).toBeTruthy();
    const profileId = ((await profileRes.json()) as { id: string }).id;
    const stepId = randomUUID();
    const pipelineRes = await request.post(`${backend.apiBase}/pipelines`, {
      headers: auth(backend),
      data: {
        name: `Restore Pipeline ${suffix}`,
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
      },
    });
    expect(pipelineRes.ok(), `POST /pipelines -> ${pipelineRes.status()}: ${await pipelineRes.text()}`).toBeTruthy();
    const pipelineId = ((await pipelineRes.json()) as { id: string }).id;
    const taskP = await createTask(request, backend, {
      title: titleP,
      prompt: `Do the thing. ${HANDOFF_MARKER}:done`,
      isolation: "none",
      workdir: tmpdir(),
      pipelineId,
    });
    await startTask(request, backend, taskP.id);
    await expect(async () => {
      expect((await getTask(request, backend, taskP.id)).pipelineRun?.status).toBe("done");
    }).toPass({ timeout: 40_000 });

    // Task B: an ordinary settled task whose transcript we will open mid-restore.
    const taskB = await createTask(request, backend, {
      title: titleB,
      prompt: titleB,
      isolation: "none",
      workdir: tmpdir(),
    });
    await startTask(request, backend, taskB.id);
    await waitForColumn(request, backend, taskB.id, "review", 30_000);

    // Baseline: turn 1 persisted every subagent row and its events.
    const idsBefore = await listSubagentIds(request, backend, taskA.id);
    expect(idsBefore.length, "first turn registered every subagent").toBe(SUBAGENT_FILES);
    const eventsBefore = subagentEventCount(backend, taskA.id);
    expect(eventsBefore, "first pass persisted subagent events").toBeGreaterThan(0);

    await gotoApp(page, backend.bootBase);
    await expect(boardCard(page, titleA)).toBeVisible();
    await expect(boardCard(page, titleB)).toBeVisible();
    await expect(boardCard(page, titleP)).toBeVisible();

    // The follow-up: the marker-less turn takes the "later turn" path, i.e.
    // re-attaches the real watcher (rehydrate + offset-0 replay over ~30 MB).
    const taskADetail = await getTask(request, backend, taskA.id);
    expect(taskADetail.runId, "A carries its last run id").toBeTruthy();
    // Deliberately NOT awaited yet: everything below must work while the
    // restore is in flight (the response itself is bounded by
    // SPAWN_RESPONSE_BUDGET_MS, but the watcher keeps working past it).
    const followUp = request.post(`${backend.apiBase}/runs/${taskADetail.runId}/input`, {
      headers: auth(backend),
      data: { line: `follow-up-${suffix}` },
    });

    // (3) /health stays prompt — probed concurrently with the UI steps.
    const healthProbes = (async () => {
      const timings: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = Date.now();
        const res = await request.get(`${backend.apiBase}/health`);
        timings.push(Date.now() - t0);
        expect(res.ok(), `GET /health #${i} -> ${res.status()}`).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return timings;
    })();

    // (1) B's panel shows its transcript within 3 s.
    const panel = page.locator("aside").last();
    const bOpenedAt = Date.now();
    await boardCard(page, titleB).click();
    await expect(panel.getByText(`fake response to: ${titleB}`, { exact: true })).toBeVisible({ timeout: 3_000 });
    const bMs = Date.now() - bOpenedAt;
    await expect(panel.getByTestId("transcript-loading")).toHaveCount(0);

    // (2) Close B, then P's run view is up within 3 s.
    // Same idiom as the other specs: the panel slides out and then
    // unmounts, so "closed" is an inert OR absent backdrop.
    const backdrop = page.getByRole("button", { name: "Close task panel" });
    await panel.getByRole("button", { name: "Close task details" }).click();
    await expect
      .poll(
        async () =>
          backdrop.evaluateAll(
            (els) => els.length === 0 || els.every((el) => getComputedStyle(el).pointerEvents === "none"),
          ),
        { timeout: 10_000, message: "task panel did not close" },
      )
      .toBe(true);
    const pOpenedAt = Date.now();
    await boardCard(page, titleP).click();
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible({ timeout: 3_000 });
    const pMs = Date.now() - pOpenedAt;

    const timings = await healthProbes;
    expect(
      Math.max(...timings),
      `every /health probe < 500 ms during the restore (timings: ${timings.join(", ")} ms)`,
    ).toBeLessThan(500);
    console.log(`[non-blocking-restore] B transcript ${bMs} ms, P run view ${pMs} ms, /health ${timings.join("/")} ms`);

    // The follow-up itself was accepted and the restore completes.
    const followUpRes = await followUp;
    expect(followUpRes.ok(), `POST /runs/:id/input -> ${followUpRes.status()}: ${await followUpRes.text()}`).toBeTruthy();
    await waitForRunSettled(request, backend, taskA.id, 2, 150_000);

    // (4) Nothing lost, nothing duplicated.
    const idsAfter = await listSubagentIds(request, backend, taskA.id);
    expect(idsAfter.length, "all subagents still registered after the re-attach").toBe(SUBAGENT_FILES);
    expect(new Set(idsAfter)).toEqual(new Set(idsBefore));
    expect(subagentEventCount(backend, taskA.id), "the replay deduped to zero new subagent events").toBe(eventsBefore);

    // And A's panel renders its (now two-run) transcript.
    await page.getByTestId("pipeline-run-back").click();
    await boardCard(page, titleA).click();
    await expect(
      panel.getByText(`Real subagent watcher attached over ${SUBAGENT_FILES} transcript(s).`).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
