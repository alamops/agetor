// The OpenCode permission and question cards: request bodies (reason sent,
// omitted, trimmed; skip with and without a message), the single-select
// option-XOR-text rule, and the client calls that carry them.
import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api.ts";
import {
  emptyOpencodeDrafts,
  opencodeAnswerBody,
  opencodeAnswerSummary,
  opencodeCanSubmit,
  opencodePermissionBody,
  opencodeSetCustom,
  opencodeSkipBody,
  opencodeTogglePick,
  type OpencodeQuestionShape,
} from "./opencode-interactions.ts";

const single: OpencodeQuestionShape = {
  multiSelect: false,
  allowCustom: true,
  options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
};
const multi: OpencodeQuestionShape = {
  multiSelect: true,
  allowCustom: true,
  options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
};
const noCustom: OpencodeQuestionShape = {
  multiSelect: false,
  options: [{ id: "a", label: "Alpha" }],
};

describe("opencodePermissionBody", () => {
  test("reject with a typed reason sends it, trimmed", () => {
    expect(opencodePermissionBody("reject", "  too risky \n")).toEqual({ optionId: "reject", message: "too risky" });
  });
  test("reject with an empty or blank reason sends no message at all", () => {
    expect(opencodePermissionBody("reject", "")).toEqual({ optionId: "reject" });
    expect(opencodePermissionBody("reject", "  \n\t ")).toEqual({ optionId: "reject" });
    expect(Object.hasOwn(opencodePermissionBody("reject", ""), "message")).toBe(false);
  });
  test("a reason never rides with an allow option", () => {
    expect(opencodePermissionBody("once", "leftover")).toEqual({ optionId: "once" });
    expect(opencodePermissionBody("always", "leftover")).toEqual({ optionId: "always" });
  });
  test("the text is the user's own, byte for byte inside the trim", () => {
    expect(opencodePermissionBody("reject", "use  `ls`\n  instead")).toEqual({
      optionId: "reject",
      message: "use  `ls`\n  instead",
    });
  });
});

describe("opencodeSkipBody", () => {
  test("skip without a reason is just { skip: true }", () => {
    expect(opencodeSkipBody("")).toEqual({ skip: true });
    expect(opencodeSkipBody("   ")).toEqual({ skip: true });
    expect(opencodeSkipBody(undefined)).toEqual({ skip: true });
    expect(opencodeSkipBody(null)).toEqual({ skip: true });
  });
  test("skip with a reason carries it, trimmed", () => {
    expect(opencodeSkipBody("  not now ")).toEqual({ skip: true, message: "not now" });
  });
});

describe("single-select: an option or typed text, never both", () => {
  test("picking an option clears typed text", () => {
    expect(opencodeTogglePick({ selected: [], custom: "my own" }, "a", false)).toEqual({ selected: ["a"], custom: "" });
  });
  test("typing clears the picked option", () => {
    expect(opencodeSetCustom({ selected: ["a"], custom: "" }, "my own", false)).toEqual({ selected: [], custom: "my own" });
  });
  test("clearing the text box keeps the pick", () => {
    expect(opencodeSetCustom({ selected: ["a"], custom: "" }, "", false)).toEqual({ selected: ["a"], custom: "" });
  });
  test("re-picking another option replaces the first", () => {
    expect(opencodeTogglePick({ selected: ["a"], custom: "" }, "b", false)).toEqual({ selected: ["b"], custom: "" });
  });
  test("the answer body never carries both, even from a hand-built draft", () => {
    const { answers } = opencodeAnswerBody([single], [{ selected: ["a"], custom: "typed" }]);
    expect(answers).toEqual([{ selected: [], custom: "typed" }]);
  });
  test("an option answer carries ids and no custom key", () => {
    const { answers } = opencodeAnswerBody([single], [{ selected: ["b"], custom: "" }]);
    expect(answers).toEqual([{ selected: [], selectedOptionIds: ["b"] }]);
    expect(Object.hasOwn(answers[0]!, "custom")).toBe(false);
  });
});

describe("multi-select keeps picks and typed text together", () => {
  test("toggling adds and removes; typing does not clear picks", () => {
    let d = emptyOpencodeDrafts([multi])[0]!;
    d = opencodeTogglePick(d, "a", true);
    d = opencodeTogglePick(d, "b", true);
    d = opencodeSetCustom(d, "and more", true);
    expect(d).toEqual({ selected: ["a", "b"], custom: "and more" });
    d = opencodeTogglePick(d, "a", true);
    expect(d.selected).toEqual(["b"]);
    expect(opencodeAnswerBody([multi], [d]).answers).toEqual([{ selected: [], selectedOptionIds: ["b"], custom: "and more" }]);
  });
});

describe("fields that do not take typed text", () => {
  test("typed text is dropped from the body and does not make the field answerable", () => {
    expect(opencodeCanSubmit([noCustom], [{ selected: [], custom: "typed" }])).toBe(false);
    expect(opencodeAnswerBody([noCustom], [{ selected: ["a"], custom: "typed" }]).answers).toEqual([
      { selected: [], selectedOptionIds: ["a"] },
    ]);
  });
});

describe("submit gating and summary", () => {
  test("every question needs a pick or typed text", () => {
    const drafts = emptyOpencodeDrafts([single, multi]);
    expect(opencodeCanSubmit([single, multi], drafts)).toBe(false);
    drafts[0] = { selected: ["a"], custom: "" };
    expect(opencodeCanSubmit([single, multi], drafts)).toBe(false);
    drafts[1] = { selected: [], custom: "  words " };
    expect(opencodeCanSubmit([single, multi], drafts)).toBe(true);
  });
  test("the review summary names labels and typed text", () => {
    expect(opencodeAnswerSummary(multi, { selected: ["a", "b"], custom: "x" })).toBe("Alpha, Beta, x");
    expect(opencodeAnswerSummary(single, { selected: ["a"], custom: "typed" })).toBe("typed");
    expect(opencodeAnswerSummary(single, { selected: [], custom: "" })).toBe("(no answer)");
  });
});

describe("the client calls put the bodies on the wire", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function capture(): Array<{ url: string; body: unknown }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return calls;
  }

  test("reject with a reason and reject without one", async () => {
    const calls = capture();
    await api.answerFxPermission("p1", opencodePermissionBody("reject", " nope "));
    await api.answerFxPermission("p1", opencodePermissionBody("reject", ""));
    expect(calls.map((c) => c.body)).toEqual([{ optionId: "reject", message: "nope" }, { optionId: "reject" }]);
    expect(calls[0]!.url).toContain("/fx-permissions/p1/answer");
  });

  test("an fx answer is still just { optionId }", async () => {
    const calls = capture();
    await api.answerFxPermission("p2", { optionId: "allow_once" });
    expect(calls[0]!.body).toEqual({ optionId: "allow_once" });
  });

  test("skip with and without a reason", async () => {
    const calls = capture();
    await api.skipAskQuestions("q1", " later ");
    await api.skipAskQuestions("q1", "  ");
    await api.skipAskQuestions("q1");
    expect(calls.map((c) => c.body)).toEqual([{ skip: true, message: "later" }, { skip: true }, { skip: true }]);
    expect(calls[0]!.url).toContain("/ask-questions/q1/answer");
  });

  test("a typed single-select answer reaches the answer route", async () => {
    const calls = capture();
    await api.answerAskQuestions("q2", opencodeAnswerBody([single], [{ selected: [], custom: " typed " }]));
    expect(calls[0]!.body).toEqual({ answers: [{ selected: [], custom: "typed" }] });
  });
});
