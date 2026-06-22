import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  detectAskModal,
  formatAnswersMessage,
  isTabbedAskModal,
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
  });

  test("flat single-select with Other (Name): excludes 'Type something' + 'Chat about this'", () => {
    const p = parseModalPane(fx("single_with_other"))!;
    expect(p.questionText).toBe("What is your name?");
    expect(p.options.map((o) => o.label)).toEqual(["Alice", "Bob"]);
    expect(p.multiSelect).toBe(false);
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
      "──────────────────────────────────────",
      "  3. Chat about this",
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
  });

  test("tabbed single-select tab (Size): same tab bar, no checkboxes", () => {
    const p = parseModalPane(fx("multi_size_tab"))!;
    expect(p.tabbed).toBe(true);
    expect(p.tabHeaders).toEqual(["Toppings", "Size"]);
    expect(p.questionText).toBe("Pick a size");
    expect(p.multiSelect).toBe(false);
    expect(p.options.map((o) => o.label)).toEqual(["Small", "Large"]);
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
    expect(plan).toEqual({ mode: "drive", keys: ["Down", "Enter"] });
  });

  test("first option of a flat single-select needs no arrow", () => {
    const plan = planAskAnswers(
      [{ question: "q", multiSelect: false, options: ["Red", "Green"] }],
      [{ selected: ["Red"] }],
    );
    expect(plan).toEqual({ mode: "drive", keys: ["Enter"] });
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
      keys: ["Down", "Enter", "Down", "Enter", "Right", "Down", "Enter", "Enter"],
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
      keys: ["Enter", "Down", "Down", "Enter", "Right", "Enter"],
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
      keys: ["Down", "Enter", "Down", "Down", "Enter", "Right", "Enter"],
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
      keys: ["Down", "Enter", "Down", "Down", "Enter", "Enter"],
    });
  });
});

describe("planAskAnswers — message fallbacks", () => {
  const specs: AskQuestionSpec[] = [
    { question: "Which color?", multiSelect: false, options: ["Red", "Green", "Blue"] },
  ];

  test("custom/free-text answer falls back to message mode", () => {
    const plan = planAskAnswers(specs, [{ selected: [], custom: "Magenta" }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") {
      expect(plan.reason).toBe("custom-text");
      expect(plan.text).toContain("Magenta");
      expect(plan.text).toContain("Which color?");
    }
  });

  test("custom text alongside a pick still falls back (can't mix)", () => {
    const plan = planAskAnswers(specs, [{ selected: ["Red"], custom: "or maybe pink" }]);
    expect(plan.mode).toBe("message");
    if (plan.mode === "message") expect(plan.reason).toBe("custom-text");
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
