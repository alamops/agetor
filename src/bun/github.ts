import { existsSync } from "node:fs";
import type {
  GitHubAssigneesResult,
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubCommitStatus,
  GitHubCommitStatusContext,
  GitHubCommitStatusResult,
  GitHubDiscussion,
  GitHubDiscussionCategory,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubDiscussionsResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubLabel,
  GitHubLabelsResult,
  GitHubLinkedIssue,
  GitHubLinkedIssuesResult,
  GitHubListItem,
  GitHubListResult,
  GitHubRepoLabel,
  GitHubMilestone,
  GitHubMilestonesResult,
  GitHubNotification,
  GitHubNotificationsResult,
  GitHubRepoMilestone,
  GitHubPullCommit,
  GitHubPullCommitsResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
  GitHubPullReviewThreadsResult,
  GitHubProjectField,
  GitHubProjectItem,
  GitHubProjectItemsResult,
  GitHubProjectV2,
  GitHubProjectsV2Result,
  GitHubRateLimit,
  GitHubReactionContent,
  GitHubReactionsResult,
  GitHubReactionSubject,
  GitHubReactionSummary,
  GitHubRelease,
  GitHubReleasesResult,
  GitHubRepoPermissions,
  GitHubReviewThread,
  GitHubSubIssue,
  GitHubSubIssuesResult,
  GitHubTag,
  GitHubTagsResult,
  GitHubUser,
  GitHubWorkflow,
  GitHubWorkflowRun,
  GitHubWorkflowRunsResult,
  GitHubWorkflowsResult,
  TaskDiff,
} from "../shared/types.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import { tokenForHost } from "./github-tokens.ts";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PipedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

export interface GitHubRepo {
  owner: string;
  name: string;
  /** Raw (pre-canonicalization) remote host — e.g. `github-work.com` for an
   *  ssh host alias, or `github.com` for a plain remote. This is the identity
   *  key tokens are stored under (see github-tokens.ts) since one env var or
   *  `gh auth token` can't cover more than one GitHub identity. */
  remoteHost: string;
}

interface ListGitHubItemsInput {
  dir: string;
  kind: GitHubItemKind;
  state: GitHubItemState;
  query?: string;
  labels?: string[];
  assignee?: string;
  // "Involvement" filters keyed to the authenticated user. When any is set the
  // list is served by the Search API (`author:@me` etc.), since the plain
  // /pulls and /issues list endpoints can't filter a PR by author/reviewer.
  createdByMe?: boolean;
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  // Raw GitHub search qualifiers typed by the user (e.g. `label:bug sort:updated`).
  // When present, forces the Search API and is appended to the composed query.
  searchQuery?: string;
  /** 1-based page to fetch. Defaults to 1. Combined with `hasMore` on the
   *  result, this is what drives the UI's "Load more" pagination (F16). */
  page?: number;
  /** Server-side sort field — passed to REST `/issues`|`/pulls` as `sort`, and
   *  to `/search/issues` as `sort` too (search additionally supports
   *  `reactions`, not exposed here). */
  sort?: "created" | "updated" | "comments";
  /** Sort direction — REST calls it `direction`, search calls it `order`;
   *  `listGitHubItems` translates the single input field to each API's name. */
  direction?: "asc" | "desc";
}

interface GetGitHubPullDiffInput {
  dir: string;
  number: number;
}

interface GitHubItemNumberInput {
  dir: string;
  number: number;
}

interface CreateGitHubCommentInput extends GitHubItemNumberInput {
  body: string;
}

interface CreateGitHubPullLineCommentInput extends GitHubItemNumberInput {
  body: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

interface ReplyGitHubPullLineCommentInput extends GitHubItemNumberInput {
  commentId: number;
  body: string;
}

interface ReviewCommentDraft {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

interface ReviewGitHubPullInput extends GitHubItemNumberInput {
  event: GitHubPullReviewEvent;
  body?: string;
  /** Inline comments to attach to this single review (the "pending review" /
   *  batched-comments flow). Each is posted with the review, not individually. */
  comments?: ReviewCommentDraft[];
}

interface MergeGitHubPullInput extends GitHubItemNumberInput {
  method: GitHubPullMergeMethod;
  title?: string;
  message?: string;
}

interface CloseGitHubPullInput extends GitHubItemNumberInput {
  comment?: string;
}

interface CreateGitHubPullInput {
  dir: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  reviewers?: string[];
}

interface CreateGitHubIssueInput {
  dir: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

interface UpdateGitHubIssueInput extends GitHubItemNumberInput {
  // The /issues/:number endpoint patches pull requests too (title/body/state/
  // labels/assignees/milestone). `kind` decides how the response is normalized so
  // the returned item keeps the caller's kind ("pulls" vs "issues").
  kind?: GitHubItemKind;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

interface RequestGitHubPullReviewersInput extends GitHubItemNumberInput {
  reviewers: string[];
  /** Org team slugs (e.g. "org/team-slug" is NOT the shape GitHub wants here —
   *  just the bare slug, "team-slug"; the org is implied by the repo). Reviews
   *  can be requested from teams in addition to (or instead of) individuals. */
  teamReviewers?: string[];
}

interface ApplyGitHubSuggestionInput extends GitHubItemNumberInput {
  commentId: number;
}

interface SetGitHubPullDraftInput extends GitHubItemNumberInput {
  draft: boolean;
}

interface SetGitHubPullAutoMergeInput extends GitHubItemNumberInput {
  enable: boolean;
  mergeMethod?: GitHubPullMergeMethod;
}

interface SetGitHubIssueLockInput extends GitHubItemNumberInput {
  locked: boolean;
  /** Only meaningful when locking (`locked: true`); an unrecognized/omitted
   *  value locks without a reason rather than erroring. */
  lockReason?: string;
}

interface SetGitHubIssuePinnedInput extends GitHubItemNumberInput {
  pinned: boolean;
}

interface AddGitHubSubIssueInput extends GitHubItemNumberInput {
  childNumber: number;
}

interface RemoveGitHubSubIssueInput extends GitHubItemNumberInput {
  childId: number;
}

interface TransferGitHubIssueInput extends GitHubItemNumberInput {
  /** "owner/name" of the destination repository. */
  targetRepo: string;
}

interface GetGitHubProjectItemsInput {
  dir: string;
  projectId: string;
}

interface AddGitHubProjectItemInput {
  dir: string;
  projectId: string;
  contentNumber: number;
  /** Which REST endpoint resolves the content's node id — `/issues/:number`
   *  vs `/pulls/:number`. Both return `node_id` for the same underlying
   *  object (a PR is an issue under the hood), so this only picks which
   *  endpoint to hit, not whether the add succeeds. */
  contentKind: "issue" | "pr";
}

interface RemoveGitHubProjectItemInput {
  dir: string;
  projectId: string;
  itemId: string;
}

interface SetGitHubProjectItemStatusInput {
  dir: string;
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}

interface GetGitHubDiscussionInput {
  dir: string;
  number: number;
}

interface CreateGitHubDiscussionInput {
  dir: string;
  categoryId: string;
  title: string;
  body: string;
}

interface AddGitHubDiscussionCommentInput {
  dir: string;
  discussionId: string;
  body: string;
}

interface SetGitHubDiscussionAnswerInput {
  dir: string;
  commentId: string;
  answer: boolean;
}

interface DeleteGitHubDiscussionInput {
  dir: string;
  discussionId: string;
}

interface DeleteGitHubDiscussionCommentInput {
  dir: string;
  commentId: string;
}

// A "conversation" comment (issue/PR body thread) lives under /issues/comments;
// an inline "review" comment lives under /pulls/comments. Both share the edit /
// delete shape, differing only by that path segment.
type GitHubCommentKind = "issue" | "review";

interface UpdateGitHubCommentInput {
  dir: string;
  commentId: number;
  kind: GitHubCommentKind;
  body: string;
}

interface DeleteGitHubCommentInput {
  dir: string;
  commentId: number;
  kind: GitHubCommentKind;
}

interface SetGitHubReviewThreadResolvedInput {
  dir: string;
  threadId: string;
  resolved: boolean;
}

interface CreateGitHubLabelInput {
  dir: string;
  name: string;
  color: string;
  description?: string;
}

interface UpdateGitHubLabelInput {
  dir: string;
  name: string;
  newName?: string;
  color?: string;
  description?: string;
}

interface DeleteGitHubLabelInput {
  dir: string;
  name: string;
}

interface CreateGitHubMilestoneInput {
  dir: string;
  title: string;
  description?: string;
  dueOn?: string;
}

interface UpdateGitHubMilestoneInput {
  dir: string;
  number: number;
  title?: string;
  description?: string;
  dueOn?: string | null;
  state?: "open" | "closed";
}

interface DeleteGitHubMilestoneInput {
  dir: string;
  number: number;
}

interface CreateGitHubReleaseInput {
  dir: string;
  tagName: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  targetCommitish?: string;
}

interface UpdateGitHubReleaseInput {
  dir: string;
  id: number;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  tagName?: string;
}

interface DeleteGitHubReleaseInput {
  dir: string;
  id: number;
}

interface GetGitHubCommitStatusInput {
  dir: string;
  ref: string;
}

interface RerunGitHubWorkflowRunInput {
  dir: string;
  runId: number;
  /** When true, hits `rerun-failed-jobs` instead of the plain `rerun`
   *  endpoint — only re-executes jobs that failed (and their dependents). */
  failedOnly?: boolean;
}

interface CancelGitHubWorkflowRunInput {
  dir: string;
  runId: number;
}

interface DispatchGitHubWorkflowInput {
  dir: string;
  workflowId: number;
  ref: string;
  /** Free-form key/value pairs (F20 assumption: no YAML parser is available
   *  to read the workflow file's declared `workflow_dispatch.inputs` schema,
   *  so the user supplies whatever keys the workflow expects verbatim). */
  inputs?: Record<string, string>;
}

interface ListGitHubNotificationsInput {
  dir: string;
  /** `false` (default) = unread only; `true` = all notifications, matching
   *  GitHub's own `all` query param semantics. */
  all?: boolean;
}

interface GitHubThreadInput {
  dir: string;
  threadId: string;
}

interface SetGitHubThreadSubscriptionInput extends GitHubThreadInput {
  ignored: boolean;
}

interface ListGitHubReactionsInput {
  dir: string;
  subject: GitHubReactionSubject;
  viewer: string;
}

interface AddGitHubReactionInput {
  dir: string;
  subject: GitHubReactionSubject;
  content: GitHubReactionContent;
}

interface RemoveGitHubReactionInput {
  dir: string;
  subject: GitHubReactionSubject;
  reactionId: number;
}

interface GitHubListError {
  ok: false;
  error: string;
}

type GitHubListResponse = ({ ok: true } & GitHubListResult) | GitHubListError;
type GitHubDiffResponse = ({ ok: true } & TaskDiff) | GitHubListError;
type GitHubCommentsResponse = ({ ok: true } & GitHubCommentsResult) | GitHubListError;
type GitHubCommentResponse = ({ ok: true; comment: GitHubComment }) | GitHubListError;
type GitHubPullLineCommentResponse = ({ ok: true; comment: GitHubPullLineComment }) | GitHubListError;
type GitHubPullReviewCommentsResponse = ({ ok: true } & GitHubPullReviewCommentsResult) | GitHubListError;
type GitHubChecksResponse = ({ ok: true } & GitHubChecksResult) | GitHubListError;
type GitHubMergeabilityResponse = ({ ok: true } & GitHubPullMergeability) | GitHubListError;
type GitHubPullDraftResponse = ({ ok: true; draft: boolean; message?: string }) | GitHubListError;
type GitHubPullAutoMergeResponse = ({ ok: true; autoMergeEnabled: boolean; message?: string }) | GitHubListError;
type GitHubPullCommitsResponse = ({ ok: true } & GitHubPullCommitsResult) | GitHubListError;
type GitHubLinkedIssuesResponse = ({ ok: true } & GitHubLinkedIssuesResult) | GitHubListError;
type GitHubViewerResponse = ({ ok: true; login: string }) | GitHubListError;
type GitHubRepoPermissionsResponse = ({ ok: true } & GitHubRepoPermissions) | GitHubListError;
type GitHubLabelsResponse = ({ ok: true } & GitHubLabelsResult) | GitHubListError;
type GitHubLabelResponse = ({ ok: true; label: GitHubRepoLabel }) | GitHubListError;
type GitHubAssigneesResponse = ({ ok: true } & GitHubAssigneesResult) | GitHubListError;
type GitHubMilestonesResponse = ({ ok: true } & GitHubMilestonesResult) | GitHubListError;
type GitHubMilestoneResponse = ({ ok: true; milestone: GitHubRepoMilestone }) | GitHubListError;
type GitHubReviewThreadsResponse = ({ ok: true } & GitHubPullReviewThreadsResult) | GitHubListError;
type GitHubThreadResolveResponse = ({ ok: true; resolved: boolean; message?: string }) | GitHubListError;
type GitHubActionResponse = ({ ok: true; message?: string; item?: GitHubListItem; commentPosted?: boolean }) | GitHubListError;
type GitHubPullMergeResponse = GitHubPullMergeResult | GitHubListError;
type GitHubPullDefaultsResponse = ({ ok: true } & GitHubPullDefaultsResult) | GitHubListError;
type GitHubIssueResponse = ({ ok: true; item: GitHubListItem; message?: string }) | GitHubListError;
type GitHubReactionsResponse = ({ ok: true } & GitHubReactionsResult) | GitHubListError;
type GitHubReactionAddResponse = ({ ok: true; reactionId: number; content: GitHubReactionContent }) | GitHubListError;
type GitHubReactionRemoveResponse = ({ ok: true }) | GitHubListError;
type GitHubApplySuggestionResponse = ({ ok: true; message: string }) | GitHubListError;
type GitHubIssueLockResponse = ({ ok: true; locked: boolean; message?: string }) | GitHubListError;
type GitHubIssuePinnedResponse = ({ ok: true; pinned: boolean; message?: string }) | GitHubListError;
type GitHubSubIssuesResponse = ({ ok: true } & GitHubSubIssuesResult) | GitHubListError;
type GitHubSubIssueAddResponse = ({ ok: true; subIssue: GitHubSubIssue; message?: string }) | GitHubListError;
type GitHubIssueTransferResponse = ({ ok: true; url: string; message?: string }) | GitHubListError;
type GitHubNotificationsResponse = ({ ok: true } & GitHubNotificationsResult) | GitHubListError;
type GitHubMarkAllReadResponse = ({ ok: true; message: string }) | GitHubListError;
type GitHubThreadSubscriptionResponse = ({ ok: true; subscribed: boolean; ignored: boolean }) | GitHubListError;
type GitHubReleasesResponse = ({ ok: true } & GitHubReleasesResult) | GitHubListError;
type GitHubReleaseResponse = ({ ok: true; release: GitHubRelease }) | GitHubListError;
type GitHubTagsResponse = ({ ok: true } & GitHubTagsResult) | GitHubListError;
type GitHubCommitStatusResponse = ({ ok: true } & GitHubCommitStatusResult) | GitHubListError;
type GitHubWorkflowRunsResponse = ({ ok: true } & GitHubWorkflowRunsResult) | GitHubListError;
type GitHubWorkflowsResponse = ({ ok: true } & GitHubWorkflowsResult) | GitHubListError;
type GitHubWorkflowActionResponse = ({ ok: true; message: string }) | GitHubListError;
type GitHubProjectsV2Response = ({ ok: true } & GitHubProjectsV2Result) | GitHubListError;
type GitHubProjectItemsResponse = ({ ok: true } & GitHubProjectItemsResult) | GitHubListError;
type GitHubProjectItemAddResponse = ({ ok: true; itemId: string }) | GitHubListError;
type GitHubDiscussionsResponse = ({ ok: true } & GitHubDiscussionsResult) | GitHubListError;
type GitHubDiscussionResponse = ({ ok: true; detail: GitHubDiscussionDetail }) | GitHubListError;
type GitHubDiscussionCreateResponse = ({ ok: true; number: number; url: string }) | GitHubListError;
type GitHubDiscussionCommentResponse = ({ ok: true; commentId: string }) | GitHubListError;
type GitHubDiscussionAnswerResponse = ({ ok: true; isAnswer: boolean }) | GitHubListError;

const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const GITHUB_DIFF_BODY_CAP_BYTES = 8_000_000;

/** Valid `lock_reason` values GitHub's lock endpoint accepts. An
 *  unrecognized/absent value locks without a reason instead of erroring. */
const ISSUE_LOCK_REASONS = new Set(["off-topic", "too heated", "resolved", "spam"]);

export async function run(cmd: string[], cwd?: string, timeoutMs = 10_000): Promise<CommandResult> {
  let proc: PipedProcess;
  try {
    proc = Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }) as PipedProcess;
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 127,
    };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a remote's host to its canonical provider host. Users pin per-identity
 *  SSH keys via `~/.ssh/config` host aliases (`github-work.com`, `bitbucket-x.org`,
 *  …), so the host in a remote URL is often not the provider's real hostname.
 *  Any host containing the provider's name resolves to that provider. */
export function canonicalGitHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.includes("github")) return "github.com";
  if (lower.includes("gitlab")) return "gitlab.com";
  if (lower.includes("bitbucket")) return "bitbucket.org";
  return lower;
}

/** Extract host + owner/name from a git remote URL in https, ssh://, or
 *  scp-like (`[user@]host:owner/repo`) form. `host` is canonicalized via
 *  canonicalGitHost; `rawHost` is the lowercased pre-canonicalization host
 *  (the ssh alias itself, when one is in play) — callers that need to route a
 *  per-identity token use `rawHost`, not `host`. Returns null for local paths
 *  and anything unrecognized. */
export function parseGitRemote(raw: string): { host: string; rawHost: string; owner: string; name: string } | null {
  const remote = raw.trim();
  if (!remote) return null;

  const https = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(remote);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(remote);
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):([^/:]+)\/(.+?)(?:\.git)?$/i.exec(remote);
  const m = https ?? ssh ?? scp;
  if (!m) return null;
  const rawHost = m[1]!.toLowerCase();
  return { host: canonicalGitHost(rawHost), rawHost, owner: m[2]!, name: m[3]! };
}

function parseGitHubRemote(raw: string): GitHubRepo | null {
  const parsed = parseGitRemote(raw);
  if (!parsed || parsed.host !== "github.com") return null;
  return { owner: parsed.owner, name: parsed.name, remoteHost: parsed.rawHost };
}

export function githubRepoFromRemoteForTest(remote: string): string | null {
  const repo = parseGitHubRemote(remote);
  return repo ? `${repo.owner}/${repo.name}` : null;
}

/** Validate a PR review submission. Returns an error string, or null if OK.
 *  GitHub rejects a REQUEST_CHANGES or COMMENT review with no body; only APPROVE
 *  may be submitted empty. Pure so it can be unit-tested without the network. */
function reviewValidationError(event: GitHubPullReviewEvent, body: string, hasComments = false): string | null {
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    return "unsupported review event";
  }
  // APPROVE may be empty; COMMENT/REQUEST_CHANGES need a summary body OR at least
  // one inline comment (the batched "pending review" path supplies the latter).
  if (event !== "APPROVE" && !body.trim() && !hasComments) {
    return event === "COMMENT" ? "a review comment requires a body" : "request changes requires a comment";
  }
  return null;
}

/** Keep only well-formed inline review comments (non-empty path/body, a positive
 *  line, a valid side) and map them to the GitHub reviews API shape. */
function sanitizeReviewComments(comments: ReviewCommentDraft[] | undefined): { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[] {
  if (!Array.isArray(comments)) return [];
  const clean: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[] = [];
  for (const c of comments) {
    const path = typeof c?.path === "string" ? c.path.trim() : "";
    const body = typeof c?.body === "string" ? c.body.trim() : "";
    const side = c?.side === "LEFT" || c?.side === "RIGHT" ? c.side : null;
    if (!path || !body || !side) continue;
    if (!Number.isInteger(c.line) || c.line <= 0) continue;
    clean.push({ path, line: c.line, side, body });
  }
  return clean;
}

/** Extract the first ```suggestion fenced block's body from a review comment's
 *  markdown, or null when there is none. GitHub's suggested-change syntax is a
 *  plain fenced code block whose info string is exactly `suggestion`; anything
 *  before/after the fence (prose) is ignored. The newline immediately before
 *  the closing fence is stripped (both `\n` and a preceding `\r`) so a
 *  suggestion doesn't introduce a spurious blank line when applied. An empty
 *  body (```suggestion\n```) is GitHub's "delete this line" convention and is
 *  returned as `{ suggestion: "" }`. Pure — unit-tested. */
function parseSuggestion(markdownBody: string): { suggestion: string } | null {
  const m = /```suggestion\r?\n([\s\S]*?)```/.exec(markdownBody);
  if (!m) return null;
  let suggestion = m[1] ?? "";
  if (suggestion.endsWith("\n")) suggestion = suggestion.slice(0, -1);
  if (suggestion.endsWith("\r")) suggestion = suggestion.slice(0, -1);
  return { suggestion };
}

/** Resolve the authoritative write position for the apply-suggestion flow from a
 *  `GET /pulls/comments/:id` response, or a clean friendly error. The position
 *  must be authoritative or we refuse to write:
 *   - `side` must be `RIGHT` — a `LEFT` comment's `line` is a BASE-file line
 *     number, which doesn't map to the HEAD file we fetch/splice.
 *   - `line` must be a present positive number — GitHub only leaves it null and
 *     falls back to `original_line` when the comment is OUTDATED (no longer maps
 *     to head), so an `original_line` write position would corrupt head. We do
 *     NOT read `original_line`/`original_start_line`.
 *  `start_line` (multi-line suggestions) is honored when present; a single-line
 *  comment collapses the range to `endLine`. Pure — unit-tested. */
function suggestionCommentRange(raw: unknown):
  | { ok: true; path: string; startLine: number; endLine: number; body: string }
  | { ok: false; error: string } {
  const malformed = { ok: false as const, error: "GitHub returned an unexpected review comment response" };
  if (!raw || typeof raw !== "object") return malformed;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.body !== "string") return malformed;
  // `line` present ⇒ the comment still maps to head. When it's null/absent the
  // comment is outdated (original_line holds the stale position) — refuse.
  if (typeof obj.line !== "number" || obj.line <= 0) {
    return { ok: false, error: "This suggestion is on an outdated diff and can't be applied automatically." };
  }
  // RIGHT = added/context line in the head file (the file we write). LEFT =
  // base-file deletion line, whose number doesn't map to head.
  const side = obj.side === "LEFT" || obj.side === "RIGHT"
    ? obj.side
    : obj.original_side === "LEFT" || obj.original_side === "RIGHT"
      ? obj.original_side
      : null;
  if (side !== "RIGHT") {
    return { ok: false, error: "Suggestions can only be applied to added or unchanged lines." };
  }
  const endLine = obj.line;
  const startLine = typeof obj.start_line === "number" ? obj.start_line : endLine;
  if (startLine <= 0 || startLine > endLine) return malformed;
  return { ok: true, path: obj.path, startLine, endLine, body: obj.body };
}

/** Replace the 1-based inclusive line range [startLine, endLine] in `content`
 *  with the suggestion's lines. Returns null — a guard, never a throw — when
 *  the file doesn't have that many lines (an outdated comment), so the caller
 *  can refuse to PUT rather than risk corrupting the file. Preserves the file's
 *  dominant line ending (CRLF vs LF — inserted lines match retained ones) and
 *  whether it had a trailing newline. An empty suggestion (`""`) deletes the
 *  range (inserts zero lines), matching GitHub's "delete this line" convention.
 *  Pure — unit-tested. */
function spliceSuggestionLines(content: string, startLine: number, endLine: number, suggestion: string): string | null {
  if (startLine < 1 || endLine < startLine) return null;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  const body = hadTrailingNewline ? lines.slice(0, -1) : lines;
  if (endLine > body.length) return null;
  // Empty body = "delete these lines" (insert nothing); otherwise split the
  // suggestion on either EOL so its own line endings don't leak through.
  const suggestionLines = suggestion === "" ? [] : suggestion.split(/\r?\n/);
  const next = [...body.slice(0, startLine - 1), ...suggestionLines, ...body.slice(endLine)];
  return next.join(eol) + (hadTrailingNewline ? eol : "");
}

/** `/repos/:o/:r/contents/:path` — each path segment is URL-encoded but the `/`
 *  separators are preserved (the Contents API treats them as directories). */
function contentsUrl(repo: GitHubRepo, filePath: string): string {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encoded}`;
}

type IssueUpdatePatch = {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
};

/** Assemble the PATCH body for an issue/PR update from a partial input, applying
 *  the same trimming and "at least one field" rule the endpoint enforces. Pure —
 *  the network call in `updateGitHubIssue` consumes `patch` on success. */
function buildIssueUpdatePatch(input: {
  kind?: GitHubItemKind;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}): { ok: true; patch: IssueUpdatePatch } | { ok: false; error: string } {
  const noun = input.kind === "pulls" ? "pull request" : "issue";
  const patch: IssueUpdatePatch = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { ok: false, error: `${noun} title cannot be empty` };
    patch.title = title;
  }
  if (input.body !== undefined) patch.body = input.body;
  if (input.state) patch.state = input.state;
  if (input.labels) patch.labels = input.labels.map((s) => s.trim()).filter(Boolean);
  if (input.assignees) patch.assignees = input.assignees.map((s) => s.trim()).filter(Boolean);
  if (input.milestone !== undefined) patch.milestone = input.milestone;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: `${noun} update requires title, body, state, labels, assignees, or milestone` };
  }
  return { ok: true, patch };
}

// Internal helpers exposed for unit tests only — no other consumers.
export const __githubInternals = {
  canonicalGitHost,
  parseGitRemote,
  matchesFilters,
  normalizeItem,
  normalizeComment,
  normalizeLineComment,
  normalizeCheckRun,
  reviewValidationError,
  buildIssueUpdatePatch,
  normalizeMergeability,
  normalizePullCommit,
  parseLinkedIssues,
  draftFromGraphql,
  graphqlErrorMessage,
  sanitizeReviewComments,
  commentUrl,
  parseReviewThreads,
  reviewThreadsHasNextPage,
  buildSearchQuery,
  normalizeColor,
  normalizeRepoLabel,
  normalizeRepoMilestone,
  normalizeDueOn,
  reactionSubjectPath,
  aggregateReactions,
  parseSuggestion,
  suggestionCommentRange,
  spliceSuggestionLines,
  normalizeSubIssue,
  parseTargetRepo,
  pinnedFromGraphqlMutation,
  pinnedFromGraphqlQuery,
  targetRepoIdFromGraphql,
  transferredIssueFromGraphql,
  subIssuesApiError,
  parseRateLimit,
  normalizeNotification,
  notificationHtmlUrl,
  normalizeRelease,
  normalizeTag,
  normalizeCommitStatus,
  normalizeWorkflowRun,
  normalizeWorkflow,
  parseProjectsV2,
  parseProjectFields,
  parseProjectItems,
  projectsScopeErrorMessage,
  addedProjectItemIdFromGraphql,
  discussionsDisabledErrorMessage,
  parseDiscussions,
  parseDiscussionCategories,
  parseDiscussionDetail,
  createdDiscussionFromGraphql,
  addedDiscussionCommentIdFromGraphql,
  privateRepoHint,
};

export async function repoForDir(dir: string): Promise<GitHubRepo | null> {
  if (!existsSync(dir)) return null;
  const remotes = await run(["git", "remote"], dir);
  if (!remotes.ok) return null;
  const names = remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const ordered = ["origin", ...names.filter((n) => n !== "origin")];
  for (const name of ordered) {
    const url = await run(["git", "remote", "get-url", name], dir);
    if (!url.ok) continue;
    const parsed = parseGitHubRemote(url.stdout);
    if (parsed) return parsed;
  }
  return null;
}

/** Distinct raw GitHub hosts (the ssh-alias identity, or `github.com` for a
 *  plain remote) across the given project dirs, sorted — drives the Settings
 *  "detected hosts" suggestion list so a user's real aliases are one click
 *  away instead of hand-typed. Dirs with no GitHub remote (or that aren't a
 *  repo at all) are tolerated silently, same as `repoForDir`. */
export async function remoteHostsForDirs(dirs: string[]): Promise<string[]> {
  const repos = await Promise.all(dirs.map((dir) => repoForDir(dir)));
  const hosts = new Set<string>();
  for (const repo of repos) {
    if (repo) hosts.add(repo.remoteHost);
  }
  return Array.from(hosts).sort();
}

/** Resolve the token to authenticate a GitHub request with, for a repo whose
 *  raw remote host is `host` (null when there's no repo in scope). Order:
 *  (1) a stored token for `host` (or the `github.com` default entry —
 *  `tokenForHost` implements that fallback), (2) `GITHUB_TOKEN`/`GH_TOKEN`
 *  env, (3) `gh auth token`. `host` is a required parameter (not optional) so
 *  every call site has to thread it through explicitly rather than silently
 *  falling back to the single-identity env/gh behavior this replaces. */
export async function githubToken(host: string | null): Promise<string | null> {
  const stored = tokenForHost(host);
  if (stored) return stored;
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;
  const gh = await run(["gh", "auth", "token"], undefined, 5_000);
  return gh.ok && gh.stdout ? gh.stdout : null;
}

function normalizeLabel(raw: unknown): GitHubLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") return null;
  return {
    name: obj.name,
    color: typeof obj.color === "string" ? obj.color : null,
  };
}

function normalizeUser(raw: unknown): GitHubUser | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.login !== "string") return null;
  return {
    login: obj.login,
    avatarUrl: typeof obj.avatar_url === "string" ? obj.avatar_url : null,
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : null,
  };
}

function normalizeMilestone(raw: unknown): GitHubMilestone | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.title !== "string") return null;
  return {
    number: obj.number,
    title: obj.title,
  };
}

// `sourcePath` defaults to null (rather than being required at every call
// site) so the many existing 2-arg call sites — and __githubInternals tests —
// keep compiling unchanged; every *production* call site below threads its
// own `input.dir` through so a list/action item always carries a usable path
// (G8, multi-repo aggregation: the UI resolves `item.sourcePath ?? projectPath`
// for every per-item action).
function normalizeItem(kind: GitHubItemKind, raw: unknown, sourcePath: string | null = null): GitHubListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.title !== "string") return null;
  if (obj.state !== "open" && obj.state !== "closed") return null;
  if (typeof obj.html_url !== "string") return null;
  const labels = Array.isArray(obj.labels)
    ? obj.labels.map(normalizeLabel).filter((x): x is GitHubLabel => !!x)
    : [];
  const assignees = Array.isArray(obj.assignees)
    ? obj.assignees.map(normalizeUser).filter((x): x is GitHubUser => !!x)
    : [];
  return {
    kind,
    number: obj.number,
    title: obj.title,
    state: obj.state,
    draft: typeof obj.draft === "boolean" ? obj.draft : false,
    htmlUrl: obj.html_url,
    author: normalizeUser(obj.user),
    assignees,
    milestone: normalizeMilestone(obj.milestone),
    body: typeof obj.body === "string" ? obj.body : "",
    labels,
    comments: typeof obj.comments === "number" ? obj.comments : 0,
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
    closedAt: typeof obj.closed_at === "string" ? obj.closed_at : null,
    mergedAt: typeof obj.merged_at === "string" ? obj.merged_at : null,
    locked: typeof obj.locked === "boolean" ? obj.locked : false,
    sourcePath,
  };
}

/** A single entry from `GET /issues/:n/sub_issues` — a full issue object, but
 *  we only keep the fields the sub-issues UI needs. `id` (not `number`) is
 *  what `DELETE /issues/:n/sub_issue` addresses a child by. Pure — unit-tested. */
function normalizeSubIssue(raw: unknown): GitHubSubIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.number !== "number" || typeof obj.title !== "string") return null;
  if (obj.state !== "open" && obj.state !== "closed") return null;
  if (typeof obj.html_url !== "string") return null;
  return {
    id: obj.id,
    number: obj.number,
    title: obj.title,
    state: obj.state,
    htmlUrl: obj.html_url,
  };
}

/** Parse "owner/name" into parts for the transfer-issue target repo input.
 *  Rejects empty/malformed/multi-segment input. Pure — unit-tested. */
function parseTargetRepo(raw: string): { owner: string; name: string } | null {
  const trimmed = raw.trim();
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!m) return null;
  return { owner: m[1]!, name: m[2]! };
}

function matchesFilters(item: GitHubListItem, query: string, labels: string[], assignee: string): boolean {
  const q = query.trim().toLowerCase();
  if (q) {
    const hay = [
      item.title,
      item.body,
      String(item.number),
      item.author?.login ?? "",
      item.assignees.map((a) => a.login).join(" "),
      item.milestone?.title ?? "",
      item.labels.map((l) => l.name).join(" "),
    ].join("\n").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (labels.length > 0) {
    const have = new Set(item.labels.map((l) => l.name.toLowerCase()));
    if (!labels.every((label) => have.has(label.toLowerCase()))) return false;
  }
  const assigneeFilter = assignee.trim().toLowerCase();
  if (assigneeFilter) {
    const have = new Set(item.assignees.map((a) => a.login.toLowerCase()));
    if (!have.has(assigneeFilter)) return false;
  }
  return true;
}

function pageLinks(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"') {
      const m = /^<(.+)>$/.exec(urlPart ?? "");
      return m?.[1] ?? null;
    }
  }
  return null;
}

/** Parse GitHub's `x-ratelimit-*` response headers into a `GitHubRateLimit`,
 *  or null when any of the three are absent (a mocked/error response, or a
 *  non-GitHub-API response). `remaining`/`limit` are validated as finite
 *  numbers so a malformed header value degrades to null rather than NaN
 *  leaking into the UI. Pure — unit-tested. */
function parseRateLimit(headers: Headers): GitHubRateLimit | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const resource = headers.get("x-ratelimit-resource");
  if (remaining === null || limit === null || resource === null) return null;
  const remainingNum = Number(remaining);
  const limitNum = Number(limit);
  if (!Number.isFinite(remainingNum) || !Number.isFinite(limitNum)) return null;
  return { remaining: remainingNum, limit: limitNum, resource };
}

function fetchErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return "GitHub request timed out";
  }
  return e instanceof Error ? e.message : String(e);
}

async function fetchGitHub(
  url: string,
  token: string | null,
  accept: string,
  init?: { method?: string; body?: string },
): Promise<Response | GitHubListError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: init?.method,
      signal: controller.signal,
      headers: {
        accept,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        "user-agent": "agetor",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: init?.body,
    });
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeComment(raw: unknown): GitHubComment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.html_url !== "string") return null;
  return {
    id: obj.id,
    body: typeof obj.body === "string" ? obj.body : "",
    htmlUrl: obj.html_url,
    author: normalizeUser(obj.user),
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
  };
}

function normalizeLineComment(raw: unknown): GitHubPullLineComment | null {
  const comment = normalizeComment(raw);
  if (!comment || !raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string") return null;
  const line = typeof obj.line === "number"
    ? obj.line
    : typeof obj.original_line === "number"
      ? obj.original_line
      : null;
  const side = obj.side === "LEFT" || obj.side === "RIGHT" ? obj.side : null;
  if (!line || !side) return null;
  return {
    ...comment,
    path: obj.path,
    line,
    side,
  };
}

function normalizeCheckRun(raw: unknown): GitHubCheckRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.name !== "string") return null;
  return {
    id: obj.id,
    name: obj.name,
    status: typeof obj.status === "string" ? obj.status : "unknown",
    conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : null,
    startedAt: typeof obj.started_at === "string" ? obj.started_at : null,
    completedAt: typeof obj.completed_at === "string" ? obj.completed_at : null,
  };
}

/** A single `GET /pulls/:n/commits` entry. `messageHeadline` is the commit
 *  message's first line; `author` prefers the top-level GitHub-user `author`
 *  (present when the committer's email is linked to a GitHub account) over
 *  the raw git `commit.author`, falling back to null. Pure — unit-tested. */
function normalizePullCommit(raw: unknown): GitHubPullCommit | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sha !== "string" || !obj.sha) return null;
  const commit = obj.commit && typeof obj.commit === "object" ? obj.commit as Record<string, unknown> : null;
  if (!commit || typeof commit.message !== "string") return null;
  const commitAuthor = commit.author && typeof commit.author === "object"
    ? commit.author as Record<string, unknown>
    : {};
  return {
    sha: obj.sha,
    messageHeadline: commit.message.split("\n")[0] ?? "",
    author: normalizeUser(obj.author),
    authoredDate: typeof commitAuthor.date === "string" ? commitAuthor.date : "",
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
  };
}

/** Dig `data.repository.pullRequest.closingIssuesReferences.nodes` out of a
 *  GraphQL response, defensively — `[]` on any unexpected shape. Pure —
 *  unit-tested. */
function parseLinkedIssues(json: unknown): GitHubLinkedIssue[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return [];
  const pr = (repository as { pullRequest?: unknown }).pullRequest;
  if (!pr || typeof pr !== "object") return [];
  const closing = (pr as { closingIssuesReferences?: unknown }).closingIssuesReferences;
  if (!closing || typeof closing !== "object") return [];
  const nodes = (closing as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const issues: GitHubLinkedIssue[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (typeof obj.number !== "number" || typeof obj.title !== "string" || typeof obj.url !== "string") continue;
    issues.push({
      number: obj.number,
      title: obj.title,
      url: obj.url,
      state: obj.state === "CLOSED" ? "CLOSED" : "OPEN",
    });
  }
  return issues;
}

/** A single `GET /repos/:o/:r/releases` entry (F18). Requires `id` + `tag_name`
 *  — the two fields every action (edit/delete) and the UI's row key need.
 *  Pure — unit-tested. */
function normalizeRelease(raw: unknown): GitHubRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.tag_name !== "string") return null;
  return {
    id: obj.id,
    tagName: obj.tag_name,
    name: typeof obj.name === "string" ? obj.name : "",
    body: typeof obj.body === "string" ? obj.body : "",
    draft: typeof obj.draft === "boolean" ? obj.draft : false,
    prerelease: typeof obj.prerelease === "boolean" ? obj.prerelease : false,
    publishedAt: typeof obj.published_at === "string" ? obj.published_at : null,
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
    targetCommitish: typeof obj.target_commitish === "string" ? obj.target_commitish : "",
  };
}

/** A single `GET /repos/:o/:r/tags` entry — `{ name, commit: { sha } }`.
 *  Requires both a non-empty name and a resolvable commit sha. Pure —
 *  unit-tested. */
function normalizeTag(raw: unknown): GitHubTag | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name) return null;
  const commit = obj.commit && typeof obj.commit === "object" ? obj.commit as Record<string, unknown> : null;
  const sha = commit && typeof commit.sha === "string" ? commit.sha : "";
  if (!sha) return null;
  return { name: obj.name, commitSha: sha };
}

/** A single context entry within a combined status's `statuses` array.
 *  Requires `context` (the CI provider's identifier string) — everything
 *  else defaults defensively. Pure, but only reachable through
 *  `normalizeCommitStatus` below (not independently unit-tested). */
function normalizeCommitStatusContext(raw: unknown): GitHubCommitStatusContext | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.context !== "string") return null;
  return {
    context: obj.context,
    state: typeof obj.state === "string" ? obj.state : "",
    description: typeof obj.description === "string" ? obj.description : null,
    targetUrl: typeof obj.target_url === "string" ? obj.target_url : null,
  };
}

/** `GET /repos/:o/:r/commits/:ref/status` (F19, the legacy combined-status
 *  API — distinct from the check-runs `normalizeCheckRun` above). An
 *  unrecognized top-level `state` degrades to `""` rather than rejecting the
 *  whole payload; malformed entries in `statuses` are dropped individually.
 *  Pure — unit-tested. */
function normalizeCommitStatus(raw: unknown): GitHubCommitStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const state = obj.state === "success" || obj.state === "pending" || obj.state === "failure" || obj.state === "error"
    ? obj.state
    : "";
  const rawStatuses = Array.isArray(obj.statuses) ? obj.statuses : [];
  const statuses = rawStatuses.map(normalizeCommitStatusContext).filter((x): x is GitHubCommitStatusContext => !!x);
  const total = typeof obj.total_count === "number" ? obj.total_count : statuses.length;
  return { state, total, statuses };
}

/** A single `GET /repos/:o/:r/actions/runs` entry (F20). Requires `id` — the
 *  field every per-row action (re-run/cancel) and the row key need. `name`
 *  falls back to `display_title` when the workflow itself has no name (rare,
 *  but the raw response can omit it); `displayTitle` always prefers GitHub's
 *  own generated title (commit message headline by default). Pure —
 *  unit-tested. */
function normalizeWorkflowRun(raw: unknown): GitHubWorkflowRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  const displayTitle = typeof obj.display_title === "string" ? obj.display_title : "";
  return {
    id: obj.id,
    name: typeof obj.name === "string" ? obj.name : displayTitle,
    displayTitle,
    status: typeof obj.status === "string" ? obj.status : "unknown",
    conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
    event: typeof obj.event === "string" ? obj.event : "",
    headBranch: typeof obj.head_branch === "string" ? obj.head_branch : "",
    runNumber: typeof obj.run_number === "number" ? obj.run_number : 0,
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    workflowId: typeof obj.workflow_id === "number" ? obj.workflow_id : 0,
  };
}

/** A single `GET /repos/:o/:r/actions/workflows` entry (F20) — powers the
 *  "run a workflow" dispatch picker. Requires `id`, `path`, and `name`.
 *  Pure — unit-tested. */
function normalizeWorkflow(raw: unknown): GitHubWorkflow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.path !== "string" || typeof obj.name !== "string") return null;
  return {
    id: obj.id,
    name: obj.name,
    path: obj.path,
    state: typeof obj.state === "string" ? obj.state : "",
  };
}

function repoSlug(repo: GitHubRepo): string {
  return `${repo.owner}/${repo.name}`;
}

async function currentBranch(dir: string): Promise<string> {
  const result = await run(["git", "branch", "--show-current"], dir, 5_000);
  return result.ok ? result.stdout.trim() : "";
}

async function defaultBaseBranch(dir: string): Promise<string> {
  const result = await run(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], dir, 5_000);
  if (result.ok && result.stdout.trim()) {
    const raw = result.stdout.trim();
    return raw.startsWith("origin/") ? raw.slice("origin/".length) : raw;
  }
  return "main";
}

function apiError(body: unknown, status: number, statusText: string): string {
  return body && typeof body === "object" && "message" in body
    ? String((body as { message: unknown }).message)
    : `${status} ${statusText}`;
}

/** Enriches a plain 404 with an actionable pointer to Settings. GitHub answers
 *  404 — not 403 — for a private repo the caller can't see, so an unadorned
 *  passthrough of `message` reads as "this repo doesn't exist" even when it's
 *  just an auth gap. Any other status is returned unchanged. Pure — the
 *  `hadToken` flag (was a request even attempted with a token?) picks between
 *  "add a token" and "the token you have doesn't work here". */
function privateRepoHint(status: number, message: string, repo: GitHubRepo, hadToken: boolean): string {
  if (status !== 404) return message;
  const host = repo.remoteHost || "github.com";
  const base = `${repo.owner}/${repo.name} was not found on GitHub — if the repo is private, add a token for ${host} in Settings → GitHub tokens`;
  return hadToken
    ? `${base} (the configured token cannot access it — check it belongs to the right account)`
    : base;
}

async function pullHeadSha(repo: GitHubRepo, token: string | null, number: number): Promise<string | GitHubListError> {
  const prUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${number}`;
  const prRes = await fetchGitHub(prUrl, token, "application/vnd.github+json");
  if (!("status" in prRes)) return prRes;
  const pr = await prRes.json().catch(() => null);
  if (!prRes.ok) return { ok: false, error: apiError(pr, prRes.status, prRes.statusText) };
  const sha = pr && typeof pr === "object"
    && "head" in pr
    && pr.head
    && typeof pr.head === "object"
    && "sha" in pr.head
    && typeof pr.head.sha === "string"
    ? pr.head.sha
    : null;
  return sha ?? { ok: false, error: "GitHub returned a pull request without a head sha" };
}

/** Build the `q` for the Search API from the "involvement" filters (and labels /
 *  assignee / state, which search can also express). Pure — unit-tested. */
function buildSearchQuery(slug: string, input: ListGitHubItemsInput): string {
  const parts: string[] = [`repo:${slug}`, `is:${input.kind === "pulls" ? "pr" : "issue"}`];
  if (input.state === "open" || input.state === "closed") parts.push(`is:${input.state}`);
  for (const l of input.labels?.map((s) => s.trim()).filter(Boolean) ?? []) parts.push(`label:${JSON.stringify(l)}`);
  if (input.createdByMe) parts.push("author:@me");
  const assignee = input.assignee?.trim();
  if (input.assignedToMe) parts.push("assignee:@me");
  else if (assignee) parts.push(`assignee:${assignee}`);
  if (input.reviewRequested && input.kind === "pulls") parts.push("review-requested:@me");
  // Raw user-typed qualifiers ride along, but strip any `repo:` they typed so the
  // prepended project scope stays authoritative (a second `repo:` ORs in another
  // repo, whose numbers/urls the single-repo UI can't render coherently).
  const raw = (input.searchQuery ?? "").replace(/(?:^|\s)repo:\S+/gi, " ").replace(/\s+/g, " ").trim();
  if (raw) parts.push(raw);
  return parts.join(" ");
}

/** GitHub's Search API never returns more than 1000 results total, regardless
 *  of `total_count` — page*per_page hitting this ceiling means "no more",
 *  even if `total_count` says otherwise. */
const SEARCH_RESULT_CEILING = 1000;

export async function listGitHubItems(input: ListGitHubItemsInput): Promise<GitHubListResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const slug = repoSlug(repo);
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const assignee = input.assignee?.trim() ?? "";
  // @me / review-requested / raw qualifiers need the Search API — the list
  // endpoints can't filter a PR by author or reviewer. Requires auth.
  const useSearch = !!(input.createdByMe || input.assignedToMe || input.reviewRequested || input.searchQuery?.trim());
  if (useSearch && !token) {
    return { ok: false, error: "GitHub authentication required for search / involvement filters" };
  }

  const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1;
  // One page of 100 keeps the tighter Search rate limit (~30/min) from being
  // hit as hard as the higher-volume REST list endpoints.
  const perPage = useSearch ? 100 : 50;

  // What still has to be filtered client-side after the request comes back. In
  // search mode the qualifiers already scoped labels/assignee/state server-side,
  // so nothing is refined here. On the REST path, `labels`/`assignee` are only
  // server-side for `kind:"issues"` — for pulls they're client-side — and the
  // free-text `query` is ALWAYS client-side (matchesFilters).
  const clientLabels = useSearch ? [] : (input.kind === "pulls" ? labels : []);
  const clientAssignee = useSearch ? "" : (input.kind === "pulls" ? assignee : "");
  const clientQuery = (input.query ?? "").trim();
  const clientFiltering = !useSearch && (clientLabels.length > 0 || clientAssignee !== "" || clientQuery !== "");

  // TWO FETCH MODES:
  //  1. No client-side filtering (the Search API path always; the REST path
  //     with no label/assignee/text filter) → fetch exactly ONE source page
  //     that maps 1:1 to the UI `page`. `hasMore` comes straight from the
  //     source (link header / total_count), and "Load more" advances one page.
  //  2. Client-side filtering active (REST path only) → the raw source page is
  //     refined by matchesFilters, so a single page can yield zero matches even
  //     when hits live on later source pages. Fetch up to 3 source pages per UI
  //     "page" and accumulate the post-filter matches (restoring the pre-
  //     single-page recall). "Load more" then advances by 3-source-page blocks;
  //     `hasMore` reflects whether the last source page fetched still had a
  //     `next` link.
  const sourcePagesPerBlock = clientFiltering ? 3 : 1;
  const firstSourcePage = (page - 1) * sourcePagesPerBlock + 1;

  const buildPageUrl = (sourcePage: number): string => {
    let url: URL;
    if (useSearch) {
      url = new URL("https://api.github.com/search/issues");
      url.searchParams.set("q", buildSearchQuery(slug, input));
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(sourcePage));
      // No `sort` → GitHub ranks by best-match relevance; `order` is meaningless
      // (and ignored) without a sort, so omit it too rather than send a stray param.
      if (input.sort) {
        url.searchParams.set("sort", input.sort);
        // The Search API calls direction "order"; REST calls it "direction".
        if (input.direction) url.searchParams.set("order", input.direction);
      }
    } else {
      const endpoint = input.kind === "pulls" ? "pulls" : "issues";
      url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/${endpoint}`);
      url.searchParams.set("state", input.state);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(sourcePage));
      if (input.sort) url.searchParams.set("sort", input.sort);
      if (input.direction) url.searchParams.set("direction", input.direction);
      if (input.kind === "issues" && labels.length > 0) url.searchParams.set("labels", labels.join(","));
      if (input.kind === "issues" && assignee) url.searchParams.set("assignee", assignee);
    }
    return url.toString();
  };

  const items: GitHubListItem[] = [];
  let hasMore = false;
  let lastRes: Response | null = null;
  for (let i = 0; i < sourcePagesPerBlock; i++) {
    const sourcePage = firstSourcePage + i;
    const res = await fetchGitHub(buildPageUrl(sourcePage), token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    lastRes = res;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      let msg = body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `${res.status} ${res.statusText}`;
      // The Search API is rate-limited far tighter than the core API (~30/min).
      if (useSearch && res.status === 403 && /rate limit/i.test(msg)) {
        msg = "GitHub search is rate-limited (~30 requests/minute) — wait a moment and try again.";
      } else if (useSearch && res.status === 422) {
        // GitHub's own "Validation Failed" is opaque — the query syntax is the fault.
        msg = "Invalid GitHub search query — check your qualifiers (e.g. is:open label:bug sort:updated).";
      }
      return { ok: false, error: privateRepoHint(res.status, msg, repo, !!token) };
    }
    // The list endpoints return a bare array; search wraps items in `.items`.
    const raws = useSearch
      ? (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : null)
      : (Array.isArray(body) ? body : null);
    if (!raws) return { ok: false, error: "GitHub returned an unexpected response" };
    for (const raw of raws) {
      if (!useSearch && input.kind === "issues" && raw && typeof raw === "object" && "pull_request" in raw) continue;
      const item = normalizeItem(input.kind, raw, input.dir);
      if (item && matchesFilters(item, input.query ?? "", clientLabels, clientAssignee)) {
        items.push(item);
      }
    }

    if (useSearch) {
      // The Search API path is always single-page — derive hasMore from
      // total_count (capped at GitHub's 1000-result search ceiling).
      const totalCount = body && typeof body === "object" && typeof (body as { total_count?: unknown }).total_count === "number"
        ? (body as { total_count: number }).total_count
        : raws.length;
      const seenThroughThisPage = page * perPage;
      hasMore = seenThroughThisPage < totalCount && seenThroughThisPage < SEARCH_RESULT_CEILING;
      break;
    }
    // REST: hasMore tracks whether the LAST source page we fetched still points
    // at a next page. Stop early once the source is exhausted.
    const nextLink = pageLinks(res.headers.get("link"));
    hasMore = nextLink != null;
    if (!nextLink) break;
  }

  return {
    ok: true,
    repo: slug,
    webUrl: `https://github.com/${slug}`,
    auth: token ? "token" : "none",
    items,
    page,
    hasMore,
    rateLimit: lastRes ? parseRateLimit(lastRes.headers) : null,
  };
}

interface ListGitHubItemsAcrossReposInput {
  dirs: string[];
  kind: GitHubItemKind;
  state: GitHubItemState;
  query?: string;
  labels?: string[];
  assignee?: string;
  createdByMe?: boolean;
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  searchQuery?: string;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
}

/** Merges items across several repos into one `GitHubListResult`-shaped list
 *  (G8, multi-repo aggregation / F15). For each `dir`, reuses the single-repo
 *  `listGitHubItems` — same filters, always page 1 — and tags every returned
 *  item with `sourcePath = dir` so the UI's per-item actions resolve
 *  `item.sourcePath ?? projectPath` and land on the correct repo even though
 *  the list itself is merged.
 *
 *  A dir without a GitHub remote (or that fails for any other reason —
 *  unauthenticated search, rate limit, …) is skipped silently rather than
 *  failing the whole aggregate: a handful of registered projects commonly
 *  includes ones with no GitHub remote at all, and one flaky repo shouldn't
 *  blank the rest. Only errors if EVERY dir failed.
 *
 *  Each repo contributes at most one page (its own `hasMore`, if true, sets
 *  the aggregate result's `hasMore` — signaling "this merged list is
 *  truncated" rather than "there's a page 2 to fetch"; the UI disables
 *  "Load more" in aggregate mode rather than trying to page per-repo). */
export async function listGitHubItemsAcrossRepos(input: ListGitHubItemsAcrossReposInput): Promise<GitHubListResponse> {
  const dirs = Array.from(new Set(input.dirs.filter((d) => d.trim())));
  if (dirs.length === 0) return { ok: false, error: "no projects to aggregate" };

  const fetchOne = (dir: string) => listGitHubItems({
    dir,
    kind: input.kind,
    state: input.state,
    query: input.query,
    labels: input.labels,
    assignee: input.assignee,
    createdByMe: input.createdByMe,
    assignedToMe: input.assignedToMe,
    reviewRequested: input.reviewRequested,
    searchQuery: input.searchQuery,
    sort: input.sort,
    direction: input.direction,
    page: 1,
  });

  // Bounded concurrency: each per-repo fetch spawns several `git`/`gh`
  // sub-processes plus a GitHub HTTP call, so an unbounded `Promise.all` over
  // every registered project can trip secondary rate limits (worse against the
  // ~30/min Search API). A small pool keeps the burst in check while still
  // overlapping the network latency. Results are collected by index so the
  // per-repo order is preserved (the final sort re-orders anyway).
  const CONCURRENCY = 5;
  const perRepo: { dir: string; res: GitHubListResponse }[] = new Array(dirs.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= dirs.length) return;
      const dir = dirs[i]!;
      perRepo[i] = { dir, res: await fetchOne(dir) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker));

  const repos: string[] = [];
  const items: GitHubListItem[] = [];
  let truncated = false;
  let auth: "token" | "none" = "none";
  let rateLimit: GitHubRateLimit | null = null;

  for (const { dir, res } of perRepo) {
    if (!res.ok) continue; // no remote, unauthenticated search, etc. — skip silently
    repos.push(res.repo);
    for (const item of res.items) items.push({ ...item, sourcePath: dir });
    if (res.hasMore) truncated = true;
    if (res.auth === "token") auth = "token";
    if (res.rateLimit && (!rateLimit || res.rateLimit.remaining < rateLimit.remaining)) rateLimit = res.rateLimit;
  }

  if (repos.length === 0) {
    return { ok: false, error: "none of the selected projects have a usable GitHub remote" };
  }

  // Default sort mirrors the UI's "best-match" fallback for a single repo
  // (created-desc); merging across repos has no relevance signal at all, so
  // "updated desc" is the more useful cross-repo default.
  const sortField = input.sort ?? "updated";
  const direction = input.direction ?? "desc";
  const sortValue = (item: GitHubListItem): number => {
    if (sortField === "comments") return item.comments;
    const raw = sortField === "created" ? item.createdAt : item.updatedAt;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  };
  items.sort((a, b) => {
    const diff = sortValue(a) - sortValue(b);
    return direction === "asc" ? diff : -diff;
  });

  return {
    ok: true,
    repo: `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
    repos,
    webUrl: null,
    auth,
    items,
    page: 1,
    hasMore: truncated,
    rateLimit,
  };
}

export async function getGitHubPullDefaults(input: { dir: string }): Promise<GitHubPullDefaultsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  return {
    ok: true,
    repo: repoSlug(repo),
    head: await currentBranch(input.dir),
    base: await defaultBaseBranch(input.dir),
  };
}

export async function createGitHubPull(input: CreateGitHubPullInput): Promise<GitHubIssueResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const title = input.title.trim();
  const head = input.head.trim();
  const base = input.base.trim();
  if (!title) return { ok: false, error: "pull request title required" };
  if (!head) return { ok: false, error: "head branch required" };
  if (!base) return { ok: false, error: "base branch required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create a pull request" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        head,
        base,
        draft: input.draft === true,
        ...(input.body?.trim() ? { body: input.body.trim() } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("pulls", json, input.dir);
  if (!item) return { ok: false, error: "GitHub returned an unexpected pull request response" };

  const reviewers = input.reviewers?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (reviewers.length === 0) {
    return { ok: true, item, message: "Pull request created." };
  }

  const reviewerUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${item.number}/requested_reviewers`;
  const reviewerRes = await fetchGitHub(
    reviewerUrl,
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ reviewers }) },
  );
  if (!("status" in reviewerRes)) {
    return { ok: true, item, message: `Pull request created, but reviewers were not requested: ${reviewerRes.error}` };
  }
  const reviewerJson = await reviewerRes.json().catch(() => null);
  if (!reviewerRes.ok) {
    return {
      ok: true,
      item,
      message: `Pull request created, but reviewers were not requested: ${apiError(reviewerJson, reviewerRes.status, reviewerRes.statusText)}`,
    };
  }
  return { ok: true, item, message: "Pull request created and reviewers requested." };
}

export async function getGitHubPullDiff(input: GetGitHubPullDiffInput): Promise<GitHubDiffResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const res = await fetchGitHub(url, token, "application/vnd.github.v3.diff");
  if (!("status" in res)) return res;
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > GITHUB_DIFF_BODY_CAP_BYTES) {
    return {
      ok: false,
      error: `Pull request diff is too large to display in Agetor (${Math.ceil(contentLength / 1_000_000)} MB).`,
    };
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string") msg = parsed.message;
    } catch { /* diff endpoints return plain text on success */ }
    return { ok: false, error: msg || `${res.status} ${res.statusText}` };
  }
  // Byte-accurate fallback for when the server omitted content-length above.
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > GITHUB_DIFF_BODY_CAP_BYTES) {
    return {
      ok: false,
      error: `Pull request diff is too large to display in Agetor (${Math.ceil(bodyBytes / 1_000_000)} MB).`,
    };
  }
  const files = parseGitDiff(body);
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_DIFF_FILES) {
    const total = files.length;
    return {
      ok: true,
      base: null,
      files: files.slice(0, MAX_DIFF_FILES),
      note: `Showing the first ${MAX_DIFF_FILES} of ${total} changed files — the rest are omitted to keep the viewer responsive.`,
    };
  }
  return {
    ok: true,
    base: null,
    files,
    note: files.length === 0 ? "No diff returned for this pull request." : undefined,
  };
}

export async function listGitHubComments(input: GitHubItemNumberInput): Promise<GitHubCommentsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "item number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/comments`);
  url.searchParams.set("per_page", "100");
  const res = await fetchGitHub(url.toString(), token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `${res.status} ${res.statusText}`;
    return { ok: false, error: msg };
  }
  if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected comments response" };
  return {
    ok: true,
    repo: repoSlug(repo),
    itemNumber: input.number,
    comments: body.map(normalizeComment).filter((x): x is GitHubComment => !!x),
  };
}

export async function createGitHubComment(input: CreateGitHubCommentInput): Promise<GitHubCommentResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "item number must be positive" };
  }
  const body = input.body.trim();
  if (!body) return { ok: false, error: "comment body required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to comment" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/comments`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ body }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json && typeof json === "object" && "message" in json
      ? String((json as { message: unknown }).message)
      : `${res.status} ${res.statusText}`;
    return { ok: false, error: msg };
  }
  const comment = normalizeComment(json);
  if (!comment) return { ok: false, error: "GitHub returned an unexpected comment response" };
  return { ok: true, comment };
}

export async function createGitHubPullLineComment(
  input: CreateGitHubPullLineCommentInput,
): Promise<GitHubPullLineCommentResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  const body = input.body.trim();
  const filePath = input.path.trim();
  if (!body) return { ok: false, error: "comment body required" };
  if (!filePath) return { ok: false, error: "comment path required" };
  if (!Number.isInteger(input.line) || input.line <= 0) {
    return { ok: false, error: "comment line must be positive" };
  }
  if (input.side !== "LEFT" && input.side !== "RIGHT") {
    return { ok: false, error: "comment side must be LEFT or RIGHT" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to comment on a line" };
  const sha = await pullHeadSha(repo, token, input.number);
  if (typeof sha !== "string") return sha;

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/comments`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        body,
        commit_id: sha,
        path: filePath,
        line: input.line,
        side: input.side,
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const comment = normalizeLineComment(json);
  if (!comment) return { ok: false, error: "GitHub returned an unexpected line comment response" };
  return { ok: true, comment };
}

export async function listGitHubPullReviewComments(
  input: GitHubItemNumberInput,
): Promise<GitHubPullReviewCommentsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/comments`);
  url.searchParams.set("per_page", "100");
  const res = await fetchGitHub(url.toString(), token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  if (!Array.isArray(json)) return { ok: false, error: "GitHub returned an unexpected review comments response" };
  return {
    ok: true,
    repo: repoSlug(repo),
    pullNumber: input.number,
    comments: json.map(normalizeLineComment).filter((x): x is GitHubPullLineComment => !!x),
  };
}

export async function replyGitHubPullLineComment(
  input: ReplyGitHubPullLineCommentInput,
): Promise<GitHubPullLineCommentResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  if (!Number.isInteger(input.commentId) || input.commentId <= 0) {
    return { ok: false, error: "review comment id must be positive" };
  }
  const body = input.body.trim();
  if (!body) return { ok: false, error: "reply body required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to reply" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/comments/${input.commentId}/replies`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ body }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const comment = normalizeLineComment(json);
  if (!comment) return { ok: false, error: "GitHub returned an unexpected reply response" };
  return { ok: true, comment };
}

/** Best-effort "apply this suggested change" for a review comment's ```suggestion
 *  fence. GitHub has no REST endpoint that applies a suggestion atomically, so
 *  this stitches one together from the Contents API: fetch the comment (path +
 *  commented line range + body), fetch the PR (head branch, and reject a
 *  cross-fork head — the Contents API write only makes sense against a branch in
 *  *this* repo), fetch the file at the head branch, splice the commented lines
 *  for the suggestion text, and PUT it back. Every failure path returns a clean
 *  `{ok:false,error}` — the PUT only fires once the splice matches cleanly, so a
 *  stale/outdated comment can't corrupt the file. Token required (both the read
 *  and the write need it; unauthenticated is rejected up front like the other
 *  mutating endpoints). */
export async function applyGitHubSuggestion(input: ApplyGitHubSuggestionInput): Promise<GitHubApplySuggestionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  if (!Number.isInteger(input.commentId) || input.commentId <= 0) {
    return { ok: false, error: "review comment id must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to apply a suggestion" };

  const reviewCommentUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/comments/${input.commentId}`;
  const commentRes = await fetchGitHub(reviewCommentUrl, token, "application/vnd.github+json");
  if (!("status" in commentRes)) return commentRes;
  const commentJson = await commentRes.json().catch(() => null);
  if (!commentRes.ok) return { ok: false, error: apiError(commentJson, commentRes.status, commentRes.statusText) };
  // Cross-check the comment actually belongs to the PR whose number we were
  // given — otherwise a stray/mismatched id could drive a write against the
  // wrong PR's head branch. `pull_request_url` looks like `.../pulls/9`.
  const prUrlOfComment = commentJson && typeof commentJson === "object"
    && typeof (commentJson as { pull_request_url?: unknown }).pull_request_url === "string"
    ? (commentJson as { pull_request_url: string }).pull_request_url
    : null;
  if (prUrlOfComment && !new RegExp(`/pulls/${input.number}$`).test(prUrlOfComment)) {
    return { ok: false, error: "This review comment doesn't belong to that pull request." };
  }
  const range = suggestionCommentRange(commentJson);
  if (!range.ok) return range;
  const parsed = parseSuggestion(range.body);
  if (!parsed) return { ok: false, error: "This comment doesn't contain a suggested change." };

  const prUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const prRes = await fetchGitHub(prUrl, token, "application/vnd.github+json");
  if (!("status" in prRes)) return prRes;
  const prJson = await prRes.json().catch(() => null);
  if (!prRes.ok) return { ok: false, error: apiError(prJson, prRes.status, prRes.statusText) };
  const pr = prJson && typeof prJson === "object" ? (prJson as Record<string, unknown>) : {};
  const head = pr.head && typeof pr.head === "object" ? pr.head as Record<string, unknown> : {};
  const headRef = typeof head.ref === "string" ? head.ref : null;
  const headRepo = head.repo && typeof head.repo === "object" ? head.repo as Record<string, unknown> : null;
  const headRepoFullName = headRepo && typeof headRepo.full_name === "string" ? headRepo.full_name : null;
  if (!headRef || !headRepoFullName) {
    return { ok: false, error: "GitHub returned a pull request without head branch info" };
  }
  if (headRepoFullName.toLowerCase() !== repoSlug(repo).toLowerCase()) {
    return { ok: false, error: "Applying suggestions isn't supported for pull requests from a fork." };
  }

  const fileUrl = `${contentsUrl(repo, range.path)}?ref=${encodeURIComponent(headRef)}`;
  const fileRes = await fetchGitHub(fileUrl, token, "application/vnd.github+json");
  if (!("status" in fileRes)) return fileRes;
  const fileJson = await fileRes.json().catch(() => null);
  if (!fileRes.ok) return { ok: false, error: apiError(fileJson, fileRes.status, fileRes.statusText) };
  const file = fileJson && typeof fileJson === "object" ? (fileJson as Record<string, unknown>) : {};
  const encodedContent = typeof file.content === "string" ? file.content : null;
  const fileSha = typeof file.sha === "string" ? file.sha : null;
  // The Contents API only inlines base64 for files under ~1MB; larger files come
  // back with `encoding: "none"` and empty content (they need the blob API).
  if (typeof file.encoding === "string" && file.encoding !== "base64") {
    return { ok: false, error: "This file is too large to apply a suggestion via the Contents API." };
  }
  if (!encodedContent || !fileSha) {
    return { ok: false, error: "GitHub returned an unexpected file contents response" };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encodedContent, "base64").toString("utf8");
  } catch {
    return { ok: false, error: "GitHub returned file contents Agetor couldn't decode" };
  }
  const spliced = spliceSuggestionLines(decoded, range.startLine, range.endLine, parsed.suggestion);
  if (spliced === null) {
    return { ok: false, error: "This suggestion is outdated — the file no longer matches the commented lines." };
  }

  const putRes = await fetchGitHub(
    contentsUrl(repo, range.path),
    token,
    "application/vnd.github+json",
    {
      method: "PUT",
      body: JSON.stringify({
        message: "Apply suggestion from review comment",
        content: Buffer.from(spliced, "utf8").toString("base64"),
        sha: fileSha,
        branch: headRef,
      }),
    },
  );
  if (!("status" in putRes)) return putRes;
  const putJson = await putRes.json().catch(() => null);
  if (!putRes.ok) return { ok: false, error: apiError(putJson, putRes.status, putRes.statusText) };
  return { ok: true, message: "Suggestion applied." };
}

export async function getGitHubPullChecks(input: GitHubItemNumberInput): Promise<GitHubChecksResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const sha = await pullHeadSha(repo, token, input.number);
  if (typeof sha !== "string") return sha;

  const checksUrl = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs`);
  checksUrl.searchParams.set("per_page", "100");
  const checksRes = await fetchGitHub(checksUrl.toString(), token, "application/vnd.github+json");
  if (!("status" in checksRes)) return checksRes;
  const checks = await checksRes.json().catch(() => null);
  if (!checksRes.ok) {
    const msg = checks && typeof checks === "object" && "message" in checks
      ? String((checks as { message: unknown }).message)
      : `${checksRes.status} ${checksRes.statusText}`;
    return { ok: false, error: msg };
  }
  const rawRuns = checks && typeof checks === "object" && Array.isArray((checks as { check_runs?: unknown }).check_runs)
    ? (checks as { check_runs: unknown[] }).check_runs
    : [];
  return {
    ok: true,
    repo: repoSlug(repo),
    pullNumber: input.number,
    sha,
    checkRuns: rawRuns.map(normalizeCheckRun).filter((x): x is GitHubCheckRun => !!x),
  };
}

/** `GET /repos/:o/:r/commits/:ref/status` (F19) — the combined status from
 *  GitHub's legacy Status API, shown next to the check-runs above (some CI
 *  providers still only post through this older API). Unlike
 *  `getGitHubPullChecks`, `ref` is caller-supplied (typically a PR head sha
 *  already resolved by the UI) rather than resolved from a PR number here. */
export async function getGitHubCommitStatus(input: GetGitHubCommitStatusInput): Promise<GitHubCommitStatusResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const ref = input.ref.trim();
  if (!ref) return { ok: false, error: "commit ref required" };

  const token = await githubToken(repo.remoteHost ?? null);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}/status`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const status = normalizeCommitStatus(json);
  if (!status) return { ok: false, error: "GitHub returned an unexpected commit status response" };
  return { ok: true, repo: repoSlug(repo), ref, ...status };
}

/** The PR's commits, oldest first — same pagination shape as `listGitHubLabels`
 *  (3-page cap, follow the `link: rel="next"` header). */
export async function listGitHubPullCommits(input: GitHubItemNumberInput): Promise<GitHubPullCommitsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const commits: GitHubPullCommit[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/commits?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected commits response" };
    for (const raw of body) {
      const commit = normalizePullCommit(raw);
      if (commit) commits.push(commit);
    }
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, repo: repoSlug(repo), pullNumber: input.number, commits };
}

export async function reviewGitHubPull(input: ReviewGitHubPullInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  const body = input.body?.trim() ?? "";
  const comments = sanitizeReviewComments(input.comments);
  const invalid = reviewValidationError(input.event, body, comments.length > 0);
  if (invalid) return { ok: false, error: invalid };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to review" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/reviews`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        event: input.event,
        ...(body ? { body } : {}),
        ...(comments.length > 0 ? { comments } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const suffix = comments.length > 0 ? ` (${comments.length} inline comment${comments.length === 1 ? "" : "s"})` : "";
  return {
    ok: true,
    message: (input.event === "APPROVE"
      ? "Pull request approved."
      : input.event === "COMMENT"
        ? "Review submitted."
        : "Changes requested.") + suffix,
  };
}

export async function mergeGitHubPull(input: MergeGitHubPullInput): Promise<GitHubPullMergeResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  if (input.method !== "merge" && input.method !== "squash" && input.method !== "rebase") {
    return { ok: false, error: "unsupported merge method" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to merge" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/merge`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "PUT",
      body: JSON.stringify({
        merge_method: input.method,
        ...(input.title?.trim() ? { commit_title: input.title.trim() } : {}),
        ...(input.message?.trim() ? { commit_message: input.message.trim() } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  return {
    ok: true,
    merged: obj.merged === true,
    sha: typeof obj.sha === "string" ? obj.sha : null,
    message: typeof obj.message === "string" ? obj.message : "Pull request merged.",
  };
}

export async function closeGitHubPull(input: CloseGitHubPullInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to close a pull request" };
  const comment = input.comment?.trim() ?? "";

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("pulls", json, input.dir);
  if (comment) {
    const commentResult = await createGitHubComment({ dir: input.dir, number: input.number, body: comment });
    if (!commentResult.ok) {
      return {
        ok: true,
        message: `Pull request closed, but the comment was not posted: ${commentResult.error}`,
        commentPosted: false,
        ...(item ? { item } : {}),
      };
    }
  }
  return {
    ok: true,
    message: comment ? "Pull request closed and comment posted." : "Pull request closed.",
    ...(comment ? { commentPosted: true } : {}),
    ...(item ? { item } : {}),
  };
}

export async function createGitHubIssue(input: CreateGitHubIssueInput): Promise<GitHubIssueResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "issue title required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create an issue" };
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const assignees = input.assignees?.map((s) => s.trim()).filter(Boolean) ?? [];
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(input.body?.trim() ? { body: input.body.trim() } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(assignees.length > 0 ? { assignees } : {}),
        ...(typeof input.milestone === "number" ? { milestone: input.milestone } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("issues", json, input.dir);
  if (!item) return { ok: false, error: "GitHub returned an unexpected issue response" };
  return { ok: true, item, message: "Issue created." };
}

export async function updateGitHubIssue(input: UpdateGitHubIssueInput): Promise<GitHubIssueResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }
  if (input.state && input.state !== "open" && input.state !== "closed") {
    return { ok: false, error: "unsupported issue state" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to update an issue" };
  const kind = input.kind === "pulls" ? "pulls" : "issues";
  const noun = kind === "pulls" ? "pull request" : "issue";
  const built = buildIssueUpdatePatch(input);
  if (!built.ok) return built;

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify(built.patch) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem(kind, json, input.dir);
  if (!item) return { ok: false, error: `GitHub returned an unexpected ${noun} response` };
  return { ok: true, item, message: `${kind === "pulls" ? "Pull request" : "Issue"} updated.` };
}

export async function requestGitHubPullReviewers(
  input: RequestGitHubPullReviewersInput,
): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }
  const reviewers = input.reviewers.map((s) => s.trim()).filter(Boolean);
  const teamReviewers = (input.teamReviewers ?? []).map((s) => s.trim()).filter(Boolean);
  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return { ok: false, error: "at least one reviewer or team is required" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to request reviewers" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/requested_reviewers`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        ...(reviewers.length > 0 ? { reviewers } : {}),
        ...(teamReviewers.length > 0 ? { team_reviewers: teamReviewers } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const parts: string[] = [];
  if (reviewers.length > 0) parts.push(reviewers.join(", "));
  if (teamReviewers.length > 0) parts.push(`team${teamReviewers.length === 1 ? "" : "s"} ${teamReviewers.join(", ")}`);
  return { ok: true, message: `Requested review from ${parts.join(" and ")}.` };
}

function pickString(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? (obj[key] as string) : "";
}

function normalizeMergeability(repo: GitHubRepo, number: number, raw: unknown): GitHubPullMergeability | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const head = obj.head && typeof obj.head === "object" ? obj.head as Record<string, unknown> : {};
  const base = obj.base && typeof obj.base === "object" ? obj.base as Record<string, unknown> : {};
  const headRepoObj = head.repo && typeof head.repo === "object" ? head.repo as Record<string, unknown> : null;
  const headRepo = headRepoObj && typeof headRepoObj.full_name === "string" ? headRepoObj.full_name : null;
  const baseSlug = repoSlug(repo);
  const baseRepoObj = base.repo && typeof base.repo === "object" ? base.repo as Record<string, unknown> : null;
  const baseFullName = baseRepoObj && typeof baseRepoObj.full_name === "string" ? baseRepoObj.full_name : baseSlug;
  return {
    repo: baseSlug,
    pullNumber: number,
    mergeable: typeof obj.mergeable === "boolean" ? obj.mergeable : null,
    mergeableState: pickString(obj, "mergeable_state") || "unknown",
    rebaseable: typeof obj.rebaseable === "boolean" ? obj.rebaseable : null,
    merged: obj.merged === true,
    draft: obj.draft === true,
    headRef: pickString(head, "ref"),
    baseRef: pickString(base, "ref"),
    headSha: pickString(head, "sha"),
    // `auto_merge` is null when disabled, else an object ({enabled_by, merge_method, ...}).
    autoMerge: !!(obj.auto_merge && typeof obj.auto_merge === "object"),
    headRepo,
    // Missing head.repo (e.g. the fork was deleted) can't be confirmed same-repo,
    // so treat it as cross-repo — the "Resolve with Agetor" flow requires proof
    // the head branch lives in this repo, not the absence of proof otherwise.
    crossRepo: headRepo === null || headRepo.toLowerCase() !== baseFullName.toLowerCase(),
  };
}

export async function getGitHubPullMergeability(input: GitHubItemNumberInput): Promise<GitHubMergeabilityResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  // GitHub computes `mergeable` asynchronously — the first read after a push can
  // return null. Poll a couple of times before giving up so the UI usually gets
  // a real verdict without the user hitting refresh.
  let last: GitHubPullMergeability | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_200));
    const res = await fetchGitHub(url, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
    const parsed = normalizeMergeability(repo, input.number, json);
    if (!parsed) return { ok: false, error: "GitHub returned an unexpected pull request response" };
    last = parsed;
    // A merged/closed PR, or a computed verdict, is terminal — stop polling.
    if (parsed.merged || parsed.mergeable !== null) break;
  }
  return last ? { ok: true, ...last } : { ok: false, error: "GitHub did not return mergeability for this pull request" };
}

export async function updateGitHubPullBranch(input: GitHubItemNumberInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to update the branch" };
  // Merges the base branch into the PR head. 202 Accepted with a message body.
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/update-branch`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "PUT", body: "{}" });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const message = json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
    ? (json as { message: string }).message
    : "Branch update started — GitHub is merging the base branch into this pull request.";
  return { ok: true, message };
}

export async function reopenGitHubPull(input: GitHubItemNumberInput): Promise<GitHubIssueResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to reopen a pull request" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify({ state: "open" }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("pulls", json, input.dir);
  if (!item) return { ok: false, error: "GitHub returned an unexpected pull request response" };
  return { ok: true, item, message: "Pull request reopened." };
}

/** First error message from a GraphQL 200-with-`errors` response, or null when
 *  there are none. GraphQL reports mutation failures in an `errors` array on an
 *  HTTP 200, so this is the real failure path a caller sees. */
function graphqlErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const errors = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  return first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string"
    ? (first as { message: string }).message
    : "GitHub rejected the request";
}

/** Map a GraphQL error touching the token's OAuth scope to a friendly message
 *  for Projects v2 endpoints (F21/G11). GitHub Projects v2 requires the
 *  `project` (classic PAT) or `read:project` (fine-grained) scope, which most
 *  tokens don't carry by default — the raw GraphQL error is opaque ("Your
 *  token has not been granted the required scopes...", "Resource not
 *  accessible by personal access token", …), so this matches loosely on the
 *  word "scope" rather than one exact string and prepends actionable
 *  guidance. Leaves any other error message untouched. Pure — unit-tested. */
function projectsScopeErrorMessage(raw: string): string {
  if (/scope/i.test(raw)) {
    return `your GitHub token needs the \`project\` scope (or \`read:project\` for fine-grained tokens) to manage Projects — ${raw}`;
  }
  return raw;
}

/** Dig `data.<field>.pullRequest.isDraft` out of a GraphQL response. */
function draftFromGraphql(json: unknown, field: string): boolean | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as Record<string, unknown>)[field];
  if (!payload || typeof payload !== "object") return null;
  const pr = (payload as { pullRequest?: unknown }).pullRequest;
  if (!pr || typeof pr !== "object") return null;
  const isDraft = (pr as { isDraft?: unknown }).isDraft;
  return typeof isDraft === "boolean" ? isDraft : null;
}

/** Dig `data.<field>.issue.isPinned` out of a `pinIssue`/`unpinIssue`
 *  mutation response. */
function pinnedFromGraphqlMutation(json: unknown, field: string): boolean | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as Record<string, unknown>)[field];
  if (!payload || typeof payload !== "object") return null;
  const issue = (payload as { issue?: unknown }).issue;
  if (!issue || typeof issue !== "object") return null;
  const isPinned = (issue as { isPinned?: unknown }).isPinned;
  return typeof isPinned === "boolean" ? isPinned : null;
}

/** Dig `data.repository.issue.isPinned` out of the lazy pinned-state read. */
function pinnedFromGraphqlQuery(json: unknown): boolean | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return null;
  const issue = (repository as { issue?: unknown }).issue;
  if (!issue || typeof issue !== "object") return null;
  const isPinned = (issue as { isPinned?: unknown }).isPinned;
  return typeof isPinned === "boolean" ? isPinned : null;
}

/** Dig `data.repository.id` out of the transfer flow's target-repo lookup. */
function targetRepoIdFromGraphql(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return null;
  const id = (repository as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Dig `data.transferIssue.issue.{number,url}` out of the `transferIssue`
 *  mutation response. */
function transferredIssueFromGraphql(json: unknown): { number: number; url: string } | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as { transferIssue?: unknown }).transferIssue;
  if (!payload || typeof payload !== "object") return null;
  const issue = (payload as { issue?: unknown }).issue;
  if (!issue || typeof issue !== "object") return null;
  const obj = issue as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.url !== "string") return null;
  return { number: obj.number, url: obj.url };
}

/** Dig `data.repository.projectsV2.nodes` out of a GraphQL response (F21/G11)
 *  — the repo-linked Projects v2 boards. Defensive: `[]` on any unexpected
 *  shape, and malformed entries are dropped individually rather than failing
 *  the whole list. Pure — unit-tested. */
function parseProjectsV2(json: unknown): GitHubProjectV2[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return [];
  const projectsV2 = (repository as { projectsV2?: unknown }).projectsV2;
  if (!projectsV2 || typeof projectsV2 !== "object") return [];
  const nodes = (projectsV2 as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const projects: GitHubProjectV2[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.number !== "number" || typeof obj.title !== "string" || typeof obj.url !== "string") {
      continue;
    }
    projects.push({ id: obj.id, number: obj.number, title: obj.title, url: obj.url });
  }
  return projects;
}

/** Dig `data.node.fields.nodes` out of the project-items query response
 *  (F21/G11), keeping only `ProjectV2SingleSelectField` nodes (discriminated
 *  by `__typename` — the query's other inline fragment,
 *  `... on ProjectV2FieldCommon`, exists only so non-select field types don't
 *  break the query; those nodes carry no `options` and aren't useful here, so
 *  they're dropped). Each returned field's `options` reflects whatever that
 *  particular single-select field has configured (rarely empty, but not
 *  guaranteed non-empty). Pure — unit-tested. */
function parseProjectFields(json: unknown): GitHubProjectField[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const node = (data as { node?: unknown }).node;
  if (!node || typeof node !== "object") return [];
  const fields = (node as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object") return [];
  const nodes = (fields as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const result: GitHubProjectField[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (obj.__typename !== "ProjectV2SingleSelectField") continue;
    if (typeof obj.id !== "string" || typeof obj.name !== "string") continue;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: { id: string; name: string }[] = [];
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== "object") continue;
      const optionObj = rawOption as Record<string, unknown>;
      if (typeof optionObj.id !== "string" || typeof optionObj.name !== "string") continue;
      options.push({ id: optionObj.id, name: optionObj.name });
    }
    result.push({ id: obj.id, name: obj.name, options });
  }
  return result;
}

/** Dig `data.node.items.nodes` out of the project-items query response
 *  (F21/G11) into our flat item shape. `content.__typename` discriminates
 *  Issue/PullRequest (number+title) vs DraftIssue (title only, `number:
 *  null`) vs anything else (`contentType: "other"`, defensive against future
 *  GraphQL content types). `statusFieldId` (the resolved "Status" field's id,
 *  or null when the project has no such field) picks the matching
 *  `ProjectV2ItemFieldSingleSelectValue` out of each item's `fieldValues` —
 *  an item with no value for that field (or when `statusFieldId` is null)
 *  gets `statusOptionId`/`statusOptionName: null`. Pure — unit-tested. */
function parseProjectItems(json: unknown, statusFieldId: string | null): GitHubProjectItem[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const node = (data as { node?: unknown }).node;
  if (!node || typeof node !== "object") return [];
  const items = (node as { items?: unknown }).items;
  if (!items || typeof items !== "object") return [];
  const nodes = (items as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const result: GitHubProjectItem[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string") continue;

    const content = obj.content && typeof obj.content === "object" ? obj.content as Record<string, unknown> : null;
    const typename = content && typeof content.__typename === "string" ? content.__typename : null;
    let contentType: GitHubProjectItem["contentType"] = "other";
    let number: number | null = null;
    let title = "";
    if (typename === "Issue" || typename === "PullRequest") {
      contentType = typename;
      number = content && typeof content.number === "number" ? content.number : null;
      title = content && typeof content.title === "string" ? content.title : "";
    } else if (typename === "DraftIssue") {
      contentType = "DraftIssue";
      title = content && typeof content.title === "string" ? content.title : "";
    }

    let statusOptionId: string | null = null;
    let statusOptionName: string | null = null;
    const fieldValuesConnection = obj.fieldValues && typeof obj.fieldValues === "object"
      ? (obj.fieldValues as { nodes?: unknown }).nodes
      : undefined;
    if (statusFieldId && Array.isArray(fieldValuesConnection)) {
      for (const rawValue of fieldValuesConnection) {
        if (!rawValue || typeof rawValue !== "object") continue;
        const valueObj = rawValue as Record<string, unknown>;
        if (valueObj.__typename !== "ProjectV2ItemFieldSingleSelectValue") continue;
        const field = valueObj.field && typeof valueObj.field === "object" ? valueObj.field as Record<string, unknown> : null;
        const fieldId = field && typeof field.id === "string" ? field.id : null;
        if (fieldId !== statusFieldId) continue;
        statusOptionId = typeof valueObj.optionId === "string" ? valueObj.optionId : null;
        statusOptionName = typeof valueObj.name === "string" ? valueObj.name : null;
        break;
      }
    }

    result.push({ itemId: obj.id, contentType, number, title, statusOptionId, statusOptionName });
  }
  return result;
}

/** Dig `data.addProjectV2ItemById.item.id` out of the `addProjectV2ItemById`
 *  mutation response (F21/G11). */
function addedProjectItemIdFromGraphql(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as { addProjectV2ItemById?: unknown }).addProjectV2ItemById;
  if (!payload || typeof payload !== "object") return null;
  const item = (payload as { item?: unknown }).item;
  if (!item || typeof item !== "object") return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Map a GraphQL error touching Discussions to a friendly message when the
 *  repo simply doesn't have the feature enabled (F22/G12) — matches loosely
 *  on "discussion" alongside "not enabled"/"disabled"/"not available" rather
 *  than one exact string, since GitHub's own wording for a disabled feature
 *  isn't stable across query vs mutation. Leaves any other error untouched
 *  (same shape as `projectsScopeErrorMessage`). Pure — unit-tested. */
function discussionsDisabledErrorMessage(raw: string): string {
  if (/discussion/i.test(raw) && /(not enabled|disabled|not available|not have discussions)/i.test(raw)) {
    return "Discussions aren't enabled for this repository.";
  }
  return raw;
}

/** Dig `data.repository.discussions.nodes` out of the `listGitHubDiscussions`
 *  GraphQL response (F22/G12). `answered` is true when either `isAnswered` is
 *  true or `answerChosenAt` is non-null — the production query only requests
 *  `isAnswered`, but this stays defensive against either shape. Malformed
 *  entries are dropped individually; unexpected top-level shapes return `[]`.
 *  Pure — unit-tested. */
function parseDiscussions(json: unknown): GitHubDiscussion[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return [];
  const discussions = (repository as { discussions?: unknown }).discussions;
  if (!discussions || typeof discussions !== "object") return [];
  const nodes = (discussions as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const result: GitHubDiscussion[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.number !== "number" || typeof obj.title !== "string") continue;
    const category = obj.category && typeof obj.category === "object" ? obj.category as Record<string, unknown> : null;
    const author = obj.author && typeof obj.author === "object" ? obj.author as Record<string, unknown> : null;
    result.push({
      id: obj.id,
      number: obj.number,
      title: obj.title,
      url: typeof obj.url === "string" ? obj.url : "",
      category: category && typeof category.name === "string" ? category.name : "",
      author: author && typeof author.login === "string" ? author.login : null,
      createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
      answered: obj.isAnswered === true || obj.answerChosenAt != null,
    });
  }
  return result;
}

/** Dig `data.repository.discussionCategories.nodes` out of the
 *  `listGitHubDiscussions` GraphQL response (F22/G12) — powers the
 *  create-discussion form's category picker only (scope A2: no category
 *  management). Pure — unit-tested. */
function parseDiscussionCategories(json: unknown): GitHubDiscussionCategory[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return [];
  const categories = (repository as { discussionCategories?: unknown }).discussionCategories;
  if (!categories || typeof categories !== "object") return [];
  const nodes = (categories as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const result: GitHubDiscussionCategory[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.name !== "string") continue;
    result.push({ id: obj.id, name: obj.name });
  }
  return result;
}

/** Dig `data.repository.discussion` out of the `getGitHubDiscussion` GraphQL
 *  response (F22/G12) — the thread's body plus its comments, and
 *  `answerable` from `category.isAnswerable`. Returns `null` (never throws)
 *  on any unexpected shape, including a missing discussion (deleted/no
 *  access) or a malformed comment list. Individual malformed comments are
 *  dropped rather than failing the whole detail. Pure — unit-tested. */
function parseDiscussionDetail(json: unknown): GitHubDiscussionDetail | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const repository = (data as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return null;
  const discussion = (repository as { discussion?: unknown }).discussion;
  if (!discussion || typeof discussion !== "object") return null;
  const obj = discussion as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;

  const comments: GitHubDiscussionComment[] = [];
  const commentsField = obj.comments && typeof obj.comments === "object" ? obj.comments as Record<string, unknown> : null;
  const commentNodes = commentsField ? commentsField.nodes : undefined;
  if (Array.isArray(commentNodes)) {
    for (const raw of commentNodes) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== "string" || typeof c.body !== "string") continue;
      const author = c.author && typeof c.author === "object" ? c.author as Record<string, unknown> : null;
      comments.push({
        id: c.id,
        body: c.body,
        author: author && typeof author.login === "string" ? author.login : null,
        createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
        isAnswer: c.isAnswer === true,
      });
    }
  }

  const category = obj.category && typeof obj.category === "object" ? obj.category as Record<string, unknown> : null;
  return {
    id: obj.id,
    title: obj.title,
    body: typeof obj.body === "string" ? obj.body : "",
    comments,
    answerable: !!category && category.isAnswerable === true,
  };
}

/** Dig `data.createDiscussion.discussion.{number,url}` out of the
 *  `createDiscussion` mutation response (F22/G12). */
function createdDiscussionFromGraphql(json: unknown): { number: number; url: string } | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as { createDiscussion?: unknown }).createDiscussion;
  if (!payload || typeof payload !== "object") return null;
  const discussion = (payload as { discussion?: unknown }).discussion;
  if (!discussion || typeof discussion !== "object") return null;
  const obj = discussion as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.url !== "string") return null;
  return { number: obj.number, url: obj.url };
}

/** Dig `data.addDiscussionComment.comment.id` out of the
 *  `addDiscussionComment` mutation response (F22/G12). */
function addedDiscussionCommentIdFromGraphql(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const payload = (data as { addDiscussionComment?: unknown }).addDiscussionComment;
  if (!payload || typeof payload !== "object") return null;
  const comment = (payload as { comment?: unknown }).comment;
  if (!comment || typeof comment !== "object") return null;
  const id = (comment as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Toggle a PR's draft state. REST has no endpoint for this, so it goes through
 *  the GraphQL `convertPullRequestToDraft` / `markPullRequestReadyForReview`
 *  mutations, keyed on the PR's global node id (read from the REST PR first). */
export async function setGitHubPullDraft(input: SetGitHubPullDraftInput): Promise<GitHubPullDraftResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to change draft state" };
  const prUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const prRes = await fetchGitHub(prUrl, token, "application/vnd.github+json");
  if (!("status" in prRes)) return prRes;
  const pr = await prRes.json().catch(() => null);
  if (!prRes.ok) return { ok: false, error: apiError(pr, prRes.status, prRes.statusText) };
  const nodeId = pr && typeof pr === "object" && typeof (pr as { node_id?: unknown }).node_id === "string"
    ? (pr as { node_id: string }).node_id
    : null;
  if (!nodeId) return { ok: false, error: "GitHub returned a pull request without a node id" };

  const field = input.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  const query = `mutation($id: ID!) { ${field}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: nodeId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  const isDraft = draftFromGraphql(json, field);
  const draft = isDraft ?? input.draft;
  return { ok: true, draft, message: draft ? "Converted to draft." : "Marked ready for review." };
}

/** Enable/disable GitHub auto-merge on a PR. REST has no endpoint for this
 *  either, so — same shape as `setGitHubPullDraft` — it goes through the
 *  GraphQL `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge`
 *  mutations, keyed on the PR's global node id. GitHub rejects enabling when
 *  the repo doesn't require any status checks/reviews on this branch, which
 *  surfaces here as a plain `graphqlErrorMessage` string (e.g. "Pull request
 *  Auto merge is not allowed for this repository"). */
export async function setGitHubPullAutoMerge(input: SetGitHubPullAutoMergeInput): Promise<GitHubPullAutoMergeResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to change auto-merge" };
  const prUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}`;
  const prRes = await fetchGitHub(prUrl, token, "application/vnd.github+json");
  if (!("status" in prRes)) return prRes;
  const pr = await prRes.json().catch(() => null);
  if (!prRes.ok) return { ok: false, error: apiError(pr, prRes.status, prRes.statusText) };
  const nodeId = pr && typeof pr === "object" && typeof (pr as { node_id?: unknown }).node_id === "string"
    ? (pr as { node_id: string }).node_id
    : null;
  if (!nodeId) return { ok: false, error: "GitHub returned a pull request without a node id" };

  const query = input.enable
    ? "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number } } }"
    : "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }";
  const variables = input.enable
    ? { id: nodeId, method: (input.mergeMethod ?? "merge").toUpperCase() }
    : { id: nodeId };
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  return {
    ok: true,
    autoMergeEnabled: input.enable,
    message: input.enable ? "Auto-merge enabled." : "Auto-merge disabled.",
  };
}

/** Lock/unlock an issue or pull request's conversation. Both share the same
 *  REST endpoint (`/issues/:number/lock` — a PR is an issue under the hood),
 *  unlike draft/auto-merge which are PR-only GraphQL mutations. Locking
 *  accepts an optional `lock_reason`; unlocking takes no body. Both directions
 *  return 204 No Content on success. */
export async function setGitHubIssueLock(input: SetGitHubIssueLockInput): Promise<GitHubIssueLockResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "item number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to lock/unlock" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/lock`;

  if (!input.locked) {
    const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "DELETE" });
    if (!("status" in res)) return res;
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      return { ok: false, error: apiError(json, res.status, res.statusText) };
    }
    return { ok: true, locked: false, message: "Conversation unlocked." };
  }

  const reason = input.lockReason?.trim();
  const body = reason && ISSUE_LOCK_REASONS.has(reason) ? { lock_reason: reason } : {};
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "PUT", body: JSON.stringify(body) });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, locked: true, message: "Conversation locked." };
}

/** Pin/unpin an issue. REST has no endpoint for this — same shape as
 *  `setGitHubPullDraft`: fetch the REST issue for its node id, then POST the
 *  GraphQL `pinIssue`/`unpinIssue` mutation. GitHub caps a repo at 3 pinned
 *  issues; that failure surfaces as a plain `graphqlErrorMessage` string,
 *  mapped here to a friendlier one. */
export async function setGitHubIssuePinned(input: SetGitHubIssuePinnedInput): Promise<GitHubIssuePinnedResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to pin/unpin" };
  const issueUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}`;
  const issueRes = await fetchGitHub(issueUrl, token, "application/vnd.github+json");
  if (!("status" in issueRes)) return issueRes;
  const issue = await issueRes.json().catch(() => null);
  if (!issueRes.ok) return { ok: false, error: apiError(issue, issueRes.status, issueRes.statusText) };
  const nodeId = issue && typeof issue === "object" && typeof (issue as { node_id?: unknown }).node_id === "string"
    ? (issue as { node_id: string }).node_id
    : null;
  if (!nodeId) return { ok: false, error: "GitHub returned an issue without a node id" };

  const field = input.pinned ? "pinIssue" : "unpinIssue";
  const query = `mutation($id: ID!) { ${field}(input: { issueId: $id }) { issue { isPinned } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: nodeId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) {
    if (/maximum number of pinned issues/i.test(gqlError)) {
      return { ok: false, error: "This repository already has the maximum of 3 pinned issues — unpin one first." };
    }
    return { ok: false, error: gqlError };
  }
  const isPinned = pinnedFromGraphqlMutation(json, field);
  const pinned = isPinned ?? input.pinned;
  return { ok: true, pinned, message: pinned ? "Issue pinned." : "Issue unpinned." };
}

/** Lazily read whether an issue is currently pinned (GraphQL — REST doesn't
 *  expose pin state). Same no-token-means-empty shape as
 *  `getGitHubPullReviewThreads`: an unauthenticated caller just sees
 *  `pinned: false` rather than an error. */
export async function getGitHubIssuePinned(input: GitHubItemNumberInput): Promise<GitHubIssuePinnedResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: true, pinned: false };
  const query = `query($owner:String!,$name:String!,$number:Int!){`
    + `repository(owner:$owner,name:$name){issue(number:$number){isPinned}}}`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, number: input.number } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  return { ok: true, pinned: pinnedFromGraphqlQuery(json) ?? false };
}

/** Friendly wrapper for the two sub-issues-specific non-2xx cases (404 = repo
 *  doesn't have the feature enabled or the issue doesn't exist; 410 = feature
 *  retired/unavailable for this repo) — otherwise falls back to the standard
 *  `message`-field mapping. */
function subIssuesApiError(body: unknown, status: number, statusText: string): string {
  if (status === 404 || status === 410) {
    return "Sub-issues aren't available here — the feature may not be enabled for this repository, or the issue doesn't exist.";
  }
  return apiError(body, status, statusText);
}

/** The children tracked under an issue via GitHub's sub-issues REST API,
 *  oldest first — same 3-page pagination cap as `listGitHubLabels`. */
export async function listGitHubSubIssues(input: GitHubItemNumberInput): Promise<GitHubSubIssuesResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const subIssues: GitHubSubIssue[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/sub_issues?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: subIssuesApiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected sub-issues response" };
    for (const raw of body) {
      const sub = normalizeSubIssue(raw);
      if (sub) subIssues.push(sub);
    }
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, repo: repoSlug(repo), issueNumber: input.number, subIssues };
}

/** Add a sub-issue by its display number. The sub-issues API wants the
 *  child's REST database `id`, not its number, so this resolves the id with a
 *  `GET /issues/:childNumber` first, then POSTs `sub_issue_id`. */
export async function addGitHubSubIssue(input: AddGitHubSubIssueInput): Promise<GitHubSubIssueAddResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }
  if (!Number.isInteger(input.childNumber) || input.childNumber <= 0) {
    return { ok: false, error: "child issue number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to add a sub-issue" };

  const childUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.childNumber}`;
  const childRes = await fetchGitHub(childUrl, token, "application/vnd.github+json");
  if (!("status" in childRes)) return childRes;
  const childJson = await childRes.json().catch(() => null);
  if (!childRes.ok) {
    return { ok: false, error: `Couldn't resolve #${input.childNumber}: ${apiError(childJson, childRes.status, childRes.statusText)}` };
  }
  const childId = childJson && typeof childJson === "object" && typeof (childJson as { id?: unknown }).id === "number"
    ? (childJson as { id: number }).id
    : null;
  if (childId === null) return { ok: false, error: "GitHub returned a child issue without an id" };

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/sub_issues`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ sub_issue_id: childId }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: subIssuesApiError(json, res.status, res.statusText) };
  const subIssue = normalizeSubIssue(json);
  if (!subIssue) return { ok: false, error: "GitHub returned an unexpected sub-issue response" };
  return { ok: true, subIssue, message: `Added #${input.childNumber} as a sub-issue.` };
}

/** Remove a sub-issue by the child's REST id (as returned by
 *  `listGitHubSubIssues`/`addGitHubSubIssue` — see `GitHubSubIssue.id`). */
export async function removeGitHubSubIssue(input: RemoveGitHubSubIssueInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }
  if (!Number.isInteger(input.childId) || input.childId <= 0) {
    return { ok: false, error: "child issue id must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to remove a sub-issue" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}/sub_issue`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "DELETE", body: JSON.stringify({ sub_issue_id: input.childId }) },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: subIssuesApiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Sub-issue removed." };
}

/** Transfer an issue to another repository. GraphQL-only: resolve the source
 *  issue's node id (REST), resolve the target repo's node id via
 *  `repository(owner,name){id}`, then POST `transferIssue`. The issue moves
 *  out of the current repo entirely, so the caller drops it from any list
 *  it's showing. */
export async function transferGitHubIssue(input: TransferGitHubIssueInput): Promise<GitHubIssueTransferResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "issue number must be positive" };
  }
  const target = parseTargetRepo(input.targetRepo);
  if (!target) return { ok: false, error: "target repo must be in the form owner/name" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to transfer an issue" };

  const issueUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}`;
  const issueRes = await fetchGitHub(issueUrl, token, "application/vnd.github+json");
  if (!("status" in issueRes)) return issueRes;
  const issueJson = await issueRes.json().catch(() => null);
  if (!issueRes.ok) return { ok: false, error: apiError(issueJson, issueRes.status, issueRes.statusText) };
  const nodeId = issueJson && typeof issueJson === "object" && typeof (issueJson as { node_id?: unknown }).node_id === "string"
    ? (issueJson as { node_id: string }).node_id
    : null;
  if (!nodeId) return { ok: false, error: "GitHub returned an issue without a node id" };

  const repoIdQuery = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}`;
  const repoIdRes = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query: repoIdQuery, variables: { owner: target.owner, name: target.name } }) },
  );
  if (!("status" in repoIdRes)) return repoIdRes;
  const repoIdJson = await repoIdRes.json().catch(() => null);
  if (!repoIdRes.ok) return { ok: false, error: apiError(repoIdJson, repoIdRes.status, repoIdRes.statusText) };
  const repoIdGqlError = graphqlErrorMessage(repoIdJson);
  if (repoIdGqlError) return { ok: false, error: repoIdGqlError };
  const targetId = targetRepoIdFromGraphql(repoIdJson);
  if (!targetId) {
    return { ok: false, error: `Target repository "${input.targetRepo}" wasn't found or isn't accessible.` };
  }

  const transferQuery = `mutation($id:ID!,$repo:ID!){ transferIssue(input:{issueId:$id,repositoryId:$repo}){ issue { number url } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query: transferQuery, variables: { id: nodeId, repo: targetId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  const transferred = transferredIssueFromGraphql(json);
  if (!transferred) return { ok: false, error: "GitHub returned an unexpected transfer response" };
  return { ok: true, url: transferred.url, message: `Issue transferred to ${input.targetRepo} as #${transferred.number}.` };
}

/** List the Projects v2 boards linked to this repo (F21/G11) — read-only.
 *  GraphQL-only (Projects v2 has no REST surface). Requires the token to
 *  carry the `project`/`read:project` scope; GitHub's own error for a
 *  missing scope is opaque, so it's routed through `projectsScopeErrorMessage`
 *  for a friendlier message. */
export async function listGitHubProjectsV2(input: { dir: string }): Promise<GitHubProjectsV2Response> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to view projects" };

  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:20){nodes{id number title url}}}}`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: projectsScopeErrorMessage(gqlError) };
  return { ok: true, projects: parseProjectsV2(json) };
}

/** List a project's items plus its "Status" single-select field (if any),
 *  so the UI can populate each row's status dropdown from `statusField`
 *  (F21/G11). One GraphQL request fetches both `fields` and `items` off the
 *  same `node(id:$projectId)` — `fields` first(30), `items` first(50); this
 *  UI manages existing projects, not their schema, so no pagination beyond
 *  those single pages. */
export async function getGitHubProjectItems(input: GetGitHubProjectItemsInput): Promise<GitHubProjectItemsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.projectId.trim()) return { ok: false, error: "project id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to view project items" };

  const query = `query($id:ID!){ node(id:$id){ ... on ProjectV2 {`
    + `fields(first:30){ nodes{ __typename ... on ProjectV2SingleSelectField { id name options{ id name } } ... on ProjectV2FieldCommon { id name } } }`
    + `items(first:50){ nodes{ id content{ __typename ... on Issue{ number title } ... on PullRequest{ number title } ... on DraftIssue{ title } }`
    + `fieldValues(first:20){ nodes{ __typename ... on ProjectV2ItemFieldSingleSelectValue{ optionId name field{ ... on ProjectV2FieldCommon{ id } } } } } } }`
    + `} } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: input.projectId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: projectsScopeErrorMessage(gqlError) };
  const statusField = parseProjectFields(json).find((f) => f.name === "Status") ?? null;
  const items = parseProjectItems(json, statusField?.id ?? null);
  return { ok: true, items, statusField };
}

/** Add an existing issue/PR to a project by number (F21/G11) — scope decision
 *  A1 manages items on existing projects, not project schema/creation. Two
 *  steps: resolve the content's global node id via REST (`contentKind`
 *  picks `/issues/:number` vs `/pulls/:number` — both return `node_id`), then
 *  `addProjectV2ItemById`. Draft issues aren't addressable by number, so this
 *  only covers Issue/PullRequest content. */
export async function addGitHubProjectItem(input: AddGitHubProjectItemInput): Promise<GitHubProjectItemAddResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.projectId.trim()) return { ok: false, error: "project id required" };
  if (!Number.isInteger(input.contentNumber) || input.contentNumber <= 0) {
    return { ok: false, error: "issue/PR number must be positive" };
  }
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to add a project item" };

  const segment = input.contentKind === "pr" ? "pulls" : "issues";
  const contentUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/${segment}/${input.contentNumber}`;
  const contentRes = await fetchGitHub(contentUrl, token, "application/vnd.github+json");
  if (!("status" in contentRes)) return contentRes;
  const contentJson = await contentRes.json().catch(() => null);
  if (!contentRes.ok) return { ok: false, error: apiError(contentJson, contentRes.status, contentRes.statusText) };
  const nodeId = contentJson && typeof contentJson === "object" && typeof (contentJson as { node_id?: unknown }).node_id === "string"
    ? (contentJson as { node_id: string }).node_id
    : null;
  if (!nodeId) return { ok: false, error: "GitHub returned an item without a node id" };

  const query = `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{ projectId:$p, contentId:$c }){ item{ id } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { p: input.projectId, c: nodeId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: projectsScopeErrorMessage(gqlError) };
  const itemId = addedProjectItemIdFromGraphql(json);
  if (!itemId) return { ok: false, error: "GitHub returned an unexpected add-item response" };
  return { ok: true, itemId };
}

/** Remove an item from a project (F21/G11) — does not close/delete the
 *  underlying issue/PR, only unlinks it from the board. */
export async function removeGitHubProjectItem(input: RemoveGitHubProjectItemInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.projectId.trim()) return { ok: false, error: "project id required" };
  if (!input.itemId.trim()) return { ok: false, error: "item id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to remove a project item" };

  const query = `mutation($p:ID!,$i:ID!){ deleteProjectV2Item(input:{ projectId:$p, itemId:$i }){ deletedItemId } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { p: input.projectId, i: input.itemId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: projectsScopeErrorMessage(gqlError) };
  return { ok: true, message: "Item removed from project." };
}

/** Set an item's value for a single-select field — in practice always the
 *  "Status" field surfaced by `getGitHubProjectItems` (F21/G11). Scope
 *  decision A1 doesn't include clearing a field back to unset (no
 *  `clearProjectV2ItemFieldValue` mutation wired here), only setting one of
 *  the field's existing options. */
export async function setGitHubProjectItemStatus(input: SetGitHubProjectItemStatusInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.projectId.trim()) return { ok: false, error: "project id required" };
  if (!input.itemId.trim()) return { ok: false, error: "item id required" };
  if (!input.fieldId.trim()) return { ok: false, error: "field id required" };
  if (!input.optionId.trim()) return { ok: false, error: "option id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to update a project item" };

  const query = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{ projectId:$p, itemId:$i, fieldId:$f, value:{ singleSelectOptionId:$o } }){ projectV2Item { id } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { p: input.projectId, i: input.itemId, f: input.fieldId, o: input.optionId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: projectsScopeErrorMessage(gqlError) };
  return { ok: true, message: "Status updated." };
}

/** List discussions + categories for the repo (F22/G12) — one GraphQL request
 *  fetches both, same combined-fetch shape as `getGitHubProjectItems`.
 *  Read-only and works without a token (`auth: "none"`), same as
 *  `listGitHubItems` — the UI gates create/comment/answer on
 *  `auth === "token"` rather than on repo push, since any authenticated user
 *  can do those on Discussions (not just someone with push access). A repo
 *  with Discussions turned off surfaces as a GraphQL error, mapped to a
 *  friendly message by `discussionsDisabledErrorMessage`. */
export async function listGitHubDiscussions(input: { dir: string }): Promise<GitHubDiscussionsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const token = await githubToken(repo.remoteHost ?? null);

  const query = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){`
    + `discussions(first:25, orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{ id number title url createdAt isAnswered category{ name } author{ login } } }`
    + `discussionCategories(first:25){ nodes{ id name } }`
    + `} }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  return {
    ok: true,
    discussions: parseDiscussions(json),
    categories: parseDiscussionCategories(json),
    auth: token ? "token" : "none",
  };
}

/** A single discussion's body + comments, plus whether its category supports
 *  marking an answer (F22/G12). Read-only, same no-token-required shape as
 *  `listGitHubDiscussions`. */
export async function getGitHubDiscussion(input: GetGitHubDiscussionInput): Promise<GitHubDiscussionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "discussion number must be positive" };
  }
  const token = await githubToken(repo.remoteHost ?? null);

  const query = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){`
    + `discussion(number:$number){ id title body category{ isAnswerable } comments(first:50){ nodes{ id body createdAt isAnswer author{ login } } } }`
    + `} }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, number: input.number } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  const detail = parseDiscussionDetail(json);
  if (!detail) return { ok: false, error: "GitHub returned an unexpected discussion response" };
  return { ok: true, detail };
}

/** Create a discussion (F22/G12). GraphQL-only: resolve the repo's node id
 *  (same `repository(owner,name){id}` lookup `transferGitHubIssue` uses for
 *  its target repo), then POST `createDiscussion`. Requires a token — any
 *  authenticated user can start a discussion, not just someone with push. */
export async function createGitHubDiscussion(input: CreateGitHubDiscussionInput): Promise<GitHubDiscussionCreateResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.categoryId.trim()) return { ok: false, error: "category required" };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "discussion title required" };
  const body = input.body.trim();
  if (!body) return { ok: false, error: "discussion body required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create a discussion" };

  const repoIdQuery = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}`;
  const repoIdRes = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query: repoIdQuery, variables: { owner: repo.owner, name: repo.name } }) },
  );
  if (!("status" in repoIdRes)) return repoIdRes;
  const repoIdJson = await repoIdRes.json().catch(() => null);
  if (!repoIdRes.ok) return { ok: false, error: apiError(repoIdJson, repoIdRes.status, repoIdRes.statusText) };
  const repoIdGqlError = graphqlErrorMessage(repoIdJson);
  if (repoIdGqlError) return { ok: false, error: discussionsDisabledErrorMessage(repoIdGqlError) };
  const repoId = targetRepoIdFromGraphql(repoIdJson);
  if (!repoId) return { ok: false, error: "GitHub returned a repository without a node id" };

  const query = `mutation($r:ID!,$c:ID!,$t:String!,$b:String!){ createDiscussion(input:{ repositoryId:$r, categoryId:$c, title:$t, body:$b }){ discussion{ number url } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { r: repoId, c: input.categoryId, t: title, b: body } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  const created = createdDiscussionFromGraphql(json);
  if (!created) return { ok: false, error: "GitHub returned an unexpected create-discussion response" };
  return { ok: true, number: created.number, url: created.url };
}

/** Comment on a discussion (F22/G12). Requires only a token, not push — same
 *  gating as `createGitHubDiscussion` (see the G12 gating note). */
export async function addGitHubDiscussionComment(input: AddGitHubDiscussionCommentInput): Promise<GitHubDiscussionCommentResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.discussionId.trim()) return { ok: false, error: "discussion id required" };
  const body = input.body.trim();
  if (!body) return { ok: false, error: "comment body required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to comment" };

  const query = `mutation($d:ID!,$b:String!){ addDiscussionComment(input:{ discussionId:$d, body:$b }){ comment{ id } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { d: input.discussionId, b: body } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  const commentId = addedDiscussionCommentIdFromGraphql(json);
  if (!commentId) return { ok: false, error: "GitHub returned an unexpected add-comment response" };
  return { ok: true, commentId };
}

/** Mark/unmark a comment as a discussion's accepted answer (F22/G12). GitHub
 *  actually requires maintain/write access (or being the discussion author)
 *  for this — narrower than "any token", but there's no cheap way to check
 *  that up front, so this is allowed optimistically and any rejection
 *  surfaces as the plain GraphQL error. */
export async function setGitHubDiscussionAnswer(input: SetGitHubDiscussionAnswerInput): Promise<GitHubDiscussionAnswerResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.commentId.trim()) return { ok: false, error: "comment id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to mark an answer" };

  const field = input.answer ? "markDiscussionCommentAsAnswer" : "unmarkDiscussionCommentAsAnswer";
  const query = `mutation($id:ID!){ ${field}(input:{ id:$id }){ clientMutationId } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: input.commentId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  return { ok: true, isAnswer: input.answer };
}

/** Delete a discussion (F22/G12). GitHub permits this on the viewer's own
 *  discussion, or with repo push/admin — the UI gates the delete control on
 *  `author === viewerLogin || canPush` and lets any other rejection surface
 *  as the plain GraphQL error. */
export async function deleteGitHubDiscussion(input: DeleteGitHubDiscussionInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.discussionId.trim()) return { ok: false, error: "discussion id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a discussion" };

  const query = `mutation($id:ID!){ deleteDiscussion(input:{ id:$id }){ clientMutationId } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: input.discussionId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  return { ok: true, message: "Discussion deleted." };
}

/** Delete a discussion comment (F22/G12) — same own-content-or-push gating as
 *  `deleteGitHubDiscussion`. */
export async function deleteGitHubDiscussionComment(input: DeleteGitHubDiscussionCommentInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.commentId.trim()) return { ok: false, error: "comment id required" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a comment" };

  const query = `mutation($id:ID!){ deleteDiscussionComment(input:{ id:$id }){ clientMutationId } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: input.commentId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: discussionsDisabledErrorMessage(gqlError) };
  return { ok: true, message: "Comment deleted." };
}

/** The authenticated user's login, so the UI can offer edit/delete only on the
 *  viewer's own comments. Returns login "" when unauthenticated (nothing is the
 *  viewer's, so no controls) rather than erroring. */
export async function getGitHubViewer(input: { dir: string }): Promise<GitHubViewerResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: true, login: "" };
  const res = await fetchGitHub("https://api.github.com/user", token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: privateRepoHint(res.status, apiError(json, res.status, res.statusText), repo, !!token) };
  const login = json && typeof json === "object" && typeof (json as { login?: unknown }).login === "string"
    ? (json as { login: string }).login
    : "";
  return { ok: true, login };
}

/** The viewer's push/admin/maintain permission on the repo, from `GET
 *  /repos/:o/:r`'s `permissions` object — drives push-only-control gating
 *  (F13). Unauthenticated (no token) returns all-false rather than erroring,
 *  mirroring `getGitHubViewer`'s no-token behavior; a public repo is still
 *  readable without a token, but the viewer plainly can't push to it. */
export async function getGitHubRepoPermissions(input: { dir: string }): Promise<GitHubRepoPermissionsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: true, push: false, admin: false, maintain: false };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: privateRepoHint(res.status, apiError(json, res.status, res.statusText), repo, !!token) };
  const perms = json && typeof json === "object" && (json as { permissions?: unknown }).permissions
    && typeof (json as { permissions?: unknown }).permissions === "object"
    ? (json as { permissions: Record<string, unknown> }).permissions
    : {};
  return {
    ok: true,
    push: perms.push === true,
    admin: perms.admin === true,
    maintain: perms.maintain === true,
  };
}

/** `/issues/comments/:id` for a conversation comment, `/pulls/comments/:id` for
 *  an inline review comment. GitHub only permits the author (or a maintainer). */
function commentUrl(repo: GitHubRepo, kind: GitHubCommentKind, commentId: number): string {
  const seg = kind === "review" ? "pulls" : "issues";
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/${seg}/comments/${commentId}`;
}

export async function updateGitHubComment(input: UpdateGitHubCommentInput): Promise<GitHubCommentResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.commentId) || input.commentId <= 0) {
    return { ok: false, error: "comment id must be positive" };
  }
  const body = input.body.trim();
  if (!body) return { ok: false, error: "comment body required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to edit a comment" };
  const res = await fetchGitHub(
    commentUrl(repo, input.kind, input.commentId),
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify({ body }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const comment = normalizeComment(json);
  if (!comment) return { ok: false, error: "GitHub returned an unexpected comment response" };
  return { ok: true, comment };
}

export async function deleteGitHubComment(input: DeleteGitHubCommentInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.commentId) || input.commentId <= 0) {
    return { ok: false, error: "comment id must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a comment" };
  const res = await fetchGitHub(
    commentUrl(repo, input.kind, input.commentId),
    token,
    "application/vnd.github+json",
    { method: "DELETE" },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Comment deleted." };
}

/** Pull `reviewThreads` out of a GraphQL response into our flat shape. Each
 *  thread carries its GraphQL node id (for the resolve mutation), resolution
 *  state, and the REST databaseId of its first comment (so the UI can match a
 *  thread to a comment in the flat review-comments list). Pure — unit-tested. */
function parseReviewThreads(json: unknown): GitHubReviewThread[] {
  const nodes = ((): unknown[] => {
    if (!json || typeof json !== "object") return [];
    const data = (json as { data?: unknown }).data;
    const pr = data && typeof data === "object"
      ? ((data as { repository?: { pullRequest?: unknown } }).repository?.pullRequest)
      : undefined;
    const threads = pr && typeof pr === "object" ? (pr as { reviewThreads?: { nodes?: unknown } }).reviewThreads : undefined;
    const arr = threads && typeof threads === "object" ? (threads as { nodes?: unknown }).nodes : undefined;
    return Array.isArray(arr) ? arr : [];
  })();

  const threads: GitHubReviewThread[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    const comments = o.comments && typeof o.comments === "object" ? (o.comments as { nodes?: unknown }).nodes : undefined;
    const first = Array.isArray(comments) && comments[0] && typeof comments[0] === "object"
      ? (comments[0] as { databaseId?: unknown }).databaseId
      : undefined;
    if (typeof first !== "number") continue;
    threads.push({
      threadId: o.id,
      rootCommentId: first,
      isResolved: o.isResolved === true,
      isOutdated: o.isOutdated === true,
    });
  }
  return threads;
}

/** Whether the reviewThreads connection reported another page (we only fetch
 *  the first 100), so the UI can flag that later threads lack resolve controls. */
function reviewThreadsHasNextPage(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const data = (json as { data?: unknown }).data;
  const pr = data && typeof data === "object"
    ? (data as { repository?: { pullRequest?: unknown } }).repository?.pullRequest
    : undefined;
  const threads = pr && typeof pr === "object" ? (pr as { reviewThreads?: unknown }).reviewThreads : undefined;
  const pageInfo = threads && typeof threads === "object" ? (threads as { pageInfo?: unknown }).pageInfo : undefined;
  return !!pageInfo && typeof pageInfo === "object" && (pageInfo as { hasNextPage?: unknown }).hasNextPage === true;
}

export async function getGitHubPullReviewThreads(input: GitHubItemNumberInput): Promise<GitHubReviewThreadsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: true, repo: repoSlug(repo), pullNumber: input.number, threads: [], truncated: false };
  // `comments(first:1)` is the thread's ROOT comment — GitHub returns a review
  // thread's comments oldest-first, so the first is the one that started the
  // thread, and its databaseId matches the REST review-comment id the UI keys on.
  const query = `query($owner:String!,$name:String!,$number:Int!){`
    + `repository(owner:$owner,name:$name){pullRequest(number:$number){`
    + `reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, number: input.number } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  return {
    ok: true,
    repo: repoSlug(repo),
    pullNumber: input.number,
    threads: parseReviewThreads(json),
    truncated: reviewThreadsHasNextPage(json),
  };
}

/** Issues this PR will close on merge (GraphQL `closingIssuesReferences`),
 *  read-only — no mutation counterpart. Same no-token-means-empty shape as
 *  `getGitHubPullReviewThreads` (an unauthenticated caller just sees nothing
 *  rather than an error). */
export async function getGitHubPullLinkedIssues(input: GitHubItemNumberInput): Promise<GitHubLinkedIssuesResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: true, repo: repoSlug(repo), pullNumber: input.number, issues: [] };
  const query = `query($owner:String!,$name:String!,$number:Int!){`
    + `repository(owner:$owner,name:$name){pullRequest(number:$number){`
    + `closingIssuesReferences(first:20){nodes{number title url state}}}}}`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, number: input.number } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  return { ok: true, repo: repoSlug(repo), pullNumber: input.number, issues: parseLinkedIssues(json) };
}

export async function setGitHubReviewThreadResolved(
  input: SetGitHubReviewThreadResolvedInput,
): Promise<GitHubThreadResolveResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.threadId) return { ok: false, error: "review thread id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to resolve a thread" };
  const field = input.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const query = `mutation($id:ID!){ ${field}(input:{threadId:$id}){ thread { isResolved } } }`;
  const res = await fetchGitHub(
    "https://api.github.com/graphql",
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ query, variables: { id: input.threadId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const gqlError = graphqlErrorMessage(json);
  if (gqlError) return { ok: false, error: gqlError };
  const isResolved = ((): boolean | null => {
    const data = json && typeof json === "object" ? (json as { data?: unknown }).data : undefined;
    const payload = data && typeof data === "object" ? (data as Record<string, unknown>)[field] : undefined;
    const thread = payload && typeof payload === "object" ? (payload as { thread?: unknown }).thread : undefined;
    const r = thread && typeof thread === "object" ? (thread as { isResolved?: unknown }).isResolved : undefined;
    return typeof r === "boolean" ? r : null;
  })();
  const resolved = isResolved ?? input.resolved;
  return { ok: true, resolved, message: resolved ? "Conversation resolved." : "Conversation reopened." };
}

function normalizeRepoLabel(raw: unknown): GitHubRepoLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") return null;
  return {
    name: obj.name,
    color: typeof obj.color === "string" ? obj.color : "",
    description: typeof obj.description === "string" ? obj.description : "",
  };
}

/** Strip a leading `#` from a hex color — GitHub's labels API wants the bare hex. */
function normalizeColor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return color.trim().replace(/^#/, "").toLowerCase();
}

/** `/repos/:o/:r/labels/:name` — the label name goes in the path, so it must be
 *  URL-encoded ("help wanted", "good first issue", etc. contain spaces). */
function labelUrl(repo: GitHubRepo, name: string): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`;
}

export async function listGitHubLabels(input: { dir: string }): Promise<GitHubLabelsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const labels: GitHubRepoLabel[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/labels?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected labels response" };
    for (const raw of body) {
      const label = normalizeRepoLabel(raw);
      if (label) labels.push(label);
    }
    next = pageLinks(res.headers.get("link"));
  }
  labels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, repo: repoSlug(repo), labels };
}

export async function listGitHubAssignees(input: { dir: string }): Promise<GitHubAssigneesResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const assignees: GitHubUser[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/assignees?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected assignees response" };
    for (const raw of body) {
      const user = normalizeUser(raw);
      if (user) assignees.push(user);
    }
    next = pageLinks(res.headers.get("link"));
  }
  assignees.sort((a, b) => a.login.localeCompare(b.login));
  return { ok: true, repo: repoSlug(repo), assignees };
}

export async function createGitHubLabel(input: CreateGitHubLabelInput): Promise<GitHubLabelResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const name = input.name.trim();
  if (!name) return { ok: false, error: "label name required" };
  const color = normalizeColor(input.color) ?? "";

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create a label" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/labels`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(color ? { color } : {}),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const label = normalizeRepoLabel(json);
  if (!label) return { ok: false, error: "GitHub returned an unexpected label response" };
  return { ok: true, label };
}

export async function updateGitHubLabel(input: UpdateGitHubLabelInput): Promise<GitHubLabelResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.name.trim()) return { ok: false, error: "label name required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to edit a label" };
  const patch: { new_name?: string; color?: string; description?: string } = {};
  if (input.newName !== undefined) {
    const nn = input.newName.trim();
    if (!nn) return { ok: false, error: "label name cannot be empty" };
    patch.new_name = nn;
  }
  const color = normalizeColor(input.color);
  if (color !== undefined) patch.color = color;
  if (input.description !== undefined) patch.description = input.description;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "label update requires a new name, color, or description" };
  }

  const res = await fetchGitHub(
    labelUrl(repo, input.name),
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const label = normalizeRepoLabel(json);
  if (!label) return { ok: false, error: "GitHub returned an unexpected label response" };
  return { ok: true, label };
}

export async function deleteGitHubLabel(input: DeleteGitHubLabelInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.name.trim()) return { ok: false, error: "label name required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a label" };
  const res = await fetchGitHub(labelUrl(repo, input.name), token, "application/vnd.github+json", { method: "DELETE" });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Label deleted." };
}

function normalizeRepoMilestone(raw: unknown): GitHubRepoMilestone | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.title !== "string") return null;
  return {
    number: obj.number,
    title: obj.title,
    state: obj.state === "closed" ? "closed" : "open",
    description: typeof obj.description === "string" ? obj.description : "",
    dueOn: typeof obj.due_on === "string" ? obj.due_on : null,
    openIssues: typeof obj.open_issues === "number" ? obj.open_issues : 0,
    closedIssues: typeof obj.closed_issues === "number" ? obj.closed_issues : 0,
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
  };
}

/** GitHub's milestone `due_on` wants ISO8601. The UI sends a bare `YYYY-MM-DD`
 *  from a date input, which we widen to **noon UTC** — GitHub converts the
 *  instant to a fixed US (Pacific) timezone and keeps that calendar date, so
 *  midnight UTC would roll back to the previous day for anyone west of UTC and
 *  store the milestone a day early. Noon UTC stays on the picked day across
 *  every timezone GitHub converts to. A full ISO string passes through
 *  untouched; blank/whitespace becomes undefined (= "no change"). */
function normalizeDueOn(dueOn: string | null | undefined): string | undefined {
  if (dueOn == null) return undefined;
  const trimmed = dueOn.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T12:00:00Z`;
  return trimmed;
}

export async function listGitHubMilestones(input: { dir: string }): Promise<GitHubMilestonesResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const milestones: GitHubRepoMilestone[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/milestones?state=all&per_page=100&sort=due_on&direction=asc`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected milestones response" };
    for (const raw of body) {
      const milestone = normalizeRepoMilestone(raw);
      if (milestone) milestones.push(milestone);
    }
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, repo: repoSlug(repo), milestones };
}

export async function createGitHubMilestone(input: CreateGitHubMilestoneInput): Promise<GitHubMilestoneResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "milestone title required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create a milestone" };
  const dueOn = normalizeDueOn(input.dueOn);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/milestones`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(dueOn ? { due_on: dueOn } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const milestone = normalizeRepoMilestone(json);
  if (!milestone) return { ok: false, error: "GitHub returned an unexpected milestone response" };
  return { ok: true, milestone };
}

export async function updateGitHubMilestone(input: UpdateGitHubMilestoneInput): Promise<GitHubMilestoneResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) return { ok: false, error: "valid milestone number required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to edit a milestone" };
  const patch: { title?: string; description?: string; due_on?: string; state?: "open" | "closed" } = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) return { ok: false, error: "milestone title cannot be empty" };
    patch.title = t;
  }
  if (input.description !== undefined) patch.description = input.description;
  const dueOn = normalizeDueOn(input.dueOn);
  if (dueOn !== undefined) patch.due_on = dueOn;
  if (input.state) patch.state = input.state;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "milestone update requires a title, description, due date, or state" };
  }

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/milestones/${input.number}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "PATCH", body: JSON.stringify(patch) });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const milestone = normalizeRepoMilestone(json);
  if (!milestone) return { ok: false, error: "GitHub returned an unexpected milestone response" };
  return { ok: true, milestone };
}

/** The 8 reaction contents GitHub supports, in the order the UI renders both the
 *  emoji picker and the resulting chips. `aggregateReactions` sorts by this order
 *  and drops any content GitHub returns that isn't in this set (defensive —
 *  GitHub hasn't added a 9th reaction, but a fixed allowlist means one wouldn't
 *  silently render as an unlabeled chip). Also doubles as the add-reaction
 *  content validator, mirroring `reviewValidationError`'s own-input checks. */
const REACTION_CONTENT_ORDER: GitHubReactionContent[] = [
  "+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes",
];

/** `/issues/:id/reactions` for an issue/PR (both share the `issues` endpoint —
 *  GitHub has no separate `/pulls/:id/reactions`), `/issues/comments/:id/reactions`
 *  for a conversation comment, `/pulls/comments/:id/reactions` for an inline
 *  review comment. Pure — unit-tested. */
function reactionSubjectPath(repo: GitHubRepo, subject: GitHubReactionSubject): string {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  switch (subject.type) {
    case "issue":
      return `${base}/issues/${subject.id}/reactions`;
    case "issueComment":
      return `${base}/issues/comments/${subject.id}/reactions`;
    case "reviewComment":
      return `${base}/pulls/comments/${subject.id}/reactions`;
  }
}

/** Group raw `{ id, content, user: { login } }` reaction objects by content,
 *  counting each and recording the viewer's own reaction id (case-insensitive
 *  login match) so the UI can toggle a chip off without a second lookup.
 *  Unknown contents (outside the 8 GitHub supports) are dropped; the result is
 *  sorted by `REACTION_CONTENT_ORDER` and omits contents with zero reactions.
 *  Pure — unit-tested. */
function aggregateReactions(rawList: unknown[], viewerLogin: string): GitHubReactionSummary[] {
  const known = new Set<string>(REACTION_CONTENT_ORDER);
  const counts = new Map<GitHubReactionContent, number>();
  const viewerIds = new Map<GitHubReactionContent, number>();
  const viewer = viewerLogin.trim().toLowerCase();
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const content = obj.content;
    if (typeof content !== "string" || !known.has(content)) continue;
    const c = content as GitHubReactionContent;
    counts.set(c, (counts.get(c) ?? 0) + 1);
    if (viewer && typeof obj.id === "number") {
      const user = obj.user && typeof obj.user === "object" ? (obj.user as Record<string, unknown>) : null;
      const login = user && typeof user.login === "string" ? user.login.trim().toLowerCase() : "";
      if (login === viewer) viewerIds.set(c, obj.id);
    }
  }
  return REACTION_CONTENT_ORDER
    .filter((c) => (counts.get(c) ?? 0) > 0)
    .map((c) => ({ content: c, count: counts.get(c)!, viewerReactionId: viewerIds.get(c) ?? null }));
}

export async function listGitHubReactions(input: ListGitHubReactionsInput): Promise<GitHubReactionsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.subject.id) || input.subject.id <= 0) {
    return { ok: false, error: "reaction subject id must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  const raw: unknown[] = [];
  let next: string | null = `${reactionSubjectPath(repo, input.subject)}?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected reactions response" };
    raw.push(...body);
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, reactions: aggregateReactions(raw, input.viewer) };
}

export async function addGitHubReaction(input: AddGitHubReactionInput): Promise<GitHubReactionAddResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.subject.id) || input.subject.id <= 0) {
    return { ok: false, error: "reaction subject id must be positive" };
  }
  if (!REACTION_CONTENT_ORDER.includes(input.content)) {
    return { ok: false, error: "unsupported reaction content" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to react" };
  const res = await fetchGitHub(
    reactionSubjectPath(repo, input.subject),
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ content: input.content }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const reactionId = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "number"
    ? (json as { id: number }).id
    : null;
  if (reactionId === null) return { ok: false, error: "GitHub returned an unexpected reaction response" };
  return { ok: true, reactionId, content: input.content };
}

export async function removeGitHubReaction(input: RemoveGitHubReactionInput): Promise<GitHubReactionRemoveResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.subject.id) || input.subject.id <= 0) {
    return { ok: false, error: "reaction subject id must be positive" };
  }
  if (!Number.isInteger(input.reactionId) || input.reactionId <= 0) {
    return { ok: false, error: "reaction id must be positive" };
  }

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to remove a reaction" };
  const res = await fetchGitHub(
    `${reactionSubjectPath(repo, input.subject)}/${input.reactionId}`,
    token,
    "application/vnd.github+json",
    { method: "DELETE" },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true };
}

export async function deleteGitHubMilestone(input: DeleteGitHubMilestoneInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) return { ok: false, error: "valid milestone number required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a milestone" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/milestones/${input.number}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "DELETE" });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Milestone deleted." };
}

/** `GET /repos/:o/:r/releases` (F18) — same 3-page pagination cap as
 *  `listGitHubLabels`. Sorted newest first by `publishedAt` (falling back to
 *  `createdAt` for a draft, which has no publish date yet). */
export async function listGitHubReleases(input: { dir: string }): Promise<GitHubReleasesResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const releases: GitHubRelease[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected releases response" };
    for (const raw of body) {
      const release = normalizeRelease(raw);
      if (release) releases.push(release);
    }
    next = pageLinks(res.headers.get("link"));
  }
  releases.sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
  return { ok: true, repo: repoSlug(repo), releases };
}

/** `GET /repos/:o/:r/tags` — powers the release manager's tag-name datalist
 *  (F18). Same 3-page pagination cap as `listGitHubLabels`. */
export async function listGitHubTags(input: { dir: string }): Promise<GitHubTagsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const tags: GitHubTag[] = [];
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/tags?per_page=100`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected tags response" };
    for (const raw of body) {
      const tag = normalizeTag(raw);
      if (tag) tags.push(tag);
    }
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, tags };
}

export async function createGitHubRelease(input: CreateGitHubReleaseInput): Promise<GitHubReleaseResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const tagName = input.tagName.trim();
  if (!tagName) return { ok: false, error: "tag name required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to create a release" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    {
      method: "POST",
      body: JSON.stringify({
        tag_name: tagName,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.prerelease !== undefined ? { prerelease: input.prerelease } : {}),
        ...(input.targetCommitish?.trim() ? { target_commitish: input.targetCommitish.trim() } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const release = normalizeRelease(json);
  if (!release) return { ok: false, error: "GitHub returned an unexpected release response" };
  return { ok: true, release };
}

export async function updateGitHubRelease(input: UpdateGitHubReleaseInput): Promise<GitHubReleaseResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.id) || input.id <= 0) return { ok: false, error: "valid release id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to edit a release" };
  const patch: { tag_name?: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean } = {};
  if (input.tagName !== undefined) {
    const tn = input.tagName.trim();
    if (!tn) return { ok: false, error: "tag name cannot be empty" };
    patch.tag_name = tn;
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.body !== undefined) patch.body = input.body;
  if (input.draft !== undefined) patch.draft = input.draft;
  if (input.prerelease !== undefined) patch.prerelease = input.prerelease;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "release update requires a tag, name, body, draft, or prerelease change" };
  }

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases/${input.id}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "PATCH", body: JSON.stringify(patch) });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const release = normalizeRelease(json);
  if (!release) return { ok: false, error: "GitHub returned an unexpected release response" };
  return { ok: true, release };
}

export async function deleteGitHubRelease(input: DeleteGitHubReleaseInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.id) || input.id <= 0) return { ok: false, error: "valid release id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to delete a release" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases/${input.id}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "DELETE" });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Release deleted." };
}

/** A single `GET /notifications` entry. Returns null when `id` or `subject`
 *  is missing — those are the two fields every other field is meaningless
 *  without (a notification the UI can't identify or describe). Pure —
 *  unit-tested. */
/** A GitHub notification `subject.url` is a REST API URL
 *  (`https://api.github.com/repos/o/r/issues/9`). Convert it to the browsable
 *  HTML URL so opening a notification lands on the page, not raw JSON. Returns
 *  null when the shape isn't a recognizable repo subject URL. */
function notificationHtmlUrl(subjectUrl: string | null): string | null {
  if (!subjectUrl) return null;
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(subjectUrl);
  if (!m) return null;
  const [, owner, name, rest] = m;
  // pulls → pull, commits → commit; issues/releases map straight through.
  const path = rest!.replace(/^pulls\//, "pull/").replace(/^commits\//, "commit/");
  return `https://github.com/${owner}/${name}/${path}`;
}

function normalizeNotification(raw: unknown): GitHubNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  const subject = obj.subject && typeof obj.subject === "object" ? obj.subject as Record<string, unknown> : null;
  if (!subject) return null;
  const repository = obj.repository && typeof obj.repository === "object" ? obj.repository as Record<string, unknown> : null;
  const subjectUrl = typeof subject.url === "string" ? subject.url : null;
  return {
    id: obj.id,
    unread: obj.unread === true,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
    title: typeof subject.title === "string" ? subject.title : "",
    subjectType: typeof subject.type === "string" ? subject.type : "",
    subjectUrl,
    htmlUrl: notificationHtmlUrl(subjectUrl),
    latestCommentUrl: typeof subject.latest_comment_url === "string" ? subject.latest_comment_url : null,
    repo: repository && typeof repository.full_name === "string" ? repository.full_name : "",
  };
}

/** `GET /repos/:o/:r/notifications` — this repo's inbox (F14). Notifications
 *  are always private, so (unlike most list endpoints here) there is no
 *  unauthenticated fallback: no token is a hard error rather than an
 *  empty/degraded result. `all: false` (GitHub's default) returns unread
 *  only; `all: true` returns the full recent history for the repo. */
export async function listGitHubNotifications(input: ListGitHubNotificationsInput): Promise<GitHubNotificationsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to view notifications" };

  const notifications: GitHubNotification[] = [];
  const all = input.all === true ? "true" : "false";
  let next: string | null = `https://api.github.com/repos/${repo.owner}/${repo.name}/notifications?all=${all}&per_page=50`;
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected notifications response" };
    for (const raw of body) {
      const notification = normalizeNotification(raw);
      if (notification) notifications.push(notification);
    }
    next = pageLinks(res.headers.get("link"));
  }
  return { ok: true, repo: repoSlug(repo), notifications };
}

/** `PATCH /notifications/threads/:id` — marks a single thread as read.
 *  Responds 205 with no body; success is `res.ok` alone. */
export async function markGitHubNotificationRead(input: GitHubThreadInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const threadId = input.threadId.trim();
  if (!threadId) return { ok: false, error: "thread id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to mark a notification read" };
  const res = await fetchGitHub(
    `https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}`,
    token,
    "application/vnd.github+json",
    { method: "PATCH" },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true };
}

/** `PUT /repos/:o/:r/notifications` — marks every notification in this repo
 *  as read. Responds 202 (Accepted, async) or 205 (already up to date) with
 *  no body; success is `res.ok` alone. */
export async function markAllGitHubNotificationsRead(input: { dir: string }): Promise<GitHubMarkAllReadResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to mark notifications read" };
  const res = await fetchGitHub(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/notifications`,
    token,
    "application/vnd.github+json",
    { method: "PUT" },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Marked all as read." };
}

/** `GET /notifications/threads/:id/subscription` — a 404 means the viewer has
 *  no explicit subscription record for the thread (the common case: they're
 *  simply subscribed by default participation), which is not an error —
 *  it's reported as `{ subscribed: false, ignored: false }`. */
export async function getGitHubThreadSubscription(input: GitHubThreadInput): Promise<GitHubThreadSubscriptionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const threadId = input.threadId.trim();
  if (!threadId) return { ok: false, error: "thread id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to view thread subscription" };
  const res = await fetchGitHub(
    `https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}/subscription`,
    token,
    "application/vnd.github+json",
  );
  if (!("status" in res)) return res;
  if (res.status === 404) return { ok: true, subscribed: false, ignored: false };
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  return { ok: true, subscribed: obj.subscribed === true, ignored: obj.ignored === true };
}

/** `PUT /notifications/threads/:id/subscription` — (re)subscribes to a
 *  thread, optionally muting it (`ignored: true`, GitHub's "ignore this
 *  conversation"). */
export async function setGitHubThreadSubscription(input: SetGitHubThreadSubscriptionInput): Promise<GitHubThreadSubscriptionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const threadId = input.threadId.trim();
  if (!threadId) return { ok: false, error: "thread id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to update thread subscription" };
  const res = await fetchGitHub(
    `https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}/subscription`,
    token,
    "application/vnd.github+json",
    { method: "PUT", body: JSON.stringify({ ignored: input.ignored === true }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  return { ok: true, subscribed: obj.subscribed === true, ignored: obj.ignored === true };
}

/** `DELETE /notifications/threads/:id/subscription` — removes the viewer's
 *  subscription entirely (distinct from `ignored: true`, which keeps a
 *  subscription but mutes it). Responds 204 with no body. */
export async function unsubscribeGitHubThread(input: GitHubThreadInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const threadId = input.threadId.trim();
  if (!threadId) return { ok: false, error: "thread id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to unsubscribe from a thread" };
  const res = await fetchGitHub(
    `https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}/subscription`,
    token,
    "application/vnd.github+json",
    { method: "DELETE" },
  );
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true };
}

/** `GET /repos/:o/:r/actions/runs` (F20). Unlike the paginated list-with-
 *  `link`-header endpoints elsewhere in this file, the response here is an
 *  OBJECT with a nested `workflow_runs` array (not a bare array) — the API
 *  already returns them newest-first, so a single page of 30 is enough for
 *  the "recent runs" panel and no client-side sort/pagination is needed. */
export async function listGitHubWorkflowRuns(input: { dir: string }): Promise<GitHubWorkflowRunsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs?per_page=30`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
  const rawRuns = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).workflow_runs)
    ? (body as Record<string, unknown>).workflow_runs as unknown[]
    : null;
  if (!rawRuns) return { ok: false, error: "GitHub returned an unexpected workflow runs response" };
  const runs = rawRuns.map(normalizeWorkflowRun).filter((x): x is GitHubWorkflowRun => !!x);
  return { ok: true, repo: repoSlug(repo), runs };
}

/** `GET /repos/:o/:r/actions/workflows` (F20) — powers the "run a workflow"
 *  dispatch picker. Same nested-object shape as `listGitHubWorkflowRuns`
 *  (`.workflows[]`, not a bare array). */
export async function listGitHubWorkflows(input: { dir: string }): Promise<GitHubWorkflowsResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken(repo.remoteHost ?? null);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/workflows?per_page=100`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(body, res.status, res.statusText) };
  const rawWorkflows = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).workflows)
    ? (body as Record<string, unknown>).workflows as unknown[]
    : null;
  if (!rawWorkflows) return { ok: false, error: "GitHub returned an unexpected workflows response" };
  const workflows = rawWorkflows.map(normalizeWorkflow).filter((x): x is GitHubWorkflow => !!x);
  return { ok: true, workflows };
}

/** `POST /repos/:o/:r/actions/runs/:run_id/rerun` (or `rerun-failed-jobs`
 *  when `failedOnly`) — F20. Responds 201 with no body; success is `res.ok`
 *  alone, like the notification mark-read endpoints. */
export async function rerunGitHubWorkflowRun(input: RerunGitHubWorkflowRunInput): Promise<GitHubWorkflowActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.runId) || input.runId <= 0) return { ok: false, error: "valid run id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to re-run a workflow" };
  const segment = input.failedOnly ? "rerun-failed-jobs" : "rerun";
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs/${input.runId}/${segment}`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "POST" });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Re-run queued." };
}

/** `POST /repos/:o/:r/actions/runs/:run_id/cancel` — F20. Responds 202 with
 *  no body; success is `res.ok` alone. */
export async function cancelGitHubWorkflowRun(input: CancelGitHubWorkflowRunInput): Promise<GitHubWorkflowActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.runId) || input.runId <= 0) return { ok: false, error: "valid run id required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to cancel a workflow run" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs/${input.runId}/cancel`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", { method: "POST" });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Cancellation requested." };
}

/** `POST /repos/:o/:r/actions/workflows/:workflow_id/dispatches` (F20) —
 *  triggers a `workflow_dispatch` run. `inputs` is omitted from the body
 *  entirely when empty (GitHub rejects an empty `inputs: {}` for workflows
 *  that declare no inputs). Responds 204 with no body; success is `res.ok`
 *  alone. Inputs are free-form key/value strings supplied by the user — no
 *  YAML parser is available to read the workflow file's declared
 *  `workflow_dispatch.inputs` schema, so we don't attempt to validate them
 *  against it (see input interface doc comment). */
export async function dispatchGitHubWorkflow(input: DispatchGitHubWorkflowInput): Promise<GitHubWorkflowActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.workflowId) || input.workflowId <= 0) return { ok: false, error: "valid workflow id required" };
  const ref = input.ref.trim();
  if (!ref) return { ok: false, error: "ref required" };

  const token = await githubToken(repo.remoteHost ?? null);
  if (!token) return { ok: false, error: "GitHub authentication required to dispatch a workflow" };
  const inputs = input.inputs && Object.keys(input.inputs).length > 0 ? input.inputs : undefined;
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/workflows/${input.workflowId}/dispatches`;
  const res = await fetchGitHub(url, token, "application/vnd.github+json", {
    method: "POST",
    body: JSON.stringify({ ref, ...(inputs ? { inputs } : {}) }),
  });
  if (!("status" in res)) return res;
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, error: apiError(json, res.status, res.statusText) };
  }
  return { ok: true, message: "Workflow dispatched." };
}
