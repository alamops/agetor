import { repairFrame, type DisplayInfo, type Rect } from "./screen-frame.ts";

/**
 * Structural subset of Electrobun's `BrowserWindow` — only the members this
 * module needs to raise, un-minimize and focus a window. Kept structural
 * (not `import type { BrowserWindow } from "electrobun/bun"`) so this module
 * has zero runtime or type dependency on the native library: a real
 * `BrowserWindow` satisfies it for free, and `bun test` can pass a plain
 * object fake without ever loading Electrobun's native bindings.
 */
export interface FocusableWindow {
  isMinimized(): boolean;
  unminimize(): void;
  activate(): void;
  getFrame(): Rect;
  setFrame(x: number, y: number, width: number, height: number): void;
}

export interface FocusDeps {
  getAllDisplays: () => DisplayInfo[];
}

/**
 * Raises, un-minimizes and focuses the app's main window. This is the single
 * shared routine behind every "bring the app to the front" trigger — a
 * clicked native notification, a deep link, a Dock reopen — so those callers
 * don't each reinvent the ordering below.
 *
 * Returns `false` only when there was no window to act on at all (`win` is
 * `null`/`undefined`) — that's the signal callers use to decide whether to
 * fall back to a 503 or to create a fresh window. Once a window exists, this
 * function always returns `true`, even if the native `activate()` call below
 * throws: a throw there is a platform hiccup on a window that legitimately
 * exists, not the "nothing to focus" case, and conflating the two would send
 * "no window" callers down the wrong recovery path.
 */
export function focusWindow(win: FocusableWindow | null | undefined, deps: FocusDeps): boolean {
  if (!win) return false;

  // Repair the frame *before* un-minimizing/activating so a window whose
  // remembered position has gone off-screen (monitor unplugged, display
  // arrangement changed since last launch) doesn't visibly animate in at an
  // unreachable location before snapping back — the fix has to land before
  // the window is shown, not after.
  try {
    const displays = deps.getAllDisplays();
    const current = win.getFrame();
    const repaired = repairFrame(current, displays);
    if (
      repaired.x !== current.x ||
      repaired.y !== current.y ||
      repaired.width !== current.width ||
      repaired.height !== current.height
    ) {
      win.setFrame(repaired.x, repaired.y, repaired.width, repaired.height);
    }
  } catch (err) {
    console.error("[agetor] window-focus: frame repair failed", err);
  }

  // Un-minimize next, still before activating, so the window is in a normal
  // (restorable) state by the time activation asks macOS to bring it
  // forward.
  try {
    if (win.isMinimized()) win.unminimize();
  } catch (err) {
    console.error("[agetor] window-focus: unminimize failed", err);
  }

  // Each step above is independently guarded so that a native failure in a
  // best-effort enhancement (frame repair, un-minimize) can never cost the
  // user the one thing that actually matters: getting the window in front
  // of them. Activation is guarded the same way for symmetry and so a throw
  // here can't escape to the caller, but unlike the steps above it is not
  // optional — this function's whole purpose is to attempt it.
  //
  // `activate()`, not the deprecated `focus()`: Electrobun's `focus()` just
  // logs a warning and delegates to `activate()`, so calling it directly
  // only adds noise. `activate()` is what actually drives macOS's
  // `activateIgnoringOtherApps:` + `makeKeyAndOrderFront:` under the hood.
  //
  // Deliberately not doing the `setVisibleOnAllWorkspaces(true) → activate()
  // → false` trick that would pull the window onto whichever Space the user
  // is currently looking at. Electrobun *does* expose
  // `setVisibleOnAllWorkspaces` (BrowserWindow.ts:342 — it's the one
  // `collectionBehavior` bit the FFI surfaces), so this is buildable: leaving
  // it out is a product decision, not a missing API. Forcing the window
  // across Spaces overrides a user-level macOS setting ("switch to a Space
  // with open windows"), the toggle-off half of the trick is timing-sensitive,
  // and `canJoinAllSpaces` alone still can't enter another app's fullscreen
  // Space. So if the window lives on another Space, macOS decides. Don't
  // "fix" this later without re-litigating the product call.
  //
  // (`NSApp.activate` and `moveToActiveSpace` genuinely don't exist in the
  // FFI table, and can't be added: the native wrapper ships as a prebuilt
  // dylib with no source, and dlopen throws on an undeclared symbol.)
  try {
    win.activate();
  } catch (err) {
    console.error("[agetor] window-focus: activate failed", err);
  }

  return true;
}
