import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2e coverage for the *launch* surfaces of docs/plans/agent-profiles.md
 * (agent profiles) that `e2e/agent-profiles.spec.ts` doesn't already cover:
 * the `AgentProfilePicker` popover's own UX (empty state, search, keyboard
 * nav, clear, Escape), the "Manage agents…" deep link into Settings, the
 * gemini prompt-argv overage warning with the injected preamble (plan §2's
 * "Gemini argv budget" note — both raw and expanded budgets must include the
 * preamble), the unavailable-harness hint rendered inside the picker's
 * "selected" branch, an empty-profile launch (no injected block at all —
 * `composeLaunchPrompt`'s no-op passthrough, plan D3), the task-details
 * lock/hint/chip/Detach cycle (with a tight bound on the *optimistic* merge
 * RunPanel's own `detachProfile` performs — plan item 15's "task-agent-
 * profile-detach" doc comment), `MessageHistoryPicker` stripping the
 * preamble before offering a message for resend (plan D11), a profile
 * deleted out from under an open New Task form's selection, and the
 * transcript block's own collapsed-by-default state on a fresh reopen.
 *
 * `e2e/agent-profiles.spec.ts` owns Settings CRUD (create/edit/rename/
 * duplicate-name-rejection/delete-with-task-count) and the freeze-at-first-
 * run / live-pickup rules — this file assumes those work and focuses purely
 * on the surfaces listed above. Three profiles are seeded via REST once
 * (Alpha/Beta/Gamma below) and reused read-only by every later scenario;
 * Delta and Echo are scoped to the single scenario that needs them. Delta
 * points at a throwaway ALIAS harness (not the built-in `cursor` row) with a
 * deliberately-nonexistent `bin`, rather than relying on `cursor-agent`
 * being absent from PATH — see the "Unavailable-harness hint" test's own
 * comment for why the built-in harness turned out to be a bad fixture for
 * that on a dev machine that happens to have it installed.
 *
 * None of these scenarios ever click "Run task" in the New Task form itself
 * — every task this file starts is created directly over the REST API
 * (`isolation: "none"`, a plain tmp `workdir` — the fake claude-code driver
 * never touches the filesystem, same recipe `agent-profiles.spec.ts` uses),
 * so unlike that file this one never needs a registered git project.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

const createdTaskIds: string[] = [];
const createdProfileIds: string[] = [];
const createdHarnessIds: string[] = [];

// Seeded once by the first test, read-only by everything after it.
let alphaId = "";
let betaId = "";
let gammaId = "";

const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";
const GAMMA_NAME = "Gamma";
const ALPHA_INSTRUCTIONS = "Investigate thoroughly before making any change.";
// Comfortably over gemini's 4096-byte one-shot argv cap once the preamble
// wrapper + a short prompt are added on top (plan §2 "Gemini argv budget").
const GAMMA_INSTRUCTIONS = "g".repeat(4000);
const CLAUDE_MODEL = "opus-5"; // DEFAULT_MODEL["claude-code"] (src/shared/types.ts)
const GEMINI_MODEL = "gemini-3.1-pro-preview";
const CURSOR_MODEL = "cursor-grok-4.6";

// Distinct, greppable prompts so a message-history / transcript assertion
// can't accidentally match the wrong task's send.
const ALPHA_PROMPT = "Investigate the alpha widget thoroughly for regressions";
const BETA_PROMPT = "Ship the beta feature flag rollout";

let taskAlphaTitle = "";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// ---- Locator helpers (mirror e2e/agent-profiles.spec.ts) ----

function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function boardCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Forces a real reload of an already-open app page — unlike a second
 *  `gotoApp(page, backend.bootBase)` call, which navigates to the byte-
 *  identical URL (host, path AND hash all unchanged within one test) and so
 *  can be treated as a same-document/no-op navigation that leaves the
 *  webview's module-level caches (e.g. `useAgentProfiles`'s) untouched
 *  instead of actually reloading the SPA. Use this whenever a test needs to
 *  observe a REST-side mutation through a fresh mount without moving to a
 *  new Playwright test (a fresh `page` fixture already guarantees a true
 *  load, so this is only needed for a second observation point mid-test). */
async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

/** Closes the run panel via its own "Close task details" button and waits
 *  for the backdrop to go inert — never via keyboard Escape (RunPanel's own
 *  Escape listener is rAF-gated on `open` and can be absent while content is
 *  already Playwright-visible), and never via `toBeHidden()` on the `<aside>`
 *  itself (it slides off-screen via a CSS transform, not `display:none`). */
async function closeTaskPanel(page: Page, panel: Locator): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Close task panel" });
  await panel.getByRole("button", { name: "Close task details" }).click();
  await expect(backdrop).toHaveCSS("pointer-events", "none");
}

/** Opens Settings and switches to the Agents section (mirrors
 *  `e2e/agent-profiles.spec.ts`'s `openSettingsAgents`). */
async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

/** The Task-details `<dl>` row for a given `dt` label — its sibling `dd`.
 *  Mirrors `e2e/agent-profiles.spec.ts` / `e2e/fx-models.spec.ts`. */
function detailsRow(panel: Locator, label: string): Locator {
  return panel
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

/** Opens the `AgentProfilePicker` inside `form`, waits for the popover, and
 *  clicks the row for `profileId` — leaves the popover closed (picking a row
 *  closes it synchronously). */
async function selectProfileInForm(form: Locator, profileId: string): Promise<void> {
  const picker = form.getByTestId("agent-profile-picker");
  await picker.getByTestId("agent-profile-picker-trigger").click();
  await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
  await picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${profileId}"]`).click();
}

// ---- REST helpers ----

interface ProfileRow {
  id: string;
  name: string;
}

async function createProfileRest(
  request: APIRequestContext,
  backend: E2EBackend,
  body: {
    name: string;
    harness: string;
    model: string;
    instructions?: string;
    skills?: string[];
    effort?: string | null;
    mode?: string | null;
  },
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/agent-profiles`, {
    headers: auth(backend),
    data: body,
  });
  expect(res.ok(), `POST /agent-profiles -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const created = (await res.json()) as ProfileRow;
  createdProfileIds.push(created.id);
  return created.id;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  agentProfileId: string | null;
  agentProfile: { name: string; instructions: string; harnessKind: string } | null;
}

async function getTaskById(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  if (!res.ok()) return null;
  return (await res.json()) as TaskRow;
}

async function waitForColumn(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: string,
  timeoutMs = CONVERGE_TIMEOUT,
): Promise<void> {
  await expect(async () => {
    const task = await getTaskById(request, backend, taskId);
    expect(task?.column).toBe(expected);
  }).toPass({ timeout: timeoutMs });
}

/** Creates a task bound to `agentProfileId` (a plain non-git tmp `workdir`,
 *  `isolation: "none"` — the fake claude-code driver never touches the
 *  filesystem) without starting it. */
async function createTaskWithProfile(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  agentProfileId: string,
  prompt: string,
): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt, isolation: "none", workdir: tmpdir(), agentProfileId },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as TaskRow;
  createdTaskIds.push(task.id);
  return task;
}

async function startTaskRest(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  expect(res.ok(), `POST /tasks/${id}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

test.afterAll(async ({ backend }) => {
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  for (const id of createdProfileIds.splice(0)) {
    await fetch(`${backend.apiBase}/agent-profiles/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  for (const id of createdHarnessIds.splice(0)) {
    await fetch(`${backend.apiBase}/harnesses/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
  }
  // Best-effort: restore gemini to its shipped-disabled default so this
  // worker's backend doesn't leak an enabled state into whatever other spec
  // file's worker happens to share it (each worker owns its own DB, but this
  // stays cheap insurance against test order becoming load-bearing).
  await fetch(`${backend.apiBase}/harnesses/gemini`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  }).catch(() => {});
});

test.describe("agent profiles: launch surfaces", () => {
  test("Picker UX: empty state, search by name/model, keyboard nav, clear, Escape", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const picker = form.getByTestId("agent-profile-picker");

    // ---- Before any profile exists ----
    // This assumes a pristine DB (no agent profiles at all), which only
    // holds if every other spec file sharing this worker's backend cleaned
    // up its own profiles — true by construction, but assert conditionally
    // rather than assuming it: if a profile somehow survived from another
    // file, the popover renders its list instead of the empty state, and
    // that's the correct, honest thing to assert here instead of a flake.
    await expect(picker.getByTestId("agent-profile-picker-trigger")).toContainText(
      "No agent — pick harness manually",
    );
    await picker.getByTestId("agent-profile-picker-trigger").click();
    const popover = picker.getByTestId("agent-profile-picker-popover");
    await expect(popover).toBeVisible();
    const preSeedRowCount = await popover.locator('[data-testid="agent-profile-picker-row"]').count();
    if (preSeedRowCount === 0) {
      await expect(popover.getByText("No agents yet.")).toBeVisible();
    } else {
      await expect(popover.getByText("No agents yet.")).toHaveCount(0);
    }
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(popover).toBeHidden();

    // ---- Seed the three shared profiles ----
    // gemini ships disabled by default (migration 037) — enable it before
    // Gamma is created so later scenarios (the gemini overage warning) see a
    // resolvable, non-"(harness disabled)" harness.
    const enableGemini = await request.patch(`${backend.apiBase}/harnesses/gemini`, {
      headers: auth(backend),
      data: { enabled: true },
    });
    expect(enableGemini.ok(), `PATCH /harnesses/gemini -> ${enableGemini.status()}`).toBeTruthy();

    alphaId = await createProfileRest(request, backend, {
      name: ALPHA_NAME,
      harness: "claude-code",
      model: CLAUDE_MODEL,
      instructions: ALPHA_INSTRUCTIONS,
      skills: ["code-review"],
    });
    betaId = await createProfileRest(request, backend, {
      name: BETA_NAME,
      harness: "claude-code",
      model: CLAUDE_MODEL,
      instructions: "",
      skills: [],
    });
    gammaId = await createProfileRest(request, backend, {
      name: GAMMA_NAME,
      harness: "gemini",
      model: GEMINI_MODEL,
      instructions: GAMMA_INSTRUCTIONS,
      skills: [],
    });

    // Reload — the New Task form's `useAgentProfiles()` cache is a
    // per-page-load module singleton, so this is what makes it refetch and
    // see the three profiles just created over REST (which bypassed the
    // client cache entirely). A second `gotoApp` call here would navigate to
    // the byte-identical URL and risk being treated as a no-op — see
    // `reloadApp`'s doc comment.
    await reloadApp(page);
    const form2 = newTaskForm(page);
    const picker2 = form2.getByTestId("agent-profile-picker");
    await picker2.getByTestId("agent-profile-picker-trigger").click();
    const popover2 = picker2.getByTestId("agent-profile-picker-popover");
    await expect(popover2).toBeVisible();
    // Scoped to this scenario's own three profile ids rather than the
    // popover's total row count — another spec file sharing this worker's
    // backend may have profiles of its own still visible here.
    const ownRows = popover2.locator(
      [alphaId, betaId, gammaId]
        .map((id) => `[data-testid="agent-profile-picker-row"][data-profile-id="${id}"]`)
        .join(", "),
    );
    await expect(ownRows).toHaveCount(3);

    // Row content: icon + name + harness label + instructions preview.
    const alphaRow = popover2.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${alphaId}"]`);
    await expect(alphaRow).toContainText(ALPHA_NAME);
    await expect(alphaRow).toContainText("Claude Code");
    await expect(alphaRow).toContainText(ALPHA_INSTRUCTIONS);
    await expect(alphaRow.locator("svg")).toHaveCount(1);

    const search = popover2.getByTestId("agent-profile-picker-search");

    // ---- Search by name ----
    await search.fill("gamma");
    await expect(popover2.locator('[data-testid="agent-profile-picker-row"]')).toHaveCount(1);
    await expect(popover2.locator('[data-testid="agent-profile-picker-row"]').first()).toContainText(GAMMA_NAME);

    // ---- Search by model ----
    await search.fill(GEMINI_MODEL);
    await expect(popover2.locator('[data-testid="agent-profile-picker-row"]')).toHaveCount(1);
    await expect(popover2.locator('[data-testid="agent-profile-picker-row"]').first()).toContainText(GAMMA_NAME);

    // ---- Clear search: back to all three, active row reset to "No agent" ----
    await search.fill("");
    // Scoped to this scenario's own three ids — see `ownRows` above.
    await expect(ownRows).toHaveCount(3);

    // ---- Keyboard nav: Down, Down, Enter picks the SECOND profile row
    //      (row 0 = "No agent", row 1 = Alpha, row 2 = Beta — name ASC). ----
    await search.press("ArrowDown");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(popover2).toBeHidden();
    // The trigger itself also renders a chip-variant `agent-profile-card`
    // for the same id — the standalone "selected" card below the picker is
    // the LAST match.
    const selectedCard = form2.locator(`[data-testid="agent-profile-card"][data-profile-id="${betaId}"]`).last();
    await expect(selectedCard).toBeVisible();
    await expect(selectedCard).toContainText(BETA_NAME);
    // "One selection" (D5): the manual block is gone.
    await expect(form2.getByText("Harness", { exact: true })).toHaveCount(0);

    // ---- Clear via the trigger-adjacent × ----
    await picker2.getByTestId("agent-profile-picker-clear").click();
    await expect(form2.getByText("Harness", { exact: true })).toBeVisible();
    await expect(form2.locator('[data-testid="agent-profile-card"]')).toHaveCount(0);

    // ---- Pick again, then restore the manual block via the "No agent" row ----
    await selectProfileInForm(form2, alphaId);
    await expect(form2.getByText("Harness", { exact: true })).toHaveCount(0);
    await picker2.getByTestId("agent-profile-picker-trigger").click();
    await expect(popover2).toBeVisible();
    await popover2.getByTestId("agent-profile-picker-none").click();
    await expect(popover2).toBeHidden();
    await expect(form2.getByText("Harness", { exact: true })).toBeVisible();
    await expect(form2.locator('[data-testid="agent-profile-card"]')).toHaveCount(0);

    // ---- Escape closes the popover only — no dialog is open here. ----
    await picker2.getByTestId("agent-profile-picker-trigger").click();
    await expect(popover2).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover2).toBeHidden();
    await expect(form2.locator("[data-popover-open]")).toHaveCount(0);
  });

  test("Manage agents… opens Settings on Agents; closing refetches the picker", async ({ page, request, backend }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const picker = form.getByTestId("agent-profile-picker");

    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    await picker.getByTestId("agent-profile-picker-manage").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    const section = dialog.getByTestId("agent-profiles-section");
    await expect(section).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Agents", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Create a fourth profile ("Echo") through the Settings UI itself.
    await section.getByTestId("agent-profile-add").click();
    const form3 = section.getByTestId("agent-profile-form");
    await expect(form3).toBeVisible();
    await form3.getByTestId("agent-profile-name").fill("Echo");
    await form3.getByTestId("agent-profile-save").click();
    await expect(form3).toBeHidden();
    const echoRow = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: "Echo" });
    await expect(echoRow).toBeVisible();

    // Created through the Settings UI, not `createProfileRest` — track it
    // by name so `afterAll` still deletes it (this file's other profiles
    // are auto-tracked by that helper).
    const listRes = await request.get(`${backend.apiBase}/agent-profiles`, { headers: auth(backend) });
    expect(listRes.ok(), `GET /agent-profiles -> ${listRes.status()}`).toBeTruthy();
    const echoEntry = ((await listRes.json()) as ProfileRow[]).find((p) => p.name === "Echo");
    expect(echoEntry, `no agent profile named "Echo"`).toBeTruthy();
    createdProfileIds.push(echoEntry!.id);

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    // App.tsx's onClose calls `refreshProfiles()` — the already-mounted New
    // Task form's picker should see "Echo" without a page reload.
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    await expect(
      picker.locator('[data-testid="agent-profile-picker-row"]').filter({ hasText: "Echo" }),
    ).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });

  test("Gemini overage: warning names Gemini's cap with the preamble included; absent for an empty profile", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = form.getByTestId("prompt-textarea");
    await textarea.click();
    await textarea.fill("p".repeat(300));

    await selectProfileInForm(form, gammaId);
    await expect(form).toContainText("This prompt is");
    await expect(form).toContainText("Gemini CLI's");
    // Math.floor(GEMINI_PROMPT_ARGV_MAX_BYTES / 1024) === 4 — deterministic
    // regardless of the exact (ceil'd) "This prompt is N KB" figure above,
    // since GAMMA_INSTRUCTIONS alone (4000 bytes) already dwarfs the cap.
    await expect(form).toContainText("caps prompts at 4 KB");
    await expect(form).toContainText("Pick another harness or trim the prompt.");

    // Same prompt, empty-instructions/no-skills profile: `composeLaunchPrompt`
    // is a no-op passthrough (plan D3), so the byte count is just the raw
    // 300-byte prompt — no warning, regardless of kind.
    await selectProfileInForm(form, betaId);
    await expect(form.getByText("This prompt is", { exact: false })).toHaveCount(0);
  });

  test("Unavailable-harness hint renders in the selected-card branch", async ({ page, request, backend }) => {
    // The built-in `cursor` harness turned out to be a bad fixture for
    // "unavailable" on this machine: `cursor-agent` is genuinely installed
    // (~/.local/bin/cursor-agent, reachable via the login-shell PATH
    // `rehydratePath()` picks up at headless.ts boot) even though it isn't
    // on a plain non-interactive shell's PATH — so `available` came back
    // `true`, not the `false` this scenario needs. A brand-new ALIAS
    // harness with an explicit, guaranteed-nonexistent `bin` sidesteps that
    // machine-dependence entirely and is enabled by default (no separate
    // "(harness disabled)" marker to worry about either).
    const aliasId = `e2e-cursor-unavailable-${randomUUID()}`;
    const createHarness = await request.post(`${backend.apiBase}/harnesses`, {
      headers: auth(backend),
      data: {
        id: aliasId,
        kind: "cursor",
        label: "E2E Cursor (unavailable)",
        bin: "/nonexistent/agetor-e2e-cursor-agent-binary",
      },
    });
    expect(createHarness.ok(), `POST /harnesses -> ${createHarness.status()}: ${await createHarness.text()}`).toBeTruthy();
    createdHarnessIds.push(aliasId);

    const agentsRes = await request.get(`${backend.apiBase}/agents`, { headers: auth(backend) });
    expect(agentsRes.ok(), `GET /agents -> ${agentsRes.status()}`).toBeTruthy();
    const statuses = (await agentsRes.json()) as { harnessId: string; available: boolean; reason: string | null }[];
    const aliasStatus = statuses.find((s) => s.harnessId === aliasId);
    expect(aliasStatus, `no /agents entry for "${aliasId}"`).toBeTruthy();
    expect(aliasStatus!.available).toBe(false);

    const deltaId = await createProfileRest(request, backend, {
      name: "Delta",
      harness: aliasId,
      model: CURSOR_MODEL,
      instructions: "",
      skills: [],
    });

    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    await selectProfileInForm(form, deltaId);

    const hint = form.getByTestId("agent-profile-harness-unavailable");
    await expect(hint).toBeVisible();
    if (aliasStatus!.reason) {
      await expect(hint).toContainText(aliasStatus!.reason);
    }
  });

  test("Empty-profile launch (Beta): no injected block, bare prompt, board badge + title", async ({
    page,
    request,
    backend,
  }) => {
    const title = `agent-profile-launch-beta ${randomUUID()}`;
    const task = await createTaskWithProfile(request, backend, title, betaId, BETA_PROMPT);
    expect(task.agentProfileId).toBe(betaId);
    await startTaskRest(request, backend, task.id);
    await waitForColumn(request, backend, task.id, "review", CONVERGE_TIMEOUT);

    await gotoApp(page, backend.bootBase);
    const card = boardCard(page, title);
    await expect(card).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const badge = card.getByTestId("task-card-agent-profile");
    await expect(badge).toContainText(BETA_NAME);
    await expect(badge).toHaveAttribute("title", "claude-code");

    const panel = await openTask(page, title);
    await expect(panel.getByTestId("agent-instructions-block")).toHaveCount(0);
    const bubble = panel.locator("div.rounded-br-md").filter({ hasText: BETA_PROMPT });
    await expect(bubble).toBeVisible();
    await expect(bubble.locator(".agetor-md")).toHaveText(BETA_PROMPT);

    // Task details' Agent-row chip still names the (empty-instructions,
    // no-skills) profile, and its details dialog reads "none" for both
    // Skills and Instructions rather than rendering blank.
    await panel.getByText("Task details", { exact: true }).click();
    const detailsChip = detailsRow(panel, "Agent").getByTestId("task-agent-profile-open");
    await expect(detailsChip).toContainText(BETA_NAME);
    await detailsChip.click();
    const detailsDialog = page.getByTestId("agent-profile-details-dialog");
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog).toContainText(BETA_NAME);
    await expect(detailsRow(detailsDialog, "Skills")).toHaveText("none");
    const instructionsValue = detailsDialog
      .getByText("Instructions", { exact: true })
      .locator("xpath=following-sibling::*[1]");
    await expect(instructionsValue).toHaveText("none");
    await detailsDialog.getByTestId("agent-profile-details-close").click();
    await expect(detailsDialog).toBeHidden();
  });

  test("Task details Agent row: unbound shows None; a not-yet-run bound task follows the live agent", async ({
    page,
    request,
    backend,
  }) => {
    // Unbound: no `agentProfileId` at all — the Agent row reads "None".
    const plainTitle = `agent-profile-launch-plain ${randomUUID()}`;
    const plainRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: { title: plainTitle, prompt: "Do the thing", isolation: "none", workdir: tmpdir() },
    });
    expect(plainRes.ok(), `POST /tasks -> ${plainRes.status()}: ${await plainRes.text()}`).toBeTruthy();
    const plainTask = (await plainRes.json()) as TaskRow;
    createdTaskIds.push(plainTask.id);

    await gotoApp(page, backend.bootBase);
    const plainPanel = await openTask(page, plainTitle);
    await plainPanel.getByText("Task details", { exact: true }).click();
    await expect(detailsRow(plainPanel, "Agent").getByTestId("task-agent-profile-none")).toHaveText("None");
    await closeTaskPanel(page, plainPanel);

    // Bound but never started: the details dialog's status line says it
    // still follows the LIVE profile, not a frozen snapshot (D2/A1).
    const unstartedTitle = `agent-profile-launch-unstarted ${randomUUID()}`;
    await createTaskWithProfile(request, backend, unstartedTitle, alphaId, "Do the thing");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, unstartedTitle);
    await panel.getByText("Task details", { exact: true }).click();
    const detailsChip = detailsRow(panel, "Agent").getByTestId("task-agent-profile-open");
    await expect(detailsChip).toContainText(ALPHA_NAME);
    await detailsChip.click();
    const detailsDialog = page.getByTestId("agent-profile-details-dialog");
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog.getByTestId("agent-profile-details-status")).toContainText(
      "Follows the live agent until the task's first run",
    );
    await detailsDialog.getByTestId("agent-profile-details-close").click();
    await expect(detailsDialog).toBeHidden();
    await closeTaskPanel(page, panel);
  });

  test("Task details bound state (Alpha): locked controls, hint, chip, fast Detach", async ({
    page,
    request,
    backend,
  }) => {
    taskAlphaTitle = `agent-profile-launch-alpha ${randomUUID()}`;
    const task = await createTaskWithProfile(request, backend, taskAlphaTitle, alphaId, ALPHA_PROMPT);
    await startTaskRest(request, backend, task.id);
    await waitForColumn(request, backend, task.id, "review", CONVERGE_TIMEOUT);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, taskAlphaTitle);

    const chip = panel.getByTestId("task-agent-profile-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(ALPHA_NAME);
    await expect(chip).toHaveAttribute("title", /Claude Code/);

    await panel.getByText("Task details", { exact: true }).click();
    await expect(panel.getByTestId("task-agent-profile-hint")).toBeVisible();
    await expect(panel.getByTestId("task-agent-profile-hint")).toContainText(ALPHA_NAME);
    const agentRow = detailsRow(panel, "Agent");
    const detailsChip = agentRow.getByTestId("task-agent-profile-open");
    await expect(detailsChip).toContainText(ALPHA_NAME);
    await expect(agentRow.getByTestId("task-agent-profile-detach")).toBeVisible();
    await expect(agentRow.getByTestId("task-agent-profile-manage")).toBeVisible();
    await expect(detailsRow(panel, "Harness").locator("select")).toHaveCount(0);
    await expect(detailsRow(panel, "Model").locator("select")).toHaveCount(0);
    await expect(detailsRow(panel, "Harness")).toContainText("claude-code");

    // Clicking the chip opens the details dialog (D2) with the task's own
    // frozen snapshot.
    await detailsChip.click();
    const detailsDialog = page.getByTestId("agent-profile-details-dialog");
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog).toContainText(ALPHA_NAME);
    await expect(detailsDialog).toContainText("Claude Code");
    await expect(detailsDialog).toContainText(ALPHA_INSTRUCTIONS);
    await expect(detailsDialog).toContainText("/code-review");
    await expect(detailsDialog.getByTestId("agent-profile-details-status")).toContainText(
      "Frozen since the task's first run",
    );
    await detailsDialog.getByTestId("agent-profile-details-close").click();
    await expect(detailsDialog).toBeHidden();

    // Detach merges the returned task's cleared fields optimistically — it
    // must not wait on the parent's 2s task poll (RunPanel's own
    // `detachProfile` doc comment).
    await panel.getByTestId("task-agent-profile-detach").click();
    await expect(panel.getByTestId("task-agent-profile-hint")).toBeHidden({ timeout: 500 });
    await expect(agentRow.getByTestId("task-agent-profile-none")).toHaveText("None", { timeout: 500 });
    await expect(detailsRow(panel, "Harness").locator("select")).toBeEnabled({ timeout: 500 });
  });

  test("Message history: picker strips the injected preamble before offering resend", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, taskAlphaTitle);

    await panel.getByTestId("message-history-trigger").click();
    const popover = panel.getByTestId("message-history-popover");
    await expect(popover).toBeVisible();

    const item = popover.locator('[data-testid="message-history-item"]').filter({ hasText: ALPHA_PROMPT }).first();
    await expect(item).toBeVisible();
    await expect(item).not.toContainText("agent_instructions_defined_by_the_user");
    await expect(item.locator("span").first()).toHaveText(ALPHA_PROMPT);

    await item.click();
    await expect(popover).toBeHidden();
    await expect(panel.getByTestId("send-textarea")).toHaveValue(ALPHA_PROMPT);
  });

  test("Transcript block: collapsed by default on a fresh reopen", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, taskAlphaTitle);

    const block = panel.getByTestId("agent-instructions-block").first();
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("data-state", "collapsed");
    await block.getByRole("button").click();
    await expect(block).toHaveAttribute("data-state", "expanded");
    await expect(block).toContainText(ALPHA_INSTRUCTIONS);

    // A real reload (rather than an in-SPA close/reopen of the SAME task, OR
    // a second `gotoApp` to the byte-identical URL — see `reloadApp`'s doc
    // comment) is the deterministic way to prove "collapsed by default":
    // RunPanel's own `mountedTask` doc comment says it deliberately keeps
    // rendering the previous task's content through the close animation, so
    // an in-page close+reopen of the same task id is not guaranteed to
    // remount the message list the way a fresh load is.
    await reloadApp(page);
    const reopened = await openTask(page, taskAlphaTitle);
    const blockAgain = reopened.getByTestId("agent-instructions-block").first();
    await expect(blockAgain).toBeVisible();
    await expect(blockAgain).toHaveAttribute("data-state", "collapsed");

    await closeTaskPanel(page, reopened);
  });

  test("Deleted profile resets the New Task form's selection after a Settings-close refresh", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    await selectProfileInForm(form, betaId);
    await expect(form.locator(`[data-testid="agent-profile-card"][data-profile-id="${betaId}"]`).last()).toBeVisible();

    const delRes = await request.delete(`${backend.apiBase}/agent-profiles/${betaId}`, { headers: auth(backend) });
    expect(delRes.ok(), `DELETE /agent-profiles/${betaId} -> ${delRes.status()}`).toBeTruthy();

    // Trigger the same profiles refetch the app performs on Settings close
    // (App.tsx's `onClose` calls `refreshProfiles()`) rather than a full
    // page reload — this exercises the live module-cache refresh path, and
    // is what NewTaskForm's own "the selected profile vanished from the
    // refreshed list" effect (right after `selectedProfile` in
    // NewTaskForm.tsx) reacts to.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(form.getByText("Harness", { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(form.locator('[data-testid="agent-profile-card"]')).toHaveCount(0);
  });
});
