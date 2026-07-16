import { test, expect } from "bun:test";
import { DEFAULT_EFFORT, DEFAULT_MODEL, supportedEfforts } from "../shared/types.ts";

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

test("grok DEFAULT_MODEL is grok-build", () => {
  expect(DEFAULT_MODEL.grok).toBe("grok-build");
});

test("grok DEFAULT_EFFORT is medium", () => {
  expect(DEFAULT_EFFORT.grok).toBe("medium");
});

test("grok grok-build supports max/xhigh/high/medium/low (D6 confirmed --effort flag, no 'none')", () => {
  // grok-build's declared support is the full canonical range minus "none"
  // (grok has no reasoning-off id) — asserted as an exact match against
  // MODEL_EFFORT_SUPPORT.grok["grok-build"], not just toContain, so a future
  // narrowing/widening of the list is caught here.
  const ids = supportedEfforts("grok", "grok-build").map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low"]);
});

test("grok null model falls back to DEFAULT_MODEL support set (grok-build's full range)", () => {
  const ids = supportedEfforts("grok", null).map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low"]);
});

test("grok unknown model id falls back to the agent's DEFAULT_MODEL (grok-build) support set", () => {
  // MODEL_EFFORT_SUPPORT.grok only declares "grok-build" now (old curated
  // ids grok-4.5 / grok-4-fast-reasoning were dropped, D7) — an id not in
  // that map falls back to DEFAULT_MODEL[agent]'s set per supportedEfforts'
  // `?? MODEL_EFFORT_SUPPORT[agent][DEFAULT_MODEL[agent]]` fallback, so an
  // unrecognized model still gets the full effort picker rather than none.
  const ids = supportedEfforts("grok", "grok-future-9000").map((o) => o.id);
  expect(ids).toEqual(["max", "xhigh", "high", "medium", "low"]);
});
