import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/agent-profiles.md — reusable "Agents" launch
 * presets (harness + model + effort + mode + free-text instructions +
 * skills), picked on task launch instead of choosing each field by hand.
 * Four scenarios, run serially against one shared profile ("Reviewer" →
 * renamed "Reviewer v2" mid-suite) because they build on each other exactly
 * the way the plan's success criteria (§1) and TT7 (§5) describe:
 *
 *  1. Settings → Agents CRUD: create (skills via free text), edit (rename),
 *     duplicate-name rejection (409 surfaced inline, D6).
 *  2. New Task form: the `AgentProfilePicker` replaces the manual harness/
 *     mode/model/effort block ("one selection", D5); create & start; the
 *     board badge, the transcript's collapsible "Agent instructions" block
 *     (D11) and the task-details lock + Detach (D5) all follow.
 *  3. Freeze-at-first-run (D2), driven over the REST API like the rest of
 *     this suite's non-UI assertions: a task that already ran keeps its
 *     frozen snapshot across a later profile edit; a task that hasn't run
 *     yet picks up the live edit when it starts.
 *  4. Deleting the profile (D7 — never blocked): the Settings row disappears,
 *     an already-bound task's chip degrades to "(deleted)" via its own
 *     frozen snapshot, and the New Task picker no longer lists it.
 *
 * Modeled on `e2e/at-file-autocomplete.spec.ts` (one throwaway git repo
 * registered as a project via `POST /projects`, `newTaskForm`/`runPanel`/
 * `taskCard` locator helpers, `awaitCreatedTask`/`waitForColumn` REST
 * polling) and `e2e/tagged-user-messages.spec.ts` (opening a task's run
 * panel and reading its rendered transcript). The fake claude-code driver
 * (`AGETOR_CLAUDE_DRIVER=fake`, wired by `e2e/fixtures.ts`'s `backend`
 * fixture) stands in for tmux + the real CLI — `startTask` unconditionally
 * echoes the (preamble-prefixed, once a profile is attached) prompt back as
 * a `user` stream event regardless of driver, which is what lets scenario 2
 * and 3 assert on the injected "Agent instructions" block without needing a
 * controllable assistant reply.
 *
 * Skill discovery (`GET /agent-discovery?agent=claude-code`, no workdir —
 * plan D8) reads the REAL `~/.claude` of the machine running this suite, so
 * its *extra* suggestion rows are environment-dependent — but `/code-review`
 * and `/simplify` are hardcoded `CLAUDE_BUILTINS` (`src/bun/commands.ts`)
 * that are always present regardless of environment, appended last (so a
 * same-named user/project/plugin entry would win the dedupe but never
 * removes the name itself), which is why this spec targets those two names
 * specifically. `addSkill` below still follows the required free-text
 * discipline: it types the query, and only clicks a suggestion row if one
 * actually renders (never blindly presses Enter assuming a match) — for
 * "/simplify" it types the query WITH a leading slash, which can never
 * substring-match a suggestion's slash-less stored name, so that call
 * always exercises the pure free-text commit path end to end.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

let projectDir: string;
const createdTaskIds: string[] = [];

// Set by "Settings CRUD" (test 1), consumed by every later test — the one
// profile this whole file shares (renamed "Reviewer" -> "Reviewer v2" partway
// through test 1, which is the name every later test looks it up by).
let profileId = "";
const PROFILE_NAME = "Reviewer v2";
const PROFILE_INSTRUCTIONS = "Always review before editing.";

// Set by "Freeze after first run" (test 3), consumed by "Delete profile"
// (test 4) to re-open the still-bound task and check its chip degrades.
let taskBId = "";
let taskBTitle = "";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** Minimal git repo (mirrors `e2e/issue-task.spec.ts`'s `initRepo`) — just
 *  enough for `POST /projects` to register it and for the New Task form's
 *  default worktree-isolation path to behave exactly like every other spec
 *  that drives "Run task" for real, rather than leaning on the (untested by
 *  any other spec) non-git-workdir fallback. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-agent-profiles-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "e2e fixture repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
  return dir;
}

async function registerProject(apiBase: string, apiToken: string, dir: string): Promise<void> {
  const res = await fetch(`${apiBase}/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  if (!res.ok) {
    throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
  }
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// ---- Locator helpers (mirror e2e/at-file-autocomplete.spec.ts / e2e/tagged-user-messages.spec.ts) ----

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

/** Opens Settings and switches to the Agents section (mirrors
 *  `e2e/helpers.ts`'s `openSettingsGeneral`, plus the one extra sidebar
 *  click this section needs). */
async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

/** The Task-details `<dl>` row for a given `dt` label (e.g. "Agent") — its
 *  sibling `dd`. Mirrors `e2e/fx-models.spec.ts`'s `detailsModelSelect`. */
function detailsRow(panel: Locator, label: string): Locator {
  return panel
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

/**
 * Types `query` into the (already-visible) `SkillsPicker`'s input and
 * commits `expectedName` — clicking the matching suggestion row if one
 * renders within a short window, else pressing Enter to commit the raw
 * free-typed text (normalized server/client-side via `normalizeSkillName`).
 * Never blindly presses Enter while assuming it hits a particular row.
 */
async function addSkill(skillsPicker: Locator, query: string, expectedName: string): Promise<void> {
  const input = skillsPicker.getByTestId("skills-picker-input");
  await input.click();
  await input.fill(query);
  const suggestionRow = skillsPicker.locator(
    `[data-testid="skills-picker-row"][data-skill="${expectedName}"]`,
  );
  let matched = false;
  try {
    await suggestionRow.waitFor({ state: "visible", timeout: 3_000 });
    matched = true;
  } catch {
    matched = false;
  }
  if (matched) {
    await suggestionRow.click();
  } else {
    await input.press("Enter");
  }
  await expect(
    skillsPicker.locator(`[data-testid="skills-picker-chip"][data-skill="${expectedName}"]`),
  ).toBeVisible();
}

// ---- Task API helpers ----

interface TaskRow {
  id: string;
  title: string;
  column: string;
  agentProfileId: string | null;
  agentProfile: { instructions: string } | null;
}

async function findTaskByTitle(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow | null> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks -> ${res.status()}`).toBeTruthy();
  const list = (await res.json()) as TaskRow[];
  return list.find((t) => t.title === title) ?? null;
}

async function awaitCreatedTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskRow> {
  let task: TaskRow | null = null;
  await expect(async () => {
    task = await findTaskByTitle(request, backend, title);
    expect(task).not.toBeNull();
  }).toPass({ timeout: CONVERGE_TIMEOUT });
  createdTaskIds.push(task!.id);
  return task!;
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

async function getProfileIdByName(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const res = await request.get(`${backend.apiBase}/agent-profiles`, { headers: auth(backend) });
  expect(res.ok(), `GET /agent-profiles -> ${res.status()}`).toBeTruthy();
  const list = (await res.json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === name);
  expect(found, `no agent profile named "${name}"`).toBeTruthy();
  return found!.id;
}

/** Creates a task bound to `agentProfileId` (a plain non-git tmp `workdir`,
 *  `isolation: "none"` — the fake driver never touches the filesystem, same
 *  recipe as `e2e/tagged-user-messages.spec.ts`) without starting it. */
async function createTaskWithProfile(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  agentProfileId: string,
): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: "Do the thing", isolation: "none", workdir: tmpdir(), agentProfileId },
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

test.beforeAll(async ({ backend }) => {
  projectDir = await initRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
});

test.afterAll(async ({ backend }) => {
  for (const id of createdTaskIds.splice(0)) {
    await fetch(`${backend.apiBase}/tasks/${id}`, {
      method: "DELETE",
      headers: auth(backend),
    }).catch(() => { /* best-effort cleanup */ });
  }
  // Belt-and-suspenders: the "Delete profile" test (test 4) deletes this
  // file's one shared profile itself via the UI, but if an earlier test
  // fails before that step runs, the profile (created under "Reviewer",
  // possibly still under that name or renamed to PROFILE_NAME) would
  // otherwise leak into whatever spec file's worker-shared backend runs
  // next and break its own absolute-count assertions. Best-effort by id
  // (if scenario 2 got far enough to resolve it) and by name (covers both
  // "Reviewer" and the renamed "Reviewer v2", in case the rename in test 1
  // itself never completed).
  if (profileId) {
    await fetch(`${backend.apiBase}/agent-profiles/${profileId}`, {
      method: "DELETE",
      headers: auth(backend),
    }).catch(() => {});
  }
  for (const name of ["Reviewer", PROFILE_NAME]) {
    try {
      const res = await fetch(`${backend.apiBase}/agent-profiles`, { headers: auth(backend) });
      if (!res.ok) continue;
      const list = (await res.json()) as { id: string; name: string }[];
      const found = list.find((p) => p.name === name);
      if (found) {
        await fetch(`${backend.apiBase}/agent-profiles/${found.id}`, {
          method: "DELETE",
          headers: auth(backend),
        }).catch(() => {});
      }
    } catch {
      // best-effort cleanup
    }
  }
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("agent profiles", () => {
  test("Settings CRUD: create (free-text skills), edit (rename), duplicate name rejected", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    // ---- Create "Reviewer" ----
    await section.getByTestId("agent-profile-add").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();

    await form.getByTestId("agent-profile-name").fill("Reviewer");
    await form.getByTestId("agent-profile-instructions").fill(PROFILE_INSTRUCTIONS);

    const skillsPicker = form.getByTestId("skills-picker");
    // "code-review" is queried bare — a CLAUDE_BUILTINS suggestion row for it
    // is expected to render, so this exercises the click-the-row path.
    await addSkill(skillsPicker, "code-review", "code-review");
    // "/simplify" is queried WITH the leading slash: no stored suggestion
    // name carries one, so this can never match a row and always exercises
    // the pure free-text Enter-commit path (normalizeSkillName strips it).
    await addSkill(skillsPicker, "/simplify", "simplify");

    await form.getByTestId("agent-profile-save").click();
    await expect(form).toBeHidden();

    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: "Reviewer" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Claude Code");
    await expect(row).toContainText(PROFILE_INSTRUCTIONS);
    await expect(row).toContainText("/code-review");
    await expect(row).toContainText("/simplify");

    // ---- Edit: rename to "Reviewer v2" ----
    await row.getByTestId("agent-profile-edit").click();
    const editForm = section.getByTestId("agent-profile-form");
    await expect(editForm).toBeVisible();
    await expect(editForm.getByTestId("agent-profile-name")).toHaveValue("Reviewer");
    await editForm.getByTestId("agent-profile-name").fill(PROFILE_NAME);
    await editForm.getByTestId("agent-profile-save").click();
    await expect(editForm).toBeHidden();

    const renamedRow = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: PROFILE_NAME });
    await expect(renamedRow).toBeVisible();

    // ---- Duplicate: a second profile named "reviewer v2" (case-insensitive clash) ----
    await section.getByTestId("agent-profile-add").click();
    const dupForm = section.getByTestId("agent-profile-form");
    await expect(dupForm).toBeVisible();
    await dupForm.getByTestId("agent-profile-name").fill("reviewer v2");
    await dupForm.getByTestId("agent-profile-save").click();
    await expect(dupForm.getByTestId("agent-profile-form-error")).toContainText("already in use");
    // No second row was created — scoped to this spec's own name family
    // ("Reviewer" was renamed to "Reviewer v2" above) rather than the whole
    // list, which may also hold profiles left behind by another spec file
    // sharing this worker's backend.
    await expect(
      section.locator('[data-testid="agent-profile-row"]').filter({ hasText: "Reviewer" }),
    ).toHaveCount(1);
    await dupForm.getByTestId("agent-profile-cancel").click();
    await expect(dupForm).toBeHidden();
  });

  test("Launch from New Task: picker replaces the manual block; run injects instructions", async ({
    page,
    request,
    backend,
  }) => {
    profileId = await getProfileIdByName(request, backend, PROFILE_NAME);

    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);

    const title = `agent-profile-launch ${randomUUID()}`;
    await form.getByPlaceholder("Short description").fill(title);

    const picker = form.getByTestId("agent-profile-picker");
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    const pickerRow = picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${profileId}"]`);
    // Row shows harness icon (AgentIcon svg) + name + summary + instructions preview.
    await expect(pickerRow).toContainText(PROFILE_NAME);
    await expect(pickerRow).toContainText("Claude Code");
    await expect(pickerRow).toContainText(PROFILE_INSTRUCTIONS);
    await expect(pickerRow.locator("svg")).toHaveCount(1);
    await pickerRow.click();

    // "One selection" (D5): the manual harness/mode/model/effort block is
    // gone, replaced by the selected card. The picker's own trigger also
    // renders a (chip-variant) `agent-profile-card` for the same profile
    // id, so pick the LAST match — the standalone "selected"-variant card
    // rendered as the picker's sibling, not the one inside the trigger.
    await expect(form.getByText("Harness", { exact: true })).toHaveCount(0);
    const selectedCard = form
      .locator(`[data-testid="agent-profile-card"][data-profile-id="${profileId}"]`)
      .last();
    await expect(selectedCard).toBeVisible();
    await expect(selectedCard).toContainText(PROFILE_NAME);

    const textarea = form.getByTestId("prompt-textarea");
    await textarea.click();
    await textarea.fill("Do the thing");

    const runButton = form.getByRole("button", { name: "Run task", exact: true });
    await expect(runButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await runButton.click();

    const task = await awaitCreatedTask(request, backend, title);
    expect(task.agentProfileId).toBe(profileId);

    await waitForColumn(request, backend, task.id, "review", CONVERGE_TIMEOUT);

    // Board badge shows the profile name.
    const card = boardCard(page, title);
    await expect(card).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(card.getByTestId("task-card-agent-profile")).toContainText(PROFILE_NAME);

    // Open the run panel.
    const panel = await openTask(page, title);
    await expect(panel.getByTestId("task-agent-profile-chip")).toContainText(PROFILE_NAME);

    // Transcript: collapsible "Agent instructions" block, collapsed by
    // default, followed by the "Your task:" text.
    const instructionsBlock = panel.getByTestId("agent-instructions-block").first();
    await expect(instructionsBlock).toBeVisible();
    await expect(instructionsBlock).toHaveAttribute("data-state", "collapsed");
    await instructionsBlock.getByRole("button").click();
    await expect(instructionsBlock).toHaveAttribute("data-state", "expanded");
    await expect(instructionsBlock).toContainText(PROFILE_INSTRUCTIONS);
    await expect(instructionsBlock).toContainText("/code-review");

    const bubble = instructionsBlock.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await expect(bubble).toContainText("Your task:");
    await expect(bubble).toContainText("Do the thing");

    // Task details: the Agent row's chip + Detach/Manage while bound; the
    // Harness dropdown (the manual harness picker, renamed from "Agent" —
    // docs/plans/task-details-agent-row.md D1/D3) has no <select> while
    // locked, matching the hint text.
    await panel.getByText("Task details", { exact: true }).click();
    await expect(panel.getByTestId("task-agent-profile-hint")).toBeVisible();
    const agentRow = detailsRow(panel, "Agent");
    const detailsChip = agentRow.getByTestId("task-agent-profile-open");
    await expect(detailsChip).toContainText(PROFILE_NAME);
    await expect(agentRow.getByTestId("task-agent-profile-detach")).toBeVisible();
    await expect(agentRow.getByTestId("task-agent-profile-manage")).toBeVisible();
    await expect(detailsRow(panel, "Harness").locator("select")).toHaveCount(0);
    await expect(detailsRow(panel, "Model").locator("select")).toHaveCount(0);

    // Clicking the chip opens the details dialog (D2) with the task's own
    // frozen snapshot: name, harness, model, the full instructions, skills,
    // and a "Frozen since the task's first run" status (the task has run).
    await detailsChip.click();
    const detailsDialog = page.getByTestId("agent-profile-details-dialog");
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog).toContainText(PROFILE_NAME);
    await expect(detailsDialog).toContainText("Claude Code");
    await expect(detailsDialog).toContainText(PROFILE_INSTRUCTIONS);
    await expect(detailsDialog).toContainText("/code-review");
    await expect(detailsDialog).toContainText("/simplify");
    await expect(detailsDialog.getByTestId("agent-profile-details-status")).toContainText(
      "Frozen since the task's first run",
    );

    // "Edit in Settings" deep-links into Settings → Agents and closes the
    // dialog on the way.
    await detailsDialog.getByTestId("agent-profile-details-edit").click();
    await expect(detailsDialog).toBeHidden();
    const settingsDialog = page.getByRole("dialog");
    await expect(settingsDialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(settingsDialog.getByTestId("agent-profiles-section")).toBeVisible();
    await settingsDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settingsDialog).toBeHidden();

    // Reopen the chip and close it via its own Close button this time.
    await detailsChip.click();
    await expect(detailsDialog).toBeVisible();
    await detailsDialog.getByTestId("agent-profile-details-close").click();
    await expect(detailsDialog).toBeHidden();

    // Detach unlocks them (allow the parent's 2s task poll to pick up the
    // server-side clear — RunPanel's own doc comment on `detachProfile`).
    await panel.getByTestId("task-agent-profile-detach").click();
    await expect(panel.getByTestId("task-agent-profile-hint")).toBeHidden({ timeout: 10_000 });
    await expect(agentRow.getByTestId("task-agent-profile-none")).toHaveText("None");
    await expect(detailsRow(panel, "Harness").locator("select")).toBeEnabled({ timeout: 10_000 });
  });

  test("Freeze after first run + live pickup on an unstarted task (REST)", async ({ page, request, backend }) => {
    // Task A from the previous scenario was just detached — its snapshot is
    // gone (`detachTaskAgentProfile` clears both columns) — so freeze this
    // half against a fresh task (task C in the plan's own fallback wording)
    // that we create and start here instead.
    const titleRan = `agent-profile-freeze-ran ${randomUUID()}`;
    const taskRan = await createTaskWithProfile(request, backend, titleRan, profileId);
    await startTaskRest(request, backend, taskRan.id);
    await waitForColumn(request, backend, taskRan.id, "review", CONVERGE_TIMEOUT);
    const afterFirstRun = await getTaskById(request, backend, taskRan.id);
    expect(afterFirstRun?.agentProfile?.instructions).toBe(PROFILE_INSTRUCTIONS);

    // Task B: created but never started.
    taskBTitle = `agent-profile-freeze-unstarted ${randomUUID()}`;
    const taskB = await createTaskWithProfile(request, backend, taskBTitle, profileId);
    taskBId = taskB.id;

    // Edit the live profile's instructions.
    const patchRes = await request.patch(`${backend.apiBase}/agent-profiles/${profileId}`, {
      headers: auth(backend),
      data: { instructions: "Edited later." },
    });
    expect(patchRes.ok(), `PATCH /agent-profiles/${profileId} -> ${patchRes.status()}`).toBeTruthy();

    // The already-ran task's frozen snapshot must NOT pick up the edit.
    const stillOld = await getTaskById(request, backend, taskRan.id);
    expect(stillOld?.agentProfile?.instructions).toBe(PROFILE_INSTRUCTIONS);

    // Task B hasn't run yet — starting it now must pick up the live edit.
    await startTaskRest(request, backend, taskB.id);
    await waitForColumn(request, backend, taskB.id, "review", CONVERGE_TIMEOUT);
    const startedB = await getTaskById(request, backend, taskB.id);
    expect(startedB?.agentProfile?.instructions).toBe("Edited later.");

    // The first user event (the injected preamble) reflects the same edit —
    // checked through the rendered transcript, same as scenario 2.
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, taskBTitle);
    const instructionsBlock = panel.getByTestId("agent-instructions-block").first();
    await expect(instructionsBlock).toBeVisible();
    await instructionsBlock.getByRole("button").click();
    await expect(instructionsBlock).toContainText("Edited later.");
    await expect(instructionsBlock).not.toContainText(PROFILE_INSTRUCTIONS);
  });

  test("Delete profile: row disappears, bound task's chip degrades, New Task picker drops it", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");
    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: PROFILE_NAME });
    await expect(row).toBeVisible();
    // Two tasks are still bound at this point: "taskRan" and task B from
    // scenario 3 (both created with `agentProfileId: profileId` and never
    // detached). Task A from scenario 2 was explicitly detached at the end
    // of that scenario, so it doesn't count.
    await expect(row.getByTestId("agent-profile-task-count")).toHaveText("Used by 2 tasks");
    await row.getByTestId("agent-profile-delete").click();

    const confirmDialog = page.getByRole("dialog").filter({ hasText: `Delete agent "${PROFILE_NAME}"` });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText("2 tasks are bound to it and keep their own frozen copy");
    await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();

    // Assert the specific row is gone, not that the whole list is empty —
    // another spec file sharing this worker's backend may still have rows.
    await expect(row).toHaveCount(0);

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Task B's chip still names the profile (via its frozen snapshot) but
    // now shows "(deleted)".
    const panel = await openTask(page, taskBTitle);
    const chip = panel.getByTestId("task-agent-profile-chip");
    await expect(chip).toContainText(PROFILE_NAME);
    await expect(chip.getByTestId("agent-profile-card-deleted")).toBeVisible();

    // Task details' own Agent-row chip carries the same "(deleted)" marker,
    // and the details dialog reflects it too: a visible deleted badge and no
    // "Edit in Settings" (there's nothing live left to edit).
    await panel.getByText("Task details", { exact: true }).click();
    const detailsChip = detailsRow(panel, "Agent").getByTestId("task-agent-profile-open");
    await expect(detailsChip).toContainText(PROFILE_NAME);
    await expect(detailsChip.getByTestId("agent-profile-card-deleted")).toBeVisible();
    await detailsChip.click();
    const detailsDialog = page.getByTestId("agent-profile-details-dialog");
    await expect(detailsDialog).toBeVisible();
    await expect(detailsDialog.getByTestId("agent-profile-details-deleted")).toBeVisible();
    await expect(detailsDialog.getByTestId("agent-profile-details-edit")).toHaveCount(0);
    // A deleted-profile task's status line leads with the deleted-profile
    // copy regardless of run count (F1-3) — "no longer exists", not the
    // ordinary frozen-since-first-run text.
    await expect(detailsDialog.getByTestId("agent-profile-details-status")).toContainText(
      "no longer exists",
    );
    await detailsDialog.getByTestId("agent-profile-details-close").click();
    await expect(detailsDialog).toBeHidden();

    // Close the run panel first — its full-width backdrop otherwise
    // intercepts clicks meant for the New Task form underneath. The panel
    // stays mounted and slides off-screen via a CSS transform (not
    // `display:none`), so wait for the backdrop button itself to go
    // pointer-events-none rather than asserting the `<aside>` hidden.
    const backdrop = page.getByRole("button", { name: "Close task panel" });
    await panel.getByRole("button", { name: "Close task details" }).click();
    await expect(backdrop).toHaveCSS("pointer-events", "none");

    // New Task picker no longer lists it.
    const form = newTaskForm(page);
    const picker = form.getByTestId("agent-profile-picker");
    await picker.getByTestId("agent-profile-picker-trigger").click();
    await expect(picker.getByTestId("agent-profile-picker-popover")).toBeVisible();
    await expect(
      picker.locator(`[data-testid="agent-profile-picker-row"][data-profile-id="${profileId}"]`),
    ).toHaveCount(0);
  });
});
