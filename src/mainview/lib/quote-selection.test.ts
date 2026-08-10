import { expect, test } from "bun:test";
import { appendQuote, formatQuote } from "./quote-selection.ts";

// --- formatQuote ---------------------------------------------------------

test("formatQuote prefixes a single line with '> '", () => {
  expect(formatQuote("hello")).toBe("> hello");
});

test("formatQuote prefixes every line of a multi-line selection", () => {
  expect(formatQuote("a\nb\nc")).toBe("> a\n> b\n> c");
});

test("formatQuote normalizes CRLF to LF before quoting", () => {
  expect(formatQuote("a\r\nb\r\nc")).toBe("> a\n> b\n> c");
});

test("formatQuote strips leading and trailing blank lines", () => {
  expect(formatQuote("\n\nhello\n\n")).toBe("> hello");
});

test("formatQuote turns an embedded blank line into a bare '>'", () => {
  // Blank lines *inside* the selection are preserved (unlike the
  // leading/trailing ones), just re-rendered without the trailing space
  // a naive `"> " + line` would leave behind.
  expect(formatQuote("a\n\nb")).toBe("> a\n>\n> b");
});

test("formatQuote returns '' for whitespace-only input (spaces, tabs, newlines)", () => {
  expect(formatQuote("   \n\t\n   ")).toBe("");
});

test("formatQuote returns '' for an empty string", () => {
  expect(formatQuote("")).toBe("");
});

test("formatQuote renders a whitespace-only inner line as a bare '>' with no trailing whitespace", () => {
  const out = formatQuote("a\n   \nb");
  expect(out).toBe("> a\n>\n> b");
  // Guard against a regression that leaves "> " (space, no content) instead
  // of the bare ">" — split the line back out and check it literally.
  const middle = out.split("\n")[1]!;
  expect(middle).toBe(">");
  expect(middle.endsWith(" ")).toBe(false);
});

test("formatQuote double-prefixes already-quoted input", () => {
  expect(formatQuote("> hello")).toBe("> > hello");
});

test("formatQuote passes markdown syntax through verbatim", () => {
  const src = "**bold** and `code` and [a link](https://example.com)";
  expect(formatQuote(src)).toBe(`> ${src}`);
});

// --- appendQuote -----------------------------------------------------------

test("appendQuote with empty quoted returns existing unchanged, caret at existing.length", () => {
  const { text, caret } = appendQuote("draft text", "");
  expect(text).toBe("draft text");
  expect(caret).toBe("draft text".length);
});

test("appendQuote with empty existing returns quoted + trailing blank line, caret at end", () => {
  const quoted = "> hi";
  const { text, caret } = appendQuote("", quoted);
  expect(text).toBe(`${quoted}\n\n`);
  expect(caret).toBe(text.length);
});

test("appendQuote with existing content trims trailing whitespace, joins with blank lines, caret at end", () => {
  const quoted = "> quoted line";
  const { text, caret } = appendQuote("hello world", quoted);
  expect(text).toBe(`hello world\n\n${quoted}\n\n`);
  expect(caret).toBe(text.length);
});

test("appendQuote collapses existing trailing newlines/spaces to a single blank line before the quote", () => {
  const quoted = "> q";
  const { text } = appendQuote("hello\n\n\n   ", quoted);
  // Trailing whitespace (including the newlines) is stripped entirely
  // before the separator is added back, so this must not produce more
  // than one blank line ahead of the quote.
  expect(text).toBe(`hello\n\n${quoted}\n\n`);
  expect(text).not.toContain("\n\n\n");
});

test("appendQuote stacks repeated appends with a single blank line between quotes", () => {
  const first = appendQuote("draft", "> one");
  const second = appendQuote(first.text, "> two");
  expect(second.text).toBe("draft\n\n> one\n\n> two\n\n");
  expect(second.text).not.toContain("\n\n\n");
});

test("appendQuote caret always equals text.length", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["draft", ""],
    ["", "> hi"],
    ["hello world", "> quoted"],
    ["hello\n\n\n   ", "> q"],
  ];
  for (const [existing, quoted] of cases) {
    const { text, caret } = appendQuote(existing, quoted);
    expect(caret).toBe(text.length);
  }
});

test("appendQuote leaves a trailing blank line after the quote whenever quoted is non-empty", () => {
  const cases: Array<[string, string]> = [
    ["", "> hi"],
    ["hello world", "> quoted"],
    ["hello\n\n\n   ", "> q"],
  ];
  for (const [existing, quoted] of cases) {
    const { text } = appendQuote(existing, quoted);
    expect(text.endsWith("\n\n")).toBe(true);
  }
});
