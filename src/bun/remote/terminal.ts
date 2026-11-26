/**
 * The phone terminal (docs/specs/remote-readiness-spec.md "Terminal", grill D17): a configure-level device, signed with its approve key,
 * attaches to a task's own tmux session as one more tmux CLIENT and mirrors it. The session itself is never touched: detaching kills the
 * client process, the session lives on.
 *
 * What it will and will not attach to: a task whose harness keeps one tmux session per task (`claude-code`), under its derived name, alive
 * on agetor's own socket. Everything else answers `no-terminal`. One phone per task: a second attach replaces the first. The input a phone
 * types is never logged and never audited (it can hold anything, including a password typed into the REPL); the audit records that an
 * attach and a detach happened, who, and for which task.
 *
 * It detaches (and tells the phone) on: the phone asking, the session closing, the phone away for 30 s, 15 minutes without input, the Mac's
 * Detach button, a task archived or deleted, a revoked device, and a phone too slow to keep up (a bounded buffer: a terminal stream that
 * lost bytes would show garbage, so it ends instead).
 */
import type { AppEvent } from "../../shared/types.ts";
import { levelAtLeast } from "@agetor/remote-protocol/levels";
import { fromBase64, toBase64 } from "@agetor/remote-protocol/bytes";
import { sessionExistsByName, sessionNameFor } from "../claude-tmux.ts";
import { coreSpawn } from "../core-spawn.ts";
import { resolveTmuxBin, tmuxSocketArgs } from "../tmux-resolution.ts";
import type { Audit } from "./audit.ts";
import { DecisionError, type Decisions } from "./decisions.ts";
import type { PhoneChannel } from "./types.ts";

export const OUTPUT_COALESCE_MS = 50;
export const OUTPUT_CHUNK_BYTES = 16 * 1024;
export const PEER_AWAY_DETACH_MS = 30_000;
export const INPUT_IDLE_DETACH_MS = 15 * 60_000;
export const MAX_PENDING_OUTPUT_BYTES = 512 * 1024;

export interface TerminalClient {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Kill the tmux client process and close the pty. Never kills the session. */
  kill(): void;
  onExit(fn: () => void): void;
}

export interface TerminalDeps {
  decisions: Pick<Decisions, "verifyTerminalAttach">;
  audit: Pick<Audit, "event">;
  task(taskId: string): Promise<{ agent: string } | null>;
  sessionName(taskId: string): string;
  sessionAlive(name: string): Promise<boolean>;
  spawnClient(sessionName: string, size: { cols: number; rows: number }, onData: (chunk: Uint8Array) => void): TerminalClient;
  broadcast?: (ev: AppEvent) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  limits?: { coalesceMs?: number; awayMs?: number; idleMs?: number; maxPending?: number };
}

export interface AttachMessage {
  id: string;
  taskId: string;
  cols: number;
  rows: number;
  payload: unknown;
  sig: string;
}

export interface AttachedTerminal {
  taskId: string;
  deviceId: string;
  deviceName: string;
  since: number;
}

interface Live {
  taskId: string;
  channel: PhoneChannel;
  client: TerminalClient;
  since: number;
  pending: Uint8Array[];
  pendingBytes: number;
  flushTimer: unknown;
  idleTimer: unknown;
  awayTimer: unknown;
  offClose: () => void;
  offPeer: () => void;
  ended: boolean;
}

export interface TerminalManager {
  attach(channel: PhoneChannel, msg: AttachMessage): Promise<void>;
  input(channel: PhoneChannel, msg: { taskId: string; data: string }): void;
  resize(channel: PhoneChannel, msg: { taskId: string; cols: number; rows: number }): void;
  detach(channel: PhoneChannel, taskId: string): void;
  /** The Mac's Detach route, a task archived or deleted. */
  detachForTask(taskId: string, reason: string): boolean;
  /** A device revoked or its session ended. */
  detachForDevice(deviceId: string, reason: string): void;
  attachedTerminals(): AttachedTerminal[];
  stop(): void;
}

export function createTerminalManager(deps: TerminalDeps): TerminalManager {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lim = { coalesceMs: OUTPUT_COALESCE_MS, awayMs: PEER_AWAY_DETACH_MS, idleMs: INPUT_IDLE_DETACH_MS, maxPending: MAX_PENDING_OUTPUT_BYTES, ...deps.limits };
  const live = new Map<string, Live>(); // by task id: one phone per task

  const fail = (channel: PhoneChannel, id: string, code: string, message: string): void => {
    channel.send("error", { id, code, message });
  };

  function flush(l: Live): void {
    l.flushTimer = null;
    if (l.ended || l.pendingBytes === 0) return;
    const all = new Uint8Array(l.pendingBytes);
    let off = 0;
    for (const p of l.pending) (all.set(p, off), (off += p.length));
    l.pending = [];
    l.pendingBytes = 0;
    for (let i = 0; i < all.length; i += OUTPUT_CHUNK_BYTES) {
      l.channel.send("terminal-output", { taskId: l.taskId, data: toBase64(all.subarray(i, i + OUTPUT_CHUNK_BYTES)) }, { heavy: true });
    }
  }

  function onData(l: Live, chunk: Uint8Array): void {
    if (l.ended) return;
    l.pending.push(chunk);
    l.pendingBytes += chunk.length;
    if (l.pendingBytes > lim.maxPending) return void end(l, "too-slow");
    if (l.flushTimer === null) l.flushTimer = setTimer(() => flush(l), lim.coalesceMs);
  }

  function armIdle(l: Live): void {
    if (l.idleTimer !== null) clearTimer(l.idleTimer);
    l.idleTimer = setTimer(() => end(l, "idle"), lim.idleMs);
  }

  function end(l: Live, reason: string): void {
    if (l.ended) return;
    flush(l); // what the phone has not seen yet, then the close notice
    l.ended = true;
    for (const t of [l.flushTimer, l.idleTimer, l.awayTimer]) if (t !== null) clearTimer(t);
    l.flushTimer = l.idleTimer = l.awayTimer = null;
    l.offClose();
    l.offPeer();
    if (live.get(l.taskId) === l) live.delete(l.taskId);
    try {
      l.client.kill();
    } catch {
      /* already gone */
    }
    try {
      l.channel.send("terminal-closed", { taskId: l.taskId, reason });
    } catch {
      /* the channel is closed */
    }
    const p = l.channel.principal;
    void deps.audit.event("terminal-detach", { deviceId: p.deviceId, target: { taskId: l.taskId }, resultCode: reason }).catch(() => undefined);
    deps.broadcast?.({ type: "phone_terminal", taskId: l.taskId, deviceId: p.deviceId, deviceName: p.deviceName, attached: false, since: l.since, ts: now() });
  }

  return {
    async attach(channel, msg) {
      const p = channel.principal;
      if (!levelAtLeast(p.level, "configure")) return fail(channel, msg.id, "level", "the terminal needs a configure-level device");
      const task = await deps.task(msg.taskId);
      const name = deps.sessionName(msg.taskId);
      if (!task || task.agent !== "claude-code" || !(await deps.sessionAlive(name))) return fail(channel, msg.id, "no-terminal", "this task has no terminal to attach to");
      try {
        await deps.decisions.verifyTerminalAttach(p, { payload: msg.payload, sig: msg.sig }, { kind: "terminal", taskId: msg.taskId, tmuxSession: name });
      } catch (e) {
        void deps.audit.event("refusal", { deviceId: p.deviceId, resultCode: e instanceof DecisionError ? e.code : "signature", target: { taskId: msg.taskId, op: "terminal-attach" } }).catch(() => undefined);
        return fail(channel, msg.id, e instanceof DecisionError ? e.code : "signature", "the attach was not accepted");
      }
      // One phone per task: the earlier one is told it was replaced.
      const earlier = live.get(msg.taskId);
      if (earlier) end(earlier, "replaced");

      const l: Live = {
        taskId: msg.taskId, channel, client: null as unknown as TerminalClient, since: now(), pending: [], pendingBytes: 0,
        flushTimer: null, idleTimer: null, awayTimer: null, offClose: () => undefined, offPeer: () => undefined, ended: false,
      };
      try {
        l.client = deps.spawnClient(name, { cols: msg.cols, rows: msg.rows }, (chunk) => onData(l, chunk));
      } catch {
        return fail(channel, msg.id, "no-terminal", "the terminal could not be attached");
      }
      live.set(msg.taskId, l);
      l.client.onExit(() => end(l, "exited"));
      l.offClose = channel.onClose((reason) => end(l, `session-${reason}`));
      l.offPeer = channel.onPeerChange((present) => {
        if (present) {
          if (l.awayTimer !== null) clearTimer(l.awayTimer);
          l.awayTimer = null;
        } else if (l.awayTimer === null) {
          l.awayTimer = setTimer(() => end(l, "phone-away"), lim.awayMs);
        }
      });
      if (!channel.peerPresent()) l.awayTimer = setTimer(() => end(l, "phone-away"), lim.awayMs);
      armIdle(l);
      channel.send("terminal-attached", { id: msg.id, taskId: msg.taskId });
      await deps.audit.event("terminal-attach", { deviceId: p.deviceId, sessionHash: Buffer.from(p.sessionHash).toString("hex"), target: { taskId: msg.taskId } }).catch(() => undefined);
      deps.broadcast?.({ type: "phone_terminal", taskId: msg.taskId, deviceId: p.deviceId, deviceName: p.deviceName, attached: true, since: l.since, ts: now() });
      // `remote_action` too, so the Mac's toast says it: "<phone> attached to <task>'s terminal".
      deps.broadcast?.({ type: "remote_action", taskId: msg.taskId, deviceName: p.deviceName, action: "terminal-attached", ts: now() });
    },

    input(channel, msg) {
      const l = live.get(msg.taskId);
      if (!l || l.ended || l.channel.principal.sessionId !== channel.principal.sessionId) return;
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(msg.data);
      } catch {
        return;
      }
      armIdle(l);
      l.client.write(bytes); // never logged, never audited
    },

    resize(channel, msg) {
      const l = live.get(msg.taskId);
      if (!l || l.ended || l.channel.principal.sessionId !== channel.principal.sessionId) return;
      l.client.resize(msg.cols, msg.rows);
    },

    detach(channel, taskId) {
      const l = live.get(taskId);
      if (l && l.channel.principal.sessionId === channel.principal.sessionId) end(l, "detached");
    },

    detachForTask(taskId, reason) {
      const l = live.get(taskId);
      if (!l) return false;
      end(l, reason);
      return true;
    },

    detachForDevice(deviceId, reason) {
      for (const l of [...live.values()]) if (l.channel.principal.deviceId === deviceId) end(l, reason);
    },

    attachedTerminals: () => [...live.values()].map((l) => ({ taskId: l.taskId, deviceId: l.channel.principal.deviceId, deviceName: l.channel.principal.deviceName, since: l.since })),

    stop() {
      for (const l of [...live.values()]) end(l, "stopped");
    },
  };
}

/** The live deps: tmux on agetor's own socket, through `coreSpawn` (the disclaim wrapper and the scrubbed env). */
export function createLiveTerminalDeps(): Pick<TerminalDeps, "task" | "sessionName" | "sessionAlive" | "spawnClient"> {
  return {
    async task(taskId) {
      const t = await (await import("../db-async.ts")).tasks.get(taskId);
      return t ? { agent: t.agent } : null;
    },
    sessionName: sessionNameFor,
    sessionAlive: sessionExistsByName,
    spawnClient(name, size, onData) {
      const proc = coreSpawn([resolveTmuxBin(), ...tmuxSocketArgs(), "attach-session", "-t", "=" + name], {
        env: { TERM: "xterm-256color" },
        terminal: { cols: size.cols, rows: size.rows, data: (_t: unknown, data: Uint8Array) => onData(new Uint8Array(data)) },
      });
      const term = proc.terminal!;
      return {
        write: (d) => void term.write(d),
        resize: (c, r) => term.resize(c, r),
        kill: () => {
          try {
            proc.kill();
          } catch {
            /* already exited */
          }
          try {
            term.close();
          } catch {
            /* already closed */
          }
        },
        onExit: (fn) => void proc.exited.then(() => fn()),
      };
    },
  };
}
