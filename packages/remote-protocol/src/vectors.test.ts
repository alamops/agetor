import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { FILES } from "../scripts/gen-vectors.ts";
import { es256Vectors } from "../scripts/gen-vectors.ts";
import { fromHex } from "./bytes.ts";
import { canonicalize, parseJsonStrict } from "./canonical-json.ts";
import { verifyEs256 } from "./es256.ts";
import canonicalVectors from "../vectors/agetor-canonical-json.json";

describe("vector files", () => {
  for (const [name, fn] of Object.entries(FILES)) {
    test(`${name} is current (re-run bun scripts/gen-vectors.ts after an intended change)`, async () => {
      const onDisk = await Bun.file(resolve(import.meta.dir, "../vectors", name)).text();
      expect(onDisk).toBe(JSON.stringify(fn(), null, 2) + "\n");
    });
  }
  test("canonical JSON vectors", () => {
    for (const c of canonicalVectors.cases) expect(canonicalize(c.input)).toBe(c.canonical);
    for (const bad of canonicalVectors.invalid) expect(() => parseJsonStrict(bad)).toThrow();
  });
  test("ES256 vectors: low-S and high-S verify, tampered ones do not", () => {
    const v = es256Vectors();
    for (const c of v.cases as { pub: string; msg: string; valid: string[] }[]) for (const sig of c.valid) expect(verifyEs256(fromHex(c.pub), fromHex(c.msg), fromHex(sig))).toBe(true);
    for (const i of v.invalid) expect(verifyEs256(fromHex(i.pub), fromHex(i.msg), fromHex(i.sig as string))).toBe(false);
  });
});
