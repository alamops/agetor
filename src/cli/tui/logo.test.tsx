import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Logo, LOGO_LINES, LOGO_WIDTH } from "./logo.tsx";

test("LOGO_LINES use only full-block + space (width-safe) — no wide glyphs", () => {
  for (const line of LOGO_LINES) expect(/^[█ ]+$/.test(line)).toBe(true);
  expect(LOGO_LINES).toHaveLength(5);
  expect(LOGO_WIDTH).toBe(Math.max(...LOGO_LINES.map((l) => l.length)));
});

test("Logo renders its block rows", () => {
  const frame = render(<Logo />).lastFrame() ?? "";
  expect(frame).toContain("█████"); // a recognizable run from the banner
  expect(frame.split("\n").length).toBeGreaterThanOrEqual(5);
});
