import { describe, expect, test } from "bun:test";
import { FocusedForcedPosts } from "./focused-forced-posts.ts";

describe("FocusedForcedPosts (D7)", () => {
  test("unfocused posts; focused clears an older entry", () => {
    const f = new FocusedForcedPosts();
    expect(f.decide("t", { isFocused: false, force: false })).toBe("post");
    expect(f.decide("t", { isFocused: true, force: false })).toBe("clear");
  });
  test("a forced post while focused posts and then protects the entry from the next focused event", () => {
    const f = new FocusedForcedPosts();
    expect(f.decide("t", { isFocused: true, force: true })).toBe("post");
    expect(f.decide("t", { isFocused: true, force: false })).toBe("keep");
    // an unfocused post replaces the entry and ends the protection
    expect(f.decide("t", { isFocused: false, force: false })).toBe("post");
    expect(f.decide("t", { isFocused: true, force: false })).toBe("clear");
  });
  test("forget ends the protection (the task was opened, archived or deleted)", () => {
    const f = new FocusedForcedPosts();
    f.decide("t", { isFocused: true, force: true });
    f.forget("t");
    expect(f.decide("t", { isFocused: true, force: false })).toBe("clear");
  });
  test("tasks are independent", () => {
    const f = new FocusedForcedPosts();
    f.decide("a", { isFocused: true, force: true });
    expect(f.decide("b", { isFocused: true, force: false })).toBe("clear");
  });
});
