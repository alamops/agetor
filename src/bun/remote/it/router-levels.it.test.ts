// TS2, invariant 6: a device reaches no app route and nothing above its level. Every ROUTE_POLICY key and method, at every device level, through
// the real router into the REAL API server's served handlers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { levelAtLeast, REMOTE_LEVELS, type RemoteLevel } from "@agetor/remote-protocol/levels";
import { body, concretePath, pinDataDir, principal } from "./inproc.ts";

const DATA = pinDataDir("levels");
process.env.AGETOR_API_PORT = "4853";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const { startApiServer } = await import("../../server.ts");
const { ROUTE_POLICY } = await import("../../route-policy.ts");
const { createRouter } = await import("../router.ts");
const { createAudit } = await import("../audit.ts");
const { createDecisions } = await import("../decisions.ts");
const { createIdempotency } = await import("../idempotency.ts");
const { RateLimiter } = await import("../rate-limit.ts");
const { createLiveLookups } = await import("../router.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");

let server: { stop: () => void };
beforeAll(() => {
  server = startApiServer() as unknown as { stop: () => void };
});
afterAll(() => {
  server.stop();
  rmTestDataDir(DATA);
});

describe("invariant 6: deny by default, and a level ceiling", () => {
  test("inv6: every ROUTE_POLICY key and method at every level: not-remote when the route has no remote policy, level when the device is below it, and never either when it is at or above", async () => {
    let t = 1_800_000_000_000;
    const router = createRouter({
      limiter: new RateLimiter(() => t),
      idempotency: createIdempotency(),
      decisions: createDecisions(),
      audit: createAudit(),
      lookups: createLiveLookups(),
    });
    const problems: string[] = [];
    let checked = 0;
    let allowedChecks = 0;
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      const perMethod = "callers" in entry ? { GET: entry } : entry;
      for (const [method, policy] of Object.entries(perMethod)) {
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !policy) continue;
        // Routes that stream or never answer are not router routes (the router refuses them with its own code).
        if (key === "/events" || key === "/tasks/:id/events") continue;
        for (const level of REMOTE_LEVELS) {
          t += 2000; // a fresh second for the per-device buckets
          const res = await router.invoke(principal(level), {
            method: method as "GET", path: concretePath(key), query: method === "GET" ? "path=%2Ftmp%2Fx.png" : null, body: method === "GET" ? null : {},
            idem: method === "GET" ? null : "ab".repeat(16) as string, decision: null,
          });
          checked++;
          const code = (await body(res)).code as string | undefined;
          const remote = policy.callers === "app+cli" ? policy.remote : "none";
          if (remote === "none") {
            if (!(res.status === 403 && code === "not-remote")) problems.push(`${method} ${key} @${level}: expected 403 not-remote, got ${res.status} ${code}`);
          } else if (!levelAtLeast(level, remote.level)) {
            if (!(res.status === 403 && code === "level")) problems.push(`${method} ${key} @${level}: expected 403 level, got ${res.status} ${code}`);
          } else {
            allowedChecks++;
            if (code === "not-remote" || code === "level" && !(res.status === 403)) problems.push(`${method} ${key} @${level}: refused at or above its level (${res.status} ${code})`);
            if (code === "not-remote") problems.push(`${method} ${key} @${level}: said not-remote`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(400);
    expect(allowedChecks).toBeGreaterThan(20);
  }, 120_000);

  test("inv6: an app-only and a public route are never reachable from a device, whatever its level", async () => {
    const router = createRouter({ limiter: new RateLimiter(), idempotency: createIdempotency(), decisions: createDecisions(), audit: createAudit(), lookups: createLiveLookups() });
    for (const [method, path] of [["POST", "/window/focus"], ["GET", "/health"], ["POST", "/app/force-quit"], ["GET", "/info"], ["POST", "/tasks"], ["POST", "/daemon/shutdown"]] as const) {
      for (const level of ["observe", "configure"] as RemoteLevel[]) {
        const res = await router.invoke(principal(level), { method, path, query: null, body: method === "GET" ? null : {}, idem: method === "GET" ? null : "cd".repeat(16), decision: null });
        expect((await body(res)).code, `${method} ${path} @${level}`).toBe("not-remote");
      }
    }
  });

  test("inv6: the router's own table covers every route and method of the real table (a route added without thought is refused, not skipped)", async () => {
    const { everyRoute } = await import("../../route-policy.ts");
    const table = everyRoute();
    const keys = new Set(Object.keys(ROUTE_POLICY));
    expect(new Set(table.map((r) => r.route))).toEqual(keys);
    expect(table.filter((r) => r.policy !== "none").length).toBeGreaterThan(20);
  });
});
