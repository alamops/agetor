/**
 * Stack create/edit are never replayed (review S21): the core mirrors the
 * primary's config inline before answering, so a dropped connection may have
 * saved the stack, and a re-POST would answer "already in another stack".
 * Asserted against a stubbed fetch (the boundary): the socket drops, the
 * health probe says the core is alive, and the request must NOT be re-issued.
 */
import { afterEach, expect, test } from "bun:test";
import { api, ApiError, StackChangedApiError } from "./api.ts";
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

test("patchHarnessStack surfaces a 409 stack-changed as a typed error carrying the stored stack", async () => {
  const stack = { id: "s1", label: "Stored" };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "This stack changed elsewhere", code: "stack-changed", stack }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const err = await api.patchHarnessStack("s1", { label: "x", expectedUpdatedAt: 1 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StackChangedApiError);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as StackChangedApiError).current).toEqual(stack as never);
});

test("fix-round calls encode ids, carry the query, and the mutating ones are not replayed", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response("{}", { status: 200 });
    seen.push(`${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await api.clearHarnessCooldown("a/b", { model: "m 1" });
  await api.clearHarnessCooldown("a/b", { accountWideOnly: true });
  await api.clearHarnessCooldown("a/b");
  await api.getHarnessStackHistory("s 1", { limit: 5, before: "c" });
  await api.previewHarnessMirror({ kind: "claude-code", members: ["a", "b"] });
  await api.restoreHarnessMirror("a/b");
  await api.switchTaskAccount("t 1");
  await api.cancelScheduledAccountSwitch("t 1");
  expect(seen).toEqual([
    "DELETE /harnesses/a%2Fb/limit-state?model=m%201",
    "DELETE /harnesses/a%2Fb/limit-state?scope=account",
    "DELETE /harnesses/a%2Fb/limit-state",
    "GET /harness-stacks/s%201/history?limit=5&before=c",
    "POST /harness-stacks/mirror-preview",
    "POST /harnesses/a%2Fb/mirror-restore",
    "POST /tasks/t%201/switch-account",
    "DELETE /tasks/t%201/switch-account",
  ]);
  const calls = dropConnection();
  await api.switchTaskAccount("t1").catch(() => null);
  await api.restoreHarnessMirror("h1").catch(() => null);
  expect(calls).toHaveLength(2);
});
