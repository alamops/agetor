// WCAG contrast of the token pairs the launch surfaces rely on, in BOTH themes
// (docs/architecture/task-launch-ui.md). Parses the HSL custom properties out of index.css, so a
// token edit that breaks a pair fails here instead of in a screenshot review.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.join(import.meta.dir, "index.css"), "utf8");

/** The declarations of the first top-level `selector { … }` block in index.css. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in index.css`);
  const end = css.indexOf("\n  }", start);
  const body = css.slice(start, end);
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.replace(/\/\*.*?\*\//g, "").trim();
  return vars;
}

function hslToRgb(token: string): [number, number, number] {
  const m = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(token);
  if (!m) throw new Error(`not an HSL triplet: ${token}`);
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const x = ((t % 1) + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return s === 0 ? [l, l, l] : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hslToRgb(a));
  const lb = luminance(hslToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const THEMES: Array<[string, Record<string, string>]> = [
  ["light", block(":root")],
  ["dark", block(".dark")],
];

// Text-on-background pairs (AA, 4.5:1).
const TEXT_PAIRS: Array<[string, string]> = [
  ["foreground", "card"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["primary-foreground", "primary"],
  ["danger", "card"], // the new error / invalid text
  ["warning", "card"],
  ["success", "card"],
  ["info", "card"],
];

describe("launch contrast", () => {
  for (const [theme, vars] of THEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      test(`${theme}: ${fg} on ${bg} is at least 4.5:1`, () => {
        const ratio = contrast(vars[fg]!, vars[bg]!);
        expect(Number.isFinite(ratio)).toBe(true);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
    test(`${theme}: the selected ring (primary) against the card is at least 3:1`, () => {
      expect(contrast(vars["primary"]!, vars["card"]!)).toBeGreaterThanOrEqual(3);
    });
  }
});
