import { defineOp } from "./define.ts";
import type { ParsedBundle } from "../../../shared/bundle.ts";
import {
  planBundleImport,
  type BundleImportOptions,
  type BundleImportPlan,
  type BundleImportResponse,
  type BundleLocalHarness,
  type BundleLocalState,
} from "../../../shared/bundle-import.ts";
import { AGENT_OPTIONS } from "../../../shared/types.ts";
import type { AgentKind, AgentProfile, Harness, HarnessStatus, Pipeline, PipelineGraph } from "../../../shared/types.ts";

const AGENT_KINDS = Object.keys(AGENT_OPTIONS) as AgentKind[];

/** What the main thread learned about one harness outside the database (its
 *  status and user-level skills). Plain data, so it can cross to the worker. */
export interface HarnessProbeData {
  status: HarnessStatus | null;
  skills: string[] | null;
}

export type ProbeData = Record<string, HarnessProbeData>;
/** Model ids known per harness id (`null`: unknown), computed on the main thread
 *  from its in-memory discovery caches. */
export type KnownModels = Record<string, string[] | null>;

/** Every harness this machine can bind to: the stored rows plus a built-in kind
 *  that has no row (read as enabled, as `getByIdOrKind` synthesizes it). */
export function withSyntheticBuiltins(rows: Harness[], byIdOrKind: (kind: string) => Harness | null): Harness[] {
  const out = [...rows];
  const ids = new Set(rows.map((h) => h.id));
  for (const kind of AGENT_KINDS) {
    if (ids.has(kind)) continue;
    const synthetic = byIdOrKind(kind);
    if (synthetic) out.push(synthetic);
  }
  return out;
}

/** The local state the planner reads, built from rows read fresh from the
 *  database plus the probe data. Pure. */
export function buildLocalState(
  rows: Harness[],
  profiles: AgentProfile[],
  pipelineNames: string[],
  probes: ProbeData,
  knownModels: KnownModels,
): BundleLocalState {
  const local: BundleLocalHarness[] = rows.map((h) => {
    const status = probes[h.id]?.status ?? null;
    return {
      id: h.id,
      kind: h.kind,
      label: h.label,
      isBuiltin: h.isBuiltin,
      enabled: h.enabled,
      available: status ? status.available : null,
      loggedIn: status ? status.loggedIn : null,
      reason: status?.reason ?? null,
      installHint: status?.installHint ?? null,
    };
  });
  const models: Record<string, string[] | null> = {};
  const skills: Record<string, string[] | null> = {};
  for (const h of rows) {
    models[h.id] = knownModels[h.id] ?? null;
    skills[h.id] = probes[h.id]?.skills ?? null;
  }
  return {
    harnesses: local,
    knownKinds: [...AGENT_KINDS],
    agentNames: profiles.map((p) => p.name),
    pipelineNames,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    knownModels: models,
    knownSkills: skills,
  };
}

/** Swap a bundle graph's Agent keys for the ids the import just created. */
function graphWithIds(graph: PipelineGraph, idByKey: Map<string, string>): PipelineGraph {
  return {
    ...graph,
    steps: graph.steps.map((step) => ({
      ...step,
      agentProfileId: step.agentProfileId === null ? null : (idByKey.get(step.agentProfileId) ?? null),
      subagents: {
        ...step.subagents,
        profileIds: step.subagents.profileIds
          .map((key) => idByKey.get(key))
          .filter((id): id is string => typeof id === "string"),
      },
    })),
  };
}

export type BundleCommitOutcome =
  | { kind: "blocked"; plan: BundleImportPlan }
  | { kind: "changed"; plan: BundleImportPlan }
  | { kind: "ok"; result: BundleImportResponse };

/** Commit an import (`bundle.ts`): inside one transaction the names and harness
 *  rows are re-read, the plan is rebuilt and, only when nothing blocks it, the
 *  harnesses are enabled, the Agents inserted, the graphs rewritten to the new
 *  ids and the Pipelines inserted. A blocked or changed plan returns before any
 *  write; a name clash (or any other throw) rolls every write back. */
export const bundleOps = {
  "bundle.commitImport": defineOp({
    tx: true,
    run: (
      { modules },
      bundle: ParsedBundle,
      options: BundleImportOptions,
      expectedFingerprint: string | null,
      probes: ProbeData,
      knownModels: KnownModels,
    ): BundleCommitOutcome => {
      const { harnesses, agentProfiles, pipelines } = modules;
      const rows = withSyntheticBuiltins(harnesses.list(), (k) => harnesses.getByIdOrKind(k));
      const profiles = agentProfiles.list();
      const plan = planBundleImport(
        bundle,
        buildLocalState(rows, profiles, pipelines.list().map((p) => p.name), probes, knownModels),
        options,
      );
      if (!plan.canImport) return { kind: "blocked", plan };
      if (expectedFingerprint !== null && plan.fingerprint !== expectedFingerprint) return { kind: "changed", plan };

      const enabledHarnesses: string[] = [];
      for (const h of plan.harnesses) {
        if (!h.willEnable || !harnesses.get(h.id)) continue;
        harnesses.setEnabled(h.id, true);
        enabledHarnesses.push(h.id);
      }

      const created: AgentProfile[] = [];
      const idByKey = new Map<string, string>();
      for (const a of plan.agents) {
        const profile = agentProfiles.insert({
          name: a.name,
          harness: a.harnessId!,
          model: a.model,
          effort: a.effort,
          mode: a.mode,
          speed: a.speed,
          maxMode: a.maxMode,
          opencodeServer: a.opencodeServer,
          instructions: a.instructions,
          skills: a.skills,
        });
        idByKey.set(a.key, profile.id);
        created.push(profile);
      }

      const createdPipelines: Pipeline[] = [];
      for (const p of plan.pipelines) {
        createdPipelines.push(
          pipelines.insert({
            name: p.name,
            description: p.description,
            graph: plan.legacy ? p.graph : graphWithIds(p.graph, idByKey),
            ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
          }),
        );
      }

      return { kind: "ok", result: { agents: created, pipelines: createdPipelines, enabledHarnesses, warnings: plan.warnings, plan } };
    },
  }),
};
