// Shared by both processes — must stay free of runtime imports from either
// side (same rule refs.ts documents). This is the "create a task from a Git
// issue" prompt/URL toolkit: `parseIssueUrl`/`normalizeIssueUrl` classify and
// compare issue URLs across all three providers, `renderIssueThreadMarkdown`
// builds the durable snapshot file (`dataDir/issue-threads/<taskId>/…`), and
// `buildIssueTaskPrompt` builds the launch prompt embedded in the task. The
// webview (New Task form, the issue-detail "Work on this with Agetor"
// dialog) and the CLI (`agetor add --issue`) both build on these so the
// prompt/snapshot shape can never drift between entry points.
import type { GitHubComment, GitHubIssueThreadResult, GitHubListItem, GitProvider } from "./types.ts";

/** Result of successfully parsing an issue URL: which forge it came from,
 *  the issue number, and the owning repo (used for the same-repo guard at
 *  task-create time). */
export interface ParsedIssueUrl {
  provider: GitProvider;
  number: number;
  owner: string;
  repo: string;
  host: string;
}

/** Any of these path segments mean "this is not a plain issue" (a pull/merge
 *  request or a discussion) — rejected up front regardless of provider. */
const NOT_AN_ISSUE_RE = /\/(pull|merge_requests|pull-requests|discussions)\//;

/** Canonical decimal only — `Number()` would also admit "1e3"/"0x10"/"12.0". */
function isCanonicalPositiveInt(s: string | undefined): s is string {
  return !!s && /^\d+$/.test(s) && Number(s) > 0;
}

/**
 * Detect which git forge an issue URL belongs to and extract its number and
 * owning repo, by matching the URL's *path shape* (self-hosted GitLab/
 * Bitbucket/GitHub Enterprise instances live on arbitrary domains). http(s)
 * only. Path shapes, checked in this order:
 *
 *  1. GitLab nested-group form: `/<group>/<subgroup...>/<project>/-/issues/<n>`
 *     — owner is the joined group path, repo is the last segment before `/-/`.
 *  2. Legacy GitLab (no `/-/`): `/<owner>/<repo>/issues/<n>` on a host whose
 *     name contains "gitlab".
 *  3. Bitbucket: `/<workspace>/<repo_slug>/issues/<n>[/anything]` on a host
 *     whose name contains "bitbucket".
 *  4. GitHub (the default — also covers self-hosted GHES hosts):
 *     `/<owner>/<repo>/issues/<n>[/anything]`.
 *
 * Returns null for an unparseable URL, a non-http(s) URL, a pull/merge-request
 * or discussion URL, or anything that doesn't match one of the shapes above.
 */
export function parseIssueUrl(url: string | null | undefined): ParsedIssueUrl | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (NOT_AN_ISSUE_RE.test(parsed.pathname)) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  // (1) GitLab nested-group form.
  const dashIdx = segments.indexOf("-");
  if (
    dashIdx >= 2
    && segments[dashIdx + 1] === "issues"
    && isCanonicalPositiveInt(segments[dashIdx + 2])
  ) {
    const ownerRepo = segments.slice(0, dashIdx);
    const repo = ownerRepo[ownerRepo.length - 1]!;
    const owner = ownerRepo.slice(0, -1).join("/");
    return { provider: "gitlab", number: Number(segments[dashIdx + 2]), owner, repo, host };
  }

  // (2) Legacy GitLab (no `/-/`) — exact `/<owner>/<repo>/issues/<n>` shape.
  if (
    host.includes("gitlab")
    && segments.length === 4
    && segments[2] === "issues"
    && isCanonicalPositiveInt(segments[3])
  ) {
    return { provider: "gitlab", number: Number(segments[3]), owner: segments[0]!, repo: segments[1]!, host };
  }

  // (3) Bitbucket.
  if (
    host.includes("bitbucket")
    && segments.length >= 4
    && segments[2] === "issues"
    && isCanonicalPositiveInt(segments[3])
  ) {
    return { provider: "bitbucket", number: Number(segments[3]), owner: segments[0]!, repo: segments[1]!, host };
  }

  // (4) GitHub (default — also GHES).
  if (segments.length >= 4 && segments[2] === "issues" && isCanonicalPositiveInt(segments[3])) {
    return { provider: "github", number: Number(segments[3]), owner: segments[0]!, repo: segments[1]!, host };
  }

  return null;
}

/**
 * Normalizes an issue URL for equality guards (e.g. "the fetched item's
 * htmlUrl must match the URL the user pasted/opened"): lowercases the host,
 * drops the query string/fragment, and cuts everything after the
 * `issues/<n>` segment (so `…/issues/7/title-slug` compares equal to
 * `…/issues/7`). Falls back to the raw input for an unparseable URL — the
 * caller is expected to have already gone through `parseIssueUrl` when that
 * matters.
 */
export function normalizeIssueUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.host.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  const issuesIdx = segments.indexOf("issues");
  const cut = issuesIdx >= 0 ? segments.slice(0, issuesIdx + 2) : segments;
  const path = cut.length > 0 ? `/${cut.join("/")}` : "";
  return `${parsed.protocol}//${host}${path}`.replace(/\/+$/, "");
}

/** `Issue #<n>: <title>` — neutral title template (not every issue is a bug). */
export function issueTaskTitle(item: Pick<GitHubListItem, "number" | "title">): string {
  return `Issue #${item.number}: ${item.title}`;
}

/** Filename the full thread snapshot is written under, per task
 *  (`dataDir/issue-threads/<taskId>/<this>`). */
export const ISSUE_SNAPSHOT_FILENAME = (n: number): string => `issue-${n}-thread.md`;

/** Byte budget for the inline thread excerpt in the launch prompt — the
 *  snapshot file (referenced alongside it) always carries the full thread
 *  regardless of this cap. */
export const ISSUE_PROMPT_INLINE_MAX_BYTES = 32_768;

/**
 * Renders the complete thread — issue metadata, description, and every
 * fetched comment — as deterministic markdown. This is what's written to the
 * snapshot file (`ISSUE_SNAPSHOT_FILENAME`) and attached as a task reference,
 * so the agent can read the full thread regardless of the prompt's inline
 * cap or a capped harness's argv limit.
 */
export function renderIssueThreadMarkdown(t: {
  repo: string;
  item: GitHubListItem;
  comments: GitHubComment[];
  truncated: boolean;
}): string {
  const { repo, item, comments, truncated } = t;
  const lines: string[] = [];
  lines.push(`# Issue #${item.number}: ${item.title}`);
  lines.push("");
  lines.push(`- Repo: ${repo}`);
  lines.push(`- URL: ${item.htmlUrl}`);
  lines.push(`- State: ${item.state}`);
  lines.push(`- Author: ${item.author ? `@${item.author.login}` : "unknown"}`);
  lines.push(`- Labels: ${item.labels.length ? item.labels.map((l) => l.name).join(", ") : "(none)"}`);
  lines.push(`- Created: ${item.createdAt}`);
  lines.push(`- Updated: ${item.updatedAt}`);
  lines.push(`- Comments: ${comments.length}`);
  if (truncated) lines.push(`- Thread truncated at the fetch cap`);
  lines.push("");
  lines.push(`## Description`);
  lines.push("");
  lines.push(item.body.trim() ? item.body : "_(no description)_");
  lines.push("");
  lines.push(`## Comments (${comments.length})`);
  for (const c of comments) {
    lines.push("");
    lines.push(`### @${c.author?.login ?? "unknown"} — ${c.createdAt} — ${c.htmlUrl}`);
    lines.push("");
    lines.push(c.body);
  }
  return lines.join("\n");
}

/** `Fixes`/`Closes #N` keyword each provider's magic-word commit convention
 *  understands; Bitbucket has no such convention, so its paragraph just
 *  names the issue plainly. */
function commitReferencePhrase(provider: GitProvider, number: number): string {
  if (provider === "github") return `Fixes #${number}`;
  if (provider === "gitlab") return `Closes #${number}`;
  return `issue #${number}`;
}

/**
 * Builds the launch prompt for a task created from an issue: what to do,
 * how to reference the fix in the commit, the snapshot-file pointer, the
 * re-fetch hint, and the issue + as much of the thread as fits under
 * `opts.inlineMaxBytes` (default `ISSUE_PROMPT_INLINE_MAX_BYTES`) — the full
 * thread always lives in the snapshot file regardless of this cap. Returns
 * `inlinedComments` so callers (or tests) can tell how much of the thread
 * made it into the prompt body.
 */
export function buildIssueTaskPrompt(
  t: GitHubIssueThreadResult & { snapshotAttached: boolean },
  opts?: { inlineMaxBytes?: number },
): { prompt: string; inlinedComments: number } {
  const { repo, item, comments, truncated, refetchCommand, snapshotAttached } = t;
  const number = item.number;
  const provider = parseIssueUrl(item.htmlUrl)?.provider ?? "github";
  const inlineMaxBytes = opts?.inlineMaxBytes ?? ISSUE_PROMPT_INLINE_MAX_BYTES;

  const paragraphs: string[] = [];
  paragraphs.push(`Work on ${repo} issue #${number} — "${item.title}" (${item.htmlUrl}).`);
  paragraphs.push(
    "Investigate the issue and its comment thread, locate the relevant code, and reproduce it — "
      + "with a failing test or by following the reported steps — before changing anything.",
  );
  paragraphs.push(
    "Implement the fix or change the issue asks for, add or adjust tests as needed, and run the "
      + "relevant test suite.",
  );
  paragraphs.push(
    `Commit locally with a clear message that includes "${commitReferencePhrase(provider, number)}". `
      + "Do not push. Leave the commit local — the user will review and push it themselves.",
  );
  if (snapshotAttached) {
    paragraphs.push(
      `The complete thread snapshot (issue body + all ${comments.length} comments`
        + `${truncated ? ", truncated at the fetch cap" : ""}) is saved as `
        + `\`${ISSUE_SNAPSHOT_FILENAME(number)}\`, listed under "Referenced files/folders" below — `
        + "read it if the inline excerpt is cut short.",
    );
  }
  if (refetchCommand) {
    paragraphs.push(`To re-fetch the live thread later, run: \`${refetchCommand}\``);
  }

  const metaLines = [
    `State: ${item.state}`,
    `Author: ${item.author ? `@${item.author.login}` : "unknown"}`,
    `Labels: ${item.labels.length ? item.labels.map((l) => l.name).join(", ") : "(none)"}`,
    `Opened: ${item.createdAt}`,
    `${comments.length} comments`,
  ];
  paragraphs.push(
    [
      "---",
      "",
      `## Issue #${number}: ${item.title}`,
      metaLines.join("\n"),
      "",
      item.body.trim() ? item.body : "_(no description)_",
    ].join("\n"),
  );

  // Thread section: inline comments while the running byte total (measured
  // against the FULL prompt built so far, not just the thread section) stays
  // under budget.
  const base = paragraphs.join("\n\n");
  const encoder = new TextEncoder();
  const threadLines: string[] = ["## Thread"];
  let inlinedComments = 0;
  for (const c of comments) {
    const entry = `**@${c.author?.login ?? "unknown"}** (${c.createdAt}):\n${c.body}`;
    const candidate = [...threadLines, entry].join("\n\n");
    const candidateFull = `${base}\n\n${candidate}`;
    if (encoder.encode(candidateFull).length > inlineMaxBytes) break;
    threadLines.push(entry);
    inlinedComments++;
  }
  let threadSection = threadLines.join("\n\n");
  const remaining = comments.length - inlinedComments;
  if (remaining > 0) {
    threadSection += `\n\n_(… ${remaining} more comments — see the snapshot file)_`;
  }
  if (truncated) {
    threadSection += `\n\n_(thread truncated at the fetch cap)_`;
  }
  paragraphs.push(threadSection);

  return { prompt: paragraphs.join("\n\n"), inlinedComments };
}
