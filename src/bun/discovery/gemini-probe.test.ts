import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GEMINI_MODELS_MIN_VERSION, parseGeminiModelsJson, probeGeminiModels } from "./gemini-probe.ts";

const fixture = readFileSync(new URL("../fixtures/model-discovery/gemini-models.json", import.meta.url), "utf8");
const dir = path.join("/tmp", `agetor-gemini-probe-${process.pid}-${Date.now()}`);

beforeAll(() => mkdirSync(dir, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeStub(name: string, version: string, modelsStdout: string): { bin: string; log: string } {
  const log = path.join(dir, `${name}.log`);
  const bin = path.join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "models" ]; then cat <<'EOF'\n${modelsStdout}\nEOF\nexit 0; fi\nexit 9\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe("parseGeminiModelsJson", () => {
  test("parses the documented array shape", () => {
    const rows = parseGeminiModelsJson(fixture);
    expect(rows.map((r) => r.id)).toEqual(["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(rows[0]).toMatchObject({ label: "Gemini 3 Pro (preview)", description: "Most capable model for complex coding and reasoning." });
    expect(rows[0]?.efforts).toBeUndefined();
  });

  test("accepts {models:[…]}, falls back from modelId to id to name, and dedupes", () => {
    const rows = parseGeminiModelsJson(JSON.stringify({ models: [{ name: "gemini-x" }, { id: "gemini-y" }, { modelId: "gemini-x" }, { modelId: "bad id" }] }));
    expect(rows.map((r) => r.id)).toEqual(["gemini-x", "gemini-y"]);
  });

  test("malformed output yields []", () => {
    for (const bad of ["", "no json", "{", "42", "{\"models\":5}", "[null,1]"]) expect(parseGeminiModelsJson(bad)).toEqual([]);
  });
});

describe("probeGeminiModels", () => {
  test("a CLI older than the floor never receives the models subcommand", async () => {
    const { bin, log } = writeStub("gemini-old", "0.66.0", fixture);
    expect(await probeGeminiModels({ bin })).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain("models");
  });

  test("an unparseable version never runs models either", async () => {
    const { bin, log } = writeStub("gemini-weird", "banana", fixture);
    expect(await probeGeminiModels({ bin })).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain("models");
  });

  test("at the floor the list is parsed", async () => {
    expect(GEMINI_MODELS_MIN_VERSION).toBe("0.67.0");
    const { bin, log } = writeStub("gemini-new", "0.67.0", fixture);
    const rows = await probeGeminiModels({ bin });
    expect(rows).toHaveLength(4);
    expect(readFileSync(log, "utf8")).toContain("models -o json");
  });

  test("malformed output, a missing binary and a failing models call yield []", async () => {
    const { bin } = writeStub("gemini-garbage", "0.70.0", "not json at all");
    expect(await probeGeminiModels({ bin })).toEqual([]);
    expect(await probeGeminiModels({ bin: path.join(dir, "nope") })).toEqual([]);
    expect(existsSync(path.join(dir, "nope"))).toBe(false);
  });
});
