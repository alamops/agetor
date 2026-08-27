import { describe, expect, test } from "bun:test";
import { GEMINI_PROMPT_ARGV_MAX_BYTES, promptByteOverage } from "./prompt-limits.ts";
import type { AgentKind } from "./types.ts";

describe("promptByteOverage", () => {
  test("gemini over the cap reports the limit and the byte count", () => {
    const prompt = "x".repeat(5_000);
    expect(promptByteOverage("gemini", prompt)).toEqual({ limit: 4096, bytes: 5_000 });
  });

  test("gemini under the cap returns null", () => {
    const prompt = "x".repeat(100);
    expect(promptByteOverage("gemini", prompt)).toBeNull();
  });

  test("gemini exactly at the cap returns null (over, not at-or-over)", () => {
    const prompt = "x".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES);
    expect(promptByteOverage("gemini", prompt)).toBeNull();
  });

  test("gemini one byte over the cap is reported", () => {
    const prompt = "x".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES + 1);
    expect(promptByteOverage("gemini", prompt)).toEqual({
      limit: GEMINI_PROMPT_ARGV_MAX_BYTES,
      bytes: GEMINI_PROMPT_ARGV_MAX_BYTES + 1,
    });
  });

  test("multi-byte characters are counted as bytes, not JS string length", () => {
    // "é" is 1 UTF-16 code unit (String#length counts it as 1) but 2 bytes in
    // UTF-8. 2,100 of them is under the cap by JS string length (2,100 <
    // 4,096) but over it by byte length (4,200 > 4,096) — this is the whole
    // point of measuring with TextEncoder instead of `.length`.
    const prompt = "é".repeat(2_100);
    expect(prompt.length).toBeLessThan(GEMINI_PROMPT_ARGV_MAX_BYTES);
    expect(promptByteOverage("gemini", prompt)).toEqual({ limit: 4096, bytes: 4_200 });
  });

  const UNCAPPED_KINDS: AgentKind[] = ["claude-code", "codex", "cursor", "fx"];
  test.each(UNCAPPED_KINDS)("%s is never capped, regardless of size", (kind) => {
    const prompt = "x".repeat(1_000_000);
    expect(promptByteOverage(kind, prompt)).toBeNull();
  });
});
