import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent, AppMenuAction } from "../shared/types.ts";

// The native menu's path to the webview, assembled (docs/architecture/app-bar.md
// § Native menu actions): a click → `deliverMenuAction` with the same deps
// `index.ts` wires (`hasAppEventListeners`, `broadcastAppEvent`,
// `setPendingMenuAction`) → either a live `menu_action` frame on
// `/app/events`, or the pending slot that the real `/app/events` route flushes
// to the next client. Only the window is faked: there is no native shell here.
// `app-menu.test.ts` covers the branch logic with fakes and
// `pending-open.test.ts` the slot; this file proves the route delivers it.
//
// db.ts captures AGETOR_DATA_DIR at first import, so set it at the top level
// before any import of ./db.ts or ./server.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-app-events-menu-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other test file's.
process.env.AGETOR_API_PORT = "4631";

type DeliverMenuAction = typeof import("./app-menu.ts").deliverMenuAction;
type DeliverDeps = Parameters<DeliverMenuAction>[1];

let server: { stop: () => void; port: number };
let token: string;
let deliverMenuAction: DeliverMenuAction;
let hasAppEventListeners: () => boolean;
let broadcastAppEvent: (e: AppEvent) => void;
let setPendingMenuAction: (action: AppMenuAction, now?: number) => void;
let PENDING_OPEN_TTL_MS: number;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer } = await import("./server.ts");
  const { API_TOKEN } = await import("./api-config.ts");
  ({ deliverMenuAction } = await import("./app-menu.ts"));
  ({ hasAppEventListeners, broadcastAppEvent } = await import("./quit-guard.ts"));
  ({ setPendingMenuAction, PENDING_OPEN_TTL_MS } = await import("./pending-open.ts"));
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

const open: AppEventsClient[] = [];

afterEach(async () => {
  setSystemTime(); // restore the real clock: bun test shares one process
  for (const c of open.splice(0)) c.close();
  // Leave the slot empty for the next test.
  (await import("./pending-open.ts")).consumePendingMenuAction();
});

afterAll(async () => {
  server?.stop?.();
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

interface AppEventsClient {
  /** Resolves with the first data frame (from the start of the stream) matching `pred`. */
  next: (pred: (e: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

/** Open `GET /app/events` the way the webview does (bearer header) and
 *  resolve on its `: connected` comment frame. The route writes it, subscribes
 *  and flushes the pending slots in one synchronous `start()`, so by then the
 *  client is a listener and any parked click is already queued behind it. */
async function openAppEvents(): Promise<AppEventsClient> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${server.port}/app/events`, {
    signal: ctrl.signal,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  let buf = "";
  let connected = false;
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith(": connected")) connected = true;
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        }
        for (const w of waiters) w();
      }
    } catch {
      // aborted
    } finally {
      ended = true;
      for (const w of waiters) w();
    }
  })();
  const waitUntil = (check: () => boolean, timeoutMs: number, what: string) =>
    new Promise<void>((resolve, reject) => {
      if (check()) return resolve();
      const timer = setTimeout(() => {
        waiters.delete(onChange);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}; frames: ${JSON.stringify(frames)}`));
      }, timeoutMs);
      const onChange = () => {
        if (check()) {
          clearTimeout(timer);
          waiters.delete(onChange);
          resolve();
        } else if (ended) {
          clearTimeout(timer);
          waiters.delete(onChange);
          reject(new Error(`stream ended while waiting for ${what}; frames: ${JSON.stringify(frames)}`));
        }
      };
      waiters.add(onChange);
    });
  await waitUntil(() => connected, 3_000, "the ': connected' frame");
  const client: AppEventsClient = {
    next: async (pred, timeoutMs = 3_000) => {
      await waitUntil(() => frames.some(pred), timeoutMs, "a matching frame");
      return frames.find(pred)!;
    },
    close: () => {
      ctrl.abort();
      void pump;
    },
  };
  open.push(client);
  return client;
}

const isMenuAction = (e: Record<string, unknown>) => e.type === "menu_action";

/** The deps `index.ts` passes, with only the native window faked. */
function deps(window: { exists: boolean }, calls: { focus: number; create: number }): DeliverDeps {
  return {
    hasListeners: hasAppEventListeners,
    broadcast: broadcastAppEvent,
    setPending: setPendingMenuAction,
    hasWindow: () => window.exists,
    focusWindow: () => {
      calls.focus++;
    },
    createWindow: async () => {
      calls.create++;
    },
  };
}

/** The "no client attached" cases need the listener set empty. A client
 *  closed by an earlier test unsubscribes when the route sees the abort. */
async function noClientsAttached(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (hasAppEventListeners() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (hasAppEventListeners()) throw new Error("precondition: an /app/events listener is still attached");
}

test("cold start: with no window and no client the click is parked, a window is created, and the first /app/events client receives it", async () => {
  await noClientsAttached();
  const calls = { focus: 0, create: 0 };
  deliverMenuAction("settings", deps({ exists: false }, calls));
  expect(calls).toEqual({ focus: 0, create: 1 });

  const webview = await openAppEvents();
  const ev = await webview.next(isMenuAction);
  expect(ev.action).toBe("settings");
  expect(typeof ev.ts).toBe("number");
});

test("a delivered click is consumed once: a reconnect does not replay it", async () => {
  await noClientsAttached();
  const calls = { focus: 0, create: 0 };
  deliverMenuAction("worktrees", deps({ exists: false }, calls));
  const first = await openAppEvents();
  expect((await first.next(isMenuAction)).action).toBe("worktrees");
  first.close();
  await noClientsAttached();

  // The reconnect hears a later live click first, never the old one.
  const second = await openAppEvents();
  deliverMenuAction("git", deps({ exists: true }, calls));
  expect((await second.next(isMenuAction)).action).toBe("git");
});

test("window and client attached: broadcast live once, the window is focused, nothing is parked", async () => {
  const webview = await openAppEvents();
  const calls = { focus: 0, create: 0 };
  deliverMenuAction("pipelines", deps({ exists: true }, calls));
  expect((await webview.next(isMenuAction)).action).toBe("pipelines");
  expect(calls).toEqual({ focus: 1, create: 0 });
  webview.close();
  await noClientsAttached();

  // Nothing was parked: the next client's first menu frame is a new live click.
  const next = await openAppEvents();
  deliverMenuAction("import-sessions", deps({ exists: true }, calls));
  expect((await next.next(isMenuAction)).action).toBe("import-sessions");
});

test("window but no client yet (the webview is booting): parked, focused, and delivered when the webview subscribes", async () => {
  await noClientsAttached();
  const calls = { focus: 0, create: 0 };
  deliverMenuAction("import-sessions", deps({ exists: true }, calls));
  expect(calls).toEqual({ focus: 1, create: 0 });
  const webview = await openAppEvents();
  expect((await webview.next(isMenuAction)).action).toBe("import-sessions");
});

test("a CLI streaming /app/events with no window is not a target: nothing is broadcast to it, the new window's webview gets the click", async () => {
  const cli = await openAppEvents();
  const calls = { focus: 0, create: 0 };
  deliverMenuAction("worktrees", deps({ exists: false }, calls));
  expect(calls).toEqual({ focus: 0, create: 1 });

  // Sentinel: a later live click reaches the CLI stream first, so the
  // worktrees click was never broadcast to it.
  deliverMenuAction("git", deps({ exists: true }, calls));
  expect((await cli.next(isMenuAction)).action).toBe("git");

  const webview = await openAppEvents();
  expect((await webview.next(isMenuAction)).action).toBe("worktrees");
});

test("a click parked longer than the TTL is dropped: a late connect does not open it", async () => {
  await noClientsAttached();
  const calls = { focus: 0, create: 0 };
  setSystemTime(new Date(Date.now() - PENDING_OPEN_TTL_MS - 1_000));
  deliverMenuAction("settings", deps({ exists: false }, calls));
  setSystemTime();
  expect(calls.create).toBe(1);

  const webview = await openAppEvents();
  deliverMenuAction("pipelines", deps({ exists: true }, calls));
  expect((await webview.next(isMenuAction)).action).toBe("pipelines");
});

test("a click parked just inside the TTL is still delivered", async () => {
  await noClientsAttached();
  const calls = { focus: 0, create: 0 };
  setSystemTime(new Date(Date.now() - PENDING_OPEN_TTL_MS + 5_000));
  deliverMenuAction("git", deps({ exists: false }, calls));
  setSystemTime();

  const webview = await openAppEvents();
  expect((await webview.next(isMenuAction)).action).toBe("git");
});
