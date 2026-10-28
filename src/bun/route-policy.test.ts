import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { API_TOKEN, CLI_TOKEN } from "./api-config.ts";
import {
  ROUTE_POLICY,
  applyRoutePolicy,
  callerOf,
  desktopOnlyResponse,
  resolveCaller,
  type ApiCaller,
  type HttpMethod,
  type PathParam,
  type RoutePolicy,
  type RoutePolicyOptions,
} from "./route-policy.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Source scan of server.ts. The route table is read from the AST (not run), so
// these tests see exactly the keys and methods the real `routes:` object has —
// including the ones that only exist behind `authed(...)`.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = path.resolve(import.meta.dir, "..", "..");
const SERVER_SRC = readFileSync(path.join(import.meta.dir, "server.ts"), "utf8");

interface ScannedRoute {
  key: string;
  /** `"ALL"` for a function-valued route; else the method names. */
  methods: string[];
  /** Handler source per method (`ALL` for a function-valued route). */
  handlers: Record<string, string>;
}

/** The `routes:` object literal, through `applyRoutePolicy(...)`, casts and a `const routes = …` hop. */
function findRoutesObject(sf: ts.SourceFile): ts.ObjectLiteralExpression {
  const consts = new Map<string, ts.Expression>();
  let candidate: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      consts.set(n.name.text, n.initializer);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText() === "routes") candidate = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const unwrap = (e: ts.Expression | undefined): ts.ObjectLiteralExpression => {
    if (!e) throw new Error("no `routes:` property found in server.ts");
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      return unwrap(e.expression);
    }
    if (ts.isCallExpression(e)) return unwrap(e.arguments[0]);
    if (ts.isIdentifier(e)) return unwrap(consts.get(e.text));
    throw new Error(`unrecognized routes initializer: ${e.getText().slice(0, 60)}`);
  };
  return unwrap(candidate);
}

function propName(p: ts.ObjectLiteralElementLike): string {
  const name = p.name;
  if (!name) throw new Error(`unnamed route property: ${p.getText().slice(0, 60)}`);
  return ts.isStringLiteralLike(name) ? name.text : name.getText();
}

function scanServerRoutes(): ScannedRoute[] {
  const sf = ts.createSourceFile("server.ts", SERVER_SRC, ts.ScriptTarget.Latest, true);
  const out: ScannedRoute[] = [];
  const collect = (p: ts.ObjectLiteralElementLike) => {
    if (ts.isSpreadAssignment(p)) {
      // A conditionally registered group: `...(flag ? { "/x": … } : {})`.
      const nested = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) n.properties.forEach(collect);
        else ts.forEachChild(n, nested);
      };
      nested(p.expression);
      return;
    }
    const key = propName(p);
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
      const handlers: Record<string, string> = {};
      for (const q of p.initializer.properties) {
        handlers[propName(q)] = ts.isPropertyAssignment(q) ? q.initializer.getText() : q.getText();
      }
      out.push({ key, methods: Object.keys(handlers), handlers });
    } else {
      const text = ts.isPropertyAssignment(p) ? p.initializer.getText() : p.getText();
      out.push({ key, methods: ["ALL"], handlers: { ALL: text } });
    }
  };
  findRoutesObject(sf).properties.forEach(collect);
  return out;
}

const SERVER_ROUTES = scanServerRoutes();

function policyFor(key: string, method: string): RoutePolicy | undefined {
  const entry = ROUTE_POLICY[key];
  if (!entry) return undefined;
  if (typeof (entry as RoutePolicy).callers === "string") return entry as RoutePolicy;
  return (entry as Partial<Record<HttpMethod, RoutePolicy>>)[method as HttpMethod];
}

/** Every (method, key) the table classifies; a flat entry counts as `ALL`. */
function policyEntries(): Array<{ method: string; key: string; policy: RoutePolicy }> {
  const out: Array<{ method: string; key: string; policy: RoutePolicy }> = [];
  for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
    if (typeof (entry as RoutePolicy).callers === "string") {
      out.push({ method: "ALL", key, policy: entry as RoutePolicy });
    } else {
      for (const [method, policy] of Object.entries(entry)) {
        out.push({ method, key, policy: policy as RoutePolicy });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("route coverage (server.ts ↔ ROUTE_POLICY)", () => {
  it("scans a plausible route table out of server.ts", () => {
    expect(SERVER_ROUTES.length).toBeGreaterThan(150);
    expect(SERVER_ROUTES.some((r) => r.key === "/health")).toBe(true);
    expect(new Set(SERVER_ROUTES.map((r) => r.key)).size).toBe(SERVER_ROUTES.length);
  });

  it("every route key in server.ts has a policy entry", () => {
    const missing = SERVER_ROUTES.filter((r) => !ROUTE_POLICY[r.key]).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("every method of every route is classified, and a flat entry matches only function-valued routes", () => {
    const problems: string[] = [];
    for (const r of SERVER_ROUTES) {
      const entry = ROUTE_POLICY[r.key];
      if (!entry) continue; // reported by the test above
      const flat = typeof (entry as RoutePolicy).callers === "string";
      if (r.methods[0] === "ALL") {
        if (!flat) problems.push(`${r.key}: function-valued route needs a flat policy`);
        continue;
      }
      if (flat) {
        problems.push(`${r.key}: per-method route needs one policy per method`);
        continue;
      }
      const have = Object.keys(entry).sort().join();
      const want = [...r.methods].sort().join();
      if (have !== want) problems.push(`${r.key}: routes [${want}] vs policy [${have}]`);
    }
    expect(problems).toEqual([]);
  });

  // Strict on purpose. `POST /terminals/:id/ws-ticket` (P7) is classified here
  // ahead of the route itself: it is the one entry expected to fail this until
  // task T7 adds the route to server.ts in wave 2. Nothing else may.
  it("every policy entry has a route in server.ts, unless it is flagged conditional", () => {
    const routeKeys = new Set(SERVER_ROUTES.map((r) => r.key));
    const orphans = Object.entries(ROUTE_POLICY)
      .filter(([key]) => !routeKeys.has(key))
      .filter(([, entry]) => {
        const policies = typeof (entry as RoutePolicy).callers === "string"
          ? [entry as RoutePolicy]
          : Object.values(entry as Record<string, RoutePolicy>);
        return !policies.every((p) => p.conditional);
      })
      .map(([key]) => key);
    expect(orphans).toEqual([]);
  });

  it("the terminal WebSocket upgrade path is not in the table (P11: it lives in fetch() and takes a ticket)", () => {
    expect(ROUTE_POLICY["/terminals/:id/ws"]).toBeUndefined();
    expect(policyFor("/terminals/:id/ws-ticket", "POST")?.callers).toBe("app");
  });

  it("/health is the only public route", () => {
    const pub = policyEntries().filter((e) => e.policy.callers === "public").map((e) => e.key);
    expect(pub).toEqual(["/health"]);
  });

  it("every entry carries remote: none and conditional is only used on the test-only block route", () => {
    for (const { policy } of policyEntries()) expect(policy.remote).toBe("none");
    const conditional = policyEntries().filter((e) => e.policy.conditional).map((e) => `${e.method} ${e.key}`);
    expect(conditional).toEqual(["POST /test/block-event-loop"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) the desktop-only set
// ─────────────────────────────────────────────────────────────────────────────

// Plan §3 "Desktop-only set" (D9, P7). Keep this list literal: it is the
// reviewable statement of what the CLI token cannot reach.
const DESKTOP_ONLY = [
  "DELETE /notifications/:taskId",
  "DELETE /terminals/:id",
  "GET /files/preview",
  "GET /tasks/:id/diff/blob",
  "GET /tasks/:id/terminals",
  "GET /updates/status",
  "POST /app/force-quit",
  "POST /attachments",
  "POST /bundle/export/save",
  "POST /bundle/pick-file",
  "POST /harnesses/:id/open-terminal",
  "POST /harnesses/:id/usage/refresh",
  "POST /open-external",
  "POST /open-path",
  "POST /projects/pick",
  "POST /refs/drag",
  "POST /refs/pick",
  "POST /reveal-path",
  "POST /screenshots",
  "POST /tasks/:id/open-tmux",
  "POST /tasks/:id/terminals",
  "POST /terminals/:id/ws-ticket",
  "POST /test/block-event-loop",
  "POST /tmux-source",
  "POST /updates/apply",
  "POST /updates/check",
  "POST /window/focus",
  "POST /window/toggle-zoom",
].sort();

// Desktop-only routes whose handler answers 501 first when `native` is absent
// (verified against server.ts: each does `if (!native) return
// notAvailableHeadless(req)` before any other outcome that matters to a real
// request). NOT in this list, though desktop-only: /bundle/export/save (the
// downloads target works headless), /window/toggle-zoom (503 "no main window"),
// and everything that works headless (terminals, previews, screenshots…).
const HEADLESS_501 = [
  "DELETE /notifications/:taskId",
  "GET /updates/status",
  "POST /app/force-quit",
  "POST /bundle/pick-file",
  "POST /open-external",
  "POST /open-path",
  "POST /projects/pick",
  "POST /refs/pick",
  "POST /reveal-path",
  "POST /updates/apply",
  "POST /updates/check",
  "POST /window/focus",
].sort();

describe("desktop-only set", () => {
  it("callers: app is exactly plan §3's set", () => {
    const actual = policyEntries()
      .filter((e) => e.policy.callers === "app")
      .map((e) => `${e.method} ${e.key}`)
      .sort();
    expect(actual).toEqual(DESKTOP_ONLY);
  });

  it("headless501 is exactly the desktop-only routes whose handler 501s first without native", () => {
    const actual = policyEntries()
      .filter((e) => e.policy.headless501)
      .map((e) => `${e.method} ${e.key}`)
      .sort();
    expect(actual).toEqual(HEADLESS_501);
    for (const e of policyEntries().filter((x) => x.policy.headless501)) {
      expect(e.policy.callers).toBe("app");
    }
  });

  it("every headless501 route's handler really does answer notAvailableHeadless", () => {
    for (const line of HEADLESS_501) {
      const [method, ...rest] = line.split(" ");
      const key = rest.join(" ");
      const route = SERVER_ROUTES.find((r) => r.key === key);
      expect(route, line).toBeDefined();
      expect(route!.handlers[method!], line).toContain("notAvailableHeadless(req)");
    }
  });

  it("the value rule, not a route, guards disclaimSpawnedAgents = false (PUT /preferences/:key stays app+cli)", () => {
    expect(policyFor("/preferences/:key", "PUT")?.callers).toBe("app+cli");
    expect(policyFor("/preferences", "GET")?.callers).toBe("app+cli");
  });

  it("D9's stay-CLI-scoped list is app+cli", () => {
    const cliRoutes: Array<[string, string]> = [
      ["POST", "/notifications"],
      ["GET", "/tmux-source"],
      ["PATCH", "/harnesses/:id"],
      ["POST", "/harnesses"],
      ["DELETE", "/harnesses/:id"],
      ["GET", "/harnesses/:id/shell-env"],
      ["GET", "/db/stats"],
      ["POST", "/db/compact"],
      ["POST", "/db/retention/run"],
      ["POST", "/bundle/export"],
      ["POST", "/bundle/import/preview"],
      ["POST", "/bundle/import"],
      ["POST", "/daemon/shutdown"],
      ["GET", "/info"],
      ["GET", "/github/issue-thread"],
      ["POST", "/refs/resolve"],
      ["GET", "/files/index"],
    ];
    for (const [method, key] of cliRoutes) {
      expect(policyFor(key, method)?.callers, `${method} ${key}`).toBe("app+cli");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) vocabulary: nothing pairs, enables remote access or raises permissions
// ─────────────────────────────────────────────────────────────────────────────

describe("route vocabulary", () => {
  const BANNED_SEGMENT = /^(pair|pairing|device|devices|remote|remote-access)$/i;
  // Read-only routes whose name merely mentions permissions:
  //  - answering an fx tool-permission card for a run, which grants nothing to a client;
  //  - the GitHub repo-permissions lookup (what the signed-in user may do on a repo).
  const PERMISSION_ALLOWLIST = new Set(["/fx-permissions/:id/answer", "/github/repo-permissions"]);

  it("no path segment looks like pairing, devices or remote access", () => {
    const bad: string[] = [];
    for (const key of Object.keys(ROUTE_POLICY)) {
      for (const segment of key.split("/").filter(Boolean)) {
        if (BANNED_SEGMENT.test(segment)) bad.push(`${key} (${segment})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no route is named for permissions, except the allowlisted read-only ones", () => {
    const bad = Object.keys(ROUTE_POLICY).filter((key) => {
      if (PERMISSION_ALLOWLIST.has(key)) return false;
      return key.split("/").some((s) => /permissions?$/i.test(s));
    });
    expect(bad).toEqual([]);
  });

  it("the allowlisted permission routes exist (a stale allowlist hides nothing)", () => {
    for (const key of PERMISSION_ALLOWLIST) expect(ROUTE_POLICY[key], key).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) every route the CLI calls is app+cli
// ─────────────────────────────────────────────────────────────────────────────

interface CliCall {
  method: string;
  /** Template path with `${…}` collapsed to `:p`, query string removed. */
  route: string;
  where: string;
}

function normalizeTemplate(raw: string): string {
  const noQuery = raw.split("?")[0]!;
  // `/${id}` → a param segment; a trailing `${qs}` suffix is dropped.
  return noQuery.replace(/\/\$\{[^}]*\}/g, "/:p").replace(/\$\{[^}]*\}/g, "");
}

function extractCliCalls(): CliCall[] {
  const calls: CliCall[] = [];
  const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

  const client = read("src/cli/api-client.ts");
  const reqRe = /this\.req(?:<[^>]*>)?\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*(["`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of client.matchAll(reqRe)) {
    calls.push({ method: m[1]!, route: normalizeTemplate(m[3]!), where: "api-client.ts this.req" });
  }
  const bundleRe = /this\.bundleReq(?:<[^>]*>)?\(\s*"([^"]+)"/g;
  for (const m of client.matchAll(bundleRe)) {
    calls.push({ method: "POST", route: m[1]!, where: "api-client.ts bundleReq" });
  }

  // SSE readers: every `streamSse<T>("<path>" | `<path>`, …)` under src/cli.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
    });
  const sseRe = /streamSse(?:<[^>]*>)?\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of walk(path.join(REPO, "src/cli"))) {
    if (/\.test\.tsx?$/.test(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(sseRe)) {
      calls.push({ method: "GET", route: normalizeTemplate(m[2]!), where: `${path.relative(REPO, file)} streamSse` });
    }
  }

  // supervisor `stopDaemon` and the app's handoff both POST /daemon/shutdown;
  // the creds probe GETs /health and /info.
  if (!read("src/cli/daemon/supervisor.ts").includes("/daemon/shutdown")) {
    throw new Error("supervisor.ts no longer calls /daemon/shutdown — update this test");
  }
  calls.push({ method: "POST", route: "/daemon/shutdown", where: "supervisor.ts" });
  if (!read("src/bun/index.ts").includes("/daemon/shutdown")) {
    throw new Error("index.ts no longer calls /daemon/shutdown — update this test");
  }
  calls.push({ method: "POST", route: "/daemon/shutdown", where: "index.ts handoff" });
  const creds = read("src/bun/core-creds.ts");
  if (!creds.includes("`${base}/info`")) throw new Error("core-creds.ts no longer probes /info — update this test");
  calls.push({ method: "GET", route: "/info", where: "core-creds.ts probeLiveCore" });
  calls.push({ method: "GET", route: "/health", where: "core-creds.ts probeLiveCore" });
  return calls;
}

/** The table key a client-side path hits: literal segments win over `:param` ones. */
function matchRouteKey(route: string): string | undefined {
  const want = route.split("/").filter(Boolean);
  let best: { key: string; score: number } | undefined;
  for (const key of Object.keys(ROUTE_POLICY)) {
    const have = key.split("/").filter(Boolean);
    if (have.length !== want.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const h = have[i]!;
      const w = want[i]!;
      if (h === w) score += 2;
      else if (h.startsWith(":") || w.startsWith(":")) score += 0;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || score > best.score)) best = { key, score };
  }
  return best?.key;
}

describe("routes the CLI (and the daemon handoff) call", () => {
  const calls = extractCliCalls();

  it("extracts a healthy number of calls (a refactor can't silently empty this test)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(65);
  });

  it("every one resolves to a table entry that lets the CLI token in for that method", () => {
    const problems: string[] = [];
    for (const c of calls) {
      const key = matchRouteKey(c.route);
      if (!key) {
        problems.push(`${c.method} ${c.route} (${c.where}): no route`);
        continue;
      }
      const policy = policyFor(key, c.method);
      if (!policy) {
        problems.push(`${c.method} ${c.route} (${c.where}): ${key} has no ${c.method} entry`);
        continue;
      }
      // /health is public, which the CLI token trivially satisfies.
      if (policy.callers === "app") problems.push(`${c.method} ${key} (${c.where}) is desktop-only`);
    }
    expect(problems).toEqual([]);
  });

  it("resolves the multi-line and template calls it is meant to see", () => {
    const seen = new Set(calls.map((c) => `${c.method} ${matchRouteKey(c.route)}`));
    for (const expected of [
      "POST /tasks/:id/start",
      "POST /agent-profiles/:id/duplicate", // multi-line this.req(
      "POST /tasks/:id/pipeline/retry", // multi-line this.req(
      "POST /bundle/import/preview", // bundleReq
      "POST /bundle/import",
      "POST /bundle/export",
      "GET /projects/branches", // template with a query string
      "POST /agent-models", // trailing ${qs}
      "GET /tasks/:id/events", // streamSse template
      "GET /events",
      "GET /app/events",
      "POST /daemon/shutdown",
      "GET /info",
    ]) {
      expect(seen.has(expected), expected).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) legacy query token
// ─────────────────────────────────────────────────────────────────────────────

describe("legacyQueryToken", () => {
  it("is set on exactly the three SSE GETs old CLIs open with ?token=", () => {
    const keys = policyEntries().filter((e) => e.policy.legacyQueryToken).map((e) => e.key).sort();
    expect(keys).toEqual(["/app/events", "/events", "/tasks/:id/events"]);
  });

  it("those are function-valued routes in server.ts and app+cli", () => {
    for (const key of ["/events", "/app/events", "/tasks/:id/events"]) {
      const route = SERVER_ROUTES.find((r) => r.key === key);
      expect(route?.methods, key).toEqual(["ALL"]);
      expect(policyFor(key, "GET")?.callers).toBe("app+cli");
    }
  });

  it("the run-scoped stream is not a legacy query route", () => {
    expect(policyFor("/runs/:id/events", "GET")?.legacyQueryToken).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) path-valued request fields are gated or explained
// ─────────────────────────────────────────────────────────────────────────────

/** Request fields that name a filesystem location. */
const PATH_FIELDS = ["path", "paths", "dir", "workdir", "cwd", "dest", "home", "bin"];

/** Path-looking fields a handler's source reads from the query string or the body. */
function pathFieldsRead(handler: string): Set<string> {
  const found = new Set<string>();
  const names = PATH_FIELDS.join("|");
  // ?name=
  for (const m of handler.matchAll(new RegExp(`searchParams\\.get\\(\\s*["'](${names})["']`, "g"))) found.add(m[1]!);
  // body.name / body?.name
  for (const m of handler.matchAll(new RegExp(`\\bbody\\??\\.(${names})\\b`, "g"))) found.add(m[1]!);
  // `as { …; name?: unknown; … }` request-shape casts
  for (const cast of handler.matchAll(/\bas\s*\{([^{}]*)\}/g)) {
    for (const m of cast[1]!.matchAll(new RegExp(`(?:^|[;,\\s])(${names})\\??\\s*:`, "g"))) found.add(m[1]!);
  }
  // `const { name, other: x } = await req.json()`
  for (const d of handler.matchAll(/\{([^{}]*)\}\s*(?::\s*\{[^{}]*\})?\s*=\s*\(?\s*(?:await\s+)?req\.json\(/g)) {
    for (const part of d[1]!.split(",")) {
      const name = part.trim().split(/[\s:]/)[0]!;
      if (PATH_FIELDS.includes(name)) found.add(name);
    }
  }
  return found;
}

// A path-looking name the source scan finds that the core never touches:
//  - POST /tasks sanitizes `references[].path` — stored and inlined into the
//    prompt as plain text, never stat'ed. The task's real directory is `workdir`
//    (declared; it travels through `Partial<Task>` where the scan can't see it).
const NOT_TOUCHED = new Set(["POST /tasks path"]);

describe("path-valued fields (D24)", () => {
  it("every app+cli handler that reads a path-looking field declares pathParams or pathParamsExempt for it", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const r of SERVER_ROUTES) {
      for (const [method, text] of Object.entries(r.handlers)) {
        const policy = policyFor(r.key, method === "ALL" ? "GET" : method);
        if (!policy || policy.callers !== "app+cli") continue;
        const fields = pathFieldsRead(text);
        if (fields.size === 0) continue;
        checked++;
        const declared = new Set((policy.pathParams ?? []).map((p) => p.name));
        for (const field of fields) {
          if (declared.has(field)) continue;
          if (policy.pathParamsExempt) continue;
          if (NOT_TOUCHED.has(`${method} ${r.key} ${field}`)) continue;
          problems.push(`${method} ${r.key} reads "${field}" with no pathParams/pathParamsExempt`);
        }
      }
    }
    expect(checked).toBeGreaterThan(80); // the ~86 /github routes alone
    expect(problems).toEqual([]);
  });

  it("every exemption states a reason, and never sits beside the pathParams it would excuse", () => {
    for (const { method, key, policy } of policyEntries()) {
      if (policy.pathParamsExempt !== undefined) {
        expect(policy.pathParamsExempt.length, `${method} ${key}`).toBeGreaterThan(15);
        expect(policy.pathParams, `${method} ${key}`).toBeUndefined();
      }
    }
  });

  it("pathParams only appear on app+cli routes (a desktop-only route never reaches the gate)", () => {
    for (const { method, key, policy } of policyEntries()) {
      if (policy.pathParams) expect(policy.callers, `${method} ${key}`).toBe("app+cli");
    }
  });

  // The handlers below take their path through shapes the source scan above
  // can't see (`Partial<Task>` + a rest spread, a shared `dir` variable…), so
  // they are pinned here by name. Full list of declared gates:
  it("pins the declared pathParams", () => {
    const declared = policyEntries()
      .filter((e) => e.policy.pathParams)
      .map((e) => `${e.method} ${e.key}: ${e.policy.pathParams!.map((p: PathParam) => `${p.in}.${p.name}(${p.mode})`).join(", ")}`)
      .sort();
    const nonGithub = declared.filter((d) => !d.includes(" /github/"));
    expect([...nonGithub].sort()).toEqual([
      "GET /agent-discovery: query.workdir(exists)",
      "GET /files/index: query.dir(exists)",
      "GET /projects/branches: query.path(exists)",
      "PATCH /harnesses/:id: body.home(exists), body.bin(exists)",
      "PATCH /tasks/:id: body.workdir(exists)",
      "POST /harnesses: body.home(exists), body.bin(exists)",
      "POST /projects: body.path(exists)",
      "POST /projects/clone: body.dest(nearest-ancestor)",
      "POST /projects/fetch: body.path(exists)",
      "POST /projects/pull: body.path(exists)",
      "POST /projects/push: body.path(exists)",
      "POST /tasks: body.workdir(exists)",
    ].sort());
    // Every /github/* route except the token store takes a repo directory.
    const github = declared.filter((d) => d.includes(" /github/"));
    const githubRoutes = policyEntries().filter((e) => e.key.startsWith("/github/"));
    expect(github.length).toBe(githubRoutes.length - 3); // GET/PUT /github/tokens, DELETE /github/tokens/:host
    for (const g of github) {
      expect(g.endsWith("query.path(exists)") || g.endsWith("body.path(exists)") || g.endsWith("body.paths(exists)"), g).toBe(true);
    }
    expect(github).toContain("POST /github/items-aggregate: body.paths(exists)");
    expect(github).toContain("GET /github/pull-blob: query.path(exists)");
  });

  it("pins the exemptions", () => {
    const exempt = policyEntries()
      .filter((e) => e.policy.pathParamsExempt)
      .map((e) => `${e.method} ${e.key}`)
      .sort();
    expect(exempt).toEqual([
      "DELETE /projects",
      "GET /projects/settings",
      "POST /claude-sessions/import",
      "POST /refs/resolve",
      "PUT /projects/settings",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCaller
// ─────────────────────────────────────────────────────────────────────────────

const APP_POLICY: RoutePolicy = { callers: "app", remote: "none" };
const CLI_POLICY: RoutePolicy = { callers: "app+cli", remote: "none" };
const SSE_POLICY: RoutePolicy = { callers: "app+cli", remote: "none", legacyQueryToken: true };

function req(url: string, init?: RequestInit & { token?: string }): Request {
  const headers = new Headers(init?.headers);
  if (init?.token) headers.set("authorization", `Bearer ${init.token}`);
  return new Request(url, { ...init, headers });
}

describe("resolveCaller", () => {
  it("Bearer master → app, Bearer CLI token → cli", () => {
    expect(resolveCaller(req("http://x/a", { token: API_TOKEN }), CLI_POLICY)).toBe("app");
    expect(resolveCaller(req("http://x/a", { token: CLI_TOKEN }), CLI_POLICY)).toBe("cli");
  });

  it("no credential, a wrong credential and a wrong scheme → null", () => {
    expect(resolveCaller(req("http://x/a"), CLI_POLICY)).toBeNull();
    expect(resolveCaller(req("http://x/a", { token: "nope" }), CLI_POLICY)).toBeNull();
    expect(resolveCaller(req("http://x/a", { token: API_TOKEN.slice(0, -1) }), CLI_POLICY)).toBeNull();
    expect(resolveCaller(req("http://x/a", { headers: { authorization: `Basic ${API_TOKEN}` } }), CLI_POLICY)).toBeNull();
  });

  it("?token=<CLI token> counts only where legacyQueryToken is set", () => {
    expect(resolveCaller(req(`http://x/events?token=${CLI_TOKEN}`), SSE_POLICY)).toBe("cli");
    expect(resolveCaller(req(`http://x/a?token=${CLI_TOKEN}`), CLI_POLICY)).toBeNull();
    expect(resolveCaller(req(`http://x/a?token=${CLI_TOKEN}`), APP_POLICY)).toBeNull();
  });

  it("?token=<master> is never accepted, flagged route or not", () => {
    expect(resolveCaller(req(`http://x/events?token=${API_TOKEN}`), SSE_POLICY)).toBeNull();
    expect(resolveCaller(req(`http://x/a?token=${API_TOKEN}`), CLI_POLICY)).toBeNull();
  });

  it("a Bearer header wins over a query token", () => {
    expect(resolveCaller(req(`http://x/events?token=${CLI_TOKEN}`, { token: API_TOKEN }), SSE_POLICY)).toBe("app");
  });
});

describe("desktopOnlyResponse", () => {
  it("is 403 with the desktop-only code and the cors headers", async () => {
    const res = desktopOnlyResponse(req("http://x/a"), () => ({ "x-cors": "1" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-cors")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "only available in the Agetor app", code: "desktop-only" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) the walker, against fake routes and a fake table
// ─────────────────────────────────────────────────────────────────────────────

const ok = (tag: string) => (r: Request) => new Response(JSON.stringify({ tag, caller: callerOf(r) }), { status: 200 });

const FAKE_TABLE: Record<string, RoutePolicy | Partial<Record<HttpMethod, RoutePolicy>>> = {
  "/open": { callers: "public", remote: "none" },
  "/both": { GET: CLI_POLICY, POST: CLI_POLICY },
  "/desk": { POST: APP_POLICY },
  "/desk501": { POST: { ...APP_POLICY, headless501: true } },
  "/stream": SSE_POLICY,
  "/files": {
    GET: { ...CLI_POLICY, pathParams: [{ in: "query", name: "dir", mode: "exists" }] },
    POST: {
      ...CLI_POLICY,
      pathParams: [
        { in: "body", name: "path", mode: "exists" },
        { in: "body", name: "paths", mode: "exists" },
        { in: "body", name: "dest", mode: "nearest-ancestor" },
      ],
    },
  },
  "/maybe": { POST: { ...APP_POLICY, conditional: true } },
};

function fakeRoutes() {
  return {
    "/open": ok("open"),
    "/both": { GET: ok("both-get"), POST: ok("both-post") },
    "/desk": { POST: ok("desk") },
    "/desk501": { POST: ok("desk501") },
    "/stream": ok("stream"),
    "/files": { GET: ok("files-get"), POST: ok("files-post") },
  };
}

interface GateCall { p: string; caller: ApiCaller; mode: PathParam["mode"] }

function makeOpts(over: Partial<RoutePolicyOptions> & { calls?: GateCall[]; refuse?: (p: string) => boolean } = {}): RoutePolicyOptions {
  const { calls, refuse, ...rest } = over;
  return {
    headless: false,
    cors: () => ({ "x-cors": "1" }),
    gate: async (p, caller, mode) => {
      calls?.push({ p, caller, mode });
      return refuse?.(p)
        ? { status: 403, error: `blocked ${p}`, code: "path-not-accessible" }
        : null;
    },
    notAvailableHeadless: () => new Response(JSON.stringify({ error: "not available in headless mode" }), { status: 501 }),
    policy: FAKE_TABLE,
    ...rest,
  };
}

type FakeHandler = (r: Request) => Response | Promise<Response>;
const wrapFake = (opts: RoutePolicyOptions = makeOpts()) => applyRoutePolicy(fakeRoutes(), opts);
const call = (fn: unknown, r: Request) => (fn as FakeHandler)(r);

describe("applyRoutePolicy: request handling", () => {
  it("passes OPTIONS through to a per-method handler untouched, with no credential", async () => {
    const w = wrapFake();
    const res = await call(w["/desk"].POST, req("http://x/desk", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
    expect((await res.json()).caller).toBeNull();
  });

  it("answers OPTIONS on a function-valued route itself: 200 + cors, no token, handler never called", async () => {
    let calls = 0;
    const routes = {
      ...fakeRoutes(),
      "/stream": (r: Request) => { calls++; return ok("stream")(r); },
      "/open": (r: Request) => { calls++; return ok("open")(r); },
    };
    const w = applyRoutePolicy(routes, makeOpts());
    for (const key of ["/stream", "/open"] as const) {
      const res = await call(w[key], req(`http://x${key}`, { method: "OPTIONS" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-cors")).toBe("1");
      expect(await res.text()).toBe("");
    }
    // …also when a (wrong) token rides along: the preflight never reaches auth.
    const withBadToken = await call(w["/stream"], req("http://x/stream", { method: "OPTIONS", token: "nope" }));
    expect(withBadToken.status).toBe(200);
    expect(calls).toBe(0);
  });

  it("lets a public route through with no credential (callerOf stays null)", async () => {
    const res = await call(wrapFake()["/open"], req("http://x/open"));
    expect(res.status).toBe(200);
    expect((await res.json()).caller).toBeNull();
  });

  it("401s a request with no valid credential, with the cors headers", async () => {
    const res = await call(wrapFake()["/both"].GET, req("http://x/both"));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-cors")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("401s the master token in a query string", async () => {
    const w = wrapFake();
    expect((await call(w["/both"].GET, req(`http://x/both?token=${API_TOKEN}`))).status).toBe(401);
    expect((await call(w["/stream"], req(`http://x/stream?token=${API_TOKEN}`))).status).toBe(401);
  });

  it("accepts ?token=<CLI token> only on the flagged route", async () => {
    const w = wrapFake();
    const flagged = await call(w["/stream"], req(`http://x/stream?token=${CLI_TOKEN}`));
    expect(flagged.status).toBe(200);
    expect((await flagged.json()).caller).toBe("cli");
    expect((await call(w["/both"].GET, req(`http://x/both?token=${CLI_TOKEN}`))).status).toBe(401);
  });

  it("sets callerOf for the handler: app for the master, cli for the CLI token", async () => {
    const w = wrapFake();
    expect((await (await call(w["/both"].GET, req("http://x/both", { token: API_TOKEN }))).json()).caller).toBe("app");
    expect((await (await call(w["/both"].POST, req("http://x/both", { method: "POST", token: CLI_TOKEN }))).json()).caller).toBe("cli");
  });

  it("callerOf is null for a request the walker never saw", () => {
    expect(callerOf(req("http://x/both", { token: CLI_TOKEN }))).toBeNull();
  });

  it("403 desktop-only for the CLI token on a desktop-only route; the master passes", async () => {
    const w = wrapFake();
    const refused = await call(w["/desk"].POST, req("http://x/desk", { method: "POST", token: CLI_TOKEN }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-cors")).toBe("1");
    expect(await refused.json()).toEqual({ error: "only available in the Agetor app", code: "desktop-only" });
    const allowed = await call(w["/desk"].POST, req("http://x/desk", { method: "POST", token: API_TOKEN }));
    expect(allowed.status).toBe(200);
  });

  it("headless: a headless501 route answers the CLI token with the 501, others keep the 403", async () => {
    const w = wrapFake(makeOpts({ headless: true }));
    expect((await call(w["/desk501"].POST, req("http://x/desk501", { method: "POST", token: CLI_TOKEN }))).status).toBe(501);
    expect((await call(w["/desk"].POST, req("http://x/desk", { method: "POST", token: CLI_TOKEN }))).status).toBe(403);
    // …and on the app (not headless) the same flagged route is the plain 403.
    const app = wrapFake(makeOpts({ headless: false }));
    expect((await call(app["/desk501"].POST, req("http://x/desk501", { method: "POST", token: CLI_TOKEN }))).status).toBe(403);
    // The master still reaches the handler (which would 501 on its own when headless).
    expect((await call(w["/desk501"].POST, req("http://x/desk501", { method: "POST", token: API_TOKEN }))).status).toBe(200);
  });

  it("never calls the path gate for a refused or unauthenticated request", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    await call(w["/files"].GET, req("http://x/files?dir=/a"));
    await call(w["/desk"].POST, req("http://x/desk", { method: "POST", token: CLI_TOKEN }));
    expect(calls).toEqual([]);
  });
});

describe("applyRoutePolicy: path gate (D24)", () => {
  const post = (body: unknown, token = CLI_TOKEN) =>
    req("http://x/files", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("gates a query path for the CLI token and lets the handler run when it passes", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    const res = await call(w["/files"].GET, req("http://x/files?dir=%2Ftmp%2Fa%20b", { token: CLI_TOKEN }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ p: "/tmp/a b", caller: "cli", mode: "exists" }]);
  });

  it("refuses with the gate's status and body (and the cors headers) and does not run the handler", async () => {
    const w = wrapFake(makeOpts({ refuse: (p) => p === "/protected" }));
    const res = await call(w["/files"].GET, req("http://x/files?dir=/protected", { token: CLI_TOKEN }));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-cors")).toBe("1");
    expect(await res.json()).toEqual({ error: "blocked /protected", code: "path-not-accessible" });
  });

  it("gates body fields with their own modes, arrays element by element, and dedupes", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    const res = await call(
      w["/files"].POST,
      post({ path: "/p", paths: ["/a", "/b", "/a", 7, ""], dest: "/d/new", other: "/not-a-gated-field" }),
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.mode}:${c.p}`).sort()).toEqual([
      "exists:/a",
      "exists:/b",
      "exists:/p",
      "nearest-ancestor:/d/new",
    ]);
  });

  it("the handler still reads the body after the gate (the walker only reads a clone)", async () => {
    const seen: unknown[] = [];
    const routes = { "/files": { GET: ok("x"), POST: async (r: Request) => { seen.push(await r.json()); return new Response("ok"); } } };
    const w = applyRoutePolicy(routes, makeOpts({ policy: { "/files": FAKE_TABLE["/files"]! } }));
    const res = await call(w["/files"].POST, post({ path: "/p" }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ path: "/p" }]);
  });

  it("an unparseable or non-object body skips the gate and leaves the 400 to the handler", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    expect((await call(w["/files"].POST, post("{not json"))).status).toBe(200);
    expect((await call(w["/files"].POST, post("[1,2]"))).status).toBe(200);
    expect((await call(w["/files"].POST, post("null"))).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("does not gate the app caller", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls, refuse: () => true }));
    const res = await call(w["/files"].GET, req("http://x/files?dir=/protected", { token: API_TOKEN }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("skips absent and empty values", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    await call(w["/files"].GET, req("http://x/files", { token: CLI_TOKEN }));
    await call(w["/files"].GET, req("http://x/files?dir=", { token: CLI_TOKEN }));
    expect(calls).toEqual([]);
  });

  it("refuses an absurd number of paths instead of spawning a probe for each", async () => {
    const calls: GateCall[] = [];
    const w = wrapFake(makeOpts({ calls }));
    const paths = Array.from({ length: 300 }, (_, i) => `/p${i}`);
    const res = await call(w["/files"].POST, post({ paths }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("too-many-paths");
    expect(calls).toEqual([]);
  });

  it("fails closed when the gate throws", async () => {
    const w = wrapFake(makeOpts({ gate: async () => { throw new Error("probe died"); } }));
    const res = await call(w["/files"].GET, req("http://x/files?dir=/a", { token: CLI_TOKEN }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("path-check-failed");
  });

  it("stops at the first refusal among several paths", async () => {
    const w = wrapFake(makeOpts({ refuse: (p) => p === "/b" }));
    const res = await call(w["/files"].POST, post({ paths: ["/a", "/b", "/c"] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("blocked /b");
  });
});

describe("applyRoutePolicy: startup validation", () => {
  const expectThrows = (routes: unknown, table: typeof FAKE_TABLE, message: RegExp) => {
    expect(() => applyRoutePolicy(routes, makeOpts({ policy: table }))).toThrow(message);
  };

  it("throws when a route has no policy entry", () => {
    expectThrows({ ...fakeRoutes(), "/extra": ok("x") }, FAKE_TABLE, /route \/extra has no policy entry/);
  });

  it("throws when a policy entry has no route (unless every method is conditional)", () => {
    const { "/desk": _desk, ...withoutDesk } = fakeRoutes();
    expectThrows(withoutDesk, FAKE_TABLE, /policy entry \/desk has no route/);
    // /maybe is conditional: absent is fine, present is classified like any route.
    expect(() => applyRoutePolicy(fakeRoutes(), makeOpts())).not.toThrow();
    const withMaybe = { ...fakeRoutes(), "/maybe": { POST: ok("maybe") } };
    const w = applyRoutePolicy(withMaybe, makeOpts());
    expect(typeof w["/maybe"].POST).toBe("function");
  });

  it("throws when a per-method entry lists other methods than the route handles", () => {
    expectThrows(
      { ...fakeRoutes(), "/both": { GET: ok("g"), POST: ok("p"), DELETE: ok("d") } },
      FAKE_TABLE,
      /route \/both handles \[DELETE, GET, POST\] but its policy entry lists \[GET, POST\]/,
    );
    expectThrows(
      { ...fakeRoutes(), "/both": { GET: ok("g") } },
      FAKE_TABLE,
      /route \/both handles \[GET\] but its policy entry lists \[GET, POST\]/,
    );
  });

  it("throws when a function-valued route has a per-method entry, or the reverse", () => {
    expectThrows({ ...fakeRoutes(), "/both": ok("fn") }, FAKE_TABLE, /function-valued/);
    expectThrows({ ...fakeRoutes(), "/stream": { GET: ok("g") } }, FAKE_TABLE, /flat policy entry/);
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      applyRoutePolicy({ "/a": ok("a"), "/b": ok("b") }, makeOpts({ policy: { "/c": CLI_POLICY } }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("route /a has no policy entry");
    expect(message).toContain("route /b has no policy entry");
    expect(message).toContain("policy entry /c has no route");
  });
});

describe("applyRoutePolicy: the real table", () => {
  it("accepts a stand-in routes object with exactly the table's shape (and wraps every handler)", () => {
    const standIn: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      if (typeof (entry as RoutePolicy).callers === "string") standIn[key] = ok(key);
      else standIn[key] = Object.fromEntries(Object.keys(entry).map((m) => [m, ok(`${m} ${key}`)]));
    }
    const wrapped = applyRoutePolicy(standIn, {
      headless: false,
      cors: () => ({}),
      gate: async () => null,
      notAvailableHeadless: () => new Response(null, { status: 501 }),
    });
    expect(Object.keys(wrapped)).toEqual(Object.keys(standIn));
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      const value = wrapped[key];
      if (typeof (entry as RoutePolicy).callers === "string") expect(typeof value).toBe("function");
      else expect(Object.keys(value as object).sort()).toEqual(Object.keys(entry).sort());
    }
  });

  it("denies the CLI token on every desktop-only route in the real table", async () => {
    const standIn: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      if (typeof (entry as RoutePolicy).callers === "string") standIn[key] = ok(key);
      else standIn[key] = Object.fromEntries(Object.keys(entry).map((m) => [m, ok(`${m} ${key}`)]));
    }
    const mk = (headless: boolean) =>
      applyRoutePolicy(standIn, {
        headless,
        cors: () => ({}),
        gate: async () => null,
        notAvailableHeadless: () => new Response(null, { status: 501 }),
      });
    const onApp = mk(false);
    const onHeadless = mk(true);
    for (const line of DESKTOP_ONLY) {
      const [method, ...rest] = line.split(" ");
      const key = rest.join(" ");
      const url = `http://x${key.replace(/:\w+/g, "abc")}`;
      const send = (routes: typeof onApp, token: string) =>
        call((routes[key] as Record<string, unknown>)[method!], req(url, { method, token }));
      expect((await send(onApp, CLI_TOKEN)).status, `${line} on the app`).toBe(403);
      const headlessStatus = (await send(onHeadless, CLI_TOKEN)).status;
      expect(headlessStatus, `${line} headless`).toBe(HEADLESS_501.includes(line) ? 501 : 403);
      expect((await send(onApp, API_TOKEN)).status, `${line} master`).toBe(200);
    }
  });
});

// A CLI token may not smuggle the master through anything: sanity on the two
// constants the table's compares are built from.
describe("tokens", () => {
  it("the two tokens differ", () => {
    expect(CLI_TOKEN).not.toBe(API_TOKEN);
  });
});
