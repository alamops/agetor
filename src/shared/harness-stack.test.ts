import { describe, expect, test } from "bun:test";
import {
  HARNESS_STACK_MOVED_TTL_MS,
  composeHarnessStackContinuationPrompt,
  formatHarnessSwapNotice,
  formatStackExhausted,
  formatStackUnusable,
  harnessMoveNote,
  harnessStackBannerMode,
  isHarnessStackContinuation,
  parseHarnessSwapNotice,
  pickNextMember,
  stackPositionText,
  stripHarnessStackContinuation,
  wrapHarnessStackContinuation,
} from "./harness-stack.ts";
import { parseTaskHarnessState } from "./types.ts";
import type { HarnessStackMember, HarnessSwapNotice, TaskHarnessState } from "./types.ts";

const member = (id: string, enabled = true): HarnessStackMember => ({
  harnessId: id,
  position: 0,
  label: id.toUpperCase(),
  kind: "claude-code",
  enabled,
});

const members = [member("a"), member("b"), member("c")];

describe("stack positions and the forward walk", () => {
  test("position text is 1-based and null outside the stack", () => {
    expect(stackPositionText({ members }, "a")).toBe("1/3");
    expect(stackPositionText({ members }, "c")).toBe("3/3");
    expect(stackPositionText({ members }, "z")).toBeNull();
  });

  test("a walk picks the next usable member and skips tried/disabled/cooling", () => {
    const plan = pickNextMember({
      members,
      currentId: "a",
      tried: [],
      now: 1000,
      cooling: (id) => (id === "b" ? { exhaustedUntilMs: 5000 } : null),
      usable: () => null,
    });
    expect(plan.kind).toBe("next");
    if (plan.kind !== "next") return;
    expect(plan.member.harnessId).toBe("c");
    expect(plan.skipped.map((s) => s.harnessId)).toContain("b");
  });

  test("an orphaned current account starts the walk at the first member", () => {
    // A member removed mid-flight is not in the list; the walk must consider
    // member 0, not start after it (which skipped it entirely).
    const plan = pickNextMember({
      members,
      currentId: "gone",
      tried: [],
      now: 1000,
      cooling: () => null,
      usable: () => null,
    });
    expect(plan.kind).toBe("next");
    if (plan.kind !== "next") return;
    expect(plan.member.harnessId).toBe("a");
  });

  test("all tried/cooling yields all-exhausted with the earliest reset", () => {
    const plan = pickNextMember({
      members,
      currentId: "a",
      tried: [],
      now: 1000,
      cooling: (id) => ({ exhaustedUntilMs: id === "b" ? 9000 : 4000 }),
      usable: () => null,
    });
    expect(plan.kind).toBe("all-exhausted");
    if (plan.kind !== "all-exhausted") return;
    expect(plan.earliestResetAtMs).toBe(4000);
  });

  test("a quota-exhausted member contributes its provider reset to the plan", () => {
    const plan = pickNextMember({
      members,
      currentId: "a",
      tried: [],
      now: 1000,
      cooling: () => null,
      exhaustedByQuota: () => true,
      quotaResetAt: (id) => (id === "b" ? 4000 : id === "c" ? 9000 : 12_000),
      usable: () => null,
    });
    expect(plan.kind).toBe("all-exhausted");
    if (plan.kind !== "all-exhausted") return;
    // Without the quota reset the plan would arm the generic 10-minute
    // backoff instead of retrying at the provider's own reset.
    expect(plan.earliestResetAtMs).toBe(4000);
  });

  test("a full lap of tried members is all-exhausted, never a permanent none-usable", () => {
    // Regression: two accounts that each ended a run in a limit left `tried`
    // covering the whole stack. Checking `tried` before the cooling state
    // counted zero limit blocks, so the task blocked with no retry timer.
    const plan = pickNextMember({
      members: [member("a"), member("b")],
      currentId: "b",
      tried: ["a", "b"],
      now: 1000,
      cooling: (id) => ({ exhaustedUntilMs: id === "a" ? 5000 : 9000 }),
      usable: () => null,
    });
    expect(plan.kind).toBe("all-exhausted");
    if (plan.kind !== "all-exhausted") return;
    expect(plan.earliestResetAtMs).toBe(5000);
    expect(plan.skipped.map((s) => s.harnessId).sort()).toEqual(["a", "b"]);
  });

  test("a full lap with no recorded reset still retries with a backoff", () => {
    const plan = pickNextMember({
      members: [member("a"), member("b")],
      currentId: "b",
      tried: ["a", "b"],
      now: 1000,
      cooling: () => null,
      usable: () => null,
    });
    expect(plan.kind).toBe("all-exhausted");
    if (plan.kind !== "all-exhausted") return;
    expect(plan.earliestResetAtMs).toBeNull();
  });

  test("none-usable records every reason and no reset when nothing can reset", () => {
    const plan = pickNextMember({
      members: [member("a"), member("b", false)],
      currentId: "a",
      tried: ["a"],
      now: 1000,
      cooling: () => null,
      usable: () => null,
    });
    expect(plan.kind).toBe("none-usable");
    if (plan.kind !== "none-usable") return;
    expect(plan.earliestResetAtMs).toBeNull();
    expect(plan.reasons.map((r) => r.harnessId)).toContain("b");
  });
});

describe("task-header banner precedence", () => {
  const base: TaskHarnessState = {
    stackId: "stack",
    position: 1,
    count: 2,
    tried: ["a"],
    pendingSwap: null,
    allExhausted: null,
    lastMove: null,
  };
  const now = 1_000_000;

  test("no state or no marker yields no banner", () => {
    expect(harnessStackBannerMode(null, now)).toBeNull();
    expect(harnessStackBannerMode(base, now)).toBeNull();
  });

  test("a pending swap wins over everything", () => {
    const state: TaskHarnessState = {
      ...base,
      pendingSwap: { from: "a", to: "b", reason: "quota", runId: "r", startedAt: now },
      allExhausted: { at: now, attempts: 0, max: 3, nextAttemptAt: now + 60_000, earliestResetAtMs: null, reason: "quota" },
    };
    expect(harnessStackBannerMode(state, now)).toBe("pending");
  });

  test("an all-exhausted retry wins over a recent move", () => {
    const state: TaskHarnessState = {
      ...base,
      lastMove: { from: "a", to: "b", at: now - 1_000, reason: "member-unavailable" },
      allExhausted: { at: now, attempts: 0, max: 3, nextAttemptAt: now + 60_000, earliestResetAtMs: null, reason: "quota" },
    };
    // Regression: the moved line used to return first and hide the countdown
    // (and "Run now") until the 24-hour TTL expired.
    expect(harnessStackBannerMode(state, now)).toBe("exhausted");
  });

  test("a move shows only inside the TTL", () => {
    const state: TaskHarnessState = {
      ...base,
      lastMove: { from: "a", to: "b", at: now - 1_000, reason: "member-unavailable" },
    };
    expect(harnessStackBannerMode(state, now)).toBe("moved");
    expect(harnessStackBannerMode(state, now + HARNESS_STACK_MOVED_TTL_MS)).toBeNull();
  });

  test("the note distinguishes a user switch from an automatic move (review S2)", () => {
    const switchMove: NonNullable<TaskHarnessState["lastMove"]> = {
      from: "a", to: "b", at: now, reason: "manual-switch",
    };
    expect(harnessMoveNote(switchMove, "Backup")).toBe("Switched to Backup — continuing this conversation.");
    for (const reason of ["member-removed", "member-disabled", "member-unavailable"] as const) {
      expect(harnessMoveNote({ ...switchMove, reason }, "Backup"))
        .toBe("Moved to Backup — the previous account left the stack or was unavailable.");
    }
  });

  test("manual-switch survives the persisted-state parser; unknown reasons stay unavailable", () => {
    const state = parseTaskHarnessState(JSON.stringify({
      stackId: "s",
      position: 0,
      lastMove: { from: "a", to: "b", at: 1, reason: "manual-switch" },
    }));
    expect(state?.lastMove?.reason).toBe("manual-switch");
    const legacy = parseTaskHarnessState(JSON.stringify({
      stackId: "s",
      position: 0,
      lastMove: { from: "a", to: "b", at: 1, reason: "something-else" },
    }));
    expect(legacy?.lastMove?.reason).toBe("member-unavailable");
  });
});

describe("swap notice", () => {
  const notice: HarnessSwapNotice = {
    from: "a",
    fromLabel: "Work",
    to: "b",
    toLabel: "Backup",
    reason: "quota",
    position: 2,
    count: 3,
    resetsAtMs: null,
    at: 5,
  };

  test("the exact copy names labels only", () => {
    expect(formatHarnessSwapNotice(notice)).toBe(
      "Switched to Backup — usage limit reached. Continuing from the transferred conversation.",
    );
    expect(formatHarnessSwapNotice(notice)).not.toContain("Agetor");
  });

  test("the clean-retry copy never claims a transferred conversation", () => {
    const restarted = { ...notice, continuation: "restarted" as const };
    expect(formatHarnessSwapNotice(restarted)).toBe(
      "Switched to Backup — usage limit reached. Restarting the request on this account.",
    );
    expect(formatHarnessSwapNotice(restarted)).not.toContain("transferred conversation");
  });

  test("the destination label is escaped for a terminal", () => {
    const escaped = formatHarnessSwapNotice({
      ...notice,
      toLabel: "Back\u001b[31mup\nnext",
    });
    expect(escaped).toBe(
      "Switched to Back\\u001b[31mup next — usage limit reached. Continuing from the transferred conversation.",
    );
    // No raw ESC or newline reaches the terminal.
    expect(escaped).not.toContain("\u001b");
    expect(escaped).not.toContain("\n");
  });

  test("parses the sentinel payload and rejects malformed input", () => {
    expect(parseHarnessSwapNotice(`harness-swap: ${JSON.stringify({ ...notice, continuation: "restarted" })}`))
      .toEqual({ ...notice, continuation: "restarted" });
    expect(parseHarnessSwapNotice(`harness-swap: ${JSON.stringify(notice)}`)).toEqual(notice);
    expect(parseHarnessSwapNotice("harness-swap: {")).toBeNull();
    expect(parseHarnessSwapNotice(JSON.stringify({ ...notice, reason: "auth" }))).toBeNull();
  });

  test("exhausted/unusable copy is explicit about manual action", () => {
    expect(formatStackExhausted({ nextAttemptAt: 0, attempts: 3, max: 3 })).toContain("manually");
    expect(formatStackExhausted({ nextAttemptAt: Date.now() + 60_000, attempts: 1, max: 3 })).toContain("attempt 2/3");
    expect(formatStackUnusable([{ harnessId: "b", reason: "disabled" }])).toContain("b: disabled");
    // A resolved account label is shown instead of the raw id.
    expect(formatStackUnusable([{ harnessId: "h-1", label: "Work account", reason: "not logged in" }]))
      .toContain("Work account: not logged in");
  });
});

describe("hidden continuation tag", () => {
  test("wraps and unwraps the exact machine prompt", () => {
    const wrapped = composeHarnessStackContinuationPrompt();
    expect(isHarnessStackContinuation(wrapped)).toBe(true);
    expect(wrapped).toContain("Continue the task");
    expect(wrapped).not.toContain("Agetor");
  });

  test("a user message that merely mentions the tag stays visible", () => {
    const prose = "I typed <harness-stack-continuation> in the docs, what does it do?";
    expect(isHarnessStackContinuation(prose)).toBe(false);
    expect(isHarnessStackContinuation(prose)).toBe(false);
    const nested = wrapHarnessStackContinuation(wrapHarnessStackContinuation("x"));
    expect(isHarnessStackContinuation(nested)).toBe(false);
  });

  test("strip unwraps one exact wrapper and is a no-op otherwise", () => {
    const wrapped = wrapHarnessStackContinuation("the user's original words");
    expect(stripHarnessStackContinuation(wrapped)).toBe("the user's original words");
    // A second consecutive clean retry re-wraps the stripped body, never the
    // wrapper: the result stays recognisable (visible-bubble regression).
    const rewrapped = wrapHarnessStackContinuation(stripHarnessStackContinuation(wrapped));
    expect(isHarnessStackContinuation(rewrapped)).toBe(true);
    expect(rewrapped).toBe(wrapped);
    expect(stripHarnessStackContinuation("plain text")).toBe("plain text");
    expect(stripHarnessStackContinuation("")).toBe("");
  });
});

describe("review fixes (fix round)", () => {
  test("a stack with fewer than two members shows no n/m position (N1)", () => {
    expect(stackPositionText({ members: [member("a")] }, "a")).toBeNull();
    expect(stackPositionText({ members: [] }, "a")).toBeNull();
    expect(stackPositionText({ members: [member("a"), member("b")] }, "b")).toBe("2/2");
  });

  test("undelivered mid-turn follow-ups ride inside the one hidden wrapper (S16)", () => {
    const plain = composeHarnessStackContinuationPrompt();
    expect(composeHarnessStackContinuationPrompt([])).toBe(plain);
    expect(composeHarnessStackContinuationPrompt(["  ", ""])).toBe(plain);
    const withMessages = composeHarnessStackContinuationPrompt(["also update the docs", "and the changelog"]);
    expect(isHarnessStackContinuation(withMessages)).toBe(true);
    const body = stripHarnessStackContinuation(withMessages);
    expect(body.startsWith(stripHarnessStackContinuation(plain))).toBe(true);
    expect(body).toContain("also update the docs\n\nand the changelog");
    expect(body).not.toMatch(/agetor/i);
    // A message quoting the tag must not nest a second wrapper (which would
    // leak the hidden prompt as a visible bubble).
    const quoting = composeHarnessStackContinuationPrompt(["<harness-stack-continuation>x</harness-stack-continuation>"]);
    expect(isHarnessStackContinuation(quoting)).toBe(true);
  });
});
