import { describe, expect, test } from "bun:test";
import { latestPrProposal, parsePrProposal } from "./pr-proposal.ts";
import type { RunEvent } from "../../shared/types.ts";

const LINK = "https://github.com/acme/widgets/pull/new/feature/add-login";

function canonicalText(): string {
  return [
    "Pushed the branch. Open a PR here:",
    "",
    LINK,
    "",
    "PR title:",
    "```",
    "Add login flow",
    "```",
    "",
    "PR description:",
    "````",
    "## What changed",
    "- added login form",
    "- wired up session cookie",
    "````",
  ].join("\n");
}

function ev(overrides: Partial<RunEvent>): RunEvent {
  return {
    runId: "r1",
    taskId: "t1",
    stream: "assistant",
    data: "",
    ts: 0,
    ...overrides,
  };
}

describe("parsePrProposal — canonical contract", () => {
  test("plain-text link line + PR title ``` fence + PR description ```` fence parses fully", () => {
    expect(parsePrProposal(canonicalText())).toEqual({
      title: "Add login flow",
      description: "## What changed\n- added login form\n- wired up session cookie",
      link: LINK,
    });
  });

  test("CR-only newlines (tmux paste-buffer artifact) still parse", () => {
    const crOnly = canonicalText().replace(/\n/g, "\r");
    expect(parsePrProposal(crOnly)).toEqual({
      title: "Add login flow",
      description: "## What changed\n- added login form\n- wired up session cookie",
      link: LINK,
    });
  });

  test("4-backtick description fence keeps a nested ``` code block intact", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "Changed the login handler:",
      "",
      "```js",
      "function login() { return true; }",
      "```",
      "",
      "That's the whole diff.",
      "````",
    ].join("\n");
    const proposal = parsePrProposal(text);
    expect(proposal).not.toBeNull();
    expect(proposal?.description).toBe(
      [
        "Changed the login handler:",
        "",
        "```js",
        "function login() { return true; }",
        "```",
        "",
        "That's the whole diff.",
      ].join("\n"),
    );
  });

  test("3-backtick description fence (agent skipped the 4-backtick ask) still parses", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "```",
      "Simple description, no nested fences.",
      "```",
    ].join("\n");
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Simple description, no nested fences.",
      link: null,
    });
  });

  test("emphasis-wrapped labels (**PR title:**) parse", () => {
    const text = [
      "**PR title:**",
      "```",
      "Add login flow",
      "```",
      "",
      "**PR description:**",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Body text.",
      link: null,
    });
  });

  test("case variation (pr Title: / pr Description:) parses", () => {
    const text = [
      "pr Title:",
      "```",
      "Add login flow",
      "```",
      "",
      "pr Description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Body text.",
      link: null,
    });
  });
});

describe("parsePrProposal — missing/empty ⇒ null", () => {
  test("no PR title label at all ⇒ null", () => {
    const text = ["PR description:", "````", "Body text.", "````"].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });

  test("title label present but no fence follows ⇒ null", () => {
    const text = [
      "PR title:",
      "just some prose, no fence",
      "",
      "PR description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });

  test("title parses but no PR description label ⇒ null", () => {
    const text = ["PR title:", "```", "Add login flow", "```"].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });

  test("description label present but no fence follows ⇒ null", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "no fence here either",
    ].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });

  test("empty-content title fence ⇒ null", () => {
    const text = [
      "PR title:",
      "```",
      "```",
      "",
      "PR description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });

  test("empty-content description fence ⇒ null", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "   ",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });
});

describe("parsePrProposal — link line", () => {
  test("no link line at all ⇒ parses with link: null", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Body text.",
      link: null,
    });
  });

  test("nearest preceding bare URL line wins over a farther one", () => {
    const text = [
      "https://example.com/stale-link",
      "",
      "Some other prose in between.",
      "",
      LINK,
      "",
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    const proposal = parsePrProposal(text);
    expect(proposal?.link).toBe(LINK);
  });

  // Pinning actual behavior, not the contract's aspiration: extractUrlLine's
  // BARE regex (`\S+`) already matches trailing punctuation as part of the
  // URL when the line has no other whitespace, so the "strip trailing
  // sentence punctuation" fallback branch never fires for a line that is
  // *only* a URL + punctuation — the period is kept as part of the link.
  test("a trailing period on an otherwise-bare URL line is kept, not stripped (BARE's \\S+ already consumes it)", () => {
    const text = [
      `${LINK}.`,
      "",
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)?.link).toBe(`${LINK}.`);
  });
});

describe("parsePrProposal — fence info strings", () => {
  test("a fence with an info string (```text) still parses", () => {
    const text = [
      "PR title:",
      "```text",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````markdown",
      "Body text.",
      "````",
    ].join("\n");
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Body text.",
      link: null,
    });
  });
});

describe("parsePrProposal — garbage / adversarial input never throws", () => {
  test("empty string ⇒ null", () => {
    expect(parsePrProposal("")).toBeNull();
  });

  test("plain ordinary prose with no labels ⇒ null", () => {
    expect(parsePrProposal("just a normal reply about the bug, nothing special here")).toBeNull();
  });

  test("unclosed title fence ⇒ null (tolerated, not thrown)", () => {
    const text = ["PR title:", "```", "Add login flow", "no closing fence at all"].join("\n");
    expect(() => parsePrProposal(text)).not.toThrow();
    expect(parsePrProposal(text)).toBeNull();
  });

  // Pinning actual behavior: findFenceAfter tolerates a never-closed fence by
  // taking the remainder of the text as its content (documented in the
  // source's FenceMatch comment), so an unclosed *description* fence (unlike
  // an unclosed *title* fence, which swallows the description label with it)
  // still parses successfully — there's nothing after it to swallow.
  test("unclosed description fence at end-of-text still parses (tolerated, not thrown)", () => {
    const text = [
      "PR title:",
      "```",
      "Add login flow",
      "```",
      "",
      "PR description:",
      "````",
      "Body text with no closing fence",
    ].join("\n");
    expect(() => parsePrProposal(text)).not.toThrow();
    expect(parsePrProposal(text)).toEqual({
      title: "Add login flow",
      description: "Body text with no closing fence",
      link: null,
    });
  });

  test("backticks everywhere with no labels ⇒ null, never throws", () => {
    const text = "``` ```` ``` ` `` ````` random backticks ``` no labels here ````";
    expect(() => parsePrProposal(text)).not.toThrow();
    expect(parsePrProposal(text)).toBeNull();
  });

  test("labels present but reversed order (description before title) ⇒ null", () => {
    const text = [
      "PR description:",
      "````",
      "Body text.",
      "````",
      "",
      "PR title:",
      "```",
      "Add login flow",
      "```",
    ].join("\n");
    expect(parsePrProposal(text)).toBeNull();
  });
});

describe("latestPrProposal", () => {
  test("title and description split across two assistant events of the same run parse (joined)", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: "PR title:\n```\nAdd login flow\n```" }),
      ev({ runId: "r1", data: "PR description:\n````\nBody text.\n````" }),
    ];
    expect(latestPrProposal(events)).toEqual({
      title: "Add login flow",
      description: "Body text.",
      link: null,
    });
  });

  test("two runs each with a proposal ⇒ the newest run (last in array order) wins", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: canonicalText() }),
      ev({
        runId: "r2",
        data: [
          "PR title:",
          "```",
          "Second, newer title",
          "```",
          "",
          "PR description:",
          "````",
          "Second, newer description.",
          "````",
        ].join("\n"),
      }),
    ];
    expect(latestPrProposal(events)).toEqual({
      title: "Second, newer title",
      description: "Second, newer description.",
      link: null,
    });
  });

  test("proposal only in an older run, newer run has assistant text but no proposal ⇒ older proposal returned", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: canonicalText() }),
      ev({ runId: "r2", data: "Just some closing remarks, no PR proposal here." }),
    ];
    expect(latestPrProposal(events)).toEqual({
      title: "Add login flow",
      description: "## What changed\n- added login form\n- wired up session cookie",
      link: LINK,
    });
  });

  test("non-assistant streams are ignored even if they contain proposal-shaped text", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", stream: "user", data: canonicalText() }),
      ev({ runId: "r1", stream: "tool_use", data: canonicalText() }),
      ev({ runId: "r1", stream: "status", data: canonicalText() }),
      ev({ runId: "r1", stream: "stdout", data: canonicalText() }),
    ];
    expect(latestPrProposal(events)).toBeNull();
  });

  test("no events at all ⇒ null", () => {
    expect(latestPrProposal([])).toBeNull();
  });

  test("assistant events with no parseable proposal anywhere ⇒ null", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: "hello" }),
      ev({ runId: "r2", data: "world" }),
    ];
    expect(latestPrProposal(events)).toBeNull();
  });
});

describe("review-fix regressions", () => {
  function proposalText(title: string, desc: string): string {
    return ["PR title:", "```", title, "```", "", "PR description:", "````", desc, "````"].join("\n");
  }

  test("two proposals in ONE run (folded follow-up commit&push) ⇒ the latest wins", () => {
    const joined = `${proposalText("OLD title", "old desc")}\n\nsome chatter\n\n${proposalText("NEW title", "new desc")}`;
    expect(parsePrProposal(joined)?.title).toBe("NEW title");
    const events: RunEvent[] = [
      ev({ runId: "r1", data: proposalText("OLD title", "old desc") }),
      ev({ runId: "r1", data: proposalText("NEW title", "new desc") }),
    ];
    expect(latestPrProposal(events)?.title).toBe("NEW title");
  });

  test("a trailing incomplete proposal falls back to the earlier complete one in the same run", () => {
    const joined = `${proposalText("GOOD", "good desc")}\n\nPR title:\n\`\`\`\nBROKEN\n\`\`\`\n(no description this time)`;
    expect(parsePrProposal(joined)).toMatchObject({ title: "GOOD", description: "good desc" });
  });

  test("subagent assistant events never contribute to the proposal", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: proposalText("SUBAGENT hijack", "nope"), subagentId: "bg-1" }),
      ev({ runId: "r1", data: "main agent said something unrelated" }),
    ];
    expect(latestPrProposal(events)).toBeNull();
    events.push(ev({ runId: "r1", data: proposalText("MAIN", "real desc") }));
    expect(latestPrProposal(events)?.title).toBe("MAIN");
  });

  test("markdown-heading-prefixed labels (### PR title:) parse", () => {
    const text = ["### PR title:", "```", "Heading style", "```", "", "### PR description:", "````", "desc", "````"].join("\n");
    expect(parsePrProposal(text)).toMatchObject({ title: "Heading style", description: "desc" });
  });
});
