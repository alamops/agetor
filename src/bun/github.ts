import { existsSync } from "node:fs";
import type {
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubLabel,
  GitHubListItem,
  GitHubListResult,
  GitHubMilestone,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
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

interface ReviewGitHubPullInput extends GitHubItemNumberInput {
  event: GitHubPullReviewEvent;
  body?: string;
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

// Internal helpers exposed for unit tests only — no other consumers.
export const __githubInternals = {
  matchesFilters,
  normalizeItem,
  normalizeComment,
  normalizeLineComment,
  normalizeCheckRun,
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

export async function listGitHubItems(input: ListGitHubItemsInput): Promise<GitHubListResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken();
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const assignee = input.assignee?.trim() ?? "";
  const endpoint = input.kind === "pulls" ? "pulls" : "issues";
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/${endpoint}`);
  url.searchParams.set("state", input.state);
  url.searchParams.set("per_page", "50");
  if (input.kind === "issues" && labels.length > 0) {
    url.searchParams.set("labels", labels.join(","));
  }
  if (input.kind === "issues" && assignee) {
    url.searchParams.set("assignee", assignee);
  }

  const items: GitHubListItem[] = [];
  let next: string | null = url.toString();
  for (let page = 0; next && page < 3; page++) {
    const res = await fetchGitHub(next, token, "application/vnd.github+json");
    if (!("status" in res)) return res;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `${res.status} ${res.statusText}`;
      return { ok: false, error: msg };
    }
    if (!Array.isArray(body)) return { ok: false, error: "GitHub returned an unexpected response" };
    for (const raw of body) {
      if (input.kind === "issues" && raw && typeof raw === "object" && "pull_request" in raw) continue;
      const item = normalizeItem(input.kind, raw);
      if (item && matchesFilters(item, input.query ?? "", input.kind === "pulls" ? labels : [], input.kind === "pulls" ? assignee : "")) {
        items.push(item);
      }
    }
    next = pageLinks(res.headers.get("link"));
  }

  const slug = repoSlug(repo);
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
  if (input.event !== "APPROVE" && input.event !== "REQUEST_CHANGES" && input.event !== "COMMENT") {
    return { ok: false, error: "unsupported review event" };
  }
  const body = input.body?.trim() ?? "";
  // GitHub rejects a REQUEST_CHANGES or COMMENT review with no body; only
  // APPROVE may be submitted empty.
  if (input.event !== "APPROVE" && !body) {
    return {
      ok: false,
      error: input.event === "COMMENT" ? "a review comment requires a body" : "request changes requires a comment",
    };
  }

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
      }),
    },
  );
  if (!("status" in res)) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: apiError(json, res.status, res.statusText) };
  return {
    ok: true,
    message: input.event === "APPROVE"
      ? "Pull request approved."
      : input.event === "COMMENT"
        ? "Review comment posted."
        : "Changes requested.",
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
  const patch: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
    milestone?: number | null;
  } = {};
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

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${input.number}`;
  const res = await fetchGitHub(
    url,
    token,
    "application/vnd.github+json",
    { method: "PATCH", body: JSON.stringify(patch) },
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
