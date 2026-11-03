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

// ── OpenCode cards ───────────────────────────────────────────────────────

import type { AnyRequest, AskQuestion } from "../bun/interactions.ts";
import {
  answerFlagsError,
  buildOpencodeAnswer,
  buildOpencodeAnswerByIndex,
  parseAnswerArgs,
  planOpencodePermissionReply,
} from "./answer-logic.ts";

const ocPerm = { kind: "fx_permission", id: "p", taskId: "t", runId: "r", createdAt: 0, toolCall: { toolCallId: "c" }, options: [], mode: "ask", harness: "opencode", allowReason: true } as AnyRequest;
const fxPerm = { kind: "fx_permission", id: "p", taskId: "t", runId: "r", createdAt: 0, toolCall: { toolCallId: "c" }, options: [], mode: "ask" } as AnyRequest;
const ocAsk = { kind: "ask_questions", id: "q", taskId: "t", runId: "r", createdAt: 0, questions: [], source: "opencode", allowReason: true } as AnyRequest;
const claudeAsk = { kind: "ask_questions", id: "q", taskId: "t", runId: "r", createdAt: 0, questions: [] } as AnyRequest;

test("parseAnswerArgs: ref, --reason value and --skip, in any order", () => {
  expect(parseAnswerArgs(["abcd"])).toEqual({ ref: "abcd", skip: false });
  expect(parseAnswerArgs(["--reason", "too risky", "abcd"])).toEqual({ ref: "abcd", reason: "too risky", skip: false });
  expect(parseAnswerArgs(["abcd", "--skip", "--reason", "n/a"])).toEqual({ ref: "abcd", reason: "n/a", skip: true });
  expect(() => parseAnswerArgs(["abcd", "--reason"])).toThrow("'--reason' needs a value");
  expect(() => parseAnswerArgs(["abcd", "--reason", "--skip"])).toThrow("'--reason' needs a value");
});

test("answerFlagsError: no flags is always fine", () => {
  for (const req of [ocPerm, fxPerm, ocAsk, claudeAsk]) expect(answerFlagsError([req], { skip: false })).toBeNull();
});

test("answerFlagsError: --reason is for OpenCode permissions, and for OpenCode questions only with --skip", () => {
  expect(answerFlagsError([ocPerm], { reason: "no", skip: false })).toBeNull();
  expect(answerFlagsError([ocAsk], { reason: "n/a", skip: true })).toBeNull();
  expect(answerFlagsError([fxPerm], { reason: "no", skip: false })).toContain("only to an OpenCode permission");
  expect(answerFlagsError([claudeAsk], { reason: "no", skip: false })).toContain("only to an OpenCode permission");
  expect(answerFlagsError([ocAsk], { reason: "n/a", skip: false })).toContain("needs --skip");
  expect(answerFlagsError([ocPerm], { reason: "no", skip: true })).toContain("--skip only skips an OpenCode question");
  // One card that cannot take it refuses the lot, before any is answered.
  expect(answerFlagsError([ocPerm, fxPerm], { reason: "no", skip: false })).not.toBeNull();
  expect(answerFlagsError([{ ...ocAsk, allowReason: false } as AnyRequest], { reason: "x", skip: true })).toContain("takes no reason");
});

test("answerFlagsError: --skip skips OpenCode questions only", () => {
  expect(answerFlagsError([ocAsk, ocAsk], { skip: true })).toBeNull();
  expect(answerFlagsError([claudeAsk], { skip: true })).toContain("only skips an OpenCode question");
  expect(answerFlagsError([ocAsk, ocPerm], { skip: true })).toContain("only skips an OpenCode question");
});

test("planOpencodePermissionReply: the reason rides Reject only; empty is omitted", () => {
  expect(planOpencodePermissionReply("reject", "too risky")).toEqual({ ok: true, body: { optionId: "reject", message: "too risky" } });
  expect(planOpencodePermissionReply("reject", "  padded  ")).toEqual({ ok: true, body: { optionId: "reject", message: "padded" } });
  expect(planOpencodePermissionReply("reject", undefined)).toEqual({ ok: true, body: { optionId: "reject" } });
  expect(planOpencodePermissionReply("reject", "   ")).toEqual({ ok: true, body: { optionId: "reject" } });
  expect(planOpencodePermissionReply("once", undefined)).toEqual({ ok: true, body: { optionId: "once" } });
  const refused = planOpencodePermissionReply("always", "because");
  expect(refused.ok).toBe(false);
  expect(planOpencodePermissionReply("once", "because").ok).toBe(false);
});

const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  id: "k",
  question: "Which?",
  options: [{ id: "a", label: "Same" }, { id: "b", label: "Same" }],
  ...over,
});

test("buildOpencodeAnswer: picks go out as ids, so two options sharing a label stay distinct", () => {
  const r = buildOpencodeAnswer(q(), ["b"], null);
  expect(r).toEqual({ ok: true, entry: { selected: ["Same"], selectedOptionIds: ["b"] } });
});

test("buildOpencodeAnswer: typed text needs allowCustom; a single-select takes an option or text, not both", () => {
  const typedOnly = buildOpencodeAnswer(q({ allowCustom: true }), ["__agetor_custom__"], "my answer");
  expect(typedOnly).toEqual({ ok: true, entry: { selected: [], custom: "my answer" } });
  expect(buildOpencodeAnswer(q(), ["__agetor_custom__"], "my answer").ok).toBe(false);
  expect(buildOpencodeAnswer(q({ allowCustom: true }), ["a"], "and more").ok).toBe(false);
  const multi = buildOpencodeAnswer(q({ allowCustom: true, multiSelect: true }), ["a", "b"], "extra");
  expect(multi).toEqual({ ok: true, entry: { selected: ["Same", "Same"], selectedOptionIds: ["a", "b"], custom: "extra" } });
  expect(buildOpencodeAnswer(q(), [], null).ok).toBe(false);
});

// A model-chosen option id or label can be any string, including the picker's own sentinels.
const colliding = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  id: "k",
  question: "Which?",
  options: [
    { id: "__agetor_custom__", label: "__opencode_skip__" },
    { label: "__agetor_custom__" },
    { id: "__opencode_skip__", label: "Third" },
  ],
  ...over,
});

test("buildOpencodeAnswerByIndex: an option whose id or label equals a sentinel is still just an option", () => {
  expect(buildOpencodeAnswerByIndex(colliding(), [0], null))
    .toEqual({ ok: true, entry: { selected: ["__opencode_skip__"], selectedOptionIds: ["__agetor_custom__"] } });
  // no id on the second option: labels only, nothing dropped as the typed-text sentinel
  expect(buildOpencodeAnswerByIndex(colliding(), [1], null))
    .toEqual({ ok: true, entry: { selected: ["__agetor_custom__"] } });
  expect(buildOpencodeAnswerByIndex(colliding({ multiSelect: true }), [0, 2], null))
    .toEqual({ ok: true, entry: { selected: ["__opencode_skip__", "Third"], selectedOptionIds: ["__agetor_custom__", "__opencode_skip__"] } });
});

test("buildOpencodeAnswerByIndex: the typed-text row is the sentinel string, never an option", () => {
  expect(buildOpencodeAnswerByIndex(colliding({ allowCustom: true }), [CUSTOM_OPTION], "mine"))
    .toEqual({ ok: true, entry: { selected: [], custom: "mine" } });
  expect(buildOpencodeAnswerByIndex(colliding(), [CUSTOM_OPTION], "mine").ok).toBe(false);
  expect(buildOpencodeAnswerByIndex(colliding({ allowCustom: true }), [0], "and more").ok).toBe(false);
  expect(buildOpencodeAnswerByIndex(colliding(), [], null).ok).toBe(false);
  expect(buildOpencodeAnswerByIndex(colliding(), [9], null).ok).toBe(false);
});

test("buildOpencodeAnswerByIndex: two options sharing id and label stay distinct by position", () => {
  const dup = q({ options: [{ id: "a", label: "Same" }, { id: "a", label: "Other" }] });
  expect(buildOpencodeAnswerByIndex(dup, [1], null)).toEqual({ ok: true, entry: { selected: ["Other"], selectedOptionIds: ["a"] } });
});

test("answerFlagsError: --reason with several permission cards pending is refused up front", () => {
  expect(answerFlagsError([ocPerm, ocPerm], { reason: "no", skip: false })).toContain("several are pending");
  // Without --reason the same list is fine; so is --skip --reason over several questions.
  expect(answerFlagsError([ocPerm, ocPerm], { skip: false })).toBeNull();
  expect(answerFlagsError([ocAsk, ocAsk], { reason: "n/a", skip: true })).toBeNull();
});
