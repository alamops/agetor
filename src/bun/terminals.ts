// In-memory manager for per-task interactive terminal tabs.
//
// Each tab is a real PTY spawned via Bun's native terminal support
// (`Bun.spawn(argv, { terminal })`, shipped in Bun 1.3.5) — NOT node-pty,
// which loads under Bun but whose libuv-based read loop never delivers data
// here (verified by spike). Bun.Terminal uses openpty(3) directly, so output,
// resize, and raw-mode all work without a native module or a tmux shim.
//
// State is intentionally NOT persisted: the PTYs are children of this Bun
// process and die with it, so a durable list would be stale at boot (same
// rationale as `interactions.ts`). The open-tab count is surfaced on the Task
// payload via `countTerminals`, mirroring `pendingInteractionCount`.
//
// Import-cycle note: this module imports `tasks` from db.ts, and db.ts imports
// `countTerminals` from here. That is safe ONLY because every cross-module
// access happens inside a function body (never at module top level) — keep it
// that way, exactly like the db.ts ↔ interactions.ts cycle.

import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { TerminalTab } from "../shared/types.ts";
import { tasks } from "./db.ts";
// NOTE: worktree.ts is imported *dynamically* inside createTerminal, not at
// the top level. worktree.ts reads db.ts's `dataDir` at module init; importing
// it statically here would pull that read into db.ts's own init chain (db.ts →
// terminals.ts → worktree.ts → db.ts) and crash with a TDZ "Cannot access 'db'
// before initialization". The `tasks` import above is fine because it's only
// touched inside function bodies (same lazy contract as interactions.ts).

/** Cap per task so a runaway loop of "+" clicks can't fork-bomb the box. */
const MAX_TERMINALS_PER_TASK = 8;
/** Recent-output ring buffer size. Replayed to a (re)connecting socket so
 *  reopening the sidebar or switching back to a tab restores scrollback
 *  without persisting anything. ~256 KB is plenty for a screen of history. */
const RING_BUFFER_BYTES = 256 * 1024;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Attached to each upgraded WebSocket so the server's ws handlers know which
 *  terminal a socket belongs to. */
export interface TerminalSocketData {
  terminalId: string;
}

type TerminalWebSocket = ServerWebSocket<TerminalSocketData>;

interface TerminalEntry {
  id: string;
  taskId: string;
  title: string;
  cwd: string;
  createdAt: number;
  proc: Bun.Subprocess;
  term: Bun.Terminal;
  cols: number;
  rows: number;
  /** Ring of recent output chunks; total length bounded by RING_BUFFER_BYTES. */
  buffer: Uint8Array[];
  bufferBytes: number;
  sockets: Set<TerminalWebSocket>;
  exited: boolean;
  exitCode: number | null;
}

const terminals = new Map<string, TerminalEntry>();
/** In-flight `createTerminal` reservations per task. Counted against the cap
 *  alongside live terminals so two concurrent creates can't both slip past it
 *  during the async `prepareWorkdir` window. */
const inFlight = new Map<string, number>();
/** Monotonic per-task label counter, so tab numbers never collide or get
 *  reused after a close (e.g. closing "Terminal 2" then creating won't mint a
 *  second "Terminal 3"). Reset when a task's terminals are all torn down. */
const labelSeq = new Map<string, number>();

function toTab(e: TerminalEntry): TerminalTab {
  return { id: e.id, taskId: e.taskId, title: e.title, cwd: e.cwd, createdAt: e.createdAt };
}

function appendToBuffer(e: TerminalEntry, chunk: Uint8Array): void {
  e.buffer.push(chunk);
  e.bufferBytes += chunk.byteLength;
  while (e.bufferBytes > RING_BUFFER_BYTES && e.buffer.length > 1) {
    const dropped = e.buffer.shift()!;
    e.bufferBytes -= dropped.byteLength;
  }
}

/** Concatenate the ring buffer into a single frame for replay on connect. */
function snapshotBuffer(e: TerminalEntry): Uint8Array {
  const out = new Uint8Array(e.bufferBytes);
  let off = 0;
  for (const chunk of e.buffer) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

function broadcast(e: TerminalEntry, data: Uint8Array): void {
  for (const ws of e.sockets) {
    // Bun queues sends; readyState 1 == OPEN. Skip closing/closed sockets.
    if (ws.readyState === 1) ws.sendBinary(data);
  }
}

function notifyExit(e: TerminalEntry): void {
  const frame = JSON.stringify({ t: "exit", code: e.exitCode });
  for (const ws of e.sockets) {
    if (ws.readyState === 1) ws.send(frame);
  }
}

/**
 * Create a new terminal tab for a task. Resolves the working directory via
 * `prepareWorkdir` — which MATERIALIZES the worktree for a worktree-isolation
 * task that hasn't one yet — and persists the resulting branch/worktreePath
 * back onto the task so a later agent run reuses the same isolated dir
 * (mirrors `orchestrator.startTask`).
 */
export async function createTerminal(
  taskId: string,
): Promise<TerminalTab | { error: string; notFound?: boolean }> {
  const task = tasks.get(taskId);
  if (!task) return { error: "task not found", notFound: true };

  const pending = inFlight.get(taskId) ?? 0;
  if (countTerminals(taskId) + pending >= MAX_TERMINALS_PER_TASK) {
    return { error: `terminal limit reached (${MAX_TERMINALS_PER_TASK} per task)` };
  }
  // Reserve the slot for the whole async setup so concurrent creates can't both
  // pass the cap check during the `prepareWorkdir` await (the live count below
  // doesn't move until the spawn lands).
  inFlight.set(taskId, pending + 1);
  try {
    // Dynamic import — see the top-of-file note on the db.ts ↔ worktree.ts cycle.
    const { prepareWorkdir, resolveRef } = await import("./worktree.ts");
    const prepared = await prepareWorkdir(task);
    if ("error" in prepared) return { error: prepared.error };

    // Lazy-pin baseRef and persist worktree fields, exactly as startTask does,
    // so the terminal and any future agent run share one branch/worktree.
    if (!task.baseRef && prepared.worktreePath) {
      const sha = await resolveRef(task.workdir, "HEAD");
      if (sha) tasks.update(taskId, { baseRef: sha });
    }
    if (
      prepared.worktreePath
      && (task.worktreePath !== prepared.worktreePath || task.branch !== prepared.branch)
    ) {
      tasks.update(taskId, { branch: prepared.branch, worktreePath: prepared.worktreePath });
    }

    const id = randomUUID();
    const shell = process.env.SHELL || "/bin/zsh";
    // Monotonic label number (never collides, never reused after a close).
    const seq = (labelSeq.get(taskId) ?? 0) + 1;
    labelSeq.set(taskId, seq);

    const entry: TerminalEntry = {
      id,
      taskId,
      title: `Terminal ${seq}`,
      cwd: prepared.cwd,
      createdAt: Date.now(),
      // proc/term filled in immediately after spawn below.
      proc: undefined as unknown as Bun.Subprocess,
      term: undefined as unknown as Bun.Terminal,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      buffer: [],
      bufferBytes: 0,
      sockets: new Set(),
      exited: false,
      exitCode: null,
    };

    const proc = Bun.spawn([shell, "-l"], {
      cwd: prepared.cwd,
      // Inherit the user's env; force a sane TERM so colors/cursor work in xterm.
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        data: (_t, data) => {
          // Copy: Bun may reuse the backing buffer for the next read.
          const chunk = new Uint8Array(data);
          appendToBuffer(entry, chunk);
          broadcast(entry, chunk);
        },
      },
    });
    entry.proc = proc;
    entry.term = proc.terminal!;
    terminals.set(id, entry);

    // The PTY `exit` callback reports stream lifecycle, not the child's code;
    // use the real process exit for that, then tear the tab down.
    void proc.exited.then((code) => {
      entry.exited = true;
      entry.exitCode = typeof code === "number" ? code : null;
      notifyExit(entry);
      terminals.delete(id);
    });

    return toTab(entry);
  } finally {
    const cur = inFlight.get(taskId) ?? 1;
    if (cur <= 1) inFlight.delete(taskId);
    else inFlight.set(taskId, cur - 1);
  }
}

export function listTerminals(taskId: string): TerminalTab[] {
  const out: TerminalTab[] = [];
  for (const e of terminals.values()) {
    if (e.taskId === taskId) out.push(toTab(e));
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export function countTerminals(taskId: string): number {
  let n = 0;
  for (const e of terminals.values()) if (e.taskId === taskId) n++;
  return n;
}

/** Grouped counts of open terminals across every task in one pass over the
 *  in-memory map — used by `tasks.list()` so the 2s `/tasks` poll does a
 *  single scan instead of calling `countTerminals` per task row. */
export function terminalCountsByTask(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of terminals.values()) {
    counts.set(e.taskId, (counts.get(e.taskId) ?? 0) + 1);
  }
  return counts;
}

export function getTerminal(id: string): TerminalTab | null {
  const e = terminals.get(id);
  return e ? toTab(e) : null;
}

export function writeTerminal(id: string, data: string | Uint8Array): boolean {
  const e = terminals.get(id);
  if (!e || e.exited) return false;
  e.term.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const e = terminals.get(id);
  if (!e || e.exited) return false;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return false;
  e.cols = Math.floor(cols);
  e.rows = Math.floor(rows);
  e.term.resize(e.cols, e.rows);
  return true;
}

/** Explicit close (tab X button). Kills the shell and drops the tab. */
export function closeTerminal(id: string): boolean {
  const e = terminals.get(id);
  if (!e) return false;
  for (const ws of e.sockets) {
    if (ws.readyState === 1) ws.close();
  }
  e.sockets.clear();
  try { e.term.close(); } catch { /* already closed */ }
  try { e.proc.kill(); } catch { /* already exited */ }
  terminals.delete(id);
  return true;
}

/** Tear down every terminal for a task. Called from `deleteTask` BEFORE the
 *  worktree is removed so no shell is still holding the directory open.
 *  Awaits the shells' actual exit (bounded) so the subsequent
 *  `git worktree remove` isn't racing a process still cwd'd inside it. */
export async function killTerminalsForTask(taskId: string): Promise<void> {
  const exits: Promise<number>[] = [];
  for (const e of [...terminals.values()]) {
    if (e.taskId !== taskId) continue;
    exits.push(e.proc.exited);
    closeTerminal(e.id);
  }
  labelSeq.delete(taskId);
  inFlight.delete(taskId);
  // Never block delete indefinitely if a shell ignores the signal.
  if (exits.length) await Promise.race([Promise.all(exits), Bun.sleep(2000)]);
}

/** Attach a WebSocket to a terminal: replay recent output, then stream live. */
export function attachSocket(id: string, ws: TerminalWebSocket): boolean {
  const e = terminals.get(id);
  if (!e) return false;
  e.sockets.add(ws);
  if (e.bufferBytes > 0) ws.sendBinary(snapshotBuffer(e));
  if (e.exited) ws.send(JSON.stringify({ t: "exit", code: e.exitCode }));
  return true;
}

export function detachSocket(id: string, ws: TerminalWebSocket): void {
  terminals.get(id)?.sockets.delete(ws);
}
