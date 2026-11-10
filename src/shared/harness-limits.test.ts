import { describe, expect, test } from "bun:test";
import {
  classifyHarnessLimitSignal,
  harnessLimitTextIsNegative,
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

  test("Codex 0.166 prose (strings of the shipped binary) — contract C2", () => {
    for (const text of [
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:00 PM.",
      "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 10th, 2026 3:00 PM.",
      "You've hit your usage limit. To get more access now, send a request to your admin or try again later.",
      "You've hit your usage limit for gpt-5.5-codex. Switch to another model now, or try again at 4:15 PM.",
      "You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits",
    ]) {
      const signal = classifyHarnessLimitSignal("codex", { text });
      expect(signal?.reason, text).toBe("quota");
      expect(signal?.source).toBe("codex-error");
    }
    expect(classifyHarnessLimitSignal("codex", {
      text: "Quota exceeded. Check your plan and billing details.",
    })?.reason).toBe("insufficient_credits");
  });

  test("Codex 'try again at <time>' is parsed as the reset", () => {
    const signal = classifyHarnessLimitSignal("codex", {
      text: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:00 PM.",
    });
    expect(signal?.resetAtMs).not.toBeNull();
    const at = new Date(signal!.resetAtMs!);
    expect(at.getHours()).toBe(15);
    expect(at.getMinutes()).toBe(0);
    expect(signal!.resetAtMs! - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // No time → no reset (the caller uses its default backoff).
    expect(classifyHarnessLimitSignal("codex", {
      text: "You've hit your usage limit. To get more access now, send a request to your admin",
    })?.resetAtMs).toBeNull();
  });

  test("a structured code decides; a non-limit code is a definitive negative", () => {
    expect(classifyHarnessLimitSignal("codex", { code: "usage_limit_exceeded", text: "turn failed" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("codex", { code: "usageLimitExceeded" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("codex", { code: { usage_limit_exceeded: {} } })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("codex", { code: "workspace_member_credits_depleted" })?.reason).toBe("insufficient_credits");
    expect(classifyHarnessLimitSignal("codex", { code: "rate_limit_reached" })?.reason).toBe("rate_limit");
    expect(classifyHarnessLimitSignal("codex", {
      code: "server_overloaded",
      text: "You've hit your usage limit.",
    })).toBeNull();
    expect(classifyHarnessLimitSignal("codex", { code: { model_not_found: {} }, text: "429" })).toBeNull();
    // An unknown code falls back to the prose.
    expect(classifyHarnessLimitSignal("codex", {
      code: { response_too_many_failed_attempts: { http_status_code: 429 } },
      text: "exceeded retry limit, last status: 429 Too Many Requests",
    })?.reason).toBe("rate_limit");
    expect(classifyHarnessLimitSignal("codex", { code: "something_new", text: "all good" })).toBeNull();
  });

  test("Claude 2.1.319 wordings", () => {
    expect(classifyHarnessLimitSignal("claude-code", { text: "You've hit your limit · resets 3pm" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("claude-code", { text: "Continuing automatically at 8am · Esc to cancel" })?.reason).toBe("quota");
    expect(classifyHarnessLimitSignal("claude-code", { text: "Usage limit reached again · continuing automatically at 8am · esc to cancel" })?.reason).toBe("quota");
    // "Continuing automatically" without the cancel hint is ordinary prose.
    expect(classifyHarnessLimitSignal("claude-code", { text: "Continuing automatically with the next file." })).toBeNull();
  });

  test("harnessLimitTextIsNegative names exactly the explicit negatives", () => {
    expect(harnessLimitTextIsNegative("503 Service Unavailable")).toBe(true);
    expect(harnessLimitTextIsNegative("server_overloaded")).toBe(true);
    expect(harnessLimitTextIsNegative("codex turn failed")).toBe(false);
    expect(harnessLimitTextIsNegative("")).toBe(false);
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
    // A date with no time, an impossible date, a dated reset already past.
    const noon = new Date(2026, 10, 8, 12, 0, 0).getTime();
    expect(parseClaudeResetNotice("resets Aug 8", noon)).toBeNull();
    expect(parseClaudeResetNotice("resets Feb 30, 3pm", noon)).toBeNull();
    expect(parseClaudeResetNotice("resets Nov 1, 9am", noon)).toBeNull();
    expect(parseClaudeResetNotice("try again at Nov 7th, 2026 3:00 PM", noon)).toBeNull();
  });

  // Sunday Nov 8 2026, noon local.
  const sundayNoon = new Date(2026, 10, 8, 12, 0, 0).getTime();
  const local = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
    new Date(year, month, day, hour, minute, 0, 0).getTime();

  test("a month/day resolves to that date, not today/tomorrow (S13)", () => {
    expect(parseClaudeResetNotice("Usage limit reached · continuing automatically at Nov 10, 3pm", sundayNoon)).toBe(local(10, 10, 15));
    expect(parseClaudeResetNotice("limit resets Nov 10 at 3pm", sundayNoon)).toBe(local(10, 10, 15));
    expect(parseClaudeResetNotice("resets 3pm on Nov 12", sundayNoon)).toBe(local(10, 12, 15));
    expect(parseClaudeResetNotice("resets Tue, Nov 10, 9:30am", sundayNoon)).toBe(local(10, 10, 9, 30));
    // Today's own date with a time still ahead is today.
    expect(parseClaudeResetNotice("resets Nov 8, 3pm", sundayNoon)).toBe(local(10, 8, 15));
  });

  test("Codex's dated 'try again at' wording (chrono '%b %-d<suffix>, %Y %-I:%M %p')", () => {
    expect(parseClaudeResetNotice("or try again at Nov 10th, 2026 3:00 PM.", sundayNoon)).toBe(local(10, 10, 15));
    expect(parseClaudeResetNotice("Try again at Nov 21st, 2026 9:05 AM.", sundayNoon)).toBe(local(10, 21, 9, 5));
    expect(parseClaudeResetNotice("or try again at 3:00 PM.", sundayNoon)).toBe(local(10, 8, 15));
  });

  test("a December date seen across New Year is next year's", () => {
    const dec30 = new Date(2026, 11, 30, 12, 0, 0).getTime();
    expect(parseClaudeResetNotice("resets Jan 2, 9am", dec30)).toBe(local(0, 2, 9, 0, 2027));
    // …but a reset implausibly far out is not believed.
    expect(parseClaudeResetNotice("resets Jan 2, 9am", sundayNoon)).toBeNull();
  });

  test("a weekday resolves to its next occurrence", () => {
    expect(parseClaudeResetNotice("resets Tuesday at 3pm", sundayNoon)).toBe(local(10, 10, 15));
    expect(parseClaudeResetNotice("resets Wed 8am", sundayNoon)).toBe(local(10, 11, 8));
    // Today's weekday: today when the time is ahead, a week out when passed.
    expect(parseClaudeResetNotice("resets Sunday 1pm", sundayNoon)).toBe(local(10, 8, 13));
    expect(parseClaudeResetNotice("resets Sun 11am", sundayNoon)).toBe(local(10, 15, 11));
  });

  test("other time spellings", () => {
    expect(parseClaudeResetNotice("resets 3 p.m.", sundayNoon)).toBe(local(10, 8, 15));
    expect(parseClaudeResetNotice("resets 15:00", sundayNoon)).toBe(local(10, 8, 15));
    expect(parseClaudeResetNotice("Usage limit reached · limit resets 3pm (America/New_York) · claude.ai/settings/usage", sundayNoon))
      .toBe(local(10, 8, 15));
  });

  test("a passed time rolls by a calendar day, keeping its wall-clock time across DST", () => {
    const originalTz = process.env.TZ;
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "America/New_York";
    try {
      // US DST ends Sun Nov 1 2026 at 2am: Nov 1 is a 25-hour day. From 8pm
      // on Oct 31, "at 8am" is Nov 1 8:00 local — the old `+24h` landed 7:00.
      const now = new Date(2026, 9, 31, 20, 0, 0).getTime();
      const at = parseClaudeResetNotice("continuing automatically at 8am", now)!;
      expect(new Date(at).getDate()).toBe(1);
      expect(new Date(at).getHours()).toBe(8);
      expect(at - now).toBe(13 * 60 * 60 * 1000);
      // Spring forward (Sun Mar 14 2027, a 23-hour day): 9pm Mar 13 → "at 8am".
      const spring = new Date(2027, 2, 13, 21, 0, 0).getTime();
      const springAt = parseClaudeResetNotice("resets 8am", spring)!;
      expect(new Date(springAt).getHours()).toBe(8);
      expect(springAt - spring).toBe(10 * 60 * 60 * 1000);
    } finally {
      // Re-point at the system zone before dropping the override, so the
      // rest of this process (bun test shares one) is back on local time.
      process.env.TZ = originalTz ?? systemZone;
      if (originalTz === undefined) delete process.env.TZ;
    }
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

  test("returns the latest reset among the exhausted blocking windows", () => {
    expect(harnessQuotaResetAt(base, 2000, 5000)).toBe(15_000);
  });

  test("any blocking window at 100% counts, even with other meters below it", () => {
    const partial: HarnessQuota = {
      ...base,
      meters: [
        { id: "five_hour", label: "5h", usedPercent: 100, resetsAtMs: 9000 },
        { id: "seven_day", label: "7d", usedPercent: 40, resetsAtMs: 15_000 },
        { id: "seven_day_routines", label: "Routines", usedPercent: 0, resetsAtMs: null },
      ],
    };
    expect(harnessQuotaLooksExhausted(partial, 2000, 5000)).toBe(true);
    expect(harnessQuotaResetAt(partial, 2000, 5000)).toBe(9000);
  });

  test("weekly_all at 100% counts as a blocking window", () => {
    const q: HarnessQuota = { ...base, meters: [{ id: "weekly_all", label: "Weekly", usedPercent: 100, resetsAtMs: 9000 }] };
    expect(harnessQuotaLooksExhausted(q, 2000, 5000)).toBe(true);
  });

  test("a credits meter at 100 does not block exhaustion", () => {
    const q: HarnessQuota = { ...base, meters: [...base.meters, { id: "credits", label: "Credits: 0", usedPercent: 100, resetsAtMs: null }] };
    expect(harnessQuotaLooksExhausted(q, 2000, 5000)).toBe(true);
  });

  test("a credits or extra-usage meter with headroom keeps the account usable", () => {
    const withCredits: HarnessQuota = {
      ...base,
      meters: [...base.meters, { id: "extra_usage", label: "Extra usage", usedPercent: 10, resetsAtMs: null }],
    };
    expect(harnessQuotaLooksExhausted(withCredits, 2000, 5000)).toBe(false);
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

describe("classifier inputs the fake drivers rely on (CR2)", () => {
  test("the fake drivers' real CLI prose classifies on its own, with no fallback", () => {
    expect(classifyHarnessLimitSignal("claude-code", {
      text: "Usage limit reached · continuing automatically when it resets",
    })?.reason).toBe("quota");
    const codex = classifyHarnessLimitSignal("codex", {
      text: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:00 PM.",
      now: new Date(2026, 10, 1, 9, 0, 0, 0).getTime(),
    });
    expect(codex?.reason).toBe("quota");
    expect(codex?.resetAtMs).toBe(new Date(2026, 10, 1, 15, 0, 0, 0).getTime());
  });

  test("`now` pins the instant a relative reset resolves against", () => {
    const text = "You've hit your usage limit. Try again at 3:00 PM.";
    const morning = new Date(2026, 10, 1, 9, 0, 0, 0).getTime();
    const evening = new Date(2026, 10, 1, 18, 0, 0, 0).getTime();
    expect(classifyHarnessLimitSignal("codex", { text, now: morning })?.resetAtMs)
      .toBe(new Date(2026, 10, 1, 15, 0, 0, 0).getTime());
    expect(classifyHarnessLimitSignal("codex", { text, now: evening })?.resetAtMs)
      .toBe(new Date(2026, 10, 2, 15, 0, 0, 0).getTime());
  });
});

describe("fix-round limit parsing", () => {
  test("a just-passed time-only reset is null, an older one is tomorrow", () => {
    const at = (h: number, m: number, sec = 0) => new Date(2026, 10, 9, h, m, sec).getTime();
    expect(parseClaudeResetNotice("You've hit your limit · resets 3pm", at(15, 0, 30))).toBeNull();
    const old = parseClaudeResetNotice("You've hit your limit · resets 3pm", at(17, 0));
    expect(old).toBe(new Date(2026, 10, 10, 15, 0).getTime());
  });

  test("a Codex per-model limit carries the model; account-wide has none", () => {
    const perModel = classifyHarnessLimitSignal("codex", {
      text: "You've hit your usage limit for gpt-5.6-codex. Switch to another model now, or try again at 3:00 PM.",
      now: new Date(2026, 10, 9, 10, 0).getTime(),
    });
    expect(perModel?.reason).toBe("quota");
    expect(perModel?.model).toBe("gpt-5.6-codex");
    expect(classifyHarnessLimitSignal("codex", { text: "You've hit your usage limit for GPT-5.6-Codex. Switch." })?.model).toBe("gpt-5.6-codex");
    const wide = classifyHarnessLimitSignal("codex", { text: "You've hit your usage limit. Upgrade to Plus." });
    expect(wide?.model).toBeNull();
  });
});
