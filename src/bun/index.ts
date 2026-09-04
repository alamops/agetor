import { writeFileSync, existsSync } from "node:fs";
import Electrobun, { ApplicationMenu, BrowserWindow, Screen, Updater, Utils } from "electrobun/bun";
import { rehydratePath } from "./login-path.ts";
import { startApiServer, API_PORT, API_TOKEN, type ApiNative } from "./server.ts";
import { db, harnesses, pidFilePath, tasks, dataDir } from "./db.ts";
import { reconcileOrphans, sweepArchivedTeardowns, reapIdleSessions } from "./orchestrator.ts";
import { SESSION_REAP_SWEEP_MS, USAGE_POLL_SWEEP_MS, FONT_SIZE_DEFAULT, FONT_SIZE_BASE_PX } from "../shared/types.ts";
import { pollAllUsage } from "./usage/poller.ts";
import { resolveThemePreference, resolveFontSizePreference, buildWindowHash } from "./window-url.ts";
import { broadcastAppEvent, consumeForceQuit } from "./quit-guard.ts";
import { refreshAllModels, startPeriodicDiscovery } from "./model-discovery.ts";
import { startUpdaterLoop, applyUpdate, checkForUpdate, getUpdateSnapshot } from "./updater.ts";
import { getMainWindow, setMainWindow } from "./window.ts";
import { makeWindowLifecycle, type Frame } from "./window-lifecycle.ts";
import { focusWindow } from "./window-focus.ts";
import { repairFrame } from "./screen-frame.ts";
import { writeCoreCreds, removeCoreCreds, readCoreCreds, probeLiveCore, waitForPortFree } from "./core-creds.ts";
import { resolveNotifier, resolveNotifierApp, buildNotifierArgs } from "./notifier.ts";
import { buildTaskDeepLink, parseTaskDeepLink } from "./deep-link.ts";
import { setPendingOpenTask } from "./pending-open.ts";
import pkg from "../../package.json" with { type: "json" };

/** Drop a pid file in the data dir so out-of-process tools (notably
 *  `bun run wipe:dev`) can tell whether an agetor instance is using this
 *  data dir, independent of which API port we ended up on. Stale pid
 *  files left behind by crashes are harmless — readers verify the pid is
 *  alive with `kill(pid, 0)` before trusting the file. Best-effort; a
 *  failed write doesn't block boot.
 *
 *  Single-instance enforcement at the application layer is intentionally
 *  absent: macOS Launch Services already dedupes packaged-app launches by
 *  bundle identifier (see `electrobun.config.ts:app.identifier`), so a
 *  double-click in Finder/Spotlight/Dock can't spawn a second process. In
 *  dev mode, dev and prod use different default ports (4318 vs 4317), so
 *  the common stale-process case can't collide. If a port is still held
 *  by something else, the try/catch around `startApiServer()` below fails
 *  loudly with a useful `lsof` hint rather than silently fighting it. */
try {
  writeFileSync(pidFilePath, String(process.pid));
} catch {
  /* non-fatal */
}

/**
 * Install a native macOS menu bar with standard Edit-menu roles. Without this,
 * WKWebView never receives `selectAll:` / `cut:` / `copy:` / `paste:` /
 * `undo:` / `redo:` because the OS routes the shortcut to the (absent) menu
 * instead of to the responder chain. The menu only needs to exist for the
 * shortcuts to start working — items still surface in the menu bar so users
 * can discover them.
 */
function installNativeMenu() {
  ApplicationMenu.setApplicationMenu([
    {
      label: "Agetor",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide", accelerator: "Cmd+H" },
        { role: "hideOthers", accelerator: "Cmd+Alt+H" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", accelerator: "Cmd+Q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", accelerator: "Cmd+Z" },
        { role: "redo", accelerator: "Cmd+Shift+Z" },
        { type: "separator" },
        { role: "cut", accelerator: "Cmd+X" },
        { role: "copy", accelerator: "Cmd+C" },
        { role: "paste", accelerator: "Cmd+V" },
        { role: "pasteAndMatchStyle", accelerator: "Cmd+Shift+Alt+V" },
        { role: "delete" },
        { role: "selectAll", accelerator: "Cmd+A" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize", accelerator: "Cmd+M" },
        { role: "zoom" },
        { role: "close", accelerator: "Cmd+W" },
        { type: "separator" },
        { role: "toggleFullScreen", accelerator: "Ctrl+Cmd+F" },
        { type: "separator" },
        { role: "bringAllToFront" },
      ],
    },
  ]);
}

const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}`;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(VITE_URL, { method: "HEAD" });
      console.log(`[agetor] HMR enabled: ${VITE_URL}`);
      return VITE_URL;
    } catch {
      console.log("[agetor] vite dev server not running — using bundled view");
    }
  }
  return "views://mainview/index.html";
}

// When agetor is launched as a packaged .app (Finder, Spotlight, Dock),
// launchd hands the process a minimal PATH that's missing every place users
// actually install dev CLIs (/opt/homebrew/bin, ~/.nvm/…, ~/.npm-global/bin,
// asdf shims, …). Source the user's login-shell PATH once at boot so
// `Bun.which("claude")` / "codex" / "tmux" can find what's there. Has to run
// before the API server starts handling /agents probes. Idempotent and safe
// in dev runs — the merge dedupes.
rehydratePath();

// Mark any runs that were "running" when we last shut down as orphaned, so the
// kanban doesn't show stuck cards. Awaited (top-level await — this module is
// ESM) so the rest of boot, in particular `startApiServer()` below, never
// runs concurrently with reconciliation: the API must not start serving
// `/tasks`/`/runs` while a `status='running'` row from a previous process is
// still being reattached or flipped to `orphaned` underneath it — the same
// "reconcile before the API starts" invariant CLAUDE.md §5 documents, and the
// same ordering the old synchronous `reconcileOrphans` gave for free by
// blocking this whole script until it returned. An unhandled rejection here
// fails boot loudly, matching that old synchronous-throw behavior — no
// swallow.
await reconcileOrphans();

// Heal any archive/delete teardown (tmux kill, terminal shells, worktree
// detach) that was deferred to the in-memory teardown queue but never ran
// because agetor quit or crashed before the job fired. Fire-and-forget — it
// only enqueues jobs onto that queue, keyed to this instance's own task ids.
sweepArchivedTeardowns();

// Idle-session reaper (docs/plans/reduce-cpu-and-memory.md §3.1, T4): kills
// claude REPL tmux sessions that have sat idle (no turn in flight, nothing
// pending, no activity) for IDLE_SESSION_REAP_MS, reclaiming their ~300–500MB
// "node" process and per-session timers. A 30s delay before the first sweep
// lets `reconcileOrphans` above finish reattaching live sessions first, so a
// task that's mid-reattach isn't mistaken for idle. Errors are swallowed —
// this is best-effort background hygiene, never something that should crash
// the app.
setTimeout(() => {
  reapIdleSessions().catch((err) => {
    console.error("[agetor] idle-session reap (post-boot) failed:", err);
  });
}, 30_000);
setInterval(() => {
  reapIdleSessions().catch((err) => {
    console.error("[agetor] idle-session reap (interval) failed:", err);
  });
}, SESSION_REAP_SWEEP_MS);

// Per-harness usage poller (docs/plans/harness-usage-tracker.md §7): fetches
// quota/usage snapshots for every enabled harness on a background cadence, so
// the topbar meters stay fresh without the webview driving the fetches. A
// 20s post-boot delay (offset from the reaper's 30s so the two sweeps don't
// both fire in the same tick) lets boot settle first. Errors are swallowed —
// `pollAllUsage` already never throws, but the `.catch` matches the reaper's
// belt-and-suspenders shape.
setTimeout(() => {
  pollAllUsage().catch((err) => {
    console.error("[agetor] usage poll (post-boot) failed:", err);
  });
}, 20_000);
setInterval(() => {
  pollAllUsage().catch((err) => {
    console.error("[agetor] usage poll sweep failed", err);
  });
}, USAGE_POLL_SWEEP_MS);

installNativeMenu();

// Best-effort: probe the agent CLIs (and every enabled fx harness's own
// account-scoped catalog) for their model lists so the form can surface
// anything new the user installed — or logged into — without an app update.
// Runs in the background — we don't await it so a slow CLI never delays the
// API/window; the webview polls GET /agent-models/harnesses' `ready` flag
// until this sweep lands, which is what closes the boot race
// docs/plans/fx-model-catalog-refresh.md §2 reproduced (fx=0 for the first
// ~1s after boot). `startPeriodicDiscovery` re-runs the sweep every 15
// minutes (`.unref()`'d — never itself keeps the app alive) so catalog
// drift (new models, revoked account access) is eventually noticed even
// with no triggering event.
void refreshAllModels();
startPeriodicDiscovery();

/**
 * Posts a task notification, deep-linking it to the task when possible.
 *
 * Electrobun's own `Utils.showNotification` has no click callback — a click
 * just dismisses the banner — so it can't carry the user back to the task that
 * fired it. Our bundled native helper (AgetorNotifier.app, see notifier.ts)
 * can: it posts via UNUserNotificationCenter with the deep link in userInfo,
 * and on click opens `agetor://task/<id>`, which triggers Electrobun's
 * "open-url" event (handled below) on the already-running app. So when a
 * `taskId` is supplied and the helper resolves, we spawn it instead.
 *
 * Fallback discipline (a notifier problem must never mean NO notification):
 *   - No taskId or no helper resolved → plain Utils.showNotification.
 *   - A *synchronous* spawn throw → caught here → plain notification.
 *   - The helper launches but exits non-zero (e.g. the user denied
 *     notification permission — the helper exits 2 then) → we watch `.exited`
 *     and fall back on failure. This async check is essential: a
 *     launch/permission failure surfaces on the *child*, not as a synchronous
 *     throw. The helper exits 0 once it has posted, so the happy path never
 *     double-notifies.
 */
function showTaskNotification(n: {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  taskId?: string;
}): void {
  const plain = () =>
    Utils.showNotification({ title: n.title, body: n.body, subtitle: n.subtitle, silent: n.silent });

  if (n.taskId) {
    const bin = resolveNotifier();
    if (bin) {
      try {
        const child = Bun.spawn(
          [
            bin,
            ...buildNotifierArgs({
              title: n.title,
              body: n.body,
              subtitle: n.subtitle,
              silent: n.silent,
              url: buildTaskDeepLink(n.taskId),
            }),
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        // Fall back if the helper failed to actually show anything.
        child.exited
          .then((code) => {
            // 0 = posted. 2 = the user denied notification permission (or never
            // answered the one-time prompt). On denial we deliberately do NOT
            // fall back to Utils.showNotification: that posts under agetor's
            // MAIN bundle id — a second "Agetor" identity — which would
            // re-prompt for a permission the user just declined. Respect the
            // choice (no notification). Any OTHER non-zero code is an
            // unexpected helper failure, so fall back to a plain notification.
            if (code === 0) return;
            if (code === 2) {
              console.error("[agetor] notifier helper: notification permission not granted; skipping fallback");
              return;
            }
            console.error(`[agetor] notifier helper exited ${code}, falling back to plain notification`);
            plain();
          })
          .catch((err) => {
            console.error("[agetor] notifier helper failed, falling back:", err);
            plain();
          });
        return;
      } catch (err) {
        console.error("[agetor] notifier helper spawn failed, falling back:", err);
        // fall through to the plain notification below
      }
    }
  }
  plain();
}

// Best-effort: register the notifier helper bundle with LaunchServices at
// startup. We spawn the helper's inner Mach-O directly (not via `open`), which
// does not guarantee the bundle is in the LaunchServices database — and a
// notification CLICK needs LS to be able to relaunch the bundle by identity to
// deliver the response (which runs `open agetor://…`). Registering it here
// maximizes the chance the cold-relaunch-on-click path works. Fully non-fatal:
// posting notifications works regardless; only the click-relaunch depends on it
// (and that is a manual-QA item on a notarized build either way).
function registerNotifierBundle(): void {
  try {
    const app = resolveNotifierApp();
    if (!app) return;
    const lsregister =
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
    if (!existsSync(lsregister)) return;
    // Fire-and-forget; lsregister is fast and idempotent.
    Bun.spawn([lsregister, "-f", app], { stdout: "ignore", stderr: "ignore" });
  } catch (err) {
    console.error("[agetor] failed to register notifier bundle with LaunchServices:", err);
  }
}
registerNotifierBundle();

// Native-host capabilities the API server needs but that only exist inside
// Electrobun (file dialogs, OS notifications, open-in-Finder/browser, the
// self-updater, quit). The headless CLI daemon injects none of these — its
// routes 501 — but the packaged app wires them up here.
const native: ApiNative = {
  openFileDialog: (opts) => Utils.openFileDialog(opts),
  openPath: (p) => Utils.openPath(p),
  openExternal: (url) => Utils.openExternal(url),
  showNotification: (n) => showTaskNotification(n),
  focusWindow: () => focusMainWindow(),
  quit: () => Utils.quit(),
  updates: {
    snapshot: () => getUpdateSnapshot(),
    check: () => checkForUpdate(),
    apply: () => applyUpdate(),
  },
};

let apiServer: ReturnType<typeof startApiServer>;
try {
  apiServer = startApiServer({ native });
} catch (e) {
  // Port busy. If our own cli-daemon owns it (the CLI started a background core
  // while the app was closed), ask it to hand off, wait for the port to free,
  // then bind and become the owner. Anything else — a foreign process (stale
  // agetor, or OTLP gRPC which also defaults to 4317) or a wedged daemon that
  // won't release — falls through to the loud message + exit so the user sees
  // the real problem rather than a wall of CORS errors in the renderer.
  const creds = readCoreCreds(dataDir);
  let recovered: ReturnType<typeof startApiServer> | null = null;
  if (creds && creds.kind === "cli-daemon" && (await probeLiveCore(creds))) {
    console.log("[agetor] a CLI daemon owns the API port — requesting handoff…");
    try {
      await fetch(`http://127.0.0.1:${creds.port}/daemon/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.token}` },
      });
    } catch {
      /* the daemon drops the connection as it exits — expected */
    }
    if (await waitForPortFree(creds.port, 10_000)) {
      try {
        recovered = startApiServer({ native });
      } catch {
        /* fall through to the loud message below */
      }
    }
  }
  if (!recovered) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`[agetor] failed to bind API on 127.0.0.1:${API_PORT}: ${msg}`);
    console.error(`[agetor] another process is holding that port. Run \`lsof -nP -iTCP:${API_PORT} -sTCP:LISTEN\` to identify it, then quit it and relaunch agetor.`);
    process.exit(1);
  }
  apiServer = recovered;
}

// Publish the per-launch API port + token so the CLI (and a second app launch)
// can discover and authenticate to this core. `kind: "app"` tells a future
// daemon spawn that the richer surface owns the port.
writeCoreCreds(
  {
    port: apiServer.port!,
    token: API_TOKEN,
    pid: process.pid,
    kind: "app",
    version: pkg.version,
    startedAt: Date.now(),
  },
  dataDir,
);

// Warn the user before quitting when runs are still active. Electrobun's
// `before-quit` event fires synchronously from Utils.quit() and reads
// `responseWasSet && response.allow === false` to veto — we can't await an
// async confirm here, so the flow is:
//   1. Block this quit (set allow:false) and broadcast a quit_request app
//      event over SSE.
//   2. The webview's QuitConfirmDialog shows the modal.
//   3. On confirm, the webview POSTs /app/force-quit which arms a one-shot
//      flag and re-issues Utils.quit(); this handler then sees the flag
//      via consumeForceQuit() and allows the quit through.
// Reattached runs (claude-code sessions kept alive across restart) count
// as running, so the user is still prompted if they try to quit while one
// is in flight.
Electrobun.events.on("before-quit", (event: { response?: { allow: boolean } }) => {
  if (consumeForceQuit()) {
    removeCoreCreds(dataDir);
    event.response = { allow: true };
    return;
  }
  let runningCount = 0;
  let runningTaskTitles: string[] = [];
  try {
    const rows = db.query<{ task_id: string }, []>(
      `SELECT DISTINCT task_id FROM runs WHERE status = 'running'`,
    ).all();
    runningCount = rows.length;
    runningTaskTitles = rows
      .map((r) => tasks.get(r.task_id)?.title ?? "")
      .filter((t) => t.length > 0)
      .slice(0, 10);
  } catch {
    // If the DB is unavailable for any reason, allow the quit — the cost
    // of a missed warning is small; the cost of trapping the user is high.
  }
  if (runningCount === 0) {
    removeCoreCreds(dataDir);
    event.response = { allow: true };
    return;
  }
  broadcastAppEvent({
    type: "quit_request",
    runningRunCount: runningCount,
    runningTaskTitles,
    ts: Date.now(),
  });
  event.response = { allow: false };
});

// Background self-update check on launch + every 6h. Emits global events
// that the UI subscribes to via SSE to render the "update ready" banner.
// Defers its first probe 5s past boot so it doesn't slow window open.
startUpdaterLoop();

/** Lifecycle wrapper around BrowserWindow construction. Handles:
 *   - idempotency (concurrent reopen events share one in-flight build),
 *   - frame memory (remembered position/size survives close → reopen so
 *     the window doesn't jump back to its DEFAULT_FRAME on every Dock
 *     click — the user-visible Mac standard).
 *  See window-lifecycle.ts + window-lifecycle.test.ts for the contract
 *  and the race-safety / restore-frame coverage. */
const windowLifecycle = makeWindowLifecycle({
  getMainWindow,
  setMainWindow,
  buildWindow: async (frame: Frame) => {
    const url = await getMainViewUrl();
    const theme = resolveThemePreference();
    const fontSize = resolveFontSizePreference();
    // The native views:// scheme handler refuses URLs that carry a fragment
    // or query — it treats the part after the scheme as a literal file path,
    // so `views://mainview/index.html#api=…` resolves to a non-existent file
    // and returns "empty response". Instead, ship the per-launch API
    // coordinates (now including the resolved theme preference) through a
    // WKUserScript injection (BrowserWindow's `preload` option). The webview
    // reads the rest off `window.__AGETOR` too (see api.ts).
    // For Vite HMR mode the URL is plain http://, which DOES support hash,
    // so we keep the legacy hash payload (now theme-carrying too, via
    // buildWindowHash) as a fallback there.
    //
    // themeApplyScript below APPLIES the theme itself, rather than only
    // exposing it for index.html's inline <head> script to read back.
    // Electrobun's `preload` is documented to run before page scripts, but
    // the exact injection point (WKUserScript's `.atDocumentStart` vs.
    // `.atDocumentEnd`) is decided by the native wrapper — a prebuilt binary
    // this repo doesn't control — so relying on "preload always beats
    // index.html's inline script" is exactly the kind of ordering
    // assumption that only breaks in a packaged build (`bun run dev:hmr`
    // never hits this path: it loads http:// + hash, not views://). Doing
    // the class/color-scheme application right here removes the dependency
    // on that ordering: whichever of this script and index.html's inline
    // script runs first "wins" the paint, and the other is a no-op re-run
    // of the identical computation from the identical `theme` value — both
    // derive `dark` the same way, so there is nothing to fight over
    // regardless of which fires first. `document.documentElement` is
    // expected to exist even at document-start in WebKit, but the `r &&`
    // guard and try/catch keep this best-effort defensive against a WKWebView
    // that injects later than documented, or an environment lacking
    // `matchMedia`.
    const themeApplyScript =
      `try{var p=${JSON.stringify(theme)};` +
      `var d=p==="dark"||(p==="auto"&&(!window.matchMedia||window.matchMedia("(prefers-color-scheme: dark)").matches));` +
      `var r=document.documentElement;` +
      `if(r){r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}` +
      `}catch(e){}`;
    // Same rationale as themeApplyScript above: applies the resolved
    // font-size percent itself, rather than only exposing it for
    // index.html's inline <head> script to read back, so neither script has
    // to win a race against the other — both derive the identical px value
    // from the identical `fontSize` number. At FONT_SIZE_DEFAULT (100) this
    // is the empty string: no inline style is written, matching the
    // "pristine at default" contract (there's nothing to clear, since
    // nothing was ever set). The px value is computed once here in Bun and
    // inlined as a literal — re-running this script (e.g. if the preload
    // and index.html's script both fire) just re-assigns the same value, an
    // idempotent no-op.
    const fontSizeApplyScript =
      fontSize === FONT_SIZE_DEFAULT
        ? ""
        : `try{var r2=document.documentElement;` +
          `if(r2){r2.style.fontSize=${JSON.stringify(`${(FONT_SIZE_BASE_PX * fontSize) / 100}px`)};}` +
          `}catch(e){}`;
    const bootGlobals =
      `window.__AGETOR=${JSON.stringify({
        port: String(API_PORT),
        token: API_TOKEN,
        theme,
        fontSize,
      })};` + themeApplyScript + fontSizeApplyScript;
    const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
    // `remembered` (window-lifecycle.ts) is in-memory only, updated live from
    // "move"/"resize" events — it's never validated against the display
    // layout at the time it was captured. If the user unplugs the display the
    // window was last on and then closes + reopens the window within the
    // same process (no restart, so this isn't the boot-reconciliation path),
    // `frame` here can describe a rect no longer on any screen. Neither
    // `BrowserWindow`'s construction nor a later `setFrame` auto-constrains
    // an out-of-bounds frame onto a live display — AppKit's
    // `constrainFrameRect` only clamps within the window's *current* screen,
    // which doesn't help a window that hasn't been placed yet — so repair
    // has to happen here, before construction, not after.
    const safeFrame = repairFrame(frame, Screen.getAllDisplays());
    // macOS-only chrome: `hiddenInset` removes the native title bar background
    // + text but keeps inset traffic lights, letting the React header at the
    // top of App.tsx render full-bleed on the same row. `trafficLightOffset`
    // shifts the lights to vertically center inside that header's 40px (h-10)
    // height — keep `x` here in sync with the header's left padding (`pl-20`
    // in App.tsx).
    const mainWindow = new BrowserWindow({
      title: "Agetor",
      titleBarStyle: "hiddenInset",
      trafficLightOffset: { x: 8, y: 8 },
      url: isHttpUrl
        ? `${url}${buildWindowHash({ port: String(API_PORT), token: API_TOKEN, theme, fontSize })}`
        : url,
      preload: bootGlobals,
      frame: safeFrame,
    });
    setMainWindow(mainWindow);
    console.log("[agetor] main window ready");
  },
});

/** Shared "bring the app to front" call for every raise trigger (notification
 *  click, Dock reopen) — wraps focusWindow() with this process's concrete
 *  getMainWindow()/Screen.getAllDisplays() so the three call sites below
 *  don't each re-spell the deps. Returns false when there's no window to
 *  focus (caller's cue to create one instead). */
function focusMainWindow(): boolean {
  return focusWindow(getMainWindow(), { getAllDisplays: () => Screen.getAllDisplays() });
}

// Shadow the window's frame as the user moves / resizes it, so the next
// reopen restores their last placement. Both events carry `id`; we filter
// to *our* main window so a future secondary window's drags don't pollute
// the main-window placement memory. `move` is x/y only; `resize` carries
// both, so we accept partial patches in rememberFrame.
Electrobun.events.on("move", (e: { data: { id: number; x: number; y: number } }) => {
  if (getMainWindow()?.id === e.data.id) {
    windowLifecycle.rememberFrame({ x: e.data.x, y: e.data.y });
  }
});
Electrobun.events.on(
  "resize",
  (e: { data: { id: number; x: number; y: number; width: number; height: number } }) => {
    if (getMainWindow()?.id === e.data.id) {
      windowLifecycle.rememberFrame({
        x: e.data.x, y: e.data.y, width: e.data.width, height: e.data.height,
      });
    }
  },
);

// Clear the registered window reference *only* when the main window
// closes. The "close" event fires for every BrowserWindow the bun
// process owns; without the id filter, closing a future secondary
// window (about box, settings dialog, devtools split) would silently
// clear the main-window registration and break getMainWindow callers
// like the /window/toggle-zoom endpoint.
Electrobun.events.on("close", (e: { data: { id: number } }) => {
  if (getMainWindow()?.id === e.data.id) setMainWindow(null);
});

// macOS Dock-icon click on an already-running app fires Cocoa's
// `applicationShouldHandleReopen:hasVisibleWindows:`, which Electrobun
// surfaces as the "reopen" event (see node_modules/electrobun/dist/api/
// bun/proc/native.ts setAppReopenHandler). Re-create the window if the
// user dismissed it earlier, or raise+focus it if it's merely buried or
// minimized — createMainWindow() no-ops when a window is already
// registered, so without the focus branch a Dock click on a minimized or
// background window did nothing from our side. This is the modern
// replacement for the old HTTP /focus endpoint, and it's what makes agetor
// feel like a real macOS app rather than a webapp that happens to live in
// a window.
//
// We catch errors here because a silent fail-to-recreate would look
// like "Dock click does nothing" to the user, with no diagnostic. The
// boot-time await further below surfaces first-launch failures via the
// top-level await; this catch covers every subsequent reopen.
Electrobun.events.on("reopen", () => {
  if (getMainWindow()) {
    focusMainWindow();
    return;
  }
  windowLifecycle.createMainWindow().catch((err) => {
    console.error("[agetor] failed to recreate window on reopen:", err);
  });
});

// Deep-link entry point: macOS routes a click on our custom `agetor://`
// scheme (e.g. from a terminal-notifier notification — see
// showTaskNotification above) to `open <url>`, which Electrobun surfaces as
// this "open-url" event. There's no notification-click callback in
// Electrobun, so this is the only way a notification click gets back into
// the app — see the design note at src/mainview/lib/api.ts:424.
//
// We ALWAYS stash the taskId in pending-open.ts (short-TTL) and, if a window
// already exists, ALSO broadcast immediately and raise the window:
//   - Window exists: the webview is connected to /app/events, so the direct
//     broadcast arrives instantly. The pending stash is belt-and-suspenders —
//     if the broadcast happens to land while the webview is mid-reload or
//     between EventSource reconnects, the next subscriber flushes the pending
//     entry (within its TTL) so the click isn't silently lost. We broadcast
//     BEFORE focusing: the SSE message is a fire-and-forget dispatch (no
//     round-trip to wait on), so issuing it first lets the webview start
//     selecting the task while the native activate/un-minimize calls are
//     still in flight, instead of the reverse order where the window
//     visibly raises a beat before the UI catches up to it.
//   - No window (app was fully dismissed / cold start): there's no SSE
//     subscriber yet, so we rely entirely on the pending flush — create the
//     window and the freshly-booted webview picks it up when it subscribes
//     (see the consumePendingOpenTask() flush in server.ts's SSE route).
//     No focusMainWindow() call here: constructing a BrowserWindow already
//     calls showWindow(ptr, activate=true) natively, so a freshly built
//     window is activated on creation — calling focusMainWindow() too would
//     be redundant, not incorrect, but it'd suggest the two paths need
//     separate raise logic when they don't.
// The pending entry's TTL (pending-open.ts) prevents a much-later, unrelated
// reconnect from resurrecting a stale click. Re-opening the same task is
// idempotent (webview just re-selects it), so a rare double-delivery is
// harmless. Wrapped so a malformed URL / window-creation failure never
// crashes the event dispatcher.
Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
  try {
    const taskId = parseTaskDeepLink(e.data.url);
    if (!taskId) return;
    setPendingOpenTask(taskId);
    if (getMainWindow()) {
      broadcastAppEvent({ type: "open_task", taskId, ts: Date.now() });
      focusMainWindow();
    } else {
      windowLifecycle.createMainWindow().catch((err) => {
        console.error("[agetor] failed to create window for open-url:", err);
      });
    }
  } catch (err) {
    console.error("[agetor] failed to handle open-url:", err);
  }
});

await windowLifecycle.createMainWindow();
