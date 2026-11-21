// Static-markup contract of the launch picker family: roles, test ids, the status
// dot's tone, and "no native <select>" (docs/architecture/task-launch-ui.md).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessPicker, StatusDot } from "./HarnessPicker.tsx";
import { ModeControl, ModeVariantPicker } from "./ModeControl.tsx";
import { SpeedPicker } from "./SpeedPicker.tsx";
import { TaskTypePicker } from "./TaskTypePicker.tsx";
import { AgentProfilePicker } from "./AgentProfilePicker.tsx";
import { PipelinePicker } from "../pipelines/PipelinePicker.tsx";
import type { AgentStatus, Harness } from "../../../shared/types.ts";

const harnesses = [
  { id: "claude-code", label: "Claude Code", kind: "claude-code", enabled: true },
  { id: "codex", label: "Codex", kind: "codex", enabled: true },
] as unknown as Harness[];
const agents = [{ harnessId: "claude-code", available: true, loggedIn: true, kind: "claude-code" }] as unknown as AgentStatus[];

describe("HarnessPicker", () => {
  const html = renderToStaticMarkup(
    <HarnessPicker
      value="claude-code"
      onChange={() => {}}
      harnesses={harnesses}
      agents={agents}
      stacks={[]}
      statusTone={(id) => (id === "claude-code" ? "ok" : "unknown")}
    />,
  );
  test("is a listbox trigger with the pinned test ids and no <select>", () => {
    expect(html).toContain('data-testid="launch-harness-picker"');
    expect(html).toContain('data-testid="launch-harness-picker-trigger"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('data-value="claude-code"');
    expect(html).not.toContain("<select");
  });
  test("shows the FULL label and the selected harness's status dot", () => {
    expect(html).toContain("Claude Code");
    expect(html).toContain('data-testid="launch-harness-status"');
    expect(html).toContain('data-tone="ok"');
  });
  test("an unknown status renders the muted 'Checking status…' dot, never a red one", () => {
    const dot = renderToStaticMarkup(<StatusDot tone="unknown" />);
    expect(dot).toContain('data-tone="unknown"');
    expect(dot).toContain("Checking status…");
    expect(dot).not.toContain("bg-danger-solid");
    expect(renderToStaticMarkup(<StatusDot tone="error" />)).toContain("bg-danger-solid");
    expect(renderToStaticMarkup(<StatusDot tone="warn" />)).toContain("bg-warning-solid");
  });
});

describe("ModeControl", () => {
  test("renders a Code | Plan radiogroup exposing the exact mode", () => {
    const html = renderToStaticMarkup(
      <ModeControl kind="claude-code" mode="acceptEdits" primary="code" onModeChange={() => {}} />,
    );
    expect(html).toContain('data-testid="launch-mode"');
    expect(html).toContain('data-mode="acceptEdits"');
    expect(html).toContain('data-testid="launch-mode-code"');
    expect(html).toContain('data-testid="launch-mode-plan"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/data-testid="launch-mode-code"[^>]*/);
    expect(html).toContain("Plan only — agent describes what it would do");
  });
  test("the variant picker is a listbox trigger", () => {
    const html = renderToStaticMarkup(
      <ModeVariantPicker mode="auto" variants={[{ id: "auto", label: "Auto" }, { id: "ask", label: "Ask" }] as never} onModeChange={() => {}} />,
    );
    expect(html).toContain('data-testid="launch-mode-variant-picker-trigger"');
    expect(html).toContain("Auto");
  });
});

describe("SpeedPicker / TaskTypePicker", () => {
  test("Speed is a radiogroup with `${testId}-${tier}` radios and keeps its stale '(not offered)' tier", () => {
    const html = renderToStaticMarkup(<SpeedPicker testId="launch-speed" options={["off", "fast"]} value="ultrafast" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-testid="launch-speed"');
    expect(html).toContain('data-testid="launch-speed-off"');
    expect(html).toContain('data-testid="launch-speed-fast"');
    expect(html).toContain('data-testid="launch-speed-ultrafast"');
    expect(html).toContain("(not offered)");
    expect(html).not.toContain("aria-pressed");
  });
  test("Speed renders nothing for a lone Off", () => {
    expect(renderToStaticMarkup(<SpeedPicker testId="launch-speed" options={["off"]} value="off" onChange={() => {}} />)).toBe("");
  });
  test("Type is a labelled radiogroup of Task / Bug / Spike", () => {
    const html = renderToStaticMarkup(<TaskTypePicker value="bug" onChange={() => {}} />);
    expect(html).toContain('data-testid="task-type-picker"');
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)?.length).toBe(3);
    expect(html).toContain("Bug");
    const labelId = /aria-labelledby="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`id="${labelId}"`);
  });
});

describe("AgentProfilePicker / PipelinePicker (on Picker)", () => {
  test("keep their part test ids on the root and trigger", () => {
    const profile = renderToStaticMarkup(
      <AgentProfilePicker value={null} onChange={() => {}} profiles={[]} harnesses={harnesses} onManage={() => {}} />,
    );
    expect(profile).toContain('data-testid="agent-profile-picker"');
    expect(profile).toContain('data-testid="agent-profile-picker-trigger"');
    expect(profile).toContain("No agent — pick harness manually");
    expect(profile).not.toContain("agent-profile-picker-clear");
    const pipeline = renderToStaticMarkup(<PipelinePicker value={null} onChange={() => {}} pipelines={[]} />);
    expect(pipeline).toContain('data-testid="pipeline-picker"');
    expect(pipeline).toContain('data-testid="pipeline-picker-trigger"');
    expect(pipeline).toContain("No pipeline");
  });
  test("a stale selection shows the warning row and a clear control", () => {
    const profile = renderToStaticMarkup(
      <AgentProfilePicker value="gone" onChange={() => {}} profiles={[]} harnesses={harnesses} />,
    );
    expect(profile).toContain("Selected agent is no longer available");
    expect(profile).toContain('data-testid="agent-profile-picker-clear"');
  });
});
