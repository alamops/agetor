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
  GitHubPullMergeability,
  GitHubPullLineComment,
  GitHubPullMergeMethod,
  GitHubPullMergeResult,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewEvent,
  GitHubUser,
  ProviderRepoInfo,
  TaskDiff,
} from "../shared/types.ts";
import { GIT_HOST_TOKENS_SECTION } from "../shared/types.ts";
import { contentTypeForPreviewPath, MAX_BLOB_PREVIEW_BYTES } from "../shared/attachments.ts";
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
 *  anything else is treated as a path relative to the Bitbucket API base.
 *  Every absolute URL that reaches this function today is built internally
 *  from `BITBUCKET_API_BASE` (e.g. `new URL(\`${BITBUCKET_API_BASE}...\`)`),
 *  so passthrough is safe here — but a `next` link taken verbatim from a
 *  Bitbucket response body is NOT internally-constructed, and paging call
 *  sites must validate it with `sanitizeNextUrl` (below) before ever handing
 *  it to `fetchBitbucket`/`resolveUrl`, since `fetchBitbucket` attaches the
 *  user's credentials to whatever host it's given. */
function resolveUrl(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BITBUCKET_API_BASE}${pathOrUrl}`;
}

const BITBUCKET_API_ORIGIN = new URL(BITBUCKET_API_BASE).origin;

/**
 * Validates a pagination `next` URL pulled out of a Bitbucket response body
 * before it's ever fetched. Bitbucket puts `next` directly in the JSON body
 * (not a header), so a malicious/compromised response — or credentials
 * reused against a lookalike host — could point `next` at an arbitrary
 * origin; `fetchBitbucket` would otherwise attach the same Authorization
 * header to that request via `resolveUrl`'s absolute-URL passthrough. Only a
 * same-origin-as-`BITBUCKET_API_BASE` absolute URL is accepted; anything
 * else (wrong origin, unparseable, missing) returns null so paging call
 * sites can treat it as end-of-pages rather than as a page to fetch.
 */
function sanitizeNextUrl(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  try {
    return new URL(next).origin === BITBUCKET_API_ORIGIN ? next : null;
  } catch {
    return null;
  }
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
 * page already succeeded. Each `next` is validated by `sanitizeNextUrl`
 * before being fetched, so a hostile/off-origin `next` just ends the walk
 * rather than leaking credentials to it.
 */
async function collectRemainingValues(firstBody: unknown, creds: BitbucketCreds | null): Promise<unknown[]> {
  const extra: unknown[] = [];
  let next = sanitizeNextUrl(firstBody && typeof firstBody === "object" ? (firstBody as { next?: unknown }).next : null);
  for (let i = 0; i < BITBUCKET_MAX_EXTRA_PAGES && next; i++) {
    const res = await fetchBitbucket(next, creds, "application/json");
    if (!("status" in res) || !res.ok) break;
    const body = await res.json().catch(() => null);
    const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
      ? (body as { values: unknown[] }).values
      : null;
    if (!values) break;
    extra.push(...values);
    next = sanitizeNextUrl((body as { next?: unknown }).next);
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
 *  endpoint wants a permissive/plain accept rather than `application/json`.
 *  `init.redirect` defaults to the platform default (`"follow"`) when
 *  omitted; `getBitbucketPullBlob`'s merge-base redirect-sniff is the only
 *  caller that passes `"manual"`, to read a 30x `Location` header instead of
 *  transparently following it. */
async function fetchBitbucket(
  pathOrUrl: string,
  creds: BitbucketCreds | null,
  accept: string,
  init?: { method?: string; body?: string; redirect?: "follow" | "manual" },
): Promise<Response | BitbucketError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BITBUCKET_FETCH_TIMEOUT_MS);
  try {
    return await fetch(resolveUrl(pathOrUrl), {
      method: init?.method,
      redirect: init?.redirect,
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
 *  Pure message extraction only — no status-specific enrichment; that lives
 *  in `bitbucketAccessHint`/`errorFrom` below, mirroring gitlab.ts's split
 *  between `apiError` and `authHint`. */
function apiErrorMessage(body: unknown, status: number, statusText: string): string {
  return body && typeof body === "object" && (body as { error?: unknown }).error
    && typeof (body as { error?: unknown }).error === "object"
    && typeof ((body as { error: Record<string, unknown> }).error.message) === "string"
    ? (body as { error: { message: string } }).error.message
    : `${status} ${statusText}`;
}

/** Enriches a 401/403/404 with an actionable pointer to Settings, mirroring
 *  github.ts's `privateRepoHint` and gitlab.ts's `authHint`. Bitbucket hides a
 *  private repo behind 404 — and sometimes 403 — rather than answering with a
 *  clean 401 (its documented "You may not have access to this repository or
 *  it no longer exists in this workspace…" body), so 404 always gets the "was
 *  not found / add a credential" treatment; a genuine 401 (missing/invalid
 *  credentials on the request itself) gets an authentication-failed flavor
 *  instead, but points at the same Settings section and credential format.
 *  403 is narrower: an *unauthenticated* 403 is plausibly the same
 *  credential-gap signal as an unauthenticated 404, so it gets the full 404
 *  treatment. An *authenticated* 403 (`hadCreds === true`) usually means
 *  something the enrichment would actively mislead about (branch restrictions
 *  blocking a merge, a permission the credential's account genuinely lacks, a
 *  rate limit) — a real, specific error like that must stay front and center,
 *  never reframed as a bare "add/replace a credential". But it does get one
 *  thing appended: a pointer to Settings for the single most common
 *  authenticated-403 cause since Bitbucket's app-password retirement — a
 *  token that authenticates fine but lacks the scope the call needs. The
 *  append keeps the real message first (so it's never discarded or buried)
 *  and still carries the `Settings → ${GIT_HOST_TOKENS_SECTION}` marker
 *  phrase so the webview's credential-error panel renders for this case too.
 *  The underlying `message` is always preserved in the enriched text so a
 *  real, specific API error is never discarded. `hadCreds` (was a credential
 *  configured for this host at all, regardless of whether it worked?) picks
 *  between "add a credential" and "the configured credential can't access
 *  it" for 404 — the latter also calls out Bitbucket's 2026-06-09
 *  app-password retirement, since a stale app password is a common way a
 *  previously-working credential starts failing. Any other status is
 *  returned unchanged. Pure — exported via `__bitbucketInternals` for unit
 *  testing. */
function bitbucketAccessHint(status: number, message: string, repo: ProviderRepoInfo, hadCreds: boolean): string {
  if (status !== 401 && status !== 403 && status !== 404) return message;
  const host = repo.remoteHost || "bitbucket.org";
  if (status === 403 && hadCreds) {
    return `${message} — if the configured credential for ${host} lacks the required Bitbucket scopes, update it in Settings → ${GIT_HOST_TOKENS_SECTION}.`;
  }
  const settingsPointer = `Settings → ${GIT_HOST_TOKENS_SECTION} (Bitbucket Basic auth: email:api_token)`;
  if (status === 401) {
    return hadCreds
      ? `Bitbucket authentication failed (${message}) — the credential stored for ${host} was rejected; replace it in ${settingsPointer}. Check it's a current API token, not a retired app password.`
      : `Bitbucket authentication failed (${message}) — add a credential for ${host} in ${settingsPointer}.`;
  }
  const base = `${repo.owner}/${repo.name} was not found on Bitbucket (${message}) — if the repo is private, add a credential for ${host} in ${settingsPointer}`;
  return hadCreds
    ? `${base} (the configured credential cannot access it — check it belongs to the right account and is a current API token, not a retired app password).`
    : base;
}

/** Single choke point tying a non-2xx `Response` + parsed body to the enriched
 *  message, threading the resolved repo and whether creds were sent — mirrors
 *  gitlab.ts's `errorFrom(res, body, repo, hadToken)`. Nearly every Bitbucket
 *  call site routes its error branch through this so the whole adapter gets
 *  hint parity in one place. */
function errorFrom(res: Response, body: unknown, repo: ProviderRepoInfo, hadCreds: boolean): string {
  return bitbucketAccessHint(res.status, apiErrorMessage(body, res.status, res.statusText), repo, hadCreds);
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
    // Only shortcut to "issue tracker is not enabled" when a credential was
    // actually sent — an unauthenticated 404 is ambiguous (could just as
    // easily be a private repo with no credential configured), so it falls
    // through to `errorFrom`'s enriched hint instead of masking the real
    // credential-gap signal behind a misleading tracker-disabled message.
    if (opts.kind === "issues" && res.status === 404 && creds) {
      return { ok: false, error: "issue tracker is not enabled for this repository" };
    }
    return { ok: false, error: errorFrom(res, body, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
    return { ok: false, error: bitbucketAccessHint(res.status, msg || `${res.status} ${res.statusText}`, repo, !!creds) };
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

/** Structurally identical to `git-host.ts`'s `PullBlobResult` — kept as a
 *  separate declaration (rather than imported) for the same reason
 *  github.ts's `GitHubBlobResult` is: `git-host.ts` is the consumer, not the
 *  source, of this module's types, and TS's structural typing makes the two
 *  interchangeable at the `pullBlob` dispatch call site. */
type BitbucketBlobResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; contentType: string; ref: string }
  | { ok: false; error: string; status?: number };

/** Short-TTL cache of a PR's source/destination commit shas + source/
 *  destination repo full names, keyed `${remoteHost}/${owner}/${name}#${number}` —
 *  mirrors github.ts's `pullDetailCache` (60s TTL, so a fresh push to the PR
 *  is picked up reasonably promptly; crude size-guard eviction rather than an
 *  LRU, since a single workstation's Git Integration modal won't realistically
 *  open enough distinct PRs in one process lifetime to make eviction policy
 *  matter). Without it, previewing both sides of a binary file — or paging
 *  through several binary files in the same PR — would re-fetch
 *  `GET /pullrequests/:number` from scratch every time. */
interface BitbucketPullDetailCacheEntry {
  sourceSha: string;
  destSha: string;
  sourceRepoFullName: string | null;
  destRepoFullName: string | null;
  fetchedAt: number;
}
const bitbucketPullDetailCache = new Map<string, BitbucketPullDetailCacheEntry>();
const BITBUCKET_PULL_DETAIL_CACHE_LIMIT = 200;
const BITBUCKET_PULL_DETAIL_CACHE_TTL_MS = 60_000;

function cacheBitbucketPullDetail(key: string, entry: BitbucketPullDetailCacheEntry): void {
  if (bitbucketPullDetailCache.size >= BITBUCKET_PULL_DETAIL_CACHE_LIMIT && !bitbucketPullDetailCache.has(key)) {
    bitbucketPullDetailCache.clear();
  }
  bitbucketPullDetailCache.set(key, entry);
}

/** Merge-base sha cache for the "old" side of a PR blob fetch, keyed
 *  `${remoteHost}/${owner}/${name}#${number}@${sourceSha}` — mirrors
 *  github.ts's `mergeBaseCache` (no TTL: a resolved merge-base commit is
 *  immutable once computed, unlike the PR detail above). Only successful
 *  resolutions are cached; a failed redirect-sniff (see
 *  `extractMergeBaseFromDiffLocation`) is re-attempted on the next request
 *  rather than being cached as a permanent miss. */
const bitbucketMergeBaseCache = new Map<string, string>();
const BITBUCKET_MERGE_BASE_CACHE_LIMIT = 200;

function cacheBitbucketMergeBase(key: string, sha: string): void {
  if (bitbucketMergeBaseCache.size >= BITBUCKET_MERGE_BASE_CACHE_LIMIT && !bitbucketMergeBaseCache.has(key)) {
    bitbucketMergeBaseCache.clear();
  }
  bitbucketMergeBaseCache.set(key, sha);
}

/**
 * Extracts a merge-base sha candidate from the `Location` header of a
 * `.../pullrequests/:id/diff` response fetched with `redirect: "manual"`.
 * Bitbucket 30x-redirects that endpoint to a fully-resolved diff spec that
 * embeds both the source and destination commits it computed the (merge-base
 * -anchored, three-dot) diff against — the exact shape isn't documented
 * (something like `.../diff/{workspace}/{slug}:{sourceSha}%0D{destSpec}` or a
 * `{source}..{dest}`-style path segment), so this parses defensively: pull
 * every 7-40 char hex run out of the Location, drop any that match the known
 * `sourceSha` (by exact match or hex-prefix, either direction — Bitbucket may
 * echo an abbreviated hash), and de-duplicate what's left. Exactly one
 * surviving candidate is treated as the merge base; zero or two-or-more means
 * the heuristic can't tell which one it is (nothing recognizable, or an
 * ambiguous Location shape), so it gives up and returns null rather than
 * guessing wrong — the caller falls back to `destination.commit.hash` in
 * that case. Pure — exported via `__bitbucketInternals` for unit testing.
 */
function extractMergeBaseFromDiffLocation(location: string, sourceSha: string): string | null {
  const hexRun = /\b[0-9a-f]{7,40}\b/gi;
  const matches = location.match(hexRun) ?? [];
  const sourceLower = sourceSha.toLowerCase();
  const candidates = new Set(
    matches
      .map((m) => m.toLowerCase())
      .filter((m) => m !== sourceLower && !m.startsWith(sourceLower) && !sourceLower.startsWith(m)),
  );
  return candidates.size === 1 ? [...candidates][0] ?? null : null;
}

/** Resolves the merge-base sha for the "old" side of a PR blob fetch:
 *  primary strategy is the redirect-sniff (`extractMergeBaseFromDiffLocation`)
 *  against the `.../diff` endpoint's 30x `Location`; returns null (not the
 *  fallback sha) when the sniff fails so the caller can apply the documented
 *  `destination.commit.hash` approximation itself and know which path was
 *  taken. Cached only on success — see `bitbucketMergeBaseCache`. */
async function resolveBitbucketMergeBase(
  repo: ProviderRepoInfo,
  number: number,
  sourceSha: string,
  creds: BitbucketCreds | null,
): Promise<string | null> {
  const cacheKey = `${repo.remoteHost}/${repo.owner}/${repo.name}#${number}@${sourceSha}`;
  const cached = bitbucketMergeBaseCache.get(cacheKey);
  if (cached) return cached;

  const res = await fetchBitbucket(
    `${repoBasePath(repo)}/pullrequests/${number}/diff`,
    creds,
    "*/*",
    { redirect: "manual" },
  );
  if (!("status" in res)) return null;
  const location = res.headers.get("location");
  if (!location) return null;
  const candidate = extractMergeBaseFromDiffLocation(location, sourceSha);
  if (!candidate) return null;
  cacheBitbucketMergeBase(cacheKey, candidate);
  return candidate;
}

/** Builds a `ProviderRepoInfo` for a PR side's `full_name` (`"workspace/
 *  repo_slug"`, as read off `source.repository.full_name`/
 *  `destination.repository.full_name` or the cached
 *  `BitbucketPullDetailCacheEntry`), reusing the *original* repo's `provider`
 *  /`host`/`remoteHost` — the fork lives on the same Bitbucket workspace host,
 *  and credentials are stored per-host, not per-repo. Returns null when
 *  `fullName` is null (e.g. the fork/source repo was deleted) or malformed. */
function bitbucketRepoFromFullName(fullName: string | null, base: ProviderRepoInfo): ProviderRepoInfo | null {
  if (!fullName) return null;
  const slash = fullName.indexOf("/");
  if (slash === -1) return null;
  return {
    provider: base.provider,
    host: base.host,
    remoteHost: base.remoteHost,
    owner: fullName.slice(0, slash),
    name: fullName.slice(slash + 1),
  };
}

/** `/src/{ref}/{path}` for a resolved repo — each path segment is
 *  URL-encoded but `/` separators are preserved (Bitbucket treats them as
 *  directories), mirroring `contentsUrl` in github.ts. */
function srcUrl(repo: ProviderRepoInfo, ref: string, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `${repoBasePath(repo)}/src/${encodeURIComponent(ref)}/${encodedPath}`;
}

/**
 * Fetches the raw bytes of a single file from one side (old/new) of a
 * Bitbucket pull request's diff, for the binary-preview UI. Dispatched
 * through `git-host.ts`'s `pullBlob`.
 *
 * - `side: "new"` reads the file at `source.commit.hash`, from the *source*
 *   repository (a fork for a cross-repo PR).
 * - `side: "old"` reads the file at the PR's merge-base commit — Bitbucket's
 *   PR diff (`getBitbucketPullDiff`, same `.../diff` endpoint) is three-dot
 *   (merge-base-anchored), and there is no official merge-base endpoint to
 *   resolve it directly. This fetches it two ways: primary is a
 *   redirect-sniff against the diff endpoint itself
 *   (`resolveBitbucketMergeBase`); when that fails (no Location header, or
 *   an ambiguous/unparseable one), it falls back to
 *   `destination.commit.hash` — an **approximation** that drifts if the
 *   destination branch has moved (and touched the same file) since the PR
 *   diverged from it, the same "approximated" tone this module already uses
 *   for `mergedAt`/`closedAt`. The old side is read from the *destination*
 *   repository either way.
 *
 * Bytes come from the Source API (`GET .../src/{ref}/{path}`), which returns
 * raw file content directly (no base64 envelope). Size is checked twice: from
 * `content-length` before reading the body (cheap rejection of an obviously
 * too-large file), and again against the actual byte count after
 * `arrayBuffer()` (Bitbucket can send a chunked response with no
 * `content-length`) — same double-guard as `getGitHubPullBlob`, against
 * `MAX_BLOB_PREVIEW_BYTES` (not `BITBUCKET_DIFF_BODY_CAP_BYTES`, which bounds
 * the unified diff text, a different budget from a single file's bytes).
 *
 * No short-circuit on missing credentials: like every other read in this
 * module (`getBitbucketPullDiff`, `getBitbucketPullChecks`, …), a public
 * repo's blob is readable with `creds: null`; a private one surfaces through
 * `bitbucketAccessHint`'s 401/403/404 enrichment same as any other call.
 */
export async function getBitbucketPullBlob(
  repo: ProviderRepoInfo,
  number: number,
  relPath: string,
  side: "old" | "new",
): Promise<BitbucketBlobResult> {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, error: "pull request number must be positive", status: 400 };
  }
  const path = relPath.trim().replace(/^\/+/, "");
  if (!path) return { ok: false, error: "file path is required", status: 400 };

  const creds = await bitbucketCreds(repo.remoteHost);

  // PR detail (source/destination sha + repo full names) is cached for a
  // short TTL — see `bitbucketPullDetailCache`'s doc comment. Avoids a
  // redundant `GET /pullrequests/:number` for every blob request against the
  // same PR.
  const detailKey = `${repo.remoteHost}/${repo.owner}/${repo.name}#${number}`;
  const cachedDetail = bitbucketPullDetailCache.get(detailKey);
  let sourceSha: string;
  let destSha: string;
  let sourceRepoFullName: string | null;
  let destRepoFullName: string | null;
  if (cachedDetail && Date.now() - cachedDetail.fetchedAt < BITBUCKET_PULL_DETAIL_CACHE_TTL_MS) {
    ({ sourceSha, destSha, sourceRepoFullName, destRepoFullName } = cachedDetail);
  } else {
    const prRes = await fetchBitbucket(`${repoBasePath(repo)}/pullrequests/${number}`, creds, "application/json");
    if (!("status" in prRes)) return { ok: false, error: prRes.error, status: 502 };
    const prJson = await prRes.json().catch(() => null);
    if (!prRes.ok) {
      return { ok: false, error: errorFrom(prRes, prJson, repo, !!creds), status: prRes.status };
    }
    const prObj = prJson && typeof prJson === "object" ? prJson as Record<string, unknown> : {};
    const source = prObj.source && typeof prObj.source === "object" ? prObj.source as Record<string, unknown> : {};
    const destination = prObj.destination && typeof prObj.destination === "object"
      ? prObj.destination as Record<string, unknown>
      : {};
    const sourceCommit = source.commit && typeof source.commit === "object" ? source.commit as Record<string, unknown> : {};
    const destCommit = destination.commit && typeof destination.commit === "object"
      ? destination.commit as Record<string, unknown>
      : {};
    const resolvedSourceSha = typeof sourceCommit.hash === "string" ? sourceCommit.hash : null;
    const resolvedDestSha = typeof destCommit.hash === "string" ? destCommit.hash : null;
    if (!resolvedSourceSha || !resolvedDestSha) {
      return { ok: false, error: "Bitbucket returned a pull request without source/destination commit hashes", status: 502 };
    }
    sourceSha = resolvedSourceSha;
    destSha = resolvedDestSha;
    const sourceRepo = source.repository && typeof source.repository === "object"
      ? source.repository as Record<string, unknown>
      : {};
    const destRepo = destination.repository && typeof destination.repository === "object"
      ? destination.repository as Record<string, unknown>
      : {};
    sourceRepoFullName = typeof sourceRepo.full_name === "string" ? sourceRepo.full_name : null;
    destRepoFullName = typeof destRepo.full_name === "string" ? destRepo.full_name : null;
    cacheBitbucketPullDetail(detailKey, { sourceSha, destSha, sourceRepoFullName, destRepoFullName, fetchedAt: Date.now() });
  }

  let blobRepo: ProviderRepoInfo;
  let ref: string;
  if (side === "new") {
    blobRepo = bitbucketRepoFromFullName(sourceRepoFullName, repo) ?? repo;
    ref = sourceSha;
  } else {
    blobRepo = bitbucketRepoFromFullName(destRepoFullName, repo) ?? repo;
    const mergeBase = await resolveBitbucketMergeBase(repo, number, sourceSha, creds);
    // Fallback: `destination.commit.hash` approximation — see this
    // function's doc comment.
    ref = mergeBase ?? destSha;
  }

  const fileRes = await fetchBitbucket(srcUrl(blobRepo, ref, path), creds, "*/*");
  if (!("status" in fileRes)) return { ok: false, error: fileRes.error, status: 502 };
  if (fileRes.status === 404) return { ok: false, error: "file not present on this side", status: 404 };
  if (!fileRes.ok) {
    const raw = await fileRes.text().catch(() => "");
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      if (parsed.error && typeof parsed.error.message === "string") msg = parsed.error.message;
    } catch { /* the src endpoint can return plain text on some errors too */ }
    return {
      ok: false,
      error: bitbucketAccessHint(fileRes.status, msg || `${fileRes.status} ${fileRes.statusText}`, blobRepo, !!creds),
      status: fileRes.status,
    };
  }

  const contentLength = Number(fileRes.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BLOB_PREVIEW_BYTES) {
    return { ok: false, error: `File is too large to preview (${Math.ceil(contentLength / 1_000_000)} MB).`, status: 413 };
  }
  const buf = await fileRes.arrayBuffer().catch(() => null);
  if (!buf) return { ok: false, error: "Bitbucket returned an unreadable file response", status: 502 };
  if (buf.byteLength > MAX_BLOB_PREVIEW_BYTES) {
    return { ok: false, error: `File is too large to preview (${Math.ceil(buf.byteLength / 1_000_000)} MB).`, status: 413 };
  }

  return {
    ok: true,
    bytes: new Uint8Array(buf),
    contentType: contentTypeForPreviewPath(path) ?? fileRes.headers.get("content-type") ?? "application/octet-stream",
    ref,
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
    // Same gating as listBitbucketItems above: only shortcut to
    // "issue tracker is not enabled" once a credential was sent, so an
    // unauthenticated 404 falls through to the enriched hint instead.
    if (kind === "issues" && res.status === 404 && creds) {
      return { ok: false, error: "issue tracker is not enabled for this repository" };
    }
    return { ok: false, error: errorFrom(res, body, repo, !!creds) };
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
    return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, body, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!prRes.ok) return { ok: false, error: errorFrom(prRes, prJson, repo, !!creds) };
  const prObj = prJson && typeof prJson === "object" ? prJson as Record<string, unknown> : {};
  const source = prObj.source && typeof prObj.source === "object" ? prObj.source as Record<string, unknown> : {};
  const commit = source.commit && typeof source.commit === "object" ? source.commit as Record<string, unknown> : {};
  const sha = typeof commit.hash === "string" ? commit.hash : "";

  const statusesUrl = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/pullrequests/${number}/statuses`);
  statusesUrl.searchParams.set("pagelen", String(BITBUCKET_PAGELEN));
  const res = await fetchBitbucket(statusesUrl.toString(), creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
  const values = json && typeof json === "object" && Array.isArray((json as { values?: unknown }).values)
    ? (json as { values: unknown[] }).values
    : [];
  const checkRuns = values.map((v, i) => normalizeBitbucketCheckRun(v, i)).filter((x): x is GitHubCheckRun => !!x);

  return { ok: true, repo: `${repo.owner}/${repo.name}`, pullNumber: number, sha, checkRuns };
}

type BitbucketMergeabilityResponse = ({ ok: true } & GitHubPullMergeability) | BitbucketError;

/** How many diffstat pages `scanBitbucketDiffstatConflicts` will follow before
 *  giving up and reporting "unknown" rather than risk a false "clean" on
 *  partial data — 10 pages of `pagelen=100` covers 1000 changed files. */
const BITBUCKET_DIFFSTAT_PAGE_CAP = 10;

/**
 * Scans a pull request's diffstat for Bitbucket's per-file `status: "merge
 * conflict"` marker — Bitbucket Cloud's PR resource has no top-level
 * mergeable field (unlike GitHub's `mergeable`/`mergeable_state`), so the
 * diffstat listing is the only conflict signal available. Stops as soon as a
 * conflicted entry is found. Returns:
 *  - "dirty" as soon as any page yields a conflicted entry.
 *  - "clean" only once every page has been walked (no `next` remains) with
 *    no conflicted entry seen.
 *  - "unknown" on any fetch/parse failure, when the page cap is exhausted
 *    while a `next` link still remains, or when a `next` link is rejected by
 *    `sanitizeNextUrl` (off-origin/malformed) — reporting "clean" on partial
 *    data would be worse than reporting "unknown".
 */
async function scanBitbucketDiffstatConflicts(
  repo: ProviderRepoInfo,
  number: number,
  creds: BitbucketCreds | null,
): Promise<"dirty" | "clean" | "unknown"> {
  const firstUrl = new URL(`${BITBUCKET_API_BASE}${repoBasePath(repo)}/pullrequests/${number}/diffstat`);
  firstUrl.searchParams.set("pagelen", "100");
  let url: string | null = firstUrl.toString();

  for (let page = 0; page < BITBUCKET_DIFFSTAT_PAGE_CAP && url; page++) {
    const res = await fetchBitbucket(url, creds, "application/json");
    if (!("status" in res) || !res.ok) return "unknown";
    const body = await res.json().catch(() => null);
    const values = body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
      ? (body as { values: unknown[] }).values
      : null;
    if (!values) return "unknown";
    for (const raw of values) {
      const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
      const status = obj && typeof obj.status === "string" ? obj.status : "";
      // "merge conflict" covers a modify/modify conflict; a delete/modify
      // conflict instead surfaces as a per-side "local deleted"/"remote
      // deleted" status with no "conflict" substring of its own — without
      // this, a deleted-vs-modified file would walk through as clean.
      if (status.includes("conflict") || status === "local deleted" || status === "remote deleted") return "dirty";
    }
    const rawNext = (body as { next?: unknown }).next;
    // A `next` link present but rejected by `sanitizeNextUrl` (off-origin,
    // malformed) is NOT the same as no `next` at all — there may be more
    // pages this scan is refusing to follow, so it must not fall through to
    // "clean" below. Distinguish "no next" (natural end) from "next present
    // but untrusted" (unresolved end) explicitly.
    if (typeof rawNext === "string" && rawNext) {
      const sanitized = sanitizeNextUrl(rawNext);
      if (!sanitized) return "unknown";
      url = sanitized;
    } else {
      url = null;
    }
  }
  return url ? "unknown" : "clean";
}

/**
 * Pure field mapping from a Bitbucket PR detail JSON plus a pre-computed
 * `conflictScan` verdict (from `scanBitbucketDiffstatConflicts`) into the
 * shared `GitHubPullMergeability` shape. Kept separate from the network walk
 * so the mapping is test-friendly without mocking fetch. `mergeable`/
 * `mergeableState` only reflect `conflictScan` when the PR is OPEN — a
 * merged/declined/superseded PR has nothing left to conflict against, so it
 * always reports "unknown"/null there, matching `getBitbucketPullMergeability`
 * (which skips the diffstat scan entirely for non-OPEN state).
 */
export function normalizeBitbucketMergeability(
  repo: ProviderRepoInfo,
  number: number,
  pr: unknown,
  conflictScan: "dirty" | "clean" | "unknown",
): GitHubPullMergeability {
  const obj = pr && typeof pr === "object" ? pr as Record<string, unknown> : {};
  const source = obj.source && typeof obj.source === "object" ? obj.source as Record<string, unknown> : {};
  const destination = obj.destination && typeof obj.destination === "object"
    ? obj.destination as Record<string, unknown>
    : {};
  const sourceBranch = source.branch && typeof source.branch === "object" ? source.branch as Record<string, unknown> : {};
  const destBranch = destination.branch && typeof destination.branch === "object"
    ? destination.branch as Record<string, unknown>
    : {};
  const sourceCommit = source.commit && typeof source.commit === "object" ? source.commit as Record<string, unknown> : {};
  const sourceRepo = source.repository && typeof source.repository === "object"
    ? source.repository as Record<string, unknown>
    : {};
  const destRepo = destination.repository && typeof destination.repository === "object"
    ? destination.repository as Record<string, unknown>
    : {};

  const headRepo = typeof sourceRepo.full_name === "string" ? sourceRepo.full_name : null;
  const baseRepo = typeof destRepo.full_name === "string" ? destRepo.full_name : null;
  const state = typeof obj.state === "string" ? obj.state : "";

  const { mergeable, mergeableState } = state === "OPEN"
    ? conflictScan === "dirty"
      ? { mergeable: false, mergeableState: "dirty" }
      : conflictScan === "clean"
        ? { mergeable: true, mergeableState: "clean" }
        : { mergeable: null, mergeableState: "unknown" }
    : { mergeable: null, mergeableState: "unknown" };

  const normalizedState = state === "OPEN" ? "open" : state === "MERGED" ? "merged" : (state === "DECLINED" || state === "SUPERSEDED") ? "closed" : "unknown";

  return {
    repo: `${repo.owner}/${repo.name}`,
    pullNumber: number,
    mergeable,
    mergeableState,
    rebaseable: null,
    merged: state === "MERGED",
    draft: obj.draft === true,
    state: normalizedState,
    headRef: typeof sourceBranch.name === "string" ? sourceBranch.name : "",
    baseRef: typeof destBranch.name === "string" ? destBranch.name : "",
    headSha: typeof sourceCommit.hash === "string" ? sourceCommit.hash : "",
    autoMerge: false,
    headRepo,
    // Fail closed: only a confirmed same-full_name match is same-repo. A
    // missing head or base repo (can't confirm) is treated as cross-repo,
    // matching github.ts's normalizeMergeability contract.
    crossRepo: headRepo === null || baseRepo === null || headRepo !== baseRepo,
  };
}

/**
 * Bitbucket's PR resource carries no `mergeable`/`mergeable_state` fields
 * (unlike GitHub), so this fetches the PR detail for the head/base/state
 * fields and — only when the PR is OPEN — follows up with a diffstat scan
 * (`scanBitbucketDiffstatConflicts`) for the actual conflict signal. Non-OPEN
 * PRs (merged/declined/superseded) skip the scan entirely, matching
 * `normalizeBitbucketMergeability`'s non-OPEN "unknown" mapping. Unlike
 * `getGitHubPullMergeability`, there's no retry/poll loop — Bitbucket's
 * diffstat is computed synchronously, not in the background.
 */
export async function getBitbucketPullMergeability(
  repo: ProviderRepoInfo,
  number: number,
): Promise<BitbucketMergeabilityResponse> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "pull request number must be positive" };
  const creds = await bitbucketCreds(repo.remoteHost);

  const res = await fetchBitbucket(`${repoBasePath(repo)}/pullrequests/${number}`, creds, "application/json");
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Bitbucket returned an unexpected pull request response" };
  }

  const state = typeof (json as Record<string, unknown>).state === "string"
    ? (json as Record<string, unknown>).state as string
    : "";
  const conflictScan = state === "OPEN" ? await scanBitbucketDiffstatConflicts(repo, number, creds) : "unknown";

  return { ok: true, ...normalizeBitbucketMergeability(repo, number, json, conflictScan) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
  if (!res.ok) return { ok: false, error: errorFrom(res, json, repo, !!creds) };

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
    return { ok: false, error: errorFrom(res, json, repo, !!creds) };
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
    return { ok: false, error: errorFrom(res, json, repo, !!creds) };
  }
  const item = normalizeBitbucketIssue(json, null);
  if (!item) return { ok: false, error: "Bitbucket returned an unexpected issue response" };
  return { ok: true, item, message: "Issue updated." };
}

/** Account-flavored counterpart to `bitbucketAccessHint`, used only by
 *  `getBitbucketViewer`. `/2.0/user` has no repo in scope — reusing
 *  `bitbucketAccessHint`'s 403/404 wording verbatim would render a nonsensical
 *  "owner/repo was not found on Bitbucket" for what is really an account-level
 *  read failure. 401 handling (auth flavor: invalid/missing credentials) is
 *  identical regardless of endpoint, so it's delegated straight to
 *  `bitbucketAccessHint`; 403/404 instead get account-flavored wording; any
 *  other status passes the message through unchanged. */
function bitbucketViewerAccessHint(status: number, message: string, repo: ProviderRepoInfo, hadCreds: boolean): string {
  if (status === 401) return bitbucketAccessHint(status, message, repo, hadCreds);
  if (status !== 403 && status !== 404) return message;
  const host = repo.remoteHost || "bitbucket.org";
  return `your Bitbucket account could not be read (${message}) — check the credential for ${host} in Settings → ${GIT_HOST_TOKENS_SECTION}`;
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
  if (!res.ok) {
    return {
      ok: false,
      error: bitbucketViewerAccessHint(res.status, apiErrorMessage(json, res.status, res.statusText), repo, !!creds),
    };
  }
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
  bitbucketAccessHint,
  bitbucketViewerAccessHint,
  errorFrom,
  normalizeBitbucketUser,
  normalizeBitbucketPull,
  normalizeBitbucketIssue,
  normalizeBitbucketComment,
  normalizeBitbucketLineComment,
  normalizeBitbucketCheckRun,
  normalizeBitbucketMergeability,
  extractMergeBaseFromDiffLocation,
  bitbucketRepoFromFullName,
  scanBitbucketDiffstatConflicts,
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
