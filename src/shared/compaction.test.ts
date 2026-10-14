import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPACTION_NOTICE_RE,
  COMPACTION_SUMMARY_LABEL,
  compactionStatusLine,
  compactionSummaryBytes,
  compactionSummaryLine,
  formatTokenCount,
  isCompactionNotice,
} from "./compaction.ts";

test("formatTokenCount: integers below 1k, one decimal below 10k, whole k below 1M, one decimal M above", () => {
  const table: Array<[number, string]> = [
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [8613, "8.6k"],
    [9999, "10k"],
    [10_000, "10k"],
    [450_162, "450k"],
    [999_600, "1M"],
    [1_000_000, "1M"],
    [1_250_000, "1.3M"],
  ];
  for (const [n, want] of table) expect(formatTokenCount(n)).toBe(want);
});

test("formatTokenCount: non-finite or negative input never throws", () => {
  expect(formatTokenCount(Number.NaN)).toBe("0");
  expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
  expect(formatTokenCount(-5)).toBe("0");
});

test("compactionStatusLine: auto trigger with both token counts", () => {
  expect(compactionStatusLine({ trigger: "auto", preTokens: 450162, postTokens: 8613 })).toBe(
    "context compacted · 450k → 8.6k tokens",
  );
});

test("compactionStatusLine: manual trigger is labeled", () => {
  expect(compactionStatusLine({ trigger: "manual", preTokens: 120_000, postTokens: 5000 })).toBe(
    "context compacted (manual) · 120k → 5k tokens",
  );
});

test("compactionStatusLine: missing or non-numeric token counts fall back to the bare line", () => {
  expect(compactionStatusLine({})).toBe("context compacted");
  expect(compactionStatusLine({ trigger: "auto", preTokens: 450162 })).toBe("context compacted");
  expect(compactionStatusLine({ preTokens: "450162", postTokens: 8613 })).toBe("context compacted");
  expect(compactionStatusLine({ preTokens: Number.NaN, postTokens: 8613 })).toBe("context compacted");
  expect(compactionStatusLine({ trigger: "manual" })).toBe("context compacted (manual)");
});

test("isCompactionNotice: matches compaction notices only", () => {
  expect(isCompactionNotice("Compacted while idle, before the prompt cache expired")).toBe(true);
  expect(isCompactionNotice("  compacted conversation")).toBe(true);
  expect(isCompactionNotice("Update available: 2.1.300")).toBe(false);
  expect(isCompactionNotice("Context left until auto-compact: 5%")).toBe(false);
  expect(isCompactionNotice("Uncompacted")).toBe(false);
  expect(COMPACTION_NOTICE_RE.test("Compactedness")).toBe(false);
});

test("compactionSummaryLine: first non-empty line plus the body size", () => {
  const body = `\n\n  This session is being continued from a previous conversation.  \n\n## Details\n${"z".repeat(16_448 - 80)}`;
  const line = compactionSummaryLine(body);
  expect(line.startsWith("This session is being continued from a previous conversation. (")).toBe(true);
  expect(line).not.toContain("Details");
});

test("compactionSummaryLine: a 16,448-byte body reads (16.1 KB) — the shared sent-files formatter", () => {
  const first = "Summary";
  const body = first + "\n" + "a".repeat(16_448 - first.length - 1);
  expect(compactionSummaryBytes(body)).toBe(16_448);
  expect(compactionSummaryLine(body)).toBe("Summary (16.1 KB)");
});

test("compactionSummaryLine: caps the first line at 140 chars with an ellipsis", () => {
  const long = "w".repeat(300);
  const line = compactionSummaryLine(long);
  const head = line.slice(0, line.lastIndexOf(" ("));
  expect(Array.from(head)).toHaveLength(140);
  expect(head.endsWith("…")).toBe(true);
  // Exactly 140 chars is kept whole.
  const exact = "q".repeat(140);
  expect(compactionSummaryLine(exact).startsWith(`${exact} (`)).toBe(true);
});

test("compactionSummaryLine: CRLF input splits like LF", () => {
  expect(compactionSummaryLine("First line\r\nsecond\r\n")).toBe("First line (20 B)");
});

test("compactionSummaryLine: an empty/blank body still prints a labeled digest", () => {
  expect(compactionSummaryLine("")).toBe("compaction summary (0 B)");
  expect(compactionSummaryLine(" \n \n")).toBe("compaction summary (4 B)");
});

test("compactionSummaryBytes counts UTF-8 bytes, not UTF-16 units", () => {
  expect(compactionSummaryBytes("é")).toBe(2);
  expect(compactionSummaryBytes("😀")).toBe(4);
});

test("COMPACTION_SUMMARY_LABEL is the summary› label", () => {
  expect(COMPACTION_SUMMARY_LABEL).toBe("summary›");
});

test("compaction.ts imports nothing from either process side", () => {
  const src = readFileSync(join(import.meta.dir, "compaction.ts"), "utf8");
  const specifiers = [...src.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  expect(specifiers).toEqual(["./sent-files.ts"]);
});
