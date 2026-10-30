import { describe, expect, test } from "bun:test";
import {
  cursorAskAnswersFromLabels,
  cursorAskFromToolUse,
  cursorAskPlainLines,
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
});
