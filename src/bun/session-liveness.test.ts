import { test, expect } from "bun:test";
import { createDeathProbe, pidAlive, AUTHORITATIVE_EVERY_MS } from "./session-liveness.ts";
import type { SessionLiveness } from "./claude-tmux.ts";

/** Scripted collaborators + call counters, so each test can assert exactly
 *  how many forks (`authoritative` / `resolvePid` calls) a tick sequence costs. */
function harness(opts: {
  liveness?: SessionLiveness | (() => SessionLiveness);
  pid?: number | null | (() => number | null);
  alive?: (pid: number) => boolean;
  every?: number;
}) {
  let t = 1_000_000;
  const calls = { authoritative: 0, resolve: 0, alive: 0 };
  const probe = createDeathProbe({
    sessionName: "agetor-test",
    authoritative: () => { calls.authoritative++; return typeof opts.liveness === "function" ? opts.liveness() : (opts.liveness ?? "alive"); },
    resolvePid: () => { calls.resolve++; return typeof opts.pid === "function" ? opts.pid() : (opts.pid === undefined ? 4242 : opts.pid); },
    pidAlive: (pid) => { calls.alive++; return opts.alive ? opts.alive(pid) : true; },
    authoritativeEveryMs: opts.every ?? AUTHORITATIVE_EVERY_MS,
    now: () => t,
  });
  return { probe, calls, advance: (ms: number) => { t += ms; } };
}

test("first tick is authoritative and learns the pid; steady-state ticks fork nothing", () => {
  const h = harness({});
  expect(h.probe.probe()).toBe("alive");
  expect(h.calls).toEqual({ authoritative: 1, resolve: 1, alive: 0 });
  expect(h.probe.pid()).toBe(4242);
  // 20 more ticks at 400ms — inside the 10s window — cost zero forks.
  for (let i = 0; i < 20; i++) { h.advance(400); expect(h.probe.probe()).toBe("alive"); }
  expect(h.calls.authoritative).toBe(1);
  expect(h.calls.resolve).toBe(1);
  expect(h.calls.alive).toBe(20);
});

test("re-validates with the real probe once per window even while the pid answers", () => {
  const h = harness({ every: 10_000 });
  h.probe.probe();
  h.advance(9_999); h.probe.probe();
  expect(h.calls.authoritative).toBe(1);
  h.advance(1); h.probe.probe();
  expect(h.calls.authoritative).toBe(2);
  // Pid still alive → no re-resolve on a scheduled re-validation.
  expect(h.calls.resolve).toBe(1);
});

test("a vanished pid is confirmed by tmux before being reported gone — never invented", () => {
  let alive = true;
  let live: SessionLiveness = "alive";
  const h = harness({ alive: () => alive, liveness: () => live });
  h.probe.probe();
  // Pid dies but tmux (still reachable) says the session is up — e.g. the
  // agent re-exec'd into a new pid. Reported alive; pid re-resolution is
  // throttled to the window so this can't double the fork rate.
  alive = false;
  h.advance(400);
  expect(h.probe.probe()).toBe("alive");
  expect(h.calls.authoritative).toBe(2);
  expect(h.calls.resolve).toBe(1); // throttled — still inside the window
  // Now tmux agrees it's gone: `gone` is passed through and the pid dropped.
  live = "gone";
  h.advance(400);
  expect(h.probe.probe()).toBe("gone");
  expect(h.probe.pid()).toBeNull();
  // Every subsequent tick is authoritative (no pid to fast-path on), so the
  // watch's consecutive-miss counter can reach its threshold.
  h.advance(400); expect(h.probe.probe()).toBe("gone");
  h.advance(400); expect(h.probe.probe()).toBe("gone");
  expect(h.calls.authoritative).toBe(5);
});

test("pid reuse: a scheduled re-validation reporting gone drops the recycled pid", () => {
  let live: SessionLiveness = "alive";
  const h = harness({ liveness: () => live, every: 10_000 });
  h.probe.probe();
  // The session dies but its pid is recycled by an unrelated process, so
  // `kill(pid, 0)` keeps succeeding. Inside the window we (wrongly but
  // boundedly) report alive without forking…
  live = "gone";
  h.advance(5_000);
  expect(h.probe.probe()).toBe("alive");
  expect(h.calls.authoritative).toBe(1);
  // …until the window elapses: the real probe says gone, the pid is dropped,
  // and from here on every tick is authoritative.
  h.advance(5_000);
  expect(h.probe.probe()).toBe("gone");
  expect(h.probe.pid()).toBeNull();
  h.advance(400);
  expect(h.probe.probe()).toBe("gone");
  expect(h.calls.authoritative).toBe(3);
});

test("unreachable keeps the pid: the next tick vouches for the pane without the server", () => {
  let live: SessionLiveness = "alive";
  const h = harness({ liveness: () => live, every: 10_000 });
  h.probe.probe();
  live = "unreachable";
  h.advance(10_000);
  expect(h.probe.probe()).toBe("unreachable");
  expect(h.probe.pid()).toBe(4242);
  h.advance(400);
  expect(h.probe.probe()).toBe("alive"); // fast path, no fork
  expect(h.calls.authoritative).toBe(2);
});

test("an unresolvable pid degrades to the old one-fork-per-tick behaviour, plus one resolve per window", () => {
  const h = harness({ pid: null, every: 10_000 });
  for (let i = 0; i < 26; i++) { h.advance(400); expect(h.probe.probe()).toBe("alive"); }
  expect(h.calls.authoritative).toBe(26);
  // First resolve on the first tick (t=400ms); the throttle allows the next
  // one 10s later, i.e. on tick 26 (t=10,400ms) — exactly two in 26 ticks.
  expect(h.calls.resolve).toBe(2);
  expect(h.calls.alive).toBe(0);
  expect(h.probe.pid()).toBeNull();
});

test("pidAlive: our own pid is alive; an impossible pid is not", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 - 1)).toBe(false);
});
