// RunPanel's "Switch to next account" control (review N7): an archived task
// offers no switch (the core refuses it with `archived`), while a switch still
// scheduled on one keeps its Cancel. Rendered to static markup, like
// StackBadge.test.tsx, since there is no DOM harness.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SwitchAccountControl } from "./RunPanel.tsx";
import type { Harness, HarnessStack, Task } from "../../../shared/types.ts";

const stack: HarnessStack = {
  id: "stk", label: "Train", kind: "claude-code", mirrorMode: "full",
  members: [
    { harnessId: "a", position: 0, label: "A", kind: "claude-code", enabled: true },
    { harnessId: "b", position: 1, label: "B", kind: "claude-code", enabled: true },
  ],
  createdAt: 1, updatedAt: 1, warnings: [],
} as HarnessStack;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", title: "T", prompt: "", column: "review", agent: "a", workdir: "/tmp/x", isolation: "none",
    ...over,
  } as Task;
}

const scheduledState = {
  stackId: "stk", position: 0, tried: [], pendingSwap: null, lastMove: null, allExhausted: null,
  scheduledSwitch: { requestedAt: 1 },
} as unknown as Task["harnessState"];

function html(t: Task): string {
  return renderToStaticMarkup(<SwitchAccountControl task={t} stacks={[stack]} harnesses={[] as Harness[]} />);
}

describe("SwitchAccountControl", () => {
  test("a live stacked task offers the switch", () => {
    expect(html(task())).toContain('data-testid="switch-account-button"');
  });

  test("an archived task offers no switch", () => {
    expect(html(task({ archivedAt: 123 }))).toBe("");
  });

  test("an archived task with a switch still scheduled shows it with Cancel, never the switch button", () => {
    const markup = html(task({ archivedAt: 123, harnessState: scheduledState }));
    expect(markup).toContain('data-testid="switch-account-scheduled"');
    expect(markup).toContain('data-testid="switch-account-cancel"');
    expect(markup).not.toContain('data-testid="switch-account-button"');
  });

  test("a task outside any stack shows nothing", () => {
    expect(html(task({ agent: "elsewhere" }))).toBe("");
  });
});
