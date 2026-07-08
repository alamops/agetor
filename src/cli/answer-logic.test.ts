import { test, expect } from "bun:test";
import { buildAskAnswer, CUSTOM_OPTION } from "./answer-logic.ts";

test("buildAskAnswer strips the custom sentinel and assembles selected + custom", () => {
  expect(buildAskAnswer(["A", "B"], null)).toEqual({ selected: ["A", "B"] });
  expect(buildAskAnswer([CUSTOM_OPTION], "my answer")).toEqual({ selected: [], custom: "my answer" });
  expect(buildAskAnswer(["A", CUSTOM_OPTION], "extra")).toEqual({ selected: ["A"], custom: "extra" });
});

test("buildAskAnswer trims custom and drops whitespace-only", () => {
  expect(buildAskAnswer(["A"], "  spaced  ")).toEqual({ selected: ["A"], custom: "spaced" });
  expect(buildAskAnswer(["A"], "   ")).toEqual({ selected: ["A"] });
});

test("buildAskAnswer returns null when nothing was answered", () => {
  expect(buildAskAnswer([], null)).toBeNull();
  expect(buildAskAnswer([CUSTOM_OPTION], "")).toBeNull();
  expect(buildAskAnswer([], "   ")).toBeNull();
});
