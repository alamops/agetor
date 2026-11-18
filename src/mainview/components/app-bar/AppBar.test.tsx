// The app bar's static contract: unique live locators (the measurement ghost
// adds none), the drag-region and pinned-chrome classes, and unchanged
// accessible names. Rendered to static markup (the StackBadge.test.tsx
// pattern); the measured collapse itself is covered by app-bar-fit.test.ts and
// e2e/app-bar.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentStatus, Harness, HarnessStack, Task } from "../../../shared/types.ts";
import { AppBar, type AppBarProps } from "./AppBar.tsx";

const harness = (id: string): Harness => ({ id, kind: "claude-code", label: id, isBuiltin: false, home: null, bin: null, env: {}, enabled: true });
const status = (id: string): AgentStatus =>
  ({ harnessId: id, kind: "claude-code", bin: "claude", available: true, path: "/bin/claude", version: "1", reason: null, installHint: null, account: null, usage: null, loggedIn: null, authHelp: null }) as AgentStatus;
const stack: HarnessStack = {
  id: "s1",
  label: "s1 label",
  kind: "claude-code",
  mirrorMode: "safe",
  members: ["acct-a", "acct-b"].map((h, i) => ({ harnessId: h, position: i, label: h, kind: "claude-code" as const, enabled: true })),
  createdAt: 0,
  updatedAt: 0,
  warnings: [],
};
const noop = () => {};

function props(o: Partial<AppBarProps> = {}): AppBarProps {
  const ids = ["acct-a", "acct-b", "acct-c"];
  return {
    agents: ids.map(status),
    harnesses: ids.map(harness),
    stacks: [stack],
    limitStates: [],
    usage: {},
    tasks: [] as Task[],
    pipelinesActive: false,
    dismissNonce: 0,
    onOpenGit: noop,
    onOpenImportSessions: noop,
    onOpenWorktrees: noop,
    onOpenPipelines: noop,
    onOpenSettings: noop,
    onOpenHarnessSettings: noop,
    onOpenStackHistory: noop,
    onOpenFailoverTask: noop,
    onRefreshUsage: async () => {},
    ...o,
  };
}
const markup = (o: Partial<AppBarProps> = {}) => renderToStaticMarkup(<AppBar {...props(o)} />);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("AppBar", () => {
  const html = markup();

  test("every live test id appears exactly once: the measurement ghost adds none", () => {
    for (const id of ["app-bar", "harnesses-button", "pipelines-button", "import-claude-sessions-open"]) {
      expect(count(html, `data-testid="${id}"`)).toBe(1);
    }
  });

  test("the ghost is hidden from assistive tech and inert", () => {
    const ghostAt = html.indexOf("data-app-bar-ghost");
    expect(ghostAt).toBeGreaterThan(0);
    const ghost = html.slice(html.lastIndexOf("<div", ghostAt), html.indexOf("</header>"));
    expect(ghost).toContain('aria-hidden="true"');
    expect(ghost).toContain("inert");
    expect(ghost).not.toContain("data-testid");
    expect(ghost).not.toContain("aria-label");
    expect(ghost).not.toContain("<button");
    expect(ghost).toContain('data-fit-part="wordmark"');
    expect(ghost).toContain('data-fit-part="import"');
    expect(ghost).toContain('data-fit-part="more"');
    expect(ghost).toContain('data-fit-part="harness-text"');
  });

  test("the header is a pinned 40 px drag region with the 80 px traffic-light inset", () => {
    // React hoists the logo's preload <link> in front of the header.
    const start = html.indexOf("<header");
    expect(start).toBeGreaterThanOrEqual(0);
    const header = html.slice(start, html.indexOf(">", start));
    expect(header).toContain("electrobun-webkit-app-region-drag");
    expect(header).toContain("h-[40px]");
    expect(header).toContain("pl-[80px]");
    expect(header).toContain("overflow-x-clip");
    expect(header).toContain('data-fit-step="0"');
  });

  test("only controls carry no-drag, never a wrapper div", () => {
    for (const m of html.matchAll(/<(\w+)\b[^>]*electrobun-webkit-app-region-no-drag[^>]*>/g)) {
      expect(m[1]).toBe("button");
    }
    // Git, Import, Worktrees, Pipelines, Settings and the Harnesses button.
    expect(count(html, "electrobun-webkit-app-region-no-drag")).toBe(6);
  });

  test("step 0 shows the wordmark and the Import button; More is not rendered live", () => {
    expect(html).toContain("<h1");
    expect(html).toContain(">Agetor<");
    expect(html).toContain('aria-label="Import Claude Code sessions and OpenCode sessions"');
    expect(html).not.toContain('data-testid="app-bar-more"');
  });

  test("accessible names are unchanged", () => {
    for (const name of ["Git", "Import Claude Code sessions and OpenCode sessions", "Worktrees", "Pipelines", "Settings", "Harnesses"]) {
      expect(html).toContain(`aria-label="${name}"`);
    }
  });

  test("icon boxes are px-pinned so UI zoom cannot grow the bar", () => {
    expect(html).toContain("h-[32px]");
    expect(html).toContain("w-[32px]");
    expect(html).toContain("size-[28px]");
  });

  test("the Pipelines button reads as pressed on the Pipelines page", () => {
    const on = markup({ pipelinesActive: true });
    const button = on.slice(on.indexOf('data-testid="pipelines-button"') - 400, on.indexOf('data-testid="pipelines-button"'));
    expect(button).toContain("bg-secondary");
    const off = markup();
    const offButton = off.slice(off.indexOf('data-testid="pipelines-button"') - 400, off.indexOf('data-testid="pipelines-button"'));
    expect(offButton).not.toContain("bg-secondary");
  });

  test("the panel is closed on first render", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="harnesses-panel"');
  });

  test("with nothing enabled it still renders the bar and a grey dot", () => {
    const empty = markup({ agents: [], harnesses: [], stacks: [] });
    expect(empty).toContain('data-testid="harnesses-button"');
    expect(empty).toContain('data-tone="none"');
  });
});
