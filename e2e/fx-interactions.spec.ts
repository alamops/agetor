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

/**
 * Ids of every task `createAndStartFakeFxTask` has created in this file, so
 * `test.afterAll` below can delete every one of them once the file's tests
 * are done. Left behind, each is a `workdir: tmpdir()` row that outlives
 * this file and — because `GET /tasks` orders newest-first — can become
 * `tasks[0]` for whatever spec runs next in the same worker (the worker-
 * scoped `backend` fixture, e2e/fixtures.ts, is shared across every spec
 * file that lands in that worker). `App.tsx`'s Git dialog falls back to
 * `tasks[0]?.workdir` when no task/prefill points it elsewhere, so a
 * leftover tmpdir task there makes the dialog default to a synthetic,
 * unregistered "T" project — exactly the failure this cleanup prevents in
 * e2e/pr-merged-state.spec.ts (see that file's header comment).
 */
const createdTaskIds: string[] = [];

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
 *  covers both fake scenarios this file exercises. `promptMarker` is
 *  optional — omitting it produces a bare prompt that matches neither
 *  `FAKE_CLAUDE_TODOS_PROMPT_MARKER` nor `FAKE_FX_PERMISSION_PROMPT_MARKER`,
 *  so `makeFakeAgent` (src/bun/agents.ts) falls through to its generic
 *  echo-back scenario — the one used below to exercise the provider chip
 *  without pulling in either marked scenario. */
async function createAndStartFakeFxTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  promptMarker?: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = promptMarker ? `${promptMarker} ${title}` : title;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, agent: "fx", isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;
  // Recorded before the start assertion below so a failed `start` still
  // leaves this task's id tracked for afterAll cleanup — the POST /tasks
  // row already exists at this point regardless of what start does next.
  createdTaskIds.push(task.id);

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

  /** Deletes every task this file created and, defensively, any leftover
   *  `workdir: tmpdir()` project row — see the `createdTaskIds` comment
   *  above for why this matters to sibling specs sharing the worker.
   *  `afterAll` only has worker-scoped fixtures (`backend`) available, same
   *  as `beforeAll` — the `request` fixture is test-scoped — so this uses
   *  plain `fetch` with the bearer token, mirroring `enableFxHarness`. */
  test.afterAll(async ({ backend }) => {
    const auth = { authorization: `Bearer ${backend.apiToken}` };

    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }

    // This file's tasks are never registered as projects — createTask
    // (src/bun/orchestrator.ts) deliberately never upserts a task's workdir
    // into the projects table. This check is purely defensive against that
    // changing: if a `tmpdir()` project row exists anyway, remove it too so
    // it can't leak into a sibling spec's project picker.
    const projectsRes = await fetch(`${backend.apiBase}/projects`, { headers: auth });
    if (projectsRes.ok) {
      const registered = (await projectsRes.json()) as Array<{ path: string }>;
      const dir = tmpdir();
      for (const p of registered) {
        if (p.path !== dir) continue;
        await fetch(`${backend.apiBase}/projects`, {
          method: "DELETE",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ path: p.path }),
        }).catch(() => {});
      }
    }
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

  test("fx run's provider sentinel renders the RunsList provider chip and stays out of the transcript", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-provider-chip-e2e ${randomUUID()}`;
    // No fake-driver marker — falls into `makeFakeAgent`'s generic fallback
    // scenario (src/bun/agents.ts), which — only for `kind: "fx"` — emits the
    // `fx-provider: gateway` status chunk before any turn content, mirroring
    // fx-acp.ts's real `maybeEmitProvider`. Every fx fake scenario in this
    // file shares that emission (the permission scenario above emits it too),
    // but this one is the least entangled: no card, no todo tracker, just the
    // sentinel + a plain echo, so the assertions below are about the chip and
    // nothing else.
    await createAndStartFakeFxTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // Proof the turn actually ran and completed via the generic echo
    // scenario — same "whole turn streamed and was persisted" rationale as
    // the todo test's `getByText` assertion above.
    await expect(panel.getByText(`fake response to: ${title}`, { exact: true })).toBeVisible();

    // --- RunsList: provider chip on the (only, so always-visible-without-
    // expanding) run's summary row. No `data-testid` exists on `ProviderChip`
    // (src/mainview/components/kanban/RunPanel.tsx) — a testid would be a
    // sturdier locator than text + title, but per this task's scope src/ is
    // not touched to add one, so this locates by the chip's exact visible
    // text, scoped to the run panel to avoid matching an unrelated "gateway"
    // occurrence elsewhere on the page.
    const providerChip = panel.getByText("gateway", { exact: true });
    await expect(providerChip).toBeVisible();
    await expect(providerChip).toHaveAttribute("title", "fx provider");

    // --- Transcript: the raw sentinel line must never render — RunPanel's
    // `isInternalStatusSentinel` suppression (shared/types.ts) is what keeps
    // it out, and this is the load-bearing assertion that guards against a
    // future change letting it leak back into the scrollback as a
    // StatusDivider.
    await expect(panel.getByText("fx-provider: gateway", { exact: true })).toHaveCount(0);
  });
});
