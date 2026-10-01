import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { c, errln, out, printJson } from "../output.ts";
import { flagValue } from "../args.ts";
import { ApiError, type AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { asProfileError, matchAgentProfileRef } from "../../shared/agent-profile.ts";
import { matchPipelineRef } from "../../shared/pipeline.ts";
import { BUNDLE_MAX_BYTES, parseBundleText } from "../../shared/bundle.ts";
import type {
  BundleImportOptions,
  BundleImportPlan,
  BundleImportResponse,
  BundleIssue,
  PlannedAgent,
} from "../../shared/bundle-import.ts";

/**
 * `agetor export` / `agetor import` and the `profile`/`pipeline`
 * export|import shortcuts (docs/plans/agents-pipelines-import-export.md K15).
 * The format, validation and import planning all happen in the core
 * (`/bundle/*`); this side resolves `<ref>`s to ids, reads/writes files, and
 * prints. Unknown flags throw — these commands write data.
 */

/** Which command a shortcut runs as, for its usage error and messages. */
type CommandName = "export" | "import" | "profile export" | "profile import" | "pipeline export" | "pipeline import";

export interface ExportFlags {
  /** `--profile <ref>` (alias `--agent`), repeatable. */
  profiles: string[];
  /** `--pipeline <ref>`, repeatable. */
  pipelines: string[];
  all: boolean;
  /** `--out <file|->`; `-` (or omitted) prints to stdout. */
  out?: string;
  force: boolean;
}

/** Pure flag parser for `agetor export`. Positionals and unknown flags throw
 *  `usage`'s error. */
export function parseExportFlags(args: string[], usage: CommandName = "export"): ExportFlags {
  const f: ExportFlags = { profiles: [], pipelines: [], all: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--profile" || a === "--agent") f.profiles.push(flagValue(args, ++i, a));
    else if (a === "--pipeline") f.pipelines.push(flagValue(args, ++i, a));
    else if (a === "--all") f.all = true;
    else if (a === "--out") f.out = flagValue(args, ++i, a, /* allowDash */ true);
    else if (a === "--force") f.force = true;
    else throw usageError(usage);
  }
  return f;
}

export interface ImportFlags {
  dryRun: boolean;
  /** `--harness-map <fileId>=<localId>`, repeatable. */
  harnessMap: Record<string, string>;
  /** `--name <n>`: the file's only Pipeline, or its only Agent. */
  name?: string;
  enableHarnesses: boolean;
}

/** Parse `--harness-map` values (`<fileId>=<localId>`). A later mapping of
 *  the same file id wins. */
export function parseHarnessMap(values: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    const from = eq > 0 ? v.slice(0, eq).trim() : "";
    const to = eq > 0 ? v.slice(eq + 1).trim() : "";
    if (!from || !to) throw new Error(`--harness-map expects <fileHarnessId>=<localHarnessId>, got "${v}"`);
    map[from] = to;
  }
  return map;
}

/** Pure flag parser for `agetor import` (positionals are the caller's). */
export function parseImportFlags(args: string[], usage: CommandName = "import"): ImportFlags {
  const maps: string[] = [];
  const f: ImportFlags = { dryRun: false, harnessMap: {}, enableHarnesses: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") f.dryRun = true;
    else if (a === "--harness-map") maps.push(flagValue(args, ++i, a));
    else if (a === "--name") f.name = flagValue(args, ++i, a);
    else if (a === "--enable-harnesses") f.enableHarnesses = true;
    else throw usageError(usage);
  }
  f.harnessMap = parseHarnessMap(maps);
  return f;
}

/** Run a `/bundle/*` call, turning a 404 (a core without these routes) into
 *  an actionable message. */
async function bundleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error("the running agetor core is older than this CLI — restart or update it");
    }
    throw e;
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function countsText(counts: { agents: number; pipelines: number }): string {
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(plural(counts.agents, "Agent"));
  if (counts.pipelines > 0) parts.push(plural(counts.pipelines, "Pipeline"));
  return parts.join(", ") || "nothing";
}

// ── export ─────────────────────────────────────────────────────────────────

async function runExport(client: AgetorClient, flags: Flags, f: ExportFlags, outPath: string | null): Promise<void> {
  let agentIds: string[] = [];
  let pipelineIds: string[] = [];
  if (!f.all) {
    if (f.profiles.length > 0) {
      const profiles = await client.listAgentProfiles();
      agentIds = f.profiles.map((ref) => {
        const r = matchAgentProfileRef(profiles, ref);
        if ("error" in r) throw new Error(asProfileError(r.error));
        return r.profile.id;
      });
    }
    if (f.pipelines.length > 0) {
      const pipelines = await client.listPipelines();
      pipelineIds = f.pipelines.map((ref) => {
        const r = matchPipelineRef(pipelines, ref);
        if (!r.ok) throw new Error(r.error);
        return r.pipeline.id;
      });
    }
  }
  const res = await bundleCall(() => client.exportBundle(f.all ? { all: true } : { agentIds, pipelineIds }));
  // Warnings go to stderr so a stdout export stays a clean JSON document.
  for (const w of res.warnings) errln(c.yellow(`! ${w}`));
  if (outPath) {
    writeFileSync(outPath, res.text);
    if (flags.json) return printJson({ written: outPath, counts: res.counts, warnings: res.warnings });
    out(`${c.green("✓")} wrote ${countsText(res.counts)} to ${outPath}`);
  } else {
    out(res.text.replace(/\n$/, ""));
  }
}

/** Refuse an existing `--out` file unless `--force` — before any network
 *  call. Returns the file path, or null for stdout. */
function checkOutPath(f: ExportFlags): string | null {
  const outPath = f.out && f.out !== "-" ? f.out : null;
  if (outPath && !f.force && existsSync(outPath)) {
    throw new Error(`refusing to overwrite ${outPath} — pass --force to replace it`);
  }
  return outPath;
}

/** `agetor export [--profile <ref>]… [--pipeline <ref>]… [--all] [--out <file|->] [--force]`. */
export async function cmdExport(args: string[], flags: Flags): Promise<void> {
  const f = parseExportFlags(args, "export");
  if (f.all && (f.profiles.length > 0 || f.pipelines.length > 0)) {
    throw new Error("--all exports everything — it can't be combined with --profile or --pipeline");
  }
  if (!f.all && f.profiles.length === 0 && f.pipelines.length === 0) throw usageError("export");
  const outPath = checkOutPath(f);
  const client = await getClient(flags);
  await runExport(client, flags, f, outPath);
}

/** `agetor profile export <ref>` / `agetor pipeline export <ref>` — the same
 *  bundle, selected by one ref; only `--out` and `--force` are accepted. */
export async function cmdExportOne(
  kind: "profile" | "pipeline",
  args: string[],
  flags: Flags,
  client?: AgetorClient,
): Promise<void> {
  const usage: CommandName = `${kind} export`;
  const ref = args[0];
  if (!ref || ref.startsWith("-")) throw usageError(usage);
  const f = parseExportFlags(args.slice(1), usage);
  if (f.all || f.profiles.length > 0 || f.pipelines.length > 0) throw usageError(usage);
  const outPath = checkOutPath(f);
  const selected: ExportFlags = { ...f, profiles: kind === "profile" ? [ref] : [], pipelines: kind === "pipeline" ? [ref] : [] };
  await runExport(client ?? (await getClient(flags)), flags, selected, outPath);
}

// ── import ─────────────────────────────────────────────────────────────────

function harnessText(id: string | null, label: string | null): string {
  if (!id) return c.red("no harness");
  return label && label !== id ? `${label} (${id})` : id;
}

function resolutionNote(a: PlannedAgent): string {
  const from = a.fileHarness.label && a.fileHarness.label !== a.fileHarness.id
    ? `${a.fileHarness.label} (${a.fileHarness.id})`
    : a.fileHarness.id;
  switch (a.resolution) {
    case "exact":
      return "";
    case "fallback":
      return c.yellow(` — fallback for ${from}`);
    case "mapped":
      return c.dim(` — mapped from ${from}`);
    case "rebound":
      return c.yellow(` — re-bound from ${from} (${a.fileHarness.kind}); settings reset`);
    case "unresolved":
      return c.red(` — ${from} (${a.fileHarness.kind}) needs a local harness`);
  }
}

const HARNESS_ISSUES = new Set(["unknown-kind", "harness-kind-mismatch", "unknown-local-harness", "no-fallback-harness"]);

/** Hint lines for a plan's blocking issues. */
function blockingHints(plan: BundleImportPlan, singleNameFlag: boolean): string[] {
  const codes = new Set(plan.blocking.map((b) => b.code));
  const hints: string[] = [];
  if ([...codes].some((code) => HARNESS_ISSUES.has(code))) {
    const local = plan.localHarnesses.map((h) => `${h.id} (${h.kind})`).join(", ");
    hints.push(`map a file harness to a local one with --harness-map <fileHarnessId>=<localHarnessId> — local harnesses: ${local}`);
  }
  if (codes.has("name-in-use") || codes.has("name-invalid")) {
    hints.push(singleNameFlag ? "pick another --name" : "rename the conflicting item in the file, or import it with --name");
  }
  if (codes.has("name-not-applicable")) {
    hints.push("--name only applies to a file with exactly one Pipeline, or one Agent and no Pipelines");
  }
  return hints;
}

function issueLine(prefix: string, issue: BundleIssue): string {
  return `  ${prefix} ${issue.message}`;
}

/**
 * The printed form of an import plan (dry run, or a blocked import): what
 * would be created, renamed and bound, then warnings and blocking issues.
 */
export function importPlanLines(plan: BundleImportPlan, opts: { singleNameFlag?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (plan.legacy) lines.push(c.yellow("legacy file — Agents are matched by name"));
  if (plan.agents.length > 0) {
    lines.push(`${c.bold(plural(plan.agents.length, "Agent"))} to create:`);
    for (const a of plan.agents) {
      const renamed = a.renamed ? c.dim(` (was "${a.sourceName}")`) : "";
      lines.push(`  + ${c.bold(a.name)}${renamed} → ${harnessText(a.harnessId, a.harnessLabel)}${resolutionNote(a)}`);
    }
  }
  if (plan.pipelines.length > 0) {
    lines.push(`${c.bold(plural(plan.pipelines.length, "Pipeline"))} to create:`);
    for (const p of plan.pipelines) {
      const renamed = p.renamed ? c.dim(` (was "${p.sourceName}")`) : "";
      lines.push(`  + ${c.bold(p.name)}${renamed} ${c.dim(`— ${plural(p.steps.length, "step")}`)}`);
    }
  }
  for (const h of plan.harnesses) {
    if (h.willEnable) lines.push(`  ${c.cyan("~")} harness ${harnessText(h.id, h.label)} will be enabled`);
  }
  if (plan.warnings.length > 0) {
    lines.push(c.yellow(plural(plan.warnings.length, "warning") + ":"));
    for (const w of plan.warnings) lines.push(c.yellow(issueLine("!", w)));
    const disabled = plan.harnesses.filter((h) => h.canEnable && !h.willEnable);
    if (disabled.length > 0) {
      lines.push(c.dim(`  pass --enable-harnesses to enable ${disabled.map((h) => h.id).join(", ")} as part of the import`));
    }
  }
  if (plan.blocking.length > 0) {
    lines.push(c.red(plural(plan.blocking.length, "blocking issue") + ":"));
    for (const b of plan.blocking) lines.push(c.red(issueLine("✗", b)));
    for (const hint of blockingHints(plan, opts.singleNameFlag ?? false)) lines.push(c.dim(`  hint: ${hint}`));
  }
  return lines;
}

/** The printed form of a committed import. */
export function importResultLines(result: BundleImportResponse): string[] {
  const lines: string[] = [];
  lines.push(
    `${c.green("✓")} imported ${countsText({ agents: result.agents.length, pipelines: result.pipelines.length })}`,
  );
  const planned = new Map(result.plan.agents.map((a) => [a.name, a] as const));
  for (const a of result.agents) {
    const p = planned.get(a.name);
    const harness = p ? harnessText(p.harnessId, p.harnessLabel) : a.harness;
    lines.push(`  + Agent ${c.bold(a.name)} → ${harness} ${c.dim(`(${a.id})`)}`);
  }
  for (const p of result.pipelines) lines.push(`  + Pipeline ${c.bold(p.name)} ${c.dim(`(${p.id})`)}`);
  for (const id of result.enabledHarnesses) lines.push(`  ${c.green("✓")} enabled harness ${id}`);
  for (const w of result.warnings) lines.push(c.yellow(issueLine("!", w)));
  return lines;
}

async function readImportText(file: string): Promise<string> {
  if (file === "-") return Bun.stdin.text();
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new Error(`can't read ${file}`);
  }
  if (size > BUNDLE_MAX_BYTES) {
    throw new Error(`${file} is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB`);
  }
  return readFileSync(file, "utf8");
}

async function runImport(
  args: string[],
  flags: Flags,
  usage: CommandName,
  client?: AgetorClient,
): Promise<void> {
  const file = args[0];
  if (!file || (file.startsWith("-") && file !== "-")) throw usageError(usage);
  const f = parseImportFlags(args.slice(1), usage);
  const text = await readImportText(file);
  // Same parser the core runs — a bad file fails here without a round trip.
  const parsed = parseBundleText(text);
  if (!parsed.ok) throw new Error(`can't import ${file === "-" ? "stdin" : file}: ${parsed.error}`);

  const options: BundleImportOptions = {};
  if (Object.keys(f.harnessMap).length > 0) options.harnessMap = f.harnessMap;
  if (f.name !== undefined) options.singleName = f.name;
  if (f.enableHarnesses) options.enableHarnesses = "all";
  const api = client ?? (await getClient(flags));
  const singleNameFlag = f.name !== undefined;

  if (f.dryRun) {
    const plan = await bundleCall(() => api.previewBundleImport(text, options));
    if (flags.json) printJson(plan);
    else {
      out(c.dim("dry run — nothing was imported"));
      for (const line of importPlanLines(plan, { singleNameFlag })) out(line);
    }
    if (!plan.canImport) throw new Error(`the import would be blocked by ${plural(plan.blocking.length, "issue")}`);
    return;
  }

  let result: BundleImportResponse;
  try {
    result = await bundleCall(() => api.importBundle(text, options));
  } catch (e) {
    const plan = e instanceof ApiError && e.status === 409 ? (e.body as { plan?: BundleImportPlan } | null)?.plan : undefined;
    if (!plan) throw e;
    if (flags.json) printJson(e instanceof ApiError ? e.body : null);
    else for (const line of importPlanLines(plan, { singleNameFlag })) out(line);
    throw new Error(`nothing was imported — ${plural(plan.blocking.length, "blocking issue")}`);
  }
  if (flags.json) return printJson(result);
  for (const line of importResultLines(result)) out(line);
}

/** `agetor import <file|-> [--dry-run] [--harness-map <fileId>=<localId>]… [--name <n>] [--enable-harnesses]`. */
export async function cmdImport(args: string[], flags: Flags): Promise<void> {
  await runImport(args, flags, "import");
}

/** `agetor profile import` / `agetor pipeline import` — the same import. */
export async function cmdImportAs(
  kind: "profile" | "pipeline",
  args: string[],
  flags: Flags,
  client?: AgetorClient,
): Promise<void> {
  await runImport(args, flags, `${kind} import`, client);
}
