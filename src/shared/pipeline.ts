/**
 * Pure grammar for {@link Pipeline}s — named graphs of agent-profile-bound
 * steps, connected by edges, where each step ends its turn with a JSON
 * `<handoff>` block that tells the runner which step comes next. This module
 * is shared by the bun-side runner (`src/bun/orchestrator.ts`'s pipeline
 * execution, the `/pipelines` route validation) and the webview's canvas
 * editor / run view — kept free of runtime imports from either process side.
 * See `docs/plans/pipelines.md` (§3, D3/D4/D10) for the full design.
 */
import type {
  AgentProfileSnapshot,
  Handoff,
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineRunState,
  PipelineRunStatus,
  PipelineStep,
} from "./types.ts";
import { PIPELINE_LIMITS } from "./types.ts";

/** The XML-ish tag a step's agent is asked to wrap its final handoff JSON
 *  in — `<handoff>{...}</handoff>`. Single source of truth for both the
 *  prompt text ({@link composeStepPrompt}) and the parser ({@link
 *  parseHandoff})'s tag matching; renamed from `agetor_handoff` per the
 *  owner's D3 pick. */
export const HANDOFF_TAG = "handoff";

const HANDOFF_BLOCK_RE = new RegExp(
  `<${HANDOFF_TAG}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${HANDOFF_TAG}\\s*>`,
  "gi",
);

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Build a new {@link PipelineStep} with sensible defaults (a fresh uuid, the
 * name "New step", empty instructions, no bound profile, origin position, no
 * subagents, `transition: "choose"`, `join: "any"`), overridden by whatever
 * `partial` supplies. Used by the canvas editor's "add step" action and by
 * tests.
 */
export function newStep(partial?: Partial<PipelineStep>): PipelineStep {
  return {
    id: crypto.randomUUID(),
    name: "New step",
    instructions: "",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...partial,
  };
}

/**
 * Validate and normalize an arbitrary (e.g. request-body or DB-column) value
 * into a well-formed {@link PipelineGraph}. Trims/coerces recoverable
 * shape issues (missing `transition`/`join`/`subagents`, non-finite
 * positions, unknown keys, duplicate identical edges) but rejects anything
 * that would make the graph ambiguous or unsafe to run: a non-object input,
 * `steps`/`edges` not arrays or over their `PIPELINE_LIMITS` caps, an empty,
 * too-long, or duplicate (case-insensitive, trimmed) step name, instructions
 * over the length cap, a duplicate step id, an edge referencing a step that
 * doesn't exist, a self-edge, an out-of-range `subagents.cap`, an invalid
 * `transition`/`join` value, or a `startStepId` that isn't a step in the
 * graph. An empty `steps` array is itself valid — the shape of an
 * in-progress editor draft.
 */
export function validatePipelineGraph(
  g: unknown,
): { ok: true; graph: PipelineGraph } | { ok: false; error: string } {
  if (!isPlainObject(g)) return { ok: false, error: "graph must be an object" };

  const rawSteps = g.steps;
  if (!Array.isArray(rawSteps)) return { ok: false, error: "graph.steps must be an array" };
  if (rawSteps.length > PIPELINE_LIMITS.steps) {
    return { ok: false, error: `graph.steps exceeds the limit of ${PIPELINE_LIMITS.steps}` };
  }

  const steps: PipelineStep[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const rawStep of rawSteps) {
    if (!isPlainObject(rawStep)) return { ok: false, error: "each step must be an object" };

    const id = typeof rawStep.id === "string" && rawStep.id.length > 0 ? rawStep.id : null;
    if (id === null) return { ok: false, error: "each step must have a non-empty id" };
    if (seenIds.has(id)) return { ok: false, error: `duplicate step id "${id}"` };
    seenIds.add(id);

    const name = typeof rawStep.name === "string" ? rawStep.name.trim() : "";
    if (name.length === 0) return { ok: false, error: `step "${id}" has an empty name` };
    if (name.length > PIPELINE_LIMITS.stepName) {
      return { ok: false, error: `step "${name}" name exceeds ${PIPELINE_LIMITS.stepName} chars` };
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) return { ok: false, error: `duplicate step name "${name}"` };
    seenNames.add(nameKey);

    const instructions = typeof rawStep.instructions === "string" ? rawStep.instructions : "";
    if (instructions.length > PIPELINE_LIMITS.instructions) {
      return { ok: false, error: `step "${name}" instructions exceed ${PIPELINE_LIMITS.instructions} chars` };
    }

    const agentProfileId =
      typeof rawStep.agentProfileId === "string" && rawStep.agentProfileId.length > 0
        ? rawStep.agentProfileId
        : null;

    const rawPos = isPlainObject(rawStep.position) ? rawStep.position : {};
    const position = {
      x: isFiniteNumber(rawPos.x) ? rawPos.x : 0,
      y: isFiniteNumber(rawPos.y) ? rawPos.y : 0,
    };

    const rawSub = isPlainObject(rawStep.subagents) ? rawStep.subagents : {};
    const profileIdsRaw = Array.isArray(rawSub.profileIds) ? rawSub.profileIds : [];
    const profileIds = dedupeStrings(
      profileIdsRaw.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
    let cap: number | null = null;
    if (rawSub.cap !== undefined && rawSub.cap !== null) {
      const c = rawSub.cap;
      if (typeof c !== "number" || !Number.isInteger(c) || c <= 0) {
        return { ok: false, error: `step "${name}" subagents.cap must be null or a positive integer` };
      }
      cap = c;
    }

    let transition: PipelineStep["transition"];
    if (rawStep.transition === undefined) transition = "choose";
    else if (rawStep.transition === "choose" || rawStep.transition === "all") transition = rawStep.transition;
    else return { ok: false, error: `step "${name}" has an invalid transition value` };

    let join: PipelineStep["join"];
    if (rawStep.join === undefined) join = "any";
    else if (rawStep.join === "any" || rawStep.join === "all") join = rawStep.join;
    else return { ok: false, error: `step "${name}" has an invalid join value` };

    steps.push({ id, name, instructions, agentProfileId, position, subagents: { profileIds, cap }, transition, join });
  }

  const rawEdges = g.edges;
  if (!Array.isArray(rawEdges)) return { ok: false, error: "graph.edges must be an array" };
  if (rawEdges.length > PIPELINE_LIMITS.edges) {
    return { ok: false, error: `graph.edges exceeds the limit of ${PIPELINE_LIMITS.edges}` };
  }

  const stepIds = new Set(steps.map((s) => s.id));
  const edges: PipelineEdge[] = [];
  const seenPairs = new Set<string>();

  for (const rawEdge of rawEdges) {
    if (!isPlainObject(rawEdge)) return { ok: false, error: "each edge must be an object" };

    const id = typeof rawEdge.id === "string" && rawEdge.id.length > 0 ? rawEdge.id : null;
    if (id === null) return { ok: false, error: "each edge must have a non-empty id" };

    const from = typeof rawEdge.from === "string" ? rawEdge.from : "";
    const to = typeof rawEdge.to === "string" ? rawEdge.to : "";
    if (!stepIds.has(from)) return { ok: false, error: `edge "${id}" references unknown step "${from}"` };
    if (!stepIds.has(to)) return { ok: false, error: `edge "${id}" references unknown step "${to}"` };
    if (from === to) {
      return { ok: false, error: `edge "${id}" is a self-edge (step "${from}" to itself), which is not allowed` };
    }

    const pairKey = `${from}\u0000${to}`;
    if (seenPairs.has(pairKey)) continue; // duplicate identical edge — collapse to the first
    seenPairs.add(pairKey);

    const label = typeof rawEdge.label === "string" ? rawEdge.label : "";
    edges.push({ id, from, to, label });
  }

  let startStepId: string | null = null;
  if (g.startStepId !== undefined && g.startStepId !== null) {
    if (typeof g.startStepId !== "string" || !stepIds.has(g.startStepId)) {
      return { ok: false, error: "startStepId must reference an existing step" };
    }
    startStepId = g.startStepId;
  }

  return { ok: true, graph: { steps, edges, startStepId } };
}

/**
 * Resolve a graph's entry point: `startStepId` when it's set and names a
 * real step, else the unique step with no incoming edges, else `null` (zero
 * or two-or-more such candidates — an ambiguous graph the editor/runner must
 * surface, not guess at).
 */
export function resolveStartStep(g: PipelineGraph): PipelineStep | null {
  if (g.startStepId !== null) {
    const found = g.steps.find((s) => s.id === g.startStepId);
    if (found) return found;
  }
  const hasIncoming = new Set(g.edges.map((e) => e.to));
  const candidates = g.steps.filter((s) => !hasIncoming.has(s.id));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** Every outgoing edge of `stepId`, paired with its target step, in edge
 *  array order. Empty when `stepId` is terminal or unknown. */
export function outgoingSteps(g: PipelineGraph, stepId: string): { step: PipelineStep; edge: PipelineEdge }[] {
  const byId = new Map(g.steps.map((s) => [s.id, s] as const));
  const result: { step: PipelineStep; edge: PipelineEdge }[] = [];
  for (const edge of g.edges) {
    if (edge.from !== stepId) continue;
    const step = byId.get(edge.to);
    if (step) result.push({ step, edge });
  }
  return result;
}

/** Every incoming edge of `stepId`, paired with its source step, in edge
 *  array order. Empty when `stepId` is a start step or unknown. */
export function incomingSteps(g: PipelineGraph, stepId: string): { step: PipelineStep; edge: PipelineEdge }[] {
  const byId = new Map(g.steps.map((s) => [s.id, s] as const));
  const result: { step: PipelineStep; edge: PipelineEdge }[] = [];
  for (const edge of g.edges) {
    if (edge.to !== stepId) continue;
    const step = byId.get(edge.from);
    if (step) result.push({ step, edge });
  }
  return result;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenceMatch ? (fenceMatch[1] ?? "") : trimmed;
}

/** Find the first balanced `{…}` object starting at the first `{` in
 *  `text`, tolerant of quoted strings (including escaped quotes) so a brace
 *  inside a string value doesn't throw off the depth count. Returns `null`
 *  when no balanced object exists. */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function capField(s: string): string {
  return s.length > PIPELINE_LIMITS.handoffField ? s.slice(0, PIPELINE_LIMITS.handoffField) : s;
}

function capArray(arr: string[]): string[] {
  return arr.slice(0, PIPELINE_LIMITS.handoffArray);
}

function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === "string");
}

function normalizeNext(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const trimmed = x.trim();
  return trimmed.length === 0 ? null : capField(trimmed);
}

/**
 * Parse a step's raw output text for its trailing `<handoff>…</handoff>`
 * block (see {@link HANDOFF_TAG}). Finds the LAST such block (tolerating
 * attributes on the open tag, whitespace around the close tag, and trailing
 * prose after it — an earlier "draft" block is ignored once a final one
 * exists). The inner text is stripped of an optional ```json/``` fence, then
 * `JSON.parse`d; on failure, a brace-balanced `{…}` slice starting at the
 * first `{` is tried as a fallback (recovers from stray prose around an
 * otherwise-valid object). Every string field is capped at
 * `PIPELINE_LIMITS.handoffField` chars and every array at
 * `PIPELINE_LIMITS.handoffArray` entries; missing fields default to `""` /
 * `null` / `[]` as documented on {@link Handoff}.
 *
 * Returns `{ok:false, error, raw:null}` when no `<handoff>` tag is found at
 * all, or `{ok:false, error, raw:<inner text>}` when a tag was found but its
 * contents couldn't be parsed as an object.
 */
export function parseHandoff(text: string): { ok: true; handoff: Handoff } | { ok: false; error: string; raw: string | null } {
  HANDOFF_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = HANDOFF_BLOCK_RE.exec(text)) !== null) {
    last = match;
    // Guard against a zero-width match looping forever (can't happen with
    // this pattern, but cheap insurance against a future edit that adds one).
    if (match[0].length === 0) HANDOFF_BLOCK_RE.lastIndex++;
  }
  if (last === null) return { ok: false, error: "no <handoff> block found", raw: null };

  const inner = stripCodeFence(last[1] ?? "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    const balanced = extractBalancedObject(inner);
    if (balanced === null) {
      return { ok: false, error: "handoff JSON could not be parsed: no valid JSON object found", raw: inner };
    }
    try {
      parsed = JSON.parse(balanced);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `handoff JSON could not be parsed: ${reason}`, raw: inner };
    }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: "handoff JSON could not be parsed: expected an object", raw: inner };
  }

  const handoff: Handoff = {
    schemaVersion: 1,
    purpose: capField(typeof parsed.purpose === "string" ? parsed.purpose : ""),
    summary: capField(typeof parsed.summary === "string" ? parsed.summary : ""),
    reason: capField(typeof parsed.reason === "string" ? parsed.reason : ""),
    next: normalizeNext(parsed.next),
    artifacts: capArray(toStringArray(parsed.artifacts)),
    openQuestions: capArray(toStringArray(parsed.openQuestions)),
  };
  if (parsed.status === "done" || parsed.status === "blocked") handoff.status = parsed.status;

  return { ok: true, handoff };
}

/**
 * Resolve which step(s) run next after `fromStepId` settles with `handoff`.
 * `transition: "all"` fan-out always starts every outgoing target
 * (deduplicated) regardless of `handoff.next`. Otherwise (`"choose"`): zero
 * outgoing edges is terminal; exactly one outgoing edge is taken
 * unconditionally (`next` is ignored); with several, `handoff.next` (trimmed,
 * case-insensitive) is matched against a target step's name, then its id
 * (exact), then the connecting edge's label — no `next` is `"ambiguous"`, a
 * `next` that matches nothing is `"unknown"`. Both failure kinds report
 * `candidates` as the outgoing steps' names, in edge order.
 */
export function resolveNextSteps(
  g: PipelineGraph,
  fromStepId: string,
  handoff: Handoff | null,
):
  | { kind: "terminal" }
  | { kind: "steps"; stepIds: string[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown"; next: string; candidates: string[] } {
  const outgoing = outgoingSteps(g, fromStepId);
  if (outgoing.length === 0) return { kind: "terminal" };

  const fromStep = g.steps.find((s) => s.id === fromStepId);
  const transition = fromStep?.transition ?? "choose";

  if (transition === "all") {
    return { kind: "steps", stepIds: dedupeStrings(outgoing.map((o) => o.step.id)) };
  }

  if (outgoing.length === 1) {
    return { kind: "steps", stepIds: [outgoing[0]!.step.id] };
  }

  const candidates = outgoing.map((o) => o.step.name);
  const next = handoff?.next?.trim();
  if (!next) return { kind: "ambiguous", candidates };

  const nextLower = next.toLowerCase();
  const byName = outgoing.find((o) => o.step.name.trim().toLowerCase() === nextLower);
  if (byName) return { kind: "steps", stepIds: [byName.step.id] };
  const byId = outgoing.find((o) => o.step.id === next);
  if (byId) return { kind: "steps", stepIds: [byId.step.id] };
  const byLabel = outgoing.find((o) => o.edge.label.trim().toLowerCase() === nextLower);
  if (byLabel) return { kind: "steps", stepIds: [byLabel.step.id] };

  return { kind: "unknown", next, candidates };
}

/**
 * Derive a run's overall status from its live progress: any blocked
 * execution wins outright (`"blocked"`), else any active execution means
 * `"running"`, else the run is either a terminal state it already recorded
 * (`"cancelled"`/`"idle"` are preserved, since nothing here can re-derive
 * them) or `"done"` (nothing active, nothing blocked, and not explicitly
 * idle/cancelled).
 */
export function deriveRunStatus(run: PipelineRunState): PipelineRunStatus {
  if (run.blocked.length > 0) return "blocked";
  if (run.active.length > 0) return "running";
  if (run.status === "cancelled" || run.status === "idle") return run.status;
  return "done";
}

function nextRuleText(outgoing: { name: string; label: string }[], transition: "choose" | "all"): string {
  if (outgoing.length === 0) {
    return 'This is the last step: set "next" to null.';
  }
  if (transition === "all") {
    const list = outgoing.map((o) => o.name).join(", ");
    return `All of the following steps will run next in parallel; set "next" to null: ${list}`;
  }
  if (outgoing.length === 1) {
    const name = outgoing[0]!.name;
    return `The next step is "${name}"; set "next" to "${name}".`;
  }
  const list = outgoing.map((o) => (o.label.trim().length > 0 ? `${o.name} (${o.label})` : o.name)).join(", ");
  return `Choose exactly one next step by name: ${list} — and put that name in "next".`;
}

const SUBAGENT_INSTRUCTIONS_PREVIEW_MAX = 2000;

/**
 * Compose the (pre-`composeLaunchPrompt`) prompt text for one step's launch,
 * deterministically: pipeline/step header, the overall goal, the previous
 * step(s)' handoff context (several entries after a join), this step's own
 * instructions, an optional parallel-siblings warning (fan-out steps sharing
 * the parent's worktree), delegation guidance for the step's allowed
 * subagent profiles, and the handoff contract itself (including the
 * `next`-field rule for this step's outgoing edges). See D10,
 * `docs/plans/pipelines.md`.
 */
export function composeStepPrompt(input: {
  pipelineName: string;
  step: PipelineStep;
  stepIndex: number;
  stepCap: number;
  goal: string;
  previous: { stepName: string; handoff: Handoff | null; filePath: string | null }[];
  outgoing: { name: string; label: string }[];
  transition: "choose" | "all";
  subagentProfiles: AgentProfileSnapshot[];
  subagentCap: number | null;
  inlineHandoff: boolean;
  parallelSiblings: string[];
}): string {
  const parts: string[] = [];

  parts.push(`# Pipeline "${input.pipelineName}" — step ${input.stepIndex} of at most ${input.stepCap}: ${input.step.name}`);
  parts.push(
    "You are one step of an agetor pipeline. You work in a shared worktree alongside the other steps of " +
      "this pipeline, and you are responsible for finishing this step's part of the work only — not the " +
      "whole pipeline.",
  );

  parts.push("## Overall goal");
  parts.push(input.goal);

  parts.push("## Context from previous step(s)");
  if (input.previous.length === 0) {
    parts.push("This is the first step — there is no prior handoff.");
  } else {
    for (const prev of input.previous) {
      parts.push(`### From "${prev.stepName}"`);
      if (input.inlineHandoff && prev.handoff !== null) {
        parts.push(`\`\`\`json\n${JSON.stringify(prev.handoff, null, 2)}\n\`\`\``);
      } else if (prev.filePath !== null) {
        parts.push(`(handoff saved to ${prev.filePath})`);
      } else {
        parts.push("(no handoff was provided)");
      }
    }
  }

  parts.push("## Your step");
  parts.push(input.step.instructions.trim().length > 0 ? input.step.instructions : "(no additional instructions)");

  if (input.parallelSiblings.length > 0) {
    parts.push("## Running in parallel");
    parts.push(
      `The following step(s) are running concurrently with you, in this same shared worktree: ` +
        `${input.parallelSiblings.join(", ")}. Avoid editing files outside this step's scope, and never run ` +
        "git commands that rewrite shared state (checkout, reset, stash, rebase) — those would disrupt the " +
        "other steps running alongside you.",
    );
  }

  parts.push("## Delegation");
  if (input.subagentProfiles.length > 0) {
    parts.push(
      input.subagentCap === null
        ? "You may delegate to subagents. No limit on how many."
        : `You may delegate to subagents. Limit: ${input.subagentCap} subagent(s).`,
    );
    for (const p of input.subagentProfiles) {
      const instructions =
        p.instructions.length > SUBAGENT_INSTRUCTIONS_PREVIEW_MAX
          ? `${p.instructions.slice(0, SUBAGENT_INSTRUCTIONS_PREVIEW_MAX)}…`
          : p.instructions;
      const lines = [`- **${p.name}** — harness ${p.harnessLabel}, model ${p.model}, effort ${p.effort ?? "default"}`];
      lines.push(`  instructions: ${instructions}`);
      if (p.skills.length > 0) lines.push(`  skills: ${p.skills.map((s) => `/${s}`).join(", ")}`);
      parts.push(lines.join("\n"));
    }
    parts.push("When you spawn a subagent for one of these personas, brief it with that persona's instructions and skills.");
  } else {
    parts.push("Do not spawn subagents for this step.");
  }

  parts.push("## Handoff (required)");
  parts.push(
    "When your work for this step is complete — or you are blocked and cannot continue — end your FINAL " +
      `message with exactly one block: \`<${HANDOFF_TAG}>\` followed by a newline, the JSON, a newline, then ` +
      `\`</${HANDOFF_TAG}>\`.`,
  );
  parts.push(
    'Schema: {"schemaVersion":1,"purpose":"…the main purpose of the overall task, restated…",' +
      '"summary":"…what you did / found…","reason":"…why you are handing off now and what the next step ' +
      'should do…","next":<see below>,"artifacts":["paths or URLs"],"openQuestions":["…"],' +
      '"status":"done"|"blocked"}',
  );
  parts.push(nextRuleText(input.outgoing, input.transition));
  parts.push(
    `Do not put anything after the closing </${HANDOFF_TAG}> tag. If you need the user's input, ask before ` +
      "writing the handoff.",
  );

  return parts.join("\n\n");
}

/**
 * Resolve a user-typed `<id|name>` reference (CLI `agetor pipeline show
 * <ref>`, `agetor add --pipeline <ref>`, …) against a list of pipelines. An
 * exact `id` match wins outright; otherwise a case-insensitive, trimmed
 * `name` match is tried — exactly one hit resolves, several is
 * `"ambiguous"` (candidate names listed), none is `"unknown"`. Mirrors
 * `matchAgentProfileRef` in `src/shared/agent-profile.ts`.
 */
export function matchPipelineRef(list: Pipeline[], ref: string): { ok: true; pipeline: Pipeline } | { ok: false; error: string } {
  const trimmed = ref.trim();

  const byId = list.find((p) => p.id === trimmed);
  if (byId) return { ok: true, pipeline: byId };

  const lower = trimmed.toLowerCase();
  const byName = list.filter((p) => p.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, pipeline: byName[0]! };
  if (byName.length > 1) {
    return { ok: false, error: `ambiguous pipeline "${trimmed}": matches ${byName.map((p) => p.name).join(", ")}` };
  }
  return { ok: false, error: `unknown pipeline "${trimmed}"` };
}

/** Look up a step's display name by id, falling back to the id itself when
 *  the step isn't found (a step deleted from a live pipeline but still
 *  referenced by a frozen run snapshot's history, for instance). */
export function stepNameById(g: PipelineGraph, id: string): string {
  return g.steps.find((s) => s.id === id)?.name ?? id;
}

/**
 * Summarize a run's progress for a board-card badge: `completed` counts
 * history entries that finished normally (`succeeded` or
 * `advanced-manually`), `active` is the number of currently-running/blocked
 * executions, and `total` is the snapshot's step count (0 before the first
 * Run). `label` is `"<completed>/<total>"`, with the first active step's
 * name appended (`" · <name>"`) whenever at least one execution is active.
 */
export function pipelineStepProgress(run: PipelineRunState): { completed: number; active: number; total: number; label: string } {
  const completed = run.history.filter((h) => h.outcome === "succeeded" || h.outcome === "advanced-manually").length;
  const active = run.active.length;
  const total = run.snapshot?.graph.steps.length ?? 0;

  let label = `${completed}/${total}`;
  const firstActive = run.active[0];
  if (firstActive) {
    const name = run.snapshot ? stepNameById(run.snapshot.graph, firstActive.stepId) : firstActive.stepId;
    label += ` · ${name}`;
  }

  return { completed, active, total, label };
}
