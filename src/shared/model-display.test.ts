import { describe, expect, test } from "bun:test";
import { asAgentKind, modelDisplayName, prettifyModelId, sanitizeCliLabel } from "./model-display.ts";

describe("prettifyModelId", () => {
  test.each([
    ["opus-5.5", "Opus 5.5"],
    ["haiku-4.5", "Haiku 4.5"],
    ["opus-6", "Opus 6"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["grok-4.7", "Grok 4.7"],
    ["kimi-k3", "Kimi K3"],
    ["gemini-4-argon", "Gemini 4 Argon"],
    ["auto", "Auto"],
    ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ])("%s → %s", (id, expected) => {
    expect(prettifyModelId(id)).toBe(expected);
  });
});

describe("sanitizeCliLabel", () => {
  test("removes zero-width characters and controls, collapses spaces", () => {
    expect(sanitizeCliLabel("Grok 4.7  High​​")).toBe("Grok 4.7 High");
    expect(sanitizeCliLabel("A\u001b[31mB\u0007")).toBe("A[31mB");
    expect(sanitizeCliLabel("  x⁠y﻿ ")).toBe("xy");
    expect("y".repeat(200)).toHaveLength(200);
    expect(sanitizeCliLabel("y".repeat(200))).toHaveLength(80);
  });
});

describe("modelDisplayName", () => {
  test("catalog label → curated label → prettified id", () => {
    const rows = [
      { id: "opus-6", label: "Opus 6 (CLI)" },
      { id: "stale", label: "stale", unlisted: true },
    ];
    expect(modelDisplayName("claude-code", "opus-6", rows)).toBe("Opus 6 (CLI)");
    expect(modelDisplayName("claude-code", "opus-5.5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-code", "opus-7")).toBe("Opus 7");
    expect(modelDisplayName("claude-code", "stale", rows)).toBe("Stale");
    expect(modelDisplayName("cursor", "grok-4.7")).toBe("Grok 4.7");
  });

  test("with no kind (a board card knows only a harness alias id) every kind's curated rows are searched", () => {
    expect(modelDisplayName(null, "opus-5.5")).toBe("Opus 5.5");
    expect(modelDisplayName(null, "grok-4.7")).toBe("Grok 4.7");
    expect(modelDisplayName(null, "unheard-of-9")).toBe("Unheard Of 9");
    expect(asAgentKind("claude-code")).toBe("claude-code");
    expect(asAgentKind("claude-work")).toBeNull();
    expect(asAgentKind(null)).toBeNull();
  });
});
