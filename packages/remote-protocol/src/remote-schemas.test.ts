import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSchemas, ROUTE_TYPES } from "../scripts/gen-schemas.ts";

const DIR = resolve(import.meta.dir, "../schemas");

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, `${prefix}${n}/`) : [`${prefix}${n}`];
  });
}

describe("checked-in JSON Schemas", () => {
  test("regenerating them changes nothing (run `bun scripts/gen-schemas.ts` after an intended change)", () => {
    const fresh = buildSchemas();
    const onDisk = walk(DIR).sort();
    expect(onDisk).toEqual(Object.keys(fresh).sort());
    for (const [name, text] of Object.entries(fresh)) expect(readFileSync(join(DIR, name), "utf8"), name).toBe(text);
  }, 120_000);

  test("every route-body type the plan names has a schema, and no message schema allows extra fields", () => {
    for (const { type } of ROUTE_TYPES) expect(statSync(join(DIR, "routes", `${type}.json`)).size).toBeGreaterThan(100);
    for (const f of walk(join(DIR, "messages"))) {
      const s = JSON.parse(readFileSync(join(DIR, "messages", f), "utf8")) as { additionalProperties?: boolean; oneOf?: unknown[] };
      if (s.oneOf === undefined) expect(s.additionalProperties).toBe(false);
    }
  });
});
