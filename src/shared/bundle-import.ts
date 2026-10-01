/**
 * The bundle import planner (docs/plans/agents-pipelines-import-export.md,
 * K5/K6/K12/K14): given a parsed bundle and a snapshot of this machine's
 * state, decide which harness each Agent lands on, what every Agent and
 * Pipeline will be named, and what to warn about or block on. The server runs
 * it for the preview and again inside the import transaction, so the preview
 * and the commit can never disagree. Pure and total — it never throws.
 */
import type { BundleHarnessRef, ParsedBundle } from "./bundle.ts";
import { AGENT_PROFILE_LIMITS } from "./agent-profile.ts";
import { PIPELINE_CONTROL_CHAR_RE } from "./pipeline.ts";
import { DEFAULT_MODEL, PIPELINE_LIMITS } from "./types.ts";
import type { AgentKind, AgentProfile, Pipeline, PipelineGraph } from "./types.ts";

export interface BundleIssue {
  code: string;
  message: string;
}

/** One harness on this machine, with the status the planner warns about. */
export interface BundleLocalHarness {
  id: string;
  kind: AgentKind;
  label: string;
  isBuiltin: boolean;
  enabled: boolean;
  available: boolean | null;
  loggedIn: boolean | null;
  reason: string | null;
  installHint: string | null;
}

export interface BundleLocalState {
  harnesses: BundleLocalHarness[];
  /** Harness kinds this build of agetor knows. */
  knownKinds: string[];
  agentNames: string[];
  pipelineNames: string[];
  profiles: { id: string; name: string }[];
  /** By local harness id; null = can't tell, no warning. */
  knownModels: Record<string, string[] | null>;
  /** By local harness id; null = can't tell, no warning. */
  knownSkills: Record<string, string[] | null>;
}

export interface BundleImportOptions {
  /** File harness id → local harness id, for every Agent on that harness. */
  harnessMap?: Record<string, string>;
  /** Agent key → local harness id; wins over `harnessMap`. */
  agentHarness?: Record<string, string>;
  /** Agent key → explicit target name. */
  agentNames?: Record<string, string>;
  /** Pipeline index (as a string) → explicit target name. */
  pipelineNames?: Record<string, string>;
  /** CLI `--name`: the file's only Pipeline, or its only Agent when it has
   *  no Pipelines. */
  singleName?: string;
  /** Disabled harnesses to enable as part of the import, or "all". */
  enableHarnesses?: string[] | "all";
}

export type HarnessResolution = "exact" | "fallback" | "mapped" | "rebound" | "unresolved";

export interface PlannedAgent {
  key: string;
  sourceName: string;
  name: string;
  renamed: boolean;
  fileHarness: BundleHarnessRef;
  resolution: HarnessResolution;
  harnessId: string | null;
  harnessKind: AgentKind | null;
  harnessLabel: string | null;
  /** Local harnesses the Agent may be bound to instead: same kind, or every
   *  local harness when the file's kind is unknown. */
  candidateHarnessIds: string[];
  model: string;
  effort: string | null;
  mode: string | null;
  fast: boolean;
  maxMode: boolean;
  instructions: string;
  skills: string[];
  warnings: BundleIssue[];
  errors: BundleIssue[];
}

export interface PlannedStep {
  id: string;
  name: string;
  instructions: string;
  agentKey: string | null;
  agentName: string | null;
  /** Legacy files only: how the step's Agent reference was resolved. */
  legacy: "kept" | "remapped" | "dangling" | null;
}

export interface PlannedPipeline {
  index: number;
  sourceName: string;
  name: string;
  renamed: boolean;
  description: string;
  maxSteps: number | undefined;
  steps: PlannedStep[];
  /** Bundle: Agent keys (rewritten to new ids at commit). Legacy: database
   *  ids, already remapped by name where possible. */
  graph: PipelineGraph;
  warnings: BundleIssue[];
  errors: BundleIssue[];
}

export interface PlannedHarness {
  id: string;
  kind: AgentKind;
  label: string;
  enabled: boolean;
  canEnable: boolean;
  willEnable: boolean;
  warnings: BundleIssue[];
}

export interface BundleImportPlan {
  legacy: boolean;
  agents: PlannedAgent[];
  pipelines: PlannedPipeline[];
  harnesses: PlannedHarness[];
  localHarnesses: BundleLocalHarness[];
  /** Every warning in the plan (Agents, Pipelines, harnesses), flattened. */
  warnings: BundleIssue[];
  /** Every blocking issue in the plan, flattened. */
  blocking: BundleIssue[];
  canImport: boolean;
}

/** `POST /bundle/import`'s 201 response. */
export interface BundleImportResponse {
  agents: AgentProfile[];
  pipelines: Pipeline[];
  /** Harnesses the import enabled. */
  enabledHarnesses: string[];
  warnings: BundleIssue[];
  plan: BundleImportPlan;
}

const nameKey = (s: string): string => s.trim().toLowerCase();

/** Cut `s` to at most `max` UTF-16 units without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * The first free automatic name for `base` (K6): `Base (imported)`, then
 * `Base (imported 2)`, … — the base is truncated so the whole name fits
 * `limit`. `taken` holds lower-cased, trimmed names; the caller adds the
 * result to it.
 */
export function importedName(base: string, taken: ReadonlySet<string>, limit: number): string {
  const trimmed = base.trim();
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (imported)" : ` (imported ${n})`;
    const candidate = `${truncate(trimmed, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

const issue = (code: string, message: string): BundleIssue => ({ code, message });

/** Own, string-valued entries of an options map; anything else reads empty. */
function stringMap(x: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof x !== "object" || x === null || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === "string") out.set(k, v);
  }
  return out;
}

function harnessText(h: { id: string; kind: string; label: string }): string {
  return h.label && h.label !== h.id ? `"${h.label}" (${h.id})` : `"${h.id}"`;
}

/** Validate a name the user typed (K6): same rules as the create routes. */
function explicitNameError(name: string, limit: number, what: string): string | null {
  if (name.length > limit) return `${what} must be ${limit} characters or fewer`;
  if (PIPELINE_CONTROL_CHAR_RE.test(name)) return `${what} must not contain control characters`;
  return null;
}

interface Nameable {
  sourceName: string;
  explicit: string | null;
  name: string;
  renamed: boolean;
  errors: BundleIssue[];
}

/**
 * Settle the target names of one kind of item (K6). Explicit names are
 * reserved first and must be free; every other item keeps its name unless it
 * clashes with a local name or an earlier item, in which case it gets the
 * next automatic `(imported)` name.
 */
function assignNames(items: Nameable[], localNames: string[], limit: number, noun: "Agent" | "Pipeline"): void {
  const taken = new Set(localNames.map(nameKey));
  const explicitTaken = new Set<string>();
  for (const item of items) {
    if (item.explicit === null) continue;
    const name = item.explicit;
    item.name = name;
    item.renamed = name !== item.sourceName;
    const bad = explicitNameError(name, limit, `${noun} name "${name}"`);
    if (bad) {
      item.errors.push(issue("name-invalid", bad));
      continue;
    }
    const key = nameKey(name);
    if (taken.has(key) || explicitTaken.has(key)) {
      item.errors.push(issue("name-in-use", `${noun} name "${name}" is already in use — pick another name`));
      continue;
    }
    explicitTaken.add(key);
  }
  for (const key of explicitTaken) taken.add(key);
  for (const item of items) {
    if (item.explicit !== null) continue;
    const key = nameKey(item.sourceName);
    if (taken.has(key)) {
      item.name = importedName(item.sourceName, taken, limit);
      item.renamed = true;
    } else {
      item.name = item.sourceName;
      item.renamed = false;
    }
    taken.add(nameKey(item.name));
  }
}

/**
 * Plan an import (K5, K6, K12, K14). See {@link BundleImportPlan}; the plan
 * is importable exactly when `blocking` is empty.
 */
export function planBundleImport(
  parsed: ParsedBundle,
  local: BundleLocalState,
  options: BundleImportOptions = {},
): BundleImportPlan {
  const harnessMap = stringMap(options.harnessMap);
  const agentHarness = stringMap(options.agentHarness);
  const agentNames = stringMap(options.agentNames);
  const pipelineNames = stringMap(options.pipelineNames);
  const singleName = typeof options.singleName === "string" ? options.singleName.trim() : "";
  const enable = options.enableHarnesses;
  const enableAll = enable === "all";
  const enableSet = new Set(Array.isArray(enable) ? enable.filter((x): x is string => typeof x === "string") : []);

  const knownKinds = new Set(local.knownKinds);
  const localById = new Map(local.harnesses.map((h) => [h.id, h] as const));
  const builtinByKind = new Map<string, BundleLocalHarness>();
  for (const h of local.harnesses) {
    if (h.isBuiltin && h.id === h.kind && !builtinByKind.has(h.kind)) builtinByKind.set(h.kind, h);
  }
  for (const h of local.harnesses) {
    if (h.isBuiltin && !builtinByKind.has(h.kind)) builtinByKind.set(h.kind, h);
  }

  const planLevelBlocking: BundleIssue[] = [];

  // CLI --name: which single item it renames.
  let singleTarget: { kind: "pipeline" | "agent"; index: number } | null = null;
  if (singleName) {
    if (parsed.pipelines.length === 1) singleTarget = { kind: "pipeline", index: 0 };
    else if (parsed.pipelines.length === 0 && parsed.agents.length === 1) singleTarget = { kind: "agent", index: 0 };
    else {
      planLevelBlocking.push(
        issue(
          "name-not-applicable",
          "a single name only applies to a file with exactly one Pipeline, or one Agent and no Pipelines",
        ),
      );
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────────
  const agents: PlannedAgent[] = parsed.agents.map((a) => {
    const warnings: BundleIssue[] = [];
    const errors: BundleIssue[] = [];
    const who = `Agent "${a.name}"`;
    const fileKindKnown = knownKinds.has(a.harness.kind);

    let resolution: HarnessResolution = "unresolved";
    let bound: BundleLocalHarness | null = null;
    let model = a.model;
    let effort = a.effort;
    let mode = a.mode;
    let fast = a.fast;
    let maxMode = a.maxMode;

    const override = agentHarness.get(a.key) ?? harnessMap.get(a.harness.id);
    if (override !== undefined) {
      const target = localById.get(override);
      if (!target) {
        errors.push(issue("unknown-local-harness", `${who}: harness "${override}" isn't defined on this machine`));
      } else if (fileKindKnown) {
        if (target.kind === a.harness.kind) {
          resolution = "mapped";
          bound = target;
        } else {
          errors.push(
            issue(
              "harness-kind-mismatch",
              `${who} is a ${a.harness.kind} Agent, but harness ${harnessText(target)} is ${target.kind} — pick a ${a.harness.kind} harness`,
            ),
          );
        }
      } else {
        resolution = "rebound";
        bound = target;
        model = DEFAULT_MODEL[target.kind];
        effort = null;
        mode = null;
        fast = false;
        maxMode = false;
        warnings.push(
          issue(
            "settings-reset",
            `${who} moves from an unknown "${a.harness.kind}" harness to ${harnessText(target)} — its model, effort and mode were reset to that harness's defaults`,
          ),
        );
      }
    } else if (fileKindKnown) {
      const same = localById.get(a.harness.id);
      if (same && same.kind === a.harness.kind) {
        resolution = "exact";
        bound = same;
      } else {
        const fallback = builtinByKind.get(a.harness.kind) ?? null;
        if (fallback) {
          resolution = "fallback";
          bound = fallback;
          const why = same
            ? `harness "${a.harness.id}" here is a ${same.kind} harness, not ${a.harness.kind}`
            : `harness ${harnessText(a.harness)} isn't on this machine`;
          warnings.push(issue("harness-fallback", `${who}: ${why} — using ${harnessText(fallback)} instead`));
        } else {
          errors.push(issue("no-fallback-harness", `${who}: no local ${a.harness.kind} harness to bind it to`));
        }
      }
    } else {
      errors.push(
        issue(
          "unknown-kind",
          `${who} uses a "${a.harness.kind}" harness, which this version of agetor doesn't know — pick a local harness for it`,
        ),
      );
    }

    const candidateHarnessIds = (
      fileKindKnown ? local.harnesses.filter((h) => h.kind === a.harness.kind) : local.harnesses
    ).map((h) => h.id);

    if (bound && resolution !== "rebound") {
      const models = local.knownModels[bound.id];
      if (Array.isArray(models) && !models.includes(model)) {
        warnings.push(
          issue(
            "unknown-model",
            `${who}: model "${model}" isn't in ${harnessText(bound)}'s model list — it imports as-is`,
          ),
        );
      }
    }
    if (bound && a.skills.length > 0) {
      const skills = local.knownSkills[bound.id];
      if (Array.isArray(skills)) {
        const known = new Set(skills.map((s) => s.toLowerCase()));
        const missing = a.skills.filter((s) => !known.has(s.toLowerCase()));
        if (missing.length > 0) {
          warnings.push(
            issue(
              "unknown-skills",
              `${who}: ${missing.length === 1 ? "skill" : "skills"} ${missing.map((s) => `/${s}`).join(", ")} not found at user level for ${harnessText(bound)}`,
            ),
          );
        }
      }
    }

    return {
      key: a.key,
      sourceName: a.name,
      name: a.name,
      renamed: false,
      fileHarness: { ...a.harness },
      resolution,
      harnessId: bound?.id ?? null,
      harnessKind: bound?.kind ?? null,
      harnessLabel: bound?.label ?? null,
      candidateHarnessIds,
      model,
      effort,
      mode,
      fast,
      maxMode,
      instructions: a.instructions,
      skills: [...a.skills],
      warnings,
      errors,
    };
  });

  const agentNameables: Nameable[] = agents.map((a, i) => {
    const typed = singleTarget?.kind === "agent" && singleTarget.index === i ? singleName : agentNames.get(a.key);
    const explicit = typed !== undefined && typed.trim() !== "" ? typed.trim() : null;
    return { sourceName: a.sourceName, explicit, name: a.sourceName, renamed: false, errors: a.errors };
  });
  assignNames(agentNameables, local.agentNames, AGENT_PROFILE_LIMITS.name, "Agent");
  agents.forEach((a, i) => {
    a.name = agentNameables[i]!.name;
    a.renamed = agentNameables[i]!.renamed;
  });

  // ── Pipelines ────────────────────────────────────────────────────────────
  const agentByKey = new Map(agents.map((a) => [a.key, a] as const));
  const localProfileIds = new Set(local.profiles.map((p) => p.id));
  const localProfileName = new Map(local.profiles.map((p) => [p.id, p.name] as const));

  const pipelines: PlannedPipeline[] = parsed.pipelines.map((p, index) => {
    const warnings: BundleIssue[] = [];
    const errors: BundleIssue[] = [];
    const who = `Pipeline "${p.name}"`;
    let graph = p.graph;
    let steps: PlannedStep[];

    if (parsed.legacy) {
      // K12: keep an id that exists here; else a unique name match; else
      // leave it dangling with a warning.
      const resolveLegacy = (
        id: string,
        hint: string | null,
        what: string,
      ): { id: string; outcome: "kept" | "remapped" | "dangling" } => {
        if (localProfileIds.has(id)) return { id, outcome: "kept" };
        if (hint) {
          const matches = local.profiles.filter((lp) => nameKey(lp.name) === nameKey(hint));
          if (matches.length === 1) return { id: matches[0]!.id, outcome: "remapped" };
          if (matches.length > 1) {
            warnings.push(
              issue(
                "legacy-ambiguous-agent",
                `${what}: several Agents here are named "${hint}" — assign one in the editor before running this pipeline`,
              ),
            );
            return { id, outcome: "dangling" };
          }
        }
        warnings.push(
          issue(
            "legacy-missing-agent",
            `${what}: Agent ${hint ? `"${hint}"` : id} isn't defined on this machine — assign one in the editor before running this pipeline`,
          ),
        );
        return { id, outcome: "dangling" };
      };
      steps = [];
      graph = {
        ...p.graph,
        steps: p.graph.steps.map((step) => {
          const hints = p.legacyHints?.[step.id] ?? null;
          let agentProfileId: string | null = null;
          let outcome: PlannedStep["legacy"] = null;
          if (step.agentProfileId !== null) {
            const r = resolveLegacy(step.agentProfileId, hints?.profileName ?? null, `${who}, step "${step.name}"`);
            agentProfileId = r.id;
            outcome = r.outcome;
          }
          const profileIds = step.subagents.profileIds.map(
            (id, i) =>
              resolveLegacy(id, hints?.subagentProfileNames[i] ?? null, `${who}, step "${step.name}" delegation`).id,
          );
          steps.push({
            id: step.id,
            name: step.name,
            instructions: step.instructions,
            agentKey: null,
            agentName:
              agentProfileId !== null && outcome !== "dangling"
                ? (localProfileName.get(agentProfileId) ?? null)
                : (hints?.profileName ?? null),
            legacy: outcome,
          });
          return { ...step, agentProfileId, subagents: { ...step.subagents, profileIds: [...new Set(profileIds)] } };
        }),
      };
    } else {
      steps = p.graph.steps.map((step) => {
        const agent = step.agentProfileId !== null ? agentByKey.get(step.agentProfileId) : undefined;
        return {
          id: step.id,
          name: step.name,
          instructions: step.instructions,
          agentKey: step.agentProfileId,
          agentName: agent?.name ?? null,
          legacy: null,
        };
      });
    }

    for (const step of steps) {
      if (step.agentKey === null && step.legacy === null) {
        warnings.push(issue("step-without-agent", `${who}, step "${step.name}" has no Agent — assign one before running it`));
      }
    }

    return {
      index,
      sourceName: p.name,
      name: p.name,
      renamed: false,
      description: p.description,
      maxSteps: p.maxSteps,
      steps,
      graph,
      warnings,
      errors,
    };
  });

  const pipelineNameables: Nameable[] = pipelines.map((p, i) => {
    const typed =
      singleTarget?.kind === "pipeline" && singleTarget.index === i ? singleName : pipelineNames.get(String(i));
    const explicit = typed !== undefined && typed.trim() !== "" ? typed.trim() : null;
    return { sourceName: p.sourceName, explicit, name: p.sourceName, renamed: false, errors: p.errors };
  });
  assignNames(pipelineNameables, local.pipelineNames, PIPELINE_LIMITS.name, "Pipeline");
  pipelines.forEach((p, i) => {
    p.name = pipelineNameables[i]!.name;
    p.renamed = pipelineNameables[i]!.renamed;
  });

  // ── Harnesses the Agents land on ─────────────────────────────────────────
  const harnessOrder: string[] = [];
  for (const a of agents) {
    if (a.harnessId !== null && !harnessOrder.includes(a.harnessId)) harnessOrder.push(a.harnessId);
  }
  const harnesses: PlannedHarness[] = harnessOrder.map((id) => {
    const h = localById.get(id)!;
    const warnings: BundleIssue[] = [];
    const canEnable = !h.enabled;
    const willEnable = canEnable && (enableAll || enableSet.has(id));
    const name = harnessText(h);
    if (!h.enabled && !willEnable) {
      warnings.push(issue("harness-disabled", `Harness ${name} is disabled — enable it to run these Agents`));
    }
    if (h.available === false) {
      const why = h.reason ? ` (${h.reason})` : "";
      const hint = h.installHint ? ` — install it: ${h.installHint}` : "";
      warnings.push(issue("harness-not-installed", `Harness ${name} isn't installed${why}${hint}`));
    }
    if (h.loggedIn === false) {
      warnings.push(issue("harness-logged-out", `Harness ${name} isn't logged in`));
    }
    return { id: h.id, kind: h.kind, label: h.label, enabled: h.enabled, canEnable, willEnable, warnings };
  });

  const warnings = [
    ...agents.flatMap((a) => a.warnings),
    ...pipelines.flatMap((p) => p.warnings),
    ...harnesses.flatMap((h) => h.warnings),
  ];
  const blocking = [...planLevelBlocking, ...agents.flatMap((a) => a.errors), ...pipelines.flatMap((p) => p.errors)];

  return {
    legacy: parsed.legacy,
    agents,
    pipelines,
    harnesses,
    localHarnesses: local.harnesses.map((h) => ({ ...h })),
    warnings,
    blocking,
    canImport: blocking.length === 0,
  };
}
