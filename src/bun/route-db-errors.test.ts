/**
 * A route whose database call fails because the database worker crashed
 * answers 503, centrally, in the routes layer (`applyRoutePolicy`,
 * route-policy.ts; the owner decision in docs/plans/non-blocking-core.md §3
 * "Worker crash"):
 *
 *   DbRestartingError  → 503 {error: "database restarting", code: "db-restarting"}, Retry-After: 1
 *   DbUnavailableError → 503 {error: "database unavailable", code: "db-unavailable"}
 *
 * Two layers: the wrapper itself over a stand-in route table (every way a
 * handler can be reached), and the real server over a REAL database worker
 * thread that crashes on every request (`fixtures/db-worker-crash/worker.ts`),
 * so the error travels the production path: route → db-async → db-rpc →
 * worker crash → `DbRestartingError` → 503.
 *
 * Port 4643 is unique across src/ (grep before reusing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-route-db-errors-"));

const savedEnv = {
  AGETOR_DB_MODE: process.env.AGETOR_DB_MODE,
  AGETOR_CORE_WORKER_ENTRY: process.env.AGETOR_CORE_WORKER_ENTRY,
  AGETOR_API_PORT: process.env.AGETOR_API_PORT,
};

type RpcModule = typeof import("./db-rpc.ts");
type PolicyModule = typeof import("./route-policy.ts");
let rpcm: RpcModule;
let policy: PolicyModule;
let token: string;

beforeAll(async () => {
  rpcm = await import("./db-rpc.ts");
  policy = await import("./route-policy.ts");
  token = (await import("./api-config.ts")).API_TOKEN;
});

afterAll(async () => {
  await rpcm.getDbRpc().closeDb({ timeoutMs: 1000 }).catch(() => {});
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // The next file gets a fresh process-wide client from the restored env.
  rpcm.resetDbRpcForTests();
});

const APP_CLI = { callers: "app+cli" } as const;
const TABLE = {
  "/public": { callers: "public" },
  "/flat": APP_CLI,
  "/methods": { GET: APP_CLI, POST: APP_CLI },
} as const;

type Handler = (req: Request) => Response | Promise<Response>;

function wrap(handlers: { public: Handler; flat: Handler; get: Handler; post: Handler }) {
  const routes = {
    "/public": handlers.public,
    "/flat": handlers.flat,
    "/methods": { GET: handlers.get, POST: handlers.post },
  };
  return policy.applyRoutePolicy(routes, {
    headless: false,
    cors: () => ({ "x-cors": "1" }),
    gate: () => Promise.resolve(null),
    notAvailableHeadless: () => new Response(null, { status: 501 }),
    policy: TABLE as never,
  }) as unknown as { "/public": Handler; "/flat": Handler; "/methods": { GET: Handler; POST: Handler } };
}

const authed = (url: string, method = "GET") =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}` } });

describe("applyRoutePolicy maps database worker errors to 503", () => {
  test("DbRestartingError, thrown or rejected, on every kind of route → 503 db-restarting with Retry-After: 1", async () => {
    const restarting = () => new rpcm.DbRestartingError("worker exited");
    const w = wrap({
      public: () => { throw restarting(); },
      flat: () => Promise.reject(restarting()),
      get: async () => { throw restarting(); },
      post: () => { throw restarting(); },
    });
    const responses = [
      await w["/public"](new Request("http://x/public")),
      await w["/flat"](authed("http://x/flat")),
      await w["/methods"].GET(authed("http://x/methods")),
      await w["/methods"].POST(authed("http://x/methods", "POST")),
    ];
    expect(responses).toHaveLength(4);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(res.headers.get("x-cors")).toBe("1");
      expect(await res.json()).toEqual({ error: "database restarting", code: "db-restarting" });
    }
  });

  test("DbUnavailableError → 503 db-unavailable, no Retry-After", async () => {
    const w = wrap({
      public: () => { throw new rpcm.DbUnavailableError("db client is closed"); },
      flat: () => Promise.reject(new rpcm.DbUnavailableError("restarted too often")),
      get: () => new Response("ok"),
      post: () => new Response("ok"),
    });
    for (const res of [await w["/public"](new Request("http://x/public")), await w["/flat"](authed("http://x/flat"))]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(await res.json()).toEqual({ error: "database unavailable", code: "db-unavailable" });
    }
  });

  test("any other error propagates unchanged, and a refused caller never reaches the handler", async () => {
    const boom = new Error("boom");
    let reached = 0;
    const w = wrap({
      public: () => { throw boom; },
      flat: () => { reached++; throw new rpcm.DbRestartingError("x"); },
      get: () => new Response("ok"),
      post: () => new Response("ok"),
    });
    await expect(Promise.resolve().then(() => w["/public"](new Request("http://x/public")))).rejects.toBe(boom);
    const refused = await w["/flat"](new Request("http://x/flat"));
    expect(refused.status).toBe(401);
    expect(reached).toBe(0);
    // A plain success is untouched.
    expect(await (await w["/methods"].GET(authed("http://x/methods"))).text()).toBe("ok");
  });

  test("isDbWorkerError matches the two db-rpc classes only", () => {
    expect(policy.isDbWorkerError(new rpcm.DbRestartingError("x"))).toBe(true);
    expect(policy.isDbWorkerError(new rpcm.DbUnavailableError("x"))).toBe(true);
    expect(policy.isDbWorkerError(new Error("database worker restarting"))).toBe(false);
    expect(policy.isDbWorkerError({ name: "DbRestartingError" })).toBe(false);
    expect(policy.isDbWorkerError(null)).toBe(false);
  });
});

describe("the real server over a crashing database worker", () => {
  test("GET /tasks/:id answers 503 db-restarting (Retry-After: 1), then db-unavailable once restarts are spent; /health keeps answering", async () => {
    process.env.AGETOR_API_PORT = "4643";
    const { startApiServer } = await import("./server.ts");
    const server = startApiServer() as unknown as { stop: (force?: boolean) => void };
    try {
      // The process-wide client now runs the crashing worker: every request
      // it posts kills the worker thread.
      process.env.AGETOR_DB_MODE = "worker";
      process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "fixtures", "db-worker-crash", "worker.ts");
      await rpcm.getDbRpc().closeDb({ timeoutMs: 1000 }).catch(() => {});
      rpcm.resetDbRpcForTests();
      expect(rpcm.getDbRpc().mode).toBe("worker");
      await rpcm.dbReady();

      const base = "http://127.0.0.1:4643";
      const get = () => fetch(`${base}/tasks/some-task`, { headers: { authorization: `Bearer ${token}` } });

      const first = await get();
      expect(first.status).toBe(503);
      expect(first.headers.get("retry-after")).toBe("1");
      expect(await first.json()).toEqual({ error: "database restarting", code: "db-restarting" });

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);

      // Each crash restarts the worker, at most 5 times a minute (db-rpc.ts);
      // after that the client stops restarting and answers unavailable.
      const codes: string[] = [];
      for (let i = 0; i < 10 && codes.at(-1) !== "db-unavailable"; i++) {
        const res = await get();
        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string };
        codes.push(body.code);
        expect(res.headers.get("retry-after")).toBe(body.code === "db-restarting" ? "1" : null);
      }
      expect(codes.at(-1)).toBe("db-unavailable");
      expect(codes.slice(0, -1).every((c) => c === "db-restarting")).toBe(true);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
