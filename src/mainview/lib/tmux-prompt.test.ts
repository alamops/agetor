import { test, expect } from "bun:test";
import { tmuxChoiceLabel } from "./tmux-prompt.ts";

// Display helper for `TmuxPromptCard`'s choice buttons (RunPanel.tsx).
// `hideKeys` is set by `matchUnnumberedModal` (issue #298's Chrome startup
// prompt — an `er` select with `hideIndexes`, so no numbers are on screen);
// every other matcher leaves it unset and keeps the long-standing
// `"<key>. <label>"` convention.

test("tmuxChoiceLabel — hideKeys:true renders the pane's label verbatim (no invented digit)", () => {
  expect(tmuxChoiceLabel({ key: "1", label: "No, keep browser tools off" }, true)).toBe(
    "No, keep browser tools off",
  );
  expect(tmuxChoiceLabel({ key: "2", label: "Yes, use my browser" }, true)).toBe("Yes, use my browser");
});

test("tmuxChoiceLabel — hideKeys false/undefined keeps '<key>. <label>' (numbered, yes-no and slider prompts)", () => {
  expect(tmuxChoiceLabel({ key: "2", label: "Yes" }, false)).toBe("2. Yes");
  expect(tmuxChoiceLabel({ key: "2", label: "Yes" }, undefined)).toBe("2. Yes");
  expect(tmuxChoiceLabel({ key: "y", label: "Yes" })).toBe("y. Yes");
});

test("tmuxChoiceLabel — only a literal true hides keys (a truthy non-boolean cannot)", () => {
  // The flag crosses an SSE JSON boundary; anything other than the serialized
  // `true` must keep the existing rendering rather than silently drop keys.
  expect(tmuxChoiceLabel({ key: "1", label: "Yes" }, 1 as unknown as boolean)).toBe("1. Yes");
  expect(tmuxChoiceLabel({ key: "1", label: "Yes" }, "true" as unknown as boolean)).toBe("1. Yes");
  expect(tmuxChoiceLabel({ key: "1", label: "Yes" }, null as unknown as boolean)).toBe("1. Yes");
});

import { checkOAuthCodeInput, OAUTH_CODE_INPUT_MAX_LEN, tmuxPromptAnswerKind } from "./tmux-prompt.ts";

test("tmuxPromptAnswerKind — only the literal enter/code are non-choice cards", () => {
  expect(tmuxPromptAnswerKind({})).toBe("choice");
  expect(tmuxPromptAnswerKind({ answerKind: "choice" })).toBe("choice");
  expect(tmuxPromptAnswerKind({ answerKind: "enter" })).toBe("enter");
  expect(tmuxPromptAnswerKind({ answerKind: "code" })).toBe("code");
  for (const bad of ["ENTER", "text", 1, true, null, undefined, {}]) {
    expect(tmuxPromptAnswerKind({ answerKind: bad })).toBe("choice");
  }
});

test("checkOAuthCodeInput — mirrors the server's rules and never quotes the value", () => {
  expect(checkOAuthCodeInput("  abc#def  ")).toEqual({ ok: true, code: "abc#def" });
  expect(checkOAuthCodeInput("a".repeat(OAUTH_CODE_INPUT_MAX_LEN)).ok).toBe(true);
  for (const bad of ["a".repeat(OAUTH_CODE_INPUT_MAX_LEN + 1), "a\nb", "a\tb", "a\u001bb", "", "   "]) {
    const r = checkOAuthCodeInput(bad);
    expect(r.ok).toBe(false);
    if (!r.ok && bad.trim()) expect(r.reason).not.toContain(bad.trim());
  }
});
