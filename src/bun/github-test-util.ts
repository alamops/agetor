// Test-only helpers for exercising the network functions in `github.ts`.
//
// The functions in github.ts resolve a repo from a real git remote
// (`repoForDir` runs `git remote …`) and read a token (`githubToken` reads
// `GITHUB_TOKEN`/`GH_TOKEN` or shells out to `gh`), then call the global
// `fetch` via the internal `fetchGitHub` wrapper. To test them end-to-end
// without touching the network we:
//   1. build a throwaway git repo with a github `origin` remote so
//      `repoForDir` resolves to a known {owner, name} — `makeGitHubRepo`;
//   2. stub `globalThis.fetch` with a route table that returns canned
//      responses and records every call — `mockGitHubFetch`.
//
// This file is imported only from `*.test.ts`, never from `index.ts`, so it is
// tree-shaken out of the packaged bundle.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo whose `origin` is `https://github.com/<owner>/<name>.git`,
 *  so `repoForDir(dir)` resolves to `{ owner, name }`. */
export async function makeGitHubRepo(owner = "o", name = "r"): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-gh-repo-"));
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", `https://github.com/${owner}/${name}.git`], dir);
  return dir;
}

export interface MockRoute {
  /** HTTP method to match (case-insensitive). Omit to match any method. */
  method?: string;
  /** URL match: a substring the request URL must contain, or a RegExp to test. */
  match: string | RegExp;
  /** Response status (default 200). */
  status?: number;
  /** Response body as a JSON value (JSON.stringify'd). Mutually exclusive with `text`. */
  json?: unknown;
  /** Raw response body text. */
  text?: string;
  /** Extra response headers (e.g. a pagination `link` header). */
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

export interface FetchMock {
  /** Every fetch the code under test issued, in order. */
  calls: FetchCall[];
  /** Restore the original `globalThis.fetch`. Always call in a `finally`. */
  restore: () => void;
}

function matchUrl(match: string | RegExp, url: string): boolean {
  return typeof match === "string" ? url.includes(match) : match.test(url);
}

function headersToObject(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Replace `globalThis.fetch` with a route table. Routes are tried in order;
 *  the first whose method + URL match wins. An unmatched request throws (so a
 *  test that hits an unexpected endpoint fails loudly rather than silently). */
export function mockGitHubFetch(routes: MockRoute[]): FetchMock {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body, headers: headersToObject(init) });

    const route = routes.find((r) => (!r.method || r.method.toUpperCase() === method) && matchUrl(r.match, url));
    if (!route) throw new Error(`mockGitHubFetch: no route for ${method} ${url}`);

    const status = route.status ?? 200;
    const payload = route.text ?? (route.json !== undefined ? JSON.stringify(route.json) : "");
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json", ...route.headers },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
