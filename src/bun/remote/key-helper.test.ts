// The real key-helper client against a stub helper process (a Bun script that serves the fake over the JSON-lines protocol), the
// conformance of fake and client, crash and timeout handling, and the seam guard.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { sasCode } from "@agetor/remote-protocol/derive";
import { verifyEs256 } from "@agetor/remote-protocol/es256";
import { decodeQr } from "@agetor/remote-protocol/qr";
import { getKeyHelper, setKeyHelperForTests, type KeyHelper, type PairCompleteArgs } from "./key-helper-api.ts";
import { FakeKeyHelper } from "./key-helper-fake.ts";
import { RealKeyHelper, createRealKeyHelper, resolveKeyHelper } from "./key-helper.ts";

const FAKE_MODULE = path.join(import.meta.dir, "key-helper-fake.ts");
let work: string;
const toClose: KeyHelper[] = [];

beforeAll(() => {
  // Under /tmp, not the repo: stub helpers are throwaway executables.
  work = mkdtempSync(path.join("/tmp", "agt-kh-stub-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => {
  for (const h of toClose.splice(0)) h.close();
  setKeyHelperForTests(null);
  delete process.env.AGETOR_FAKE_KEY_HELPER;
});

function stub(name: string, body: string): string {
  const file = path.join(work, name);
  writeFileSync(file, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A stub that serves a FakeKeyHelper over stdio; `dir` is its shared state and control directory. */
function serveStub(dir: string): string {
  return stub(
    `serve-${path.basename(dir)}.ts`,
    `import { FakeKeyHelper, serveHelperOverStdio } from ${JSON.stringify(FAKE_MODULE)};
const h = new FakeKeyHelper({ dir: ${JSON.stringify(dir)} });
await serveHelperOverStdio(h, { stdin: Bun.stdin.stream(), write: (l) => process.stdout.write(l) });`,
  );
}

const hash = new Uint8Array(32).map((_, i) => i + 9);
const pairArgs = (over: Partial<PairCompleteArgs> = {}): PairCompleteArgs => ({
  handshakeHash: hash, deviceId: "ab".repeat(16), name: "Ana's iPhone", platform: "ios", appVersion: "1.0",
  sessionPub: new Uint8Array(65).fill(2), approvePub: new Uint8Array(65).fill(3), pushPub: new Uint8Array(32).fill(4), enrolledAt: 1_800_000_000_000, ...over,
});

interface Rig {
  name: string;
  helper: KeyHelper;
  /** Drop a control file for the pairing window (works for both rigs: the fake reads it too). */
  control(c: Record<string, unknown>): void;
}

function rigs(): Rig[] {
  const fakeDir = mkdtempSync(path.join(work, "fake-"));
  const fake = new FakeKeyHelper({ dir: fakeDir });
  const realDir = mkdtempSync(path.join(work, "real-"));
  const real = createRealKeyHelper({ resolveBin: () => serveStub(realDir) });
  toClose.push(fake, real);
  const control = (dir: string) => (c: Record<string, unknown>) => writeFileSync(path.join(dir, "pairing-control.json"), JSON.stringify(c));
  return [
    { name: "the fake directly", helper: fake, control: control(fakeDir) },
    { name: "the real client over a stub process", helper: real, control: control(realDir) },
  ];
}

describe("conformance: the fake and the real client agree", () => {
  for (const name of ["the fake directly", "the real client over a stub process"]) {
    describe(name, () => {
      const rig = () => rigs().find((r) => r.name === name)!;

      test("status and dh", async () => {
        const { helper } = rig();
        const s = await helper.status();
        expect(s.corePub.length).toBe(32);
        expect(s.registryPub.length).toBe(65);
        const e = x25519.utils.randomSecretKey();
        expect(toHex(await helper.dh(x25519.getPublicKey(e)))).toBe(toHex(x25519.getSharedSecret(e, s.corePub)));
        await expect(helper.dh(new Uint8Array(32))).rejects.toMatchObject({ code: "bad-args" });
      });

      test("revoke is append-only and revoke-all replaces the core key", async () => {
        const { helper } = rig();
        expect(await helper.revoke("aa".repeat(16))).toEqual(["aa".repeat(16)]);
        expect(await helper.revoked()).toEqual(["aa".repeat(16)]);
        await expect(helper.revoke("zz")).rejects.toMatchObject({ code: "bad-args" });
        const before = (await helper.status()).corePub;
        const all = await helper.revokeAll();
        expect(toHex(all.corePub)).not.toBe(toHex(before));
        expect(toHex((await helper.status()).corePub)).toBe(toHex(all.corePub));
      });

      test("pairing: begin, complete at operate, a verifiable signature, then a closed window", async () => {
        const r = rig();
        const begun = await r.helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 });
        expect(decodeQr(begun.qr).pairingSecret).toBe(toHex(begun.pairingSecret));
        const pending = r.helper.pairComplete(pairArgs());
        r.control({ code: sasCode(hash), level: "operate" });
        const done = await pending;
        expect(done.level).toBe("operate");
        expect(verifyEs256((await r.helper.status()).registryPub, utf8(done.entry), done.sig)).toBe(true);
        await expect(r.helper.pairComplete(pairArgs())).rejects.toMatchObject({ code: "cancelled" });
      });

      test("pairing failures carry the same codes: wrong code, denied, closed window, busy", async () => {
        const r = rig();
        await r.helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 });
        await expect(r.helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 })).rejects.toMatchObject({ code: "busy" });
        let pending = r.helper.pairComplete(pairArgs());
        r.control({ codes: ["000000", "111111", "222222"] });
        await expect(pending).rejects.toMatchObject({ code: "wrong-code" });

        await r.helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 });
        pending = r.helper.pairComplete(pairArgs());
        r.control({ code: sasCode(hash), deny: true });
        await expect(pending).rejects.toMatchObject({ code: "auth-failed" });

        const events: string[] = [];
        r.helper.onEvent((e) => events.push(e));
        await r.helper.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "Mac", expiresAt: Date.now() + 60_000 });
        pending = r.helper.pairComplete(pairArgs());
        r.control({ closeWindow: true });
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
        await new Promise((res) => setTimeout(res, 50));
        expect(events).toContain("window-closed");
      });
    });
  }
});

describe("the real client", () => {
  test("a missing helper is reported as helper-missing, for every call", async () => {
    const h = createRealKeyHelper({ resolveBin: () => null });
    toClose.push(h);
    expect(h.available()).toBe(false);
    await expect(h.status()).rejects.toMatchObject({ code: "helper-missing" });
    await expect(h.dh(new Uint8Array(32))).rejects.toMatchObject({ code: "helper-missing" });
    await expect(h.pairBegin({ relayUrl: "ws://x", macName: "m", expiresAt: Date.now() + 1000 })).rejects.toMatchObject({ code: "helper-missing" });
  });

  test("a spawn that throws is helper-missing", async () => {
    const h = createRealKeyHelper({ resolveBin: () => "/nope", spawn: () => { throw new Error("ENOENT"); } });
    toClose.push(h);
    await expect(h.status()).rejects.toMatchObject({ code: "helper-missing" });
  });

  test("a crash rejects in-flight calls, and the next call starts a fresh helper", async () => {
    const dir = mkdtempSync(path.join(work, "crash-"));
    const count = path.join(dir, "count");
    // Exits on `dh` after counting its own start; serves everything else.
    const bin = stub(
      "crashy.ts",
      `import { appendFileSync } from "node:fs";
import { FakeKeyHelper, serveHelperOverStdio } from ${JSON.stringify(FAKE_MODULE)};
appendFileSync(${JSON.stringify(count)}, "x");
const h = new FakeKeyHelper({ dir: ${JSON.stringify(dir)} });
const real = h.dh.bind(h);
h.dh = async (p) => { setTimeout(() => process.exit(3), 5); return await new Promise(() => {}); };
await serveHelperOverStdio(h, { stdin: Bun.stdin.stream(), write: (l) => process.stdout.write(l) });`,
    );
    const h = createRealKeyHelper({ resolveBin: () => bin });
    toClose.push(h);
    expect((await h.status()).corePub.length).toBe(32);
    await expect(h.dh(x25519.getPublicKey(x25519.utils.randomSecretKey()))).rejects.toMatchObject({ code: "helper-crashed" });
    expect((await h.status()).corePub.length).toBe(32);
    expect(await Bun.file(count).text()).toBe("xx");
  });

  test("a helper that never answers times out", async () => {
    const bin = stub("mute.ts", `await new Promise(() => {});`);
    const h = createRealKeyHelper({ resolveBin: () => bin, timeouts: { dh: 80, status: 80 } });
    toClose.push(h);
    await expect(h.dh(new Uint8Array(32).fill(9))).rejects.toMatchObject({ code: "timeout" });
    await expect(h.status()).rejects.toMatchObject({ code: "timeout" });
  });

  test("stray non-JSON output is ignored and an unknown id is dropped", async () => {
    const bin = stub(
      "noisy.ts",
      `for await (const chunk of Bun.stdin.stream()) {
  const line = new TextDecoder().decode(chunk).trim();
  const req = JSON.parse(line);
  process.stdout.write("hello world, not json\\n");
  process.stdout.write(JSON.stringify({ id: 9999, ok: true, result: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { ids: ["aa".repeat(16)] } }) + "\\n");
}`,
    );
    const h = createRealKeyHelper({ resolveBin: () => bin });
    toClose.push(h);
    expect(await h.revoked()).toEqual(["aa".repeat(16)]);
  });

  test("an error with an unknown code becomes internal, and an unknown event is ignored", async () => {
    const bin = stub(
      "weird.ts",
      `for await (const chunk of Bun.stdin.stream()) {
  const req = JSON.parse(new TextDecoder().decode(chunk).trim());
  process.stdout.write(JSON.stringify({ event: "mystery" }) + "\\n");
  process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: "weird-new-code", message: "x" } }) + "\\n");
}`,
    );
    const h = createRealKeyHelper({ resolveBin: () => bin });
    toClose.push(h);
    await expect(h.revoked()).rejects.toMatchObject({ code: "internal" });
  });

  test("it logs nothing: no key, hash or name reaches the console", async () => {
    const seen: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      const dir = mkdtempSync(path.join(work, "quiet-"));
      const h = createRealKeyHelper({ resolveBin: () => serveStub(dir) });
      toClose.push(h);
      await h.status();
      await h.dh(x25519.getPublicKey(x25519.utils.randomSecretKey()));
      await h.pairBegin({ relayUrl: "ws://127.0.0.1:9", macName: "SECRET-MAC-NAME", expiresAt: Date.now() + 60_000 });
    } finally {
      Object.assign(console, orig);
    }
    expect(seen).toEqual([]);
  });

  test("resolveKeyHelper prefers the bundled helper, then the dev build", () => {
    const calls: string[] = [];
    expect(resolveKeyHelper((p) => (calls.push(p), p.includes("vendor")))).toContain("vendor/keyhelper/AgetorKeyHelper.app/Contents/MacOS/keyhelper");
    expect(calls[0]).toContain("Resources/app/bin/AgetorKeyHelper.app");
    expect(resolveKeyHelper(() => true)).toContain("Resources/app/bin/AgetorKeyHelper.app");
    expect(resolveKeyHelper(() => false)).toBeNull();
  });
});

describe("the seam guard (grill D4)", () => {
  test("under NODE_ENV=test, AGETOR_FAKE_KEY_HELPER=1 yields the fake", () => {
    process.env.AGETOR_FAKE_KEY_HELPER = "1";
    expect(getKeyHelper()).toBeInstanceOf(FakeKeyHelper);
  });

  test("with NODE_ENV unset and no e2e flag, AGETOR_FAKE_KEY_HELPER=1 still yields the real client", () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, E2E: process.env.AGETOR_E2E_HARNESS_SEAMS };
    delete process.env.NODE_ENV;
    delete process.env.AGETOR_E2E_HARNESS_SEAMS;
    process.env.AGETOR_FAKE_KEY_HELPER = "1";
    try {
      expect(getKeyHelper()).toBeInstanceOf(RealKeyHelper);
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.E2E !== undefined) process.env.AGETOR_E2E_HARNESS_SEAMS = saved.E2E;
    }
  });

  test("AGETOR_E2E_HARNESS_SEAMS=1 opens the seam outside NODE_ENV=test; without AGETOR_FAKE_KEY_HELPER it is the real client", () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    process.env.AGETOR_E2E_HARNESS_SEAMS = "1";
    try {
      expect(getKeyHelper()).toBeInstanceOf(RealKeyHelper);
      setKeyHelperForTests(null);
      process.env.AGETOR_FAKE_KEY_HELPER = "1";
      expect(getKeyHelper()).toBeInstanceOf(FakeKeyHelper);
    } finally {
      process.env.NODE_ENV = saved;
      delete process.env.AGETOR_E2E_HARNESS_SEAMS;
    }
  });

  test("the process-wide helper is cached, and setKeyHelperForTests replaces and closes the old one", async () => {
    process.env.AGETOR_FAKE_KEY_HELPER = "1";
    const a = getKeyHelper();
    expect(getKeyHelper()).toBe(a);
    const b = new FakeKeyHelper();
    setKeyHelperForTests(b);
    expect(getKeyHelper()).toBe(b);
    await expect(a.status()).rejects.toMatchObject({ code: "closed" });
    toClose.push(b);
  });
});
