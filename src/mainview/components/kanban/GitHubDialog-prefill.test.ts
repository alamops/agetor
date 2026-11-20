import { describe, expect, test } from "bun:test";
import { mergePullDefaults, prefillPullFields } from "./GitHubDialog.tsx";

describe("prefillPullFields", () => {
  test("carries head, title and body, and base only when the prefill names one", () => {
    expect(prefillPullFields({ head: "h", title: "t", body: "b" })).toEqual({ head: "h", title: "t", body: "b" });
    expect(prefillPullFields({ head: "h", title: "t", body: "b", base: "topic" })).toEqual({
      head: "h",
      title: "t",
      body: "b",
      base: "topic",
    });
  });
  test("an empty base is treated as unset", () => {
    expect("base" in prefillPullFields({ head: "h", title: "t", body: "b", base: "" })).toBe(false);
  });
});

describe("mergePullDefaults", () => {
  const defaults = { head: "feat", base: "main" };
  test("fills empty fields from the defaults", () => {
    expect(mergePullDefaults({ head: "", base: "" }, defaults)).toEqual(defaults);
  });
  test("never overwrites a base the prefill seeded before the defaults resolved", () => {
    expect(mergePullDefaults({ head: "", base: "topic" }, defaults).base).toBe("topic");
  });
  test("never overwrites a head the user already has", () => {
    expect(mergePullDefaults({ head: "mine", base: "" }, defaults).head).toBe("mine");
  });
});
