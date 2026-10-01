/**
 * Pure helpers behind the Agents/Pipelines export and import dialogs
 * (docs/plans/agents-pipelines-import-export.md, T4): the import dialog's
 * option state and its reducer, the summary/toast strings, and the `.json`
 * pick from a dropped `FileList`. No React, no DOM beyond the `File` type —
 * unit-tested in `bundle.test.ts`.
 */
import { BUNDLE_MAX_BYTES } from "../../shared/bundle.ts";
import type {
  BundleImportOptions,
  BundleImportPlan,
  BundleImportResponse,
  BundleLocalHarness,
  PlannedAgent,
} from "../../shared/bundle-import.ts";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "2 Agents, 1 Pipeline" — or "nothing" for an empty count. */
export function countsSummary(counts: { agents: number; pipelines: number }): string {
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(plural(counts.agents, "Agent"));
  if (counts.pipelines > 0) parts.push(plural(counts.pipelines, "Pipeline"));
  return parts.join(", ") || "nothing";
}

/** Toast title after a successful import. */
export function importSuccessText(result: Pick<BundleImportResponse, "agents" | "pipelines">): string {
  return `Imported ${countsSummary({ agents: result.agents.length, pipelines: result.pipelines.length })}`;
}

// ── import options ─────────────────────────────────────────────────────────

/** What the user changed in the import preview. Names are kept as typed
 *  (a cleared field is "" — it falls back to the automatic name). */
export interface ImportOptionsState {
  agentNames: Record<string, string>;
  pipelineNames: Record<string, string>;
  agentHarness: Record<string, string>;
  enableHarnesses: string[];
}

export const EMPTY_IMPORT_OPTIONS: ImportOptionsState = {
  agentNames: {},
  pipelineNames: {},
  agentHarness: {},
  enableHarnesses: [],
};

export type ImportOptionsAction =
  | { type: "agent-name"; key: string; name: string }
  | { type: "pipeline-name"; index: number; name: string }
  | { type: "agent-harness"; key: string; harnessId: string }
  | { type: "enable-harness"; harnessId: string; enabled: boolean }
  | { type: "reset" };

export function importOptionsReducer(state: ImportOptionsState, action: ImportOptionsAction): ImportOptionsState {
  switch (action.type) {
    case "agent-name":
      return { ...state, agentNames: { ...state.agentNames, [action.key]: action.name } };
    case "pipeline-name":
      return { ...state, pipelineNames: { ...state.pipelineNames, [String(action.index)]: action.name } };
    case "agent-harness":
      return { ...state, agentHarness: { ...state.agentHarness, [action.key]: action.harnessId } };
    case "enable-harness": {
      const rest = state.enableHarnesses.filter((id) => id !== action.harnessId);
      return { ...state, enableHarnesses: action.enabled ? [...rest, action.harnessId] : rest };
    }
    case "reset":
      return EMPTY_IMPORT_OPTIONS;
  }
}

function nonBlank(map: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(map)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The wire options for a preview/import request; blank names are left out
 *  (the planner then uses the automatic name). */
export function toImportOptions(state: ImportOptionsState): BundleImportOptions {
  const options: BundleImportOptions = {};
  const agentNames = nonBlank(state.agentNames);
  const pipelineNames = nonBlank(state.pipelineNames);
  if (agentNames) options.agentNames = agentNames;
  if (pipelineNames) options.pipelineNames = pipelineNames;
  if (Object.keys(state.agentHarness).length > 0) options.agentHarness = { ...state.agentHarness };
  if (state.enableHarnesses.length > 0) options.enableHarnesses = [...state.enableHarnesses];
  return options;
}

/** True once the user changed anything — closing then asks to discard. */
export function importOptionsEdited(state: ImportOptionsState): boolean {
  return (
    Object.keys(state.agentNames).length > 0 ||
    Object.keys(state.pipelineNames).length > 0 ||
    Object.keys(state.agentHarness).length > 0 ||
    state.enableHarnesses.length > 0
  );
}

/** The harnesses an Agent's harness select offers, in local order. */
export function harnessChoices(agent: PlannedAgent, plan: Pick<BundleImportPlan, "localHarnesses">): BundleLocalHarness[] {
  const allowed = new Set(agent.candidateHarnessIds);
  return plan.localHarnesses.filter((h) => allowed.has(h.id));
}

/** A harness's select-option text: label, id when it differs, and status. */
export function harnessOptionLabel(h: BundleLocalHarness): string {
  const name = h.label && h.label !== h.id ? `${h.label} (${h.id})` : h.id;
  return h.enabled ? name : `${name} — disabled`;
}

// ── dropped files ──────────────────────────────────────────────────────────

/** Whether a drag carries files (and so may be a bundle drop). */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

/**
 * The `.json` file a drop should import: the first file, refused when it
 * isn't `.json` or is over the size cap.
 */
export function pickBundleDropFile(files: ArrayLike<File> | null | undefined): { file: File } | { error: string } {
  const list = files ? Array.from(files) : [];
  const file = list[0];
  if (!file) return { error: "Drop a .json bundle file to import it." };
  if (!file.name.toLowerCase().endsWith(".json")) {
    return { error: `"${file.name}" isn't a .json file — drop an agetor bundle (.agetor.json).` };
  }
  if (file.size > BUNDLE_MAX_BYTES) {
    return { error: `"${file.name}" is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  return { file };
}
