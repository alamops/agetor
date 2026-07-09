/**
 * Pure geometry for validating and repairing a window frame against the set
 * of connected displays. Used at window-restore time to catch the case
 * where the remembered frame was computed on a monitor arrangement that no
 * longer exists (a laptop undocked, an external display unplugged, a
 * different display layout on next launch) and would otherwise place the
 * window fully off-screen and unreachable.
 *
 * `DisplayInfo` is a structural subset of Electrobun's `Display` — only
 * `bounds`, `workArea`, and `isPrimary` are read — so this module never
 * imports from `electrobun/bun`. That keeps it free of native bindings and
 * side effects at import time, which is what makes it trivially unit
 * testable without a real windowing system underneath.
 *
 * Coordinates throughout are top-left origin, y grows downward, matching
 * both Electrobun's `Display.bounds` and the existing `Frame` type in
 * `window-lifecycle.ts`. Secondary displays legitimately report negative
 * `x`/`y` (anything above or left of the primary display's origin), so no
 * function here may assume non-negative coordinates.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural subset of Electrobun's `Display` — extra fields on the real
 *  object (id, scaleFactor, ...) are fine, TypeScript structural typing
 *  accepts them without this module needing to know about them. */
export interface DisplayInfo {
  bounds: Rect;
  workArea: Rect;
  isPrimary: boolean;
}

/**
 * Smallest on-screen region a frame must occupy to count as "visible".
 * A single pixel of overlap technically satisfies "the window is on
 * screen" but leaves nothing a user can grab to drag it back into view —
 * so the threshold is sized to guarantee at least a sliver of title bar
 * stays reachable, not just technically non-zero overlap.
 */
export const MIN_VISIBLE_WIDTH = 120;
export const MIN_VISIBLE_HEIGHT = 40;

/**
 * Returns the overlapping rectangle of `a` and `b`, or `null` if they don't
 * overlap at all. Works for negative origins (secondary displays sit at
 * negative x/y relative to the primary) since it only ever compares
 * coordinates, never assumes a sign.
 */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * True iff `frame` overlaps a *single* display's `bounds` (not `workArea`) by
 * at least `MIN_VISIBLE_WIDTH` x `MIN_VISIBLE_HEIGHT`. `bounds` is used here
 * rather than `workArea` because a frame that pokes up under the menu bar
 * or down over the Dock is still visible and draggable — visibility only
 * cares about the physical screen, not the region an app window is polite
 * enough to avoid.
 *
 * The threshold is evaluated **per display, not against the union of them**.
 * Adjacent displays form one contiguous desktop, so a window straddling the
 * seam can present a usable strip to the user while clearing the threshold on
 * neither screen alone — e.g. a 120pt-wide window centred on the boundary
 * shows 60pt on each side and is reported here as not visible. That is a
 * deliberate false negative. The alternative, summing coverage across
 * displays, would accept a 10x600 sliver (6000px² > the 4800px² threshold
 * area) as "visible" even though there's no grabbable title bar anywhere —
 * trading a rare, harmless re-centering for a window the user genuinely
 * cannot reach. Erring toward repair is the safer failure.
 *
 * Returns `true` when `displays` is empty. `Screen.getAllDisplays()`
 * returns `[]` when the native display-enumeration library isn't loaded
 * (notably under `bun test`), and an empty list carries no information
 * about the real screen layout — treating "unknown" as "invisible" would
 * make every repair path fire in that environment and mask the very bug
 * it exists to catch. Unknown must mean "don't touch it".
 */
export function frameIsVisible(frame: Rect, displays: DisplayInfo[]): boolean {
  if (displays.length === 0) return true;
  return displays.some((display) => {
    const overlap = intersection(frame, display.bounds);
    return overlap !== null && overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT;
  });
}

/**
 * Returns `frame` unchanged if it's already visible on some display,
 * otherwise a new frame centered on the primary display's `workArea`
 * (falling back to the first display if none is flagged primary), with
 * width/height clamped to fit.
 *
 * Repair targets `workArea` rather than `bounds`: a frame *placed* there
 * should end up somewhere the menu bar and Dock don't immediately cover it
 * again, and workArea is exactly the region macOS itself reserves for that
 * purpose. Visibility checks (above) and repair placement (here) are
 * deliberately asymmetric for this reason.
 *
 * Repair fires only when `frameIsVisible` reports no display showing a usable
 * part of the frame — never on a partial mismatch or an unfamiliar-looking
 * position. (See `frameIsVisible` for the one deliberate false negative: a
 * window straddling the seam between two adjacent displays.) A frame
 * legitimately placed on a secondary display can have
 * wildly different-looking coordinates from the primary display (e.g. a
 * large negative x) without being wrong — display layouts are stored in
 * whatever coordinate space macOS handed back at placement time, and a
 * naive "does this look sane" heuristic would misidentify that as damage
 * and yank the window off a monitor it's correctly sitting on. Only "no
 * display can show any usable part of this frame" is treated as broken.
 *
 * A display whose `workArea` has zero width or height is degenerate (can't
 * meaningfully host a centered window) and is skipped when picking the
 * repair target, including when it's the one flagged primary. If every
 * display is degenerate, or `displays` is empty, `frame` is returned
 * unchanged — there's no usable target to repair onto, and returning
 * something is worse than returning the (already known to be off-screen,
 * but at least not garbage) original.
 *
 * A degenerate *input* frame is likewise returned untouched. Electrobun's
 * `getWindowFrame` reports `{0,0,0,0}` rather than throwing when the native
 * window pointer is already gone, and a zero-area rect overlaps nothing, so
 * it would otherwise be diagnosed as "off-screen" and re-centered — turning
 * a dead handle into a live, zero-sized window. There is no width or height
 * here to preserve, so there is nothing to repair: a caller that hands us a
 * degenerate frame has a problem this function cannot fix, and inventing an
 * origin for it only hides that.
 */
export function repairFrame(frame: Rect, displays: DisplayInfo[]): Rect {
  if (frame.width <= 0 || frame.height <= 0) return frame;
  if (frameIsVisible(frame, displays)) return frame;

  const usable = displays.filter((d) => d.workArea.width > 0 && d.workArea.height > 0);
  const first = usable[0];
  if (!first) return frame;

  const target = usable.find((d) => d.isPrimary) ?? first;
  const workArea = target.workArea;

  const width = Math.max(0, Math.min(frame.width, workArea.width));
  const height = Math.max(0, Math.min(frame.height, workArea.height));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);

  return { x, y, width, height };
}
