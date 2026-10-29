import { describe, expect, test } from "bun:test";
import { HANDOFF_TAG, findHandoffBlocks, type HandoffBlockSpan } from "./handoff-locator.ts";
import { parseHandoff } from "./pipeline.ts";
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

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
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

  test("a nested open pairs the outer open with the first close", () => {
    const text = `${OPEN}${OPEN}{"a":1}${CLOSE}${CLOSE}`;
    expect(inners(text)).toEqual([`${OPEN}{"a":1}`]);
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
    const text = `start \`${OPEN} open\n\nstill prose \` end ${block("Real")}`;
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

  test("an unclosed real open stops the scan (nothing after it can pair)", () => {
    expect(findHandoffBlocks(`${OPEN}\n{"a":1}`)).toEqual([]);
    expect(findHandoffBlocks(`${block("A")}\n${OPEN}draft`)).toHaveLength(1);
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

  test("agrees with the original scanner on seeded random token soup (code-aware agrees too when no code characters appear)", () => {
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
      const expected = referenceLastBlock(text);
      expect(lastInner(text, { codeAware: false })).toBe(expected);
      expect(lastInner(text)).toBe(expected);
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

  test("50,000 `</` + whitespace runs (close-tag tolerance)", () => {
    const text = `${OPEN}{}` + "</   ".repeat(50_000) + CLOSE;
    const { value, ms } = timed(() => findHandoffBlocks(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(1);
  });
});
