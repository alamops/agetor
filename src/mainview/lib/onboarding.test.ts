import { expect, test } from "bun:test";
import {
  deriveOnboardingSteps,
  ONBOARDING_DISMISSED_PREF,
  type OnboardingStep,
  resolveOnboardingVisibility,
} from "./onboarding.ts";
import type { ColumnId, HarnessStatus } from "../../shared/types.ts";

function status(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    harnessId: "claude-code",
    kind: "claude-code",
    bin: "claude",
    available: false,
    path: null,
    version: null,
    reason: null,
    installHint: null,
    loggedIn: null,
    authHelp: null,
    ...overrides,
  } as HarnessStatus;
}

// --- ONBOARDING_DISMISSED_PREF ---------------------------------------------

test("ONBOARDING_DISMISSED_PREF is the pinned preference key", () => {
  expect(ONBOARDING_DISMISSED_PREF).toBe("onboardingDismissed");
});

// --- deriveOnboardingSteps: ordering ----------------------------------------

test("deriveOnboardingSteps always returns all 4 steps in fixed order", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.map((s) => s.id)).toEqual(["harness", "project", "task", "run"]);
});

test("deriveOnboardingSteps preserves fixed order even when everything is done", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "claude-code", available: true })],
    enabledHarnessIds: null,
    projectCount: 3,
    tasks: [{ column: "running" }],
  });
  expect(steps.map((s) => s.id)).toEqual(["harness", "project", "task", "run"]);
  expect(steps.every((s) => s.done)).toBe(true);
});

// --- deriveOnboardingSteps: harness rule ------------------------------------

test("harness step is not done when no status is available", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ available: false })],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(false);
});

test("harness step is done when an available status has enabledHarnessIds === null (no filtering)", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "claude-code", available: true })],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

test("harness step is done when an available status's harnessId is in the enabled set", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "codex", available: true })],
    enabledHarnessIds: new Set(["codex", "gemini"]),
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

test("harness step is NOT done when the only available status is disabled (available but not in enabled set)", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "cursor", available: true })],
    enabledHarnessIds: new Set(["claude-code"]),
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(false);
});

test("harness step is not done when a status is enabled but not available", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "claude-code", available: false })],
    enabledHarnessIds: new Set(["claude-code"]),
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(false);
});

test("harness step is done if ANY status among several satisfies available+enabled", () => {
  const steps = deriveOnboardingSteps({
    statuses: [
      status({ harnessId: "claude-code", available: false }),
      status({ harnessId: "codex", available: true }),
    ],
    enabledHarnessIds: new Set(["codex"]),
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

test("harness step is NOT done when the only available status is logged out (loggedIn === false)", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "fx", kind: "fx", available: true, loggedIn: false, authHelp: "Run fx login…" })],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(false);
});

test("harness step IS done when an available status has loggedIn === true", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "fx", kind: "fx", available: true, loggedIn: true })],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

test("harness step IS done when an available status has loggedIn === null (unknown, fail-open)", () => {
  const steps = deriveOnboardingSteps({
    statuses: [status({ harnessId: "claude-code", available: true, loggedIn: null })],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

test("harness step is done if ANY status among several satisfies available+not-logged-out, even if another is logged out", () => {
  const steps = deriveOnboardingSteps({
    statuses: [
      status({ harnessId: "fx", kind: "fx", available: true, loggedIn: false }),
      status({ harnessId: "codex", available: true, loggedIn: true }),
    ],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "harness")!.done).toBe(true);
});

// --- deriveOnboardingSteps: project rule ------------------------------------

test("project step is not done when projectCount is 0", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "project")!.done).toBe(false);
});

test("project step is done when projectCount > 0", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 1,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "project")!.done).toBe(true);
});

// --- deriveOnboardingSteps: task rule ---------------------------------------

test("task step is not done when tasks is empty", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "task")!.done).toBe(false);
});

test("task step is done when at least one task exists, regardless of column", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [{ column: "backlog" }],
  });
  expect(steps.find((s) => s.id === "task")!.done).toBe(true);
});

// --- deriveOnboardingSteps: run rule -----------------------------------------

test("run step is not done when tasks is empty", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [],
  });
  expect(steps.find((s) => s.id === "run")!.done).toBe(false);
});

test("run step is not done when every task is still backlog/ready", () => {
  const steps = deriveOnboardingSteps({
    statuses: [],
    enabledHarnessIds: null,
    projectCount: 0,
    tasks: [{ column: "backlog" }, { column: "ready" }],
  });
  expect(steps.find((s) => s.id === "run")!.done).toBe(false);
});

test.each(["running", "review", "done", "blocked"] as ColumnId[])(
  "run step is done when a task's column is %s",
  (column) => {
    const steps = deriveOnboardingSteps({
      statuses: [],
      enabledHarnessIds: null,
      projectCount: 0,
      tasks: [{ column: "backlog" }, { column }],
    });
    expect(steps.find((s) => s.id === "run")!.done).toBe(true);
  },
);

// --- resolveOnboardingVisibility: not loaded --------------------------------

test("resolveOnboardingVisibility: everything false while not loaded, regardless of other inputs", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: false,
    steps: allDoneSteps,
    taskCount: 0,
    welcomeAcknowledged: false,
  });
  expect(result).toEqual({ showWelcome: false, showChecklist: false, autoDismiss: false });
});

// --- resolveOnboardingVisibility: dismissed "true" --------------------------

test("resolveOnboardingVisibility: dismissedPref 'true' hides everything and never auto-dismisses", () => {
  const notDoneSteps: OnboardingStep[] = [
    { id: "harness", done: false },
    { id: "project", done: false },
    { id: "task", done: false },
    { id: "run", done: false },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: "true",
    loaded: true,
    steps: notDoneSteps,
    taskCount: 0,
    welcomeAcknowledged: false,
  });
  expect(result).toEqual({ showWelcome: false, showChecklist: false, autoDismiss: false });
});

// --- resolveOnboardingVisibility: replay "false" ----------------------------

test("resolveOnboardingVisibility: replay ('false') shows checklist but never the welcome dialog", () => {
  const notDoneSteps: OnboardingStep[] = [
    { id: "harness", done: false },
    { id: "project", done: false },
    { id: "task", done: false },
    { id: "run", done: false },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: "false",
    loaded: true,
    steps: notDoneSteps,
    taskCount: 0,
    welcomeAcknowledged: false,
  });
  expect(result.showChecklist).toBe(true);
  expect(result.showWelcome).toBe(false);
  expect(result.autoDismiss).toBe(false);
});

test("resolveOnboardingVisibility: replay stays visible (not a no-op) even when all steps happen to be done", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: "false",
    loaded: true,
    steps: allDoneSteps,
    taskCount: 5,
    welcomeAcknowledged: false,
  });
  expect(result.autoDismiss).toBe(false);
  // Replay must force the checklist visible even though allDone — otherwise
  // replaying onboarding for a fully set-up board would be a silent no-op.
  expect(result.showChecklist).toBe(true);
  expect(result.showWelcome).toBe(false);
});

test("resolveOnboardingVisibility: dismissing again after a replay ('true') hides the checklist even if all steps are done", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: "true",
    loaded: true,
    steps: allDoneSteps,
    taskCount: 5,
    welcomeAcknowledged: false,
  });
  expect(result).toEqual({ showWelcome: false, showChecklist: false, autoDismiss: false });
});

// --- resolveOnboardingVisibility: fresh user (pref undefined) --------------

test("resolveOnboardingVisibility: fresh user (pref undefined, no tasks, steps incomplete) shows welcome + checklist", () => {
  const notDoneSteps: OnboardingStep[] = [
    { id: "harness", done: false },
    { id: "project", done: false },
    { id: "task", done: false },
    { id: "run", done: false },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: true,
    steps: notDoneSteps,
    taskCount: 0,
    welcomeAcknowledged: false,
  });
  expect(result).toEqual({ showWelcome: true, showChecklist: true, autoDismiss: false });
});

// --- resolveOnboardingVisibility: welcome acknowledged ----------------------

test("resolveOnboardingVisibility: welcomeAcknowledged suppresses only the welcome dialog", () => {
  const notDoneSteps: OnboardingStep[] = [
    { id: "harness", done: false },
    { id: "project", done: false },
    { id: "task", done: false },
    { id: "run", done: false },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: true,
    steps: notDoneSteps,
    taskCount: 0,
    welcomeAcknowledged: true,
  });
  expect(result.showWelcome).toBe(false);
  expect(result.showChecklist).toBe(true);
  expect(result.autoDismiss).toBe(false);
});

// --- resolveOnboardingVisibility: taskCount > 0 suppresses welcome ----------

test("resolveOnboardingVisibility: taskCount > 0 suppresses welcome but not the checklist", () => {
  const notDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: false },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: true,
    steps: notDoneSteps,
    taskCount: 1,
    welcomeAcknowledged: false,
  });
  expect(result.showWelcome).toBe(false);
  expect(result.showChecklist).toBe(true);
  expect(result.autoDismiss).toBe(false);
});

// --- resolveOnboardingVisibility: all done -> autoDismiss -------------------

test("resolveOnboardingVisibility: all steps done + pref undefined -> autoDismiss true, checklist/welcome hidden", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: true,
    steps: allDoneSteps,
    taskCount: 3,
    welcomeAcknowledged: false,
  });
  expect(result).toEqual({ showWelcome: false, showChecklist: false, autoDismiss: true });
});

test("resolveOnboardingVisibility: autoDismiss requires pref to be undefined, not merely falsy/'false'", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const withFalsePref = resolveOnboardingVisibility({
    dismissedPref: "false",
    loaded: true,
    steps: allDoneSteps,
    taskCount: 3,
    welcomeAcknowledged: false,
  });
  const withUndefinedPref = resolveOnboardingVisibility({
    dismissedPref: undefined,
    loaded: true,
    steps: allDoneSteps,
    taskCount: 3,
    welcomeAcknowledged: false,
  });
  expect(withFalsePref.autoDismiss).toBe(false);
  expect(withUndefinedPref.autoDismiss).toBe(true);
});

test("resolveOnboardingVisibility: all done + already dismissed ('true') -> autoDismiss stays false (no redundant write)", () => {
  const allDoneSteps: OnboardingStep[] = [
    { id: "harness", done: true },
    { id: "project", done: true },
    { id: "task", done: true },
    { id: "run", done: true },
  ];
  const result = resolveOnboardingVisibility({
    dismissedPref: "true",
    loaded: true,
    steps: allDoneSteps,
    taskCount: 3,
    welcomeAcknowledged: false,
  });
  expect(result.autoDismiss).toBe(false);
});
