import { describe, expect, test } from "bun:test";
import {
  AGENT_INSTRUCTIONS_TAG,
  AGENT_PROFILE_LIMITS,
  agentProfileSummary,
  composeLaunchPrompt,
  matchAgentProfileRef,
  normalizeSkillName,
  snapshotFromProfile,
  stripAgentInstructionsPreamble,
} from "./agent-profile.ts";
import type { AgentProfile } from "./types.ts";

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "profile-1",
    name: "My Agent",
    harness: "harness-1",
    model: "model-1",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeSkillName

describe("normalizeSkillName", () => {
  test("trims leading/trailing whitespace", () => {
    expect(normalizeSkillName("  foo  ")).toBe("foo");
  });

  test("strips exactly one leading slash", () => {
    expect(normalizeSkillName("/foo")).toBe("foo");
  });

  test("strips only ONE leading slash — a second leading slash survives", () => {
    expect(normalizeSkillName("//foo")).toBe("/foo");
  });

  test("collapses internal whitespace runs to a single space", () => {
    expect(normalizeSkillName("foo   bar")).toBe("foo bar");
  });

  test("combination: outer whitespace, one leading slash, internal whitespace runs", () => {
    expect(normalizeSkillName("  /  foo   bar  ")).toBe("foo bar");
  });

  test("empty after trimming → \"\"", () => {
    expect(normalizeSkillName("   ")).toBe("");
  });

  test("a bare slash normalizes to \"\" (nothing left after stripping it)", () => {
    expect(normalizeSkillName("/")).toBe("");
  });

  test("at the length cap: kept unchanged", () => {
    const atCap = "a".repeat(AGENT_PROFILE_LIMITS.skillName);
    expect(normalizeSkillName(atCap)).toBe(atCap);
  });

  test("over the length cap: → \"\"", () => {
    const overCap = "a".repeat(AGENT_PROFILE_LIMITS.skillName + 1);
    expect(normalizeSkillName(overCap)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// composeLaunchPrompt

describe("composeLaunchPrompt", () => {
  test("null profile → prompt returned unchanged (identity)", () => {
    expect(composeLaunchPrompt(null, "do the thing")).toBe("do the thing");
  });

  test("blank instructions + no skills → prompt returned unchanged (identity)", () => {
    expect(composeLaunchPrompt({ instructions: "   ", skills: [] }, "do the thing")).toBe("do the thing");
  });

  test("empty-string instructions + no skills → prompt returned unchanged (identity)", () => {
    expect(composeLaunchPrompt({ instructions: "", skills: [] }, "do the thing")).toBe("do the thing");
  });

  test("instructions only → exact wrapper text with NO skills line", () => {
    const result = composeLaunchPrompt({ instructions: "Be nice", skills: [] }, "do X");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "Be nice\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + "do X",
    );
  });

  test("instructions are trimmed before being placed in the wrapper body", () => {
    const result = composeLaunchPrompt({ instructions: "  Be nice  ", skills: [] }, "do X");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "Be nice\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + "do X",
    );
  });

  test("skills only (blank instructions) → tag body is just the skills line", () => {
    const result = composeLaunchPrompt({ instructions: "", skills: ["a", "b"] }, "do Y");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "Skills to use for this task (invoke each with its skill tool before starting): /a, /b\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + "do Y",
    );
  });

  test("both instructions and skills → blank line separates them inside the tag body", () => {
    const result = composeLaunchPrompt({ instructions: "Be nice", skills: ["a", "b"] }, "do X");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "Be nice\n"
      + "\n"
      + "Skills to use for this task (invoke each with its skill tool before starting): /a, /b\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + "do X",
    );
  });

  test("single skill still renders as a one-item comma list", () => {
    const result = composeLaunchPrompt({ instructions: "", skills: ["only-one"] }, "p");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "Skills to use for this task (invoke each with its skill tool before starting): /only-one\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + "p",
    );
  });

  test("prompt is appended verbatim, not trimmed — leading/trailing whitespace and newlines survive", () => {
    const prompt = "  \n  leading and trailing whitespace survives  \n  ";
    const result = composeLaunchPrompt({ instructions: "X", skills: [] }, prompt);
    expect(result.endsWith(`Your task:\n${prompt}`)).toBe(true);
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\n"
      + "X\n"
      + "</agent_instructions_defined_by_the_user>\n"
      + "\n"
      + "Your task:\n"
      + prompt,
    );
  });

  test("empty prompt with a non-empty profile still appends the empty string after 'Your task:\\n'", () => {
    const result = composeLaunchPrompt({ instructions: "X", skills: [] }, "");
    expect(result).toBe(
      "<agent_instructions_defined_by_the_user>\nX\n</agent_instructions_defined_by_the_user>\n\nYour task:\n",
    );
  });
});

// ---------------------------------------------------------------------------
// stripAgentInstructionsPreamble

describe("stripAgentInstructionsPreamble", () => {
  test("identity when text does not start with the open tag", () => {
    expect(stripAgentInstructionsPreamble("just an ordinary prompt")).toBe("just an ordinary prompt");
    expect(stripAgentInstructionsPreamble("")).toBe("");
  });

  test("identity when text starts with the open tag but never contains the closing marker", () => {
    const text = `<${AGENT_INSTRUCTIONS_TAG}>unterminated`;
    expect(stripAgentInstructionsPreamble(text)).toBe(text);
  });

  describe("round trip with composeLaunchPrompt: strip(compose(p, x)) === x", () => {
    const profileVariants: Array<{ label: string; instructions: string; skills: string[] }> = [
      { label: "instructions only", instructions: "Be nice", skills: [] },
      { label: "skills only", instructions: "", skills: ["a", "b"] },
      { label: "instructions and skills", instructions: "Be nice", skills: ["a"] },
    ];

    const prompts: Array<{ label: string; value: string }> = [
      { label: "empty prompt", value: "" },
      { label: "simple one-line prompt", value: "do the thing" },
      {
        label: "multi-line prompt with blank lines",
        value: "line one\n\nline two\nline three",
      },
      {
        label: "prompt containing the closing tag text",
        value: `here is the tag verbatim: </${AGENT_INSTRUCTIONS_TAG}>\n\nYour task:\nnested reference`,
      },
    ];

    for (const p of profileVariants) {
      for (const prompt of prompts) {
        test(`${p.label} / ${prompt.label}`, () => {
          const composed = composeLaunchPrompt({ instructions: p.instructions, skills: p.skills }, prompt.value);
          expect(stripAgentInstructionsPreamble(composed)).toBe(prompt.value);
        });
      }
    }
  });

  test("round trip also holds through a null profile (no preamble at all)", () => {
    const prompt = "no profile involved";
    const composed = composeLaunchPrompt(null, prompt);
    expect(stripAgentInstructionsPreamble(composed)).toBe(prompt);
  });
});

// ---------------------------------------------------------------------------
// agentProfileSummary

describe("agentProfileSummary", () => {
  test("all fields present", () => {
    expect(agentProfileSummary({ harnessLabel: "Claude Code", model: "opus", effort: "high", mode: "auto" })).toBe(
      "Claude Code · opus · high · auto",
    );
  });

  test("null effort is dropped", () => {
    expect(agentProfileSummary({ harnessLabel: "Claude Code", model: "opus", effort: null, mode: "auto" })).toBe(
      "Claude Code · opus · auto",
    );
  });

  test("null mode is dropped", () => {
    expect(agentProfileSummary({ harnessLabel: "Claude Code", model: "opus", effort: "high", mode: null })).toBe(
      "Claude Code · opus · high",
    );
  });

  test("both effort and mode null: only harness and model remain", () => {
    expect(agentProfileSummary({ harnessLabel: "Claude Code", model: "opus", effort: null, mode: null })).toBe(
      "Claude Code · opus",
    );
  });
});

// ---------------------------------------------------------------------------
// matchAgentProfileRef

describe("matchAgentProfileRef", () => {
  test("id match wins outright, even when another profile's name equals the ref", () => {
    const byIdTarget = makeProfile({ id: "beta", name: "Other Profile" });
    const byNameDecoy = makeProfile({ id: "other-id", name: "beta" });
    const result = matchAgentProfileRef([byIdTarget, byNameDecoy], "beta");
    expect(result).toEqual({ profile: byIdTarget });
  });

  test("case-insensitive, trimmed name match", () => {
    const p = makeProfile({ id: "p1", name: "Alpha" });
    const result = matchAgentProfileRef([p], "  ALPHA  ");
    expect(result).toEqual({ profile: p });
  });

  test("ambiguous name match lists every matching name, in list order", () => {
    const p1 = makeProfile({ id: "id1", name: "Alpha" });
    const p2 = makeProfile({ id: "id2", name: "alpha" });
    const result = matchAgentProfileRef([p1, p2], "alpha");
    expect(result).toEqual({ error: 'ambiguous agent "alpha": matches Alpha, alpha' });
  });

  test("unknown ref (no id or name match) reports the trimmed ref", () => {
    const p = makeProfile({ id: "id1", name: "Alpha" });
    const result = matchAgentProfileRef([p], "  nope  ");
    expect(result).toEqual({ error: 'unknown agent "nope"' });
  });

  test("empty profile list always reports unknown", () => {
    const result = matchAgentProfileRef([], "anything");
    expect(result).toEqual({ error: 'unknown agent "anything"' });
  });
});

// ---------------------------------------------------------------------------
// snapshotFromProfile

describe("snapshotFromProfile", () => {
  test("captures every field plus resolved harness identity and capturedAt", () => {
    const p = makeProfile({
      id: "p1",
      name: "My Agent",
      harness: "h1",
      model: "opus",
      effort: "high",
      mode: "auto",
      fast: true,
      maxMode: true,
      instructions: "Be nice",
      skills: ["a", "b"],
    });
    const snapshot = snapshotFromProfile(p, { kind: "claude-code", label: "Claude Code" }, 12345);
    expect(snapshot).toEqual({
      id: "p1",
      name: "My Agent",
      harness: "h1",
      harnessKind: "claude-code",
      harnessLabel: "Claude Code",
      model: "opus",
      effort: "high",
      mode: "auto",
      fast: true,
      maxMode: true,
      instructions: "Be nice",
      skills: ["a", "b"],
      capturedAt: 12345,
    });
  });

  test("skills is copied into a fresh array — later mutation of the source doesn't leak into the snapshot", () => {
    const p = makeProfile({ skills: ["a", "b"] });
    const snapshot = snapshotFromProfile(p, { kind: "codex", label: "Codex" }, 0);
    expect(snapshot.skills).not.toBe(p.skills);
    p.skills.push("c");
    expect(snapshot.skills).toEqual(["a", "b"]);
  });
});
