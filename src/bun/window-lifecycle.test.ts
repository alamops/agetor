import { test, expect } from "bun:test";
import type { BrowserWindow } from "electrobun/bun";
import { makeWindowLifecycle, DEFAULT_FRAME, type Frame } from "./window-lifecycle.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Minimal fake BrowserWindow — only the shape `setMainWindow` would
 *  receive matters; we never call any methods on it. Cast at the seam. */
function fakeWindow(id = 1): BrowserWindow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id } as any;
}

/** Build a deps object backed by a tiny mutable cell + a buildWindow that
 *  records the frame it was called with. `buildDelay` lets a test simulate
 *  the real Vite-probe await so concurrent createMainWindow calls can race. */
function makeDeps(opts: {
  buildDelay?: number;
  buildFails?: boolean;
} = {}) {
  let registered: BrowserWindow | null = null;
  const frames: Frame[] = [];
  let buildCalls = 0;
  return {
    deps: {
      getMainWindow: () => registered,
      setMainWindow: (w: BrowserWindow | null) => { registered = w; },
      buildWindow: async (frame: Frame) => {
        buildCalls++;
        frames.push({ ...frame });
        if (opts.buildDelay) await new Promise((r) => setTimeout(r, opts.buildDelay));
        if (opts.buildFails) throw new Error("buildWindow failed (test)");
        registered = fakeWindow(buildCalls);
      },
    },
    snapshot: () => ({
      registered,
      framesPassed: frames.slice(),
      buildCalls,
    }),
  };
}

// ─── createMainWindow: race-safety ────────────────────────────────────────

test("createMainWindow constructs once when called sequentially", async () => {
  const { deps, snapshot } = makeDeps();
  const lifecycle = makeWindowLifecycle(deps);

  await lifecycle.createMainWindow();
  // Second call: window already registered, no-op (no extra build).
  await lifecycle.createMainWindow();

  const s = snapshot();
  expect(s.buildCalls).toBe(1);
  expect(s.registered).not.toBeNull();
});

test("createMainWindow dedupes concurrent calls into a single build (fixes the rapid-Dock-click race)", async () => {
  // buildDelay > 0 simulates the real Vite probe / FFI constructor await.
  // Without the in-flight promise dedup, both calls pass the early-exit
  // check (no window yet) and each fires buildWindow.
  const { deps, snapshot } = makeDeps({ buildDelay: 30 });
  const lifecycle = makeWindowLifecycle(deps);

  const [a, b] = await Promise.all([
    lifecycle.createMainWindow(),
    lifecycle.createMainWindow(),
  ]);

  expect(a).toBeUndefined();
  expect(b).toBeUndefined();
  const s = snapshot();
  expect(s.buildCalls).toBe(1);
  expect(s.registered).not.toBeNull();
});

test("createMainWindow allows retry after a failed build (in-flight slot is released)", async () => {
  // First call: buildWindow rejects. Subsequent calls must be free to try
  // again — the in-flight promise must NOT pin a failure into the lifecycle.
  let failNext = true;
  let registered: BrowserWindow | null = null;
  let buildCalls = 0;
  const lifecycle = makeWindowLifecycle({
    getMainWindow: () => registered,
    setMainWindow: (w) => { registered = w; },
    buildWindow: async () => {
      buildCalls++;
      if (failNext) {
        failNext = false;
        throw new Error("transient failure");
      }
      registered = fakeWindow(buildCalls);
    },
  });

  await expect(lifecycle.createMainWindow()).rejects.toThrow("transient failure");
  expect(registered).toBeNull();

  // Second attempt should run buildWindow again — the inflight slot must
  // have been cleared in the finally block.
  await lifecycle.createMainWindow();
  expect(buildCalls).toBe(2);
  expect(registered).not.toBeNull();
});

// ─── createMainWindow: frame restoration ──────────────────────────────────

test("createMainWindow uses DEFAULT_FRAME on first launch", async () => {
  const { deps, snapshot } = makeDeps();
  const lifecycle = makeWindowLifecycle(deps);

  await lifecycle.createMainWindow();

  expect(snapshot().framesPassed[0]).toEqual(DEFAULT_FRAME);
});

test("createMainWindow uses the remembered frame after rememberFrame is called", async () => {
  const { deps, snapshot } = makeDeps();
  const lifecycle = makeWindowLifecycle(deps);

  await lifecycle.createMainWindow();
  // Simulate the user dragging + resizing the window.
  lifecycle.rememberFrame({ x: 400, y: 250, width: 1400, height: 900 });
  // Simulate window close → reopen.
  deps.setMainWindow(null);
  await lifecycle.createMainWindow();

  const s = snapshot();
  expect(s.buildCalls).toBe(2);
  expect(s.framesPassed[1]).toEqual({ x: 400, y: 250, width: 1400, height: 900 });
});

test("rememberFrame accepts partial patches without clobbering other axes", async () => {
  const { deps } = makeDeps();
  const lifecycle = makeWindowLifecycle(deps);

  // Simulate a "move" event (x/y only) then a "resize" event (full set).
  lifecycle.rememberFrame({ x: 50, y: 75 });
  expect(lifecycle.rememberedFrame()).toEqual({
    x: 50, y: 75, width: DEFAULT_FRAME.width, height: DEFAULT_FRAME.height,
  });
  lifecycle.rememberFrame({ width: 800, height: 600 });
  expect(lifecycle.rememberedFrame()).toEqual({
    x: 50, y: 75, width: 800, height: 600,
  });
});

test("rememberedFrame returns a defensive copy", async () => {
  const { deps } = makeDeps();
  const lifecycle = makeWindowLifecycle(deps);

  const f = lifecycle.rememberedFrame();
  f.x = 9999;
  expect(lifecycle.rememberedFrame().x).toBe(DEFAULT_FRAME.x);
});
