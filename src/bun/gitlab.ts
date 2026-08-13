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
  GitHubMilestone,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullMergeResult,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewEvent,
  GitHubRepoLabel,
  GitHubUser,
  ProviderRepoInfo,
  TaskDiff,
} from "../shared/types.ts";
import { GIT_HOST_TOKENS_SECTION } from "../shared/types.ts";
import { contentTypeForPreviewPath, MAX_BLOB_PREVIEW_BYTES } from "../shared/attachments.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import { apiHostForRemote, gitlabToken } from "./git-provider.ts";

/**
 * GitLab adapter (T2, docs/plans/multi-provider-git-modal.md §4) — gitlab.com
 * as well as self-hosted instances, both addressed via
 * `apiHostForRemote`-derived `https://<host>/api/v4` (see
 * docs/plans/per-host-git-api-bases.md). Mirrors `src/bun/github.ts`'s
 * conventions closely enough that the facade (`git-host.ts`, T4) can dispatch
 * to either module transparently: same `{ok:true}&Result | {ok:false,error}`
 * result-union style, a 30s AbortController fetch timeout, `user-agent:
 * agetor`, and normalizers that produce the *exact same* shared `GitHub*`
 * wire types the UI already renders — GitLab's MR/issue/note/discussion/
 * pipeline JSON is mapped onto them rather than inventing GitLab-shaped types.
 *
 * Leaf module: does not import `db.ts`, `server.ts`, or `github.ts`. Every
 * exported function takes an already-resolved `ProviderRepoInfo` (see
 * `git-provider.ts`) — this adapter never shells out to `git` itself and
 * never resolves a remote from a directory; that's the facade's job. One
 * consequence: `ProviderRepoInfo` carries no working directory, so
 * `GitHubListItem.sourcePath` is always normalized to `null` here — the
 * facade is responsible for stitching `sourcePath = dir` onto every item it
 * gets back, the same way `listGitHubItemsAcrossRepos` does for the GitHub
 * path. Similarly `getGitLabPullDefaults`'s `head` can't be resolved without
 * a working directory (see its doc comment).
 */

/** GitLab's cloud hostname — kept as a named constant for the handful of
 *  display-only fallbacks (e.g. `authHint`'s `repo.remoteHost || GITLAB_CLOUD_HOST`)
 *  that aren't API-base URLs. Every actual request/URL site derives its host
 *  via `gitlabHost`/`gitlabApiBase` below, not this constant directly. */
const GITLAB_CLOUD_HOST = "gitlab.com";
const GITLAB_FETCH_TIMEOUT_MS = 30_000;
const GITLAB_DIFF_BODY_CAP_BYTES = 8_000_000;

/** Resolves the real host to address for `repo`'s GitLab API/web requests.
 *  `repo.remoteHost` is the raw host from the git remote — often an
 *  `~/.ssh/config` alias used to pin a per-identity SSH key (see
 *  git-provider.ts's module doc comment), not necessarily the provider's
 *  actual hostname. `apiHostForRemote` (git-provider.ts) resolves that alias
 *  to its configured `HostName` via `ssh -G` (falling back to the input
 *  verbatim on any failure), so a multi-identity alias whose HostName is
 *  gitlab.com round-trips to gitlab.com, while a genuine self-hosted domain
 *  (`gitlab.mycompany.com`, no matching alias) round-trips to itself. */
function gitlabHost(repo: ProviderRepoInfo): string {
  return apiHostForRemote(repo.remoteHost);
}

/** `https://<host>/api/v4` for `repo`'s real GitLab host (see `gitlabHost`).
 *  For gitlab.com and any ssh alias whose HostName points at gitlab.com, this
 *  reproduces the old hard-coded `https://gitlab.com/api/v4` constant
 *  exactly — byte-identical behavior, zero regression. For a genuine
 *  self-hosted domain, it targets that instance's own `/api/v4`, which is
 *  what makes self-hosted GitLab work at all. Called once per exported
 *  function (every call site has `repo` in scope) rather than memoized here —
 *  `apiHostForRemote` already caches the ssh resolution itself. */
function gitlabApiBase(repo: ProviderRepoInfo): string {
  return `https://${gitlabHost(repo)}/api/v4`;
}

export interface GitLabError {
  ok: false;
  error: string;
}

type GitLabListResponse = ({ ok: true } & GitHubListResult) | GitLabError;
type GitLabDiffResponse = ({ ok: true } & TaskDiff) | GitLabError;
type GitLabPullDefaultsResponse = ({ ok: true } & GitHubPullDefaultsResult) | GitLabError;
type GitLabIssueResponse = ({ ok: true; item: GitHubListItem; message?: string }) | GitLabError;
type GitLabCommentsResponse = ({ ok: true } & GitHubCommentsResult) | GitLabError;
type GitLabCommentResponse = ({ ok: true; comment: GitHubComment }) | GitLabError;
type GitLabPullLineCommentResponse = ({ ok: true; comment: GitHubPullLineComment }) | GitLabError;
type GitLabPullReviewCommentsResponse = ({ ok: true } & GitHubPullReviewCommentsResult) | GitLabError;
type GitLabChecksResponse = ({ ok: true } & GitHubChecksResult) | GitLabError;
type GitLabMergeabilityResponse = ({ ok: true } & GitHubPullMergeability) | GitLabError;
type GitLabPullMergeResponse = GitHubPullMergeResult | GitLabError;
type GitLabActionResponse = ({ ok: true; message?: string; item?: GitHubListItem; commentPosted?: boolean }) | GitLabError;
type GitLabViewerResponse = ({ ok: true; login: string }) | GitLabError;
type GitLabLabelsResponse = ({ ok: true } & GitHubLabelsResult) | GitLabError;

function fetchErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") return "GitLab request timed out";
  return e instanceof Error ? e.message : String(e);
}

/** `PRIVATE-TOKEN` (GitLab's own auth header, not `Authorization: Bearer`) when
 *  a token is present; 30s abort; `user-agent: agetor` — same shape as
 *  `fetchGitHub` in github.ts. `url` must be an absolute `https://<host>/api/v4/...`
 *  URL (every call site below builds one via `gitlabApiBase(repo)`, so `<host>`
 *  is gitlab.com for cloud/alias repos and the real domain for self-hosted
 *  ones — see `gitlabHost`'s doc comment) so pagination helpers can re-derive
 *  a next-page URL without having to know a base path convention. */
async function fetchGitLab(
  url: string,
  token: string | null,
  init?: { method?: string; body?: string; accept?: string },
): Promise<Response | GitLabError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITLAB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: init?.method,
      signal: controller.signal,
      headers: {
        accept: init?.accept ?? "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        "user-agent": "agetor",
        ...(token ? { "PRIVATE-TOKEN": token } : {}),
      },
      body: init?.body,
    });
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

function encodeProjectId(owner: string, name: string): string {
  return encodeURIComponent(`${owner}/${name}`);
}

/** GitLab's error bodies are inconsistent — sometimes `{message: string}`,
 *  sometimes `{message: string[]}` (validation errors), sometimes
 *  `{error: string}` (OAuth-flavored endpoints). Best-effort flatten; falls
 *  back to the HTTP status line. Pure — unit-tested via `__gitlabInternals`. */
function apiError(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (Array.isArray(obj.message)) return obj.message.map(String).join(", ");
    if (typeof obj.error === "string") return obj.error;
  }
  return `${status} ${statusText}`;
}

/** Enriches a 401/404 with an actionable pointer to Settings, mirroring
 *  github.ts's `privateRepoHint` wording — GitLab, like GitHub, answers 404
 *  (not 403) for a private project the caller can't see, and plain 401 for no
 *  credentials at all. Any other status is returned unchanged. Pure —
 *  unit-tested via `__gitlabInternals`. */
function authHint(status: number, message: string, repo: ProviderRepoInfo, hadToken: boolean): string {
  if (status !== 401 && status !== 404) return message;
  const host = repo.remoteHost || GITLAB_CLOUD_HOST;
  const base = `${repo.owner}/${repo.name} was not found on GitLab — if the project is private, add a token for ${host} in Settings → ${GIT_HOST_TOKENS_SECTION}`;
  return hadToken
    ? `${base} (the configured token cannot access it — check it belongs to the right account)`
    : base;
}

function errorFrom(res: Response, body: unknown, repo: ProviderRepoInfo, hadToken: boolean): string {
  return authHint(res.status, apiError(body, res.status, res.statusText), repo, hadToken);
}

/** `link: rel="next"` header parser — identical to github.ts's `pageLinks`. */
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

/** Resolves the next page's absolute URL from a GitLab list response: prefers
 *  the `Link: rel="next"` header (present on every paginated v4 endpoint),
 *  falling back to GitLab's own `x-next-page` header (present, but empty,
 *  once the last page has been reached — an empty/missing value means no next
 *  page). Pure given `res.headers`/`currentUrl` — unit-tested via
 *  `__gitlabInternals`. */
function resolveNextPage(res: Response, currentUrl: string): string | null {
  const link = pageLinks(res.headers.get("link"));
  if (link) return link;
  const nextPage = res.headers.get("x-next-page");
  if (nextPage === null || !nextPage.trim()) return null;
  const url = new URL(currentUrl);
  url.searchParams.set("page", nextPage.trim());
  return url.toString();
}

function normalizeUser(raw: unknown): GitHubUser | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.username !== "string") return null;
  return {
    login: obj.username,
    avatarUrl: typeof obj.avatar_url === "string" ? obj.avatar_url : null,
    htmlUrl: typeof obj.web_url === "string" ? obj.web_url : null,
  };
}

/** GitLab's MR/issue *list* endpoints return `labels` as a plain array of
 *  strings (not objects) unless `with_labels_details=true` is passed, which
 *  this adapter doesn't use. Synthesizes `{name, color: null}` to match
 *  `GitHubListItem.labels`'s shape; a details-shaped `{name,color}` object is
 *  also accepted defensively in case a future call site opts into details.
 *  Pure — unit-tested via `__gitlabInternals`. */
function normalizeLabels(raw: unknown): GitHubLabel[] {
  if (!Array.isArray(raw)) return [];
  const out: GitHubLabel[] = [];
  for (const l of raw) {
    if (typeof l === "string") {
      out.push({ name: l, color: null });
    } else if (l && typeof l === "object" && typeof (l as Record<string, unknown>).name === "string") {
      const obj = l as Record<string, unknown>;
      out.push({ name: obj.name as string, color: typeof obj.color === "string" ? obj.color : null });
    }
  }
  return out;
}

/** Maps a GitLab merge request or issue JSON object onto `GitHubListItem`.
 *  `iid` (project-scoped) is GitLab's counterpart to GitHub's `number`;
 *  `merged`/`locked` MR states both fold into `state: "closed"` (mirroring
 *  how GitHub only has open/closed, with `mergedAt` as the side channel the
 *  UI uses to tell a merge apart from a plain close) — a transient `locked`
 *  MR (mid-merge) is instead treated as still-open, since it isn't actually
 *  closed. `sourcePath` is always `null` here (see the module doc comment);
 *  the facade stitches it on. Pure — unit-tested via `__gitlabInternals`. */
function normalizeItem(kind: GitHubItemKind, raw: unknown, sourcePath: string | null = null): GitHubListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.iid !== "number" || typeof obj.title !== "string") return null;
  const rawState = obj.state;
  if (rawState !== "opened" && rawState !== "closed" && rawState !== "merged" && rawState !== "locked") return null;
  if (typeof obj.web_url !== "string") return null;
  const state: "open" | "closed" = rawState === "opened" || rawState === "locked" ? "open" : "closed";

  const assignees = Array.isArray(obj.assignees)
    ? obj.assignees.map(normalizeUser).filter((x): x is GitHubUser => !!x)
    : [];
  const milestoneRaw = obj.milestone && typeof obj.milestone === "object" ? obj.milestone as Record<string, unknown> : null;
  const milestoneNumber = milestoneRaw
    ? (typeof milestoneRaw.iid === "number" ? milestoneRaw.iid : (typeof milestoneRaw.id === "number" ? milestoneRaw.id : null))
    : null;
  const milestone: GitHubMilestone | null = milestoneRaw && milestoneNumber !== null && typeof milestoneRaw.title === "string"
    ? { number: milestoneNumber, title: milestoneRaw.title }
    : null;

  return {
    kind,
    number: obj.iid,
    title: obj.title,
    state,
    draft: typeof obj.draft === "boolean" ? obj.draft : false,
    htmlUrl: obj.web_url,
    author: normalizeUser(obj.author),
    assignees,
    milestone,
    body: typeof obj.description === "string" ? obj.description : "",
    labels: normalizeLabels(obj.labels),
    comments: typeof obj.user_notes_count === "number" ? obj.user_notes_count : 0,
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
    closedAt: typeof obj.closed_at === "string" ? obj.closed_at : null,
    mergedAt: typeof obj.merged_at === "string" ? obj.merged_at : null,
    locked: typeof obj.discussion_locked === "boolean" ? obj.discussion_locked : false,
    sourcePath,
  };
}

/** A GitLab note (`/notes`) has no `web_url` of its own — this builds the same
 *  "anchor into the MR/issue page" URL GitLab's own UI uses
 *  (`#note_<id>`). Requires the caller's `number` since a note payload alone
 *  doesn't carry its parent MR/issue iid. */
function noteHtmlUrl(repo: ProviderRepoInfo, kind: GitHubItemKind, number: number, noteId: number): string {
  const seg = kind === "pulls" ? "merge_requests" : "issues";
  return `https://${gitlabHost(repo)}/${repo.owner}/${repo.name}/-/${seg}/${number}#note_${noteId}`;
}

function normalizeComment(raw: unknown, repo: ProviderRepoInfo, kind: GitHubItemKind, number: number): GitHubComment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  return {
    id: obj.id,
    body: typeof obj.body === "string" ? obj.body : "",
    htmlUrl: noteHtmlUrl(repo, kind, number, obj.id),
    author: normalizeUser(obj.author),
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
  };
}

/** Maps a GitLab discussion note (`type: "DiffNote"`) onto `GitHubPullLineComment`.
 *  `position.new_line` set → `side: "RIGHT"`; `position.old_line` set →
 *  `side: "LEFT"` (mirrors GitHub's own LEFT=old/RIGHT=new convention). `path`
 *  prefers `new_path`, falling back to `old_path` (a delete-side-only comment
 *  has no `new_path`). Note: `GitHubPullLineComment` has no field for GitLab's
 *  discussion id — same as github.ts's own `normalizeLineComment`, which drops
 *  REST's `in_reply_to_id` too — so reply-threading isn't carried in this
 *  shape; `replyGitLabLineComment` below resolves the discussion id
 *  out-of-band instead. Pure — unit-tested via `__gitlabInternals`. */
function normalizeLineComment(raw: unknown, repo: ProviderRepoInfo, number: number): GitHubPullLineComment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  const position = obj.position && typeof obj.position === "object" ? obj.position as Record<string, unknown> : null;
  if (!position) return null;
  const newLine = typeof position.new_line === "number" ? position.new_line : null;
  const oldLine = typeof position.old_line === "number" ? position.old_line : null;
  const path = typeof position.new_path === "string"
    ? position.new_path
    : (typeof position.old_path === "string" ? position.old_path : null);
  if (!path) return null;
  let side: "LEFT" | "RIGHT";
  let line: number;
  if (newLine !== null) { side = "RIGHT"; line = newLine; }
  else if (oldLine !== null) { side = "LEFT"; line = oldLine; }
  else return null;

  return {
    id: obj.id,
    body: typeof obj.body === "string" ? obj.body : "",
    htmlUrl: noteHtmlUrl(repo, "pulls", number, obj.id),
    author: normalizeUser(obj.author),
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
    path,
    line,
    side,
  };
}

/** GitLab commit-status / pipeline status vocabulary → GitHub check-run
 *  vocabulary. `pending`/`running` are non-terminal (`conclusion: null`);
 *  everything else is `completed` with a mapped conclusion. An unrecognized
 *  status string rides through as-is rather than being coerced to
 *  "unknown", so a future GitLab status value degrades to "shown verbatim"
 *  instead of "shown as unknown". Pure — unit-tested via `__gitlabInternals`. */
function mapGitLabStatus(status: string): { status: string; conclusion: string | null } {
  switch (status) {
    case "pending": return { status: "queued", conclusion: null };
    case "running": return { status: "in_progress", conclusion: null };
    case "success": return { status: "completed", conclusion: "success" };
    case "failed": return { status: "completed", conclusion: "failure" };
    case "canceled": return { status: "completed", conclusion: "cancelled" };
    case "skipped": return { status: "completed", conclusion: "skipped" };
    default: return { status: status || "unknown", conclusion: null };
  }
}

function normalizeCommitStatusAsCheckRun(raw: unknown): GitHubCheckRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.name !== "string") return null;
  const { status, conclusion } = mapGitLabStatus(typeof obj.status === "string" ? obj.status : "");
  return {
    id: obj.id,
    name: obj.name,
    status,
    conclusion,
    htmlUrl: typeof obj.target_url === "string" ? obj.target_url : null,
    startedAt: typeof obj.started_at === "string" ? obj.started_at : null,
    completedAt: typeof obj.finished_at === "string" ? obj.finished_at : null,
  };
}

/** Fallback check-run entry representing the MR's own pipeline, used only
 *  when the commit has no individual per-job statuses to show (some projects
 *  only report a pipeline, not per-job statuses, through this API). */
function normalizePipelineAsCheckRun(raw: Record<string, unknown>): GitHubCheckRun | null {
  if (typeof raw.id !== "number") return null;
  const { status, conclusion } = mapGitLabStatus(typeof raw.status === "string" ? raw.status : "");
  return {
    id: raw.id,
    name: `pipeline #${raw.id}`,
    status,
    conclusion,
    htmlUrl: typeof raw.web_url === "string" ? raw.web_url : null,
    startedAt: null,
    completedAt: null,
  };
}

function normalizeRepoLabel(raw: unknown): GitHubRepoLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") return null;
  // github.ts's GitHubRepoLabel stores color as bare 6-hex (no leading '#');
  // GitLab returns "#RRGGBB" — strip the '#' so the UI's single color parse
  // works for either provider without a provider-specific branch.
  const color = typeof obj.color === "string" ? obj.color.replace(/^#/, "") : "";
  return {
    name: obj.name,
    color,
    description: typeof obj.description === "string" ? obj.description : "",
  };
}

function sortValue(item: GitHubListItem, sort: "created" | "updated" | "comments" | undefined): number {
  if (sort === "comments") return item.comments;
  const raw = sort === "created" ? item.createdAt : item.updatedAt;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function sortItems(items: GitHubListItem[], sort: "created" | "updated" | "comments" | undefined, direction: "asc" | "desc"): void {
  items.sort((a, b) => {
    const diff = sortValue(a, sort) - sortValue(b, sort);
    return direction === "asc" ? diff : -diff;
  });
}

/**
 * Maps the UI's neutral `GitHubItemState` to the GitLab `state` query param(s)
 * to fetch. The one asymmetry: GitHub's "closed" for pull requests already
 * includes merged PRs (GitHub only has open/closed, with a `merged` flag
 * riding along), but GitLab models `closed` and `merged` as two distinct MR
 * states — there's no single `state=` value that means "closed or merged".
 * Decision (documented per the plan, since GitLab's API forces a pick):
 * `kind: "pulls"` + `state: "closed"` fans out to **two** sequential requests
 * (`state=closed` then `state=merged`), merged and re-sorted client-side by
 * `listGitLabItems` — see its own comment for the pagination trade-off that
 * entails. Issues have no "merged" state, so `state: "closed"` there is a
 * single direct passthrough to `state=closed`.
 */
function gitlabStateParams(kind: GitHubItemKind, state: GitHubItemState): string[] {
  if (state === "all") return ["all"];
  if (state === "open") return ["opened"];
  if (kind === "pulls") return ["closed", "merged"];
  return ["closed"];
}

export interface ListGitLabItemsOptions {
  kind: GitHubItemKind;
  state: GitHubItemState;
  query?: string;
  labels?: string[];
  assignee?: string;
  createdByMe?: boolean;
  assignedToMe?: boolean;
  /** MRs only — GitLab's `scope=reviews_for_me`. Silently ignored for issues,
   *  mirroring the plan's decision (GitLab issues have no reviewer concept). */
  reviewRequested?: boolean;
  page?: number;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
}

const GITLAB_PER_PAGE = 30;

/** Mirrors `listGitHubItems`'s shape (minus `dir` — the facade resolves that
 *  into `repo`). See `gitlabStateParams` for the closed/merged fan-out this
 *  applies when `kind: "pulls"` and `state: "closed"`: in that case `page`
 *  and "Load more" are NOT supported — both requests always fetch their own
 *  page 1, the two results are merged and re-sorted, and `hasMore` is always
 *  `false`. That's a deliberate v1 simplification (documented in the plan):
 *  GitLab's page-based pagination doesn't compose across two independent
 *  listings without tracking two separate cursors, which the single `page`
 *  input here has no room to express. Every other state (`open`, `all`, and
 *  `closed` for issues) is a single direct request with normal pagination. */
export async function listGitLabItems(repo: ProviderRepoInfo, opts: ListGitLabItemsOptions): Promise<GitLabListResponse> {
  const token = await gitlabToken(repo.remoteHost);
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const endpoint = opts.kind === "pulls" ? "merge_requests" : "issues";
  const page = Number.isInteger(opts.page) && (opts.page as number) > 0 ? (opts.page as number) : 1;
  const orderBy = opts.sort === "created" ? "created_at" : "updated_at";
  const direction = opts.direction ?? "desc";
  const states = gitlabStateParams(opts.kind, opts.state);
  const combinedClosed = states.length > 1;

  const buildUrl = (stateParam: string, sourcePage: number): string => {
    const url = new URL(`${apiBase}/projects/${projectId}/${endpoint}`);
    // "all" is expressed by omitting `state` — the MR list documents
    // `state=all` but the issues list doesn't, and omission means "all"
    // uniformly on both endpoints.
    if (stateParam !== "all") url.searchParams.set("state", stateParam);
    url.searchParams.set("per_page", String(GITLAB_PER_PAGE));
    url.searchParams.set("page", String(sourcePage));
    url.searchParams.set("order_by", orderBy);
    url.searchParams.set("sort", direction);
    const query = opts.query?.trim();
    if (query) url.searchParams.set("search", query);
    if (opts.labels && opts.labels.length > 0) url.searchParams.set("labels", opts.labels.join(","));
    const assignee = opts.assignee?.trim();
    if (assignee) url.searchParams.set("assignee_username", assignee);
    // `scope` is a single value on the wire — priority when more than one
    // involvement filter is set: createdByMe, then assignedToMe, then
    // reviewRequested (MRs only).
    if (opts.createdByMe) url.searchParams.set("scope", "created_by_me");
    else if (opts.assignedToMe) url.searchParams.set("scope", "assigned_to_me");
    else if (opts.reviewRequested && opts.kind === "pulls") url.searchParams.set("scope", "reviews_for_me");
    return url.toString();
  };

  const items: GitHubListItem[] = [];
  let hasMore = false;
  for (const stateParam of states) {
    const sourcePage = combinedClosed ? 1 : page;
    const url = buildUrl(stateParam, sourcePage);
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!token) };
    if (!Array.isArray(body)) return { ok: false, error: "GitLab returned an unexpected response" };
    for (const raw of body) items.push(...([normalizeItem(opts.kind, raw)].filter((x): x is GitHubListItem => !!x)));
    if (!combinedClosed) hasMore = resolveNextPage(res, url) != null;
  }

  if (combinedClosed) sortItems(items, opts.sort, direction);
  const sliced = combinedClosed ? items.slice(0, GITLAB_PER_PAGE) : items;

  return {
    ok: true,
    repo: `${repo.owner}/${repo.name}`,
    webUrl: `https://${gitlabHost(repo)}/${repo.owner}/${repo.name}`,
    auth: token ? "token" : "none",
    items: sliced,
    page,
    hasMore: combinedClosed ? false : hasMore,
    // GitLab's rate-limit headers (`RateLimit-*`) don't carry GitHub's
    // remaining/limit/resource triple in a directly comparable shape — no
    // rate-limit UI is shown for non-GitHub providers (see PROVIDER_CAPS).
    rateLimit: null,
  };
}

/** Matches `getGitHubPullDefaults`'s `{repo, head, base}` shape. `base` comes
 *  from `GET /projects/:id`'s `default_branch`. `head` (the branch that would
 *  be pushed) can't be resolved here: `getGitHubPullDefaults`'s `head` comes
 *  from shelling out to `git branch --show-current` in the project's working
 *  directory, but this adapter only ever receives a resolved `ProviderRepoInfo`
 *  (no `dir`) — per the plan, adapters never call git themselves. `head` is
 *  returned as `""` (rather than omitted, since the shared result type
 *  requires it) and the facade (`git-host.ts`, T4) is expected to fill it in
 *  from the local git branch itself, the same way it must for `dir`-derived
 *  fields on every other GitLab call. */
export async function getGitLabPullDefaults(repo: ProviderRepoInfo): Promise<GitLabPullDefaultsResponse> {
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}`, token);
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!token) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const base = typeof obj.default_branch === "string" ? obj.default_branch : "main";
  return { ok: true, repo: `${repo.owner}/${repo.name}`, head: "", base };
}

export interface CreateGitLabPullInput {
  title: string;
  body?: string;
  base: string;
  head: string;
  draft?: boolean;
}

/** Matches `createGitHubPull`'s `GitHubIssueResponse` shape. GitLab has no
 *  reviewer field on this endpoint — reviewer assignment isn't part of the
 *  plan's core subset for GitLab (`reviewRequestedFilter` reads MR reviewers
 *  set some other way, e.g. the GitLab UI or a separate call not wired up
 *  here). `draft: true` prefixes the title with `"Draft: "`, GitLab's own
 *  draft convention (the same one its web UI uses; there's no separate
 *  boolean field on create). */
export async function createGitLabPull(repo: ProviderRepoInfo, input: CreateGitLabPullInput): Promise<GitLabIssueResponse> {
  const title = input.title.trim();
  const head = input.head.trim();
  const base = input.base.trim();
  if (!title) return { ok: false, error: "merge request title required" };
  if (!head) return { ok: false, error: "head branch required" };
  if (!base) return { ok: false, error: "base branch required" };

  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to create a merge request" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const finalTitle = input.draft ? `Draft: ${title}` : title;
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests`, token, {
    method: "POST",
    body: JSON.stringify({
      title: finalTitle,
      ...(input.body?.trim() ? { description: input.body.trim() } : {}),
      source_branch: head,
      target_branch: base,
    }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!token) };
  const item = normalizeItem("pulls", json);
  if (!item) return { ok: false, error: "GitLab returned an unexpected merge request response" };
  return { ok: true, item, message: "Merge request created." };
}

/** Matches `getGitHubPullDiff`'s `GitHubDiffResponse` shape, including the 8MB
 *  size cap (checked via `content-length` first, then a byte-accurate
 *  fallback) and `parseGitDiff` (git-diff.ts) for the raw unified diff.
 *  `raw_diffs` is GitLab's stable, generally-available raw-diff endpoint
 *  (the structured `/diffs` endpoint is intentionally NOT used — the plan
 *  calls for keeping this adapter on the same raw-unified-diff parse path
 *  Bitbucket's `/diff` and GitHub's `.diff` media type both go through). */
export async function getGitLabPullDiff(repo: ProviderRepoInfo, number: number): Promise<GitLabDiffResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(
    `${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/raw_diffs`,
    token,
    { accept: "text/plain" },
  );
  if (!("status" in res)) return res;
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > GITLAB_DIFF_BODY_CAP_BYTES) {
    return { ok: false, error: `Merge request diff is too large to display in Agetor (${Math.ceil(contentLength / 1_000_000)} MB).` };
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string") msg = parsed.message;
    } catch { /* raw_diffs returns plain text on success, JSON on error */ }
    return { ok: false, error: msg || `${res.status} ${res.statusText}` };
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > GITLAB_DIFF_BODY_CAP_BYTES) {
    return { ok: false, error: `Merge request diff is too large to display in Agetor (${Math.ceil(bodyBytes / 1_000_000)} MB).` };
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
    note: files.length === 0 ? "No diff returned for this merge request." : undefined,
  };
}

/** Structurally identical to `git-host.ts`'s `PullBlobResult` — kept as a
 *  separate declaration (rather than imported) for the same reason
 *  `github.ts`'s `GitHubBlobResult` is: `git-host.ts` is the consumer, not
 *  the source, of this module's types, and TS's structural typing makes the
 *  two interchangeable at the `pullBlob` dispatch call site. */
type GitLabBlobResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; contentType: string; ref: string }
  | { ok: false; error: string; status?: number };

interface GitLabPullBlobDetailCacheEntry {
  baseSha: string;
  headSha: string;
  /** Numeric project ids, present whenever GitLab reports them as numbers.
   *  `null` means "couldn't confirm" — treated as same-repo (fails closed to
   *  the project we already have an owner/name slug for, not to an
   *  unconfirmed numeric id). */
  sourceProjectId: number | null;
  targetProjectId: number | null;
  fetchedAt: number;
}

/** Short-TTL cache of an MR's resolved base/head sha + source/target project
 *  ids, keyed `${remoteHost}/${owner}/${name}#${number}` — mirrors
 *  github.ts's `pullDetailCache` exactly (60s TTL, 200-entry wholesale-clear
 *  eviction) so paging through a binary file's old/new sides, or several
 *  files in the same MR, doesn't re-fetch `GET /merge_requests/:iid` (and
 *  possibly `/versions`) on every blob request. */
const pullBlobDetailCache = new Map<string, GitLabPullBlobDetailCacheEntry>();
const PULL_BLOB_DETAIL_CACHE_LIMIT = 200;
const PULL_BLOB_DETAIL_CACHE_TTL_MS = 60_000;

function cachePullBlobDetail(key: string, entry: GitLabPullBlobDetailCacheEntry): void {
  if (pullBlobDetailCache.size >= PULL_BLOB_DETAIL_CACHE_LIMIT && !pullBlobDetailCache.has(key)) {
    pullBlobDetailCache.clear();
  }
  pullBlobDetailCache.set(key, entry);
}

/** Test-only: clears `pullBlobDetailCache`. bun test shares a process across
 *  files, so a test that primes the cache (e.g. git-host.test.ts's happy-path
 *  pull-blob test) would otherwise leak a stale entry into a later network
 *  test in this module — network tests should call this from `beforeEach`. */
function resetGitLabPullBlobCaches(): void {
  pullBlobDetailCache.clear();
}

/** Content-type for a binary diff preview, from the shared canonical
 *  extension→MIME map — mirrors github.ts's `contentTypeForBlobPath`. Pure —
 *  unit-tested via `__gitlabInternals`. */
function contentTypeForGitLabBlobPath(path: string, fallback: string | null): string {
  return contentTypeForPreviewPath(path) ?? fallback ?? "application/octet-stream";
}

/** Fetches the raw bytes of a single file from one side (old/new) of a
 *  GitLab merge request's diff, for the binary-preview UI. Dispatched
 *  through `git-host.ts`'s `pullBlob`.
 *
 *  - `side: "old"` reads the file at `diff_refs.base_sha` — GitLab's own
 *    merge-base sha (unlike GitHub's `base.sha`, this one doesn't drift once
 *    the base branch moves, so no separate compare round-trip is needed) —
 *    from the *target* project (`repo.owner`/`repo.name`).
 *  - `side: "new"` reads the file at `diff_refs.head_sha`, from the *source*
 *    project — the target project for a same-repo MR, or the fork's numeric
 *    `source_project_id` for a cross-repo one (GitLab's MR payload carries no
 *    owner/name for the source project, only its numeric id).
 *
 *  `diff_refs` populates asynchronously right after an MR is created/pushed
 *  to, so a missing/incomplete `diff_refs` falls back to the latest diff
 *  "version" (`GET .../versions`) the same way `createGitLabPullLineComment`
 *  does. The resolved tuple is cached — see `pullBlobDetailCache`.
 *
 *  Bytes come from the repository-files raw endpoint (`GET
 *  /projects/:id/repository/files/:path/raw?ref=<sha>`), requested with a
 *  permissive `accept` (`fetchGitLab` defaults to `application/json`, which
 *  would be wrong for arbitrary binary bytes). Size is checked twice: from
 *  `content-length` before reading the body, and again against the actual
 *  byte count after `arrayBuffer()` (a chunked response can omit
 *  `content-length`) — matching `MAX_BLOB_PREVIEW_BYTES`, not the 8MB diff
 *  cap `getGitLabPullDiff` uses. */
export async function getGitLabPullBlob(
  repo: ProviderRepoInfo,
  number: number,
  relPath: string,
  side: "old" | "new",
): Promise<GitLabBlobResult> {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, error: "merge request number must be positive", status: 400 };
  }
  const path = relPath.trim().replace(/^\/+/, "");
  if (!path) return { ok: false, error: "file path is required", status: 400 };

  const token = await gitlabToken(repo.remoteHost);
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const detailKey = `${repo.remoteHost}/${repo.owner}/${repo.name}#${number}`;

  const cached = pullBlobDetailCache.get(detailKey);
  let baseSha: string;
  let headSha: string;
  let sourceProjectId: number | null;
  let targetProjectId: number | null;

  if (cached && Date.now() - cached.fetchedAt < PULL_BLOB_DETAIL_CACHE_TTL_MS) {
    ({ baseSha, headSha, sourceProjectId, targetProjectId } = cached);
  } else {
    const mrRes = await fetchGitLab(`${apiBase}/projects/${projectId}/merge_requests/${number}`, token);
    if (!("status" in mrRes)) return { ok: false, error: mrRes.error, status: 502 };
    const mrJson = await mrRes.json().catch(() => null);
    if (!mrRes.ok) {
      return mrRes.status === 404
        ? { ok: false, error: "merge request not found", status: 404 }
        : { ok: false, error: errorFrom(mrRes, mrJson, repo, !!token), status: mrRes.status };
    }
    const obj = mrJson && typeof mrJson === "object" ? mrJson as Record<string, unknown> : {};
    const diffRefs = obj.diff_refs && typeof obj.diff_refs === "object" ? obj.diff_refs as Record<string, unknown> : null;
    let resolvedBaseSha = diffRefs && typeof diffRefs.base_sha === "string" ? diffRefs.base_sha : null;
    let resolvedHeadSha = diffRefs && typeof diffRefs.head_sha === "string" ? diffRefs.head_sha : null;
    const resolvedSourceProjectId = typeof obj.source_project_id === "number" ? obj.source_project_id : null;
    const resolvedTargetProjectId = typeof obj.target_project_id === "number" ? obj.target_project_id : null;

    if (!resolvedBaseSha || !resolvedHeadSha) {
      // diff_refs populates async after the MR is created/pushed to — fall
      // back to the latest diff version, same as createGitLabPullLineComment.
      const versionsRes = await fetchGitLab(`${apiBase}/projects/${projectId}/merge_requests/${number}/versions`, token);
      if (!("status" in versionsRes)) return { ok: false, error: versionsRes.error, status: 502 };
      const versions = await versionsRes.json().catch(() => null);
      if (!versionsRes.ok) {
        return { ok: false, error: errorFrom(versionsRes, versions, repo, !!token), status: versionsRes.status };
      }
      const latest = Array.isArray(versions) && versions.length > 0 ? versions[0] as Record<string, unknown> : null;
      resolvedBaseSha = latest && typeof latest.base_commit_sha === "string" ? latest.base_commit_sha : null;
      resolvedHeadSha = latest && typeof latest.head_commit_sha === "string" ? latest.head_commit_sha : null;
      if (!resolvedBaseSha || !resolvedHeadSha) {
        return { ok: false, error: "GitLab returned no base/head commit for this merge request", status: 502 };
      }
    }

    baseSha = resolvedBaseSha;
    headSha = resolvedHeadSha;
    sourceProjectId = resolvedSourceProjectId;
    targetProjectId = resolvedTargetProjectId;
    cachePullBlobDetail(detailKey, { baseSha, headSha, sourceProjectId, targetProjectId, fetchedAt: Date.now() });
  }

  let ref: string;
  let blobProjectId: string;
  let isFork = false;
  if (side === "new") {
    ref = headSha;
    // Fail closed to the target project (the one we have an owner/name slug
    // for) unless both ids are confirmed numbers and actually differ — an
    // unconfirmed id is not a safe basis for routing to a different project.
    isFork = sourceProjectId !== null && targetProjectId !== null && sourceProjectId !== targetProjectId;
    blobProjectId = isFork ? String(sourceProjectId) : projectId;
  } else {
    ref = baseSha;
    blobProjectId = projectId;
  }

  const buildFileUrl = (pid: string): string =>
    `${apiBase}/projects/${pid}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;

  let fileRes = await fetchGitLab(buildFileUrl(blobProjectId), token, { accept: "*/*" });
  if (!("status" in fileRes)) return { ok: false, error: fileRes.error, status: 502 };
  if (fileRes.status === 404 && side === "new" && isFork) {
    // A private/deleted fork can 404 on its own numeric project id even
    // though the MR's head commit is still reachable — GitLab keeps a
    // cross-project MR's head commit available in the *target* project via
    // `refs/merge-requests/:iid/head`, so a same-`headSha` read against the
    // target project usually succeeds where the fork read failed. Retry
    // exactly once before giving up.
    fileRes = await fetchGitLab(buildFileUrl(projectId), token, { accept: "*/*" });
    if (!("status" in fileRes)) return { ok: false, error: fileRes.error, status: 502 };
  }
  if (fileRes.status === 404) return { ok: false, error: "file not present on this side", status: 404 };
  if (!fileRes.ok) {
    const raw = await fileRes.text().catch(() => "");
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === "string") msg = parsed.message;
    } catch { /* raw-file error bodies are sometimes plain text */ }
    return { ok: false, error: authHint(fileRes.status, msg || `${fileRes.status} ${fileRes.statusText}`, repo, !!token), status: fileRes.status };
  }

  const contentLength = Number(fileRes.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BLOB_PREVIEW_BYTES) {
    return { ok: false, error: `File is too large to preview (${Math.ceil(contentLength / 1_000_000)} MB).`, status: 413 };
  }
  const buf = await fileRes.arrayBuffer().catch(() => null);
  if (!buf) return { ok: false, error: "GitLab returned an unreadable file response", status: 502 };
  if (buf.byteLength > MAX_BLOB_PREVIEW_BYTES) {
    return { ok: false, error: `File is too large to preview (${Math.ceil(buf.byteLength / 1_000_000)} MB).`, status: 413 };
  }

  return {
    ok: true,
    bytes: new Uint8Array(buf),
    contentType: contentTypeForGitLabBlobPath(path, fileRes.headers.get("content-type")),
    ref,
  };
}

/** Matches `listGitHubComments`'s `GitHubCommentsResponse` shape. Uses the
 *  notes API (`sort=asc&order_by=created_at`, chronological — matching
 *  GitHub's own comment ordering) and **skips system notes** (`system: true`
 *  — GitLab posts automated notes for label/assignee/milestone changes etc.
 *  into the same notes stream; GitHub has no equivalent noise in its
 *  `/issues/:n/comments` endpoint, so filtering keeps the two providers'
 *  comment lists comparable). */
export async function listGitLabComments(repo: ProviderRepoInfo, number: number, kind: GitHubItemKind): Promise<GitLabCommentsResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "item number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const endpoint = kind === "pulls" ? "merge_requests" : "issues";
  const comments: GitHubComment[] = [];
  let url: string | null = `${gitlabApiBase(repo)}/projects/${projectId}/${endpoint}/${number}/notes?sort=asc&order_by=created_at&per_page=100`;
  for (let page = 0; url && page < 5; page++) {
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!token) };
    if (!Array.isArray(body)) return { ok: false, error: "GitLab returned an unexpected notes response" };
    for (const raw of body) {
      if (raw && typeof raw === "object" && (raw as Record<string, unknown>).system === true) continue;
      const comment = normalizeComment(raw, repo, kind, number);
      if (comment) comments.push(comment);
    }
    url = resolveNextPage(res, url);
  }
  return { ok: true, repo: `${repo.owner}/${repo.name}`, itemNumber: number, comments };
}

export async function createGitLabComment(repo: ProviderRepoInfo, number: number, kind: GitHubItemKind, body: string): Promise<GitLabCommentResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "item number must be positive" };
  const text = body.trim();
  if (!text) return { ok: false, error: "comment body required" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to comment" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const endpoint = kind === "pulls" ? "merge_requests" : "issues";
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/${endpoint}/${number}/notes`, token, {
    method: "POST",
    body: JSON.stringify({ body: text }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const comment = normalizeComment(json, repo, kind, number);
  if (!comment) return { ok: false, error: "GitLab returned an unexpected comment response" };
  return { ok: true, comment };
}

/** Matches `listGitHubPullReviewComments`'s shape. GitLab's inline comments
 *  live inside "discussions" (each a thread of one or more notes); only notes
 *  with `type === "DiffNote"` are inline/positioned (a discussion can also
 *  hold plain top-level notes) so everything else is skipped. Each matching
 *  note is flattened into its own `GitHubPullLineComment` — see
 *  `normalizeLineComment`'s doc comment for why no discussion-id/thread field
 *  is carried (the shared type has no slot for it, matching github.ts's own
 *  comment shape). */
export async function listGitLabPullReviewComments(repo: ProviderRepoInfo, number: number): Promise<GitLabPullReviewCommentsResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const comments: GitHubPullLineComment[] = [];
  let url: string | null = `${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/discussions?per_page=100`;
  for (let page = 0; url && page < 5; page++) {
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!token) };
    if (!Array.isArray(body)) return { ok: false, error: "GitLab returned an unexpected discussions response" };
    for (const discussion of body) {
      if (!discussion || typeof discussion !== "object") continue;
      const notes = (discussion as Record<string, unknown>).notes;
      if (!Array.isArray(notes)) continue;
      for (const raw of notes) {
        if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).type !== "DiffNote") continue;
        const comment = normalizeLineComment(raw, repo, number);
        if (comment) comments.push(comment);
      }
    }
    url = resolveNextPage(res, url);
  }
  return { ok: true, repo: `${repo.owner}/${repo.name}`, pullNumber: number, comments };
}

export interface CreateGitLabPullLineCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Matches `createGitHubPullLineComment`'s shape. GitLab positions an inline
 *  discussion against three SHAs (`base_sha`/`start_sha`/`head_sha`) rather
 *  than a single commit id — those come from the merge request's latest diff
 *  "version" (`GET .../versions`, newest first), fetched here first. */
export async function createGitLabPullLineComment(
  repo: ProviderRepoInfo,
  number: number,
  input: CreateGitLabPullLineCommentInput,
): Promise<GitLabPullLineCommentResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const body = input.body.trim();
  const path = input.path.trim();
  if (!body) return { ok: false, error: "comment body required" };
  if (!path) return { ok: false, error: "comment path required" };
  if (!Number.isInteger(input.line) || input.line <= 0) return { ok: false, error: "comment line must be positive" };
  if (input.side !== "LEFT" && input.side !== "RIGHT") return { ok: false, error: "comment side must be LEFT or RIGHT" };

  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to comment on a line" };
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);

  const versionsRes = await fetchGitLab(`${apiBase}/projects/${projectId}/merge_requests/${number}/versions`, token);
  if (!("status" in versionsRes)) return versionsRes;
  const versions = await versionsRes.json().catch(() => null);
  if (!versionsRes.ok) return { ok: false, error: errorFrom(versionsRes, versions, repo, !!token) };
  const latest = Array.isArray(versions) && versions.length > 0 ? versions[0] as Record<string, unknown> : null;
  if (
    !latest
    || typeof latest.base_commit_sha !== "string"
    || typeof latest.start_commit_sha !== "string"
    || typeof latest.head_commit_sha !== "string"
  ) {
    return { ok: false, error: "GitLab returned no diff versions for this merge request" };
  }

  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: latest.base_commit_sha,
    start_sha: latest.start_commit_sha,
    head_sha: latest.head_commit_sha,
    new_path: path,
    old_path: path,
  };
  if (input.side === "RIGHT") position.new_line = input.line;
  else position.old_line = input.line;

  const res = await fetchGitLab(`${apiBase}/projects/${projectId}/merge_requests/${number}/discussions`, token, {
    method: "POST",
    body: JSON.stringify({ body, position }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const notes = json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).notes)
    ? (json as Record<string, unknown>).notes as unknown[]
    : [];
  const comment = normalizeLineComment(notes[0], repo, number);
  if (!comment) return { ok: false, error: "GitLab returned an unexpected line comment response" };
  return { ok: true, comment };
}

/** Finds the discussion id containing note `noteId` — needed because GitLab's
 *  reply endpoint is `POST .../discussions/:discussion_id/notes`, addressed
 *  by discussion, not by the note being replied to. The shared reply
 *  signature (mirroring `replyGitHubPullLineComment`) only carries a comment
 *  id, so this does the extra discussions round-trip documented in the plan. */
async function findDiscussionIdForNote(
  repo: ProviderRepoInfo,
  number: number,
  noteId: number,
  token: string | null,
): Promise<{ ok: true; id: string | null } | GitLabError> {
  const projectId = encodeProjectId(repo.owner, repo.name);
  let url: string | null = `${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/discussions?per_page=100`;
  for (let page = 0; url && page < 5; page++) {
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!token) };
    if (!Array.isArray(body)) return { ok: false, error: "GitLab returned an unexpected discussions response" };
    for (const discussion of body) {
      if (!discussion || typeof discussion !== "object") continue;
      const obj = discussion as Record<string, unknown>;
      const notes = Array.isArray(obj.notes) ? obj.notes : [];
      const found = notes.some((n) => n && typeof n === "object" && (n as Record<string, unknown>).id === noteId);
      if (found) return { ok: true, id: typeof obj.id === "string" ? obj.id : null };
    }
    url = resolveNextPage(res, url);
  }
  return { ok: true, id: null };
}

export async function replyGitLabLineComment(repo: ProviderRepoInfo, number: number, commentId: number, body: string): Promise<GitLabPullLineCommentResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  if (!Number.isInteger(commentId) || commentId <= 0) return { ok: false, error: "review comment id must be positive" };
  const text = body.trim();
  if (!text) return { ok: false, error: "reply body required" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to reply" };
  const projectId = encodeProjectId(repo.owner, repo.name);

  const discussion = await findDiscussionIdForNote(repo, number, commentId, token);
  if (!discussion.ok) return discussion;
  if (!discussion.id) return { ok: false, error: "Could not find the discussion for that comment." };

  const res = await fetchGitLab(
    `${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/discussions/${discussion.id}/notes`,
    token,
    { method: "POST", body: JSON.stringify({ body: text }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const comment = normalizeLineComment(json, repo, number);
  if (!comment) return { ok: false, error: "GitLab returned an unexpected reply response" };
  return { ok: true, comment };
}

function pickString(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? (obj[key] as string) : "";
}

/** Maps GitLab's MR merge-status fields onto GitHub's `mergeableState`
 *  vocabulary (`clean|dirty|behind|blocked|unstable|draft|unknown`). Prefers
 *  the newer `detailed_merge_status` (GitLab 15.6+) when it's a recognized
 *  value; falls back to the coarser `merge_status`/`has_conflicts` pair for
 *  older instances or an unrecognized/missing `detailed_merge_status`. Pure —
 *  unit-tested via `__gitlabInternals`. */
function mapMergeableState(obj: Record<string, unknown>): string {
  const detailed = typeof obj.detailed_merge_status === "string" ? obj.detailed_merge_status : "";
  switch (detailed) {
    case "conflict": return "dirty";
    case "mergeable": return "clean";
    case "need_rebase": return "behind";
    case "draft_status": return "draft";
    case "ci_still_running": return "unstable";
    case "blocked_status":
    case "discussions_not_resolved":
    case "not_approved":
    case "external_status_checks":
    case "ci_must_pass":
    case "status_checks_must_pass":
    case "requested_changes":
    case "jira_association_missing":
    case "security_policy_violations":
    case "locked_paths":
    case "broken_status":
      return "blocked";
    case "unchecked":
    case "checking":
    case "preparing":
    case "approvals_syncing":
    case "not_open":
      return "unknown";
  }
  // A present-but-unrecognized `detailed_merge_status` is fail-safe: don't
  // fall through to the coarser `merge_status`/`has_conflicts` pair, which
  // could report "clean" on a status this code doesn't understand yet.
  if (detailed !== "") return "blocked";
  if (obj.has_conflicts === true) return "dirty";
  const mergeStatus = typeof obj.merge_status === "string" ? obj.merge_status : "";
  if (mergeStatus === "can_be_merged") return "clean";
  if (mergeStatus === "cannot_be_merged") return "dirty";
  return "unknown";
}

/** `mergeable` boolean for a given `mergeableState`: `dirty`/`clean`/`unknown`
 *  map directly; the remaining states (`behind`/`blocked`/`unstable`/`draft`)
 *  don't imply a verdict on their own, so `has_conflicts` (when GitLab
 *  actually reports it as a boolean) is used as the best available signal. */
function computeMergeable(mergeableState: string, obj: Record<string, unknown>): boolean | null {
  if (mergeableState === "dirty") return false;
  if (mergeableState === "clean") return true;
  if (mergeableState === "unknown") return null;
  return typeof obj.has_conflicts === "boolean" ? !obj.has_conflicts : null;
}

/** Maps a GitLab MR detail payload (`GET /merge_requests/:iid`) onto
 *  `GitHubPullMergeability` — see `mapMergeableState`/`computeMergeable` for
 *  the vocabulary mapping. GitLab's MR payload doesn't carry the source
 *  project's path (only its numeric id), so `headRepo` reports the repo
 *  itself for a same-repo MR and `null` for a cross-repo (fork) one — there's
 *  no owner/name to report in the fork case. Exported (rather than folded
 *  into `__gitlabInternals` like the other pure normalizers) so tests can
 *  exercise it directly. */
export function normalizeGitLabMergeability(repo: ProviderRepoInfo, number: number, mr: unknown): GitHubPullMergeability | null {
  if (!mr || typeof mr !== "object") return null;
  const obj = mr as Record<string, unknown>;
  const mergeableState = mapMergeableState(obj);
  const diffRefs = obj.diff_refs && typeof obj.diff_refs === "object" ? obj.diff_refs as Record<string, unknown> : null;
  const headSha = (diffRefs ? pickString(diffRefs, "head_sha") : "") || pickString(obj, "sha");
  const sourceProjectId = obj.source_project_id;
  const targetProjectId = obj.target_project_id;
  // Fail closed: only a confirmed same-numeric-id match is same-repo. Missing
  // or non-numeric ids (can't confirm) are treated as cross-repo, matching
  // github.ts's normalizeMergeability contract.
  const crossRepo = typeof sourceProjectId !== "number" || typeof targetProjectId !== "number" || sourceProjectId !== targetProjectId;
  const repoSlug = `${repo.owner}/${repo.name}`;
  const merged = obj.state === "merged";
  const state = obj.state === "opened" ? "open" : merged ? "merged" : (obj.state === "closed" || obj.state === "locked") ? "closed" : "unknown";
  return {
    repo: repoSlug,
    pullNumber: number,
    mergeable: computeMergeable(mergeableState, obj),
    mergeableState,
    rebaseable: null,
    merged,
    draft: obj.draft === true || obj.work_in_progress === true,
    state,
    headRef: pickString(obj, "source_branch"),
    baseRef: pickString(obj, "target_branch"),
    headSha,
    // `merge_when_pipeline_succeeds` is GitLab's counterpart to GitHub's
    // `auto_merge` — true once the "merge when pipeline succeeds" toggle is on.
    autoMerge: obj.merge_when_pipeline_succeeds === true,
    headRepo: crossRepo ? null : repoSlug,
    crossRepo,
  };
}

/** Matches `getGitHubPullMergeability`'s shape and polling behavior. GitLab
 *  also computes mergeability asynchronously (`detailed_merge_status:
 *  "unchecked"`/`"checking"` right after a push) — poll up to 3 times,
 *  1.2s apart, stopping early once the verdict settles (merged, a resolved
 *  `mergeable`, or any `mergeableState` other than `"unknown"`). Always
 *  returns the last successful parse even if it's still unresolved; only
 *  `ok:false` when every fetch attempt failed. */
export async function getGitLabPullMergeability(repo: ProviderRepoInfo, number: number): Promise<GitLabMergeabilityResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const url = `${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}`;

  let last: GitHubPullMergeability | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_200));
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!token) };
    const parsed = normalizeGitLabMergeability(repo, number, json);
    if (!parsed) return { ok: false, error: "GitLab returned an unexpected merge request response" };
    last = parsed;
    if (parsed.merged || parsed.mergeable !== null || parsed.mergeableState !== "unknown") break;
  }
  return last ? { ok: true, ...last } : { ok: false, error: "GitLab did not return mergeability for this merge request" };
}

/** Matches `getGitHubPullChecks`'s shape. GitLab has no single "check-runs"
 *  API — the closest equivalents are (1) per-job commit statuses (`GET
 *  /projects/:id/repository/commits/:sha/statuses`, populated when CI posts
 *  granular per-job statuses) and (2) the MR's own pipeline object. When the
 *  commit has zero individual statuses (some projects only surface the
 *  pipeline as a whole), the pipeline itself is added as a single synthetic
 *  check-run entry named `"pipeline #<id>"` so the UI still shows *something*
 *  rather than an empty checks panel. */
export async function getGitLabPullChecks(repo: ProviderRepoInfo, number: number): Promise<GitLabChecksResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);

  const mrRes = await fetchGitLab(`${apiBase}/projects/${projectId}/merge_requests/${number}`, token);
  if (!("status" in mrRes)) return mrRes;
  const mr = await mrRes.json().catch(() => null);
  if (!mrRes.ok) return { ok: false, error: errorFrom(mrRes, mr, repo, !!token) };
  const obj = mr && typeof mr === "object" ? mr as Record<string, unknown> : {};
  const sha = typeof obj.sha === "string" ? obj.sha : "";
  if (!sha) return { ok: false, error: "GitLab returned a merge request without a head sha" };
  const pipeline = obj.head_pipeline && typeof obj.head_pipeline === "object" ? obj.head_pipeline as Record<string, unknown> : null;

  const statusesRes = await fetchGitLab(`${apiBase}/projects/${projectId}/repository/commits/${sha}/statuses?per_page=100`, token);
  if (!("status" in statusesRes)) return statusesRes;
  const statuses = await statusesRes.json().catch(() => null);
  if (!statusesRes.ok) return { ok: false, error: errorFrom(statusesRes, statuses, repo, !!token) };
  const rawStatuses = Array.isArray(statuses) ? statuses : [];
  const checkRuns = rawStatuses.map(normalizeCommitStatusAsCheckRun).filter((x): x is GitHubCheckRun => !!x);

  if (checkRuns.length === 0 && pipeline) {
    const pipelineRun = normalizePipelineAsCheckRun(pipeline);
    if (pipelineRun) checkRuns.push(pipelineRun);
  }

  return { ok: true, repo: `${repo.owner}/${repo.name}`, pullNumber: number, sha, checkRuns };
}

/** Matches `getGitHubPullDetail`'s shape — a single merge request by number,
 *  normalized through the same `normalizeItem` mapper `closeGitLabPull` /
 *  `reopenGitLabPull` use. */
export async function getGitLabPullDetail(repo: ProviderRepoInfo, number: number): Promise<GitLabIssueResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}`, token);
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!token) };
  const item = normalizeItem("pulls", json);
  if (!item) return { ok: false, error: "GitLab returned an unexpected merge request response" };
  return { ok: true, item };
}

/** Matches `mergeGitHubPull`'s shape. GitLab's `merge_strategy`/merge-method
 *  vocabulary is squash-or-not (`squash: boolean`) rather than GitHub's
 *  named strategies — `PROVIDER_CAPS.gitlab.mergeMethods` only ever offers
 *  `"merge"`/`"squash"` to the UI for this provider, so `"rebase"` should
 *  never reach here; it's still rejected defensively. */
export async function mergeGitLabPull(repo: ProviderRepoInfo, number: number, method: GitHubPullMergeMethod): Promise<GitLabPullMergeResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  if (method !== "merge" && method !== "squash") {
    return { ok: false, error: "GitLab only supports merge or squash merge methods" };
  }
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to merge" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/merge`, token, {
    method: "PUT",
    body: JSON.stringify({ squash: method === "squash" }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // 405 = "not mergeable right now" (pipeline/approval/conflict gate);
    // 409 = a concurrent update changed the MR underneath this request.
    // GitLab's own messages for both are terse REST-speak — friendlier copy.
    const msg = res.status === 405
      ? "This merge request cannot be merged right now (check pipeline status and approvals)."
      : res.status === 409
        ? "This merge request was updated concurrently — refresh and try again."
        : apiError(json, res.status, res.statusText);
    return { ok: false, error: msg };
  }
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const state = typeof obj.state === "string" ? obj.state : "";
  return {
    ok: true,
    merged: state === "merged",
    sha: typeof obj.merge_commit_sha === "string" ? obj.merge_commit_sha : (typeof obj.sha === "string" ? obj.sha : null),
    message: "Merge request merged.",
  };
}

/** Matches `closeGitHubPull`'s `GitHubActionResponse` shape (no comment
 *  parameter — the plan's core subset doesn't wire a close-with-comment
 *  convenience for GitLab; callers wanting a comment can `createGitLabComment`
 *  separately, same as any other note). */
export async function closeGitLabPull(repo: ProviderRepoInfo, number: number): Promise<GitLabActionResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to close a merge request" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}`, token, {
    method: "PUT",
    body: JSON.stringify({ state_event: "close" }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("pulls", json);
  return { ok: true, message: "Merge request closed.", ...(item ? { item } : {}) };
}

/** Matches `reopenGitHubPull`'s `GitHubIssueResponse` shape. */
export async function reopenGitLabPull(repo: ProviderRepoInfo, number: number): Promise<GitLabIssueResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to reopen a merge request" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}`, token, {
    method: "PUT",
    body: JSON.stringify({ state_event: "reopen" }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("pulls", json);
  if (!item) return { ok: false, error: "GitLab returned an unexpected merge request response" };
  return { ok: true, item, message: "Merge request reopened." };
}

/** Matches `reviewGitHubPull`'s `GitHubActionResponse` shape, restricted to
 *  what GitLab supports: `APPROVE` (`POST .../approve`, optionally followed
 *  by a plain note when `body` is set) and `COMMENT` (a plain note, no
 *  approval state change). `REQUEST_CHANGES` has no GitLab equivalent — MRs
 *  have no "changes requested" review state — so it's rejected up front;
 *  `PROVIDER_CAPS.gitlab.requestChanges: false` is what keeps the UI from
 *  ever sending it, this is defense-in-depth. */
export async function reviewGitLabPull(repo: ProviderRepoInfo, number: number, verdict: GitHubPullReviewEvent, body?: string): Promise<GitLabActionResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "merge request number must be positive" };
  if (verdict === "REQUEST_CHANGES") {
    return { ok: false, error: "Requesting changes is not supported on GitLab merge requests." };
  }
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to review" };
  const projectId = encodeProjectId(repo.owner, repo.name);
  const text = body?.trim() ?? "";

  if (verdict === "APPROVE") {
    const res = await fetchGitLab(`${gitlabApiBase(repo)}/projects/${projectId}/merge_requests/${number}/approve`, token, {
      method: "POST",
      body: "{}",
    });
    if (!("status" in res)) return res;
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
    if (!text) return { ok: true, message: "Merge request approved." };
    const noteResult = await createGitLabComment(repo, number, "pulls", text);
    if (!noteResult.ok) {
      return { ok: true, message: `Merge request approved, but the comment was not posted: ${noteResult.error}`, commentPosted: false };
    }
    return { ok: true, message: "Merge request approved and comment posted.", commentPosted: true };
  }

  // COMMENT — a plain note, no approval state change.
  if (!text) return { ok: false, error: "review comment body required" };
  const noteResult = await createGitLabComment(repo, number, "pulls", text);
  if (!noteResult.ok) return noteResult;
  return { ok: true, message: "Review comment submitted." };
}

/** Resolves each username to a GitLab user id via `GET /projects/:id/users?search=`
 *  — GitLab's issue create/update endpoints only accept `assignee_ids`, never
 *  usernames. Best-effort: a username with no exact match (typo, not a member
 *  of the project) is silently dropped rather than failing the whole request,
 *  per the plan's decision — the alternative (rejecting the entire
 *  create/update over one bad assignee) is worse UX for a field the user
 *  likely won't double-check immediately. */
async function resolveAssigneeIds(apiBase: string, projectId: string, usernames: string[], token: string | null): Promise<number[]> {
  const trimmed = usernames.map((s) => s.trim()).filter(Boolean);
  if (trimmed.length === 0) return [];
  const ids: number[] = [];
  for (const username of trimmed) {
    const res = await fetchGitLab(`${apiBase}/projects/${projectId}/users?search=${encodeURIComponent(username)}`, token);
    if (!("status" in res) || !res.ok) continue;
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) continue;
    const match = body.find((u) => u && typeof u === "object" && (u as Record<string, unknown>).username === username);
    if (match && typeof (match as Record<string, unknown>).id === "number") ids.push((match as Record<string, unknown>).id as number);
  }
  return ids;
}

export interface CreateGitLabIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export async function createGitLabIssue(repo: ProviderRepoInfo, input: CreateGitLabIssueInput): Promise<GitLabIssueResponse> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "issue title required" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to create an issue" };
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const assigneeIds = await resolveAssigneeIds(apiBase, projectId, input.assignees ?? [], token);

  const res = await fetchGitLab(`${apiBase}/projects/${projectId}/issues`, token, {
    method: "POST",
    body: JSON.stringify({
      title,
      ...(input.body?.trim() ? { description: input.body.trim() } : {}),
      ...(labels.length > 0 ? { labels: labels.join(",") } : {}),
      ...(assigneeIds.length > 0 ? { assignee_ids: assigneeIds } : {}),
    }),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem("issues", json);
  if (!item) return { ok: false, error: "GitLab returned an unexpected issue response" };
  return { ok: true, item, message: "Issue created." };
}

export interface UpdateGitLabIssueInput {
  /** The `/issues` and `/merge_requests` PUT endpoints are separate on
   *  GitLab (unlike GitHub's single `/issues/:number` patching both) — `kind`
   *  picks which one, mirroring `UpdateGitHubIssueInput`'s `kind` field. */
  kind?: GitHubItemKind;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export async function updateGitLabIssue(repo: ProviderRepoInfo, number: number, input: UpdateGitLabIssueInput): Promise<GitLabIssueResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "issue number must be positive" };
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: false, error: "GitLab authentication required to update an issue" };
  const kind: GitHubItemKind = input.kind === "pulls" ? "pulls" : "issues";
  const endpoint = kind === "pulls" ? "merge_requests" : "issues";
  const noun = kind === "pulls" ? "merge request" : "issue";
  const apiBase = gitlabApiBase(repo);
  const projectId = encodeProjectId(repo.owner, repo.name);

  const patch: Record<string, unknown> = {};
  if (input.title?.trim()) patch.title = input.title.trim();
  if (input.body !== undefined) patch.description = input.body.trim();
  if (input.state === "closed") patch.state_event = "close";
  else if (input.state === "open") patch.state_event = "reopen";
  if (input.labels) patch.labels = input.labels.map((s) => s.trim()).filter(Boolean).join(",");
  if (input.assignees) patch.assignee_ids = await resolveAssigneeIds(apiBase, projectId, input.assignees, token);

  const res = await fetchGitLab(`${apiBase}/projects/${projectId}/${endpoint}/${number}`, token, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  const item = normalizeItem(kind, json);
  if (!item) return { ok: false, error: `GitLab returned an unexpected ${noun} response` };
  return { ok: true, item, message: `${kind === "pulls" ? "Merge request" : "Issue"} updated.` };
}

/** Matches `getGitHubViewer`'s `{ok:true,login:string}` shape — no-token
 *  resolves to an empty login rather than erroring, same as the GitHub side. */
export async function getGitLabViewer(repo: ProviderRepoInfo): Promise<GitLabViewerResponse> {
  const token = await gitlabToken(repo.remoteHost);
  if (!token) return { ok: true, login: "" };
  const res = await fetchGitLab(`${gitlabApiBase(repo)}/user`, token);
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!token) };
  const login = json && typeof json === "object" && typeof (json as Record<string, unknown>).username === "string"
    ? (json as Record<string, unknown>).username as string
    : "";
  return { ok: true, login };
}

/** Matches `listGitHubLabels`'s shape (3-page cap, following the next-page
 *  link, alphabetically sorted). */
export async function listGitLabLabels(repo: ProviderRepoInfo): Promise<GitLabLabelsResponse> {
  const token = await gitlabToken(repo.remoteHost);
  const projectId = encodeProjectId(repo.owner, repo.name);
  const labels: GitHubRepoLabel[] = [];
  let url: string | null = `${gitlabApiBase(repo)}/projects/${projectId}/labels?per_page=100`;
  for (let page = 0; url && page < 3; page++) {
    const res = await fetchGitLab(url, token);
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!token) };
    if (!Array.isArray(body)) return { ok: false, error: "GitLab returned an unexpected labels response" };
    for (const raw of body) {
      const label = normalizeRepoLabel(raw);
      if (label) labels.push(label);
    }
    url = resolveNextPage(res, url);
  }
  labels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, repo: `${repo.owner}/${repo.name}`, labels };
}

/** Pure normalizers/param-builders exposed for tests (TT2,
 *  `gitlab.test.ts`) — mirrors github.ts's `__githubInternals`. */
export const __gitlabInternals = {
  encodeProjectId,
  gitlabHost,
  gitlabApiBase,
  apiError,
  authHint,
  pageLinks,
  resolveNextPage,
  normalizeUser,
  normalizeLabels,
  normalizeItem,
  noteHtmlUrl,
  normalizeComment,
  normalizeLineComment,
  mapGitLabStatus,
  normalizeCommitStatusAsCheckRun,
  normalizePipelineAsCheckRun,
  normalizeRepoLabel,
  sortItems,
  gitlabStateParams,
  contentTypeForGitLabBlobPath,
  resetGitLabPullBlobCaches,
};
