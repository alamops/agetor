/**
 * A fake key helper for tests and the headless client (docs/specs/remote-readiness-spec.md "Tests, CI and review", grill D4).
 *
 * It keeps the keys in memory (or in `AGETOR_FAKE_KEY_HELPER_DIR` when set, so a core in another process and the test share one
 * identity), answers `dh` with the real X25519, signs registry entries with a real P-256 key through noble, keeps an append-only
 * revocation list, and runs the pairing "window" as a state machine the test drives: the code typed, the level chosen, the
 * Configure confirmation, Touch ID granted or denied, the window closed. It returns the same error codes as the real helper.
 *
 * Reachable only through the seam guard in `key-helper-api.ts` (`!RELEASE_BUILD && remoteSeamsAllowed && AGETOR_FAKE_KEY_HELPER=1`)
 * or by a test constructing it directly. Dead code in a release bundle.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fromHex, randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { canonicalize } from "@agetor/remote-protocol/canonical-json";
import { PAIRING_TTL_MS } from "@agetor/remote-protocol/constants";
import { mailboxId, pairingMailboxKey, sasCode } from "@agetor/remote-protocol/derive";
import { signEs256 } from "@agetor/remote-protocol/es256";
import { isRemoteLevel, type RemoteLevel } from "@agetor/remote-protocol/levels";
import { encodeQr } from "@agetor/remote-protocol/qr";
import {
  KeyHelperError,
  type KeyHelper,
  type KeyHelperEvent,
  type KeyHelperStatus,
  type PairBeginArgs,
  type PairBeginResult,
  type PairCompleteArgs,
  type PairCompleteResult,
} from "./key-helper-api.ts";

export interface FakeKeyHelperOptions {
  /** Persist the keys and lists here (and read `pairing-control.json` from here for a core in another process). */
  dir?: string;
  now?: () => number;
}

/** What the test "does in the window". */
interface ControlState {
  codes: string[];
  level: RemoteLevel;
  confirmConfigure: boolean | null;
  deny: boolean;
  closed: boolean;
}

const freshControl = (): ControlState => ({ codes: [], level: "respond", confirmConfigure: null, deny: false, closed: false });
let control: ControlState = freshControl();

/**
 * Test controls for an in-process core. `enterCode` types a code into the window (three wrong ones end the pairing); `chooseLevel` picks
 * the level (Respond by default); `confirmConfigure` answers the second sheet Configure needs; `deny` refuses Touch ID; `closeWindow`
 * is the red button. State is consumed by the `pairComplete` in flight, or kept for the next one.
 */
export const fakeKeyHelperControl = {
  enterCode(code: string): void {
    control.codes.push(code);
  },
  chooseLevel(level: RemoteLevel): void {
    control.level = level;
  },
  confirmConfigure(yes = true): void {
    control.confirmConfigure = yes;
  },
  deny(): void {
    control.deny = true;
  },
  closeWindow(): void {
    control.closed = true;
  },
  reset(): void {
    control = freshControl();
  },
};

interface Window {
  secret: Uint8Array;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Settles the pairComplete in flight, if any. */
  fail?: (e: KeyHelperError) => void;
}

export class FakeKeyHelper implements KeyHelper {
  private corePriv: Uint8Array;
  private registryPriv: Uint8Array;
  private revokedList: string[] = [];
  private signedList: string[] = [];
  private window: Window | null = null;
  private readonly listeners = new Set<(e: KeyHelperEvent) => void>();
  private readonly dir: string | undefined;
  private readonly now: () => number;
  private closed = false;
  /** Count of `dh` calls: a test asserts one per handshake. */
  dhCalls = 0;

  constructor(opts: FakeKeyHelperOptions = {}) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    const stored = this.load();
    this.corePriv = stored?.corePriv ?? x25519.utils.randomSecretKey();
    this.registryPriv = stored?.registryPriv ?? p256.utils.randomSecretKey();
    this.revokedList = stored?.revoked ?? [];
    this.signedList = stored?.signed ?? [];
    this.save();
  }

  private file(): string | null {
    return this.dir ? path.join(this.dir, "keyhelper-state.json") : null;
  }

  private load(): { corePriv: Uint8Array; registryPriv: Uint8Array; revoked: string[]; signed: string[] } | null {
    const f = this.file();
    if (!f || !existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { corePriv: string; registryPriv: string; revoked: string[]; signed: string[] };
      return { corePriv: fromHex(j.corePriv), registryPriv: fromHex(j.registryPriv), revoked: j.revoked, signed: j.signed };
    } catch {
      return null;
    }
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ corePriv: toHex(this.corePriv), registryPriv: toHex(this.registryPriv), revoked: this.revokedList, signed: this.signedList }), { mode: 0o600 });
    renameSync(tmp, f);
  }

  private emit(e: KeyHelperEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        /* a listener must not break the others */
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new KeyHelperError("closed", "the fake helper is closed");
  }

  async status(): Promise<KeyHelperStatus> {
    this.assertOpen();
    return { version: "fake-1", secureEnclave: true, corePub: x25519.getPublicKey(this.corePriv), registryPub: p256.getPublicKey(this.registryPriv, false) };
  }

  async dh(peerPub: Uint8Array): Promise<Uint8Array> {
    this.assertOpen();
    this.dhCalls++;
    try {
      const shared = x25519.getSharedSecret(this.corePriv, peerPub);
      if (shared.every((b) => b === 0)) throw new Error("low order");
      return shared;
    } catch {
      throw new KeyHelperError("bad-args", "peerPub is not a valid X25519 key");
    }
  }

  async revoked(): Promise<string[]> {
    this.assertOpen();
    return [...this.revokedList];
  }

  async revoke(id: string): Promise<string[]> {
    this.assertOpen();
    if (!/^[0-9a-f]{32}$/.test(id)) throw new KeyHelperError("bad-args", "id must be 32 hex characters");
    // Append-only: there is no way to remove an id.
    if (!this.revokedList.includes(id)) this.revokedList.push(id);
    this.save();
    return [...this.revokedList];
  }

  async revokeAll(): Promise<{ ids: string[]; corePub: Uint8Array }> {
    this.assertOpen();
    for (const id of this.signedList) if (!this.revokedList.includes(id)) this.revokedList.push(id);
    this.corePriv = x25519.utils.randomSecretKey();
    this.save();
    return { ids: [...this.revokedList], corePub: x25519.getPublicKey(this.corePriv) };
  }

  async pairBegin(args: PairBeginArgs): Promise<PairBeginResult> {
    this.assertOpen();
    if (this.window) throw new KeyHelperError("busy", "a pairing window is already open");
    const now = this.now();
    if (!(args.expiresAt > now) || args.expiresAt - now > 10 * 60 * 1000) throw new KeyHelperError("bad-args", "expiresAt must be within 10 minutes");
    const secret = randomBytes(32);
    const corePub = x25519.getPublicKey(this.corePriv);
    const qr = encodeQr({
      fmt: 1,
      corePub: toHex(corePub),
      relayUrl: args.relayUrl,
      mailbox: toHex(mailboxId(pairingMailboxKey(secret))),
      pairingSecret: toHex(secret),
      expiresAt: args.expiresAt,
    });
    control = freshControl();
    const win: Window = { secret, expiresAt: args.expiresAt, timer: setTimeout(() => this.expire(), Math.max(1, args.expiresAt - now)) };
    this.window = win;
    return { pairingSecret: secret.slice(), qr };
  }

  private expire(): void {
    const win = this.window;
    if (!win) return;
    this.closeWindow();
    win.fail?.(new KeyHelperError("expired", "the pairing window expired"));
    this.emit("pairing-cancelled");
  }

  private closeWindow(): void {
    const win = this.window;
    if (!win) return;
    clearTimeout(win.timer);
    win.secret.fill(0);
    this.window = null;
  }

  async pairComplete(args: PairCompleteArgs): Promise<PairCompleteResult> {
    this.assertOpen();
    const win = this.window;
    if (!win) throw new KeyHelperError("cancelled", "no pairing window is open");
    if (win.fail) throw new KeyHelperError("busy", "a pairing is already in progress");
    if (this.now() >= win.expiresAt) {
      this.closeWindow();
      throw new KeyHelperError("expired", "the pairing window expired");
    }
    const expected = sasCode(args.handshakeHash);
    return await new Promise<PairCompleteResult>((resolve, reject) => {
      let wrong = 0;
      let poll: ReturnType<typeof setInterval>;
      const finish = (fn: () => void) => {
        clearInterval(poll);
        win.fail = undefined;
        fn();
      };
      win.fail = (e) => finish(() => reject(e));
      const fail = (code: ConstructorParameters<typeof KeyHelperError>[0], message: string) => {
        this.closeWindow();
        this.emit("pairing-cancelled");
        finish(() => reject(new KeyHelperError(code, message)));
      };
      let codeOk = false;
      const step = () => {
        this.readControlFile();
        if (control.closed) {
          this.closeWindow();
          this.emit("window-closed");
          return finish(() => reject(new KeyHelperError("cancelled", "the pairing window was closed")));
        }
        if (!this.window) return;
        while (!codeOk && control.codes.length > 0) {
          const typed = control.codes.shift()!;
          if (typed === expected) codeOk = true;
          else if (++wrong >= 3) return fail("wrong-code", "the code was wrong three times");
        }
        if (!codeOk) return;
        const level = isRemoteLevel(control.level) ? control.level : "respond";
        if (level === "configure" && control.confirmConfigure !== true) {
          if (control.confirmConfigure === false) return fail("cancelled", "Configure was not confirmed");
          return; // the second sheet is still up
        }
        if (control.deny) return fail("auth-failed", "authentication was not completed");
        const entry = canonicalize({
          id: args.deviceId,
          name: args.name,
          platform: args.platform,
          session_pub: toHex(args.sessionPub),
          approve_pub: toHex(args.approvePub),
          push_pub: toHex(args.pushPub),
          level,
          enrolled_at: args.enrolledAt,
        });
        // Recorded as signed BEFORE the signature leaves, so Revoke all always covers it.
        if (!this.signedList.includes(args.deviceId)) this.signedList.push(args.deviceId);
        this.save();
        const sig = signEs256(this.registryPriv, new TextEncoder().encode(entry));
        this.closeWindow();
        finish(() => resolve({ level, entry, sig }));
      };
      poll = setInterval(step, 5);
      step();
    });
  }

  /** A core in another process: the test drops `<dir>/pairing-control.json`; it is read once and deleted. */
  private readControlFile(): void {
    if (!this.dir) return;
    const f = path.join(this.dir, "pairing-control.json");
    if (!existsSync(f)) return;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { code?: string; codes?: string[]; level?: RemoteLevel; confirmConfigure?: boolean; deny?: boolean; closeWindow?: boolean };
      rmSync(f, { force: true });
      if (typeof j.code === "string") control.codes.push(j.code);
      for (const c of j.codes ?? []) control.codes.push(c);
      if (j.level) control.level = j.level;
      if (typeof j.confirmConfigure === "boolean") control.confirmConfigure = j.confirmConfigure;
      if (j.deny) control.deny = true;
      if (j.closeWindow) control.closed = true;
    } catch {
      /* a half-written file is read on the next tick */
    }
  }

  async pairCancel(): Promise<void> {
    if (!this.window) return;
    const win = this.window;
    this.closeWindow();
    win.fail?.(new KeyHelperError("cancelled", "pairing was cancelled"));
    this.emit("pairing-cancelled");
  }

  onEvent(fn: (e: KeyHelperEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    const win = this.window;
    this.closeWindow();
    win?.fail?.(new KeyHelperError("closed", "the fake helper is closed"));
  }

  /** The window's pairing secret, for a test that plays the phone without scanning the QR. Null when no window is open. */
  windowSecret(): Uint8Array | null {
    return this.window ? this.window.secret.slice() : null;
  }

  /** Test aid: the 120 s default window the gateway asks for. */
  static readonly PAIRING_TTL_MS = PAIRING_TTL_MS;
}

export function createFakeKeyHelper(opts: FakeKeyHelperOptions = {}): FakeKeyHelper {
  return new FakeKeyHelper({ dir: process.env.AGETOR_FAKE_KEY_HELPER_DIR || undefined, ...opts });
}

/**
 * Serve a helper over JSON lines on stdin/stdout, exactly as the Swift helper does (docs/plans/remote-readiness.md §3.3). Used by the
 * conformance test: a Bun script under /tmp runs this with a `FakeKeyHelper`, so the real client is exercised against a process.
 */
export async function serveHelperOverStdio(helper: KeyHelper, io: { stdin: AsyncIterable<Uint8Array>; write(line: string): void }): Promise<void> {
  const write = (o: unknown) => io.write(JSON.stringify(o) + "\n");
  helper.onEvent((event) => write({ event }));
  const handle = async (line: string) => {
    let req: { id?: number; cmd?: string; args?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      return write({ id: null, ok: false, error: { code: "bad-json", message: "request is not JSON" } });
    }
    const id = req.id ?? null;
    const a = req.args ?? {};
    const hex = (k: string): Uint8Array => fromHex(String(a[k]));
    try {
      let result: Record<string, unknown>;
      switch (req.cmd) {
        case "status": {
          const s = await helper.status();
          result = { version: s.version, secureEnclave: true, corePub: toHex(s.corePub), registryPub: toHex(s.registryPub) };
          break;
        }
        case "dh":
          result = { shared: toHex(await helper.dh(hex("peerPub"))) };
          break;
        case "revoked":
          result = { ids: await helper.revoked() };
          break;
        case "revoke":
          result = { ids: await helper.revoke(String(a.id)) };
          break;
        case "revoke-all": {
          const r = await helper.revokeAll();
          result = { ids: r.ids, corePub: toHex(r.corePub) };
          break;
        }
        case "pair-begin": {
          const r = await helper.pairBegin({ relayUrl: String(a.relayUrl), macName: String(a.macName), expiresAt: Number(a.expiresAt) });
          result = { pairingSecret: toHex(r.pairingSecret), qr: r.qr };
          break;
        }
        case "pair-complete": {
          const r = await helper.pairComplete({
            handshakeHash: hex("handshakeHash"), deviceId: String(a.deviceId), name: String(a.name), platform: a.platform as "ios" | "android",
            appVersion: String(a.appVersion), sessionPub: hex("sessionPub"), approvePub: hex("approvePub"), pushPub: hex("pushPub"), enrolledAt: Number(a.enrolledAt),
          });
          result = { level: r.level, entry: r.entry, sig: toHex(r.sig) };
          break;
        }
        case "pair-cancel":
          await helper.pairCancel();
          result = {};
          break;
        default:
          return write({ id, ok: false, error: { code: "unknown-command", message: "unknown command" } });
      }
      write({ id, ok: true, result });
    } catch (e) {
      const code = e instanceof KeyHelperError ? e.code : "internal";
      write({ id, ok: false, error: { code, message: e instanceof Error ? e.message : "failed" } });
    }
  };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of io.stdin) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) void handle(line);
    }
  }
}
