import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for TT4 of `docs/plans/claude-code-monitors-hold-running.md`:
 * a Claude Code Monitor (the `Monitor` tool — what `/loop`/"watch this log"
 * workflows use) counts as background work for the task that armed it, so
 * the board card stays in `running` from the monitor's launch until it ends,
 * rather than flipping to `review` the moment the visible turn's `end_turn`
 * lands. This spec drives the real orchestrator (`holdForSubagents` /
 * `maybeReleaseHeldTask` in `src/bun/orchestrator.ts`) end to end through
 * the fake-driver monitor scenario in `src/bun/agents.ts`, asserting both
 * the API-observable state (task.column, task.runningSubagents, the run's
 * terminal status) and the UI surfaces (board badge, RunPanel hold line,
 * subagent tab).
 *
 * Mirrors `FAKE_CLAUDE_MONITOR_PROMPT_MARKER` in `src/bun/agents.ts` (kept as
 * a literal, not an import — see `e2e/todo-progress.spec.ts`'s header
 * comment for why `src/bun/*.ts` can't be imported from a Playwright spec
 * file: Node's ESM loader, which runs the Playwright test process itself as
 * opposed to the `bun` runtime the headless backend under test runs on,
 * can't resolve `bun:sqlite`/tmux-driver imports transitively pulled in by
 * that module). The scenario supports an optional `:<ms>` suffix controlling
 * how long the monitor stays "running" before it settles with a receipt —
 * this spec uses 8000ms, long enough to deterministically observe the held
 * state (board badge, hold line, monitor tab) before asserting the release,
 * short enough to keep the whole spec well under a minute.
 */
const FAKE_CLAUDE_MONITOR_PROMPT_MARKER = "__agetor_fake_claude_monitor__";
const MONITOR_SETTLE_MS = 8000;

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
  column: string;
  runningSubagents?: number;
}

interface RunRow {
  id: string;
  status: string;
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Create a task with the given prompt (isolation "none", a plain non-git
 *  temp dir as workdir — the fake driver never touches the filesystem) and
 *  start it, mirroring `e2e/todo-progress.spec.ts`'s
 *  `createAndStartFakeTodoTask`. */
async function createAndStartTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  prompt: string,
): Promise<TaskRow> {
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: auth(backend),
  });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as TaskRow;
}

/** Newest-first per `GET /tasks/:id/runs`'s doc comment (server.ts /
 *  runs.listForTask) — index 0 is always the run this spec just started. */
async function latestRunStatus(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
): Promise<string | undefined> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${taskId}/runs -> ${res.status()}`).toBeTruthy();
  const runs = (await res.json()) as RunRow[];
  return runs[0]?.status;
}

/** Polls the latest run's status via the API until it matches, rather than
 *  sleeping a fixed duration — deterministic under load, per the task's
 *  "no waitForTimeout" instruction. */
async function waitForLatestRunStatus(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: string,
  timeoutMs = 20_000,
): Promise<void> {
  await expect(async () => {
    const status = await latestRunStatus(request, backend, taskId);
    expect(status).toBe(expected);
  }).toPass({ timeout: timeoutMs });
}

/** Polls `task.column` via the API until it matches. */
async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: string,
  timeoutMs = 20_000,
): Promise<void> {
  await expect(async () => {
    const task = await getTask(request, backend, taskId);
    expect(task.column).toBe(expected);
  }).toPass({ timeout: timeoutMs });
}

async function deleteTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `DELETE /tasks/${id} -> ${res.status()}`).toBeTruthy();
}

/** The run panel's slide-over `<aside>` — see `e2e/quote.spec.ts`'s identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is also
 *  an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as `e2e/todo-progress.spec.ts`'s
 *  `openTask`. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  `TaskCard.tsx`'s root `<Card>` carries `cursor-grab` (drag handle
 *  styling, unique to board cards; the run panel's `<aside>` never has it),
 *  mirroring `e2e/unread-indicator.spec.ts`'s identical helper. */
function taskCard(page: Page, title: string) {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/** Scopes a locator to one kanban column's container div by its visible
 *  heading ("Running", "Review", …) — `Column.tsx` renders `<div
 *  className="flex w-72 shrink-0 flex-col …">` with an `<h2>{label}</h2>`
 *  nested two levels inside; `w-72 shrink-0` together is a combination no
 *  other element in the app uses (verified: `ExtensionPicker.tsx`'s popover
 *  uses `w-72` alone, never paired with `shrink-0`), so this can't
 *  accidentally match a different container. */
function boardColumn(page: Page, label: string) {
  return page.locator("div.w-72.shrink-0").filter({
    has: page.getByRole("heading", { name: label, exact: true }),
  });
}

/** True once the given task's card renders inside the named column. */
function taskInColumn(page: Page, label: string, title: string) {
  return boardColumn(page, label).locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

test.describe("claude code monitor hold", () => {
  test("a live Monitor holds the card in running (badge, hold line, tab) and releases it to review once the monitor settles", async ({
    page,
    request,
    backend,
  }) => {
    // Generous ceiling: MONITOR_SETTLE_MS (8s) plus wide margin for the
    // held-state UI assertions and the post-settle release wait, on a
    // machine that can be under heavy load (see task instructions).
    test.setTimeout(120_000);

    const title = `monitor-hold-e2e ${randomUUID()}`;
    const prompt = `${FAKE_CLAUDE_MONITOR_PROMPT_MARKER}:${MONITOR_SETTLE_MS} ${title}`;
    const task = await createAndStartTask(request, backend, title, prompt);

    try {
      // --- (1) the turn resolves, but the card stays in `running` ---------
      // The fake driver's monitor scenario resolves the turn (run ->
      // succeeded) within ~12ms of spawn, well before the monitor settles —
      // `holdForSubagents` (orchestrator.ts) keeps the task parked in
      // `running` because `subagents.hasRunning(taskId)` is still true.
      await waitForLatestRunStatus(request, backend, task.id, "succeeded");
      const held = await getTask(request, backend, task.id);
      expect(held.column).toBe("running");
      expect(held.runningSubagents).toBe(1);

      await gotoApp(page, backend.bootBase);

      // Board: card is in Running, with the background-task badge.
      await expect(taskInColumn(page, "Running", title)).toBeVisible({ timeout: 10_000 });
      const badge = taskCard(page, title).locator('[title="1 background task running"]');
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("1");

      // --- (2) task details show the hold line + a monitor tab ------------
      const panel = await openTask(page, title);
      await expect(
        panel.getByText("Holding in running — 1 monitor still active", { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
      const monitorTab = panel.locator('[role="tab"]').filter({ hasText: "Fake monitor" });
      await expect(monitorTab).toBeVisible({ timeout: 10_000 });

      // --- (3) once the monitor settles, the card moves to `review` -------
      await waitForColumn(request, backend, task.id, "review", MONITOR_SETTLE_MS + 30_000);
      const released = await getTask(request, backend, task.id);
      expect(released.runningSubagents).toBe(0);

      await expect(taskInColumn(page, "Review", title)).toBeVisible({ timeout: 15_000 });
      await expect(
        panel.getByText("Holding in running — 1 monitor still active", { exact: true }),
      ).toBeHidden();
    } finally {
      await deleteTask(request, backend, task.id);
    }
  });

  test("a plain fake turn with no monitor marker goes straight to review (no hold)", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(45_000);

    const title = `no-monitor-e2e ${randomUUID()}`;
    // Plain prompt text, no marker at all — the fake driver's default branch
    // (a canned `stdout` chunk + immediate turn completion), which never
    // inserts a `subagents` row, so nothing should hold this card in
    // `running`.
    const task = await createAndStartTask(request, backend, title, title);

    try {
      await waitForLatestRunStatus(request, backend, task.id, "succeeded");
      await waitForColumn(request, backend, task.id, "review", 15_000);
      const done = await getTask(request, backend, task.id);
      expect(done.runningSubagents ?? 0).toBe(0);

      await gotoApp(page, backend.bootBase);
      await expect(taskInColumn(page, "Review", title)).toBeVisible({ timeout: 10_000 });
      // Never held: no background-task badge should ever have appeared.
      await expect(taskCard(page, title).locator('[title="1 background task running"]')).toHaveCount(0);
    } finally {
      await deleteTask(request, backend, task.id);
    }
  });
});
