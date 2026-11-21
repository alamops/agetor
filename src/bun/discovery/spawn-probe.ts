/**
 * Child-process helpers shared by the per-kind model probes in this folder.
 * A leaf like `agent-discovery.ts`: only `core-spawn` and `shared/*`.
 *
 * Every spawn goes through `coreSpawn` with `childEnv(...)` (the probed CLI,
 * or anything earlier on PATH, is agent-plantable, and the master token must
 * not reach it).
 */

import type { Subprocess } from "bun";
import { childEnv, coreSpawn } from "../core-spawn.ts";

/**
 * The most stdout a probe reads (one unbroken line for a JSON-line session,
 * the whole output for `runCapture`). Far above any real catalog (a claude
 * `initialize` reply, a gemini model list), so a CLI or a wrapper earlier on
 * PATH that streams without end can't grow the core's memory on the shared
 * main thread until the budget fires: past it the child is killed and the
 * probe answers nothing.
 */
export const PROBE_STDOUT_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Drive a line-oriented JSON child (one JSON object per line each way) to a
 * single answer: spawn `cmd`, let `start` write the opening request(s), hand
 * every parsed stdout line to `onMessage`, and stop on `"done"`, child exit
 * or the budget. The child is always killed and its stdout reader cancelled
 * in `finally`: a grandchild that inherited the pipe would otherwise keep
 * this process's end of it (and so its event loop) alive — the same
 * leak-safety pattern as `discoverCodex`.
 *
 * Never throws: a spawn failure resolves like an immediate exit. A line that
 * is not JSON is ignored. `timedOut` is true only when the budget fired.
 */
export async function runJsonLineSession(opts: {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  start(write: (obj: unknown) => void): void;
  onMessage(msg: unknown, write: (obj: unknown) => void): "done" | void;
}): Promise<{ timedOut: boolean }> {
  let proc: Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = coreSpawn(opts.cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: childEnv(opts.env),
    }) as Subprocess<"pipe", "pipe", "ignore">;
  } catch {
    return { timedOut: false };
  }

  let timedOut = false;
  let killed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    try { proc.kill(); } catch { /* already exited */ }
  };
  const write = (obj: unknown): void => {
    try {
      // FileSink.write may return a Promise (a broken pipe rejects it later).
      void Promise.resolve(proc.stdin.write(`${JSON.stringify(obj)}\n`)).catch(() => {});
      // flush() may return a Promise too: a broken pipe rejects it, same as write.
      void Promise.resolve(proc.stdin.flush()).catch(() => {});
    } catch { /* the child closed its stdin */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
    // Release a read that a grandchild's open pipe would never end.
    try { void reader?.cancel(); } catch { /* already released */ }
  }, opts.timeoutMs);

  try {
    opts.start(write);
    reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const dispatch = (line: string): boolean => {
      if (!line.trim()) return false;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return false; }
      return opts.onMessage(msg, write) === "done";
    };
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (dispatch(line)) { buf = ""; break outer; }
      }
      // An unbroken line past the cap is no answer.
      if (buf.length > PROBE_STDOUT_CAP_BYTES) { buf = ""; break; }
    }
    // A reply that never got its trailing newline.
    if (buf.trim()) dispatch(buf);
  } catch {
    /* a stream error degrades to "no answer" */
  } finally {
    clearTimeout(timer);
    kill();
    try { void reader?.cancel(); } catch { /* already released */ }
  }
  return { timedOut };
}

/**
 * Run `cmd` to completion and capture stdout (stderr ignored). Resolves
 * `{ ok: false }` on a spawn failure, timeout or non-zero exit. Never throws.
 */
export async function runCapture(
  cmd: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number },
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = coreSpawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: childEnv(opts.env),
    }) as Subprocess<"ignore", "pipe", "ignore">;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already exited */ }
    }, opts.timeoutMs);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let overflowed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PROBE_STDOUT_CAP_BYTES) {
          overflowed = true;
          try { proc.kill(); } catch { /* already exited */ }
          break;
        }
        chunks.push(value);
      }
      const stdout = overflowed ? "" : Buffer.concat(chunks).toString("utf8");
      await proc.exited;
      return { ok: !timedOut && !overflowed && proc.exitCode === 0, stdout };
    } finally {
      clearTimeout(timer);
      // Release a read that a grandchild's open pipe would never end.
      try { void reader.cancel(); } catch { /* already released */ }
    }
  } catch {
    return { ok: false, stdout: "" };
  }
}
