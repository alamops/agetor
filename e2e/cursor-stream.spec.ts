import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/fx-0.0.14-and-cursor-updates.md E3 (D33 flow
 * 3): cursor-agent's plan mode and its 2026.10 stream-json shape, through
 * the in-process fake cursor driver (`AGETOR_CURSOR_DRIVER=fake`, set on
 * every backend by e2e/fixtures.ts).
 *
 * - The New Task form's Code/Plan toggle on cursor stores `mode: "plan"`
 *   (`CODE_PLAN_MODE.cursor.plan`, a real `--mode plan` now) and the run's
 *   opening breadcrumb says `mode=plan`.
 * - The stream marker's canned turn (two `thinking` blocks streamed as
 *   deltas, a glob tool call, an assistant message, `result.usage`) renders
 *   one thinking block per block — the deltas are coalesced at the mapper,
 *   never one row each — and the run row's usage chip.
 * - With `AGETOR_FAKE_CURSOR_PLAN=1` (its own fresh backend), approving the
 *   plan on an unbound plan-mode task flips the task to `auto` and posts the
 *   status line saying so; on a profile-bound one the task keeps `plan`, the
 *   approve response's warning shows as a toast and a status line, and the
 *   plan is embedded in the approval message.
 */

/** Literal copy of `FAKE_CURSOR_STREAM_PROMPT_MARKER` (src/bun/agents.ts) —
 *  specs can't import `src/bun/*` (see e2e/fx-interactions.spec.ts). */
const FAKE_CURSOR_STREAM_PROMPT_MARKER = "__agetor_fake_cursor_stream__";

const PLAN_APPROVED_STATUS = "plan approved — switched this task to Auto (force) so cursor can implement it";
const BOUND_PLAN_WARNING =
  "plan approved, but this task's agent runs cursor in Plan mode — detach the agent or switch the mode to implement";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function setCursorEnabled(backend: E2EBackend, enabled: boolean): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/cursor`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`PATCH /harnesses/cursor -> ${res.status}: ${await res.text()}`);
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Record<string, any>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, any>;
}

async function findTaskByTitle(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<Record<string, any> | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  if (!res.ok()) return null;
  const list = (await res.json()) as Array<Record<string, any>>;
  return list.find((t) => t.title === title) ?? null;
}

/** Every persisted event of a task (newest page; these tasks are tiny). */
async function taskEvents(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<Array<{ stream: string; data: string }>> {
  const res = await request.get(
    `${backend.apiBase}/tasks/${id}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}&limit=500`,
    { headers: auth(backend) },
  );
  expect(res.ok(), `GET /tasks/${id}/events/page -> ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { events: Array<{ stream: string; data: string }> };
  return body.events;
}

function newTaskFormPanel(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

async function registerProject(backend: E2EBackend, name: string): Promise<void> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
}

async function selectProject(form: Locator, projectName: string): Promise<void> {
  await form
    .getByTitle(
      "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.",
    )
    .click();
  const search = form.getByPlaceholder("Search projects…");
  await expect(search).toBeVisible();
  await search.fill(projectName);
  const row = form.getByRole("button", { name: projectName });
  await expect(row).toBeVisible();
  await row.click();
}

test.describe("cursor stream (worker backend)", () => {
  test.describe.configure({ mode: "serial" });
  const createdTaskIds: string[] = [];

  test.beforeAll(async ({ backend }) => {
    await setCursorEnabled(backend, true);
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    // cursor ships disabled — leave the worker-shared backend that way.
    await setCursorEnabled(backend, false).catch(() => {});
  });

  test("New Task Plan toggle stores mode plan and launches mode=plan; the stream turn renders one block per thinking block and the usage chip", async ({
    page,
    request,
    backend,
  }) => {
    const projectName = `cursor-stream-e2e-project-${randomUUID()}`;
    await registerProject(backend, projectName);

    await gotoApp(page, backend.bootBase);
    const form = newTaskFormPanel(page);
    const cursorButton = form.getByRole("button", { name: "Cursor", exact: true });
    await expect(cursorButton).toBeVisible({ timeout: 20_000 });
    await cursorButton.click();
    await selectProject(form, projectName);

    // The Mode label's first sibling is the Code/Plan pill pair; the second
    // is the exact-mode picker, whose trigger then also reads "Plan".
    const modeLabel = form.getByText("Mode", { exact: true });
    const planButton = modeLabel
      .locator("xpath=following-sibling::div[1]")
      .getByRole("button", { name: "Plan", exact: true });
    await planButton.click();
    await expect(planButton).toHaveAttribute("title", /--mode plan/);
    await expect(modeLabel.locator("xpath=following-sibling::div[2]//button").first()).toHaveText("Plan");

    const title = `cursor-stream-e2e ${randomUUID()}`;
    await form.getByPlaceholder("Short description").fill(title);
    await form.getByTestId("prompt-textarea").fill(`${FAKE_CURSOR_STREAM_PROMPT_MARKER} ${title}`);
    await form.getByTestId("worktree-options").getByTestId("isolate-toggle").uncheck();
    // To backlog, then start with the panel open: the `started — …`
    // breadcrumb is broadcast-only (never persisted), so it only reaches a
    // panel that is already subscribed when the run starts.
    await form.getByRole("button", { name: "To backlog", exact: true }).click();

    let row: Record<string, any> | null = null;
    await expect(async () => {
      row = await findTaskByTitle(request, backend, title);
      expect(row).not.toBeNull();
    }).toPass({ timeout: 15_000 });
    const taskId = row!.id as string;
    createdTaskIds.push(taskId);
    expect((await getTask(request, backend, taskId)).mode).toBe("plan");

    const panel = await openTask(page, title);
    await expect(panel.getByTestId("transcript-loading")).toHaveCount(0);
    const startRes = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `POST /tasks/${taskId}/start -> ${startRes.status()}`).toBeTruthy();
    await expect(panel.getByText("The notes file is ./notes.txt.", { exact: true })).toBeVisible({ timeout: 15_000 });

    // Opening breadcrumb names the stored mode.
    await expect(panel.getByText(/^started — .*agent=cursor, model=.*, mode=plan$/)).toBeVisible();

    // Two thinking blocks — one per `thinking/completed`, not one per delta.
    const thinkingToggles = panel.getByRole("button", { name: "thinking" });
    await expect(thinkingToggles).toHaveCount(2);
    await thinkingToggles.nth(0).click();
    await thinkingToggles.nth(1).click();
    await expect(panel.getByText("Looking for the notes file first.", { exact: true })).toBeVisible();
    await expect(panel.getByText("Found it. Answering now.", { exact: true })).toBeVisible();
    // No fragment of a delta renders on its own.
    await expect(panel.getByText("Looking for", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(" the notes file", { exact: true })).toHaveCount(0);

    // Persisted: exactly two thinking rows for five deltas.
    const events = await taskEvents(request, backend, taskId);
    expect(events.filter((e) => e.stream === "thinking")).toHaveLength(2);

    // Run row's usage chip from `result.usage` (per-turn tokens only, so the
    // compact ↑in ↓out form; the tooltip lists the cache counts too).
    const usageChip = panel.getByTestId("fx-usage-chip");
    await expect(usageChip).toBeVisible();
    await expect(usageChip).toHaveText("↑1.2k ↓80");
    await expect(usageChip).toHaveAttribute("title", /cache read/);
    // The raw sentinel never renders as a transcript line.
    await expect(panel.getByText("fx-usage:", { exact: false })).toHaveCount(0);
  });
});

test.describe("cursor plan approval (AGETOR_FAKE_CURSOR_PLAN=1)", () => {
  // A nested `test.use` replaces `backendEnv` wholesale; this block only
  // needs the plan seam (the fake cursor driver comes from the base env).
  test.use({ backendEnv: { AGETOR_FAKE_CURSOR_PLAN: "1" } });

  test("approving the plan on an unbound plan-mode task switches it to auto with a status line", async ({
    page,
    request,
    freshBackend,
  }) => {
    await setCursorEnabled(freshBackend, true);
    const title = `cursor-plan-approve-e2e ${randomUUID()}`;
    const createRes = await request.post(`${freshBackend.apiBase}/tasks`, {
      headers: auth(freshBackend),
      data: { title, prompt: title, agent: "cursor", mode: "plan", isolation: "none", workdir: tmpdir() },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const task = (await createRes.json()) as { id: string };
    const startRes = await request.post(`${freshBackend.apiBase}/tasks/${task.id}/start`, {
      headers: auth(freshBackend),
    });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);

    const planCard = panel.getByRole("button", { name: /Fake Plan.*View plan/ });
    await expect(planCard).toBeVisible({ timeout: 15_000 });
    // The run has to settle before the plan is approvable.
    await expect.poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 15_000 }).toBe(
      "review",
    );
    await planCard.click();
    const approve = page.getByRole("button", { name: "Approve Plan", exact: true });
    await expect(approve).toBeVisible();
    await approve.click();

    // A successful approve closes the dialog itself.
    await expect(approve).toBeHidden();
    await expect.poll(async () => (await getTask(request, freshBackend, task.id)).mode, { timeout: 15_000 }).toBe("auto");
    await expect(panel.getByText(PLAN_APPROVED_STATUS, { exact: true })).toBeVisible({ timeout: 15_000 });

    // The approval went out WITHOUT the plan embedded: Auto (force) can read
    // the saved plan file, so only read-only modes get it inline.
    let approval: string | undefined;
    await expect
      .poll(async () => {
        approval = (await taskEvents(request, freshBackend, task.id)).find(
          (e) => e.stream === "user" && e.data.includes("The plan is approved"),
        )?.data;
        return approval !== undefined;
      })
      .toBe(true);
    expect(approval).not.toContain("--- Approved plan ---");

    await request.delete(`${freshBackend.apiBase}/tasks/${task.id}`, { headers: auth(freshBackend) });
  });

  // Q1 = a, bound branch: the mode belongs to the agent profile, so the task
  // stays in Plan; the approve response's `warning` becomes a PlanDialog
  // toast, the same text lands on the plan's run as a status line, and the
  // plan is embedded in the approval message (plan mode can't be relied on
  // to read the file back).
  test("approving the plan on a profile-bound plan-mode task keeps plan and warns (toast + status line)", async ({
    page,
    request,
    freshBackend,
  }) => {
    await setCursorEnabled(freshBackend, true);
    const profileRes = await request.post(`${freshBackend.apiBase}/agent-profiles`, {
      headers: auth(freshBackend),
      data: { name: `Cursor Planner ${randomUUID().slice(0, 8)}`, harness: "cursor", model: "auto", mode: "plan" },
    });
    expect(profileRes.ok(), `POST /agent-profiles -> ${profileRes.status()}: ${await profileRes.text()}`).toBeTruthy();
    const profile = (await profileRes.json()) as { id: string };

    const title = `cursor-plan-approve-bound-e2e ${randomUUID()}`;
    const createRes = await request.post(`${freshBackend.apiBase}/tasks`, {
      headers: auth(freshBackend),
      data: { title, prompt: title, agentProfileId: profile.id, isolation: "none", workdir: tmpdir() },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const task = (await createRes.json()) as { id: string; mode: string; agent: string };
    expect(task.agent).toBe("cursor");
    expect(task.mode).toBe("plan");
    const startRes = await request.post(`${freshBackend.apiBase}/tasks/${task.id}/start`, {
      headers: auth(freshBackend),
    });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();

    await gotoApp(page, freshBackend.bootBase);
    const panel = await openTask(page, title);
    const planCard = panel.getByRole("button", { name: /Fake Plan.*View plan/ });
    await expect(planCard).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await getTask(request, freshBackend, task.id)).column, { timeout: 15_000 }).toBe(
      "review",
    );
    await planCard.click();
    const approve = page.getByRole("button", { name: "Approve Plan", exact: true });
    await expect(approve).toBeVisible();
    await approve.click();
    await expect(approve).toBeHidden();

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: BOUND_PLAN_WARNING });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(BOUND_PLAN_WARNING, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(PLAN_APPROVED_STATUS, { exact: true })).toHaveCount(0);

    // The approval still went out — with the plan embedded — and the mode
    // never moved off plan.
    await expect
      .poll(async () =>
        (await taskEvents(request, freshBackend, task.id)).some(
          (e) => e.stream === "user" && e.data.includes("--- Approved plan ---"),
        ),
      )
      .toBe(true);
    const after = await getTask(request, freshBackend, task.id);
    expect(after.mode).toBe("plan");
    expect(after.agentProfileId).toBe(profile.id);

    await request.delete(`${freshBackend.apiBase}/tasks/${task.id}`, { headers: auth(freshBackend) });
    await request.delete(`${freshBackend.apiBase}/agent-profiles/${profile.id}`, { headers: auth(freshBackend) });
  });
});
