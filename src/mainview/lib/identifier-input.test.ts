import { describe, expect, test } from "bun:test";
import { IDENTIFIER_INPUT_PROPS } from "./identifier-input.ts";

/**
 * `IDENTIFIER_INPUT_PROPS` (docs/plans/remove-autocorrect-from-pickers.md §5,
 * TT1) is spread onto every identifier input (Project/Branch picker search
 * boxes, the Kanban filter search box, the branch-name field, the branch-
 * naming pattern field, and the GitHub host field) so macOS/WebKit's
 * autocorrect/autocapitalize/spellcheck/autofill services never rewrite a
 * typed identifier. Prose fields (Title, Prompt) deliberately do NOT spread
 * it — see identifier-input.ts's doc comment.
 *
 * The exact-set assertions below (both the deep-equal AND the sorted key
 * list) exist so a future edit can't silently widen the constant (e.g. adding
 * an attribute that fights some other input) or narrow it (dropping one of
 * the four WebKit services it's meant to defeat) without a visible test
 * failure — a plain `toEqual` alone wouldn't catch an added key.
 */
describe("IDENTIFIER_INPUT_PROPS", () => {
  test("is exactly the four autocorrect-defeating attributes", () => {
    expect(IDENTIFIER_INPUT_PROPS).toEqual({
      autoCorrect: "off",
      autoCapitalize: "off",
      spellCheck: false,
      autoComplete: "off",
    });
  });

  test("has exactly these four keys — no more, no fewer", () => {
    expect(Object.keys(IDENTIFIER_INPUT_PROPS).sort()).toEqual([
      "autoCapitalize",
      "autoComplete",
      "autoCorrect",
      "spellCheck",
    ]);
  });
});
