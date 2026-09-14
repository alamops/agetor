import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { AGENT_PROFILE_LIMITS } from "../src/shared/agent-profile.ts";

/**
 * E2e coverage for the Settings → Agents surface itself (docs/plans/agent-
 * profiles.md §1/§3) — `e2e/agent-profiles.spec.ts` already covers the
 * launch-side flow (New Task picker → run → transcript → freeze → delete),
 * so this file goes deep on the Settings form/list instead: validation,
 * edit-seeding (the exact race `docs/plans/agent-profiles.md` §10's "Review"
 * notes call out — `useTaskLaunch`'s `initial` option), the `SkillsPicker`'s
 * keyboard/mouse contract, draft survival across Settings section switches,
 * the cursor-only fast/max-mode toggles, the disabled-harness marker, the
 * harness-delete guard, and duplicate-name/task-count edge cases.
 *
 * One serial `describe` sharing the worker backend (`e2e/fixtures.ts`) and
 * building on itself exactly like `e2e/agent-profiles.spec.ts` does: scenario
 * 1 creates "Widget Builder", scenario 2 edits it (no-op save), scenario 8
 * renames a fresh profile to clash with it. Scenarios 3/4 use their own
 * disposable Add-form drafts (never saved). Scenarios 5/6 bind profiles to
 * the built-in `cursor` harness, which ships disabled (migration 032) — each
 * enables it via REST first.
 *
 * `SkillsPicker` discovery reads the REAL `~/.claude` of the machine running
 * this suite (`GET /agent-discovery?agent=claude-code`, no workdir), so its
 * *extra* rows are environment-dependent — but `/code-review` and `/simplify`
 * are hardcoded `CLAUDE_BUILTINS` (`src/bun/commands.ts`) always present
 * regardless of environment, appended last, which is why scenario 3 targets
 * those two names specifically (mirroring `e2e/agent-profiles.spec.ts`'s
 * `addSkill` helper's own doc comment).
 *
 * A note on one sub-step of scenario 3: the task brief this file was written
 * against described "Tab with the suggestion list closed" as a no-op. Reading
 * `SkillsPicker.tsx`'s `onKeyDown` (and its own module doc comment — "Enter /
 * Tab / `,` commits the highlighted suggestion when the popover is showing
 * one, else the typed text") shows Tab commits non-empty typed free text
 * exactly like Enter/",", regardless of whether the popover is open — the
 * real "no commit, focus moves" case is an INPUT that normalizes to empty
 * (blank, or a bare "/"), not "list closed" per se. Scenario 3 tests the
 * actual, correct behavior on both sides of that line rather than asserting
 * something the component was never built to do — see its own inline
 * comments for the two sub-cases and CLAUDE.md/AGENTS instructions' "keep the
 * correct assertion, report expected vs actual" rule.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

const WIDGET_BUILDER_NAME = `Widget Builder ${randomUUID()}`;
const WIDGET_BUILDER_INSTRUCTIONS = "Always sand the edges before painting.";
let widgetBuilderId = "";

// Non-builtin harness + its bound profile, created in scenario 7 and torn
// down by the end of that same scenario (the profile is deleted so the
// harness delete can succeed) — nothing later depends on either surviving.
let guardHarnessId = "";
let guardProfileId = "";

// Every OTHER profile this file creates and saves (via REST or the Settings
// UI) that isn't already torn down inline by its own scenario — tracked here
// so `afterAll` can delete them. This worker's backend is shared by every
// spec file in this run (`e2e/fixtures.ts`), so a profile left behind here
// would otherwise leak into another file's absolute-count assertions.
const createdProfileIds: string[] = [];

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// ---- Locator helpers ----

/** Opens Settings and switches to the Agents section — mirrors
 *  `e2e/agent-profiles.spec.ts`'s identical helper. */
async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

/**
 * `TaskLaunchPickers`' Mode/Model/Effort `<Select>`s carry no test id — each
 * is a native `<select>` immediately following a `<label>` with the field
 * name, inside its own `space-y-1` wrapper div (same shape for all three;
 * Model/Effort additionally sit inside a `grid-cols-2` row, which doesn't
 * change the label→select adjacency). Mirrors `e2e/agent-profiles.spec.ts`'s
 * `detailsRow` xpath-sibling pattern.
 */
function launchSelect(container: Locator, label: string): Locator {
  return container
    .locator("label", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::*[1]//select");
}

/** One of the harness-picker's grid buttons (`AgentIcon` + exact label text;
 *  the icon is `aria-hidden`, so `name` matches the label alone). */
function harnessButton(container: Locator, label: string): Locator {
  return container.getByRole("button", { name: label, exact: true });
}

// ---- REST helpers ----

async function getAgentProfile(request: APIRequestContext, backend: E2EBackend, id: string): Promise<any> {
  const res = await request.get(`${backend.apiBase}/agent-profiles/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /agent-profiles/${id} -> ${res.status()}`).toBeTruthy();
  return res.json();
}

async function getProfileIdByName(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const res = await request.get(`${backend.apiBase}/agent-profiles`, { headers: auth(backend) });
  expect(res.ok(), `GET /agent-profiles -> ${res.status()}`).toBeTruthy();
  const list = (await res.json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === name);
  expect(found, `no agent profile named "${name}"`).toBeTruthy();
  return found!.id;
}

async function patchHarness(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/${id}`, { headers: auth(backend), data: body });
  expect(res.ok(), `PATCH /harnesses/${id} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

async function createHarness(
  request: APIRequestContext,
  backend: E2EBackend,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await request.post(`${backend.apiBase}/harnesses`, { headers: auth(backend), data: body });
  expect(res.ok(), `POST /harnesses -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function createAgentProfileRest(
  request: APIRequestContext,
  backend: E2EBackend,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${backend.apiBase}/agent-profiles`, { headers: auth(backend), data: body });
  expect(res.ok(), `POST /agent-profiles -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function deleteAgentProfileRest(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.delete(`${backend.apiBase}/agent-profiles/${id}`, { headers: auth(backend) });
  expect(res.ok(), `DELETE /agent-profiles/${id} -> ${res.status()}`).toBeTruthy();
}

test.describe("agent profiles — Settings surface", () => {
  test("Form validation & pickers: Save gated on name, picker fields present, name capped at 80 chars, save reflects choices", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    await section.getByTestId("agent-profile-add").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();

    const nameInput = form.getByTestId("agent-profile-name");
    const saveButton = form.getByTestId("agent-profile-save");
    await expect(saveButton).toBeDisabled();

    await nameInput.fill(WIDGET_BUILDER_NAME);
    await expect(saveButton).toBeEnabled();

    // hideProfilePicker: the manual harness/mode/model/effort block renders
    // directly — the AgentProfilePicker (which would let a profile pick
    // itself) never mounts inside this form.
    await expect(form.getByTestId("agent-profile-picker")).toHaveCount(0);
    await expect(form.getByText("Harness", { exact: true })).toBeVisible();
    await expect(launchSelect(form, "Mode")).toBeVisible();
    await expect(launchSelect(form, "Model")).toBeVisible();
    await expect(launchSelect(form, "Effort")).toBeVisible();

    // Only Claude Code is enabled at this point (cursor ships disabled by
    // migration 032, and this is the very first test in the suite) — one
    // harness button, selected by default ("default" variant = bg-primary).
    const claudeButton = harnessButton(form, "Claude Code");
    await expect(claudeButton).toBeVisible();
    await expect(claudeButton).toHaveClass(/bg-primary/);

    // Switch model first, then mode, then effort — in that order — so each
    // later pick lands after any auto-reset effect the earlier one could
    // trigger (TaskLaunchPickers.tsx's kind/model-keyed effort/mode reset
    // effects), and reads back as exactly what was picked.
    await launchSelect(form, "Model").selectOption("sonnet-5");
    await launchSelect(form, "Mode").selectOption("plan");
    await launchSelect(form, "Effort").selectOption("medium");

    await form.getByTestId("agent-profile-instructions").fill(WIDGET_BUILDER_INSTRUCTIONS);

    await saveButton.click();
    await expect(form).toBeHidden();

    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: WIDGET_BUILDER_NAME });
    await expect(row).toBeVisible();
    // agentProfileSummary joins raw ids (not labels) for model/effort/mode.
    await expect(row).toContainText("Claude Code");
    await expect(row).toContainText("sonnet-5");
    await expect(row).toContainText("medium");
    await expect(row).toContainText("plan");
    await expect(row).toContainText(WIDGET_BUILDER_INSTRUCTIONS);

    widgetBuilderId = await getProfileIdByName(request, backend, WIDGET_BUILDER_NAME);
    createdProfileIds.push(widgetBuilderId);
    const stored = await getAgentProfile(request, backend, widgetBuilderId);
    expect(stored.harness).toBe("claude-code");
    expect(stored.model).toBe("sonnet-5");
    expect(stored.effort).toBe("medium");
    expect(stored.mode).toBe("plan");

    // Name over 80 chars is capped by the input's `maxLength` — a throwaway
    // second Add form, cancelled afterward.
    await section.getByTestId("agent-profile-add").click();
    const capForm = section.getByTestId("agent-profile-form");
    await expect(capForm).toBeVisible();
    const capName = capForm.getByTestId("agent-profile-name");
    await capName.pressSequentially("x".repeat(AGENT_PROFILE_LIMITS.name + 10));
    await expect(capName).toHaveValue("x".repeat(AGENT_PROFILE_LIMITS.name));
    await capForm.getByTestId("agent-profile-cancel").click();
    await expect(capForm).toBeHidden();
  });

  test("Edit seeding: every field reflects the saved values; an unchanged save is byte-identical (seed-race regression)", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    const before = await getAgentProfile(request, backend, widgetBuilderId);

    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: WIDGET_BUILDER_NAME });
    await row.getByTestId("agent-profile-edit").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();

    await expect(form.getByTestId("agent-profile-name")).toHaveValue(WIDGET_BUILDER_NAME);
    await expect(launchSelect(form, "Model")).toHaveValue("sonnet-5");
    await expect(launchSelect(form, "Effort")).toHaveValue("medium");
    await expect(launchSelect(form, "Mode")).toHaveValue("plan");
    await expect(form.getByTestId("agent-profile-instructions")).toHaveValue(WIDGET_BUILDER_INSTRUCTIONS);
    await expect(harnessButton(form, "Claude Code")).toHaveClass(/bg-primary/);
    await expect(form.locator('[data-testid="skills-picker-chip"]')).toHaveCount(0);

    await form.getByTestId("agent-profile-save").click();
    await expect(form).toBeHidden();

    const after = await getAgentProfile(request, backend, widgetBuilderId);
    expect(after.harness).toBe(before.harness);
    expect(after.model).toBe(before.model);
    expect(after.effort).toBe(before.effort);
    expect(after.mode).toBe(before.mode);
    expect(after.fast).toBe(before.fast);
    expect(after.maxMode).toBe(before.maxMode);
    expect(after.instructions).toBe(before.instructions);
    expect(after.skills).toEqual(before.skills);
  });

  test("Skills picker: remove/backspace/comma/dedupe/slash-strip/tab-commit/escape-list-only/suggestion-click", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    await section.getByTestId("agent-profile-add").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();
    await form.getByTestId("agent-profile-name").fill(`Skills Scratch ${randomUUID()}`);

    const skillsPicker = form.getByTestId("skills-picker");
    const input = skillsPicker.getByTestId("skills-picker-input");
    const chips = skillsPicker.locator('[data-testid="skills-picker-chip"]');

    // "," commits free text.
    await input.click();
    await input.fill("alpha-skill");
    await input.press(",");
    await expect(skillsPicker.locator('[data-testid="skills-picker-chip"][data-skill="alpha-skill"]')).toBeVisible();
    await expect(chips).toHaveCount(1);

    // Duplicate names are ignored.
    await input.fill("alpha-skill");
    await input.press("Enter");
    await expect(chips).toHaveCount(1);

    // A leading "/" is stripped.
    await input.fill("/beta-skill");
    await input.press("Enter");
    await expect(skillsPicker.locator('[data-testid="skills-picker-chip"][data-skill="beta-skill"]')).toBeVisible();
    await expect(chips).toHaveCount(2);

    // Backspace on an empty input removes the last chip (beta-skill, added
    // most recently).
    await expect(input).toHaveValue("");
    await input.press("Backspace");
    await expect(chips).toHaveCount(1);
    await expect(skillsPicker.locator('[data-testid="skills-picker-chip"][data-skill="beta-skill"]')).toHaveCount(0);

    // Chips remove via the × button.
    await skillsPicker
      .locator('[data-testid="skills-picker-chip"][data-skill="alpha-skill"]')
      .getByTestId("skills-picker-remove")
      .click();
    await expect(chips).toHaveCount(0);

    // Tab commits non-empty typed free text exactly like Enter/"," — see
    // this file's header comment. A query with zero suggestion matches still
    // commits via the free-text fallback.
    const uniqueQuery = `zzz-${randomUUID().slice(0, 8)}`;
    await input.fill(uniqueQuery);
    await expect(skillsPicker.locator('[data-testid="skills-picker-row"]')).toHaveCount(0);
    await input.press("Tab");
    await expect(skillsPicker.locator(`[data-testid="skills-picker-chip"][data-skill="${uniqueQuery}"]`)).toBeVisible();
    await expect(chips).toHaveCount(1);

    // Tab on an input that normalizes to "" (a bare "/") commits nothing and
    // lets the browser's native Tab focus-move through (no preventDefault).
    await input.fill("/");
    await input.press("Tab");
    await expect(chips).toHaveCount(1);
    await expect(input).not.toBeFocused();

    // Escape closes only the suggestion popover, not the Settings dialog.
    // "code" reliably matches the hardcoded CLAUDE_BUILTINS "/code-review"
    // suggestion regardless of the machine's own ~/.claude contents.
    await input.click();
    await input.fill("code");
    const codeReviewRow = skillsPicker.locator('[data-testid="skills-picker-row"][data-skill="code-review"]');
    await expect(codeReviewRow).toBeVisible({ timeout: 5_000 });
    await input.press("Escape");
    await expect(codeReviewRow).toBeHidden();
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(form).toBeVisible();
    await input.fill("");

    // A suggestion row is clicked only if one actually renders — never
    // assumed. "simplify" (bare, no slash) matches the hardcoded
    // CLAUDE_BUILTINS "/simplify" suggestion by name.
    await input.fill("simplify");
    const simplifyRow = skillsPicker.locator('[data-testid="skills-picker-row"][data-skill="simplify"]');
    const rowCount = await simplifyRow.count();
    if (rowCount > 0) {
      await simplifyRow.click();
      await expect(skillsPicker.locator('[data-testid="skills-picker-chip"][data-skill="simplify"]')).toBeVisible();
    }
    // else: environment-dependent — this machine's discovery didn't surface
    // the row within the query window; skip the click sub-step per the task
    // brief's own carve-out.

    await form.getByTestId("agent-profile-cancel").click();
    await expect(form).toBeHidden();
  });

  test("Draft survives switching Settings sections and back", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    await section.getByTestId("agent-profile-add").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();
    const draftName = `Draft Survivor ${randomUUID()}`;
    await form.getByTestId("agent-profile-name").fill(draftName);
    await form.getByTestId("agent-profile-instructions").fill("Draft instructions that must survive a tab switch.");

    // AgentProfilesSection is always-mounted (hidden via className, not
    // unmounted) exactly like the Git/Saved-Prompts sections — switching
    // away and back must not lose the in-progress form.
    await dialog.getByRole("button", { name: "General", exact: true }).click();
    await expect(section).toBeHidden();

    await dialog.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(section).toBeVisible();
    await expect(form).toBeVisible();
    await expect(form.getByTestId("agent-profile-name")).toHaveValue(draftName);
    await expect(form.getByTestId("agent-profile-instructions")).toHaveValue(
      "Draft instructions that must survive a tab switch.",
    );

    await form.getByTestId("agent-profile-cancel").click();
    await expect(form).toBeHidden();
  });

  test("Cursor-only fast/max-mode toggles: appear for a supporting model, hide for claude-code, persist maxMode", async ({
    page,
    request,
    backend,
  }) => {
    await patchHarness(request, backend, "cursor", { enabled: true });

    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    await section.getByTestId("agent-profile-add").click();
    const form = section.getByTestId("agent-profile-form");
    await expect(form).toBeVisible();
    const cursorName = `Cursor MaxMode Test ${randomUUID()}`;
    await form.getByTestId("agent-profile-name").fill(cursorName);

    await harnessButton(form, "Cursor").click();
    await expect(harnessButton(form, "Cursor")).toHaveClass(/bg-primary/);

    // "Codex 5.3" (CURSOR_MODEL_SPECS["gpt-5.3-codex"]) supports BOTH the
    // fast variant and Max Mode at the default cursor effort ("high") — see
    // src/shared/types.ts's cursorModelSupportsFast/cursorModelSupportsMaxMode
    // and that spec's effortIds/fastEfforts entries.
    await launchSelect(form, "Model").selectOption("gpt-5.3-codex");
    await expect(launchSelect(form, "Effort")).toHaveValue("high");

    const maxModeToggle = form.getByTestId("launch-max-mode-toggle");
    const fastToggle = form.getByTestId("launch-fast-toggle");
    await expect(maxModeToggle).toBeVisible();
    await expect(fastToggle).toBeVisible();

    await maxModeToggle.getByRole("switch").click();
    await expect(maxModeToggle.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    await form.getByTestId("agent-profile-save").click();
    await expect(form).toBeHidden();

    const cursorProfileId = await getProfileIdByName(request, backend, cursorName);
    createdProfileIds.push(cursorProfileId);
    const stored = await getAgentProfile(request, backend, cursorProfileId);
    expect(stored.harness).toBe("cursor");
    expect(stored.model).toBe("gpt-5.3-codex");
    expect(stored.maxMode).toBe(true);
    expect(stored.fast).toBe(false);

    // Switching the form back to claude-code hides both toggles.
    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: cursorName });
    await row.getByTestId("agent-profile-edit").click();
    const editForm = section.getByTestId("agent-profile-form");
    await expect(editForm).toBeVisible();
    await expect(editForm.getByTestId("launch-max-mode-toggle")).toBeVisible();
    await harnessButton(editForm, "Claude Code").click();
    await expect(editForm.getByTestId("launch-max-mode-toggle")).toHaveCount(0);
    await expect(editForm.getByTestId("launch-fast-toggle")).toHaveCount(0);
    await editForm.getByTestId("agent-profile-cancel").click();
    await expect(editForm).toBeHidden();

    await patchHarness(request, backend, "cursor", { enabled: false });
  });

  test("Disabled-harness marker: shows while cursor is disabled, clears once re-enabled", async ({
    page,
    request,
    backend,
  }) => {
    await patchHarness(request, backend, "cursor", { enabled: true });
    const markerProfile = await createAgentProfileRest(request, backend, {
      name: `Cursor Marker Test ${randomUUID()}`,
      harness: "cursor",
      model: "cursor-grok-4.6",
      effort: "high",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "",
      skills: [],
    });
    createdProfileIds.push(markerProfile.id);
    await patchHarness(request, backend, "cursor", { enabled: false });

    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");
    const row = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: markerProfile.name });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("agent-profile-card-harness-disabled")).toBeVisible();

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    await patchHarness(request, backend, "cursor", { enabled: true });

    await gotoApp(page, backend.bootBase);
    const dialog2 = await openSettingsAgents(page);
    const section2 = dialog2.getByTestId("agent-profiles-section");
    const row2 = section2.locator('[data-testid="agent-profile-row"]').filter({ hasText: markerProfile.name });
    await expect(row2).toBeVisible();
    await expect(row2.getByTestId("agent-profile-card-harness-disabled")).toHaveCount(0);
  });

  test("Harness delete blocked by a bound profile; succeeds once the profile is gone", async ({
    page,
    request,
    backend,
  }) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-agent-profiles-settings-harness-"));
    guardHarnessId = `guard-harness-${randomUUID().slice(0, 8)}`;
    const guardLabel = `Guard Harness ${randomUUID().slice(0, 8)}`;
    const harness = await createHarness(request, backend, {
      id: guardHarnessId,
      kind: "claude-code",
      label: guardLabel,
      home: homeDir,
    });
    expect(harness.id).toBe(guardHarnessId);

    const guardProfileName = `Harness Guard Test ${randomUUID()}`;
    const profile = await createAgentProfileRest(request, backend, {
      name: guardProfileName,
      harness: guardHarnessId,
      model: "opus-5",
      effort: "high",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "",
      skills: [],
    });
    guardProfileId = profile.id;

    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsHarnesses(page);
    const deleteButton = dialog.getByRole("button", { name: `Delete ${guardLabel}` });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const confirmDialog = page.getByRole("dialog").filter({ hasText: `Delete "${guardLabel}"?` });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmDialog).toBeHidden();

    // The delete was refused server-side (409, a profile still references
    // it) — surfaced as a toast naming the blocking agent by name. Scoped to
    // the sonner toast region — the always-mounted (hidden-not-unmounted)
    // Agents section underneath also contains this profile's row text, so an
    // unscoped page-wide text search hits both and trips strict mode.
    const toaster = page.locator("[data-sonner-toaster]");
    await expect(toaster.getByText(`Couldn't delete "${guardLabel}"`)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const toastDescription = toaster.getByText(/In use by 1 agent/);
    await expect(toastDescription).toBeVisible();
    await expect(toastDescription).toContainText(guardProfileName);
    // The harness row is still there — the delete did not go through.
    await expect(dialog.getByRole("button", { name: `Delete ${guardLabel}` })).toBeVisible();

    await deleteAgentProfileRest(request, backend, guardProfileId);
    guardProfileId = "";

    await deleteButton.click();
    const confirmDialog2 = page.getByRole("dialog").filter({ hasText: `Delete "${guardLabel}"?` });
    await expect(confirmDialog2).toBeVisible();
    await confirmDialog2.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmDialog2).toBeHidden();
    await expect(dialog.getByRole("button", { name: `Delete ${guardLabel}` })).toHaveCount(0);
    guardHarnessId = "";
  });

  test("Duplicate name rejected case-insensitively on rename; a fresh profile reads 'not used by any task yet'", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsAgents(page);
    const section = dialog.getByTestId("agent-profiles-section");

    const freshName = `Task Count Fresh ${randomUUID()}`;
    await section.getByTestId("agent-profile-add").click();
    const createForm = section.getByTestId("agent-profile-form");
    await expect(createForm).toBeVisible();
    await createForm.getByTestId("agent-profile-name").fill(freshName);
    await createForm.getByTestId("agent-profile-save").click();
    await expect(createForm).toBeHidden();
    createdProfileIds.push(await getProfileIdByName(request, backend, freshName));

    const freshRow = section.locator('[data-testid="agent-profile-row"]').filter({ hasText: freshName });
    await expect(freshRow).toBeVisible();
    await expect(freshRow.getByTestId("agent-profile-task-count")).toHaveText("Not used by any task yet");

    // Rename to a name that clashes case-insensitively with "Widget Builder"
    // (created in scenario 1, still present).
    await freshRow.getByTestId("agent-profile-edit").click();
    const editForm = section.getByTestId("agent-profile-form");
    await expect(editForm).toBeVisible();
    await editForm.getByTestId("agent-profile-name").fill(WIDGET_BUILDER_NAME.toLowerCase());
    await editForm.getByTestId("agent-profile-save").click();
    await expect(editForm.getByTestId("agent-profile-form-error")).toContainText("already in use");
    // The row still shows the ORIGINAL name — the rejected save didn't
    // rename it, and no duplicate row was created. `.filter({hasText: string})`
    // matches case-INsensitively, which would make a lowercase needle match
    // the still-present "Widget Builder" row too — use a case-sensitive
    // RegExp so this actually proves no "widget builder …" row exists.
    await expect(section.locator('[data-testid="agent-profile-row"]').filter({ hasText: freshName })).toBeVisible();
    await expect(
      section
        .locator('[data-testid="agent-profile-row"]')
        .filter({ hasText: new RegExp(WIDGET_BUILDER_NAME.toLowerCase()) }),
    ).toHaveCount(0);

    await editForm.getByTestId("agent-profile-cancel").click();
    await expect(editForm).toBeHidden();
  });
});

test.afterAll(async ({ backend }) => {
  // Best-effort cleanup for anything a failed scenario left dangling — uses
  // raw `fetch` rather than the `request` fixture (test-scoped, not safely
  // available in `afterAll`), mirroring `e2e/agent-profiles.spec.ts`'s own
  // afterAll. Never blocks teardown.
  const headers = { ...auth(backend), "content-type": "application/json" };
  for (const id of createdProfileIds.splice(0)) {
    await fetch(`${backend.apiBase}/agent-profiles/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
  if (guardProfileId) {
    await fetch(`${backend.apiBase}/agent-profiles/${guardProfileId}`, { method: "DELETE", headers }).catch(
      () => {},
    );
  }
  if (guardHarnessId) {
    await fetch(`${backend.apiBase}/harnesses/${guardHarnessId}`, { method: "DELETE", headers }).catch(() => {});
  }
  // Leave cursor disabled — its shipped-disabled default — rather than
  // leaking an enabled state into whatever runs next on this worker.
  await fetch(`${backend.apiBase}/harnesses/cursor`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled: false }),
  }).catch(() => {});
});
