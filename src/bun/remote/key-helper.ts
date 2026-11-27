/**
 * The real key-helper client: a long-lived child process speaking JSON lines on stdin and stdout (docs/plans/remote-readiness.md §3.3).
 *
 * - Started through `coreSpawn` (disclaimed, scrubbed env) from either core, lazily on the first call, and restarted lazily after a crash.
 * - One request map with a per-command timeout. A crash or an exit rejects every in-flight call with `helper-crashed`; the next call
 *   spawns a fresh helper.
 * - It never logs a request or a response (keys, hashes, names and the pairing secret all pass through it); the pairing secret is
 *   registered as a log secret by the caller that holds it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fromHex, toHex } from "@agetor/remote-protocol/bytes";
import { isRemoteLevel, type RemoteLevel } from "@agetor/remote-protocol/levels";
import { childEnv, coreSpawn } from "../core-spawn.ts";
import {
  KeyHelperError,
  type KeyHelper,
  type KeyHelperErrorCode,
  type KeyHelperEvent,
  type KeyHelperStatus,
  type PairBeginArgs,
  type PairBeginResult,
  type PairCompleteArgs,
  type PairCompleteResult,
} from "./key-helper-api.ts";

/** Per-command timeouts, ms. `pair-complete` waits for the owner (until the window expires, plus a margin). */
export interface KeyHelperTimeouts {
  status: number;
  dh: number;
  revoked: number;
  revoke: number;
  "revoke-all": number;
  "pair-begin": number;
  "pair-cancel": number;
  /** Added to the time left in the pairing window while `pair-complete` waits for the owner. */
  pairCompleteMarginMs: number;
  /** Used when `pair-complete` is called without a prior `pair-begin` (it will fail with `cancelled`, but must not hang). */
  pairCompleteFallbackMs: number;
}

export const KEY_HELPER_TIMEOUTS_MS: KeyHelperTimeouts = {
  status: 10_000,
  dh: 5_000,
  revoked: 5_000,
  revoke: 5_000,
  "revoke-all": 10_000,
  "pair-begin": 10_000,
  "pair-cancel": 5_000,
  pairCompleteMarginMs: 30_000,
  /** Used when `pair-complete` is called without a prior `pair-begin` (it will fail with `cancelled`, but must not hang). */
  pairCompleteFallbackMs: 150_000,
};

/** The helper executable inside the packaged app, mirroring notifier.ts: `Contents/Resources/app/bin/AgetorKeyHelper.app/…`. */
function bundledKeyHelperExe(): string {
  return path.join(path.dirname(process.execPath), "..", "Resources", "app", "bin", "AgetorKeyHelper.app", "Contents", "MacOS", "keyhelper");
}

/** The locally built helper (`bun run vendor:keyhelper`), used when running from source. */
function devKeyHelperExe(): string {
  return path.join(import.meta.dir, "..", "..", "..", "vendor", "keyhelper", "AgetorKeyHelper.app", "Contents", "MacOS", "keyhelper");
}

export function resolveKeyHelper(exists: (p: string) => boolean = existsSync): string | null {
  for (const candidate of [bundledKeyHelperExe(), devKeyHelperExe()]) if (exists(candidate)) return candidate;
  return null;
}

interface Pending {
  cmd: string;
  resolve(result: Record<string, unknown>): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelperProc {
  stdin: { write(data: string): unknown; flush?(): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(sig?: number | NodeJS.Signals): void;
}

export interface RealKeyHelperDeps {
  /** The helper executable, or null. Default: the bundled path, then the dev path. */
  resolveBin?: () => string | null;
  /** Spawn the helper. Default: `coreSpawn` with piped stdin/stdout. A test injects a stub. */
  spawn?: (bin: string) => HelperProc;
  timeouts?: Partial<KeyHelperTimeouts>;
}

function defaultSpawn(bin: string): HelperProc {
  return coreSpawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: childEnv({}) }) as unknown as HelperProc;
}

const ERROR_CODES: ReadonlySet<string> = new Set<KeyHelperErrorCode>([
  "no-secure-enclave", "keychain-unavailable", "wrong-code", "expired", "cancelled", "auth-failed", "busy", "bad-args", "bad-json",
  "line-too-long", "unknown-command", "internal",
]);

export class RealKeyHelper implements KeyHelper {
  private proc: HelperProc | null = null;
  private starting = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: KeyHelperEvent) => void>();
  private pairingExpiresAt: number | null = null;
  private closed = false;
  private readonly resolveBin: () => string | null;
  private readonly spawn: (bin: string) => HelperProc;
  private readonly timeouts: KeyHelperTimeouts;

  constructor(deps: RealKeyHelperDeps = {}) {
    this.resolveBin = deps.resolveBin ?? (() => resolveKeyHelper());
    this.spawn = deps.spawn ?? defaultSpawn;
    this.timeouts = { ...KEY_HELPER_TIMEOUTS_MS, ...deps.timeouts };
  }

  /** True when a helper executable resolves (status shows `helper-missing` otherwise). */
  available(): boolean {
    return this.resolveBin() !== null;
  }

  private ensure(): HelperProc {
    if (this.closed) throw new KeyHelperError("closed", "the key helper client is closed");
    if (this.proc) return this.proc;
    const bin = this.resolveBin();
    if (!bin) throw new KeyHelperError("helper-missing", "the key helper is not installed in this build");
    let proc: HelperProc;
    try {
      proc = this.spawn(bin);
    } catch {
      throw new KeyHelperError("helper-missing", "the key helper could not be started");
    }
    this.proc = proc;
    void this.readLoop(proc);
    void proc.exited.then(
      () => this.onExit(proc),
      () => this.onExit(proc),
    );
    return proc;
  }

  private onExit(proc: HelperProc): void {
    if (this.proc === proc) this.proc = null;
    const err = new KeyHelperError("helper-crashed", "the key helper exited");
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
    this.pairingExpiresAt = null;
  }

  private async readLoop(proc: HelperProc): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.onLine(line);
        }
        if (buf.length > 1_000_000) throw new Error("helper line too long");
      }
    } catch {
      // A broken pipe or an oversize line: the helper is treated as crashed (onExit rejects what is in flight).
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; event?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // a non-JSON line (a stray log line) is ignored, never trusted
    }
    if (typeof msg.event === "string") {
      if (msg.event === "window-closed" || msg.event === "pairing-cancelled") {
        this.pairingExpiresAt = null;
        for (const fn of [...this.listeners]) {
          try {
            fn(msg.event);
          } catch {
            /* a listener must not break the others */
          }
        }
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok === true && msg.result && typeof msg.result === "object") return p.resolve(msg.result as Record<string, unknown>);
    const code = typeof msg.error?.code === "string" && ERROR_CODES.has(msg.error.code) ? (msg.error.code as KeyHelperErrorCode) : "internal";
    p.reject(new KeyHelperError(code, typeof msg.error?.message === "string" ? msg.error.message.slice(0, 200) : code));
  }

  private call(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    let proc: HelperProc;
    try {
      proc = this.ensure();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KeyHelperError("timeout", `the key helper did not answer ${cmd} in time`));
      }, timeoutMs);
      this.pending.set(id, { cmd, resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
        proc.stdin.flush?.();
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new KeyHelperError("helper-crashed", "the key helper's stdin is closed"));
      }
    });
  }

  async status(): Promise<KeyHelperStatus> {
    const r = await this.call("status", {}, this.timeouts.status);
    return { version: String(r.version), secureEnclave: true, corePub: fromHex(String(r.corePub)), registryPub: fromHex(String(r.registryPub)) };
  }

  async dh(peerPub: Uint8Array): Promise<Uint8Array> {
    const r = await this.call("dh", { peerPub: toHex(peerPub) }, this.timeouts.dh);
    return fromHex(String(r.shared));
  }

  async revoked(): Promise<string[]> {
    return ((await this.call("revoked", {}, this.timeouts.revoked)).ids as string[]) ?? [];
  }

  async revoke(id: string): Promise<string[]> {
    return ((await this.call("revoke", { id }, this.timeouts.revoke)).ids as string[]) ?? [];
  }

  async revokeAll(): Promise<{ ids: string[]; corePub: Uint8Array }> {
    const r = await this.call("revoke-all", {}, this.timeouts["revoke-all"]);
    return { ids: (r.ids as string[]) ?? [], corePub: fromHex(String(r.corePub)) };
  }

  async pairBegin(args: PairBeginArgs): Promise<PairBeginResult> {
    const r = await this.call("pair-begin", { ...args }, this.timeouts["pair-begin"]);
    this.pairingExpiresAt = args.expiresAt;
    return { pairingSecret: fromHex(String(r.pairingSecret)), qr: String(r.qr) };
  }

  async pairComplete(args: PairCompleteArgs): Promise<PairCompleteResult> {
    const wait = this.pairingExpiresAt !== null ? Math.max(1000, this.pairingExpiresAt - Date.now()) + this.timeouts.pairCompleteMarginMs : this.timeouts.pairCompleteFallbackMs;
    const r = await this.call(
      "pair-complete",
      {
        handshakeHash: toHex(args.handshakeHash),
        deviceId: args.deviceId,
        name: args.name,
        platform: args.platform,
        appVersion: args.appVersion,
        sessionPub: toHex(args.sessionPub),
        approvePub: toHex(args.approvePub),
        pushPub: toHex(args.pushPub),
        enrolledAt: args.enrolledAt,
      },
      wait,
    );
    this.pairingExpiresAt = null;
    if (!isRemoteLevel(r.level)) throw new KeyHelperError("internal", "the helper returned an unknown level");
    return { level: r.level as RemoteLevel, entry: String(r.entry), sig: fromHex(String(r.sig)) };
  }

  async pairCancel(): Promise<void> {
    if (!this.proc) return;
    await this.call("pair-cancel", {}, this.timeouts["pair-cancel"]).catch(() => undefined);
    this.pairingExpiresAt = null;
  }

  onEvent(fn: (e: KeyHelperEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    const err = new KeyHelperError("closed", "the key helper client was closed");
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
    try {
      proc?.stdin.end?.();
      proc?.kill();
    } catch {
      /* already gone */
    }
  }
}

export function createRealKeyHelper(deps: RealKeyHelperDeps = {}): RealKeyHelper {
  return new RealKeyHelper(deps);
}
