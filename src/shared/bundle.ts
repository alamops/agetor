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
import { AGENT_PROFILE_LIMITS, normalizeSkillName, SKILL_NAME_LEAD_RE } from "./agent-profile.ts";
import { LONE_SURROGATE_RE, PIPELINE_CONTROL_CHAR_RE, stepNameKey, validatePipelineGraph } from "./pipeline.ts";
import { DEFAULT_MODEL, PIPELINE_LIMITS } from "./types.ts";
import {
  cutTo,
  escapeCapped,
  escapeControlChars,
  findInvisibleChar,
  LONE_SURROGATE_G,
  stripControls,
  stripInvisible,
} from "./terminal-text.ts";
import type { AgentProfile, Harness, Pipeline, PipelineEdge, PipelineGraph } from "./types.ts";

export const BUNDLE_FORMAT = "agetor-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_FILE_EXT = ".agetor.json";
/** Largest import text accepted, in UTF-8 bytes. */
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
/** Largest `/bundle/*` request body the server reads at all: the import
 *  text plus JSON-escaping headroom plus the options object. The server
 *  checks it against `Content-Length` before reading the body, like
 *  `/screenshots`; the webview checks a request it is about to send against
 *  it too, since text full of control characters grows up to 6x as JSON. */
export const BUNDLE_MAX_REQUEST_BYTES = 2 * BUNDLE_MAX_BYTES + 64 * 1024;
/** Count and length caps for bundle-only fields; Agent and Pipeline fields
 *  reuse `AGENT_PROFILE_LIMITS` / `PIPELINE_LIMITS`. */
export const BUNDLE_LIMITS = {
  agents: 500,
  pipelines: 200,
  key: 128,
  harnessId: 128,
  harnessKind: 64,
  harnessLabel: 200,
  model: AGENT_PROFILE_LIMITS.model,
  effort: AGENT_PROFILE_LIMITS.effort,
  mode: AGENT_PROFILE_LIMITS.mode,
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

/** `POST /bundle/export`'s response. `text` is the canonical file text. */
export interface BundleExportResponse {
  text: string;
  filename: string;
  warnings: string[];
  counts: { agents: number; pipelines: number };
}

/** `POST /bundle/export/save`'s response. */
export type BundleSaveResponse =
  | {
      path: string;
      filename: string;
      /** False when there is no Finder to reveal it in (headless). */
      revealed: boolean;
      warnings: string[];
      counts: { agents: number; pipelines: number };
    }
  | { cancelled: true };

/** `POST /bundle/pick-file`'s response. */
export type BundlePickResponse = { text: string; filename: string } | { cancelled: true };

const KEY_SLUG_MAX = 64;
const FILE_SLUG_MAX = 64;

/** Lower-case kebab slug (`[a-z0-9-]`), capped at `max` chars; "" when the
 *  input has no usable characters. */
function slugify(s: string, max: number): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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


/** File text quoted for an error message: control characters escaped, cut
 *  to `max` characters. */
function quoted(value: string, max = 60): string {
  const cut = cutTo(value, max);
  return `"${escapeControlChars(cut)}${cut.length < value.length ? "…" : ""}"`;
}

// The text-safety helpers live in ./terminal-text.ts; re-exported here for
// the bundle's existing importers. LONE_SURROGATE_RE is defined beside the
// graph validator, which refuses one in ids and Agent references.
export {
  escapeCapped,
  escapeControlChars,
  escapeFreeText,
  findInvisibleChar,
  stripInvisible,
  truncateText,
} from "./terminal-text.ts";
export { LONE_SURROGATE_RE };

const DEFAULT_IGNORABLE_G = /\p{Default_Ignorable_Code_Point}/gu;
const BLANK_RUN_G = /[\p{White_Space}\u2800]+/gu;
// Built on top of the stored `name_key` (`trim().toLowerCase()`, db.ts) so
// two names the database treats as one also clash here: lower-casing and
// NFC don't commute (`j\u030c` vs `J\u030c` lower-case to the same string,
// but NFC composes only the lower one, to U+01F0, which has no precomposed
// capital), so NFC first would let a name through the preview that every
// commit then refuses as taken.
/** The key two Agent (or two Pipeline) names clash under, in a file and
 *  against local rows: import renames or refuses a name whose key is taken. */
export const bundleNameKey = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(DEFAULT_IGNORABLE_G, "")
    .replace(BLANK_RUN_G, " ")
    .trim()
    .toLowerCase();

/** Longest parser error returned, in characters. */
const MAX_ERROR_LENGTH = 500;

/** A single-line value as it would export, for warning text: escapes and
 *  control characters removed, trimmed. */
function plainLine(value: string): string {
  return stripControls(value, false).trim();
}

/** The fields one Agent or Pipeline had changed on export, for its warning. */
interface ExportChanges {
  stripped: string[];
  /** Fields whose lone surrogates became U+FFFD (graph text, where removing
   *  them could make two names equal or empty one). */
  replaced: string[];
  shortened: string[];
  renamed: string[];
  /** Fields of which some values were dropped outright (an edge label that
   *  cleaning made ambiguous). */
  dropped: string[];
  /** Required fields cleaning emptied, replaced by a default (an Agent's
   *  model made only of invisible characters). */
  defaulted: string[];
}

const noChanges = (): ExportChanges => ({
  stripped: [],
  replaced: [],
  shortened: [],
  renamed: [],
  dropped: [],
  defaulted: [],
});

function note(list: string[], field: string): void {
  if (!list.includes(field)) list.push(field);
}

/**
 * Make `value` pass `parseBundleText`, so data the local write paths accept
 * (an ANSI escape pasted into Agent instructions, a harness label longer
 * than import allows, say) still exports as a file agetor will import:
 * escape sequences and refused control characters are removed, a single-line
 * value is trimmed, and a value over `max` is cut. `field` names the change
 * in the caller's warning.
 */
function exportText(
  value: string,
  opts: { multiline?: boolean; max?: number },
  field: string,
  changes: ExportChanges,
): string {
  const multiline = opts.multiline ?? false;
  const stripped = stripControls(value, multiline);
  if (stripped !== value) note(changes.stripped, field);
  let out = multiline ? stripped : stripped.trim();
  if (opts.max !== undefined && out.length > opts.max) {
    // A cut can strand a joiner or selector whose context was the character
    // after it (a ZWJ before the emoji it joined), which import refuses; the
    // second strip takes it off, so the export still parses.
    out = stripInvisible(cutTo(out, opts.max), multiline);
    if (!multiline) out = out.trimEnd();
    note(changes.shortened, field);
  }
  return out;
}

/** "control characters were removed from its name; its model was cut to
 *  fit", or null when nothing changed. */
function describeChanges(changes: ExportChanges): string | null {
  const parts: string[] = [];
  if (changes.stripped.length > 0) {
    parts.push(`control or invisible characters were removed from its ${changes.stripped.join(", ")}`);
  }
  if (changes.replaced.length > 0) {
    parts.push(`unpaired surrogate characters in its ${changes.replaced.join(", ")} were replaced with U+FFFD`);
  }
  if (changes.shortened.length > 0) {
    parts.push(`its ${changes.shortened.join(", ")} ${changes.shortened.length === 1 ? "was" : "were"} cut to fit`);
  }
  if (changes.renamed.includes("name")) {
    parts.push("its name was empty after cleanup, so it was given a numbered one");
  }
  if (changes.renamed.includes(DISTINCT_NAME)) {
    parts.push("after cleanup its name matched another one in this export, so it was renamed to keep them distinct");
  }
  const renamedLists = changes.renamed.filter((field) => field !== "name" && field !== DISTINCT_NAME);
  if (renamedLists.length > 0) {
    parts.push(`some of its ${renamedLists.join(", ")} were renamed to keep them distinct`);
  }
  if (changes.dropped.length > 0) {
    parts.push(
      `some of its ${changes.dropped.join(", ")} were removed because, after export cleanup, they matched another label on the same step or the name of another step it leads to`,
    );
  }
  if (changes.defaulted.length > 0) {
    parts.push(
      `its ${changes.defaulted.join(", ")} ${changes.defaulted.length === 1 ? "was" : "were"} empty and ${changes.defaulted.length === 1 ? "was" : "were"} set to the harness default`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** C0 controls and DEL, which the graph validator refuses in ids. */
const ID_CONTROL_CHARS_G = /[\u0000-\u001f\u007f]/g;

/** `id` without the characters import refuses in an id or an Agent
 *  reference: control characters and lone surrogates (the graph validator)
 *  and C1 controls, bidi overrides and other invisible characters
 *  (`checkGraphText`, by the single-line rule). */
function cleanId(id: string): string {
  return stripInvisible(id.replace(LONE_SURROGATE_G, "").replace(ID_CONTROL_CHARS_G, ""), false);
}

/** `ids` with every value `cleanId` changes replaced by a clean one that is
 *  unique among them — ids left alone keep theirs; one cleaning empties
 *  becomes `<prefix>-<n>`. A non-string entry is kept for the validator. */
function cleanUniqueIds(ids: unknown[], prefix: string): unknown[] {
  const taken = new Set(ids.filter((id): id is string => typeof id === "string" && cleanId(id) === id));
  return ids.map((id, i) => {
    if (typeof id !== "string" || cleanId(id) === id) return id;
    const base = cleanId(id) || `${prefix}-${i + 1}`;
    let candidate = cutTo(base, PIPELINE_LIMITS.id);
    for (let n = 2; taken.has(candidate); n++) {
      const suffix = `-${n}`;
      candidate = `${cutTo(base, PIPELINE_LIMITS.id - suffix.length)}${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

/**
 * A stored graph with the characters import refuses in an id removed from
 * its step ids, edge ids and Agent references (see `cleanId`), and lone
 * surrogates in its step names, step instructions and edge labels replaced
 * with U+FFFD — all of which the validator (and so import) refuses; the rest
 * of the text cleanup runs after it. Replacing rather than removing never
 * empties a name — the same choice `String.prototype.toWellFormed` makes —
 * but every lone surrogate becomes the same U+FFFD, so two names can still
 * meet (`Review\ud800` and `Review\udbff`, or `Review\ud800` and a stored
 * `Review\ufffd`), as can two labels of one step or a label and a sibling
 * target's name, which the validator would refuse. A name this changed that
 * clashes takes a ` 2`/` 3` suffix (an unchanged name keeps it, so a `next`
 * naming it still routes there); a label this changed that clashes is
 * removed (the edge still routes). Stored graphs can hold them — a JSON
 * column or route keeps `"\ud800"` — and ids can't be edited, so export
 * cleans them rather than refuse the Pipeline: ids stay unique, and edges
 * and `startStepId` keep pointing at the same steps. A cleaned reference
 * can't name a stored Agent (their ids are generated), so its step exports
 * without that Agent, with the usual warning. A graph whose step (or edge)
 * ids already repeat is left as it is for the validator to refuse —
 * cleaning would hide the clash. Accepted residual: a cleaned step id is
 * not checked against edge labels, so a hand-edited id `b\u200b` that
 * cleans to `b` beside a sibling edge labelled `b` makes a `next: "b"`
 * route by id (ids are matched before labels) where it used to route by
 * label; the editor's ids are `crypto.randomUUID()`s, so only a hand-edited
 * row can reach this.
 * The input is shape-safe (`parsePipelineGraph`), not validated.
 */
function cleanStoredGraph(graph: PipelineGraph, changes: ExportChanges): PipelineGraph {
  const rawSteps: unknown[] = Array.isArray(graph.steps) ? graph.steps : [];
  const rawEdges: unknown[] = Array.isArray(graph.edges) ? graph.edges : [];
  const field = (x: unknown, key: string): unknown => (isPlainObject(x) ? x[key] : undefined);
  const unique = (ids: unknown[]): boolean => new Set(ids).size === ids.length;

  const stepIds = rawSteps.map((step) => field(step, "id"));
  const newStepIds = unique(stepIds) ? cleanUniqueIds(stepIds, "step") : stepIds;
  const stepIdMap = new Map<unknown, unknown>(stepIds.map((id, i) => [id, newStepIds[i]] as const));
  const mapStep = (id: unknown): unknown => (stepIdMap.has(id) ? stepIdMap.get(id) : id);
  if (newStepIds.some((id, i) => id !== stepIds[i])) note(changes.stripped, "step ids");

  const edgeIds = rawEdges.map((edge) => field(edge, "id"));
  const newEdgeIds = unique(edgeIds) ? cleanUniqueIds(edgeIds, "edge") : edgeIds;
  if (newEdgeIds.some((id, i) => id !== edgeIds[i])) note(changes.stripped, "edge ids");

  const replaceLoneSurrogates = (text: unknown, field: string): unknown => {
    if (typeof text !== "string" || !LONE_SURROGATE_RE.test(text)) return text;
    note(changes.replaced, field);
    return text.replace(LONE_SURROGATE_G, "\ufffd");
  };
  const cleanRef = (ref: unknown): unknown => {
    if (typeof ref !== "string" || cleanId(ref) === ref) return ref;
    note(changes.stripped, "Agent references");
    return cleanId(ref);
  };

  const steps = rawSteps.map((step, i) => {
    if (!isPlainObject(step)) return step;
    const sub = step.subagents;
    return {
      ...step,
      id: newStepIds[i],
      name: replaceLoneSurrogates(step.name, "step names"),
      instructions: replaceLoneSurrogates(step.instructions, "step instructions"),
      agentProfileId: cleanRef(step.agentProfileId),
      subagents:
        isPlainObject(sub) && Array.isArray(sub.profileIds) ? { ...sub, profileIds: sub.profileIds.map(cleanRef) } : sub,
    };
  });
  const edges = rawEdges.map((edge, i) =>
    isPlainObject(edge)
      ? {
          ...edge,
          id: newEdgeIds[i],
          from: mapStep(edge.from),
          to: mapStep(edge.to),
          label: replaceLoneSurrogates(edge.label, "edge labels"),
        }
      : edge,
  );
  keepReplacedTextDistinct(rawSteps, steps, rawEdges, edges, changes);
  return { ...graph, steps, edges, startStepId: mapStep(graph.startStepId) } as PipelineGraph;
}

/**
 * Make the step names and edge labels `cleanStoredGraph` replaced lone
 * surrogates in distinct again, in place, under the validator's own rules
 * (`stepNameKey` over the trimmed, whitespace-collapsed name). Unchanged
 * names are claimed first, so only a changed name takes a ` 2`/` 3` suffix
 * (cut to the step-name cap) — also when it equals an unchanged label on
 * another edge out of a step that leads to it, or the id of another target
 * of such a step (ids are matched before labels, after names); unchanged
 * labels are claimed first too, so only a changed label that now equals
 * another label of the same step, or the name of a different target of
 * that step, is emptied.
 * `buildBundle`'s invisible-character pass follows the same rules. Anything
 * that isn't a string is left for the validator.
 */
function keepReplacedTextDistinct(
  rawSteps: unknown[],
  steps: unknown[],
  rawEdges: unknown[],
  edges: unknown[],
  changes: ExportChanges,
): void {
  const textOf = (x: unknown, key: string): string | null =>
    isPlainObject(x) && typeof x[key] === "string" ? (x[key] as string) : null;
  const tidy = (name: string): string => name.trim().replace(/\s+/g, " ");

  const nameChanged = (i: number): boolean => textOf(steps[i], "name") !== textOf(rawSteps[i], "name");
  const labelChanged = (i: number): boolean => textOf(edges[i], "label") !== textOf(rawEdges[i], "label");
  // Keys a changed name must not take: an unchanged label on another edge
  // out of a step that also leads to this one, and the id of that step's
  // other targets (`resolveNextSteps` tries names before ids). (A changed
  // label that clashes is emptied below instead.)
  const labelKeysAround = (stepId: unknown): Set<string> => {
    const sources = new Set<unknown>();
    for (const edge of edges) if (isPlainObject(edge) && edge.to === stepId) sources.add(edge.from);
    const keys = new Set<string>();
    edges.forEach((edge, i) => {
      if (!isPlainObject(edge) || !sources.has(edge.from) || edge.to === stepId) return;
      if (typeof edge.to === "string") keys.add(stepNameKey(edge.to));
      const label = textOf(edge, "label");
      if (label === null || label.trim().length === 0 || labelChanged(i)) return;
      keys.add(stepNameKey(label));
    });
    return keys;
  };
  const order = steps.map((_, i) => i);
  order.sort((a, b) => Number(nameChanged(a)) - Number(nameChanged(b)) || a - b);
  const takenNames = new Set<string>();
  for (const i of order) {
    const name = textOf(steps[i], "name");
    if (name === null) continue;
    const base = tidy(name);
    if (base.length === 0) continue;
    let candidate = base;
    if (nameChanged(i)) {
      const labelKeys = labelKeysAround(isPlainObject(steps[i]) ? (steps[i] as Record<string, unknown>).id : undefined);
      const taken = (key: string): boolean => takenNames.has(key) || labelKeys.has(key);
      for (let n = 2; taken(stepNameKey(candidate)); n++) {
        const suffix = ` ${n}`;
        candidate = `${cutTo(base, PIPELINE_LIMITS.stepName - suffix.length).trimEnd()}${suffix}`;
      }
      if (candidate !== base) {
        (steps[i] as Record<string, unknown>).name = candidate;
        note(changes.renamed, "step names");
      }
    }
    takenNames.add(stepNameKey(candidate));
  }

  const nameKeyById = new Map<unknown, string>();
  for (const step of steps) {
    const name = textOf(step, "name");
    if (name !== null && isPlainObject(step)) nameKeyById.set(step.id, stepNameKey(name));
  }
  const edgeOrder = edges.map((_, i) => i);
  edgeOrder.sort((a, b) => Number(labelChanged(a)) - Number(labelChanged(b)) || a - b);
  const keptLabels = new Map<unknown, Set<string>>();
  for (const i of edgeOrder) {
    const edge = edges[i];
    const label = textOf(edge, "label");
    if (label === null || label.trim().length === 0 || !isPlainObject(edge)) continue;
    const key = stepNameKey(label);
    let kept = keptLabels.get(edge.from);
    if (!kept) {
      kept = new Set();
      keptLabels.set(edge.from, kept);
    }
    if (labelChanged(i)) {
      const namesSibling = edges.some(
        (sibling) =>
          isPlainObject(sibling) &&
          sibling.from === edge.from &&
          sibling.to !== edge.to &&
          nameKeyById.get(sibling.to) === key,
      );
      if (kept.has(key) || namesSibling) {
        edge.label = "";
        note(changes.dropped, "edge labels");
        continue;
      }
    }
    kept.add(key);
  }
}

/**
 * `names` with every one cleaning emptied replaced by `<noun> N`, N counting
 * up from the item's position past any name the file already holds under
 * `bundleNameKey` — otherwise a Pipeline literally named "Pipeline 2" and
 * one that cleans to nothing would both export as "Pipeline 2", and import
 * would rename the second without saying why. Noted on that item's changes.
 */
function fillEmptyNames(names: string[], noun: string, changes: ExportChanges[]): string[] {
  const taken = new Set(names.filter((name) => name.length > 0).map(bundleNameKey));
  return names.map((name, i) => {
    if (name) return name;
    let n = i + 1;
    while (taken.has(bundleNameKey(`${noun} ${n}`))) n++;
    const filled = `${noun} ${n}`;
    taken.add(bundleNameKey(filled));
    note(changes[i]!.renamed, "name");
    return filled;
  });
}

/** The `renamed` entry `keepNamesDistinct` notes. */
const DISTINCT_NAME = "distinct name";

/**
 * `names` (already cleaned and filled) made distinct under `bundleNameKey`:
 * cleaning can turn two local names that differed only by an invisible
 * character (`Reviewer` and `Reviewer\u200b`) into the same one, which
 * import would then rename `(imported)` on a fresh machine without saying
 * why. Names cleaning left alone (`raw[i].trim()`) reserve theirs first, in
 * order; every later name that clashes takes a ` 2`/` 3` suffix within
 * `max`, noted on that item's changes.
 */
function keepNamesDistinct(names: string[], raw: string[], max: number, changes: ExportChanges[]): string[] {
  const out = [...names];
  const order = names.map((_, i) => i);
  const changed = (i: number): boolean => names[i] !== raw[i]!.trim();
  order.sort((a, b) => Number(changed(a)) - Number(changed(b)) || a - b);
  const taken = new Set<string>();
  for (const i of order) {
    const base = names[i]!;
    let candidate = base;
    for (let n = 2; taken.has(bundleNameKey(candidate)); n++) {
      const suffix = ` ${n}`;
      candidate = `${stripInvisible(cutTo(base, max - suffix.length), false).trimEnd()}${suffix}`;
    }
    if (candidate !== base) {
      out[i] = candidate;
      note(changes[i]!.renamed, DISTINCT_NAME);
    }
    taken.add(bundleNameKey(candidate));
  }
  return out;
}

const byNameThenId = <T extends { name: string; id: string }>(a: T, b: T): number => {
  const an = a.name.trim().toLowerCase();
  const bn = b.name.trim().toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** `YYYY-MM-DD` of `d` in the local time zone: the date the user exported
 *  on, which `toISOString` (UTC) gets wrong for an evening export west of
 *  UTC or a morning one east of it. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
 * - Control and invisible characters import would refuse are removed, with a
 *   warning per Agent or Pipeline.
 * - An unknown selected id, an empty selection, or a result with nothing in
 *   it is `{ ok: false }`.
 * - The result is round-tripped through `parseBundleText`: a file import
 *   would refuse (over `BUNDLE_MAX_BYTES`, more than `BUNDLE_LIMITS.agents`
 *   Agents or `.pipelines` Pipelines, or any other rule) is `{ ok: false }`,
 *   so every export this returns imports.
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
}):
  | { ok: true; bundle: BundleFile; text: string; filename: string; warnings: string[] }
  | { ok: false; error: string } {
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

  // Every writer stores validator output, but `parsePipelineGraph` (db.ts)
  // hands back a stored graph today's validator refuses as long as its shape
  // is intact — a legacy or hand-edited row, an edge without a label, say.
  // Export each graph the way the validator normalizes it, and refuse one it
  // fails by name rather than crash on a missing field.
  const pipelineChanges: ExportChanges[] = selectedPipelines.map(noChanges);
  for (let i = 0; i < selectedPipelines.length; i++) {
    const pipeline = selectedPipelines[i]!;
    const validated = validatePipelineGraph(cleanStoredGraph(pipeline.graph, pipelineChanges[i]!));
    if (!validated.ok) {
      return {
        ok: false,
        error: `Pipeline "${plainLine(pipeline.name) || pipeline.id}" can't be exported: its graph is invalid (${plainLine(validated.error)}) — fix it in the pipeline editor`,
      };
    }
    selectedPipelines[i] = { ...pipeline, graph: validated.graph };
  }

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
  // An Agent with no model exports with its harness kind's default; one whose
  // kind has none (a row left by a retired kind) can't be imported, so it is
  // skipped the same way.
  // Why each skipped Agent was left out, for the warnings of the steps that
  // reference it.
  const skipReason = new Map<string, string>();
  const exportable = included.filter((p) => {
    const h = harnessById.get(p.harness);
    if (!h) {
      skipReason.set(p.id, "its harness no longer exists");
      warnings.push(
        `Agent "${plainLine(p.name) || p.id}" was skipped: its harness "${plainLine(p.harness)}" no longer exists`,
      );
      return false;
    }
    if (!plainLine(p.model) && !Object.hasOwn(DEFAULT_MODEL, h.kind)) {
      skipReason.set(p.id, "it has no model and its harness kind has no default");
      warnings.push(
        `Agent "${plainLine(p.name) || p.id}" was skipped: it has no model and its harness kind "${plainLine(h.kind)}" has no default`,
      );
      return false;
    }
    return true;
  });

  const agentChanges: ExportChanges[] = exportable.map(noChanges);
  const agentNames = keepNamesDistinct(
    fillEmptyNames(
      exportable.map((p, i) => exportText(p.name, { max: AGENT_PROFILE_LIMITS.name }, "name", agentChanges[i]!)),
      "Agent",
      agentChanges,
    ),
    exportable.map((p) => p.name),
    AGENT_PROFILE_LIMITS.name,
    agentChanges,
  );
  const keys = assignAgentKeys(agentNames);
  const keyById = new Map(exportable.map((p, i) => [p.id, keys[i]!] as const));

  const agents: BundleAgent[] = exportable.map((p, i) => {
    const h = harnessById.get(p.harness)!;
    const changes = agentChanges[i]!;
    const line = (v: string, field: string, max: number): string => exportText(v, { max }, field, changes);
    const optional = (v: string | null, field: string, max: number): string | null =>
      v === null ? null : line(v, field, max) || null;
    // The harness id only drives an exact match on import — a cleaned id that
    // matches nothing falls back to the built-in of the same kind.
    const harnessId = line(h.id, "harness id", BUNDLE_LIMITS.harnessId) || h.kind;
    const harnessLabel = line(h.label, "harness label", BUNDLE_LIMITS.harnessLabel) || harnessId;
    // Import requires a model; one made only of invisible characters cleans
    // to nothing, so it exports as the harness kind's default instead.
    let model = line(p.model, "model", BUNDLE_LIMITS.model);
    if (!model) {
      // The filter above skipped every Agent whose kind has no default.
      model = DEFAULT_MODEL[h.kind];
      note(changes.defaulted, "model");
    }
    const agent: BundleAgent = {
      key: keys[i]!,
      name: agentNames[i]!,
      harness: {
        id: harnessId,
        kind: h.kind,
        label: harnessLabel,
      },
      model,
      effort: optional(p.effort, "effort", BUNDLE_LIMITS.effort),
      mode: optional(p.mode, "mode", BUNDLE_LIMITS.mode),
      fast: p.fast,
      maxMode: p.maxMode,
      instructions: exportText(p.instructions, { multiline: true }, "instructions", changes),
      // Cleaning can make two skills equal (`A\u200b` and `A`); keep one.
      skills: [
        ...new Set(p.skills.map((s) => exportText(s, {}, "skills", changes)).filter((s) => s.length > 0)),
      ],
    };
    const changed = describeChanges(changes);
    if (changed) warnings.push(`Agent "${agent.name}": ${changed}`);
    return agent;
  });

  // Worked out first so every warning names the Pipeline the way the file
  // does; numbered like Agents so two that clean to nothing stay apart.
  const pipelineNames = keepNamesDistinct(
    fillEmptyNames(
      selectedPipelines.map((pipeline, i) =>
        exportText(pipeline.name, { max: PIPELINE_LIMITS.name }, "name", pipelineChanges[i]!),
      ),
      "Pipeline",
      pipelineChanges,
    ),
    selectedPipelines.map((pipeline) => pipeline.name),
    PIPELINE_LIMITS.name,
    pipelineChanges,
  );
  const bundlePipelines: BundlePipeline[] = selectedPipelines.map((pipeline, pipelineIndex) => {
    const changes = pipelineChanges[pipelineIndex]!;
    const name = pipelineNames[pipelineIndex]!;
    // Cleaned step names, made unique again: stripping can empty a name made
    // only of invisible characters, or turn two distinct names into the same
    // one (`Review` and `Review\u200b`), and import refuses both.
    // Names cleaning left alone keep them; only the changed ones take a
    // suffix — so `Review\u200b` listed before a clean `Review` becomes
    // `Review 2`, and a `next: "Review"` still reaches the step it always did.
    // A changed name also steers clear of the labels cleaning leaves alone
    // on another edge out of a step that leads to it — the same rule as
    // `keepReplacedTextDistinct` — so the label keeps routing `next` where
    // it always did instead of being dropped for the renamed step's sake.
    // (Computed with a scratch record: the labels are noted below, in order.)
    const cleanedStepNames = pipeline.graph.steps.map((step) =>
      exportText(step.name, { max: PIPELINE_LIMITS.stepName }, "step names", changes),
    );
    const scratch = noChanges();
    // "Unchanged" means routing-unchanged: the cleaned text has the same
    // `stepNameKey` as the stored one. Cleaning trims single-line text, so a
    // label stored as `Yes ` (the editor stores labels untrimmed) exports as
    // `Yes` and still answers `next: "Yes"` exactly as it did.
    const labelUnchanged = pipeline.graph.edges.map(
      (e) =>
        e.label.trim().length > 0 &&
        stepNameKey(exportText(e.label, {}, "edge labels", scratch)) === stepNameKey(e.label),
    );
    // Keys a changed name must not take: the unchanged labels on another edge
    // out of a step that leads to it, and the ids of that step's other
    // targets — `resolveNextSteps` tries names before ids, so a name equal to
    // a sibling's id would steal a `next` that named the id.
    const routingKeysAround = (stepId: string): Set<string> => {
      const sources = new Set(pipeline.graph.edges.filter((e) => e.to === stepId).map((e) => e.from));
      const keys = new Set<string>();
      pipeline.graph.edges.forEach((e, i) => {
        if (!sources.has(e.from) || e.to === stepId) return;
        keys.add(stepNameKey(e.to));
        if (labelUnchanged[i]) keys.add(stepNameKey(e.label));
      });
      return keys;
    };
    const unchanged = (i: number): boolean =>
      stepNameKey(cleanedStepNames[i]!) === stepNameKey(pipeline.graph.steps[i]!.name);
    const order = pipeline.graph.steps.map((_, i) => i);
    order.sort((a, b) => Number(unchanged(b)) - Number(unchanged(a)) || a - b);
    const stepNames: string[] = new Array(pipeline.graph.steps.length);
    const takenStepNames = new Set<string>();
    for (const i of order) {
      const cleaned = cleanedStepNames[i]!;
      const base = cleaned || `Step ${i + 1}`;
      const labelKeys = unchanged(i) ? new Set<string>() : routingKeysAround(pipeline.graph.steps[i]!.id);
      const taken = (key: string): boolean => takenStepNames.has(key) || labelKeys.has(key);
      let candidate = base;
      for (let n = 2; taken(stepNameKey(candidate)); n++) {
        const suffix = ` ${n}`;
        candidate = `${stripInvisible(cutTo(base, PIPELINE_LIMITS.stepName - suffix.length), false).trimEnd()}${suffix}`;
      }
      if (candidate !== cleaned) note(changes.renamed, "step names");
      takenStepNames.add(stepNameKey(candidate));
      stepNames[i] = candidate;
    }
    const steps: BundleStep[] = pipeline.graph.steps.map((step, stepIndex) => {
      let agent: string | null = null;
      if (step.agentProfileId !== null) {
        agent = keyById.get(step.agentProfileId) ?? null;
        if (agent === null) {
          const why = skipReason.get(step.agentProfileId) ?? "it no longer exists";
          warnings.push(
            `Pipeline "${name}", step "${stepNames[stepIndex]}": its Agent was left out (${why}) — the step exports without an Agent`,
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
            `Pipeline "${name}", step "${stepNames[stepIndex]}": a delegation Agent was left out (${skipReason.get(id) ?? "it no longer exists"})`,
          );
        }
      }
      return {
        id: step.id,
        name: stepNames[stepIndex]!,
        instructions: exportText(step.instructions, { multiline: true }, "step instructions", changes),
        agent,
        position: { x: step.position.x, y: step.position.y },
        subagents: { agents: delegated, cap: step.subagents.cap },
        transition: step.transition,
        join: step.join,
      };
    });
    const description = exportText(pipeline.description, { multiline: true }, "description", changes);
    const cleanedEdges: PipelineEdge[] = pipeline.graph.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label ? exportText(e.label, {}, "edge labels", changes) : e.label,
    }));
    // Cleaning can make two outgoing labels of one step equal (`Yes` and
    // `Yes\u200b`), or make a label spell a sibling target's (cleaned, maybe
    // renamed) name — both make `next` ambiguous, and import refuses them.
    // Labels cleaning left alone are claimed first, so only a changed label
    // of a clash is dropped (as in `keepReplacedTextDistinct`; an unchanged
    // one can't clash — the stored graph validated, and a changed name
    // avoided it above): the edge still routes, only that label alias is
    // lost, and a `next` naming an unchanged label still reaches the step it
    // always did.
    const stepNameKeyById = new Map(pipeline.graph.steps.map((s, i) => [s.id, stepNameKey(stepNames[i]!)] as const));
    const keptLabelKeys = new Map<string, Set<string>>();
    const edgeOrder = cleanedEdges.map((_, i) => i);
    edgeOrder.sort((a, b) => Number(labelUnchanged[b]) - Number(labelUnchanged[a]) || a - b);
    const edges: PipelineEdge[] = [...cleanedEdges];
    for (const i of edgeOrder) {
      const edge = cleanedEdges[i]!;
      if (edge.label.trim().length === 0) continue;
      const key = stepNameKey(edge.label);
      let kept = keptLabelKeys.get(edge.from);
      if (!kept) {
        kept = new Set();
        keptLabelKeys.set(edge.from, kept);
      }
      const namesSibling = cleanedEdges.some(
        (sibling) => sibling.from === edge.from && sibling.to !== edge.to && stepNameKeyById.get(sibling.to) === key,
      );
      if (kept.has(key) || namesSibling) {
        note(changes.dropped, "edge labels");
        edges[i] = { ...edge, label: "" };
        continue;
      }
      kept.add(key);
    }
    const changed = describeChanges(changes);
    if (changed) warnings.push(`Pipeline "${name}": ${changed}`);
    return {
      name,
      description,
      maxSteps: pipeline.maxSteps,
      graph: {
        steps,
        edges,
        startStepId: pipeline.graph.startStepId,
      },
    };
  });

  if (agents.length === 0 && bundlePipelines.length === 0) {
    return { ok: false, error: warnings[0] ?? "nothing to export" };
  }
  if (agents.length > BUNDLE_LIMITS.agents) {
    return {
      ok: false,
      error: `this export would hold ${agents.length} Agents — a bundle holds at most ${BUNDLE_LIMITS.agents}; export fewer at a time`,
    };
  }
  if (bundlePipelines.length > BUNDLE_LIMITS.pipelines) {
    return {
      ok: false,
      error: `this export would hold ${bundlePipelines.length} Pipelines — a bundle holds at most ${BUNDLE_LIMITS.pipelines}; export fewer at a time`,
    };
  }

  const selectedCount = selectedProfiles.length + selectedPipelines.length;
  let filename: string;
  if (selectedCount === 1) {
    // The cleaned name, as the file carries it: the stored one may hold an
    // ANSI sequence whose parameter bytes would otherwise reach the slug.
    // A selected Agent is `agents[0]` (selected Agents come first, and with
    // nothing else selected it can't have been skipped — the export would be
    // empty).
    const only = selectedPipelines.length === 1 ? bundlePipelines[0]! : agents[0]!;
    const fallback = selectedPipelines.length === 1 ? "pipeline" : "agent";
    filename = `${slugify(only.name, FILE_SLUG_MAX) || fallback}${BUNDLE_FILE_EXT}`;
  } else {
    filename = `agetor-export-${localDate(input.now)}${BUNDLE_FILE_EXT}`;
  }

  const bundle: BundleFile = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: input.now.toISOString(),
    agetorVersion: input.agetorVersion,
    agents,
    pipelines: bundlePipelines,
  };
  const text = serializeBundle(bundle);
  // Never hand out a file agetor itself would refuse to import.
  const check = parseBundleText(text);
  if (!check.ok) {
    if (check.code === "too-large") {
      const mb = (new TextEncoder().encode(text).length / (1024 * 1024)).toFixed(1);
      return {
        ok: false,
        error: `this export would be ${mb} MB — over the ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB import limit; export fewer Agents or Pipelines at a time`,
      };
    }
    // The parser names an Agent by its file key; name it the way the user does.
    const nameByKey = new Map(agents.map((a) => [a.key, a.name] as const));
    const error = check.error.replace(/Agent "([^"]*)"/g, (whole, key: string) => {
      const display = nameByKey.get(key);
      return display === undefined ? whole : `Agent "${display}"`;
    });
    return { ok: false, error: `this export wouldn't import (${error}) — nothing was exported` };
  }

  return { ok: true, bundle, text, filename, warnings };
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

/** Longest legacy `profileName` hint kept, in UTF-16 units: a few times the
 *  Agent name cap, since a longer one can't match a stored name. */
export const LEGACY_HINT_MAX = 4 * AGENT_PROFILE_LIMITS.name;

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

/** Refuse `value` when it holds a lone surrogate (see `LONE_SURROGATE_RE`)
 *  or an invisible character (see `INVISIBLE_CANDIDATE_G` in ./terminal-text.ts), naming the code
 *  point. Every text field the parser keeps goes through here. */
function refuseInvisible(value: string, what: string, multiline: boolean): void {
  if (LONE_SURROGATE_RE.test(value)) invalid(`${what} must not contain a lone surrogate`);
  const found = findInvisibleChar(value, multiline);
  if (found) invalid(`${what} must not contain invisible characters (${found})`);
}

/** A required, trimmed, single-line string within `max` chars. */
function lineField(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") return invalid(`${what} must be a string`);
  const v = value.trim();
  if (v.length === 0) return invalid(`${what} is required`);
  if (v.length > max) return invalid(`${what} must be ${max} characters or fewer`);
  if (PIPELINE_CONTROL_CHAR_RE.test(v)) return invalid(`${what} must not contain control characters`);
  refuseInvisible(v, what, false);
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
  refuseInvisible(v, what, false);
  return v;
}

/** Optional multi-line text (absent reads as ""), kept verbatim. */
function textField(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return invalid(`${what} must be a string`);
  if (value.length > max) return invalid(`${what} must be ${max} characters or fewer`);
  if (MULTILINE_CONTROL_CHAR_RE.test(value)) return invalid(`${what} must not contain control characters`);
  refuseInvisible(value, what, true);
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
    refuseInvisible(raw, what, false);
    const name = normalizeSkillName(raw);
    if (!name) {
      const stripped = raw.replace(SKILL_NAME_LEAD_RE, "").trim();
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
  refuseInvisible(key, `${at}.key`, false);
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

/** What `validatePipelineGraph` doesn't check: control characters in step
 *  instructions (multi-line text), and invisible characters — C1 controls,
 *  bidi overrides, zero-width and tag characters, the BOM — in step ids,
 *  edge ids, step instructions, step names, edge labels and Agent references
 *  (import keeps ids verbatim, a legacy file's references are kept as they
 *  are when nothing local matches, and the CLI prints both). Ids and
 *  references with C0 control characters or lone surrogates are refused by
 *  the validator itself. */
function checkGraphText(graph: PipelineGraph, label: string): void {
  for (const step of graph.steps) {
    const where = `${label}, step ${quoted(step.name)}`;
    refuseInvisible(step.id, `${where} id`, false);
    refuseInvisible(step.name, `${where} name`, false);
    if (MULTILINE_CONTROL_CHAR_RE.test(step.instructions)) {
      invalid(`${where} instructions must not contain control characters`);
    }
    refuseInvisible(step.instructions, `${where} instructions`, true);
    if (step.agentProfileId !== null) refuseInvisible(step.agentProfileId, `${where} Agent reference`, false);
    for (const ref of step.subagents.profileIds) refuseInvisible(ref, `${where} delegation Agent reference`, false);
  }
  for (const edge of graph.edges) {
    refuseInvisible(edge.id, `${label}, edge id ${quoted(edge.id)}`, false);
    if (edge.label) refuseInvisible(edge.label, `${label}, edge label ${quoted(edge.label)}`, false);
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
  refuseCoercedGraphFields(raw.graph, label);
  // Map the public `agent` / `subagents.agents` names onto the internal
  // `agentProfileId` / `subagents.profileIds` (K3), then reuse the one graph
  // validator every other write path runs.
  const steps = raw.graph.steps.map((step: unknown, i: number) => {
    if (!isPlainObject(step)) return step;
    const where = `${label}, step ${typeof step.name === "string" ? quoted(step.name) : `#${i + 1}`}`;
    if (step.agent !== undefined && step.agent !== null && typeof step.agent !== "string") {
      invalid(`${where}: agent must be an Agent key or null`);
    }
    refuseMalformedSubagents(step.subagents, where);
    const sub = isPlainObject(step.subagents) ? step.subagents : {};
    // An empty key names no Agent, and the graph validator would drop it
    // without a word: refuse it like any other malformed key.
    if (step.agent === "") invalid(`${where}: agent must be an Agent key or null`);
    if (
      sub.agents !== undefined &&
      (!Array.isArray(sub.agents) || sub.agents.some((k) => typeof k !== "string" || k === ""))
    ) {
      invalid(`${where}: subagents.agents must be an array of Agent keys`);
    }
    // The internal names are not bundle fields, and dropping them would lose
    // the step's Agent or its delegations without a word (a hand-written file,
    // or a database row pasted in): refuse rather than import less than shown.
    if (step.agentProfileId !== undefined && step.agentProfileId !== null) {
      invalid(`${where}: agentProfileId is not a bundle field — name the Agent by its key in "agent"`);
    }
    if (sub.profileIds !== undefined && !(Array.isArray(sub.profileIds) && sub.profileIds.length === 0)) {
      invalid(`${where}: subagents.profileIds is not a bundle field — list Agent keys in "subagents.agents"`);
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
  checkGraphText(graph, label);

  for (const step of graph.steps) {
    if (step.agentProfileId !== null && !keys.has(step.agentProfileId)) {
      invalid(`${label}, step "${step.name}" references unknown Agent ${quoted(step.agentProfileId)}`);
    }
    for (const key of step.subagents.profileIds) {
      if (!keys.has(key)) invalid(`${label}, step "${step.name}" delegates to unknown Agent ${quoted(key)}`);
    }
  }

  return { name, description, maxSteps: maxSteps ?? PIPELINE_LIMITS.maxStepsDefault, graph, legacyHints: null };
}

/** Pull a legacy file's per-step name hints off the RAW graph, aligned with
 *  the validator's normalized (deduplicated) `subagents.profileIds`. */
function legacyHints(rawGraph: Record<string, unknown>, graph: PipelineGraph): Record<string, LegacyStepHints> {
  // A hint longer than LEGACY_HINT_MAX can't name a stored Agent (names are
  // capped at AGENT_PROFILE_LIMITS.name; the slack covers whitespace runs the
  // name match folds), so it's dropped rather than carried into every plan.
  const hintText = (x: unknown): string | null => {
    if (typeof x !== "string") return null;
    const hint = x.trim();
    return hint &&
      hint.length <= LEGACY_HINT_MAX &&
      !PIPELINE_CONTROL_CHAR_RE.test(hint) &&
      !LONE_SURROGATE_RE.test(hint) &&
      !findInvisibleChar(hint)
      ? hint
      : null;
  };
  const rawById = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(rawGraph.steps) ? rawGraph.steps : []) {
    if (isPlainObject(raw) && typeof raw.id === "string" && !rawById.has(raw.id)) rawById.set(raw.id, raw);
  }
  // Step ids come from the file: entries are collected and built with
  // Object.fromEntries, since `hints[id] = …` with the id "__proto__" would
  // set the object's prototype instead of adding an entry.
  const entries: [string, LegacyStepHints][] = [];
  for (const step of graph.steps) {
    const raw = rawById.get(step.id) ?? {};
    const sub = isPlainObject(raw.subagents) ? raw.subagents : {};
    const ids = Array.isArray(sub.profileIds) ? sub.profileIds : [];
    const names = Array.isArray(sub.profileNames) ? sub.profileNames : [];
    const nameById = new Map<string, string | null>();
    ids.forEach((id, i) => {
      if (typeof id === "string" && !nameById.has(id)) nameById.set(id, hintText(names[i]));
    });
    entries.push([
      step.id,
      {
        profileName: hintText(raw.profileName),
        subagentProfileNames: step.subagents.profileIds.map((id) => nameById.get(id) ?? null),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

/** A step's `subagents` must be absent, null or an object. The graph
 *  validator reads anything else as "no delegations", so `["reviewer"]` or
 *  `"reviewer"` would import a step with its delegations and cap silently
 *  dropped — refused instead, like a malformed `subagents.agents`. */
function refuseMalformedSubagents(subagents: unknown, where: string): void {
  if (subagents !== undefined && subagents !== null && !isPlainObject(subagents)) {
    invalid(`${where}: subagents must be an object`);
  }
}

/** Fields the graph validator coerces rather than refuses (K3): a step's
 *  non-string `instructions` and an edge's non-string `label` become "", and
 *  a second edge between the same two steps collapses into the first (its id
 *  and label lost). A third-party file is refused instead, so an import never
 *  holds less than the file shows. */
function refuseCoercedGraphFields(rawGraph: Record<string, unknown>, label: string): void {
  const rawSteps = Array.isArray(rawGraph.steps) ? rawGraph.steps : [];
  const nameById = new Map<string, string>();
  const stepIds = new Set<string>();
  let repeatedStepId = false;
  rawSteps.forEach((step: unknown, i: number) => {
    if (!isPlainObject(step)) return;
    if (typeof step.id === "string") {
      if (stepIds.has(step.id)) repeatedStepId = true;
      stepIds.add(step.id);
    }
    const where = `${label}, step ${typeof step.name === "string" ? quoted(step.name) : `#${i + 1}`}`;
    if (step.instructions !== undefined && step.instructions !== null && typeof step.instructions !== "string") {
      invalid(`${where}: instructions must be text`);
    }
    if (typeof step.id === "string" && typeof step.name === "string" && !nameById.has(step.id)) {
      nameById.set(step.id, step.name);
    }
  });
  const stepText = (id: string): string => quoted(nameById.get(id) ?? id);
  const firstByPair = new Map<string, string>();
  (Array.isArray(rawGraph.edges) ? rawGraph.edges : []).forEach((edge: unknown, i: number) => {
    if (!isPlainObject(edge)) return;
    const where = `${label}, edge ${typeof edge.id === "string" ? quoted(edge.id) : `#${i + 1}`}`;
    if (edge.label !== undefined && edge.label !== null && typeof edge.label !== "string") {
      invalid(`${where}: label must be text`);
    }
    // Leave a structurally broken edge — a self-edge, an end that names no
    // step, or any edge of a graph whose step ids repeat — to the graph
    // validator, whose message names the real problem; a repeat of such an
    // edge would otherwise be reported first.
    if (typeof edge.from !== "string" || typeof edge.to !== "string") return;
    if (repeatedStepId || edge.from === edge.to || !stepIds.has(edge.from) || !stepIds.has(edge.to)) return;
    const pair = `${edge.from}\u0000${edge.to}`;
    const first = firstByPair.get(pair);
    if (first !== undefined) {
      invalid(
        `${where} repeats the connection from step ${stepText(edge.from)} to step ${stepText(edge.to)} ` +
          `(edge ${quoted(first)}) — keep one of them`,
      );
    }
    firstByPair.set(pair, typeof edge.id === "string" ? edge.id : `#${i + 1}`);
  });
}

/** K12: a bare `PipelineInput` (the pre-bundle `agetor pipeline export`). */
function parseLegacy(obj: Record<string, unknown>): ParsedBundle {
  const name = lineField(obj.name, "pipeline name", PIPELINE_LIMITS.name);
  const label = `Pipeline "${name}"`;
  const description = textField(obj.description, `${label} description`, PIPELINE_LIMITS.description);
  const maxSteps = maxStepsField(obj.maxSteps, `${label} maxSteps`);
  const rawGraph = obj.graph as Record<string, unknown>;
  refuseCoercedGraphFields(rawGraph, label);
  if (Array.isArray(rawGraph.steps)) {
    rawGraph.steps.forEach((step: unknown, i: number) => {
      if (!isPlainObject(step)) return;
      const where = `${label}, step ${typeof step.name === "string" ? quoted(step.name) : `#${i + 1}`}`;
      refuseMalformedSubagents(step.subagents, where);
      // The graph validator reads a non-string reference as none and drops
      // non-string or empty delegation entries: refuse them rather than
      // import a step with fewer Agents than the file names (K3).
      if (step.agentProfileId !== undefined && step.agentProfileId !== null && typeof step.agentProfileId !== "string") {
        invalid(`${where}: agentProfileId must be an Agent id or null`);
      }
      const ids = isPlainObject(step.subagents) ? step.subagents.profileIds : undefined;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id === ""))) {
        invalid(`${where}: subagents.profileIds must be an array of Agent ids`);
      }
    });
  }
  const validated = validatePipelineGraph(rawGraph);
  if (!validated.ok) return invalid(`${label}: ${validated.error}`);
  checkGraphText(validated.graph, label);
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
  typeof x === "string" &&
  x.length > 0 &&
  x.length <= 100 &&
  !PIPELINE_CONTROL_CHAR_RE.test(x) &&
  !LONE_SURROGATE_RE.test(x) &&
  !findInvisibleChar(x)
    ? x
    : null;

/**
 * Parse and validate import text (K11/K12). Accepts an agetor bundle or a
 * legacy pipeline file; never throws. Unknown keys are ignored, and so are
 * any harness fields other than `id`/`kind`/`label` (a file's `home`, `bin`
 * or `env` never reach the result).
 */
export function parseBundleText(text: string): ParseResult {
  const result = parseBundleTextUnsafe(text);
  if (result.ok) return result;
  // Errors quote file text (a JSON token, a name that failed validation):
  // never hand a caller a raw control character, nor an unbounded message.
  return { ...result, error: escapeCapped(result.error, MAX_ERROR_LENGTH) };
}

function parseBundleTextUnsafe(text: string): ParseResult {
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
      const format =
        typeof data.format === "string"
          ? quoted(data.format)
          : data.format === null
            ? "null"
            : `of type ${Array.isArray(data.format) ? "array" : typeof data.format}`;
      return { ok: false, code: "unrecognized", error: `not an agetor bundle (format ${format})` };
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
