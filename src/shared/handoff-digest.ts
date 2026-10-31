// Plain-text rendering of a step's `<handoff>` block for the terminal
// surfaces (`agetor logs` and the TUI dashboard) — the CLI counterpart of the
// webview's formatted handoff card (docs/plans/formatted-handoff.md, T7 / D19).
// It drops only the JSON syntax: the status and next step first, then the
// purpose, summary, reason, artifacts and open questions. Every field is
// agent-authored text, so every printed line is escaped (`escapeControlChars`
// under the multi-line rule, `escapeFreeText` for one-line forms) before it
// can reach a terminal. No runtime imports outside src/shared.

import type { Handoff } from "./types.ts";
import { splitHandoffPromptSpans, type HandoffMessageSplit } from "./pipeline.ts";
import { escapeControlChars, escapeFreeText } from "./terminal-text.ts";
import type { PlainLine } from "./user-message.ts";

/** Label of every line of a handoff digest, printed before its text. */
export const HANDOFF_DIGEST_LABEL = "handoff›";

const LINE_BREAK_RE = /\r\n|\r|\n/;

/** One escaped physical line: control characters, bidi overrides and
 *  invisibles written as visible `\uXXXX` escapes (multi-line rule). */
function esc(line: string): string {
  return escapeControlChars(line, true);
}

/** `✓ done → Grilling` / `⚠ blocked → last step` (the `next` already escaped
 *  by the caller's chosen rule). */
function headline(handoff: Handoff, next: string): string {
  return `${handoff.status === "blocked" ? "⚠ blocked" : "✓ done"} → ${next}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A labeled field: `name: <first line>`, continuation lines indented. Empty
 *  (blank) text yields nothing. */
function fieldLines(name: string, text: string): string[] {
  if (text.trim() === "") return [];
  const [first = "", ...rest] = text.split(LINE_BREAK_RE);
  return [`${name}: ${esc(first)}`, ...rest.map((l) => (l === "" ? "" : `  ${esc(l)}`))];
}

/** A list field: `name:` then one `- ` line per entry (continuation lines of
 *  an entry indented under it). An empty list yields nothing. */
function listLines(name: string, items: readonly string[]): string[] {
  const entries = items.filter((item) => item.trim() !== "");
  if (entries.length === 0) return [];
  const lines = [`${name}:`];
  for (const item of entries) {
    const [first = "", ...rest] = item.split(LINE_BREAK_RE);
    lines.push(`  - ${esc(first)}`, ...rest.map((l) => (l === "" ? "" : `    ${esc(l)}`)));
  }
  return lines;
}

/** The digest of one normalized handoff as unlabeled text lines. */
function handoffTextLines(handoff: Handoff): string[] {
  return [
    headline(handoff, handoff.next === null ? "last step" : esc(handoff.next.replace(LINE_BREAK_RE, " "))),
    ...fieldLines("purpose", handoff.purpose),
    ...fieldLines("summary", handoff.summary),
    ...fieldLines("reason", handoff.reason),
    ...listLines("artifacts", handoff.artifacts),
    ...listLines("open questions", handoff.openQuestions),
  ];
}

/** `✓ done → Grilling · 7 artifacts · 10 questions` for one handoff. */
function handoffSummaryLine(handoff: Handoff): string {
  const parts = [headline(handoff, handoff.next === null ? "last step" : escapeFreeText(handoff.next))];
  if (handoff.artifacts.length > 0) parts.push(plural(handoff.artifacts.length, "artifact", "artifacts"));
  if (handoff.openQuestions.length > 0) parts.push(plural(handoff.openQuestions.length, "question", "questions"));
  return parts.join(" · ");
}

function invalidLine(error: string): string {
  return `✗ invalid handoff — ${escapeFreeText(error)}`;
}

/**
 * The multi-line digest of a message's handoff block, one {@link PlainLine}
 * per physical line, all labeled {@link HANDOFF_DIGEST_LABEL}: the first line
 * is `✓ done → <next | last step>` (or `⚠ blocked → …`), then `purpose:`,
 * `summary:`, `reason:`, `artifacts:` and `open questions:` — empty fields are
 * left out, list entries get a `- ` line each. A block whose JSON does not
 * parse is a single `✗ invalid handoff — <error>` line (error tone). Every
 * line is escaped. `[]` when the message has no real block.
 */
export function handoffDigestLines(split: HandoffMessageSplit): PlainLine[] {
  if (split.block === null) return [];
  const { result } = split.block;
  if (!result.ok) return [{ label: HANDOFF_DIGEST_LABEL, text: invalidLine(result.error), tone: "error" }];
  return handoffTextLines(result.handoff).map((text) => ({ label: HANDOFF_DIGEST_LABEL, text, tone: "tag" as const }));
}

/**
 * The one-line digest of a message's handoff block (the TUI's form):
 * `✓ done → Grilling · 7 artifacts · 10 questions`, `… → last step` when
 * `next` is null, `✗ invalid handoff — <error>` for a block that does not
 * parse. `""` when the message has no real block.
 */
export function handoffDigestLine(split: HandoffMessageSplit): string {
  if (split.block === null) return "";
  const { result } = split.block;
  return result.ok ? handoffSummaryLine(result.handoff) : invalidLine(result.error);
}

/**
 * Collapse the previous steps' untrusted-handoff spans in a step prompt (the
 * `--- BEGIN untrusted handoff <nonce> from "<step>" ---` … `--- END … ---`
 * spans `composeStepPrompt` writes, found through the nonce-checked
 * {@link splitHandoffPromptSpans}) into digest text labelled
 * `[handoff from "<step>" · untrusted]` — the digest lines indented under it.
 * With `oneLine` each span becomes a single bracketed line (the TUI's form).
 * A file-pointer span names its file. Text outside the spans is returned
 * untouched; a prompt without spans is returned as the same string.
 */
export function collapseHandoffPromptSpans(text: string, opts?: { oneLine?: boolean }): string {
  if (!text.includes("untrusted handoff")) return text;
  // Same CR normalization the webview applies before splitting (RunPanel's
  // UserMessageBlock): the span markers and the ```json fence need plain `\n`.
  const normalized = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  const parts = splitHandoffPromptSpans(normalized);
  if (parts.length === 1 && parts[0]!.kind === "text") return text;
  const oneLine = opts?.oneLine === true;
  return parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      const title = `handoff from "${esc(part.fromStep)}" · untrusted`;
      if (part.kind === "handoff-file") {
        const where =
          part.filePath === null
            ? "too large to inline; no file available"
            : `${part.tooLarge ? "too large to inline, " : ""}saved to ${esc(part.filePath)}`;
        return `[${title} — ${where}]`;
      }
      if (oneLine) return `[${title} — ${handoffSummaryLine(part.handoff)}]`;
      return [`[${title}]`, ...handoffTextLines(part.handoff).map((l) => (l === "" ? "" : `  ${l}`))].join("\n");
    })
    .join("");
}
