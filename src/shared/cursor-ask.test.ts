import { describe, expect, test } from "bun:test";
import {
  cursorAskAnswersFromLabels,
  cursorAskCanAdvance,
  cursorAskCardHeading,
  cursorAskFromToolUse,
  cursorAskOptionChoiceLabel,
  cursorAskPicksFromValues,
  cursorAskPlainLines,
  cursorAskToolBanner,
  cursorAskToolFooter,
  cursorAskWireCustom,
  formatCursorAskFollowup,
  questionText,
} from "./cursor-ask.ts";

const questions = [
  {
    id: "q1",
    multiSelect: false,
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "a2", label: "Alpha" },
    ],
  },
  {
    id: "q2",
    multiSelect: true,
    options: [
      { id: "c", label: "Gamma" },
      { id: "d", label: "Delta" },
    ],
  },
];

describe("questionText", () => {
  test("prompt wins over promptMarkdown", () => {
    expect(questionText("plain", "# md")).toBe("plain");
  });

  test("empty prompt falls through to promptMarkdown", () => {
    expect(questionText("", "# md")).toBe("# md");
    expect(questionText(undefined, "only md")).toBe("only md");
  });

  test("both empty is an empty string", () => {
    expect(questionText("", "")).toBe("");
    expect(questionText(null, null)).toBe("");
  });
});

describe("cursorAskFromToolUse", () => {
  test("reads the pinned envelope", () => {
    const view = cursorAskFromToolUse({
      id: "call-1",
      name: "askQuestionToolCall",
      input: {
        askQuestionToolCall: {
          args: {
            title: "Pick",
            questions: [{
              id: "q1",
              prompt: "",
              promptMarkdown: "Which?",
              allowMultiple: false,
              options: [{ id: "a", label: "Alpha" }],
            }],
          },
        },
        toolCallId: "call-1",
      },
    });
    expect(view).toEqual({
      title: "Pick",
      toolCallId: "call-1",
      questions: [{
        id: "q1",
        prompt: "",
        promptMarkdown: "Which?",
        text: "Which?",
        allowMultiple: false,
        options: [{ id: "a", label: "Alpha" }],
      }],
    });
  });

  test("rejects a different tool", () => {
    expect(cursorAskFromToolUse({ name: "Bash", input: {} })).toBeNull();
  });
});

describe("cursorAskAnswersFromLabels", () => {
  test("duplicate labels bind in order", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Alpha", "Alpha"] }, { selected: ["Gamma"] }],
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.answers[0]).toEqual({ questionId: "q1", selectedOptionIds: ["a", "a2"] });
    expect(mapped.answers[1]).toEqual({ questionId: "q2", selectedOptionIds: ["c"] });
  });

  test("an explicit id selects the second option that shares a label", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Alpha"], selectedOptionIds: ["a2"] }, { selected: [] }],
    );
    expect(mapped).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: ["a2"] },
        { questionId: "q2", selectedOptionIds: [] },
      ],
    });
  });

  test("freeformText single-select custom clears ids", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"], custom: "typed" }, { selected: ["Delta"] }],
      "freeformText",
    );
    expect(mapped).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: [], freeformText: "typed" },
        { questionId: "q2", selectedOptionIds: ["d"] },
      ],
    });
  });

  test("freeformText multi-select custom keeps ids", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"] }, { selected: ["Gamma"], custom: "also" }],
      "freeformText",
    );
    expect(mapped).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: ["b"] },
        { questionId: "q2", selectedOptionIds: ["c"], freeformText: "also" },
      ],
    });
  });

  test("freeformOther keeps ids and adds the synthetic option", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"], custom: "typed" }, { selected: ["Gamma"], custom: "more" }],
      "freeformOther",
    );
    expect(mapped).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: ["b", "__freeform_other__"], freeformText: "typed" },
        { questionId: "q2", selectedOptionIds: ["c", "__freeform_other__"], freeformText: "more" },
      ],
    });
  });

  test("unsupported refuses a custom answer and still maps option picks", () => {
    const refused = cursorAskAnswersFromLabels(
      questions,
      [{ selected: [], custom: "only" }, { selected: [] }],
      "unsupported",
    );
    expect(refused.ok).toBe(false);
    const picked = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"] }, { selected: ["Delta"] }],
      "unsupported",
    );
    expect(picked).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: ["b"] },
        { questionId: "q2", selectedOptionIds: ["d"] },
      ],
    });
  });

  test("unsupported drops leftover single-select custom text when an option is selected", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"], custom: "still typed" }, { selected: ["Delta"] }],
      "unsupported",
    );
    expect(mapped).toEqual({
      ok: true,
      answers: [
        { questionId: "q1", selectedOptionIds: ["b"] },
        { questionId: "q2", selectedOptionIds: ["d"] },
      ],
    });
  });

  test("unsupported refuses multi-select custom text even when options are selected", () => {
    const mapped = cursorAskAnswersFromLabels(
      questions,
      [{ selected: ["Beta"] }, { selected: ["Gamma", "Delta"], custom: "also" }],
      "unsupported",
    );
    expect(mapped).toEqual({
      ok: false,
      error: "Cursor cannot accept a custom answer — pick an option",
    });
  });
});

describe("formatCursorAskFollowup", () => {
  test("names the mapped option and keeps freeform only when the mapper did", () => {
    expect(formatCursorAskFollowup(
      [{ question: "Which?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
      [{ questionId: "q1", selectedOptionIds: ["b"] }],
    )).toBe('Here are my answers: "Which?"="Beta".');
    expect(formatCursorAskFollowup(
      [{ question: "Which?", options: [{ id: "b", label: "Beta" }] }],
      [{ questionId: "q1", selectedOptionIds: [], freeformText: "typed" }],
    )).toBe('Here are my answers: "Which?"="typed".');
    expect(formatCursorAskFollowup(
      [{ question: "Which?", options: [{ id: "b", label: "Beta" }] }],
      [{ questionId: "q1", selectedOptionIds: ["b", "__freeform_other__"], freeformText: "typed" }],
    )).toBe('Here are my answers: "Which?"="Beta, typed".');
  });

  test("a shared label keeps the option id the card selected", () => {
    const options = [
      { id: "a", label: "Alpha" },
      { id: "a2", label: "Alpha" },
    ];
    expect(formatCursorAskFollowup(
      [{ question: "Which?", options }],
      [{ questionId: "q1", selectedOptionIds: ["a2"] }],
    )).toBe('Here are my answers: "Which?"="Alpha (a2)".');
    expect(formatCursorAskFollowup(
      [{ question: "Which?", options }],
      [{ questionId: "q1", selectedOptionIds: ["a", "a2"] }],
    )).toBe('Here are my answers: "Which?"="Alpha (a), Alpha (a2)".');
  });
});

describe("cursorAskPlainLines", () => {
  test("title and two questions", () => {
    expect(cursorAskPlainLines({
      title: "Ship it?",
      questions: [
        { text: "Which branch?", options: [{ label: "main" }, { label: "dev" }] },
        { prompt: "", promptMarkdown: "Who reviews?", options: [{ label: "Ada" }] },
      ],
    })).toEqual([
      "Ship it?",
      "Which branch?",
      "  main",
      "  dev",
      "Who reviews?",
      "  Ada",
    ]);
  });

  test("a duplicated option label keeps its id", () => {
    expect(cursorAskPlainLines({
      questions: [{
        text: "Which Alpha?",
        options: [
          { id: "a", label: "Alpha" },
          { id: "a2", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      }],
    })).toEqual([
      "Which Alpha?",
      "  Alpha (a)",
      "  Alpha (a2)",
      "  Beta",
    ]);
  });
});

describe("cursor ask copy and duplicate labels", () => {
  test("a dead agent does not reuse the restart heading or the waiting line", () => {
    expect(cursorAskCardHeading("live")).toBe("Cursor is waiting");
    expect(cursorAskCardHeading("restart-followup", "child-exit")).toBe("Cursor's wait ended when the agent exited");
    expect(cursorAskCardHeading("restart-followup", "restart")).toBe("Cursor's wait ended when Agetor restarted");
    expect(cursorAskCardHeading("restart-followup")).toBe("Cursor's wait ended when Agetor restarted");
    expect(cursorAskToolBanner("live")).toBe("Cursor is waiting — answer it in the card above.");
    expect(cursorAskToolBanner("restart-followup", "child-exit")).toBe(
      "Cursor's wait ended when the agent exited — answer it in the card above.",
    );
    expect(cursorAskToolBanner(undefined)).toBe("Cursor is waiting — answer it in the card above.");
    expect(cursorAskToolFooter(undefined)).toBeNull();
    expect(cursorAskToolFooter({ delivery: "live" })).toBe("Cursor is waiting — answer it in the card above.");
    expect(cursorAskToolFooter({ delivery: "restart-followup", followupCause: "child-exit" })).toBe(
      "Cursor's wait ended when the agent exited — answer it in the card above.",
    );
    expect(cursorAskToolFooter({ delivery: "restart-followup" })).toBe(
      "Cursor's wait ended when Agetor restarted — answer it in the card above.",
    );
  });

  test("picker values keep the second shared label", () => {
    const options = [
      { id: "a", label: "Alpha" },
      { id: "a2", label: "Alpha" },
    ];
    expect(cursorAskOptionChoiceLabel(options[1]!, options)).toBe("Alpha (a2)");
    expect(cursorAskPicksFromValues(options, ["a2"])).toEqual({
      selected: ["Alpha"],
      selectedOptionIds: ["a2"],
    });
    expect(cursorAskPicksFromValues([{ label: "Alpha" }], ["Alpha"])).toEqual({ selected: ["Alpha"] });
  });

  test("unsupported freeform blocks a multi-select note and keeps a single-select option", () => {
    const single = [{ multiSelect: false }];
    const multi = [{ multiSelect: true }];
    expect(cursorAskCanAdvance(single, [{ selected: [], custom: "typed" }], "unsupported")).toBe(false);
    expect(cursorAskCanAdvance(single, [{ selected: ["a"], custom: "typed" }], "unsupported")).toBe(true);
    expect(cursorAskCanAdvance(multi, [{ selected: ["a"], custom: "typed" }], "unsupported")).toBe(false);
    expect(cursorAskCanAdvance(multi, [{ selected: ["a"], custom: "" }], "unsupported")).toBe(true);
    expect(cursorAskWireCustom(false, " typed ", "unsupported")).toBeUndefined();
    expect(cursorAskWireCustom(true, " typed ", "unsupported")).toBe("typed");
    expect(cursorAskWireCustom(true, " typed ", "freeformText")).toBe("typed");
  });
});
