import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Logo, LOGO_WIDE, LOGO_COMPACT, logoFor } from "./logo.tsx";

test("both logo variants use only block / half-block + space (width-safe)", () => {
  for (const line of [...LOGO_WIDE, ...LOGO_COMPACT]) {
    expect(/^[█▀▄ ]+$/.test(line)).toBe(true);
  }
  expect(LOGO_WIDE).toHaveLength(5);
  expect(LOGO_COMPACT).toHaveLength(2);
});

test("logoFor picks the widest variant that fits, else null", () => {
  expect(logoFor(200)).toBe(LOGO_WIDE); // plenty of room → bold
  expect(logoFor(30)).toBe(LOGO_COMPACT); // too narrow for bold, fits the compact
  expect(logoFor(10)).toBeNull(); // too narrow for either → caller shows plain text
});

test("Logo renders the bold banner when the pane is wide", () => {
  const frame = render(<Logo maxWidth={200} />).lastFrame() ?? "";
  expect(frame).toContain("█████");
});
