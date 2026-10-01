/**
 * The "agetor bundle" — one versioned, pretty-printed JSON file format that
 * carries any selection of Agents (agent profiles) and Pipelines, so they can
 * be exported from one machine and imported on another
 * (docs/plans/agents-pipelines-import-export.md, K2/K3/K11/K12).
 *
 * This module is the single grammar every surface shares: the server builds
 * and serves export text from it, the CLI and the webview hand import text to
 * the server, and the server parses it here before planning
 * (`./bundle-import.ts`). Pure — no I/O, and no runtime imports from
 * `src/bun` or `src/mainview`.
 *
 * Shape (K2): `{ format, version, exportedAt, agetorVersion, agents[],
 * pipelines[] }`. Each Agent carries `harness: { id, kind, label }` — `kind`
 * is the built-in harness an additional-account harness wraps, which is what
 * lets an import on a machine without that account fall back to the
 * built-in. Harness `home`/`bin`/`env` are never written and never read.
 * Steps reference Agents by a file-local `key` (`agent`, `subagents.agents`),
 * never by a database id.
 */
import { AGENT_PROFILE_LIMITS, normalizeSkillName } from "./agent-profile.ts";
import { PIPELINE_CONTROL_CHAR_RE, validatePipelineGraph } from "./pipeline.ts";
import { PIPELINE_LIMITS } from "./types.ts";
import type { AgentProfile, Harness, Pipeline, PipelineEdge, PipelineGraph } from "./types.ts";

export const BUNDLE_FORMAT = "agetor-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_FILE_EXT = ".agetor.json";
/** Largest import text accepted, in UTF-8 bytes. */
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
/** Count and length caps for bundle-only fields; Agent and Pipeline fields
 *  reuse `AGENT_PROFILE_LIMITS` / `PIPELINE_LIMITS`. */
export const BUNDLE_LIMITS = {
  agents: 500,
  pipelines: 200,
  key: 128,
  harnessId: 128,
  harnessKind: 64,
  harnessLabel: 200,
  model: 200,
  effort: 100,
  mode: 100,
} as const;

/** The harness an exported Agent was bound to. `kind` is the built-in kind it
 *  wraps — the "original harness" a fallback import binds to. */
export interface BundleHarnessRef {
  id: string;
  kind: string;
  label: string;
}

export interface BundleAgent {
  /** File-local reference target for `BundleStep.agent` / `subagents.agents`.
   *  Unique within the file, never stored. */
  key: string;
  name: string;
  harness: BundleHarnessRef;
  model: string;
  effort: string | null;
  mode: string | null;
  fast: boolean;
  maxMode: boolean;
  instructions: string;
  skills: string[];
}

export interface BundleStep {
  id: string;
  name: string;
  instructions: string;
  /** An `agents[].key`, or null for a step with no Agent. */
  agent: string | null;
  position: { x: number; y: number };
  subagents: { agents: string[]; cap: number | null };
  transition: "choose" | "all";
  join: "any" | "all";
}

export interface BundlePipeline {
  name: string;
  description: string;
  maxSteps: number;
  graph: { steps: BundleStep[]; edges: PipelineEdge[]; startStepId: string | null };
}

export interface BundleFile {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  exportedAt: string;
  agetorVersion: string;
  agents: BundleAgent[];
  pipelines: BundlePipeline[];
}

/** What to export: explicit ids, or `all` (every Agent and every Pipeline). */
export interface BundleSelection {
  agentIds: string[];
  pipelineIds: string[];
  all: boolean;
}

const KEY_SLUG_MAX = 64;
const FILE_SLUG_MAX = 64;

/** Lower-case kebab slug (`[a-z0-9-]`), capped at `max` chars; "" when the
 *  input has no usable characters. */
function slugify(s: string, max: number): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** Assign each Agent a unique file-local key (K3): the slugged name, else
 *  `agent-<n>` (1-based position), suffixed `-2`, `-3`, … on a clash. */
function assignAgentKeys(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, i) => {
    const base = slugify(name, KEY_SLUG_MAX) || `agent-${i + 1}`;
    let key = base;
    for (let n = 2; used.has(key); n++) {
      const suffix = `-${n}`;
      key = `${base.slice(0, KEY_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    }
    used.add(key);
    return key;
  });
}

const byNameThenId = <T extends { name: string; id: string }>(a: T, b: T): number => {
  const an = a.name.trim().toLowerCase();
  const bn = b.name.trim().toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Build an export bundle from a selection (K2/K3, grill C5).
 *
 * - Selected Agents come first, in name order, then every Agent a selected
 *   Pipeline references (step Agents, then delegation Agents), in
 *   pipeline-then-step order. Each Agent appears once.
 * - A step whose Agent no longer exists exports `agent: null`; a delegation
 *   entry that no longer exists is dropped. Both add a warning.
 * - An Agent whose harness no longer resolves is skipped with a warning (and
 *   steps that reference it export without an Agent).
 * - An unknown selected id, an empty selection, or a result with nothing in
 *   it is `{ ok: false }`.
 *
 * `harnesses` must include the built-in harnesses even when the database has
 * no row for one (the server adds them the way `harnesses.getByIdOrKind`
 * synthesizes them).
 */
export function buildBundle(input: {
  selection: BundleSelection;
  profiles: AgentProfile[];
  pipelines: Pipeline[];
  harnesses: Pick<Harness, "id" | "kind" | "label">[];
  agetorVersion: string;
  now: Date;
}): { ok: true; bundle: BundleFile; filename: string; warnings: string[] } | { ok: false; error: string } {
  const { selection, profiles, pipelines, harnesses } = input;
  const profileById = new Map(profiles.map((p) => [p.id, p] as const));
  const pipelineById = new Map(pipelines.map((p) => [p.id, p] as const));
  const harnessById = new Map(harnesses.map((h) => [h.id, h] as const));

  let selectedProfiles: AgentProfile[];
  let selectedPipelines: Pipeline[];
  if (selection.all) {
    selectedProfiles = [...profiles];
    selectedPipelines = [...pipelines];
    if (selectedProfiles.length === 0 && selectedPipelines.length === 0) {
      return { ok: false, error: "nothing to export — there are no Agents or Pipelines yet" };
    }
  } else {
    const agentIds = [...new Set(selection.agentIds)];
    const pipelineIds = [...new Set(selection.pipelineIds)];
    if (agentIds.length === 0 && pipelineIds.length === 0) {
      return { ok: false, error: "nothing selected to export" };
    }
    selectedProfiles = [];
    for (const id of agentIds) {
      const p = profileById.get(id);
      if (!p) return { ok: false, error: `unknown agent "${id}"` };
      selectedProfiles.push(p);
    }
    selectedPipelines = [];
    for (const id of pipelineIds) {
      const p = pipelineById.get(id);
      if (!p) return { ok: false, error: `unknown pipeline "${id}"` };
      selectedPipelines.push(p);
    }
  }
  selectedProfiles.sort(byNameThenId);
  selectedPipelines.sort(byNameThenId);

  const warnings: string[] = [];

  // Every Agent in the file, in order: selected first, then referenced.
  const included: AgentProfile[] = [];
  const includedIds = new Set<string>();
  const include = (p: AgentProfile): void => {
    if (includedIds.has(p.id)) return;
    includedIds.add(p.id);
    included.push(p);
  };
  for (const p of selectedProfiles) include(p);
  for (const pipeline of selectedPipelines) {
    for (const step of pipeline.graph.steps) {
      const p = step.agentProfileId ? profileById.get(step.agentProfileId) : undefined;
      if (p) include(p);
    }
    for (const step of pipeline.graph.steps) {
      for (const id of step.subagents.profileIds) {
        const p = profileById.get(id);
        if (p) include(p);
      }
    }
  }

  // Drop Agents whose harness no longer resolves.
  const exportable = included.filter((p) => {
    if (harnessById.has(p.harness)) return true;
    warnings.push(`Agent "${p.name}" was skipped: its harness "${p.harness}" no longer exists`);
    return false;
  });

  const keys = assignAgentKeys(exportable.map((p) => p.name));
  const keyById = new Map(exportable.map((p, i) => [p.id, keys[i]!] as const));

  const agents: BundleAgent[] = exportable.map((p, i) => {
    const h = harnessById.get(p.harness)!;
    return {
      key: keys[i]!,
      name: p.name,
      harness: { id: h.id, kind: h.kind, label: h.label },
      model: p.model,
      effort: p.effort,
      mode: p.mode,
      fast: p.fast,
      maxMode: p.maxMode,
      instructions: p.instructions,
      skills: [...p.skills],
    };
  });

  const bundlePipelines: BundlePipeline[] = selectedPipelines.map((pipeline) => {
    const steps: BundleStep[] = pipeline.graph.steps.map((step) => {
      let agent: string | null = null;
      if (step.agentProfileId !== null) {
        agent = keyById.get(step.agentProfileId) ?? null;
        if (agent === null) {
          const why = profileById.has(step.agentProfileId) ? "its harness no longer exists" : "it no longer exists";
          warnings.push(
            `Pipeline "${pipeline.name}", step "${step.name}": its Agent was left out (${why}) — the step exports without an Agent`,
          );
        }
      }
      const delegated: string[] = [];
      for (const id of step.subagents.profileIds) {
        const key = keyById.get(id);
        if (key) {
          if (!delegated.includes(key)) delegated.push(key);
        } else {
          warnings.push(
            `Pipeline "${pipeline.name}", step "${step.name}": a delegation Agent was left out because it no longer exists or has no harness`,
          );
        }
      }
      return {
        id: step.id,
        name: step.name,
        instructions: step.instructions,
        agent,
        position: { x: step.position.x, y: step.position.y },
        subagents: { agents: delegated, cap: step.subagents.cap },
        transition: step.transition,
        join: step.join,
      };
    });
    return {
      name: pipeline.name,
      description: pipeline.description,
      maxSteps: pipeline.maxSteps,
      graph: {
        steps,
        edges: pipeline.graph.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label })),
        startStepId: pipeline.graph.startStepId,
      },
    };
  });

  if (agents.length === 0 && bundlePipelines.length === 0) {
    return { ok: false, error: warnings[0] ?? "nothing to export" };
  }

  const selectedCount = selectedProfiles.length + selectedPipelines.length;
  let filename: string;
  if (selectedCount === 1) {
    const only = selectedPipelines[0] ?? selectedProfiles[0]!;
    const fallback = selectedPipelines.length === 1 ? "pipeline" : "agent";
    filename = `${slugify(only.name, FILE_SLUG_MAX) || fallback}${BUNDLE_FILE_EXT}`;
  } else {
    filename = `agetor-export-${input.now.toISOString().slice(0, 10)}${BUNDLE_FILE_EXT}`;
  }

  return {
    ok: true,
    bundle: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: input.now.toISOString(),
      agetorVersion: input.agetorVersion,
      agents,
      pipelines: bundlePipelines,
    },
    filename,
    warnings,
  };
}

/** The canonical file text: 2-space indent plus a trailing newline. The CLI,
 *  Copy JSON and both save targets all write exactly this. */
export function serializeBundle(bundle: BundleFile): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** `name.agetor.json` → `name (n).agetor.json` for `n >= 2` (the
 *  never-overwrite numbering); `n < 2` returns `filename` unchanged. */
export function numberedFileName(filename: string, n: number): string {
  if (n < 2) return filename;
  const ext = filename.endsWith(BUNDLE_FILE_EXT)
    ? BUNDLE_FILE_EXT
    : filename.endsWith(".json")
      ? ".json"
      : "";
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base} (${n})${ext}`;
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** A legacy pipeline file's per-step Agent NAME hints (the pre-bundle
 *  `profileName` / `subagents.profileNames` fields). `subagentProfileNames` is
 *  aligned with the normalized `subagents.profileIds`. */
export interface LegacyStepHints {
  profileName: string | null;
  subagentProfileNames: (string | null)[];
}

export interface ParsedBundlePipeline {
  name: string;
  description: string;
  /** Undefined only for a legacy file that didn't carry one. */
  maxSteps: number | undefined;
  /** `agentProfileId` / `subagents.profileIds` hold Agent KEYS for a bundle,
   *  or the original database ids for a legacy file. */
  graph: PipelineGraph;
  /** Keyed by step id; null for a bundle. */
  legacyHints: Record<string, LegacyStepHints> | null;
}

export interface ParsedBundle {
  legacy: boolean;
  agents: BundleAgent[];
  pipelines: ParsedBundlePipeline[];
  exportedAt: string | null;
  agetorVersion: string | null;
}

export type BundleParseErrorCode = "too-large" | "invalid-json" | "unrecognized" | "unsupported-version" | "invalid";

type ParseResult = { ok: true; bundle: ParsedBundle } | { ok: false; error: string; code: BundleParseErrorCode };

/** Thrown inside the parser and caught once at the top — keeps every field
 *  check a one-liner. Never escapes `parseBundleText`. */
class BundleInvalid extends Error {}

const invalid = (message: string): never => {
  throw new BundleInvalid(message);
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Control characters allowed in multi-line text (K11): only tab, LF, CR. */
const MULTILINE_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function utf8ByteLength(text: string): number {
  // Every UTF-16 code unit encodes to 1..3 UTF-8 bytes, so most texts are
  // decided without encoding.
  if (text.length > BUNDLE_MAX_BYTES) return text.length;
  if (text.length * 3 <= BUNDLE_MAX_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/** A required, trimmed, single-line string within `max` chars. */
function lineField(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") return invalid(`${what} must be a string`);
  const v = value.trim();
  if (v.length === 0) return invalid(`${what} is required`);
  if (v.length > max) return invalid(`${what} must be ${max} characters or fewer`);
  if (PIPELINE_CONTROL_CHAR_RE.test(v)) return invalid(`${what} must not contain control characters`);
  return v;
}

/** An optional single-line string (`null`, absent and "" read as null). */
function optionalLineField(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return invalid(`${what} must be a string or null`);
  const v = value.trim();
  if (v.length === 0) return null;
  if (v.length > max) return invalid(`${what} must be ${max} characters or fewer`);
  if (PIPELINE_CONTROL_CHAR_RE.test(v)) return invalid(`${what} must not contain control characters`);
  return v;
}

/** Optional multi-line text (absent reads as ""), kept verbatim. */
function textField(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return invalid(`${what} must be a string`);
  if (value.length > max) return invalid(`${what} must be ${max} characters or fewer`);
  if (MULTILINE_CONTROL_CHAR_RE.test(value)) return invalid(`${what} must not contain control characters`);
  return value;
}

function boolField(value: unknown, what: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") return invalid(`${what} must be true or false`);
  return value;
}

function skillsField(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return invalid(`${what} must be an array of strings`);
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return invalid(`${what} must be an array of strings`);
    if (PIPELINE_CONTROL_CHAR_RE.test(raw)) return invalid(`${what} must not contain control characters`);
    const name = normalizeSkillName(raw);
    if (!name) {
      const stripped = raw.trim().replace(/^\//, "").trim();
      if (stripped.length > 0) {
        return invalid(`${what}: a skill name must be ${AGENT_PROFILE_LIMITS.skillName} characters or fewer`);
      }
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    skills.push(name);
  }
  if (skills.length > AGENT_PROFILE_LIMITS.skills) {
    return invalid(`${what}: at most ${AGENT_PROFILE_LIMITS.skills} skills`);
  }
  return skills;
}

function maxStepsField(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > PIPELINE_LIMITS.maxStepsMax) {
    return invalid(`${what} must be an integer between 1 and ${PIPELINE_LIMITS.maxStepsMax}`);
  }
  return value;
}

function parseAgent(raw: unknown, index: number, keys: Set<string>): BundleAgent {
  const at = `agents[${index}]`;
  if (!isPlainObject(raw)) return invalid(`${at} must be an object`);
  if (typeof raw.key !== "string" || raw.key.length === 0) return invalid(`${at}.key is required`);
  const key = raw.key;
  if (key.length > BUNDLE_LIMITS.key) return invalid(`${at}.key must be ${BUNDLE_LIMITS.key} characters or fewer`);
  if (PIPELINE_CONTROL_CHAR_RE.test(key)) return invalid(`${at}.key must not contain control characters`);
  if (keys.has(key)) return invalid(`duplicate Agent key "${key}"`);
  keys.add(key);

  const label = `Agent "${key}"`;
  const name = lineField(raw.name, `${label} name`, AGENT_PROFILE_LIMITS.name);

  if (!isPlainObject(raw.harness)) return invalid(`${label} harness must be an object with id, kind and label`);
  const id = lineField(raw.harness.id, `${label} harness.id`, BUNDLE_LIMITS.harnessId);
  const kind = lineField(raw.harness.kind, `${label} harness.kind`, BUNDLE_LIMITS.harnessKind);
  const harnessLabel =
    optionalLineField(raw.harness.label, `${label} harness.label`, BUNDLE_LIMITS.harnessLabel) ?? id;

  return {
    key,
    name,
    harness: { id, kind, label: harnessLabel },
    model: lineField(raw.model, `${label} model`, BUNDLE_LIMITS.model),
    effort: optionalLineField(raw.effort, `${label} effort`, BUNDLE_LIMITS.effort),
    mode: optionalLineField(raw.mode, `${label} mode`, BUNDLE_LIMITS.mode),
    fast: boolField(raw.fast, `${label} fast`),
    maxMode: boolField(raw.maxMode, `${label} maxMode`),
    instructions: textField(raw.instructions, `${label} instructions`, AGENT_PROFILE_LIMITS.instructions),
    skills: skillsField(raw.skills, `${label} skills`),
  };
}

/** Step instructions are multi-line text; `validatePipelineGraph` checks
 *  their length but not their control characters. */
function checkStepInstructions(graph: PipelineGraph, label: string): void {
  for (const step of graph.steps) {
    if (MULTILINE_CONTROL_CHAR_RE.test(step.instructions)) {
      invalid(`${label}, step "${step.name}" instructions must not contain control characters`);
    }
  }
}

function parseBundlePipeline(raw: unknown, index: number, keys: Set<string>): ParsedBundlePipeline {
  const at = `pipelines[${index}]`;
  if (!isPlainObject(raw)) return invalid(`${at} must be an object`);
  const name = lineField(raw.name, `${at} name`, PIPELINE_LIMITS.name);
  const label = `Pipeline "${name}"`;
  const description = textField(raw.description, `${label} description`, PIPELINE_LIMITS.description);
  const maxSteps = maxStepsField(raw.maxSteps, `${label} maxSteps`);

  if (!isPlainObject(raw.graph)) return invalid(`${label} graph must be an object`);
  if (!Array.isArray(raw.graph.steps)) return invalid(`${label} graph.steps must be an array`);
  // Map the public `agent` / `subagents.agents` names onto the internal
  // `agentProfileId` / `subagents.profileIds` (K3), then reuse the one graph
  // validator every other write path runs.
  const steps = raw.graph.steps.map((step: unknown, i: number) => {
    if (!isPlainObject(step)) return step;
    const where = `${label}, step ${typeof step.name === "string" ? `"${step.name}"` : `#${i + 1}`}`;
    if (step.agent !== undefined && step.agent !== null && typeof step.agent !== "string") {
      invalid(`${where}: agent must be an Agent key or null`);
    }
    const sub = isPlainObject(step.subagents) ? step.subagents : {};
    if (sub.agents !== undefined && (!Array.isArray(sub.agents) || sub.agents.some((k) => typeof k !== "string"))) {
      invalid(`${where}: subagents.agents must be an array of Agent keys`);
    }
    const { agent: _agent, agentProfileId: _id, ...rest } = step;
    return {
      ...rest,
      agentProfileId: typeof step.agent === "string" ? step.agent : null,
      subagents: { profileIds: Array.isArray(sub.agents) ? sub.agents : [], cap: sub.cap },
    };
  });
  const validated = validatePipelineGraph({ ...raw.graph, steps });
  if (!validated.ok) return invalid(`${label}: ${validated.error}`);
  const graph = validated.graph;
  checkStepInstructions(graph, label);

  for (const step of graph.steps) {
    if (step.agentProfileId !== null && !keys.has(step.agentProfileId)) {
      invalid(`${label}, step "${step.name}" references unknown Agent "${step.agentProfileId}"`);
    }
    for (const key of step.subagents.profileIds) {
      if (!keys.has(key)) invalid(`${label}, step "${step.name}" delegates to unknown Agent "${key}"`);
    }
  }

  return { name, description, maxSteps: maxSteps ?? PIPELINE_LIMITS.maxStepsDefault, graph, legacyHints: null };
}

/** Pull a legacy file's per-step name hints off the RAW graph, aligned with
 *  the validator's normalized (deduplicated) `subagents.profileIds`. */
function legacyHints(rawGraph: Record<string, unknown>, graph: PipelineGraph): Record<string, LegacyStepHints> {
  const hintText = (x: unknown): string | null =>
    typeof x === "string" && x.trim() && !PIPELINE_CONTROL_CHAR_RE.test(x) ? x.trim() : null;
  const rawById = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(rawGraph.steps) ? rawGraph.steps : []) {
    if (isPlainObject(raw) && typeof raw.id === "string" && !rawById.has(raw.id)) rawById.set(raw.id, raw);
  }
  const hints: Record<string, LegacyStepHints> = {};
  for (const step of graph.steps) {
    const raw = rawById.get(step.id) ?? {};
    const sub = isPlainObject(raw.subagents) ? raw.subagents : {};
    const ids = Array.isArray(sub.profileIds) ? sub.profileIds : [];
    const names = Array.isArray(sub.profileNames) ? sub.profileNames : [];
    const nameById = new Map<string, string | null>();
    ids.forEach((id, i) => {
      if (typeof id === "string" && !nameById.has(id)) nameById.set(id, hintText(names[i]));
    });
    hints[step.id] = {
      profileName: hintText(raw.profileName),
      subagentProfileNames: step.subagents.profileIds.map((id) => nameById.get(id) ?? null),
    };
  }
  return hints;
}

/** K12: a bare `PipelineInput` (the pre-bundle `agetor pipeline export`). */
function parseLegacy(obj: Record<string, unknown>): ParsedBundle {
  const name = lineField(obj.name, "pipeline name", PIPELINE_LIMITS.name);
  const label = `Pipeline "${name}"`;
  const description = textField(obj.description, `${label} description`, PIPELINE_LIMITS.description);
  const maxSteps = maxStepsField(obj.maxSteps, `${label} maxSteps`);
  const rawGraph = obj.graph as Record<string, unknown>;
  const validated = validatePipelineGraph(rawGraph);
  if (!validated.ok) return invalid(`${label}: ${validated.error}`);
  checkStepInstructions(validated.graph, label);
  return {
    legacy: true,
    agents: [],
    pipelines: [
      { name, description, maxSteps, graph: validated.graph, legacyHints: legacyHints(rawGraph, validated.graph) },
    ],
    exportedAt: null,
    agetorVersion: null,
  };
}

const shortString = (x: unknown): string | null =>
  typeof x === "string" && x.length > 0 && x.length <= 100 && !PIPELINE_CONTROL_CHAR_RE.test(x) ? x : null;

/**
 * Parse and validate import text (K11/K12). Accepts an agetor bundle or a
 * legacy pipeline file; never throws. Unknown keys are ignored, and so are
 * any harness fields other than `id`/`kind`/`label` (a file's `home`, `bin`
 * or `env` never reach the result).
 */
export function parseBundleText(text: string): ParseResult {
  if (utf8ByteLength(text) > BUNDLE_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `file is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB`,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, code: "invalid-json", error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isPlainObject(data)) {
    return { ok: false, code: "unrecognized", error: "not an agetor bundle — expected a JSON object" };
  }

  try {
    if (data.format === undefined) {
      if (typeof data.name === "string" && isPlainObject(data.graph)) return { ok: true, bundle: parseLegacy(data) };
      return { ok: false, code: "unrecognized", error: "not an agetor bundle or pipeline file" };
    }
    if (data.format !== BUNDLE_FORMAT) {
      return { ok: false, code: "unrecognized", error: `not an agetor bundle (format "${String(data.format)}")` };
    }
    const version = data.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      return { ok: false, code: "invalid", error: "version must be a positive integer" };
    }
    if (version > BUNDLE_VERSION) {
      return {
        ok: false,
        code: "unsupported-version",
        error: `this file uses bundle version ${version}, newer than this agetor supports (${BUNDLE_VERSION}) — update agetor to import this file`,
      };
    }

    const rawAgents = data.agents ?? [];
    const rawPipelines = data.pipelines ?? [];
    if (!Array.isArray(rawAgents)) return { ok: false, code: "invalid", error: "agents must be an array" };
    if (!Array.isArray(rawPipelines)) return { ok: false, code: "invalid", error: "pipelines must be an array" };
    if (rawAgents.length > BUNDLE_LIMITS.agents) {
      return { ok: false, code: "invalid", error: `a bundle holds at most ${BUNDLE_LIMITS.agents} Agents` };
    }
    if (rawPipelines.length > BUNDLE_LIMITS.pipelines) {
      return { ok: false, code: "invalid", error: `a bundle holds at most ${BUNDLE_LIMITS.pipelines} Pipelines` };
    }
    if (rawAgents.length === 0 && rawPipelines.length === 0) {
      return { ok: false, code: "invalid", error: "nothing to import — the file has no Agents or Pipelines" };
    }

    const keys = new Set<string>();
    const agents = rawAgents.map((raw, i) => parseAgent(raw, i, keys));
    const pipelines = rawPipelines.map((raw, i) => parseBundlePipeline(raw, i, keys));
    return {
      ok: true,
      bundle: {
        legacy: false,
        agents,
        pipelines,
        exportedAt: shortString(data.exportedAt),
        agetorVersion: shortString(data.agetorVersion),
      },
    };
  } catch (err) {
    if (err instanceof BundleInvalid) return { ok: false, code: "invalid", error: err.message };
    return { ok: false, code: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
}
