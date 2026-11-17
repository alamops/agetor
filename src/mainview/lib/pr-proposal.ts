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
// Two APIs live here. `parsePrProposals` / `collectRunProposals` return EVERY
// proposal in a reply with its own `Base:` line, link and `Repository:` label,
// which `pr-plan.ts` attributes to (repository, head) pairs for Create all PRs.
// The older single-proposal readers (`parsePrProposal`, `latestPrProposal`)
// stay for the single "Create PR" chip until it moves onto the planner.
import type { RunEvent } from "../../shared/types.ts";

/** What the single-proposal readers return. */
export interface LegacyPrProposal {
  title: string;
  description: string;
  link: string | null;
}

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

function parsePrProposalUnsafe(text: string): LegacyPrProposal | null {
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

function parseProposalAt(lines: string[], titleLabelIdx: number): LegacyPrProposal | null {
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
export function parsePrProposal(text: string): LegacyPrProposal | null {
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
export function latestPrProposal(events: RunEvent[]): LegacyPrProposal | null {
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

/**
 * Parse one labeled proposal per repository out of an agent's Commit & Push
 * reply. Each `Repository: <name>` label starts a block; the block is parsed
 * with the same tolerant {@link parsePrProposal}. A missing label is only
 * tolerated when the whole reply contains exactly one proposal-shaped block:
 * the caller maps that to the single repository it asked about.
 */
export function parseRepositoryProposals(text: string): Map<string, LegacyPrProposal> {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const out = new Map<string, LegacyPrProposal>();
  let currentName: string | null = null;
  let block: string[] = [];

  const flush = () => {
    if (!currentName) return;
    const proposal = parsePrProposal(block.join("\n"));
    if (proposal) out.set(currentName, proposal);
  };

  for (const line of lines) {
    const label = REPO_LABEL_RE.exec(line);
    if (label) {
      flush();
      currentName = repositoryLabelValue(label[1]!);
      if (!currentName) {
        currentName = null;
        block = [];
        continue;
      }
      block = [];
      continue;
    }
    if (currentName) block.push(line);
  }
  flush();
  return out;
}

/**
 * The repositories that still need a pull request — those whose `prUrl` is
 * unset. "Create all PRs" uses this so a second press never opens duplicate
 * PRs and a retry after a partial failure only retries the missing ones.
 */
export function repositoriesNeedingPr<T extends { prUrl: string | null }>(repos: T[]): T[] {
  return repos.filter((r) => !r.prUrl);
}

/**
 * The newest run's labeled proposal for ONE repository. Unlike
 * {@link latestPrProposal}, a proposal labeled for a different repository is
 * never returned — a multi task's Commit & push reply carries one labeled
 * block per repository, and using the last block blindly prefilled the wrong
 * repository's title/description.
 */
export function latestProposalForRepository(
  events: RunEvent[],
  repositoryName: string,
): LegacyPrProposal | null {
  return latestRepositoryProposals(events).get(repositoryName) ?? null;
}

/**
 * Proposals for the repositories a PR action is about to target. An
 * unlabeled proposal is only attributable when there is EXACTLY one target —
 * with several, any attribution would be a guess (and the old
 * `repos[0]` fallback handed the first repository's identity to a proposal
 * from any of them). Missing entries simply fall back to the task title.
 */
export function latestProposalsForTargets(
  events: RunEvent[],
  targetNames: readonly string[],
): Map<string, LegacyPrProposal> {
  const unique = [...new Set(targetNames.filter((n) => n.length > 0))];
  return latestRepositoryProposals(events, unique.length === 1 ? unique[0] : undefined);
}

/**
 * The newest run's per-repository proposals. Mirrors {@link latestPrProposal}
 * (newest run wins, subagent streams ignored) but returns every labeled
 * block, and falls back to a single unlabeled proposal under `fallbackName`.
 */
export function latestRepositoryProposals(
  events: RunEvent[],
  fallbackName?: string,
): Map<string, LegacyPrProposal> {
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
  for (let i = runOrder.length - 1; i >= 0; i--) {
    const runId = runOrder[i];
    if (runId === undefined) continue;
    const chunks = textByRun.get(runId);
    if (!chunks) continue;
    const text = chunks.join("\n\n");
    const labeled = parseRepositoryProposals(text);
    if (labeled.size > 0) return labeled;
    const single = parsePrProposal(text);
    if (single && fallbackName) return new Map([[fallbackName, single]]);
  }
  return new Map();
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
