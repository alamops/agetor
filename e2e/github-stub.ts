import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Tiny reusable stub GitHub API server for Playwright specs.
 *
 * Pairs with `src/bun/github.ts`'s `GITHUB_API_BASE` seam (overridable via
 * `AGETOR_GITHUB_API_BASE`) and `e2e/fixtures.ts`'s per-worker/per-test
 * `githubStubPort`: a spec starts a stub on `backend.githubStubPort` and the
 * app's GitHub REST/GraphQL calls transparently land here instead of the
 * real `api.github.com`, with no product-code branching on "am I in a test".
 *
 * Uses Node's `node:http` rather than `Bun.serve` purely for portability —
 * Playwright specs run under Bun (`bun node_modules/@playwright/test/cli.js
 * test`), and `node:http` works fine there while staying the more portable
 * choice if the harness ever changes.
 *
 * Routes are matched in declaration order by method (default: any) + path
 * (exact string match, or a `RegExp` tested against the URL's pathname —
 * query strings are stripped before matching and handed to route bodies
 * separately via `query`) + `accept` header (optional — a route that declares
 * one only matches a request whose `accept` header matches it; a route with
 * no `accept` matches regardless of the request's header, same as before).
 * `routes` is a live, mutable array — a spec can either call `setRoutes()` to
 * swap the whole table (e.g. flipping a PR from open to merged mid-test) or
 * mutate `stub.routes` in place; both are seen by the very next request since
 * the server always reads the current array.
 *
 * A route body function normally returns a plain JSON-serializable value or a
 * `{status, body}` envelope; it can additionally set `contentType` alongside
 * a string `body` to send that string raw (no `JSON.stringify`) — e.g. for
 * `.diff`/`.patch` media-type responses. There's no `stubResponse()` helper
 * for building that envelope — the shape is small enough to write inline, and
 * skipping the helper keeps the stub's own API surface small.
 *
 * Every request (matched or not) is appended to `calls` so a spec can assert
 * on hit counts (`callsMatching`) — e.g. "the detail endpoint was refetched
 * on re-entry". An unmatched request gets a 404 JSON body AND a
 * `console.error` naming the method+path, so a spec author can discover what
 * the app actually fetches by just running it once and reading stderr.
 *
 * NOT emulated: GitHub's pagination `Link` response header. Every stub
 * response here is a single page — a spec that needs multi-page behavior
 * must fake it itself (e.g. a route body that inspects `query.get("page")`).
 */

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface StubRoute {
  /** Defaults to matching any method. */
  method?: string;
  /** Exact match against the URL pathname, or a RegExp tested against it. */
  path: RegExp | string;
  /** When set, this route only matches a request whose `accept` header
   *  matches (substring test for a string, `.test()` for a RegExp) — e.g. to
   *  give a `.diff`-media-type request on the same path a different response
   *  than the default JSON one. A route with no `accept` matches any request,
   *  same as before this field existed. */
  accept?: string | RegExp;
  /** Status to send when `body` is a plain value (ignored when `body` is a
   *  function that returns a `{ status, body }` envelope — that overrides). */
  status?: number;
  /**
   * Either a plain JSON-serializable value to send back verbatim, or a
   * function receiving the parsed request (JSON body if any, else the raw
   * text, else `null`) and returning either a plain value (sent with
   * `status`/200) or a `{ status, body[, contentType] }` envelope to override
   * the status for that particular call. Setting `contentType` together with
   * a string `body` sends that string raw (no `JSON.stringify`) — for a
   * non-JSON response such as a `.diff`/`.patch` media-type fetch.
   */
  body:
    | unknown
    | ((req: StubRequest) => unknown | { status: number; body: unknown; contentType?: string });
}

export interface GitHubStub {
  port: number;
  baseUrl: string;
  routes: StubRoute[];
  calls: Array<{ method: string; path: string; body: unknown }>;
  setRoutes(routes: StubRoute[]): void;
  callsMatching(re: RegExp, method?: string): number;
  close(): Promise<void>;
}

const ENVELOPE_KEYS = new Set(["status", "body", "contentType"]);

/** Distinguishes a route body function's `{status, body[, contentType]}`
 *  control envelope from an ordinary payload value that happens to be a
 *  plain object with `status`/`body` keys of its own. Matched structurally,
 *  not just by key presence: every own key of `value` must be one of
 *  `status`/`body`/`contentType`, `status` must be a number, and `body` must
 *  be present — so a route that genuinely wants to send back
 *  `{status: "ok", body: "…"}` (a real API payload shape, `status` as a
 *  string) is never misread as the envelope. A route that needs to send an
 *  object shaped exactly like the envelope (numeric `status` key et al.) for
 *  some other reason should wrap it: return `{status: 200, body: thatObject}`
 *  explicitly. */
function isStatusBodyEnvelope(
  value: unknown,
): value is { status: number; body: unknown; contentType?: string } {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((k) => ENVELOPE_KEYS.has(k))) return false;
  if (typeof (value as { status: unknown }).status !== "number") return false;
  return "body" in value;
}

/** Strips a `g` flag before using a RegExp for a stateless `.test()` — a
 *  route or `callsMatching` filter reused across multiple requests/assertions
 *  with a `g`-flagged RegExp would otherwise silently start failing every
 *  other call because `.test()` advances `lastIndex` and never resets it. */
function stateless(re: RegExp): RegExp {
  return re.flags.includes("g") ? new RegExp(re.source, re.flags.replace("g", "")) : re;
}

function matchesAccept(want: string | RegExp | undefined, header: string | undefined): boolean {
  if (!want) return true;
  const value = header ?? "";
  return typeof want === "string" ? value.includes(want) : stateless(want).test(value);
}

function matchesRoute(route: StubRoute, method: string, pathname: string, acceptHeader: string | undefined): boolean {
  if (route.method && route.method.toUpperCase() !== method) return false;
  const pathMatches =
    typeof route.path === "string" ? route.path === pathname : stateless(route.path).test(pathname);
  if (!pathMatches) return false;
  return matchesAccept(route.accept, acceptHeader);
}

/** Buffers the request body and JSON-parses it when possible. Empty bodies
 *  (GET/HEAD, or a request with no payload) resolve to `null`; a non-JSON
 *  body resolves to the raw text rather than throwing, so a route body
 *  function can still inspect it. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

export async function startGitHubStub(port: number, initialRoutes: StubRoute[] = []): Promise<GitHubStub> {
  let routes: StubRoute[] = initialRoutes;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // Minimal handling: no route table lookup needed for a bare CORS-style
    // preflight — the app never actually sends one (server-side fetch, not a
    // browser), but respond harmlessly if anything ever does.
    if (method === "OPTIONS") {
      calls.push({ method, path: pathname, body: null });
      res.writeHead(204).end();
      return;
    }

    const isHead = method === "HEAD";
    const body = method === "GET" || isHead ? null : await readBody(req);
    calls.push({ method, path: pathname, body });

    const acceptHeader = req.headers.accept;
    const accept = Array.isArray(acceptHeader) ? acceptHeader.join(", ") : acceptHeader;

    // HEAD falls back to matching as if it were GET when no route explicitly
    // declares `method: "HEAD"` — mirrors ordinary HTTP server behavior.
    const route =
      routes.find((r) => matchesRoute(r, method, pathname, accept)) ??
      (isHead ? routes.find((r) => matchesRoute(r, "GET", pathname, accept)) : undefined);

    if (!route) {
      const message = `stub: no route for ${method} ${pathname}`;
      // eslint-disable-next-line no-console -- deliberate: lets a spec author
      // discover unhandled fetches by reading stderr from one run.
      console.error(`[github-stub] unmatched ${method} ${pathname}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(isHead ? undefined : JSON.stringify({ message }));
      return;
    }

    let status = route.status ?? 200;
    let contentType = "application/json";
    let rawBody: string | undefined;
    let payload: unknown;
    if (typeof route.body === "function") {
      const result = await (route.body as (req: StubRequest) => unknown)({
        method,
        path: pathname,
        query: url.searchParams,
        body,
      });
      if (isStatusBodyEnvelope(result)) {
        status = result.status;
        if (result.contentType && typeof result.body === "string") {
          contentType = result.contentType;
          rawBody = result.body;
        } else {
          payload = result.body;
        }
      } else {
        payload = result;
      }
    } else {
      payload = route.body;
    }

    res.writeHead(status, { "content-type": contentType });
    res.end(isHead ? undefined : rawBody !== undefined ? rawBody : JSON.stringify(payload ?? null));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- surfaces a stub bug loudly
      // rather than hanging the request or crashing the process.
      console.error("[github-stub] handler error", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "stub: internal error" }));
    });
  });

  // Keep-alive sockets left open by a client (Bun's fetch, in practice) can
  // otherwise hold `server.close()` pending indefinitely — a stub that never
  // closes is exactly the "stale process squatting the port" failure mode
  // `startGitHubStub`'s EADDRINUSE message below warns about for the *next*
  // run. Disabling keep-alive timeout server-side plus force-closing
  // connections in `close()` (below) makes shutdown prompt and deterministic.
  server.keepAliveTimeout = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "EADDRINUSE") {
      throw new Error(
        `[github-stub] port ${port} is already in use — a previous run's stub may still be alive: ` +
          `\`lsof -ti :${port} | xargs kill\``,
      );
    }
    throw err;
  }

  const stub: GitHubStub = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    get routes() {
      return routes;
    },
    set routes(next: StubRoute[]) {
      routes = next;
    },
    calls,
    setRoutes(next: StubRoute[]) {
      routes = next;
    },
    callsMatching(re: RegExp, method?: string): number {
      const wantMethod = method?.toUpperCase();
      const stableRe = stateless(re);
      return calls.filter((c) => (!wantMethod || c.method === wantMethod) && stableRe.test(c.path)).length;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // `close()` first (stops accepting new connections, waits for
        // existing ones to end before firing its callback), THEN
        // `closeAllConnections()` to force-terminate any lingering
        // keep-alive sockets so that callback actually fires promptly
        // instead of hanging until a client-side idle timeout. Reversing
        // this order breaks under Bun's `node:http` shim, where
        // `closeAllConnections()` appears to tear down the listener itself
        // — a subsequent `close()` then throws "Server is not running".
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    },
  } as GitHubStub;

  return stub;
}
