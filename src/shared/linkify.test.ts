import { expect, test } from "bun:test";
import { splitLinks } from "./linkify.ts";

// --- no URL / empty input ----------------------------------------------------

test("splitLinks: no URL yields a single text segment identical to the input", () => {
  const text = "hello world, nothing to link here.";
  expect(splitLinks(text)).toEqual([{ type: "text", value: text }]);
});

test('splitLinks: "" yields an empty array', () => {
  expect(splitLinks("")).toEqual([]);
});

// --- a single URL -------------------------------------------------------------

test("splitLinks: a bare URL with no surrounding text yields a single link segment", () => {
  expect(splitLinks("https://example.com")).toEqual([{ type: "link", value: "https://example.com" }]);
});

// --- trailing sentence punctuation ---------------------------------------------

test("splitLinks: a trailing period is stripped back into the following text segment", () => {
  expect(splitLinks("Visit https://example.com.")).toEqual([
    { type: "text", value: "Visit " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: "." },
  ]);
});

test("splitLinks: a trailing comma is stripped back into the following text segment", () => {
  expect(splitLinks("See https://example.com, thanks")).toEqual([
    { type: "text", value: "See " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: ", thanks" },
  ]);
});

test("splitLinks: a trailing semicolon is stripped back into the following text segment", () => {
  expect(splitLinks("Ref https://example.com; done")).toEqual([
    { type: "text", value: "Ref " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: "; done" },
  ]);
});

test("splitLinks: a trailing ) with no matching ( inside the URL itself is stripped (unbalanced)", () => {
  expect(splitLinks("(see https://example.com)")).toEqual([
    { type: "text", value: "(see " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: ")" },
  ]);
});

// --- Wikipedia-style balanced parenthetical -------------------------------------

test("splitLinks: a Wikipedia-style URL whose own path contains a balanced parenthetical keeps its trailing )", () => {
  expect(splitLinks("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
    { type: "link", value: "https://en.wikipedia.org/wiki/Foo_(bar)" },
  ]);
});

test("splitLinks: the same balanced-parenthetical URL still keeps its ) when surrounded by prose", () => {
  expect(splitLinks("See https://en.wikipedia.org/wiki/Foo_(bar) now")).toEqual([
    { type: "text", value: "See " },
    { type: "link", value: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    { type: "text", value: " now" },
  ]);
});

// --- link fully wrapped in parens ------------------------------------------------

test("splitLinks: (https://x.com) — the whole URL sits inside surrounding parens; the unmatched ) is trimmed to text", () => {
  expect(splitLinks("(https://x.com)")).toEqual([
    { type: "text", value: "(" },
    { type: "link", value: "https://x.com" },
    { type: "text", value: ")" },
  ]);
});

// --- multiple URLs / position ------------------------------------------------------

test("splitLinks: two URLs separated by text yield link/text/link", () => {
  expect(splitLinks("https://a.com and https://b.com")).toEqual([
    { type: "link", value: "https://a.com" },
    { type: "text", value: " and " },
    { type: "link", value: "https://b.com" },
  ]);
});

test("splitLinks: a URL at the very start of the text", () => {
  expect(splitLinks("https://a.com is the place")).toEqual([
    { type: "link", value: "https://a.com" },
    { type: "text", value: " is the place" },
  ]);
});

test("splitLinks: a URL at the very end of the text", () => {
  expect(splitLinks("go to https://a.com")).toEqual([
    { type: "text", value: "go to " },
    { type: "link", value: "https://a.com" },
  ]);
});

// --- http:// (not just https://) ---------------------------------------------------

test("splitLinks: plain http:// (not https) is still recognized as a link", () => {
  expect(splitLinks("insecure: http://example.com here")).toEqual([
    { type: "text", value: "insecure: " },
    { type: "link", value: "http://example.com" },
    { type: "text", value: " here" },
  ]);
});

// --- angle-bracket / quote termination -----------------------------------------------

test("splitLinks: angle brackets terminate the URL scan and are never consumed into the link", () => {
  expect(splitLinks("<https://a.com>")).toEqual([
    { type: "text", value: "<" },
    { type: "link", value: "https://a.com" },
    { type: "text", value: ">" },
  ]);
});

test("splitLinks: double and single quotes terminate the URL scan and are never consumed into the link", () => {
  expect(splitLinks('"https://a.com"')).toEqual([
    { type: "text", value: '"' },
    { type: "link", value: "https://a.com" },
    { type: "text", value: '"' },
  ]);
  expect(splitLinks("'https://a.com'")).toEqual([
    { type: "text", value: "'" },
    { type: "link", value: "https://a.com" },
    { type: "text", value: "'" },
  ]);
});

// --- adjacent text merged ------------------------------------------------------------

test("splitLinks: trailing punctuation and the prose that follows it land in ONE merged text segment, never two adjacent text nodes", () => {
  const segments = splitLinks("Check https://example.com. Thanks!");
  expect(segments).toEqual([
    { type: "text", value: "Check " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: ". Thanks!" },
  ]);
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    expect(prev.type === "text" && cur.type === "text").toBe(false);
  }
});

test("splitLinks: never returns two consecutive text-type segments, across a battery of inputs", () => {
  const samples = [
    "no links at all, just prose.",
    "(see https://example.com).",
    "https://a.com, https://b.com.",
    "<https://a.com> and \"https://b.com\"",
    "https://en.wikipedia.org/wiki/Foo_(bar), also https://en.wikipedia.org/wiki/Baz_(qux).",
  ];
  for (const sample of samples) {
    const segments = splitLinks(sample);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.type === "text" && segments[i - 1]!.type === "text").toBe(false);
    }
  }
});

// --- lossless split (bonus invariant) -------------------------------------------------

test("splitLinks: segments always join back to the original text exactly, across a battery of inputs", () => {
  const samples = [
    "",
    "no links here",
    "https://a.com",
    "(https://x.com)",
    "Check https://example.com. Thanks!",
    "<https://a.com>",
    "https://a.com and https://b.com",
    "rate_limit_exceeded: Free tier requests on this model are rate-limited. Upgrade to paid credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.",
  ];
  for (const sample of samples) {
    expect(splitLinks(sample).map((seg) => seg.value).join("")).toBe(sample);
  }
});

// --- exact live Gateway message (docs/plans/fix-fx-harness-rate-limit.md §2) -----------

test("splitLinks: the exact live Gateway rate-limit message yields the URL alone, without the trailing ' for unrestricted access.' text", () => {
  const message =
    "rate_limit_exceeded: Free tier requests on this model are rate-limited. Upgrade to paid credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.";
  const segments = splitLinks(message);

  const links = segments.filter((s) => s.type === "link");
  expect(links).toEqual([{ type: "link", value: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up" }]);

  const linkIndex = segments.findIndex((s) => s.type === "link");
  const after = segments[linkIndex + 1];
  expect(after?.type).toBe("text");
  expect(after?.value.startsWith(" for unrestricted access.")).toBe(true);

  // Splitting must be lossless — no characters gained or dropped.
  expect(segments.map((s) => s.value).join("")).toBe(message);
});
