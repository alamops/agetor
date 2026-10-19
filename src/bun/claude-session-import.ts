/**
 * Commit an external Claude Code session as an in-place task and persist
 * its transcript onto a succeeded seed run. Send stays refused until the
 * backfill reaches `ready`.
 */
import { open, type FileHandle } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  harnesses,
  hiddenClaudeSessionIds,
  IMPORTED_CLAUDE_HELD_ELSEWHERE,
  ImportedClaudeSessionTaken,
  projects,
  runs,
  subagents,
  tasks,
} from "./db.ts";
import { createTask, emitRunEvent } from "./orchestrator.ts";
import { claudeModelIdFromArg } from "./agents.ts";
import { replayJsonlLines, type JsonlReplayLine } from "./claude-tmux.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import {
  discoverAgetorWorktreeRoots,
  findClaudeSession,
  findClaudeSessions,
  recheckClaudeSessionLiveness,
  type ClaudeHarnessRef,
  type ClaudeSessionRecord,
  type ScanClaudeSessionsOptions,
} from "./claude-session-scan.ts";
import {
  LONG_PATH_IMPORT_ERROR,
  MISSING_FOLDER_IMPORT_ERROR,
  agetorModeForClaudePermission,
} from "../shared/claude-session-meta.ts";
import type { ImportedClaudeSession, Run, Task } from "../shared/types.ts";

const PROMPT_CAP_BYTES = 100 * 1024;

/** Bytes read per transcript slice. Lines from this chunk are replayed before the next read. */
export const IMPORT_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

export interface ImportClaudeSessionsOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  encodePath?: (cwd: string) => string;
  listLive?: ScanClaudeSessionsOptions["listLive"];
  readRegistry?: ScanClaudeSessionsOptions["readRegistry"];
  harnesses?: readonly ClaudeHarnessRef[];
  worktreeRoots?: readonly string[];
  pidAlive?: (pid: number) => boolean;
  procStartMatches?: (pid: number, procStart: string) => boolean | Promise<boolean>;
  /** Test seam: the backfill waits here before reading the transcript. */
  backfillGate?: Promise<void>;
  /** Passed through to the cooperative replay. Tests use `0` to yield per line. */
  sliceMs?: number;
  /** Fired after each persisted slice of the main transcript, with the byte offset. */
  onBackfillProgress?: (taskId: string, offset: number) => void;
  /**
   * Test seam for the transcript read. `read` is the real `filehandle.read`.
   * A short `bytesRead` is retried until the tail is full; `0` is EOF and
   * fails the import instead of marking the stat size ready.
   */
  readChunk?: (
    read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>,
    buf: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  /** Test seam: forwarded to the scanner so a batch can prove it parsed each file once. */
  onJsonlRead?: (jsonlPath: string) => void;
}

export interface ImportClaudeSessionResult {
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

const ALREADY_IMPORTED = "session is already imported";

function sessionAlreadyBound(sessionId: string): boolean {
  return tasks.findByImportedSessionId(sessionId) != null || runs.hasClaudeSessionId(sessionId);
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

function scanOptions(opts: ImportClaudeSessionsOptions | undefined): ScanClaudeSessionsOptions {
  const homeDir = opts?.homeDir ?? (process.env.HOME || homedir());
  const listed = opts?.harnesses ?? harnesses.list()
    .filter((h) => h.kind === "claude-code")
    .map((h) => ({ id: h.id, kind: h.kind, home: h.home, bin: h.bin }));
  return {
    homeDir,
    env: opts?.env ?? process.env,
    ownedSessionIds: hiddenClaudeSessionIds(),
    worktreeRoots: opts?.worktreeRoots ?? discoverAgetorWorktreeRoots(homeDir),
    harnesses: listed,
    encodePath: opts?.encodePath,
    listLive: opts?.listLive,
    readRegistry: opts?.readRegistry,
    pidAlive: opts?.pidAlive,
    procStartMatches: opts?.procStartMatches,
    onJsonlRead: opts?.onJsonlRead,
  };
}

type TranscriptRead = (
  buf: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number }>;

/**
 * Byte window for one transcript. Grows by doubling so a line that spans
 * chunks is copied O(log n) times, and a newline search never looks past
 * the bytes that have actually been read.
 */
class TranscriptWindow {
  private buf = Buffer.alloc(0);
  private start = 0;
  private end = 0;

  append(chunk: Buffer): void {
    const need = chunk.length;
    if (need === 0) return;
    if (this.end + need > this.buf.length) {
      const live = this.end - this.start;
      let cap = Math.max(this.buf.length, 4096);
      while (cap < live + need) cap *= 2;
      const next = Buffer.alloc(cap);
      if (live > 0) this.buf.copy(next, 0, this.start, this.end);
      chunk.copy(next, live);
      this.buf = next;
      this.start = 0;
      this.end = live + need;
      return;
    }
    chunk.copy(this.buf, this.end);
    this.end += need;
  }

  /** Complete lines. The newline is not part of `line`; it is part of `bytes`. */
  drain(into: JsonlReplayLine[]): void {
    while (this.start < this.end) {
      const nl = this.buf.indexOf(0x0a, this.start);
      if (nl < 0 || nl >= this.end) return;
      const slice = this.buf.subarray(this.start, nl);
      into.push({ line: slice.toString("utf8"), bytes: slice.length + 1 });
      this.start = nl + 1;
    }
  }

  /** The unread tail at EOF, when the file does not end on a newline. */
  finish(into: JsonlReplayLine[]): void {
    if (this.start >= this.end) return;
    const slice = this.buf.subarray(this.start, this.end);
    into.push({ line: slice.toString("utf8"), bytes: slice.length });
    this.start = this.end;
  }
}

function createTranscriptPull(
  fh: FileHandle,
  offset: number,
  bound: { size: number },
  readChunk: ImportClaudeSessionsOptions["readChunk"],
): () => JsonlReplayLine | null | Promise<JsonlReplayLine | null> {
  const raw: TranscriptRead = (dst, dstOff, length, position) => fh.read(dst, dstOff, length, position);
  const read: TranscriptRead = readChunk
    ? (dst, dstOff, length, position) => readChunk(raw, dst, dstOff, length, position)
    : raw;
  const window = new TranscriptWindow();
  const queued: JsonlReplayLine[] = [];
  let cursor = 0;
  let filePos = offset;
  let flushed = false;
  let eof = false;
  let inflight: Promise<JsonlReplayLine | null> | null = null;

  return () => {
    if (cursor < queued.length) return queued[cursor++]!;
    if (eof) return null;
    if (!inflight) inflight = readLines().finally(() => { inflight = null; });
    return inflight;
  };

  async function readLines(): Promise<JsonlReplayLine | null> {
    queued.length = 0;
    cursor = 0;
    if (flushed) {
      eof = true;
      return null;
    }
    // One chunk is enough when it holds a newline. A line longer than the
    // chunk keeps reading, yielding on each awaited read, until the line
    // closes or the file ends. A stat that lands mid-write is not EOF:
    // finish the partial line only after a later stat shows no growth.
    while (queued.length === 0 && !flushed) {
      while (filePos < bound.size && queued.length === 0) {
        const want = Math.min(IMPORT_TRANSCRIPT_CHUNK_BYTES, bound.size - filePos);
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await read(buf, got, want - got, filePos + got);
          // A short read is normal; EOF (`0`) before the stat size is not.
          // Stopping early would persist a truncated transcript and mark the
          // import ready.
          if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > want - got) {
            throw new Error(
              `short read of session transcript (${filePos - offset + got} of ${bound.size - offset} bytes)`,
            );
          }
          got += bytesRead;
        }
        filePos += got;
        window.append(buf.subarray(0, got));
        window.drain(queued);
      }
      if (queued.length > 0) break;
      const now = (await fh.stat()).size;
      if (now > bound.size) {
        bound.size = now;
        continue;
      }
      window.finish(queued);
      flushed = true;
    }
    if (cursor < queued.length) return queued[cursor++]!;
    eof = true;
    return null;
  }
}

function requireTask(taskId: string): ImportedClaudeSession {
  const task = tasks.get(taskId);
  if (!task) throw new ImportDeleted();
  if (!task.importedClaude) throw new Error("task lost its import record");
  return task.importedClaude;
}

function noteBackfillOffset(
  taskId: string,
  offset: number,
  lastAssistant: { id: number | null },
  opts: ImportClaudeSessionsOptions | undefined,
): void {
  const current = requireTask(taskId);
  if (current.status === "importing" && current.backfillOffset !== offset) {
    tasks.setImportedClaude(taskId, { ...current, backfillOffset: offset });
  }
  if (lastAssistant.id != null) {
    tasks.noteAssistantEvent(taskId, lastAssistant.id);
    lastAssistant.id = null;
  }
  opts?.onBackfillProgress?.(taskId, offset);
}

async function replayFile(
  taskId: string,
  runId: string,
  file: string,
  offset: number,
  subagentId: string | null,
  opts: ImportClaudeSessionsOptions | undefined,
  trackOffset: boolean,
): Promise<number> {
  const fh = await open(file, "r");
  try {
    const bound = { size: (await fh.stat()).size };
    if (offset >= bound.size) return bound.size;
    const lastAssistant = { id: null as number | null };
    // The task can be deleted while this file is open. A full `tasks.get`
    // per line joins runs and parses the row; that dominated import of a
    // long transcript. Check once up front and again on each yield. A
    // delete between those points fails the insert, and that failure is
    // the same stop.
    if (!tasks.exists(taskId)) throw new ImportDeleted();
    // Stream complete lines and yield inside the replay. Reading or splitting
    // the whole transcript first would hold the main thread for a large JSONL.
    // `bound.size` grows when the file does, so a flush during the read is
    // not treated as the end. The caller marks ready only with the size
    // returned after a stat that did not grow.
    let cursor = offset;
    while (cursor < bound.size) {
      const sliceFrom = cursor;
      await replayJsonlLines(createTranscriptPull(fh, cursor, bound, opts?.readChunk), (stream, data, lineUuid) => {
        let eventId: number | null;
        try {
          eventId = runs.appendEvent(runId, stream, data, lineUuid ?? null, subagentId);
        } catch (err) {
          if (!tasks.exists(taskId)) throw new ImportDeleted();
          throw err;
        }
        if (eventId == null) return;
        emitRunEvent({
          runId,
          taskId,
          stream,
          data,
          ts: Date.now(),
          ...(subagentId ? { subagentId } : {}),
        });
        if (trackOffset && stream === "assistant") lastAssistant.id = eventId;
      }, {
        sliceMs: opts?.sliceMs,
        onProgress: (consumed) => {
          const absolute = sliceFrom + consumed;
          // The offset that equals the file size is written by the caller
          // after this replay returns, which is after the EOF turn-complete
          // banner. Persisting it from the in-loop checkpoint would let a
          // crash skip that banner on resume.
          if (trackOffset) {
            if (absolute < bound.size) noteBackfillOffset(taskId, absolute, lastAssistant, opts);
          } else if (!tasks.exists(taskId)) throw new ImportDeleted();
        },
      });
      const now = (await fh.stat()).size;
      if (now <= bound.size) break;
      cursor = bound.size;
      bound.size = now;
    }
    return bound.size;
  } finally {
    await fh.close();
  }
}

function importFailureMessage(err: unknown): string {
  if (err instanceof ImportedClaudeSessionTaken) return IMPORTED_CLAUDE_HELD_ELSEWHERE;
  return err instanceof Error ? err.message : String(err);
}

/** Mark an in-flight import failed. A row that does not hold the session
 *  claim is updated in the JSON only — writing the claim would throw on the
 *  unique index and leave the row `importing` forever. */
function failImport(taskId: string, message: string): void {
  const current = tasks.get(taskId);
  if (!current?.importedClaude) return;
  const next: ImportedClaudeSession = { ...current.importedClaude, status: "failed", error: message };
  if (tasks.importedSessionHeldElsewhere(taskId, next.sessionId)) {
    tasks.setImportedClaude(taskId, next, { claim: false });
  } else {
    try {
      tasks.setImportedClaude(taskId, next);
    } catch (err) {
      if (!(err instanceof ImportedClaudeSessionTaken)) throw err;
      tasks.setImportedClaude(taskId, next, { claim: false });
    }
  }
  broadcastAppEvent({ type: "claude_session_import", taskId, status: "failed", ts: Date.now() });
}

async function importSubagents(
  taskId: string,
  runId: string,
  jsonlPath: string,
  sessionId: string,
  opts: ImportClaudeSessionsOptions | undefined,
): Promise<void> {
  const dir = path.join(path.dirname(jsonlPath), sessionId, "subagents");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    requireTask(taskId);
    const id = name.slice("agent-".length, -".jsonl".length);
    const sourcePath = path.join(dir, name);
    subagents.insertIfAbsent({
      id,
      taskId,
      runId,
      parentKind: "subagent",
      agentType: null,
      description: null,
      spawnDepth: 1,
      sourcePath,
      status: "completed",
      startedAt: now,
      endedAt: now,
    });
    await replayFile(taskId, runId, sourcePath, 0, id, opts, false);
  }
}

function seedRun(task: Task, provenance: ImportedClaudeSession, runId: string, now: number): Run {
  return {
    id: runId,
    taskId: task.id,
    agent: task.agent,
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: provenance.sessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "imported",
  };
}

/** A crash after provenance is stored and before `runId` points at the seed
 *  run leaves `status: "importing"` with nothing to replay onto. Reattach
 *  the existing seed row when it survived, otherwise insert one and continue.
 *  Provenance is written first so this repair can see the task — a seed row
 *  with no `importedClaude` is invisible to resume. */
function ensureSeedRun(task: Task): string {
  const provenance = task.importedClaude;
  if (!provenance) throw new Error("task lost its import record");
  if (task.runId && runs.get(task.runId)) return task.runId;
  const existing = runs.listForTask(task.id).find(
    (r) => r.origin === "imported" && r.claudeSessionId === provenance.sessionId,
  );
  const runId = existing?.id ?? randomUUID();
  if (!existing) runs.insert(seedRun(task, provenance, runId, Date.now()));
  tasks.update(task.id, { runId, column: "review" });
  return runId;
}

async function runBackfill(
  taskId: string,
  opts: ImportClaudeSessionsOptions | undefined,
  known?: ClaudeSessionRecord,
): Promise<void> {
  if (opts?.backfillGate) await opts.backfillGate;
  const task = tasks.get(taskId);
  if (!task?.importedClaude || task.importedClaude.status !== "importing") return;
  // Migration 070 leaves a losing duplicate `importing` with a null claim.
  // Taking the session id here throws, and the failure write used to throw
  // the same way, so the row stayed `importing` across boots.
  if (tasks.importedSessionHeldElsewhere(taskId, task.importedClaude.sessionId)) {
    failImport(taskId, IMPORTED_CLAUDE_HELD_ELSEWHERE);
    return;
  }
  // Stays ahead of the transcript await when no gate is set. The launch scan
  // reads ownership after `resumeIncompleteImports` returns, and this function
  // runs synchronously up to that await.
  let runId: string;
  try {
    runId = ensureSeedRun(task);
  } catch (err) {
    if (err instanceof ImportDeleted) return;
    failImport(taskId, importFailureMessage(err));
    return;
  }
  const provenance = tasks.get(taskId)?.importedClaude ?? task.importedClaude;
  try {
    const record = known?.sessionId === provenance.sessionId
      ? known
      : await findClaudeSession(provenance.sessionId, scanOptions(opts));
    if (!record) throw new Error("session transcript is gone");
    await importSubagents(taskId, runId, record.jsonlPath, provenance.sessionId, opts);
    const fresh = requireTask(taskId);
    const size = await replayFile(taskId, runId, record.jsonlPath, fresh.backfillOffset, null, opts, true);
    const current = requireTask(taskId);
    tasks.setImportedClaude(taskId, { ...current, backfillOffset: size, status: "ready", error: null });
    broadcastAppEvent({ type: "claude_session_import", taskId, status: "ready", ts: Date.now() });
  } catch (err) {
    if (err instanceof ImportDeleted) return;
    failImport(taskId, importFailureMessage(err));
  }
}

function startBackfill(
  taskId: string,
  opts: ImportClaudeSessionsOptions | undefined,
  known?: ClaudeSessionRecord,
): void {
  if (inflight.has(taskId)) return;
  const job = runBackfill(taskId, opts, known).finally(() => { inflight.delete(taskId); });
  inflight.set(taskId, job);
}

/** Resolves when this task's backfill has settled. Tests use it. */
export function pendingImportBackfill(taskId: string): Promise<void> {
  return inflight.get(taskId) ?? Promise.resolve();
}

export async function resumeIncompleteImports(opts?: ImportClaudeSessionsOptions): Promise<void> {
  for (const taskId of tasks.importingClaudeIds()) startBackfill(taskId, opts);
}

export async function retryImport(
  taskId: string,
  opts?: ImportClaudeSessionsOptions,
): Promise<{ ok: true } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task?.importedClaude) return { error: "task is not an imported session" };
  if (task.importedClaude.status !== "failed") return { error: "import is not failed" };
  // Same claim the unique index enforces on import. A losing duplicate still
  // has failed provenance; rewriting it would either throw or, if the check
  // were skipped, replay onto a session another task owns.
  if (tasks.importedSessionHeldElsewhere(taskId, task.importedClaude.sessionId)) {
    return { error: IMPORTED_CLAUDE_HELD_ELSEWHERE };
  }
  try {
    tasks.setImportedClaude(taskId, { ...task.importedClaude, status: "importing", error: null });
  } catch (err) {
    if (err instanceof ImportedClaudeSessionTaken) {
      return { error: IMPORTED_CLAUDE_HELD_ELSEWHERE };
    }
    throw err;
  }
  startBackfill(taskId, opts);
  await pendingImportBackfill(taskId);
  const after = tasks.get(taskId);
  if (!after) return { error: "task disappeared during retry" };
  if (!after.importedClaude) return { error: "task lost its import record" };
  if (after.importedClaude.status === "failed") {
    return { error: after.importedClaude.error ?? "Import failed" };
  }
  return { ok: true };
}

export async function importClaudeSessions(
  ids: string[],
  opts?: ImportClaudeSessionsOptions,
): Promise<{ results: ImportClaudeSessionResult[] }> {
  const scan = scanOptions(opts);
  const records = await findClaudeSessions(new Set(ids), scan);
  // The scanner's liveness was taken before the transcript read. Probe again
  // so a session that started during that read is refused.
  await recheckClaudeSessionLiveness(records.values(), scan);
  const results: ImportClaudeSessionResult[] = [];
  for (const id of ids) {
    try {
      results.push(await commitOne(id, records.get(id) ?? null, opts));
    } catch (err) {
      // One id's failure must not 500 the rest of the batch. A claim that
      // landed before the throw stays on the task so resume can finish it.
      results.push({ id, error: importFailureMessage(err) });
    }
  }
  return { results };
}

async function commitOne(
  id: string,
  record: ClaudeSessionRecord | null,
  opts: ImportClaudeSessionsOptions | undefined,
): Promise<ImportClaudeSessionResult> {
  // Fresh read, not the scanner's snapshot: a seed-insert crash leaves the
  // session id on the task and not yet on a run, and a snapshot taken before
  // a concurrent commit cannot see that commit.
  if (sessionAlreadyBound(id)) return { id, error: ALREADY_IMPORTED };
  if (!record) return { id, error: "session not found" };
  if (!record.firstHumanPrompt && record.messageCount === 0) return { id, error: "session has no messages" };
  if (record.blockedReason === "long-path") return { id, error: LONG_PATH_IMPORT_ERROR };
  if (record.blockedReason === "missing-folder") return { id, error: MISSING_FOLDER_IMPORT_ERROR };
  if (record.liveness === "live" || record.blockedReason === "live") {
    return { id, error: record.liveHint ?? "Close it in your terminal first" };
  }
  if (record.liveness === "unknown") return { id, error: "session liveness is unknown — re-check first" };
  if (record.blockedReason === "no-harness" || !record.harnessId) {
    return { id, error: `Account ${record.configDir} isn't set up in Agetor — Add it to import` };
  }
  if (record.continuedIn) return { id, error: `session was continued in ${record.continuedIn}` };
  const found = record;

  return withCommitLock(id, async () => {
    if (sessionAlreadyBound(id)) return { id, error: ALREADY_IMPORTED };
    // The folder can go away between the scan and this commit.
    if (!isDirectory(found.cwd)) return { id, error: MISSING_FOLDER_IMPORT_ERROR };
    return bindImportedSession(id, found, opts);
  });
}

async function bindImportedSession(
  id: string,
  record: ClaudeSessionRecord,
  opts: ImportClaudeSessionsOptions | undefined,
): Promise<ImportClaudeSessionResult> {
  const prompt = capPrompt(record.firstHumanPrompt ?? record.title);
  const model = record.model ? claudeModelIdFromArg(record.model) : null;
  projects.upsert(record.cwd, path.basename(record.cwd) || record.cwd);
  const created = await createTask({
    title: record.title,
    prompt,
    workdir: record.cwd,
    isolation: "none",
    column: "review",
    agent: record.harnessId!,
    mode: agetorModeForClaudePermission(record.permissionMode),
    ...(model ? { model } : {}),
  });
  if ("error" in created) return { id, error: created.error };

  const taskId = created.task.id;
  const now = Date.now();
  const runId = randomUUID();
  const provenance: ImportedClaudeSession = {
    sessionId: id,
    gitBranch: record.gitBranch,
    importedAt: now,
    configDir: record.configDir,
    status: "importing",
    backfillOffset: 0,
    error: null,
  };
  // Provenance before the seed run. The other order crashes into a seed row
  // with no `importedClaude`, which resume never selects and `ensureSeedRun`
  // cannot repair. The unique index claims the session id on this write, so
  // a retry sees the task even though no run row exists yet.
  let claimed = false;
  try {
    const createdTask = tasks.setImportedClaude(taskId, provenance);
    if (!createdTask) {
      tasks.delete(taskId);
      return { id, error: "task disappeared before the seed run was written" };
    }
    claimed = true;
    runs.insert(seedRun(
      { ...createdTask, agent: record.harnessId! },
      provenance,
      runId,
      now,
    ));
    tasks.update(taskId, { runId, column: "review" });
  } catch (err) {
    if (err instanceof ImportedClaudeSessionTaken) {
      tasks.delete(taskId);
      return { id, error: ALREADY_IMPORTED };
    }
    // Provenance is the claim. Keep the task when that write landed so resume
    // can insert the seed. A failure before it leaves an unbound row; delete
    // that row so the next attempt can bind a fresh task.
    if (!claimed) tasks.delete(taskId);
    throw err;
  }
  startBackfill(taskId, opts, record);
  return { id, taskId };
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check out a session's branch in its folder, refusing a live session and a
 * dirty tree. `requested` is the branch the caller showed the user — the
 * task panel names the branch frozen at import, while the transcript's last
 * `gitBranch` moves on once the session continues in Agetor. Without it the
 * transcript's last branch is used (the import dialog shows that one).
 */
export async function checkoutSessionBranch(
  sessionId: string,
  opts?: ImportClaudeSessionsOptions,
  requested?: string,
): Promise<{ ok: true; branch: string } | { error: string }> {
  const scan = scanOptions(opts);
  const record = await findClaudeSession(sessionId, scan);
  if (!record) return { error: "session not found" };
  // The list probe can be stale by the time checkout runs. A live Claude
  // process must not have its cwd's HEAD moved under it.
  await recheckClaudeSessionLiveness([record], scan);
  if (record.liveness === "live" || record.blockedReason === "live") {
    return { error: record.liveHint ?? "Close it in your terminal first" };
  }
  // `findClaudeSession` just parsed this transcript. A second full read
  // only to copy `gitBranch` holds the main thread on a large JSONL.
  const branch = requested ?? record.gitBranch;
  if (!branch) return { error: "this session has no branch to switch to" };
  if (!isDirectory(record.cwd)) return { error: MISSING_FOLDER_IMPORT_ERROR };
  const inside = await git(record.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { error: "folder is not a git repository" };
  }
  const format = await git(record.cwd, ["check-ref-format", "--branch", branch]);
  if (format.code !== 0) return { error: `invalid branch name: ${branch}` };
  const status = await git(record.cwd, ["status", "--porcelain"]);
  if (status.code !== 0) return { error: status.stderr.trim() || "could not read git status" };
  if (status.stdout.trim()) return { error: "working tree is not clean" };
  const checkout = await git(record.cwd, ["checkout", branch]);
  if (checkout.code !== 0) return { error: (checkout.stderr || checkout.stdout).trim() || "checkout failed" };
  return { ok: true, branch };
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}
