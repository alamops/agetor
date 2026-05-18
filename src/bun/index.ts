import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Electrobun, { ApplicationMenu, BrowserWindow, Updater } from "electrobun/bun";
import { rehydratePath } from "./login-path.ts";
import { startApiServer, API_PORT, API_TOKEN } from "./server.ts";
import { db, dataDir, harnesses, tasks } from "./db.ts";
import { reconcileOrphans } from "./orchestrator.ts";
import { broadcastAppEvent, consumeForceQuit } from "./quit-guard.ts";
import { prewarmSharedFiles } from "./hook-installer.ts";
import { refreshDiscoveredModels } from "./agent-discovery.ts";
import { startUpdaterLoop } from "./updater.ts";
import { setMainWindow } from "./window.ts";

const PID_FILE = path.join(dataDir, "agetor.pid");

/** Enforce single-instance: if a prior agetor process is still alive (per
 *  pidfile), SIGTERM it and wait briefly for the API port to free. Without
 *  this, launching a second instance lets the new webview talk to the old
 *  bun process (CORS/auth mismatch, "Status 200 + wrong ACAO" errors). */
async function ensureSingleInstance(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  let raw: string;
  try { raw = readFileSync(PID_FILE, "utf8"); } catch { return; }
  const oldPid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(oldPid) || oldPid <= 0 || oldPid === process.pid) return;
  try { process.kill(oldPid, 0); } catch { return; /* dead — nothing to do */ }
  console.log(`[agetor] another instance is running (pid ${oldPid}) — sending SIGTERM and waiting for port ${API_PORT} to free`);
  try { process.kill(oldPid, "SIGTERM"); } catch { /* race: already gone */ }
  // Poll for the port to free. ~2s budget is enough for a clean Bun.serve
  // shutdown; if the old process is wedged we'll fall through and the loud
  // Bun.serve bind failure below will surface the conflict to the user.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const probe = Bun.serve({ port: API_PORT, hostname: "127.0.0.1", fetch: () => new Response("probe") });
      probe.stop();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

await ensureSingleInstance();

/** Drop a pid file in the data dir so out-of-process tools (notably
 *  `bun run wipe:dev`) can tell whether an agetor instance is using this
 *  data dir, independent of which API port we ended up on. Stale pid
 *  files left behind by crashes are harmless — readers verify the pid is
 *  alive with `kill(pid, 0)` before trusting the file. Best-effort; a
 *  failed write doesn't block boot. */
try {
  writeFileSync(PID_FILE, String(process.pid));
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
// before prewarmSharedFiles (which resolves `bun`) and before the API server
// starts handling /agents probes. Idempotent and safe in dev runs — the
// merge dedupes.
rehydratePath();

// Eagerly refresh the materialised hook + MCP launcher scripts on disk
// (~/.agetor/bin/*) so a `claude` invocation made directly in a previously-
// hook-installed repo — between this restart and the first task spawn —
// runs the current version of the bypass logic, not whatever the prior
// agetor process wrote. Idempotent per process (the `materialised` flag in
// hook-installer.ts gates the writes).
prewarmSharedFiles();

// Mark any runs that were "running" when we last shut down as orphaned, so the
// kanban doesn't show stuck cards.
reconcileOrphans();

// Migration 016 pauses every codex row (built-in + user aliases). The Settings
// dialog renders the "Coming soon" lock so the state is visible there, but a
// user who built a codex alias before the pause deserves a breadcrumb in the
// logs explaining why their alias is dark. Cheap to compute — built-ins are
// expected, anything else is worth a one-line notice.
{
  const paused = harnesses
    .list()
    .filter((h) => h.kind === "codex" && !h.isBuiltin && !h.enabled);
  if (paused.length > 0) {
    console.log(
      `[agetor] codex is paused (coming soon) — ${paused.length} user alias${
        paused.length === 1 ? "" : "es"
      } disabled: ${paused.map((h) => h.id).join(", ")}`,
    );
  }
}

installNativeMenu();

// Best-effort: probe the agent CLIs for their model lists so the form can
// surface anything new the user installed without an app update. Runs in the
// background — we don't await it so a slow CLI never delays the API/window.
void refreshDiscoveredModels();

try {
  startApiServer();
} catch (e) {
  // The webview is created after this — if the API never came up, we'd
  // leave an orphan window talking to whatever else happens to be on the
  // port (e.g. a stale agetor, or OTLP gRPC which also defaults to 4317).
  // Fail loudly instead so the user sees the real problem in the launcher
  // logs rather than a wall of CORS errors in the renderer console.
  const msg = (e as Error)?.message ?? String(e);
  console.error(`[agetor] failed to bind API on 127.0.0.1:${API_PORT}: ${msg}`);
  console.error(`[agetor] another process is holding that port. Run \`lsof -nP -iTCP:${API_PORT} -sTCP:LISTEN\` to identify it, then quit it and relaunch agetor.`);
  process.exit(1);
}

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

const url = await getMainViewUrl();
// The native views:// scheme handler refuses URLs that carry a fragment
// or query — it treats the part after the scheme as a literal file path,
// so `views://mainview/index.html#api=…` resolves to a non-existent file
// and returns "empty response". Instead, ship the per-launch API
// coordinates through a WKUserScript injection (BrowserWindow's
// `preload` option), which runs before any page script. The webview
// reads them off `window.__AGETOR`. For Vite HMR mode the URL is plain
// http://, which DOES support hash, so we keep the legacy hash payload
// as a fallback there.
const bootGlobals = `window.__AGETOR=${JSON.stringify({
  port: String(API_PORT),
  token: API_TOKEN,
})};`;
const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
// macOS-only chrome: `hiddenInset` removes the native title bar background +
// text but keeps inset traffic lights, letting the React header at the top of
// App.tsx render full-bleed on the same row. `trafficLightOffset` shifts the
// lights to vertically center inside that header's 40px (h-10) height — keep
// `x` here in sync with the header's left padding (`pl-20` in App.tsx).
const mainWindow = new BrowserWindow({
  title: "Agetor",
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 8, y: 8 },
  url: isHttpUrl ? `${url}#api=${API_PORT}&token=${API_TOKEN}` : url,
  preload: bootGlobals,
  frame: { width: 1200, height: 800, x: 120, y: 120 },
});
setMainWindow(mainWindow);

console.log("[agetor] main window ready");
