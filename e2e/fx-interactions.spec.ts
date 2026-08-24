import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Mirrors two prompt-embedded fake-driver markers exported from
 * `src/bun/agents.ts` (kept as literals, not imports — same rationale as
 * `todo-progress.spec.ts`'s identical comment: `src/bun/*.ts` pulls in
 * `bun:sqlite`/tmux-driver modules that Node's ESM loader, which is what
 * runs Playwright's own test process as opposed to the `bun` runtime the
 * headless backend under test runs on, can't resolve — a `bun:`-scheme
 * specifier 404s the whole test file).
 *
 * `FAKE_CLAUDE_TODOS_PROMPT_MARKER` triggers the generic Task-tools
 * (`TaskCreate`/`TaskUpdate`) canned scenario in `makeFakeAgent` — agent-
 * agnostic, so routing it through an `agent: "fx"` task proves the todo
 * tracker (RunPanel card + board badge) works identically for fx, not just
 * claude. `FAKE_FX_PERMISSION_PROMPT_MARKER` triggers the fx-specific
 * `session/request_permission` scenario: it registers a real `fx_permission`
 * card via `registerFxPermission` and blocks the fake turn until the card is
 * answered (by this spec's own HTTP call through the UI, or by `kill()` on
 * teardown), mirroring the real ACP driver's registry-awaiter discipline.
 */
const FAKE_CLAUDE_TODOS_PROMPT_MARKER = "__agetor_fake_claude_todos__";
const FAKE_FX_PERMISSION_PROMPT_MARKER = "__agetor_fake_fx_permission__";

/**
 * E2E coverage for fx's ACP-native interaction surfaces (docs/plans/fx-
 * branch-finalization.md T8): the plan→TODO tracker reused unmodified from
 * claude, and the `fx_permission` permission card end to end — click-through
 * (an offered option) and the unconditional Dismiss/reject path. All three
 * drive a real turn through the real orchestrator via the in-process fake
 * fx driver (`AGETOR_FX_DRIVER=fake`, e2e/fixtures.ts), so the coverage is
 * of production wiring (orchestrator → SSE → RunPanel → the answer route),
 * not a stubbed component.
 *
 * fx ships disabled by default (migration 046, `enabled=0` — same house
 * style as codex/cursor) so every test here needs the harness enabled first;
 * done once per worker in `beforeAll` since `backend` is worker-scoped and
 * the toggle is idempotent/persists across this file's serial tests.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

async function enableFxHarness(backend: E2EBackend): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/fx`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${backend.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /harnesses/fx -> ${res.status}: ${await res.text()}`);
  }
}

/** Create an fx task whose prompt embeds the given fake-driver marker
 *  (isolation "none", a plain non-git temp dir as workdir — the fake driver
 *  never touches the filesystem) and start it. Mirrors todo-progress.spec
 *  .ts's `createAndStartFakeTodoTask`, parametrized by agent + marker so it
 *  covers both fake scenarios this file exercises. */
async function createAndStartFakeFxTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  promptMarker: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `${promptMarker} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, agent: "fx", isolation: "none", workdir: tmpdir() },
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

/** The run panel's slide-over `<aside>` — see todo-progress.spec.ts's
 *  identical helper for why `.last()` is the right pick (NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as todo-progress.spec.ts's
 *  `openTask`. `.first()` resolves the board `CardTitle` over any later
 *  text-match inside the (not-yet-open) panel. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("fx interactions", () => {
  test.beforeAll(async ({ backend }) => {
    await enableFxHarness(backend);
  });

  test("fake TaskCreate/TaskUpdate turn renders the todo card and board badge for an fx task", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-todo-e2e ${randomUUID()}`;
    await createAndStartFakeFxTask(request, backend, title, FAKE_CLAUDE_TODOS_PROMPT_MARKER);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // Proof the whole canned turn streamed and was persisted, replayed here
    // over the task's unified SSE event stream — mirrors todo-progress.spec
    // .ts's identical assertion.
    await expect(page.getByText("Starting Phase 1 — Investigate now.")).toBeVisible();

    // --- RunPanel: pinned TodoProgressCard --------------------------------
    await expect(panel.getByText("2 tasks·0 done·2 open")).toBeVisible();

    // --- Board: TaskCard mini badge ----------------------------------
    await expect(page.locator('[title="0 of 2 tasks done"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[title="0 of 2 tasks done"]').getByText("0/2", { exact: true })).toBeVisible();
  });

  test("fx_permission card click-through: choosing an option resolves the turn", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-permission-allow-e2e ${randomUUID()}`;
    await createAndStartFakeFxTask(request, backend, title, FAKE_FX_PERMISSION_PROMPT_MARKER);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await expect(panel.getByText("Fx is requesting permission")).toBeVisible();
    const allowOnce = panel.getByRole("button", { name: "Allow once" });
    await expect(allowOnce).toBeVisible();
    await allowOnce.click();

    // The fake scenario's echo status, proving the answer round-tripped
    // through the real `/fx-permissions/:id/answer` route and unblocked the
    // registry awaiter, same as the real ACP driver would.
    await expect(panel.getByText("fake fx permission resolved: allow-once", { exact: true })).toBeVisible();
    await expect(panel.getByText("Fx is requesting permission")).toHaveCount(0);
  });

  test("fx_permission card dismiss: unconditional reject resolves the turn cancelled", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-permission-dismiss-e2e ${randomUUID()}`;
    await createAndStartFakeFxTask(request, backend, title, FAKE_FX_PERMISSION_PROMPT_MARKER);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await expect(panel.getByText("Fx is requesting permission")).toBeVisible();
    const dismiss = panel.getByRole("button", { name: "Dismiss (reject)" });
    await expect(dismiss).toBeVisible();
    await dismiss.click();

    await expect(panel.getByText("fake fx permission resolved: cancelled", { exact: true })).toBeVisible();
    await expect(panel.getByText("Fx is requesting permission")).toHaveCount(0);
  });
});
