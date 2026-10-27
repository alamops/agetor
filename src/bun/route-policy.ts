import { timingSafeEqual } from "node:crypto";
import { API_TOKEN, CLI_TOKEN } from "./api-config.ts";

/**
 * Who may call which HTTP route, and the walker that enforces it
 * (docs/plans/master-token-agent-read.md §3, decisions D3, D9–D14).
 *
 * Agetor has two credentials (`api-config.ts`):
 *
 *   • the MASTER token (`API_TOKEN`) lives in memory and reaches only the app's
 *     own webview (and e2e/dev through `AGETOR_API_TOKEN`) → caller `"app"`;
 *   • the CLI token (`CLI_TOKEN`) is the one written to `agetor-core.json`,
 *     which any program running as the user — agents included — can read →
 *     caller `"cli"`.
 *
 * `ROUTE_POLICY` classifies EVERY route and method of the `routes:` object in
 * `server.ts`, deny by default: `applyRoutePolicy` throws at startup when a
 * route has no entry, an entry has no route, or the methods of a per-method
 * entry don't match the route's, so a route can't ship unclassified. The
 * route-policy test scans `server.ts` for the same facts, so a gap also fails
 * in CI before it can fail a boot.
 *
 * Out of the table by design (P11): the terminal WebSocket upgrade, which lives
 * in `fetch()` and accepts only a single-use ticket minted by
 * `POST /terminals/:id/ws-ticket` (P7).
 *
 * No route in any scope pairs a device, enables remote access or raises a
 * device's permissions — those are native-only (docs/plans/
 * companion-pairing-requirements.md); `route-policy.test.ts` fails on route
 * names that look like it.
 */

/** The identity behind a request, as decided by `resolveCaller`. */
export type ApiCaller = "app" | "cli";

/** Methods a `Bun.serve` route object can key on. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * A request value that names a filesystem path the core would touch in-process
 * (D24). For the CLI caller the walker hands each present string value to
 * `opts.gate` before the handler runs; the app caller is never gated.
 * `mode: "exists"` probes the path itself, `"nearest-ancestor"` the closest
 * existing ancestor (a destination that doesn't exist yet). A value that is an
 * array of strings is gated element by element.
 */
export interface PathParam {
  in: "query" | "body";
  name: string;
  mode: "exists" | "nearest-ancestor";
}

export interface RoutePolicy {
  /**
   * `public`: no token needed. `app`: desktop-only — the master token only, the
   * CLI token is refused. `app+cli`: either token. (The master is accepted on
   * every non-public route.)
   */
  callers: "public" | "app" | "app+cli";
  /** Companion remote levels are added later; today nothing is reachable remotely. */
  remote: "none";
  /**
   * Desktop-only routes whose handler answers 501 first when the core runs
   * headless (no `native`): the CLI token keeps getting that 501 instead of a
   * 403 (D12). Only meaningful with `callers: "app"`.
   */
  headless501?: true;
  /**
   * Accept `?token=<CLI token>` (never the master, D13). Exactly the three SSE
   * GETs that already-installed CLIs open with a query token (P6); the current
   * CLI sends a header. Deprecated — removing it is a later ticket.
   */
  legacyQueryToken?: true;
  /** Path-valued request fields to gate for the CLI caller (D24, P10). */
  pathParams?: readonly PathParam[];
  /**
   * A path-looking field the handler reads that needs no gate, and why (DB
   * only, answered by the disclaimed probe itself, …). Mutually exclusive with
   * `pathParams` for the same field; the test requires one or the other on any
   * `app+cli` handler that reads a path-looking field.
   */
  pathParamsExempt?: string;
  /**
   * The route is registered only under a feature flag, so the "entry without a
   * route" startup check skips it. Today that is the test-only
   * `/test/block-event-loop` (`AGETOR_TEST_BLOCK_ROUTE=1`). When the route IS
   * registered it is classified like any other.
   */
  conditional?: true;
}

type PolicyEntry = RoutePolicy | Partial<Record<HttpMethod, RoutePolicy>>;

// ── building blocks ─────────────────────────────────────────────────────────

const PUBLIC: RoutePolicy = { callers: "public", remote: "none" };
/** Desktop-only: master token only. */
const APP: RoutePolicy = { callers: "app", remote: "none" };
/** Either token. */
const CLI: RoutePolicy = { callers: "app+cli", remote: "none" };
/** Either token; the CLI one also accepted as `?token=` for old CLIs (P6). */
const SSE_LEGACY: RoutePolicy = { callers: "app+cli", remote: "none", legacyQueryToken: true };

function app(extra: Pick<RoutePolicy, "headless501" | "conditional">): RoutePolicy {
  return { ...APP, ...extra };
}
function cli(extra: Pick<RoutePolicy, "pathParams" | "pathParamsExempt">): RoutePolicy {
  return { ...CLI, ...extra };
}

const QUERY_PATH: readonly PathParam[] = [{ in: "query", name: "path", mode: "exists" }];
const QUERY_DIR: readonly PathParam[] = [{ in: "query", name: "dir", mode: "exists" }];
const QUERY_WORKDIR: readonly PathParam[] = [{ in: "query", name: "workdir", mode: "exists" }];
const BODY_PATH: readonly PathParam[] = [{ in: "body", name: "path", mode: "exists" }];
const BODY_PATHS: readonly PathParam[] = [{ in: "body", name: "paths", mode: "exists" }];
const BODY_DEST: readonly PathParam[] = [{ in: "body", name: "dest", mode: "nearest-ancestor" }];
const BODY_WORKDIR: readonly PathParam[] = [{ in: "body", name: "workdir", mode: "exists" }];
const BODY_HOME_BIN: readonly PathParam[] = [
  { in: "body", name: "home", mode: "exists" },
  { in: "body", name: "bin", mode: "exists" },
];

/** `/github/*` GETs: `?path=<repo dir>` → `existsSync(dir)` + git in that cwd. */
const GH_QUERY = cli({ pathParams: QUERY_PATH });
/** `/github/*` POSTs: `{ path: <repo dir> }`. */
const GH_BODY = cli({ pathParams: BODY_PATH });

const EXEMPT_DB = "DB only: reads or writes the project row keyed by the path string, touches no file";
const EXEMPT_REFS_RESOLVE =
  "the route's own answer comes from probePaths(paths, callerOf(req)): for the CLI token every stat runs in a disclaimed child";
const EXEMPT_SESSION_IMPORT =
  "no path in the request: the cwd comes from the transcript and is gated in the handler via the importer's gateCwd option";

// ── the table ───────────────────────────────────────────────────────────────

/**
 * Keys are the route patterns of `server.ts`'s `routes:` object verbatim.
 * Function-valued routes (handle every method) take one flat policy;
 * routes with per-method handlers list EVERY method — a flat policy on a
 * method-object route, or the reverse, is a startup error, so adding a method
 * to a route can't silently inherit another method's access.
 */
export const ROUTE_POLICY: Record<string, PolicyEntry> = {
  // Unauthenticated liveness probe; reveals nothing (the CLI's creds probe uses it).
  "/health": PUBLIC,

  // Core info, projects and the git-host adapters (`/github/*` serves GitHub, GitLab
  // and Bitbucket). GETs read `?path=<repo dir>`, POSTs `{ path }` → gated for the CLI
  // token because the adapters `existsSync(dir)` it in-process.
  "/defaults": { GET: CLI },
  "/projects": {
    GET: CLI,
    POST: cli({ pathParams: BODY_PATH }),
    DELETE: cli({ pathParamsExempt: EXEMPT_DB }),
  },
  "/projects/clone": { POST: cli({ pathParams: BODY_DEST }) },
  "/projects/clone/:cloneId": { DELETE: CLI },
  "/projects/pick": { POST: app({ headless501: true }) },
  "/projects/branches": { GET: cli({ pathParams: QUERY_PATH }) },
  "/projects/settings": {
    GET: cli({ pathParamsExempt: EXEMPT_DB }),
    PUT: cli({ pathParamsExempt: EXEMPT_DB }),
  },
  "/projects/fetch": { POST: cli({ pathParams: BODY_PATH }) },
  "/projects/pull": { POST: cli({ pathParams: BODY_PATH }) },
  "/projects/push": { POST: cli({ pathParams: BODY_PATH }) },
  "/github/items": { GET: GH_QUERY },
  "/github/items-aggregate": { POST: cli({ pathParams: BODY_PATHS }) },
  "/github/repo-permissions": { GET: GH_QUERY },
  "/github/pull-diff": { GET: GH_QUERY },
  "/github/pull-blob": { GET: GH_QUERY },
  "/github/pull-detail": { GET: GH_QUERY },
  "/github/issue-thread": { GET: GH_QUERY },
  "/github/viewer": { GET: GH_QUERY },
  "/github/provider-info": { GET: GH_QUERY },
  "/github/labels": {
    GET: GH_QUERY,
    POST: GH_BODY,
  },
  "/github/label-update": { POST: GH_BODY },
  "/github/label-delete": { POST: GH_BODY },
  "/github/assignees": { GET: GH_QUERY },
  "/github/milestones": {
    GET: GH_QUERY,
    POST: GH_BODY,
  },
  "/github/milestone-update": { POST: GH_BODY },
  "/github/milestone-delete": { POST: GH_BODY },
  "/github/releases": {
    GET: GH_QUERY,
    POST: GH_BODY,
  },
  "/github/release-update": { POST: GH_BODY },
  "/github/release-delete": { POST: GH_BODY },
  "/github/tags": { GET: GH_QUERY },
  "/github/workflow-runs": { GET: GH_QUERY },
  "/github/workflows": { GET: GH_QUERY },
  "/github/workflow-rerun": { POST: GH_BODY },
  "/github/workflow-cancel": { POST: GH_BODY },
  "/github/workflow-dispatch": { POST: GH_BODY },
  "/github/comment-update": { POST: GH_BODY },
  "/github/comment-delete": { POST: GH_BODY },
  "/github/comments": {
    GET: GH_QUERY,
    POST: GH_BODY,
  },
  "/github/pull-line-comment": { POST: GH_BODY },
  "/github/pull-review-comments": { GET: GH_QUERY },
  "/github/pull-review-threads": { GET: GH_QUERY },
  "/github/review-thread-resolve": { POST: GH_BODY },
  "/github/pull-line-comment-reply": { POST: GH_BODY },
  "/github/pull-checks": { GET: GH_QUERY },
  "/github/commit-status": { GET: GH_QUERY },
  "/github/pull-mergeability": { GET: GH_QUERY },
  "/github/pull-update-branch": { POST: GH_BODY },
  "/github/pull-reopen": { POST: GH_BODY },
  "/github/pull-draft": { POST: GH_BODY },
  "/github/pull-auto-merge": { POST: GH_BODY },
  "/github/pull-commits": { GET: GH_QUERY },
  "/github/pull-linked-issues": { GET: GH_QUERY },
  "/github/pull-defaults": { GET: GH_QUERY },
  "/github/pull-create": { POST: GH_BODY },
  "/github/pull-review": { POST: GH_BODY },
  "/github/pull-merge": { POST: GH_BODY },
  "/github/pull-close": { POST: GH_BODY },
  "/github/issue-create": { POST: GH_BODY },
  "/github/issue-update": { POST: GH_BODY },
  "/github/issue-lock": { POST: GH_BODY },
  "/github/issue-pin": { POST: GH_BODY },
  "/github/issue-pinned": { GET: GH_QUERY },
  "/github/sub-issues": { GET: GH_QUERY },
  "/github/sub-issue-add": { POST: GH_BODY },
  "/github/sub-issue-remove": { POST: GH_BODY },
  "/github/issue-transfer": { POST: GH_BODY },
  "/github/projects": { GET: GH_QUERY },
  "/github/project-items": { GET: GH_QUERY },
  "/github/project-item-add": { POST: GH_BODY },
  "/github/project-item-remove": { POST: GH_BODY },
  "/github/project-item-status": { POST: GH_BODY },
  "/github/discussions": { GET: GH_QUERY },
  "/github/discussion": { GET: GH_QUERY },
  "/github/discussion-create": { POST: GH_BODY },
  "/github/discussion-comment": { POST: GH_BODY },
  "/github/discussion-answer": { POST: GH_BODY },
  "/github/discussion-delete": { POST: GH_BODY },
  "/github/discussion-comment-delete": { POST: GH_BODY },
  "/github/pull-reviewers": { POST: GH_BODY },
  "/github/pull-apply-suggestion": { POST: GH_BODY },
  "/github/reactions": { GET: GH_QUERY },
  "/github/reaction-add": { POST: GH_BODY },
  "/github/reaction-remove": { POST: GH_BODY },
  "/github/notifications": { GET: GH_QUERY },
  "/github/notification-read": { POST: GH_BODY },
  "/github/notifications-read-all": { POST: GH_BODY },
  "/github/thread-subscription": {
    GET: GH_QUERY,
    POST: GH_BODY,
  },
  "/github/thread-unsubscribe": { POST: GH_BODY },
  "/github/tokens": {
    GET: CLI,
    PUT: CLI,
  },
  "/github/tokens/:host": { DELETE: CLI },

  // Preferences, DB maintenance, app chrome and updates. `PUT /preferences/:key` is
  // `app+cli`; the `disclaimSpawnedAgents` = "false" value rule lives in the handler (D4).
  "/preferences": { GET: CLI },
  "/preferences/:key": { PUT: CLI },
  "/db/stats": { GET: CLI },
  "/db/compact": { POST: CLI },
  "/db/retention/run": { POST: CLI },
  "/test/block-event-loop": { POST: app({ conditional: true }) },
  "/info": { GET: CLI },
  "/window/toggle-zoom": { POST: APP },
  "/window/focus": { POST: app({ headless501: true }) },
  "/updates/status": { GET: app({ headless501: true }) },
  "/updates/check": { POST: app({ headless501: true }) },
  "/updates/apply": { POST: app({ headless501: true }) },
  "/tmux-source": {
    GET: CLI,
    POST: APP,
  },

  // Harnesses, agents, saved prompts, pipelines and bundles.
  "/usage": { GET: CLI },
  "/harnesses": {
    GET: CLI,
    POST: cli({ pathParams: BODY_HOME_BIN }),
  },
  "/harness-discovery": { GET: CLI },
  "/harnesses/:id": {
    GET: CLI,
    PATCH: cli({ pathParams: BODY_HOME_BIN }),
    DELETE: CLI,
  },
  "/saved-prompts": {
    GET: CLI,
    POST: CLI,
  },
  "/saved-prompts/:id": {
    PATCH: CLI,
    DELETE: CLI,
  },
  "/agent-profiles": {
    GET: CLI,
    POST: CLI,
  },
  "/agent-profiles/:id/duplicate": { POST: CLI },
  "/agent-profiles/:id": {
    GET: CLI,
    PATCH: CLI,
    DELETE: CLI,
  },
  "/pipelines": {
    GET: CLI,
    POST: CLI,
  },
  "/pipelines/:id": {
    GET: CLI,
    PATCH: CLI,
    DELETE: CLI,
  },
  "/bundle/export": { POST: CLI },
  "/bundle/export/save": { POST: APP },
  "/bundle/pick-file": { POST: app({ headless501: true }) },
  "/bundle/import/preview": { POST: CLI },
  "/bundle/import": { POST: CLI },
  "/harnesses/:id/usage": { GET: CLI },
  "/harnesses/:id/account-usage": { GET: CLI },
  "/harnesses/:id/usage/refresh": { POST: CLI },
  "/harnesses/:id/shell-env": { GET: CLI },
  "/harnesses/:id/open-terminal": { POST: APP },
  "/agents": { GET: CLI },
  "/agent-models": {
    GET: CLI,
    POST: CLI,
  },
  "/agent-models/harnesses": { GET: CLI },
  "/agent-discovery": { GET: cli({ pathParams: QUERY_WORKDIR }) },

  // Tasks, runs and worktrees.
  "/tasks": {
    GET: CLI,
    POST: cli({ pathParams: BODY_WORKDIR }),
  },
  "/tasks/:id": {
    GET: CLI,
    PATCH: cli({ pathParams: BODY_WORKDIR }),
    DELETE: CLI,
  },
  "/tasks/:id/start": { POST: CLI },
  "/tasks/:id/claude-session/retry": { POST: CLI },
  "/claude-sessions": { GET: CLI },
  "/claude-sessions/recheck": { POST: CLI },
  "/claude-sessions/import": { POST: cli({ pathParamsExempt: EXEMPT_SESSION_IMPORT }) },
  "/claude-sessions/checkout": { POST: CLI },
  "/tasks/:id/archive": { POST: CLI },
  "/tasks/:id/unarchive": { POST: CLI },
  "/tasks/:id/pipeline": { GET: CLI },
  "/tasks/:id/pipeline/advance": { POST: CLI },
  "/tasks/:id/pipeline/retry": { POST: CLI },
  "/tasks/:id/pipeline/cancel": { POST: CLI },
  "/tasks/:id/pipeline/restart": { POST: CLI },
  "/worktrees": { GET: CLI },
  "/worktrees/:id": { DELETE: CLI },
  "/worktrees/:id/git-status": { GET: CLI },
  "/tasks/:id/runs": { GET: CLI },
  "/tasks/:id/subagents": { GET: CLI },
  "/tasks/:id/diff": { GET: CLI },
  "/tasks/:id/diff/blob": { GET: APP },
  "/tasks/:id/open-tmux": { POST: APP },
  "/tasks/:id/git-status": { GET: CLI },
  "/tasks/:id/teardown-preview": { GET: CLI },
  "/runs/:id/cancel": { POST: CLI },

  // Native file/URL helpers and attachments: desktop-only, except `/refs/resolve` and
  // `/files/index`, which the CLI uses.
  "/open-path": { POST: app({ headless501: true }) },
  "/reveal-path": { POST: app({ headless501: true }) },
  "/open-external": { POST: app({ headless501: true }) },
  "/refs/pick": { POST: app({ headless501: true }) },
  "/refs/resolve": { POST: cli({ pathParamsExempt: EXEMPT_REFS_RESOLVE }) },
  "/refs/drag": { POST: APP },
  "/files/index": { GET: cli({ pathParams: QUERY_DIR }) },
  "/screenshots": { POST: APP },
  "/attachments": { POST: APP },
  "/files/preview": { GET: APP },

  // Interaction answers, backlog, plans, drafts and run input.
  "/ask-questions/:id/answer": { POST: CLI },
  "/tmux-prompts/:id/answer": { POST: CLI },
  "/fx-permissions/:id/answer": { POST: CLI },
  "/tasks/:id/interactions/pending": { GET: CLI },
  "/tasks/:id/backlog": {
    POST: CLI,
    PUT: CLI,
  },
  "/tasks/:id/backlog/:itemId": {
    PATCH: CLI,
    DELETE: CLI,
  },
  "/tasks/:id/agent-profile": { DELETE: CLI },
  "/tasks/:id/seen": {
    POST: CLI,
    DELETE: CLI,
  },
  "/tasks/:id/plans/:planId": { PATCH: CLI },
  "/tasks/:id/plans/:planId/approve": { POST: CLI },
  "/tasks/:id/fx-resume": { POST: CLI },
  "/tasks/:id/fx-auto-resume": { DELETE: CLI },
  "/tasks/:id/draft": {
    PUT: CLI,
    DELETE: CLI,
  },
  "/runs/:id/input": { POST: CLI },
  "/runs/:id/rebuild-events": { GET: CLI },

  // Event streams: function-valued routes, so one flat policy covers every method.
  // Only the three that old CLIs open with `?token=<CLI token>` carry `legacyQueryToken`.
  "/runs/:id/events": CLI,
  "/events": SSE_LEGACY,

  // Notifications, app lifecycle, daemon control and terminals. The terminal WebSocket
  // upgrade is NOT here (it lives in `fetch()`, P11); `ws-ticket` mints its ticket.
  "/notifications": { POST: CLI },
  "/notifications/:taskId": { DELETE: app({ headless501: true }) },
  "/app/events": SSE_LEGACY,
  "/app/force-quit": { POST: app({ headless501: true }) },
  "/daemon/shutdown": { POST: CLI },
  "/tasks/:id/terminals": {
    GET: APP,
    POST: APP,
  },
  "/terminals/:id": { DELETE: APP },
  "/terminals/:id/ws-ticket": { POST: APP },
  "/tasks/:id/events/page": { GET: CLI },
  "/tasks/:id/messages/history": { GET: CLI },
  "/tasks/:id/events": SSE_LEGACY,
};

// ── caller resolution ───────────────────────────────────────────────────────

const MASTER_BYTES = Buffer.from(API_TOKEN);
const CLI_BYTES = Buffer.from(CLI_TOKEN);

// Constant-time compare: the headless core can be bound beyond loopback
// (AGETOR_API_HOST), so don't let response timing leak how much of a guess
// matched. The length check only reveals the tokens' (public) lengths.
function tokenMatches(candidate: string | null | undefined, expected: Buffer): boolean {
  if (candidate == null) return false;
  const bytes = Buffer.from(candidate);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/**
 * The caller behind `req` under `policy`, or `null` when no valid credential
 * was presented. A Bearer header carrying either token is accepted anywhere;
 * `?token=` is accepted only for the CLI token and only where the policy sets
 * `legacyQueryToken`. The master token is never accepted in a query string
 * (D13): a URL lands in logs, history and proxies' request lines.
 */
export function resolveCaller(req: Request, policy: RoutePolicy): ApiCaller | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const presented = header.slice("Bearer ".length);
    if (tokenMatches(presented, MASTER_BYTES)) return "app";
    if (tokenMatches(presented, CLI_BYTES)) return "cli";
  }
  if (policy.legacyQueryToken) {
    const queryToken = new URL(req.url).searchParams.get("token");
    if (tokenMatches(queryToken, CLI_BYTES)) return "cli";
  }
  return null;
}

const callers = new WeakMap<Request, ApiCaller>();

/**
 * The caller `applyRoutePolicy` authorized for this request, or `null` when the
 * request didn't go through the walker (or the route is public). Handlers read
 * it for caller-dependent behavior (D24: the filesystem helpers).
 */
export function callerOf(req: Request): ApiCaller | null {
  return callers.get(req) ?? null;
}

// ── responses ───────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `403` for the CLI token on a desktop-only route (D11). */
export function desktopOnlyResponse(
  req: Request,
  cors: (req: Request) => Record<string, string>,
): Response {
  return jsonResponse(
    { error: "only available in the Agetor app", code: "desktop-only" },
    403,
    cors(req),
  );
}

// ── the walker ──────────────────────────────────────────────────────────────

export interface RoutePolicyOptions {
  /** True when the core runs without a native host (`headless.ts`). */
  headless: boolean;
  cors: (req: Request) => Record<string, string>;
  /** D24: probe one CLI-supplied path; non-null refuses the request. */
  gate: (
    p: string,
    caller: ApiCaller,
    mode: PathParam["mode"],
  ) => Promise<null | { status: 403; error: string; code: string }>;
  /** The 501 a desktop-only route answers headless (`headless501`). */
  notAvailableHeadless: (req: Request) => Response;
  /** Test seam: classify against another table than `ROUTE_POLICY`. */
  policy?: Record<string, PolicyEntry>;
}

type Handler = (req: Request, ...rest: unknown[]) => Response | Promise<Response>;

/** One request's path values never fan out beyond this many probes. */
const MAX_GATED_VALUES = 256;
const GATE_CONCURRENCY = 8;

function isRoutePolicy(entry: PolicyEntry): entry is RoutePolicy {
  return typeof (entry as RoutePolicy).callers === "string";
}

function toHandler(value: unknown, where: string): Handler {
  if (typeof value === "function") return value as Handler;
  if (value instanceof Response) return () => value.clone();
  throw new Error(`route policy: ${where} is neither a handler nor a Response`);
}

/**
 * Every spelling of one caller-supplied path a handler might act on. Handlers
 * trim (`createTask`'s workdir, `/projects/clone`'s dest, …) and a trimmed path
 * names a different file than the raw one: `" /Users/me/Documents"` reads as a
 * missing relative path to the probe while the handler uses the protected
 * absolute one. So gate the raw string AND its trimmed form; a refusal of
 * either refuses the request.
 */
function spellings(v: string): string[] {
  if (v === "") return [];
  const t = v.trim();
  return t === v || t === "" ? [v] : [v, t];
}

function pathValues(raw: unknown): string[] {
  if (typeof raw === "string") return spellings(raw);
  if (Array.isArray(raw)) return raw.flatMap((v) => (typeof v === "string" ? spellings(v) : []));
  return [];
}

async function collectPathValues(req: Request, params: readonly PathParam[]): Promise<Array<{ value: string; mode: PathParam["mode"] }>> {
  const out: Array<{ value: string; mode: PathParam["mode"] }> = [];
  let body: unknown;
  let bodyRead = false;
  for (const p of params) {
    let raw: unknown;
    if (p.in === "query") {
      const all = new URL(req.url).searchParams.getAll(p.name);
      raw = all.length > 1 ? all : all[0];
    } else {
      if (!bodyRead) {
        bodyRead = true;
        // A body that doesn't parse is the handler's to reject with its own 400.
        body = await req.clone().json().catch(() => undefined);
      }
      raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[p.name] : undefined;
    }
    for (const value of pathValues(raw)) out.push({ value, mode: p.mode });
  }
  return out;
}

async function gatePaths(
  req: Request,
  caller: ApiCaller,
  params: readonly PathParam[],
  opts: RoutePolicyOptions,
): Promise<Response | null> {
  const seen = new Set<string>();
  const todo = (await collectPathValues(req, params)).filter(({ value, mode }) => {
    const key = `${mode}\0${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (todo.length === 0) return null;
  if (todo.length > MAX_GATED_VALUES) {
    return jsonResponse(
      { error: `too many paths in one request for the CLI token (max ${MAX_GATED_VALUES})`, code: "too-many-paths" },
      403,
      opts.cors(req),
    );
  }
  let refusal: { status: 403; error: string; code: string } | null = null;
  let next = 0;
  const worker = async () => {
    while (refusal === null && next < todo.length) {
      const item = todo[next++]!;
      const r = await opts.gate(item.value, caller, item.mode);
      if (r !== null && refusal === null) refusal = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(GATE_CONCURRENCY, todo.length) }, worker));
  if (refusal === null) return null;
  const { status, ...body } = refusal as { status: 403; error: string; code: string };
  return jsonResponse(body, status, opts.cors(req));
}

function wrapHandler(
  handler: Handler,
  policy: RoutePolicy,
  opts: RoutePolicyOptions,
  /** True for a function-valued route: Bun hands it OPTIONS too. */
  functionValued: boolean,
): Handler {
  return async (req, ...rest) => {
    // A CORS preflight never carries the token, and the webview sends an
    // `authorization` header cross-origin, so every request to it is preceded
    // by one. Bun calls a function-valued route for OPTIONS as well, so answer
    // it here — exactly what `fetch()` answers for routes with per-method
    // objects (those have no OPTIONS key, so Bun falls through to `fetch()`):
    // never a 401, and the handler (and its own auth check) is never reached.
    if (req.method === "OPTIONS") {
      return functionValued
        ? new Response(null, { headers: opts.cors(req) })
        : handler(req, ...rest);
    }
    if (policy.callers === "public") return handler(req, ...rest);

    const caller = resolveCaller(req, policy);
    if (caller === null) {
      return jsonResponse({ error: "unauthorized" }, 401, opts.cors(req));
    }
    if (policy.callers === "app" && caller === "cli") {
      return policy.headless501 && opts.headless
        ? opts.notAvailableHeadless(req)
        : desktopOnlyResponse(req, opts.cors);
    }
    if (caller === "cli" && policy.pathParams?.length) {
      let refused: Response | null;
      try {
        refused = await gatePaths(req, caller, policy.pathParams, opts);
      } catch {
        // A probe that blew up proves nothing about the path: fail closed.
        return jsonResponse({ error: "path check failed", code: "path-check-failed" }, 500, opts.cors(req));
      }
      if (refused) return refused;
    }
    callers.set(req, caller);
    return handler(req, ...rest);
  };
}

/**
 * Wrap a `Bun.serve` `routes` object so every handler enforces `ROUTE_POLICY`.
 * Same shape in, same shape out (handlers receive the same `Request`, so
 * Bun's `req.params` keeps working). Per request, in order: `OPTIONS` is answered
 * with the CORS headers on function-valued routes (200, no token, handler never
 * called) and passes through on per-method objects →
 * `public` passes → no valid credential → 401 → CLI token on a desktop-only
 * route → 501 (`headless501` on a headless core) or 403 `desktop-only` → CLI
 * token with `pathParams` → the path gate (403 `path-not-accessible`) → the
 * handler, with the caller readable through `callerOf(req)`.
 *
 * Throws, so the server refuses to start, when a route key has no policy
 * entry, a (non-`conditional`) entry has no route, a function-valued route has
 * a per-method entry, a method-object route has a flat one, or a per-method
 * entry's methods differ from the route's.
 */
export function applyRoutePolicy<T>(routes: T, opts: RoutePolicyOptions): T {
  const table = opts.policy ?? ROUTE_POLICY;
  const map = routes as unknown as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(map)) {
    const entry = table[key];
    if (!entry) {
      problems.push(`route ${key} has no policy entry`);
      continue;
    }
    const value = map[key];
    const perMethod = typeof value === "object" && value !== null && !(value instanceof Response);
    if (perMethod) {
      if (isRoutePolicy(entry)) {
        problems.push(`route ${key} has per-method handlers but a flat policy entry — list every method`);
        continue;
      }
      const routeMethods = Object.keys(value as object).sort();
      const entryMethods = Object.keys(entry).sort();
      if (routeMethods.join() !== entryMethods.join()) {
        problems.push(
          `route ${key} handles [${routeMethods.join(", ")}] but its policy entry lists [${entryMethods.join(", ")}]`,
        );
      }
    } else if (!isRoutePolicy(entry)) {
      problems.push(`route ${key} is function-valued (every method) but its policy entry is per-method — use a flat policy`);
    }
  }
  for (const [key, entry] of Object.entries(table)) {
    if (key in map) continue;
    const entries = isRoutePolicy(entry) ? [entry] : Object.values(entry);
    if (entries.every((e) => e?.conditional)) continue;
    problems.push(`policy entry ${key} has no route`);
  }
  if (problems.length) {
    throw new Error(`route policy does not match the routes:\n  - ${problems.join("\n  - ")}`);
  }

  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    const entry = table[key]!;
    if (isRoutePolicy(entry)) {
      wrapped[key] = wrapHandler(toHandler(value, key), entry, opts, true);
    } else {
      const methods: Record<string, Handler> = {};
      for (const [method, handlerValue] of Object.entries(value as Record<string, unknown>)) {
        methods[method] = wrapHandler(
          toHandler(handlerValue, `${method} ${key}`),
          entry[method as HttpMethod]!,
          opts,
          false,
        );
      }
      wrapped[key] = methods;
    }
  }
  return wrapped as T;
}
