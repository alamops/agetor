import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarMeter } from "./BarMeter.tsx";

const html = (p: Parameters<typeof BarMeter>[0]) => renderToStaticMarkup(<BarMeter {...p} />);

describe("BarMeter", () => {
  test("the tier color follows the 70 / 90 thresholds", () => {
    expect(html({ usedPercent: 69 })).toContain("bg-success");
    expect(html({ usedPercent: 70 })).toContain("bg-warning");
    expect(html({ usedPercent: 89 })).toContain("bg-warning");
    expect(html({ usedPercent: 90 })).toContain("bg-danger");
  });

  test("the fill width is the percent, clamped to 0..100 and 0 for a non-finite value", () => {
    expect(html({ usedPercent: 42 })).toContain("width:42%");
    expect(html({ usedPercent: 150 })).toContain("width:100%");
    expect(html({ usedPercent: -5 })).toContain("width:0%");
    expect(html({ usedPercent: Number.NaN })).toContain("width:0%");
  });

  test("a stale snapshot is dimmed; a fresh one is not", () => {
    expect(html({ usedPercent: 10, stale: true })).toContain("opacity-60");
    expect(html({ usedPercent: 10 })).not.toContain("opacity-60");
  });

  test("it is decorative (aria-hidden) and can carry a test id", () => {
    const markup = html({ usedPercent: 10, "data-testid": "m" });
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-testid="m"');
  });
});
