import { describe, expect, test } from "bun:test";
import { classifyTmuxChoice, isClaudePlanModal, normalizeChoiceLabel, type TmuxChoiceClass } from "./tmux-choice-class.ts";

// Every row below was seen in src/bun/claude-tmux-scraper.test.ts, claude-prompt-screens.ts or
// claude-tmux-card-drive.test.ts; project names and paths are synthetic.
const ROWS: Array<{ prompt: string; label: string; want: TmuxChoiceClass }> = [
  // Permission prompts
  { prompt: "Do you want to proceed?", label: "Yes", want: "once" },
  { prompt: "Do you want to proceed?", label: "Yes, allow all", want: "always" },
  { prompt: "Do you want to make this edit?", label: "Yes, allow all edits during this session (shift+tab)", want: "always" },
  { prompt: "Do you want to proceed?", label: "Yes, and don't ask again for example MCP server – Fetch Records commands in /Users/me/.agetor/worktrees/demo", want: "always" },
  { prompt: "Do you want to proceed?", label: "Yes, allow always", want: "always" },
  { prompt: "Do you want to proceed?", label: "No", want: "reject" },
  { prompt: "Do you want to proceed?", label: "No, and tell Claude what to do differently (esc)", want: "reject" },
  // Trust and boot dialogs
  { prompt: "Do you trust the files in this folder?", label: "Yes, I trust this folder", want: "once" },
  { prompt: "Do you trust the files in this folder?", label: "No, exit", want: "reject" },
  { prompt: "Terms", label: "Yes, I accept", want: "once" },
  { prompt: "Terms", label: "No, go back", want: "reject" },
  // Browser tools: a persistent setting, so no phone answer
  { prompt: "Use your browser with Claude?", label: "Yes, use my browser", want: "unknown" },
  { prompt: "Use your browser with Claude?", label: "No, keep browser tools off", want: "reject" },
  // Model switch and misc dialogs: not code execution consent, and not on the exact list
  { prompt: "Switch model?", label: "Yes, switch to Opus 5", want: "unknown" },
  { prompt: "Switch effort?", label: "Yes, switch to low", want: "unknown" },
  { prompt: "Add?", label: "Yes, add it", want: "unknown" },
  { prompt: "Pick", label: "Cancel", want: "reject" },
  { prompt: "Pick", label: "Submit answers", want: "unknown" },
  { prompt: "Pick", label: "Chat about this", want: "unknown" },
  { prompt: "Pick", label: "Type something.", want: "unknown" },
  { prompt: "Pick", label: "Default (recommended)  Opus 5 with 1M context, best for complex work", want: "unknown" },
  { prompt: "Pick", label: "Fable                  Fable 5, most capable for your hardest and longest-running tasks", want: "unknown" },
  { prompt: "Login", label: "Claude account with subscription", want: "unknown" },
  { prompt: "Install", label: "Install", want: "unknown" },
];

describe("classifyTmuxChoice", () => {
  for (const r of ROWS) {
    test(`${r.want}: ${r.label.slice(0, 60)}`, () => {
      expect(classifyTmuxChoice(r.prompt, { key: "1", label: r.label })).toBe(r.want);
    });
  }

  test("the cursor glyph, the number prefix and the key hint are not part of the label", () => {
    expect(normalizeChoiceLabel("❯ 1. Yes")).toBe("Yes");
    expect(normalizeChoiceLabel("  2.  No,   exit ")).toBe("No, exit");
    expect(classifyTmuxChoice("p", { label: "❯ 1. Yes" })).toBe("once");
    expect(classifyTmuxChoice("p", { label: "3. No, and tell Claude what to do differently (esc)" })).toBe("reject");
  });

  test("fail closed: an extra word, a different wording or a different digit is unknown", () => {
    for (const label of [
      "Yes, please",
      "Yes, and run it",
      "Yes!",
      "yes",
      "Sure",
      "Yes, I trust this folder and its parents",
      "No thanks",
      "No, exit now",
      "Proceed",
      "",
      "1.",
      "Y",
    ]) {
      expect(classifyTmuxChoice("Do you want to proceed?", { label })).toBe("unknown");
    }
    // A key hint that is not a known one is not stripped, so the row is unknown.
    expect(classifyTmuxChoice("p", { label: "Yes (ctrl+x)" })).toBe("unknown");
  });

  test("any 'Yes' row that widens the grant is always, whatever else it says", () => {
    for (const label of [
      "Yes, and remember this choice",
      "Yes, from now on",
      "Yes, for this session",
      "Yes, every time",
      "Yes, don't ask again",
      "Yes, do not ask again for these",
      "Yes, allow all edits",
      "Yes, always allow Bash",
    ]) {
      expect(classifyTmuxChoice("p", { label })).toBe("always");
    }
  });
});

describe("the ExitPlanMode modal", () => {
  const modal = [
    "Ready to code?",
    "Here is Claude's plan: ↑ 17 more lines",
    "1. Yes, and use auto mode",
    "2. Yes, manually approve edits",
    "3. Tell Claude what to change",
  ].join("\n");

  test("its three rows map to plan-auto, plan-manual and plan-revise", () => {
    expect(isClaudePlanModal(modal)).toBe(true);
    expect(classifyTmuxChoice(modal, { key: "1", label: "Yes, and use auto mode" })).toBe("plan-auto");
    expect(classifyTmuxChoice(modal, { key: "2", label: "Yes, manually approve edits" })).toBe("plan-manual");
    expect(classifyTmuxChoice(modal, { key: "3", label: "Tell Claude what to change" })).toBe("plan-revise");
  });

  test("the same labels in another prompt are unknown", () => {
    const other = "Do you want to proceed?";
    expect(isClaudePlanModal(other)).toBe(false);
    for (const label of ["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]) {
      expect(classifyTmuxChoice(other, { label })).toBe("unknown");
    }
  });

  test("an unlisted row of the modal is never once", () => {
    expect(classifyTmuxChoice(modal, { label: "Yes, clear context and auto-accept edits" })).toBe("unknown");
    expect(classifyTmuxChoice(modal, { label: "Yes, and don't ask again for plans" })).toBe("always");
    expect(classifyTmuxChoice(modal, { label: "Yes" })).toBe("unknown");
  });
});
