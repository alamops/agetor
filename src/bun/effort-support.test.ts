import { test, expect } from "bun:test";
import { AGENT_OPTIONS, DEFAULT_EFFORT, DEFAULT_MODEL, supportedEfforts, supportedModes } from "../shared/types.ts";

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

test("claude null model falls back to DEFAULT_MODEL support set (opus-4.8)", () => {
  // No model specified → use the agent's default model's support set. Since
  // claude-code's DEFAULT_MODEL is opus-4.8, xhigh + max are both available.
  expect(DEFAULT_MODEL["claude-code"]).toBe("opus-4.8");
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
  // codex's default is gpt-5.5 which has the same set as gpt-5.
  const ids = supportedEfforts("codex", "future-codex-9000").map((o) => o.id);
  expect(ids).toContain("xhigh");
  expect(ids).not.toContain("max");
});

test("ordered highest → lowest (no placeholder at the top)", () => {
  const ids = supportedEfforts("claude-code", "opus-4.7").map((o) => o.id);
  expect(ids[0]).toBe("max");
  const expectedOrder = ["max", "xhigh", "high", "medium", "low"];
  const filteredExpected = expectedOrder.filter((id) => ids.includes(id));
  expect(ids).toEqual(filteredExpected);
});

// --- cursor: no reasoning/effort knob at all ---------------------------------

test("cursor DEFAULT_MODEL is 'auto' (cursor-agent's own 'let the CLI pick' default)", () => {
  expect(DEFAULT_MODEL.cursor).toBe("auto");
});

test("cursor DEFAULT_EFFORT matches the 'none' sentinel (no effort knob to default)", () => {
  expect(DEFAULT_EFFORT.cursor).toBe("none");
});

test.each(AGENT_OPTIONS.cursor.models.map((m) => m.id))(
  "cursor model '%s' reports zero supported efforts (cursor-agent has no reasoning-effort flag)",
  (modelId) => {
    expect(supportedEfforts("cursor", modelId)).toEqual([]);
  },
);

test("cursor null model falls back to DEFAULT_MODEL ('auto') and still reports zero efforts", () => {
  expect(supportedEfforts("cursor", null)).toEqual([]);
});

test("cursor unknown model id falls back to DEFAULT_MODEL support set (still empty)", () => {
  expect(supportedEfforts("cursor", "cursor-mystery-9000")).toEqual([]);
});

test("cursor supportedModes returns the auto/ask pair (no per-model mode carve-outs)", () => {
  const ids = supportedModes("cursor", null).map((o) => o.id);
  expect(ids).toEqual(["auto", "ask"]);
});
