import { describe, expect, test } from "bun:test";
import {
  canonicalizeUserText,
  isMachineEmittedMessage,
  parseForkedSkillLaunch,
  parseMessageSegments,
  parseUserMessage,
  splitReferences,
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
