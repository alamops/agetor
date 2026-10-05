/**
 * Pure helpers behind the Agents/Pipelines export and import dialogs
 * (docs/plans/agents-pipelines-import-export.md, T4): the import dialog's
 * option state and its reducer, the summary/toast strings, and the `.json`
 * pick from a dropped `FileList`. No React, no DOM beyond the `File` type —
 * unit-tested in `bundle.test.ts`.
 */
import { BUNDLE_MAX_BYTES, BUNDLE_MAX_REQUEST_BYTES } from "../../shared/bundle.ts";
import { ApiTransitError, ApiUnreachableError } from "./net-retry.ts";
import type {
  BundleImportOptions,
  BundleImportPlan,
  BundleImportResponse,
  BundleLocalHarness,
  PlannedAgent,
} from "../../shared/bundle-import.ts";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * What a failed bundle request says to the user. A request that got no HTTP
 * answer carries net-retry's developer-facing text (the URL, "NOT retried",
 * "restart `bun run dev`"), so it is worded by what happened instead; any
 * other error (the core's own answer) keeps its message.
 */
export function requestFailureText(e: unknown): string {
  if (e instanceof ApiUnreachableError) return "agetor's core isn't answering";
  if (e instanceof ApiTransitError) return "The connection to agetor's core dropped before it answered";
  return e instanceof Error ? e.message : String(e);
}

/**
 * What an import whose answer never arrived says while the refreshed preview
 * is on its way: the request reached the core (it isn't retried), so it may
 * have committed. The re-preview settles it — see `lostImportVerdictText`.
 * Shown after `importErrorPrefix("unknown")` ("Import may have run:"), so it
 * doesn't repeat that.
 */
export function lostImportText(e: unknown): string {
  return `${requestFailureText(e)}. Checking it against a refreshed preview…`;
}

/**
 * Whether a lost import ran, judged by a preview of the same options that
 * landed afterwards. The confirmed plan was importable (Confirm requires
 * it), and a landed import takes every name it created, so the re-plan
 * either renames them — a different fingerprint — or, for a name the user
 * typed (which is never suffixed), keeps the name and blocks it as
 * `name-in-use`. `planFingerprint` hashes the names, not whether the plan
 * can import, so that second case keeps the confirmed fingerprint: a plan
 * that can no longer import counts as "ran" too. Only an importable re-plan
 * with the confirmed fingerprint proves nothing was created.
 */
export function lostImportLanded(
  confirmedFingerprint: string,
  next: Pick<BundleImportPlan, "canImport"> & { fingerprint: string },
): boolean {
  return next.fingerprint !== confirmedFingerprint || !next.canImport;
}

/**
 * The verdict on a lost import, once a preview of the same options lands
 * (`lostImportLanded`). "Ran" is worded as "most likely" — something else
 * on this machine may have changed meanwhile, so it says to look rather
 * than claim it outright; "didn't run" is proven by an identical,
 * still-importable plan.
 */
export function lostImportVerdictText(cause: string, landed: boolean): string {
  return landed
    ? `${cause}, and the refreshed preview no longer matches the one you confirmed (the names it would create are now taken). Check your Agents and Pipelines before importing again.`
    : `${cause}, but the refreshed preview matches the one you confirmed. It's safe to import again.`;
}

/**
 * What a lost import says when its verdict can no longer be given: the
 * options changed before a preview of the confirmed ones landed, so there
 * is nothing to compare against. It may have run, so it says where to look.
 */
export function lostImportUnsettledText(cause: string): string {
  return `${cause}, and the options changed before a refreshed preview could tell whether it ran. Check your Agents and Pipelines before importing again.`;
}

/**
 * The toast description when the dialog is left (closed, another file
 * loaded, the page navigated away) while a lost import's verdict is still
 * pending: nothing will say whether it ran, so it says where to look — the
 * same advice as an import whose answer is lost after the dialog closed.
 */
export function lostImportLeftText(cause: string): string {
  return `${cause}, so the import may already have run — check your Agents and Pipelines before importing the file again.`;
}

/**
 * The toast description for a 409 that lands after the import dialog closed.
 * The core's own message ("review the new preview…") points at a preview that
 * no longer exists, so the copy is picked from the 409's plan — except when
 * that plan is still importable and identical to the confirmed one
 * (`sentFingerprint`): nothing changed to review, so "something changed"
 * would be false and the core's own reason (`message`) is shown instead,
 * matching what the open dialog shows for the same answer.
 */
export function lateImportConflictText(
  plan: Pick<BundleImportPlan, "canImport"> & { fingerprint?: string } | null | undefined,
  sent?: { fingerprint: string; message: string },
): string {
  if (plan?.canImport === false) return "The import is blocked. Open Import again to see why.";
  if (sent && plan?.canImport && plan.fingerprint === sent.fingerprint) return lateImportErrorText(sent.message);
  return "Something on this machine changed since the preview, so the import changed. Open Import again to review it.";
}

const IMPORT_FAILED_PREFIX = "import failed — nothing was imported: ";

/**
 * The toast description for an import the core refused with an error answer
 * after the dialog closed. The toast's title already says "Nothing was
 * imported", so the route's own `import failed — nothing was imported:`
 * prefix is dropped rather than repeated.
 */
export function lateImportErrorText(message: string): string {
  const detail = message.startsWith(IMPORT_FAILED_PREFIX) ? message.slice(IMPORT_FAILED_PREFIX.length) : message;
  return `${detail.replace(/[.\s]+$/, "")}. Open Import again to retry.`;
}

/**
 * The error text for an import the core refused with an error answer while
 * the dialog is open: it writes in one transaction, so nothing was imported.
 * The route's own lowercase `import failed — nothing was imported:` prefix is
 * replaced, so the box — and the live region, which adds no lead-in of its
 * own to this text (see `importStatusText`) — says "Nothing was imported"
 * exactly once.
 */
export function importRefusalText(message: string): string {
  const detail = message.startsWith(IMPORT_FAILED_PREFIX) ? message.slice(IMPORT_FAILED_PREFIX.length) : message;
  return NOTHING_IMPORTED_RE.test(detail) ? detail : `Nothing was imported: ${detail}`;
}
const NOTHING_IMPORTED_RE = /^nothing was imported\b/i;

/**
 * The accessible name of one preview row's field — `Name: Agent "X" (2 of 3)`.
 * Every row's field reads "Name"/"Harness", so it says whose, field word
 * first. The file's names may repeat (only keys must be unique), so the row's
 * position is added whenever there is more than one row.
 */
export function rowFieldLabel(
  field: "Name" | "Harness",
  kind: "Agent" | "Pipeline",
  sourceName: string,
  index: number,
  total: number,
): string {
  const base = `${field}: ${kind} "${sourceName}"`;
  return total > 1 ? `${base} (${index + 1} of ${total})` : base;
}

/** "2 Agents, 1 Pipeline" — or "nothing" for an empty count. */
export function countsSummary(counts: { agents: number; pipelines: number }): string {
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(plural(counts.agents, "Agent"));
  if (counts.pipelines > 0) parts.push(plural(counts.pipelines, "Pipeline"));
  return parts.join(", ") || "nothing";
}

/** Toast title after a successful import. */
export function importSuccessText(result: Pick<BundleImportResponse, "agents" | "pipelines">): string {
  return `Imported ${countsSummary({ agents: result.agents.length, pipelines: result.pipelines.length })}`;
}

// ── import options ─────────────────────────────────────────────────────────

/** What the user changed in the import preview. Names are kept as typed
 *  (a cleared field is "" — it falls back to the automatic name). */
export interface ImportOptionsState {
  agentNames: Record<string, string>;
  pipelineNames: Record<string, string>;
  agentHarness: Record<string, string>;
  enableHarnesses: string[];
}

export const EMPTY_IMPORT_OPTIONS: ImportOptionsState = {
  agentNames: {},
  pipelineNames: {},
  agentHarness: {},
  enableHarnesses: [],
};

export type ImportOptionsAction =
  | { type: "agent-name"; key: string; name: string }
  | { type: "pipeline-name"; index: number; name: string }
  /** `harnessId: null` drops the override (the planner picks again). */
  | { type: "agent-harness"; key: string; harnessId: string | null }
  | { type: "enable-harness"; harnessId: string; enabled: boolean }
  | { type: "reset" };

export function importOptionsReducer(state: ImportOptionsState, action: ImportOptionsAction): ImportOptionsState {
  switch (action.type) {
    case "agent-name":
      return { ...state, agentNames: { ...state.agentNames, [action.key]: action.name } };
    case "pipeline-name":
      return { ...state, pipelineNames: { ...state.pipelineNames, [String(action.index)]: action.name } };
    case "agent-harness": {
      if (action.harnessId !== null) {
        return { ...state, agentHarness: { ...state.agentHarness, [action.key]: action.harnessId } };
      }
      if (!Object.hasOwn(state.agentHarness, action.key)) return state;
      // Rebuilt rather than `delete`d: keys come from the file ("__proto__").
      const rest = Object.fromEntries(Object.entries(state.agentHarness).filter(([k]) => k !== action.key));
      return { ...state, agentHarness: rest };
    }
    case "enable-harness": {
      const rest = state.enableHarnesses.filter((id) => id !== action.harnessId);
      return { ...state, enableHarnesses: action.enabled ? [...rest, action.harnessId] : rest };
    }
    case "reset":
      return EMPTY_IMPORT_OPTIONS;
  }
}

/**
 * `map[key]` when `map` holds `key` itself, else undefined. Agent keys come
 * from the file (an Agent named "Constructor" gets the key "constructor", a
 * hand-made file can use "__proto__"), so a plain index would read an
 * Object.prototype member instead of "nothing typed".
 */
export function ownOption(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function nonBlank(map: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(map)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The wire options for a preview/import request; blank names are left out
 *  (the planner then uses the automatic name). */
export function toImportOptions(state: ImportOptionsState): BundleImportOptions {
  const options: BundleImportOptions = {};
  const agentNames = nonBlank(state.agentNames);
  const pipelineNames = nonBlank(state.pipelineNames);
  if (agentNames) options.agentNames = agentNames;
  if (pipelineNames) options.pipelineNames = pipelineNames;
  if (Object.keys(state.agentHarness).length > 0) options.agentHarness = { ...state.agentHarness };
  if (state.enableHarnesses.length > 0) options.enableHarnesses = [...state.enableHarnesses];
  return options;
}

/** True once the options differ from the defaults — closing then asks to
 *  discard. A name typed and cleared again is no change (it's left out of
 *  the request, like an untouched one). */
export function importOptionsEdited(state: ImportOptionsState): boolean {
  return Object.keys(toImportOptions(state)).length > 0;
}

/** UTF-8 byte length of `text`, without encoding it when `text.length`
 *  already decides against `limit` (each UTF-16 unit is 1..3 bytes). */
function utf8Bytes(text: string, limit: number): number {
  if (text.length > limit || text.length * 3 <= limit) return text.length;
  return new TextEncoder().encode(text).length;
}

/** Request bytes `bundleTextTooLarge` keeps free for the import options and
 *  `planFingerprint` that ride beside the text once the user edits the
 *  preview — the 64 KB the server's request cap adds on top of the text. */
export const BUNDLE_OPTIONS_HEADROOM_BYTES = 64 * 1024;

const mb = (bytes: number, decimals = 1): string => {
  const scale = 10 ** decimals;
  return `${Math.round((bytes / (1024 * 1024)) * scale) / scale} MB`;
};

/**
 * The size of the preview request `api.previewBundleImport` sends for
 * `text` — the same `JSON.stringify({ text, options })` body, in UTF-8
 * bytes. JSON escaping can make it far larger than the text: a control
 * character becomes a six-byte `\u00XX` escape.
 */
export function bundleRequestBytes(text: string, options: BundleImportOptions = {}): number {
  return new TextEncoder().encode(JSON.stringify({ text, options })).length;
}

/**
 * Why bundle `text` can't be sent for a preview, or null. `what` names it in
 * the message ("The pasted JSON", `"x.agetor.json"`). Two checks, both
 * before any request (the server refuses an oversized body by its length,
 * early, and its 413 can't tell the two apart): the text itself over the
 * 2 MB import cap, counted in UTF-8 bytes like the server counts it; and
 * the request body over the server's request cap once the text is escaped
 * as JSON — a file under 2 MB full of control characters can still be too
 * large to send. An empty (or blank) text is refused too: a dropped or
 * picked 0-byte file would otherwise open nothing at all.
 */
export function bundleTextTooLarge(text: string, what: string): string | null {
  if (text.trim() === "") return `${what} is empty.`;
  if (utf8Bytes(text, BUNDLE_MAX_BYTES) > BUNDLE_MAX_BYTES) {
    return `${what} is too large — the limit is ${mb(BUNDLE_MAX_BYTES)}.`;
  }
  // The body is measured with empty options, so leave room for the ones the
  // user adds later (names, harness picks) and the import's fingerprint: a
  // text that only just fits would preview and then fail once edited.
  const budget = BUNDLE_MAX_REQUEST_BYTES - BUNDLE_OPTIONS_HEADROOM_BYTES;
  // The text alone can't reach the budget: only escaping can.
  if (text.length * 6 + 1024 <= budget) return null;
  const body = bundleRequestBytes(text);
  if (body <= budget) return null;
  // Name the budget actually enforced. A body just over it rounds to the
  // same figure ("4 MB, over the 4 MB limit"), so show more decimals, and
  // past that say "just over" rather than print two equal numbers.
  const limit = mb(budget);
  const size = mb(body) !== limit ? mb(body) : mb(body, 2) !== mb(budget, 2) ? mb(body, 2) : null;
  const comesTo = size ? `${size}, over the ${limit} limit for sending` : `just over the ${limit} limit for sending`;
  return `${what} is too large to send: escaped for sending it comes to ${comesTo} — it likely holds many control characters.`;
}

/** Why pasted text can't be previewed, or null (`bundleTextTooLarge`). */
export function pastedBundleTooLarge(text: string): string | null {
  return bundleTextTooLarge(text, "The pasted JSON");
}

/**
 * The harness the planner picks for each Agent on its own (no override):
 * `prev` updated from `plan`'s Agents whose resolution is the planner's own
 * (`exact`, `fallback`, or `unresolved` → null). An Agent with an override
 * (`mapped`/`rebound`) keeps its earlier entry. Picking this harness again
 * in the select drops the override instead of pinning it.
 */
export function autoHarnessIds(
  prev: Readonly<Record<string, string | null>>,
  plan: Pick<BundleImportPlan, "agents">,
): Record<string, string | null> {
  const next: Record<string, string | null> = { ...prev };
  let changed = false;
  for (const agent of plan.agents) {
    if (agent.resolution !== "exact" && agent.resolution !== "fallback" && agent.resolution !== "unresolved") continue;
    if (Object.hasOwn(next, agent.key) && next[agent.key] === agent.harnessId) continue;
    // defineProperty, not assignment: a "__proto__" key must stay an own key.
    Object.defineProperty(next, agent.key, { value: agent.harnessId, enumerable: true, writable: true, configurable: true });
    changed = true;
  }
  return changed ? next : (prev as Record<string, string | null>);
}

/** The harnesses an Agent's harness select offers, in local order. */
export function harnessChoices(agent: PlannedAgent, plan: Pick<BundleImportPlan, "localHarnesses">): BundleLocalHarness[] {
  const allowed = new Set(agent.candidateHarnessIds);
  return plan.localHarnesses.filter((h) => allowed.has(h.id));
}

/** A harness's select-option text: label, id when it differs, and status. */
export function harnessOptionLabel(h: BundleLocalHarness): string {
  const name = h.label && h.label !== h.id ? `${h.label} (${h.id})` : h.id;
  return h.enabled ? name : `${name} — disabled`;
}

/**
 * What is known about an import whose answer was lost: still being checked
 * (or past checking — `unknown`), most likely ran, or proven not to have
 * run. A failure that isn't a lost answer carries none.
 */
export type LostImportOutcome = "unknown" | "ran" | "not-run";

/** The lead-in for an import failure in the live region, and — for a lost
 *  answer — in the error box too (`importErrorText`). A lost answer isn't
 *  announced as "failed": the import may well have run. */
export function importErrorPrefix(outcome: LostImportOutcome | undefined): string {
  switch (outcome) {
    case "unknown":
      return "Import may have run:";
    case "ran":
      return "Import most likely ran:";
    case "not-run":
      return "Import didn't run:";
    default:
      return "Import failed:";
  }
}

/** What the error box shows for an import failure. A lost answer's message
 *  is the detail after its lead-in ("Import most likely ran: …"), so the box
 *  shows both; any other failure's message stands alone. */
export function importErrorText(err: { message: string; outcome?: LostImportOutcome }): string {
  return err.outcome ? `${importErrorPrefix(err.outcome)} ${err.message}` : err.message;
}

/** The live-region text: what a screen reader user would otherwise only see.
 *  A re-preview after an option edit keeps the last plan's text, so typing a
 *  name announces only what changes the outcome (e.g. a new blocking issue),
 *  not every debounced request. An import error that stays up across edits
 *  (a "most likely ran" verdict, an unsettled one) carries the current plan's
 *  summary after it, so later outcome changes are still announced; a pending
 *  verdict doesn't, since the plan on screen is out of date until it lands. */
export function importStatusText(s: {
  showPreview: boolean;
  pasteError: string | null;
  plan: Pick<BundleImportPlan, "agents" | "pipelines" | "blocking"> | null;
  planChanged: boolean;
  previewing: boolean;
  previewError: { message: string } | null;
  importing: boolean;
  importError: { message: string; outcome?: LostImportOutcome; lost?: unknown } | null;
}): string {
  if (!s.showPreview) return s.pasteError ?? "";
  if (s.importing) return "Importing…";
  // A failed preview is announced even over an import error: Confirm waits
  // on it (the plan is out of date), so it is the news. A lost import's
  // verdict was riding on that preview, so say it is still unknown.
  if (s.previewError) {
    const failed = `Preview failed: ${s.previewError.message}`;
    return s.importError?.lost !== undefined
      ? `${failed}. Whether the import ran is still unknown — retry the preview to find out.`
      : failed;
  }
  const outcome = s.plan ? planOutcomeText(s.plan) : null;
  if (s.importError) {
    // A refusal already says "Nothing was imported" (`importRefusalText`);
    // "Import failed: Nothing was imported: …" would say it twice.
    const error = s.importError.outcome
      ? importErrorText(s.importError)
      : NOTHING_IMPORTED_RE.test(s.importError.message)
        ? s.importError.message
        : `${importErrorPrefix(undefined)} ${s.importError.message}`;
    if (!outcome || s.importError.lost !== undefined) return error;
    return `${/[.!?…]$/.test(error) ? error : `${error}.`} Current plan: ${outcome}`;
  }
  if (!outcome) return s.previewing ? "Reading the file…" : "";
  return s.planChanged
    ? `Nothing was imported: the import changed since the preview. Updated plan: ${outcome}`
    : `Preview ready: ${outcome}`;
}

/** "1 Agent, ready to import" / "1 Agent, 2 blocking issues". */
function planOutcomeText(plan: Pick<BundleImportPlan, "agents" | "pipelines" | "blocking">): string {
  const what = countsSummary({ agents: plan.agents.length, pipelines: plan.pipelines.length });
  const blocking = plan.blocking.length;
  return blocking > 0 ? `${what}, ${blocking} blocking issue${blocking === 1 ? "" : "s"}` : `${what}, ready to import`;
}

/** The footer note while a failed re-preview leaves the plan on screen out
 *  of date. Only a retryable failure gets a Retry button, so only then does
 *  the note point at it; a refused request (400/413) fails the same way
 *  again, and only other options can get past it. */
export function previewOutdatedNote(previewError: { retryable: boolean }): string {
  return previewError.retryable
    ? "The preview is out of date — retry it to import"
    : "The preview is out of date — change the options to import";
}

// ── list selection ─────────────────────────────────────────────────────────

/** A list's selection once its rows are `ids`: a selected row that left the
 *  list (deleted elsewhere) leaves the selection. The same set comes back
 *  when nothing left it, so a state update bails out. */
export function pruneSelection(prev: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (prev.size === 0) return prev;
  const live = new Set(ids);
  const kept = [...prev].filter((id) => live.has(id));
  return kept.length === prev.size ? prev : new Set(kept);
}

// ── dropped files ──────────────────────────────────────────────────────────

/** Whether a drag carries files (and so may be a bundle drop). */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

/**
 * The `.json` file a drop should import: exactly one file, refused when
 * several were dropped (rather than silently importing only one of them),
 * when it isn't `.json`, or when it is over the size cap. The text's own
 * request-size check (`bundleTextTooLarge`) runs once it has been read.
 */
export function pickBundleDropFile(files: ArrayLike<File> | null | undefined): { file: File } | { error: string } {
  const list = files ? Array.from(files) : [];
  const file = list[0];
  if (!file) return { error: "Drop a .json bundle file to import it." };
  if (list.length > 1) return { error: `Drop one file at a time — ${list.length} files were dropped.` };
  if (!file.name.toLowerCase().endsWith(".json")) {
    return { error: `"${file.name}" isn't a .json file — drop an agetor bundle (.agetor.json).` };
  }
  if (file.size > BUNDLE_MAX_BYTES) {
    return { error: `"${file.name}" is too large — the limit is ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  return { file };
}
