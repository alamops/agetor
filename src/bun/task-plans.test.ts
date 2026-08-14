import { test, expect } from "bun:test";
import type { TaskPlan } from "../shared/types.ts";
import {
  approvePlan,
  effectiveContent,
  planIdFromCallId,
  planSlug,
  resolveClaudePlan,
  setEditedContent,
  upsertClaudePlanFromExitPlanMode,
  upsertDetectedPlan,
} from "./task-plans.ts";

// Pure-unit tests for src/bun/task-plans.ts — no DB, no orchestrator, no
// fake drivers. See orchestrator-cursor-plan.test.ts for the flow-level
// coverage (detection via attachDoneHandler, the PATCH/approve routes).

/** Build a fully-formed TaskPlan fixture, overriding only what a test cares
 *  about — mirrors what `upsertDetectedPlan` would have produced. */
function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "abc1234500000000",
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Fake Plan",
    content: "# Fake Plan\n\n- step one\n- step two",
    editedContent: null,
    status: "pending",
    createdAt: 1000,
    approvedAt: null,
    approvedEdited: false,
    filePath: null,
    ...overrides,
  };
}

// --- planIdFromCallId -------------------------------------------------

test("planIdFromCallId: deterministic — same input yields the same id", () => {
  const callId = "call-abc\nfc_123";
  expect(planIdFromCallId(callId)).toBe(planIdFromCallId(callId));
});

test("planIdFromCallId: 16 lowercase hex chars", () => {
  const id = planIdFromCallId("call-abc\nfc_123");
  expect(id).toMatch(/^[0-9a-f]{16}$/);
});

test("planIdFromCallId: handles call_ids with embedded newlines without throwing", () => {
  const callId = "call-with-a-\nnewline-in-it\nand-another\n";
  expect(() => planIdFromCallId(callId)).not.toThrow();
  expect(planIdFromCallId(callId)).toMatch(/^[0-9a-f]{16}$/);
});

test("planIdFromCallId: distinct inputs produce distinct ids", () => {
  const a = planIdFromCallId("call-1\nfc_1");
  const b = planIdFromCallId("call-2\nfc_2");
  expect(a).not.toBe(b);
});

// --- planSlug -----------------------------------------------------------

test("planSlug: lowercases the name", () => {
  expect(planSlug("My Plan")).toBe("my_plan");
});

test("planSlug: collapses runs of non-alphanumerics to a single underscore", () => {
  expect(planSlug("Foo!!  Bar??Baz")).toBe("foo_bar_baz");
});

test("planSlug: trims leading/trailing underscores", () => {
  expect(planSlug("__Foo__")).toBe("foo");
});

test("planSlug: caps length at 40 chars and trims a trailing underscore the cap exposes", () => {
  // 39 'a's + '-' + 10 'b's: after non-alnum collapse the '-' becomes '_' at
  // index 39, landing exactly on the 40-char slice boundary — this is the
  // case the trailing-underscore trim in planSlug exists to handle.
  const name = "a".repeat(39) + "-" + "b".repeat(10);
  const slug = planSlug(name);
  expect(slug).toBe("a".repeat(39));
  expect(slug.length).toBeLessThanOrEqual(40);
});

test("planSlug: a name with no punctuation is simply truncated at 40 chars", () => {
  const name = "a".repeat(45);
  expect(planSlug(name)).toBe("a".repeat(40));
});

test("planSlug: null name falls back to 'plan'", () => {
  expect(planSlug(null)).toBe("plan");
});

test("planSlug: empty / all-punctuation name falls back to 'plan'", () => {
  expect(planSlug("")).toBe("plan");
  expect(planSlug("!!!???")).toBe("plan");
});

// --- upsertDetectedPlan ---------------------------------------------------

test("upsertDetectedPlan: appends a pending plan to an empty list", () => {
  const next = upsertDetectedPlan([], {
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Plan One",
    content: "content one",
    now: 1000,
  });
  expect(next.length).toBe(1);
  expect(next[0]!.status).toBe("pending");
  expect(next[0]!.content).toBe("content one");
  expect(next[0]!.toolCallId).toBe("call-1\nfc_1");
});

test("upsertDetectedPlan: same toolCallId is idempotent — returns the SAME array reference and preserves existing edits/status", () => {
  const first = upsertDetectedPlan([], {
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Plan One",
    content: "original content",
    now: 1000,
  });
  // Simulate an edit having landed since detection.
  const edited = setEditedContent(first, first[0]!.id, "user edit")!;

  // Re-detecting the SAME call_id (e.g. a reattach re-reading run_events)
  // must be a no-op: same reference back, edit/status untouched.
  const second = upsertDetectedPlan(edited, {
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Plan One (different name — must be ignored)",
    content: "different content — must be ignored",
    now: 2000,
  });
  expect(second).toBe(edited); // reference equality — literal no-op
  expect(second[0]!.content).toBe("original content");
  expect(second[0]!.editedContent).toBe("user edit");
  expect(second[0]!.status).toBe("pending");
});

test("upsertDetectedPlan: a new plan supersedes an existing PENDING plan", () => {
  const first = upsertDetectedPlan([], {
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Plan One",
    content: "content one",
    now: 1000,
  });
  const second = upsertDetectedPlan(first, {
    toolCallId: "call-2\nfc_2",
    runId: "run-2",
    name: "Plan Two",
    content: "content two",
    now: 2000,
  });
  expect(second.length).toBe(2);
  expect(second[0]!.status).toBe("superseded");
  expect(second[1]!.status).toBe("pending");
});

test("upsertDetectedPlan: an APPROVED plan is left untouched by a later detection (not superseded)", () => {
  const first = upsertDetectedPlan([], {
    toolCallId: "call-1\nfc_1",
    runId: "run-1",
    name: "Plan One",
    content: "content one",
    now: 1000,
  });
  const approvedResult = approvePlan(first, first[0]!.id, { now: 1500, filePath: ".cursor/plans/plan_one.plan.md" });
  expect(approvedResult).not.toBeNull();
  const approved = approvedResult!.plans;
  expect(approved[0]!.status).toBe("approved");

  // A brand new plan lands (e.g. the resumed turn stopped on another plan).
  const second = upsertDetectedPlan(approved, {
    toolCallId: "call-2\nfc_2",
    runId: "run-2",
    name: "Plan Two",
    content: "content two",
    now: 2000,
  });
  expect(second.length).toBe(2);
  // The approved plan's status/fields are exactly as they were — the
  // "supersede on new detection" transition only touches `pending` entries.
  expect(second[0]!.status).toBe("approved");
  expect(second[0]!.approvedAt).toBe(1500);
  expect(second[0]!.filePath).toBe(".cursor/plans/plan_one.plan.md");
  expect(second[1]!.status).toBe("pending");
});

test("upsertDetectedPlan: retention cap prunes oldest superseded plans, never the newest pending or the most recent approved", () => {
  let plans: TaskPlan[] = [];
  const ids: string[] = [];

  // Plan 0: detect then immediately approve, so it sits in history as the
  // "most recent approved" plan for the rest of the sequence.
  plans = upsertDetectedPlan(plans, {
    toolCallId: "call-0\nfc_0",
    runId: "run-0",
    name: "Plan 0",
    content: "content 0",
    now: 0,
  });
  ids.push(plans[0]!.id);
  const approvedResult = approvePlan(plans, plans[0]!.id, { now: 1, filePath: ".cursor/plans/plan_0.plan.md" });
  plans = approvedResult!.plans;

  // Plans 1..11: eleven more detections, each superseding the prior pending
  // one (plan 0 stays approved throughout — only pending entries flip).
  for (let i = 1; i <= 11; i++) {
    plans = upsertDetectedPlan(plans, {
      toolCallId: `call-${i}\nfc_${i}`,
      runId: `run-${i}`,
      name: `Plan ${i}`,
      content: `content ${i}`,
      now: i,
    });
    ids.push(plans[plans.length - 1]!.id);
  }

  // 12 plans total (0..11) exceeds MAX_RETAINED_PLANS (10) by 2.
  expect(plans.length).toBe(10);

  const remainingIds = new Set(plans.map((p) => p.id));
  // Protected: plan 0 (most recent approved) and plan 11 (newest, pending).
  expect(remainingIds.has(ids[0]!)).toBe(true);
  expect(plans.find((p) => p.id === ids[0])!.status).toBe("approved");
  expect(remainingIds.has(ids[11]!)).toBe(true);
  expect(plans.find((p) => p.id === ids[11])!.status).toBe("pending");
  // The two oldest UNPROTECTED (superseded) entries — plans 1 and 2 — are
  // the ones pruned; plan 0 is older still but protected by its approval.
  expect(remainingIds.has(ids[1]!)).toBe(false);
  expect(remainingIds.has(ids[2]!)).toBe(false);
  // Plan 3 onward survive (toDrop reached 0 after dropping plans 1 and 2).
  expect(remainingIds.has(ids[3]!)).toBe(true);
});

// --- setEditedContent -----------------------------------------------------

test("setEditedContent: returns null when the plan id is missing", () => {
  const plans = [makePlan()];
  expect(setEditedContent(plans, "does-not-exist", "text")).toBeNull();
});

test("setEditedContent: returns null when the plan is not pending", () => {
  const plans = [makePlan({ status: "approved" })];
  expect(setEditedContent(plans, plans[0]!.id, "text")).toBeNull();
  const superseded = [makePlan({ status: "superseded" })];
  expect(setEditedContent(superseded, superseded[0]!.id, "text")).toBeNull();
});

test("setEditedContent: editedContent equal to the original content normalizes to null", () => {
  const plan = makePlan();
  const next = setEditedContent([plan], plan.id, plan.content);
  expect(next).not.toBeNull();
  expect(next![0]!.editedContent).toBeNull();
});

test("setEditedContent: an edit different from the original persists", () => {
  const plan = makePlan();
  const next = setEditedContent([plan], plan.id, "a genuinely different plan");
  expect(next).not.toBeNull();
  expect(next![0]!.editedContent).toBe("a genuinely different plan");
});

test("setEditedContent: passing null clears any existing draft", () => {
  const plan = makePlan({ editedContent: "old draft" });
  const next = setEditedContent([plan], plan.id, null);
  expect(next).not.toBeNull();
  expect(next![0]!.editedContent).toBeNull();
});

// --- approvePlan / effectiveContent ---------------------------------------

test("approvePlan: returns null when the plan id is missing", () => {
  const plans = [makePlan()];
  expect(approvePlan(plans, "does-not-exist", { now: 1, filePath: "x.plan.md" })).toBeNull();
});

test("approvePlan: returns null when the plan is not pending (already approved or superseded)", () => {
  const approved = [makePlan({ status: "approved" })];
  expect(approvePlan(approved, approved[0]!.id, { now: 1, filePath: "x.plan.md" })).toBeNull();
  const superseded = [makePlan({ status: "superseded" })];
  expect(approvePlan(superseded, superseded[0]!.id, { now: 1, filePath: "x.plan.md" })).toBeNull();
});

test("approvePlan: sets approvedAt/filePath and approvedEdited=false for an unedited approval", () => {
  const plan = makePlan();
  const result = approvePlan([plan], plan.id, { now: 12345, filePath: ".cursor/plans/fake_plan_abc.plan.md" });
  expect(result).not.toBeNull();
  const approved = result!.approved;
  expect(approved.status).toBe("approved");
  expect(approved.approvedAt).toBe(12345);
  expect(approved.filePath).toBe(".cursor/plans/fake_plan_abc.plan.md");
  expect(approved.approvedEdited).toBe(false);
  // The updated plan in the returned list is the same object.
  expect(result!.plans[0]).toEqual(approved);
});

test("approvePlan: approvedEdited=true when a draft edit is present at approval time", () => {
  const plan = makePlan({ editedContent: "edited version" });
  const result = approvePlan([plan], plan.id, { now: 1, filePath: "x.plan.md" });
  expect(result).not.toBeNull();
  expect(result!.approved.approvedEdited).toBe(true);
});

test("effectiveContent: returns the original content when there is no edit", () => {
  const plan = makePlan({ editedContent: null });
  expect(effectiveContent(plan)).toBe(plan.content);
});

test("effectiveContent: returns the edited content when present, not the original", () => {
  const plan = makePlan({ editedContent: "edited version" });
  expect(effectiveContent(plan)).toBe("edited version");
  expect(effectiveContent(plan)).not.toBe(plan.content);
});

// --- upsertClaudePlanFromExitPlanMode -------------------------------------

test("upsertClaudePlanFromExitPlanMode: appends a pending plan with name null", () => {
  const next = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01abc",
    runId: "run-1",
    content: "# Plan\n\n- step one",
    now: 1000,
  });
  expect(next.length).toBe(1);
  expect(next[0]!.status).toBe("pending");
  expect(next[0]!.name).toBeNull();
  expect(next[0]!.content).toBe("# Plan\n\n- step one");
  expect(next[0]!.toolCallId).toBe("toolu_01abc");
});

test("upsertClaudePlanFromExitPlanMode: idempotent by toolCallId (reattach-safe), same as upsertDetectedPlan", () => {
  const first = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01abc",
    runId: "run-1",
    content: "original plan",
    now: 1000,
  });
  const second = upsertClaudePlanFromExitPlanMode(first, {
    toolCallId: "toolu_01abc",
    runId: "run-1",
    content: "different content — must be ignored",
    now: 2000,
  });
  expect(second).toBe(first);
  expect(second[0]!.content).toBe("original plan");
});

test("upsertClaudePlanFromExitPlanMode: a new ExitPlanMode supersedes a stale pending plan", () => {
  const first = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "plan one",
    now: 1000,
  });
  const second = upsertClaudePlanFromExitPlanMode(first, {
    toolCallId: "toolu_02",
    runId: "run-2",
    content: "plan two",
    now: 2000,
  });
  expect(second.length).toBe(2);
  expect(second[0]!.status).toBe("superseded");
  expect(second[1]!.status).toBe("pending");
});

// --- resolveClaudePlan ------------------------------------------------------

test("resolveClaudePlan: returns the SAME array reference when toolCallId doesn't match any plan", () => {
  const plans = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "plan",
    now: 1000,
  });
  const next = resolveClaudePlan(plans, "toolu_does_not_exist", "User has approved your plan.", 2000);
  expect(next).toBe(plans);
});

test("resolveClaudePlan: returns the SAME array reference when the matching plan is no longer pending", () => {
  const plans = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "plan",
    now: 1000,
  });
  const approved = resolveClaudePlan(plans, "toolu_01", "User has approved your plan.", 2000);
  expect(approved).not.toBe(plans);
  // A stale/duplicate tool_result replayed on reattach must be a no-op.
  const replayed = resolveClaudePlan(approved, "toolu_01", "User has approved your plan.", 3000);
  expect(replayed).toBe(approved);
});

test("resolveClaudePlan: plain approval (no edit marker) sets status approved, approvedEdited false, editedContent null", () => {
  const plans = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "# Original Plan",
    now: 1000,
  });
  const next = resolveClaudePlan(
    plans,
    "toolu_01",
    "User has approved your plan. You can now start coding.",
    5000,
  );
  expect(next).not.toBe(plans);
  const plan = next[0]!;
  expect(plan.status).toBe("approved");
  expect(plan.approvedAt).toBe(5000);
  expect(plan.approvedEdited).toBe(false);
  expect(plan.editedContent).toBeNull();
  expect(plan.content).toBe("# Original Plan");
  // Claude plans never get a filePath — approval doesn't write a file.
  expect(plan.filePath).toBeNull();
});

test("resolveClaudePlan: approval with the edited-plan marker extracts the edited text, sets approvedEdited true", () => {
  const plans = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "# Original Plan\n\n- step one",
    now: 1000,
  });
  const resultContent =
    "User has approved your plan. You can now start coding. Start with what you' told will be step #1.\n\n"
    + "## Approved Plan (edited by user):\n# Edited Plan\n\n- step one (edited)\n- step two (added)";
  const next = resolveClaudePlan(plans, "toolu_01", resultContent, 5000);
  const plan = next[0]!;
  expect(plan.status).toBe("approved");
  expect(plan.approvedEdited).toBe(true);
  expect(plan.editedContent).toBe("# Edited Plan\n\n- step one (edited)\n- step two (added)");
  // Original content is preserved verbatim — edits live in editedContent only.
  expect(plan.content).toBe("# Original Plan\n\n- step one");
});

test("resolveClaudePlan: any other tool_result content (rejection/interrupt) resolves to rejected", () => {
  const plans = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "# Plan",
    now: 1000,
  });
  const next = resolveClaudePlan(plans, "toolu_01", "The user rejected your plan.", 5000);
  const plan = next[0]!;
  expect(plan.status).toBe("rejected");
  expect(plan.approvedAt).toBeNull();
});

test("resolveClaudePlan: supersede + resolve interplay — resolving a superseded (non-pending) plan is a no-op", () => {
  const first = upsertClaudePlanFromExitPlanMode([], {
    toolCallId: "toolu_01",
    runId: "run-1",
    content: "plan one",
    now: 1000,
  });
  const superseded = upsertClaudePlanFromExitPlanMode(first, {
    toolCallId: "toolu_02",
    runId: "run-2",
    content: "plan two",
    now: 2000,
  });
  expect(superseded[0]!.status).toBe("superseded");
  // A late-arriving tool_result for the superseded call id must not
  // resurrect it — it's no longer the actionable plan.
  const next = resolveClaudePlan(superseded, "toolu_01", "User has approved your plan.", 3000);
  expect(next).toBe(superseded);
});
