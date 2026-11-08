import { describe, expect, test } from "bun:test";
import type { HarnessStack, TaskHarnessState } from "../../shared/types.ts";
import { stackBadgeStateFor } from "./stack-badge.ts";

function stack(id: string, members: string[]): HarnessStack {
  return {
    id,
    label: id,
    kind: "claude-code",
    mirrorMode: "full",
    members: members.map((harnessId, position) => ({
      harnessId,
      position,
      label: harnessId,
      kind: "claude-code",
      enabled: true,
    })),
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
  };
}

function state(stackId: string, extra: Partial<TaskHarnessState> = {}): TaskHarnessState {
  return {
    stackId,
    position: 0,
    count: 2,
    tried: [],
    pendingSwap: null,
    allExhausted: null,
    lastMove: null,
    ...extra,
  };
}

describe("stackBadgeStateFor", () => {
  test("a not-yet-run task derives its position from the account's stack", () => {
    const stacks = [stack("s1", ["a", "b", "c"])];
    expect(stackBadgeStateFor({ agent: "c", harnessState: null }, stacks)).toEqual({
      stackId: "s1",
      position: 2,
      count: 3,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
  });

  test("recorded state for the same stack is returned untouched", () => {
    const pending = state("s1", {
      position: 1,
      pendingSwap: { from: "a", to: "b", reason: "quota", runId: "r1", startedAt: 5 },
    });
    expect(stackBadgeStateFor({ agent: "b", harnessState: pending }, [stack("s1", ["a", "b"])])).toBe(pending);
  });

  test("a deleted member re-ranks the badge instead of showing an impossible n/m (R13-M1)", () => {
    // The state was written when the train had 3 accounts and this task ran on
    // the last one (3/3). Deleting the primary leaves two accounts, so the
    // card must show 2/2 — never a position the membership does not have.
    const stale = state("s1", {
      position: 2,
      count: 3,
      pendingSwap: { from: "b", to: "c", reason: "quota", runId: "r2", startedAt: 9 },
    });
    const derived = stackBadgeStateFor({ agent: "c", harnessState: stale }, [stack("s1", ["b", "c"])]);
    expect(derived).toEqual({ ...stale, position: 1, count: 2 });
    expect(derived?.pendingSwap).toEqual(stale.pendingSwap);
  });

  test("a membership move re-points position/count but keeps live failover state (R11-S1)", () => {
    // The task is mid-swap on stack s1 and its account was just edited into s2.
    // RunPanel renders `task.harnessState` directly, so the card must not zero
    // the swap/countdown it is showing.
    const live = state("s1", {
      position: 0,
      pendingSwap: { from: "a", to: "b", reason: "quota", runId: "r1", startedAt: 7 },
      lastMove: { from: "c", to: "a", at: 3, reason: "member-unavailable" },
    });
    const derived = stackBadgeStateFor({ agent: "a", harnessState: live }, [stack("s2", ["x", "a"])]);
    expect(derived).toEqual({
      ...live,
      stackId: "s2",
      position: 1,
      count: 2,
    });
    expect(derived?.pendingSwap).toEqual(live.pendingSwap);
    expect(derived?.lastMove).toEqual(live.lastMove);
  });

  test("a live all-exhausted marker survives a membership move", () => {
    const ex = {
      at: 1,
      attempts: 0,
      max: 3,
      nextAttemptAt: Date.now() + 60_000,
      earliestResetAtMs: null,
      reason: "quota" as const,
    };
    const derived = stackBadgeStateFor(
      { agent: "a", harnessState: state("s1", { allExhausted: ex }) },
      [stack("s2", ["a", "b"])],
    );
    expect(derived?.allExhausted).toEqual(ex);
  });

  test("an account in no stack keeps its recorded state until the next move", () => {
    const recorded = state("gone", { position: 1 });
    expect(stackBadgeStateFor({ agent: "a", harnessState: recorded }, [stack("s1", ["b", "c"])])).toBe(recorded);
    expect(stackBadgeStateFor({ agent: "a", harnessState: null }, [stack("s1", ["b", "c"])])).toBeNull();
  });
});
