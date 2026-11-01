import { describe, expect, test } from "bun:test";
import {
  HANDOFF_TAG,
  findHandoffBlocks,
  mayContainHandoffOpenTag,
  type HandoffBlockSpan,
} from "./handoff-locator.ts";
import { classifyStepResponse, parseHandoff, splitHandoffMessage } from "./pipeline.ts";
import { PIPELINE_LIMITS } from "./types.ts";

const OPEN = `<${HANDOFF_TAG}>`;
const CLOSE = `</${HANDOFF_TAG}>`;

function json(next: string | null = "Next"): string {
  return JSON.stringify({
    schemaVersion: 1,
    purpose: "p",
    summary: "s",
    reason: "r",
    next,
    artifacts: [],
    openQuestions: [],
  });
}

function block(next: string | null = "Next"): string {
  return `${OPEN}${json(next)}${CLOSE}`;
}

function inners(text: string, opts?: Parameters<typeof findHandoffBlocks>[1]): string[] {
  return findHandoffBlocks(text, opts).map((b) => text.slice(b.openEnd, b.closeStart));
}

/** A verbatim copy of the scanner this module replaced (`findLastHandoffBlock`
 *  in `pipeline.ts` before the locator existed) — the oracle for the legacy
 *  mode, so "byte for byte" is checked against the original code, not against
 *  a re-derivation of it. */
function referenceLastBlock(text: string): string | null {
  const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
  const prefix = `<${HANDOFF_TAG}`;
  const tail =
    text.length > PIPELINE_LIMITS.handoffScanTailBytes
      ? text.slice(text.length - PIPELINE_LIMITS.handoffScanTailBytes)
      : text;
  const lower = tail.toLowerCase();
  const closeAt = (p: number): number => {
    let i = p + 2;
    while (isWs(lower[i])) i++;
    if (!lower.startsWith(HANDOFF_TAG, i)) return -1;
    i += HANDOFF_TAG.length;
    while (isWs(lower[i])) i++;
    return lower[i] === ">" ? i + 1 : -1;
  };
  let cursor = 0;
  let last: string | null = null;
  for (;;) {
    const open = lower.indexOf(prefix, cursor);
    if (open === -1) break;
    const afterName = open + prefix.length;
    const next = lower[afterName];
    let openEnd: number;
    if (next === ">") {
      openEnd = afterName + 1;
    } else if (isWs(next)) {
      const g = lower.indexOf(">", afterName);
      if (g === -1) break;
      openEnd = g + 1;
    } else {
      cursor = open + 1;
      continue;
    }
    let p = openEnd;
    let found: { start: number; end: number } | null = null;
    for (;;) {
      const at = lower.indexOf("</", p);
      if (at === -1) break;
      const end = closeAt(at);
      if (end !== -1) {
        found = { start: at, end };
        break;
      }
      p = at + 2;
    }
    if (found === null) break;
    last = tail.slice(openEnd, found.start);
    cursor = found.end;
  }
  return last;
}

/** Oracle for the code-aware mode on text with no Markdown code characters
 *  and one segment: the legacy pairing, except a pair's open tag moves to the
 *  last open tag before its close that begins a line (only spaces/tabs back to
 *  a newline or the text start), else — when the start's body doesn't begin
 *  with `{` or a fence — to the first later mid-line open not after a `"`
 *  whose body does. Only opens ending at or before the pair's last `{` are
 *  considered, and a pair with no `{` never moves. Brute force — short inputs
 *  only. */
function referenceAnchoredLastBlock(text: string): string | null {
  const openRe = new RegExp(`<${HANDOFF_TAG}(?:>|\\s[^>]*>)`, "gi");
  const closeRe = new RegExp(`</\\s*${HANDOFF_TAG}\\s*>`, "gi");
  let cursor = 0;
  let last: string | null = null;
  for (;;) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(text);
    if (open === null) return last;
    let openEnd = open.index + open[0].length;
    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(text);
    if (close === null) return last;
    // A body that starts (after whitespace) with `{` or a ``` / ~~~ fence.
    const shaped = (end: number) => /^\s*(?:\{|```|~~~)/.test(text.slice(end, close.index));
    const lastBrace = text.slice(openEnd, close.index).lastIndexOf("{");
    const limit = lastBrace === -1 ? -1 : openEnd + lastBrace;
    let shapedAfter: number | null = null;
    for (let p = openEnd; ; ) {
      openRe.lastIndex = p;
      const later = openRe.exec(text);
      if (later === null) break;
      const laterEnd = later.index + later[0].length;
      if (laterEnd > limit) break;
      if (/(^|\n)[ \t]*$/.test(text.slice(0, later.index))) {
        openEnd = laterEnd;
        shapedAfter = null;
      } else if (shapedAfter === null && text[later.index - 1] !== '"' && shaped(laterEnd)) {
        shapedAfter = laterEnd;
      }
      p = laterEnd;
    }
    if (shapedAfter !== null && !shaped(openEnd)) openEnd = shapedAfter;
    last = text.slice(openEnd, close.index);
    cursor = close.index + close[0].length;
  }
}

/** Best of three runs, so a scheduler stall on a loaded machine can't fail a
 *  linear-time budget, while a quadratic scan (seconds at these sizes) still
 *  blows it every time. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  let value = fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    value = fn();
    ms = Math.min(ms, performance.now() - start);
  }
  return { value, ms };
}

describe("findHandoffBlocks — spans", () => {
  test("offsets index the original text and slice into open tag / inner / close tag", () => {
    const text = `prose\n${OPEN}{"a":1}${CLOSE}\ntrailing`;
    const [span] = findHandoffBlocks(text) as [HandoffBlockSpan];
    expect(text.slice(span.start, span.openEnd)).toBe(OPEN);
    expect(text.slice(span.openEnd, span.closeStart)).toBe('{"a":1}');
    expect(text.slice(span.closeStart, span.end)).toBe(CLOSE);
  });

  test("attributes on the open tag, mixed case and whitespace in the close tag are tolerated", () => {
    const text = `<Handoff id="x" data-y='1'>{"a":1}</ HANDOFF >`;
    expect(inners(text)).toEqual(['{"a":1}']);
    expect(inners(text, { codeAware: false })).toEqual(['{"a":1}']);
  });

  test("`<handoffx>` is not an open tag", () => {
    expect(findHandoffBlocks(`<${HANDOFF_TAG}x>{}${CLOSE}`)).toEqual([]);
    expect(findHandoffBlocks(`<${HANDOFF_TAG}x>{}${CLOSE}`, { codeAware: false })).toEqual([]);
  });

  test("offsets stay exact when the text has characters whose full lower-casing changes length", () => {
    const text = `İİİ ${OPEN}{"a":1}${CLOSE}`;
    const [span] = findHandoffBlocks(text) as [HandoffBlockSpan];
    expect(text.slice(span.openEnd, span.closeStart)).toBe('{"a":1}');
  });

  test("several real blocks are all returned in order; the last wins for callers", () => {
    const text = `${block("A")}\n\nprose\n\n${block("B")}\n${OPEN}half-written`;
    const found = inners(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('"next":"A"');
    expect(found[1]).toContain('"next":"B"');
  });

  test("a quoted close tag inside a JSON string pairs with the first close, as before", () => {
    const text = `${OPEN}{"summary":"a ${CLOSE} b"}${CLOSE}`;
    expect(inners(text)).toEqual(['{"summary":"a ']);
    expect(inners(text, { codeAware: false })).toEqual(['{"summary":"a ']);
  });

  test("a nested open pairs with the first close; code-aware starts at the open whose body is the JSON", () => {
    const text = `${OPEN}${OPEN}{"a":1}${CLOSE}${CLOSE}`;
    expect(inners(text)).toEqual(['{"a":1}']);
    expect(inners(text, { codeAware: false })).toEqual([`${OPEN}{"a":1}`]);
  });

  test("tail window: a block ending before the trailing handoffScanTailBytes is not found", () => {
    const padding = "x".repeat(PIPELINE_LIMITS.handoffScanTailBytes);
    const b = block();
    expect(findHandoffBlocks(`${padding}\n${b}`)).toHaveLength(1);
    expect(findHandoffBlocks(`${b}\n${padding}`)).toHaveLength(0);
    expect(findHandoffBlocks(`${b}\n${padding}`, { codeAware: false })).toHaveLength(0);
  });

  test("offsets are in full-text coordinates when the tail window cuts the front", () => {
    const padding = "x".repeat(PIPELINE_LIMITS.handoffScanTailBytes + 10);
    const text = `${padding}\n${block("Tail")}`;
    const [span] = findHandoffBlocks(text) as [HandoffBlockSpan];
    expect(text.slice(span.start, span.openEnd)).toBe(OPEN);
    expect(text.slice(span.closeStart, span.end)).toBe(CLOSE);
  });
});

describe("findHandoffBlocks — a tail window that starts inside a fence", () => {
  const MAX = PIPELINE_LIMITS.handoffScanTailBytes;

  /** One segment: a fence opened before the window, `body` lines filling it past the window start, the
   *  fence closed (or not), then the real block. `extra` shifts where the cut lands within a line. */
  function fenced(extra: number, opts: { fence?: string; closed?: boolean } = {}): string {
    const fence = opts.fence ?? "```";
    const tailPart = `${opts.closed === false ? "" : `${fence}\n`}\n${block("Real")}`;
    const head = `${"p".repeat(extra)}\n${fence}\n`;
    const bodyLen = MAX + 2_000 - head.length - tailPart.length;
    const body = "abcd\n".repeat(Math.floor(bodyLen / 5));
    return head + body + tailPart;
  }

  test("the fence's closing line is not read as an opener: the real block is found (every cut alignment)", () => {
    for (let extra = 0; extra < 6; extra++) {
      const text = fenced(extra);
      expect(text.length).toBeGreaterThan(MAX);
      expect(inners(text, { codeAware: false })).toEqual([json("Real")]);
      expect(inners(text)).toEqual([json("Real")]);
      const parsed = parseHandoff(text);
      expect(parsed.ok && parsed.handoff.next).toBe("Real");
    }
    for (const fence of ["~~~", "````"]) {
      expect(inners(fenced(0, { fence }))).toEqual([json("Real")]);
    }
  });

  test("a fence still open after the window start keeps hiding what follows it (same answer as a full scan)", () => {
    for (let extra = 0; extra < 6; extra++) {
      const text = fenced(extra, { closed: false });
      expect(findHandoffBlocks(text)).toEqual([]);
      // A full scan of the same text without the window (small padding) agrees.
      expect(findHandoffBlocks(`\`\`\`\n${"abcd\n".repeat(10)}\n${block("Real")}`)).toEqual([]);
    }
  });

  test("a fence closed before the window start does not carry into the window", () => {
    const head = `\`\`\`\ncode\n\`\`\`\n`;
    const tailPart = `\n${block("Real")}`;
    const body = "abcd\n".repeat(Math.floor((MAX + 2_000 - head.length - tailPart.length) / 5));
    expect(inners(head + body + tailPart)).toEqual([json("Real")]);
  });

  test("the fence state is per segment: a fence in an earlier segment does not carry into the window's segment", () => {
    const first = `\`\`\`\n${"abcd\n".repeat(10)}`; // an unclosed fence, but in segment 1
    const second = `${"abcd\n".repeat(Math.floor((MAX + 2_000) / 5))}${block("Real")}`;
    const text = first + second;
    const spans = findHandoffBlocks(text, { segmentStarts: [0, first.length] });
    expect(spans.map((b) => text.slice(b.openEnd, b.closeStart))).toEqual([json("Real")]);
  });

  test("a fence opened in the window's own segment before the cut, split into segments after it", () => {
    const first = fenced(0, { closed: false }).slice(0, -(`\n${block("Real")}`.length));
    const second = `\n${block("Real")}`;
    const text = first + second;
    // Segment 1 holds the unclosed fence, segment 2 starts fresh and holds the block.
    const spans = findHandoffBlocks(text, { segmentStarts: [0, first.length] });
    expect(spans.map((b) => text.slice(b.openEnd, b.closeStart))).toEqual([json("Real")]);
  });
});

describe("findHandoffBlocks — code awareness (K1)", () => {
  test("the bug: an inline-code mention of the tag before the real block (with a {…} in the prose) is skipped", () => {
    const text =
      `I checked the \`${OPEN}\` contract and its \`{schemaVersion, …}\` shape before finishing.\n\n${block("Real")}`;
    const found = inners(text);
    expect(found).toEqual([json("Real")]);
    // The legacy mode pairs the mention with the real close tag — the bug this module fixes.
    const legacy = inners(text, { codeAware: false });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).not.toBe(json("Real"));
    expect(legacy[0]).toContain("contract and its");
  });

  test("a double-backtick span containing the tag is skipped", () => {
    const text = `Use \`\`${OPEN}\`\` for the block.\n${block("Real")}`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("a mention with a different-length backtick run inside the span is skipped as one span", () => {
    const text = `Write \`\`a ` + "`" + ` ${OPEN}\`\` first.\n${block("Real")}`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("an unmatched backtick in the same paragraph with no partner is literal — the block is found", () => {
    const text = `It's a \` thing. ${block("Real")}`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("an unmatched backtick in an earlier paragraph does not pair with a backtick inside the JSON", () => {
    const inner = JSON.stringify({ summary: "uses `code` here", next: "Real" });
    const text = `An odd ` + "`" + ` here.\n\n${OPEN}${inner}${CLOSE}`;
    expect(inners(text)).toEqual([inner]);
  });

  test("the earliest-starting span that swallows the open tag hides it (A3)", () => {
    // `a <handoff>{"x":"`"}</handoff> — the first backtick pairs with the one inside the JSON.
    const text = "a ` b " + `${OPEN}{"x":"` + "`" + `"}${CLOSE}`;
    expect(findHandoffBlocks(text)).toEqual([]);
    expect(findHandoffBlocks(text, { codeAware: false })).toHaveLength(1);
  });

  test("a block wrapped entirely in a ``` fence is not a block", () => {
    const text = `Here it is:\n\n\`\`\`\n${block("Real")}\n\`\`\`\n`;
    expect(findHandoffBlocks(text)).toEqual([]);
  });

  test("a block wrapped entirely in a ~~~ fence is not a block", () => {
    const text = `Here it is:\n\n~~~\n${block("Real")}\n~~~\n`;
    expect(findHandoffBlocks(text)).toEqual([]);
  });

  test("a ```json fence INSIDE the tags is fine", () => {
    const text = `${OPEN}\n\`\`\`json\n${json("Real")}\n\`\`\`\n${CLOSE}`;
    expect(inners(text)).toHaveLength(1);
    expect(parseHandoff(text).ok).toBe(true);
  });

  test("a block after a closed fence is found; after an unclosed fence it is not", () => {
    const closed = `\`\`\`js\nconst a = 1;\n\`\`\`\n\n${block("Real")}`;
    expect(inners(closed)).toEqual([json("Real")]);
    const unclosed = `\`\`\`js\nconst a = 1;\n\n${block("Real")}`;
    expect(findHandoffBlocks(unclosed)).toEqual([]);
  });

  test("a longer fence is only closed by an equal-or-longer one; a shorter one inside does not close it", () => {
    const text = `\`\`\`\`\n\`\`\`\n${block("Real")}\n\`\`\`\n\`\`\`\`\n`;
    expect(findHandoffBlocks(text)).toEqual([]);
    const after = `\`\`\`\`\ncode\n\`\`\`\`\n${block("Real")}`;
    expect(inners(after)).toEqual([json("Real")]);
  });

  test("a fence closer must be followed by whitespace only; a ~~~ does not close a ``` fence", () => {
    const text = `\`\`\`\n~~~\n\`\`\` trailing text\n${block("Real")}`;
    expect(findHandoffBlocks(text)).toEqual([]);
  });

  test("a fence indented under a list item, or behind > markers, is still a fence", () => {
    const listItem = `- item\n\n    \`\`\`\n    ${block("Real")}\n    \`\`\`\n`;
    expect(findHandoffBlocks(listItem)).toEqual([]);
    const quoted = `> \`\`\`\n> ${block("Real")}\n> \`\`\`\n`;
    expect(findHandoffBlocks(quoted)).toEqual([]);
  });

  test("a backtick fence opener with a backtick in its info string is not a fence", () => {
    const text = `\`\`\`js \`x\`\n${block("Real")}`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("a 4-space indented block is NOT treated as code (A3)", () => {
    const text = `Example:\n\n    ${block("Real")}\n`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("a fence opener line ends the paragraph — spans cannot cross it", () => {
    // The backtick before the fence has no partner in ITS paragraph, so it is literal.
    const text = `odd \` backtick\n\`\`\`\ncode with \` backtick\n\`\`\`\n${block("Real")}`;
    expect(inners(text)).toEqual([json("Real")]);
  });

  test("a blank line ends the paragraph — a span cannot cross it", () => {
    // The second open's body doesn't start JSON, so it can't re-anchor the block.
    const text = `start \`${OPEN} open\n\nstill prose \` end ${OPEN} note ${json("Real")}${CLOSE}`;
    // First backtick is unmatched in paragraph 1 (the open tag after it is real but unclosed there),
    // so the first open pairs with the first close tag (the real block's) — one span, not two.
    const spans = findHandoffBlocks(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.openEnd)).toBe(OPEN);
    expect(spans[0]!.start).toBeLessThan(text.indexOf("still prose"));
  });

  test("after a real block, scanning resumes with fresh code state (a later fenced mention stays hidden)", () => {
    const text = `${block("A")}\n\n\`\`\`\n${block("Hidden")}\n\`\`\`\n\n${block("B")}`;
    const found = inners(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('"next":"A"');
    expect(found[1]).toContain('"next":"B"');
  });

  test("a close tag inside a code span after a real open still closes the block (block mode ignores Markdown)", () => {
    const text = `${OPEN}{"a":"\`${CLOSE}\`"}${CLOSE}`;
    expect(inners(text)).toEqual(['{"a":"`']);
  });

  test("several real blocks in one paragraph are all found", () => {
    const text = Array.from({ length: 5 }, (_, i) => block(`S${i}`)).join(" ");
    expect(findHandoffBlocks(text)).toHaveLength(5);
  });

  test("an ATX heading is its own paragraph — a backtick in it can't pair with one in the JSON", () => {
    const text = `## Fix \`foo\nSome prose.\n${OPEN}\n{"summary":"uses \` once","next":"N"}\n${CLOSE}`;
    expect(inners(text)).toEqual([`\n{"summary":"uses \` once","next":"N"}\n`]);
    // Behind blockquote markers, and as the line right before the block, too.
    const quoted = `> ### Heading \`x\n${OPEN}\n{"s":"\`"}\n${CLOSE}`;
    expect(inners(quoted)).toEqual([`\n{"s":"\`"}\n`]);
  });

  test("a heading interrupts the paragraph above it", () => {
    const text = `prose with \` tick\n# Title\n${OPEN}\n{"s":"\`"}\n${CLOSE}`;
    expect(inners(text)).toHaveLength(1);
  });

  test("`#foo` (no space) and 7 hashes are not headings — the span still pairs", () => {
    for (const head of ["#foo", "####### seven"]) {
      const text = `${head} \`\n${OPEN}\n{"s":"\`"}\n${CLOSE}`;
      expect(inners(text)).toEqual([]);
    }
  });

  test("a thematic break or setext underline ends the paragraph", () => {
    for (const rule of ["---", "***", "- - -", "___", "===", "  * * *  "]) {
      const text = `prose \` tick\n${rule}\n${OPEN}\n{"s":"\`"}\n${CLOSE}`;
      expect(inners(text)).toHaveLength(1);
    }
    // Not rules: two dashes, a list item, mixed characters.
    for (const notRule of ["--", "- item", "-*-"]) {
      const text = `prose \` tick\n${notRule}\n${OPEN}\n{"s":"\`"}\n${CLOSE}`;
      expect(inners(text)).toEqual([]);
    }
  });

  test("a stray mention that escaped code does not swallow the real block (last line-start open wins)", () => {
    // A malformed inline span leaves one mention outside code; the real block follows on its own lines.
    const text = `I checked \`\`${OPEN}\` and the shape {x}.\n${OPEN}\n${json("Real")}\n${CLOSE}`;
    expect(inners(text)).toEqual([`\n${json("Real")}\n`]);
    expect(parseHandoff(text).ok).toBe(true);
    // Legacy keeps the old pairing.
    expect(inners(text, { codeAware: false })[0]).toContain("and the shape");
  });

  test("an indented line-start open counts; a mid-line one after the real open does not move the start", () => {
    const indented = `see ${OPEN} here\n   ${OPEN}\n{"a":1}\n${CLOSE}`;
    expect(inners(indented)).toEqual(['\n{"a":1}\n']);
    const midLine = `${OPEN}\n{"summary":"writes ${OPEN} then JSON"}\n${CLOSE}`;
    expect(inners(midLine)).toEqual([`\n{"summary":"writes ${OPEN} then JSON"}\n`]);
  });

  test("a mid-line open whose body starts JSON re-anchors past a prose mention (first such open wins)", () => {
    const body = '{"schemaVersion":1,"purpose":"p","summary":"s","reason":"r","next":null}';
    const text = `I end with a ${OPEN} block. Here: ${OPEN}${body}${CLOSE}`;
    expect(inners(text)).toEqual([body]);
    const split = splitHandoffMessage(text);
    expect(split.block?.result.ok).toBe(true);
    expect(split.before).toContain("Here:");
    // Fenced body, with whitespace before the fence.
    const fenced = `mention ${OPEN} here, then ${OPEN} \n\`\`\`json\n{"a":1}\n\`\`\`\n${CLOSE}`;
    expect(inners(fenced)).toEqual([' \n```json\n{"a":1}\n```\n']);
    // The FIRST JSON-shaped open after the prose mention wins, so a later
    // mention inside the real JSON can't move the start.
    const later = `see ${OPEN} below: ${OPEN}{"summary":"x ${OPEN}{ y"}${CLOSE}`;
    expect(inners(later)).toEqual([`{"summary":"x ${OPEN}{ y"}`]);
  });

  test("a mid-line JSON-shaped open never moves a block that already starts JSON, nor one after a quote", () => {
    const nested = `${OPEN}{"summary":"writes ${OPEN}{ inline"}${CLOSE}`;
    expect(inners(nested)).toEqual([`{"summary":"writes ${OPEN}{ inline"}`]);
    const quoted = `mention ${OPEN} then "${OPEN}{}" end${CLOSE}`;
    expect(inners(quoted)).toEqual([` then "${OPEN}{}" end`]);
    // A later line-start open still wins over an earlier mid-line JSON open.
    const lineStart = `mention ${OPEN} x ${OPEN}{"a":1} y\n${OPEN}\n{"b":2}\n${CLOSE}`;
    expect(inners(lineStart)).toEqual(['\n{"b":2}\n']);
  });

  test("re-anchoring never moves the start past the block's last `{` (an extra open-tag line keeps the JSON)", () => {
    // An extra line-start open between the JSON and the close: moving there would leave no JSON.
    const extraLine = `${OPEN}\n${json("Real")}\n${OPEN}\n${CLOSE}`;
    expect(inners(extraLine)).toEqual([`\n${json("Real")}\n${OPEN}\n`]);
    expect(parseHandoff(extraLine).ok).toBe(true);
    expect(inners(extraLine, { codeAware: false })).toEqual(inners(extraLine));
    // Same for a mid-line JSON-shaped candidate rule: a trailing prose open after the JSON stays put.
    const trailing = `mention ${OPEN} here:\n${json("Real")} and ${OPEN} done${CLOSE}`;
    expect(parseHandoff(trailing).ok).toBe(true);
    // A brace-less block never moves at all.
    const braceless = `${OPEN} a\n${OPEN}\nno json\n${CLOSE}`;
    expect(inners(braceless)).toEqual([` a\n${OPEN}\nno json\n`]);
    // Draft-then-corrected still takes the corrected block: its open sits before the last `{`.
    const corrected = `${OPEN}\n${json("Draft")}\n${OPEN}\n${json("Final")}\n${CLOSE}`;
    expect(inners(corrected)).toEqual([`\n${json("Final")}\n`]);
    const parsed = parseHandoff(corrected);
    expect(parsed.ok && parsed.handoff.next).toBe("Final");
  });

  test("a segment start counts as a line start for re-anchoring", () => {
    const segments = [`prose ${OPEN} mention`, `${OPEN}\n{"a":1}\n${CLOSE}`];
    const joined = segments.join("");
    const spans = findHandoffBlocks(joined, { segmentStarts: [0, segments[0]!.length] });
    expect(spans).toHaveLength(1);
    expect(joined.slice(spans[0]!.openEnd, spans[0]!.closeStart)).toBe('\n{"a":1}\n');
  });

  test("a prose mention whose close sits in a later fence is no block — the fence keeps its state", () => {
    // The mention used to pair with the fenced close, and the scan resumed after it with the fence
    // state cleared, so the fence's closing line read as an opener and hid the real block.
    for (const fence of ["```", "~~~", "````"]) {
      const text = `The runner reads the ${OPEN} block.\n${fence}\n${CLOSE}\n${fence}\n${OPEN}\n${json("Real")}\n${CLOSE}`;
      expect(inners(text)).toEqual([`\n${json("Real")}\n`]);
      const parsed = parseHandoff(text);
      expect(parsed.ok && parsed.handoff.next).toBe("Real");
      expect(parseHandoff(text, { codeAware: false }).ok).toBe(true);
    }
    // Same in a later paragraph, behind blockquote markers, and with the close on the fence's info line.
    const later = `Ends with a ${OPEN} block.\n\nMore prose.\n> \`\`\`\n> ${CLOSE}\n> \`\`\`\n${block("Real")}`;
    expect(inners(later)).toEqual([json("Real")]);
    const infoLine = `A ${OPEN} mention.\n\`\`\`${CLOSE}\nbody\n\`\`\`\n${block("Real")}`;
    expect(inners(infoLine)).toEqual([json("Real")]);
  });

  test("a prose mention followed by a fenced example block yields the real block, not the example", () => {
    const text =
      `Remember: the ${OPEN} block goes last.\n` +
      `\`\`\`\n${OPEN}\n${json("Example")}\n${CLOSE}\n\`\`\`\n` +
      `${OPEN}\n${json("Real")}\n${CLOSE}`;
    expect(inners(text)).toEqual([`\n${json("Real")}\n`]);
    const parsed = parseHandoff(text);
    expect(parsed.ok && parsed.handoff.next).toBe("Real");
    expect(splitHandoffMessage(text).before).toContain(json("Example"));
  });

  test("a prose mention whose close sits in an inline code span is no block", () => {
    const only = `Write a ${OPEN} block and close it with \`${CLOSE}\`.`;
    expect(findHandoffBlocks(only)).toEqual([]);
    expect(parseHandoff(only).ok).toBe(false);
    // A real block after it is found, and the span's closing backtick can't swallow it.
    const withReal = `A ${OPEN} mention and \`${CLOSE}\` then ${block("Real")} and a \` tick`;
    expect(inners(withReal)).toEqual([json("Real")]);
  });

  test("a prose-first block body with an unbalanced backtick still finds its handoff (the close is prose, not span content)", () => {
    // `{` between the open and the close: it is a block body, so a span a stray backtick opens inside it
    // and a later backtick closes must not swallow the close tag (legacy finds this block).
    const text = `${OPEN}\nNote: run \`npm test\n${json("Real")}\n${CLOSE}\nsee \`x\``;
    expect(inners(text, { codeAware: false })).toHaveLength(1);
    const spans = findHandoffBlocks(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.openEnd)).toBe(OPEN);
    expect(text.slice(spans[0]!.closeStart, spans[0]!.end)).toBe(CLOSE);
    const parsed = parseHandoff(text);
    expect(parsed.ok && parsed.handoff.next).toBe("Real");
    // Same with a double-backtick span, mid-line mentions and a following paragraph.
    const dbl = `Here is the result:\n${OPEN}\nSee \`\`a\n${json("Real")}\n${CLOSE}\nthen \`\`b\`\` done`;
    const p2 = parseHandoff(dbl);
    expect(p2.ok && p2.handoff.next).toBe("Real");
    // A brace-less body is still just a mention whose close sits in a code span.
    const noBrace = `Write ${OPEN} then \`code ${CLOSE} here\` end.`;
    expect(findHandoffBlocks(noBrace)).toEqual([]);
  });

  test("a prose mention still pairs with a close in prose; a body-shaped open before that close takes over", () => {
    const prose = `A ${OPEN} mention, then text ${CLOSE} after.`;
    expect(inners(prose)).toEqual([" mention, then text "]);
    // The real open sits in a later paragraph, past a closed fence; its close is in prose.
    const past = `See ${OPEN} below.\n\n\`\`\`\ncode\n\`\`\`\n${OPEN}\n${json("Real")}\n${CLOSE}`;
    expect(inners(past)).toEqual([`\n${json("Real")}\n`]);
    // An open inside the fence is not a start; the mention pairs with the prose close.
    const fencedOpen = `See ${OPEN} below.\n\`\`\`\n${OPEN} in code\n\`\`\`\nthen ${CLOSE}`;
    expect(findHandoffBlocks(fencedOpen)).toHaveLength(1);
  });

  test("a mention whose close is fenced in a later segment is no block; the segment's fence keeps its state", () => {
    const segments = [`prose ${OPEN} mention`, `\`\`\`\n${CLOSE}\n\`\`\`\n${OPEN}\n{"a":1}\n${CLOSE}`];
    const joined = segments.join("");
    const spans = findHandoffBlocks(joined, { segmentStarts: [0, segments[0]!.length] });
    expect(spans.map((b) => joined.slice(b.openEnd, b.closeStart))).toEqual(['\n{"a":1}\n']);
  });

  test("a mention ending its line before a fenced example: the fence keeps its state after the example's close", () => {
    // `opensBody` reads the fence after the mention as a block body; the close sits inside that
    // fence, so the scan must resume inside it — resuming with a cleared fence state read the
    // fence's closing line as an opener and hid the real block (round-5 review, a regression vs main).
    for (const gap of ["\n", "\n\n"]) {
      for (const fence of ["```", "~~~", "````"]) {
        const example = `The final message must end with a block opened by ${OPEN}${gap}${fence}\n${OPEN}\n${json("Example")}\n${CLOSE}\n${fence}\n\n${OPEN}\n${json("Real")}\n${CLOSE}`;
        const parsed = parseHandoff(example);
        expect(parsed.ok && parsed.handoff.next).toBe("Real");
        const split = splitHandoffMessage(example);
        expect(split.after).toBe("");
        expect(split.block?.inner).toBe(`\n${json("Real")}\n`);
        // A fence holding only a close tag.
        const closeOnly = `The block starts with ${OPEN}${gap}${fence}\n${CLOSE}\n${fence}\n\n${OPEN}\n${json("Real")}\n${CLOSE}`;
        const p2 = parseHandoff(closeOnly);
        expect(p2.ok && p2.handoff.next).toBe("Real");
        // Same with the fence behind blockquote markers.
        const quoted = `Wrap it in ${OPEN}${gap}> ${fence}\n> ${CLOSE}\n> ${fence}\n${OPEN}\n${json("Real")}\n${CLOSE}`;
        const p3 = parseHandoff(quoted);
        expect(p3.ok && p3.handoff.next).toBe("Real");
      }
    }
  });

  test("a body-shaped open taking over a pending mention resumes inside the fence its close sits in", () => {
    const text =
      `A ${OPEN} mention with {"x":1} in it.\n${OPEN}\n\`\`\`\n${json("Example")}\n${CLOSE}\n\`\`\`\n\n` +
      `${OPEN}\n${json("Real")}\n${CLOSE}`;
    const parsed = parseHandoff(text);
    expect(parsed.ok && parsed.handoff.next).toBe("Real");
  });

  test("a real block whose own fence never closes before the close tag still counts; the fence runs on", () => {
    const sloppy = `${OPEN}\n\`\`\`json\n${json("Sloppy")}\n${CLOSE}`;
    const p1 = parseHandoff(sloppy);
    expect(p1.ok && p1.handoff.next).toBe("Sloppy");
    // The fence closes after the close tag: a later block is found.
    const later = `${OPEN}\n\`\`\`json\n${json("Draft")}\n${CLOSE}\n\`\`\`\n\n${block("Final")}`;
    const p2 = parseHandoff(later);
    expect(p2.ok && p2.handoff.next).toBe("Final");
    // A mention after the close, still inside the unclosed fence, stays code.
    const fencedAfter = `${OPEN}\n\`\`\`json\n{"a":1}\n${CLOSE}\n\`${OPEN}\` text ${CLOSE}`;
    expect(findHandoffBlocks(fencedAfter)).toHaveLength(1);
    // A close tag on the fence's info line resumes inside that fence too.
    const infoLine = `See ${OPEN}\n\`\`\`${CLOSE}\n${OPEN}\n${json("Hidden")}\n${CLOSE}\n\`\`\`\n${block("Real")}`;
    const p3 = parseHandoff(infoLine);
    expect(p3.ok && p3.handoff.next).toBe("Real");
  });

  test("a fence a block's close sits in ends at its segment; the next segment starts fresh", () => {
    const segments = [`prose ${OPEN}\n\`\`\`\n${CLOSE}\nstill fenced ${OPEN}`, `${OPEN}\n${json("Real")}\n${CLOSE}`];
    const joined = segments.join("\n");
    const found = findHandoffBlocks(joined, { segmentStarts: [0, segments[0]!.length + 1] });
    expect(joined.slice(found.at(-1)!.openEnd, found.at(-1)!.closeStart)).toBe(`\n${json("Real")}\n`);
    // The close's line runs to the segment end: nothing more in that segment.
    const tight = [`prose ${OPEN}\n\`\`\`\n${CLOSE} tail`, block("Real")];
    const j2 = tight.join("\n");
    const f2 = findHandoffBlocks(j2, { segmentStarts: [0, tight[0]!.length + 1] });
    expect(j2.slice(f2.at(-1)!.openEnd, f2.at(-1)!.closeStart)).toBe(json("Real"));
  });

  test("a pending mention resolved in prose is anchored only at opens the walk met in prose", () => {
    // A line-start open inside a fence (or an inline code span) between the mention and its prose
    // close is code — it used to become the block's start.
    const fenced = `See ${OPEN} below {"a":1}.\n\`\`\`\n${OPEN}\n{"b":2}\n\`\`\`\nthen ${CLOSE}`;
    const spans = findHandoffBlocks(fenced);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(fenced.indexOf(OPEN));
    const inline = `See ${OPEN} below {"a":1}.\n\`\n${OPEN}{"b":2}\` then ${CLOSE}`;
    const s2 = findHandoffBlocks(inline);
    expect(s2).toHaveLength(1);
    expect(s2[0]!.start).toBe(inline.indexOf(OPEN));
    // A line-start open in prose still wins, as before.
    const prose = `See ${OPEN} below.\n${OPEN}\n{"b":2}\nthen ${CLOSE}`;
    const s3 = findHandoffBlocks(prose);
    expect(s3[0]!.start).toBe(prose.lastIndexOf(OPEN));
  });

  test("a real review message: inline-code mentions and a mention inside a JSON string don't break the block", () => {
    // Shape of a live Code Review turn the stable (legacy) scanner rejected as unparseable: the
    // legacy scan pairs the first inline-code mention with the final close tag.
    const final = JSON.stringify({ ...JSON.parse(json("Bug Fix")), summary: `a mention that ends a line ('opened by ${OPEN}') {brace}` });
    const text =
      `Finding: a prose mention ("…opened by \`${OPEN}\`") followed by a fenced example.\n\n` +
      `For example, a mention, then \`\` \`${OPEN}{"next":"Example"}\` \`\`, then a block.\n\n` +
      `${OPEN}\n${final}\n${CLOSE}`;
    const parsed = parseHandoff(text);
    expect(parsed.ok && parsed.handoff.next).toBe("Bug Fix");
    const legacy = parseHandoff(text, { codeAware: false });
    expect(legacy.ok && legacy.handoff.next).not.toBe("Bug Fix");
  });

  test("an unclosed real open stops the scan (nothing after it can pair)", () => {
    expect(findHandoffBlocks(`${OPEN}\n{"a":1}`)).toEqual([]);
    expect(findHandoffBlocks(`${block("A")}\n${OPEN}draft`)).toHaveLength(1);
  });
});

describe("findHandoffBlocks — accepted trade-offs and known limits (review round 6)", () => {
  // A draft block whose own fence is sloppy, then the final block, in ONE message. The draft's
  // close tag sits inside a fence that is still open there, so the scan resumes inside that fence
  // (the round-5 rule that keeps a mention ending its line before a fenced example from hiding the
  // real block) — and the final block, read as fenced code, is hidden. Legacy mode and main pick
  // the final block. Accepted: the prod transcripts held no message with two real blocks. If this
  // test starts failing because the final block wins, the trade-off was resolved — update it.
  const FINAL = `${OPEN}\n${json("Final")}\n${CLOSE}`;
  const DRAFT_SHAPES: Record<string, string> = {
    "an unclosed body fence": `${OPEN}\n\`\`\`json\n${json("Draft")}\n${CLOSE}`,
    "a fence closer glued to the close tag": `${OPEN}\n\`\`\`json\n${json("Draft")}\n\`\`\`${CLOSE}`,
    "a stray fence line after the JSON": `${OPEN}\n${json("Draft")}\n\`\`\`\n${CLOSE}`,
    "a fence on the open tag's own line": `${OPEN}\`\`\`json\n${json("Draft")}\n\`\`\`\n${CLOSE}`,
    "a 4-backtick fence closed with 3": `${OPEN}\n\`\`\`\`json\n${json("Draft")}\n\`\`\`\n${CLOSE}`,
  };

  for (const [shape, draft] of Object.entries(DRAFT_SHAPES)) {
    test(`a sloppy draft block (${shape}) before the final block in one message wins; legacy picks the final`, () => {
      const text = `${draft}\n\nOn second thought:\n\n${FINAL}`;
      const code = parseHandoff(text);
      expect(code.ok && code.handoff.next).toBe("Draft");
      // Every display surface agrees with the runner: the card shows the draft.
      const split = splitHandoffMessage(text);
      expect(split.block?.result.ok && split.block.result.handoff.next).toBe("Draft");
      expect(split.after).toContain(json("Final"));
      const legacy = parseHandoff(text, { codeAware: false });
      expect(legacy.ok && legacy.handoff.next).toBe("Final");
      // The trade-off is per message: with the final block in its own event, the fence the draft
      // left open ends at its segment and the final block wins.
      const events = parseHandoff([draft, FINAL]);
      expect(events.ok && events.handoff.next).toBe("Final");
    });
  }

  test("control: the same draft with a well-formed fence loses to the final block", () => {
    const text = `${OPEN}\n\`\`\`json\n${json("Draft")}\n\`\`\`\n${CLOSE}\n\n${FINAL}`;
    const parsed = parseHandoff(text);
    expect(parsed.ok && parsed.handoff.next).toBe("Final");
  });

  test("known limit: a literal close tag inside the handoff's own JSON string ends the block early", () => {
    // Both scanners pair the open tag with the first close tag, so the block's body is cut inside
    // the string and the handoff is invalid (2 of 1777 prod messages, both from pipelines about
    // handoffs). Owner question open: skip close tags inside JSON strings, tell agents to escape
    // the slash, or leave it to the reminder. Update this test with that decision.
    const summary = `the step must end with ${CLOSE} and nothing after it`;
    const body = JSON.stringify({ ...JSON.parse(json("Next")), summary });
    const text = `Done.\n\n${OPEN}\n${body}\n${CLOSE}`;
    for (const codeAware of [true, false]) {
      const parsed = parseHandoff(text, { codeAware });
      expect(parsed.ok).toBe(false);
      // A tag was found, so this is an invalid handoff (one reminder), not a missing one.
      expect(!parsed.ok && parsed.raw).toStartWith('{"schemaVersion":1');
      const classified = classifyStepResponse({ runStatus: "succeeded", assistantText: text, pendingInteractions: 0, codeAware });
      expect(classified.kind).toBe("handoff-invalid");
      expect(classified.error).toContain("could not be parsed");
    }
    // The display shows the invalid card, with the rest of the JSON and the real close as prose after it.
    const split = splitHandoffMessage(text);
    expect(split.before).toBe("Done.\n\n");
    expect(split.block?.result.ok).toBe(false);
    expect(split.block?.inner).toBe(`\n${body.slice(0, body.indexOf(CLOSE))}`);
    expect(split.after).toBe(`${body.slice(body.indexOf(CLOSE) + CLOSE.length)}\n${CLOSE}`);
  });

  test("a JSON-escaped close tag (`<\\/handoff>`) inside a string is not a close tag — the handoff parses", () => {
    const summary = `the step must end with ${CLOSE} and nothing after it`;
    const body = JSON.stringify({ ...JSON.parse(json("Next")), summary }).replace(CLOSE, `<\\/${HANDOFF_TAG}>`);
    const text = `Done.\n\n${OPEN}\n${body}\n${CLOSE}`;
    for (const codeAware of [true, false]) {
      const parsed = parseHandoff(text, { codeAware });
      expect(parsed.ok && parsed.handoff.summary).toBe(summary);
    }
  });
});

describe("findHandoffBlocks — segments", () => {
  test("code state resets at every segment start: an unclosed fence in segment 1 does not hide segment 2", () => {
    const segments = ["```\nunclosed", block("Real")];
    const joined = segments.join("\n");
    const starts = [0, segments[0]!.length + 1];
    expect(findHandoffBlocks(joined, { segmentStarts: starts })).toHaveLength(1);
    // The same text as ONE segment: the fence swallows the block.
    expect(findHandoffBlocks(joined)).toEqual([]);
  });

  test("an unmatched backtick in segment 1 cannot pair with one inside the next segment's JSON", () => {
    const inner = JSON.stringify({ summary: "uses `x`", next: "Real" });
    const segments = ["odd ` backtick here ", `${OPEN}${inner}${CLOSE}`];
    const joined = segments.join("\n");
    const starts = [0, segments[0]!.length + 1];
    expect(findHandoffBlocks(joined, { segmentStarts: starts })).toHaveLength(1);
    expect(findHandoffBlocks(joined)).toEqual([]);
  });

  test("a block may pair its open tag in one segment with its close in the next", () => {
    const segments = [`prose ${OPEN}{"a":`, `1}${CLOSE} more`];
    const joined = segments.join("\n");
    const found = findHandoffBlocks(joined, { segmentStarts: [0, segments[0]!.length + 1] });
    expect(found).toHaveLength(1);
    expect(joined.slice(found[0]!.openEnd, found[0]!.closeStart)).toBe('{"a":\n1}');
  });

  test("scanning resumes in the segment where a cross-segment block closed, with fresh state", () => {
    const segments = [`${OPEN}{"a":`, `1}${CLOSE} \`${OPEN}\``, block("Second")];
    const joined = segments.join("\n");
    const starts = [0, segments[0]!.length + 1, segments[0]!.length + segments[1]!.length + 2];
    const found = findHandoffBlocks(joined, { segmentStarts: starts });
    expect(found).toHaveLength(2); // the quoted mention in segment 2 stays hidden
  });

  test("segment starts are shifted correctly by the tail window and tolerate unsorted/duplicate/out-of-range input", () => {
    const padding = "x".repeat(PIPELINE_LIMITS.handoffScanTailBytes);
    const segments = [padding, "```\nunclosed", block("Real")];
    const joined = segments.join("\n");
    const s1 = padding.length + 1;
    const s2 = s1 + segments[1]!.length + 1;
    const found = findHandoffBlocks(joined, { segmentStarts: [s2, 0, s1, s1, joined.length + 50, -3] });
    expect(found).toHaveLength(1);
    expect(joined.slice(found[0]!.start, found[0]!.openEnd)).toBe(OPEN);
  });

  test("segmentStarts are ignored by the legacy mode", () => {
    const segments = ["```\nunclosed", block("Real")];
    const joined = segments.join("\n");
    expect(findHandoffBlocks(joined, { codeAware: false, segmentStarts: [0, 13] })).toHaveLength(1);
    expect(findHandoffBlocks(joined, { codeAware: false })).toHaveLength(1);
  });
});

describe("findHandoffBlocks — legacy mode is byte-identical to the replaced scanner", () => {
  const fixtures: string[] = [
    "",
    "no tags here",
    block(),
    `${block("A")}\n\nActually wait.\n\n${block("B")}`,
    `${OPEN}\n\`\`\`json\n${json()}\n\`\`\`\n${CLOSE}`,
    `<${HANDOFF_TAG} id="abc" data-x="1">${json()}</${HANDOFF_TAG}>`,
    `${OPEN}${json()}</ ${HANDOFF_TAG} >`,
    `<${HANDOFF_TAG}x>${json()}${CLOSE}`,
    `${OPEN}${OPEN}${json()}${CLOSE}${CLOSE}`,
    `${block("A")}\n${OPEN}\n{"next": "half-written`,
    `<${HANDOFF_TAG} attr="unterminated ${json()}</${HANDOFF_TAG}`,
    `I mention \`${OPEN}\` and {braces} first.\n${block("Real")}`,
    `\`\`\`\n${block("Fenced")}\n\`\`\``,
    `${OPEN}x${CLOSE} trailing ${CLOSE}`,
    `${CLOSE}${CLOSE}${OPEN}ok${CLOSE}`,
  ];

  function lastInner(text: string, opts?: Parameters<typeof findHandoffBlocks>[1]): string | null {
    const blocks = findHandoffBlocks(text, opts);
    const last = blocks[blocks.length - 1];
    return last === undefined ? null : text.slice(last.openEnd, last.closeStart);
  }

  test("agrees with the original scanner on every fixture", () => {
    for (const text of fixtures) {
      expect(lastInner(text, { codeAware: false })).toBe(referenceLastBlock(text));
    }
  });

  test("agrees with the original scanner on seeded random token soup (code-aware differs only by line-start re-anchoring)", () => {
    const tokens = [
      OPEN,
      CLOSE,
      `<${HANDOFF_TAG} a="1">`,
      `<${HANDOFF_TAG}x>`,
      `</ ${HANDOFF_TAG} >`,
      "</",
      "<",
      ">",
      "{}",
      '{"a":"b"}',
      "\n",
      "\n\n",
      " ",
      "text",
    ];
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let n = 0; n < 400; n++) {
      let text = "";
      const len = 1 + Math.floor(rand() * 24);
      for (let i = 0; i < len; i++) text += tokens[Math.floor(rand() * tokens.length)];
      expect(lastInner(text, { codeAware: false })).toBe(referenceLastBlock(text));
      expect(lastInner(text)).toBe(referenceAnchoredLastBlock(text));
    }
  });

  test("legacy still gets the inline-mention case wrong (pins the legacy mode)", () => {
    const text = `I checked the \`${OPEN}\` contract and \`{x}\` shape.\n${block("Real")}`;
    expect(lastInner(text, { codeAware: false })).not.toBe(json("Real"));
    expect(lastInner(text)).toBe(json("Real"));
  });
});

describe("findHandoffBlocks — linear time on pathological input", () => {
  const BUDGET_MS = 100;

  test("50,000 unclosed opens", () => {
    const text = `${OPEN}\n`.repeat(50_000);
    expect(timed(() => findHandoffBlocks(text)).ms).toBeLessThan(BUDGET_MS);
    expect(timed(() => findHandoffBlocks(text, { codeAware: false })).ms).toBeLessThan(BUDGET_MS);
  });

  test("50,000 backtick runs of cycling lengths 1–50 in one paragraph, then a real block", () => {
    let text = "";
    for (let i = 0; i < 50_000; i++) text += "`".repeat((i % 50) + 1) + " ";
    text += block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 one-run paragraphs (each backtick run of length 1 or 2, unmatched), then a real block", () => {
    let text = "";
    for (let i = 0; i < 50_000; i++) text += `a ${"`".repeat((i % 2) + 1)} x\n\n`;
    text += block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 paragraphs that each carry a real-looking mention in a lone span, then a real block", () => {
    const text = `a \`${OPEN}\` b\n\n`.repeat(50_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 single backticks in one paragraph pair off; the block after them is found", () => {
    const text = "` ".repeat(50_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 fence-like lines (alternating open/close), then a real block", () => {
    const text = "```\n".repeat(50_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 odd-lengths of fence-like lines that never close hide everything after them", () => {
    const text = "~~~~\n~~~\n".repeat(25_000) + block("Hidden");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(0);
  });

  test("50,000 quoted `<handoff>` mentions, then a real block", () => {
    const text = `\`${OPEN}\` `.repeat(50_000) + `\n\n${block("Real")}`;
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 quoted mentions on separate lines (one paragraph), then a real block", () => {
    const text = `\`${OPEN}\`\n`.repeat(50_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 complete blocks in one paragraph", () => {
    const unit = `${OPEN}x${CLOSE} `;
    const text = unit.repeat(50_000); // ~1 MB — only the trailing scan window is read
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeGreaterThan(PIPELINE_LIMITS.handoffScanTailBytes / unit.length - 2);
    expect(value.length).toBeLessThanOrEqual(Math.ceil(PIPELINE_LIMITS.handoffScanTailBytes / unit.length));
  });

  test("50,000 tiny segments", () => {
    const segments: string[] = Array.from({ length: 50_000 }, (_, i) => (i % 2 === 0 ? "```" : `\`${OPEN}\``));
    segments.push(block("Real"));
    const starts: number[] = [];
    let offset = 0;
    for (const s of segments) {
      starts.push(offset);
      offset += s.length + 1;
    }
    const joined = segments.join("\n");
    const { value, ms } = timed(() => findHandoffBlocks(joined, { segmentStarts: starts }));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeGreaterThanOrEqual(1);
  });

  test("50,000 `<handoff ` false-opens whose attributes never close, then one real block", () => {
    const text = `${OPEN.slice(0, -1)} a`.repeat(50_000) + block("Real");
    expect(timed(() => findHandoffBlocks(text)).ms).toBeLessThan(BUDGET_MS);
  });

  test("50,000 line-start opens before one close (re-anchoring stays linear)", () => {
    const text = `${OPEN}\n`.repeat(50_000) + `{"a":1}${CLOSE}`;
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
    expect(text.slice(value[0]!.openEnd, value[0]!.closeStart)).toBe('\n{"a":1}');
  });

  test("50,000 heading / rule lines with backticks, then a real block", () => {
    const text = "# h `\n---\n".repeat(25_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 prose mentions sharing one fenced close, then a real block", () => {
    const text = `a ${OPEN} b\n`.repeat(50_000) + `\`\`\`\n${CLOSE}\n\`\`\`\n` + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(text.slice(value[0]!.openEnd, value[0]!.closeStart)).toBe(json("Real"));
  });

  test("50,000 mention + fenced close pairs, then a real block", () => {
    const text = `a ${OPEN} b\n\`\`\`\n${CLOSE}\n\`\`\`\n`.repeat(25_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 mentions with a body-shaped brace-less open each, before one far close", () => {
    // Every mid-line fence-shaped open is past the pair's last `{`, so none takes over.
    const text = `{"x":1}\na ${OPEN} b\n` + `d ${OPEN}\`\`\` e\n`.repeat(50_000) + CLOSE;
    expect(timed(() => findHandoffBlocks(text)).ms).toBeLessThan(BUDGET_MS);
  });

  test("8,000 mention + fenced-example pairs whose close sits inside the fence, then a real block", () => {
    // Sized to fit the scan tail, so every pair is actually walked.
    const text = `a ${OPEN}\n\`\`\`\n${CLOSE}\n\`\`\`\n`.repeat(8_000) + block("Real");
    expect(text.length).toBeLessThan(PIPELINE_LIMITS.handoffScanTailBytes);
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(text.slice(value.at(-1)!.openEnd, value.at(-1)!.closeStart)).toBe(json("Real"));
  });

  test("12,000 blocks on one line after a fence-bodied block (the fence walk never re-reads the line)", () => {
    // The blocks sit in the fence's content; sized to fit the scan tail.
    const text = `${OPEN}\n\`\`\`\n${CLOSE} ` + `${OPEN}{}${CLOSE}`.repeat(12_000) + `\n\`\`\`\n${block("Real")}`;
    expect(text.length).toBeLessThan(PIPELINE_LIMITS.handoffScanTailBytes);
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(text.slice(value.at(-1)!.openEnd, value.at(-1)!.closeStart)).toBe(json("Real"));
  });

  test("6,000 fenced opens + 6,000 prose mentions pending on one far close (anchoring reads only the recorded opens)", () => {
    const text = `{"x":1}\na ${OPEN} b\n` + `\`\`\`\n${OPEN}\n\`\`\`\n`.repeat(6_000) + `c ${OPEN} d\n`.repeat(6_000) + CLOSE;
    expect(text.length).toBeLessThan(PIPELINE_LIMITS.handoffScanTailBytes);
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });

  test("50,000 fence-like lines before the tail window (the fence-state walk over the cut-off text is linear)", () => {
    const pre = "```\n~~~~\n".repeat(50_000); // one segment, ~450 KB before the window
    const text = pre + "abcd\n".repeat(Math.floor(PIPELINE_LIMITS.handoffScanTailBytes / 5)) + block("Real");
    expect(text.length - PIPELINE_LIMITS.handoffScanTailBytes).toBeGreaterThan(400_000);
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeLessThanOrEqual(1);
  });

  test("50,000 prose-first bodies with an unbalanced backtick, then a real block", () => {
    const text = `${OPEN}\nrun \`a\n{"k":1}\n${CLOSE}\n`.repeat(50_000) + block("Real");
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeGreaterThan(0);
  });

  test("50,000 `</` + whitespace runs (close-tag tolerance)", () => {
    const text = `${OPEN}{}` + "</   ".repeat(50_000) + CLOSE;
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });
});

describe("mayContainHandoffOpenTag", () => {
  test("matches the open-tag prefix case-insensitively, like the locator", () => {
    expect(mayContainHandoffOpenTag(`x ${OPEN}`)).toBe(true);
    expect(mayContainHandoffOpenTag("x <HANDOFF>{}</HANDOFF>")).toBe(true);
    expect(mayContainHandoffOpenTag("x <Handoff id=1>")).toBe(true);
    expect(mayContainHandoffOpenTag("no tag here, just handoff")).toBe(false);
    expect(mayContainHandoffOpenTag(`only a close ${CLOSE}`)).toBe(false);
  });

  test("every text the locator finds a block in passes the pre-check", () => {
    for (const text of ["<HANDOFF>{}</handoff>", `<hAnDoFf a="1">{}${CLOSE}`, block()]) {
      expect(findHandoffBlocks(text).length).toBeGreaterThan(0);
      expect(mayContainHandoffOpenTag(text)).toBe(true);
    }
  });
});
