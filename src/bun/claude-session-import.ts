/**
 * Commit an external Claude Code session as an in-place task and persist
 * its transcript onto a succeeded seed run. Send stays refused until the
 * backfill reaches `ready`.
 */
import { open } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { harnesses, projects, runs, subagents, tasks } from "./db.ts";
import { createTask } from "./orchestrator.ts";
import { claudeModelIdFromArg } from "./agents.ts";
import { rebuildEventsFromJsonlCooperative } from "./claude-tmux.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import {
  claudeConfigDirsToScan,
  discoverAgetorWorktreeRoots,
  findClaudeSession,
  refreshClaudeSessionLiveness,
  type ClaudeHarnessRef,
  type ScanClaudeSessionsOptions,
} from "./claude-session-scan.ts";
import {
  LONG_PATH_IMPORT_ERROR,
  agetorModeForClaudePermission,
  readClaudeSessionMeta,
} from "../shared/claude-session-meta.ts";
import type { ImportedClaudeSession } from "../shared/types.ts";

const PROMPT_CAP_BYTES = 100 * 1024;

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
}

export interface ImportClaudeSessionResult {
  id: string;
  taskId?: string;
  error?: string;
}

const inflight = new Map<string, Promise<void>>();

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
    .map((h) => ({ id: h.id, kind: h.kind, home: h.home }));
  return {
    homeDir,
    env: opts?.env ?? process.env,
    ownedSessionIds: runs.claudeSessionIds(),
    worktreeRoots: opts?.worktreeRoots ?? discoverAgetorWorktreeRoots(homeDir),
    harnesses: listed,
    encodePath: opts?.encodePath,
    listLive: opts?.listLive,
    readRegistry: opts?.readRegistry,
    pidAlive: opts?.pidAlive,
    procStartMatches: opts?.procStartMatches,
  };
}

async function readTail(file: string, offset: number): Promise<{ text: string; size: number }> {
  const fh = await open(file, "r");
  try {
    const stat = await fh.stat();
    if (offset >= stat.size) return { text: "", size: stat.size };
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return { text: buf.toString("utf8"), size: stat.size };
  } finally {
    await fh.close();
  }
}

function requireTask(taskId: string): ImportedClaudeSession {
  const task = tasks.get(taskId);
  if (!task) throw new ImportDeleted();
  if (!task.importedClaude) throw new Error("task lost its import record");
  return task.importedClaude;
}

async function replayFile(
  taskId: string,
  runId: string,
  file: string,
  offset: number,
  subagentId: string | null,
): Promise<number> {
  const { text, size } = await readTail(file, offset);
  if (!text) return size;
  await rebuildEventsFromJsonlCooperative(text, (stream, data, lineUuid) => {
    requireTask(taskId);
    runs.appendEvent(runId, stream, data, lineUuid ?? null, subagentId);
  });
  return size;
}

async function importSubagents(taskId: string, runId: string, jsonlPath: string, sessionId: string): Promise<void> {
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
    await replayFile(taskId, runId, sourcePath, 0, id);
  }
}

async function runBackfill(taskId: string, opts: ImportClaudeSessionsOptions | undefined): Promise<void> {
  if (opts?.backfillGate) await opts.backfillGate;
  const task = tasks.get(taskId);
  if (!task?.importedClaude || !task.runId) return;
  const provenance = task.importedClaude;
  try {
    const record = await findClaudeSession(provenance.sessionId, scanOptions(opts));
    if (!record) throw new Error("session transcript is gone");
    await importSubagents(taskId, task.runId, record.jsonlPath, provenance.sessionId);
    const size = await replayFile(taskId, task.runId, record.jsonlPath, provenance.backfillOffset, null);
    const current = requireTask(taskId);
    tasks.setImportedClaude(taskId, { ...current, backfillOffset: size, status: "ready", error: null });
    broadcastAppEvent({ type: "claude_session_import", taskId, status: "ready", ts: Date.now() });
  } catch (err) {
    if (err instanceof ImportDeleted) return;
    const current = tasks.get(taskId);
    if (!current?.importedClaude) return;
    const message = err instanceof Error ? err.message : String(err);
    tasks.setImportedClaude(taskId, { ...current.importedClaude, status: "failed", error: message });
    broadcastAppEvent({ type: "claude_session_import", taskId, status: "failed", ts: Date.now() });
  }
}

function startBackfill(taskId: string, opts: ImportClaudeSessionsOptions | undefined): void {
  if (inflight.has(taskId)) return;
  const job = runBackfill(taskId, opts).finally(() => { inflight.delete(taskId); });
  inflight.set(taskId, job);
}

/** Resolves when this task's backfill has settled. Tests use it. */
export function pendingImportBackfill(taskId: string): Promise<void> {
  return inflight.get(taskId) ?? Promise.resolve();
}

export async function resumeIncompleteImports(opts?: ImportClaudeSessionsOptions): Promise<void> {
  for (const task of tasks.list()) {
    if (task.importedClaude?.status === "importing") startBackfill(task.id, opts);
  }
}

export async function retryImport(
  taskId: string,
  opts?: ImportClaudeSessionsOptions,
): Promise<{ ok: true } | { error: string }> {
  const task = tasks.get(taskId);
  if (!task?.importedClaude) return { error: "task is not an imported session" };
  if (task.importedClaude.status !== "failed") return { error: "import is not failed" };
  tasks.setImportedClaude(taskId, { ...task.importedClaude, status: "importing", error: null });
  startBackfill(taskId, opts);
  return { ok: true };
}

export async function importClaudeSessions(
  ids: string[],
  opts?: ImportClaudeSessionsOptions,
): Promise<{ results: ImportClaudeSessionResult[] }> {
  const scan = scanOptions(opts);
  if (!opts?.listLive) {
    await refreshClaudeSessionLiveness(claudeConfigDirsToScan(scan), scan.env);
  }
  const owned = runs.claudeSessionIds();
  const results: ImportClaudeSessionResult[] = [];
  for (const id of ids) {
    results.push(await commitOne(id, scan, owned, opts));
  }
  return { results };
}

async function commitOne(
  id: string,
  scan: ScanClaudeSessionsOptions,
  owned: Set<string>,
  opts: ImportClaudeSessionsOptions | undefined,
): Promise<ImportClaudeSessionResult> {
  if (owned.has(id)) return { id, error: "session is already imported" };
  const record = await findClaudeSession(id, scan);
  if (!record) return { id, error: "session not found" };
  if (!record.firstHumanPrompt && record.messageCount === 0) return { id, error: "session has no messages" };
  if (record.blockedReason === "long-path") return { id, error: LONG_PATH_IMPORT_ERROR };
  if (record.liveness === "live" || record.blockedReason === "live") {
    return { id, error: record.liveHint ?? "Close it in your terminal first" };
  }
  if (record.liveness === "unknown") return { id, error: "session liveness is unknown — re-check first" };
  if (record.blockedReason === "no-harness" || !record.harnessId) {
    return { id, error: `Account ${record.configDir} isn't set up in Agetor — Add it to import` };
  }
  if (record.continuedIn) return { id, error: `session was continued in ${record.continuedIn}` };

  const prompt = capPrompt(record.firstHumanPrompt ?? record.title);
  const model = record.model ? claudeModelIdFromArg(record.model) : null;
  projects.upsert(record.cwd, path.basename(record.cwd) || record.cwd);
  const created = await createTask({
    title: record.title,
    prompt,
    workdir: record.cwd,
    isolation: "none",
    column: "review",
    agent: record.harnessId,
    mode: agetorModeForClaudePermission(record.permissionMode),
    ...(model ? { model } : {}),
  });
  if ("error" in created) return { id, error: created.error };

  const taskId = created.task.id;
  const now = Date.now();
  const provenance: ImportedClaudeSession = {
    sessionId: id,
    gitBranch: record.gitBranch,
    importedAt: now,
    configDir: record.configDir,
    status: "importing",
    backfillOffset: 0,
    error: null,
  };
  tasks.setImportedClaude(taskId, provenance);
  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: record.harnessId,
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: id,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: "imported",
  });
  tasks.update(taskId, { runId, column: "review" });
  owned.add(id);
  startBackfill(taskId, opts);
  return { id, taskId };
}

export async function checkoutSessionBranch(
  sessionId: string,
  opts?: ImportClaudeSessionsOptions,
): Promise<{ ok: true; branch: string } | { error: string }> {
  const record = await findClaudeSession(sessionId, scanOptions(opts));
  if (!record) return { error: "session not found" };
  let branch = record.gitBranch;
  try {
    branch = readClaudeSessionMeta(await Bun.file(record.jsonlPath).text()).gitBranch;
  } catch {
    return { error: "could not read the session transcript" };
  }
  if (!branch) return { error: "this session has no branch to switch to" };
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
