import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import {
  bearerHeaders,
  createStackAccount,
  createStackViaApi,
  gotoApp,
  openSettingsGeneral,
  queryBackendScalar,
  seedLimitState,
} from "./helpers";

/**
 * End-to-end harness-stack failover (TT8): two fake Claude accounts, a task
 * that hits a limit on the primary, and a successor run that continues on the
 * backup — while the task stays `running` and the visible divider lands
 * between the runs. No real account or CLI is touched.
 *
 * The fake driver marker is a literal copy of
 * `FAKE_CLAUDE_LIMIT_PROMPT_MARKER` (e2e cannot import `src/bun/*`).
 */
const LIMIT_MARKER = "__agetor_fake_claude_limit__";
const CLEAN_MARKER = "__agetor_fake_claude_limit_clean__";

const createdTaskIds: string[] = [];
const createdStackIds: string[] = [];
const createdHarnessIds: string[] = [];

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function createAccount(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<void> {
  const home = path.join(backend.dataDir, "harnesses", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "{}");
  const res = await request.post(`${backend.apiBase}/harnesses`, {
    headers: { ...auth(backend), "content-type": "application/json" },
    data: { id, kind: "claude-code", label: id, home },
  });
  expect(res.status()).toBe(200);
  createdHarnessIds.push(id);
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  agent: string,
  prompt: string,
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: { ...auth(backend), "content-type": "application/json" },
    data: {
      // Unique per account so the DOM assertion below can open exactly this
      // card; both tests share one worker backend.
      title: `stack swap ${agent}`,
      prompt,
      agent,
      workdir: backend.dataDir,
      isolation: "none",
      model: "sonnet-4.6",
      effort: "high",
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  createdTaskIds.push(body.id);
  return body.id;
}

/** The run panel's slide-over `<aside>` — the New Task form's sidebar is also
 *  an `<aside>`, mounted first (mirrors other e2e specs' helper). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click the task card by its exact title and wait for the panel to mount. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  columns: string[],
  timeoutMs = 20_000,
): Promise<{ column: string; agent: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { column: string; agent: string } = { column: "", agent: "" };
  while (Date.now() < deadline) {
    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) });
    if (res.ok()) {
      last = (await res.json()) as { column: string; agent: string };
      if (columns.includes(last.column)) return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`task ${taskId} never reached ${columns.join("/")} (last ${last.column})`);
}

function runsOf(backend: E2EBackend, taskId: string): Array<{
  id: string;
  agent: string;
  status: string;
  origin: string | null;
  claude_session_id: string | null;
}> {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
  try {
    return db
      .query(
        `SELECT id, agent, status, origin, claude_session_id FROM runs WHERE task_id = ? ORDER BY started_at ASC`,
      )
      .all(taskId) as never;
  } finally {
    db.close();
  }
}

function statusLines(backend: E2EBackend, runId: string): string[] {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
  try {
    return (db.query(`SELECT data FROM run_events WHERE run_id = ? AND stream = 'status' ORDER BY id ASC`).all(runId) as { data: string }[]).map((r) => r.data);
  } finally {
    db.close();
  }
}

/** Write the account-global cooldown the failover engine would persist. The
 *  board reads it from `/harnesses`; the row is normally written by a limit
 *  settle, which a never-started task cannot produce. */
function insertLimitState(backend: E2EBackend, harnessId: string, untilMs: number): void {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.run(
      `INSERT OR REPLACE INTO harness_limit_state
         (harness_id, reason, source, message, exhausted_until_ms, updated_at)
       VALUES (?, 'quota', 'claude-pane', 'usage limit', ?, ?)`,
      [harnessId, untilMs, Date.now()],
    );
  } finally {
    db.close();
  }
}

test.describe("harness-stack swap", () => {
  test("a limit transfers the conversation and the task keeps running", async ({ page, request, backend }) => {
    const a = `e2e-stack-a-${Date.now()}`;
    const b = `e2e-stack-b-${Date.now()}`;
    await createAccount(request, backend, a);
    await createAccount(request, backend, b);
    const stackRes = await request.post(`${backend.apiBase}/harness-stacks`, {
      headers: { ...auth(backend), "content-type": "application/json" },
      data: { label: "e2e train", kind: "claude-code", members: [a, b], mirrorMode: "safe" },
    });
    expect(stackRes.status()).toBe(201);
    createdStackIds.push(((await stackRes.json()) as { stack: { id: string } }).stack.id);

    const taskId = await createTask(request, backend, a, `do it ${LIMIT_MARKER}`);
    const start = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, {
      headers: auth(backend),
    });
    expect(start.ok()).toBe(true);

    const settled = await waitForColumn(request, backend, taskId, ["review", "done", "ready", "blocked"]);
    expect(settled.column).toBe("review");
    expect(settled.agent).toBe(b);

    const runs = runsOf(backend, taskId);
    expect(runs.length).toBe(2);
    expect(runs[0]!.agent).toBe(a);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[1]!.agent).toBe(b);
    expect(runs[1]!.origin).toBe("harness-swap");
    // The conversation itself moved: the successor resumes the transferred
    // session id and the copied transcript exists under the backup's home.
    expect(runs[1]!.claude_session_id).toBe(`fake-swap-${taskId}`);
    const copied = path.join(
      backend.dataDir,
      "harnesses",
      b,
      "projects",
      backend.dataDir.replace(/[^a-zA-Z0-9]/g, "-"),
      `fake-swap-${taskId}.jsonl`,
    );
    expect(existsSync(copied)).toBe(true);
    const notice = statusLines(backend, runs[1]!.id).find((l) => l.startsWith("harness-swap: "));
    expect(notice).toBeTruthy();

    // C5/TT8: the divider really renders between the task's messages, not just
    // as a persisted row the API can read.
    await gotoApp(page, backend.bootBase);
    // TT15: the card derives its chip from the account's stack membership (the
    // task moved to the backup, so it reads 2 of 2) — this also pins the
    // `task-card-stack-badge` test id the card path renders.
    const card = page.locator(`[data-task-id="${taskId}"]`);
    await expect(card.getByTestId("task-card-stack-badge")).toHaveText("2/2");
    const panel = await openTask(page, `stack swap ${a}`);
    const divider = panel.getByTestId("harness-swap-divider");
    await expect(divider).toBeVisible();
    await expect(divider).toContainText(`Switched to ${b}`);
    await expect(divider).toContainText("Continuing from the transferred conversation.");
    await expect(divider).toContainText("(2/2)");
  });

  test("before any tool call the original prompt is retried without a transfer", async ({ page, request, backend }) => {
    const a = `e2e-clean-a-${Date.now()}`;
    const b = `e2e-clean-b-${Date.now()}`;
    await createAccount(request, backend, a);
    await createAccount(request, backend, b);
    const stackRes = await request.post(`${backend.apiBase}/harness-stacks`, {
      headers: { ...auth(backend), "content-type": "application/json" },
      data: { label: "e2e clean", kind: "claude-code", members: [a, b], mirrorMode: "safe" },
    });
    expect(stackRes.status()).toBe(201);
    createdStackIds.push(((await stackRes.json()) as { stack: { id: string } }).stack.id);

    const taskId = await createTask(request, backend, a, `no tools ${CLEAN_MARKER}`);
    const start = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: auth(backend) });
    expect(start.ok()).toBe(true);

    const settled = await waitForColumn(request, backend, taskId, ["review", "done", "ready", "blocked"]);
    expect(settled.column).toBe("review");
    const runs = runsOf(backend, taskId);
    expect(runs.length).toBe(2);
    expect(runs[1]!.agent).toBe(b);
    expect(runs[1]!.claude_session_id ?? null).toBeNull();

    // The divider's copy must not claim a transfer that never happened.
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, `stack swap ${a}`);
    const divider = panel.getByTestId("harness-swap-divider");
    await expect(divider).toBeVisible();
    await expect(divider).toContainText(`Switched to ${b}`);
    await expect(divider).toContainText("Restarting the request on this account.");
  });

  test("a cooling current account marks the card chip (R18)", async ({ page, request, backend }) => {
    const a = `e2e-cool-a-${Date.now()}`;
    const b = `e2e-cool-b-${Date.now()}`;
    await createAccount(request, backend, a);
    await createAccount(request, backend, b);
    const stackRes = await request.post(`${backend.apiBase}/harness-stacks`, {
      headers: { ...auth(backend), "content-type": "application/json" },
      data: { label: "e2e cooling", kind: "claude-code", members: [a, b], mirrorMode: "safe" },
    });
    expect(stackRes.status()).toBe(201);
    createdStackIds.push(((await stackRes.json()) as { stack: { id: string } }).stack.id);

    // The task's current account (the backup, position 2) is cooling. A task
    // that never ran has no `harnessState`, so this also proves the badge is
    // derived from the account's stack membership and the App -> Column ->
    // TaskCard limit-state plumbing.
    const taskId = await createTask(request, backend, b, "cooling chip");
    insertLimitState(backend, b, Date.now() + 6 * 60 * 60 * 1000);

    await gotoApp(page, backend.bootBase);
    const card = page.locator(`[data-task-id="${taskId}"]`);
    await expect(card).toBeVisible();
    const badge = card.getByTestId("task-card-stack-badge");
    await expect(badge).toHaveText("⏳ 2/2");
    await expect(badge).toHaveAttribute("title", /its current account is cooling until/);

    // The Settings → Harnesses row carries the same cooldown fact, from the
    // same `/harnesses` limitStates payload.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
    // Scoped to this test's stack: earlier tests leave their own cooling chips.
    const coolingChip = dialog
      .getByTestId("harness-stack-row")
      .filter({ hasText: "e2e cooling" })
      .getByTestId("harness-cooling-chip");
    await expect(coolingChip).toBeVisible();
    // The chip's visible text carries the reset; its `title` is the provider's
    // own message ("usage limit", as seeded), its aria-label the full sentence.
    await expect(coolingChip).toContainText(/until /);
    await expect(coolingChip).toHaveAttribute("aria-label", /^Cooling: .*until /);
    await expect(coolingChip).toHaveAttribute("title", "usage limit");
  });
});


/* ───────────────────────── TT11: exhausted / retry / codex ───────────────────────── */

const CODEX_LIMIT_MARKER = "__agetor_fake_codex_limit__";
const HOUR_MS = 3_600_000;

interface TaskView {
  id: string;
  column: string;
  agent: string;
  harnessState: {
    allExhausted?: {
      attempts: number;
      nextAttemptAt: number;
      inFlight?: boolean;
      memberReasons?: Array<{ harnessId: string; label: string; reason: string }>;
    } | null;
    lastMove?: unknown;
  } | null;
}

async function getTask(backend: E2EBackend, taskId: string): Promise<TaskView> {
  const res = await fetch(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) });
  if (!res.ok) throw new Error(`GET /tasks/${taskId} -> ${res.status}`);
  return (await res.json()) as TaskView;
}

/** Poll the API until `pred(task)` holds — a real-state wait, not a sleep. */
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
  throw new Error(`task ${taskId} never reached "${what}" (last column=${last?.column}, state=${JSON.stringify(last?.harnessState)})`);
}

async function makeTask(
  backend: E2EBackend,
  opts: { agent: string; title: string; prompt: string; model?: string },
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
      ...(opts.model ? { model: opts.model } : {}),
    }),
  });
  if (!res.ok) throw new Error(`POST /tasks -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function startTaskApi(backend: E2EBackend, taskId: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${taskId}/start`, { method: "POST", headers: auth(backend) });
  if (!res.ok) throw new Error(`POST /tasks/${taskId}/start -> ${res.status}: ${await res.text()}`);
}

/** Two accounts + a stack, the backup cooling until `backupCoolsForMs` from now. */
async function exhaustedSetup(
  backend: E2EBackend,
  tag: string,
  backupCoolsForMs: number,
): Promise<{ a: string; b: string; stackId: string; taskId: string; title: string }> {
  const a = `e2e-ex-a-${tag}`;
  const b = `e2e-ex-b-${tag}`;
  await createStackAccount(backend, a);
  await createStackAccount(backend, b);
  const stack = await createStackViaApi(backend, `e2e ex ${tag}`, "claude-code", [a, b]);
  seedLimitState(backend, { harnessId: b, untilMs: Date.now() + backupCoolsForMs, message: "Weekly limit reached" });
  const title = `exhausted ${tag}`;
  const taskId = await makeTask(backend, { agent: a, title, prompt: `go ${LIMIT_MARKER}`, model: "sonnet-4.6" });
  await startTaskApi(backend, taskId);
  await waitForTask(backend, taskId, "all-exhausted", (t) => t.harnessState?.allExhausted != null && t.column !== "running");
  return { a, b, stackId: stack.id, taskId, title };
}

async function panelFor(page: Page, title: string): Promise<Locator> {
  return openTask(page, title);
}

test.describe("harness-stack all-exhausted banner", () => {
  test("shows the earliest reset, each member's reason and an Open Harnesses link; Run now starts once", async ({ page, backend }) => {
    const tag = `${Date.now()}`;
    const { a, b, stackId, taskId, title } = await exhaustedSetup(backend, tag, 2 * HOUR_MS);
    createdHarnessIds.push(a, b);
    createdStackIds.push(stackId);
    createdTaskIds.push(taskId);

    await gotoApp(page, backend.bootBase);
    const panel = await panelFor(page, title);
    const banner = panel.getByTestId("harness-stack-exhausted");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Every account in this stack is out of quota");
    await expect(banner).toContainText("retrying in");
    await expect(banner).toContainText("Next reset around");
    // One line per member that can't take the task, naming the account.
    const reasons = panel.getByTestId("harness-stack-member-reasons").locator("li");
    await expect(reasons.filter({ hasText: a })).toHaveCount(1);
    await expect(reasons.filter({ hasText: b })).toHaveCount(1);

    // Open Harnesses lands on Settings → Harnesses (where a member is fixed).
    await panel.getByTestId("harness-stack-open-harnesses").click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings" }) });
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Run now: a double click must start the task exactly once, with no error toast.
    const before = runsOf(backend, taskId).length;
    await panel.getByTestId("harness-stack-run-now").dblclick();
    await expect
      .poll(async () => (await getTask(backend, taskId)).column, { timeout: 20_000 })
      .toMatch(/review|done/);
    expect(runsOf(backend, taskId).length).toBe(before + 1);
    await expect(panel.getByTestId("harness-stack-exhausted")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /already running|couldn't|failed/i })).toHaveCount(0);
  });

  test("deleting the stack during an armed retry clears the banner and leaves a status line", async ({ page, backend }) => {
    const tag = `del-${Date.now()}`;
    const { a, b, stackId, taskId, title } = await exhaustedSetup(backend, tag, 2 * HOUR_MS);
    createdHarnessIds.push(a, b);
    createdTaskIds.push(taskId);

    await gotoApp(page, backend.bootBase);
    const panel = await panelFor(page, title);
    await expect(panel.getByTestId("harness-stack-exhausted")).toBeVisible();

    const del = await fetch(`${backend.apiBase}/harness-stacks/${stackId}`, { method: "DELETE", headers: auth(backend) });
    expect(del.status).toBe(200);

    await expect(panel.getByTestId("harness-stack-exhausted")).toHaveCount(0);
    expect((await getTask(backend, taskId)).harnessState?.allExhausted ?? null).toBeNull();
    const line = "automatic account retry cancelled — the stack was deleted";
    const lastRun = runsOf(backend, taskId).at(-1)!;
    expect(statusLines(backend, lastRun.id)).toContain(line);
    await expect(panel.getByText(line)).toBeVisible();
  });
});

test.describe("harness-stack retry run", () => {
  // Hold every ordinary claude turn open so the retry run is observably live.
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_TURN_MS: "20000" } });
  test.setTimeout(90_000);

  test("while the retry run is live the banner reads Running on <account> after a quota reset, with no Run now", async ({
    page,
    freshBackend: backend,
  }) => {
    const tag = `${Date.now()}`;
    // All-exhausted first (the backup cools for two hours), then the user
    // clears that cooldown: the waiting task is re-armed a short backoff out
    // (AGETOR_HARNESS_RETRY_MIN_MS) and its retry runs on the backup.
    const { b, taskId, title } = await exhaustedSetup(backend, tag, 2 * HOUR_MS);
    const cleared = await fetch(`${backend.apiBase}/harnesses/${b}/limit-state`, { method: "DELETE", headers: auth(backend) });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { rearmed: number }).rearmed).toBe(1);

    const live = await waitForTask(
      backend,
      taskId,
      "retry run live",
      (t) => t.column === "running" && t.harnessState?.allExhausted?.inFlight === true,
      30_000,
    );
    expect(live.agent).toBe(b);

    await gotoApp(page, backend.bootBase);
    const panel = await panelFor(page, title);
    const banner = panel.getByTestId("harness-stack-retry-running");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("after a quota reset");
    await expect(banner).toContainText(/attempt \d\/3/);
    // A manual run would only bounce off "task already running".
    await expect(panel.getByTestId("harness-stack-run-now")).toHaveCount(0);
    await expect(panel.getByTestId("harness-stack-exhausted")).toHaveCount(0);
  });
});

test.describe("harness-stack codex swap", () => {
  test.use({ backendEnv: { AGETOR_E2E_CODEX_STUB: "1" } });
  test.setTimeout(90_000);

  test("a Codex usage limit moves the task to the backup account on the fake Codex driver", async ({
    page,
    freshBackend: backend,
  }) => {
    const tag = `${Date.now()}`;
    const a = `e2e-cx-a-${tag}`;
    const b = `e2e-cx-b-${tag}`;
    const rootA = await createStackAccount(backend, a, "codex");
    await createStackAccount(backend, b, "codex");
    const stack = await createStackViaApi(backend, `e2e codex ${tag}`, "codex", [a, b]);
    const title = `codex swap ${tag}`;
    const taskId = await makeTask(backend, { agent: a, title, prompt: `go ${CODEX_LIMIT_MARKER}` });
    // The fake driver reports the thread id `fake-codex-thread-<task>` at spawn
    // but, unlike real codex, writes no rollout file. The session transfer
    // needs one under the account's CODEX_HOME, so plant it where codex would.
    const thread = `fake-codex-thread-${taskId}`;
    const rolloutDir = path.join(rootA, "sessions", "2026", "11", "08");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      path.join(rolloutDir, `rollout-2026-11-08T00-00-00-${thread}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: thread } })}\n`,
    );
    await startTaskApi(backend, taskId);

    const settled = await waitForTask(backend, taskId, "swapped and settled", (t) => t.agent === b && t.column !== "running", 30_000);
    expect(["review", "done"]).toContain(settled.column);
    const runs = runsOf(backend, taskId);
    expect(runs.length).toBe(2);
    expect(runs[0]!.agent).toBe(a);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[1]!.agent).toBe(b);
    expect(runs[1]!.origin).toBe("harness-swap");
    expect(
      queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM harness_swap_events WHERE stack_id = ? AND trigger = 'limit'", [stack.id]),
    ).toBe(1);

    await gotoApp(page, backend.bootBase);
    const panel = await panelFor(page, title);
    const divider = panel.getByTestId("harness-swap-divider");
    await expect(divider).toBeVisible();
    await expect(divider).toContainText(`Switched to ${b}`);
    await expect(divider).toContainText("(2/2)");
  });
});

test.afterAll(async ({ backend }) => {
  const del = (p: string) => fetch(`${backend.apiBase}${p}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  for (const id of createdTaskIds) await del(`/tasks/${id}`);
  for (const id of createdStackIds) await del(`/harness-stacks/${id}`);
  for (const id of createdHarnessIds) await del(`/harnesses/${id}`);
});
