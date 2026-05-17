import { writeFileSync } from "node:fs";
import path from "node:path";
import { ApplicationMenu, BrowserWindow, Updater } from "electrobun/bun";
import { startApiServer, API_PORT, API_TOKEN } from "./server.ts";
import { dataDir, harnesses } from "./db.ts";
import { reconcileOrphans } from "./orchestrator.ts";
import { prewarmSharedFiles } from "./hook-installer.ts";
import { refreshDiscoveredModels } from "./agent-discovery.ts";
import { startUpdaterLoop } from "./updater.ts";
import { setMainWindow } from "./window.ts";

/** Drop a pid file in the data dir so out-of-process tools (notably
 *  `bun run wipe:dev`) can tell whether an agetor instance is using this
 *  data dir, independent of which API port we ended up on. Stale pid
 *  files left behind by crashes are harmless — readers verify the pid is
 *  alive with `kill(pid, 0)` before trusting the file. Best-effort; a
 *  failed write doesn't block boot. */
try {
  writeFileSync(path.join(dataDir, "agetor.pid"), String(process.pid));
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

startApiServer();

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
