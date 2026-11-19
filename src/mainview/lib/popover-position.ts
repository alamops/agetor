/**
 * Pure placement math for a portaled `fixed` popover (`ui/picker.tsx`): choose
 * above or below the trigger, then clamp the box inside the viewport.
 */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopoverPlacement {
  side: "above" | "below";
  top: number;
  left: number;
  width: number;
  /** The max height the popover may use on the chosen side. */
  maxHeight: number;
}

export const VIEWPORT_MARGIN = 8;
const GAP = 4;

/**
 * Place a popover of `popoverHeight` against `trigger`.
 *
 * It opens below unless there isn't room for it there and there is more room
 * above. The box is at least as wide as the trigger, never wider than the
 * viewport minus the margins, and is shifted left to stay `VIEWPORT_MARGIN`
 * px inside the right edge.
 */
export function placePopover(opts: {
  trigger: Box;
  popoverHeight: number;
  popoverWidth?: number;
  viewportWidth: number;
  viewportHeight: number;
  /** The side to prefer when both fit (default "below"). */
  prefer?: "above" | "below";
}): PopoverPlacement {
  const { trigger, viewportWidth, viewportHeight } = opts;
  const prefer = opts.prefer ?? "below";
  const spaceBelow = viewportHeight - (trigger.top + trigger.height) - GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - GAP - VIEWPORT_MARGIN;
  const fitsBelow = opts.popoverHeight <= spaceBelow;
  const fitsAbove = opts.popoverHeight <= spaceAbove;
  const first = prefer;
  const second = prefer === "below" ? "above" : "below";
  const fits = { below: fitsBelow, above: fitsAbove };
  const space = { below: spaceBelow, above: spaceAbove };
  // The preferred side if the popover fits there, else the other side if it
  // fits, else whichever side has more room (the popover then scrolls).
  const side: "above" | "below" = fits[first]
    ? first
    : fits[second]
      ? second
      : space[first] >= space[second]
        ? first
        : second;

  const room = Math.max(0, side === "below" ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(opts.popoverHeight, room);

  const maxWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const width = Math.min(Math.max(trigger.width, opts.popoverWidth ?? 0), maxWidth);
  const maxLeft = viewportWidth - VIEWPORT_MARGIN - width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, maxLeft));
  const top = side === "below" ? trigger.top + trigger.height + GAP : trigger.top - GAP - maxHeight;
  return { side, top: Math.max(VIEWPORT_MARGIN, top), left, width, maxHeight };
}

/**
 * The height a popover panel needs for all of its content, measured while it
 * may already be clamped. The panel's list is the part that scrolls, so a
 * panel capped by an earlier `maxHeight` reports that cap as its own
 * `scrollHeight`; re-measuring it after rows arrive would keep it at the old
 * size forever. Adding back what the list hides (its content past its current
 * box, itself limited to `maxListHeight`) gives the uncapped height. With
 * nothing clipped this is exactly `panelScrollHeight`.
 */
export function naturalPopoverHeight(m: {
  panelScrollHeight: number;
  listClientHeight: number;
  listScrollHeight: number;
  maxListHeight: number;
}): number {
  const listNatural = Math.min(m.listScrollHeight, m.maxListHeight);
  return m.panelScrollHeight + Math.max(0, listNatural - m.listClientHeight);
}
