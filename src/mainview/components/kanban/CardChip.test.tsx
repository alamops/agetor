import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot } from "lucide-react";
import { readFileSync } from "node:fs";
import { CardChip, CardStat } from "./CardChip.tsx";

describe("CardChip", () => {
  test("carries the chip system classes", () => {
    const m = renderToStaticMarkup(<CardChip tone="info">x</CardChip>);
    for (const c of ["h-5", "rounded-full", "text-[10px]", "px-2", "whitespace-nowrap", "min-w-0", "max-w-full", "border-info/40", "text-info"]) {
      expect(m).toContain(c);
    }
    expect(m).not.toContain("shrink-0");
  });

  test("each tone maps to its semantic token, never a literal palette class", () => {
    const tones = { neutral: "border-border", info: "border-info/40", warning: "border-warning/40", success: "border-success/40" } as const;
    for (const [tone, cls] of Object.entries(tones)) {
      const m = renderToStaticMarkup(<CardChip tone={tone as keyof typeof tones}>x</CardChip>);
      expect(m).toContain(cls);
      expect(m).not.toMatch(/(amber|rose|emerald|red|green)-\d/);
    }
  });

  test("passes title, test id and a caller's className through", () => {
    const m = renderToStaticMarkup(<CardChip tone="warning" title="why" data-testid="chip" className="font-sans">x</CardChip>);
    expect(m).toContain('title="why"');
    expect(m).toContain('data-testid="chip"');
    expect(m).toContain("font-sans");
  });
});

describe("CardStat", () => {
  test("renders icon and text with no border", () => {
    const m = renderToStaticMarkup(<CardStat icon={Bot} title="3 background tasks running">3</CardStat>);
    expect(m).toContain("<svg");
    expect(m).toContain(">3<");
    expect(m).toContain("tabular-nums");
    expect(m).not.toContain("border");
    expect(m).toContain('title="3 background tasks running"');
  });
});

describe("--warning-solid-foreground token", () => {
  test("is defined in both themes and in the Tailwind config", () => {
    const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    expect(css.match(/--warning-solid-foreground:/g)?.length).toBe(2);
    const cfg = readFileSync(new URL("../../../../tailwind.config.js", import.meta.url), "utf8");
    expect(cfg).toContain('"warning-solid-foreground"');
  });
});
