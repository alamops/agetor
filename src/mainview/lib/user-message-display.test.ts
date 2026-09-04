import { describe, expect, test } from "bun:test";
import { parseStickyUserMessagesPreference } from "./user-message-display.ts";

describe("parseStickyUserMessagesPreference", () => {
  test("defaults to sticky when the preference is absent", () => {
    expect(parseStickyUserMessagesPreference(undefined)).toBe(true);
  });

  test("recognizes the explicit standard-chat value", () => {
    expect(parseStickyUserMessagesPreference("false")).toBe(false);
  });

  test("keeps sticky for the persisted true value and malformed values", () => {
    expect(parseStickyUserMessagesPreference("true")).toBe(true);
    expect(parseStickyUserMessagesPreference("nope")).toBe(true);
    expect(parseStickyUserMessagesPreference(null)).toBe(true);
  });
});
