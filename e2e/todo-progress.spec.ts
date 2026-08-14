import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Mirrors `FAKE_CLAUDE_TODOS_PROMPT_MARKER` in `src/bun/agents.ts` (kept as a
 * literal, not an import: `src/bun/*.ts` pulls in `bun:sqlite`/tmux-driver
 * modules that Node's ESM loader — which is what runs Playwright's own test
 * process, as opposed to the `bun` runtime the headless backend under test
 * runs on — can't resolve; `bun:`-scheme specifiers 404 the whole test file
 * with "Only URLs with a scheme in: file, data, and node are supported").
 * `src/shared/*.ts` (runtime-import-free by convention) is safe to import
 * from e2e specs; `src/bun/*.ts` is not.
 */
const FAKE_CLAUDE_TODOS_PROMPT_MARKER = "__agetor_fake_claude_todos__";

/**
 * E2E coverage for the Task-tools (`TaskCreate`/`TaskUpdate`) todo tracker
 * (docs/plans/claude-code-plan-mode-and-todo-tracker.md, T6): a canned fake-
 * driver scenario runs a real turn through the real orchestrator, and this
 * spec asserts the derived progress lands in both places a user sees it —
 * the RunPanel's pinned `TodoProgressCard` and the board `TaskCard`'s mini
 * badge — proving the chunks → `deriveTodoProgress`/`maybeUpdateTodoProgress`
 * (orchestrator.ts) → `tasks.todo_progress` → UI loop end to end.
 *
 * **Triggering the scenario without touching `e2e/fixtures.ts`**: the fake
 * driver's todo scenario (`makeFakeAgent` in `src/bun/agents.ts`) is
 * primarily gated on `AGETOR_FAKE_CLAUDE_TODOS=1`, but that env var is fixed
 * for the whole `headless.ts` process at spawn time — `e2e/fixtures.ts`'s
 * `backend`/`freshBackend` fixtures spawn one such process per WORKER with a
 * single hardcoded env block (already `AGETOR_CLAUDE_DRIVER=fake`, per
 * quote.spec.ts's header comment) shared by every test/task that worker
 * runs, and there is no per-test/per-spec env override in that fixture API
 * today. Rather than widen a fixture I don't own, `agents.ts` also accepts a
 * prompt-embedded marker (`FAKE_CLAUDE_TODOS_PROMPT_MARKER`, exported for
 * exactly this) as an e2e-reachable equivalent of the env gate — a spec can
 * always control `task.prompt` at create time via the plain `/tasks` API,
 * same as quote.spec.ts controls it to get a deterministic echo. Trade-off:
 * this exercises driver-selection logic that's slightly wider than the real
 * env-only gate a unit test would hit, but the scenario body itself (the
 * canned chunks) is identical either way, so the tracker's UI/orchestrator
 * plumbing is still proven end to end against production code, not a stub.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task whose prompt embeds the todo-scenario marker (isolation
 *  "none", a plain non-git temp dir as workdir — the fake driver never
 *  touches the filesystem) and start it. Mirrors quote.spec.ts's
 *  `createAndStartFakeClaudeTask`. */
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

/** The run panel's slide-over `<aside>` — see quote.spec.ts's identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is
 *  also an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as quote.spec.ts's `openTask`.
 *  `.first()` resolves the board `CardTitle` over any later text-match
 *  inside the (not-yet-open) panel. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("todo progress tracker", () => {
  test("fake TaskCreate/TaskUpdate turn renders the RunPanel todo card and the board mini badge", async ({
    page,
    request,
    backend,
  }) => {
    const title = `todo-e2e ${randomUUID()}`;
    await createAndStartFakeTodoTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // The scenario's final chunk before "turn complete" — proof the whole
    // canned turn (both TaskCreates + the TaskUpdate, which land earlier in
    // the same turn) has streamed and been persisted, replayed here over the
    // task's unified SSE event stream regardless of whether the (very fast)
    // fake turn already finished before we navigated.
    await expect(page.getByText("Starting Phase 1 — Investigate now.")).toBeVisible();

    // --- RunPanel: pinned TodoProgressCard --------------------------------
    // Header line mirrors Claude Code's own Task-tools UI ("N tasks · M
    // done · K open") — 2 created, 0 completed, task #1 flipped to
    // in_progress by the TaskUpdate chunk (0 done, not 1). The three counts
    // + separators are separate sibling `<span>`s in `TodoProgressCard.tsx`
    // with no literal whitespace between them in JSX, so the rendered text
    // concatenates with no spaces around "·" (unlike the source comment's
    // spaced rendering above) — match that exact DOM text, not the spaced
    // prose form.
    await expect(panel.getByText("2 tasks·0 done·2 open")).toBeVisible();
    // `progress.activeForm` is task #1's `activeForm` ("Investigating"),
    // shown as the card's title once a todo is in_progress.
    await expect(panel.getByText("Investigating", { exact: true })).toBeVisible();
    await expect(panel.getByText("Phase 1 — Investigate", { exact: true })).toBeVisible();
    await expect(panel.getByText("Phase 2 — Implement", { exact: true })).toBeVisible();

    // --- Board: TaskCard mini badge -----------------------------------
    // `title` attribute is unique to the board badge (TaskCard.tsx) — the
    // RunPanel's own "0/2" count in the TodoProgressCard header carries no
    // such attribute, so this locator can't accidentally match the panel
    // instead of the board card. The board list polls every 2s (App.tsx),
    // so give it real headroom past the default assertion timeout.
    await expect(page.locator('[title="0 of 2 tasks done"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[title="0 of 2 tasks done"]').getByText("0/2", { exact: true })).toBeVisible();
  });
});
