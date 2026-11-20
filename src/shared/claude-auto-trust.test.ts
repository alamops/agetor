import { describe, expect, test } from "bun:test";
import { CLAUDE_AUTO_TRUST_PREF, isClaudeAutoTrustOn } from "./claude-auto-trust.ts";

describe("isClaudeAutoTrustOn", () => {
  test("defaults on when nothing is stored", () => {
    expect(isClaudeAutoTrustOn(undefined)).toBe(true);
    expect(isClaudeAutoTrustOn(null)).toBe(true);
  });
  test("is off only for an explicit off value", () => {
    for (const v of ["0", "false", "off", " OFF ", "False"]) expect(isClaudeAutoTrustOn(v)).toBe(false);
    for (const v of ["1", "true", "on", "", "yes", "garbage"]) expect(isClaudeAutoTrustOn(v)).toBe(true);
  });
  test("the key is the documented one", () => {
    expect(CLAUDE_AUTO_TRUST_PREF).toBe("claude_auto_trust_repositories");
  });
});
