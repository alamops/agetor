/**
 * Pairing (docs/specs/remote-readiness-spec.md "Pairing", grill D5; plan PA). The owner picks "Pair a Phone" in the app; the key helper
 * draws the QR in ITS OWN native window, where the owner also types the six-digit code and picks the level, and a malicious page or process
 * cannot draw over it. This module is the core half: open the window, join the pairing mailbox, run the NKpsk0 responder with the window's
 * secret, check the phone's request, hand the phone's hash and keys to the helper, verify what the helper signed, and only THEN write the
 * device row.
 *
 * Order, and why:
 *   1. refuse unless the Companion is compiled in and this is the desktop app's core (a headless core has no screen to draw the window on)
 *   2. `pairBegin` (the window and the secret); register the secret with the log redactor; open the gate so the link comes up
 *   3. NKpsk0 handshake on the pairing mailbox; the SAS both sides derive from the handshake hash is what the owner compares by eye
 *   4. the phone's `pairing-request` must parse (name cleaned) and BOTH its signatures must verify over the handshake hash: the phone proves
 *      it holds the session key and the approve key it is enrolling, and that they belong to THIS handshake (no replay)
 *   5. `pairComplete`: the owner types the code (3 tries), picks the level, touches the sensor. The helper returns the level, the canonical
 *      entry and its registry signature
 *   6. the core re-derives the entry from what it sent plus the returned level, requires it to equal the helper's, and verifies the signature
 *      with the registry key: a helper answer that does not match is refused, nothing is written
 *   7. `remote.addDevice` (the row and its `pair` audit entry in one transaction) AT THE RETURNED LEVEL, then `pairing-result`
 *   8. "<name> was paired" on the Mac, an alert to the other phones, the app event, the window closed, the mailbox retired, the secret zeroed
 *
 * Any failure writes nothing, audits a refusal, tells the phone (generically) and recomputes the gate.
 */
import { equalBytes, fromHex, randomBytes, toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { PAIRING_TTL_MS, PROLOGUE_PREFIX } from "@agetor/remote-protocol/constants";
import { coreId, mailboxId, pairingMailboxKey } from "@agetor/remote-protocol/derive";
import { Reassembler, sealStream } from "@agetor/remote-protocol/envelope";
import { verifyEs256 } from "@agetor/remote-protocol/es256";
import { ParseError, cleanDeviceName, encodeMessage, parseMessage } from "@agetor/remote-protocol/messages";
import { HandshakeState, prologue } from "@agetor/remote-protocol/noise";
import type { RemoteDeviceInsert } from "../../shared/remote-types.ts";
import type { AppEvent } from "../../shared/types.ts";
import type { Audit } from "./audit.ts";
import { KeyHelperError, type KeyHelper } from "./key-helper-api.ts";
import { registryEntryJson } from "./registry.ts";
import type { Delivered, MailboxSpec } from "./relay-link.ts";

export const PAIRING_GROUP = "pairing";
/** How long the result may take to leave the relay link before the mailbox is closed. */
const DRAIN_GRACE_MS = 3000;

export type PairingStartError = "disabled" | "not-app-core" | "relay-not-configured" | "helper-failed";

export class PairingError extends Error {
  constructor(
    readonly code: PairingStartError | KeyHelperError["code"],
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PairingError";
  }
}

export interface PairingLink {
  open(spec: MailboxSpec): void;
  close(name: string): void;
  send(name: string, mailbox: Uint8Array | null, tag: Uint8Array, payload: Uint8Array, opts?: { priority?: boolean }): boolean;
  queuedBytes(name: string): number;
}

export interface PairingDeps {
  helper: () => KeyHelper;
  link: PairingLink;
  audit: Pick<Audit, "event" | "refusal">;
  /** Write the device row and its `pair` audit entry, one transaction (op `remote.addDevice`). */
  addDevice(device: RemoteDeviceInsert, audit: { ts: number; target?: unknown }): Promise<unknown>;
  macName: () => Promise<string>;
  relayUrl: () => string | null;
  /** Whether the Companion is compiled in (`COMPANION_ENABLED`). */
  enabled: () => boolean;
  /** "app" for the desktop app's core; anything else (the headless core) cannot pair. */
  mode: () => "app" | "headless";
  /** The pairing window opened or closed: the link gate recomputes. */
  onWindowChange(open: boolean): void;
  /** An OS notification on this Mac ("<name> was paired"). */
  notify(n: { deviceId: string; title: string; body: string }): void;
  /** A push to every other device ("a phone was paired"). */
  alertOthers(newDeviceId: string, kind: "device-paired"): Promise<void>;
  broadcast(ev: AppEvent): void;
  /** Hide a string from the log (`registerLogSecret`). */
  registerSecret(s: string): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  ttlMs?: number;
}

export interface PairingStatus {
  open: boolean;
  expiresAt: number | null;
  /** Where the phone is: `waiting` (QR drawn), `handshaking`, `confirming` (the owner is in the helper's window). */
  stage: "closed" | "waiting" | "confirming";
}

export interface Pairing {
  /** Open the window. A second call while one is open returns the open one (the helper's window is already on screen). */
  start(): Promise<{ expiresAt: number; alreadyOpen: boolean }>;
  cancel(reason?: string): Promise<void>;
  /** A frame delivered on the pairing mailbox. */
  onFrame(d: Delivered): Promise<void>;
  isOpen(): boolean;
  status(): PairingStatus;
}

interface Window {
  expiresAt: number;
  secret: Uint8Array;
  mailbox: Uint8Array;
  timer: unknown;
  offEvent: () => void;
  session: {
    tag: Uint8Array;
    send: ReturnType<HandshakeState["split"]>["send"];
    recv: ReturnType<HandshakeState["split"]>["recv"];
    hash: Uint8Array;
    reassembler: Reassembler;
    stage: "request" | "confirming";
  } | null;
  /** Serializes the frames of the window. */
  chain: Promise<void>;
  closing: boolean;
  /** Resolves when the window is fully gone (its mailbox closed, the gate told). */
  closed: Promise<void>;
  markClosed: () => void;
}

export function createPairing(deps: PairingDeps): Pairing {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ttl = deps.ttlMs ?? PAIRING_TTL_MS;
  let win: Window | null = null;
  let starting: Promise<{ expiresAt: number; alreadyOpen: boolean }> | null = null;

  const refuse = (code: string, extra?: unknown): void => {
    void deps.audit.event("refusal", { target: { op: "pairing", code, extra: extra ?? null }, resultCode: code }).catch(() => undefined);
  };

  async function closeWindow(reason: string, opts: { helperCancel?: boolean; drain?: boolean } = {}): Promise<void> {
    const w = win;
    if (!w || w.closing) return;
    w.closing = true;
    clearTimer(w.timer);
    w.offEvent();
    if (opts.drain) {
      const end = now() + DRAIN_GRACE_MS;
      while (deps.link.queuedBytes(PAIRING_GROUP) > 0 && now() < end) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 150)); // the last frame left the socket; let the relay hand it on
    }
    deps.link.close(PAIRING_GROUP);
    w.secret.fill(0);
    win = null;
    deps.onWindowChange(false);
    w.markClosed();
    if (opts.helperCancel) await deps.helper().pairCancel().catch(() => undefined);
    void reason;
  }

  /**
   * The window ended for a reason that is not the phone's request failing: the time ran out, or the owner closed the helper's window.
   * A phone that is mid-handshake is told; one whose confirmation is in the helper's hands is left to that call, which settles with the
   * helper's own error a moment later (tearing the mailbox down now would drop the message that tells the phone).
   */
  function ended(w: Window, code: string): void {
    if (win !== w || w.closing) return;
    refuse(code);
    const s = w.session;
    if (s && s.stage === "confirming") {
      void deps.helper().pairCancel().catch(() => undefined);
      return;
    }
    if (s) {
      try {
        say(w, w.mailbox, "error", { id: null, code: "pairing-failed", message: "the pairing window closed" });
      } catch {
        /* unusable */
      }
      void closeWindow(code, { helperCancel: true, drain: true });
      return;
    }
    void closeWindow(code, { helperCancel: true });
  }

  async function startInner(): Promise<{ expiresAt: number; alreadyOpen: boolean }> {
    if (win?.closing) await win.closed;
    if (win) return { expiresAt: win.expiresAt, alreadyOpen: true };
    if (!deps.enabled()) throw new PairingError("disabled", "the Companion is not enabled in this build");
    if (deps.mode() !== "app") throw new PairingError("not-app-core", "pairing needs the Agetor app");
    const relayUrl = deps.relayUrl();
    if (!relayUrl) throw new PairingError("relay-not-configured", "no relay is configured");
    const expiresAt = now() + ttl;
    let begun;
    try {
      begun = await deps.helper().pairBegin({ relayUrl, macName: await deps.macName(), expiresAt });
    } catch (e) {
      throw e instanceof KeyHelperError ? new PairingError(e.code, e.message) : new PairingError("helper-failed");
    }
    deps.registerSecret(toHex(begun.pairingSecret));
    deps.registerSecret(begun.qr);
    const key = pairingMailboxKey(begun.pairingSecret);
    let markClosed!: () => void;
    const closed = new Promise<void>((r) => (markClosed = r));
    const w: Window = {
      expiresAt, secret: begun.pairingSecret.slice(), mailbox: mailboxId(key), timer: null, offEvent: () => undefined, session: null, chain: Promise.resolve(), closing: false,
      closed, markClosed,
    };
    win = w;
    w.timer = setTimer(() => ended(w, "expired"), ttl);
    // The owner closed the helper's window, or cancelled: the pairing is over.
    w.offEvent = deps.helper().onEvent((e) => ended(w, e));
    deps.onWindowChange(true);
    deps.link.open({ name: PAIRING_GROUP, keys: () => [key] });
    return { expiresAt, alreadyOpen: false };
  }

  async function handshake(w: Window, d: Delivered): Promise<void> {
    const helper = deps.helper();
    const corePub = (await helper.status()).corePub;
    const hs = new HandshakeState({
      pattern: "NKpsk0", role: "responder", prologue: prologue(PROLOGUE_PREFIX, coreId(corePub)), psk: w.secret, staticPublic: corePub,
      staticDh: (p) => helper.dh(p),
    });
    try {
      await hs.readMessage(d.payload);
    } catch {
      // A stranger without the secret, or a replay: ignore it, the window stays open for the phone that has it.
      refuse("handshake-failed");
      return;
    }
    const reply = await hs.writeMessage(new Uint8Array(0));
    const { send, recv } = hs.split();
    w.session = { tag: d.tag, send, recv, hash: hs.handshakeHash(), reassembler: new Reassembler(), stage: "request" };
    deps.link.send(PAIRING_GROUP, d.mailbox, d.tag, reply, { priority: true });
  }

  function say(w: Window, mailbox: Uint8Array, type: "pairing-result" | "error", body: unknown): void {
    const s = w.session!;
    for (const plaintext of sealStream(type, "pair", encodeMessage(type, body as never))) {
      deps.link.send(PAIRING_GROUP, mailbox, s.tag, s.send.encrypt(new Uint8Array(0), plaintext), { priority: true });
    }
  }

  async function onTransport(w: Window, d: Delivered): Promise<void> {
    const s = w.session!;
    let msg;
    try {
      msg = s.reassembler.push(s.recv.decrypt(new Uint8Array(0), d.payload));
    } catch {
      refuse("bad-frame");
      return void (await closeWindow("bad-frame", { helperCancel: true }));
    }
    if (!msg) return;
    if (s.stage !== "request" || msg.t !== "pairing-request") {
      refuse("unexpected-message");
      return void (await closeWindow("unexpected-message", { helperCancel: true }));
    }
    s.stage = "confirming";
    const fail = async (code: string, message: string): Promise<void> => {
      refuse(code);
      try {
        say(w, d.mailbox, "error", { id: null, code: "pairing-failed", message });
      } catch {
        /* the session is unusable */
      }
      await closeWindow(code, { helperCancel: true, drain: true });
    };

    let req;
    try {
      req = parseMessage<{
        name: string; platform: "ios" | "android"; appVersion: string; sessionPub: string; approvePub: string; pushPub: string; sessionSig: string; approveSig: string;
      }>("pairing-request", msg.body);
    } catch (e) {
      return void (await fail(e instanceof ParseError ? "bad-request" : "bad-request", "the pairing request was not valid"));
    }
    const sessionPub = fromHex(req.sessionPub);
    const approvePub = fromHex(req.approvePub);
    const pushPub = fromHex(req.pushPub);
    // Both signatures are over THIS handshake's hash: the phone proves it holds both private keys, here, now.
    if (!verifyEs256(sessionPub, s.hash, fromHex(req.sessionSig)) || !verifyEs256(approvePub, s.hash, fromHex(req.approveSig))) {
      return void (await fail("bad-phone-signature", "the phone could not prove its keys"));
    }
    const name = cleanDeviceName(req.name);
    if (!name) return void (await fail("bad-name", "the device name is not valid"));

    const deviceId = toHex(randomBytes(16));
    const enrolledAt = now();
    const helper = deps.helper();
    let completed;
    try {
      completed = await helper.pairComplete({
        handshakeHash: s.hash, deviceId, name, platform: req.platform, appVersion: req.appVersion, sessionPub, approvePub, pushPub, enrolledAt,
      });
    } catch (e) {
      const code = e instanceof KeyHelperError ? e.code : "helper-failed";
      return void (await fail(code, "the pairing was not confirmed"));
    }
    if (win !== w || w.closing) return; // the window was closed while the owner was in the helper's

    // What the helper signed must be exactly what was asked, at the level it returned.
    const row = { id: deviceId, name, platform: req.platform, sessionPub, approvePub, pushPub, level: completed.level, enrolledAt };
    const expected = registryEntryJson(row);
    let registryOk = false;
    try {
      registryOk = completed.entry === expected && verifyEs256((await helper.status()).registryPub, utf8(expected), completed.sig);
    } catch {
      registryOk = false;
    }
    if (!registryOk) return void (await fail("bad-helper-signature", "the confirmation could not be verified"));

    const linkSecret = randomBytes(32);
    const device: RemoteDeviceInsert = { ...row, appVersion: req.appVersion, linkSecret, sig: completed.sig };
    try {
      await deps.addDevice(device, { ts: now(), target: { name, platform: req.platform, level: completed.level } });
    } catch {
      return void (await fail("store-failed", "the device could not be saved"));
    }
    say(w, d.mailbox, "pairing-result", { deviceId, linkSecret: toHex(linkSecret), level: completed.level });
    deps.notify({ deviceId, title: "Phone paired", body: `${name} was paired` });
    deps.broadcast({ type: "remote_action", taskId: null, deviceName: name, action: "device-paired", ts: now() });
    void deps.alertOthers(deviceId, "device-paired").catch(() => undefined);
    await closeWindow("paired", { drain: true });
  }

  const pairing: Pairing = {
    start() {
      starting ??= startInner().finally(() => void (starting = null));
      return starting;
    },
    async cancel(reason = "cancelled") {
      if (!win) return;
      refuse(reason);
      await closeWindow(reason, { helperCancel: true });
    },
    onFrame(d) {
      const w = win;
      if (!w || w.closing) return Promise.resolve();
      w.chain = w.chain
        .then(async () => {
          if (win !== w || w.closing) return;
          if (!w.session) return await handshake(w, d);
          if (equalBytes(w.session.tag, d.tag)) return await onTransport(w, d);
          // Another phone's frames while one is pairing: ignored.
        })
        .catch(() => undefined);
      return w.chain;
    },
    // A closing window still counts as open until its mailbox is gone: the link gate must not drop the link under the last frame.
    isOpen: () => win !== null,
    status: () => (win ? { open: true, expiresAt: win.expiresAt, stage: win.session ? "confirming" : "waiting" } : { open: false, expiresAt: null, stage: "closed" }),
  };
  return pairing;
}
