import { randomUUID } from "node:crypto";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import {
  auth,
  createPipelineRest,
  createPipelineTaskRest,
  createProfileRest,
  FAKE_CLAUDE_HANDOFF_PROMPT_MARKER,
  getTaskRest,
  makeStep,
  reviewPipelineRest,
  startTaskRest,
  waitForPipelineRest,
} from "./scroll-memory-helpers";
import type { TaskRow } from "./scroll-memory-helpers";

/**
 * The human step, end to end: A → H → B pauses in Review, the board card
 * offers Review (never Done), the control panel shows the goal, the check
 * list, the last handoff and the history, Accept carries the comment to B,
 * Return re-runs A and re-pauses, Stop dismisses the gate and moves the card
 * to Ready.
 */

const H = "human";

async function gateRow(backend: E2EBackend, id: string, minSeq = 1): Promise<TaskRow> {
  return waitForPipelineRest(backend, id, (t) => {
    const gates = (t.pipelineRun as unknown as { humanSteps?: { seq: number }[] } | null)?.humanSteps ?? [];
    return gates.some((g) => g.seq >= minSeq);
  });
}

function gateOf(row: TaskRow): { stepId: string; seq: number } {
  const gates = (row.pipelineRun as unknown as { humanSteps?: { stepId: string; seq: number }[] } | null)?.humanSteps ?? [];
  const gate = gates[0];
  if (!gate) throw new Error("no pending human gate");
  return gate;
}

test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "40" } });

test("pause + accept: card Review/no Done, panel contents, Accept carries the comment to B", async ({ page, freshBackend: backend }) => {
  const profileId = await createProfileRest(backend, `human-${randomUUID().slice(0, 6)}`);
  const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const Hstep = makeStep({ id: randomUUID(), name: "H", agentProfileId: null, type: H, instructions: "check the header" });
  const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId, instructions: `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipelineId = await createPipelineRest(backend, `human-pipeline-${randomUUID().slice(0, 6)}`, [A, Hstep, B], [
    { from: A.id, to: Hstep.id },
    { from: Hstep.id, to: B.id },
  ]);
  const task = await createPipelineTaskRest(backend, `Human accept ${randomUUID().slice(0, 6)}`, pipelineId, "the overall goal");

  await gotoApp(page, backend.bootBase);
  await startTaskRest(backend, task.id);
  const gated = await gateRow(backend, task.id);
  const gate = gateOf(gated);

  const card = page.locator(`[data-task-id="${task.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(card.getByTestId("task-card-pipeline-review")).toBeVisible();
  await expect(card.getByTestId("task-card-pipeline-stop")).toHaveCount(1);
  await expect(card.locator('button[title="Stop"]')).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Done" })).toHaveCount(0);

  await card.getByTestId("task-card-pipeline-review").click();
  const panel = page.getByTestId("pipeline-human-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("pipeline-human-goal")).toContainText("the overall goal");
  await expect(panel.getByTestId("pipeline-human-check")).toContainText("check the header");
  await expect(panel.getByTestId("pipeline-human-handoff")).toBeVisible();
  await expect(panel.getByTestId("pipeline-human-history")).toBeVisible();

  await panel.getByTestId("pipeline-human-comment").fill("please tighten X");
  await panel.getByTestId("pipeline-human-accept").click();

  await waitForPipelineRest(backend, task.id, (t) => t.pipelineRun?.status === "done");
  const detail = await fetch(`${backend.apiBase}/tasks/${task.id}/pipeline`, { headers: auth(backend) });
  const rows = (await detail.json()) as { steps: { pipelineStepId: string; prompt: string }[] };
  const stepB = rows.steps.find((s) => s.pipelineStepId === B.id)!;
  expect(stepB.prompt).toContain("## Human review feedback");
  expect(stepB.prompt).toContain("please tighten X");
});

test("return → re-pause → accept", async ({ page, freshBackend: backend }) => {
  const profileId = await createProfileRest(backend, `human-${randomUUID().slice(0, 6)}`);
  const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const Hstep = makeStep({ id: randomUUID(), name: "H", agentProfileId: null, type: H });
  const pipelineId = await createPipelineRest(backend, `human-return-${randomUUID().slice(0, 6)}`, [A, Hstep], [{ from: A.id, to: Hstep.id }]);
  const task = await createPipelineTaskRest(backend, `Human return ${randomUUID().slice(0, 6)}`, pipelineId, "goal");

  await gotoApp(page, backend.bootBase);
  await startTaskRest(backend, task.id);
  const first = await gateRow(backend, task.id);
  const firstGate = gateOf(first);

  await page.locator(`[data-task-id="${task.id}"]`).getByTestId("task-card-pipeline-review").click();
  const panel = page.getByTestId("pipeline-human-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("pipeline-human-comment").fill("redo the header");
  await expect(panel.getByTestId("pipeline-human-return")).toBeEnabled();
  await panel.getByTestId("pipeline-human-return").click();

  const second = await gateRow(backend, task.id, firstGate.seq + 1);
  const run = second.pipelineRun as unknown as { history: { stepId: string; taskId: string | null; outcome: string | null }[] };
  const returned = run.history.find((h) => h.taskId === null && h.outcome === "returned");
  expect(returned).toBeTruthy();

  // The panel reopens on the new gate; accept it to finish.
  const reopened = gateOf(second);
  await reviewPipelineRest(backend, task.id, { stepId: reopened.stepId, seq: reopened.seq, decision: "accept" });
  const done = await waitForPipelineRest(backend, task.id, (t) => t.pipelineRun?.status === "done");
  expect(done.pipelineRun?.status).toBe("done");
});

test("stop at a gate: card moves to Ready, the gate section is gone, history kept", async ({ page, freshBackend: backend }) => {
  const profileId = await createProfileRest(backend, `human-${randomUUID().slice(0, 6)}`);
  const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const Hstep = makeStep({ id: randomUUID(), name: "H", agentProfileId: null, type: H });
  const pipelineId = await createPipelineRest(backend, `human-stop-${randomUUID().slice(0, 6)}`, [A, Hstep], [{ from: A.id, to: Hstep.id }]);
  const task = await createPipelineTaskRest(backend, `Human stop ${randomUUID().slice(0, 6)}`, pipelineId, "goal");

  await gotoApp(page, backend.bootBase);
  await startTaskRest(backend, task.id);
  await gateRow(backend, task.id);

  await page.locator(`[data-task-id="${task.id}"]`).getByTestId("task-card-pipeline-stop").click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Stop" }).click();

  const stopped = await waitForPipelineRest(backend, task.id, (t) => t.pipelineRun?.status === "cancelled");
  expect(stopped.column).toBe("ready");
  const gates = (stopped.pipelineRun as unknown as { humanSteps?: unknown[] }).humanSteps ?? [];
  expect(gates).toHaveLength(0);
  expect(stopped.pipelineRun?.history.length).toBeGreaterThanOrEqual(2);
});

test("multi-gate: each Open review opens its own gate's panel", async ({ page, freshBackend: backend }) => {
  const profileId = await createProfileRest(backend, `human-${randomUUID().slice(0, 6)}`);
  const S = {
    ...makeStep({ id: randomUUID(), name: "S", agentProfileId: profileId, instructions: `Do S. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` }),
    transition: "all" as const,
  };
  const B = makeStep({ id: randomUUID(), name: "B", agentProfileId: profileId, instructions: `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = makeStep({ id: randomUUID(), name: "C", agentProfileId: profileId, instructions: `Do C. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const H1 = makeStep({ id: randomUUID(), name: "H1", agentProfileId: null, type: H, instructions: "check gate one" });
  const H2 = makeStep({ id: randomUUID(), name: "H2", agentProfileId: null, type: H, instructions: "check gate two" });
  const pipelineId = await createPipelineRest(backend, `human-multi-${randomUUID().slice(0, 6)}`, [S, B, C, H1, H2], [
    { from: S.id, to: B.id },
    { from: S.id, to: C.id },
    { from: B.id, to: H1.id },
    { from: C.id, to: H2.id },
  ]);
  const task = await createPipelineTaskRest(backend, `Human multi ${randomUUID().slice(0, 6)}`, pipelineId, "goal");

  await gotoApp(page, backend.bootBase);
  await startTaskRest(backend, task.id);
  const gated = await waitForPipelineRest(backend, task.id, (t) => {
    const gates = (t.pipelineRun as unknown as { humanSteps?: unknown[] } | null)?.humanSteps ?? [];
    return gates.length === 2;
  });
  const gates = (gated.pipelineRun as unknown as { humanSteps: { stepId: string; seq: number }[] }).humanSteps;
  const second = [...gates].sort((a, b) => a.seq - b.seq)[1]!;
  const secondIndex = gates.findIndex((g) => g.stepId === second.stepId);

  // R-S2 webview half: the second gate's event carries every pending seq, so
  // the one per-task alert names the count. Without that, the second gate is
  // marked announced and never gets a cue of its own (the task notifier keeps
  // one entry per task, so a second banner would replace the first).
  const toaster = page.locator("[data-sonner-toaster]");
  const multiGateToast = toaster
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Pipeline needs your review (2 gates)" });
  await expect(multiGateToast).toBeVisible({ timeout: 15_000 });

  // The alert's Open lands on the announced gate's panel, not merely the
  // board or the run view with no gate focused (C6). Which of the two gates
  // the event announced is timing-dependent; either is a gate-focused panel.
  const card = page.locator(`[data-task-id="${task.id}"]`);
  await expect(card.getByTestId("task-card-pipeline-review")).toBeVisible();
  await multiGateToast.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
  const toastFocusedPanel = page.getByTestId("pipeline-human-panel");
  await expect(toastFocusedPanel).toBeVisible();
  const gateSeqs = gates.map((g) => String(g.seq));
  await expect(toastFocusedPanel).toHaveAttribute("data-gate-seq", new RegExp(`^(${gateSeqs.join("|")})$`));
  await toastFocusedPanel.getByTitle("Close").click();
  await expect(toastFocusedPanel).toBeHidden();
  await page.getByTestId("pipeline-run-back").click();
  await expect(page.getByTestId("pipeline-run-view")).toHaveCount(0);

  await card.click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
  const section = page.getByTestId("pipeline-run-human-review");
  await expect(section).toBeVisible();
  const opens = section.getByTestId("pipeline-run-open-review");
  await expect(opens).toHaveCount(2);

  // Opening the SECOND gate must show the second gate's own panel (N1).
  await opens.nth(secondIndex).click();
  const panel = page.getByTestId("pipeline-human-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-gate-seq", String(second.seq));
  await expect(panel.getByTestId("pipeline-human-check")).toContainText(
    second.stepId === H1.id ? "check gate one" : "check gate two",
  );

  // Closing a non-primary gate and reopening it must keep the half-typed
  // comment: the panel stays mounted on THAT gate while closed, instead of
  // snapping back to the primary gate and remounting a fresh draft (R-N1).
  await panel.getByTestId("pipeline-human-comment").fill("draft for the second gate");
  await panel.getByTitle("Close").click();
  await expect(panel).toBeHidden();
  await opens.nth(secondIndex).click();
  await expect(page.getByTestId("pipeline-human-panel").getByTestId("pipeline-human-comment"))
    .toHaveValue("draft for the second gate");
  await expect(page.getByTestId("pipeline-human-panel")).toHaveAttribute("data-gate-seq", String(second.seq));

  // Switching to the other gate remounts on its own key, so the draft belongs
  // to the gate it was typed on and the new gate starts blank (T9 P4).
  const reopenedPanel = page.getByTestId("pipeline-human-panel");
  await reopenedPanel.getByTitle("Close").click();
  await expect(reopenedPanel).toBeHidden();
  const otherIndex = secondIndex === 0 ? 1 : 0;
  await opens.nth(otherIndex).click();
  const switched = page.getByTestId("pipeline-human-panel");
  await expect(switched).toHaveAttribute("data-gate-seq", String(gates[otherIndex]!.seq));
  await expect(switched.getByTestId("pipeline-human-comment")).toHaveValue("");
});

test("context menu: Review pipeline present, Mark done absent while a gate is pending", async ({ page, freshBackend: backend }) => {
  const profileId = await createProfileRest(backend, `human-${randomUUID().slice(0, 6)}`);
  const A = makeStep({ id: randomUUID(), name: "A", agentProfileId: profileId, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const Hstep = makeStep({ id: randomUUID(), name: "H", agentProfileId: null, type: H });
  const pipelineId = await createPipelineRest(backend, `human-menu-${randomUUID().slice(0, 6)}`, [A, Hstep], [{ from: A.id, to: Hstep.id }]);
  const task = await createPipelineTaskRest(backend, `Human menu ${randomUUID().slice(0, 6)}`, pipelineId, "goal");

  await gotoApp(page, backend.bootBase);
  await startTaskRest(backend, task.id);
  await gateRow(backend, task.id);

  const card = page.locator(`[data-task-id="${task.id}"]`);
  await card.click({ button: "right" });
  const menu = page.locator('[role="menu"], [role="dialog"]').last();
  await expect(page.getByRole("menuitem", { name: "Review pipeline" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark done" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(await getTaskRest(backend, task.id)).toBeTruthy();
  void menu;
});
