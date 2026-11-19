import { describe, expect, test } from "bun:test";
import {
  cleanBaseValue,
  collectRunProposals,
  extractLinkLine,
  parsePrProposals,
} from "./pr-proposal.ts";
import type { RunEvent } from "../../shared/types.ts";

/** Test adapter: a reply's newest proposal in the single-proposal shape the first suites below were written for. */
function parsePrProposal(text: string): { title: string; description: string; link: string | null } | null {
  const p = parsePrProposals(text).at(-1);
  return p ? { title: p.title, description: p.description, link: p.link } : null;
}

/** Test adapter: the newest proposal across a task's run events. */
function latestPrProposal(events: RunEvent[]): { title: string; description: string; link: string | null } | null {
  const p = collectRunProposals(events).at(-1);
  return p ? { title: p.title, description: p.description, link: p.link } : null;
}

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

  // Git forbids a ref name ending in "." and the link is read to find the
  // branch, so sentence punctuation after a bare URL is dropped.
  test("a trailing period on an otherwise-bare URL line is dropped", () => {
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
    expect(parsePrProposal(text)?.link).toBe(LINK);
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

describe("Repository: labels", () => {
  const labeled = [
    "Repository: frontend",
    LINK,
    "PR title:",
    "```",
    "Add login UI",
    "```",
    "PR description:",
    "````",
    "Frontend body.",
    "````",
    "",
    "Repository: backend",
    "https://github.com/acme/backend/pull/new/feature/add-login",
    "PR title:",
    "```",
    "Add login API",
    "```",
    "PR description:",
    "````",
    "Backend body.",
    "````",
  ].join("\n");

  const block = (label: string, title: string) =>
    [label, LINK, "PR title:", "```", title, "```", "PR description:", "````", "Body.", "````"].join("\n");
  const labelsOf = (text: string) => parsePrProposals(text).map((p) => p.repositoryLabel);

  test("one proposal per Repository label, each with its own link", () => {
    const ps = parsePrProposals(labeled);
    expect(ps.map((p) => p.repositoryLabel)).toEqual(["frontend", "backend"]);
    expect(ps[0]).toMatchObject({ title: "Add login UI", description: "Frontend body." });
    expect(ps[1]!.link).toBe("https://github.com/acme/backend/pull/new/feature/add-login");
  });

  test("repository names containing underscores are not truncated", () => {
    expect(labelsOf(block("Repository: agetor_api", "Add API"))).toEqual(["agetor_api"]);
  });

  test("repository names ending or starting with an underscore survive", () => {
    // A lone edge underscore is part of the slug — `repoNameForPath` keeps it,
    // so the label must too (only a *balanced* pair is emphasis).
    expect(labelsOf([block("Repository: api_", "A"), block("Repository: _worker", "B")].join("\n\n"))).toEqual([
      "api_",
      "_worker",
    ]);
  });

  test("markdown emphasis around the label and value is stripped", () => {
    expect(
      labelsOf([block("**Repository:** **frontend**", "UI"), block("### _Repository:_ agetor_api", "API")].join("\n\n")),
    ).toEqual(["frontend", "agetor_api"]);
  });

  test("inline-code-wrapped labels keep their proposal (backticks and nested emphasis)", () => {
    expect(
      labelsOf(
        [
          block("Repository: `frontend`", "UI"),
          block("**Repository: `backend`**", "API"),
          block("Repository: **`infra`**", "Infra"),
        ].join("\n\n"),
      ),
    ).toEqual(["frontend", "backend", "infra"]);
  });

  test("an unlabeled proposal has a null label", () => {
    expect(labelsOf(canonicalText())).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// parsePrProposals / collectRunProposals (Create all PRs)
// ---------------------------------------------------------------------------

const block = (title: string, desc: string) =>
  ["PR title:", "```", title, "```", "", "PR description:", "````", desc, "````"].join("\n");

// The shape of a real multi-PR reply: bold headings, bare pull/new links, no labels.
function threePrReply(): string {
  return [
    "Pushed all branches.",
    "",
    "**PR-1: app → `main`**",
    "https://github.com/acme/app/pull/new/feature/login",
    "",
    block("Add login", "Adds login to app."),
    "",
    "**PR-2: infra → `main`**",
    "https://github.com/acme/infra/pull/new/feature/login",
    "",
    block("Add login infra", "Infra for login."),
    "",
    "**PR-3: app second branch**",
    "https://github.com/acme/app/pull/new/feature/docs",
    "",
    block("Docs for login", "Docs."),
  ].join("\n");
}

describe("parsePrProposals", () => {
  test("a title with no description of its own never takes the next proposal's; the next one stays whole", () => {
    const text = [
      "https://github.com/acme/app/compare/main...a",
      "PR title:",
      "```",
      "Orphan title",
      "```",
      "",
      "https://github.com/acme/app/compare/main...b",
      block("Second", "second description"),
    ].join("\n");
    const ps = parsePrProposals(text);
    expect(ps.map((p) => [p.title, p.description, p.link])).toEqual([
      ["Second", "second description", "https://github.com/acme/app/compare/main...b"],
    ]);
  });

  test("a proposal never inherits the link or base of a dropped proposal above it; its own link still wins", () => {
    const orphan = [
      "Base: develop",
      "https://github.com/acme/app/compare/develop...a",
      "PR title:",
      "```",
      "Orphan title",
      "```",
      "",
    ];
    const linkless = parsePrProposals([...orphan, block("Second", "second description")].join("\n"));
    expect(linkless.map((p) => [p.title, p.link, p.baseLine])).toEqual([["Second", null, null]]);
    const own = parsePrProposals(
      [...orphan, "Base: main", "https://github.com/acme/app/compare/main...b", block("Second", "d")].join("\n"),
    );
    expect(own.map((p) => [p.title, p.link, p.baseLine])).toEqual([["Second", "https://github.com/acme/app/compare/main...b", "main"]]);
  });

  test("a three-PR reply gives three proposals, each with its own link", () => {
    const ps = parsePrProposals(threePrReply());
    expect(ps.map((p) => p.title)).toEqual(["Add login", "Add login infra", "Docs for login"]);
    expect(ps.map((p) => p.link)).toEqual([
      "https://github.com/acme/app/pull/new/feature/login",
      "https://github.com/acme/infra/pull/new/feature/login",
      "https://github.com/acme/app/pull/new/feature/docs",
    ]);
    expect(ps[1]!.description).toBe("Infra for login.");
  });

  test("a proposal without its own link gets null, never a sibling's", () => {
    const text = [
      "https://github.com/acme/app/compare/main...a",
      block("One", "d1"),
      "",
      block("Two", "d2"),
    ].join("\n");
    const ps = parsePrProposals(text);
    expect(ps).toHaveLength(2);
    expect(ps[0]!.link).toBe("https://github.com/acme/app/compare/main...a");
    expect(ps[1]!.link).toBeNull();
  });

  test("reads Base: variants (emphasis, backticks, Base branch:, trailing prose)", () => {
    const mk = (line: string) => parsePrProposals([line, block("T", "D")].join("\n"))[0]!.baseLine;
    expect(mk("Base: develop")).toBe("develop");
    expect(mk("**Base:** `develop`")).toBe("develop");
    expect(mk("**Base**: release/1.2")).toBe("release/1.2");
    expect(mk("Base branch: `main` (the default).")).toBe("main");
    expect(mk("- Base: origin/develop")).toBe("origin/develop");
    expect(mk("Base: <branch>")).toBeNull();
    expect(mk("no base here")).toBeNull();
  });

  test("a Base: line belongs to the proposal below it only", () => {
    const text = ["Base: develop", block("One", "d1"), "", block("Two", "d2")].join("\n");
    const ps = parsePrProposals(text);
    expect(ps[0]!.baseLine).toBe("develop");
    expect(ps[1]!.baseLine).toBeNull();
  });

  test("the label is the most recent Repository: line above, even above an earlier proposal", () => {
    const text = [
      "Repository: app",
      "https://github.com/acme/app/compare/main...a",
      block("One", "Repository: not-a-label inside a description"),
      "",
      "https://github.com/acme/app/compare/main...b",
      block("Two", "d2"),
      "",
      "Repository: infra",
      block("Three", "d3"),
    ].join("\n");
    const ps = parsePrProposals(text);
    expect(ps.map((p) => p.repositoryLabel)).toEqual(["app", "app", "infra"]);
  });

  test("\\r\\n and bare \\r input parse", () => {
    const text = threePrReply();
    expect(parsePrProposals(text.replace(/\n/g, "\r\n"))).toHaveLength(3);
    expect(parsePrProposals(text.replace(/\n/g, "\r"))).toHaveLength(3);
  });

  test("a four-backtick description holding ``` survives", () => {
    const desc = "Intro\n```ts\nconst a = 1;\n```\nOutro";
    const ps = parsePrProposals(block("T", desc));
    expect(ps[0]!.description).toBe(desc);
  });

  test("an incomplete trailing proposal is ignored and garbage gives []", () => {
    expect(parsePrProposals(["PR title:", "```", "Only a title", "```"].join("\n"))).toEqual([]);
    expect(parsePrProposals("")).toEqual([]);
    expect(parsePrProposals("nothing\nPR title:")).toEqual([]);
  });
});

describe("extractLinkLine", () => {
  test("bare, angle-bracketed, markdown and labeled forms", () => {
    const url = "https://github.com/a/b/compare/main...x?quick_pull=1";
    expect(extractLinkLine(url)).toBe(url);
    expect(extractLinkLine(`<${url}>`)).toBe(url);
    expect(extractLinkLine(`[Open PR](${url})`)).toBe(url);
    expect(extractLinkLine(`PR link: ${url}`)).toBe(url);
    expect(extractLinkLine(`- **Link:** [open](${url})`)).toBe(url);
    expect(extractLinkLine(`${url}.`)).toBe(url);
  });
  test("prose and non-links are not links", () => {
    expect(extractLinkLine("Open it at https://x.example/y later")).toBeNull();
    expect(extractLinkLine("")).toBeNull();
    expect(extractLinkLine("Base: main")).toBeNull();
  });
});

describe("cleanBaseValue", () => {
  test("keeps underscores and slashes, drops decoration", () => {
    expect(cleanBaseValue("`feature/a_b`")).toBe("feature/a_b");
    expect(cleanBaseValue("**main**")).toBe("main");
    expect(cleanBaseValue("")).toBeNull();
  });
  test("a backtick-quoted name is read whole: an apostrophe inside is kept, prose after the closing backtick ignored", () => {
    expect(cleanBaseValue("`fix/it's-done`")).toBe("fix/it's-done");
    expect(cleanBaseValue("`release/1.2` (the branch it was cut from).")).toBe("release/1.2");
    expect(cleanBaseValue("**`develop`** — not main")).toBe("develop");
    expect(cleanBaseValue("`<branch>`")).toBeNull();
    expect(cleanBaseValue("``")).toBeNull();
    // Unquoted values keep the token rules.
    expect(cleanBaseValue("main (the default).")).toBe("main");
  });
});

describe("collectRunProposals", () => {
  test("ignores subagent and non-assistant events, orders by run then position", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: block("Old", "d") }),
      ev({ runId: "r1", stream: "stdout", data: block("Nope", "d") }),
      ev({ runId: "r1", subagentId: "sa", data: block("Sub", "d") }),
      ev({ runId: "r2", data: [block("New A", "d"), "", block("New B", "d")].join("\n") }),
    ];
    const ps = collectRunProposals(events);
    expect(ps.map((p) => [p.runId, p.title])).toEqual([
      ["r1", "Old"],
      ["r2", "New A"],
      ["r2", "New B"],
    ]);
    expect(ps.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  test("joins an assistant reply split across event chunks", () => {
    const events: RunEvent[] = [
      ev({ runId: "r1", data: ["PR title:", "```", "Split", "```"].join("\n") }),
      ev({ runId: "r1", data: ["PR description:", "````", "body", "````"].join("\n") }),
    ];
    expect(collectRunProposals(events).map((p) => p.title)).toEqual(["Split"]);
  });
});
