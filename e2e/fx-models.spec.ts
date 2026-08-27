import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { AGENT_OPTIONS } from "../src/shared/types.ts";

/**
 * E2E coverage for `docs/plans/fx-model-catalog-refresh.md` TT1: the fx model
 * picker must show the signed-in account's discovered catalog (curated ∩
 * discovered, plus discovered-only ids) rather than the full static curated
 * list, must populate live without a page reload (the boot-race D4/D5 close),
 * and its manual ↻ must work — across all three surfaces that render a model
 * picker for fx (New Task form, task-details inline editor). CLI parity
 * (`agetor add`, T8) is out of scope here — no Playwright coverage of the CLI.
 *
 * The account catalog is stood in by `e2e/fixtures.ts`'s fx stub binary,
 * which now answers `fx models --json` with a small fixed 3-id catalog:
 * `zai/glm-5.3-flash` and `openai/gpt-5.2` (both curated rows, proving the
 * curated ∩ discovered intersection) plus `e2e/discovered-only` (no curated
 * row, proving the discovered-only-id append). Every other curated fx id —
 * including non-catalogOnly rows like `spacexai/grok-4.6` /
 * `moonshotai/kimi-k2.7-code` and every `catalogOnly` premium row — is
 * absent from that 3-id catalog, so `mergeModelOptions`'s scoped branch
 * (`src/shared/model-options.ts`) filters them all out. This is the exact
 * merged list every test below polls for.
 *
 * fx ships disabled by default (migration 046), so the first test enables it
 * — and does so from *inside* the test, immediately before navigating,
 * rather than in a `beforeAll` — because proving "populates without a
 * reload" requires the harness to go from disabled to enabled with no
 * `page.reload()` anywhere in that test's body. The remaining tests reuse
 * the now-enabled harness (this file runs `mode: "serial"`, and `backend` is
 * worker-scoped — same pattern as e2e/fx-interactions.spec.ts).
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** The merged option *text* content every fx picker in this file should
 *  converge to — see the module doc comment above for why exactly these
 *  three. Order matters: curated rows first (curated-list order, filtered to
 *  those present in the discovered catalog), then discovered-only ids
 *  (discovered-list order) — `mergeModelOptions` rules 3/5. */
const EXPECTED_FX_OPTION_LABELS = ["GLM 5.3 Flash", "GPT-5.2", "e2e/discovered-only"];

/** `DEFAULT_MODEL.fx` (src/shared/types.ts) — the owner-chosen default
 *  (2026-08-27), also the first curated row, so it's always present in the
 *  converged list above and should be the picker's initial selected value. */
const FX_DEFAULT_MODEL_ID = "zai/glm-5.3-flash";

/** Curated ids that must NOT survive the curated ∩ discovered filter against
 *  the 3-id stub catalog: two ordinary curated rows absent from the stub
 *  (`spacexai/grok-4.6`, `moonshotai/kimi-k2.7-code`) and three of the five
 *  `catalogOnly` premium rows (absent from the stub the same as any other
 *  id would be — catalogOnly gates them even harder, but plain absence
 *  already excludes them under the scoped merge). */
const EXCLUDED_FX_OPTION_LABELS = ["Grok 4.6", "Kimi K2.7 Code", "Claude Opus 5", "GPT-5.5", "Kimi K3"];

/** Mirrors `e2e/fx-interactions.spec.ts`'s identical helper. Duplicated
 *  locally rather than imported — this task's brief scopes edits to this
 *  file plus `e2e/fixtures.ts` only, and every e2e spec file in this repo
 *  already owns its own small local helpers (`openTask`/`runPanel` are
 *  redefined per file too) rather than sharing a growing cross-file helper
 *  module. */
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

/** Creates an fx task (isolation "none", a plain non-git temp dir as
 *  workdir) WITHOUT starting it — this file only needs the task-details
 *  editor, which is editable for any non-running/non-blocked task, so
 *  there's no reason to spend a fake-driver turn. Mirrors the create half of
 *  fx-interactions.spec.ts's `createAndStartFakeFxTask`, minus the
 *  `/start` call. */
async function createFxTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: title, agent: "fx", isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  return (await createRes.json()) as TaskRow;
}

/** The New Task sidebar's `<aside>` — mounted first in App.tsx's JSX, ahead
 *  of the run panel's own `<aside>` (see `runPanel` below), so `.first()`
 *  resolves it unambiguously. */
function newTaskFormPanel(page: Page): Locator {
  return page.locator("aside").first();
}

/** The run panel's slide-over `<aside>` — same `.last()` idiom
 *  e2e/fx-interactions.spec.ts and e2e/todo-progress.spec.ts use, since
 *  NewTaskForm's sidebar is also an `<aside>` mounted first. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as fx-interactions.spec.ts's
 *  `openTask`. `.first()` resolves the board `CardTitle` over any later
 *  text match inside the (not-yet-open) panel. */
async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Clicks the given harness's button in the New Task form's Harness picker.
 *  Only enabled harnesses render here (`availableHarnesses` in
 *  NewTaskForm.tsx filters on `h.enabled`), so this doubles as an assertion
 *  that the harness is actually enabled and the (fresh-per-navigation)
 *  harness list fetch has already picked that up. */
async function selectHarness(page: Page, label: string): Promise<void> {
  const button = newTaskFormPanel(page).getByRole("button", { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
}

/**
 * The New Task form's Model `<select>`. There is no `htmlFor`/`aria-
 * labelledby` wiring the "Model" `<label>` to the `<select>` (NewTaskForm
 * .tsx), so this locates structurally instead: the "Refresh model list"
 * button (`data-testid="refresh-models"`, unique to this form — the
 * task-details editor's twin carries a different testid) sits in a small
 * flex row that is the immediate previous sibling of the `<Select>`, both
 * children of one shared `space-y-1` wrapper. Two levels up from the button
 * lands on that wrapper; `select` inside it is the Model dropdown.
 */
function newTaskModelSelect(page: Page): Locator {
  return page.getByTestId("refresh-models").locator("xpath=../..").locator("select");
}

/**
 * The task-details inline editor's Model `<select>` (RunPanel.tsx). Its
 * "Refresh model list" button (`data-testid="refresh-models-details"`) lives
 * inside the `<dt>Model</dt>` cell of a `<dl>`; the editable `<select>` is
 * inside the very next `<dd>` sibling. `panel` should already be scrolled to
 * / have its "Task details" `<details>` expanded before this resolves
 * anything.
 */
function detailsModelSelect(panel: Locator): Locator {
  return panel
    .getByTestId("refresh-models-details")
    .locator("xpath=../following-sibling::dd[1]")
    .locator("select");
}

/**
 * Polls a Model `<select>`'s `<option>` text content until it converges to
 * `EXPECTED_FX_OPTION_LABELS` (curated ∩ discovered + discovered-only, per
 * the module doc comment). This is deliberately a poll, not a single
 * assertion or a sleep: the server-side discovery probe for a just-enabled
 * (or just-refreshed) fx harness runs asynchronously, and the webview only
 * learns about the result via the `agent_models_changed` SSE event or the
 * bounded 2s ready-retry (docs/plans/fx-model-catalog-refresh.md §3 D4/D5)
 * — never synchronously with whatever action triggered the probe.
 */
async function expectConvergedFxOptions(select: Locator, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => select.locator("option").allTextContents(), {
      timeout,
      message: "fx model picker never converged to curated ∩ discovered + discovered-only",
    })
    .toEqual(EXPECTED_FX_OPTION_LABELS);
}

test.describe("fx model catalog picker", () => {
  test("New Task form: picker shows curated ∩ discovered catalog, converging live with no page reload", async ({
    page,
    backend,
  }) => {
    // Enabling from inside the test, immediately before navigating, is what
    // lets this test also stand in for "no reload needed" (next assertion
    // block): fx starts this test disabled, and nothing below ever calls
    // page.reload() — the picker must reach the converged catalog purely
    // through the app's own live triggers.
    await enableFxHarness(backend);
    await gotoApp(page, backend.bootBase);

    await selectHarness(page, "fx.sh");
    const modelSelect = newTaskModelSelect(page);

    // --- Convergence without a reload -------------------------------------
    // No `page.reload()` call exists anywhere in this test — this poll is
    // the boot-race/trigger claim itself: the harness-enable PATCH fired a
    // server-side re-probe (model-discovery.ts's refreshHarnessModels), and
    // this assertion waits for that probe's result to reach the webview
    // live (SSE push or ready-retry), never via a fresh page load.
    await expectConvergedFxOptions(modelSelect);

    const texts = await modelSelect.locator("option").allTextContents();
    for (const label of EXPECTED_FX_OPTION_LABELS) {
      expect(texts).toContain(label);
    }
    for (const label of EXCLUDED_FX_OPTION_LABELS) {
      expect(texts).not.toContain(label);
    }

    // --- Default selection ---------------------------------------------
    await expect(modelSelect).toHaveValue(FX_DEFAULT_MODEL_ID);
  });

  test("New Task form: refresh-models button re-probes and keeps the converged catalog", async ({
    page,
    backend,
  }) => {
    // fx was enabled by the previous (serial) test and its catalog already
    // converged there — a fresh navigation here re-fetches everything from
    // scratch, so this test also incidentally proves the converged state
    // survives an ordinary reload (as opposed to the specific "must not
    // need one" claim the previous test makes).
    await gotoApp(page, backend.bootBase);
    await selectHarness(page, "fx.sh");
    const modelSelect = newTaskModelSelect(page);
    await expectConvergedFxOptions(modelSelect);

    const refreshButton = page.getByTestId("refresh-models");
    await expect(refreshButton).toBeVisible();
    await expect(refreshButton).toBeEnabled();
    await refreshButton.click();

    // The button's own onClick awaits `onRefreshModels` (forces a fresh
    // probe, then refetches both model maps) before it stops spinning — but
    // poll rather than assume the click resolved synchronously with the
    // network round-trip; the stub catalog is fixed, so the only thing this
    // proves is that a manual refresh doesn't regress the list.
    await expectConvergedFxOptions(modelSelect);
  });

  test("New Task form: switching to Claude Code shows its own full curated list, unaffected by fx's filter", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    // Start from fx (already enabled) so this test actually exercises a
    // switch AWAY from the account-scoped kind, not just claude-code's
    // already-default state — guards against the merge helper leaking fx's
    // discovered-catalog filter into another kind's picker.
    await selectHarness(page, "fx.sh");
    const modelSelect = newTaskModelSelect(page);
    await expectConvergedFxOptions(modelSelect);

    await selectHarness(page, "Claude Code");

    const claudeCuratedLabels = AGENT_OPTIONS["claude-code"].models.map((m) => m.label);
    // claude-code's own discovery always returns [] (no programmatic
    // model-list command exists — see agent-discovery.ts's discoverClaude),
    // so its picker takes `mergeModelOptions`'s discovery-empty fallback
    // (curated list, as-is) regardless of `scoped` — the full curated set,
    // unfiltered. A leak of fx's 3-id discovered catalog into claude-code's
    // `discoveredForAgent` (e.g. a harness-id/kind key mixup) would instead
    // intersect claude's ids against fx's Gateway ids and produce an empty
    // (or unrecognizable) list, failing this exact-equality check.
    await expect
      .poll(async () => modelSelect.locator("option").allTextContents(), { timeout: 10_000 })
      .toEqual(claudeCuratedLabels);

    // Named explicitly per this task's ask: the curated first option
    // (fx-model-catalog-refresh.md's own "Mythos 5" row today) must be
    // present, not just the list length.
    expect(claudeCuratedLabels[0]).toBeTruthy();
    const texts = await modelSelect.locator("option").allTextContents();
    expect(texts).toContain(claudeCuratedLabels[0]);
  });

  test("Task details editor: shows the same converged fx catalog and has its own refresh button", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-models-details-e2e ${randomUUID()}`;
    const task = await createFxTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // The "Task details" section is a native <details>/<summary> — closed
    // by default — click it open to reveal the Agent/Mode/Model/Effort
    // editors underneath.
    await panel.getByText("Task details", { exact: true }).click();

    const modelSelect = detailsModelSelect(panel);
    await expectConvergedFxOptions(modelSelect);
    await expect(modelSelect).toHaveValue(FX_DEFAULT_MODEL_ID);

    // A freshly-created, never-started task sits in column "backlog", so
    // RunPanel's `editable` (`task.column !== "running" && !== "blocked"`)
    // is true and the inline editor — including its own ↻ — renders.
    await expect(panel.getByTestId("refresh-models-details")).toBeVisible();

    const deleteRes = await request.delete(`${backend.apiBase}/tasks/${task.id}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(deleteRes.ok(), `DELETE /tasks/${task.id} -> ${deleteRes.status()}`).toBeTruthy();
  });
});
