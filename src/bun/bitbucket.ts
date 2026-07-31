import type {
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubListItem,
  GitHubListResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeMethod,
  GitHubPullMergeResult,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewEvent,
  GitHubUser,
  ProviderRepoInfo,
  TaskDiff,
} from "../shared/types.ts";
import { MAX_DIFF_FILES, parseGitDiff } from "./git-diff.ts";
import { bitbucketCreds, type BitbucketCreds } from "./git-provider.ts";

/**
 * Bitbucket Cloud (api.bitbucket.org, REST 2.0) adapter
 * (docs/plans/multi-provider-git-modal.md, T3).
 *
 * Mirrors `src/bun/github.ts`'s shape as closely as the two APIs allow, so the
 * facade (`git-host.ts`, T4) can dispatch to whichever provider a repo
 * resolves to without special-casing return shapes: every exported function
 * here returns the SAME shared `GitHub*` wire types as its github.ts
 * counterpart (`{ok:true} & X | {ok:false;error}`), just normalized from
 * Bitbucket's JSON instead of GitHub's. `src/bun/gitlab.ts` is the sibling
 * adapter for GitLab (owned by a different task/agent in this wave).
 *
 * Key shape difference from github.ts: every github.ts function takes a
 * `dir` and resolves the repo (and does local git work like reading the
 * current branch) itself via `repoForDir`. This adapter instead takes an
 * already-resolved `repo: ProviderRepoInfo` (the facade resolves it once via
 * `providerRepoForDir`, T1) — this module does no local git/filesystem work
 * at all, only Bitbucket HTTP calls. The one place that matters is
 * `getBitbucketPullDefaults`: unlike `getGitHubPullDefaults`, it cannot read
 * the local checkout's current branch (no `dir`), so `head` is always `""`
 * here — the facade is expected to fill it in from local git the same way
 * for every provider, since "current branch" is a local-checkout concept,
 * not a provider concept.
 *
 * Bitbucket API facts this file leans on (see plan §2/§3 and Bitbucket's own
 * docs):
 *  - Base URL `https://api.bitbucket.org`; a repo is addressed as
 *    `/2.0/repositories/{workspace}/{repo_slug}` — `owner`/`name` on
 *    `ProviderRepoInfo` map to workspace/repo_slug respectively.
 *  - Auth is Basic (email + API token) or Bearer (workspace/repo access
 *    token) — `bitbucketCreds` (git-provider.ts) resolves which.
 *  - List responses page as `{values, next, page, pagelen, size}`; `next` is
 *    an absolute URL to the following page — this module's `fetchBitbucket`
 *    passes an absolute URL straight through instead of re-prefixing it.
 *  - Bitbucket Query Language (`q=`) expresses server-side filters; multiple
 *    clauses combine with ` AND `. There is no Bitbucket equivalent of
 *    GitHub labels, so `labels` is accepted (for interface parity with
 *    call sites shared across providers) but always ignored.
 *
 * Leaf module: does not import `db.ts`, `server.ts`, or `github.ts`. May
 * import from `git-provider.ts`, `git-diff.ts`, and `../shared/types.ts`.
 */

const BITBUCKET_API_BASE = "https://api.bitbucket.org";
const BITBUCKET_FETCH_TIMEOUT_MS = 30_000;
const BITBUCKET_DIFF_BODY_CAP_BYTES = 8_000_000;
const BITBUCKET_PAGELEN = 30;

interface BitbucketError {
  ok: false;
  error: string;
}

// Local response unions, mirroring the shape of github.ts's (unexported)
// `GitHub*Response` types but built from the shared, exported `GitHub*`
// interfaces so this module can compile without any github.ts import.
type BitbucketListResponse = ({ ok: true } & GitHubListResult) | BitbucketError;
type BitbucketDiffResponse = ({ ok: true } & TaskDiff) | BitbucketError;
type BitbucketCommentsResponse = ({ ok: true } & GitHubCommentsResult) | BitbucketError;
type BitbucketCommentResponse = ({ ok: true; comment: GitHubComment }) | BitbucketError;
type BitbucketPullLineCommentResponse = ({ ok: true; comment: GitHubPullLineComment }) | BitbucketError;
type BitbucketPullReviewCommentsResponse = ({ ok: true } & GitHubPullReviewCommentsResult) | BitbucketError;
type BitbucketChecksResponse = ({ ok: true } & GitHubChecksResult) | BitbucketError;
type BitbucketPullMergeResponse = GitHubPullMergeResult | BitbucketError;
type BitbucketPullDefaultsResponse = ({ ok: true } & GitHubPullDefaultsResult) | BitbucketError;
type BitbucketIssueResponse = ({ ok: true; item: GitHubListItem; message?: string }) | BitbucketError;
type BitbucketActionResponse =
  | ({ ok: true; message?: string; item?: GitHubListItem; commentPosted?: boolean })
  | BitbucketError;
type BitbucketViewerResponse = ({ ok: true; login: string }) | BitbucketError;

/** `/2.0/repositories/{workspace}/{repo_slug}` for a resolved repo. Segments
 *  are URL-encoded defensively even though workspace/repo slugs are normally
 *  URL-safe already. */
function repoBasePath(repo: ProviderRepoInfo): string {
  return `/2.0/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Absolute-URL passthrough: a `next` pagination link (or any other
 *  already-absolute URL a caller builds via `new URL(...)`) is used as-is;
 *  anything else is treated as a path relative to the Bitbucket API base. */
function resolveUrl(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BITBUCKET_API_BASE}${pathOrUrl}`;
}

/** How many extra pages a comment listing follows beyond the first — 5 pages
 *  of `pagelen=30` covers 150 comments, matching gitlab.ts's paging bound. */
const BITBUCKET_MAX_EXTRA_PAGES = 4;

/**
 * Follows a paginated collection's absolute `next` URLs (Bitbucket puts
 * pagination in the response body, not headers), accumulating each page's
 * `values`. `firstBody` is the already-fetched, already-error-checked page-1
 * body. A fetch/parse failure mid-pagination stops the walk and returns what
 * has accumulated so far — partial results beat failing a listing whose first
 * page already succeeded.
 */
async function collectRemainingValues(firstBody: unknown, creds: BitbucketCreds | null): Promise<unknown[]> {
  const extra: unknown[] = [];
  let next = firstBody && typeof firstBody === "object" ? (firstBody as { next?: unknown }).next : null;
  for (let i = 0; i < BITBUCKET_MAX_EXTRA_PAGES && typeof next === "string" && next; i++) {
    const res = await fetchBitbucket(next, creds, "application/json");
    if (!("status" in res) || !res.ok) break;
    const body = await res.json().catch(() => null);
    const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
      ? (body as { values: unknown[] }).values
      : null;
    if (!values) break;
    extra.push(...values);
    next = (body as { next?: unknown }).next;
  }
  return extra;
}

function authHeader(creds: BitbucketCreds | null): Record<string, string> {
  if (!creds) return {};
  if (creds.kind === "basic") {
    const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
    return { authorization: `Basic ${encoded}` };
  }
  return { authorization: `Bearer ${creds.token}` };
}

function fetchErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return "Bitbucket request timed out";
  }
  return e instanceof Error ? e.message : String(e);
}

/** Internal fetch wrapper: absolute-URL passthrough (for pagination `next`
 *  links), 30s abort, `user-agent: agetor`, and the resolved
 *  Basic/Bearer auth header. `accept` is caller-supplied since the diff
 *  endpoint wants a permissive/plain accept rather than `application/json`. */
async function fetchBitbucket(
  pathOrUrl: string,
  creds: BitbucketCreds | null,
  accept: string,
  init?: { method?: string; body?: string },
): Promise<Response | BitbucketError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BITBUCKET_FETCH_TIMEOUT_MS);
  try {
    return await fetch(resolveUrl(pathOrUrl), {
      method: init?.method,
      signal: controller.signal,
      headers: {
        accept,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        "user-agent": "agetor",
        ...authHeader(creds),
      },
      body: init?.body,
    });
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a friendly error message from a non-2xx Bitbucket response body
 *  (`{type:"error", error:{message}}`), falling back to `status statusText`.
 *  A 401 gets an actionable hint pointing at where credentials are
 *  configured, mirroring github.ts's `privateRepoHint` — a bare 401 passthrough
 *  otherwise reads as "this doesn't exist" rather than "you're not authed". */
function apiErrorMessage(body: unknown, status: number, statusText: string): string {
  const message = body && typeof body === "object" && (body as { error?: unknown }).error
    && typeof (body as { error?: unknown }).error === "object"
    && typeof ((body as { error: Record<string, unknown> }).error.message) === "string"
    ? (body as { error: { message: string } }).error.message
    : `${status} ${statusText}`;
  if (status === 401) {
    return `Bitbucket authentication failed (${message}) — configure credentials in Settings → API tokens (Basic auth: email:api_token).`;
  }
  return message;
}

function normalizeBitbucketUser(raw: unknown): GitHubUser | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const links = obj.links && typeof obj.links === "object" ? obj.links as Record<string, unknown> : {};
  const html = links.html && typeof links.html === "object" ? (links.html as Record<string, unknown>).href : undefined;
  const avatar = links.avatar && typeof links.avatar === "object"
    ? (links.avatar as Record<string, unknown>).href
    : undefined;
  // login prefers `nickname` (Bitbucket's stable handle-like field) and falls
  // back to `display_name` — Bitbucket deprecated the old `username` field for
  // most accounts, and not every user object carries a nickname.
  const login = typeof obj.nickname === "string" && obj.nickname
    ? obj.nickname
    : typeof obj.display_name === "string" && obj.display_name
      ? obj.display_name
      : null;
  if (!login) return null;
  return {
    login,
    avatarUrl: typeof avatar === "string" ? avatar : null,
    htmlUrl: typeof html === "string" ? html : null,
  };
}

/** Normalize a Bitbucket pull request object into `GitHubListItem`.
 *  `mergedAt` is approximated: Bitbucket pull requests have no dedicated
 *  `merged_at`/similar field, so `updated_on` is used when `state === "MERGED"`
 *  — in practice the merge is the terminal update to a PR, so this is accurate
 *  for the vast majority of cases (a rare post-merge metadata edit, if the API
 *  even allows one, would shift it slightly). `closedAt` uses the same
 *  approximation for any non-open state. */
function normalizeBitbucketPull(raw: unknown, sourcePath: string | null): GitHubListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.title !== "string") return null;
  const links = obj.links && typeof obj.links === "object" ? obj.links as Record<string, unknown> : {};
  const html = links.html && typeof links.html === "object" ? (links.html as Record<string, unknown>).href : undefined;
  if (typeof html !== "string") return null;
  const rawState = typeof obj.state === "string" ? obj.state : "";
  const state: "open" | "closed" = rawState === "OPEN" ? "open" : "closed";
  const updatedAt = typeof obj.updated_on === "string" ? obj.updated_on : "";
  return {
    kind: "pulls",
    number: obj.id,
    title: obj.title,
    state,
    // Bitbucket added draft PRs after the initial 2.0 API — read defensively
    // since older responses (and some SDKs) may omit the field entirely.
    draft: typeof obj.draft === "boolean" ? obj.draft : false,
    htmlUrl: html,
    author: normalizeBitbucketUser(obj.author),
    assignees: [], // Bitbucket pull requests have no assignee concept.
    milestone: null,
    body: typeof obj.description === "string" ? obj.description : "",
    labels: [], // Bitbucket has no labels.
    comments: typeof obj.comment_count === "number" ? obj.comment_count : 0,
    createdAt: typeof obj.created_on === "string" ? obj.created_on : "",
    updatedAt,
    closedAt: state === "closed" ? (updatedAt || null) : null,
    mergedAt: rawState === "MERGED" ? (updatedAt || null) : null,
    locked: false, // Bitbucket has no conversation-lock concept.
    sourcePath,
  };
}

// Bitbucket issue states that count as "open" for state filtering / mapping —
// everything else (resolved, closed, duplicate, invalid, wontfix, on hold)
// counts as "closed". Kept as a Set (not a switch) so `buildIssuesBBQL`'s BBQL
// clause and `normalizeBitbucketIssue`'s state mapping stay in lockstep.
const BITBUCKET_OPEN_ISSUE_STATES = new Set(["new", "open"]);

function normalizeBitbucketIssue(raw: unknown, sourcePath: string | null): GitHubListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number" || typeof obj.title !== "string") return null;
  const links = obj.links && typeof obj.links === "object" ? obj.links as Record<string, unknown> : {};
  const html = links.html && typeof links.html === "object" ? (links.html as Record<string, unknown>).href : undefined;
  if (typeof html !== "string") return null;
  const rawState = typeof obj.state === "string" ? obj.state : "";
  const state: "open" | "closed" = BITBUCKET_OPEN_ISSUE_STATES.has(rawState) ? "open" : "closed";
  const content = obj.content && typeof obj.content === "object" ? obj.content as Record<string, unknown> : {};
  const assignee = obj.assignee ? normalizeBitbucketUser(obj.assignee) : null;
  const updatedAt = typeof obj.updated_on === "string" ? obj.updated_on : "";
  return {
    kind: "issues",
    number: obj.id,
    title: obj.title,
    state,
    draft: false, // Issues have no draft concept.
    htmlUrl: html,
    author: normalizeBitbucketUser(obj.reporter),
    assignees: assignee ? [assignee] : [],
    milestone: null,
    body: typeof content.raw === "string" ? content.raw : "",
    labels: [],
    comments: typeof obj.comment_count === "number" ? obj.comment_count : 0,
    createdAt: typeof obj.created_on === "string" ? obj.created_on : "",
    updatedAt,
    closedAt: state === "closed" ? (updatedAt || null) : null,
    mergedAt: null, // Issues never merge.
    locked: false,
    sourcePath,
  };
}

function normalizeBitbucketComment(raw: unknown): GitHubComment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  const links = obj.links && typeof obj.links === "object" ? obj.links as Record<string, unknown> : {};
  const html = links.html && typeof links.html === "object" ? (links.html as Record<string, unknown>).href : undefined;
  if (typeof html !== "string") return null;
  const content = obj.content && typeof obj.content === "object" ? obj.content as Record<string, unknown> : {};
  return {
    id: obj.id,
    body: typeof content.raw === "string" ? content.raw : "",
    htmlUrl: html,
    author: normalizeBitbucketUser(obj.user),
    createdAt: typeof obj.created_on === "string" ? obj.created_on : "",
    updatedAt: typeof obj.updated_on === "string" ? obj.updated_on : "",
  };
}

/** A comment carrying an `inline` position is a line (review) comment. Note:
 *  `GitHubPullLineComment` (shared/types.ts) has no field for reply-threading
 *  — and neither does github.ts's own `normalizeLineComment` (it never reads
 *  GitHub's `in_reply_to_id`). So Bitbucket's `parent.id` on a reply is
 *  likewise not carried into the normalized shape here; this is a limitation
 *  of the current shared wire type, not something bitbucket.ts drops that
 *  github.ts otherwise preserves. */
function normalizeBitbucketLineComment(raw: unknown): GitHubPullLineComment | null {
  const comment = normalizeBitbucketComment(raw);
  if (!comment || !raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const inline = obj.inline && typeof obj.inline === "object" ? obj.inline as Record<string, unknown> : null;
  if (!inline || typeof inline.path !== "string") return null;
  const to = typeof inline.to === "number" ? inline.to : null;
  const from = typeof inline.from === "number" ? inline.from : null;
  const side: "LEFT" | "RIGHT" | null = to != null ? "RIGHT" : from != null ? "LEFT" : null;
  const line = to ?? from;
  if (!side || line == null) return null;
  return { ...comment, path: inline.path, line, side };
}

/** Maps a Bitbucket commit-status `state` to the `{status, conclusion}` pair
 *  `GitHubCheckRun` expects (GitHub's check-runs vocabulary). */
const BITBUCKET_CHECK_STATE_MAP: Record<string, { status: string; conclusion: string | null }> = {
  INPROGRESS: { status: "in_progress", conclusion: null },
  SUCCESSFUL: { status: "completed", conclusion: "success" },
  FAILED: { status: "completed", conclusion: "failure" },
  STOPPED: { status: "completed", conclusion: "cancelled" },
};

/** Bitbucket build-status entries have no numeric id (only a string
 *  `key`/`uuid`), unlike GitHub's check runs — `GitHubCheckRun.id` is `number`,
 *  so the entry's 1-based position in the page is used as a stand-in. It's
 *  only used as a React/table row key by the UI, never round-tripped back
 *  into a Bitbucket API call, so a page-local synthetic id is safe. */
function normalizeBitbucketCheckRun(raw: unknown, index: number): GitHubCheckRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name
    ? obj.name
    : typeof obj.key === "string" && obj.key
      ? obj.key
      : null;
  if (!name) return null;
  const rawState = typeof obj.state === "string" ? obj.state : "";
  const mapped = BITBUCKET_CHECK_STATE_MAP[rawState] ?? { status: "unknown", conclusion: null };
  return {
    id: index + 1,
    name,
    status: mapped.status,
    conclusion: mapped.conclusion,
    htmlUrl: typeof obj.url === "string" ? obj.url : null,
    startedAt: typeof obj.created_on === "string" ? obj.created_on : null,
    completedAt: mapped.status === "completed" && typeof obj.updated_on === "string" ? obj.updated_on : null,
  };
}

/** Escape a double quote in a BBQL string literal — the only character in a
 *  free-text query that needs escaping for a `"…"` BBQL string to stay valid. */
function escapeBBQLString(s: string): string {
  // Backslash is BBQL's own escape character, so it must be doubled BEFORE
  // quotes are escaped — otherwise a trailing `\` in the search term turns
  // the closing `"` into an escaped quote and the whole `q=` fails with 400.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Bitbucket's pull-request list endpoint takes a repeatable `state` query
 *  param rather than a single value — `closed` and `all` expand to every
 *  terminal (or all) PR state. */
function prStateParams(state: GitHubItemState): string[] {
  if (state === "open") return ["OPEN"];
  if (state === "closed") return ["MERGED", "DECLINED", "SUPERSEDED"];
  return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
}

/** BBQL clause for issue state filtering — Bitbucket issues have a richer
 *  state machine (new/open/resolved/closed/duplicate/invalid/wontfix/on hold)
 *  than the open/closed binary the UI exposes, so `closed` expands to every
 *  non-open state. `null` for `state === "all"` (no filter needed). */
function issueStateBBQL(state: GitHubItemState): string | null {
  if (state === "open") return '(state="new" OR state="open")';
  if (state === "closed") {
    return '(state="resolved" OR state="closed" OR state="duplicate" OR state="invalid" OR state="wontfix" OR state="on hold")';
  }
  return null;
}

interface BitbucketQueryFilters {
  query?: string;
  assignee?: string;
  createdByMe?: boolean;
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  state: GitHubItemState;
}

/** Builds the `q=` BBQL string for the pull-requests list endpoint from the
 *  "involvement" filters, ANDing every active clause together. Bitbucket pull
 *  requests have no assignee concept, so `assignedToMe` is treated the same as
 *  `reviewRequested` (documented on `listBitbucketItems`). `meUuid` is null
 *  when the involvement filters can't be resolved (no credentials, or the
 *  `/2.0/user` lookup failed) — those clauses are silently dropped rather than
 *  erroring, matching a plain unauthenticated list. */
function buildPullsBBQL(input: BitbucketQueryFilters, meUuid: string | null): string | null {
  const clauses: string[] = [];
  const q = input.query?.trim();
  if (q) clauses.push(`(title ~ "${escapeBBQLString(q)}" OR description ~ "${escapeBBQLString(q)}")`);
  if (input.createdByMe && meUuid) clauses.push(`author.uuid="${meUuid}"`);
  if ((input.reviewRequested || input.assignedToMe) && meUuid) clauses.push(`reviewers.uuid="${meUuid}"`);
  return clauses.length > 0 ? clauses.join(" AND ") : null;
}

/** Builds the `q=` BBQL string for the issues list endpoint. `assignee` is
 *  matched by nickname (best-effort — Bitbucket's issue-tracker BBQL schema
 *  for assignee is thinner than the pull-request one). */
function buildIssuesBBQL(input: BitbucketQueryFilters): string | null {
  const clauses: string[] = [];
  const stateClause = issueStateBBQL(input.state);
  if (stateClause) clauses.push(stateClause);
  const q = input.query?.trim();
  if (q) clauses.push(`(title ~ "${escapeBBQLString(q)}" OR content.raw ~ "${escapeBBQLString(q)}")`);
  const assignee = input.assignee?.trim();
  if (assignee) clauses.push(`assignee.nickname="${escapeBBQLString(assignee)}"`);
  return clauses.length > 0 ? clauses.join(" AND ") : null;
}

/** Maps the shared sort/direction input to Bitbucket's `sort=` param.
 *  "best-match" (search-relevance sort, GitHub-only) and "comments" (no
 *  Bitbucket field backs a comment-count sort) both degrade to `-updated_on` —
 *  the plan's documented fallback. `direction: "asc"` drops the leading `-`. */
function sortParam(sort: "created" | "updated" | "comments" | undefined, direction: "asc" | "desc" | undefined): string {
  const field = sort === "created" ? "created_on" : "updated_on";
  return direction === "asc" ? field : `-${field}`;
}

/** Resolves the authenticated viewer's Bitbucket `uuid` (needed for BBQL
 *  `author.uuid="…"` / `reviewers.uuid="…"` clauses) alongside a display
 *  login. Returns null on no credentials or any failure — callers treat that
 *  as "the me-scoped filter can't be applied" rather than a hard error. */
async function bitbucketViewerUuid(creds: BitbucketCreds | null): Promise<{ uuid: string; login: string } | null> {
  if (!creds) return null;
  const res = await fetchBitbucket("/2.0/user", creds, "application/json");
  if (!("status" in res) || !res.ok) return null;
  const json = await res.json().catch(() => null);
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
  if (!uuid) return null;
  const login = typeof obj.nickname === "string" && obj.nickname
    ? obj.nickname
    : typeof obj.username === "string"
      ? obj.username
      : "";
  return { uuid, login };
}

export interface ListBitbucketItemsOptions {
  kind: GitHubItemKind;
  state: GitHubItemState;
  query?: string;
  /** Bitbucket has no labels — accepted only for interface parity with
   *  callers shared across providers (the facade); always ignored. */
  labels?: string[];
  assignee?: string;
  createdByMe?: boolean;
  /** PRs: no Bitbucket assignee concept — treated as `reviewRequested`
   *  (see `buildPullsBBQL`). Issues: matched via `assignee.nickname=`. */
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  page?: number;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
}

/** Lists pull requests or issues for a repo. Mirrors `listGitHubItems`'s
 *  option surface and `GitHubListResult` return shape. `rateLimit` is always
 *  null — Bitbucket's REST API doesn't expose a GitHub-style rate-limit
 *  header trio. `hasMore` reflects whether the response body's `next` link is
 *  present (Bitbucket's own pagination cursor), and `page` echoes back the
 *  requested page the same way `listGitHubItems` does. */
export async function listBitbucketItems(
  repo: ProviderRepoInfo,
  opts: ListBitbucketItemsOptions,
): Promise<BitbucketListResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  const page = Number.isInteger(opts.page) && (opts.page as number) > 0 ? (opts.page as number) : 1;

  const needsMe = !!(opts.createdByMe || opts.assignedToMe || opts.reviewRequested);
  const viewer = needsMe ? await bitbucketViewerUuid(creds) : null;
  const meUuid = viewer?.uuid ?? null;

  const url = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/${opts.kind === "pulls" ? "pullrequests" : "issues"}`);
  url.searchParams.set("pagelen", String(BITBUCKET_PAGELEN));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", sortParam(opts.sort, opts.direction));

  if (opts.kind === "pulls") {
    for (const s of prStateParams(opts.state)) url.searchParams.append("state", s);
    const q = buildPullsBBQL(opts, meUuid);
    if (q) url.searchParams.set("q", q);
  } else {
    const q = buildIssuesBBQL(opts);
    if (q) url.searchParams.set("q", q);
  }

  const res = await fetchBitbucket(url.toString(), creds, "application/json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (opts.kind === "issues" && res.status === 404) {
      return { ok: false, error: "issue tracker is not enabled for this repository" };
    }
    return { ok: false, error: apiErrorMessage(body, res.status, res.statusText) };
  }
  const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
    ? (body as { values: unknown[] }).values
    : null;
  if (!values) return { ok: false, error: "Bitbucket returned an unexpected response" };
  const normalize = opts.kind === "pulls" ? normalizeBitbucketPull : normalizeBitbucketIssue;
  const items = values.map((v) => normalize(v, null)).filter((x): x is GitHubListItem => !!x);
  const next = body && typeof body === "object" ? (body as { next?: unknown }).next : undefined;

  return {
    ok: true,
    repo: `${repo.owner}/${repo.name}`,
    webUrl: `https://bitbucket.org/${repo.owner}/${repo.name}`,
    auth: creds ? "token" : "none",
    items,
    page,
    hasMore: typeof next === "string" && next.length > 0,
    rateLimit: null,
  };
}

/** Matches `getGitHubPullDefaults`'s return shape. `base` comes from the
 *  repo's `mainbranch.name`; `head` is always `""` here since this adapter
 *  has no working directory to read a current branch from (see the module
 *  doc comment) — the facade fills it in from local git the same way for
 *  every provider. */
export async function getBitbucketPullDefaults(repo: ProviderRepoInfo): Promise<BitbucketPullDefaultsResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  const res = await fetchBitbucket(repoBasePath(repo), creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const mainbranch = obj.mainbranch && typeof obj.mainbranch === "object" ? obj.mainbranch as Record<string, unknown> : {};
  const base = typeof mainbranch.name === "string" && mainbranch.name ? mainbranch.name : "main";
  return { ok: true, repo: `${repo.owner}/${repo.name}`, head: "", base };
}

export interface CreateBitbucketPullInput {
  title: string;
  body?: string;
  base: string;
  head: string;
  draft?: boolean;
}

export async function createBitbucketPull(
  repo: ProviderRepoInfo,
  input: CreateBitbucketPullInput,
): Promise<BitbucketIssueResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  const title = input.title.trim();
  const head = input.head.trim();
  const base = input.base.trim();
  if (!title) return { ok: false, error: "pull request title required" };
  if (!head) return { ok: false, error: "head branch required" };
  if (!base) return { ok: false, error: "base branch required" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to create a pull request" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests`,
    creds,
    "application/json",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(input.body?.trim() ? { description: input.body.trim() } : {}),
        source: { branch: { name: head } },
        destination: { branch: { name: base } },
        draft: input.draft === true,
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const item = normalizeBitbucketPull(json, null);
  if (!item) return { ok: false, error: "Bitbucket returned an unexpected pull request response" };
  return { ok: true, item, message: "Pull request created." };
}

/** Fetches the raw unified diff for a pull request. Mirrors
 *  `getGitHubPullDiff`'s 8MB content-length/byte-size guard and
 *  `MAX_DIFF_FILES` truncation exactly (same constants, same shape). Bitbucket
 *  itself also truncates very large diffs server-side (its own 8000-line /
 *  200-file caps) — `parseGitDiff` tolerates a truncated unified diff either
 *  way (it just yields fewer/partial hunks). */
export async function getBitbucketPullDiff(repo: ProviderRepoInfo, number: number): Promise<BitbucketDiffResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };

  const res = await fetchBitbucket(`${repoBasePath(repo)}/pullrequests/${number}/diff`, creds, "*/*");
  if (!("status" in res)) return res;
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > BITBUCKET_DIFF_BODY_CAP_BYTES) {
    return {
      ok: false,
      error: `Pull request diff is too large to display in Agetor (${Math.ceil(contentLength / 1_000_000)} MB).`,
    };
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (parsed.error && typeof parsed.error.message === "string") msg = parsed.error.message;
    } catch { /* the diff endpoint returns plain text on success, not JSON */ }
    return { ok: false, error: msg || `${res.status} ${res.statusText}` };
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > BITBUCKET_DIFF_BODY_CAP_BYTES) {
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

/** Lists non-inline comments on a pull request or issue. Inline (line)
 *  comments and soft-deleted comments are excluded here — inline ones belong
 *  to `listBitbucketPullReviewComments`, and Bitbucket never removes a deleted
 *  comment from the list, it just flips `deleted: true` and blanks the body. */
export async function listBitbucketComments(
  repo: ProviderRepoInfo,
  number: number,
  kind: GitHubItemKind,
): Promise<BitbucketCommentsResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "item number must be positive" };
  const endpoint = kind === "pulls" ? "pullrequests" : "issues";
  const url = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/${endpoint}/${number}/comments`);
  url.searchParams.set("pagelen", String(BITBUCKET_PAGELEN));

  const res = await fetchBitbucket(url.toString(), creds, "application/json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (kind === "issues" && res.status === 404) {
      return { ok: false, error: "issue tracker is not enabled for this repository" };
    }
    return { ok: false, error: apiErrorMessage(body, res.status, res.statusText) };
  }
  const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
    ? (body as { values: unknown[] }).values
    : null;
  if (!values) return { ok: false, error: "Bitbucket returned an unexpected comments response" };
  values.push(...await collectRemainingValues(body, creds));
  const comments: GitHubComment[] = [];
  for (const raw of values) {
    const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    if (!obj || obj.deleted === true || obj.inline) continue;
    const comment = normalizeBitbucketComment(obj);
    if (comment) comments.push(comment);
  }
  return { ok: true, repo: `${repo.owner}/${repo.name}`, itemNumber: number, comments };
}

export async function createBitbucketComment(
  repo: ProviderRepoInfo,
  number: number,
  kind: GitHubItemKind,
  body: string,
): Promise<BitbucketCommentResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "item number must be positive" };
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "comment body required" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to comment" };
  const endpoint = kind === "pulls" ? "pullrequests" : "issues";
  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/${endpoint}/${number}/comments`,
    creds,
    "application/json",
    { method: "POST", body: JSON.stringify({ content: { raw: trimmed } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (kind === "issues" && res.status === 404) {
      return { ok: false, error: "issue tracker is not enabled for this repository" };
    }
    return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  }
  const comment = normalizeBitbucketComment(json);
  if (!comment) return { ok: false, error: "Bitbucket returned an unexpected comment response" };
  return { ok: true, comment };
}

/** Lists inline (line) review comments on a pull request — the same
 *  `/comments` endpoint as `listBitbucketComments`, but keeping ONLY entries
 *  that carry an `inline` position (excluding soft-deleted ones too). */
export async function listBitbucketPullReviewComments(
  repo: ProviderRepoInfo,
  number: number,
): Promise<BitbucketPullReviewCommentsResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const url = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/pullrequests/${number}/comments`);
  url.searchParams.set("pagelen", String(BITBUCKET_PAGELEN));

  const res = await fetchBitbucket(url.toString(), creds, "application/json");
  if (!("status" in res)) return res;
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(body, res.status, res.statusText) };
  const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
    ? (body as { values: unknown[] }).values
    : null;
  if (!values) return { ok: false, error: "Bitbucket returned an unexpected review comments response" };
  values.push(...await collectRemainingValues(body, creds));
  const comments = values
    .filter((raw) => {
      const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
      return !!obj && !!obj.inline && obj.deleted !== true;
    })
    .map(normalizeBitbucketLineComment)
    .filter((x): x is GitHubPullLineComment => !!x);
  return { ok: true, repo: `${repo.owner}/${repo.name}`, pullNumber: number, comments };
}

export interface CreateBitbucketPullLineCommentInput {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export async function createBitbucketPullLineComment(
  repo: ProviderRepoInfo,
  number: number,
  input: CreateBitbucketPullLineCommentInput,
): Promise<BitbucketPullLineCommentResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const body = input.body.trim();
  const path = input.path.trim();
  if (!body) return { ok: false, error: "comment body required" };
  if (!path) return { ok: false, error: "comment path required" };
  if (!Number.isInteger(input.line) || input.line <= 0) {
    return { ok: false, error: "comment line must be positive" };
  }
  if (input.side !== "LEFT" && input.side !== "RIGHT") {
    return { ok: false, error: "comment side must be LEFT or RIGHT" };
  }
  if (!creds) return { ok: false, error: "Bitbucket authentication required to comment on a line" };

  // RIGHT (added/context line, head file) → `inline.to`; LEFT (base-file
  // deletion line) → `inline.from` — Bitbucket's own to/from vocabulary for
  // which side of the diff a line number refers to.
  const lineKey = input.side === "RIGHT" ? "to" : "from";
  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/comments`,
    creds,
    "application/json",
    { method: "POST", body: JSON.stringify({ content: { raw: body }, inline: { path, [lineKey]: input.line } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const comment = normalizeBitbucketLineComment(json);
  if (!comment) return { ok: false, error: "Bitbucket returned an unexpected line comment response" };
  return { ok: true, comment };
}

export async function replyBitbucketLineComment(
  repo: ProviderRepoInfo,
  number: number,
  commentId: number,
  body: string,
): Promise<BitbucketPullLineCommentResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  if (!Number.isInteger(commentId) || commentId <= 0) return { ok: false, error: "review comment id must be positive" };
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "reply body required" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to reply" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/comments`,
    creds,
    "application/json",
    { method: "POST", body: JSON.stringify({ content: { raw: trimmed }, parent: { id: commentId } }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const comment = normalizeBitbucketLineComment(json);
  if (!comment) return { ok: false, error: "Bitbucket returned an unexpected reply response" };
  return { ok: true, comment };
}

/** `GET .../pullrequests/:id/statuses` — Bitbucket's commit build statuses
 *  scoped directly to the pull request (unlike GitHub, no separate head-sha
 *  resolution + check-runs call is needed for the listing itself). The head
 *  sha for `GitHubChecksResult.sha` is still fetched via the PR detail call,
 *  purely to fill that field — same two-request shape as
 *  `getGitHubPullChecks`, just for a different reason. */
export async function getBitbucketPullChecks(repo: ProviderRepoInfo, number: number): Promise<BitbucketChecksResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };

  const prRes = await fetchBitbucket(`${repoBasePath(repo)}/pullrequests/${number}`, creds, "application/json");
  if (!("status" in prRes)) return prRes;
  const prJson = await prRes.json().catch(() => null);
  if (!prRes.ok) return { ok: false, error: apiErrorMessage(prJson, prRes.status, prRes.statusText) };
  const prObj = prJson && typeof prJson === "object" ? prJson as Record<string, unknown> : {};
  const source = prObj.source && typeof prObj.source === "object" ? prObj.source as Record<string, unknown> : {};
  const commit = source.commit && typeof source.commit === "object" ? source.commit as Record<string, unknown> : {};
  const sha = typeof commit.hash === "string" ? commit.hash : "";

  const statusesUrl = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/pullrequests/${number}/statuses`);
  statusesUrl.searchParams.set("pagelen", String(BITBUCKET_PAGELEN));
  const res = await fetchBitbucket(statusesUrl.toString(), creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const values = json && typeof json === "object" && Array.isArray((json as { values?: unknown }).values)
    ? (json as { values: unknown[] }).values
    : [];
  const checkRuns = values.map((v, i) => normalizeBitbucketCheckRun(v, i)).filter((x): x is GitHubCheckRun => !!x);

  return { ok: true, repo: `${repo.owner}/${repo.name}`, pullNumber: number, sha, checkRuns };
}

/** Matches `getGitHubPullDetail`'s shape — a single pull request by number,
 *  normalized through the same `normalizeBitbucketPull` mapper
 *  `closeBitbucketPull` uses. `sourcePath` is left `null` here, same as every
 *  other adapter function — the facade (`git-host.ts`) stitches it on via
 *  `withSourcePath`. */
export async function getBitbucketPullDetail(repo: ProviderRepoInfo, number: number): Promise<BitbucketIssueResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const creds = await bitbucketCreds(repo.remoteHost);
  const res = await fetchBitbucket(`${repoBasePath(repo)}/pullrequests/${number}`, creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const item = normalizeBitbucketPull(json, null);
  if (!item) return { ok: false, error: "Bitbucket returned an unexpected pull request response" };
  return { ok: true, item };
}

/** The shared `GitHubPullMergeMethod` enum ("merge"|"squash"|"rebase") maps to
 *  Bitbucket's three `merge_strategy` values. There is no fast-forward entry
 *  in the shared enum, so Bitbucket's `fast_forward` (a linear, no-merge-
 *  commit history — the same end result GitHub's "rebase and merge" produces)
 *  is exposed to the UI as `"rebase"`; see the `PROVIDER_CAPS` doc comment in
 *  `shared/types.ts` for the authoritative statement of this mapping. */
const BITBUCKET_MERGE_STRATEGY: Record<GitHubPullMergeMethod, string> = {
  merge: "merge_commit",
  squash: "squash",
  rebase: "fast_forward",
};

export async function mergeBitbucketPull(
  repo: ProviderRepoInfo,
  number: number,
  method: GitHubPullMergeMethod,
): Promise<BitbucketPullMergeResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const strategy = BITBUCKET_MERGE_STRATEGY[method];
  if (!strategy) return { ok: false, error: "unsupported merge method" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to merge" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/merge`,
    creds,
    "application/json",
    { method: "POST", body: JSON.stringify({ merge_strategy: strategy }) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const mergeCommit = obj.merge_commit && typeof obj.merge_commit === "object"
    ? obj.merge_commit as Record<string, unknown>
    : null;
  const sha = mergeCommit && typeof mergeCommit.hash === "string" ? mergeCommit.hash : null;
  return { ok: true, merged: true, sha, message: "Pull request merged." };
}

/** Bitbucket has no distinct "close without merging" action — declining is
 *  the only terminal non-merge state a pull request can reach via the API,
 *  so this is what `closeGitHubPull`'s call sites map onto. */
export async function closeBitbucketPull(repo: ProviderRepoInfo, number: number): Promise<BitbucketActionResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to decline a pull request" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/decline`,
    creds,
    "application/json",
    { method: "POST" },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const item = normalizeBitbucketPull(json, null);
  return { ok: true, message: "Pull request declined.", ...(item ? { item } : {}) };
}

/** Bitbucket has no API to move a declined pull request back to OPEN — unlike
 *  GitHub (`reopenGitHubPull`, a plain `state: "closed"` → back to `"open"`
 *  PATCH), a decline is terminal. Always returns a friendly, actionable error
 *  rather than attempting a request that Bitbucket would reject anyway. */
export async function reopenBitbucketPull(_repo: ProviderRepoInfo, _number: number): Promise<BitbucketActionResponse> {
  return { ok: false, error: "declined pull requests cannot be reopened on Bitbucket" };
}

/** Approve / request-changes / comment on a pull request. Reuses the shared
 *  `GitHubPullReviewEvent` enum ("APPROVE"|"REQUEST_CHANGES"|"COMMENT") as the
 *  verdict vocabulary — rather than inventing Bitbucket-specific literal
 *  strings — so the facade (T4) can pass the same value through to whichever
 *  provider a repo resolves to. `body` is optional for approve/request-changes
 *  (posted as a trailing plain comment when present) but required for a bare
 *  "comment" verdict, matching `reviewValidationError`'s COMMENT rule in
 *  github.ts. */
export async function reviewBitbucketPull(
  repo: ProviderRepoInfo,
  number: number,
  verdict: GitHubPullReviewEvent,
  body?: string,
): Promise<BitbucketActionResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const trimmedBody = body?.trim() ?? "";
  if (verdict === "COMMENT" && !trimmedBody) {
    return { ok: false, error: "a review comment requires a body" };
  }
  if (verdict !== "APPROVE" && verdict !== "REQUEST_CHANGES" && verdict !== "COMMENT") {
    return { ok: false, error: "unsupported review event" };
  }
  if (!creds) return { ok: false, error: "Bitbucket authentication required to review" };

  if (verdict === "COMMENT") {
    const commentRes = await createBitbucketComment(repo, number, "pulls", trimmedBody);
    if (!commentRes.ok) return commentRes;
    return { ok: true, message: "Review submitted." };
  }

  const endpoint = verdict === "APPROVE" ? "approve" : "request-changes";
  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/${endpoint}`,
    creds,
    "application/json",
    { method: "POST" },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };

  const verdictLabel = verdict === "APPROVE" ? "Pull request approved" : "Changes requested";
  if (trimmedBody) {
    const commentRes = await createBitbucketComment(repo, number, "pulls", trimmedBody);
    if (!commentRes.ok) {
      return { ok: true, message: `${verdictLabel}, but the comment was not posted: ${commentRes.error}` };
    }
  }
  return { ok: true, message: `${verdictLabel}.` };
}

export interface CreateBitbucketIssueInput {
  title: string;
  body?: string;
}

/** Labels/assignees/milestone are silently ignored — Bitbucket's issue
 *  creation endpoint doesn't support labels at all, and while it technically
 *  accepts an `assignee`/`milestone` object, the plan scopes this adapter to
 *  the portable title/body subset (matching `updateBitbucketIssue` below). */
export async function createBitbucketIssue(
  repo: ProviderRepoInfo,
  input: CreateBitbucketIssueInput,
): Promise<BitbucketIssueResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  const title = input.title.trim();
  if (!title) return { ok: false, error: "issue title required" };
  if (!creds) return { ok: false, error: "Bitbucket authentication required to create an issue" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/issues`,
    creds,
    "application/json",
    {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(input.body?.trim() ? { content: { raw: input.body.trim() } } : {}),
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 404) return { ok: false, error: "issue tracker is not enabled for this repository" };
    return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  }
  const item = normalizeBitbucketIssue(json, null);
  if (!item) return { ok: false, error: "Bitbucket returned an unexpected issue response" };
  return { ok: true, item, message: "Issue created." };
}

export interface UpdateBitbucketIssueInput {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

/** Portable patch surface matching `updateGitHubIssue`'s (title/body/state) —
 *  labels/assignees/milestone aren't part of this adapter's issue-update
 *  surface (see `createBitbucketIssue`). `state: "closed"` maps to Bitbucket's
 *  `"resolved"` (the canonical closed-ish state a fresh issue transitions to
 *  via a plain "close" action; a caller wanting `wontfix`/`duplicate`/etc.
 *  would need a Bitbucket-specific affordance this adapter doesn't expose). */
export async function updateBitbucketIssue(
  repo: ProviderRepoInfo,
  number: number,
  patch: UpdateBitbucketIssueInput,
): Promise<BitbucketIssueResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "issue number must be positive" };
  if (patch.state && patch.state !== "open" && patch.state !== "closed") {
    return { ok: false, error: "unsupported issue state" };
  }
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return { ok: false, error: "issue title cannot be empty" };
    body.title = title;
  }
  if (patch.body !== undefined) body.content = { raw: patch.body };
  if (patch.state === "closed") body.state = "resolved";
  else if (patch.state === "open") body.state = "open";
  if (Object.keys(body).length === 0) {
    return { ok: false, error: "issue update requires title, body, or state" };
  }
  if (!creds) return { ok: false, error: "Bitbucket authentication required to update an issue" };

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/issues/${number}`,
    creds,
    "application/json",
    { method: "PUT", body: JSON.stringify(body) },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 404) return { ok: false, error: "issue tracker is not enabled for this repository" };
    return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  }
  const item = normalizeBitbucketIssue(json, null);
  if (!item) return { ok: false, error: "Bitbucket returned an unexpected issue response" };
  return { ok: true, item, message: "Issue updated." };
}

/** Matches `getGitHubViewer`'s shape (`{ok:true; login}` only — no token
 *  means an anonymous "" login rather than an error, same no-token behavior
 *  as the GitHub counterpart). */
export async function getBitbucketViewer(repo: ProviderRepoInfo): Promise<BitbucketViewerResponse> {
  const creds = await bitbucketCreds(repo.remoteHost);
  if (!creds) return { ok: true, login: "" };
  const res = await fetchBitbucket("/2.0/user", creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiErrorMessage(json, res.status, res.statusText) };
  const obj = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const login = typeof obj.nickname === "string" && obj.nickname
    ? obj.nickname
    : typeof obj.username === "string"
      ? obj.username
      : "";
  return { ok: true, login };
}

// Internal helpers exposed for unit tests only (TT3) — no other consumers.
export const __bitbucketInternals = {
  repoBasePath,
  resolveUrl,
  apiErrorMessage,
  normalizeBitbucketUser,
  normalizeBitbucketPull,
  normalizeBitbucketIssue,
  normalizeBitbucketComment,
  normalizeBitbucketLineComment,
  normalizeBitbucketCheckRun,
  escapeBBQLString,
  prStateParams,
  issueStateBBQL,
  buildPullsBBQL,
  buildIssuesBBQL,
  sortParam,
  bitbucketViewerUuid,
  BITBUCKET_OPEN_ISSUE_STATES,
  BITBUCKET_CHECK_STATE_MAP,
  BITBUCKET_MERGE_STRATEGY,
};
