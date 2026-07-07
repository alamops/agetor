import { existsSync } from "node:fs";
import type {
  GitHubItemKind,
  GitHubItemState,
  GitHubLabel,
  GitHubListItem,
  GitHubListResult,
  GitHubUser,
} from "../shared/types.ts";

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
}

interface GitHubListError {
  ok: false;
  error: string;
}

type GitHubListResponse = ({ ok: true } & GitHubListResult) | GitHubListError;

const GITHUB_FETCH_TIMEOUT_MS = 30_000;

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

function normalizeItem(kind: GitHubItemKind, raw: unknown): GitHubListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.number !== "number" || typeof obj.title !== "string") return null;
  if (obj.state !== "open" && obj.state !== "closed") return null;
  if (typeof obj.html_url !== "string") return null;
  const labels = Array.isArray(obj.labels)
    ? obj.labels.map(normalizeLabel).filter((x): x is GitHubLabel => !!x)
    : [];
  return {
    kind,
    number: obj.number,
    title: obj.title,
    state: obj.state,
    draft: typeof obj.draft === "boolean" ? obj.draft : false,
    htmlUrl: obj.html_url,
    author: normalizeUser(obj.user),
    body: typeof obj.body === "string" ? obj.body : "",
    labels,
    comments: typeof obj.comments === "number" ? obj.comments : 0,
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    updatedAt: typeof obj.updated_at === "string" ? obj.updated_at : "",
    closedAt: typeof obj.closed_at === "string" ? obj.closed_at : null,
  };
}

function matchesFilters(item: GitHubListItem, query: string, labels: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (q) {
    const hay = [
      item.title,
      item.body,
      String(item.number),
      item.author?.login ?? "",
      item.labels.map((l) => l.name).join(" "),
    ].join("\n").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (labels.length > 0) {
    const have = new Set(item.labels.map((l) => l.name.toLowerCase()));
    if (!labels.every((label) => have.has(label.toLowerCase()))) return false;
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

export async function listGitHubItems(input: ListGitHubItemsInput): Promise<GitHubListResponse> {
  const repo = await repoForDir(input.dir);
  if (!repo) return { ok: false, error: "project does not have a GitHub remote" };

  const token = await githubToken();
  const labels = input.labels?.map((s) => s.trim()).filter(Boolean) ?? [];
  const endpoint = input.kind === "pulls" ? "pulls" : "issues";
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/${endpoint}`);
  url.searchParams.set("state", input.state);
  url.searchParams.set("per_page", "50");
  if (input.kind === "issues" && labels.length > 0) {
    url.searchParams.set("labels", labels.join(","));
  }

  const items: GitHubListItem[] = [];
  let next: string | null = url.toString();
  for (let page = 0; next && page < 3; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(next, {
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "agetor",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (e) {
      return { ok: false, error: fetchErrorMessage(e) };
    } finally {
      clearTimeout(timer);
    }
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
      if (item && matchesFilters(item, input.query ?? "", input.kind === "pulls" ? labels : [])) {
        items.push(item);
      }
    }
    next = pageLinks(res.headers.get("link"));
  }

const repoSlug = `${repo.owner}/${repo.name}`;
  return {
    ok: true,
    repo: repoSlug,
    webUrl: `https://github.com/${repoSlug}`,
    auth: token ? "token" : "none",
    items,
  };
}
