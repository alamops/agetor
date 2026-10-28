import { describe, expect, test } from "bun:test";
import {
  SPEED_OPTIONS,
  isSpeed,
  resolveSpeedInput,
  speedFromFast,
  speedLabel,
  supportedSpeeds,
} from "./speed.ts";
import { SPEEDS, cursorModelSupportsFast, type AgentKind } from "./types.ts";

describe("isSpeed", () => {
  test("accepts exactly the three tiers", () => {
    for (const s of SPEEDS) expect(isSpeed(s)).toBe(true);
    expect(SPEEDS).toEqual(["off", "fast", "ultrafast"]);
  });

  test("rejects everything else, including near-misses and non-strings", () => {
    for (const v of ["", "Fast", "OFF", "ultra", "turbo", " fast", null, undefined, true, false, 0, 1, {}, ["fast"]]) {
      expect(isSpeed(v)).toBe(false);
    }
  });
});

describe("speedFromFast", () => {
  test("true → fast, false → off", () => {
    expect(speedFromFast(true)).toBe("fast");
    expect(speedFromFast(false)).toBe("off");
  });
});

describe("resolveSpeedInput", () => {
  test("neither field present → {}", () => {
    expect(resolveSpeedInput({})).toEqual({});
    expect(resolveSpeedInput({ speed: undefined, fast: undefined })).toEqual({});
  });

  test("a valid speed alone is returned verbatim", () => {
    expect(resolveSpeedInput({ speed: "off" })).toEqual({ speed: "off" });
    expect(resolveSpeedInput({ speed: "fast" })).toEqual({ speed: "fast" });
    expect(resolveSpeedInput({ speed: "ultrafast" })).toEqual({ speed: "ultrafast" });
  });

  test("the legacy fast boolean alone maps through speedFromFast", () => {
    expect(resolveSpeedInput({ fast: true })).toEqual({ speed: "fast" });
    expect(resolveSpeedInput({ fast: false })).toEqual({ speed: "off" });
  });

  test("speed wins over a conflicting fast", () => {
    expect(resolveSpeedInput({ speed: "ultrafast", fast: false })).toEqual({ speed: "ultrafast" });
    expect(resolveSpeedInput({ speed: "off", fast: true })).toEqual({ speed: "off" });
  });

  test("speed wins even over an invalid fast — fast is never validated when speed is present", () => {
    expect(resolveSpeedInput({ speed: "fast", fast: "yes" })).toEqual({ speed: "fast" });
  });

  test("an invalid speed is an error naming the allowed values, even with a valid fast", () => {
    const err = { error: "speed must be one of off, fast, ultrafast" };
    expect(resolveSpeedInput({ speed: "turbo" })).toEqual(err);
    expect(resolveSpeedInput({ speed: true })).toEqual(err);
    expect(resolveSpeedInput({ speed: null })).toEqual(err);
    expect(resolveSpeedInput({ speed: "x", fast: true })).toEqual(err);
  });

  test("a non-boolean fast (speed absent) is an error", () => {
    const err = { error: "fast must be a boolean" };
    expect(resolveSpeedInput({ fast: "true" })).toEqual(err);
    expect(resolveSpeedInput({ fast: 1 })).toEqual(err);
    expect(resolveSpeedInput({ fast: null })).toEqual(err);
  });
});

describe("supportedSpeeds", () => {
  test("cursor: fast-capable model/effort pairs offer off + fast", () => {
    // A fastId-only model (no thinking levels) — fast regardless of effort.
    expect(cursorModelSupportsFast("composer-2.5", null)).toBe(true);
    expect(supportedSpeeds("cursor", "composer-2.5", null)).toEqual(["off", "fast"]);
    // An effort-tiered model whose tier has a -fast variant.
    expect(cursorModelSupportsFast("gpt-5.5", "xhigh")).toBe(true);
    expect(supportedSpeeds("cursor", "gpt-5.5", "xhigh")).toEqual(["off", "fast"]);
  });

  test("cursor: models/efforts with no Fast variant offer off only", () => {
    // Sonnet 5.5 has no fastEfforts at all.
    expect(cursorModelSupportsFast("claude-sonnet-5-5", "high")).toBe(false);
    expect(supportedSpeeds("cursor", "claude-sonnet-5-5", "high")).toEqual(["off"]);
    // Effort-tiered model with no effort chosen.
    expect(supportedSpeeds("cursor", "gpt-5.5", null)).toEqual(["off"]);
    // Unknown cursor id.
    expect(supportedSpeeds("cursor", "vendor/unknown-model", "high")).toEqual(["off"]);
  });

  test("cursor ignores the discovery option flags — the catalog decides", () => {
    expect(supportedSpeeds("cursor", "claude-sonnet-5-5", "high", { fast: true, ultrafast: true })).toEqual(["off"]);
  });

  test("copilot: off only, whatever the model, effort or discovery flags", () => {
    expect(supportedSpeeds("copilot", "auto", "auto")).toEqual(["off"]);
    expect(supportedSpeeds("copilot", "claude-opus-5.5", "high", { fast: true, ultrafast: true })).toEqual(["off"]);
    expect(supportedSpeeds("copilot", null, null)).toEqual(["off"]);
  });

  test("fx: off only without discovery flags", () => {
    expect(supportedSpeeds("fx", "deepseek/deepseek-v4-flash", "auto")).toEqual(["off"]);
    expect(supportedSpeeds("fx", "deepseek/deepseek-v4-flash", "auto", {})).toEqual(["off"]);
    expect(supportedSpeeds("fx", null, null, { fast: false, ultrafast: false })).toEqual(["off"]);
  });

  test("fx: each discovered flag adds its tier, in off → fast → ultrafast order", () => {
    expect(supportedSpeeds("fx", "e2e/model", null, { fast: true })).toEqual(["off", "fast"]);
    expect(supportedSpeeds("fx", "e2e/model", null, { ultrafast: true })).toEqual(["off", "ultrafast"]);
    expect(supportedSpeeds("fx", "e2e/model", null, { ultrafast: true, fast: true })).toEqual(["off", "fast", "ultrafast"]);
  });

  test("every other kind offers off only, even with flags", () => {
    const others: AgentKind[] = ["claude-code", "codex", "gemini", "antigravity"];
    for (const kind of others) {
      expect(supportedSpeeds(kind, null, null)).toEqual(["off"]);
      expect(supportedSpeeds(kind, null, null, { fast: true, ultrafast: true })).toEqual(["off"]);
    }
  });

  test("the result always starts with off", () => {
    expect(supportedSpeeds("cursor", "composer-2.5", null)[0]).toBe("off");
    expect(supportedSpeeds("fx", null, null, { ultrafast: true })[0]).toBe("off");
  });
});

describe("SPEED_OPTIONS / speedLabel", () => {
  test("one option per tier, in SPEEDS order, labelled Off / Fast / Ultrafast", () => {
    expect(SPEED_OPTIONS.map((o) => o.id)).toEqual([...SPEEDS]);
    expect(SPEED_OPTIONS.map((o) => o.label)).toEqual(["Off", "Fast", "Ultrafast"]);
    for (const o of SPEED_OPTIONS) expect((o.hint ?? "").trim().length).toBeGreaterThan(0);
  });

  test("the Ultrafast hint warns it costs more than Fast (D16)", () => {
    expect(SPEED_OPTIONS.find((o) => o.id === "ultrafast")?.hint).toBe(
      "Faster Gateway lane — costs more per token than Fast",
    );
  });

  test("speedLabel maps each tier to its label", () => {
    expect(speedLabel("off")).toBe("Off");
    expect(speedLabel("fast")).toBe("Fast");
    expect(speedLabel("ultrafast")).toBe("Ultrafast");
  });
});
