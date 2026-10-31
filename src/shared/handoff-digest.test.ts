import { test, expect } from "bun:test";
import {
  HANDOFF_DIGEST_LABEL,
  collapseHandoffPromptSpans,
  handoffDigestLine,
  handoffDigestLines,
} from "./handoff-digest.ts";
import { composeStepPrompt, splitHandoffMessage } from "./pipeline.ts";
import type { Handoff } from "./types.ts";

function block(over: Record<string, unknown>): string {
  const body = {
    schemaVersion: 1,
    purpose: "Ship the thing",
    summary: "Did the work",
    reason: "All done",
    next: "Grilling",
    artifacts: [],
    openQuestions: [],
    ...over,
  };
  return `<handoff>\n${JSON.stringify(body)}\n</handoff>`;
}

function textsOf(message: string): string[] {
  return handoffDigestLines(splitHandoffMessage(message)).map((l) => l.text);
}

test("no real block -> no digest lines and an empty one-line form", () => {
  const split = splitHandoffMessage("just prose, `<handoff>` in code");
  expect(handoffDigestLines(split)).toEqual([]);
  expect(handoffDigestLine(split)).toBe("");
});

test("done handoff: headline then purpose/summary/reason, all labeled handoff›", () => {
  const lines = handoffDigestLines(splitHandoffMessage(`Finished.\n${block({})}`));
  expect(lines.map((l) => l.text)).toEqual([
    "✓ done → Grilling",
    "purpose: Ship the thing",
    "summary: Did the work",
    "reason: All done",
  ]);
  expect(lines.every((l) => l.label === HANDOFF_DIGEST_LABEL && l.tone === "tag")).toBe(true);
  expect(HANDOFF_DIGEST_LABEL).toBe("handoff›");
});

test("blocked handoff leads with the warning headline", () => {
  const [first] = textsOf(block({ status: "blocked", next: "Fix" }));
  expect(first).toBe("⚠ blocked → Fix");
});

test("next: null reads 'last step'", () => {
  expect(textsOf(block({ next: null }))[0]).toBe("✓ done → last step");
});

test("artifacts and open questions print one '- ' line each; empty fields are left out", () => {
  const lines = textsOf(block({ purpose: "", reason: "", artifacts: ["a/b.md", "https://x.test/y"], openQuestions: ["Why?"] }));
  expect(lines).toEqual([
    "✓ done → Grilling",
    "summary: Did the work",
    "artifacts:",
    "  - a/b.md",
    "  - https://x.test/y",
    "open questions:",
    "  - Why?",
  ]);
});

test("a multi-line summary becomes one line per physical line, continuations indented", () => {
  const lines = textsOf(block({ summary: "one\r\ntwo\rthree\n\nfour" }));
  expect(lines).toContain("summary: one");
  expect(lines).toContain("  two");
  expect(lines).toContain("  three");
  expect(lines).toContain("");
  expect(lines).toContain("  four");
  for (const t of lines) expect(t).not.toMatch(/[\r\n]/);
});

test("control characters and bidi overrides in agent text are escaped, never printed raw", () => {
  const lines = textsOf(block({
    summary: "red \u001b[31malert\u001b[0m",
    artifacts: ["evil‮txt.md"],
    next: "Step\u001b]0;pwn\u0007",
  }));
  const all = lines.join("\n");
  expect(all).not.toContain("\u001b");
  expect(all).not.toContain("‮");
  expect(all).not.toContain("\u0007");
  expect(all).toContain("\\u001b[31malert\\u001b[0m");
  expect(all).toContain("\\u202e");
});

test("the one-line form counts artifacts and questions, singular and plural", () => {
  expect(handoffDigestLine(splitHandoffMessage(block({ artifacts: new Array(7).fill("p"), openQuestions: new Array(10).fill("q") }))))
    .toBe("✓ done → Grilling · 7 artifacts · 10 questions");
  expect(handoffDigestLine(splitHandoffMessage(block({ artifacts: ["p"], openQuestions: ["q"] }))))
    .toBe("✓ done → Grilling · 1 artifact · 1 question");
  expect(handoffDigestLine(splitHandoffMessage(block({ next: null, status: "blocked" })))).toBe("⚠ blocked → last step");
});

test("the one-line form escapes next", () => {
  const line = handoffDigestLine(splitHandoffMessage(block({ next: "A\u001b[2Jb\nc" })));
  expect(line).not.toContain("\u001b");
  expect(line).not.toContain("\n");
  expect(line).toContain("\\u001b[2J");
});

test("an invalid block is one error line, escaped, in both forms", () => {
  const split = splitHandoffMessage("<handoff>\nnot json \u001b[31m\n</handoff>");
  const lines = handoffDigestLines(split);
  expect(lines).toHaveLength(1);
  expect(lines[0]!.tone).toBe("error");
  expect(lines[0]!.text.startsWith("✗ invalid handoff — ")).toBe(true);
  expect(lines[0]!.text).not.toContain("\u001b");
  expect(handoffDigestLine(split)).toBe(lines[0]!.text);
});

// --- collapseHandoffPromptSpans ---------------------------------------------

const PREV: Handoff = {
  schemaVersion: 1,
  purpose: "Goal",
  summary: "Investigated",
  reason: "Ready",
  next: "Build",
  artifacts: ["notes.md"],
  openQuestions: ["Which db?"],
};

function stepPrompt(): string {
  return composeStepPrompt({
    pipelineName: "Ship It",
    step: {
      id: "s2",
      name: "Build",
      instructions: "Do it",
      agentProfileId: null,
      position: { x: 0, y: 0 },
      subagents: { profileIds: [], cap: null },
      transition: "choose",
      join: "any",
    },
    stepIndex: 2,
    stepCap: 25,
    goal: "Ship",
    previous: [{ stepName: "Investigate", handoff: PREV, filePath: "/data/pipeline-runs/p/handoff-1-1-from-0.json" }],
    outgoing: [],
    transition: "choose",
    subagentProfiles: [],
    subagentCap: null,
    inlineHandoff: true,
    parallelSiblings: [],
    nonce: "abcd1234",
  });
}

test("collapseHandoffPromptSpans: a CRLF-stored prompt collapses like an LF one", () => {
  const lf = stepPrompt();
  const crlf = lf.replace(/\n/g, "\r\n");
  expect(collapseHandoffPromptSpans(crlf)).toBe(collapseHandoffPromptSpans(lf));
  expect(collapseHandoffPromptSpans(crlf, { oneLine: true })).toBe(collapseHandoffPromptSpans(lf, { oneLine: true }));
});

test("collapseHandoffPromptSpans: text without spans is returned as the same string", () => {
  const text = "plain prompt\nwith lines";
  expect(collapseHandoffPromptSpans(text)).toBe(text);
});

test("collapseHandoffPromptSpans: an inlined span becomes an indented digest labelled from the step", () => {
  const out = collapseHandoffPromptSpans(stepPrompt());
  expect(out).not.toContain("--- BEGIN untrusted handoff");
  expect(out).not.toContain("```json");
  expect(out).toContain('[handoff from "Investigate" · untrusted]');
  expect(out).toContain("\n  ✓ done → Build");
  expect(out).toContain("\n  summary: Investigated");
  expect(out).toContain("\n    - notes.md");
  expect(out).toContain("## Your step");
});

test("collapseHandoffPromptSpans: oneLine collapses a span to a single bracketed line", () => {
  const out = collapseHandoffPromptSpans(stepPrompt(), { oneLine: true });
  expect(out).toContain('[handoff from "Investigate" · untrusted — ✓ done → Build · 1 artifact · 1 question]');
});

test("collapseHandoffPromptSpans: a file-pointer span names its file", () => {
  const text = [
    "intro",
    '--- BEGIN untrusted handoff abcd1234 from "Investigate" ---',
    "(handoff saved to /data/x/handoff.json)",
    "--- END untrusted handoff abcd1234 ---",
    "outro",
  ].join("\n");
  const out = collapseHandoffPromptSpans(text);
  expect(out).toBe('intro\n[handoff from "Investigate" · untrusted — saved to /data/x/handoff.json]\noutro');
});

test("collapseHandoffPromptSpans: a lookalike marker with the wrong nonce stays text", () => {
  const text = [
    '--- BEGIN untrusted handoff abcd1234 from "X" ---',
    "(handoff saved to /p.json)",
    "--- END untrusted handoff ffffffff ---",
  ].join("\n");
  expect(collapseHandoffPromptSpans(text)).toBe(text);
});
