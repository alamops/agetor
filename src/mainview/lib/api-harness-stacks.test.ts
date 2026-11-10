/**
 * Stack create/edit are never replayed (review S21): the core mirrors the
 * primary's config inline before answering, so a dropped connection may have
 * saved the stack, and a re-POST would answer "already in another stack".
 * Asserted against a stubbed fetch (the boundary): the socket drops, the
 * health probe says the core is alive, and the request must NOT be re-issued.
 */
import { afterEach, expect, test } from "bun:test";
import { api } from "./api.ts";
import { ApiTransitError } from "./net-retry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every non-health request rejects like WebKit's dropped socket; `/health`
 *  answers 200. Records the non-health requests. */
function dropConnection(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response("{}", { status: 200 });
    calls.push(`${init?.method ?? "GET"} ${u}`);
    throw new TypeError("Load failed");
  }) as unknown as typeof fetch;
  return calls;
}

test("createHarnessStack is sent once and a dropped answer is an ApiTransitError", async () => {
  const calls = dropConnection();
  const err = await api
    .createHarnessStack({ label: "Train", kind: "claude-code", members: ["a", "b"], mirrorMode: "full" })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiTransitError);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("POST ");
  expect(calls[0]).toEndWith("/harness-stacks");
});

test("patchHarnessStack is sent once and a dropped answer is an ApiTransitError", async () => {
  const calls = dropConnection();
  const err = await api.patchHarnessStack("s 1", { members: ["b", "a"] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiTransitError);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("PATCH ");
  expect(calls[0]).toEndWith("/harness-stacks/s%201");
});
