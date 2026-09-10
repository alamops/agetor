// Covers docs/plans/markdown-image-rendering.md D9/T2: the sandbox CSP
// header on `GET /github/pull-blob`'s 200 responses. `server-blob.test.ts`
// exercises the sibling `/tasks/:id/diff/blob` route's CSP header the same
// way, and `files-preview-endpoint.test.ts` covers `/files/preview`'s — this
// file is the third leg, specifically for the route git-host.ts's `pullBlob`
// backs (no task/worktree involved, just a `dir` + PR `number` + `filePath`).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockRoute } from "./github-test-util.ts";

// Set AGETOR_DATA_DIR BEFORE importing db.ts (which captures it at top-level
// import) — same convention as server-blob.test.ts / worktree.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-pull-blob-csp-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (checked via `grep -rhn "AGETOR_API_PORT = " src/bun/*.test.ts`;
// server-blob.test.ts, the closest sibling, uses 4551).
process.env.AGETOR_API_PORT = "4552";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

// GITLAB_TOKEN forced below (mirrors git-host.test.ts) so `gitlabToken()`
// never falls through to a real `glab` CLI shellout.
const ORIGINAL_GITLAB_TOKEN = process.env.GITLAB_TOKEN;

/** A throwaway git repo whose `origin` is a GitLab remote, so
 *  `providerRepoForDir(dir)` resolves to the gitlab provider and
 *  `pullBlob` dispatches to `getGitLabPullBlob`. Mirrors git-host.test.ts's
 *  own `makeRepo` helper (not imported from there — that file owns its own
 *  beforeEach/afterEach fixture lifecycle at module scope, which we don't
 *  want to inherit). No commit is needed: `providerRepoForDir` only shells
 *  out to `git remote`. */
async function makeGitLabRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pull-blob-csp-repo-"));
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", "https://gitlab.com/csp-owner/csp-repo.git"], dir);
  return dir;
}

interface GitLabFetchMock {
  calls: { url: string; method: string }[];
  restore: () => void;
}

/**
 * Like `github-test-util.ts`'s `mockGitHubFetch`, but only intercepts
 * requests aimed at the GitLab API host — every other request (in
 * particular this test's own client-side `fetch()` calls against the local
 * 127.0.0.1 test server) passes through to the real `fetch`.
 *
 * This route is the one pull-blob test that needs BOTH a real HTTP
 * round-trip through `server.ts`'s route handler AND a mocked upstream
 * provider call inside `getGitLabPullBlob` live at the same time — two
 * different roles sharing the single `globalThis.fetch` symbol.
 * `git-host.test.ts` avoids the collision by calling `pullBlob()` directly
 * (no HTTP layer); `server-blob.test.ts` avoids it by having no upstream
 * network call at all (`/tasks/:id/diff/blob` reads bytes from the local
 * worktree/git objects, never the network). A host-unaware mock like
 * `mockGitHubFetch` would swallow this test's own request to
 * `http://127.0.0.1:4552/...` and throw "no route for ...".
 */
function mockGitLabUpstreamFetch(routes: MockRoute[]): GitLabFetchMock {
  const calls: { url: string; method: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("gitlab.com")) return original(input as string, init);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const route = routes.find(
      (r) =>
        (!r.method || r.method.toUpperCase() === method) &&
        (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)),
    );
    if (!route) throw new Error(`mockGitLabUpstreamFetch: no route for ${method} ${url}`);
    const status = route.status ?? 200;
    const payload = route.text ?? (route.json !== undefined ? JSON.stringify(route.json) : "");
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json", ...route.headers },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

let server: { stop: () => void };
let token: string;
let repoDir: string;
let fetchMock: GitLabFetchMock | null = null;

beforeAll(async () => {
  process.env.GITLAB_TOKEN = "glab-test-token";
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  repoDir = await makeGitLabRepo();

  // pullBlob → getGitLabPullBlob issues two calls: the merge-request lookup
  // (for diff_refs.head_sha) and the repository/files/.../raw fetch — same
  // shape as git-host.test.ts's "pullBlob on a gitlab repo dispatches to
  // getGitLabPullBlob and returns the file bytes" test.
  fetchMock = mockGitLabUpstreamFetch([
    {
      match: "/api/v4/projects/csp-owner%2Fcsp-repo/merge_requests/7",
      json: {
        iid: 7,
        diff_refs: { base_sha: "base123", head_sha: "head456" },
        source_project_id: 10,
        target_project_id: 10,
      },
    },
    {
      match: /\/repository\/files\/.*\/raw\?ref=head456/,
      text: "PNGDATA",
      headers: { "content-type": "application/octet-stream" },
    },
  ]);
});

afterAll(() => {
  server?.stop?.();
  fetchMock?.restore();
  if (ORIGINAL_GITLAB_TOKEN === undefined) delete process.env.GITLAB_TOKEN;
  else process.env.GITLAB_TOKEN = ORIGINAL_GITLAB_TOKEN;
});

const BASE_URL = "http://127.0.0.1:4552";
const pullBlobUrl = (filePath: string, opts: { side?: string; number?: number } = {}) => {
  const side = opts.side ?? "new";
  const number = opts.number ?? 7;
  return `${BASE_URL}/github/pull-blob?path=${encodeURIComponent(repoDir)}&number=${number}&filePath=${encodeURIComponent(filePath)}&side=${side}`;
};

const withHeader = (url: string) => fetch(url, { headers: { authorization: `Bearer ${token}` } });

test("/github/pull-blob 200s with the sandbox CSP header, nosniff, and the right bytes", async () => {
  const res = await withHeader(pullBlobUrl("assets/logo.png"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(await res.text()).toBe("PNGDATA");
});

test("/github/pull-blob requires a token", async () => {
  const res = await fetch(pullBlobUrl("assets/logo.png"));
  expect(res.status).toBe(401);
  expect(res.headers.get("content-security-policy")).toBeNull();
});

test("/github/pull-blob 400s a path-traversal filePath before dispatching to any provider, without the CSP header", async () => {
  const res = await withHeader(pullBlobUrl("../../etc/passwd.png"));
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("invalid path");
  expect(res.headers.get("content-security-policy")).toBeNull();
});
