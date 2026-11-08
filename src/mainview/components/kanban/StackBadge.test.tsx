// The card's stack chip (T15): position, pending swap, all-exhausted and the
// cooling-current-account marker. Rendered to static markup so the branch that
// App -> Column -> TaskCard plumbs (`coolingUntilMs`) is observable without a
// DOM harness.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StackBadge } from "./StackBadge.tsx";

function html(props: Parameters<typeof StackBadge>[0]): string {
  return renderToStaticMarkup(<StackBadge {...props} />);
}

describe("StackBadge", () => {
  test("no stack state renders nothing", () => {
    expect(html({ state: null })).toBe("");
    expect(html({ state: undefined })).toBe("");
  });

  test("a base badge shows the 1-based position of the total", () => {
    const markup = html({ state: { position: 1, count: 3 } });
    expect(markup).toContain('data-testid="task-card-stack-badge"');
    expect(markup).toContain("2/3");
    expect(markup).toContain("border-info/40");
    expect(markup).toContain("Account 2 of 3 — fails over to the next account at its limit");
  });

  test("a pending swap shows the switch marker and explanation", () => {
    const markup = html({ state: { position: 0, count: 2, pendingSwap: { to: "b" } } });
    expect(markup).toContain("⇄");
    expect(markup).toContain("1/2");
    expect(markup).toContain("Switching to the next account…");
  });

  test("a cooling current account marks the chip with the hourglass and the warning tone", () => {
    const until = Date.now() + 60_000;
    const markup = html({ state: { position: 1, count: 2 }, coolingUntilMs: until });
    expect(markup).toContain("⏳");
    expect(markup).toContain("2/2");
    expect(markup).toContain("border-warning/40");
    expect(markup).toContain("its current account is cooling until");
  });

  test("a past cooling instant is not cooling", () => {
    const markup = html({ state: { position: 1, count: 2 }, coolingUntilMs: Date.now() - 1_000 });
    expect(markup).not.toContain("⏳");
    expect(markup).toContain("border-info/40");
    expect(markup).not.toContain("cooling until");
  });

  test("all-exhausted with a countdown is amber and says the stack is out of quota", () => {
    const markup = html({
      state: {
        position: 0,
        count: 2,
        allExhausted: { nextAttemptAt: Date.now() + 60_000, reason: "quota", attempts: 0, max: 3 },
      },
    });
    expect(markup).not.toContain("⏳");
    expect(markup).toContain("border-warning/40");
    expect(markup).toContain("Every account in this stack is out of quota");
  });

  test("a started retry reads as in-flight, not out of quota", () => {
    const markup = html({
      state: {
        position: 0,
        count: 2,
        allExhausted: { nextAttemptAt: 0, reason: "quota", attempts: 1, max: 3 },
      },
    });
    expect(markup).toContain("⇄");
    expect(markup).toContain("border-info/40");
    expect(markup).toContain("Retrying on the next available account…");
  });

  test("no-usable-member points at Settings instead of claiming a quota wait", () => {
    const markup = html({
      state: {
        position: 0,
        count: 2,
        allExhausted: { nextAttemptAt: 0, reason: "no-usable-member", attempts: 0, max: 3 },
      },
    });
    expect(markup).toContain("No account in this stack can run this task — fix one in Settings");
    expect(markup).not.toContain("out of quota");
  });
});
