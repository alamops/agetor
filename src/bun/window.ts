import type { BrowserWindow } from "electrobun/bun";

let mainWindow: BrowserWindow | null = null;

/** Set or clear the registered main window. We accept `null` because
 *  `exitOnLastWindowClosed: false` lets the window be destroyed while the
 *  bun process stays alive; the boot script's "close" listener clears the
 *  reference so the next `reopen` event knows to re-create rather than
 *  trying to `show()` a dead native handle. */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
