import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";
import type { AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { taskCountText } from "./agent-profile.ts";
import {
  matchPipelineRef,
  outgoingSteps,
  pipelineStepProgress,
  resolveStartStep,
  stepNameById,
  validatePipelineGraph,
} from "../../shared/pipeline.ts";
import type {
  AgentProfile,
  Pipeline,
  PipelineGraph,
  PipelineInput,
  PipelineRunState,
  Task,
} from "../../shared/types.ts";

export async function cmdPipeline(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
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
        `${c.red("✗")} removed pipeline ${c.bold(pipeline.name)} — tasks that already ran keep their frozen snapshot`,
      );
      return;
    }
    case "export": {
      const ref = args[1];
      if (!ref) throw usageError("pipeline export");
      const f = parseExportFlags(args.slice(2));
      // Refuse to clobber an existing file BEFORE any network round-trip —
      // `--force` opts in; `--out -` is stdout (symmetry with `import -`).
      const outPath = f.out && f.out !== "-" ? f.out : null;
      if (outPath && !f.force && existsSync(outPath)) {
        throw new Error(`refusing to overwrite ${outPath} — pass --force to replace it`);
      }
      const pipeline = await resolvePipeline(client, ref);
      const input: PipelineInput = {
        name: pipeline.name,
        description: pipeline.description,
        graph: pipeline.graph,
        maxSteps: pipeline.maxSteps,
      };
      // Additive `profileName` / `subagents.profileNames` hints ride next to
      // each profile id so `import` on another machine can remap by name
      // (M-CLI4). The server's `validatePipelineGraph` drops unknown keys,
      // so the hints are harmless to post back verbatim — but `import`
      // reads them off the raw file and posts the normalized graph anyway.
      const profiles = await listProfilesOrNull(client);
      const text = JSON.stringify(profiles ? withProfileHints(input, profiles) : input, null, 2);
      if (outPath) {
        writeFileSync(outPath, text + "\n");
        if (flags.json) return printJson({ written: outPath });
        out(`${c.green("✓")} wrote ${c.bold(pipeline.name)} to ${outPath}`);
      } else {
        out(text);
      }
      return;
    }
    case "import": {
      const file = args[1];
      if (!file) throw usageError("pipeline import");
      const f = parseImportFlags(args.slice(2));
      const text = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
      const parsed = parsePipelineFile(text);
      if (!parsed.ok) throw new Error(`invalid pipeline file: ${parsed.error}`);
      const named: PipelineInput = f.name ? { ...parsed.input, name: f.name } : parsed.input;
      // Dangling agent-profile references (M-CLI4): a step's `agentProfileId`
      // — or a `subagents.profileIds` entry — that no profile on THIS machine
      // carries is remapped by the exported `profileName` hint when exactly
      // one live profile has that name, else warned about (the server never
      // validates profile ids on create, so the run would only fail at Run
      // time with `profile-missing`). A failed profile listing can't check
      // anything, so it becomes its own warning instead of blocking.
      const profiles = await listProfilesOrNull(client);
      const resolved = profiles
        ? resolveImportProfiles(named, parsed.hints, profiles)
        : {
            input: named,
            remapped: [],
            warnings: ["couldn't list this machine's agent profiles — step profile references were not checked"],
          };
      const created = await client.createPipeline(resolved.input);
      if (flags.json) {
        const warnings = [...resolved.remapped, ...resolved.warnings];
        return printJson(warnings.length ? { ...created, warnings } : created);
      }
      out(`${c.green("✓")} imported pipeline ${c.bold(created.name)} (${c.dim(created.id)})`);
      for (const line of resolved.remapped) out(c.dim(`  ${line}`));
      for (const line of resolved.warnings) out(c.yellow(`  ! ${line}`));
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

interface ExportFlags {
  /** `--out <file|->` — `-` (or omitted) prints to stdout. */
  out?: string;
  /** `--force` — overwrite an existing `--out` file instead of refusing. */
  force: boolean;
}

/** Pure flag parser for `agetor pipeline export` — `--out <file|->` and
 *  `--force`. The overwrite refusal itself lives in the caller (it needs
 *  the filesystem). */
export function parseExportFlags(args: string[]): ExportFlags {
  const f: ExportFlags = { force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") f.out = flagValue(args, ++i, a, /* allowDash */ true);
    else if (a === "--force") f.force = true;
  }
  return f;
}

interface ImportFlags {
  name?: string;
}

/** Pure flag parser for `agetor pipeline import` — just `--name <n>`. */
export function parseImportFlags(args: string[]): ImportFlags {
  const f: ImportFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--name") f.name = flagValue(args, ++i, a);
  }
  return f;
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
    throw new Error(`ambiguous step "${trimmed}": matches ${byName.map((s) => s.name).join(", ")}`);
  }

  const byId = graph.steps.find((s) => s.id === trimmed);
  if (byId) return byId.id;

  if (lower) {
    const targets = new Set(
      graph.edges.filter((e) => e.label.trim().toLowerCase() === lower).map((e) => e.to),
    );
    if (targets.size === 1) return [...targets][0]!;
    if (targets.size > 1) {
      const names = [...targets].map((id) => stepNameById(graph, id)).join(", ");
      throw new Error(`ambiguous edge label "${trimmed}": leads to ${names}`);
    }
  }

  const candidates = graph.steps.map((s) => s.name).join(", ") || "(none)";
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
      .map((a) => `${a.taskId.slice(0, 8)} (${run.snapshot ? stepNameById(run.snapshot.graph, a.stepId) : a.stepId})`)
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
  return [c.dim(p.id.slice(0, 8)), c.bold(p.name), String(p.graph.steps.length), String(p.taskCount ?? 0)];
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
  lines.push(`${c.bold(p.name)}  ${c.dim(p.id)}`);
  lines.push(`  ${label("description")} ${p.description ? p.description : c.dim("none")}`);
  const start = resolveStartStep(p.graph);
  lines.push(
    `  ${label("max steps")} ${p.maxSteps}   ${label("start step")} ${start ? start.name : c.dim("-")}` +
      `   ${label("used by")} ${taskCountText(p.taskCount ?? 0)}`,
  );
  lines.push("");
  if (p.graph.steps.length === 0) {
    lines.push(`  ${c.dim("no steps")}`);
    return lines;
  }
  p.graph.steps.forEach((step, i) => {
    const startMarker = start?.id === step.id ? c.cyan(" (start)") : "";
    lines.push(`  ${i + 1}. ${c.bold(step.name)}  ${c.dim(step.id)}${startMarker}`);
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
        .map((o) => (o.edge.label.trim() ? `${o.step.name} (${o.edge.label.trim()})` : o.step.name))
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
  lines.push(`${c.bold(task.title)}  ${c.dim(task.id)}`);
  const run = task.pipelineRun;
  if (!run) {
    lines.push(`  ${c.dim("pipeline has never run")}`);
    return lines;
  }

  const progress = pipelineStepProgress(run);
  lines.push(
    `  ${label("pipeline")} ${run.pipelineName}   ${label("status")} ${colorRunStatus(run.status)}` +
      `   ${label("steps")} ${progress.label}`,
  );

  if (run.blocked.length > 0) {
    lines.push("");
    lines.push(`  ${c.yellow("blocked")}:`);
    for (const b of run.blocked) {
      const stepName = run.snapshot && b.stepId ? stepNameById(run.snapshot.graph, b.stepId) : b.stepId;
      const who = b.taskId ? ` (${stepName ?? "?"} · ${c.dim(b.taskId.slice(0, 8))})` : "";
      lines.push(`    ${c.yellow("⚠")} [${b.kind}]${who} ${b.message}`);
    }
  }

  if (run.active.length > 0) {
    lines.push("");
    lines.push(`  ${c.cyan("active")}:`);
    for (const a of run.active) {
      const stepName = run.snapshot ? stepNameById(run.snapshot.graph, a.stepId) : a.stepId;
      const stepTask = steps.find((s) => s.id === a.taskId);
      const columnNote = stepTask ? `  ${c.dim(stepTask.column)}` : "";
      lines.push(`    ${c.cyan("▸")} ${stepName}  ${c.dim(a.taskId.slice(0, 8))}${columnNote}`);
    }
  }

  if (run.history.length > 0) {
    lines.push("");
    lines.push(`  ${c.dim("history (oldest first):")}`);
    for (const h of run.history) {
      const stepName = run.snapshot ? stepNameById(run.snapshot.graph, h.stepId) : h.stepId;
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
 *  (listing failed — nothing to compare against). */
function profileText(id: string, profiles: AgentProfile[] | null): string {
  if (!profiles) return id;
  const live = profiles.find((p) => p.id === id);
  return live ? `${live.name} ${c.dim(`(${id})`)}` : `${id} ${c.yellow("(missing)")}`;
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

/**
 * Per-step agent-profile NAME hints an exported file carries next to its
 * profile ids (`profileName` on the step, `subagents.profileNames` parallel
 * to `subagents.profileIds`) — additive, ignored by the server's validator,
 * read here so `import` can remap an id that doesn't exist on this machine
 * by name (M-CLI4). Keyed by step id; a missing/non-string hint is `null`.
 */
export type ProfileHints = Map<string, { profileName: string | null; subagentProfileNames: (string | null)[] }>;

/**
 * `agetor pipeline export`'s counterpart to {@link parsePipelineFile}'s hint
 * extraction: returns a copy of `input` whose steps carry a `profileName`
 * next to `agentProfileId` and a `subagents.profileNames` array parallel to
 * `subagents.profileIds` (`null` for an id no live profile matches — kept
 * positional so the import side can index by the same offset). Pure.
 */
export function withProfileHints(input: PipelineInput, profiles: AgentProfile[]): PipelineInput {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (profiles.find((p) => p.id === id)?.name ?? null);
  return {
    ...input,
    graph: {
      ...input.graph,
      steps: input.graph.steps.map((step) => {
        const hinted: Record<string, unknown> = { ...step };
        const profileName = nameOf(step.agentProfileId);
        if (profileName !== null) hinted.profileName = profileName;
        if (step.subagents.profileIds.length > 0) {
          hinted.subagents = { ...step.subagents, profileNames: step.subagents.profileIds.map(nameOf) };
        }
        return hinted as unknown as PipelineGraph["steps"][number];
      }),
    },
  };
}

/**
 * Pure import-side reconciliation of a parsed file's agent-profile ids
 * against THIS machine's live `profiles` (M-CLI4). For each step
 * `agentProfileId` and each `subagents.profileIds` entry that no live
 * profile carries: when the file's hint names exactly one live profile
 * (case-insensitive, trimmed — the same uniqueness the server enforces on
 * `name_key`), the id is remapped to that profile's and the swap is
 * reported in `remapped`; otherwise the dangling id is left as-is and
 * reported in `warnings`. Ids that already resolve are untouched.
 */
export function resolveImportProfiles(
  input: PipelineInput,
  hints: ProfileHints,
  profiles: AgentProfile[],
): { input: PipelineInput; remapped: string[]; warnings: string[] } {
  const remapped: string[] = [];
  const warnings: string[] = [];
  const liveIds = new Set(profiles.map((p) => p.id));
  const byName = (name: string | null): AgentProfile | null => {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    const matches = profiles.filter((p) => p.name.trim().toLowerCase() === key);
    return matches.length === 1 ? matches[0]! : null;
  };
  const resolve = (id: string, hint: string | null, what: string): string => {
    if (liveIds.has(id)) return id;
    const target = byName(hint);
    if (target) {
      remapped.push(`${what}: agent profile ${id} isn't defined here — remapped to "${target.name}" (${target.id})`);
      return target.id;
    }
    warnings.push(
      `${what}: agent profile ${id}${hint ? ` ("${hint}")` : ""} isn't defined on this machine — ` +
        "assign one in the editor before running this pipeline",
    );
    return id;
  };
  const steps = input.graph.steps.map((step) => {
    const hint = hints.get(step.id);
    const agentProfileId =
      step.agentProfileId === null
        ? null
        : resolve(step.agentProfileId, hint?.profileName ?? null, `step "${step.name}"`);
    const profileIds = step.subagents.profileIds.map((id, i) =>
      resolve(id, hint?.subagentProfileNames[i] ?? null, `step "${step.name}" subagent`),
    );
    return { ...step, agentProfileId, subagents: { ...step.subagents, profileIds } };
  });
  return { input: { ...input, graph: { ...input.graph, steps } }, remapped, warnings };
}

/**
 * Parse the JSON text of a `agetor pipeline export`ed file (or a hand-written
 * one) into a {@link PipelineInput} ready for `POST /pipelines`, validating
 * as it goes: valid JSON, a plain object, a non-empty `name`, a graph that
 * passes {@link validatePipelineGraph}, and (when present) an integer
 * `maxSteps`. Pure — no I/O — so `agetor pipeline import`'s file/stdin read
 * stays a thin wrapper around this. `hints` carries the file's additive
 * profile-name hints (see {@link ProfileHints}); the returned `input.graph`
 * is the validator's NORMALIZED graph, which has already dropped them.
 */
export function parsePipelineFile(
  text: string,
): { ok: true; input: PipelineInput; hints: ProfileHints } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "pipeline file must contain a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return { ok: false, error: 'missing a non-empty "name"' };

  const graphResult = validatePipelineGraph(obj.graph);
  if (!graphResult.ok) return { ok: false, error: graphResult.error };

  let maxSteps: number | undefined;
  if (obj.maxSteps !== undefined) {
    if (typeof obj.maxSteps !== "number" || !Number.isInteger(obj.maxSteps)) {
      return { ok: false, error: '"maxSteps" must be an integer' };
    }
    maxSteps = obj.maxSteps;
  }

  const input: PipelineInput = { name, graph: graphResult.graph };
  if (typeof obj.description === "string") input.description = obj.description;
  if (maxSteps !== undefined) input.maxSteps = maxSteps;

  return { ok: true, input, hints: extractProfileHints(obj.graph) };
}

/** Pull the additive `profileName` / `subagents.profileNames` hints off a
 *  RAW (pre-validation) graph object — the validator has already proven the
 *  shape, so this only has to be defensive about the hint fields themselves. */
function extractProfileHints(rawGraph: unknown): ProfileHints {
  const hints: ProfileHints = new Map();
  const g = rawGraph as { steps?: unknown };
  if (!g || !Array.isArray(g.steps)) return hints;
  for (const raw of g.steps as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const step = raw as { id?: unknown; profileName?: unknown; subagents?: unknown };
    if (typeof step.id !== "string") continue;
    const sub = (typeof step.subagents === "object" && step.subagents !== null ? step.subagents : {}) as {
      profileNames?: unknown;
    };
    const names = Array.isArray(sub.profileNames) ? sub.profileNames : [];
    hints.set(step.id, {
      profileName: typeof step.profileName === "string" && step.profileName.trim() ? step.profileName : null,
      subagentProfileNames: names.map((n) => (typeof n === "string" && n.trim() ? n : null)),
    });
  }
  return hints;
}
