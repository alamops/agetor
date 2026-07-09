import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-window-focus-route-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from other server-test ports so parallel test runs don't fight.
process.env.AGETOR_API_PORT = "4402";

// Stub electrobun's native bridge before server.ts imports it — same reason
// as notifications.test.ts. Critically, this stub MUST export `Screen`:
// server.ts's `/window/focus` handler reads `ElectrobunBun.Screen.getAllDisplays()`
// lazily inside the handler and passes it straight through to `focusWindow`,
// which calls it inside a guarded try/catch as part of frame repair. Without
// a `Screen` export here, `getAllDisplays()` would throw, the guard would
// swallow it, and `activate()` would still run — the test would pass for the
// wrong reason (proving nothing about the frame-repair path actually running).
mock.module("electrobun/bun", () => ({
  Utils: {
    showNotification: () => {},
    openPath: () => true,
    openFileDialog: async () => [],
  },
  BrowserWindow: class { /* unused in this test */ },
  ApplicationMenu: { setApplicationMenu: () => { /* noop */ } },
  Updater: { /* noop */ },
  Screen: { getAllDisplays: () => [] },
}));

let server: { stop: () => void; port: number };
let token: string;
let setMainWindow: (win: unknown) => void;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const windowModule = await import("./window.ts");
  setMainWindow = windowModule.setMainWindow as unknown as (win: unknown) => void;
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

afterEach(() => {
  // A registered fake window must never leak into another test in this file
  // (or a sibling test file, given mock.module's process-wide reach).
  setMainWindow(null);
});

const url = (p: string) => `http://127.0.0.1:4402${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function makeFakeWindow(over: Partial<{
  isMinimized: () => boolean;
  unminimize: () => void;
  activate: () => void;
  getFrame: () => { x: number; y: number; width: number; height: number };
  setFrame: (x: number, y: number, width: number, height: number) => void;
}> = {}) {
  return {
    isMinimized: () => false,
    unminimize: () => {},
    activate: () => {},
    getFrame: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setFrame: () => {},
    ...over,
  };
}

describe("POST /window/focus", () => {
  test("without a token returns 401", async () => {
    const res = await fetch(url("/window/focus"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("returns 503 with no main window registered", async () => {
    setMainWindow(null);
    const res = await fetch(url("/window/focus"), { method: "POST", headers: auth() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no main window" });
  });

  test("returns 200 and calls activate() exactly once on a normal window", async () => {
    let activateCalls = 0;
    const fake = makeFakeWindow({ activate: () => { activateCalls++; } });
    setMainWindow(fake as any);

    const res = await fetch(url("/window/focus"), { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(activateCalls).toBe(1);
  });

  test("restores a minimized window (unminimize before activate)", async () => {
    const calls: string[] = [];
    const fake = makeFakeWindow({
      isMinimized: () => true,
      unminimize: () => { calls.push("unminimize"); },
      activate: () => { calls.push("activate"); },
    });
    setMainWindow(fake as any);

    const res = await fetch(url("/window/focus"), { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["unminimize", "activate"]);
  });

  test("a native activate() throw is still a 200, never a 503 — 503 means 'no window', not 'a native call failed'", async () => {
    const origError = console.error;
    console.error = () => {}; // focusWindow logs this guarded failure; keep suite output clean
    try {
      const fake = makeFakeWindow({
        activate: () => { throw new Error("native activate boom"); },
      });
      setMainWindow(fake as any);

      const res = await fetch(url("/window/focus"), { method: "POST", headers: auth() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      console.error = origError;
    }
  });

  test("GET is not a valid focus trigger (route only registers POST)", async () => {
    const fake = makeFakeWindow();
    setMainWindow(fake as any);

    const res = await fetch(url("/window/focus"), { method: "GET", headers: auth() });
    // The route only registers a POST handler; Bun's router falls through to
    // the server's catch-all fetch handler for an unmatched method, which
    // responds 404 (matches the "not found" shape used elsewhere in server.ts).
    expect(res.status).toBe(404);
  });
});
