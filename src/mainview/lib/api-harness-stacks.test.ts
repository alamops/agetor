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

// ── TT-E ─────────────────────────────────────────────────────────────────────

test("every mutating stack / switch call is sent exactly once when the socket drops (no replay after a transit failure)", async () => {
  const calls = dropConnection();
  const mutating: [string, () => Promise<unknown>][] = [
    ["createHarnessStack", () => api.createHarnessStack({ label: "T", kind: "claude-code", members: ["a"], mirrorMode: "full" })],
    ["patchHarnessStack", () => api.patchHarnessStack("s", { label: "x", expectedUpdatedAt: 1 })],
    ["restoreHarnessMirror", () => api.restoreHarnessMirror("h")],
    ["switchTaskAccount", () => api.switchTaskAccount("t")],
    ["updateTask(agent)", () => api.updateTask("t", { agent: "b" }, { retry: false })],
  ];
  for (const [name, run] of mutating) {
    calls.length = 0;
    const err = await run().catch((e: unknown) => e);
    expect(err, name).toBeInstanceOf(ApiTransitError);
    expect(calls, name).toHaveLength(1);
  }
});

test("only a 409 with code stack-changed AND a stack becomes StackChangedApiError; every other failure stays a plain ApiError with its body", async () => {
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  };
  const stack = { id: "s1", label: "Stored" };
  const cases: [number, unknown, boolean][] = [
    [409, { error: "This stack changed elsewhere", code: "stack-changed", stack }, true],
    [409, { error: "other conflict", code: "busy" }, false],
    [409, { error: "no stack in body", code: "stack-changed" }, false],
    [409, { error: "null stack", code: "stack-changed", stack: null }, false],
    [400, { error: "bad", code: "stack-changed", stack }, false],
    [400, { error: "bad", blockers: [{ code: "duplicate-member", message: "x" }] }, false],
  ];
  for (const [status, body, typed] of cases) {
    answer(status, body);
    const err = await api.patchHarnessStack("s1", { label: "x", expectedUpdatedAt: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err instanceof StackChangedApiError, JSON.stringify(body)).toBe(typed);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).body).toEqual(body as never);
  }
  // Create has no concurrency token: a 409 there is never retyped.
  answer(409, { error: "x", code: "stack-changed", stack });
  const created = await api.createHarnessStack({ label: "T", kind: "claude-code", members: ["a"], mirrorMode: "full" }).catch((e: unknown) => e);
  expect(created instanceof StackChangedApiError).toBe(false);
  expect(created).toBeInstanceOf(ApiError);
});

test("clearHarnessCooldown maps its options to the query: model wins over accountWideOnly, a bare string is a model, null/empty model is no query", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response("{}", { status: 200 });
    seen.push(`${init?.method} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
    return new Response(JSON.stringify({ cleared: true, rearmed: 2, limitStates: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await api.clearHarnessCooldown("a", { model: "GPT/5", accountWideOnly: true });
  await api.clearHarnessCooldown("a", "m 2");
  await api.clearHarnessCooldown("a", { model: null });
  await api.clearHarnessCooldown("a", { model: "" });
  const res = await api.clearHarnessCooldown("a", { accountWideOnly: true });
  expect(res.rearmed).toBe(2);
  expect(seen).toEqual([
    "DELETE /harnesses/a/limit-state?model=GPT%2F5",
    "DELETE /harnesses/a/limit-state?model=m%202",
    "DELETE /harnesses/a/limit-state",
    "DELETE /harnesses/a/limit-state",
    "DELETE /harnesses/a/limit-state?scope=account",
  ]);
});

test("getHarnessStackHistory sends only the options given (limit 0 counts, an empty cursor does not) and encodes the id", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url).replace(/^https?:\/\/[^/]+/, ""));
    return new Response(JSON.stringify({ events: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await api.getHarnessStackHistory("a/b");
  await api.getHarnessStackHistory("../x", { limit: 0, before: "" });
  await api.getHarnessStackHistory("100%", { before: "c+d/e=" });
  expect(seen).toEqual([
    "/harness-stacks/a%2Fb/history",
    "/harness-stacks/..%2Fx/history?limit=0",
    "/harness-stacks/100%25/history?before=c%2Bd%2Fe%3D",
  ]);
});
