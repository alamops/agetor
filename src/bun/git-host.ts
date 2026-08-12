import type {
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubLabelsResult,
  GitHubListItem,
  GitHubListResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullMergeResult,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewEvent,
  GitHubRateLimit,
  GitProvider,
  TaskDiff,
} from "../shared/types.ts";
import {
  closeGitHubPull,
  createGitHubComment,
  createGitHubIssue,
  createGitHubPull,
  createGitHubPullLineComment,
  getGitHubPullBlob,
  getGitHubPullChecks,
  getGitHubPullDefaults,
  getGitHubPullDetail,
  getGitHubPullDiff,
  getGitHubPullMergeability,
  getGitHubViewer,
  listGitHubComments,
  listGitHubItems,
  listGitHubItemsAcrossRepos,
  listGitHubLabels,
  listGitHubPullReviewComments,
  mergeGitHubPull,
  reopenGitHubPull,
  replyGitHubPullLineComment,
  reviewGitHubPull,
  run,
  updateGitHubIssue,
} from "./github.ts";
import { providerRepoForDir } from "./git-provider.ts";
import {
  closeGitLabPull,
  createGitLabComment,
  createGitLabIssue,
  createGitLabPull,
  createGitLabPullLineComment,
  getGitLabPullChecks,
  getGitLabPullDefaults,
  getGitLabPullDetail,
  getGitLabPullDiff,
  getGitLabPullMergeability,
  getGitLabViewer,
  listGitLabComments,
  listGitLabItems,
  listGitLabLabels,
  listGitLabPullReviewComments,
  mergeGitLabPull,
  reopenGitLabPull,
  replyGitLabLineComment,
  reviewGitLabPull,
  updateGitLabIssue,
} from "./gitlab.ts";
import {
  closeBitbucketPull,
  createBitbucketComment,
  createBitbucketIssue,
  createBitbucketPull,
  createBitbucketPullLineComment,
  getBitbucketPullChecks,
  getBitbucketPullDefaults,
  getBitbucketPullDetail,
  getBitbucketPullDiff,
  getBitbucketPullMergeability,
  getBitbucketViewer,
  listBitbucketComments,
  listBitbucketItems,
  listBitbucketPullReviewComments,
  mergeBitbucketPull,
  reopenBitbucketPull,
  replyBitbucketLineComment,
  reviewBitbucketPull,
  updateBitbucketIssue,
} from "./bitbucket.ts";

/**
 * Provider dispatch facade (T4, docs/plans/multi-provider-git-modal.md §4).
 * server.ts's core `/github/*` routes call into this module instead of
 * `github.ts` directly; this is the single choke point that decides — per
 * project directory — whether a request is served by GitHub (`github.ts`,
 * unchanged pass-through), GitLab (`gitlab.ts`), or Bitbucket (`bitbucket.ts`).
 *
 * Every exported function here takes the same `{dir, ...}`-shaped input the
 * route used to pass straight to a `github.ts` function. On the GitHub path
 * that object is passed straight through — zero behavior change, since
 * `github.ts`'s own functions are untouched. On the GitLab/Bitbucket path,
 * `providerRepoForDir` resolves the already-detected `ProviderRepoInfo` once,
 * and the adapter (which never shells out to git or resolves a remote itself)
 * is called with it.
 *
 * Two things the adapters can't do themselves, because they only ever see a
 * resolved `ProviderRepoInfo` with no working directory (see their own doc
 * comments):
 *  - `sourcePath` on every normalized `GitHubListItem` is null coming out of
 *    an adapter — `withSourcePath` stitches `dir` on, mirroring what
 *    `github.ts`'s own `normalizeItem(kind, raw, dir)` does inline.
 *  - `pullDefaults().head` (the current local branch) can't be read without a
 *    working directory — `currentBranchFor` fills it in for GitLab/Bitbucket
 *    the same way `getGitHubPullDefaults` reads it via `git branch
 *    --show-current` for GitHub.
 *
 * Never throws across the route boundary: every function resolves to
 * `{ok:true, ...} | {ok:false, error}`, same convention as `github.ts`.
 */

const NO_REMOTE_ERROR = "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)";

export interface FacadeError {
  ok: false;
  error: string;
}

type ListResponse = ({ ok: true } & GitHubListResult) | FacadeError;
type PullDefaultsResponse = ({ ok: true } & GitHubPullDefaultsResult) | FacadeError;
type IssueResponse = ({ ok: true; item: GitHubListItem; message?: string }) | FacadeError;
type DiffResponse = ({ ok: true } & TaskDiff) | FacadeError;
type CommentsResponse = ({ ok: true } & GitHubCommentsResult) | FacadeError;
type CommentResponse = ({ ok: true; comment: GitHubComment }) | FacadeError;
type LineCommentResponse = ({ ok: true; comment: GitHubPullLineComment }) | FacadeError;
type ReviewCommentsResponse = ({ ok: true } & GitHubPullReviewCommentsResult) | FacadeError;
type ChecksResponse = ({ ok: true } & GitHubChecksResult) | FacadeError;
type MergeabilityResponse = ({ ok: true } & GitHubPullMergeability) | FacadeError;
type MergeResponse = GitHubPullMergeResult | FacadeError;
type ActionResponse = ({ ok: true; message?: string; item?: GitHubListItem; commentPosted?: boolean }) | FacadeError;
type ViewerResponse = ({ ok: true; login: string }) | FacadeError;
type LabelsResponse = ({ ok: true } & GitHubLabelsResult) | FacadeError;

function withSourcePath(item: GitHubListItem, dir: string): GitHubListItem {
  return { ...item, sourcePath: dir };
}

/** Mirrors `github.ts`'s own (unexported) `currentBranch` — used to fill in
 *  `pullDefaults().head` for GitLab/Bitbucket, which have no local working
 *  directory to read a branch from (see the module doc comment). */
async function currentBranchFor(dir: string): Promise<string> {
  const result = await run(["git", "branch", "--show-current"], dir, 5_000);
  return result.ok ? result.stdout.trim() : "";
}

/**
 * Resolves which provider (and repo identity) a project directory's git
 * remote points at — powers the new `/github/provider-info` route the UI
 * (T5) uses to pick terminology/gating before making any other call.
 */
export async function providerInfoForDir(
  dir: string,
): Promise<
  | { ok: true; provider: GitProvider; owner: string; name: string; host: string; remoteHost: string }
  | FacadeError
> {
  const info = await providerRepoForDir(dir);
  if (!info) return { ok: false, error: NO_REMOTE_ERROR };
  return { ok: true, provider: info.provider, owner: info.owner, name: info.name, host: info.host, remoteHost: info.remoteHost };
}

export interface ListItemsInput {
  dir: string;
  kind: GitHubItemKind;
  state: GitHubItemState;
  query?: string;
  labels?: string[];
  assignee?: string;
  createdByMe?: boolean;
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  /** GitHub-only raw search qualifiers — ignored on GitLab/Bitbucket, whose
   *  adapters use structured filters instead. */
  searchQuery?: string;
  page?: number;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
}

/** Single-repo item listing, dispatched by provider. GitHub delegates
 *  straight to `listGitHubItems` (unchanged). GitLab/Bitbucket dispatch to
 *  their adapter and stitch `sourcePath = dir` onto every returned item
 *  (adapters always normalize it to null — see the module doc comment). */
export async function listItems(input: ListItemsInput): Promise<ListResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return listGitHubItems(input);

  const opts = {
    kind: input.kind,
    state: input.state,
    query: input.query,
    labels: input.labels,
    assignee: input.assignee,
    createdByMe: input.createdByMe,
    assignedToMe: input.assignedToMe,
    reviewRequested: input.reviewRequested,
    page: input.page,
    sort: input.sort,
    direction: input.direction,
  };
  const res = repoInfo.provider === "gitlab" ? await listGitLabItems(repoInfo, opts) : await listBitbucketItems(repoInfo, opts);
  if (!res.ok) return res;
  return { ...res, items: res.items.map((item) => withSourcePath(item, input.dir)) };
}

export interface ListItemsAcrossReposInput {
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

const AGGREGATE_CONCURRENCY = 5;

/**
 * Multi-repo aggregate listing ("All repositories" in the dialog).
 *
 * Zero-regression fast path: when every selected dir resolves to GitHub, this
 * delegates wholesale to `listGitHubItemsAcrossRepos` — the exact same code
 * path as before this facade existed.
 *
 * Otherwise (mixed providers, or all non-GitHub): each dir is detected once,
 * then dispatched through this module's own single-repo `listItems` (so each
 * repo gets its own provider's auth + normalization), and the per-repo
 * results are merged/sorted/truncated with the same policy
 * `listGitHubItemsAcrossRepos` uses — a bounded-concurrency worker pool, a
 * failing repo is skipped rather than failing the whole aggregate, default
 * sort is "updated desc" (no cross-repo relevance signal to rank by), and
 * `hasMore` on the merged result means "at least one contributing repo had
 * more than one page" (truncated), not "there's a page 2 to fetch" — the UI
 * has no per-repo cursor to advance in aggregate mode, matching the existing
 * GitHub-only aggregate's documented behavior.
 */
export async function listItemsAcrossRepos(input: ListItemsAcrossReposInput): Promise<ListResponse> {
  const dirs = Array.from(new Set(input.dirs.filter((d) => d.trim())));
  if (dirs.length === 0) return { ok: false, error: "no projects to aggregate" };

  const providers = new Map<string, GitProvider | null>();
  for (const dir of dirs) {
    const info = await providerRepoForDir(dir);
    providers.set(dir, info?.provider ?? null);
  }

  if (dirs.every((d) => providers.get(d) === "github")) {
    return listGitHubItemsAcrossRepos({
      dirs,
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
    });
  }

  const perRepo: { dir: string; res: ListResponse }[] = new Array(dirs.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= dirs.length) return;
      const dir = dirs[i]!;
      perRepo[i] = {
        dir,
        res: await listItems({
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
        }),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGGREGATE_CONCURRENCY, dirs.length) }, worker));

  const repos: string[] = [];
  const items: GitHubListItem[] = [];
  let truncated = false;
  let auth: "token" | "none" = "none";
  let rateLimit: GitHubRateLimit | null = null;
  for (const { dir, res } of perRepo) {
    if (!res.ok) continue;
    repos.push(res.repo);
    for (const item of res.items) items.push(withSourcePath(item, dir));
    if (res.hasMore) truncated = true;
    if (res.auth === "token") auth = "token";
    if (res.rateLimit && (!rateLimit || res.rateLimit.remaining < rateLimit.remaining)) rateLimit = res.rateLimit;
  }
  if (repos.length === 0) {
    return { ok: false, error: "none of the selected projects have a usable git remote" };
  }

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

export async function pullDefaults(input: { dir: string }): Promise<PullDefaultsResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullDefaults(input);
  const res = repoInfo.provider === "gitlab" ? await getGitLabPullDefaults(repoInfo) : await getBitbucketPullDefaults(repoInfo);
  if (!res.ok) return res;
  return { ...res, head: await currentBranchFor(input.dir) };
}

export interface PullCreateInput {
  dir: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  reviewers?: string[];
}

/** Reviewer assignment on create isn't part of the GitLab/Bitbucket adapters'
 *  core subset (see their own doc comments) — `reviewers` is silently
 *  ignored for those two providers. */
export async function pullCreate(input: PullCreateInput): Promise<IssueResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return createGitHubPull(input);
  const pullInput = { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft };
  const res = repoInfo.provider === "gitlab" ? await createGitLabPull(repoInfo, pullInput) : await createBitbucketPull(repoInfo, pullInput);
  if (!res.ok) return res;
  return { ...res, item: withSourcePath(res.item, input.dir) };
}

export async function pullDiff(input: { dir: string; number: number }): Promise<DiffResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullDiff(input);
  return repoInfo.provider === "gitlab" ? getGitLabPullDiff(repoInfo, input.number) : getBitbucketPullDiff(repoInfo, input.number);
}

/** Same identifying fields `pullDiff` takes (`dir`, `number`), plus which
 *  file and which side of the diff to fetch bytes for. `path` is
 *  repo-relative, matching the `path` field on `TaskDiff`'s `DiffFile`
 *  entries the UI already has in hand from a prior `pullDiff` call. */
export interface PullBlobOpts {
  dir: string;
  number: number;
  path: string;
  side: "old" | "new";
}

export type PullBlobResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  // status: 404 missing, 413 too large, 501 unsupported provider, 502 upstream
  | { ok: false; error: string; status?: number };

/**
 * Fetches the raw bytes of one side (old/new) of a binary file in a pull
 * request's diff, for the binary-diff-preview UI (`BinaryFilePreview`).
 * GitHub is implemented (`getGitHubPullBlob` — resolves head/base repo and
 * anchors the old side at the PR's merge base, since the diff the UI shows
 * is merge-base-anchored, not `base.sha`-anchored). GitLab and Bitbucket
 * previews are deferred to a follow-up (see docs/plans/binary-diff-previews.md
 * §8) — both return `501 unsupported` rather than attempting a fetch, so the
 * UI's binary placeholder degrades gracefully instead of erroring.
 */
export async function pullBlob(input: PullBlobOpts): Promise<PullBlobResult> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullBlob(input);
  return { ok: false, status: 501, error: "binary preview not supported for this provider yet" };
}

/**
 * Fetches a single pull request by number — powers the Git Integration
 * modal's future PR detail subpage (opening directly on a task's stored PR
 * URL instead of landing on the list). All three providers are fully wired:
 * GitHub via `getGitHubPullDetail`, GitLab via `getGitLabPullDetail`,
 * Bitbucket via `getBitbucketPullDetail` — each a plain single-item GET
 * normalized through the same mapper its provider's list/mutation paths use.
 */
export async function pullDetail(input: { dir: string; number: number }): Promise<IssueResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullDetail(input);
  const res = repoInfo.provider === "gitlab"
    ? await getGitLabPullDetail(repoInfo, input.number)
    : await getBitbucketPullDetail(repoInfo, input.number);
  if (!res.ok) return res;
  return { ...res, item: withSourcePath(res.item, input.dir) };
}

export interface ListCommentsInput {
  dir: string;
  number: number;
  /** Which endpoint to query on GitLab/Bitbucket — their comment APIs split
   *  merge-requests/pull-requests from issues, unlike GitHub's single
   *  `/issues/:number/comments` endpoint that serves both (so GitHub ignores
   *  this field entirely). The UI passes the open item's kind through the
   *  `/github/comments` route (GitHubDialog.tsx → api.ts → server.ts); the
   *  `"pulls"` default below is only a defensive fallback for callers that
   *  omit it. */
  kind?: GitHubItemKind;
}

export async function listComments(input: ListCommentsInput): Promise<CommentsResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return listGitHubComments(input);
  const kind = input.kind ?? "pulls";
  return repoInfo.provider === "gitlab"
    ? listGitLabComments(repoInfo, input.number, kind)
    : listBitbucketComments(repoInfo, input.number, kind);
}

export interface CreateCommentInput extends ListCommentsInput {
  body: string;
}

export async function createComment(input: CreateCommentInput): Promise<CommentResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return createGitHubComment(input);
  const kind = input.kind ?? "pulls";
  return repoInfo.provider === "gitlab"
    ? createGitLabComment(repoInfo, input.number, kind, input.body)
    : createBitbucketComment(repoInfo, input.number, kind, input.body);
}

export interface PullLineCommentInput {
  dir: string;
  number: number;
  body: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

export async function pullLineComment(input: PullLineCommentInput): Promise<LineCommentResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return createGitHubPullLineComment(input);
  const lineInput = { path: input.path, line: input.line, side: input.side, body: input.body };
  return repoInfo.provider === "gitlab"
    ? createGitLabPullLineComment(repoInfo, input.number, lineInput)
    : createBitbucketPullLineComment(repoInfo, input.number, lineInput);
}

export async function pullReviewComments(input: { dir: string; number: number }): Promise<ReviewCommentsResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return listGitHubPullReviewComments(input);
  return repoInfo.provider === "gitlab"
    ? listGitLabPullReviewComments(repoInfo, input.number)
    : listBitbucketPullReviewComments(repoInfo, input.number);
}

export async function pullLineCommentReply(
  input: { dir: string; number: number; commentId: number; body: string },
): Promise<LineCommentResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return replyGitHubPullLineComment(input);
  return repoInfo.provider === "gitlab"
    ? replyGitLabLineComment(repoInfo, input.number, input.commentId, input.body)
    : replyBitbucketLineComment(repoInfo, input.number, input.commentId, input.body);
}

export async function pullChecks(input: { dir: string; number: number }): Promise<ChecksResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullChecks(input);
  return repoInfo.provider === "gitlab" ? getGitLabPullChecks(repoInfo, input.number) : getBitbucketPullChecks(repoInfo, input.number);
}

export async function pullMergeability(input: { dir: string; number: number }): Promise<MergeabilityResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubPullMergeability(input);
  return repoInfo.provider === "gitlab"
    ? getGitLabPullMergeability(repoInfo, input.number)
    : getBitbucketPullMergeability(repoInfo, input.number);
}

export interface PullMergeInput {
  dir: string;
  number: number;
  method: GitHubPullMergeMethod;
  title?: string;
  message?: string;
}

export async function pullMerge(input: PullMergeInput): Promise<MergeResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return mergeGitHubPull(input);
  return repoInfo.provider === "gitlab"
    ? mergeGitLabPull(repoInfo, input.number, input.method)
    : mergeBitbucketPull(repoInfo, input.number, input.method);
}

export interface PullCloseInput {
  dir: string;
  number: number;
  comment?: string;
}

/** GitHub's `closeGitHubPull` posts an optional trailing comment as part of
 *  the same request; the GitLab/Bitbucket adapters' close functions don't
 *  accept one (see their doc comments — "close" and "comment" are separate
 *  concerns on those APIs), so the facade composes it here from the
 *  adapters' own comment functions — same "close, then best-effort comment"
 *  shape `closeGitHubPull` itself uses. */
export async function pullClose(input: PullCloseInput): Promise<ActionResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return closeGitHubPull(input);

  const res = repoInfo.provider === "gitlab" ? await closeGitLabPull(repoInfo, input.number) : await closeBitbucketPull(repoInfo, input.number);
  if (!res.ok) return res;
  const item = res.item ? withSourcePath(res.item, input.dir) : undefined;

  const comment = input.comment?.trim();
  if (!comment) return { ...res, ...(item ? { item } : {}) };

  const commentRes = repoInfo.provider === "gitlab"
    ? await createGitLabComment(repoInfo, input.number, "pulls", comment)
    : await createBitbucketComment(repoInfo, input.number, "pulls", comment);
  if (!commentRes.ok) {
    return {
      ok: true,
      message: `${res.message ?? "Closed."} but the comment was not posted: ${commentRes.error}`,
      commentPosted: false,
      ...(item ? { item } : {}),
    };
  }
  return {
    ok: true,
    message: `${res.message ?? "Closed."} Comment posted.`,
    commentPosted: true,
    ...(item ? { item } : {}),
  };
}

/** Bitbucket has no API to move a declined pull request back to open — the
 *  adapter (`reopenBitbucketPull`) always returns a friendly error, which is
 *  passed through as-is. */
export async function pullReopen(input: { dir: string; number: number }): Promise<IssueResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return reopenGitHubPull(input);
  if (repoInfo.provider === "bitbucket") {
    const res = await reopenBitbucketPull(repoInfo, input.number);
    if (res.ok) return { ok: false, error: "Bitbucket returned an unexpected reopen response" };
    return res;
  }
  const res = await reopenGitLabPull(repoInfo, input.number);
  if (!res.ok) return res;
  return { ...res, item: withSourcePath(res.item, input.dir) };
}

export interface PullReviewInput {
  dir: string;
  number: number;
  event: GitHubPullReviewEvent;
  body?: string;
  comments?: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[];
}

/** GitLab/Bitbucket reviews don't support a batch of inline comments attached
 *  to one review call the way GitHub's "pending review" flow does —
 *  `comments` is accepted here for interface parity with the shared route,
 *  but silently ignored for those two providers; a caller wanting inline
 *  comments on GitLab/Bitbucket posts them individually via `pullLineComment`
 *  instead. */
export async function pullReview(input: PullReviewInput): Promise<ActionResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return reviewGitHubPull(input);
  return repoInfo.provider === "gitlab"
    ? reviewGitLabPull(repoInfo, input.number, input.event, input.body)
    : reviewBitbucketPull(repoInfo, input.number, input.event, input.body);
}

export interface IssueCreateInput {
  dir: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

/** `milestone` isn't part of the GitLab/Bitbucket adapters' create-issue
 *  input (see their own interfaces) — silently dropped for those providers. */
export async function issueCreate(input: IssueCreateInput): Promise<IssueResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return createGitHubIssue(input);
  if (repoInfo.provider === "gitlab") {
    const res = await createGitLabIssue(repoInfo, { title: input.title, body: input.body, labels: input.labels, assignees: input.assignees });
    if (!res.ok) return res;
    return { ...res, item: withSourcePath(res.item, input.dir) };
  }
  const res = await createBitbucketIssue(repoInfo, { title: input.title, body: input.body });
  if (!res.ok) return res;
  return { ...res, item: withSourcePath(res.item, input.dir) };
}

export interface IssueUpdateInput {
  dir: string;
  number: number;
  kind?: GitHubItemKind;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

/** `milestone` isn't part of the GitLab/Bitbucket adapters' update-issue
 *  input — silently dropped for those providers, same as `issueCreate`. */
export async function issueUpdate(input: IssueUpdateInput): Promise<IssueResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return updateGitHubIssue(input);
  if (repoInfo.provider === "gitlab") {
    const res = await updateGitLabIssue(repoInfo, input.number, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      state: input.state,
      labels: input.labels,
      assignees: input.assignees,
    });
    if (!res.ok) return res;
    return { ...res, item: withSourcePath(res.item, input.dir) };
  }
  const res = await updateBitbucketIssue(repoInfo, input.number, { title: input.title, body: input.body, state: input.state });
  if (!res.ok) return res;
  return { ...res, item: withSourcePath(res.item, input.dir) };
}

export async function viewer(input: { dir: string }): Promise<ViewerResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return getGitHubViewer(input);
  return repoInfo.provider === "gitlab" ? getGitLabViewer(repoInfo) : getBitbucketViewer(repoInfo);
}

/** Bitbucket has no labels concept at all (see `bitbucket.ts`'s module doc
 *  comment) — rather than erroring, this returns a well-formed empty result
 *  so the UI's labels filter/picker renders "no labels" instead of a broken
 *  request. */
export async function labels(input: { dir: string }): Promise<LabelsResponse> {
  const repoInfo = await providerRepoForDir(input.dir);
  if (!repoInfo) return { ok: false, error: NO_REMOTE_ERROR };
  if (repoInfo.provider === "github") return listGitHubLabels(input);
  if (repoInfo.provider === "gitlab") return listGitLabLabels(repoInfo);
  return { ok: true, repo: `${repoInfo.owner}/${repoInfo.name}`, labels: [] };
}
