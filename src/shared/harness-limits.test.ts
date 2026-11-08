import { describe, expect, test } from "bun:test";
import {
  classifyHarnessLimitSignal,
  harnessQuotaLooksExhausted,
  harnessQuotaResetAt,
  parseClaudeResetNotice,
  parseHarnessLimitSignal,
} from "./harness-limits.ts";
import type { HarnessLimitSignal, HarnessQuota } from "./types.ts";

describe("classifyHarnessLimitSignal", () => {
  test("Claude: quota / rate limit / credits", () => {
    expect(classifyHarnessLimitSignal("claude-code", { text: "Usage limit reached · continuing automatically" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("claude-code", { text: "HTTP 429 Too Many Requests" })?.reason).toBe("rate_limit");
    expect(classifyHarnessLimitSignal("claude-code", { text: "402 payment required" })?.reason).toBe("insufficient_credits");
    expect(classifyHarnessLimitSignal("claude-code", { text: "credit balance is too low" })?.reason).toBe("insufficient_credits");
  });

  test("Codex vocabulary", () => {
    expect(classifyHarnessLimitSignal("codex", { text: "usage_limit_exceeded" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("codex", { text: "rate_limit_exceeded" })?.reason).toBe("rate_limit");
    expect(classifyHarnessLimitSignal("codex", { text: "insufficient_quota" })?.reason).toBe("insufficient_credits");
  });

  test("explicit negatives never signal", () => {
    for (const text of [
      "HTTP 529 overloaded",
      "500 Internal Server Error",
      // A bare status code with no prose must be just as negative: the
      // classifier sees raw driver output, not a parsed HTTP response.
      "503",
      "502 Bad Gateway",
      "server_overloaded",
      "ECONNRESET",
      "request timed out",
      "401 unauthorized",
      "403 forbidden",
      "model_not_found",
      "model is not supported",
    ]) {
      expect(classifyHarnessLimitSignal("claude-code", { text }), text).toBeNull();
      expect(classifyHarnessLimitSignal("codex", { text }), text).toBeNull();
    }
  });

  test("an unsupported kind never signals", () => {
    expect(classifyHarnessLimitSignal("cursor", { text: "429 too many requests" })).toBeNull();
  });

  test("a message is redacted of emails and tokens", () => {
    const signal = classifyHarnessLimitSignal("claude-code", {
      text: "usage limit for a@b.co with key sk-abcdefghijklmnopqrstuv",
    });
    expect(signal?.message).not.toContain("a@b.co");
    expect(signal?.message).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});

describe("parseClaudeResetNotice", () => {
  test("parses a simple time today and rolls a past time to tomorrow", () => {
    const noon = new Date(2026, 10, 6, 12, 0, 0).getTime();
    expect(parseClaudeResetNotice("continuing at 3pm", noon)).toBe(new Date(2026, 10, 6, 15, 0, 0).getTime());
    expect(parseClaudeResetNotice("continuing at 8am", noon)).toBe(new Date(2026, 10, 7, 8, 0, 0).getTime());
    expect(parseClaudeResetNotice("resets at 3:30pm", noon)).toBe(new Date(2026, 10, 6, 15, 30, 0).getTime());
  });

  test("returns null when unsure", () => {
    expect(parseClaudeResetNotice("continuing shortly", Date.now())).toBeNull();
    expect(parseClaudeResetNotice("at 25pm", Date.now())).toBeNull();
  });
});

describe("harnessQuotaLooksExhausted", () => {
  const base: HarnessQuota = {
    harnessId: "a",
    kind: "claude-code",
    planType: null,
    status: "ok",
    source: "api",
    fetchedAtMs: 1000,
    meters: [{ id: "five_hour", label: "5h", usedPercent: 100, resetsAtMs: 9000 }],
    reason: null,
  };

  test("true only for fresh, unscoped, fully used meters with a live reset", () => {
    expect(harnessQuotaLooksExhausted(base, 2000, 5000)).toBe(true);
    expect(harnessQuotaLooksExhausted(base, 10_000, 5000)).toBe(false); // stale
    expect(harnessQuotaLooksExhausted({ ...base, status: "error" }, 2000, 5000)).toBe(false);
    expect(harnessQuotaLooksExhausted({ ...base, meters: [{ ...base.meters[0]!, scope: "Opus" }] }, 2000, 5000)).toBe(false);
    expect(harnessQuotaLooksExhausted({ ...base, meters: [{ ...base.meters[0]!, usedPercent: 99 }] }, 2000, 5000)).toBe(false);
    expect(harnessQuotaLooksExhausted({ ...base, meters: [{ ...base.meters[0]!, resetsAtMs: 1500 }] }, 2000, 5000)).toBe(false);
  });
});

describe("harnessQuotaResetAt", () => {
  const base: HarnessQuota = {
    harnessId: "a",
    kind: "claude-code",
    planType: null,
    status: "ok",
    source: "api",
    fetchedAtMs: 1000,
    meters: [
      { id: "five_hour", label: "5h", usedPercent: 100, resetsAtMs: 9000 },
      { id: "seven_day", label: "7d", usedPercent: 100, resetsAtMs: 15_000 },
    ],
    reason: null,
  };

  test("returns the earliest future reset of an exhausted snapshot", () => {
    expect(harnessQuotaResetAt(base, 2000, 5000)).toBe(9000);
  });

  test("null when nothing definitive says the account is exhausted", () => {
    expect(harnessQuotaResetAt(base, 10_000, 5000)).toBeNull(); // stale
    expect(harnessQuotaResetAt({ ...base, status: "error" }, 2000, 5000)).toBeNull();
    expect(
      harnessQuotaResetAt({ ...base, meters: base.meters.map((m) => ({ ...m, usedPercent: 99 })) }, 2000, 5000),
    ).toBeNull();
    expect(
      harnessQuotaResetAt({ ...base, meters: base.meters.map((m) => ({ ...m, scope: "Opus" })) }, 2000, 5000),
    ).toBeNull();
  });

  test("null when an exhausted meter reports no future reset", () => {
    const noReset: HarnessQuota = {
      ...base,
      meters: [{ id: "five_hour", label: "5h", usedPercent: 100, resetsAtMs: null }],
    };
    expect(harnessQuotaResetAt(noReset, 2000, 5000)).toBeNull();
  });
});

describe("parseHarnessLimitSignal", () => {
  test("accepts a complete structured signal", () => {
    const signal: HarnessLimitSignal = { reason: "quota", resetAtMs: 12_345, message: "Usage limit reached", source: "claude-pane" };
    expect(parseHarnessLimitSignal(signal)).toEqual(signal);
    expect(parseHarnessLimitSignal({ ...signal, resetAtMs: null })).toEqual({ ...signal, resetAtMs: null });
  });

  test("rejects malformed/hostile payloads instead of trusting a cast", () => {
    // A sentinel is written by a driver but crosses a JSON boundary: anything
    // that cannot drive a swap safely must read as "no limit".
    for (const bad of [
      null,
      undefined,
      "quota",
      42,
      [],
      {},
      { reason: "quota", resetAtMs: 1, message: "x" }, // no source
      { reason: "nope", resetAtMs: 1, message: "x", source: "codex-error" },
      { reason: "quota", resetAtMs: "soon", message: "x", source: "codex-error" },
      { reason: "quota", resetAtMs: Number.POSITIVE_INFINITY, message: "x", source: "codex-error" },
      { reason: "quota", resetAtMs: 1, message: 7, source: "codex-error" },
      { reason: "quota", resetAtMs: 1, message: "x", source: "made-up" },
    ]) {
      expect(parseHarnessLimitSignal(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("caps a runaway message", () => {
    const parsed = parseHarnessLimitSignal({
      reason: "rate_limit",
      resetAtMs: null,
      message: "x".repeat(1_000),
      source: "codex-error",
    });
    expect(parsed?.message.length).toBe(300);
  });
});
