import { describe, expect, test } from "bun:test";
import {
  fxAutoResumeCountdownText,
  fxRecoveryNoticeText,
  fxRecoverySummaryLine,
  isFxRecoveryResumable,
  isTaskFxPaused,
  latestFxRecoveryByRun,
  parseFxAutoResumePrefs,
  parseFxRecoveryMeta,
  parseFxRecoveryPayload,
  parseTaskFxRecovery,
} from "./fx-recovery.ts";
import { FX_RECOVERY_STATUS_PREFIX, type FxRecoveryPayload, type TaskFxRecovery } from "./types.ts";

// --- parseFxRecoveryMeta -------------------------------------------------

test("parseFxRecoveryMeta: no `_meta` at all yields undefined", () => {
  expect(parseFxRecoveryMeta({})).toBeUndefined();
  expect(parseFxRecoveryMeta({ sessionUpdate: "session_info_update" })).toBeUndefined();
});

test("parseFxRecoveryMeta: `_meta.fx` present without the modelResponseRecovery key yields undefined", () => {
  expect(parseFxRecoveryMeta({ _meta: { fx: {} } })).toBeUndefined();
  expect(parseFxRecoveryMeta({ _meta: { fx: { provider: "gateway" } } })).toBeUndefined();
});

test("parseFxRecoveryMeta: `_meta.fx` itself not a plain object yields undefined", () => {
  expect(parseFxRecoveryMeta({ _meta: { fx: "nope" } })).toBeUndefined();
  expect(parseFxRecoveryMeta({ _meta: { fx: null } })).toBeUndefined();
});

test("parseFxRecoveryMeta: key present with a null value yields { state: \"cleared\" }", () => {
  expect(parseFxRecoveryMeta({ _meta: { fx: { modelResponseRecovery: null } } }))
    .toEqual({ state: "cleared" });
});

// Live wire shapes, docs/plans/fix-fx-harness-rate-limit.md §2.

test("parseFxRecoveryMeta: live 'active' payload with delaySeconds parses with every field preserved", () => {
  const update = {
    sessionUpdate: "session_info_update",
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "active",
          kind: "auto_retry",
          cause: "rate_limited",
          action: "retrying_request",
          attempt: 5,
          attemptLimit: 10,
          delaySeconds: 8,
          durable: true,
          message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request in 8s · attempt 5/10",
        },
      },
    },
  };
  expect(parseFxRecoveryMeta(update)).toEqual({
    state: "active",
    kind: "auto_retry",
    cause: "rate_limited",
    action: "retrying_request",
    attempt: 5,
    attemptLimit: 10,
    delaySeconds: 8,
    durable: true,
    message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request in 8s · attempt 5/10",
  });
});

test("parseFxRecoveryMeta: live 'active' payload without delaySeconds parses with every other field preserved and omits delaySeconds", () => {
  const update = {
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "active",
          kind: "auto_retry",
          cause: "rate_limited",
          action: "retrying_request",
          attempt: 5,
          attemptLimit: 10,
          durable: true,
          message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request · attempt 5/10",
        },
      },
    },
  };
  const parsed = parseFxRecoveryMeta(update);
  expect(parsed).toEqual({
    state: "active",
    kind: "auto_retry",
    cause: "rate_limited",
    action: "retrying_request",
    attempt: 5,
    attemptLimit: 10,
    durable: true,
    message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request · attempt 5/10",
  });
  expect(parsed && "delaySeconds" in parsed).toBe(false);
});

test("parseFxRecoveryMeta: live 'paused' payload with requiredAction parses with every field preserved", () => {
  const update = {
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "paused",
          kind: "terminal_provider_error",
          cause: "rate_limited",
          action: "paused",
          requiredAction: "continue_later",
          attempt: 10,
          attemptLimit: 10,
          durable: true,
          message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts",
        },
      },
    },
  };
  expect(parseFxRecoveryMeta(update)).toEqual({
    state: "paused",
    kind: "terminal_provider_error",
    cause: "rate_limited",
    action: "paused",
    requiredAction: "continue_later",
    attempt: 10,
    attemptLimit: 10,
    durable: true,
    message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts",
  });
});

test("parseFxRecoveryMeta: live 'recovered' payload parses with every field preserved", () => {
  const update = {
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "recovered",
          kind: "auto_recovered",
          attempt: 3,
          attemptLimit: 10,
          durable: true,
          message: "✓ recovered · succeeded on attempt 3/10",
        },
      },
    },
  };
  expect(parseFxRecoveryMeta(update)).toEqual({
    state: "recovered",
    kind: "auto_recovered",
    attempt: 3,
    attemptLimit: 10,
    durable: true,
    message: "✓ recovered · succeeded on attempt 3/10",
  });
});

test("parseFxRecoveryMeta: non-string message/tags are dropped individually, well-typed siblings survive", () => {
  const update = {
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "active",
          kind: 123,
          cause: {},
          action: [],
          requiredAction: true,
          message: 42,
          attempt: 3,
          attemptLimit: 10,
        },
      },
    },
  };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active", attempt: 3, attemptLimit: 10 });
});

test("parseFxRecoveryMeta: an empty-string message is dropped like a wrong-typed one", () => {
  const update = { _meta: { fx: { modelResponseRecovery: { state: "active", message: "" } } } };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

test("parseFxRecoveryMeta: non-finite numbers (NaN/Infinity/-Infinity) are dropped individually", () => {
  const update = {
    _meta: {
      fx: {
        modelResponseRecovery: {
          state: "active",
          attempt: Number.NaN,
          attemptLimit: Number.POSITIVE_INFINITY,
          delaySeconds: Number.NEGATIVE_INFINITY,
        },
      },
    },
  };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

test("parseFxRecoveryMeta: a non-boolean durable is dropped", () => {
  const update = { _meta: { fx: { modelResponseRecovery: { state: "active", durable: "true" } } } };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

test("parseFxRecoveryMeta: an unknown state string falls back to \"active\"", () => {
  const update = { _meta: { fx: { modelResponseRecovery: { state: "some_future_state" } } } };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

test("parseFxRecoveryMeta: state \"cleared\" as an object-string (not the null shorthand) also falls back to \"active\" — only WIRE_OBJECT_STATES (active/paused/recovered) are accepted from the object form", () => {
  const update = { _meta: { fx: { modelResponseRecovery: { state: "cleared" } } } };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

test("parseFxRecoveryMeta: a non-object, non-null modelResponseRecovery value yields undefined", () => {
  expect(parseFxRecoveryMeta({ _meta: { fx: { modelResponseRecovery: "oops" } } })).toBeUndefined();
  expect(parseFxRecoveryMeta({ _meta: { fx: { modelResponseRecovery: 42 } } })).toBeUndefined();
  expect(parseFxRecoveryMeta({ _meta: { fx: { modelResponseRecovery: [] } } })).toBeUndefined();
  expect(parseFxRecoveryMeta({ _meta: { fx: { modelResponseRecovery: true } } })).toBeUndefined();
});

test("parseFxRecoveryMeta: extra unknown keys on the raw object are ignored", () => {
  const update = { _meta: { fx: { modelResponseRecovery: { state: "active", someFutureField: "x", n: 1 } } } };
  expect(parseFxRecoveryMeta(update)).toEqual({ state: "active" });
});

// --- parseFxRecoveryPayload ----------------------------------------------

test("parseFxRecoveryPayload: round-trips JSON.stringify(payload)", () => {
  const payload: FxRecoveryPayload = {
    state: "active",
    kind: "auto_retry",
    cause: "rate_limited",
    action: "retrying_request",
    attempt: 5,
    attemptLimit: 10,
    delaySeconds: 8,
    durable: true,
    message: "⚠ Rate limited · HTTP 429 · … · retrying request in 8s · attempt 5/10",
  };
  expect(parseFxRecoveryPayload(JSON.stringify(payload))).toEqual(payload);
});

test("parseFxRecoveryPayload: garbage JSON yields null", () => {
  expect(parseFxRecoveryPayload("{not valid json")).toBeNull();
  expect(parseFxRecoveryPayload("")).toBeNull();
  expect(parseFxRecoveryPayload("undefined")).toBeNull();
});

test("parseFxRecoveryPayload: a JSON array or primitive yields null", () => {
  expect(parseFxRecoveryPayload("[1,2,3]")).toBeNull();
  expect(parseFxRecoveryPayload("42")).toBeNull();
  expect(parseFxRecoveryPayload('"hello"')).toBeNull();
  expect(parseFxRecoveryPayload("null")).toBeNull();
  expect(parseFxRecoveryPayload("true")).toBeNull();
});

test("parseFxRecoveryPayload: a missing state field yields null", () => {
  expect(parseFxRecoveryPayload('{"kind":"auto_retry","attempt":1}')).toBeNull();
});

test("parseFxRecoveryPayload: an invalid state string yields null", () => {
  expect(parseFxRecoveryPayload('{"state":"bogus"}')).toBeNull();
});

test('parseFxRecoveryPayload: {"state":"cleared"} parses to the cleared payload', () => {
  expect(parseFxRecoveryPayload('{"state":"cleared"}')).toEqual({ state: "cleared" });
});

// --- fxRecoveryNoticeText -------------------------------------------------

test("fxRecoveryNoticeText: p.message wins verbatim over any composed form", () => {
  const p: FxRecoveryPayload = {
    state: "active",
    cause: "rate_limited",
    action: "retrying_request",
    attempt: 3,
    attemptLimit: 10,
    message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: custom gateway text · retrying request in 8s · attempt 3/10",
  };
  expect(fxRecoveryNoticeText(p)).toBe(
    "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: custom gateway text · retrying request in 8s · attempt 3/10",
  );
});

test("fxRecoveryNoticeText: composed fallback for active with cause/action/attempt, no message", () => {
  const p: FxRecoveryPayload = { state: "active", cause: "rate_limited", action: "retrying_request", attempt: 3, attemptLimit: 10 };
  expect(fxRecoveryNoticeText(p)).toBe("⚠ Rate limited · retrying request · attempt 3/10");
});

test("fxRecoveryNoticeText: unknown cause/action tags render verbatim rather than being dropped", () => {
  const p: FxRecoveryPayload = { state: "active", cause: "widget_jam", action: "spinning_up" };
  expect(fxRecoveryNoticeText(p)).toBe("⚠ widget_jam · spinning_up");
});

test("fxRecoveryNoticeText: missing attempt/attemptLimit omits the attempt segment entirely", () => {
  const p: FxRecoveryPayload = { state: "active", cause: "rate_limited", action: "retrying_request" };
  expect(fxRecoveryNoticeText(p)).toBe("⚠ Rate limited · retrying request");
});

test("fxRecoveryNoticeText: only one of attempt/attemptLimit known still omits the attempt segment", () => {
  const p: FxRecoveryPayload = { state: "active", cause: "rate_limited", attempt: 3 };
  expect(fxRecoveryNoticeText(p)).toBe("⚠ Rate limited");
});

test("fxRecoveryNoticeText: nothing known at all falls back to the generic notice", () => {
  expect(fxRecoveryNoticeText({ state: "active" })).toBe("⚠ Recovering model response");
});

test("fxRecoveryNoticeText: recovered without message composes \"succeeded on attempt N/M\"", () => {
  expect(fxRecoveryNoticeText({ state: "recovered", attempt: 3, attemptLimit: 10 }))
    .toBe("✓ recovered · succeeded on attempt 3/10");
});

test("fxRecoveryNoticeText: recovered without attempt numbers falls back to bare \"recovered\"", () => {
  expect(fxRecoveryNoticeText({ state: "recovered" })).toBe("✓ recovered");
});

test("fxRecoveryNoticeText: cleared always renders empty, even if a message is somehow present", () => {
  expect(fxRecoveryNoticeText({ state: "cleared" })).toBe("");
  expect(fxRecoveryNoticeText({ state: "cleared", message: "should never show" })).toBe("");
});

// --- fxRecoverySummaryLine -------------------------------------------------

test("fxRecoverySummaryLine: paused appends the fixed resume-or-message call to action", () => {
  const p: FxRecoveryPayload = {
    state: "paused",
    message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts",
  };
  expect(fxRecoverySummaryLine(p)).toBe(
    "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts — resume once the limit clears, or send a new message.",
  );
});

test("fxRecoverySummaryLine: paused with a composed (message-less) notice still appends the call to action", () => {
  const p: FxRecoveryPayload = { state: "paused", cause: "rate_limited", action: "paused", attempt: 10, attemptLimit: 10 };
  expect(fxRecoverySummaryLine(p)).toBe(
    "⚠ Rate limited · recovery paused · attempt 10/10 — resume once the limit clears, or send a new message.",
  );
});

test("fxRecoverySummaryLine: recovered is the notice text verbatim, no suffix", () => {
  const p: FxRecoveryPayload = { state: "recovered", message: "✓ recovered · succeeded on attempt 3/10" };
  expect(fxRecoverySummaryLine(p)).toBe("✓ recovered · succeeded on attempt 3/10");
});

test("fxRecoverySummaryLine: active and cleared yield null (nothing final to say yet / nothing happened)", () => {
  expect(fxRecoverySummaryLine({ state: "active", message: "⚠ still retrying" })).toBeNull();
  expect(fxRecoverySummaryLine({ state: "cleared" })).toBeNull();
});

// --- isFxRecoveryResumable -------------------------------------------------

test("isFxRecoveryResumable: paused without a requiredAction defaults to resumable (continue_later)", () => {
  expect(isFxRecoveryResumable({ state: "paused" })).toBe(true);
});

test("isFxRecoveryResumable: paused with requiredAction \"continue_later\" is resumable", () => {
  expect(isFxRecoveryResumable({ state: "paused", requiredAction: "continue_later" })).toBe(true);
});

test("isFxRecoveryResumable: paused with requiredAction \"inspect_uncertain_tool\" is not resumable", () => {
  expect(isFxRecoveryResumable({ state: "paused", requiredAction: "inspect_uncertain_tool" })).toBe(false);
});

test("isFxRecoveryResumable: paused with requiredAction \"change_request\" is not resumable", () => {
  expect(isFxRecoveryResumable({ state: "paused", requiredAction: "change_request" })).toBe(false);
});

test("isFxRecoveryResumable: active/recovered/cleared are never resumable regardless of requiredAction", () => {
  expect(isFxRecoveryResumable({ state: "active" })).toBe(false);
  expect(isFxRecoveryResumable({ state: "recovered" })).toBe(false);
  expect(isFxRecoveryResumable({ state: "cleared" })).toBe(false);
  expect(isFxRecoveryResumable({ state: "active", requiredAction: "continue_later" })).toBe(false);
});

test("isFxRecoveryResumable: undefined/null payload is never resumable", () => {
  expect(isFxRecoveryResumable(undefined)).toBe(false);
  expect(isFxRecoveryResumable(null)).toBe(false);
});

// --- latestFxRecoveryByRun --------------------------------------------------

function sentinelRow(runId: string, payload: FxRecoveryPayload): { runId: string; stream: string; data: string } {
  return { runId, stream: "status", data: FX_RECOVERY_STATUS_PREFIX + JSON.stringify(payload) };
}

test("latestFxRecoveryByRun: the last sentinel per run wins across interleaved runs", () => {
  const events = [
    sentinelRow("r1", { state: "active", attempt: 1, attemptLimit: 3 }),
    sentinelRow("r2", { state: "active", attempt: 1, attemptLimit: 2 }),
    sentinelRow("r1", { state: "active", attempt: 2, attemptLimit: 3 }),
    sentinelRow("r2", { state: "paused", attempt: 2, attemptLimit: 2 }),
    sentinelRow("r1", { state: "paused", attempt: 3, attemptLimit: 3 }),
  ];
  const result = latestFxRecoveryByRun(events);
  expect(result.size).toBe(2);
  expect(result.get("r1")).toEqual({ state: "paused", attempt: 3, attemptLimit: 3 });
  expect(result.get("r2")).toEqual({ state: "paused", attempt: 2, attemptLimit: 2 });
});

test("latestFxRecoveryByRun: non-status streams are ignored even if the data carries the prefix", () => {
  const events = [
    { runId: "r1", stream: "stdout", data: FX_RECOVERY_STATUS_PREFIX + JSON.stringify({ state: "active" }) },
    { runId: "r1", stream: "assistant", data: FX_RECOVERY_STATUS_PREFIX + JSON.stringify({ state: "paused" }) },
  ];
  expect(latestFxRecoveryByRun(events).size).toBe(0);
});

test("latestFxRecoveryByRun: status rows without the fx-recovery prefix are ignored", () => {
  const events = [
    { runId: "r1", stream: "status", data: "fx-provider: gateway" },
    { runId: "r1", stream: "status", data: "turn complete" },
  ];
  expect(latestFxRecoveryByRun(events).size).toBe(0);
});

test("latestFxRecoveryByRun: an unparsable sentinel row is skipped without clearing an earlier value for that run", () => {
  const events = [
    sentinelRow("r1", { state: "active", attempt: 1, attemptLimit: 3 }),
    { runId: "r1", stream: "status", data: `${FX_RECOVERY_STATUS_PREFIX}{not valid json` },
  ];
  const result = latestFxRecoveryByRun(events);
  expect(result.get("r1")).toEqual({ state: "active", attempt: 1, attemptLimit: 3 });
});

test("latestFxRecoveryByRun: empty input yields an empty map", () => {
  const result = latestFxRecoveryByRun([]);
  expect(result.size).toBe(0);
});

describe("replayed marker (agetor's own stamp, never a wire field)", () => {
  test("parseFxRecoveryPayload keeps a literal `replayed: true` and drops false/non-boolean", () => {
    const live = { state: "active", cause: "rate_limited", attempt: 3, attemptLimit: 10 } as const;
    expect(parseFxRecoveryPayload(JSON.stringify({ ...live, replayed: true }))).toEqual({ ...live, replayed: true });
    expect(parseFxRecoveryPayload(JSON.stringify({ ...live, replayed: false }))).toEqual(live);
    expect(parseFxRecoveryPayload(JSON.stringify({ ...live, replayed: "yes" }))).toEqual(live);
    expect(parseFxRecoveryPayload(JSON.stringify(live))).not.toHaveProperty("replayed");
  });

  test("parseFxRecoveryMeta ignores a `replayed` key on fx's wire object", () => {
    const meta = parseFxRecoveryMeta({
      sessionUpdate: "session_info_update",
      _meta: { fx: { modelResponseRecovery: { state: "paused", cause: "rate_limited", replayed: true } } },
    });
    expect(meta).toEqual({ state: "paused", cause: "rate_limited" });
  });

  test("latestFxRecoveryByRun and isFxRecoveryResumable still honor a replayed paused sentinel", () => {
    const paused: FxRecoveryPayload = { state: "paused", cause: "rate_limited", requiredAction: "continue_later", replayed: true };
    const latest = latestFxRecoveryByRun([
      { runId: "r2", stream: "status", data: FX_RECOVERY_STATUS_PREFIX + JSON.stringify(paused) },
    ]);
    expect(latest.get("r2")).toEqual(paused);
    expect(isFxRecoveryResumable(latest.get("r2"))).toBe(true);
  });
});

// --- parseTaskFxRecovery ----------------------------------------------------

describe("parseTaskFxRecovery", () => {
  test("null/undefined/empty string input yields null", () => {
    expect(parseTaskFxRecovery(null)).toBeNull();
    expect(parseTaskFxRecovery(undefined)).toBeNull();
    expect(parseTaskFxRecovery("")).toBeNull();
  });

  test("garbage JSON yields null", () => {
    expect(parseTaskFxRecovery("{not valid json")).toBeNull();
    expect(parseTaskFxRecovery("undefined")).toBeNull();
  });

  test("a JSON array or primitive (non-plain-object) yields null", () => {
    expect(parseTaskFxRecovery("[1,2,3]")).toBeNull();
    expect(parseTaskFxRecovery("42")).toBeNull();
    expect(parseTaskFxRecovery('"hello"')).toBeNull();
    expect(parseTaskFxRecovery("null")).toBeNull();
    expect(parseTaskFxRecovery("true")).toBeNull();
  });

  test("a state other than \"paused\" (or a missing state) yields null", () => {
    expect(parseTaskFxRecovery(JSON.stringify({ state: "active", runId: "r1", pausedAt: 1 }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ state: "cleared", runId: "r1", pausedAt: 1 }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ runId: "r1", pausedAt: 1 }))).toBeNull();
  });

  test("a missing, empty, or non-string runId yields null", () => {
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", pausedAt: 1 }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", runId: "", pausedAt: 1 }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", runId: 42, pausedAt: 1 }))).toBeNull();
  });

  test("a missing or non-finite pausedAt yields null", () => {
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", runId: "r1" }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", runId: "r1", pausedAt: "soon" }))).toBeNull();
    expect(parseTaskFxRecovery(JSON.stringify({ state: "paused", runId: "r1", pausedAt: null }))).toBeNull();
  });

  test("full round-trip with an active auto-resume schedule and every descriptive field populated", () => {
    const full: TaskFxRecovery = {
      state: "paused",
      runId: "run-42",
      pausedAt: 1_700_000_000_000,
      cause: "rate_limited",
      attempt: 10,
      attemptLimit: 10,
      message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts",
      autoResume: { at: 1_700_000_120_000, attempt: 1, max: 3, delaySec: 120 },
      autoResumeCount: 1,
    };
    expect(parseTaskFxRecovery(JSON.stringify(full))).toEqual(full);
  });

  test("full round-trip with no pending timer and an autoResumeStopped reason set", () => {
    const stopped: TaskFxRecovery = {
      state: "paused",
      runId: "run-7",
      pausedAt: 5000,
      autoResume: null,
      autoResumeCount: 3,
      autoResumeStopped: "exhausted",
    };
    expect(parseTaskFxRecovery(JSON.stringify(stopped))).toEqual(stopped);
  });

  test("a partially-typed autoResume sub-object is dropped to null wholesale, not partially trusted", () => {
    const missingDelaySec = JSON.stringify({
      state: "paused",
      runId: "r1",
      pausedAt: 1,
      autoResume: { at: 100, attempt: 1, max: 3 }, // delaySec missing
    });
    expect(parseTaskFxRecovery(missingDelaySec)?.autoResume).toBeNull();

    const wrongFieldType = JSON.stringify({
      state: "paused",
      runId: "r1",
      pausedAt: 1,
      autoResume: { at: "soon", attempt: 1, max: 3, delaySec: 120 },
    });
    expect(parseTaskFxRecovery(wrongFieldType)?.autoResume).toBeNull();

    const notAnObject = JSON.stringify({ state: "paused", runId: "r1", pausedAt: 1, autoResume: "none" });
    expect(parseTaskFxRecovery(notAnObject)?.autoResume).toBeNull();

    const missingEntirely = JSON.stringify({ state: "paused", runId: "r1", pausedAt: 1 });
    expect(parseTaskFxRecovery(missingEntirely)?.autoResume).toBeNull();
  });

  test("autoResumeCount defaults to 0 when missing, negative, non-integer, or wrong-typed — a valid non-negative integer is kept", () => {
    const base = { state: "paused", runId: "r1", pausedAt: 1 };
    expect(parseTaskFxRecovery(JSON.stringify(base))?.autoResumeCount).toBe(0); // missing
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: -1 }))?.autoResumeCount).toBe(0); // negative
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: 1.5 }))?.autoResumeCount).toBe(0); // non-integer
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: "2" }))?.autoResumeCount).toBe(0); // wrong type
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: Number.NaN }))?.autoResumeCount).toBe(0); // non-finite
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: 2 }))?.autoResumeCount).toBe(2); // valid, sanity check
    expect(parseTaskFxRecovery(JSON.stringify({ ...base, autoResumeCount: 0 }))?.autoResumeCount).toBe(0); // valid zero
  });

  test("an invalid autoResumeStopped reason is dropped, leaving the property entirely absent", () => {
    const base = { state: "paused", runId: "r1", pausedAt: 1, autoResumeStopped: "bogus" };
    const result = parseTaskFxRecovery(JSON.stringify(base));
    expect(result).not.toBeNull();
    expect(result?.autoResumeStopped).toBeUndefined();
    expect(result && "autoResumeStopped" in result).toBe(false);
  });

  test("each of the four valid autoResumeStopped reasons is kept verbatim", () => {
    for (const reason of ["exhausted", "cancelled", "disabled", "failed"] as const) {
      const json = JSON.stringify({ state: "paused", runId: "r1", pausedAt: 1, autoResumeStopped: reason });
      expect(parseTaskFxRecovery(json)?.autoResumeStopped).toBe(reason);
    }
  });

  test("full round-trip with autoResumeStopped: \"failed\" — a fired auto-resume that could not start", () => {
    const failed: TaskFxRecovery = {
      state: "paused",
      runId: "run-9",
      pausedAt: 6000,
      autoResume: null,
      autoResumeCount: 2,
      autoResumeStopped: "failed",
    };
    expect(parseTaskFxRecovery(JSON.stringify(failed))).toEqual(failed);
  });
});

// --- parseFxAutoResumePrefs --------------------------------------------------

describe("parseFxAutoResumePrefs", () => {
  test("missing preferences default to enabled with the 120 s default delay", () => {
    expect(parseFxAutoResumePrefs({})).toEqual({ enabled: true, delaySec: 120 });
  });

  test('"off" (and case/whitespace variants) disables auto-resume', () => {
    expect(parseFxAutoResumePrefs({ fxAutoResume: "off" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "OFF " }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "Off" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "  off  " }).enabled).toBe(false);
  });

  test('each of "false"/"0"/"no" (trimmed + lower-cased) also disables auto-resume', () => {
    expect(parseFxAutoResumePrefs({ fxAutoResume: "false" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "False" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "0" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "no" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "No" }).enabled).toBe(false);
    expect(parseFxAutoResumePrefs({ fxAutoResume: " No " }).enabled).toBe(false);
  });

  test('"on" and any non-disabling value read as enabled — including "1"/"true"/"yes"', () => {
    expect(parseFxAutoResumePrefs({ fxAutoResume: "on" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "garbage" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "offline" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "1" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "true" }).enabled).toBe(true);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "yes" }).enabled).toBe(true);
  });

  test("delay clamps to [10, 3600]", () => {
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "5" }).delaySec).toBe(10);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "0" }).delaySec).toBe(10);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "-5" }).delaySec).toBe(10);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "3600" }).delaySec).toBe(3600);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "99999" }).delaySec).toBe(3600);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "500" }).delaySec).toBe(500);
  });

  test('"abc"/""/"12.7" fall back to the implemented rule: unparsable strings default to 120, but Number.parseInt floors a decimal string rather than rejecting it', () => {
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "abc" }).delaySec).toBe(120);
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "" }).delaySec).toBe(120);
    // Number.parseInt("12.7", 10) === 12 (parses the leading digit run and stops
    // at the decimal point) — a *finite* result, so it is clamped like any
    // other parsed value rather than falling back to the 120 s default.
    expect(parseFxAutoResumePrefs({ fxAutoResumeDelaySec: "12.7" }).delaySec).toBe(12);
  });

  test("missing delay key falls back to the 120 s default independent of the enabled flag", () => {
    expect(parseFxAutoResumePrefs({ fxAutoResume: "off" }).delaySec).toBe(120);
    expect(parseFxAutoResumePrefs({ fxAutoResume: "on" }).delaySec).toBe(120);
  });
});

// --- fxAutoResumeCountdownText -----------------------------------------------

describe("fxAutoResumeCountdownText", () => {
  test('118 s remaining renders "1:58"', () => {
    expect(fxAutoResumeCountdownText(118_000, 0)).toBe("1:58");
  });

  test('7 s remaining renders zero-padded seconds "0:07"', () => {
    expect(fxAutoResumeCountdownText(7_000, 0)).toBe("0:07");
  });

  test('at === now renders "now"', () => {
    expect(fxAutoResumeCountdownText(1000, 1000)).toBe("now");
  });

  test('at already in the past (negative remaining) renders "now", never a negative countdown', () => {
    expect(fxAutoResumeCountdownText(1000, 5000)).toBe("now");
    expect(fxAutoResumeCountdownText(0, 999_999)).toBe("now");
  });

  test("999 ms remaining rounds UP to 1 s rather than down to \"now\"", () => {
    expect(fxAutoResumeCountdownText(999, 0)).toBe("0:01");
  });

  test("exactly 1000 ms remaining also renders \"0:01\" (ceil, not floor)", () => {
    expect(fxAutoResumeCountdownText(1000, 0)).toBe("0:01");
  });

  test("a full minute renders \"1:00\"", () => {
    expect(fxAutoResumeCountdownText(60_000, 0)).toBe("1:00");
  });

  test("minutes are not zero-padded but seconds always are", () => {
    expect(fxAutoResumeCountdownText(200_000, 0)).toBe("3:20");
  });
});

// --- isTaskFxPaused ----------------------------------------------------------

describe("isTaskFxPaused", () => {
  const pausedRecovery: TaskFxRecovery = {
    state: "paused",
    runId: "r1",
    pausedAt: 1,
    autoResume: null,
    autoResumeCount: 0,
  };

  test("paused + a non-running column (e.g. ready) is true", () => {
    expect(isTaskFxPaused({ fxRecovery: pausedRecovery, column: "ready" })).toBe(true);
  });

  test("paused + column running is false — a just-started resume must not still show the badge", () => {
    expect(isTaskFxPaused({ fxRecovery: pausedRecovery, column: "running" })).toBe(false);
  });

  test("no fxRecovery (null, undefined, or absent) is always false", () => {
    expect(isTaskFxPaused({ fxRecovery: null, column: "ready" })).toBe(false);
    expect(isTaskFxPaused({ fxRecovery: undefined, column: "ready" })).toBe(false);
    expect(isTaskFxPaused({ column: "ready" })).toBe(false);
  });

  test("paused is true across every non-running column value", () => {
    for (const column of ["backlog", "ready", "review", "blocked", "done"]) {
      expect(isTaskFxPaused({ fxRecovery: pausedRecovery, column })).toBe(true);
    }
  });
});
