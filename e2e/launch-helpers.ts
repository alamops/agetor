import { expect, type Locator, type Page } from "@playwright/test";
import { CODE_PLAN_MODE, type AgentKind } from "../src/shared/types.ts";

/**
 * The e2e helper layer over every task-launch surface (docs/architecture/task-launch-ui.md):
 * the New Task panel, the issue and PR dialogs, Clone's "Explain" block and the
 * Settings → Agents form all render the same launch pickers, so a spec reaches
 * a field through these helpers instead of structural XPath. Every function
 * takes a `scope` Locator — the panel, a dialog, or the Settings form.
 *
 * The pickers are `ui/picker.tsx` listboxes: a trigger button (`<id>-trigger`,
 * carrying `data-value`) and a popover portaled to `document.body`
 * (`<id>-popover`), so the popover is looked up on the page, not inside `scope`.
 * Rarely-changed fields (Speed, Max Mode, the agent profile picker, the Mode
 * variant) sit behind "More options"; the helpers that need them open it first
 * (`openMore` is idempotent).
 */

type Tier = "off" | "fast" | "ultrafast";

/** The New Task panel (`new-task-panel`), the first `<aside>` on the page. */
export function newTaskPanel(page: Page): Locator {
  return page.getByTestId("new-task-panel");
}

/** Opens a collapsed Workspace / Agent section (a no-op when already open). */
export async function expandLaunch(scope: Locator): Promise<void> {
  for (const section of ["workspace", "agent"] as const) {
    const toggle = scope.getByTestId(`launch-section-${section}-toggle`);
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
}

/** Opens a section's "More options" (a no-op when already open or absent). */
export async function openMore(scope: Locator, section: "agent" | "workspace" = "agent"): Promise<void> {
  await expandLaunch(scope);
  const toggle = scope.getByTestId(`launch-more-${section}`);
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

function trigger(scope: Locator, id: string): Locator {
  return scope.getByTestId(`${id}-trigger`);
}

function popover(scope: Locator, id: string): Locator {
  return scope.page().getByTestId(`${id}-popover`);
}

async function openPicker(scope: Locator, id: string): Promise<Locator> {
  const t = trigger(scope, id);
  await expect(t).toBeVisible({ timeout: 20_000 });
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  const pop = popover(scope, id);
  await expect(pop).toBeVisible();
  return pop;
}

/** Picks the row whose `data-value` is `value`. */
async function pickByValue(scope: Locator, id: string, value: string): Promise<void> {
  const pop = await openPicker(scope, id);
  await pop.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(pop).toHaveCount(0);
}

/** Every row's `data-value`, in order; closes the popover again. */
async function optionValues(scope: Locator, id: string): Promise<string[]> {
  const pop = await openPicker(scope, id);
  const values = await pop.locator('[role="option"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-value") ?? ""));
  await scope.page().keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  return values;
}

// ---- Harness ---------------------------------------------------------------------

export function harnessPicker(scope: Locator): Locator {
  return trigger(scope, "launch-harness-picker");
}

export async function pickHarness(scope: Locator, label: string): Promise<void> {
  const pop = await openPicker(scope, "launch-harness-picker");
  await pop.getByRole("option", { name: label, exact: true }).click();
  await expect(pop).toHaveCount(0);
}

export async function expectHarness(scope: Locator, label: string): Promise<void> {
  await expect(harnessPicker(scope)).toContainText(label, { timeout: 20_000 });
}

/** The status-dot tone (`ok | warn | error | unknown`) of a harness row. */
export async function harnessStatus(scope: Locator, label: string): Promise<string | null> {
  const pop = await openPicker(scope, "launch-harness-picker");
  const tone = await pop
    .getByRole("option", { name: label, exact: true })
    .getByTestId("launch-harness-status")
    .getAttribute("data-tone");
  await scope.page().keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  return tone;
}

// ---- Model / Effort -----------------------------------------------------------------

export function modelPicker(scope: Locator): Locator {
  return trigger(scope, "launch-model-picker");
}
export function effortPicker(scope: Locator): Locator {
  return trigger(scope, "launch-effort-picker");
}
/** The ↻ button next to Model. */
export function refreshModelsButton(scope: Locator): Locator {
  return scope.getByTestId("launch-refresh-models");
}

export const pickModel = (scope: Locator, id: string) => pickByValue(scope, "launch-model-picker", id);
export const modelOptionIds = (scope: Locator) => optionValues(scope, "launch-model-picker");
export async function expectModel(scope: Locator, id: string): Promise<void> {
  await expect(modelPicker(scope)).toHaveAttribute("data-value", id, { timeout: 20_000 });
}

export const pickEffort = (scope: Locator, id: string) => pickByValue(scope, "launch-effort-picker", id);
export const effortOptionIds = (scope: Locator) => optionValues(scope, "launch-effort-picker");
export async function expectEffort(scope: Locator, id: string): Promise<void> {
  await expect(effortPicker(scope)).toHaveAttribute("data-value", id, { timeout: 20_000 });
}
export async function expectEffortDisabled(scope: Locator): Promise<void> {
  await expect(effortPicker(scope)).toBeDisabled();
}

/** The visible label of the model row for `id` (opens and closes the popover). */
export async function modelLabel(scope: Locator, id: string): Promise<string> {
  const pop = await openPicker(scope, "launch-model-picker");
  const label = (await pop.locator(`[role="option"][data-value="${id}"]`).getAttribute("aria-label")) ?? "";
  await scope.page().keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  return label;
}

// ---- Mode ----------------------------------------------------------------------------

export async function setPrimaryMode(scope: Locator, mode: "code" | "plan"): Promise<void> {
  await scope.getByTestId(`launch-mode-${mode}`).click();
}
export async function expectPrimaryMode(scope: Locator, mode: "code" | "plan"): Promise<void> {
  await expect(scope.getByTestId(`launch-mode-${mode}`)).toBeChecked();
}
export async function pickModeVariant(scope: Locator, label: string): Promise<void> {
  await openMore(scope);
  const pop = await openPicker(scope, "launch-mode-variant-picker");
  await pop.getByRole("option", { name: label, exact: true }).click();
  await expect(pop).toHaveCount(0);
}
export async function expectModeVariant(scope: Locator, label: string): Promise<void> {
  await openMore(scope);
  await expect(trigger(scope, "launch-mode-variant-picker")).toContainText(label);
}

// ---- Speed / Max Mode --------------------------------------------------------------------

/** One tier of the Speed control (opens More options first). */
export async function speedOption(scope: Locator, tier: Tier, testId = "launch-speed"): Promise<Locator> {
  if (testId === "launch-speed") await openMore(scope);
  return scope.getByTestId(`${testId}-${tier}`);
}
export async function pickSpeed(scope: Locator, tier: Tier): Promise<void> {
  await (await speedOption(scope, tier)).click();
}
export async function expectSpeed(scope: Locator, tier: Tier): Promise<void> {
  await expect(await speedOption(scope, tier)).toBeChecked();
}
/** Asserts the tier of ANY `SpeedPicker` root (the launch one or RunPanel's `task-speed`). */
export async function expectSpeedTier(picker: Locator, tier: Tier, testId: string): Promise<void> {
  await expect(picker.getByTestId(`${testId}-${tier}`)).toBeChecked();
}
export async function maxModeToggle(scope: Locator): Promise<Locator> {
  await openMore(scope);
  return scope.getByTestId("launch-max-mode-toggle").getByRole("switch");
}

// ---- Type and the submit actions --------------------------------------------------------------

export async function pickTaskType(scope: Locator, label: string): Promise<void> {
  await scope.getByTestId("task-type-picker").getByRole("radio", { name: label, exact: true }).click();
}
export async function expectTaskType(scope: Locator, label: string): Promise<void> {
  await expect(scope.getByTestId("task-type-picker").getByRole("radio", { name: label, exact: true })).toBeChecked();
}

export function runTaskButton(scope: Locator): Locator {
  return scope.getByRole("button", { name: "Run task", exact: true });
}
export function backlogButton(scope: Locator): Locator {
  return scope.getByRole("button", { name: "Add to backlog", exact: true });
}

/** Fills the panel's Title and Prompt. */
export async function fillNewTask(page: Page, input: { title: string; prompt: string }): Promise<void> {
  const panel = newTaskPanel(page);
  await panel.getByPlaceholder("Short description").fill(input.title);
  await panel.getByTestId("prompt-textarea").fill(input.prompt);
}

// ---- Pipeline / profile ------------------------------------------------------------------------

export function pipelinePicker(scope: Locator): Locator {
  return scope.getByTestId("launch-pipeline-picker").getByTestId("pipeline-picker");
}
export async function pickProfile(scope: Locator, name: string): Promise<void> {
  await openMore(scope);
  await scope.getByTestId("agent-profile-picker-trigger").click();
  await scope.page().getByTestId("agent-profile-picker-popover").getByRole("option", { name, exact: true }).click();
}

// ---- A `<select>`-shaped facade over a Picker ---------------------------------------------------
//
// Specs written against the old native `<select>`s keep their shape: `pick.selectOption(x)`,
// `await pick.expectValue(x)`, `await pick.optionLabels()`. Everything resolves through the
// picker's own DOM (trigger `data-value`, listbox rows), never structural XPath.

export interface PickerHandle {
  /** The trigger button (for visibility / disabled assertions). */
  trigger: Locator;
  selectOption(value: string | { value?: string; label?: string }): Promise<void>;
  expectValue(value: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** The visible label of every row, in order (opens and closes the popover). */
  optionLabels(): Promise<string[]>;
  /** The `data-value` of every row, in order. */
  optionValues(): Promise<string[]>;
  /** The trigger's current visible text. */
  text(): Promise<string>;
}

function handle(scope: Locator, id: string): PickerHandle {
  const t = trigger(scope, id);
  return {
    trigger: t,
    async selectOption(value) {
      if (typeof value === "string") return pickByValue(scope, id, value);
      if (value.value !== undefined) return pickByValue(scope, id, value.value);
      const pop = await openPicker(scope, id);
      await pop.locator(`[role="option"]`).filter({ hasText: value.label ?? "" }).first().click();
      await expect(pop).toHaveCount(0);
    },
    async expectValue(value, options) {
      await expect(t).toHaveAttribute("data-value", value, { timeout: options?.timeout ?? 20_000 });
    },
    async optionLabels() {
      const pop = await openPicker(scope, id);
      const labels = await pop.locator('[role="option"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
      await scope.page().keyboard.press("Escape");
      await expect(pop).toHaveCount(0);
      return labels;
    },
    optionValues: () => optionValues(scope, id),
    text: async () => ((await t.textContent()) ?? "").trim(),
  };
}

export const modelField = (scope: Locator): PickerHandle => handle(scope, "launch-model-picker");
export const effortField = (scope: Locator): PickerHandle => handle(scope, "launch-effort-picker");

/**
 * The Mode control as one field: `expectValue(id)` reads the exact mode id the form holds
 * (`data-mode`), `selectOption(id)` clicks Plan or Code when `id` is the kind's plan or code mode,
 * and picks a code variant (Accept edits, Ask …) from the Approvals picker otherwise.
 */
export function modeField(scope: Locator): PickerHandle {
  const root = scope.getByTestId("launch-mode");
  return {
    trigger: root,
    async selectOption(value) {
      const id = typeof value === "string" ? value : (value.value ?? "");
      const kind = (await root.getAttribute("data-kind")) as AgentKind;
      if (id === CODE_PLAN_MODE[kind].plan) return setPrimaryMode(scope, "plan");
      if (id === CODE_PLAN_MODE[kind].code) return setPrimaryMode(scope, "code");
      await openMore(scope);
      await pickByValue(scope, "launch-mode-variant-picker", id);
    },
    async expectValue(value, options) {
      await expect(root).toHaveAttribute("data-mode", value, { timeout: options?.timeout ?? 20_000 });
    },
    optionLabels: async () => [],
    optionValues: async () => [],
    text: async () => (await root.getAttribute("data-mode")) ?? "",
  };
}
