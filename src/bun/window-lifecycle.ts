import type { BrowserWindow } from "electrobun/bun";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Starting placement for the very first launch on a fresh data dir.
 *  Subsequent launches (and reopens within a process) use the remembered
 *  frame from `rememberFrame()`. Tuned to land below the menu bar with
 *  some breathing room from the screen edges on a 13" MacBook. */
export const DEFAULT_FRAME: Frame = { x: 120, y: 120, width: 1200, height: 800 };

export interface WindowLifecycleDeps {
  /** Returns the currently-registered main window, or `null` if none. */
  getMainWindow: () => BrowserWindow | null;
  /** Register the main window. Pass `null` to clear (e.g. on close). */
  setMainWindow: (w: BrowserWindow | null) => void;
  /** Construct + register a new BrowserWindow with the given frame.
   *  Async so callers can do I/O before construction (Vite probe, URL
   *  resolution, etc.). The lifecycle module only cares that *after*
   *  the promise resolves, `getMainWindow()` returns the new window. */
  buildWindow: (frame: Frame) => Promise<void>;
}

export interface WindowLifecycle {
  /** Idempotent in two senses:
   *   - If a window is already registered, returns immediately.
   *   - If a construction is in flight, returns the same promise so
   *     concurrent callers don't race two `buildWindow` calls. The
   *     previous (non-idempotent) shape leaked a BrowserWindow when
   *     the user double-clicked the Dock icon fast enough to fire
   *     two `reopen` events while the first await on Vite was still
   *     pending.
   *  Rejects if `buildWindow` rejects; the rejection clears the
   *  in-flight slot so a follow-up call can retry. */
  createMainWindow(): Promise<void>;
  /** Update the remembered frame. Wire to Electrobun's "move" / "resize"
   *  events so the next reopen restores the user's last placement —
   *  without this, every Dock-icon reopen snaps the window back to
   *  `DEFAULT_FRAME` regardless of where the user dragged it. Accepts a
   *  partial so move-only and resize-only events can each update their
   *  axis without clobbering the other. */
  rememberFrame(frame: Partial<Frame>): void;
  /** Read-only accessor for the remembered frame. Exists for tests; the
   *  production caller never needs this since `buildWindow` receives the
   *  frame directly. */
  rememberedFrame(): Frame;
}

export function makeWindowLifecycle(deps: WindowLifecycleDeps): WindowLifecycle {
  let remembered: Frame = { ...DEFAULT_FRAME };
  let inflight: Promise<void> | null = null;

  return {
    createMainWindow(): Promise<void> {
      if (deps.getMainWindow() !== null) return Promise.resolve();
      if (inflight) return inflight;
      const p = (async () => {
        try {
          await deps.buildWindow({ ...remembered });
        } finally {
          inflight = null;
        }
      })();
      inflight = p;
      return p;
    },
    rememberFrame(patch: Partial<Frame>): void {
      remembered = {
        x: patch.x ?? remembered.x,
        y: patch.y ?? remembered.y,
        width: patch.width ?? remembered.width,
        height: patch.height ?? remembered.height,
      };
    },
    rememberedFrame(): Frame {
      return { ...remembered };
    },
  };
}
