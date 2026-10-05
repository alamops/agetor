import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, errln, isTTY, out, printJson } from "../output.ts";
import { flagValue } from "../args.ts";
import { ApiError, type AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { asProfileError, matchAgentProfileRef } from "../../shared/agent-profile.ts";
import { matchPipelineRef } from "../../shared/pipeline.ts";
import { BUNDLE_MAX_BYTES, escapeControlChars, type ParsedBundle, parseBundleText } from "../../shared/bundle.ts";
import { shellWord } from "../../shared/shell-quote.ts";
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

/** `flagValue`, refusing an empty or blank value too: `--out ""` would
 *  otherwise print to stdout and `--name ""` be silently ignored. */
function nonEmptyValue(args: string[], i: number, flag: string, allowDash = false): string {
  const v = flagValue(args, i, flag, allowDash);
  if (!v.trim()) throw new Error(`'${flag}' needs a value`);
  return v;
}

/** Pure flag parser for `agetor export`. Positionals and unknown flags throw
 *  `usage`'s error. */
export function parseExportFlags(args: string[], usage: CommandName = "export"): ExportFlags {
  const f: ExportFlags = { profiles: [], pipelines: [], all: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--profile" || a === "--agent") f.profiles.push(nonEmptyValue(args, ++i, a));
    else if (a === "--pipeline") f.pipelines.push(nonEmptyValue(args, ++i, a));
    else if (a === "--all") f.all = true;
    else if (a === "--out") f.out = nonEmptyValue(args, ++i, a, /* allowDash */ true);
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
  /** `--yes`/`-y`: import without the confirmation an interactive terminal
   *  otherwise asks for. */
  yes: boolean;
}

/** Parse `--harness-map` values (`<fileId>=<localId>`). A later mapping of
 *  the same file id wins. Split on the LAST `=`: a local harness id never
 *  contains one (`HARNESS_ID_RE`), but a file's id is third-party text that
 *  may (`acct=work`), and must still be mappable. */
export function parseHarnessMap(values: string[]): Record<string, string> {
  const map = new Map<string, string>();
  for (const v of values) {
    const eq = v.lastIndexOf("=");
    const from = eq > 0 ? v.slice(0, eq).trim() : "";
    const to = eq > 0 ? v.slice(eq + 1).trim() : "";
    if (!from || !to) throw new Error(`--harness-map expects <fileHarnessId>=<localHarnessId>, got "${v}"`);
    map.set(from, to);
  }
  // Own properties, so a file harness id such as "__proto__" isn't dropped
  // by the prototype setter an assignment would hit.
  return Object.fromEntries(map);
}

/** The error for `--harness-map` keys no Agent in the file uses, or null
 *  when every key names one. The planner matches keys against each Agent's
 *  file harness id exactly and ignores the rest, so a typo (or the
 *  `--harness-map --name=x` shape, whose key is `--name`) would otherwise
 *  import with nothing remapped and no word why. */
export function unknownHarnessMapError(harnessMap: Record<string, string>, bundle: ParsedBundle): string | null {
  const used = [...new Set(bundle.agents.map((a) => a.harness.id))];
  const unknown = Object.keys(harnessMap).filter((id) => !used.includes(id));
  if (unknown.length === 0) return null;
  const quoted = (ids: string[]): string => ids.map((id) => `"${escapeControlChars(id)}"`).join(", ");
  const what = `--harness-map names ${unknown.length === 1 ? "a harness" : "harnesses"} this file doesn't use: ${quoted(unknown)}`;
  return used.length === 0
    ? `${what} — the file has no Agents, so there is nothing to map`
    : `${what} — its Agents use: ${quoted(used)}`;
}

/** A `--harness-map` value. One holding an `=` is taken as-is even when it
 *  starts with `-`: no flag contains one, but a file's harness id is
 *  third-party text that may start with a dash (`-work`), and the hint the
 *  CLI prints for it (`--harness-map -work=<localHarnessId>`) must work when
 *  pasted. */
function harnessMapValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (v !== undefined && v.startsWith("-") && v.includes("=")) return v;
  return nonEmptyValue(args, i, flag);
}

/** Pure flag parser for `agetor import` (positionals are the caller's). */
export function parseImportFlags(args: string[], usage: CommandName = "import"): ImportFlags {
  const maps: string[] = [];
  const f: ImportFlags = { dryRun: false, harnessMap: {}, enableHarnesses: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") f.dryRun = true;
    else if (a === "--harness-map") maps.push(harnessMapValue(args, ++i, a));
    else if (a === "--name") f.name = nonEmptyValue(args, ++i, a);
    else if (a === "--enable-harnesses") f.enableHarnesses = true;
    else if (a === "--yes" || a === "-y") f.yes = true;
    else throw usageError(usage);
  }
  f.harnessMap = parseHarnessMap(maps);
  return f;
}

const EXPORT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--profile", "--agent", "--pipeline", "--out"]);
const IMPORT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--harness-map", "--name"]);

/** Split off the one positional argument wherever it sits among the flags
 *  (`agetor import --dry-run f.agetor.json` as well as `… f.agetor.json
 *  --dry-run`), skipping each value flag's value. `-` is a positional (stdin).
 *  The rest goes to the flag parser, which refuses a second positional. */
export function splitPositional(
  args: string[],
  valueFlags: ReadonlySet<string>,
): { positional: string | undefined; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (a === "-" || !a.startsWith("-")) {
      return { positional: a, rest: [...args.slice(0, i), ...args.slice(i + 1)] };
    }
  }
  return { positional: undefined, rest: args };
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
  // Warnings go to stderr so a stdout export stays a clean JSON document;
  // under --json they ride in the printed result instead.
  if (!flags.json) for (const w of res.warnings) errln(c.yellow(`! ${safe(w)}`));
  if (outPath) {
    writeOutFile(outPath, res.text, f.force);
    if (flags.json) return printJson({ written: outPath, counts: res.counts, warnings: res.warnings });
    out(`${c.green("✓")} wrote ${countsText(res.counts)} to ${outPath}`);
  } else if (flags.json) {
    // --json is the machine-readable result, like every other command: the
    // bundle plus what was exported. Without --json stdout is the file.
    printJson({ filename: res.filename, counts: res.counts, warnings: res.warnings, bundle: JSON.parse(res.text) });
  } else {
    out(res.text.replace(/\n$/, ""));
  }
}

/** Write the export to `--out`. Without `--force` the file is created
 *  exclusively, so one that appeared after `checkOutPath` is still never
 *  overwritten. */
function writeOutFile(outPath: string, text: string, force: boolean): void {
  try {
    writeFileSync(outPath, text, { flag: force ? "w" : "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`refusing to overwrite ${outPath} — pass --force to replace it`);
    }
    if (code === "EISDIR") throw new Error(`can't write to ${outPath}: it is a folder — give a file name with --out`);
    if (code === "ENOENT") throw new Error(`can't write to ${outPath}: its folder doesn't exist`);
    if (code === "ENOTDIR") throw new Error(`can't write to ${outPath}: its parent isn't a folder`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`can't write to ${outPath} — permission denied`);
    throw new Error(`can't write to ${outPath}${code ? ` (${code})` : `: ${(e as Error).message}`}`);
  }
}

function isDirectoryPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Refuse an existing `--out` file unless `--force` — before any network
 *  call, so nothing is fetched for an export that can't be written. Returns
 *  the file path, or null for stdout. */
function checkOutPath(f: ExportFlags): string | null {
  const outPath = f.out && f.out !== "-" ? f.out : null;
  if (outPath && isDirectoryPath(outPath)) {
    throw new Error(`can't write to ${outPath}: it is a folder — give a file name with --out`);
  }
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
  const { positional: ref, rest } = splitPositional(args, EXPORT_VALUE_FLAGS);
  if (!ref || ref === "-") throw usageError(usage);
  const f = parseExportFlags(rest, usage);
  if (f.all || f.profiles.length > 0 || f.pipelines.length > 0) throw usageError(usage);
  const outPath = checkOutPath(f);
  const selected: ExportFlags = { ...f, profiles: kind === "profile" ? [ref] : [], pipelines: kind === "pipeline" ? [ref] : [] };
  await runExport(client ?? (await getClient(flags)), flags, selected, outPath);
}

// ── import ─────────────────────────────────────────────────────────────────

/** File-sourced text (names, harness labels, issue messages that quote
 *  them) for the terminal: the parser admits C1 controls and bidi overrides,
 *  which a terminal would act on. */
const safe = escapeControlChars;

function harnessText(id: string | null, label: string | null): string {
  if (!id) return c.red("no harness");
  return label && label !== id ? `${safe(label)} (${safe(id)})` : safe(id);
}

function resolutionNote(a: PlannedAgent): string {
  const from = safe(
    a.fileHarness.label && a.fileHarness.label !== a.fileHarness.id
      ? `${a.fileHarness.label} (${a.fileHarness.id})`
      : a.fileHarness.id,
  );
  const kind = safe(a.fileHarness.kind);
  switch (a.resolution) {
    case "exact":
      return "";
    case "fallback":
      return c.yellow(` — fallback for ${from}`);
    case "mapped":
      return c.dim(` — mapped from ${from}`);
    case "rebound":
      return c.yellow(` — re-bound from ${from} (${kind}); settings reset`);
    case "unresolved":
      return c.red(` — ${from} (${kind}) needs a local harness`);
  }
}

const HARNESS_ISSUES = new Set([
  "unknown-kind",
  "harness-kind-mismatch",
  "unknown-local-harness",
  "unsupported-local-harness",
  "no-fallback-harness",
]);

/** One `--harness-map` hint per file harness a blocked Agent uses, naming
 *  only the local harnesses that Agent can be bound to (its
 *  `candidateHarnessIds`: the same kind, or any harness of a kind this build
 *  can run when the file's kind is unknown) — never a retired-kind or
 *  wrong-kind harness the planner would refuse. */
function harnessHints(plan: BundleImportPlan): string[] {
  const localById = new Map(plan.localHarnesses.map((h) => [h.id, h]));
  const groups = new Map<string, { id: string; kind: string; candidates: string[] }>();
  for (const a of plan.agents) {
    if (!a.errors.some((e) => HARNESS_ISSUES.has(e.code))) continue;
    const key = `${a.fileHarness.id}\u0000${a.fileHarness.kind}`;
    const group = groups.get(key);
    if (group) {
      for (const id of a.candidateHarnessIds) if (!group.candidates.includes(id)) group.candidates.push(id);
    } else {
      groups.set(key, { id: a.fileHarness.id, kind: a.fileHarness.kind, candidates: [...a.candidateHarnessIds] });
    }
  }
  const hints: string[] = [];
  for (const g of groups.values()) {
    const id = safe(g.id);
    if (g.candidates.length === 0) {
      hints.push(`no harness on this machine can run ${id} (${safe(g.kind)}) — add one in Settings → Harnesses, or remove the Agent from the file`);
      continue;
    }
    const candidates = g.candidates
      .map((hid) => `${safe(hid)} (${safe(localById.get(hid)?.kind ?? "?")})`)
      .join(", ");
    // The file's id is third-party text: shell-quoted inside the pasteable
    // flag, so an id such as `$(…)` can't run when the line is copied.
    hints.push(
      `map ${id} to a local harness with --harness-map ${shellWord(`${safe(g.id)}=`)}<localHarnessId> — it can use: ${candidates}`,
    );
  }
  return hints;
}

/** Hint lines for a plan's blocking issues. */
function blockingHints(plan: BundleImportPlan, singleNameFlag: boolean): string[] {
  const codes = new Set(plan.blocking.map((b) => b.code));
  const hints: string[] = [];
  if ([...codes].some((code) => HARNESS_ISSUES.has(code))) hints.push(...harnessHints(plan));
  if (codes.has("name-in-use") || codes.has("name-invalid")) {
    hints.push(singleNameFlag ? "pick another --name" : "rename the conflicting item in the file, or import it with --name");
  }
  if (codes.has("name-not-applicable")) {
    hints.push("--name only applies to a file with exactly one Pipeline, or one Agent and no Pipelines");
  }
  return hints;
}

function issueLine(prefix: string, issue: BundleIssue): string {
  return `  ${prefix} ${safe(issue.message)}`;
}

/** Longest instructions/description block printed per item, in lines. */
const TEXT_PREVIEW_LINES = 40;

/** Tab stop width used when printing file text. */
const TAB_WIDTH = 4;

/** `line` with each tab expanded to spaces up to the next tab stop — `safe`
 *  would otherwise print it as a literal `\u0009`. */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const pad = TAB_WIDTH - (col % TAB_WIDTH);
      out += " ".repeat(pad);
      col += pad;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/**
 * Multi-line text (instructions, a description) as printable lines: split on
 * every line break a terminal honors — a bare CR included, which would
 * otherwise return the cursor and let later text overprint what a model
 * still reads — with tabs expanded and the rest escaped by the multi-line
 * rule, so the joiners Persian or Hindi text needs (which the parser allows
 * there) print as text, not `\u200c`.
 */
export function printableLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => escapeControlChars(expandTabs(line), true));
}

/** A file-sourced multi-line text (instructions, a description), indented
 *  under its item for review; nothing for empty text. */
export function textBlockLines(label: string, text: string): string[] {
  const body = text.replace(/\s+$/, "");
  if (!body.trim()) return [];
  const all = printableLines(body);
  const shown = all.slice(0, TEXT_PREVIEW_LINES);
  const lines = [c.dim(`      ${label}:`)];
  for (const line of shown) lines.push(`${c.dim("      │")} ${line}`);
  if (all.length > shown.length) {
    lines.push(c.dim(`      │ … ${plural(all.length - shown.length, "more line")} — read them in the file`));
  }
  return lines;
}

/** The third-party note shown above every plan (the app shows the same). */
export const THIRD_PARTY_NOTE =
  "This file is third-party content: its instructions become part of your agents' prompts. Read them before importing.";

/**
 * The printed form of an import plan (dry run, or a blocked import): what
 * would be created, renamed and bound, then warnings and blocking issues.
 */
export function importPlanLines(plan: BundleImportPlan, opts: { singleNameFlag?: boolean } = {}): string[] {
  const lines: string[] = [];
  lines.push(c.yellow(THIRD_PARTY_NOTE));
  if (plan.legacy) lines.push(c.yellow("legacy file — Agents are matched by name"));
  if (plan.agents.length > 0) {
    lines.push(`${c.bold(plural(plan.agents.length, "Agent"))} to create:`);
    for (const a of plan.agents) {
      const renamed = a.renamed ? c.dim(` (was "${safe(a.sourceName)}")`) : "";
      lines.push(`  + ${c.bold(safe(a.name))}${renamed} → ${harnessText(a.harnessId, a.harnessLabel)}${resolutionNote(a)}`);
      if (a.skills.length > 0) lines.push(c.dim(`      skills: ${a.skills.map((s) => `/${safe(s)}`).join(", ")}`));
      lines.push(...textBlockLines("instructions", a.instructions));
    }
  }
  if (plan.pipelines.length > 0) {
    lines.push(`${c.bold(plural(plan.pipelines.length, "Pipeline"))} to create:`);
    for (const pl of plan.pipelines) {
      const renamed = pl.renamed ? c.dim(` (was "${safe(pl.sourceName)}")`) : "";
      lines.push(`  + ${c.bold(safe(pl.name))}${renamed} ${c.dim(`— ${plural(pl.steps.length, "step")}`)}`);
      lines.push(...textBlockLines("description", pl.description));
      for (const step of pl.steps) {
        if (!step.instructions.trim()) continue;
        lines.push(...textBlockLines(`step "${safe(step.name)}" instructions`, step.instructions));
      }
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
      lines.push(c.dim(`  pass --enable-harnesses to enable ${disabled.map((h) => safe(h.id)).join(", ")} as part of the import`));
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
    const harness = p ? harnessText(p.harnessId, p.harnessLabel) : safe(a.harness);
    lines.push(`  + Agent ${c.bold(safe(a.name))} → ${harness} ${c.dim(`(${a.id})`)}`);
  }
  for (const p of result.pipelines) lines.push(`  + Pipeline ${c.bold(safe(p.name))} ${c.dim(`(${p.id})`)}`);
  for (const id of result.enabledHarnesses) lines.push(`  ${c.green("✓")} enabled harness ${safe(id)}`);
  for (const w of result.warnings) lines.push(c.yellow(issueLine("!", w)));
  return lines;
}

/** `readCappedText`'s refusal of a stream past the cap — told apart from the
 *  read itself failing, which gets `readFailure`'s wording. */
class ImportTooLargeError extends Error {}

/** `stream` as UTF-8 text, refused once it passes {@link BUNDLE_MAX_BYTES} —
 *  the read stops there instead of buffering the rest. */
export async function readCappedText(stream: ReadableStream<Uint8Array>, what: string): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BUNDLE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ImportTooLargeError(`${what} is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A plain sentence for a failed read of `file`: the common errno codes
 *  get words, anything else keeps its code. */
function readFailure(file: string, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new Error(`no such file: ${file}`);
  if (code === "EACCES" || code === "EPERM") return new Error(`can't read ${file} — permission denied`);
  if (code === "EISDIR") return new Error(`${file} is a folder — pass a bundle file`);
  return new Error(`can't read ${file}${code ? ` (${code})` : ""}`);
}

/** Read `stream` through the cap; a failing read becomes `readFailure`'s
 *  plain sentence, the cap's own refusal passes through. */
export async function readStreamText(stream: () => ReadableStream<Uint8Array>, what: string): Promise<string> {
  try {
    return await readCappedText(stream(), what);
  } catch (e) {
    if (e instanceof ImportTooLargeError) throw e;
    throw readFailure(what, e);
  }
}

async function readImportText(file: string): Promise<string> {
  if (file === "-") return readStreamText(() => Bun.stdin.stream(), "stdin");
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch (e) {
    throw readFailure(file, e);
  }
  if (st.isDirectory()) throw new Error(`${file} is a folder — pass a bundle file`);
  if (!st.isFile()) {
    // A FIFO, /dev/stdin, /dev/fd/N…: its size says nothing about what it
    // will deliver, so read it through the same cap as stdin.
    return readStreamText(
      () => Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>,
      file,
    );
  }
  if (st.size > BUNDLE_MAX_BYTES) {
    throw new Error(`${file} is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB`);
  }
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw readFailure(file, e);
  }
}

/** Whether `agetor import` should preview and ask before importing: a
 *  terminal on both ends, a file (stdin is the bundle for `-`), no --json,
 *  no --yes. `tty` is a test seam. */
export function interactiveImport(
  file: string,
  flags: Pick<Flags, "json">,
  f: Pick<ImportFlags, "yes">,
  tty: { stdout: boolean; stdin: boolean } = { stdout: isTTY, stdin: Boolean(process.stdin.isTTY) },
): boolean {
  return !f.yes && !flags.json && file !== "-" && tty.stdout && tty.stdin;
}

/** What `askImport` prompts with; a test seam. */
export interface AskImportIo {
  confirm: (opts: { message: string; initialValue: boolean }) => Promise<boolean | symbol>;
  isCancel: (value: unknown) => value is symbol;
  /** Watched for a raw Ctrl+C while the prompt is up. */
  stdin: Pick<NodeJS.ReadStream, "on" | "off">;
}

const defaultAskImportIo: AskImportIo = { confirm: p.confirm, isCancel: p.isCancel, stdin: process.stdin };

/**
 * `true` to import, `false` for No, `null` for Ctrl+C. @clack/prompts
 * reports Esc and Ctrl+C alike as a cancel, so the raw input is watched for
 * the Ctrl+C byte: Esc is a No (exit 0), only Ctrl+C is an interrupt.
 */
export async function askImport(plan: BundleImportPlan, io: AskImportIo = defaultAskImportIo): Promise<boolean | null> {
  let interrupted = false;
  const onData = (chunk: Buffer | string) => {
    if (String(chunk).includes("\u0003")) interrupted = true;
  };
  io.stdin.on("data", onData);
  let answer: boolean | symbol;
  try {
    answer = await io.confirm({
      message: `Import ${countsText({ agents: plan.agents.length, pipelines: plan.pipelines.length })}?`,
      initialValue: false,
    });
  } finally {
    io.stdin.off("data", onData);
  }
  if (io.isCancel(answer)) return interrupted ? null : false;
  return answer === true;
}

/** Test seams for `runImport`. */
export interface ImportDeps {
  /** Replaces the terminal check + prompt: called with the previewed plan;
   *  resolve `true` to import, `false` for No, `null` for an interrupted
   *  prompt (Ctrl+C — exit status 130). */
  confirm?: (plan: BundleImportPlan) => Promise<boolean | null>;
}

async function runImport(
  args: string[],
  flags: Flags,
  usage: CommandName,
  client?: AgetorClient,
  deps: ImportDeps = {},
): Promise<void> {
  const { positional: file, rest } = splitPositional(args, IMPORT_VALUE_FLAGS);
  if (!file) throw usageError(usage);
  const f = parseImportFlags(rest, usage);
  const text = await readImportText(file);
  // Same parser the core runs — a bad file fails here without a round trip.
  const parsed = parseBundleText(text);
  // `parsed.error` never carries a raw control character (the parser escapes
  // the file text it quotes), so printing it can't drive the terminal.
  if (!parsed.ok) throw new Error(`can't import ${file === "-" ? "stdin" : file}: ${parsed.error}`);
  const mapError = unknownHarnessMapError(f.harnessMap, parsed.bundle);
  if (mapError) throw new Error(mapError);

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

  // In a terminal, show the plan — instructions included — and ask before
  // importing; the commit then carries the previewed plan's fingerprint, so
  // it's refused if this machine changed in between. Scripts (no TTY, --json,
  // a file on stdin) and --yes import directly.
  const confirm = deps.confirm ?? (interactiveImport(file, flags, f) ? askImport : null);
  let planFingerprint: string | undefined;
  if (confirm) {
    const plan = await bundleCall(() => api.previewBundleImport(text, options));
    for (const line of importPlanLines(plan, { singleNameFlag })) out(line);
    if (!plan.canImport) throw new Error(`nothing was imported — ${plural(plan.blocking.length, "blocking issue")}`);
    const answer = await confirm(plan);
    if (answer !== true) {
      // Ctrl+C is an interrupt, not a "No": exit 130 like any other one.
      if (answer === null) process.exitCode = 130;
      out(c.dim("nothing was imported"));
      return;
    }
    planFingerprint = plan.fingerprint;
  }

  let result: BundleImportResponse;
  try {
    result = await bundleCall(() => api.importBundle(text, options, planFingerprint));
  } catch (e) {
    const plan = e instanceof ApiError && e.status === 409 ? (e.body as { plan?: BundleImportPlan } | null)?.plan : undefined;
    if (!plan) throw e;
    if (flags.json) printJson(e instanceof ApiError ? e.body : null);
    else for (const line of importPlanLines(plan, { singleNameFlag })) out(line);
    // A name taken between the plan and the commit 409s with a plan that may
    // list no blocking issue — the core's own message says what happened.
    if (plan.blocking.length === 0) {
      throw new Error(`nothing was imported — ${escapeControlChars((e as Error).message)}`);
    }
    throw new Error(`nothing was imported — ${plural(plan.blocking.length, "blocking issue")}`);
  }
  if (flags.json) return printJson(result);
  for (const line of importResultLines(result)) out(line);
}

/** `agetor import <file|-> [--dry-run] [--harness-map <fileId>=<localId>]… [--name <n>] [--enable-harnesses] [--yes]`. */
export async function cmdImport(args: string[], flags: Flags, client?: AgetorClient, deps?: ImportDeps): Promise<void> {
  await runImport(args, flags, "import", client, deps);
}

/** `agetor profile import` / `agetor pipeline import` — the same import. */
export async function cmdImportAs(
  kind: "profile" | "pipeline",
  args: string[],
  flags: Flags,
  client?: AgetorClient,
  deps?: ImportDeps,
): Promise<void> {
  await runImport(args, flags, `${kind} import`, client, deps);
}
