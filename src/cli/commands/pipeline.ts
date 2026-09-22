import { readFileSync, writeFileSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";
import type { AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { taskCountText } from "./agent-profile.ts";
import { matchPipelineRef, outgoingSteps, resolveStartStep, validatePipelineGraph } from "../../shared/pipeline.ts";
import type { Pipeline, PipelineInput } from "../../shared/types.ts";

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
      for (const line of pipelineShowLines(pipeline)) out(line);
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
      const pipeline = await resolvePipeline(client, ref);
      const input: PipelineInput = {
        name: pipeline.name,
        description: pipeline.description,
        graph: pipeline.graph,
        maxSteps: pipeline.maxSteps,
      };
      const text = JSON.stringify(input, null, 2);
      if (f.out) {
        writeFileSync(f.out, text + "\n");
        if (flags.json) return printJson({ written: f.out });
        out(`${c.green("✓")} wrote ${c.bold(pipeline.name)} to ${f.out}`);
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
      const input: PipelineInput = f.name ? { ...parsed.input, name: f.name } : parsed.input;
      const created = await client.createPipeline(input);
      if (flags.json) return printJson(created);
      out(`${c.green("✓")} imported pipeline ${c.bold(created.name)} (${c.dim(created.id)})`);
      return;
    }
    default:
      throw new Error(`unknown pipeline subcommand: ${sub} (use ls | show | rm | export | import)`);
  }
}

async function resolvePipeline(client: AgetorClient, ref: string): Promise<Pipeline> {
  const pipelines = await client.listPipelines();
  const result = matchPipelineRef(pipelines, ref);
  if (!result.ok) throw new Error(result.error);
  return result.pipeline;
}

interface ExportFlags {
  out?: string;
}

/** Pure flag parser for `agetor pipeline export` — just `--out <file>`. */
export function parseExportFlags(args: string[]): ExportFlags {
  const f: ExportFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") f.out = flagValue(args, ++i, a);
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
 * step (name/id, bound agent-profile id, transition/join mode, and its
 * outgoing edges by target step name, with the edge label in parens when
 * set — or "(terminal …)" for a step with no outgoing edges). Exported so
 * the render is testable without a client/daemon.
 */
export function pipelineShowLines(p: Pipeline): string[] {
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
    lines.push(`     ${label("profile")} ${step.agentProfileId ?? c.dim("none")}`);
    lines.push(`     ${label("transition")} ${step.transition}   ${label("join")} ${step.join}`);
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
 * Parse the JSON text of a `agetor pipeline export`ed file (or a hand-written
 * one) into a {@link PipelineInput} ready for `POST /pipelines`, validating
 * as it goes: valid JSON, a plain object, a non-empty `name`, a graph that
 * passes {@link validatePipelineGraph}, and (when present) an integer
 * `maxSteps`. Pure — no I/O — so `agetor pipeline import`'s file/stdin read
 * stays a thin wrapper around this.
 */
export function parsePipelineFile(
  text: string,
): { ok: true; input: PipelineInput } | { ok: false; error: string } {
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

  return { ok: true, input };
}
