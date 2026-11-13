import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import {
  bearerHeaders,
  createStackAccount,
  createStackViaApi,
  deleteAll,
  gotoApp,
  removeLimitStates,
  seedLimitState,
} from "./helpers";

/**
 * Switching accounts inside a stack (TT11, SC9): the RunPanel picker is limited
 * to the stack's members, a manual same-stack switch keeps the conversation and
 * shows a pending state, "Switch to next account" moves an idle task now and
 * schedules itself for the end of a live turn (cancellable), a switch with no
 * usable target is refused with each member's reason, and the New Task form
 * explains a launch whose primary cannot start.
 *
 * The limit marker is a literal copy of `FAKE_CLAUDE_LIMIT_PROMPT_MARKER`
 * (e2e cannot import `src/bun/*`); it gives a task a real transcript that the
 * switch has to carry over.
 */
const LIMIT_MARKER = "__agetor_fake_claude_limit__";
const HOUR_MS = 3_600_000;

const createdTaskIds: string[] = [];
const createdStackIds: string[] = [];
const createdHarnessIds: string[] = [];

interface TaskView {
  id: string;
  column: string;
  agent: string;
  harnessState: { scheduledSwitch?: unknown; lastMove?: unknown } | null;
}

async function getTask(backend: E2EBackend, taskId: string): Promise<TaskView> {
  const res = await fetch(`${backend.apiBase}/tasks/${taskId}`, { headers: bearerHeaders(backend) });
  if (!res.ok) throw new Error(`GET /tasks/${taskId} -> ${res.status}`);
  return (await res.json()) as TaskView;
}

async function makeTask(
  backend: E2EBackend,
  opts: { agent: string; title: string; prompt: string },
): Promise<string> {
  const res = await fetch(`${backend.apiBase}/tasks`, {
    method: "POST",
    headers: bearerHeaders(backend),
    body: JSON.stringify({
      title: opts.title,
      prompt: opts.prompt,
      agent: opts.agent,
      workdir: backend.dataDir,
      isolation: "none",
      model: "sonnet-4.6",
      effort: "high",
    }),
  });
  if (!res.ok) throw new Error(`POST /tasks -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function startTaskApi(backend: E2EBackend, taskId: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${taskId}/start`, { method: "POST", headers: bearerHeaders(backend) });
  if (!res.ok) throw new Error(`POST /tasks/${taskId}/start -> ${res.status}: ${await res.text()}`);
}

async function waitForTask(
  backend: E2EBackend,
  taskId: string,
  what: string,
  pred: (t: TaskView) => boolean,
  timeoutMs = 20_000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | null = null;
  while (Date.now() < deadline) {
    last = await getTask(backend, taskId);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`task ${taskId} never reached "${what}" (last column=${last?.column}, agent=${last?.agent})`);
}

/** The run panel's slide-over `<aside>` (the New Task sidebar is the first one). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

function accountPicker(panel: Locator): Locator {
  return panel.getByLabel("Harness account");
}

/** Two accounts + a stack, registered for cleanup on the shared backend. */
async function trainOn(
  backend: E2EBackend,
  tag: string,
  opts: { shared: boolean },
): Promise<{ a: string; b: string; stackId: string; roots: { a: string; b: string } }> {
  const a = `e2e-sw-a-${tag}`;
  const b = `e2e-sw-b-${tag}`;
  const rootA = await createStackAccount(backend, a);
  const rootB = await createStackAccount(backend, b);
  const stack = await createStackViaApi(backend, `e2e sw ${tag}`, "claude-code", [a, b]);
  if (opts.shared) {
    createdHarnessIds.push(a, b);
    createdStackIds.push(stack.id);
  }
  return { a, b, stackId: stack.id, roots: { a: rootA, b: rootB } };
}

function dbOf(backend: E2EBackend): Database {
  return new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
}

test.describe("stack account switching (shared backend)", () => {
  test.afterAll(async ({ backend }) => {
    removeLimitStates(backend, createdHarnessIds);
    await deleteAll(backend, [
      ...createdTaskIds.map((id) => `/tasks/${id}`),
      ...createdStackIds.map((id) => `/harness-stacks/${id}`),
      ...createdHarnessIds.map((id) => `/harnesses/${id}`),
    ]);
  });

  test("the RunPanel picker lists only the stack's members for a stacked task", async ({ page, backend }) => {
    const tag = `pick-${Date.now()}`;
    const { a, b } = await trainOn(backend, tag, { shared: true });
    const outsider = `e2e-sw-out-${tag}`;
    await createStackAccount(backend, outsider);
    createdHarnessIds.push(outsider);

    const stackedTitle = `stacked ${tag}`;
    const stacked = await makeTask(backend, { agent: a, title: stackedTitle, prompt: "plain" });
    const loneTitle = `lone ${tag}`;
    const lone = await makeTask(backend, { agent: outsider, title: loneTitle, prompt: "plain" });
    createdTaskIds.push(stacked, lone);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, stackedTitle);
    const options = accountPicker(panel).locator("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute("value", a);
    await expect(options.nth(1)).toHaveAttribute("value", b);
    // Labelled with the position, so the order is readable in the list.
    await expect(options.nth(0)).toHaveText(`${a} 1/2`);
    await expect(options.nth(1)).toHaveText(`${b} 2/2`);
    await expect(accountPicker(panel)).toHaveValue(a);

    // A task outside any stack keeps the full account list.
    await page.getByRole("button", { name: "Close task details" }).click();
    const lonePanel = await openTask(page, loneTitle);
    const all = accountPicker(lonePanel).locator("option");
    expect(await all.count()).toBeGreaterThan(2);
    await expect(accountPicker(lonePanel).locator(`option[value="${a}"]`)).toHaveCount(1);
  });

  test("a manual same-stack switch keeps the conversation and shows a pending state", async ({ page, backend }) => {
    const tag = `man-${Date.now()}`;
    const { a, b, roots } = await trainOn(backend, tag, { shared: true });
    // A limit on A gives the task a real transcript, moved to B by the failover.
    const title = `manual ${tag}`;
    const taskId = await makeTask(backend, { agent: a, title, prompt: `work ${LIMIT_MARKER}` });
    createdTaskIds.push(taskId);
    await startTaskApi(backend, taskId);
    await waitForTask(backend, taskId, "swapped to the backup", (t) => t.agent === b && t.column === "review");
    const sessionId = `fake-swap-${taskId}`;
    const slug = backend.dataDir.replace(/[^a-zA-Z0-9]/g, "-");
    expect(existsSync(path.join(roots.b, "projects", slug, `${sessionId}.jsonl`))).toBe(true);

    // Hold the account PATCH so the pending state is observable, not a flash.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route(`**/tasks/${taskId}`, async (route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        await gate;
      }
      await route.continue();
    });

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByText("Task details", { exact: true }).click();
    const picker = accountPicker(panel);
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(b);
    await picker.selectOption(a);

    await expect(panel.getByTestId("task-agent-switching")).toBeVisible();
    await expect(picker).toBeDisabled();
    release();
    await expect(panel.getByTestId("task-agent-switching")).toHaveCount(0);
    await expect(picker).toBeEnabled();
    await expect(picker).toHaveValue(a);

    // The task is on A, and the conversation came along: A holds the session
    // transcript, and the task's own session id is unchanged.
    expect((await getTask(backend, taskId)).agent).toBe(a);
    expect(existsSync(path.join(roots.a, "projects", slug, `${sessionId}.jsonl`))).toBe(true);
    const db = dbOf(backend);
    try {
      const sessions = db
        .query("SELECT DISTINCT claude_session_id AS id FROM runs WHERE task_id = ? AND claude_session_id IS NOT NULL")
        .all(taskId) as Array<{ id: string }>;
      expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    } finally {
      db.close();
    }
  });

  test("Switch to next account moves an idle task now and toasts", async ({ page, backend }) => {
    const tag = `idle-${Date.now()}`;
    const { a, b } = await trainOn(backend, tag, { shared: true });
    const title = `idle switch ${tag}`;
    const taskId = await makeTask(backend, { agent: a, title, prompt: "plain" });
    createdTaskIds.push(taskId);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByTestId("switch-account-button").click();
    await expect(page.getByText(`Switched to ${b}`)).toBeVisible();
    await expect(accountPicker(panel)).toHaveValue(b);
    expect((await getTask(backend, taskId)).agent).toBe(b);
    // Nothing is scheduled for an idle move.
    await expect(panel.getByTestId("switch-account-scheduled")).toHaveCount(0);
  });

  test("with every other account cooling the switch is refused and lists each reason", async ({ page, backend }) => {
    const tag = `refuse-${Date.now()}`;
    const { a, b } = await trainOn(backend, tag, { shared: true });
    seedLimitState(backend, { harnessId: b, untilMs: Date.now() + 2 * HOUR_MS, message: "Weekly limit reached" });
    const title = `refused ${tag}`;
    const taskId = await makeTask(backend, { agent: a, title, prompt: "plain" });
    createdTaskIds.push(taskId);

    const direct = await fetch(`${backend.apiBase}/tasks/${taskId}/switch-account`, {
      method: "POST",
      headers: bearerHeaders(backend),
    });
    expect(direct.status).toBe(409);
    const refusal = (await direct.json()) as { reasons: Array<{ harnessId: string; label: string; reason: string }> };
    expect(refusal.reasons.map((r) => r.harnessId)).toContain(b);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByTestId("switch-account-button").click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Couldn't switch account" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("No other account can take this task");
    await expect(toast).toContainText(b);
    expect((await getTask(backend, taskId)).agent).toBe(a);
  });

  test("the New Task form says the run starts on the next account when the primary cannot start", async ({ page, backend }) => {
    const tag = `hint-${Date.now()}`;
    const { a } = await trainOn(backend, tag, { shared: true });
    await gotoApp(page, backend.bootBase);
    const form = page.locator("aside").first();
    const pick = form.getByRole("button", { name: new RegExp(`^${a}`) });
    await pick.click();
    // Healthy primary: no hint.
    await expect(form.getByTestId("launch-stack-fallback-hint")).toHaveCount(0);

    // Point the primary at a binary that does not exist: it cannot start, but
    // its backup can. (The New Task picker lists enabled accounts only, so a
    // disabled primary cannot be chosen there; an unavailable one can.)
    const patch = await fetch(`${backend.apiBase}/harnesses/${a}`, {
      method: "PATCH",
      headers: bearerHeaders(backend),
      body: JSON.stringify({ bin: path.join(backend.dataDir, "not-installed", "claude") }),
    });
    expect(patch.status).toBe(200);
    await page.reload();
    await expect(page.getByTitle("Settings", { exact: true })).toBeVisible();
    await form.getByRole("button", { name: new RegExp(`^${a}`) }).click();
    const hint = form.getByTestId("launch-stack-fallback-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("the run starts on the next usable account in its stack");
    // The red "not installed" box is replaced by the hint.
    await expect(form.getByText("not installed", { exact: false })).toHaveCount(0);
  });
});

test.describe("stack account switching during a live turn", () => {
  // Hold every ordinary claude turn open so the run is live while we click.
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_TURN_MS: "60000" } });
  test.setTimeout(90_000);

  test("Switch to next account is scheduled for the end of the turn and can be cancelled", async ({
    page,
    freshBackend: backend,
  }) => {
    const tag = `live-${Date.now()}`;
    const { a } = await trainOn(backend, tag, { shared: false });
    const title = `live switch ${tag}`;
    const taskId = await makeTask(backend, { agent: a, title, prompt: "plain" });
    await startTaskApi(backend, taskId);
    await waitForTask(backend, taskId, "running", (t) => t.column === "running");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await panel.getByTestId("switch-account-button").click();

    const scheduled = panel.getByTestId("switch-account-scheduled");
    await expect(scheduled).toContainText("Switch scheduled for the end of this turn");
    await expect(panel.getByTestId("switch-account-button")).toHaveCount(0);
    expect((await getTask(backend, taskId)).harnessState?.scheduledSwitch).toBeTruthy();
    // The task stays on its account while the turn runs.
    expect((await getTask(backend, taskId)).agent).toBe(a);

    await panel.getByTestId("switch-account-cancel").click();
    await expect(scheduled).toHaveCount(0);
    await expect(panel.getByTestId("switch-account-button")).toBeVisible();
    await expect.poll(async () => (await getTask(backend, taskId)).harnessState?.scheduledSwitch ?? null).toBeNull();
    expect((await getTask(backend, taskId)).agent).toBe(a);
  });
});
