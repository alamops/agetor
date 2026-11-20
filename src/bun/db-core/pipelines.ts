import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { PIPELINE_LIMITS, type Pipeline, type PipelineGraph, type PipelineInput } from "../../shared/types.ts";
import { PIPELINE_CONTROL_CHAR_RE, validatePipelineGraph } from "../../shared/pipeline.ts";
import { PipelineNameError, isUniqueConstraintError } from "./errors.ts";
import { isPlainObject, isShapeSafePipelineEdge, isShapeSafePipelineStep } from "./task-parsers.ts";

export type PipelineRow = {
  id: string;
  name: string;
  name_key: string;
  description: string;
  graph: string;
  max_steps: number;
  created_at: number;
  updated_at: number;
};

/** Parse a pipeline row's stored `graph` JSON. This is our own write
 *  (produced by `validatePipelineGraph` at insert/update time), so this only
 *  ever fires against on-disk corruption or a shape an older/newer validator
 *  no longer accepts, but every other JSON column in this file is parsed
 *  defensively and `pipelines` is no exception.
 *
 *  m21: unparseable JSON still collapses to the empty graph
 *  `{steps:[],edges:[],startStepId:null}` (there's nothing else to return),
 *  logged via `console.warn` so the corruption is visible. A value that
 *  parses fine yet fails today's `validatePipelineGraph` is returned AS-IS
 *  (also warned) ONLY when it's still shaped safely enough to hand to the
 *  pipeline editor and the step-resolution helpers — a plain object with
 *  array `steps`/`edges` and a `startStepId` that's a string, `null`, or
 *  `undefined`. That's deliberately lenient (not full `validatePipelineGraph`
 *  again): the pipeline editor reads this value straight through, and an
 *  editor session that opens, makes an unrelated change, and saves would
 *  otherwise silently overwrite the user's real graph with nothing.
 *  Anything looser than that minimal shape (not an object, non-array
 *  `steps`/`edges`, a `startStepId` of some other type) collapses to the
 *  empty graph instead — there's nothing safe to index into otherwise.
 *  Trusting the stored shape here is the same call `sanitizeRunSnapshot`
 *  makes for a run's frozen snapshot, for a different reason — this one is
 *  "don't destroy data", not "don't re-validate a graph that already
 *  validated once". */

export const parsePipelineGraph = (raw: string): PipelineGraph => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[agetor] pipeline graph column is not valid JSON — falling back to an empty graph:`, err);
    return { steps: [], edges: [], startStepId: null };
  }
  const validated = validatePipelineGraph(parsed);
  if (validated.ok) return validated.graph;
  console.warn(`[agetor] stored pipeline graph failed validation (${validated.error}) — returning it unmodified if shape-safe`);
  if (isPlainObject(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const startStepIdOk = rec.startStepId === undefined || rec.startStepId === null || typeof rec.startStepId === "string";
    if (
      Array.isArray(rec.steps) &&
      Array.isArray(rec.edges) &&
      startStepIdOk &&
      rec.steps.every(isShapeSafePipelineStep) &&
      rec.edges.every(isShapeSafePipelineEdge)
    ) {
      return parsed as unknown as PipelineGraph;
    }
  }
  console.warn(`[agetor] stored pipeline graph shape is unsafe to return as-is — falling back to an empty graph`);
  return { steps: [], edges: [], startStepId: null };
};

export const toPipeline = (r: PipelineRow): Pipeline => ({
  id: r.id,
  name: r.name,
  description: r.description,
  graph: parsePipelineGraph(r.graph),
  maxSteps: r.max_steps,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Validate + normalize the name/description fields shared by `insert` and
 *  `update`: trims the name, rejects empty or over `PIPELINE_LIMITS.name`
 *  with a plain `Error` (a caller/validation error, not a name-clash error
 *  — mirrors `validateAgentProfileNameAndInstructions`), and rejects a
 *  description over `PIPELINE_LIMITS.description`. Returns the trimmed name
 *  and its lower-cased `name_key`. */
export const validatePipelineNameAndDescription = (name: string, description: string): { name: string; nameKey: string } => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("pipeline name is required");
  if (trimmed.length > PIPELINE_LIMITS.name) {
    throw new Error(`pipeline name must be ${PIPELINE_LIMITS.name} characters or fewer`);
  }
  if (PIPELINE_CONTROL_CHAR_RE.test(trimmed)) {
    throw new Error("pipeline name must not contain control characters");
  }
  if (description.length > PIPELINE_LIMITS.description) {
    throw new Error(`pipeline description must be ${PIPELINE_LIMITS.description} characters or fewer`);
  }
  return { name: trimmed, nameKey: trimmed.toLowerCase() };
};

/** Resolve a requested `maxSteps`: absent (`undefined`) defaults to
 *  `PIPELINE_LIMITS.maxStepsDefault`; anything else must be an integer in
 *  `1..PIPELINE_LIMITS.maxStepsMax` or this throws a plain `Error` (a
 *  caller/validation error, like `validatePipelineNameAndDescription`'s).
 *  L-S5: this used to CLAMP out-of-range values silently, which let the db
 *  layer be handed exactly what the `/pipelines` routes 400 on — the two
 *  layers now agree, and the route's error text is reused verbatim. */
export const resolveMaxSteps = (raw: number | undefined): number => {
  if (raw === undefined) return PIPELINE_LIMITS.maxStepsDefault;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > PIPELINE_LIMITS.maxStepsMax) {
    throw new Error(`maxSteps must be an integer between 1 and ${PIPELINE_LIMITS.maxStepsMax}`);
  }
  return raw;
};

export function makePipelines(conn: Database) {
  /**
   * Named, reusable pipeline graphs (`Pipeline`, `shared/types.ts`) — the
   * templates a pipeline task is launched from. See `docs/plans/pipelines.md`
   * for the full design. Structurally a near-clone of `agentProfiles` above:
   * unique case-insensitive names via `name_key`, delete is never blocked
   * (D8 — an already-started run is frozen onto its own
   * `tasks.pipeline_run.snapshot` and doesn't need the live row), and
   * `taskCounts`/`taskCount` mirror `agentProfiles`' the same way. The one
   * addition is `graph` validation/normalization on every write, via
   * `validatePipelineGraph` (`shared/pipeline.ts`) — `insert`/`update` never
   * store an un-normalized graph, and a graph that fails validation throws a
   * plain `Error` carrying `validatePipelineGraph`'s own message (the server
   * maps that to a 400).
   */
  const pipelines = {
    list(): Pipeline[] {
      return conn
        .query<PipelineRow, []>(`SELECT * FROM pipelines ORDER BY name_key ASC, id ASC`)
        .all()
        .map(toPipeline);
    },
    get(id: string): Pipeline | null {
      const row = conn.query<PipelineRow, [string]>(`SELECT * FROM pipelines WHERE id = ?`).get(id);
      return row ? toPipeline(row) : null;
    },
    /** Case-insensitive, trimmed name lookup — the backing query for the
     *  unique-name check in `insert`/`update` and for `matchPipelineRef`'s CLI
     *  `<id|name>` resolution. */
    findByName(name: string): Pipeline | null {
      const row = conn
        .query<PipelineRow, [string]>(`SELECT * FROM pipelines WHERE name_key = ?`)
        .get(name.trim().toLowerCase());
      return row ? toPipeline(row) : null;
    },
    insert(input: PipelineInput): Pipeline {
      const description = input.description ?? "";
      const { name, nameKey } = validatePipelineNameAndDescription(input.name, description);
      if (this.findByName(name)) throw new PipelineNameError(name);

      const validated = validatePipelineGraph(input.graph);
      if (!validated.ok) throw new Error(validated.error);

      const maxSteps = resolveMaxSteps(input.maxSteps);
      const id = randomUUID();
      const now = Date.now();
      try {
        conn.run(
          `INSERT INTO pipelines
           (id, name, name_key, description, graph, max_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, name, nameKey, description, JSON.stringify(validated.graph), maxSteps, now, now],
        );
      } catch (e) {
        if (isUniqueConstraintError(e)) throw new PipelineNameError(name);
        throw e;
      }
      return this.get(id) as Pipeline;
    },
    update(id: string, patch: Partial<PipelineInput>): Pipeline | null {
      const current = this.get(id);
      if (!current) return null;

      const nextNameRaw = patch.name !== undefined ? patch.name : current.name;
      const nextDescription = patch.description !== undefined ? patch.description : current.description;
      const { name, nameKey } = validatePipelineNameAndDescription(nextNameRaw, nextDescription);
      if (patch.name !== undefined) {
        const clash = this.findByName(name);
        if (clash && clash.id !== id) throw new PipelineNameError(name);
      }

      const validated = patch.graph !== undefined ? validatePipelineGraph(patch.graph) : { ok: true as const, graph: current.graph };
      if (!validated.ok) throw new Error(validated.error);

      const maxSteps = patch.maxSteps !== undefined ? resolveMaxSteps(patch.maxSteps) : current.maxSteps;

      try {
        conn.run(
          `UPDATE pipelines SET
           name = ?, name_key = ?, description = ?, graph = ?, max_steps = ?, updated_at = ?
         WHERE id = ?`,
          [name, nameKey, nextDescription, JSON.stringify(validated.graph), maxSteps, Date.now(), id],
        );
      } catch (e) {
        if (isUniqueConstraintError(e)) throw new PipelineNameError(name);
        throw e;
      }
      return this.get(id);
    },
    /** Deleting a pipeline always succeeds — a task that was launched from it
     *  keeps its own frozen `pipeline_run.snapshot` (D8 in the plan), so there
     *  is nothing to guard against here the way `harnesses.delete` must guard
     *  against in-use tasks/profiles. Mirrors `agentProfiles.delete`. */
    delete(id: string): boolean {
      const current = this.get(id);
      if (!current) return false;
      conn.run(`DELETE FROM pipelines WHERE id = ?`, [id]);
      return true;
    },
    /** pipelineId -> count of tasks currently bound to it (`pipeline_id =
     *  pipelineId`, every column including archived). One grouped query — the
     *  batch form the `GET /pipelines` list route uses so listing N pipelines
     *  never issues N count queries. Mirrors `agentProfiles.taskCounts`. */
    taskCounts(): Map<string, number> {
      const rows = conn.query<{ pipeline_id: string; n: number }, []>(
        `SELECT pipeline_id, COUNT(*) AS n FROM tasks WHERE pipeline_id IS NOT NULL GROUP BY pipeline_id`,
      ).all();
      return new Map(rows.map((r) => [r.pipeline_id, r.n]));
    },
    /** Single-pipeline count of tasks currently bound to it — for a
     *  single-resource response (GET/POST/PATCH `/pipelines/:id`) where a full
     *  grouped scan would be wasteful. Mirrors `agentProfiles.taskCount`. */
    taskCount(id: string): number {
      const row = conn.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM tasks WHERE pipeline_id = ?`,
      ).get(id);
      return row?.n ?? 0;
    },
  };
  return pipelines;
}
