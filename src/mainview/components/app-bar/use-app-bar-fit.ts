import { useLayoutEffect, useState, type RefObject } from "react";
import { chooseFitStep, type AppBarPartWidths, type AppBarStep } from "@/lib/app-bar-fit";

type PartName = "wordmark" | "import" | "more" | "harness-text" | "until";

/** Σ of the widths of every `[data-fit-part=name]` in `ghost`, each plus the
 *  `column-gap` of its parent flex row: the room the part frees when hidden. */
function partWidth(ghost: HTMLElement, name: PartName): number {
  let total = 0;
  for (const el of ghost.querySelectorAll<HTMLElement>(`[data-fit-part="${name}"]`)) {
    total += el.getBoundingClientRect().width;
    const parent = el.parentElement;
    if (parent) {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap);
      if (Number.isFinite(gap)) total += gap;
    }
  }
  return total;
}

function measureParts(ghost: HTMLElement): AppBarPartWidths {
  // The ghost always carries a More replica (it is a step-2 part), but step 0
  // does not show it, so it is not part of the full width.
  const more = partWidth(ghost, "more");
  return {
    full: ghost.scrollWidth - more,
    wordmark: partWidth(ghost, "wordmark"),
    importAction: partWidth(ghost, "import"),
    more,
    harnessText: partWidth(ghost, "harness-text"),
    until: partWidth(ghost, "until"),
  };
}

/**
 * The collapse step of the app bar, from measurement.
 *
 * `ghostRef` is an inert, invisible copy of the bar at step 0, so what is
 * measured never depends on the step that is rendered and the fit cannot
 * oscillate. `headerRef`'s content width (its box minus padding) is what the
 * bar can use. Two `ResizeObserver`s (header, ghost) re-measure on a window
 * resize, a UI-zoom change (the ghost's width scales) and a content change
 * (a badge appears, a count gains a digit). Observers are created in a layout
 * effect and disconnected on cleanup, so React StrictMode's double mount
 * leaves exactly one pair.
 */
export function useAppBarFit(
  headerRef: RefObject<HTMLElement | null>,
  ghostRef: RefObject<HTMLElement | null>,
): AppBarStep {
  const [step, setStep] = useState<AppBarStep>(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const ghost = ghostRef.current;
    if (!header || !ghost) return;
    let previous: AppBarStep = 0;
    const update = () => {
      const cs = getComputedStyle(header);
      const available =
        header.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0);
      const next = chooseFitStep(available, measureParts(ghost), previous);
      if (next === previous) return;
      previous = next;
      setStep(next);
    };
    update();
    const headerObserver = new ResizeObserver(update);
    const ghostObserver = new ResizeObserver(update);
    headerObserver.observe(header);
    ghostObserver.observe(ghost);
    return () => {
      headerObserver.disconnect();
      ghostObserver.disconnect();
    };
  }, [headerRef, ghostRef]);

  return step;
}
