/**
 * `api.removeTaskRepository` (issue #291, round 15): one DELETE with both
 * path segments encoded, the route's `{ task }` envelope unwrapped, the core's
 * refusal message surfaced as the thrown error, and never replayed after a
 * dropped answer (a replay would 404 on the repository it already removed).
 * Asserted against a stubbed fetch (the boundary).
 */
import { afterEach, expect, test } from "bun:test";
import { api, ApiError } from "./api.ts";
import { ApiTransitError } from "./net-retry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(respond: (method: string, url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response("{}", { status: 200 });
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    return respond(method, u);
  }) as unknown as typeof fetch;
  return calls;
}

test("sends one DELETE with encoded segments and returns the updated task", async () => {
  const calls = stub(() => new Response(JSON.stringify({ task: { id: "t 1", repositories: [] } }), { status: 200 }));
  const task = await api.removeTaskRepository("t 1", "api/v2");
  expect(task).toEqual({ id: "t 1", repositories: [] } as never);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("DELETE ");
  expect(calls[0]).toEndWith("/tasks/t%201/repositories/api%2Fv2");
});

test("a refusal throws the core's message", async () => {
  stub(() => new Response(JSON.stringify({ error: "backend has uncommitted changes", code: "dirty" }), { status: 409 }));
  const err = await api.removeTaskRepository("t1", "backend").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).message).toBe("backend has uncommitted changes");
});

test("a dropped answer is not replayed", async () => {
  const calls = stub(() => {
    throw new TypeError("Load failed");
  });
  const err = await api.removeTaskRepository("t1", "backend").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiTransitError);
  expect(calls).toHaveLength(1);
});
