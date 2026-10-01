import { describe, expect, test } from "bun:test";
import {
  EMPTY_IMPORT_OPTIONS,
  countsSummary,
  dragHasFiles,
  harnessChoices,
  harnessOptionLabel,
  importOptionsEdited,
  importOptionsReducer,
  importSuccessText,
  pickBundleDropFile,
  toImportOptions,
} from "./bundle.ts";
import { BUNDLE_MAX_BYTES } from "../../shared/bundle.ts";
import type { BundleLocalHarness, PlannedAgent } from "../../shared/bundle-import.ts";

function harness(id: string, over: Partial<BundleLocalHarness> = {}): BundleLocalHarness {
  return {
    id,
    kind: "claude-code",
    label: id,
    isBuiltin: false,
    enabled: true,
    available: null,
    loggedIn: null,
    reason: null,
    installHint: null,
    ...over,
  };
}

describe("summaries", () => {
  test("countsSummary pluralizes and skips zeros", () => {
    expect(countsSummary({ agents: 2, pipelines: 1 })).toBe("2 Agents, 1 Pipeline");
    expect(countsSummary({ agents: 1, pipelines: 0 })).toBe("1 Agent");
    expect(countsSummary({ agents: 0, pipelines: 3 })).toBe("3 Pipelines");
    expect(countsSummary({ agents: 0, pipelines: 0 })).toBe("nothing");
  });

  test("importSuccessText", () => {
    expect(importSuccessText({ agents: [{}, {}] as never, pipelines: [{}] as never })).toBe("Imported 2 Agents, 1 Pipeline");
  });
});

describe("import options", () => {
  test("the reducer records names, harness picks and enable toggles", () => {
    let s = importOptionsReducer(EMPTY_IMPORT_OPTIONS, { type: "agent-name", key: "w", name: "New" });
    s = importOptionsReducer(s, { type: "pipeline-name", index: 0, name: "Flow" });
    s = importOptionsReducer(s, { type: "agent-harness", key: "w", harnessId: "claude-2" });
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: true });
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: true });
    expect(s).toEqual({
      agentNames: { w: "New" },
      pipelineNames: { "0": "Flow" },
      agentHarness: { w: "claude-2" },
      enableHarnesses: ["codex"],
    });
    expect(importOptionsEdited(s)).toBe(true);
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: false });
    expect(s.enableHarnesses).toEqual([]);
    expect(importOptionsReducer(s, { type: "reset" })).toBe(EMPTY_IMPORT_OPTIONS);
    expect(importOptionsEdited(EMPTY_IMPORT_OPTIONS)).toBe(false);
  });

  test("the reducer never mutates its input", () => {
    const before = { ...EMPTY_IMPORT_OPTIONS, agentNames: { a: "x" } };
    importOptionsReducer(before, { type: "agent-name", key: "a", name: "y" });
    expect(before.agentNames).toEqual({ a: "x" });
  });

  test("toImportOptions drops blank names and empty maps", () => {
    expect(toImportOptions(EMPTY_IMPORT_OPTIONS)).toEqual({});
    expect(
      toImportOptions({
        agentNames: { a: "  ", b: " Kept " },
        pipelineNames: { "0": "" },
        agentHarness: { a: "codex" },
        enableHarnesses: ["codex"],
      }),
    ).toEqual({ agentNames: { b: "Kept" }, agentHarness: { a: "codex" }, enableHarnesses: ["codex"] });
  });

  test("harnessChoices keeps local order and only the candidates", () => {
    const plan = { localHarnesses: [harness("claude-code"), harness("codex", { kind: "codex" }), harness("claude-2")] };
    const agent = { candidateHarnessIds: ["claude-2", "claude-code"] } as PlannedAgent;
    expect(harnessChoices(agent, plan).map((h) => h.id)).toEqual(["claude-code", "claude-2"]);
  });

  test("harnessOptionLabel shows the label, the id when it differs, and a disabled marker", () => {
    expect(harnessOptionLabel(harness("claude-code", { label: "Claude Code" }))).toBe("Claude Code (claude-code)");
    expect(harnessOptionLabel(harness("codex", { enabled: false }))).toBe("codex — disabled");
  });
});

describe("dropped files", () => {
  test("dragHasFiles reads DataTransfer.types", () => {
    expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  test("pickBundleDropFile takes the first .json file and refuses others", () => {
    const json = new File(["{}"], "x.agetor.json", { type: "application/json" });
    const txt = new File(["{}"], "notes.txt");
    expect(pickBundleDropFile([json, txt])).toEqual({ file: json });
    expect(pickBundleDropFile([txt, json])).toEqual({ error: expect.stringContaining("isn't a .json file") });
    expect(pickBundleDropFile([])).toEqual({ error: expect.stringContaining("Drop a .json") });
    expect(pickBundleDropFile(null)).toEqual({ error: expect.stringContaining("Drop a .json") });
    const big = new File([new Uint8Array(BUNDLE_MAX_BYTES + 1)], "big.json");
    expect(pickBundleDropFile([big])).toEqual({ error: expect.stringContaining("too large") });
  });
});
