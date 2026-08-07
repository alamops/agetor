import { test, expect } from "bun:test";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  cursorModelArg,
  cursorModelSupportsFast,
  supportedEfforts,
  supportedModes,
} from "../shared/types.ts";

test("claude opus-5 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-5").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude opus-4.8 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-4.8").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude opus-4.7 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "opus-4.7").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude sonnet-4.6 supports max but not xhigh (per API docs)", () => {
  const ids = supportedEfforts("claude-code", "sonnet-4.6").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
  expect(ids).not.toContain("xhigh");
});

test("claude sonnet-5 supports xhigh + max (first Sonnet tier with xhigh)", () => {
  const ids = supportedEfforts("claude-code", "sonnet-5").map((o) => o.id);
  expect(ids).toContain("max");
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
});

test("claude haiku-4.5 exposes no effort options (CLI doesn't accept the flag)", () => {
  const ids = supportedEfforts("claude-code", "haiku-4.5").map((o) => o.id);
  expect(ids).toEqual([]);
});

test("claude null model falls back to DEFAULT_MODEL support set (opus-5)", () => {
  // No model specified → use the agent's default model's support set. Since
  // claude-code's DEFAULT_MODEL is opus-5, xhigh + max are both available.
  expect(DEFAULT_MODEL["claude-code"]).toBe("opus-5");
  const ids = supportedEfforts("claude-code", null).map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
  expect(ids).toContain("high");
});

test("claude fable-5 supports xhigh + max", () => {
  const ids = supportedEfforts("claude-code", "fable-5").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("max");
});

test("codex DEFAULT_MODEL is GPT-5.6 Sol", () => {
  expect(DEFAULT_MODEL.codex).toBe("gpt-5.6-sol");
});

test("codex GPT-5.6 family supports none through max", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const ids = supportedEfforts("codex", model).map((o) => o.id);
    expect(ids).toEqual(["max", "xhigh", "high", "medium", "low", "none"]);
  }
});

test("codex model picker includes the GPT-5.6 family", () => {
  const ids = AGENT_OPTIONS.codex.models.map((m) => m.id);
  expect(ids.slice(0, 3)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
});

test("codex gpt-5.5 supports xhigh but not max", () => {
  const ids = supportedEfforts("codex", "gpt-5.5").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).toContain("high");
  expect(ids).toContain("medium");
  expect(ids).toContain("low");
  expect(ids).not.toContain("max");
});

test("codex gpt-5 supports xhigh but not max", () => {
  const ids = supportedEfforts("codex", "gpt-5").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).not.toContain("max");
});

test("unknown model falls back to the agent's DEFAULT_MODEL support set", () => {
  // codex's default is gpt-5.6-sol, so pasted future ids inherit its range.
  const ids = supportedEfforts("codex", "future-codex-9000").map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low", "none"]);
});

test("ordered highest → lowest (no placeholder at the top)", () => {
  const ids = supportedEfforts("claude-code", "opus-4.7").map((o) => o.id);
  expect(ids[0]).toBe("max");
  const expectedOrder = ["max", "xhigh", "high", "medium", "low"];
  const filteredExpected = expectedOrder.filter((id) => ids.includes(id));
  expect(ids).toEqual(filteredExpected);
});

// --- cursor: model thinking modes + fast variants -----------------------------

test("cursor DEFAULT_MODEL is 'auto' (cursor-agent's own 'let the CLI pick' default)", () => {
  expect(DEFAULT_MODEL.cursor).toBe("auto");
});

test("cursor DEFAULT_EFFORT is high for parameterized non-Auto models", () => {
  expect(DEFAULT_EFFORT.cursor).toBe("high");
});

test("cursor model catalog includes the screenshot/default surface", () => {
  const ids = AGENT_OPTIONS.cursor.models.map((m) => m.id);
  expect(ids[0]).toBe("auto");
  expect(ids).toContain("gpt-5.3-codex");
  expect(ids).toContain("cursor-grok-4.5");
  expect(ids).toContain("composer-2.5");
  expect(ids).toContain("claude-opus-5");
  expect(ids).toContain("gpt-5.6-sol");
  expect(ids).toContain("gpt-5.6-terra");
  expect(ids).toContain("gemini-3.1-pro");
  expect(ids).toContain("glm-5.2");
});

test("cursor Auto model reports zero efforts", () => {
  expect(supportedEfforts("cursor", null)).toEqual([]);
  expect(supportedEfforts("cursor", "auto")).toEqual([]);
});

test("cursor Opus 4.8 and GPT-5.6 Sol expose Max", () => {
  expect(supportedEfforts("cursor", "claude-opus-4-8").map((o) => o.id)).toContain("max");
  expect(supportedEfforts("cursor", "gpt-5.6-sol").map((o) => o.id)).toContain("max");
});

test("cursor GPT-5.4 exposes Extra High but not Max", () => {
  const ids = supportedEfforts("cursor", "gpt-5.4").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).not.toContain("max");
});

test("cursor Gemini 3.6 Flash exposes Minimal", () => {
  expect(supportedEfforts("cursor", "gemini-3.6-flash").map((o) => o.id)).toContain("minimal");
});

test("cursor unknown model id falls back to DEFAULT_MODEL support set (Auto, no efforts)", () => {
  expect(supportedEfforts("cursor", "cursor-mystery-9000")).toEqual([]);
});

test("cursor fast support is model and effort specific", () => {
  expect(cursorModelSupportsFast("gpt-5.6-sol", "max")).toBe(true);
  expect(cursorModelSupportsFast("gpt-5.4", "low")).toBe(false);
  expect(cursorModelSupportsFast("composer-2.5", null)).toBe(true);
  expect(cursorModelSupportsFast("claude-sonnet-5", "max")).toBe(false);
});

test("cursorModelArg composes known model, effort, and fast variants", () => {
  expect(cursorModelArg("gpt-5.5", "xhigh", false)).toBe("gpt-5.5-extra-high");
  expect(cursorModelArg("gpt-5.5", "xhigh", true)).toBe("gpt-5.5-extra-high-fast");
  expect(cursorModelArg("composer-2.5", null, true)).toBe("composer-2.5-fast");
  expect(cursorModelArg("unknown-model", "max", true)).toBe("unknown-model");
});

test("cursor supportedModes returns the auto/ask pair (no per-model mode carve-outs)", () => {
  const ids = supportedModes("cursor", null).map((o) => o.id);
  expect(ids).toEqual(["auto", "ask"]);
});
