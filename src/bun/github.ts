import { existsSync } from "node:fs";
import type {
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubLabel,
  GitHubLabelsResult,
  GitHubListItem,
  GitHubListResult,
  GitHubRepoLabel,
  GitHubMilestone,
  GitHubMilestonesResult,
  GitHubRepoMilestone,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
  GitHubPullReviewThreadsResult,
  GitHubReviewThread,
  GitHubUser,
  TaskDiff,
} from "../shared/types.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";

interface CommandResult {
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

interface GitHubRepo {
  owner: string;
  name: string;
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
}

interface SetGitHubPullDraftInput extends GitHubItemNumberInput {
  draft: boolean;
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
type GitHubViewerResponse = ({ ok: true; login: string }) | GitHubListError;
type GitHubLabelsResponse = ({ ok: true } & GitHubLabelsResult) | GitHubListError;
type GitHubLabelResponse = ({ ok: true; label: GitHubRepoLabel }) | GitHubListError;
type GitHubMilestonesResponse = ({ ok: true } & GitHubMilestonesResult) | GitHubListError;
type GitHubMilestoneResponse = ({ ok: true; milestone: GitHubRepoMilestone }) | GitHubListError;
type GitHubReviewThreadsResponse = ({ ok: true } & GitHubPullReviewThreadsResult) | GitHubListError;
type GitHubThreadResolveResponse = ({ ok: true; resolved: boolean; message?: string }) | GitHubListError;
type GitHubActionResponse = ({ ok: true; message?: string; item?: GitHubListItem; commentPosted?: boolean }) | GitHubListError;
type GitHubPullMergeResponse = GitHubPullMergeResult | GitHubListError;
type GitHubPullDefaultsResponse = ({ ok: true } & GitHubPullDefaultsResult) | GitHubListError;
type GitHubIssueResponse = ({ ok: true; item: GitHubListItem; message?: string }) | GitHubListError;

const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const GITHUB_DIFF_BODY_CAP_BYTES = 8_000_000;

async function run(cmd: string[], cwd?: string, timeoutMs = 10_000): Promise<CommandResult> {
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

function parseGitHubRemote(raw: string): GitHubRepo | null {
  const remote = raw.trim();
  if (!remote) return null;

  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(remote);
  if (https) return { owner: https[1]!, name: https[2]! };

  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i.exec(remote);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  return null;
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
  matchesFilters,
  normalizeItem,
  normalizeComment,
  normalizeLineComment,
  normalizeCheckRun,
  reviewValidationError,
  buildIssueUpdatePatch,
  normalizeMergeability,
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
};

async function repoForDir(dir: string): Promise<GitHubRepo | null> {
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

async function githubToken(): Promise<string | null> {
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

function normalizeItem(kind: GitHubItemKind, raw: unknown): GitHubListItem | null {
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
  };
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

export async function listGitHubItems(input: ListGitHubItemsInput): Promise<GitHubListResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken();
  const slug = repoSlug(repo);
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const assignee = input.assignee?.trim() ?? "";
  // @me / review-requested / raw qualifiers need the Search API — the list
  // endpoints can't filter a PR by author or reviewer. Requires auth.
  const useSearch = !!(input.createdByMe || input.assignedToMe || input.reviewRequested || input.searchQuery?.trim());
  if (useSearch && !token) {
    return { ok: false, error: "GitHub authentication required for search / involvement filters" };
  }

  let url: URL;
  if (useSearch) {
    // One page of 100 keeps the tighter Search rate limit (~30/min) from being
    // hit by the 3× fan-out the list endpoints use.
    url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", buildSearchQuery(slug, input));
    url.searchParams.set("per_page", "100");
  } else {
    const endpoint = input.kind === "pulls" ? "pulls" : "issues";
    url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/${endpoint}`);
    url.searchParams.set("state", input.state);
    url.searchParams.set("per_page", "50");
    if (input.kind === "issues" && labels.length > 0) url.searchParams.set("labels", labels.join(","));
    if (input.kind === "issues" && assignee) url.searchParams.set("assignee", assignee);
  }

  const maxPages = useSearch ? 1 : 3;
  const items: GitHubListItem[] = [];
  let next: string | null = url.toString();
  for (let page = 0; next && page < maxPages; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
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
      return { ok: false, error: msg };
    }
    // The list endpoints return a bare array; search wraps items in `.items`.
    const raws = useSearch
      ? (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : null)
      : (Array.isArray(body) ? body : null);
    if (!raws) return { ok: false, error: "GitHub returned an unexpected response" };
    // In search mode the qualifiers already scoped labels/assignee server-side,
    // so only the free-text query is refined client-side.
    const clientLabels = useSearch ? [] : (input.kind === "pulls" ? labels : []);
    const clientAssignee = useSearch ? "" : (input.kind === "pulls" ? assignee : "");
    for (const raw of raws) {
      if (!useSearch && input.kind === "issues" && raw && typeof raw === "object" && "pull_request" in raw) continue;
      const item = normalizeItem(input.kind, raw);
      if (item && matchesFilters(item, input.query ?? "", clientLabels, clientAssignee)) {
        items.push(item);
      }
    }
    next = pageLinks(res.headers.get("link"));
  }

  return {
    ok: true,
    repo: slug,
    webUrl: `https://github.com/${slug}`,
    auth: token ? "token" : "none",
    items,
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

  const token = await githubToken();
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
  const item = normalizeItem("pulls", json);
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

export async function getGitHubPullChecks(input: GitHubItemNumberInput): Promise<GitHubChecksResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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
  const item = normalizeItem("pulls", json);
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

  const token = await githubToken();
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
  const item = normalizeItem("issues", json);
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

  const token = await githubToken();
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
  const item = normalizeItem(kind, json);
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
  if (reviewers.length === 0) return { ok: false, error: "at least one reviewer is required" };

  const token = await githubToken();
  if (!token) return { ok: false, error: "GitHub authentication required to request reviewers" };
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${input.number}/requested_reviewers`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "POST", body: JSON.stringify({ reviewers }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  return { ok: true, message: `Requested review from ${reviewers.join(", ")}.` };
}

function pickString(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? (obj[key] as string) : "";
}

function normalizeMergeability(repo: GitHubRepo, number: number, raw: unknown): GitHubPullMergeability | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const head = obj.head && typeof obj.head === "object" ? obj.head as Record<string, unknown> : {};
  const base = obj.base && typeof obj.base === "object" ? obj.base as Record<string, unknown> : {};
  return {
    repo: repoSlug(repo),
    pullNumber: number,
    mergeable: typeof obj.mergeable === "boolean" ? obj.mergeable : null,
    mergeableState: pickString(obj, "mergeable_state") || "unknown",
    rebaseable: typeof obj.rebaseable === "boolean" ? obj.rebaseable : null,
    merged: obj.merged === true,
    draft: obj.draft === true,
    headRef: pickString(head, "ref"),
    baseRef: pickString(base, "ref"),
    headSha: pickString(head, "sha"),
  };
}

export async function getGitHubPullMergeability(input: GitHubItemNumberInput): Promise<GitHubMergeabilityResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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
  const item = normalizeItem("pulls", json);
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

/** Toggle a PR's draft state. REST has no endpoint for this, so it goes through
 *  the GraphQL `convertPullRequestToDraft` / `markPullRequestReadyForReview`
 *  mutations, keyed on the PR's global node id (read from the REST PR first). */
export async function setGitHubPullDraft(input: SetGitHubPullDraftInput): Promise<GitHubPullDraftResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, error: "pull request number must be positive" };
  }

  const token = await githubToken();
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

/** The authenticated user's login, so the UI can offer edit/delete only on the
 *  viewer's own comments. Returns login "" when unauthenticated (nothing is the
 *  viewer's, so no controls) rather than erroring. */
export async function getGitHubViewer(input: { dir: string }): Promise<GitHubViewerResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const token = await githubToken();
  if (!token) return { ok: true, login: "" };
  const res = await fetchGitHub("https://api.github.com/user", token, "application/vnd.github+json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const login = json && typeof json === "object" && typeof (json as { login?: unknown }).login === "string"
    ? (json as { login: string }).login
    : "";
  return { ok: true, login };
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

export async function setGitHubReviewThreadResolved(
  input: SetGitHubReviewThreadResolvedInput,
): Promise<GitHubThreadResolveResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!input.threadId) return { ok: false, error: "review thread id required" };

  const token = await githubToken();
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

  const token = await githubToken();
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

export async function createGitHubLabel(input: CreateGitHubLabelInput): Promise<GitHubLabelResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  const name = input.name.trim();
  if (!name) return { ok: false, error: "label name required" };
  const color = normalizeColor(input.color) ?? "";

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

  const token = await githubToken();
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

export async function deleteGitHubMilestone(input: DeleteGitHubMilestoneInput): Promise<GitHubActionResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };
  if (!Number.isInteger(input.number) || input.number <= 0) return { ok: false, error: "valid milestone number required" };

  const token = await githubToken();
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
