import { describe, expect, test } from "bun:test";
import { cleanPromptPane, isPromptNoiseLine, PROMPT_NOISE_RE } from "./prompt-noise.ts";

describe("isPromptNoiseLine — spinner/working-footer lines are noise", () => {
  test("glyph + duration + token-count + esc-to-interrupt footer", () => {
    expect(isPromptNoiseLine("✱ Scurrying… (1m 13s · ↓ 3.7k tokens)")).toBe(true);
  });

  test("asterisk glyph + short duration + esc-to-interrupt", () => {
    expect(isPromptNoiseLine("* Reticulating… (3s · esc to interrupt)")).toBe(true);
  });

  test("glyph + duration + decimal-k token count + esc-to-interrupt", () => {
    expect(
      isPromptNoiseLine("✳ Simmering… (2m 4s · ↑ 1.2k tokens · esc to interrupt)"),
    ).toBe(true);
  });

  test("ASCII ellipsis variant (three literal dots) still matches", () => {
    expect(isPromptNoiseLine("Scurrying... (45s · esc to interrupt)")).toBe(true);
  });

  test("bare token count with no k/m suffix still matches (digit-led)", () => {
    expect(isPromptNoiseLine("Working… (↓ 812 tokens)")).toBe(true);
  });
});

describe("isPromptNoiseLine — legitimate modal content is not noise", () => {
  test("a plain yes/no question", () => {
    expect(isPromptNoiseLine("Do you want to proceed?")).toBe(false);
  });

  test("numbered choice lines", () => {
    expect(isPromptNoiseLine("1. Yes, run it")).toBe(false);
    expect(isPromptNoiseLine("2. No, and tell Claude what to do differently")).toBe(false);
  });

  test("an ellipsis with no parenthesized tail is not a footer", () => {
    expect(isPromptNoiseLine("Reading files… please wait")).toBe(false);
  });

  test("a code snippet with a literal ellipsis inside a call's parens", () => {
    expect(isPromptNoiseLine("callFunction(x, y, ...)")).toBe(false);
  });

  test("bare 'tokens' with no numeric count must NOT strip (security-relevant)", () => {
    // A code-review tightened the pattern specifically so a permission
    // excerpt describing what a tool does isn't silently swallowed just
    // because it happens to end in "...(...tokens...)".
    expect(isPromptNoiseLine("Read secrets… (rotates auth tokens)")).toBe(false);
    expect(isPromptNoiseLine("Deploy… (production tokens required)")).toBe(false);
  });
});

describe("isPromptNoiseLine — pre-existing keyboard-shortcut footers", () => {
  test("esc to cancel, anchored at line start", () => {
    expect(isPromptNoiseLine("Esc to cancel")).toBe(true);
  });

  test("enter to select, as rendered in the real AskUserQuestion footer", () => {
    // Matches the fixture text in src/bun/fixtures/askuserquestion/*.txt —
    // claude's TUI renders the whole hint bar as one line.
    expect(
      isPromptNoiseLine("Enter to select · ↑/↓ to navigate · Esc to cancel"),
    ).toBe(true);
  });

  test("arrow-hint line anchored at line start", () => {
    expect(isPromptNoiseLine("↑/↓ to navigate · n to add notes · Esc to cancel")).toBe(true);
  });
});

describe("PROMPT_NOISE_RE — sanity on the exported list itself", () => {
  test("is a non-empty array of RegExp", () => {
    expect(Array.isArray(PROMPT_NOISE_RE)).toBe(true);
    expect(PROMPT_NOISE_RE.length).toBeGreaterThan(0);
    for (const re of PROMPT_NOISE_RE) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});

describe("cleanPromptPane — end-to-end on a realistic pane capture", () => {
  // Mirrors the shape of a real scraped pane tail (see claude-tmux.ts,
  // `lines.slice(-12)`): a boxed modal, its keyboard-shortcut footer, and
  // the "is working" spinner line that sits right below it in the viewport.
  const paneLines = [
    "╭─ Plan ready ────────────────────────╮",
    "│ I will refactor the auth module.    │",
    "",
    "│ Would you like to proceed?           │",
    "",
    "│ 1. Yes, and auto-accept edits        │",
    "│ 2. Yes, and manually approve edits   │",
    "│ 3. No, keep planning                 │",
    "╰───────────────────────────────────────╯",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "",
    "✱ Scurrying… (1m 13s · ↓ 3.7k tokens · esc to interrupt)",
  ];

  test("strips the footer and spinner lines, keeps the modal body/choices", () => {
    const cleaned = cleanPromptPane(paneLines.join("\n"));

    expect(cleaned).not.toMatch(/Enter to select/);
    expect(cleaned).not.toMatch(/Scurrying/);
    expect(cleaned).toContain("Would you like to proceed?");
    expect(cleaned).toContain("1. Yes, and auto-accept edits");
    expect(cleaned).toContain("2. Yes, and manually approve edits");
    expect(cleaned).toContain("3. No, keep planning");
  });

  test("preserves the original line order of what's kept", () => {
    const cleaned = cleanPromptPane(paneLines.join("\n"));
    // The trailing blank line (index 10) has nothing after it once the
    // spinner (index 11) is stripped, so it's trimmed off the end — the
    // result is exactly the first 9 (non-noise) lines, untouched.
    expect(cleaned).toBe(paneLines.slice(0, 9).join("\n"));
  });
});

describe("cleanPromptPane — repaint duplicates and edge trimming", () => {
  test("collapses an immediately-repeated line (tmux repaint) but not distant repeats", () => {
    const pane = [
      "│ Would you like to proceed?           │",
      "│ Would you like to proceed?           │",
      "1. Yes",
      "│ Would you like to proceed?           │",
    ].join("\n");
    const cleaned = cleanPromptPane(pane);
    expect(cleaned).toBe(
      [
        "│ Would you like to proceed?           │",
        "1. Yes",
        "│ Would you like to proceed?           │",
      ].join("\n"),
    );
  });

  test("trims leading/trailing blank lines left behind by stripped noise", () => {
    const pane = [
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "Do you want to proceed?",
      "✱ Scurrying… (1m 13s · ↓ 3.7k tokens)",
    ].join("\n");
    expect(cleanPromptPane(pane)).toBe("Do you want to proceed?");
  });
});
