/**
 * Plain-text helpers for Claude Code context compaction, shared by the bun
 * JSONL mapper, the webview, the CLI and the TUI so the wording can't drift
 * between surfaces. Kept free of runtime imports from either process side
 * (its only import is the shared byte-size formatter).
 *
 * Ground truth (Claude Code 2.1.296 session JSONL, keys only):
 *
 *   boundary — `{type:"system", subtype:"compact_boundary",
 *               compactMetadata:{trigger:"auto"|"manual", preTokens,
 *               postTokens, durationMs, …}}`
 *   summary  — `{type:"user", isCompactSummary:true,
 *               isVisibleInTranscriptOnly:true, message:{content:<string>}}`
 *               (~16 KB of Claude's own markdown)
 *   notice   — `{type:"system", subtype:"informational", level:"notice",
 *               content:"Compacted while idle, before the prompt cache expired"}`
 *
 * The boundary and the notice become two independent `status` lines; the
 * summary rides the `compaction_summary` stream (see `RunEventStream`). All
 * three are mapped at ingest — nothing here text-matches stored rows.
 */
import { formatByteSize } from "./sent-files.ts";

/** Label the CLI (`agetor logs`) and the TUI print before a compaction
 *  summary's one-line digest. */
export const COMPACTION_SUMMARY_LABEL = "summary›";

/** Cap on the summary digest line, before the size suffix. */
const SUMMARY_LINE_MAX_CHARS = 140;

/** Compact token count: `999` → `"999"`, `8613` → `"8.6k"`, `450162` →
 *  `"450k"`, `1250000` → `"1.3M"`. A trailing `.0` is dropped. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 10_000) return `${trimZero((v / 1000).toFixed(1))}k`;
  if (v < 1_000_000) {
    const k = Math.round(v / 1000);
    // 999,600 rounds to "1000k" — promote it to the next unit instead.
    return k >= 1000 ? "1M" : `${k}k`;
  }
  return `${trimZero((v / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Status line for a `compact_boundary` event, built from Claude's own
 * `compactMetadata`: `context compacted · 450k → 8.6k tokens`, with
 * `(manual)` after "compacted" for a user-run `/compact`, and just
 * `context compacted` when either token count is missing or not a number.
 */
export function compactionStatusLine(meta: {
  preTokens?: unknown;
  postTokens?: unknown;
  trigger?: unknown;
}): string {
  const head = meta.trigger === "manual" ? "context compacted (manual)" : "context compacted";
  const pre = tokenCount(meta.preTokens);
  const post = tokenCount(meta.postTokens);
  if (pre === null || post === null) return head;
  return `${head} · ${formatTokenCount(pre)} → ${formatTokenCount(post)} tokens`;
}

/** An `informational` system notice about compaction (`Compacted while
 *  idle, …`). Other informational notices are not surfaced. */
export const COMPACTION_NOTICE_RE = /^compacted\b/i;

export function isCompactionNotice(content: string): boolean {
  return COMPACTION_NOTICE_RE.test(content.trim());
}

/** UTF-8 size of the summary body, for the size hint. */
export function compactionSummaryBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * One-line digest of a compaction summary for the CLI/TUI: its first
 * non-empty line (capped at 140 chars with `…`) plus the body's size, e.g.
 * `This session is being continued … (16.1 KB)`. Never the whole body.
 */
export function compactionSummaryLine(text: string): string {
  const first =
    text
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const chars = Array.from(first);
  const head =
    chars.length > SUMMARY_LINE_MAX_CHARS
      ? `${chars.slice(0, SUMMARY_LINE_MAX_CHARS - 1).join("")}…`
      : first;
  const size = `(${formatByteSize(compactionSummaryBytes(text))})`;
  return head ? `${head} ${size}` : `compaction summary ${size}`;
}
