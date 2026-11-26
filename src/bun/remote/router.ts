/**
 * The remote router (docs/specs/remote-readiness-spec.md "Remote router and route policy"; docs/architecture/remote-gateway.md). Takes ONE
 * request from an authenticated phone session and turns it into a call of the SAME served handler the desktop webview and the CLI use, in
 * process: no loopback fetch, no token. The ten steps, in this order and for every call:
 *
 *   1 match     the path against the remote route table (its own matcher; routing-precedence.test.ts proves it picks what Bun.serve picks)
 *   2 refuse    the two SSE routes: a phone subscribes (`use-subscription`)
 *   3 rate      per-device buckets; stop-class calls are never limited
 *   4 classify  base policy + the class rules (route-classes.ts): level raises, `never`, the targets of signed calls
 *   5 idem      every non-GET carries a 128-bit key; a repeat inside 10 minutes answers the stored result without running again
 *   6 step-up   unlock window (only while the task runs without asking) or a signed decision (five checks)
 *   7 attempt   an audit row, with a body HASH and the signature, BEFORE the handler runs; if it cannot be written the call does not run
 *   8 handler   `markDeviceRequest` then the served handler (boot gate, level check and path gate included)
 *   9 result    an audit row naming the attempt and the status
 *   10 store    the idempotency result; a consent or autonomy-raising success raises an app event and an OS notification
 *
 * `markDeviceRequest` is imported here and nowhere else (route-policy-remote.test.ts pins it): this is the only place a request becomes a
 * device request, so there is no header, query or token a phone could forge to look like one.
 */
import { toHex } from "@agetor/remote-protocol/bytes";
import { canonicalBytes } from "@agetor/remote-protocol/canonical-json";
import { sha256Hex } from "@agetor/remote-protocol/derive";
import { levelAtLeast } from "@agetor/remote-protocol/levels";
import type { AppEvent } from "../../shared/types.ts";
import { everyRoute, markDeviceRequest, type HttpMethod, type RemotePolicy } from "../route-policy.ts";
import { servedRoutes, type ServedHandler, type ServedRoutes } from "../route-table.ts";
import type { Audit } from "./audit.ts";
import { runsWithoutAsking } from "./autonomy.ts";
import { DecisionError, type Decisions } from "./decisions.ts";
import { requestHash, type Idempotency } from "./idempotency.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { classifyRoute, type ClassifyLookups } from "./route-classes.ts";
import type { Classified, DevicePrincipal } from "./types.ts";

// ── the request and the result ────────────────────────────────────────────────────────────────────────────────────────────

export interface RouteRequest {
  method: HttpMethod;
  /** Absolute path, no query. */
  path: string;
  /** The query string without its `?`. */
  query: string | null;
  body: unknown;
  /** 128-bit lowercase hex. Required on every non-GET. */
  idem: string | null;
  decision: { payload: unknown; sig: string } | null;
}

export interface RouteResult {
  status: number;
  contentType: string;
  body: Uint8Array;
  /** True when the answer is a stored result returned for a repeated idempotency key. */
  replayed?: boolean;
}

export interface RouterDeps {
  limiter: Pick<RateLimiter, "check">;
  idempotency: Idempotency;
  decisions: Pick<Decisions, "verifyDecision" | "isUnlocked">;
  audit: Pick<Audit, "attempt" | "result" | "event" | "refusal">;
  lookups: ClassifyLookups & { task(taskId: string): Promise<{ agent: string; mode: string | null; title?: string | null } | null> };
  /** Defaults to the real served routes. */
  routes?: () => ServedRoutes;
  /** Defaults to every route and method in ROUTE_POLICY (`everyRoute`). */
  table?: () => Array<{ method: HttpMethod; route: string; policy: RemotePolicy | "none" }>;
  broadcast?: (ev: AppEvent) => void;
  /** An OS notification that a phone allowed something (deviceName, text). Optional: the gateway wires the real one. */
  notify?: (n: { deviceId: string; title: string; body: string }) => void;
  now?: () => number;
}

// ── the matcher ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Characters a path segment may hold. Ids are uuids and slugs; anything exotic (an encoding, a dot segment) is refused before matching. */
const SEGMENT_RE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const MAX_PATH = 512;

export interface CompiledRoute {
  route: string;
  segments: string[];
  methods: Map<string, RemotePolicy | "none">;
}

export function compileRoutes(table: Array<{ method: HttpMethod; route: string; policy: RemotePolicy | "none" }>): CompiledRoute[] {
  const byRoute = new Map<string, CompiledRoute>();
  for (const t of table) {
    let c = byRoute.get(t.route);
    if (!c) byRoute.set(t.route, (c = { route: t.route, segments: t.route.split("/").slice(1), methods: new Map() }));
    c.methods.set(t.method, t.policy);
  }
  return [...byRoute.values()];
}

export function splitPath(path: string): string[] | null {
  if (path.length === 0 || path.length > MAX_PATH || path[0] !== "/") return null;
  const parts = path.slice(1).split("/");
  for (const p of parts) if (!SEGMENT_RE.test(p) || p === "." || p === "..") return null;
  return parts;
}

/**
 * Pick the route for a request: among the patterns that serve the METHOD, have the path's length and whose static segments equal the path's,
 * the one that is static at the FIRST position where candidates differ (what Bun.serve's router does: an exact segment beats a parameter,
 * evaluated left to right, and a static route that lacks the method does not shadow a parametric one that has it: router-precedence.test.ts
 * runs both routers over a corpus). The table holds every route and method, remote or not, so a phone's path can never be quietly handed
 * to a remote route that Bun would not have picked.
 */
export function matchPath(compiled: CompiledRoute[], method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = splitPath(path);
  if (!parts) return null;
  let best: CompiledRoute | null = null;
  for (const r of compiled) {
    if (r.segments.length !== parts.length || !r.methods.has(method)) continue;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i]!;
      if (!seg.startsWith(":") && seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (!best || moreSpecific(r, best)) best = r;
  }
  if (!best) return null;
  const params: Record<string, string> = {};
  best.segments.forEach((seg, i) => {
    if (seg.startsWith(":")) params[seg.slice(1)] = parts[i]!;
  });
  return { route: best, params };
}

function moreSpecific(a: CompiledRoute, b: CompiledRoute): boolean {
  for (let i = 0; i < a.segments.length; i++) {
    const aStatic = !a.segments[i]!.startsWith(":");
    const bStatic = !b.segments[i]!.startsWith(":");
    if (aStatic !== bStatic) return aStatic;
  }
  return false;
}

/** The routes a phone must subscribe to rather than call. They are not remote routes, so they would answer `not-remote`; this answers usefully. */
const SSE_PATTERNS = ["/events", "/tasks/:id/events"];

function isSseRoute(path: string): boolean {
  const parts = splitPath(path);
  if (!parts) return false;
  return SSE_PATTERNS.some((p) => {
    const segs = p.split("/").slice(1);
    return segs.length === parts.length && segs.every((s, i) => s.startsWith(":") || s === parts[i]);
  });
}

// ── responses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function errorResult(status: number, code: string, message: string, extra: Record<string, unknown> = {}): RouteResult {
  return { status, contentType: "application/json", body: enc.encode(JSON.stringify({ error: message, code, ...extra })) };
}

const REFUSAL_FOR_DECISION: Record<string, string> = {
  "no-such-content": "gone",
  challenge: "challenge",
  session: "session",
  signature: "signature",
  "content-changed": "content-changed",
  decision: "decision",
  unlock: "unlock",
};

/** What a consent success is called in the app event stream. */
function actionFor(c: Classified): Extract<AppEvent, { type: "remote_action" }>["action"] | null {
  if (c.class !== "consent" || !c.target) return null;
  switch (c.target.kind) {
    case "plan":
      return "plan-approved";
    case "claude-plan":
      return c.target.row === "auto" ? "auto-mode-approved" : "plan-approved";
    case "tmux-card":
    case "fx-permission":
    case "fx-resume":
      return "card-allowed";
    case "gate":
      return "gate-decided";
    default:
      return null;
  }
}

function describe(action: NonNullable<ReturnType<typeof actionFor>>): string {
  switch (action) {
    case "plan-approved":
      return "approved a plan";
    case "card-allowed":
      return "allowed a request";
    case "gate-decided":
      return "decided a review";
    case "auto-mode-approved":
      return "switched a task to auto mode";
    default:
      return "acted";
  }
}

const NO_SERVER = { timeout: () => undefined, requestIP: () => null, upgrade: () => false } as const;

// ── the router ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Router {
  invoke(principal: DevicePrincipal, req: RouteRequest): Promise<RouteResult>;
}

export function createRouter(deps: RouterDeps): Router {
  const now = deps.now ?? Date.now;
  let compiledCache: CompiledRoute[] | null = null;
  const compiled = (): CompiledRoute[] => (compiledCache ??= compileRoutes((deps.table ?? everyRoute)()));
  const routes = deps.routes ?? servedRoutes;

  const handlerFor = (method: HttpMethod, route: string): ServedHandler | null => {
    const entry = routes()[route];
    if (!entry) return null;
    if (typeof entry === "function") return entry;
    return entry[method] ?? null;
  };

  async function invoke(principal: DevicePrincipal, req: RouteRequest): Promise<RouteResult> {
    const routeLabel = `${req.method} ${req.path}`;
    const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): RouteResult => {
      void deps.audit.refusal(principal.deviceId, code, routeLabel).catch(() => undefined);
      return errorResult(status, code, message, extra);
    };

    // 1. match
    if (!splitPath(req.path)) return errorResult(400, "bad-path", "the path is not valid");
    // 2. the SSE routes
    if (req.method === "GET" && isSseRoute(req.path)) return errorResult(400, "use-subscription", "subscribe instead of calling this route");
    const m = matchPath(compiled(), req.method, req.path);
    const entry = m?.route.methods.get(req.method);
    if (!m || entry === undefined) return errorResult(404, "not-found", "no such route");
    if (entry === "none") return refuse(403, "not-remote", "this route is not available from a phone");
    const { params } = m;
    const route = { route: m.route.route, method: req.method, policy: entry };
    if (!levelAtLeast(principal.level, route.policy.level)) {
      return refuse(403, "level", "this device's level is too low for this route", { required: route.policy.level, level: principal.level });
    }

    // 3. rate (a stop-class call is never limited)
    const rate = deps.limiter.check(principal.deviceId, route.policy.rate);
    if (!rate.ok) return refuse(429, "rate-limited", "too many requests", { retryAfterMs: rate.retryAfterMs });

    // 4. classify
    const query = new URLSearchParams(req.query ?? "");
    let cls: Classified;
    try {
      cls = await classifyRoute({ method: req.method, route: route.route, params, query, body: req.body }, route.policy, deps.lookups);
    } catch {
      return errorResult(500, "internal", "the request could not be classified");
    }
    if (cls.class === "never") {
      if (cls.reason === "gone") return errorResult(404, "gone", "what you are answering no longer exists");
      return refuse(403, "not-remote-v1", cls.reason ?? "answer this on your Mac");
    }
    if (!levelAtLeast(principal.level, cls.level)) {
      return refuse(403, "level", "this call needs a higher device level", { required: cls.level, level: principal.level });
    }

    // 5. idempotency: every non-GET
    let claim: Awaited<ReturnType<Idempotency["claim"]>> | null = null;
    if (req.method !== "GET") {
      if (req.idem === null) return refuse(400, "idem-required", "a write needs an idempotency key");
      try {
        claim = await deps.idempotency.claim(principal.deviceId, req.idem, requestHash(req.method, req.path, req.query, req.body));
      } catch {
        return errorResult(400, "idem-required", "the idempotency key is not valid");
      }
      if (claim.kind === "mismatch") return refuse(409, "idem-mismatch", "that idempotency key was used for a different request");
      if (claim.kind === "hit") {
        void deps.audit.event("replayed", { deviceId: principal.deviceId, route: routeLabel, resultCode: String(claim.result.status) }).catch(() => undefined);
        return { status: claim.result.status, contentType: claim.result.contentType, body: claim.result.body ?? new Uint8Array(0), replayed: true };
      }
    }
    const done = async (r: RouteResult, store: boolean): Promise<RouteResult> => {
      if (claim && claim.kind === "run") {
        if (store) await claim.commit({ status: r.status, contentType: r.contentType, body: r.body }).catch(() => undefined);
        else claim.abort();
      }
      return r;
    };

    // 6. step-up
    let signature: string | null = null;
    try {
      const stepRefusal = await stepUp(principal, req, cls, routeLabel);
      if (stepRefusal) return await done(refuse(403, stepRefusal.code, stepRefusal.message), false);
      signature = req.decision?.sig ?? null;
    } catch {
      return await done(errorResult(500, "internal", "the step-up check failed"), false);
    }

    // 7. attempt (a call that changes anything is audited before it runs; a read is not)
    let attemptSeq: number | null = null;
    if (cls.class !== "read") {
      try {
        attemptSeq = await deps.audit.attempt({
          deviceId: principal.deviceId, sessionHash: toHex(principal.sessionHash), route: routeLabel, target: cls.target ?? { taskId: cls.taskId ?? null },
          bodyHash: req.body === null || req.body === undefined ? null : sha256Hex(canonicalBytes(req.body)), signature,
        });
      } catch {
        // No audit row, no action.
        return await done(errorResult(500, "audit-failed", "the call could not be recorded, so it was not made"), false);
      }
    }

    // 8. the handler
    let result: RouteResult;
    try {
      result = await callHandler(principal, route, params, req);
    } catch {
      if (attemptSeq !== null) await deps.audit.result(attemptSeq, "500", { deviceId: principal.deviceId }).catch(() => undefined);
      return await done(errorResult(500, "internal", "the request failed"), false);
    }

    // 9. result  10. store, and tell the Mac
    if (attemptSeq !== null) await deps.audit.result(attemptSeq, String(result.status), { deviceId: principal.deviceId }).catch(() => undefined);
    await done(result, true);
    if (result.status >= 200 && result.status < 300) afterSuccess(principal, cls);
    return result;
  }

  /** The step-up of a classified call; null when it passes, else the refusal. */
  async function stepUp(principal: DevicePrincipal, req: RouteRequest, cls: Classified, routeLabel: string): Promise<{ code: string; message: string } | null> {
    const needsUnlock = async (): Promise<boolean> => {
      // A task that runs without asking acts on whatever it is sent: the unlock window must be open. An unknown task counts as one.
      const task = cls.taskId ? await deps.lookups.task(cls.taskId) : null;
      return task ? runsWithoutAsking(task) : true;
    };
    if (cls.stepUp === "none") return null;
    if (cls.stepUp === "unlock") {
      if ((await needsUnlock()) && !deps.decisions.isUnlocked(principal)) return { code: "unlock", message: "unlock this session first" };
      return null;
    }
    // signed
    if (!req.decision || !cls.target) return { code: "signature", message: "this call needs a signed decision" };
    let payload;
    try {
      payload = await deps.decisions.verifyDecision(principal, req.decision, cls.target);
    } catch (e) {
      if (e instanceof DecisionError) return { code: REFUSAL_FOR_DECISION[e.code] ?? "signature", message: e.message };
      throw e;
    }
    // The signed route must be this call, and a gate's decision and comment must be what the body says.
    if (payload.route !== routeLabel) return { code: "signature", message: "the signed route is not this call's" };
    if (cls.bound) {
      if (cls.bound.decision !== undefined && payload.decision !== cls.bound.decision) return { code: "decision", message: "the signed decision is not the one requested" };
      if (cls.bound.comment !== undefined && (payload.comment ?? null) !== (cls.bound.comment ?? null)) return { code: "decision", message: "the signed comment is not the one sent" };
    }
    if (cls.alsoUnlock && (cls.alsoUnlock === "always" || (await needsUnlock())) && !deps.decisions.isUnlocked(principal)) {
      return { code: "unlock", message: "unlock this session first" };
    }
    return null;
  }

  async function callHandler(principal: DevicePrincipal, route: { route: string; method: HttpMethod }, params: Record<string, string>, req: RouteRequest): Promise<RouteResult> {
    const handler = handlerFor(route.method, route.route);
    if (!handler) return errorResult(404, "not-found", "no such route");
    const url = `http://127.0.0.1${req.path}${req.query ? `?${req.query}` : ""}`;
    const hasBody = req.method !== "GET" && req.body !== null && req.body !== undefined;
    const request = new Request(url, {
      method: req.method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    Object.defineProperty(request, "params", { value: params, enumerable: true });
    markDeviceRequest(request, principal);
    const res = await handler(request, NO_SERVER);
    if (!res) return errorResult(404, "not-found", "no such route");
    const body = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body };
  }

  function afterSuccess(principal: DevicePrincipal, cls: Classified): void {
    const action = actionFor(cls);
    if (!action) return;
    const ts = now();
    try {
      deps.broadcast?.({ type: "remote_action", taskId: cls.taskId ?? null, deviceName: principal.deviceName, action, ts });
    } catch {
      /* an app event must never fail the call */
    }
    try {
      deps.notify?.({ deviceId: principal.deviceId, title: principal.deviceName, body: describe(action) });
    } catch {
      /* ignore */
    }
  }

  return { invoke };
}

/** The pinned entry point (plan §3.3): one call of the router. */
export function invokeRoute(router: Router, principal: DevicePrincipal, req: RouteRequest): Promise<RouteResult> {
  return router.invoke(principal, req);
}

// ── the live lookups ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lookups over the running core. Imports are lazy so the module and its tests load without a database. */
export function createLiveLookups(): RouterDeps["lookups"] {
  const interactions = () => import("../interactions.ts");
  const db = () => import("../db-async.ts");
  return {
    async tmuxPrompt(id) {
      const p = (await interactions()).findTmuxPromptById(id);
      return p ? { taskId: p.taskId, paneText: p.paneText, choices: p.choices.map((c) => ({ key: c.key, label: c.label })), answerKind: p.answerKind ?? null } : null;
    },
    async fxPermission(id) {
      const p = (await interactions()).findFxPermissionById(id);
      return p ? { taskId: p.taskId, harness: p.harness ?? "fx", options: p.options.map((o) => ({ optionId: o.optionId, kind: o.kind })) } : null;
    },
    async askQuestionTask(id) {
      return (await interactions()).getAskQuestionsById(id)?.taskId ?? null;
    },
    async runTask(runId) {
      return (await (await db()).runs.get(runId))?.taskId ?? null;
    },
    async task(taskId) {
      const t = await (await db()).tasks.get(taskId);
      return t ? { agent: t.agent, mode: t.mode ?? null, title: t.title ?? null } : null;
    },
    async previewInScope(taskId, path) {
      const t = await (await db()).tasks.get(taskId);
      if (!t) return false;
      const nodePath = await import("node:path");
      const roots = [t.workdir, t.worktreePath, ...(t.repositories ?? []).flatMap((r) => [r.path, r.worktreePath]), ...(t.sentFiles ?? []).map((f) => f.path)].filter(
        (r): r is string => typeof r === "string" && r.length > 0,
      );
      const target = nodePath.resolve(path);
      return roots.some((r) => {
        const root = nodePath.resolve(r);
        return target === root || target.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
      });
    },
  };
}
