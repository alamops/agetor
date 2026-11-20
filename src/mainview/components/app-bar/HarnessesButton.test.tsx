import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessBarButton } from "@/lib/harness-bar";
import { HarnessesButton } from "./HarnessesButton.tsx";

const NOW = 1_800_000_000_000;

function button(o: Partial<HarnessBarButton> = {}): HarnessBarButton {
  return {
    dot: "success",
    enabledCount: 7,
    meter: { usedPercent: 63, stale: false, source: "stack" },
    badgeCount: 2,
    allBlocked: true,
    until: NOW + 3_600_000,
    summaryText: "7 harnesses enabled",
    ...o,
  };
}
type Props = Parameters<typeof HarnessesButton>[0];
function html(o: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    <HarnessesButton
      button={button()}
      hide={{ harnessText: false, until: false }}
      open={false}
      panelId="panel-1"
      onToggle={() => {}}
      now={NOW}
      {...o}
    />,
  );
}

describe("HarnessesButton (live)", () => {
  test("is a labelled disclosure button for the panel", () => {
    const markup = html();
    expect(markup).toContain('aria-label="Harnesses"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="panel-1"');
    expect(markup).toContain('data-testid="harnesses-button"');
    expect(markup).toContain("electrobun-webkit-app-region-no-drag");
    expect(html({ open: true })).toContain('aria-expanded="true"');
  });

  test("shows the dot, name, count, meter with its percent, badge and until", () => {
    const markup = html();
    expect(markup).toContain('data-testid="harnesses-button-dot"');
    expect(markup).toContain(">Harnesses<");
    expect(markup).toContain('data-testid="harnesses-button-count"');
    expect(markup).toContain(">7<");
    expect(markup).toContain('data-testid="harnesses-button-meter"');
    expect(markup).toContain(">63%<");
    expect(markup).toContain('data-testid="harnesses-button-badge"');
    expect(markup).toContain('data-testid="harnesses-button-until"');
    expect(markup).toContain("until ");
  });

  test("the tooltip text is the summary", () => {
    expect(html({ button: button({ summaryText: "7 harnesses enabled · Meter: 63% used on stack" }) })).toContain(
      "Meter: 63% used on stack",
    );
  });

  test("hide.harnessText drops the name, the count and the %; the meter, badge and until stay", () => {
    const markup = html({ hide: { harnessText: true, until: false } });
    expect(markup).not.toContain(">Harnesses<");
    expect(markup).not.toContain("harnesses-button-count");
    expect(markup).not.toContain(">63%<");
    expect(markup).toContain("harnesses-button-meter");
    expect(markup).toContain("harnesses-button-badge");
    expect(markup).toContain("harnesses-button-until");
  });

  test("hide.until drops only the until text", () => {
    const markup = html({ hide: { harnessText: false, until: true } });
    expect(markup).not.toContain("harnesses-button-until");
    expect(markup).toContain(">Harnesses<");
  });

  test("badge, meter and until are absent when the model has none", () => {
    const markup = html({ button: button({ badgeCount: 0, meter: null, until: null, allBlocked: false }) });
    expect(markup).not.toContain("harnesses-button-badge");
    expect(markup).not.toContain("harnesses-button-meter");
    expect(markup).not.toContain("harnesses-button-until");
    expect(markup).not.toContain("%<");
  });

  test("a zero-enabled bar still renders the button with a grey dot", () => {
    const markup = html({ button: button({ dot: "none", enabledCount: 0, meter: null, badgeCount: 0, until: null }) });
    expect(markup).toContain('data-tone="none"');
    expect(markup).toContain(">0<");
  });
});

describe("HarnessesButton (measure)", () => {
  const markup = html({ measure: true, hide: { harnessText: true, until: true } });

  test("renders everything regardless of hide, with the fit parts tagged", () => {
    expect(markup).toContain(">Harnesses<");
    expect(markup).toContain(">63%<");
    expect(markup).toContain("until ");
    expect((markup.match(/data-fit-part="harness-text"/g) ?? []).length).toBe(3);
    expect((markup.match(/data-fit-part="until"/g) ?? []).length).toBe(1);
  });

  test("has no test id, accessible name, popup, id or control", () => {
    expect(markup).not.toContain("data-testid");
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain("aria-haspopup");
    expect(markup).not.toContain("aria-controls");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain(' id="');
    expect(markup).not.toContain('role="img"');
  });
});
