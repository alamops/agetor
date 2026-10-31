/**
 * Commit an external OpenCode session as an in-place task and persist its
 * history onto a succeeded seed run (`docs/plans/add-opencode-harness.md`
 * D-13). The OpenCode counterpart of `claude-session-import.ts`, same rules:
 * the claim is the unique index on `tasks.imported_opencode_session_id`, the
 * claim is written before the seed run, and Send stays refused until the
 * backfill reaches `ready`.
 *
 * Unlike Claude there is no transcript to stream from an offset: OpenCode
 * keeps the session in its own database, so the history is ONE
 * `session export` (`opencode export` on v1), turned into run events by the
 * same `exportToEvents` the subagent tabs use, and written in cooperative
 * {@link IMPORT_SLICE_MS} slices so a long session can't hold the main thread.
 * Every event carries a stable line uuid, so a resumed backfill re-runs the
 * export and the `(run_id, line_uuid)` index skips what already landed.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  harnesses,
  IMPORTED_OPENCODE_HELD_ELSEWHERE,
  ImportedOpencodeSessionTaken,
  projects,
  runs,
  tasks,
  type AppendedEvent,
} from "./db.ts";
import { createTask, emitRunEvent } from "./orchestrator.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import { cachedCliVersion } from "./agent-status.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import {
  exportIsComplete,
  exportSummary,
  exportToEvents,
  runOpencodeExport,
  type OpencodeExport,
  type OpencodeExportSummary,
} from "./opencode-export.ts";
import {
  scanOpencodeSessionRecords,
  withinBusyWindow,
  type OpencodeSessionRecord,
} from "./opencode-session-scan.ts";
import { MISSING_FOLDER_IMPORT_ERROR } from "../shared/claude-session-meta.ts";
import { OPENCODE_DEFAULT_MODEL, opencodeMajor } from "../shared/opencode.ts";
import type { Harness, ImportedOpencodeSession, Run, RunEventStream, Task } from "../shared/types.ts";

const PROMPT_CAP_BYTES = 100 * 1024;
const TITLE_MAX_CHARS = 80;
/** Cooperative slice for the event writes, like the Claude replay. */
export const IMPORT_SLICE_MS = 20;
/** One import export may carry a long session; allow it more than a probe. */
const IMPORT_EXPORT_TIMEOUT_MS = 30_000;

/** Status line posted on the seed run when OpenCode never finished the
 *  session's last turn (an old unfinished session, A8c). */
export const OPENCODE_UNFINISHED_STATUS = "OpenCode reported this session unfinished";
/** Refusal for a session OpenCode reports unfinished that was updated within
 *  the busy window. */
export const OPENCODE_BUSY_IMPORT_ERROR =
  "OpenCode is still working on this session — wait for it to finish, then import";
const ALREADY_IMPORTED = "session is already imported";
const UNFINISHED_LINE_UUID = "opencode:import:unfinished";

export interface ImportOpencodeSessionsOptions {
  /** The OpenCode harness the new task runs under. Default: the harness
   *  whose `session list` reported the session. Refused for a harness that
   *  reads another OpenCode data dir: its `-s <id>` follow-ups couldn't see
   *  the session (v2 would silently start an empty one, spike Q4). */
  harnessId?: string;
  /**
   * Caller gate for the session's folder (D24): the server passes it for a
   * CLI-token caller, and it probes the folder in a disclaimed child, resolving
   * to a refusal message or `null` to allow. It runs BEFORE this module's first
   * in-process touch of the folder (the `isDirectory` check), once per session,
   * and a refusal is reported in that session's result. Omitted = no gate.
   */
  gateCwd?: (cwd: string) => Promise<string | null>;
  /** Test seam: the backfill waits here before writing events. */
  backfillGate?: Promise<void>;
  /** Slice length for the cooperative writes. Tests use `0` to yield per event. */
  sliceMs?: number;
}

export interface ImportOpencodeSessionResult {
  id: string;
  taskId?: string;
  error?: string;
}

const inflight = new Map<string, Promise<void>>();

/** In-process queue so two commits of one session id cannot both pass the
 *  "already imported" read. The unique index is the cross-process backstop;
 *  this queue keeps the loser from creating a task it would then delete. */
const commitChain = new Map<string, Promise<void>>();

function withCommitLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = commitChain.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail: Promise<void> = run.then(() => undefined, () => undefined);
  commitChain.set(sessionId, tail);
  void tail.finally(() => {
    if (commitChain.get(sessionId) === tail) commitChain.delete(sessionId);
  });
  return run;
}

function sessionAlreadyBound(sessionId: string): boolean {
  return tasks.findTaskByImportedOpencodeSession(sessionId) != null || runs.hasOpencodeSessionId(sessionId);
}

class ImportDeleted extends Error {
  constructor() { super("deleted"); }
}

function capPrompt(text: string): string {
  if (Buffer.byteLength(text) <= PROMPT_CAP_BYTES) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > PROMPT_CAP_BYTES) {
    const over = Buffer.byteLength(text.slice(0, end)) - PROMPT_CAP_BYTES;
    end -= Math.max(1, Math.ceil(over / 4));
  }
  return text.slice(0, Math.max(0, end));
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** A one-line title from the first user message, cut on a code point. */
function titleFromText(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length <= TITLE_MAX_CHARS ? line : `${chars.slice(0, TITLE_MAX_CHARS - 1).join("")}…`;
}

/** Title for the new task: OpenCode's own title, else the first user text,
 *  else a placeholder naming the session. */
export function opencodeImportTitle(sessionId: string, summary: OpencodeExportSummary, listedTitle: string | null): string {
  return summary.title?.trim()
    || listedTitle?.trim()
    || (summary.firstUserText ? titleFromText(summary.firstUserText) : null)
    || `OpenCode session ${sessionId.replace(/^ses_/, "").slice(0, 8)}`;
}

/**
 * The launch fields an imported session maps to (A8e): the session's
 * `providerID/id` model (the "OpenCode default" sentinel when it has none),
 * its variant as the effort unless `"default"` (else `auto`, "Model
 * default"), and `plan` mode when the last assistant ran the `plan` agent
 * (`build` and anything else → `auto`).
 */
export function opencodeImportLaunch(summary: OpencodeExportSummary): { model: string; effort: string; mode: string } {
  const model = summary.model ?? OPENCODE_DEFAULT_MODEL;
  const variant = summary.variant?.trim();
  const effort = summary.model && variant && variant !== "default" ? variant : "auto";
  return { model, effort, mode: summary.agent === "plan" ? "plan" : "auto" };
}

function importFailureMessage(err: unknown): string {
  if (err instanceof ImportedOpencodeSessionTaken) return IMPORTED_OPENCODE_HELD_ELSEWHERE;
  return err instanceof Error ? err.message : String(err);
}

function exportFailedMessage(sessionId: string): string {
  return `couldn't read OpenCode session ${sessionId} — \`opencode session export\` failed`;
}

function requireTask(taskId: string): ImportedOpencodeSession {
  const task = tasks.get(taskId);
  if (!task) throw new ImportDeleted();
  if (!task.importedOpencode) throw new Error("task lost its import record");
  return task.importedOpencode;
}

/** Mark an in-flight import failed. A row that does not hold the session
 *  claim is updated in the JSON only — writing the claim would throw on the
 *  unique index and leave the row `importing` forever. */
function failImport(taskId: string, message: string): void {
  const current = tasks.get(taskId);
  if (!current?.importedOpencode) return;
  const next: ImportedOpencodeSession = { ...current.importedOpencode, status: "failed", error: message };
  if (tasks.importedOpencodeSessionHeldElsewhere(taskId, next.sessionId)) {
    tasks.setImportedOpencode(taskId, next, { claim: false });
  } else {
    try {
      tasks.setImportedOpencode(taskId, next);
    } catch (err) {
      if (!(err instanceof ImportedOpencodeSessionTaken)) throw err;
      tasks.setImportedOpencode(taskId, next, { claim: false });
    }
  }
  // The webview's handler for this event only refetches tasks; the payload
  // carries no kind, so OpenCode imports share it.
  broadcastAppEvent({ type: "claude_session_import", taskId, status: "failed", ts: Date.now() });
}

function seedRun(task: Task, provenance: ImportedOpencodeSession, runId: string, now: number): Run {
  return {
    id: runId,
    taskId: task.id,
    agent: task.agent,
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    opencodeSessionId: provenance.sessionId,
    origin: "imported",
  };
}

/** Reattach or recreate the seed run of an import left `importing` (a crash
 *  between the claim and the seed insert). Provenance is written first, so
 *  this repair can always find the task. */
function ensureSeedRun(task: Task): string {
  const provenance = task.importedOpencode;
  if (!provenance) throw new Error("task lost its import record");
  if (task.runId && runs.get(task.runId)) return task.runId;
  const existing = runs.listForTask(task.id).find(
    (r) => r.origin === "imported" && r.opencodeSessionId === provenance.sessionId,
  );
  const runId = existing?.id ?? randomUUID();
  if (!existing) runs.insert(seedRun(task, provenance, runId, Date.now()));
  tasks.update(task.id, { runId, column: "review" });
  return runId;
}

/** The harness whose state holds the session: the one it was listed under,
 *  else the task's own harness. */
function exportHarnessFor(task: Task, provenance: ImportedOpencodeSession): Harness | null {
  const listed = harnesses.get(provenance.harnessId);
  if (listed?.kind === "opencode") return listed;
  const own = harnesses.getByIdOrKind(task.agent);
  return own?.kind === "opencode" ? own : null;
}

async function exportFor(task: Task, provenance: ImportedOpencodeSession): Promise<OpencodeExport> {
  const harness = exportHarnessFor(task, provenance);
  if (!harness) throw new Error(`OpenCode harness "${provenance.harnessId}" no longer exists`);
  const major = opencodeMajor(await cachedCliVersion(harness));
  const exp = await runOpencodeExport({
    sessionId: provenance.sessionId,
    bin: resolveBin(harness),
    env: harnessEnv(harness),
    cwd: provenance.directory,
    major,
    standalone: major === 2,
    timeoutMs: IMPORT_EXPORT_TIMEOUT_MS,
  });
  if (!exp) throw new Error(exportFailedMessage(provenance.sessionId));
  return exp;
}

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Write the export's events onto the seed run in cooperative slices. The
 *  task can be deleted mid-import; that is checked once per slice, and an
 *  insert that fails because the row is gone is the same stop. */
async function writeEvents(
  taskId: string,
  runId: string,
  events: ReadonlyArray<{ stream: RunEventStream; data: string; lineUuid: string }>,
  sliceMs: number,
): Promise<void> {
  if (!tasks.exists(taskId)) throw new ImportDeleted();
  let lastAssistant: number | null = null;
  const flushAssistant = () => {
    if (lastAssistant != null) {
      tasks.noteAssistantEvent(taskId, lastAssistant);
      lastAssistant = null;
    }
  };
  let sliceStart = performance.now();
  for (const ev of events) {
    let row: AppendedEvent | null;
    try {
      row = runs.appendEvent(runId, ev.stream, ev.data, ev.lineUuid, null);
    } catch (err) {
      if (!tasks.exists(taskId)) throw new ImportDeleted();
      throw err;
    }
    if (row != null) {
      emitRunEvent({ id: row.id, runId, taskId, stream: ev.stream, data: ev.data, ts: row.ts });
      if (ev.stream === "assistant") lastAssistant = row.id;
    }
    if (performance.now() - sliceStart >= sliceMs) {
      flushAssistant();
      await yieldTurn();
      if (!tasks.exists(taskId)) throw new ImportDeleted();
      sliceStart = performance.now();
    }
  }
  flushAssistant();
}

async function runBackfill(
  taskId: string,
  opts: ImportOpencodeSessionsOptions | undefined,
  known?: OpencodeExport,
): Promise<void> {
  if (opts?.backfillGate) await opts.backfillGate;
  const task = tasks.get(taskId);
  if (!task?.importedOpencode || task.importedOpencode.status !== "importing") return;
  if (tasks.importedOpencodeSessionHeldElsewhere(taskId, task.importedOpencode.sessionId)) {
    failImport(taskId, IMPORTED_OPENCODE_HELD_ELSEWHERE);
    return;
  }
  let runId: string;
  try {
    runId = ensureSeedRun(task);
  } catch (err) {
    if (err instanceof ImportDeleted) return;
    failImport(taskId, importFailureMessage(err));
    return;
  }
  const provenance = tasks.get(taskId)?.importedOpencode ?? task.importedOpencode;
  try {
    const exp = known ?? await exportFor(task, provenance);
    const events = exportToEvents(exp);
    if (!exportIsComplete(exp)) {
      events.push({ stream: "status", data: OPENCODE_UNFINISHED_STATUS, lineUuid: UNFINISHED_LINE_UUID });
    }
    await writeEvents(taskId, runId, events, opts?.sliceMs ?? IMPORT_SLICE_MS);
    const current = requireTask(taskId);
    tasks.setImportedOpencode(taskId, { ...current, status: "ready", error: null });
    broadcastAppEvent({ type: "claude_session_import", taskId, status: "ready", ts: Date.now() });
  } catch (err) {
    if (err instanceof ImportDeleted) return;
    failImport(taskId, importFailureMessage(err));
  }
}

function startBackfill(
  taskId: string,
  opts: ImportOpencodeSessionsOptions | undefined,
  known?: OpencodeExport,
): void {
  if (inflight.has(taskId)) return;
  const job = runBackfill(taskId, opts, known).finally(() => { inflight.delete(taskId); });
  inflight.set(taskId, job);
}

/** Resolves when this task's backfill has settled. Tests use it. */
export function pendingOpencodeImportBackfill(taskId: string): Promise<void> {
  return inflight.get(taskId) ?? Promise.resolve();
}

/** Re-run the export for every import a crash left `importing`. Called at
 *  boot by both entry points; the claim and the seed row are already there. */
export async function resumeIncompleteOpencodeImports(opts?: ImportOpencodeSessionsOptions): Promise<void> {
  for (const taskId of tasks.importingOpencodeIds()) startBackfill(taskId, opts);
}

export async function retryOpencodeImport(
  taskId: string,
  opts?: ImportOpencodeSessionsOptions,
): Promise<{ ok: true } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task?.importedOpencode) return { error: "task is not an imported session" };
  if (task.importedOpencode.status !== "failed") return { error: "import is not failed" };
  if (tasks.importedOpencodeSessionHeldElsewhere(taskId, task.importedOpencode.sessionId)) {
    return { error: IMPORTED_OPENCODE_HELD_ELSEWHERE };
  }
  try {
    tasks.setImportedOpencode(taskId, { ...task.importedOpencode, status: "importing", error: null });
  } catch (err) {
    if (err instanceof ImportedOpencodeSessionTaken) return { error: IMPORTED_OPENCODE_HELD_ELSEWHERE };
    throw err;
  }
  startBackfill(taskId, opts);
  await pendingOpencodeImportBackfill(taskId);
  const after = tasks.get(taskId);
  if (!after) return { error: "task disappeared during retry" };
  if (!after.importedOpencode) return { error: "task lost its import record" };
  if (after.importedOpencode.status === "failed") {
    return { error: after.importedOpencode.error ?? "Import failed" };
  }
  return { ok: true };
}

/** Every listed row per session id (one per harness that listed it). A
 *  cached scan first; ids it lacks trigger one forced re-scan. */
async function findRecords(ids: readonly string[]): Promise<Map<string, OpencodeSessionRecord[]>> {
  const group = (records: OpencodeSessionRecord[]) => {
    const byId = new Map<string, OpencodeSessionRecord[]>();
    for (const r of records) {
      if (!ids.includes(r.sessionId)) continue;
      const list = byId.get(r.sessionId) ?? [];
      list.push(r);
      byId.set(r.sessionId, list);
    }
    return byId;
  };
  let byId = group(await scanOpencodeSessionRecords());
  if (ids.some((id) => !byId.has(id))) byId = group(await scanOpencodeSessionRecords({ force: true }));
  return byId;
}

export async function importOpencodeSessions(
  ids: string[],
  opts?: ImportOpencodeSessionsOptions,
): Promise<{ results: ImportOpencodeSessionResult[] }> {
  const results: ImportOpencodeSessionResult[] = [];
  let target: Harness | null = null;
  if (opts?.harnessId) {
    target = harnesses.get(opts.harnessId);
    if (target?.kind !== "opencode") {
      const error = `unknown OpenCode harness "${opts.harnessId}"`;
      return { results: ids.map((id) => ({ id, error })) };
    }
  }
  const records = await findRecords(ids);
  for (const id of ids) {
    try {
      const rows = records.get(id) ?? [];
      const record = (target && rows.find((r) => r.harnessId === target!.id)) ?? rows[0] ?? null;
      results.push(await commitOne(id, record, target, opts));
    } catch (err) {
      // One id's failure must not 500 the rest of the batch. A claim that
      // landed before the throw stays on the task so resume can finish it.
      results.push({ id, error: importFailureMessage(err) });
    }
  }
  return { results };
}

/**
 * The OpenCode data dir a harness's CLI reads (sessions live in its
 * `opencode/opencode.db`): `XDG_DATA_HOME`, else `$HOME/.local/share`, over
 * the env a spawn actually gets — agetor's own env with the harness's
 * (`harnessEnv`: a `home` pins HOME + XDG_*, an env map may set either) on top.
 */
function opencodeDataDirOf(h: Harness): string {
  const env = { ...process.env, ...harnessEnv(h) };
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return path.resolve(xdg);
  return path.resolve(env.HOME?.trim() || homedir(), ".local", "share");
}

/** Error for a `harnessId` override that can't resume the session, or null. */
function overrideMismatch(id: string, record: OpencodeSessionRecord, target: Harness): string | null {
  if (record.harnessId === target.id) return null;
  const listedUnder = harnesses.get(record.harnessId);
  if (listedUnder?.kind === "opencode" && opencodeDataDirOf(listedUnder) === opencodeDataDirOf(target)) return null;
  const listedLabel = listedUnder?.label ?? record.harnessId;
  return `OpenCode session ${id} belongs to "${listedLabel}" — "${target.label}" reads another OpenCode data dir and couldn't continue it; import it under "${listedLabel}"`;
}

async function commitOne(
  id: string,
  record: OpencodeSessionRecord | null,
  target: Harness | null,
  opts: ImportOpencodeSessionsOptions | undefined,
): Promise<ImportOpencodeSessionResult> {
  if (sessionAlreadyBound(id)) return { id, error: ALREADY_IMPORTED };
  if (!record) return { id, error: "session not found" };
  if (record.blockedReason === "missing-folder") return { id, error: MISSING_FOLDER_IMPORT_ERROR };
  const mismatch = target ? overrideMismatch(id, record, target) : null;
  if (mismatch) return { id, error: mismatch };
  const found = record;

  return withCommitLock(id, async () => {
    if (sessionAlreadyBound(id)) return { id, error: ALREADY_IMPORTED };
    // The caller gate comes first: nothing in this process may stat a folder
    // the caller is not allowed to reach (D24).
    if (opts?.gateCwd) {
      const refusal = await opts.gateCwd(found.directory);
      if (refusal !== null) return { id, error: refusal };
    }
    // The folder can go away between the scan and this commit.
    if (!isDirectory(found.directory)) return { id, error: MISSING_FOLDER_IMPORT_ERROR };
    const listedUnder = harnesses.get(found.harnessId);
    if (listedUnder?.kind !== "opencode") return { id, error: `OpenCode harness "${found.harnessId}" no longer exists` };
    // One export serves the busy re-check, the task's launch fields and the
    // backfill. The scan's busy verdict can be up to 10 s old.
    const exp = await runOpencodeExport({
      sessionId: id,
      bin: resolveBin(listedUnder),
      env: harnessEnv(listedUnder),
      cwd: found.directory,
      major: found.major,
      standalone: found.standalone,
      timeoutMs: IMPORT_EXPORT_TIMEOUT_MS,
    });
    if (!exp) return { id, error: exportFailedMessage(id) };
    const summary = exportSummary(exp);
    if (!exportIsComplete(exp) && withinBusyWindow(summary.updatedAt ?? found.updatedAt)) {
      return { id, error: OPENCODE_BUSY_IMPORT_ERROR };
    }
    return bindImportedSession(id, found, target ?? listedUnder, exp, summary, opts);
  });
}

async function bindImportedSession(
  id: string,
  record: OpencodeSessionRecord,
  harness: Harness,
  exp: OpencodeExport,
  summary: OpencodeExportSummary,
  opts: ImportOpencodeSessionsOptions | undefined,
): Promise<ImportOpencodeSessionResult> {
  const title = opencodeImportTitle(id, summary, record.title);
  const prompt = capPrompt(summary.firstUserText ?? title);
  const launch = opencodeImportLaunch(summary);
  projects.upsert(record.directory, path.basename(record.directory) || record.directory);
  const created = await createTask({
    title,
    prompt,
    workdir: record.directory,
    isolation: "none",
    column: "review",
    agent: harness.id,
    mode: launch.mode,
    model: launch.model,
    effort: launch.effort,
    opencodeServer: "shared",
  });
  if ("error" in created) return { id, error: created.error };

  const taskId = created.task.id;
  const now = Date.now();
  const runId = randomUUID();
  const provenance: ImportedOpencodeSession = {
    sessionId: id,
    harnessId: record.harnessId,
    directory: record.directory,
    importedAt: now,
    status: "importing",
    error: null,
  };
  // Provenance before the seed run, so a crash between the two leaves a row
  // resume can repair. The unique index claims the session id on this write.
  let claimed = false;
  try {
    const claimedTask = tasks.setImportedOpencode(taskId, provenance);
    if (!claimedTask) {
      tasks.delete(taskId);
      return { id, error: "task disappeared before the seed run was written" };
    }
    claimed = true;
    runs.insert(seedRun({ ...claimedTask, agent: harness.id }, provenance, runId, now));
    tasks.update(taskId, { runId, column: "review" });
  } catch (err) {
    if (err instanceof ImportedOpencodeSessionTaken) {
      tasks.delete(taskId);
      return { id, error: ALREADY_IMPORTED };
    }
    if (!claimed) tasks.delete(taskId);
    throw err;
  }
  startBackfill(taskId, opts, exp);
  return { id, taskId };
}
