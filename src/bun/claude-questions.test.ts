import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ASK_TYPED_ANSWER_MAX_CHARS,
  detectAskModal,
  extractFocusedPreview,
  formatAnswersMessage,
  isLossyAskPane,
  isTabbedAskModal,
  paneWrapRisk,
  parseAskModal,
  parseModalPane,
  planAskAnswers,
  stripPreviewColumn,
  type AskAnswer,
  type AskQuestionSpec,
} from "./claude-questions.ts";

/** Real tmux pane captures of claude-code 2.1.161's AskUserQuestion modal,
 *  recorded live (see the module header). These are the ground truth the
 *  detector/parser must keep handling across refactors. */
const fx = (name: string): string =>
  readFileSync(path.join(import.meta.dir, "fixtures", "askuserquestion", `${name}.txt`), "utf8");

describe("detectAskModal", () => {
  test("flat single-select question screen → 'question'", () => {
    expect(detectAskModal(fx("single_select"))).toBe("question");
  });

  test("single-select-with-Other question screen → 'question'", () => {
    expect(detectAskModal(fx("single_with_other"))).toBe("question");
  });

  test("multi-question multiSelect screen → 'question'", () => {
    expect(detectAskModal(fx("multi_initial_toppings"))).toBe("question");
    expect(detectAskModal(fx("multi_toppings_toggled"))).toBe("question");
    expect(detectAskModal(fx("multi_size_tab"))).toBe("question");
  });

  test("review/submit screen → 'review'", () => {
    expect(detectAskModal(fx("review_submit"))).toBe("review");
  });

  test("2.1.284: footer wrapped across two rows (`Esc to` / `cancel`) still detects", () => {
    expect(detectAskModal(fx("v284_footer_wrapped"))).toBe("question");
  });

  test("2.1.284: review screen → 'review'", () => {
    expect(detectAskModal(fx("v284_review"))).toBe("review");
  });

  test("2.1.284: post-decline screen (typed `purple` in the composer) is not a modal", () => {
    expect(detectAskModal(fx("v284_typed_single"))).toBeNull();
  });

  test("ordinary REPL output is not a modal", () => {
    expect(detectAskModal("just some normal assistant text\n❯ \n? for shortcuts")).toBeNull();
    // A plain numbered list (no 'Chat about this' escape hatch) must not match.
    expect(detectAskModal("Steps:\n  1. do a thing\n  2. do another\n")).toBeNull();
  });
});

describe("isTabbedAskModal", () => {
  test("flat single-select is not tabbed", () => {
    expect(isTabbedAskModal(fx("single_select"))).toBe(false);
    expect(isTabbedAskModal(fx("single_with_other"))).toBe(false);
  });
  test("multiSelect / multi-question is tabbed (checkbox + Submit tab)", () => {
    expect(isTabbedAskModal(fx("multi_initial_toppings"))).toBe(true);
    expect(isTabbedAskModal(fx("multi_size_tab"))).toBe(true); // single-select tab but Submit tab present
  });
});

describe("parseAskModal", () => {
  test("returns kind + tabbed + a non-empty paneText + stable fingerprint", () => {
    const p = parseAskModal(fx("multi_initial_toppings"));
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("question");
    expect(p!.tabbed).toBe(true);
    expect(p!.paneText).toContain("Pick toppings");
    expect(p!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    // Deterministic for the same pane.
    expect(parseAskModal(fx("multi_initial_toppings"))!.fingerprint).toBe(p!.fingerprint);
  });

  test("review screen parses as tabbed review", () => {
    const p = parseAskModal(fx("review_submit"));
    expect(p!.kind).toBe("review");
    expect(p!.tabbed).toBe(true);
    expect(p!.paneText).toContain("Submit answers");
  });

  test("distinct panes get distinct fingerprints", () => {
    expect(parseAskModal(fx("multi_initial_toppings"))!.fingerprint)
      .not.toBe(parseAskModal(fx("multi_toppings_toggled"))!.fingerprint);
  });
});

describe("stripPreviewColumn — removes the side-by-side preview box from a row", () => {
  test("cuts the box off an option row at the gutter", () => {
    expect(stripPreviewColumn("❯ 1. One combined line            ┌──────────────┐"))
      .toBe("❯ 1. One combined line");
    expect(stripPreviewColumn("  2. Separate name + flag         │ Cancelled by: X │"))
      .toBe("  2. Separate name + flag");
  });

  test("blanks an indented box continuation row entirely", () => {
    expect(stripPreviewColumn("                                  │ — or — │")).toBe("");
    expect(stripPreviewColumn("                                  ├─── ✂ ─── 2 lines hidden ───┤")).toBe("");
    expect(stripPreviewColumn("                                  └──────────────┘")).toBe("");
  });

  test("preserves a full-width separator row (horizontals at column 0)", () => {
    const sep = "─".repeat(60);
    expect(stripPreviewColumn(sep)).toBe(sep);
  });

  test("leaves a label that merely contains a lone box char after a gap (≥2 box-char guard)", () => {
    // A real panel row has both borders; a label with a single stray `│` does not.
    expect(stripPreviewColumn("  1. Use A  │ B layout")).toBe("  1. Use A  │ B layout");
    // …but two box chars after the gutter still strip (defends the real case).
    expect(stripPreviewColumn("  1. Use A  │ B │")).toBe("  1. Use A");
  });

  test("rows with no preview box are returned unchanged", () => {
    expect(stripPreviewColumn("❯ 1. Red")).toBe("❯ 1. Red");
    expect(stripPreviewColumn("  One main model with others as failover/cost backups.")).toBe(
      "  One main model with others as failover/cost backups.",
    );
  });
});

describe("parseModalPane — reads the visible question off the pane", () => {
  test("flat single-select (Color): question + options, no tab bar, not multiSelect", () => {
    const p = parseModalPane(fx("single_select"))!;
    expect(p.tabbed).toBe(false);
    expect(p.tabHeaders).toEqual([]);
    expect(p.questionText).toBe("Which color do you prefer?");
    expect(p.multiSelect).toBe(false);
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
    expect(p.options.every((o) => !o.checked)).toBe(true);
    expect(p.cursorIndex).toBe(0);
    expect(p.complete).toBe(true);
  });

  test("flat single-select with Other (Name): excludes 'Type something' + 'Chat about this'", () => {
    const p = parseModalPane(fx("single_with_other"))!;
    expect(p.questionText).toBe("What is your name?");
    expect(p.options.map((o) => o.label)).toEqual(["Alice", "Bob"]);
    expect(p.multiSelect).toBe(false);
    expect(p.complete).toBe(true);
  });

  test("a bare unnumbered `Chat about this` row under the last option is never folded into its description", () => {
    const pane = [
      " Which color do you prefer?",
      "",
      " ❯ 1. Red",
      "      A warm color",
      "   2. Green",
      "      A cool color",
      "  Chat about this",
      "",
      " Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const p = parseModalPane(pane)!;
    expect(p).not.toBeNull();
    expect(p.questionText).toBe("Which color do you prefer?");
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Green"]);
    expect(p.options[0]!.description).toBe("A warm color");
    expect(p.options[1]!.description).toBe("A cool color");
    const bare = parseModalPane(pane.replace("      A cool color\n", ""))!;
    expect(bare.options[1]!.description).toBeUndefined();
  });

  test("wrapped question + wrapped description: gathers every hard-wrapped row, not just the tail", () => {
    const p = parseModalPane(fx("single_wrapped_question"))!;
    // The full question spans two pane rows; the old parser kept only the tail
    // ("OpenAI). How are they used?").
    expect(p.questionText).toBe(
      "There are 5+ AI providers wired up (Vision, Translate, Gemini, Mistral, Groq, OpenAI). How are they used?",
    );
    expect(p.options.map((o) => o.label)).toEqual([
      "Primary + fallbacks", "Task-specialized", "Experimental",
    ]);
    expect(p.options[0]!.description).toBe("One main model with others as failover/cost backups.");
    // option 2's description hard-wraps across two rows → joined into one.
    expect(p.options[1]!.description).toBe(
      "Each provider handles a specific job (OCR vs translate vs explain vs chat).",
    );
    expect(p.multiSelect).toBe(false);
    expect(p.complete).toBe(true);
  });

  test("truncated top: header/question/option-1 scrolled off-screen → complete: false", () => {
    // Same underlying modal as single_wrapped_question, but the capture starts
    // mid-option-1's wrapped description (the header, question, and "1. Primary
    // + fallbacks" row are off the top of a short pane). This is the exact shape
    // that used to mis-drive an answer: option 1 disappears from the card and
    // its leftover description line gets scooped up as the "question".
    const p = parseModalPane(fx("truncated_top"))!;
    expect(p.complete).toBe(false);
    // Document the corruption this guards against, so a future refactor that
    // "fixes" the symptom without fixing the underlying completeness check
    // gets caught here too.
    expect(p.options.map((o) => o.label)).toEqual(["Task-specialized", "Experimental"]);
    expect(p.questionText).not.toBe(
      "There are 5+ AI providers wired up (Vision, Translate, Gemini, Mistral, Groq, OpenAI). How are they used?",
    );
  });

  test("pane fallback: TUI collapse markers ('✂ N lines hidden') + 'Notes:' rows never leak into descriptions", () => {
    const pane = [
      " ☐ Scope",
      "",
      "How far should this go?",
      "",
      "❯ 1. Plugins + curated built-ins",
      "  Enumerate plugins and a curated list.",
      "  ✂ 5 lines hidden",
      "  2. Plugins only",
      "  Enumerate enabled-plugin items only.",
      "Notes: press n to add notes",
      "  3. Type something.",
      "──────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const p = parseModalPane(pane)!;
    expect(p.options.map((o) => o.label)).toEqual(["Plugins + curated built-ins", "Plugins only"]);
    expect(p.options[0]!.description).toBe("Enumerate plugins and a curated list.");
    expect(p.options[1]!.description).toBe("Enumerate enabled-plugin items only.");
  });

  test("side-by-side `preview` panel: the example box never bleeds into option labels/descriptions", () => {
    // capture-pane flattens claude's side-by-side preview layout so the
    // box-drawn example panel lands on the SAME rows as the options (to the
    // right). Before the fix, option 2 rendered as
    // "Full-width row below shift  │ Supervisor block (240px), 2 stacked lines: │".
    const p = parseModalPane(fx("multi_preview_panel"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Layout", "Display", "Extras"]);
    expect(p.questionText).toBe("Where should the new cancellation detail row go?");
    expect(p.multiSelect).toBe(false);
    expect(p.options.map((o) => o.label)).toEqual([
      "Inside the merged cell", "Full-width row below shift",
    ]);
    // No preview text, box-drawing chars, or collapse markers anywhere.
    for (const o of p.options) {
      expect(o.description ?? "").not.toContain("Supervisor block");
      expect(`${o.label} ${o.description ?? ""}`).not.toMatch(/[┌┐└┘├┤┬┴┼│✂]/);
      expect(`${o.label} ${o.description ?? ""}`).not.toContain("lines hidden");
    }
    expect(p.options.every((o) => o.description === undefined)).toBe(true);
  });

  test("tabbed multiSelect (Toppings): tab headers, checkbox options, multiSelect=true", () => {
    const p = parseModalPane(fx("multi_initial_toppings"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Toppings", "Size"]);
    expect(p.questionText).toBe("Pick toppings");
    expect(p.multiSelect).toBe(true);
    expect(p.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Mushroom"]);
    expect(p.options.every((o) => !o.checked)).toBe(true);
    expect(p.cursorIndex).toBe(0);
    expect(p.complete).toBe(true);
  });

  test("tabbed single-select tab (Size): same tab bar, no checkboxes", () => {
    const p = parseModalPane(fx("multi_size_tab"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Toppings", "Size"]);
    expect(p.questionText).toBe("Pick a size");
    expect(p.multiSelect).toBe(false);
    expect(p.options.map((o) => o.label)).toEqual(["Small", "Large"]);
    expect(p.complete).toBe(true);
  });

  test("toggled checkboxes: cursor on option 3 doesn't affect completeness (based on option 1, not the cursor)", () => {
    const p = parseModalPane(fx("multi_toppings_toggled"))!;
    expect(p.complete).toBe(true);
  });

  test("toggled checkboxes are reflected in `checked`", () => {
    const p = parseModalPane(fx("multi_toppings_toggled"))!;
    const byLabel = Object.fromEntries(p.options.map((o) => [o.label, o.checked]));
    expect(byLabel).toEqual({ Cheese: false, Ham: true, Mushroom: true });
  });

  test("returns null on the review screen and on ordinary output", () => {
    expect(parseModalPane(fx("review_submit"))).toBeNull();
    expect(parseModalPane("just some text\n1. not a real modal\n")).toBeNull();
  });

  test("side-by-side preview panel: clean labels (no bleed) + focused option's full preview", () => {
    // Real 2.1.170 capture, pane grown so the 12-line preview is not collapsed.
    const p = parseModalPane(fx("single_preview_full"))!;
    expect(p.options.map((o) => o.label)).toEqual(["Single-select only (v1)", "Both layouts"]);
    expect(p.cursorIndex).toBe(0);
    // The box never bled into the label.
    expect(p.options[0]!.label).not.toContain("│");
    expect(p.options[0]!.label).not.toContain("┌");
    // Focused (cursor) option carries its full preview; the other does not (its
    // panel isn't on this frame — the caller navigates to capture it).
    expect(p.options[0]!.preview).toBe(
      Array.from({ length: 12 }, (_, i) => `preview probe line ${String(i + 1).padStart(2, "0")}`).join("\n"),
    );
    expect(p.options[0]!.previewTruncated).toBe(false);
    expect(p.options[1]!.preview).toBeUndefined();
    expect(p.complete).toBe(true);
  });

  test("collapsed preview panel: marker flips previewTruncated, partial text kept, labels clean", () => {
    const p = parseModalPane(fx("single_preview_truncated"))!;
    expect(p.options.map((o) => o.label)).toEqual(["Cap ~40 rows", "Cap ~80 rows", "Fit to tallest preview"]);
    expect(p.options[0]!.preview).toBe("line 1 of 3");
    expect(p.options[0]!.previewTruncated).toBe(true);
    // The "├── ✂ N lines hidden ──┤" divider never leaked into a label.
    expect(p.options.every((o) => !o.label.includes("✂"))).toBe(true);
  });
});

describe("extractFocusedPreview", () => {
  test("pulls the full preview from the side panel of a grown capture", () => {
    const got = extractFocusedPreview(fx("single_preview_full").split("\n"));
    expect(got?.truncated).toBe(false);
    expect(got?.text.split("\n").length).toBe(12);
    expect(got?.text.startsWith("preview probe line 01")).toBe(true);
  });
  test("flags truncation when the TUI collapsed the panel", () => {
    const got = extractFocusedPreview(fx("single_preview_truncated").split("\n"));
    expect(got).toEqual({ text: "line 1 of 3", truncated: true });
  });
  test("preserves interior blank lines and ASCII-art leading indent", () => {
    const pane = [
      "❯ 1. Logo                ┌────────────────────┐",
      "  2. Other               │  ███ wide          │",
      "                         │                    │",
      "                         │ narrow             │",
      "                         └────────────────────┘",
      "  3. Chat about this",
      "Enter to select · Esc to cancel",
    ];
    expect(extractFocusedPreview(pane)).toEqual({ text: " ███ wide\n\nnarrow", truncated: false });
  });
  test("returns null when no panel is present", () => {
    expect(extractFocusedPreview(["❯ 1. Red", "  2. Green", "Esc to cancel"])).toBeNull();
  });
});

describe("planAskAnswers — drive sequences", () => {
  test("single single-select question submits on the option Enter (no review)", () => {
    const specs: AskQuestionSpec[] = [
      { question: "Which color?", multiSelect: false, options: ["Red", "Green", "Blue"] },
    ];
    const answers: AskAnswer[] = [{ selected: ["Green"] }];
    const plan = planAskAnswers(specs, answers);
    expect(plan.mode).toBe("drive");
    // Green = index 1 → Down once, Enter. Flat single-select ⇒ NO trailing submit Enter.
    expect(plan).toEqual({ mode: "drive", steps: ["Down", "Enter"], confirmsReview: false });
  });

  test("first option of a flat single-select needs no arrow", () => {
    const plan = planAskAnswers(
      [{ question: "q", multiSelect: false, options: ["Red", "Green"] }],
      [{ selected: ["Red"] }],
    );
    expect(plan).toEqual({ mode: "drive", steps: ["Enter"], confirmsReview: false });
  });

  test("captured multi example: Toppings[Ham,Mushroom] + Size[Large]", () => {
    // This is the exact scenario the live capture walked through.
    const specs: AskQuestionSpec[] = [
      { question: "Pick toppings", multiSelect: true, options: ["Cheese", "Ham", "Mushroom"] },
      { question: "Pick a size", multiSelect: false, options: ["Small", "Large"] },
    ];
    const answers: AskAnswer[] = [
      { selected: ["Ham", "Mushroom"] },
      { selected: ["Large"] },
    ];
    const plan = planAskAnswers(specs, answers);
    // Toppings: cursor 0→1 (Ham) Down,Enter ; 1→2 (Mushroom) Down,Enter ; Right.
    // Size: 0→1 (Large) Down,Enter (auto-advances to Submit). Trailing Enter submits.
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Enter", "Down", "Enter", "Right", "Down", "Enter", "Enter"],
      confirmsReview: true,
    });
  });

  test("single multiSelect question: toggles, advance to Submit, confirm", () => {
    const specs: AskQuestionSpec[] = [
      { question: "Pick toppings", multiSelect: true, options: ["Cheese", "Ham", "Mushroom"] },
    ];
    const plan = planAskAnswers(specs, [{ selected: ["Cheese", "Mushroom"] }]);
    // Cheese idx0 (no arrow) Enter ; 0→2 Down,Down,Enter ; Right (to Submit) ; Enter (submit).
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Enter", "Down", "Down", "Enter", "Right", "Enter"],
      confirmsReview: true,
    });
  });

  test("multiSelect picks are toggled in option order regardless of click order", () => {
    const specs: AskQuestionSpec[] = [
      { question: "q", multiSelect: true, options: ["A", "B", "C", "D"] },
    ];
    const planAsc = planAskAnswers(specs, [{ selected: ["B", "D"] }]);
    const planDesc = planAskAnswers(specs, [{ selected: ["D", "B"] }]);
    expect(planAsc).toEqual(planDesc);
    // B idx1 Down,Enter ; 1→3 Down,Down,Enter ; Right ; Enter.
    expect(planAsc).toEqual({
      mode: "drive",
      steps: ["Down", "Enter", "Down", "Down", "Enter", "Right", "Enter"],
      confirmsReview: true,
    });
  });

  test("two single-select questions each auto-advance, then submit", () => {
    const specs: AskQuestionSpec[] = [
      { question: "q1", multiSelect: false, options: ["A", "B"] },
      { question: "q2", multiSelect: false, options: ["X", "Y", "Z"] },
    ];
    const plan = planAskAnswers(specs, [{ selected: ["B"] }, { selected: ["Z"] }]);
    // q1: Down,Enter(auto-advance) ; q2: Down,Down,Enter(auto-advance to Submit) ; Enter(submit).
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Enter", "Down", "Down", "Enter", "Enter"],
      confirmsReview: true,
    });
  });
});

describe("planAskAnswers — message fallbacks", () => {
  const specs: AskQuestionSpec[] = [
    { question: "Which color?", multiSelect: false, options: ["Red", "Green", "Blue"] },
  ];

  // Plan change (2.1.284): a typed custom answer is DRIVEN through the native
  // "Type something" row, so these two no longer fall back. What still falls
  // back for custom text is the untypeable cases (multi-line / over-long).
  test("multi-line custom answer falls back to message mode", () => {
    const plan = planAskAnswers(specs, [{ selected: [], custom: "Magenta\nor pink" }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") {
      expect(plan.reason).toBe("multiline-custom");
      expect(plan.text).toContain("Magenta");
      expect(plan.text).toContain("Which color?");
    }
  });

  test("custom text alongside a pick: the typed text wins and is driven", () => {
    const plan = planAskAnswers(specs, [{ selected: ["Red"], custom: "or maybe pink" }]);
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Down", "Down", { type: "text", text: "or maybe pink" }, "Enter"],
      confirmsReview: false,
    });
  });

  test("empty answer → message mode (native requires an answer)", () => {
    const plan = planAskAnswers(specs, [{ selected: [] }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("empty-answer");
  });

  test("unknown option label → message mode (never drive a blind keypress)", () => {
    const plan = planAskAnswers(specs, [{ selected: ["Chartreuse"] }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("unknown-option");
  });

  test("arity mismatch (answers vs questions) → message mode", () => {
    const plan = planAskAnswers(specs, []);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("arity-mismatch");
  });
});

describe("formatAnswersMessage", () => {
  test("joins multi-select picks and includes custom text", () => {
    const specs: AskQuestionSpec[] = [
      { question: "Pick toppings", multiSelect: true, options: ["Cheese", "Ham"] },
      { question: "Anything else?", multiSelect: false, options: ["No"] },
    ];
    const msg = formatAnswersMessage(specs, [
      { selected: ["Cheese", "Ham"] },
      { selected: [], custom: "extra napkins" },
    ]);
    expect(msg).toBe(
      'Here are my answers: "Pick toppings"="Cheese, Ham", "Anything else?"="extra napkins".',
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Claude Code 2.1.284 — real captures (fixtures `v284_*`) + synthetic panes
 * ────────────────────────────────────────────────────────────────────────── */

const RULE = "─".repeat(80);

/** Build a synthetic 2.1.284-shaped modal pane. `body` rows are placed verbatim
 *  between the header and the bottom rule; `header` defaults to a flat ` ☐ Q`. */
function synthPane(opts: {
  header?: string;
  question: string[];
  options: string[];
  footer?: string;
}): string {
  return [
    RULE,
    opts.header ?? " ☐ Q",
    "",
    ...opts.question,
    "",
    ...opts.options,
    RULE,
    "  9. Chat about this",
    "",
    opts.footer ?? "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "",
  ].join("\n");
}

describe("parseModalPane — 2.1.284 real captures", () => {
  test("v284_flat: flat header, gutter-stripped 3-row question, 3 options with descriptions", () => {
    const p = parseModalPane(fx("v284_flat"))!;
    expect(p).not.toBeNull();
    expect(p.tabbed).toBe(false);
    expect(p.tabHeaders).toEqual([]);
    expect(p.flatHeader).toBe("Color");
    expect(p.multiSelect).toBe(false);
    expect(p.questionText).toBe(
      "Considering everything about the brand refresh we discussed, including the warm palette, the accessibility contrast requirements, and the printed packaging, which primary accent color should we adopt for the new logo?",
    );
    expect(p.questionText).not.toContain("│");
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Blue", "Green"]);
    expect(p.options.map((o) => o.description)).toEqual([
      "Bold and energetic",
      "Calm and trustworthy",
      "Fresh and natural",
    ]);
    expect(p.cursorIndex).toBe(0);
    expect(p.complete).toBe(true);
    expect(p.windowed).toBe(false);
  });

  test("v284_multi_tab1: tabbed multiSelect, 4 checkbox options with `Add …` descriptions", () => {
    const p = parseModalPane(fx("v284_multi_tab1"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Toppings", "Size", "Delivery"]);
    expect(p.flatHeader).toBeUndefined();
    expect(p.multiSelect).toBe(true);
    expect(p.questionText).toBe(
      "Which toppings do you want on your pizza? Pick as many as you like, keeping in mind that each additional topping adds a small charge to the final price of the order.",
    );
    expect(p.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Mushrooms", "Olives"]);
    expect(p.options.map((o) => o.description)).toEqual([
      "Add cheese",
      "Add ham",
      "Add mushrooms",
      "Add olives",
    ]);
    expect(p.options.every((o) => o.checked === false)).toBe(true);
    expect(p.cursorIndex).toBe(0);
    expect(p.complete).toBe(true);
  });

  test("v284_multi_tab2: single-select tab, cursor on Medium (index 1), not multiSelect", () => {
    const p = parseModalPane(fx("v284_multi_tab2"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Toppings", "Size", "Delivery"]);
    expect(p.multiSelect).toBe(false);
    expect(p.questionText).toBe("What size pizza do you want?");
    expect(p.options.map((o) => o.label)).toEqual(["Small", "Medium", "Large"]);
    expect(p.options.map((o) => o.description)).toEqual(["8 inch", "12 inch", "16 inch"]);
    expect(p.cursorIndex).toBe(1);
    expect(p.complete).toBe(true);
  });

  test("v284_multi_tab3: labels are cut at the 80-col wrap (continuation lands as a fake description) and paneWrapRisk flags it", () => {
    const t = fx("v284_multi_tab3");
    const p = parseModalPane(t)!;
    expect(p.tabbed).toBe(true);
    expect(p.multiSelect).toBe(false);
    expect(p.questionText).toBe("How should we deliver the order?");
    expect(p.options).toHaveLength(2);
    // Exactly what the parser yields today: the wrapped tail of each label is
    // read as its description — the reason the collector grows the pane.
    expect(p.options[0]!.label).toBe(
      "Deliver to my home address by courier, leaving it at the front door without",
    );
    expect(p.options[0]!.description).toBe("signature");
    expect(p.options[1]!.label).toBe(
      "Hold at the restaurant counter for pickup, I will collect it myself later",
    );
    expect(p.options[1]!.description).toBe("this evening");
    expect(p.complete).toBe(true);
    expect(paneWrapRisk(t)).toBe(true);
    expect(isLossyAskPane(t)).toBe(true);
  });

  test("v284_longopts: flat header Plan, 4 options, wrap risk + lossy", () => {
    const t = fx("v284_longopts");
    const p = parseModalPane(t)!;
    expect(p.flatHeader).toBe("Plan");
    expect(p.questionText).toBe("Which rollout plan should we follow for the migration?");
    expect(p.options).toHaveLength(4);
    expect(p.options[0]!.label).toStartWith("Option A:");
    expect(p.options[3]!.label).toStartWith("Option D:");
    expect(paneWrapRisk(t)).toBe(true);
    expect(isLossyAskPane(t)).toBe(true);
  });

  test("v284_preview: clean labels, focused option's preview set + truncated, lossy because of the ✂ marker", () => {
    const t = fx("v284_preview");
    const p = parseModalPane(t)!;
    expect(p.flatHeader).toBe("Layout");
    expect(p.options.map((o) => o.label)).toEqual(["Sidebar", "Topbar", "Tabs"]);
    expect(p.cursorIndex).toBe(0);
    expect(p.options[0]!.preview).toBeTruthy();
    expect(p.options[0]!.previewTruncated).toBe(true);
    expect(p.options[1]!.preview).toBeUndefined();
    expect(p.options[2]!.preview).toBeUndefined();
    expect(p.complete).toBe(true);
    // Not a wrap problem — the collapse marker alone makes it lossy.
    expect(paneWrapRisk(t)).toBe(false);
    expect(isLossyAskPane(t)).toBe(true);
  });

  test("v284_tabbar_scrolled_off: parses 4 options but is incomplete (no ☐/tab bar) and lossy", () => {
    const t = fx("v284_tabbar_scrolled_off");
    const p = parseModalPane(t)!;
    expect(p).not.toBeNull();
    expect(p.options).toHaveLength(4);
    expect(p.multiSelect).toBe(true);
    expect(p.complete).toBe(false);
    expect(isLossyAskPane(t)).toBe(true);
  });

  test("v284_footer_wrapped: parses (wrapped footer) with the cursor parked on the Type row", () => {
    const p = parseModalPane(fx("v284_footer_wrapped"))!;
    expect(p).not.toBeNull();
    expect(p.tabHeaders).toEqual(["Toppings", "Size", "Delivery"]);
    expect(p.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Mushrooms", "Olives"]);
    expect(p.options.map((o) => o.checked)).toEqual([true, true, false, false]);
    expect(p.cursorIndex).toBe(-1);
    expect(p.complete).toBe(true);
  });

  test("v284_typed_single_modal: the typed `purple` row is the Type row, NOT an option (cursor -1)", () => {
    const p = parseModalPane(fx("v284_typed_single_modal"))!;
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Blue", "Green"]);
    expect(p.cursorIndex).toBe(-1);
    expect(p.hasTypeRow).toBe(true);
    expect(p.complete).toBe(true);
  });

  test("v284_typed_multi: the typed, auto-checked `Peppers` row is the Type row, NOT an option", () => {
    const p = parseModalPane(fx("v284_typed_multi"))!;
    expect(p.multiSelect).toBe(true);
    expect(p.options.map((o) => o.label)).toEqual(["Cheese", "Ham", "Mushrooms", "Olives"]);
    expect(p.cursorIndex).toBe(-1);
    expect(p.hasTypeRow).toBe(true);
    expect(p.complete).toBe(true);
  });

  test("hasTypeRow per fixture: true for flat / multi tabs / footer_wrapped, false for the preview layout", () => {
    expect(parseModalPane(fx("v284_flat"))!.hasTypeRow).toBe(true);
    expect(parseModalPane(fx("v284_multi_tab1"))!.hasTypeRow).toBe(true);
    expect(parseModalPane(fx("v284_footer_wrapped"))!.hasTypeRow).toBe(true);
    expect(parseModalPane(fx("v284_preview"))!.hasTypeRow).toBe(false);
  });

  test("structural Type row: a numbered row right above the numbered `Chat about this` is excluded whatever its label", () => {
    const t = synthPane({
      question: ["Pick one?"],
      options: ["❯ 1. Alpha", "  2. Beta", "  3. Type something.", "  4. my own words"].slice(0, 3),
    }).replace("  9. Chat about this", "  4. Chat about this");
    const typed = t.replace("  3. Type something.", "  3. my own words");
    const p = parseModalPane(typed)!;
    expect(p.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    expect(p.hasTypeRow).toBe(true);
    // Label fallback (no numbered Chat row): `Type something` alone still counts.
    const noChat = t.replace("  4. Chat about this", "  Chat about this");
    const q = parseModalPane(noChat)!;
    expect(q.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    expect(q.hasTypeRow).toBe(true);
  });

  test("structural Type row: picks the NEAREST `chatNum - 1` row above `Chat about this`, never scrollback above the modal", () => {
    const modal = synthPane({
      question: ["Pick one?"],
      options: ["❯ 1. Alpha", "  2. Beta", "  3. my own words"],
    }).replace("  9. Chat about this", "  4. Chat about this");
    const p = parseModalPane(["  3. old item", "some earlier output", modal].join("\n"))!;
    expect(p).not.toBeNull();
    // The modal's own Type row (also numbered 3) is excluded ...
    expect(p.options.map((o) => o.label)).not.toContain("my own words");
    expect(p.hasTypeRow).toBe(true);
    // ... and the nearest-above rule never reaches the scrollback row to
    // exclude it in the Type row's place (the pre-fix `raw.find` did).
    expect(p.options.map((o) => o.label)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    const withoutScrollback = parseModalPane(modal)!;
    expect(withoutScrollback.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
  });

  test("v284_typed_single (post-decline screen) and v284_review do not parse as a question", () => {
    expect(parseModalPane(fx("v284_typed_single"))).toBeNull();
    expect(parseModalPane(fx("v284_review"))).toBeNull();
  });
});

describe("parseModalPane — question gutter + paragraphs", () => {
  test("a 3-row gutter question joins with single spaces and drops every `│`", () => {
    const p = parseModalPane(
      synthPane({
        question: ["│ first row of the", "│ second row of the", "│ third row"],
        options: ["❯ 1. A", "  2. B"],
      }),
    )!;
    expect(p.questionText).toBe("first row of the second row of the third row");
    expect(p.questionText).not.toContain("│");
    expect(p.complete).toBe(true);
  });

  test("a bare `│` row is a paragraph break → \\n between paragraphs", () => {
    const p = parseModalPane(
      synthPane({
        question: ["│ para one", "│", "│ para two"],
        options: ["❯ 1. A", "  2. B"],
      }),
    )!;
    expect(p.questionText).toBe("para one\npara two");
  });

  test("a one-row question without a gutter is unchanged", () => {
    const p = parseModalPane(
      synthPane({ question: ["Just one row?"], options: ["❯ 1. A", "  2. B"] }),
    )!;
    expect(p.questionText).toBe("Just one row?");
  });
});

describe("parseModalPane — OPTION_RE anchoring, edge markers, answered suffix", () => {
  test("a 5-space-indented `2. …` description row is NOT an option", () => {
    const p = parseModalPane(
      synthPane({
        question: ["Pick one?"],
        options: ["❯ 1. first", "     2. second thing", "  2. Type something."],
      }),
    )!;
    expect(p.options).toHaveLength(1);
    expect(p.options[0]!.label).toBe("first");
    expect(p.options[0]!.description).toBe("2. second thing");
  });

  test("a `↓ 5. Fifth` edge-marker row parses as an option, marks windowed, and is incomplete", () => {
    const p = parseModalPane(
      synthPane({
        question: ["Pick one?"],
        options: ["❯ 1. A", "  2. B", "  3. C", "  4. D", "↓ 5. Fifth"],
      }),
    )!;
    expect(p.options.map((o) => o.label)).toEqual(["A", "B", "C", "D", "Fifth"]);
    expect(p.windowed).toBe(true);
    expect(p.complete).toBe(false);
  });

  test("a trailing ` ✔` answered-suffix is stripped from the label", () => {
    const p = parseModalPane(
      synthPane({
        question: ["Pick one?"],
        options: ["  1. A", "  2. B", "  3. Chosen ✔"],
      }),
    )!;
    expect(p.options.map((o) => o.label)).toEqual(["A", "B", "Chosen"]);
  });
});

describe("parseModalPane — Next/Submit rows are never descriptions", () => {
  const tabBar = "←  ☐ Type  ✔ Submit  →";

  test("a `Submit` row under the Type row gives no option a description", () => {
    const p = parseModalPane(
      synthPane({
        header: tabBar,
        question: ["Pick some?"],
        options: [
          "❯ 1. [ ] A",
          "         desc a",
          "  2. [ ] B",
          "         desc b",
          "  3. [ ] Type something",
          "     Submit",
        ],
      }),
    )!;
    expect(p.multiSelect).toBe(true);
    expect(p.options.map((o) => o.label)).toEqual(["A", "B"]);
    expect(p.options.map((o) => o.description)).toEqual(["desc a", "desc b"]);
    for (const o of p.options) expect(o.description ?? "").not.toContain("Submit");
  });

  test("a `Next`/`Submit` row directly under a real option is noise, not its description", () => {
    for (const row of ["     Next", "     Submit"]) {
      const p = parseModalPane(
        synthPane({
          header: tabBar,
          question: ["Pick some?"],
          options: ["❯ 1. [ ] A", "  2. [ ] B", row],
        }),
      )!;
      expect(p.options[1]!.label).toBe("B");
      expect(p.options[1]!.description).toBeUndefined();
    }
  });
});

describe("parseModalPane — `complete` verdict over every pre-2.1.284 fixture", () => {
  const table: Array<[string, boolean]> = [
    ["single_select", true],
    ["single_with_other", true],
    ["single_wrapped_question", true],
    ["multi_initial_toppings", true],
    ["multi_size_tab", true],
    ["multi_toppings_toggled", true],
    ["multi_preview_panel", true],
    ["single_preview_full", true],
    ["single_preview_truncated", true],
    ["truncated_top", false],
  ];
  for (const [name, expected] of table) {
    test(`${name} → complete: ${expected}`, () => {
      expect(parseModalPane(fx(name))!.complete).toBe(expected);
    });
  }
});

describe("paneWrapRisk", () => {
  test("false for v284_flat — near-edge gutter question rows are excluded", () => {
    expect(paneWrapRisk(fx("v284_flat"))).toBe(false);
  });

  test("true for v284_longopts", () => {
    expect(paneWrapRisk(fx("v284_longopts"))).toBe(true);
  });

  test("false when the pane has no full-width `─` rule (no width to measure)", () => {
    const long = "x".repeat(70);
    const pane = [
      " ☐ Q",
      "",
      "Pick one?",
      "",
      `❯ 1. ${long}`,
      "  2. B",
      "  3. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(paneWrapRisk(pane)).toBe(false);
  });
});

describe("paneWrapRisk — long-token wrap and scrollback", () => {
  test("a label well short of the edge whose continuation starts with a long path wraps early (Ink wraps at the word)", () => {
    // 52-col row + 1 + 49-char path > 80: the path could not fit, so Ink wrapped
    // it onto the next line even though the row is far from the right edge.
    const pane = synthPane({
      question: ["Which file should the helper live in?"],
      options: [
        "❯ 1. Edit the shared prompt helper that lives at",
        "     src/mainview/components/kanban/PromptComposer.tsx",
        "  2. Create a new file",
      ],
    });
    expect("❯ 1. Edit the shared prompt helper that lives at".length).toBeLessThan(68);
    expect(paneWrapRisk(pane)).toBe(true);
    expect(isLossyAskPane(pane)).toBe(true);
  });

  test("the same continuation is NOT a wrap when the row + word would have fit on one line", () => {
    const pane = synthPane({
      question: ["Which file?"],
      options: ["❯ 1. Edit the helper at", "     src/mainview/components/kanban/PromptComposer.tsx", "  2. Other"],
    });
    expect(paneWrapRisk(pane)).toBe(false);
  });

  test("a short label with a normal short description is not a wrap risk", () => {
    const pane = synthPane({
      question: ["Which one?"],
      options: ["❯ 1. Red", "     Bold and energetic", "  2. Blue", "     Calm"],
    });
    expect(paneWrapRisk(pane)).toBe(false);
  });

  test("v284_flat stays false", () => {
    expect(paneWrapRisk(fx("v284_flat"))).toBe(false);
  });

  test("a full-width numbered list in the scrollback above the modal's rule is ignored", () => {
    const scrollback = [
      "  1. " + "word ".repeat(16).trim(),
      "  2. " + "word ".repeat(16).trim(),
      "",
    ].join("\n");
    const pane = scrollback + "\n" + synthPane({
      question: ["Pick?"],
      options: ["❯ 1. Red", "  2. Blue"],
    });
    expect(scrollback.split("\n")[0]!.length).toBeGreaterThan(68);
    expect(paneWrapRisk(pane)).toBe(false);
  });
});

describe("formatAnswersMessage — single-select custom wins", () => {
  test("single-select: only the custom text; multi-select keeps picks + custom", () => {
    const specs: AskQuestionSpec[] = [
      { question: "Color?", multiSelect: false, options: ["Red", "Blue"] },
      { question: "Toppings?", multiSelect: true, options: ["Ham", "Olives"] },
    ];
    const msg = formatAnswersMessage(specs, [
      { selected: ["Red"], custom: "purple" },
      { selected: ["Ham"], custom: "peppers" },
    ]);
    expect(msg).toBe('Here are my answers: "Color?"="purple", "Toppings?"="Ham, peppers".');
  });
});

describe("planAskAnswers — hasTypeRow and unsafe custom text", () => {
  const spec = (hasTypeRow?: boolean, multiSelect = false): AskQuestionSpec => ({
    question: "q", multiSelect, options: ["A", "B"], ...(hasTypeRow !== undefined ? { hasTypeRow } : {}),
  });

  test("custom answer for a question with no Type row → message mode `no-type-row` (single and multi)", () => {
    for (const multi of [false, true]) {
      const plan = planAskAnswers([spec(false, multi)], [{ selected: [], custom: "purple" }]);
      expect(plan.mode).toBe("message");
      if (plan.mode === "message") {
        expect(plan.reason).toBe("no-type-row");
        expect(plan.text).toContain("purple");
      }
    }
  });

  test("no Type row but a pick only → still driven; hasTypeRow true/undefined → typed", () => {
    expect(planAskAnswers([spec(false)], [{ selected: ["B"] }])).toEqual({
      mode: "drive", steps: ["Down", "Enter"], confirmsReview: false,
    });
    for (const h of [true, undefined]) {
      const plan = planAskAnswers([spec(h)], [{ selected: [], custom: "purple" }]);
      expect(plan.mode).toBe("drive");
    }
  });

  test("control characters in custom text → `unsafe-custom` (tab, ESC, DEL, C1)", () => {
    for (const bad of ["a\tb", "a\u001bb", "a\u007fb", "a\u0085b", "a\u0000b"]) {
      const plan = planAskAnswers([spec()], [{ selected: [], custom: bad }]);
      expect(plan.mode).toBe("message");
      if (plan.mode === "message") expect(plan.reason).toBe("unsafe-custom");
    }
  });

  test("a newline still reports multiline-custom (checked before unsafe-custom)", () => {
    const plan = planAskAnswers([spec()], [{ selected: [], custom: "a\nb\tc" }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("multiline-custom");
  });
});

describe("planAskAnswers — 2.1.284 typed custom answers", () => {
  const single = (options: string[]): AskQuestionSpec => ({ question: "q", multiSelect: false, options });
  const multi = (options: string[]): AskQuestionSpec => ({ question: "q", multiSelect: true, options });

  test("single flat question with a custom answer: Down × options, type, Enter (no review)", () => {
    const plan = planAskAnswers(
      [single(["Red", "Blue", "Green"])],
      [{ selected: [], custom: "purple" }],
    );
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Down", "Down", { type: "text", text: "purple" }, "Enter"],
      confirmsReview: false,
    });
  });

  test("single flat question with a pick AND a custom answer: custom wins (same steps)", () => {
    const withPick = planAskAnswers(
      [single(["Red", "Blue", "Green"])],
      [{ selected: ["Blue"], custom: "purple" }],
    );
    const customOnly = planAskAnswers(
      [single(["Red", "Blue", "Green"])],
      [{ selected: [], custom: "purple" }],
    );
    expect(withPick).toEqual(customOnly);
    expect(withPick).toEqual({
      mode: "drive",
      steps: ["Down", "Down", "Down", { type: "text", text: "purple" }, "Enter"],
      confirmsReview: false,
    });
  });

  test("three-question mix: single pick, multi picks + custom, single custom → one review Enter", () => {
    const specs: AskQuestionSpec[] = [
      single(["A", "B", "C"]),
      multi(["P", "Q", "R", "S"]),
      single(["X", "Y"]),
    ];
    const plan = planAskAnswers(specs, [
      { selected: ["B"] },
      { selected: ["P", "R"], custom: "custom two" },
      { selected: [], custom: "custom three" },
    ]);
    expect(plan).toEqual({
      mode: "drive",
      steps: [
        // Q1: idx 1
        "Down", "Enter",
        // Q2: toggle idx 0, toggle idx 2 (cursor now 2), Down × (4 − 2) onto the Type row, type, Down to Next, Enter
        "Enter", "Down", "Down", "Enter",
        "Down", "Down", { type: "text", text: "custom two" }, "Down", "Enter",
        // Q3: Down × 2 options, type, Enter (auto-advance to review)
        "Down", "Down", { type: "text", text: "custom three" }, "Enter",
        // review
        "Enter",
      ],
      confirmsReview: true,
    });
  });

  test("single multiSelect question with picks only ends Right, Enter and confirms the review", () => {
    const plan = planAskAnswers([multi(["A", "B", "C"])], [{ selected: ["B"] }]);
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Enter", "Right", "Enter"],
      confirmsReview: true,
    });
    if (plan.mode === "drive") expect(plan.steps.slice(-2)).toEqual(["Right", "Enter"]);
  });

  test("single multiSelect question with a custom answer only: Down × options, type, Down, Enter, review Enter", () => {
    const plan = planAskAnswers([multi(["A", "B", "C"])], [{ selected: [], custom: "extra" }]);
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", "Down", "Down", { type: "text", text: "extra" }, "Down", "Enter", "Enter"],
      confirmsReview: true,
    });
  });

  test("custom text containing a newline → message mode, reason multiline-custom", () => {
    const plan = planAskAnswers([single(["A", "B"])], [{ selected: [], custom: "line one\nline two" }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("multiline-custom");
  });

  test("custom text over ASK_TYPED_ANSWER_MAX_CHARS → custom-too-long; exactly the max is driven", () => {
    expect(ASK_TYPED_ANSWER_MAX_CHARS).toBe(400);
    const over = planAskAnswers(
      [single(["A", "B"])],
      [{ selected: [], custom: "x".repeat(ASK_TYPED_ANSWER_MAX_CHARS + 1) }],
    );
    expect(over.mode).toBe("message");
    if (over.mode === "message") expect(over.reason).toBe("custom-too-long");

    const exact = "x".repeat(ASK_TYPED_ANSWER_MAX_CHARS);
    const ok = planAskAnswers([single(["A", "B"])], [{ selected: [], custom: exact }]);
    expect(ok).toEqual({
      mode: "drive",
      steps: ["Down", "Down", { type: "text", text: exact }, "Enter"],
      confirmsReview: false,
    });
  });

  test("whitespace-only custom with no pick → empty-answer", () => {
    const plan = planAskAnswers([single(["A", "B"])], [{ selected: [], custom: "   " }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("empty-answer");
  });

  test("whitespace-only custom alongside a pick is treated as absent: normal pick drive", () => {
    const plan = planAskAnswers([single(["A", "B"])], [{ selected: ["B"], custom: "  \t " }]);
    expect(plan).toEqual({ mode: "drive", steps: ["Down", "Enter"], confirmsReview: false });
  });

  test("custom text is trimmed before it is typed", () => {
    const plan = planAskAnswers([single(["A"])], [{ selected: [], custom: "  padded  " }]);
    expect(plan).toEqual({
      mode: "drive",
      steps: ["Down", { type: "text", text: "padded" }, "Enter"],
      confirmsReview: false,
    });
  });

  test("multiSelect question with a custom answer but an unknown selected label → unknown-option", () => {
    const plan = planAskAnswers(
      [multi(["A", "B"])],
      [{ selected: ["Nope"], custom: "extra" }],
    );
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("unknown-option");
  });
});
