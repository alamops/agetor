/**
 * Server side of the agetor bundle (docs/plans/agents-pipelines-import-export.md,
 * K1/K4/K7/K8/K13/K14): builds export text, writes it to the Downloads folder
 * or a picked folder without ever overwriting, gathers this machine's state
 * for the import planner, and commits an import in one database transaction.
 *
 * The `/bundle/*` routes in `server.ts` stay thin wrappers around this file.
 * The format itself and the planning rules live in `src/shared/bundle.ts` and
 * `src/shared/bundle-import.ts`. Nothing here ever reads or writes a path a
 * client supplied: save targets are the Downloads directory or a folder the
 * native panel returned, and file names are slugs this side derived.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  AgentProfileNameError,
  PipelineNameError,
  agentProfiles,
  db,
  harnesses,
  pipelines,
} from "./db.ts";
import { checkHarness } from "./agent-status.ts";
import { getDiscoveredModels, getHarnessDiscoveredModels } from "./agent-discovery.ts";
import { listAgentCapabilities } from "./commands.ts";
import { refreshHarnessModels } from "./model-discovery.ts";
import {
  BUNDLE_MAX_BYTES,
  buildBundle,
  numberedFileName,
  parseBundleText,
  type BundleExportResponse,
  type BundleParseErrorCode,
  type BundleSelection,
  type ParsedBundle,
} from "../shared/bundle.ts";
import {
  planBundleImport,
  type BundleImportOptions,
  type BundleImportPlan,
  type BundleImportResponse,
  type BundleLocalHarness,
  type BundleLocalState,
} from "../shared/bundle-import.ts";
import { AGENT_OPTIONS } from "../shared/types.ts";
import type { AgentKind, AgentProfile, Harness, HarnessStatus, Pipeline, PipelineGraph } from "../shared/types.ts";

const AGENT_KINDS = Object.keys(AGENT_OPTIONS) as AgentKind[];

export { BUNDLE_MAX_REQUEST_BYTES } from "../shared/bundle.ts";

/** Most ids one export request may name. */
const SELECTION_MAX_IDS = 1000;
/** Most entries in one import-options map. */
const OPTION_MAP_MAX_ENTRIES = 1000;
/** Highest `name (n).agetor.json` tried before giving up. */
const MAX_FILE_NUMBER = 999;

/** Every harness this machine can bind to, including a built-in that has no
 *  database row (read as enabled, the way `harnesses.getByIdOrKind`
 *  synthesizes it). */
export function allLocalHarnesses(): Harness[] {
  const rows = harnesses.list();
  const ids = new Set(rows.map((h) => h.id));
  for (const kind of AGENT_KINDS) {
    if (ids.has(kind)) continue;
    const synthetic = harnesses.getByIdOrKind(kind);
    if (synthetic) rows.push(synthetic);
  }
  return rows;
}

// ── Request validation ─────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function idList(raw: unknown, what: string): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.length === 0)) {
    return { error: `${what} must be an array of ids` };
  }
  if (raw.length > SELECTION_MAX_IDS) return { error: `${what} may name at most ${SELECTION_MAX_IDS} ids` };
  return raw as string[];
}

/** Validate `{ agentIds?, pipelineIds?, all? }` from an export request. */
export function parseBundleSelection(body: unknown): { selection: BundleSelection } | { error: string } {
  if (!isPlainObject(body)) return { error: "invalid body" };
  const agentIds = idList(body.agentIds, "agentIds");
  if ("error" in agentIds) return agentIds;
  const pipelineIds = idList(body.pipelineIds, "pipelineIds");
  if ("error" in pipelineIds) return pipelineIds;
  if (body.all !== undefined && typeof body.all !== "boolean") return { error: "all must be true or false" };
  const all = body.all === true;
  if (all && (agentIds.length > 0 || pipelineIds.length > 0)) {
    return { error: "all can't be combined with agentIds or pipelineIds" };
  }
  if (!all && agentIds.length === 0 && pipelineIds.length === 0) return { error: "nothing selected to export" };
  return { selection: { agentIds, pipelineIds, all } };
}

function stringRecord(
  raw: unknown,
  what: string,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) return { ok: false, error: `${what} must be an object of strings` };
  const entries = Object.entries(raw);
  if (entries.length > OPTION_MAP_MAX_ENTRIES) return { ok: false, error: `${what} has too many entries` };
  for (const [, v] of entries) {
    if (typeof v !== "string") return { ok: false, error: `${what} must be an object of strings` };
  }
  // `fromEntries` defines own properties, so a key such as "__proto__" (an
  // Agent key or harness id a file may carry) survives — an assignment would
  // hit the prototype setter and silently drop it.
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

/** Validate the `options` object of a preview/import request. */
export function parseBundleImportOptions(raw: unknown): { options: BundleImportOptions } | { error: string } {
  if (raw === undefined || raw === null) return { options: {} };
  if (!isPlainObject(raw)) return { error: "options must be an object" };
  const options: BundleImportOptions = {};
  for (const key of ["harnessMap", "agentHarness", "agentNames", "pipelineNames"] as const) {
    const parsed = stringRecord(raw[key], key);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.value) options[key] = parsed.value;
  }
  if (raw.singleName !== undefined && raw.singleName !== null) {
    if (typeof raw.singleName !== "string") return { error: "singleName must be a string" };
    options.singleName = raw.singleName;
  }
  const enable = raw.enableHarnesses;
  if (enable !== undefined && enable !== null) {
    if (enable === "all") options.enableHarnesses = "all";
    else if (Array.isArray(enable) && enable.every((x) => typeof x === "string") && enable.length <= OPTION_MAP_MAX_ENTRIES) {
      options.enableHarnesses = enable as string[];
    } else {
      return { error: 'enableHarnesses must be "all" or an array of harness ids' };
    }
  }
  return { options };
}

// ── Export ─────────────────────────────────────────────────────────────────

/** Build the export for a selection from the live database. */
export function exportBundleFor(
  selection: BundleSelection,
  now: Date = new Date(),
): ({ ok: true } & BundleExportResponse) | { ok: false; error: string } {
  const built = buildBundle({
    selection,
    profiles: agentProfiles.list(),
    pipelines: pipelines.list(),
    harnesses: allLocalHarnesses(),
    agetorVersion: pkg.version,
    now,
  });
  if (!built.ok) return built;
  return {
    ok: true,
    text: built.text,
    filename: built.filename,
    warnings: built.warnings,
    counts: { agents: built.bundle.agents.length, pipelines: built.bundle.pipelines.length },
  };
}

/** Where Save to Downloads writes: `AGETOR_DOWNLOADS_DIR` (test seam, wins
 *  whenever set) else `~/Downloads`. */
export function bundleDownloadsDir(): string {
  // Never trimmed, like every other path here (a folder name may end in a
  // space); only a blank value reads as unset.
  const seam = process.env.AGETOR_DOWNLOADS_DIR;
  return seam && seam.trim() ? seam : path.join(homedir(), "Downloads");
}

/**
 * Write `text` into `dir` as `filename`, never overwriting: the file is
 * created exclusively and, when the name is taken, numbered
 * `name (2).agetor.json`, `name (3)…` up to 999 (a symlink at the name counts
 * as taken — exclusive creation never follows it). Creates `dir` when
 * missing only with `createDir` (Downloads); a picked folder must exist, so a
 * mangled pick can never create a stray directory. `filename` must be a bare
 * name this side derived.
 */
export function writeBundleFile(
  dir: string,
  filename: string,
  text: string,
  opts: { createDir?: boolean } = {},
): { path: string; filename: string } {
  if (path.basename(filename) !== filename || filename === "." || filename === "..") {
    throw new Error("invalid export file name");
  }
  if (opts.createDir) mkdirSync(dir, { recursive: true });
  else if (!isDirectory(dir)) throw new Error(`${dir} is not a folder`);
  for (let n = 1; n <= MAX_FILE_NUMBER; n++) {
    const name = numberedFileName(filename, n);
    const target = path.join(dir, name);
    try {
      writeFileSync(target, text, { flag: "wx" });
      return { path: target, filename: name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`${dir} already has ${MAX_FILE_NUMBER} files named like ${filename}`);
}

/**
 * The message for an export that couldn't be written. A permission error
 * (EPERM/EACCES) is almost always macOS privacy: Agetor isn't allowed into
 * Downloads (or the picked folder) — so say where to allow it and what
 * works without it, instead of a bare errno.
 */
export function bundleSaveErrorMessage(err: unknown, target: "downloads" | "folder", dir: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EPERM" || code === "EACCES") {
    const where = target === "downloads" ? "your Downloads folder" : dir;
    const settings =
      target === "downloads"
        ? "System Settings → Privacy & Security → Files and Folders"
        : "System Settings → Privacy & Security";
    return `couldn't save the export: macOS didn't allow Agetor to write to ${where} — allow it in ${settings}, or use Copy JSON${target === "downloads" ? " or Choose folder" : ""} instead`;
  }
  // Creating Downloads (or AGETOR_DOWNLOADS_DIR) when a file, or a dangling
  // symlink, sits at its path or above it: `writeBundleFile` numbers past a
  // taken file name itself, so these only come from the folder.
  if (code === "EEXIST") return `couldn't save the export: ${dir} exists but isn't a folder`;
  if (code === "ENOTDIR") return `couldn't save the export: part of ${dir} isn't a folder`;
  return `couldn't save the export: ${err instanceof Error ? err.message : String(err)}`;
}

/** The test seam directory shared with `/refs/pick` (`e2e/fixtures.ts`). */
export function fakePickDir(): string | null {
  return process.env.AGETOR_FAKE_PICK_REFS_DIR?.trim() || null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** First `*.json` file (name order) in the fake-pick seam directory, or null. */
export function fakePickedJsonFile(dir: string): string | null {
  try {
    const first = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))[0];
    return first ? path.join(dir, first) : null;
  } catch {
    return null;
  }
}

/** The fake-pick seam directory for a folder pick, or null when it isn't a
 *  directory (a cancelled pick). */
export function fakePickedFolder(dir: string): string | null {
  return isDirectory(dir) ? dir : null;
}

/** Read a picked bundle file, refusing anything over the size cap. */
export function readPickedBundleFile(file: string): { text: string; filename: string } | { error: string } {
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { error: "the picked item is not a file" };
    size = st.size;
  } catch {
    return { error: "couldn't read the picked file" };
  }
  if (size > BUNDLE_MAX_BYTES) {
    return { error: `file is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB` };
  }
  try {
    return { text: readFileSync(file, "utf8"), filename: path.basename(file) };
  } catch {
    return { error: "couldn't read the picked file" };
  }
}

// ── Local state for the planner ────────────────────────────────────────────

/** How long a harness probe (status + user-level skills) is reused across
 *  preview requests — the import dialog re-previews on every option change. */
const PROBE_TTL_MS = 5000;

interface HarnessProbe {
  status: HarnessStatus | null;
  skills: string[] | null;
}

const probeCache = new Map<string, { at: number; probe: Promise<HarnessProbe> }>();

function probeKey(h: Harness): string {
  return JSON.stringify([h.id, h.kind, h.home, h.bin, h.env]);
}

/** User-level skills for kinds whose discovery implements them (claude-code
 *  and codex today, `commands.ts`); null when it can't tell. */
async function userLevelSkills(h: Harness): Promise<string[] | null> {
  if (h.kind !== "claude-code" && h.kind !== "codex") return null;
  try {
    const caps = await listAgentCapabilities({
      agent: h.kind,
      workdir: null,
      harnessHome: h.home,
      harnessEnv: h.env,
    });
    return caps.extensions.filter((e) => e.kind === "skill").map((e) => e.name);
  } catch {
    return null;
  }
}

function probeHarness(h: Harness): Promise<HarnessProbe> {
  const key = probeKey(h);
  const now = Date.now();
  const cached = probeCache.get(key);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.probe;
  const probe = Promise.all([checkHarness(h).catch(() => null), userLevelSkills(h)]).then(([status, skills]) => ({
    status,
    skills,
  }));
  probeCache.set(key, { at: now, probe });
  for (const [k, v] of probeCache) {
    if (now - v.at >= PROBE_TTL_MS) probeCache.delete(k);
  }
  return probe;
}

/** Model ids known for a harness (K14): its discovered catalog plus the
 *  curated rows; `catalogOnly` rows count only while discovery is empty.
 *  A logged-out harness (`loggedIn === false`) distrusts its catalog, as
 *  `mergeModelOptions`' rule 7 does for the pickers — an expired login's
 *  passive discovery reads back a catalog the account can't run — and
 *  knows exactly what its pickers would offer: the non-gated curated rows. */
function knownModelsFor(h: Harness, loggedIn: boolean | null): string[] {
  const curated = AGENT_OPTIONS[h.kind]?.models ?? [];
  if (loggedIn === false) return curated.filter((m) => !m.catalogOnly).map((m) => m.id);
  // Same per-harness/per-kind split as `model-discovery.ts`'s
  // `modelsForHarness`: only fx and codex catalogs vary per harness.
  const discovered = h.kind === "fx" || h.kind === "codex" ? getHarnessDiscoveredModels(h.id) : getDiscoveredModels(h.kind);
  const known = new Set(discovered.map((m) => m.id));
  for (const m of curated) {
    if (!m.catalogOnly || discovered.length === 0) known.add(m.id);
  }
  return [...known];
}

/** Harnesses whose status the planner may report on for this file: the ones
 *  of a kind the file uses, or every harness when the file has a kind this
 *  build doesn't know (it may be re-bound anywhere). */
function relevantHarnesses(rows: Harness[], parsed: ParsedBundle): Harness[] {
  const kinds = new Set(parsed.agents.map((a) => a.harness.kind));
  if ([...kinds].some((k) => !(AGENT_KINDS as string[]).includes(k))) return rows;
  return rows.filter((h) => kinds.has(h.kind));
}

type ProbeMap = Map<string, HarnessProbe>;

async function probeRelevant(parsed: ParsedBundle): Promise<ProbeMap> {
  const relevant = relevantHarnesses(allLocalHarnesses(), parsed);
  const probes = await Promise.all(relevant.map((h) => probeHarness(h)));
  return new Map(relevant.map((h, i) => [h.id, probes[i]!] as const));
}

/** The synchronous half of the local state, read fresh from the database —
 *  run again inside the import transaction. */
function localStateFrom(probes: ProbeMap): BundleLocalState {
  const rows = allLocalHarnesses();
  const local: BundleLocalHarness[] = rows.map((h) => {
    const status = probes.get(h.id)?.status ?? null;
    return {
      id: h.id,
      kind: h.kind,
      label: h.label,
      isBuiltin: h.isBuiltin,
      enabled: h.enabled,
      available: status ? status.available : null,
      loggedIn: status ? status.loggedIn : null,
      reason: status?.reason ?? null,
      installHint: status?.installHint ?? null,
    };
  });
  const profiles = agentProfiles.list();
  const knownModels: Record<string, string[] | null> = {};
  const knownSkills: Record<string, string[] | null> = {};
  for (const h of rows) {
    knownModels[h.id] = knownModelsFor(h, probes.get(h.id)?.status?.loggedIn ?? null);
    knownSkills[h.id] = probes.get(h.id)?.skills ?? null;
  }
  return {
    harnesses: local,
    knownKinds: [...AGENT_KINDS],
    agentNames: profiles.map((p) => p.name),
    pipelineNames: pipelines.list().map((p) => p.name),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    knownModels,
    knownSkills,
  };
}

/** Everything the planner needs about this machine (K5/K14). */
export async function gatherBundleLocalState(parsed: ParsedBundle): Promise<BundleLocalState> {
  return localStateFrom(await probeRelevant(parsed));
}

// ── Preview and commit ─────────────────────────────────────────────────────

export type BundleImportError =
  | { ok: false; status: 400; error: string; code: BundleParseErrorCode }
  | { ok: false; status: 409; error: string; plan: BundleImportPlan };

/** Dry run: parse and plan, writing nothing. */
export async function previewBundleImport(
  text: string,
  options: BundleImportOptions,
): Promise<{ ok: true; plan: BundleImportPlan } | BundleImportError> {
  const parsed = parseBundleText(text);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, code: parsed.code };
  const local = await gatherBundleLocalState(parsed.bundle);
  return { ok: true, plan: planBundleImport(parsed.bundle, local, options) };
}

class BundleImportBlocked extends Error {
  constructor(readonly plan: BundleImportPlan) {
    super(plan.blocking[0]?.message ?? "the import has blocking issues");
  }
}

class BundleImportChanged extends Error {
  constructor(readonly plan: BundleImportPlan) {
    super("the import changed since the preview — review the new preview and import again");
  }
}

/** Swap a bundle graph's Agent keys for the ids the import just created. */
function graphWithIds(graph: PipelineGraph, idByKey: Map<string, string>): PipelineGraph {
  return {
    ...graph,
    steps: graph.steps.map((step) => ({
      ...step,
      agentProfileId: step.agentProfileId === null ? null : (idByKey.get(step.agentProfileId) ?? null),
      subagents: {
        ...step.subagents,
        profileIds: step.subagents.profileIds
          .map((key) => idByKey.get(key))
          .filter((id): id is string => typeof id === "string"),
      },
    })),
  };
}

/**
 * Commit an import (K13). The async state (harness status, skills) is
 * gathered first; then, inside one database transaction, names and harness
 * rows are re-read, the plan is rebuilt, and — only if nothing is blocking —
 * harnesses are enabled, Agents inserted, graphs rewritten to the new ids and
 * Pipelines inserted. Any throw rolls everything back. A name clash that
 * slipped past the plan surfaces as a 409 with a fresh plan, and so does a
 * re-plan whose fingerprint differs from `expectedFingerprint` (the one the
 * client previewed and the user confirmed) — this machine changed in
 * between, so the import would create something other than what was shown.
 * Without `expectedFingerprint` (an older client) the re-plan is trusted.
 */
export async function commitBundleImport(
  text: string,
  options: BundleImportOptions,
  expectedFingerprint?: string,
): Promise<{ ok: true; result: BundleImportResponse } | BundleImportError> {
  const parsed = parseBundleText(text);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error, code: parsed.code };
  const probes = await probeRelevant(parsed.bundle);

  const run = db.transaction((): BundleImportResponse => {
    const plan = planBundleImport(parsed.bundle, localStateFrom(probes), options);
    if (!plan.canImport) throw new BundleImportBlocked(plan);
    if (expectedFingerprint !== undefined && plan.fingerprint !== expectedFingerprint) {
      throw new BundleImportChanged(plan);
    }

    const enabledHarnesses: string[] = [];
    for (const h of plan.harnesses) {
      if (!h.willEnable || !harnesses.get(h.id)) continue;
      harnesses.setEnabled(h.id, true);
      enabledHarnesses.push(h.id);
    }

    const created: AgentProfile[] = [];
    const idByKey = new Map<string, string>();
    for (const a of plan.agents) {
      const profile = agentProfiles.insert({
        name: a.name,
        harness: a.harnessId!,
        model: a.model,
        effort: a.effort,
        mode: a.mode,
        fast: a.fast,
        maxMode: a.maxMode,
        instructions: a.instructions,
        skills: a.skills,
      });
      idByKey.set(a.key, profile.id);
      created.push(profile);
    }

    const createdPipelines: Pipeline[] = [];
    for (const p of plan.pipelines) {
      createdPipelines.push(
        pipelines.insert({
          name: p.name,
          description: p.description,
          graph: plan.legacy ? p.graph : graphWithIds(p.graph, idByKey),
          ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
        }),
      );
    }

    return { agents: created, pipelines: createdPipelines, enabledHarnesses, warnings: plan.warnings, plan };
  });

  let result: BundleImportResponse;
  try {
    result = run();
  } catch (err) {
    if (err instanceof BundleImportBlocked || err instanceof BundleImportChanged) {
      return { ok: false, status: 409, error: err.message, plan: err.plan };
    }
    if (err instanceof AgentProfileNameError || err instanceof PipelineNameError) {
      const plan = planBundleImport(parsed.bundle, localStateFrom(probes), options);
      return { ok: false, status: 409, error: `${err.message} — preview the import again`, plan };
    }
    throw err;
  }

  // Same post-enable catalog refresh `PATCH /harnesses/:id` triggers.
  for (const id of result.enabledHarnesses) void refreshHarnessModels(id).catch(() => {});
  return { ok: true, result };
}
