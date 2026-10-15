// The requests that open a native Open panel (and the Compact request) block
// the core's main thread on purpose — Electrobun's `openFileDialog` is a
// synchronous FFI call — so they run with the busy-banner watchdog suspended
// (docs/plans/non-blocking-session-restore.md, decision E). The observable
// seam: while a tracked request is pending and nothing suspends the watchdog,
// it arms a timer for the moment the request crosses `PENDING_THRESHOLD_MS`;
// a suspended watchdog arms nothing, so it can never probe or show "Agetor is
// busy" for a panel the user is looking at.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./api.ts";
import { PENDING_THRESHOLD_MS, configureCoreBusy, getCoreBusy } from "./core-busy.ts";

const realFetch = globalThis.fetch;
/** Delays the watchdog asked for, in arm order. Never fired. */
let armed: number[] = [];
/** Resolves the one in-flight fake request with a JSON body. */
let answer: ((body: unknown) => void) | null = null;

beforeEach(() => {
  armed = [];
  answer = null;
  let nextHandle = 1;
  configureCoreBusy({
    now: () => 0,
    setTimeout: (_fn, ms) => {
      armed.push(ms);
      return nextHandle++ as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
  });
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      answer = (body) =>
        resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  configureCoreBusy({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  });
});

/** Start `call`, let it reach fetch, report how many watchdog timers were
 *  armed while it was pending, then answer it with `body` and settle it. */
async function armedWhilePending(call: () => Promise<unknown>, body: unknown): Promise<number> {
  const settled = call();
  for (let i = 0; i < 20 && answer === null; i++) await Promise.resolve();
  expect(answer).not.toBeNull();
  const count = armed.length;
  answer!(body);
  await settled;
  expect(getCoreBusy()).toBe(false);
  return count;
}

describe("native-panel requests suspend the busy watchdog", () => {
  test("an ordinary request arms the watchdog (the control)", async () => {
    expect(await armedWhilePending(() => api.listProjects(), [])).toBe(1);
    expect(armed[0]).toBe(PENDING_THRESHOLD_MS);
  });

  test("pickProject, pickRefs, pickBundleFile and compactDb arm nothing", async () => {
    expect(await armedWhilePending(() => api.pickProject(), { project: null })).toBe(0);
    expect(await armedWhilePending(() => api.pickRefs("files"), { refs: [] })).toBe(0);
    expect(await armedWhilePending(() => api.pickBundleFile(), { cancelled: true })).toBe(0);
    expect(await armedWhilePending(() => api.compactDb(), { ok: true })).toBe(0);
  });

  test("saveBundle suspends only for the folder target, which opens a panel", async () => {
    const all = { agentIds: [], pipelineIds: [], all: true };
    expect(await armedWhilePending(() => api.saveBundle(all, "folder"), { cancelled: true })).toBe(0);
    expect(await armedWhilePending(() => api.saveBundle(all, "downloads"), { path: "/x", filename: "x" })).toBe(1);
  });

  test("the suspension is released when the request fails", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;
    await expect(api.pickProject()).rejects.toThrow("boom");
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }));
      })) as unknown as typeof fetch;
    expect(await armedWhilePending(() => api.listProjects(), [])).toBe(1);
  });
});
