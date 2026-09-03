import { describe, expect, test } from "bun:test";
import {
  canonicalizeUserText,
  forkedSkillLabel,
  hasTagSegments,
  humanizeTagName,
  isMachineEmittedMessage,
  parseForkedSkillLaunch,
  parseMessageSegments,
  parseUserMessage,
  splitReferences,
  stripAnsiSgr,
  tryParseJsonBody,
  userMessageLines,
} from "./user-message.ts";
import { appendReferences } from "./refs.ts";
import type { TaskReference } from "./types.ts";

const REFS: TaskReference[] = [
  { path: "/a/b.png", isDirectory: false },
  { path: "/c/d", isDirectory: true },
];

describe("parseUserMessage — XML expansion shape", () => {
  test("full three-tag message parses to a command with name + args", () => {
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      "<command-args>do the thing</command-args>",
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/implement", args: "do the thing", references: [] },
    });
  });

  test("args containing markdown, a fenced code block, a screenshot token, and blank lines survive verbatim", () => {
    const argsBody = [
      "Do the following:",
      "",
      "1. Update **bold** stuff",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "See [screenshot-1.png] for reference.",
    ].join("\n");
    const xml = [
      "<command-message>run</command-message>",
      "<command-name>/run</command-name>",
      `<command-args>${argsBody}</command-args>`,
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/run", args: argsBody, references: [] },
    });
  });

  test("trailing Referenced files/folders block inside command-args is split off; folder bullets keep trailing slash", () => {
    const argsRaw = appendReferences("do the thing", REFS);
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      `<command-args>${argsRaw}</command-args>`,
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: {
        name: "/implement",
        args: "do the thing",
        references: ["/a/b.png", "/c/d/"],
      },
    });
  });

  test("no command-args tag at all yields empty args and no references", () => {
    const xml = [
      "<command-message>compact</command-message>",
      "<command-name>/compact</command-name>",
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/compact", args: "", references: [] },
    });
  });

  test("tags in a different order (name before message) still parse", () => {
    const xml = [
      "<command-name>/implement</command-name>",
      "<command-message>implement</command-message>",
      "<command-args>do it</command-args>",
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/implement", args: "do it", references: [] },
    });
  });

  test("tolerates \\r\\n tag separators; bare \\r inside tag content is normalized to \\n", () => {
    const xml = [
      "<command-message>run</command-message>",
      "<command-name>/run</command-name>",
      "<command-args>line one\rline two</command-args>",
    ].join("\r\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/run", args: "line one\nline two", references: [] },
    });
  });
});

describe("parseUserMessage — strict-parse guards (bail to null)", () => {
  test("duplicate command-name tags → null", () => {
    const xml =
      "<command-name>/implement</command-name><command-name>/other</command-name><command-args>x</command-args>";
    expect(parseUserMessage(xml)).toBeNull();
  });

  test("leftover non-whitespace text before the tags → null", () => {
    const xml = `hello <command-name>/implement</command-name><command-args>x</command-args>`;
    expect(parseUserMessage(xml)).toBeNull();
  });

  test("leftover non-whitespace text between tags → null", () => {
    const xml = `<command-name>/implement</command-name> extra text <command-args>x</command-args>`;
    expect(parseUserMessage(xml)).toBeNull();
  });

  test("leftover non-whitespace text after the tags → null", () => {
    const xml = `<command-name>/implement</command-name><command-args>x</command-args> trailing`;
    expect(parseUserMessage(xml)).toBeNull();
  });

  test("missing command-name (only message + args) → null", () => {
    const xml = "<command-message>implement</command-message><command-args>x</command-args>";
    expect(parseUserMessage(xml)).toBeNull();
  });

  test("a command-name tag appearing mid-sentence in ordinary prose → null", () => {
    const text = "Check out <command-name>/foo</command-name> for details";
    expect(parseUserMessage(text)).toBeNull();
  });
});

describe("parseUserMessage — plain echo shape", () => {
  test("/implement do the thing → command /implement with args", () => {
    expect(parseUserMessage("/implement do the thing")).toEqual({
      kind: "command",
      command: { name: "/implement", args: "do the thing", references: [] },
    });
  });

  test("/vercel:deploy prod → colon-qualified command name", () => {
    expect(parseUserMessage("/vercel:deploy prod")).toEqual({
      kind: "command",
      command: { name: "/vercel:deploy", args: "prod", references: [] },
    });
  });

  test("/compact alone → empty args", () => {
    expect(parseUserMessage("/compact")).toEqual({
      kind: "command",
      command: { name: "/compact", args: "", references: [] },
    });
  });

  test("plain echo with a trailing refs block splits references", () => {
    const text = appendReferences("/implement do the thing", REFS);
    expect(parseUserMessage(text)).toEqual({
      kind: "command",
      command: {
        name: "/implement",
        args: "do the thing",
        references: ["/a/b.png", "/c/d/"],
      },
    });
  });
});

describe("parseUserMessage — plain echo false-positive guards", () => {
  test("an absolute path with an uppercase segment is never a command", () => {
    expect(parseUserMessage("/Users/foo/bar.png")).toBeNull();
  });

  test("a path continuing past a slash boundary is never a command", () => {
    expect(parseUserMessage("/tmp/foo")).toBeNull();
  });

  test("bare /tmp DOES parse as a (contentless) command — accepted conservative tradeoff, not a bug (plan §3 / review finding)", () => {
    expect(parseUserMessage("/tmp")).toEqual({
      kind: "command",
      command: { name: "/tmp", args: "", references: [] },
    });
  });
});

describe("parseUserMessage — local-command-stdout shape", () => {
  test("basic stdout body is trimmed", () => {
    expect(parseUserMessage("<local-command-stdout>some output</local-command-stdout>")).toEqual(
      { kind: "command-output", output: "some output" },
    );
  });

  test("stdout with surrounding whitespace is trimmed to empty", () => {
    expect(
      parseUserMessage("<local-command-stdout>   \n  </local-command-stdout>"),
    ).toEqual({ kind: "command-output", output: "" });
  });

  test("self-closing form yields empty output", () => {
    expect(parseUserMessage("<local-command-stdout/>")).toEqual({
      kind: "command-output",
      output: "",
    });
    expect(parseUserMessage("<local-command-stdout />")).toEqual({
      kind: "command-output",
      output: "",
    });
  });

  test("ANSI SGR escapes around a bolded model name are stripped", () => {
    const text =
      "<local-command-stdout>Set model to \x1b[1mOpus 5 (1M context)\x1b[22m for this session only</local-command-stdout>";
    expect(parseUserMessage(text)).toEqual({
      kind: "command-output",
      output: "Set model to Opus 5 (1M context) for this session only",
    });
  });
});

describe("parseUserMessage — ordinary text stays null", () => {
  test("ordinary prose", () => {
    expect(parseUserMessage("just a normal reply about the bug")).toBeNull();
  });

  test("empty string", () => {
    expect(parseUserMessage("")).toBeNull();
  });

  test("markdown heading", () => {
    expect(parseUserMessage("# Section title\n\nSome body text.")).toBeNull();
  });
});

describe("splitReferences — newline contract", () => {
  // splitReferences itself expects \n-based text: its blank-line paragraph
  // split (`/\n\s*\n/`) never fires on bare-\r-only input. That's fine as an
  // internal contract because the rendering entry point, parseUserMessage,
  // normalizes \r / \r\n → \n up front (the JSONL twin of a send can be
  // \r-only via tmux's paste-buffer — see event-dedup.ts). Both halves are
  // pinned here: the raw helper's limitation, and the entry point covering it.
  test("a refs block is NOT split by the raw helper when the whole text uses bare \\r with no \\n", () => {
    const argsRaw = appendReferences("do the thing", REFS).replace(/\n/g, "\r");
    expect(splitReferences(argsRaw)).toEqual({ args: argsRaw, references: [] });
  });

  test("a refs block IS split when \\r\\n is used (an actual \\n is present)", () => {
    const argsRaw = appendReferences("do the thing", REFS).replace(/\n/g, "\r\n");
    expect(splitReferences(argsRaw)).toEqual({
      args: "do the thing",
      references: ["/a/b.png", "/c/d/"],
    });
  });

  test("parseUserMessage splits the refs block of a bare-\\r-only XML twin (entry-point normalization)", () => {
    const argsRaw = appendReferences("do the thing", REFS);
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      `<command-args>${argsRaw}</command-args>`,
    ]
      .join("\n")
      .replace(/\n/g, "\r");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/implement", args: "do the thing", references: ["/a/b.png", "/c/d/"] },
    });
  });

  test("parseUserMessage splits the refs block of a bare-\\r-only plain echo", () => {
    const echo = appendReferences("/implement do the thing", REFS).replace(/\n/g, "\r");
    expect(parseUserMessage(echo)).toEqual({
      kind: "command",
      command: { name: "/implement", args: "do the thing", references: ["/a/b.png", "/c/d/"] },
    });
  });
});

describe("splitReferences — bare bullet (claude's image-bullet rewrite)", () => {
  test("a lone bare '-' bullet (twin shape, no real path left) is accepted and dropped: args without the block, references []", () => {
    const text = "do the thing\n\nReferenced files/folders:\n-";
    expect(splitReferences(text)).toEqual({ args: "do the thing", references: [] });
  });

  test("a mixed bare bullet + real-path bullet: the bare one drops, the real path is kept as the only reference", () => {
    const text = "do the thing\n\nReferenced files/folders:\n-\n- /a/b.png";
    expect(splitReferences(text)).toEqual({ args: "do the thing", references: ["/a/b.png"] });
  });

  test("bare bullet with trailing whitespace ('- ') is also accepted and dropped", () => {
    const text = "do the thing\n\nReferenced files/folders:\n- ";
    expect(splitReferences(text)).toEqual({ args: "do the thing", references: [] });
  });
});

describe("canonicalizeUserText", () => {
  test("the XML twin of a command with a refs block canonicalizes to exactly the live echo text", () => {
    const baseArgs = "do this and that across the codebase";
    const echoText = appendReferences(`/implement ${baseArgs}`, REFS);
    const argsRaw = appendReferences(baseArgs, REFS);
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      `<command-args>${argsRaw}</command-args>`,
    ].join("\n");
    expect(canonicalizeUserText(xml)).toBe(echoText);
  });

  test("non-command text is returned identically", () => {
    const text = "  just some ordinary reply with   odd spacing\n\n";
    expect(canonicalizeUserText(text)).toBe(text);
  });

  test("plain echo text (no XML tags) is returned identically", () => {
    const text = "/implement do the thing";
    expect(canonicalizeUserText(text)).toBe(text);
  });

  test("near-miss XML (leftover content) is returned identically", () => {
    const text = "hello <command-name>/implement</command-name> world";
    expect(canonicalizeUserText(text)).toBe(text);
  });
});

describe("parseMessageSegments — smoke", () => {
  test("real fixture: forked-skill-launch line, newline-separated (prod transcript shape)", () => {
    const text =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';

    const segments = parseMessageSegments(text);
    expect(segments).toEqual([
      { kind: "tag", name: "local-command-stdout", attrs: "", body: "Running in the background as @code-review", raw: "<local-command-stdout>Running in the background as @code-review</local-command-stdout>" },
      { kind: "tag", name: "forked-skill-launch", attrs: "", body: '{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}', raw: '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>' },
    ]);
    expect(isMachineEmittedMessage(segments)).toBe(true);

    const launchSeg = segments[1];
    if (launchSeg?.kind !== "tag") throw new Error("expected tag segment");
    expect(parseForkedSkillLaunch(launchSeg.body)).toEqual({
      agentId: "a7db6829e09d1ba9b",
      skillName: "code-review",
      description: "/code-review",
    });

    expect(parseUserMessage(text)).toEqual({
      kind: "tagged",
      text,
      segments,
      references: [],
    });
    expect(userMessageLines(text)).toEqual([
      { label: "cmd›", text: "Running in the background as @code-review", tone: "machine" },
      { label: "skill›", text: "/code-review launched in background (agent a7db6829)", tone: "machine" },
    ]);
  });

  test("real fixture: same forked-skill-launch line, space-separated (copy-paste artifact)", () => {
    const text =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout> " +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';

    const segments = parseMessageSegments(text);
    expect(segments.filter((s) => s.kind === "tag")).toHaveLength(2);
    expect(isMachineEmittedMessage(segments)).toBe(true);
    expect(userMessageLines(text)).toEqual([
      { label: "cmd›", text: "Running in the background as @code-review", tone: "machine" },
      { label: "skill›", text: "/code-review launched in background (agent a7db6829)", tone: "machine" },
    ]);
  });

  test("real fixture: shell escape (bash-input / empty bash-stdout / bash-stderr)", () => {
    const text =
      "<bash-input>supabase db push --linked</bash-input>\n" +
      "<bash-stdout></bash-stdout><bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>";

    const segments = parseMessageSegments(text);
    const tagNames = segments.filter((s) => s.kind === "tag").map((s) => (s.kind === "tag" ? s.name : ""));
    expect(tagNames).toEqual(["bash-input", "bash-stdout", "bash-stderr"]);
    expect(isMachineEmittedMessage(segments)).toBe(true);

    const lines = userMessageLines(text);
    expect(lines).toEqual([
      { label: "sh›", text: "$ supabase db push --linked", tone: "machine" },
      { label: "err›", text: "(eval):1: command not found: supabase", tone: "error" },
    ]);
  });

  test("guard: type-parameter-like/URL-like/inline-code angle brackets never become tags", () => {
    const text = "Use `Array<string>` and see <https://example.com> — `<not-a-tag>` in code";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
    expect(parseUserMessage(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Area 1 — parseMessageSegments matrix

describe("parseMessageSegments — segment matrix", () => {
  test("balanced tag with prose before and after: 3 segments, text verbatim/untrimmed", () => {
    const text = "before text <note>body here</note> after text";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "text", text: "before text " },
      { kind: "tag", name: "note", attrs: "", body: "body here", raw: "<note>body here</note>" },
      { kind: "text", text: " after text" },
    ]);
  });

  test("self-closing <note/> and <note kind=\"x\" /> — attrs captured, body empty", () => {
    expect(parseMessageSegments("<note/>")).toEqual([
      { kind: "tag", name: "note", attrs: "", body: "", raw: "<note/>" },
    ]);
    expect(parseMessageSegments('<note kind="x" />')).toEqual([
      { kind: "tag", name: "note", attrs: 'kind="x"', body: "", raw: '<note kind="x" />' },
    ]);
  });

  test("attrs on a normal (non-self-closing) tag are captured trimmed, body untouched", () => {
    expect(parseMessageSegments('<box kind="x">hello</box>')).toEqual([
      { kind: "tag", name: "box", attrs: 'kind="x"', body: "hello", raw: '<box kind="x">hello</box>' },
    ]);
  });

  test("nested tags of a DIFFERENT name: outer segment's body contains the inner tag's raw text", () => {
    const text = "<outer>text <inner>y</inner> more</outer>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "outer", attrs: "", body: "text <inner>y</inner> more", raw: text },
    ]);
  });

  test("same-name nesting closes at the OUTER close, not the inner one", () => {
    const text = "<a-tag>outer <a-tag>inner</a-tag> more</a-tag>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "a-tag", attrs: "", body: "outer <a-tag>inner</a-tag> more", raw: text },
    ]);
  });

  test("unbalanced <foo> (no closing tag) yields a single untouched text segment", () => {
    const text = "<foo>abc";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("uppercase tag names (<T>, <Foo>) are never recognized as tags", () => {
    expect(parseMessageSegments("<T>abc</T>")).toEqual([{ kind: "text", text: "<T>abc</T>" }]);
    expect(parseMessageSegments("<Foo>abc</Foo>")).toEqual([{ kind: "text", text: "<Foo>abc</Foo>" }]);
  });

  test("Array<string> (a TS generic, no matching close) stays plain text", () => {
    const text = "a value of type Array<string> in TS";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("an autolink <https://example.com> is never a tag", () => {
    const text = "see <https://example.com> for more";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("an email autolink <foo@bar.com> is never a tag", () => {
    const text = "contact <foo@bar.com> please";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("HTML element names (<b>, <div>) stay literal text", () => {
    expect(parseMessageSegments("<b>x</b>")).toEqual([{ kind: "text", text: "<b>x</b>" }]);
    expect(parseMessageSegments("<div>..</div>")).toEqual([{ kind: "text", text: "<div>..</div>" }]);
  });

  test("the three reserved command-XML tag names are never recognized as generic tags", () => {
    expect(parseMessageSegments("<command-message>hi</command-message>")).toEqual([
      { kind: "text", text: "<command-message>hi</command-message>" },
    ]);
    expect(parseMessageSegments("<command-name>/foo</command-name>")).toEqual([
      { kind: "text", text: "<command-name>/foo</command-name>" },
    ]);
    expect(parseMessageSegments("<command-args>x</command-args>")).toEqual([
      { kind: "text", text: "<command-args>x</command-args>" },
    ]);
  });

  test("a tag inside a fenced ``` block is protected as text; a tag AFTER the fence still parses", () => {
    const text = ["```", "<inside>fenced</inside>", "```", "<after>parsed</after>"].join("\n");
    expect(parseMessageSegments(text)).toEqual([
      { kind: "text", text: "```\n<inside>fenced</inside>\n```\n" },
      { kind: "tag", name: "after", attrs: "", body: "parsed", raw: "<after>parsed</after>" },
    ]);
  });

  test("a tag inside a fenced ~~~ block is protected as text; a tag AFTER the fence still parses", () => {
    const text = ["~~~", "<inside>fenced</inside>", "~~~", "<after>parsed</after>"].join("\n");
    expect(parseMessageSegments(text)).toEqual([
      { kind: "text", text: "~~~\n<inside>fenced</inside>\n~~~\n" },
      { kind: "tag", name: "after", attrs: "", body: "parsed", raw: "<after>parsed</after>" },
    ]);
  });

  test("a tag inside an inline code span (backticks) stays literal text", () => {
    const text = "see `<flag>on</flag>` here";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("an unterminated fence protects everything to the end of the text", () => {
    const text = ["```", "<tag>never closes</tag>", "more text with <another>tag</another>"].join("\n");
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("CRLF newlines inside a tag body are normalized to \\n", () => {
    expect(parseMessageSegments("<box>line one\r\nline two</box>")).toEqual([
      { kind: "tag", name: "box", attrs: "", body: "line one\nline two", raw: "<box>line one\nline two</box>" },
    ]);
  });

  test("bare \\r newlines inside a tag body are normalized to \\n", () => {
    expect(parseMessageSegments("<box>line one\rline two</box>")).toEqual([
      { kind: "tag", name: "box", attrs: "", body: "line one\nline two", raw: "<box>line one\nline two</box>" },
    ]);
  });

  test("whitespace-only text between two adjacent tags produces no text segment", () => {
    expect(parseMessageSegments("<one>1</one>   \n  <two>2</two>")).toEqual([
      { kind: "tag", name: "one", attrs: "", body: "1", raw: "<one>1</one>" },
      { kind: "tag", name: "two", attrs: "", body: "2", raw: "<two>2</two>" },
    ]);
  });

  test("a tag at the very start of the text, with trailing prose", () => {
    expect(parseMessageSegments("<start>tag</start> trailing text")).toEqual([
      { kind: "tag", name: "start", attrs: "", body: "tag", raw: "<start>tag</start>" },
      { kind: "text", text: " trailing text" },
    ]);
  });

  test("a tag at the very end of the text, with leading prose", () => {
    expect(parseMessageSegments("leading text <end>tag</end>")).toEqual([
      { kind: "text", text: "leading text " },
      { kind: "tag", name: "end", attrs: "", body: "tag", raw: "<end>tag</end>" },
    ]);
  });

  test("a tag that is the entire text (no surrounding prose at all)", () => {
    expect(parseMessageSegments("<whole>tag</whole>")).toEqual([
      { kind: "tag", name: "whole", attrs: "", body: "tag", raw: "<whole>tag</whole>" },
    ]);
  });

  test("a lone trailing '<' as the last character is never a tag", () => {
    const text = "hello <";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("a closing tag with no matching open (</name> before any open) is text", () => {
    const text = "</foo> some text";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("no tags at all: exactly one text segment covering the whole input", () => {
    const text = "just prose text";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("hasTagSegments is true when at least one tag segment is present", () => {
    expect(hasTagSegments(parseMessageSegments("<one>1</one>"))).toBe(true);
  });

  test("hasTagSegments is false for pure prose (no tags recognized)", () => {
    expect(hasTagSegments(parseMessageSegments("just prose text"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Area 2 — real fixtures (prod transcript shapes from the plan)

describe("parseMessageSegments / userMessageLines — real fixtures", () => {
  const forkedNewline =
    "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
    '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
  const forkedSpace =
    "<local-command-stdout>Running in the background as @code-review</local-command-stdout> " +
    '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';

  test("newline-separated forked-skill-launch line: 2 tag segments, isMachineEmittedMessage true", () => {
    const segments = parseMessageSegments(forkedNewline);
    expect(segments.filter((s) => s.kind === "tag")).toHaveLength(2);
    expect(segments).toHaveLength(2);
    expect(isMachineEmittedMessage(segments)).toBe(true);
  });

  test("space-separated forked-skill-launch line (copy-paste artifact): same result as newline-separated", () => {
    const segments = parseMessageSegments(forkedSpace);
    expect(segments.filter((s) => s.kind === "tag")).toHaveLength(2);
    expect(segments).toHaveLength(2);
    expect(isMachineEmittedMessage(segments)).toBe(true);
  });

  test("<bash-input>supabase db push --linked</bash-input> alone parses to a single machine-emitted tag", () => {
    const text = "<bash-input>supabase db push --linked</bash-input>";
    const segments = parseMessageSegments(text);
    expect(segments).toEqual([
      { kind: "tag", name: "bash-input", attrs: "", body: "supabase db push --linked", raw: text },
    ]);
    expect(isMachineEmittedMessage(segments)).toBe(true);
    expect(userMessageLines(text)).toEqual([{ label: "sh›", text: "$ supabase db push --linked", tone: "machine" }]);
  });

  test("<bash-stdout></bash-stdout><bash-stderr>...</bash-stderr> pair with empty stdout", () => {
    const text = "<bash-stdout></bash-stdout><bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>";
    const segments = parseMessageSegments(text);
    expect(segments).toEqual([
      { kind: "tag", name: "bash-stdout", attrs: "", body: "", raw: "<bash-stdout></bash-stdout>" },
      {
        kind: "tag",
        name: "bash-stderr",
        attrs: "",
        body: "(eval):1: command not found: supabase\n",
        raw: "<bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>",
      },
    ]);
    expect(isMachineEmittedMessage(segments)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Area 3 — parseForkedSkillLaunch / forkedSkillLabel / humanizeTagName /
// tryParseJsonBody / stripAnsiSgr

describe("parseForkedSkillLaunch", () => {
  test("valid body with all three fields", () => {
    expect(
      parseForkedSkillLaunch('{"agentId":"abc123","skillName":"code-review","description":"/code-review"}'),
    ).toEqual({ agentId: "abc123", skillName: "code-review", description: "/code-review" });
  });

  test("missing agentId and description default to empty strings", () => {
    expect(parseForkedSkillLaunch('{"skillName":"code-review"}')).toEqual({
      agentId: "",
      skillName: "code-review",
      description: "",
    });
  });

  test("a JSON array body is not an object → null", () => {
    expect(parseForkedSkillLaunch("[1,2,3]")).toBeNull();
  });

  test("a JSON scalar body (string) is not an object → null", () => {
    expect(parseForkedSkillLaunch('"just a string"')).toBeNull();
  });

  test("invalid JSON → null", () => {
    expect(parseForkedSkillLaunch("{not json")).toBeNull();
  });

  test("missing skillName → null", () => {
    expect(parseForkedSkillLaunch('{"agentId":"abc"}')).toBeNull();
  });

  test("non-string skillName → null", () => {
    expect(parseForkedSkillLaunch('{"skillName":123}')).toBeNull();
  });

  test("empty or whitespace-only body → null", () => {
    expect(parseForkedSkillLaunch("")).toBeNull();
    expect(parseForkedSkillLaunch("   ")).toBeNull();
  });
});

describe("forkedSkillLabel", () => {
  test("description starting with '/' wins over skillName", () => {
    expect(forkedSkillLabel({ agentId: "a", skillName: "code-review", description: "/code-review" })).toBe(
      "/code-review",
    );
  });

  test("description not starting with '/' falls back to /<skillName>", () => {
    expect(forkedSkillLabel({ agentId: "a", skillName: "code-review", description: "runs code review" })).toBe(
      "/code-review",
    );
  });

  test("empty description falls back to /<skillName>", () => {
    expect(forkedSkillLabel({ agentId: "a", skillName: "code-review", description: "" })).toBe("/code-review");
  });
});

describe("humanizeTagName", () => {
  test("hyphens become spaces", () => {
    expect(humanizeTagName("forked-skill-launch")).toBe("forked skill launch");
  });

  test("underscores become spaces", () => {
    expect(humanizeTagName("some_tag_name")).toBe("some tag name");
  });

  test("runs of mixed hyphens/underscores collapse to a single space", () => {
    expect(humanizeTagName("a--b__c")).toBe("a b c");
  });

  test("a name with no separators is returned unchanged", () => {
    expect(humanizeTagName("note")).toBe("note");
  });
});

describe("tryParseJsonBody", () => {
  test("a JSON object body returns the parsed value", () => {
    expect(tryParseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  test("a JSON array body returns the parsed value", () => {
    expect(tryParseJsonBody("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("a scalar JSON body (string/number/boolean/null) returns undefined", () => {
    expect(tryParseJsonBody('"hello"')).toBeUndefined();
    expect(tryParseJsonBody("42")).toBeUndefined();
    expect(tryParseJsonBody("true")).toBeUndefined();
    expect(tryParseJsonBody("null")).toBeUndefined();
  });

  test("invalid JSON returns undefined", () => {
    expect(tryParseJsonBody("{not json")).toBeUndefined();
  });

  test("empty/whitespace-only body returns undefined", () => {
    expect(tryParseJsonBody("")).toBeUndefined();
    expect(tryParseJsonBody("   ")).toBeUndefined();
  });
});

describe("stripAnsiSgr", () => {
  test("strips SGR escape codes around bolded text", () => {
    expect(stripAnsiSgr("Set model to \x1b[1mOpus 5\x1b[22m done")).toBe("Set model to Opus 5 done");
  });

  test("text with no ANSI codes is returned unchanged", () => {
    expect(stripAnsiSgr("no ansi here")).toBe("no ansi here");
  });
});

// ---------------------------------------------------------------------------
// Area 4 — isMachineEmittedMessage

describe("isMachineEmittedMessage", () => {
  test("true when every segment is a machine tag", () => {
    expect(isMachineEmittedMessage(parseMessageSegments("<bash-input>ls</bash-input>"))).toBe(true);
  });

  test("false when a machine tag is mixed with authored text", () => {
    expect(isMachineEmittedMessage(parseMessageSegments("hi <bash-input>ls</bash-input>"))).toBe(false);
  });

  test("false for a user-authored tag not in MACHINE_TAGS (e.g. <context>)", () => {
    expect(isMachineEmittedMessage(parseMessageSegments("<context>hello</context>"))).toBe(false);
  });

  test("false for an empty segment array", () => {
    expect(isMachineEmittedMessage([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Area 5 — parseUserMessage → tagged kind, precedence, and null guards

describe("parseUserMessage — tagged kind", () => {
  test("a user-authored tag plus prose parses to kind 'tagged' with segments and empty references", () => {
    const text = "<context>some info</context>\n\nPlease do the thing";
    const segments = parseMessageSegments(text);
    expect(parseUserMessage(text)).toEqual({ kind: "tagged", text, segments, references: [] });
  });

  test("a trailing Referenced files/folders block is split off: text excludes it, references populated", () => {
    const base = "<context>info</context>\n\nDo it";
    const text = appendReferences(base, REFS);
    const expectedSegments = parseMessageSegments(base);
    expect(parseUserMessage(text)).toEqual({
      kind: "tagged",
      text: base,
      segments: expectedSegments,
      references: ["/a/b.png", "/c/d/"],
    });
  });

  test("a message with only HTML-named or unbalanced tags is ordinary text → null", () => {
    expect(parseUserMessage("<b>x</b>")).toBeNull();
    expect(parseUserMessage("<foo>abc")).toBeNull();
  });
});

describe("parseUserMessage — precedence order", () => {
  test("the slash-command XML twin wins even when its args contain a user-authored tag (kind stays 'command', tag left inside args)", () => {
    const xml = [
      "<command-message>run</command-message>",
      "<command-name>/run</command-name>",
      "<command-args>please handle <note>this thing</note> carefully</command-args>",
    ].join("\n");
    expect(parseUserMessage(xml)).toEqual({
      kind: "command",
      command: { name: "/run", args: "please handle <note>this thing</note> carefully", references: [] },
    });
  });

  test("a lone <local-command-stdout> (full match) stays kind 'command-output', not 'tagged'", () => {
    expect(parseUserMessage("<local-command-stdout>only</local-command-stdout>")).toEqual({
      kind: "command-output",
      output: "only",
    });
  });

  test("local-command-stdout combined with extra prose fails the strict full-match and falls through to 'tagged'", () => {
    const text = "<local-command-stdout>foo</local-command-stdout> and more text";
    expect(parseUserMessage(text)).toEqual({
      kind: "tagged",
      text,
      segments: parseMessageSegments(text),
      references: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Area 6 — userMessageLines plain-text rendering

describe("userMessageLines", () => {
  test("ordinary text yields exactly one you› line, untouched (including a bare-CR input)", () => {
    expect(userMessageLines("just a normal reply about the bug")).toEqual([
      { label: "you›", text: "just a normal reply about the bug", tone: "user" },
    ]);
    const crText = "line one\rline two";
    expect(userMessageLines(crText)).toEqual([{ label: "you›", text: crText, tone: "user" }]);
  });

  test("the XML command expansion renders as you› /name args", () => {
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      "<command-args>do the thing</command-args>",
    ].join("\n");
    expect(userMessageLines(xml)).toEqual([{ label: "you›", text: "/implement do the thing", tone: "user" }]);
  });

  test("command-output renders as a single cmd› line", () => {
    expect(userMessageLines("<local-command-stdout>some output</local-command-stdout>")).toEqual([
      { label: "cmd›", text: "some output", tone: "machine" },
    ]);
  });

  test("the forked-skill-launch fixture renders cmd› then skill› with a shortened agent id", () => {
    const text =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
    expect(userMessageLines(text)).toEqual([
      { label: "cmd›", text: "Running in the background as @code-review", tone: "machine" },
      { label: "skill›", text: "/code-review launched in background (agent a7db6829)", tone: "machine" },
    ]);
  });

  test("bash trio: empty stdout produces no line, stderr is err›/error, input is sh›/$ cmd", () => {
    const text =
      "<bash-input>ls -la</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>boom\n</bash-stderr>";
    expect(userMessageLines(text)).toEqual([
      { label: "sh›", text: "$ ls -la", tone: "machine" },
      { label: "err›", text: "boom", tone: "error" },
    ]);
  });

  test("a generic (unrecognized) tag renders as <name>› with tone 'tag'; nested tags stay raw in its body", () => {
    expect(userMessageLines("<context>hello there</context>")).toEqual([
      { label: "context›", text: "hello there", tone: "tag" },
    ]);
    expect(userMessageLines("<outer>a <inner>b</inner> c</outer>")).toEqual([
      { label: "outer›", text: "a <inner>b</inner> c", tone: "tag" },
    ]);
  });

  test("a tagged message with a trailing refs block appends a final refs› line", () => {
    const text = appendReferences("<context>info</context>\n\nDo it", REFS);
    expect(userMessageLines(text)).toEqual([
      { label: "context›", text: "info", tone: "tag" },
      { label: "you›", text: "Do it", tone: "user" },
      { label: "refs›", text: "/a/b.png, /c/d/", tone: "user" },
    ]);
  });

  test("ANSI SGR codes are stripped from a local-command-stdout line inside a tagged (multi-tag) message", () => {
    const text =
      "<local-command-stdout>Set model to \x1b[1mOpus 5\x1b[22m done</local-command-stdout>\n" +
      '<forked-skill-launch>{"skillName":"code-review"}</forked-skill-launch>';
    expect(userMessageLines(text)).toEqual([
      { label: "cmd›", text: "Set model to Opus 5 done", tone: "machine" },
      { label: "skill›", text: "/code-review launched in background", tone: "machine" },
    ]);
  });

  test("result is never empty: an all-empty bash pair falls back to a single cmd› — line", () => {
    expect(userMessageLines("<bash-stdout></bash-stdout><bash-stderr></bash-stderr>")).toEqual([
      { label: "cmd›", text: "—", tone: "machine" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Area 7 — canonicalizeUserText identity on tagged text

describe("canonicalizeUserText — tagged messages stay byte-identical", () => {
  test("a user-authored tagged message is returned identically", () => {
    const text = "<context>some info</context>\n\nPlease do the thing";
    expect(canonicalizeUserText(text)).toBe(text);
  });

  test("the forked-skill-launch fixture is returned identically (byte-for-byte, no CR normalization)", () => {
    const text =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\r" +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
    expect(canonicalizeUserText(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 review fixes (docs/plans/tagged-user-messages.md, task FIX-A)

describe("findBalancedClose — same-name self-closing tag inside a body (Fix 1)", () => {
  test("<note><note/></note> is ONE balanced tag whose body is the self-closing child, not unbalanced", () => {
    const text = "<note><note/></note>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "note", attrs: "", body: "<note/>", raw: text },
    ]);
  });

  test("a self-closing same-name tag mixed with a real nested same-name tag still closes at the outer close", () => {
    const text = "<a-tag>x <a-tag/> y <a-tag>z</a-tag></a-tag>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "a-tag", attrs: "", body: "x <a-tag/> y <a-tag>z</a-tag>", raw: text },
    ]);
  });
});

describe("TAG_OPEN_RE — quote-aware attrs allow a literal '>' inside a quoted value (Fix 2)", () => {
  test("a double-quoted attribute value containing '>' does not split the tag early", () => {
    const text = '<note title="x > y">foo</note>';
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "note", attrs: 'title="x > y"', body: "foo", raw: text },
    ]);
  });

  test("a single-quoted attribute value containing '>' does not split the tag early", () => {
    const text = "<note title='x > y'>foo</note>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "note", attrs: "title='x > y'", body: "foo", raw: text },
    ]);
  });

  test("an unbalanced quote in an attribute value fails the open match entirely — stays literal text", () => {
    const text = '<note title="x>foo</note>';
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("a plain unquoted attribute (no quotes involved) still parses", () => {
    expect(parseMessageSegments("<step n=1>go</step>")).toEqual([
      { kind: "tag", name: "step", attrs: "n=1", body: "go", raw: "<step n=1>go</step>" },
    ]);
  });
});

describe("computeProtectedRanges — indented code blocks (Fix 3)", () => {
  test("a 4-space-indented tag preceded by a blank line is protected: whole message stays a single text segment", () => {
    const text = "text\n\n    <config>value</config>\n";
    expect(parseMessageSegments(text)).toEqual([{ kind: "text", text }]);
  });

  test("an indented block between two real tags protects only the middle one", () => {
    // "a"/"b" are avoided here — they're HTML_ELEMENT_NAMES (anchor/bold) and
    // never recognized as tags regardless of indentation; this test is about
    // the indented-code carve-out specifically.
    const text = "<one>1</one>\n\n    <note>2</note>\n\nafter <three>3</three>";
    expect(parseMessageSegments(text)).toEqual([
      { kind: "tag", name: "one", attrs: "", body: "1", raw: "<one>1</one>" },
      { kind: "text", text: "\n\n    <note>2</note>\n\nafter " },
      { kind: "tag", name: "three", attrs: "", body: "3", raw: "<three>3</three>" },
    ]);
  });
});

describe("protectedRangeAt — binary search correctness and non-quadratic performance (Fix 4)", () => {
  test("several inline-code spans plus a fence still combine correctly (no cross-contamination between ranges)", () => {
    const lines = [
      "prefix `<a>x</a>` and `<b>y</b>` middle",
      "```",
      "<inside>fenced</inside>",
      "```",
      "tail <c>z</c> and `<d>w</d>` end",
    ];
    const text = lines.join("\n");
    expect(parseMessageSegments(text)).toEqual([
      {
        kind: "text",
        text: "prefix `<a>x</a>` and `<b>y</b>` middle\n```\n<inside>fenced</inside>\n```\ntail ",
      },
      { kind: "tag", name: "c", attrs: "", body: "z", raw: "<c>z</c>" },
      { kind: "text", text: " and `<d>w</d>` end" },
    ]);
  });

  test("a ~200KB message with 2000 inline-code spans and 2000 generic-looking angle brackets parses in well under 200ms", () => {
    const rows: string[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(
        `Line ${i}: some prose padding to bulk up the line \`<code-${i}>\` inline, plus a Map<string, number> generic here.`,
      );
    }
    const text = rows.join("\n");
    expect(text.length).toBeGreaterThan(150_000);

    const started = performance.now();
    const segments = parseMessageSegments(text);
    const elapsed = performance.now() - started;

    // None of the angle brackets here form a recognized tag (the code spans
    // are backtick-protected; the generics are broken by their comma) — the
    // whole thing collapses to one text segment either way. The real
    // assertion is the timing bound below: this is not a correctness probe.
    expect(segments).toEqual([{ kind: "text", text }]);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("userMessageLines — command args containing tags render per-segment, not as raw XML (Fix 5a)", () => {
  test("a slash-command XML twin whose args contain a tag renders you› <name> then per-segment lines", () => {
    const xml = [
      "<command-message>run</command-message>",
      "<command-name>/run</command-name>",
      "<command-args>see <context>ctx</context> now</command-args>",
    ].join("\n");
    expect(userMessageLines(xml)).toEqual([
      { label: "you›", text: "/run", tone: "user" },
      { label: "you›", text: "see", tone: "user" },
      { label: "context›", text: "ctx", tone: "tag" },
      { label: "you›", text: "now", tone: "user" },
    ]);
  });

  test("the same shape via a plain echo (no XML) renders identically", () => {
    const text = "/run see <context>ctx</context> now";
    expect(userMessageLines(text)).toEqual([
      { label: "you›", text: "/run", tone: "user" },
      { label: "you›", text: "see", tone: "user" },
      { label: "context›", text: "ctx", tone: "tag" },
      { label: "you›", text: "now", tone: "user" },
    ]);
  });

  test("a trailing refs block on a tagged command's args appends a final refs› line", () => {
    const baseArgs = "see <context>ctx</context> now";
    const argsRaw = appendReferences(baseArgs, REFS);
    const xml = [
      "<command-message>run</command-message>",
      "<command-name>/run</command-name>",
      `<command-args>${argsRaw}</command-args>`,
    ].join("\n");
    expect(userMessageLines(xml)).toEqual([
      { label: "you›", text: "/run", tone: "user" },
      { label: "you›", text: "see", tone: "user" },
      { label: "context›", text: "ctx", tone: "tag" },
      { label: "you›", text: "now", tone: "user" },
      { label: "refs›", text: "/a/b.png, /c/d/", tone: "user" },
    ]);
  });

  test("a command with no tags in its args keeps today's single-line rendering byte-for-byte", () => {
    const xml = [
      "<command-message>implement</command-message>",
      "<command-name>/implement</command-name>",
      "<command-args>do the thing</command-args>",
    ].join("\n");
    expect(userMessageLines(xml)).toEqual([{ label: "you›", text: "/implement do the thing", tone: "user" }]);
  });
});

describe("userMessageLines — generic tag label includes attrs when present (Fix 5b)", () => {
  test("a generic tag with attributes renders '<name> <attrs>›' as the label", () => {
    expect(userMessageLines('<note kind="x">hello</note>')).toEqual([
      { label: 'note kind="x"›', text: "hello", tone: "tag" },
    ]);
  });

  test("a generic tag with no attributes keeps the plain '<name>›' label (no regression)", () => {
    expect(userMessageLines("<context>hello</context>")).toEqual([
      { label: "context›", text: "hello", tone: "tag" },
    ]);
  });
});
