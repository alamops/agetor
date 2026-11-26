/**
 * The native macOS menu bar and the path from a click to the webview.
 *
 * `buildAppMenu()` is the template `ApplicationMenu.setApplicationMenu` takes
 * (Agetor / Edit / Go / Window). Items that open something in the webview
 * carry the action id `webview:<action>`, validated against
 * `APP_MENU_ACTIONS`. `menuActionFromClick` maps a click's action string back
 * to that action (other items, such as "remote-access", return null and keep
 * their own handlers in `index.ts`). `deliverMenuAction` then gets it to the
 * webview: a `menu_action` AppEvent over the existing `/app/events` stream,
 * or, with no client attached, a pending slot the next client receives
 * (`pending-open.ts`). No route is added: `/app/events` is already
 * `SSE_LEGACY` in `route-policy.ts`, and the event carries an action id only.
 * Contract: docs/architecture/app-bar.md.
 *
 * Kept free of any `electrobun` import so a unit test can load it.
 */
import { COMPANION_ENABLED } from "../shared/build-flags.ts";
import { APP_MENU_ACTIONS, type AppEvent, type AppMenuAction } from "../shared/types.ts";

export type MenuItem =
  | { type: "separator" }
  | { label: string; action?: string; accelerator?: string; submenu?: MenuItem[] }
  | { role: string; label?: string; accelerator?: string };

const WEBVIEW_PREFIX = "webview:";

function webviewItem(label: string, action: AppMenuAction, accelerator?: string): MenuItem {
  return { label, action: `${WEBVIEW_PREFIX}${action}`, ...(accelerator ? { accelerator } : {}) };
}

/** `companion` is injected so a test runs both ways; the build flag decides in the app. */
export function buildAppMenu(opts: { companion?: boolean } = {}): MenuItem[] {
  const companion = opts.companion ?? COMPANION_ENABLED;
  return [
    {
      label: "Agetor",
      submenu: [
        { role: "about" },
        { type: "separator" },
        webviewItem("Settings…", "settings", "Cmd+,"),
        { type: "separator" },
        { label: "Remote Access…", action: "remote-access" },
        // Only in a build that ships the Companion; the action turns remote access on first (index.ts), then opens the key helper's window.
        ...(companion ? [{ label: "Pair a Phone…", action: "pair-phone" } as MenuItem] : []),
        { type: "separator" },
        { role: "hide", accelerator: "Cmd+H" },
        { role: "hideOthers", accelerator: "Cmd+Alt+H" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", accelerator: "Cmd+Q" },
        // Stops the background host too (D6): a plain quit parks the core under
        // the login item when "run in the background" is on.
        { label: "Quit Agetor Completely", action: "quit-completely", accelerator: "Cmd+Alt+Q" },
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
      // Every app bar action is reachable from the menu bar (HIG), including
      // the ones RunPanel covers. No accelerators: they would collide with
      // webview shortcuts.
      label: "Go",
      submenu: [
        webviewItem("Pipelines", "pipelines"),
        webviewItem("Worktrees…", "worktrees"),
        webviewItem("Git Pull Requests and Issues…", "git"),
        webviewItem("Import Sessions…", "import-sessions"),
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
  ];
}

/** The webview action a menu click's `action` string names, or null for
 *  anything else (other menu handlers, unknown ids, no action at all). */
export function menuActionFromClick(action: unknown): AppMenuAction | null {
  if (typeof action !== "string" || !action.startsWith(WEBVIEW_PREFIX)) return null;
  const id = action.slice(WEBVIEW_PREFIX.length);
  return (APP_MENU_ACTIONS as readonly string[]).includes(id) ? (id as AppMenuAction) : null;
}

export interface DeliverMenuActionDeps {
  hasListeners: () => boolean;
  broadcast: (e: AppEvent) => void;
  setPending: (action: AppMenuAction) => void;
  /** True when a main window exists. */
  hasWindow: () => boolean;
  focusWindow: () => void;
  /** Create the main window (a cold start); the webview then picks the parked action up. */
  createWindow: () => Promise<unknown>;
  log?: (message: string, err: unknown) => void;
  now?: () => number;
}

/**
 * Get one menu action to the webview.
 *
 * - A window exists and a client is attached: broadcast once and focus the
 *   window. Nothing is parked.
 * - A window exists but no client yet (the webview is still booting): park it
 *   for the next client and focus the window.
 * - No window (a cold start): park it and create one; its fresh webview
 *   subscribes and receives it. A client without a window is a CLI streaming
 *   `/app/events`, which is not a target, so nothing is broadcast.
 */
export function deliverMenuAction(action: AppMenuAction, deps: DeliverMenuActionDeps): void {
  const hasWindow = deps.hasWindow();
  if (hasWindow && deps.hasListeners()) {
    deps.broadcast({ type: "menu_action", action, ts: (deps.now ?? Date.now)() });
  } else {
    deps.setPending(action);
  }
  if (hasWindow) {
    deps.focusWindow();
    return;
  }
  deps.createWindow().catch((err) => {
    (deps.log ?? ((m, e) => console.error(m, e)))("[agetor] failed to create window for a menu action:", err);
  });
}
