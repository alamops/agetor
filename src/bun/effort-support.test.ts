import { test, expect } from "bun:test";
import { DEFAULT_MODEL, supportedEfforts } from "../shared/types.ts";

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

test("grok grok-build supports no effort levels (no confirmed CLI reasoning-effort flag)", () => {
  const ids = supportedEfforts("grok", "grok-build").map((o) => o.id);
  expect(ids).toEqual([]);
});

test("grok grok-4.5 supports no effort levels", () => {
  const ids = supportedEfforts("grok", "grok-4.5").map((o) => o.id);
  expect(ids).toEqual([]);
});

test("grok grok-4-fast-reasoning supports no effort levels", () => {
  const ids = supportedEfforts("grok", "grok-4-fast-reasoning").map((o) => o.id);
  expect(ids).toEqual([]);
});

test("grok null model falls back to DEFAULT_MODEL support set (still empty — every grok model declines effort)", () => {
  const ids = supportedEfforts("grok", null).map((o) => o.id);
  expect(ids).toEqual([]);
});

test("grok unknown model falls back to the agent's DEFAULT_MODEL support set (empty)", () => {
  const ids = supportedEfforts("grok", "grok-future-9000").map((o) => o.id);
  expect(ids).toEqual([]);
});
