/**
 * Noise_NK_25519_ChaChaPoly_SHA256 and Noise_NKpsk0_25519_ChaChaPoly_SHA256 (Noise Protocol Framework rev 34),
 * the only two suites the Companion uses: NKpsk0 for pairing (the pairing secret is the PSK), NK for every session.
 * There is no cipher negotiation (invariant 14): the prologue `agetor-remote/1` ‖ core id binds the protocol version and
 * the core's identity into the handshake hash, so a different version or core fails the handshake.
 *
 * The responder's static Diffie-Hellman is an INJECTED function (`staticDh`): the core never holds its static private key,
 * the key helper performs `x25519(s, remote)` (invariant 10). Both handshake methods are therefore async.
 *
 * Passes the cacophony NK and NKpsk0 vectors (ciphertexts and handshake hash), snow's NK vectors and this package's own
 * (`vectors/`), see noise.test.ts.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, utf8, zero } from "./bytes.ts";
import { NOISE_NK, NOISE_NKPSK0 } from "./constants.ts";

export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

export type NoisePattern = "NK" | "NKpsk0";
export type DhFn = (remotePublic: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const DHLEN = 32;
const HASHLEN = 32;
const TAG = 16;
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = new Uint8Array(0);

function nonceBytes(n: bigint): Uint8Array {
  // ChaChaPoly: 32 bits of zeros, then the 64-bit counter little-endian.
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

function isAllZero(b: Uint8Array): boolean {
  let d = 0;
  for (const x of b) d |= x;
  return d === 0;
}

function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmac(sha256, tempKey, concat(o2, Uint8Array.of(3)))];
}

/** One direction of transport: a key and an implicit 64-bit counter nonce. */
export class CipherState {
  private k: Uint8Array | null;
  private n = 0n;

  constructor(key: Uint8Array | null = null) {
    this.k = key ? key.slice() : null;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  /** The number of messages processed so far (for the rekey-after-2^20 rule). */
  nonce(): bigint {
    return this.n;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext;
    if (this.n === MAX_NONCE) throw new NoiseError("nonce exhausted");
    const ct = chacha20poly1305(this.k, nonceBytes(this.n), ad).encrypt(plaintext);
    this.n++;
    return ct;
  }

  /** Throws NoiseError on any failure and leaves the counter where it was. A replayed or reordered message fails here. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext;
    if (this.n === MAX_NONCE) throw new NoiseError("nonce exhausted");
    if (ciphertext.length < TAG) throw new NoiseError("ciphertext too short");
    let pt: Uint8Array;
    try {
      pt = chacha20poly1305(this.k, nonceBytes(this.n), ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError("decryption failed");
    }
    this.n++;
    return pt;
  }

  /** Noise REKEY(): k = ENCRYPT(k, 2^64-1, empty, 32 zero bytes)[0..32]. Both sides call it at the same message count. */
  rekey(): void {
    if (!this.k) throw new NoiseError("cannot rekey without a key");
    const next = chacha20poly1305(this.k, nonceBytes(MAX_NONCE), EMPTY).encrypt(new Uint8Array(32)).slice(0, 32);
    zero(this.k);
    this.k = next;
  }
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher = new CipherState();

  constructor(protocolName: string) {
    const name = utf8(protocolName);
    this.h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : sha256(name);
    this.ck = this.h.slice();
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Uint8Array, Uint8Array];
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3) as [Uint8Array, Uint8Array, Uint8Array];
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher = new CipherState(tempK);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2) as [Uint8Array, Uint8Array];
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface HandshakeOptions {
  pattern: NoisePattern;
  role: "initiator" | "responder";
  /** `agetor-remote/1` ‖ core id (see `prologue()` in this file). Mixed into the handshake hash. */
  prologue: Uint8Array;
  /** NKpsk0 only: the 32-byte pre-shared key (the pairing secret). */
  psk?: Uint8Array;
  /** Initiator: the responder's static public key (the pre-message). Responder: its own static public key. */
  staticPublic: Uint8Array;
  /** Responder only: `x25519(static private, remotePublic)`. The key helper performs it; the private key never reaches this module. */
  staticDh?: DhFn;
  /** Tests and vectors only: a fixed ephemeral private key. Production leaves it unset and a random one is drawn. */
  ephemeralSecret?: Uint8Array;
}

/** The Noise prologue for this protocol: `agetor-remote/1` followed by the core id (SHA-256 of the core's public key). */
export function prologue(prefix: string, coreId: Uint8Array): Uint8Array {
  return concat(utf8(prefix), coreId);
}

export class HandshakeState {
  private readonly ss: SymmetricState;
  private readonly role: "initiator" | "responder";
  private readonly pattern: NoisePattern;
  private readonly psk: Uint8Array | null;
  private readonly staticDh?: DhFn;
  private e: { secret: Uint8Array; pub: Uint8Array } | null = null;
  private re: Uint8Array | null = null;
  private readonly rs: Uint8Array | null;
  private step = 0;
  private done = false;
  private failed = false;

  constructor(opts: HandshakeOptions) {
    if (opts.pattern !== "NK" && opts.pattern !== "NKpsk0") throw new NoiseError("unsupported pattern");
    this.pattern = opts.pattern;
    this.role = opts.role;
    this.psk = opts.pattern === "NKpsk0" ? (opts.psk ?? null) : null;
    if (opts.pattern === "NKpsk0" && (!this.psk || this.psk.length !== 32)) throw new NoiseError("NKpsk0 needs a 32-byte psk");
    if (opts.pattern === "NK" && opts.psk) throw new NoiseError("NK takes no psk");
    if (opts.staticPublic.length !== DHLEN) throw new NoiseError("static public key must be 32 bytes");
    if (opts.role === "responder" && !opts.staticDh) throw new NoiseError("the responder needs staticDh");
    this.staticDh = opts.staticDh;
    this.ss = new SymmetricState(opts.pattern === "NK" ? NOISE_NK : NOISE_NKPSK0);
    this.ss.mixHash(opts.prologue);
    // Pre-message `<- s`: both sides know the responder's static key.
    this.rs = opts.staticPublic.slice();
    this.ss.mixHash(this.rs);
    if (opts.ephemeralSecret) {
      if (opts.ephemeralSecret.length !== DHLEN) throw new NoiseError("ephemeral secret must be 32 bytes");
      this.e = { secret: opts.ephemeralSecret.slice(), pub: x25519.getPublicKey(opts.ephemeralSecret) };
    }
  }

  get complete(): boolean {
    return this.done;
  }

  /** The handshake hash h; the channel binding signs it and the pairing code is derived from it. Only after completion. */
  handshakeHash(): Uint8Array {
    if (!this.done) throw new NoiseError("handshake not complete");
    return this.ss.h.slice();
  }

  private ephemeral(): { secret: Uint8Array; pub: Uint8Array } {
    if (!this.e) {
      const secret = x25519.utils.randomSecretKey();
      this.e = { secret, pub: x25519.getPublicKey(secret) };
    }
    return this.e;
  }

  private dhEphemeral(remote: Uint8Array): Uint8Array {
    const out = x25519.getSharedSecret(this.ephemeral().secret, remote);
    if (isAllZero(out)) throw new NoiseError("low-order point");
    return out;
  }

  private async dhStatic(remote: Uint8Array): Promise<Uint8Array> {
    const out = await this.staticDh!(remote);
    if (out.length !== DHLEN || isAllZero(out)) throw new NoiseError("bad static dh");
    return out;
  }

  /** Produce the next handshake message carrying `payload`. */
  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    this.assertTurn("write");
    try {
      const parts: Uint8Array[] = [];
      if (this.step === 0) {
        // -> psk (NKpsk0), e, es
        if (this.psk) this.ss.mixKeyAndHash(this.psk);
        const e = this.ephemeral();
        parts.push(e.pub);
        this.ss.mixHash(e.pub);
        if (this.psk) this.ss.mixKey(e.pub);
        this.ss.mixKey(this.dhEphemeral(this.rs!));
      } else {
        // <- e, ee
        const e = this.ephemeral();
        parts.push(e.pub);
        this.ss.mixHash(e.pub);
        if (this.psk) this.ss.mixKey(e.pub);
        this.ss.mixKey(this.dhEphemeral(this.re!));
      }
      parts.push(this.ss.encryptAndHash(payload));
      this.advance();
      return concat(...parts);
    } catch (e) {
      this.failed = true;
      throw e instanceof NoiseError ? e : new NoiseError("handshake failed");
    }
  }

  /** Consume the peer's next handshake message and return its payload. Any failure poisons the handshake. */
  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    this.assertTurn("read");
    try {
      if (message.length < DHLEN + TAG) throw new NoiseError("handshake message too short");
      const re = message.slice(0, DHLEN);
      this.re = re;
      if (this.step === 0) {
        // responder reads: psk, e, es
        if (this.psk) this.ss.mixKeyAndHash(this.psk);
        this.ss.mixHash(re);
        if (this.psk) this.ss.mixKey(re);
        this.ss.mixKey(await this.dhStatic(re));
      } else {
        // initiator reads: e, ee
        this.ss.mixHash(re);
        if (this.psk) this.ss.mixKey(re);
        this.ss.mixKey(this.dhEphemeral(re));
      }
      const payload = this.ss.decryptAndHash(message.slice(DHLEN));
      this.advance();
      return payload;
    } catch (e) {
      this.failed = true;
      throw e instanceof NoiseError ? e : new NoiseError("handshake failed");
    }
  }

  private assertTurn(dir: "write" | "read"): void {
    if (this.failed) throw new NoiseError("handshake failed earlier");
    if (this.done) throw new NoiseError("handshake already complete");
    const initiatorWrites = this.step === 0;
    const iAmInitiator = this.role === "initiator";
    const myTurnToWrite = initiatorWrites === iAmInitiator;
    if ((dir === "write") !== myTurnToWrite) throw new NoiseError("out of turn");
  }

  private advance(): void {
    this.step++;
    if (this.step === 2) {
      this.done = true;
      if (this.e) zero(this.e.secret);
    }
  }

  /**
   * After completion: the transport ciphers, oriented for this role (`send` encrypts what this side writes,
   * `recv` decrypts what the peer writes).
   */
  split(): { send: CipherState; recv: CipherState } {
    if (!this.done) throw new NoiseError("handshake not complete");
    const [c1, c2] = this.ss.split();
    return this.role === "initiator" ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

/** Compare a handshake hash to bytes without a timing channel. */
export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return equalBytes(a, b);
}
