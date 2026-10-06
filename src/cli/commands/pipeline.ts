import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";
import type { AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { taskCountText } from "./agent-profile.ts";
import { cmdExportOne, cmdImportAs, printableLines } from "./bundle.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
import {
  matchPipelineRef,
  outgoingSteps,
  pipelineStepProgress,
  resolveStartStep,
  stepNameById,
} from "../../shared/pipeline.ts";
import type {
  AgentProfile,
  Pipeline,
  PipelineGraph,
  PipelineRunState,
  Task,
} from "../../shared/types.ts";

export async function cmdPipeline(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  // The agetor bundle (docs/plans/agents-pipelines-import-export.md). Handled
  // before `getClient`, which may start a daemon: an `--out` that would be
  // overwritten, or an unreadable/invalid import file, fails first — the
  // same order as top-level `agetor export`/`agetor import`.
  // export: the pipeline plus every Agent it references; import: any bundle,
  // or a legacy pre-bundle pipeline file.
  if (sub === "export") return cmdExportOne("pipeline", args.slice(1), flags);
  if (sub === "import") return cmdImportAs("pipeline", args.slice(1), flags);
  const client = await getClient(flags);
  switch (sub) {
    case "ls":
    case "list": {
      const pipelines = await client.listPipelines();
      if (flags.json) return printJson(pipelines);
      if (pipelines.length === 0) {
        out(
          c.dim(
            "no pipelines defined — build one in the app's Pipelines editor, or import one: agetor pipeline import <file>",
          ),
        );
        return;
      }
      const rows = pipelines.map((p) => formatPipelineListRow(p));
      out(table(["id", "name", "steps", "tasks"], rows));
      return;
    }
    case "show": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline");
      const pipeline = await resolvePipeline(client, ref);
      if (flags.json) return printJson(pipeline);
      // Resolve each step's bound profile id to its live name (and flag one
      // that no longer exists) — best-effort: a failed listing prints the
      // bare ids, exactly as before, rather than failing `show`.
      const profiles = await listProfilesOrNull(client);
      for (const line of pipelineShowLines(pipeline, profiles)) out(line);
      return;
    }
    case "rm":
    case "delete": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline");
      const pipeline = await resolvePipeline(client, ref);
      await client.deletePipeline(pipeline.id);
      if (flags.json) return printJson({ removed: pipeline.id });
      out(
        `${c.red("✗")} removed pipeline ${c.bold(safe(pipeline.name))} — tasks that already ran keep their frozen snapshot`,
      );
      return;
    }
    // ── task-scoped subcommands below: <ref> is a pipeline TASK (the board
    // task launched from a pipeline), not the pipeline template itself, and
    // is resolved by id/short-id via `resolveTask` exactly like every other
    // task-targeting command (start/send/cancel/…). ──────────────────────
    case "retry": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline retry");
      // Flags are parsed BEFORE the task lookup so a typo'd flag fails fast
      // without a network round-trip (L-CLI7).
      const f = parseRetryFlags(args.slice(2));
      const task = await resolvePipelineTask(client, ref);
      let targetTaskId: string | undefined;
      if (f.from) {
        if (!task.pipelineRun) throw new Error("pipeline has never run — nothing to retry");
        targetTaskId = resolveActiveStepRef(task.pipelineRun, f.from);
      }
      const updated = await client.retryPipeline(task.id, targetTaskId);
      if (flags.json) return printJson(updated);
      out(`${c.cyan("↻")} retrying pipeline for ${c.dim(task.id.slice(0, 8))}`);
      return;
    }

    case "advance": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline advance");
      // Flags (and their exclusivity) are checked BEFORE the task lookup so
      // a bad invocation fails fast without a network round-trip (L-CLI7).
      const f = parseAdvanceFlags(args.slice(2));
      if (f.finish && f.next.length > 0) {
        throw new Error("pipeline advance: --next and --finish are mutually exclusive");
      }
      if (!f.finish && f.next.length === 0) throw usageError("pipeline advance");
      const task = await resolvePipelineTask(client, ref);

      let nextStepIds: string[] | null;
      if (f.finish) {
        nextStepIds = null;
      } else {
        const graph = task.pipelineRun?.snapshot?.graph;
        if (!graph) throw new Error("pipeline has no run snapshot yet — nothing to advance");
        nextStepIds = f.next.map((name) => resolveStepRef(graph, name));
      }

      const body: { nextStepIds: string[] | null; fromTaskId?: string } = { nextStepIds };
      if (f.from) {
        if (!task.pipelineRun) throw new Error("pipeline has never run — nothing to advance");
        body.fromTaskId = resolveActiveStepRef(task.pipelineRun, f.from);
      }
      const updated = await client.advancePipeline(task.id, body);
      if (flags.json) return printJson(updated);
      out(`${c.green("▸")} advanced pipeline for ${c.dim(task.id.slice(0, 8))}`);
      return;
    }

    case "restart": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline restart");
      const task = await resolvePipelineTask(client, ref);
      // Mirrors `startTask`'s own response shape (this launches the start
      // step's agent synchronously, same as a plain Run) rather than
      // returning the task — see `POST /tasks/:id/pipeline/restart`.
      const res = await client.restartPipeline(task.id);
      if (flags.json) return printJson(res);
      if (res.pending) {
        out(
          `${c.yellow("▸")} restarting pipeline for ${c.dim(task.id.slice(0, 8))} — run ${res.runId.slice(0, 8)} ` +
            c.dim("(agent launch still in progress)"),
        );
      } else {
        out(`${c.cyan("↻")} restarted pipeline for ${c.dim(task.id.slice(0, 8))} — run ${res.runId.slice(0, 8)}`);
      }
      return;
    }

    case "status": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline status");
      const task = await resolvePipelineTask(client, ref);
      const { task: fresh, steps } = await client.getPipelineRun(task.id);
      if (flags.json) return printJson({ task: fresh, steps });
      for (const line of pipelineStatusLines(fresh, steps)) out(line);
      return;
    }

    default:
      throw new Error(
        "unknown pipeline subcommand: " +
          sub +
          " (use ls | show | rm | export | import | retry | advance | restart | status)",
      );
  }
}

/** Resolve `ref` to a task and confirm it's actually a pipeline (parent)
 *  task — shared by the four task-scoped subcommands below. */
async function resolvePipelineTask(client: AgetorClient, ref: string): Promise<Task> {
  const task = await resolveTask(client, ref);
  // A hidden step task's id is the one most likely to be pasted here (it's
  // what `agetor logs`/`show` print) — point at the parent instead of the
  // opaque "not a pipeline task" (L-CLI8).
  if (task.pipelineParentId) {
    throw new Error(
      `"${ref}" is a step task of pipeline task ${task.pipelineParentId.slice(0, 8)} — target that id instead`,
    );
  }
  if (!task.pipelineId) throw new Error(`task "${ref}" is not a pipeline task`);
  return task;
}

/** `client.listAgentProfiles()` or `null` when the listing fails — every
 *  caller treats a profile list as a display/validation nicety that must
 *  never fail the subcommand itself. */
async function listProfilesOrNull(client: AgetorClient): Promise<AgentProfile[] | null> {
  try {
    return await client.listAgentProfiles();
  } catch {
    return null;
  }
}

async function resolvePipeline(client: AgetorClient, ref: string): Promise<Pipeline> {
  const pipelines = await client.listPipelines();
  const result = matchPipelineRef(pipelines, ref);
  if (!result.ok) throw new Error(result.error);
  return result.pipeline;
}

interface AdvanceFlags {
  /** `--next <step>` — repeatable; each value is a step name or id, resolved
   *  against the run's snapshot graph by `resolveStepRef`. */
  next: string[];
  /** `--finish` — end the run here (maps to `nextStepIds: null`); mutually
   *  exclusive with `--next`. */
  finish: boolean;
  /** `--from <task-id>` — the specific blocked/awaiting step execution to
   *  advance, when more than one is in play. Accepts a full task id or a
   *  unique prefix of one (resolved against the run's active executions by
   *  `resolveActiveStepRef`), same as every other task-id reference in the
   *  CLI. */
  from?: string;
}

/** Pure flag parser for `agetor pipeline advance` — `--next <step>`
 *  (repeatable), `--finish`, `--from <task-id>`. Exclusivity between
 *  `--next` and `--finish`, and requiring one of them, is checked by the
 *  caller (`cmdPipeline`'s "advance" case) since that needs a usage-error
 *  vs. a plain error distinction this pure parser has no business making.
 *  An unrecognized flag DOES throw here (unlike `parseHarnessFlags`/
 *  `parseAgentProfileFlags`, which silently ignore one per house
 *  convention): a typo'd `--frmo` here would otherwise silently run
 *  `advance` with none of the caller's intended args applied, against a
 *  live pipeline run — worth a hard stop rather than a surprising no-op. */
export function parseAdvanceFlags(args: string[]): AdvanceFlags {
  const f: AdvanceFlags = { next: [], finish: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--next") f.next.push(flagValue(args, ++i, a));
    else if (a === "--finish") f.finish = true;
    else if (a === "--from") f.from = flagValue(args, ++i, a);
    else throw usageError("pipeline advance");
  }
  return f;
}

interface RetryFlags {
  /** `--from <task-id-or-prefix>` — narrow the retry to one specific active
   *  execution (the route's optional body `taskId`), resolved against the
   *  run's active executions by `resolveActiveStepRef`. Omitted, every
   *  eligible active execution plus every pending run-level block is
   *  retried, same as a bare `agetor pipeline retry <task>`. */
  from?: string;
}

/** Pure flag parser for `agetor pipeline retry` — just `--from <task-id>`.
 *  An unrecognized flag throws (see `parseAdvanceFlags`'s doc for why this
 *  pair departs from `parseHarnessFlags`/`parseAgentProfileFlags`'s
 *  silently-ignore convention). */
export function parseRetryFlags(args: string[]): RetryFlags {
  const f: RetryFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--from") f.from = flagValue(args, ++i, a);
    else throw usageError("pipeline retry");
  }
  return f;
}

/**
 * Resolve a `--next` step reference against a pipeline run's snapshot
 * graph, with exactly the precedence the runner's own `resolveNextSteps`
 * gives a handoff's `next` (L-CLI2 parity): a unique case-insensitive,
 * trimmed step NAME first, then an exact step ID, then an edge LABEL
 * (case-insensitive, trimmed) — the label resolves to the edge's target
 * step. Throws (listing every step name as candidates) on an unknown or
 * ambiguous reference; the graph enforces unique names, so a name match
 * can't actually be ambiguous, but the check stays defensive, and a label
 * shared by several edges into DIFFERENT targets is genuinely ambiguous.
 *
 * NOT used for `--from` — that resolves against a run's currently ACTIVE
 * step executions (task ids), not the graph's step ids/names; see
 * {@link resolveActiveStepRef} below.
 */
export function resolveStepRef(graph: PipelineGraph, ref: string): string {
  const trimmed = ref.trim();
  const lower = trimmed.toLowerCase();

  const byName = graph.steps.filter((s) => s.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new Error(`ambiguous step "${trimmed}": matches ${byName.map((s) => safe(s.name)).join(", ")}`);
  }

  const byId = graph.steps.find((s) => s.id === trimmed);
  if (byId) return byId.id;

  if (lower) {
    const targets = new Set(
      graph.edges.filter((e) => e.label.trim().toLowerCase() === lower).map((e) => e.to),
    );
    if (targets.size === 1) return [...targets][0]!;
    if (targets.size > 1) {
      const names = [...targets].map((id) => stepLabel(graph, id)).join(", ");
      throw new Error(`ambiguous edge label "${trimmed}": leads to ${names}`);
    }
  }

  const candidates = graph.steps.map((s) => safe(s.name)).join(", ") || "(none)";
  throw new Error(`unknown step "${trimmed}" — steps: ${candidates}`);
}

/**
 * Resolve `agetor pipeline advance --from`/`agetor pipeline retry --from`
 * against a running pipeline's currently ACTIVE step executions
 * (`run.active[].taskId`) — exact task id first, then a unique prefix match,
 * mirroring `resolveTask`'s own id-then-prefix precedence for board tasks
 * elsewhere in the CLI. Throws on an unknown or ambiguous reference, listing
 * every active execution's short task id plus its step name as candidates
 * so the error is actionable without a separate `pipeline status` call.
 *
 * An empty/whitespace-only ref is rejected outright rather than falling
 * through to the prefix match below — `"".startsWith("")` (and
 * `anything.startsWith("")`) is always true, so an accidentally-blank
 * `--from ""` would otherwise match every active execution and "resolve" to
 * the first one instead of erroring.
 */
export function resolveActiveStepRef(run: PipelineRunState, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("--from requires a non-empty task id");
  const exact = run.active.find((a) => a.taskId === trimmed);
  if (exact) return exact.taskId;

  const matches = run.active.filter((a) => a.taskId.startsWith(trimmed));
  const candidates =
    run.active
      .map((a) => `${a.taskId.slice(0, 8)} (${runStepLabel(run, a.stepId)})`)
      .join(", ") || "(no active executions)";
  if (matches.length === 1) return matches[0]!.taskId;
  if (matches.length > 1) {
    throw new Error(`"${trimmed}" is ambiguous among active executions — candidates: ${candidates}`);
  }
  throw new Error(`no active execution matches "${trimmed}" — candidates: ${candidates}`);
}

/** Pure row formatter for `agetor pipeline ls`'s table: id (short), name,
 *  step count, and the server-derived `taskCount` (how many pipeline tasks
 *  are currently bound to it — every column, including archived). */
export function formatPipelineListRow(p: Pipeline): string[] {
  return [c.dim(p.id.slice(0, 8)), c.bold(safe(p.name)), String(p.graph.steps.length), String(p.taskCount ?? 0)];
}

/** Pipeline text escaped for the terminal. Names, ids and descriptions can
 *  come from an imported file, a hand-edited row or an agent's own handoff
 *  (a block message quotes its `next`): an ESC, C1 control or bidi override
 *  there would otherwise drive the terminal or hide what the text says. */
const safe = (s: string): string => escapeControlChars(s);

/** A step's name, or its id when the graph has no such step, escaped. */
function stepLabel(graph: PipelineGraph, id: string): string {
  return safe(stepNameById(graph, id));
}

/** `stepLabel` against a run's frozen graph, or the bare (escaped) id. */
function runStepLabel(run: PipelineRunState, id: string): string {
  return run.snapshot ? stepLabel(run.snapshot.graph, id) : safe(id);
}

function label(s: string): string {
  return c.dim(s + ":");
}

/**
 * Pure line-by-line renderer for `agetor pipeline show <ref>` — name/id,
 * description, max steps + start step + used-by count, then one block per
 * step (name/id, bound agent profile, transition/join mode, allowed
 * subagent profiles when any, and its outgoing edges by target step name,
 * with the edge label in parens when set — or "(terminal …)" for a step
 * with no outgoing edges). Exported so the render is testable without a
 * client/daemon.
 *
 * `profiles` (the live `GET /agent-profiles` list) resolves each profile
 * id to `<name> (<id>)`, or marks it `<id> (missing)` when no live profile
 * carries that id (M-CLI4); `null` — listing failed — prints the bare id,
 * exactly as before, never a false "missing".
 */
export function pipelineShowLines(p: Pipeline, profiles: AgentProfile[] | null = null): string[] {
  const lines: string[] = [];
  lines.push(`${c.bold(safe(p.name))}  ${c.dim(p.id)}`);
  // Split on every line break (a bare CR included) so a later line can't
  // overprint an earlier one, and printed under the label when there are
  // several.
  const description = p.description.trim() ? printableLines(p.description.replace(/\s+$/, "")) : [];
  if (description.length <= 1) {
    lines.push(`  ${label("description")} ${description.length ? description[0] : c.dim("none")}`);
  } else {
    lines.push(`  ${label("description")}`);
    for (const line of description) lines.push(`    ${line}`);
  }
  const start = resolveStartStep(p.graph);
  lines.push(
    `  ${label("max steps")} ${p.maxSteps}   ${label("start step")} ${start ? safe(start.name) : c.dim("-")}` +
      `   ${label("used by")} ${taskCountText(p.taskCount ?? 0)}`,
  );
  lines.push("");
  if (p.graph.steps.length === 0) {
    lines.push(`  ${c.dim("no steps")}`);
    return lines;
  }
  p.graph.steps.forEach((step, i) => {
    const startMarker = start?.id === step.id ? c.cyan(" (start)") : "";
    lines.push(`  ${i + 1}. ${c.bold(safe(step.name))}  ${c.dim(safe(step.id))}${startMarker}`);
    lines.push(`     ${label("profile")} ${step.agentProfileId ? profileText(step.agentProfileId, profiles) : c.dim("none")}`);
    lines.push(`     ${label("transition")} ${step.transition}   ${label("join")} ${step.join}`);
    if (step.subagents.profileIds.length > 0) {
      const cap = step.subagents.cap === null ? "no cap" : `cap ${step.subagents.cap}`;
      lines.push(
        `     ${label("subagents")} ${step.subagents.profileIds.map((id) => profileText(id, profiles)).join(", ")}` +
          `  ${c.dim(`(${cap})`)}`,
      );
    }
    const outgoing = outgoingSteps(p.graph, step.id);
    if (outgoing.length === 0) {
      lines.push(`     ${c.dim("(terminal — no outgoing edges)")}`);
    } else {
      const targets = outgoing
        .map((o) =>
          o.edge.label.trim() ? `${safe(o.step.name)} (${safe(o.edge.label.trim())})` : safe(o.step.name),
        )
        .join(", ");
      lines.push(`     ${label("→")} ${targets}`);
    }
  });
  return lines;
}

/**
 * Pure line-by-line renderer for `agetor pipeline status <task>` — the
 * pipeline task's overall status/progress, every blocked entry, every
 * currently-active step execution (with its own task's live column), and
 * the full step history (oldest first, matching `PipelineRunState.history`'s
 * `seq` order). `steps` is the parent's hidden step tasks (from
 * `GET /tasks/:id/pipeline`), consulted only to show an active execution's
 * live column — history rows show just the recorded outcome, since a
 * settled step task's own column may have moved on (e.g. archived).
 */
export function pipelineStatusLines(task: Task, steps: Task[]): string[] {
  const lines: string[] = [];
  lines.push(`${c.bold(escapeFreeText(task.title))}  ${c.dim(task.id)}`);
  const run = task.pipelineRun;
  if (!run) {
    lines.push(`  ${c.dim("pipeline has never run")}`);
    return lines;
  }

  const progress = pipelineStepProgress(run);
  lines.push(
    `  ${label("pipeline")} ${safe(run.pipelineName)}   ${label("status")} ${colorRunStatus(run.status)}` +
      `   ${label("steps")} ${safe(progress.label)}`,
  );

  if (run.blocked.length > 0) {
    lines.push("");
    lines.push(`  ${c.yellow("blocked")}:`);
    for (const b of run.blocked) {
      const stepName = b.stepId ? runStepLabel(run, b.stepId) : null;
      const who = b.taskId ? ` (${stepName ?? "?"} · ${c.dim(b.taskId.slice(0, 8))})` : "";
      // A block message can quote an agent's own handoff text verbatim.
      lines.push(`    ${c.yellow("⚠")} [${b.kind}]${who} ${escapeFreeText(b.message)}`);
    }
  }

  if (run.active.length > 0) {
    lines.push("");
    lines.push(`  ${c.cyan("active")}:`);
    for (const a of run.active) {
      const stepName = runStepLabel(run, a.stepId);
      const stepTask = steps.find((s) => s.id === a.taskId);
      const columnNote = stepTask ? `  ${c.dim(stepTask.column)}` : "";
      lines.push(`    ${c.cyan("▸")} ${stepName}  ${c.dim(a.taskId.slice(0, 8))}${columnNote}`);
    }
  }

  if (run.history.length > 0) {
    lines.push("");
    lines.push(`  ${c.dim("history (oldest first):")}`);
    for (const h of run.history) {
      const stepName = runStepLabel(run, h.stepId);
      const kindNote = h.responseKind ? `  ${c.dim(`[${h.responseKind}]`)}` : "";
      const remindedNote = h.reminder
        ? h.reminder.delivered === false
          ? `  ${c.red("(reminder failed)")}`
          : `  ${c.yellow("(reminder sent)")}`
        : "";
      lines.push(
        `    ${h.seq}. ${stepName}  ${historyGlyph(h.outcome)}${kindNote}${remindedNote}  ${c.dim(h.taskId.slice(0, 8))}`,
      );
    }
  }

  return lines;
}

/** `<name> (<id>)` for a live profile, `<id> (missing)` when the id no longer
 *  resolves against `profiles`, or the bare id when `profiles` is `null`
 *  (listing failed — nothing to compare against). The id comes from the
 *  stored graph — an imported legacy file's reference is kept as it was —
 *  so it and the name are printed with control characters escaped. */
function profileText(rawId: string, profiles: AgentProfile[] | null): string {
  const id = escapeControlChars(rawId);
  if (!profiles) return id;
  const live = profiles.find((p) => p.id === rawId);
  return live ? `${escapeControlChars(live.name)} ${c.dim(`(${id})`)}` : `${id} ${c.yellow("(missing)")}`;
}

/** Color a `PipelineRunStatus` for the terminal — shared with `agetor show`
 *  so the two surfaces can't drift (L-CLI4). */
export function colorRunStatus(status: string): string {
  if (status === "running") return c.cyan(status);
  if (status === "blocked") return c.yellow(status);
  if (status === "done") return c.green(status);
  if (status === "cancelled") return c.yellow(status);
  return status;
}

function historyGlyph(outcome: string | null): string {
  if (outcome === "succeeded" || outcome === "advanced-manually") return c.green(outcome);
  if (outcome === "failed") return c.red("failed");
  if (outcome === "cancelled") return c.yellow("cancelled");
  return c.dim("pending");
}
