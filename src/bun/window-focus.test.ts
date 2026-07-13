import { describe, expect, test } from "bun:test";
import { focusWindow, type FocusableWindow, type FocusDeps } from "./window-focus.ts";
import { repairFrame, type DisplayInfo, type Rect } from "./screen-frame.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Real display layout pulled from the dev machine. Negative-origin secondary
// displays aren't exercised here (only one display), but the shape matches
// what `screen-frame.ts` expects to read.
const PRIMARY: DisplayInfo = {
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 33, width: 1728, height: 1084 },
  isPrimary: true,
};
const DISPLAYS: DisplayInfo[] = [PRIMARY];

const ONSCREEN_FRAME: Rect = { x: 100, y: 100, width: 800, height: 600 };
const OFFSCREEN_FRAME: Rect = { x: 5000, y: 5000, width: 1200, height: 800 };

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Recording fake for `FocusableWindow`. Every method call is appended to
 *  `calls` (setFrame includes its args) so tests can assert both presence
 *  and ORDER. Any method named in `throws` throws after recording the call —
 *  matching real native bindings, which fail loudly rather than silently. */
function makeWindow(
  opts: {
    frame?: Rect;
    minimized?: boolean;
    throws?: Partial<Record<"getFrame" | "setFrame" | "isMinimized" | "unminimize" | "activate", boolean>>;
  } = {},
): { win: FocusableWindow; calls: string[] } {
  const frame = opts.frame ?? ONSCREEN_FRAME;
  const minimized = opts.minimized ?? false;
  const throwsCfg = opts.throws ?? {};
  const calls: string[] = [];

  const win: FocusableWindow = {
    isMinimized: () => {
      calls.push("isMinimized");
      if (throwsCfg.isMinimized) throw new Error("isMinimized failed (test)");
      return minimized;
    },
    unminimize: () => {
      calls.push("unminimize");
      if (throwsCfg.unminimize) throw new Error("unminimize failed (test)");
    },
    activate: () => {
      calls.push("activate");
      if (throwsCfg.activate) throw new Error("activate failed (test)");
    },
    getFrame: () => {
      calls.push("getFrame");
      if (throwsCfg.getFrame) throw new Error("getFrame failed (test)");
      return frame;
    },
    setFrame: (x: number, y: number, width: number, height: number) => {
      calls.push(`setFrame:${x},${y},${width},${height}`);
      if (throwsCfg.setFrame) throw new Error("setFrame failed (test)");
    },
  };

  return { win, calls };
}

/** Recording fake for `FocusDeps`. */
function makeDeps(
  displays: DisplayInfo[] = DISPLAYS,
  opts: { throws?: boolean } = {},
): { deps: FocusDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: FocusDeps = {
    getAllDisplays: () => {
      calls.push("getAllDisplays");
      if (opts.throws) throw new Error("getAllDisplays failed (test)");
      return displays;
    },
  };
  return { deps, calls };
}

/** Runs `fn` with `console.error` swapped for a recorder, then restores it —
 *  so tests that deliberately trigger the module's error-logging paths don't
 *  spew into the suite's output, while still letting a test assert the log
 *  actually happened. */
function withSilencedConsoleError<T>(fn: () => T): { result: T; errorCalls: unknown[][] } {
  const original = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    return { result: fn(), errorCalls };
  } finally {
    console.error = original;
  }
}

// ─── No window ──────────────────────────────────────────────────────────────

describe("no window to focus", () => {
  test("returns false for null and never touches deps", () => {
    const { deps, calls } = makeDeps();
    expect(focusWindow(null, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("returns false for undefined and never touches deps", () => {
    const { deps, calls } = makeDeps();
    expect(focusWindow(undefined, deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ─── Happy paths ────────────────────────────────────────────────────────────

describe("happy path ordering", () => {
  test("not minimized, on-screen frame: activate() runs once, unminimize and setFrame are skipped", () => {
    const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME, minimized: false });
    const { deps } = makeDeps();

    expect(focusWindow(win, deps)).toBe(true);

    expect(calls).toEqual(["getFrame", "isMinimized", "activate"]);
  });

  test("minimized window: unminimize() runs before activate()", () => {
    const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME, minimized: true });
    const { deps } = makeDeps();

    expect(focusWindow(win, deps)).toBe(true);

    expect(calls).toEqual(["getFrame", "isMinimized", "unminimize", "activate"]);
    expect(calls.indexOf("unminimize")).toBeLessThan(calls.indexOf("activate"));
  });

  test("off-screen frame: setFrame() repairs it before activate(), using repairFrame's own output", () => {
    const repaired = repairFrame(OFFSCREEN_FRAME, DISPLAYS);
    expect(repaired).not.toEqual(OFFSCREEN_FRAME); // sanity: fixture really is off-screen
    // Pin the concrete numbers too, so a change to repairFrame's centering
    // math is visible here rather than only silently shifting the fixture.
    expect(repaired).toEqual({ x: 264, y: 175, width: 1200, height: 800 });

    const { win, calls } = makeWindow({ frame: OFFSCREEN_FRAME });
    const { deps } = makeDeps();

    expect(focusWindow(win, deps)).toBe(true);

    expect(calls).toEqual([
      "getFrame",
      `setFrame:${repaired.x},${repaired.y},${repaired.width},${repaired.height}`,
      "isMinimized",
      "activate",
    ]);
    expect(calls.indexOf("setFrame:264,175,1200,800")).toBeLessThan(calls.indexOf("activate"));
  });

  test("on-screen frame: setFrame() is never called (repair is a no-op when the rect is unchanged)", () => {
    const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME });
    const { deps } = makeDeps();

    focusWindow(win, deps);

    expect(calls.some((c) => c.startsWith("setFrame"))).toBe(false);
  });
});

// ─── Resilience: every best-effort step is independently fault-tolerant ────

const RESILIENCE_CASES: Array<{
  name: string;
  build: () => { win: FocusableWindow; deps: FocusDeps; calls: string[] };
}> = [
  {
    name: "getAllDisplays throws",
    build: () => {
      const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME });
      const { deps } = makeDeps(DISPLAYS, { throws: true });
      return { win, deps, calls };
    },
  },
  {
    name: "getFrame throws",
    build: () => {
      const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME, throws: { getFrame: true } });
      const { deps } = makeDeps();
      return { win, deps, calls };
    },
  },
  {
    name: "setFrame throws",
    build: () => {
      // Off-screen frame so the repair path actually reaches setFrame().
      const { win, calls } = makeWindow({ frame: OFFSCREEN_FRAME, throws: { setFrame: true } });
      const { deps } = makeDeps();
      return { win, deps, calls };
    },
  },
  {
    name: "isMinimized throws",
    build: () => {
      const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME, throws: { isMinimized: true } });
      const { deps } = makeDeps();
      return { win, deps, calls };
    },
  },
  {
    name: "unminimize throws",
    build: () => {
      const { win, calls } = makeWindow({
        frame: ONSCREEN_FRAME,
        minimized: true,
        throws: { unminimize: true },
      });
      const { deps } = makeDeps();
      return { win, deps, calls };
    },
  },
];

describe("resilience matrix: a best-effort step failing never costs activate()", () => {
  for (const { name, build } of RESILIENCE_CASES) {
    test(`${name} → activate() still runs exactly once and focusWindow still returns true`, () => {
      const { win, deps, calls } = build();

      const { result } = withSilencedConsoleError(() => focusWindow(win, deps));

      expect(result).toBe(true);
      expect(calls.filter((c) => c === "activate").length).toBe(1);
    });
  }
});

test("activate() itself throwing still returns true, not false — false means 'no window', never a native error", () => {
  // server.ts's POST /window/focus turns `false` into a 503 "no main window".
  // A window that exists but whose activate() call failed natively is a
  // completely different situation and must not be reported the same way.
  const { win, calls } = makeWindow({ frame: ONSCREEN_FRAME, throws: { activate: true } });
  const { deps } = makeDeps();

  const { result } = withSilencedConsoleError(() => focusWindow(win, deps));

  expect(result).toBe(true);
  expect(calls).toEqual(["getFrame", "isMinimized", "activate"]);
});

test("empty display list (native display library absent, e.g. under bun test) skips repair but still activates", () => {
  // getAllDisplays() legitimately returns [] when the native lib isn't
  // loaded. screen-frame.ts treats that as "unknown, don't touch it" —
  // frameIsVisible short-circuits to true — so setFrame must not fire even
  // though the frame is nowhere near real screen bounds.
  const { win, calls } = makeWindow({ frame: OFFSCREEN_FRAME });
  const { deps } = makeDeps([]);

  expect(focusWindow(win, deps)).toBe(true);

  expect(calls.some((c) => c.startsWith("setFrame"))).toBe(false);
  expect(calls).toContain("activate");
});

// ─── Error logging ──────────────────────────────────────────────────────────

test("a failed step is logged via console.error rather than surfaced as an unhandled throw", () => {
  const { win } = makeWindow({ frame: ONSCREEN_FRAME, throws: { getFrame: true } });
  const { deps } = makeDeps();

  const { errorCalls } = withSilencedConsoleError(() => focusWindow(win, deps));

  expect(errorCalls.length).toBeGreaterThan(0);
});
