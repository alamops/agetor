// The picker VIEW's static contract (docs/architecture/task-launch-ui.md): every pinned
// test id in the sections layout, the flat layout without a disclosure, no native <select>,
// and the rule that picks change ONLY through the hook's tracked setters.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskLaunchPickers, type TaskLaunch } from "./TaskLaunchPickers.tsx";
import { buildModelOptions, effortOptionsFor, speedOptionsFor } from "../../../shared/model-catalog.ts";
import { supportedModes, type AgentKind, type AgentStatus, type Harness } from "../../../shared/types.ts";
import { codeVariants } from "@/lib/launch-state";

const noop = () => {};

function fakeLaunch(over: Partial<TaskLaunch> = {}, kind: AgentKind = "cursor"): TaskLaunch {
  const harness = { id: kind, label: "Cursor", kind, enabled: true } as unknown as Harness;
  const status = { harnessId: kind, kind, available: true, loggedIn: true, reason: null, installHint: null } as unknown as AgentStatus;
  const model = kind === "cursor" ? "composer-2" : "m";
  const models = buildModelOptions(kind, { discovered: [], selected: model });
  return {
    loading: false, loadError: null, harnesses: [harness], stacks: [], availableHarnesses: [harness], agents: [status],
    agentModels: {} as never, harnessModels: {}, agent: kind, kind, selectedStatus: status,
    mode: "auto", model, effort: null, speed: "off", maxMode: false,
    setSpeed: noop, setMaxMode: noop, speedOptions: speedOptionsFor(kind, model, null, models), maxModeAvailable: true,
    models, modes: supportedModes(kind, model), efforts: effortOptionsFor(kind, model, models),
    setMode: noop, setModel: noop, setEffort: noop, switchAgent: noop, rememberPicks: noop,
    agentProfileId: null, setAgentProfileId: noop, profiles: [], selectedProfile: null, refreshProfiles: async () => {},
    effectiveKind: kind, effectiveAgent: kind, effectiveStatus: status, effectiveStackFallback: false, effectiveLaunchable: true,
    withPipelines: true, pipelines: [], pipelinesLoaded: true, pipelinesLoading: false, pipelinesError: null,
    pipelineId: null, setPipelineId: noop, selectedPipeline: null, pipelineState: "no-pipeline", pipelineProblem: null,
    pipelineReady: true, pipelineStartProfile: null, overageKind: kind, overageLabel: "Cursor", seed: noop,
    refreshModels: async () => {}, refreshingModels: false, profilesLoaded: true, primaryMode: "code",
    codeVariants: codeVariants(kind, model), statusTone: () => "ok",
    ...over,
  } as TaskLaunch;
}

describe("TaskLaunchPickers — sections layout", () => {
  const html = renderToStaticMarkup(
    <TaskLaunchPickers launch={fakeLaunch()} layout="sections" surface="panel" onManageProfiles={noop} onManagePipelines={noop} />,
  );
  test("renders the Agent section with every pinned frequent-field id", () => {
    for (const id of [
      "launch-section-agent",
      "launch-section-agent-toggle",
      "launch-pipeline-picker",
      "agent-profile-picker",
      "launch-harness-picker",
      "launch-model-picker",
      "launch-refresh-models",
      "launch-effort-picker",
      "launch-more-agent",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });
  test("the Agent picker sits right under Pipeline, above Harness", () => {
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("launch-pipeline-picker")).toBeLessThan(at("agent-profile-picker"));
    expect(at("agent-profile-picker")).toBeLessThan(at("launch-harness-picker"));
  });
  test("Code | Plan sits behind the closed More options", () => {
    expect(html).not.toContain('data-testid="launch-mode"');
  });
  test("a Plan pick is announced on the closed More options row", () => {
    const plan = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ mode: "plan", primaryMode: "plan" })} layout="sections" surface="panel" />,
    );
    expect(plan).toContain("Mode: Plan");
  });
  test("has no native <select> and no aria-pressed segments", () => {
    expect(html).not.toContain("<select");
    expect(html).not.toContain("aria-pressed");
  });
  test("every field has an associated label", () => {
    for (const name of ["Pipeline", "Agent", "Harness", "Model", "Effort"]) expect(html).toContain(`>${name}</`);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*id="[^"]*harness-label"|<label[^>]*id="[^"]*harness-label"[^>]*for=/);
  });
});

describe("TaskLaunchPickers — flat layout", () => {
  test("renders the same fields with no section and no More options disclosure", () => {
    const html = renderToStaticMarkup(<TaskLaunchPickers launch={fakeLaunch()} layout="flat" hideProfilePicker />);
    expect(html).not.toContain("launch-more-agent");
    expect(html).not.toContain("launch-section-agent");
    expect(html).toContain('data-testid="launch-harness-picker"');
    expect(html).toContain('data-testid="launch-model-picker"');
    expect(html).not.toContain("<select");
  });
  test("keeps Code | Plan inline between Harness and Model", () => {
    const html = renderToStaticMarkup(<TaskLaunchPickers launch={fakeLaunch()} layout="flat" hideProfilePicker />);
    expect(html.indexOf("launch-harness-picker")).toBeLessThan(html.indexOf('data-testid="launch-mode"'));
    expect(html.indexOf('data-testid="launch-mode"')).toBeLessThan(html.indexOf("launch-model-picker"));
  });
  test("Speed and Max Mode render inline for a cursor model that offers them", () => {
    const html = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ speedOptions: ["off", "fast"], speed: "fast", maxMode: true })} layout="flat" hideProfilePicker />,
    );
    expect(html).toContain('data-testid="launch-speed"');
    expect(html).toContain('data-testid="launch-max-mode-toggle"');
  });
});

describe("TaskLaunchPickers — hints", () => {
  test("an unavailable harness shows the hint directly after the picker", () => {
    const bad = { harnessId: "cursor", kind: "cursor", available: false, reason: "cursor-agent not found", installHint: "brew install cursor" } as unknown as AgentStatus;
    const html = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ agents: [bad], selectedStatus: bad, effectiveStatus: bad, effectiveLaunchable: false })} layout="flat" hideProfilePicker />,
    );
    expect(html).toContain('data-testid="launch-agent-unavailable-hint"');
    expect(html).toContain("cursor-agent not found");
    expect(html.indexOf("launch-harness-picker")).toBeLessThan(html.indexOf("launch-agent-unavailable-hint"));
    expect(html.indexOf("launch-agent-unavailable-hint")).toBeLessThan(html.indexOf("launch-mode"));
  });
  test("a Fable model shows the 2x usage note", () => {
    const html = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ kind: "claude-code", agent: "claude-code", model: "fable-5.2" })} layout="flat" hideProfilePicker />,
    );
    expect(html).toContain('data-testid="launch-usage-note"');
    expect(html).toContain("uses 2x the usage of Opus");
  });
  test("the pipeline loading, error and empty hints each render in the one place the picker points at", () => {
    const hintsId = (html: string) => html.match(/aria-describedby="([^"]*pipeline-description)"/)?.[1];
    const loading = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ pipelinesLoading: true, pipelinesLoaded: false })} layout="flat" hideProfilePicker />,
    );
    expect(loading).toContain('data-testid="launch-pipelines-loading"');
    const error = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ pipelinesError: "boom", pipelinesLoaded: false })} layout="flat" hideProfilePicker />,
    );
    expect(error).toContain('data-testid="launch-pipelines-error"');
    expect(error).toContain("boom");
    const empty = renderToStaticMarkup(<TaskLaunchPickers launch={fakeLaunch()} layout="flat" hideProfilePicker />);
    expect(empty).toContain("No pipelines yet");
    for (const html of [loading, error, empty]) {
      const id = hintsId(html);
      expect(id).toBeDefined();
      expect(html).toContain(`id="${id}"`);
    }
  });
  test("each field's help text is named by its control's aria-describedby", () => {
    const html = renderToStaticMarkup(
      <TaskLaunchPickers launch={fakeLaunch({ kind: "claude-code", agent: "claude-code", model: "fable-5.2" })} layout="flat" hideProfilePicker />,
    );
    for (const suffix of ["harness-description", "model-description", "pipeline-description"]) {
      const id = html.match(new RegExp(`aria-describedby="([^"]*${suffix})"`))?.[1];
      expect({ suffix, id: id !== undefined }).toEqual({ suffix, id: true });
      expect(html).toContain(`id="${id}"`);
    }
  });
});

describe("tracked setters only", () => {
  const dir = path.join(import.meta.dir);
  const files = ["TaskLaunchPickers.tsx", "HarnessPicker.tsx", "ModeControl.tsx"].map((f) => readFileSync(path.join(dir, f), "utf8"));
  // The eight setters Settings → Agents' dirtiness tracker wraps (lib/agent-profile-form.ts), plus the
  // two selection setters the form hides.
  const ALLOWED = new Set(["switchAgent", "setMode", "setModel", "setEffort", "setSpeed", "setMaxMode", "setAgentProfileId", "setPipelineId"]);
  test("every launch.<setter> call is one of the allowed tracked setters", () => {
    const used = new Set<string>();
    for (const src of files) for (const m of src.matchAll(/\blaunch\.(set\w+|switchAgent|seed)\b/g)) used.add(m[1]!);
    expect([...used].filter((n) => !ALLOWED.has(n))).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });
  test("nothing reaches around the hook (no setPrimaryMode, no raw state setters)", () => {
    for (const src of files) {
      expect(src).not.toContain("setPrimaryMode");
      expect(src).not.toMatch(/\blaunch\.seed\(/);
    }
  });
});
