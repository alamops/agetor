import { useEffect, useState } from "react";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");

/**
 * Braille spinner frame. Ticks on its own ~12fps timer and ONLY while `active`,
 * so an idle dashboard does no work (the anti-lag rule: animation decoupled
 * from data, zero CPU when nothing is running).
 */
export function useSpinner(active: boolean, fps = 12): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 1000 / fps);
    return () => clearInterval(id);
  }, [active, fps]);
  return FRAMES[i] ?? FRAMES[0]!;
}
