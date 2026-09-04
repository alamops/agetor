// Parses the PR title/description an agent prints after a Commit & Push turn
// (the contract `commitPushPrompt` asks for — see src/shared/types.ts) out of
// the task's run-event stream, so the UI can prefill the "Open PR" composer
// without a second round-trip.
//
// The agent is asked for: a plain-text PR-open link on its own line, then a
// "PR title:" label followed by a ``` fenced one-line title, then a
// "PR description:" label followed by a ```` (four-backtick) fenced markdown
// block. Agents don't always reproduce this verbatim, so every step here is
// best-effort and the whole thing degrades to `null` rather than throwing or
// mis-rendering garbage.
//
// Pure, DOM-free, unit-testable — same convention as `shared/user-message.ts`.
import type { RunEvent } from "../../shared/types.ts";

export interface PrProposal {
  title: string;
  description: string;
  link: string | null;
}

/** Label line matchers: case-insensitive, tolerant of a markdown heading
 *  prefix (`### PR title:`) and `**`/`*`/`__`/`_` emphasis wrapping plus
 *  trailing whitespace, but nothing else on the line — the fence is expected
 *  on a following line, not inline with the label. */
const TITLE_LABEL_RE = /^#{0,6}\s*[*_]{0,2}\s*pr\s+title\s*:\s*[*_]{0,2}\s*$/i;
const DESC_LABEL_RE = /^#{0,6}\s*[*_]{0,2}\s*pr\s+description\s*:\s*[*_]{0,2}\s*$/i;

/** A line consisting of nothing but a bare http(s) URL (optionally trailing
 *  a stray sentence-punctuation character prose sometimes tacks on). */
function extractUrlLine(line: string): string | null {
  const s = line.trim();
  if (!s) return null;
  const BARE = /^https?:\/\/\S+$/;
  if (BARE.test(s)) return s;
  const stripped = s.replace(/[.,)\]]+$/, "");
  if (stripped !== s && BARE.test(stripped)) return stripped;
  return null;
}

interface FenceMatch {
  content: string;
  /** Index of the closing fence line, or the last content line's index when
   *  the fence never closes (tolerated — we just take the rest as content). */
  endIdx: number;
}

/**
 * Starting from `fromIdx`, skip blank lines and look for a fenced code block
 * opener (3+ backticks, any info string). The block closes only at a later
 * line whose trimmed content is backticks-only and at least as long as the
 * opening run — this is what lets a 4-backtick PR-description fence survive
 * inner ``` fences (a 3-backtick line can't close a `{4,}` requirement).
 * Returns `null` when the next non-blank line isn't a fence opener at all.
 */
function findFenceAfter(lines: string[], fromIdx: number): FenceMatch | null {
  let i = fromIdx;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  if (i >= lines.length) return null;

  const open = /^\s*(`{3,})/.exec(lines[i] ?? "");
  if (!open) return null;
  const tickLen = (open[1] ?? "").length;
  const closeRe = new RegExp(`^\\s*\`{${tickLen},}\\s*$`);

  let j = i + 1;
  while (j < lines.length && !closeRe.test(lines[j] ?? "")) j++;
  const content = lines.slice(i + 1, j).join("\n");
  return { content, endIdx: j < lines.length ? j : lines.length - 1 };
}

function parsePrProposalUnsafe(text: string): PrProposal | null {
  // Critical: raw run_event data can carry bare `\r` newlines (tmux
  // paste-buffer artifact — see event-dedup.ts's normalizeForKey). Every
  // blank-line / line-start regex below silently fails without this.
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  // A run can contain several proposals (a follow-up Commit & push folds into
  // the same run rather than opening a new one), so try title labels from the
  // LAST occurrence backward — the newest complete proposal wins, and an
  // incomplete trailing one falls back to an earlier complete one.
  for (let titleLabelIdx = lines.length - 1; titleLabelIdx >= 0; titleLabelIdx--) {
    if (!TITLE_LABEL_RE.test(lines[titleLabelIdx] ?? "")) continue;
    const proposal = parseProposalAt(lines, titleLabelIdx);
    if (proposal) return proposal;
  }
  return null;
}

function parseProposalAt(lines: string[], titleLabelIdx: number): PrProposal | null {
  const titleFence = findFenceAfter(lines, titleLabelIdx + 1);
  if (!titleFence) return null;
  const titleLine = titleFence.content.split("\n").find((l) => l.trim() !== "");
  const title = titleLine?.trim() ?? "";
  if (!title) return null;

  const descLabelIdx = lines.findIndex(
    (l, i) => i > titleFence.endIdx && DESC_LABEL_RE.test(l),
  );
  if (descLabelIdx === -1) return null;

  const descFence = findFenceAfter(lines, descLabelIdx + 1);
  if (!descFence) return null;
  const description = descFence.content.trim();
  if (!description) return null;

  // The nearest URL-only line above the title label wins — walking backward
  // means the first hit is the closest (i.e. "last before the label").
  let link: string | null = null;
  for (let i = titleLabelIdx - 1; i >= 0; i--) {
    const url = extractUrlLine(lines[i] ?? "");
    if (url) {
      link = url;
      break;
    }
  }

  return { title, description, link };
}

/** Extract a `{ title, description, link }` proposal from raw assistant text.
 *  Returns `null` unless both title and description parse; never throws on
 *  arbitrary/garbage input. */
export function parsePrProposal(text: string): PrProposal | null {
  try {
    return parsePrProposalUnsafe(text);
  } catch {
    return null;
  }
}

/**
 * Scan a task's unified run-event stream for the most recent parseable PR
 * proposal. Events are grouped by `runId` (preserving stream order within
 * each run — title and description can land in separate assistant text
 * blocks of the same reply, joined here with a blank line), then runs are
 * tried newest-first: since events arrive in id order, the last-seen runId
 * is the newest one.
 */
export function latestPrProposal(events: RunEvent[]): PrProposal | null {
  const textByRun = new Map<string, string[]>();
  const runOrder: string[] = [];
  for (const e of events) {
    // Background-agent (subagent) streams are read-only side channels — a
    // subagent echoing a proposal-shaped block must not hijack the prefill
    // from the main agent's real reply.
    if (e.stream !== "assistant" || e.subagentId) continue;
    let chunks = textByRun.get(e.runId);
    if (!chunks) {
      chunks = [];
      textByRun.set(e.runId, chunks);
      runOrder.push(e.runId);
    }
    chunks.push(e.data ?? "");
  }

  for (let i = runOrder.length - 1; i >= 0; i--) {
    const runId = runOrder[i];
    if (runId === undefined) continue;
    const chunks = textByRun.get(runId);
    if (!chunks) continue;
    const proposal = parsePrProposal(chunks.join("\n\n"));
    if (proposal) return proposal;
  }
  return null;
}
