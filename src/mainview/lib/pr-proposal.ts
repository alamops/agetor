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
//
// `parsePrProposals` / `collectRunProposals` return EVERY proposal in a reply
// with its own `Base:` line, link and `Repository:` label; `pr-plan.ts`
// attributes them to (repository, head) pairs for Create all PRs and the single
// "Create PR" chip.
import type { RunEvent } from "../../shared/types.ts";

/** One proposal as written in the agent's reply. */
export interface PrProposal {
  title: string;
  description: string;
  /** The PR-open link nearest above this proposal's title (its own, never a sibling's). */
  link: string | null;
  /** The cleaned value of the nearest `Base:` line above the title, or null. */
  baseLine: string | null;
  /** The most recent `Repository:` label above the title, or null. */
  repositoryLabel: string | null;
}

/** A proposal tagged with the run it came from; `order` grows with recency. */
export interface RunProposal extends PrProposal {
  runId: string;
  order: number;
}

/** Label line matchers: case-insensitive, tolerant of a markdown heading
 *  prefix (`### PR title:`) and `**`/`*`/`__`/`_` emphasis wrapping plus
 *  trailing whitespace, but nothing else on the line — the fence is expected
 *  on a following line, not inline with the label. */
const TITLE_LABEL_RE = /^#{0,6}\s*[*_]{0,2}\s*pr\s+title\s*:\s*[*_]{0,2}\s*$/i;
const DESC_LABEL_RE = /^#{0,6}\s*[*_]{0,2}\s*pr\s+description\s*:\s*[*_]{0,2}\s*$/i;

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

// ---------------------------------------------------------------------------
// Multi-repository proposals (issue #291)
// ---------------------------------------------------------------------------

/** A `Repository: <name>` label line the multi-repo commit prompt asks for. */
const REPO_LABEL_RE = /^\s*#{0,6}\s*[*_]{0,2}\s*repository\s*:\s*(.*?)\s*$/i;

/**
 * Strip the markdown emphasis an agent may wrap around a label value
 * (`**Repository:** agetor_api`, `Repository: **agetor_api**`) without
 * touching underscores INSIDE the name — `agetor_api` is a real repository
 * name, so the old `[^\n*_]` capture dropped everything from the underscore
 * on and the proposal never matched its repository.
 *
 * Underscores are only stripped as a *balanced* emphasis pair. A single
 * leading/trailing underscore is a legal part of a slug
 * (`repoNameForPath` preserves it), so stripping it unconditionally dropped
 * the proposal for a directory like `api_`. Asterisks can never appear in a
 * slug (`repoNameForPath` replaces them), so any leftover asterisks are
 * still safe to remove. Agents also commonly render the name as an inline
 * code span (`` Repository: `backend` ``), sometimes nested inside emphasis
 * (`` **`backend`** ``), so a balanced backtick pair is stripped too — on
 * repeat, until neither wrapper remains.
 */
function repositoryLabelValue(raw: string): string {
  let value = raw.trim();
  // The label's own emphasis close can leak into the captured value
  // (`### _Repository:_ agetor_api` captures `_ agetor_api`). A slug can never
  // contain a space, so an underscore/asterisk immediately followed by
  // whitespace is emphasis residue, not part of the name.
  value = value.replace(/^[*_]+\s+/, "").trim();
  // Wrappers can nest (`**`backend`**`, `` `**backend**` ``); peel one layer
  // per pass until nothing changes. Bounded so pathological input can't loop.
  for (let pass = 0; pass < 4; pass++) {
    const before = value;
    for (const marker of ["**", "__", "*", "_"]) {
      if (value.length >= marker.length * 2 && value.startsWith(marker) && value.endsWith(marker)) {
        value = value.slice(marker.length, -marker.length).trim();
        break;
      }
    }
    if (value.length >= 2 && value.startsWith("`") && value.endsWith("`")) {
      value = value.slice(1, -1).trim();
    }
    value = value.replace(/^\*+|\*+$/g, "").trim();
    if (value === before) break;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Every proposal in a reply, with its own base and link (Create all PRs)
// ---------------------------------------------------------------------------

/** `Base: <branch>` / `Base branch: <branch>`, tolerant of heading, list, emphasis and a trailing-colon `**Base**:`. */
const BASE_LABEL_RE = /^\s*(?:[-*+]\s+)?#{0,6}\s*[*_]{0,2}\s*base(?:\s+branch)?\s*[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.*?)\s*$/i;

/**
 * The branch named by a `Base:` line's value: emphasis, backticks, quotes and a
 * trailing parenthetical or sentence stop are dropped ("`main` (the default)."
 * gives `main`). A literal `<branch>` placeholder or an empty value gives null.
 */
export function cleanBaseValue(raw: string): string | null {
  let v = raw.trim();
  if (/^<[^>]*>$/.test(v)) return null;
  if (v.startsWith("__") && v.endsWith("__") && v.length > 4) v = v.slice(2, -2).trim();
  // A backtick-quoted value is read whole first: everything between the
  // matching backticks is the name (an apostrophe included), and prose after
  // the closing one is ignored.
  const quoted = /^(?:\*\*|__|\*|_)?\s*`([^`]*)`/.exec(v);
  if (quoted) {
    const inner = quoted[1]!.trim();
    if (!inner || /^<[^>]*>$/.test(inner)) return null;
    // A branch name has no whitespace: `main (the default)` inside the quotes still gives `main`.
    return inner.split(/\s+/)[0]!;
  }
  v = v.replace(/^[*`"'<\s]+/, "");
  const token = /^[^\s`*"'<>,;()]+/.exec(v)?.[0] ?? "";
  const cleaned = token.replace(/[.,;:]+$/, "");
  return cleaned || null;
}

/**
 * A line carrying a link and nothing else worth reading: a bare URL, `<url>`,
 * a lone markdown link `[text](url)`, or `Label: url` / `- **Link:** [text](url)`.
 * Trailing sentence punctuation is dropped.
 */
export function extractLinkLine(line: string): string | null {
  let s = line.trim();
  if (!s) return null;
  s = s.replace(/^(?:[-*+]\s+|>\s*)/, "").trim();
  // Drop a "Label:" / "**Label:**" prefix, but never the scheme's own colon.
  s = s.replace(/^(?:\*\*|__)?[A-Za-z][A-Za-z ]{0,30}(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s+(?=[<\[h])/, "");
  const angle = /^<(https?:\/\/[^>\s]+)>$/.exec(s);
  if (angle) return angle[1]!;
  const md = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)[.,]?$/.exec(s);
  if (md) return md[1]!;
  const bare = /^(https?:\/\/\S+?)[.,)\]]*$/.exec(s);
  return bare ? bare[1]! : null;
}

interface RawProposal {
  title: string;
  description: string;
  titleLabelIdx: number;
  /** Index of the description fence's last line. */
  endIdx: number;
}

/** The title + description blocks starting at a `PR title:` label, or null when incomplete. */
function readTitleAndDescription(lines: string[], titleLabelIdx: number): RawProposal | null {
  const titleFence = findFenceAfter(lines, titleLabelIdx + 1);
  if (!titleFence) return null;
  const title = titleFence.content.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  if (!title) return null;
  const descLabelIdx = lines.findIndex((l, i) => i > titleFence.endIdx && DESC_LABEL_RE.test(l));
  if (descLabelIdx === -1) return null;
  // A description belongs to the nearest title above it: when another
  // `PR title:` comes first, this proposal has none and is dropped, leaving the
  // next one (which the caller resumes at) whole.
  const nextTitleIdx = lines.findIndex((l, i) => i > titleFence.endIdx && TITLE_LABEL_RE.test(l));
  if (nextTitleIdx !== -1 && nextTitleIdx < descLabelIdx) return null;
  const descFence = findFenceAfter(lines, descLabelIdx + 1);
  if (!descFence) return null;
  const description = descFence.content.trim();
  if (!description) return null;
  return { title, description, titleLabelIdx, endIdx: descFence.endIdx };
}

function parsePrProposalsUnsafe(text: string): PrProposal[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const raws: RawProposal[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TITLE_LABEL_RE.test(lines[i] ?? "")) continue;
    const raw = readTitleAndDescription(lines, i);
    if (!raw) continue;
    raws.push(raw);
    i = raw.endIdx;
  }

  const out: PrProposal[] = [];
  raws.forEach((raw, n) => {
    const prev = raws[n - 1];
    const windowStart = prev ? prev.endIdx + 1 : 0;
    let link: string | null = null;
    let baseLine: string | null = null;
    for (let i = raw.titleLabelIdx - 1; i >= windowStart; i--) {
      const line = lines[i] ?? "";
      if (link === null) link = extractLinkLine(line);
      if (baseLine === null) {
        const m = BASE_LABEL_RE.exec(line);
        if (m) baseLine = cleanBaseValue(m[1] ?? "");
      }
      if (link !== null && baseLine !== null) break;
    }
    // The label may sit above an earlier proposal of the same repository, so
    // search the whole text above this title, skipping earlier proposals' blocks.
    let repositoryLabel: string | null = null;
    let idx = raw.titleLabelIdx - 1;
    while (idx >= 0) {
      const blockOfEarlier = raws.find((r, k) => k < n && idx >= r.titleLabelIdx && idx <= r.endIdx);
      if (blockOfEarlier) {
        idx = blockOfEarlier.titleLabelIdx - 1;
        continue;
      }
      const m = REPO_LABEL_RE.exec(lines[idx] ?? "");
      if (m) {
        const value = repositoryLabelValue(m[1] ?? "");
        if (value) {
          repositoryLabel = value;
          break;
        }
      }
      idx--;
    }
    out.push({ title: raw.title, description: raw.description, link, baseLine, repositoryLabel });
  });
  return out;
}

/**
 * Every complete proposal (title + description) in an agent reply, in text
 * order. Each carries the link and `Base:` line nearest above its own title,
 * searched only back to the end of the previous proposal, so a proposal without
 * its own link never inherits a sibling's. The label is the most recent
 * `Repository:` line above it. Never throws.
 */
export function parsePrProposals(text: string): PrProposal[] {
  try {
    return parsePrProposalsUnsafe(text);
  } catch {
    return [];
  }
}

/**
 * Every proposal across a task's run events (assistant stream, subagent streams
 * ignored), tagged with its run. `order` is a single counter over all runs, so a
 * later run, then a later position in the text, always outranks an earlier one.
 */
export function collectRunProposals(events: RunEvent[]): RunProposal[] {
  const textByRun = new Map<string, string[]>();
  const runOrder: string[] = [];
  for (const e of events) {
    if (e.stream !== "assistant" || e.subagentId) continue;
    let chunks = textByRun.get(e.runId);
    if (!chunks) {
      chunks = [];
      textByRun.set(e.runId, chunks);
      runOrder.push(e.runId);
    }
    chunks.push(e.data ?? "");
  }
  const out: RunProposal[] = [];
  let order = 0;
  for (const runId of runOrder) {
    for (const p of parsePrProposals((textByRun.get(runId) ?? []).join("\n\n"))) {
      out.push({ ...p, runId, order: order++ });
    }
  }
  return out;
}
