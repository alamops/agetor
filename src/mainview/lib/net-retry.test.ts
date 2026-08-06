import { describe, expect, test } from "bun:test";
import { fetchWithRecovery, type NetRetryDeps } from "./net-retry.ts";

type Call = { url: string; init?: RequestInit };
type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/** Builds a scripted fetchImpl: the Nth call is served by handlers[N],
 *  recording every call's url + init for later assertions. */
function makeFetch(handlers: Handler[]) {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    const handler = handlers[n++];
    if (!handler) {
      throw new Error(`unexpected call #${n} to ${urlStr}`);
    }
    return handler(urlStr, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (body = "ok") => new Response(body, { status: 200 });
const serverError = (status = 500) => new Response("boom", { status });

const BASE = "http://127.0.0.1:4317";
const PATH = "/tasks";

function deps(fetchImpl: typeof fetch, healthTimeoutMs?: number): NetRetryDeps {
  return { fetchImpl, base: BASE, healthTimeoutMs };
}

describe("fetchWithRecovery", () => {
  test("happy path: first fetch resolves, no probe, no retry", async () => {
    const { fetchImpl, calls } = makeFetch([async () => ok("first")]);
    const res = await fetchWithRecovery(deps(fetchImpl), PATH);
    expect(await res.text()).toBe("first");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}${PATH}`);
  });

  test("transient recovery: rejection + healthy probe re-issues original once", async () => {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    };
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => ok(), // health probe
      async () => ok("retried"), // original request, retried
    ]);

    const res = await fetchWithRecovery(deps(fetchImpl), PATH, init);

    expect(await res.text()).toBe("retried");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(`${BASE}${PATH}`);
    expect(calls[1]!.url).toBe(`${BASE}/health`);
    expect(calls[2]!.url).toBe(`${BASE}${PATH}`);
    // retry must re-issue the exact same method/headers/body as the original
    expect(calls[2]!.init?.method).toBe(calls[0]!.init?.method);
    expect(calls[2]!.init?.headers).toEqual(calls[0]!.init?.headers);
    expect(calls[2]!.init?.body).toBe(calls[0]!.init?.body);
    expect(calls[2]!.init).toBe(calls[0]!.init);
  });

  test("server down (probe rejects): throws unreachable error mentioning the path", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => {
        throw new Error("ECONNREFUSED");
      }, // health probe rejects
    ]);

    await expect(fetchWithRecovery(deps(fetchImpl), PATH)).rejects.toThrow(
      /cannot reach agetor API/,
    );
    // re-run to inspect message content precisely (fresh fetch script)
    const { fetchImpl: fetchImpl2 } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    try {
      await fetchWithRecovery(deps(fetchImpl2), PATH);
      throw new Error("expected fetchWithRecovery to throw");
    } catch (e) {
      expect((e as Error).message).toContain("cannot reach agetor API");
      expect((e as Error).message).toContain(PATH);
      expect((e as Error).message).toContain(BASE);
    }
    expect(calls).toHaveLength(2);
  });

  test("server down (probe resolves non-ok): treated the same as a failed probe", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => serverError(503), // health probe responds, but not ok
    ]);

    await expect(fetchWithRecovery(deps(fetchImpl), PATH)).rejects.toThrow(
      /cannot reach agetor API/,
    );
    expect(calls).toHaveLength(2);
  });

  test("failed twice: rejection + healthy probe + retry also rejects", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new Error("first failure");
      },
      async () => ok(), // health probe succeeds
      async () => {
        throw new Error("second failure");
      }, // retry also fails
    ]);

    try {
      await fetchWithRecovery(deps(fetchImpl), PATH);
      throw new Error("expected fetchWithRecovery to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("failed twice");
      expect(message).toContain(`${BASE}${PATH}`);
      // implementation reports the retry's error message (falling back to the
      // original only if the retry's message is empty) — see net-retry.ts
      expect(message).toContain("second failure");
    }
    expect(calls).toHaveLength(3);
  });

  test("HTTP error passthrough: 500 response is returned as-is, no probe/retry", async () => {
    const { fetchImpl, calls } = makeFetch([async () => serverError(500)]);
    const res = await fetchWithRecovery(deps(fetchImpl), PATH);
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("retry:false + healthy probe: does NOT re-issue, error explains why", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => ok(), // health probe succeeds
    ]);

    try {
      await fetchWithRecovery(deps(fetchImpl), PATH, undefined, { retry: false });
      throw new Error("expected fetchWithRecovery to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toMatch(/not retried/i);
      expect(message).toContain(PATH);
      expect(message).toContain(BASE);
    }
    // original request + health probe only — no re-issue.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(`${BASE}/health`);
  });

  test("retry:false + dead server: still throws the cannot-reach error", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      async () => {
        throw new Error("ECONNREFUSED"); // health probe rejects
      },
    ]);

    await expect(
      fetchWithRecovery(deps(fetchImpl), PATH, undefined, { retry: false }),
    ).rejects.toThrow(/cannot reach agetor API/);
    expect(calls).toHaveLength(2);
  });

  test("caller-initiated abort: rethrown immediately, no probe, no retry", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        throw err;
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRecovery(deps(fetchImpl), PATH, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    // no health probe, no retry — just the original call.
    expect(calls).toHaveLength(1);
  });

  test("non-\"Load failed\" original error + dead server: original message surfaces", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new Error("NetworkError when attempting to fetch resource.");
      },
      async () => {
        throw new Error("ECONNREFUSED"); // health probe rejects
      },
    ]);

    try {
      await fetchWithRecovery(deps(fetchImpl), PATH);
      throw new Error("expected fetchWithRecovery to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toBe("NetworkError when attempting to fetch resource.");
      expect(message).not.toContain("cannot reach agetor API");
    }
    expect(calls).toHaveLength(2);
  });

  test("health probe timeout: hung probe respects AbortSignal and behaves as server-down", async () => {
    const { fetchImpl, calls } = makeFetch([
      async () => {
        throw new TypeError("Load failed");
      },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ]);

    const start = Date.now();
    await expect(
      fetchWithRecovery(deps(fetchImpl, 30), PATH),
    ).rejects.toThrow(/cannot reach agetor API/);
    const elapsed = Date.now() - start;

    expect(calls).toHaveLength(2); // original + health probe; no retry
    // sanity: the timeout actually gated this, not some near-instant path
    expect(elapsed).toBeLessThan(1000);
  });
});
