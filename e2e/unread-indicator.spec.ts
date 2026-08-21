import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the unread-messages corner dot on board `TaskCard`s
 * (docs/plans/unread-bullet-indicator.md, §1 success criteria / §3 approach).
 * Drives a real fake-driver turn through the real orchestrator so the whole
 * chain proves out end to end: `makeChunkHandler`'s watermark bump on a
 * top-level `assistant` chunk (orchestrator.ts) → `tasks.last_assistant_
 * event_id` / `last_seen_event_id` → `Task.unread` computed in `db.ts` →
 * the board `TaskCard`'s corner dot + `App.tsx`'s open/close mark-seen
 * wiring.
 *
 * Mirrors `FAKE_CLAUDE_TODOS_PROMPT_MARKER` in `src/bun/agents.ts` (kept as
 * a literal, not an import — see `e2e/todo-progress.spec.ts`'s identical
 * header comment for why `src/bun/*.ts` can't be imported from a Playwright
 * spec file). The todos scenario is used specifically (rather than the
 * plain default fake-driver reply, which `e2e/quote.spec.ts` exercises) because
 * it's the only canned scenario whose chunks include a genuine top-level
 * `assistant`-stream event (`onChunk("assistant", "Starting Phase 1 —
 * Investigate now.")`, emitted ~23ms after spawn) — the default reply emits
 * a plain `stdout` chunk instead, which the unread watermark deliberately
 * ignores (only `stream === "assistant"` bumps it, per the plan's §3
 * "Trigger scope").
 */
const FAKE_CLAUDE_TODOS_PROMPT_MARKER = "__agetor_fake_claude_todos__";

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task whose prompt embeds the todo-scenario marker (isolation
 *  "none", a plain non-git temp dir as workdir — the fake driver never
 *  touches the filesystem) and start it. Mirrors `e2e/todo-progress.spec.ts`'s
 *  `createAndStartFakeTodoTask`. */
async function createAndStartFakeTodoTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `${FAKE_CLAUDE_TODOS_PROMPT_MARKER} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: auth,
  });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** Polls `GET /tasks/:id` until `unread` matches `expected` — the fake
 *  driver's chunk timers (23ms/26ms after spawn) settle well within a
 *  single poll interval, but this avoids any race against the orchestrator's
 *  async `appendEvent` → `noteAssistantEvent` write. */
async function waitForUnread(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: boolean,
): Promise<void> {
  await expect(async () => {
    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const task = (await res.json()) as { unread: boolean };
    expect(task.unread).toBe(expected);
  }).toPass({ timeout: 10_000 });
}

/** The run panel's slide-over `<aside>` — see `e2e/quote.spec.ts`'s identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is also
 *  an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as `e2e/quote.spec.ts`'s
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
 *  so this can't accidentally match anything inside an open panel. Needed
 *  so the "New messages" dot assertions unambiguously target the board
 *  card rather than any other `[title="New messages"]` element that might
 *  exist elsewhere in the DOM. */
function taskCard(page: Page, title: string) {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

function unreadDot(page: Page, title: string) {
  return taskCard(page, title).locator('[title="New messages"]');
}

test.describe("unread messages indicator", () => {
  test("board dot appears on a new assistant message, clears on open, and stays clear on close", async ({
    page,
    request,
    backend,
  }) => {
    const title = `unread-e2e ${randomUUID()}`;
    const task = await createAndStartFakeTodoTask(request, backend, title);

    // The fake todos scenario's canned assistant chunk lands (and the
    // orchestrator bumps the watermark) well before the UI ever polls —
    // confirm server-side state directly rather than racing the board's 2s
    // poll cycle at load.
    await waitForUnread(request, backend, task.id, true);

    // --- (1) board card shows the dot, without opening the task ----------
    await gotoApp(page, backend.bootBase);
    const dot = unreadDot(page, title);
    await expect(dot).toBeVisible({ timeout: 10_000 });
    await expect(dot).toHaveAttribute("role", "img");
    await expect(dot).toHaveAttribute("aria-label", "New messages");

    // --- (2) opening the task's details clears the dot --------------------
    const panel = await openTask(page, title);
    // Proof the real turn's content streamed into the panel, not just that
    // the dot cleared for an unrelated reason.
    await expect(panel.getByText("Starting Phase 1 — Investigate now.")).toBeVisible();
    await expect(dot).toBeHidden();
    await waitForUnread(request, backend, task.id, false);

    // --- (3) closing the panel leaves the dot cleared ----------------------
    // RunPanel's `<aside>` stays mounted through its slide-out exit
    // animation (translate-x-full, `EXIT_DURATION_MS`) rather than
    // unmounting immediately, so `toBeHidden()` (which only checks CSS
    // visibility/display, not viewport position) wouldn't observe the
    // close — assert on the closed-state class instead, which flips
    // synchronously with the click (App.tsx's `setSelected(null)`, the
    // same state change that flips `TaskCard`'s `isOpen` prop).
    await page.getByRole("button", { name: "Close task panel" }).click();
    await expect(runPanel(page)).toHaveClass(/translate-x-full/);
    await expect(dot).toBeHidden();
    // Re-marked seen on close (covers anything that streamed while open) —
    // confirm the server agrees it's still read, so a later board poll
    // can't reintroduce the dot from stale server state.
    await waitForUnread(request, backend, task.id, false);
  });
});

/*
 * A fifth scenario — a SECOND assistant message arriving on the same task
 * while the panel is closed, asserting the dot reappears — was considered
 * and deliberately left out. The fake todos scenario's canned `assistant`
 * chunk only fires on turn 1 (a fresh spawn); `makeFakeAgent` in
 * `src/bun/agents.ts` explicitly falls back to the *default* branch for any
 * follow-up (`--resume`-shaped) turn on a todos-marked task, and that
 * default branch emits a plain `stdout` chunk, not `assistant` — the one
 * stream the unread watermark tracks. Producing a second genuine
 * `assistant`-stream event on the *same* task therefore has no existing
 * fake-driver hook to lean on; adding one would mean editing
 * `src/bun/agents.ts`, which is out of this test task's scope (owned by the
 * sibling backend-tests task, and shared fixture/driver code besides). Not
 * proportional to fake for this spec alone, so this case is left uncovered
 * here — the reappearance path is exercised at the unit level instead
 * (`src/bun/task-unread.test.ts`'s monotonic-rebump coverage per the plan's
 * Task T1).
 */
