import { describe, expect, test } from "bun:test";
import type { ColumnId, TaskHarnessState } from "../../shared/types.ts";
import { formatCountdown, harnessStackBannerView } from "./harness-stack-banner.ts";

const NOW = 1_000_000;
const labelOf = (id: string) => ({ a: "Work", b: "Personal" } as Record<string, string>)[id] ?? id;

function state(extra: Partial<TaskHarnessState> = {}): TaskHarnessState {
  return { stackId: "s1", position: 1, count: 2, tried: [], pendingSwap: null, allExhausted: null, lastMove: null, ...extra };
}

function exhausted(extra: Partial<NonNullable<TaskHarnessState["allExhausted"]>> = {}) {
  return {
    at: 1,
    attempts: 0,
    max: 3,
    nextAttemptAt: NOW + 90_000,
    earliestResetAtMs: null,
    reason: "quota" as const,
    ...extra,
  };
}

function view(column: ColumnId, harnessState: TaskHarnessState | null) {
  return harnessStackBannerView({ agent: "b", column, harnessState }, labelOf, NOW);
}

describe("harnessStackBannerView", () => {
  test("no state, no banner", () => {
    expect(view("review", null)).toBeNull();
    expect(view("review", state())).toBeNull();
  });

  test("a pending swap names the destination account", () => {
    const v = view("running", state({ pendingSwap: { from: "a", to: "b", reason: "quota", runId: "r", startedAt: 1 } }));
    expect(v).toEqual({ kind: "pending", text: "Switching to Personal…" });
  });

  test("a recent move uses the shared move note", () => {
    const v = view("review", state({ lastMove: { from: "a", to: "b", at: NOW - 1000, reason: "manual-switch" } }));
    expect(v).toEqual({ kind: "moved", text: "Switched to Personal — continuing this conversation." });
  });

  test("a waiting all-exhausted task shows the countdown and Run now", () => {
    const v = view("blocked", state({ allExhausted: exhausted() }));
    expect(v).toEqual({
      kind: "exhausted",
      text: "Every account in this stack is out of quota — retrying in 1m 30s (attempt 1/3).",
      runNow: true,
    });
  });

  test("the live retry run (inFlight) is 'running after a quota reset' with no Run now (S20)", () => {
    const v = view("blocked", state({ allExhausted: exhausted({ nextAttemptAt: 0, inFlight: true, attempts: 1 }) }));
    expect(v).toEqual({ kind: "retry-running", text: "Running on Personal after a quota reset (attempt 2/3)." });
  });

  test("a running task with the marker (successor alive, inFlight unset) is the retry run too (S20)", () => {
    const v = view("running", state({ allExhausted: exhausted({ nextAttemptAt: 0 }) }));
    expect(v?.kind).toBe("retry-running");
    expect(v?.text).toBe("Running on Personal after a quota reset (attempt 1/3).");
    expect(v).not.toHaveProperty("runNow");
  });

  test("a fired retry with no run yet still reads as retrying and keeps Run now", () => {
    const v = view("blocked", state({ allExhausted: exhausted({ nextAttemptAt: 0, attempts: 1 }) }));
    expect(v).toEqual({
      kind: "exhausted",
      text: "Retrying on the next available account (attempt 2/3)…",
      runNow: true,
    });
  });

  test("the cap reached asks for a manual run", () => {
    const v = view("blocked", state({ allExhausted: exhausted({ attempts: 3 }) }));
    expect(v?.text).toBe("Every account in this stack is out of quota — run the task manually after a reset.");
  });

  test("no usable member points at Settings", () => {
    const v = view("blocked", state({ allExhausted: exhausted({ nextAttemptAt: 0, reason: "no-usable-member" }) }));
    expect(v?.text).toBe("No account in this stack can run this task — fix one in Settings → Stacks.");
  });
});

test("formatCountdown", () => {
  expect(formatCountdown(5)).toBe("5s");
  expect(formatCountdown(65)).toBe("1m 5s");
  expect(formatCountdown(3 * 3600 + 120)).toBe("3h 2m");
  expect(formatCountdown(-4)).toBe("0s");
});
