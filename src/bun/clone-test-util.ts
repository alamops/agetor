// Test-only helpers for exercising `cloneRepo`'s auth-retry / redirect-safety
// behavior against a REAL smart-HTTP git server, without ever touching the
// network. Ported from the plan's spike scripts
// (scratchpad `spikes/git-env-auth/git-cgi-server.ts` /
// `redirect-server.ts`, docs/plans/clone-repository-all-providers.md §2), but
// run in-process (a `Bun.serve` in the SAME test process) rather than as a
// spawned subprocess, and on an ephemeral (`port: 0`) port so parallel test
// runs never collide.
//
// This file is imported only from `*.test.ts`, never from `index.ts`, so it
// is tree-shaken out of the packaged bundle (same convention as
// `github-test-util.ts` / `test-data-dir.ts`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/** One request `startAuthGitServer`/`startAuthRedirectServer` observed —
 *  exposed so a test can assert exactly what did (or didn't) reach a given
 *  server, and with what `Authorization` header (if any). */
export interface AuthGitRequestLog {
  method: string;
  path: string;
  /** The raw header VALUE (e.g. `"Basic <base64>"`), never the
   *  `"Authorization: "` prefix — this is what `req.headers.get(...)`
   *  returns, and what a caller building a `requireAuth` string to compare
   *  against must also use. `null` when the request carried no header at
   *  all. */
  authorization: string | null;
}

export interface AuthGitServer {
  /** `http://127.0.0.1:<port>` — the caller appends `/repo.git` (or
   *  whatever `makeBareSourceRepo` named the repo). */
  url: string;
  port: number;
  /** Every request this server has received so far, in order. */
  requests: AuthGitRequestLog[];
  stop: () => void;
}

export interface AuthGitServerOptions {
  /** When set, a request is only forwarded to `git-http-backend` if its
   *  `Authorization` header value EXACTLY equals this string (compare
   *  against `req.headers.get("authorization")`'s shape — `"Basic
   *  <base64>"`, never the `"Authorization: "` prefix a `CloneAuth.header`
   *  carries). Every non-matching request (including a bare anonymous one)
   *  gets a `401` + `WWW-Authenticate: Basic`, mirroring a real git forge's
   *  auth gate. Omitted (default): no auth gate at all — every request is
   *  served anonymously, exercising the "already public" path. */
  requireAuth?: string;
  /** Milliseconds to sleep before answering ANY request (success or 401).
   *  Used only by the "destination became non-empty between attempts" race
   *  test, to open a deterministic window between the clone attempt
   *  STARTING and its response arriving. */
  delayMs?: number;
}

/** Ported 1:1 from the spike's `git-cgi-server.ts` `runCgi` — spawns
 *  `git-http-backend` as CGI against `projectRoot`, translating the inbound
 *  `Request` into the CGI env `git-http-backend` expects and its stdout back
 *  into a `Response`. */
async function runGitHttpBackendCgi(
  req: Request,
  url: URL,
  projectRoot: string,
  port: number,
): Promise<Response> {
  const execPathProc = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const execPath = (execPathProc.stdout ?? "").trim();
  const backend = path.join(execPath, "git-http-backend");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    SERVER_PROTOCOL: "HTTP/1.1",
    SERVER_SOFTWARE: "agetor-test-cgi",
    GATEWAY_INTERFACE: "CGI/1.1",
    REMOTE_ADDR: "127.0.0.1",
    SERVER_NAME: "127.0.0.1",
    SERVER_PORT: String(port),
  };

  const contentType = req.headers.get("content-type");
  if (contentType) env.CONTENT_TYPE = contentType;
  const contentLength = req.headers.get("content-length");
  if (contentLength) env.CONTENT_LENGTH = contentLength;
  for (const [key, value] of req.headers.entries()) {
    const cgiKey = "HTTP_" + key.toUpperCase().replace(/-/g, "_");
    if (cgiKey === "HTTP_CONTENT_TYPE" || cgiKey === "HTTP_CONTENT_LENGTH") continue;
    env[cgiKey] = value;
  }

  const bodyBuf = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;

  const proc = Bun.spawn({
    cmd: [backend],
    env,
    stdin: bodyBuf ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;

  const buf = Buffer.from(stdout);
  const sep = buf.indexOf("\r\n\r\n");
  const headerSepLf = buf.indexOf("\n\n");
  const headerLen = sep !== -1 ? sep + 4 : headerSepLf !== -1 ? headerSepLf + 2 : 0;
  const headerText = headerLen ? buf.subarray(0, headerLen).toString("utf8") : "";
  const bodyBytes = headerLen ? buf.subarray(headerLen) : buf;

  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    const statusMatch = line.match(/^Status:\s*(\d+)/i);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) headers.append(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
  }

  return new Response(bodyBytes, { status, headers });
}

/**
 * Starts a local smart-HTTP git server (an in-process `Bun.serve` proxying
 * `git-http-backend` as CGI) on an ephemeral port. Optionally gates every
 * request behind a fixed `Authorization` value, and/or delays every
 * response — see `AuthGitServerOptions`. Every request is recorded on
 * `.requests` regardless of whether it was let through.
 */
export function startAuthGitServer(projectRoot: string, opts: AuthGitServerOptions = {}): AuthGitServer {
  const requests: AuthGitRequestLog[] = [];
  // `portBox` sidesteps referencing `server` from inside its own `fetch`
  // callback (a `const server = Bun.serve({ fetch() { ...server... } })`
  // self-reference TS flags as implicitly-`any`) — `fetch` only ever reads
  // `portBox.port`, which is filled in right after `Bun.serve` returns,
  // before any request can possibly arrive.
  const portBox = { port: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      requests.push({ method: req.method, path: url.pathname + url.search, authorization: auth });
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      if (opts.requireAuth !== undefined && auth !== opts.requireAuth) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="agetor-test"' },
        });
      }
      return runGitHttpBackendCgi(req, url, projectRoot, portBox.port);
    },
  });
  const port = server.port ?? 0;
  portBox.port = port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * Starts a local server that unconditionally 301-redirects to `targetUrl`
 * (same path+query) whenever the request's `Authorization` header exactly
 * equals `requireAuth` — otherwise it answers `401` itself, exactly like
 * `startAuthGitServer`'s gate. This is what lets a test force attempt 1
 * (anonymous, no header) to fail auth-shaped against the REDIRECTING origin,
 * then prove attempt 2's credentialed request never reaches `targetUrl` once
 * git's `http.followRedirects=false` refuses to follow the 301 — the
 * redirect-non-leak the plan's spike found (§2).
 */
export function startAuthRedirectServer(targetUrl: string, requireAuth: string): AuthGitServer {
  const requests: AuthGitRequestLog[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      requests.push({ method: req.method, path: url.pathname + url.search, authorization: auth });
      if (auth !== requireAuth) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="agetor-test"' },
        });
      }
      const target = `${targetUrl}${url.pathname}${url.search}`;
      return new Response(null, { status: 301, headers: { Location: target } });
    },
  });
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    stop: () => server.stop(true),
  };
}

/** Creates a BARE git repo with one commit at `<root>/repo.git`, suitable
 *  for serving via `startAuthGitServer(root)` — the caller derives the clone
 *  URL as `${server.url}/repo.git`. `root` is created if missing. */
export function makeBareSourceRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "agetor-clone-src-work-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: work, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  writeFileSync(path.join(work, "README.md"), "# hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const barePath = path.join(root, "repo.git");
  const cloneResult = spawnSync("git", ["clone", "--bare", "-q", work, barePath], { encoding: "utf8" });
  if (cloneResult.status !== 0) {
    throw new Error(`git clone --bare failed: ${cloneResult.stderr}`);
  }
  rmSync(work, { recursive: true, force: true });
  return barePath;
}

/** Encodes `userpass` (e.g. `"x-access-token:tok"`) exactly the way
 *  `cloneAuthHeader` would, returning the bare header VALUE (`"Basic
 *  <base64>"`, no `"Authorization: "` prefix) — the shape
 *  `req.headers.get("authorization")` returns, and what a test's
 *  `requireAuth` option must be expressed as. */
export function basicAuthValue(userpass: string): string {
  return `Basic ${Buffer.from(userpass).toString("base64")}`;
}
