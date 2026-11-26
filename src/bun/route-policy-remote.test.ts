// Remote levels in ROUTE_POLICY (docs/plans/remote-readiness.md RP): the pinned v1 set, the startup checks, the device branch of the
// walker against synthetic tables and the real wrapped handlers, and invariant 7 (a device caller only from the private mark).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMOTE_LEVELS, type RemoteLevel } from "@agetor/remote-protocol/levels";
import { API_TOKEN, CLI_TOKEN } from "./api-config.ts";
import {
  ROUTE_POLICY,
  allRemoteRoutes,
  applyRoutePolicy,
  callerOf,
  deviceOf,
  markDeviceRequest,
  remotePolicyFor,
  remotePolicyProblem,
  remoteRoutesFor,
  resolveCaller,
  type RoutePolicy,
} from "./route-policy.ts";
import type { DevicePrincipal } from "./remote/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-route-policy-remote-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "5413";

function principal(level: RemoteLevel): DevicePrincipal {
  return { kind: "device", deviceId: "ab".repeat(16), deviceName: "Ana's iPhone", level, sessionId: "s1", sessionHash: new Uint8Array(32), approvePub: new Uint8Array(65) };
}

/** The exact v1 remote set: METHOD route → level / step-up / rate. Opening, closing or changing a route changes this list, so it shows up in review. */
const V1_SET = [
  "DELETE /tasks/:id/backlog/:itemId → respond/none/normal",
  "DELETE /tasks/:id/seen → respond/none/normal",
  "GET /interactions/pending → observe/none/normal",
  "GET /tasks → observe/none/normal",
  "GET /tasks/:id → observe/none/normal",
  "GET /tasks/:id/events/:eventId → observe/none/heavy",
  "GET /tasks/:id/events/page → observe/none/heavy",
  "GET /tasks/:id/files/preview → observe/none/heavy",
  "GET /tasks/:id/git-status → observe/none/heavy",
  "GET /tasks/:id/interactions/pending → observe/none/normal",
  "GET /tasks/:id/messages/history → observe/none/normal",
  "GET /tasks/:id/pipeline → observe/none/normal",
  "GET /tasks/:id/runs → observe/none/normal",
  "GET /tasks/:id/subagents → observe/none/normal",
  "PATCH /tasks/:id/backlog/:itemId → respond/unlock/normal",
  "PATCH /tasks/:id/plans/:planId → respond/signed/normal",
  "POST /ask-questions/:id/answer → respond/unlock/normal",
  "POST /fx-permissions/:id/answer → respond/signed/normal",
  "POST /runs/:id/cancel → respond/none/stop",
  "POST /runs/:id/input → respond/unlock/normal",
  "POST /tasks/:id/backlog → respond/unlock/normal",
  "POST /tasks/:id/fx-resume → respond/signed/normal",
  "POST /tasks/:id/pipeline/cancel → respond/none/stop",
  "POST /tasks/:id/pipeline/review → respond/signed/normal",
  "POST /tasks/:id/plans/:planId/approve → respond/signed/normal",
  "POST /tasks/:id/seen → respond/none/normal",
  "POST /tasks/:id/switch-account → operate/none/normal",
  "POST /tmux-prompts/:id/answer → respond/signed/normal",
  "PUT /tasks/:id/backlog → respond/unlock/normal",
].sort();

describe("the pinned v1 remote set", () => {
  test("the routes a phone may call, and at which level, are exactly the plan's table", () => {
    const got = allRemoteRoutes().map((r) => `${r.method} ${r.route} → ${r.policy.level}/${r.policy.stepUp}/${r.policy.rate}`).sort();
    expect(got).toEqual(V1_SET);
  });

  test("every remote policy is at protocol version 1 on an app+cli route; everything else is none", () => {
    let remoteCount = 0;
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      const each = "callers" in entry ? [entry as RoutePolicy] : Object.values(entry).filter((x): x is RoutePolicy => !!x);
      for (const p of each) {
        if (p.remote === "none") continue;
        remoteCount++;
        expect(p.callers, key).toBe("app+cli");
        expect(p.remote.since).toBe(1);
        expect(remotePolicyProblem(p.remote)).toBeNull();
      }
    }
    expect(remoteCount).toBe(V1_SET.length);
  });

  test("no route that adds a device, turns remote access on or changes a level is remote (D19)", () => {
    for (const r of allRemoteRoutes()) {
      expect(r.route).not.toMatch(/remote-access|pair|devices|presence/);
    }
  });

  test("remoteRoutesFor(level) returns the routes at or below the level, in a stable order", () => {
    const counts = REMOTE_LEVELS.map((l) => remoteRoutesFor(l).length);
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
    expect(counts[2]).toBe(counts[3]!); // v1 opens no configure route (the terminal is a session op)
    expect(remoteRoutesFor("observe").every((r) => r.policy.level === "observe")).toBe(true);
    expect(remoteRoutesFor("operate").some((r) => r.route === "/tasks/:id/switch-account")).toBe(true);
    expect(remoteRoutesFor("respond").some((r) => r.route === "/tasks/:id/switch-account")).toBe(false);
    expect(remoteRoutesFor("respond").map((r) => `${r.method} ${r.route}`)).toEqual(remoteRoutesFor("respond").map((r) => `${r.method} ${r.route}`).slice().sort((a, b) => {
      const [am, ar] = a.split(" ") as [string, string];
      const [bm, br] = b.split(" ") as [string, string];
      return ar === br ? am.localeCompare(bm) : ar < br ? -1 : 1;
    }));
  });

  test("remotePolicyFor answers by route and method, and none for the rest", () => {
    expect(remotePolicyFor("GET", "/tasks")).toMatchObject({ level: "observe" });
    expect(remotePolicyFor("POST", "/tasks")).toBe("none");
    expect(remotePolicyFor("DELETE", "/tasks/:id/switch-account")).toBe("none");
    expect(remotePolicyFor("GET", "/files/preview")).toBe("none");
    expect(remotePolicyFor("GET", "/nope")).toBe("none");
  });
});

describe("startup checks", () => {
  const ok = { level: "respond", stepUp: "none", rate: "normal", since: 1 } as const;
  const opts = (policy: Record<string, unknown>) => ({
    policy: policy as never,
    cors: () => ({}),
    headless: false,
    notAvailableHeadless: () => new Response(null, { status: 501 }),
    gate: async () => null,
  });
  const routes = { "/x": () => new Response("x") };

  test("a remote policy on an app or public route stops the server from starting", () => {
    expect(() => applyRoutePolicy(routes, opts({ "/x": { callers: "app", remote: ok } }))).toThrow("not an app+cli route");
    expect(() => applyRoutePolicy(routes, opts({ "/x": { callers: "public", remote: ok } }))).toThrow("not an app+cli route");
    expect(() => applyRoutePolicy(routes, opts({ "/x": { callers: "app+cli", remote: ok } }))).not.toThrow();
  });

  test("a remote policy missing its level, step-up, rate or since is refused", () => {
    for (const bad of [
      { stepUp: "none", rate: "normal", since: 1 },
      { level: "respond", rate: "normal", since: 1 },
      { level: "respond", stepUp: "none", since: 1 },
      { level: "respond", stepUp: "none", rate: "normal" },
      { level: "full", stepUp: "none", rate: "normal", since: 1 },
      { level: "respond", stepUp: "pin", rate: "normal", since: 1 },
      { level: "respond", stepUp: "none", rate: "fast", since: 1 },
      { level: "respond", stepUp: "none", rate: "normal", since: 2 },
    ]) {
      expect(() => applyRoutePolicy(routes, opts({ "/x": { callers: "app+cli", remote: bad } }))).toThrow(/remote\./);
    }
  });

  test("the per-method form is checked method by method", () => {
    const perMethod = { "/x": { GET: () => new Response("x"), POST: () => new Response("x") } };
    expect(() =>
      applyRoutePolicy(perMethod, opts({ "/x": { GET: { callers: "app+cli", remote: ok }, POST: { callers: "app", remote: ok } } })),
    ).toThrow("POST /x has a remote policy but is not an app+cli route");
  });
});

describe("the device branch of the walker (synthetic table)", () => {
  const seen: Array<{ caller: ReturnType<typeof callerOf>; gated: string[] }> = [];
  const table: Record<string, unknown> = {
    "/app": { callers: "app", remote: "none" },
    "/public": { callers: "public", remote: "none" },
    "/none": { callers: "app+cli", remote: "none" },
    "/respond": { callers: "app+cli", remote: { level: "respond", stepUp: "none", rate: "normal", since: 1 } },
    "/paths": {
      callers: "app+cli",
      remote: { level: "observe", stepUp: "none", rate: "normal", since: 1 },
      pathParams: [{ in: "query", name: "path", mode: "exists" }],
    },
  };
  const gated: string[] = [];
  const handler = (req: Request) => {
    seen.push({ caller: callerOf(req), gated: [...gated] });
    return new Response("ran");
  };
  const wrapped = applyRoutePolicy(
    { "/app": handler, "/public": handler, "/none": handler, "/respond": handler, "/paths": handler } as Record<string, (req: Request) => Response>,
    {
      policy: table as never,
      cors: () => ({}),
      headless: false,
      notAvailableHeadless: () => new Response(null, { status: 501 }),
      gate: async (p, caller) => {
        gated.push(`${caller}:${p}`);
        return p.includes("protected") ? { status: 403, error: "no", code: "path-not-accessible" } : null;
      },
    },
  ) as unknown as Record<string, (req: Request) => Promise<Response>>;
  const call = (route: string, level: RemoteLevel, url = `http://127.0.0.1${route}`, headers: Record<string, string> = {}) => {
    const req = new Request(url, { headers });
    markDeviceRequest(req, principal(level));
    return wrapped[route]!(req);
  };

  test("(a) an app route is not remote, and neither is a public one", async () => {
    for (const route of ["/app", "/public"]) {
      const res = await call(route, "configure");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("not-remote");
    }
  });

  test("(b) a route with remote none is refused at every level", async () => {
    for (const level of REMOTE_LEVELS) expect((await call("/none", level)).status).toBe(403);
  });

  test("(c) a device below the route's level is refused with 403 level; at or above it runs", async () => {
    const low = await call("/respond", "observe");
    expect(low.status).toBe(403);
    expect(await low.json()).toMatchObject({ code: "level", required: "respond", level: "observe" });
    for (const level of ["respond", "operate", "configure"] as const) expect((await call("/respond", level)).status).toBe(200);
  });

  test("(d) a pathParams route runs the path gate with the device caller, and a refusal stops the handler", async () => {
    const before = seen.length;
    gated.length = 0;
    expect((await call("/paths", "observe", "http://127.0.0.1/paths?path=/Users/me/project")).status).toBe(200);
    expect(gated).toEqual(["device:/Users/me/project"]);
    const refused = await call("/paths", "observe", "http://127.0.0.1/paths?path=/protected/dir");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("path-not-accessible");
    expect(seen.length).toBe(before + 1);
  });

  test("(e) an allowed route runs the handler, and callerOf is device", async () => {
    seen.length = 0;
    gated.length = 0;
    expect((await call("/respond", "respond")).status).toBe(200);
    expect(seen).toEqual([{ caller: "device", gated: [] }]);
  });

  test("an unmarked request with a device-looking header never becomes a device", async () => {
    seen.length = 0;
    const res = await wrapped["/respond"]!(new Request("http://127.0.0.1/respond", { headers: { "x-agetor-device": "1", authorization: "Device abc" } }));
    expect(res.status).toBe(401);
    expect(seen.length).toBe(0);
  });
});

describe("invariant 7: a device caller exists only from the private mark", () => {
  const policy: RoutePolicy = { callers: "app+cli", remote: "none", legacyQueryToken: true };

  test("no header name or value, query token or bearer produces device (fuzz)", () => {
    const names = ["authorization", "x-agetor-device", "x-device", "x-remote", "x-forwarded-for", "cookie", "x-agetor-caller", "x-caller", "proxy-authorization"];
    const values = ["device", "Device", "Bearer device", "Bearer ", "Bearer", `Bearer ${API_TOKEN}x`, `Bearer x${CLI_TOKEN}`, "1", "true", "a".repeat(5000), "Bearer " + "9".repeat(64)];
    for (let i = 0; i < 2000; i++) {
      const headers: Record<string, string> = {};
      for (let j = 0; j < 1 + (i % 4); j++) headers[names[(i * 7 + j * 3) % names.length]!] = values[(i * 5 + j) % values.length]!;
      const url = `http://127.0.0.1/x?token=${encodeURIComponent(values[i % values.length]!)}&caller=device`;
      const caller = resolveCaller(new Request(url, { headers }), policy);
      expect(caller === null || caller === "app" || caller === "cli").toBe(true);
      expect(caller).not.toBe("device");
    }
  });

  test("the mark does not survive a clone or a copy", () => {
    const req = new Request("http://127.0.0.1/x");
    markDeviceRequest(req, principal("respond"));
    expect(deviceOf(req)?.deviceId).toBe("ab".repeat(16));
    expect(deviceOf(req.clone())).toBeNull();
    expect(deviceOf(new Request(req))).toBeNull();
    expect(deviceOf(new Request("http://127.0.0.1/x"))).toBeNull();
  });

  test("only remote/router.ts (and this test) imports markDeviceRequest", () => {
    const root = path.resolve(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === "node_modules") continue;
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((f) => /markDeviceRequest/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f))
      .sort();
    // route-policy.ts defines it and this file tests it; the router is the one production caller (it lands with RT).
    const allowed = new Set(["bun/route-policy.ts", "bun/route-policy-remote.test.ts", "bun/remote/router.ts"]);
    expect(importers.filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe("the device branch against the real wrapped handlers", () => {
  let server: { stop: () => void };
  let routes: Record<string, unknown>;
  beforeAll(async () => {
    const srv = await import("./server.ts");
    server = srv.startApiServer() as unknown as { stop: () => void };
    routes = (await import("./route-table.ts")).servedRoutes() as Record<string, unknown>;
  });
  afterAll(() => {
    server?.stop?.();
    rmTestDataDir(DATA_DIR);
  });

  const call = async (method: string, route: string, level: RemoteLevel, params: Record<string, string> = {}, url = `http://127.0.0.1${route}`) => {
    const req = new Request(url, { method });
    (req as unknown as { params: Record<string, string> }).params = params;
    markDeviceRequest(req, principal(level));
    const entry = routes[route] as Record<string, (r: Request) => Promise<Response>> | ((r: Request) => Promise<Response>);
    const fn = typeof entry === "function" ? entry : entry[method]!;
    return fn(req);
  };

  test("an app route and a remote-none route are refused with not-remote, whatever the level", async () => {
    for (const [method, route] of [["POST", "/background"], ["GET", "/files/preview"], ["POST", "/open-path"], ["GET", "/projects"], ["POST", "/tasks"], ["PUT", "/preferences/:key"]] as const) {
      const res = await call(method, route, "configure");
      expect(res.status, `${method} ${route}`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("not-remote");
    }
  });

  test("a respond route is refused for an observe device and not for a respond device", async () => {
    const low = await call("POST", "/runs/:id/cancel", "observe", { id: "nope" });
    expect(low.status).toBe(403);
    expect(((await low.json()) as { code: string }).code).toBe("level");
    const ok = await call("POST", "/runs/:id/cancel", "respond", { id: "nope" });
    expect(ok.status).not.toBe(403);
  });

  test("an observe route answers an observe device", async () => {
    const res = await call("GET", "/tasks", "observe", {}, "http://127.0.0.1/tasks?delta=1");
    expect(res.status).toBe(200);
  });

  test("the CLI token's desktop-only 403 is not what a device sees", async () => {
    const res = await call("POST", "/background", "configure");
    expect(((await res.json()) as { code: string }).code).toBe("not-remote");
  });
});
