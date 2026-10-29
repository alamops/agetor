import { describe, expect, test } from "bun:test";
import {
  TAKEOVER_PORT_FREE_TIMEOUT_MS,
  TAKEOVER_RETRY_INTERVAL_MS,
  TAKEOVER_RETRY_WINDOW_MS,
  acquireApiPort,
  type AcquireApiPortDeps,
} from "./app-takeover.ts";
import type { CoreCreds } from "./core-creds.ts";

// Every effect is a fake and time is virtual (`sleep` advances `now`), so the
// 5 s retry window runs instantly and no port is ever bound.

const PORT = 54317;

function creds(over: Partial<CoreCreds> = {}): CoreCreds {
  return {
    port: PORT,
    token: "cli-token-abc",
    pid: 4242,
    kind: "cli-daemon",
    version: "0.0.0-test",
    startedAt: 1,
    ...over,
  };
}

interface Harness {
  deps: AcquireApiPortDeps<string>;
  calls: {
    starts: number;
    reads: number;
    probes: number;
    sleeps: number[];
    fetches: Array<{ url: string; init: RequestInit }>;
    freeWaits: Array<{ port: number; timeoutMs: number }>;
  };
  clock: { t: number };
}

/** `holdsPortUntil(n)`: the nth `start()` call (1-based) is the first to succeed. */
function harness(opts: {
  startSucceedsOnAttempt?: number;
  readCreds?: (reads: number) => CoreCreds | null;
  probe?: (c: CoreCreds) => boolean | Promise<boolean>;
  fetchImpl?: () => Promise<Response>;
  waitForPortFree?: () => boolean;
}): Harness {
  const clock = { t: 1_000_000 };
  const calls: Harness["calls"] = {
    starts: 0,
    reads: 0,
    probes: 0,
    sleeps: [],
    fetches: [],
    freeWaits: [],
  };
  const deps: AcquireApiPortDeps<string> = {
    start: () => {
      calls.starts++;
      if (opts.startSucceedsOnAttempt !== undefined && calls.starts >= opts.startSucceedsOnAttempt) {
        return `server-${calls.starts}`;
      }
      // A distinct error per attempt, so a test can tell which one was thrown.
      throw new Error(`EADDRINUSE attempt ${calls.starts}`);
    },
    readCreds: () => {
      calls.reads++;
      return opts.readCreds ? opts.readCreds(calls.reads) : null;
    },
    probe: async (c) => {
      calls.probes++;
      return opts.probe ? opts.probe(c) : true;
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.fetches.push({ url: String(url), init: init ?? {} });
      return opts.fetchImpl ? opts.fetchImpl() : new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
    waitForPortFree: async (port, timeoutMs) => {
      calls.freeWaits.push({ port, timeoutMs });
      return opts.waitForPortFree ? opts.waitForPortFree() : true;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls, clock };
}

describe("acquireApiPort", () => {
  test("a free port binds at once: no creds read, no request", async () => {
    const h = harness({ startSucceedsOnAttempt: 1 });
    expect(await acquireApiPort(h.deps)).toBe("server-1");
    expect(h.calls.starts).toBe(1);
    expect(h.calls.reads).toBe(0);
    expect(h.calls.fetches).toHaveLength(0);
    expect(h.calls.sleeps).toHaveLength(0);
  });

  test("a live cli-daemon is asked to hand off (Bearer, JSON, mode=handoff), then the port is bound", async () => {
    // First start fails (daemon holds it); the post-handoff start succeeds.
    const h = harness({ startSucceedsOnAttempt: 2, readCreds: () => creds() });
    expect(await acquireApiPort(h.deps)).toBe("server-2");

    expect(h.calls.fetches).toHaveLength(1);
    const { url, init } = h.calls.fetches[0]!;
    expect(url).toBe(`http://127.0.0.1:${PORT}/daemon/shutdown`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cli-token-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ mode: "handoff" });

    // The bind happens only after the port was reported free.
    expect(h.calls.freeWaits).toEqual([{ port: PORT, timeoutMs: TAKEOVER_PORT_FREE_TIMEOUT_MS }]);
    expect(h.calls.starts).toBe(2);
    expect(h.calls.sleeps).toHaveLength(0);
  });

  test("a login-item core (cli-daemon, launchedBy login-item) takes the same handoff path", async () => {
    const h = harness({
      startSucceedsOnAttempt: 2,
      readCreds: () => creds({ launchedBy: "login-item", token: "login-item-token" }),
    });
    expect(await acquireApiPort(h.deps)).toBe("server-2");
    expect(h.calls.fetches).toHaveLength(1);
    expect((h.calls.fetches[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer login-item-token",
    );
    expect(JSON.parse(String(h.calls.fetches[0]!.init.body))).toEqual({ mode: "handoff" });
  });

  test("the handoff request failing (daemon drops the connection) still proceeds to bind", async () => {
    const h = harness({
      startSucceedsOnAttempt: 2,
      readCreds: () => creds(),
      fetchImpl: () => Promise.reject(new Error("socket hang up")),
    });
    expect(await acquireApiPort(h.deps)).toBe("server-2");
    expect(h.calls.freeWaits).toHaveLength(1);
  });

  test("port held with no creds: retries every 250 ms and succeeds when the port frees mid-way", async () => {
    // Held for attempts 1..4, free on the 5th.
    const h = harness({ startSucceedsOnAttempt: 5, readCreds: () => null });
    expect(await acquireApiPort(h.deps)).toBe("server-5");
    expect(h.calls.starts).toBe(5);
    expect(h.calls.sleeps).toEqual([250, 250, 250, 250]);
    expect(h.calls.sleeps.every((ms) => ms === TAKEOVER_RETRY_INTERVAL_MS)).toBe(true);
    expect(h.calls.fetches).toHaveLength(0);
  });

  test("creds appearing mid-way switch to the handoff path", async () => {
    // Creds absent for the first 3 reads (a daemon between bind and creds write),
    // then present. The port stays held until the handoff completes: starts 1-4
    // fail (initial + 3 retries), the post-handoff start (5th) succeeds.
    const h = harness({
      startSucceedsOnAttempt: 5,
      readCreds: (reads) => (reads >= 4 ? creds() : null),
    });
    expect(await acquireApiPort(h.deps)).toBe("server-5");
    expect(h.calls.sleeps).toEqual([250, 250, 250]);
    expect(h.calls.fetches).toHaveLength(1);
    expect(h.calls.freeWaits).toHaveLength(1);
  });

  test("a foreign holder: retries for 5 s, then throws the ORIGINAL bind error", async () => {
    const h = harness({ readCreds: () => null }); // never frees
    let thrown: unknown;
    try {
      await acquireApiPort(h.deps);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe("EADDRINUSE attempt 1");

    const retries = TAKEOVER_RETRY_WINDOW_MS / TAKEOVER_RETRY_INTERVAL_MS; // 20
    expect(h.calls.sleeps).toHaveLength(retries);
    expect(h.calls.starts).toBe(retries + 1); // the initial bind plus one per sleep
    expect(h.clock.t - 1_000_000).toBe(TAKEOVER_RETRY_WINDOW_MS);
    expect(h.calls.fetches).toHaveLength(0);
  });

  test("stale creds (probe says not live, or probe throws) are treated as a foreign holder", async () => {
    const dead = harness({ readCreds: () => creds(), probe: () => false });
    await expect(acquireApiPort(dead.deps)).rejects.toThrow("EADDRINUSE attempt 1");
    expect(dead.calls.fetches).toHaveLength(0);
    expect(dead.calls.sleeps).toHaveLength(20);

    const throwing = harness({
      readCreds: () => creds(),
      probe: () => {
        throw new Error("probe blew up");
      },
    });
    await expect(acquireApiPort(throwing.deps)).rejects.toThrow("EADDRINUSE attempt 1");
    expect(throwing.calls.fetches).toHaveLength(0);
  });

  test("a live app owner is never evicted: throws immediately, no request, no retry", async () => {
    const h = harness({ readCreds: () => creds({ kind: "app" }) });
    await expect(acquireApiPort(h.deps)).rejects.toThrow("EADDRINUSE attempt 1");
    expect(h.calls.fetches).toHaveLength(0);
    expect(h.calls.freeWaits).toHaveLength(0);
    expect(h.calls.sleeps).toHaveLength(0);
    expect(h.calls.starts).toBe(1);
  });

  test("the port never freeing after the handoff throws the original error without a second bind", async () => {
    const h = harness({ readCreds: () => creds(), waitForPortFree: () => false });
    await expect(acquireApiPort(h.deps)).rejects.toThrow("EADDRINUSE attempt 1");
    expect(h.calls.fetches).toHaveLength(1);
    expect(h.calls.freeWaits).toHaveLength(1);
    expect(h.calls.starts).toBe(1);
  });

  test("losing the freed port to another process reports the original bind error", async () => {
    // The port reports free, but the bind that follows still fails.
    const h = harness({ readCreds: () => creds(), waitForPortFree: () => true });
    await expect(acquireApiPort(h.deps)).rejects.toThrow("EADDRINUSE attempt 1");
    expect(h.calls.starts).toBe(2);
  });
});
