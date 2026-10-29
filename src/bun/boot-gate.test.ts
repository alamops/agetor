import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootReadySignal, gateRoutesUntilReady } from "./boot-gate.ts";

// The boot gate (boot-gate.ts): a core binds the API port BEFORE its boot
// restore, and every route but the ownership probes waits until the restore is
// done. These pin the wrapper itself and the real server wiring.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-boot-gate-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const PORT = 4613;
process.env.AGETOR_API_PORT = String(PORT);

/** Resolves with "pending" if `p` hasn't settled after a few event-loop turns. */
async function settledWithin<T>(p: Promise<T>, ms = 50): Promise<T | "pending"> {
  return Promise.race([p, Bun.sleep(ms).then(() => "pending" as const)]);
}

describe("gateRoutesUntilReady", () => {
  test("holds function and per-method handlers until ready, passes exempt paths and static responses", async () => {
    const calls: string[] = [];
    const staticRes = new Response("static");
    const { ready, markReady } = bootReadySignal();
    const routes = gateRoutesUntilReady(
      {
        "/fn": () => {
          calls.push("fn");
          return "fn-ok";
        },
        "/per-method": {
          GET: () => {
            calls.push("get");
            return "get-ok";
          },
        },
        "/health": () => {
          calls.push("health");
          return "health-ok";
        },
        "/static": staticRes,
      },
      ready,
      ["/health"],
    ) as unknown as Record<string, unknown>;

    const fn = (routes["/fn"] as (r: never, s: never) => unknown)(undefined as never, undefined as never);
    const get = ((routes["/per-method"] as Record<string, unknown>).GET as (r: never, s: never) => unknown)(
      undefined as never,
      undefined as never,
    );
    expect((routes["/health"] as () => unknown)()).toBe("health-ok");
    expect(routes["/static"]).toBe(staticRes);
    expect(await settledWithin(fn as Promise<unknown>)).toBe("pending");
    expect(await settledWithin(get as Promise<unknown>)).toBe("pending");
    expect(calls).toEqual(["health"]);

    markReady();
    expect(await fn).toBe("fn-ok");
    expect(await get).toBe("get-ok");
    expect(calls).toEqual(["health", "fn", "get"]);

    // Once ready, a wrapped handler calls straight through (no promise).
    expect((routes["/fn"] as (r: never, s: never) => unknown)(undefined as never, undefined as never)).toBe("fn-ok");
  });

  test("no ready promise returns the routes untouched", () => {
    const routes = { "/a": () => 1 };
    expect(gateRoutesUntilReady(routes, undefined, [])).toBe(routes);
  });
});

describe("startApiServer with a ready signal (headless)", () => {
  let server: { stop: (force?: boolean) => void } | null = null;
  let token = "";
  let markReady: () => void = () => {};
  const shutdowns: string[] = [];

  beforeAll(async () => {
    await import("./db.ts");
    const { startApiServer, API_TOKEN } = await import("./server.ts");
    const signal = bootReadySignal();
    markReady = signal.markReady;
    server = startApiServer({
      ready: signal.ready,
      onShutdownRequest: (mode) => shutdowns.push(mode),
    }) as unknown as { stop: (force?: boolean) => void };
    token = API_TOKEN;
  });

  afterAll(() => server?.stop(true));

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const u = (p: string) => `http://127.0.0.1:${PORT}${p}`;

  test("ownership probes and /daemon/shutdown answer mid-restore; everything else waits for ready", async () => {
    // probeLiveCore's two calls must answer, or a booting owner reads as dead.
    expect((await fetch(u("/health"))).status).toBe(200);
    expect((await fetch(u("/info"), { headers: auth() })).status).toBe(200);

    const tasksReq = fetch(u("/tasks"), { headers: auth() });
    expect(await settledWithin(tasksReq, 300)).toBe("pending");

    // The app can take the port from a core that is still booting.
    const shutdown = await fetch(u("/daemon/shutdown"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ mode: "handoff" }),
    });
    expect(shutdown.status).toBe(200);
    await Bun.sleep(20); // the route defers the callback with setTimeout(0)
    expect(shutdowns).toEqual(["handoff"]);

    markReady();
    const res = await tasksReq;
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("POST /notifications on a headless core with a notification sink", () => {
  const SINK_PORT = 4614;
  let server: { stop: (force?: boolean) => void } | null = null;
  let token = "";
  const posted: Array<{ title: string; taskId?: string }> = [];

  beforeAll(async () => {
    const { startApiServer, API_TOKEN } = await import("./server.ts");
    const prev = process.env.AGETOR_API_PORT;
    process.env.AGETOR_API_PORT = String(SINK_PORT);
    try {
      server = startApiServer({
        notifications: { post: (n) => posted.push({ title: n.title, taskId: n.taskId }), remove: () => {} },
      }) as unknown as { stop: (force?: boolean) => void };
    } finally {
      process.env.AGETOR_API_PORT = prev;
    }
    token = API_TOKEN;
  });

  afterAll(() => server?.stop(true));

  test("posts through the sink instead of answering 501 (agetor logs --notify reaches the background core)", async () => {
    const res = await fetch(`http://127.0.0.1:${SINK_PORT}/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Waiting on you", taskId: "t-1" }),
    });
    expect(res.status).toBe(200);
    expect(posted).toEqual([{ title: "Waiting on you", taskId: "t-1" }]);
  });
});
