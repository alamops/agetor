import { test, expect } from "bun:test";
import {
  AGENT_OPTIONS,
  CODE_PLAN_MODE,
  FX_USAGE_STATUS_PREFIX,
  PERMISSION_MODE_STATUS_PREFIX,
  isInternalStatusSentinel,
  type AgentKind,
} from "./types.ts";

/* ── isInternalStatusSentinel ────────────────────────────────────────────── */

test("isInternalStatusSentinel: true for a permission-mode status chunk", () => {
  expect(isInternalStatusSentinel(`${PERMISSION_MODE_STATUS_PREFIX}plan`)).toBe(true);
});

test("isInternalStatusSentinel: true for an fx-usage status chunk", () => {
  expect(isInternalStatusSentinel(`${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`)).toBe(true);
});

test("isInternalStatusSentinel: false for plain transcript text", () => {
  expect(isInternalStatusSentinel("started — worktree — agent=fx, model=zai/glm-5.2-fast, mode=auto")).toBe(false);
});

test("isInternalStatusSentinel: false for an empty string", () => {
  expect(isInternalStatusSentinel("")).toBe(false);
});

test("isInternalStatusSentinel: false when a sentinel appears as a substring but not as the prefix", () => {
  // The predicate is startsWith-based — a sentinel string embedded mid-line
  // (e.g. quoted inside a larger message) must NOT be suppressed, or a real
  // assistant message that happens to mention the sentinel text would
  // silently vanish from the transcript.
  expect(isInternalStatusSentinel(`note: saw "${PERMISSION_MODE_STATUS_PREFIX}plan" in the log`)).toBe(false);
  expect(isInternalStatusSentinel(`re: ${FX_USAGE_STATUS_PREFIX}{"used":1}`)).toBe(false);
});

/* ── CODE_PLAN_MODE / AGENT_OPTIONS invariants ───────────────────────────── */

const KINDS = Object.keys(AGENT_OPTIONS) as AgentKind[];

test("every AgentKind has both an AGENT_OPTIONS entry and a CODE_PLAN_MODE entry", () => {
  // Guards against either record silently falling out of sync when a new
  // AgentKind is added to the union without updating both.
  expect(KINDS.length).toBeGreaterThan(0);
  for (const kind of KINDS) {
    expect(CODE_PLAN_MODE[kind]).toBeDefined();
  }
});

test("for every AgentKind, CODE_PLAN_MODE[kind].code equals AGENT_OPTIONS[kind].modes[0].id", () => {
  // The Code/Plan pill's "Code" side always resolves to the agent's
  // most-permissive first-listed mode — see CODE_PLAN_MODE's own doc
  // comment. A mismatch here would mean clicking "Code" doesn't actually
  // select the mode the picker shows as the top/default option.
  for (const kind of KINDS) {
    const modesFirstId = AGENT_OPTIONS[kind].modes[0]?.id;
    expect(modesFirstId).toBeDefined();
    expect(CODE_PLAN_MODE[kind].code).toBe(modesFirstId as string);
  }
});

test("for every AgentKind, CODE_PLAN_MODE[kind].plan is a mode id that kind actually offers", () => {
  for (const kind of KINDS) {
    const validIds = AGENT_OPTIONS[kind].modes.map((m) => m.id);
    expect(validIds).toContain(CODE_PLAN_MODE[kind].plan);
  }
});

test("every AGENT_OPTIONS model entry (all kinds) carries a non-empty hint", () => {
  // As of this writing every kind's model list — including fx's — populates
  // `hint` on every entry (verified directly against AGENT_OPTIONS below), so
  // the assertion is not narrowed to fx alone. If a future kind's model list
  // legitimately ships hint-less entries, narrow this loop to the kinds that
  // still guarantee hints rather than deleting the invariant outright.
  for (const kind of KINDS) {
    const models = AGENT_OPTIONS[kind].models;
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.hint).toBe("string");
      expect((model.hint ?? "").trim().length).toBeGreaterThan(0);
    }
  }
});
