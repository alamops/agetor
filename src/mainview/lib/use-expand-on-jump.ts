import { useEffect, type RefObject } from "react";
import { EXPAND_EVENT, expandDetailOf, isExpandTargetFor, type ExpandOnJumpDetail } from "./expand-on-jump";

/** Listens for the search-jump `EXPAND_EVENT` bubbling up from the matched
 *  `[data-evid]` element (see RunPanel's highlight effect) and calls
 *  `onExpand` when `root` is (or contains) the element that dispatched it —
 *  the imperative counterpart to that effect, so a jump onto a match inside
 *  a collapsed tool-call card / result fold / thinking block / compaction
 *  summary reveals it without threading new props through the `blocks` memo.
 *  `onExpand` receives the jump's {@link ExpandOnJumpDetail} (the matched
 *  query, when the dispatcher sent one); a callback that takes no arguments
 *  keeps working unchanged. */
export function useExpandOnJump(
  rootRef: RefObject<HTMLDivElement | null>,
  onExpand: (detail: ExpandOnJumpDetail) => void,
) {
  useEffect(() => {
    const handler = (evt: Event) => {
      if (isExpandTargetFor(evt.target, rootRef.current)) onExpand(expandDetailOf(evt));
    };
    document.addEventListener(EXPAND_EVENT, handler);
    return () => document.removeEventListener(EXPAND_EVENT, handler);
  }, [rootRef, onExpand]);
}
