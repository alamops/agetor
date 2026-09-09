import { describe, expect, test } from "bun:test";
import {
  fxRecoveryNoticeText,
  fxRecoverySummaryLine,
  isFxRecoveryResumable,
  latestFxRecoveryByRun,
  parseFxRecoveryMeta,
  parseFxRecoveryPayload,
} from "./fx-recovery.ts";
import { FX_RECOVERY_STATUS_PREFIX, type FxRecoveryPayload } from "./types.ts";

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
