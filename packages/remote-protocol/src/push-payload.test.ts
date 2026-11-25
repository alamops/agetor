import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import { PushPayloadError, SEALED_PUSH_BYTES, fitPayload, openPush, sealPush, type PushPayload } from "./push-payload.ts";
import pushVectors from "../vectors/agetor-push.json";

const seed = (n: number, start: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i * 5) & 0xff);
const SK = seed(32, 7);
const PK = x25519.getPublicKey(SK);
const EPH = seed(32, 71);

function payload(title: string, subtitle: string | null = "Fable"): PushPayload {
  return { v: 1, taskId: "9a1f0c2e-1111-4222-8333-444455556666", kind: "waiting", title, subtitle, ts: 1795560000000 };
}

function vectorCases() {
  return [payload("A task needs you"), payload("é".repeat(40), null), payload("x".repeat(5000))].map((p) => ({
    payload: fitPayload(p),
    sealed: toHex(sealPush(p, PK, EPH)),
  }));
}

if (process.env.UPDATE_VECTORS === "1") {
  await Bun.write(
    resolve(import.meta.dir, "../vectors/agetor-push.json"),
    JSON.stringify({ source: "Agetor: sealed push payloads, HPKE info agetor-push/1, padded to 1 KB", pushSecret: toHex(SK), pushPublic: toHex(PK), ephemeralSecret: toHex(EPH), cases: vectorCases() }, null, 2) + "\n",
  );
}

describe("sealed push payload", () => {
  test("every sealed push is the same size, whatever the title length", () => {
    const sizes = new Set<number>();
    for (const title of ["", "short", "x".repeat(200), "x".repeat(1100), "😀".repeat(900), "é".repeat(3000)]) {
      sizes.add(sealPush(payload(title), PK).length);
    }
    expect([...sizes]).toEqual([SEALED_PUSH_BYTES]);
    expect(SEALED_PUSH_BYTES).toBe(32 + 1024 + 16);
  });

  test("round trip", () => {
    const p = payload("Ana's task needs you");
    expect(openPush(sealPush(p, PK), SK)).toEqual(p);
  });

  test("a title that does not fit is cut, never refused, and never splits a surrogate pair", () => {
    const opened = openPush(sealPush(payload("😀".repeat(2000)), PK), SK);
    expect(opened.title.length).toBeGreaterThan(100);
    expect(opened.title.length).toBeLessThan(2000);
    expect(/^(?:😀)*$/u.test(opened.title)).toBe(true);
    const asciiOpened = openPush(sealPush(payload("a".repeat(5000)), PK), SK);
    expect(utf8(JSON.stringify(asciiOpened)).length).toBeLessThanOrEqual(1100);
    expect(asciiOpened.taskId).toBe(payload("").taskId);
  });

  test("no plaintext marker appears in the sealed bytes", () => {
    const sealed = sealPush(payload("SECRET-TITLE-MARKER", "SECRET-SUB"), PK);
    const text = Buffer.from(sealed).toString("latin1");
    expect(text).not.toContain("SECRET-TITLE-MARKER");
    expect(text).not.toContain("SECRET-SUB");
    expect(text).not.toContain("9a1f0c2e");
  });

  test("a wrong key, a flipped bit and a bad shape fail to open", () => {
    const sealed = sealPush(payload("x"), PK);
    expect(() => openPush(sealed, seed(32, 99))).toThrow();
    const flipped = sealed.slice();
    flipped[100] = (flipped[100] as number) ^ 1;
    expect(() => openPush(flipped, SK)).toThrow();
    expect(() => fitPayload({ ...payload("x"), taskId: "" })).toThrow(PushPayloadError);
    expect(() => fitPayload({ ...payload("x"), kind: "k".repeat(40) })).toThrow(PushPayloadError);
  });

  test("the checked-in vectors match and open (UPDATE_VECTORS=1 rewrites them after an intended change)", () => {
    expect(pushVectors.pushPublic).toBe(toHex(PK));
    for (const c of pushVectors.cases) {
      const opened = openPush(fromHex(c.sealed), fromHex(pushVectors.pushSecret));
      expect(opened).toEqual(c.payload as PushPayload);
    }
    expect(JSON.parse(JSON.stringify(vectorCases()))).toEqual(pushVectors.cases);
  });
});
