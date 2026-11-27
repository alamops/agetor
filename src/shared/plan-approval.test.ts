import { expect, test } from "bun:test";
import { planApprovalFlipsToAuto } from "./plan-approval.ts";

test("a Plan-mode task that no agent profile owns flips to Auto on approval", () => {
  expect(planApprovalFlipsToAuto({ mode: "plan", agentProfileId: null })).toBe(true);
});

test("a profile-bound Plan task keeps Plan: its mode belongs to the profile", () => {
  expect(planApprovalFlipsToAuto({ mode: "plan", agentProfileId: "p1" })).toBe(false);
});

test("no other mode flips", () => {
  for (const mode of ["auto", "ask", "yolo", null, undefined]) {
    expect(planApprovalFlipsToAuto({ mode, agentProfileId: null })).toBe(false);
  }
});
