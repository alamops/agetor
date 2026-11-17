import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cursorSpecKeyFor, cursorVariantOf, parseCursorModelList } from "./cursor-catalog.ts";
import { CURSOR_MODEL_SPECS, cursorModelArg } from "./types.ts";

const FIXTURE = readFileSync(new URL("../bun/fixtures/model-discovery/cursor-models-2026.10.22.txt", import.meta.url), "utf8");

describe("parseCursorModelList on the 284-line fixture", () => {
  const rows = parseCursorModelList(FIXTURE);
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  test("rows are unique by id and by label", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const labels = rows.map((r) => r.label).filter((l): l is string => Boolean(l));
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
  });

  test("every id a spec covers collapses to one bare row with no discovered fields", () => {
    const covered = FIXTURE.split("\n")
      .map((l) => l.split(" - ")[0]?.trim() ?? "")
      .filter((id) => id && cursorSpecKeyFor(id));
    expect(covered.length).toBeGreaterThan(40);
    for (const id of covered) {
      const key = cursorSpecKeyFor(id) as string;
      const row = byId.get(key);
      expect(row, key).toBeDefined();
      expect(Object.keys(row as object), key).toEqual(["id"]);
    }
  });

  test("no flat variant of a spec'd base leaks as its own grouped row", () => {
    for (const r of rows) {
      if (r.cursor) expect(CURSOR_MODEL_SPECS[r.id], r.id).toBeUndefined();
    }
  });

  test("first-seen order is preserved", () => {
    const order = rows.map((r) => r.id);
    expect(order[0]).toBe("auto");
    // gpt-5.3-codex precedes gpt-5.2, which precedes composer-2.5 in the CLI's list.
    expect(order.indexOf("gpt-5.3-codex")).toBeLessThan(order.indexOf("gpt-5.2"));
    expect(order.indexOf("gpt-5.2")).toBeLessThan(order.indexOf("composer-2.5"));
  });

  test("an uncovered family groups into base + efforts + variant map", () => {
    const row = byId.get("gemini-4-hydrogen") ?? byId.get("muse-spark-1.3");
    expect(row).toBeDefined();
    const r = row as NonNullable<typeof row>;
    expect(r.efforts?.length).toBeGreaterThan(2);
    expect(r.cursor?.effortIds?.[r.efforts?.[0] as string]).toMatch(new RegExp(`^${r.id}-`));
    expect(r.label ?? "").not.toMatch(/\b(low|medium|high|max)\b/i);
  });

  test("an uncovered variant of a spec'd base keeps its own plain row and full label", () => {
    const low = byId.get("claude-opus-5-low");
    expect(low).toEqual({ id: "claude-opus-5-low", label: "Claude Opus 5 1M Low" });
  });

  test("a thinking base keeps -thinking in its id and a lone default id stays a plain row", () => {
    const thinking = rows.find((r) => r.id === "claude-fable-5-thinking") ?? rows.find((r) => r.id.endsWith("-thinking") && r.cursor);
    expect(thinking?.cursor?.effortIds).toBeDefined();
    const plain = byId.get("claude-4.6-sonnet-medium-thinking") ?? byId.get("claude-4.5-sonnet");
    expect(plain).toBeDefined();
    expect(plain?.cursor).toBeUndefined();
  });

  test("labels lose zero-width characters", () => {
    for (const r of rows) expect(r.label ?? "", r.id).not.toMatch(/[​-‍⁠﻿]/);
  });

  test("the grouped row composes the real flat id through cursorModelArg", () => {
    const fam = rows.find((r) => r.cursor?.effortIds && r.cursor.fastEfforts?.length);
    expect(fam).toBeDefined();
    const f = fam as NonNullable<typeof fam>;
    const effort = f.cursor?.fastEfforts?.[0] as string;
    const flat = f.cursor?.effortIds?.[effort] as string;
    expect(cursorModelArg(f.id, effort, true, false, f.cursor)).toBe(`${flat}-fast`);
    expect(FIXTURE).toContain(`${flat}-fast - `);
  });
});

describe("parseCursorModelList edge cases", () => {
  test("header, tip and garbage lines are skipped; a new variant of a spec'd base stays plain", () => {
    const out = parseCursorModelList([
      "Available models",
      "",
      "grok-4.7-max - Grok 4.7 Max",
      "gpt-7-low - GPT-7 Low",
      "gpt-7-high - GPT-7 High",
      "gpt-7-high-fast - GPT-7 High Fast",
      "solo - Solo",
      "solo-fast - Solo Fast",
      "NOT AN ID - nope",
      "Tip: use --model <id>",
    ].join("\n"));
    expect(out.map((r) => r.id)).toEqual(["grok-4.7-max", "gpt-7", "solo"]);
    const g = out[1];
    expect(g?.label).toBe("GPT-7");
    expect(g?.efforts).toEqual(["low", "high"]);
    expect(g?.cursor).toEqual({ effortIds: { low: "gpt-7-low", high: "gpt-7-high" }, fastEfforts: ["high"] });
    expect(g?.fast).toBe(true);
    expect(out[2]?.cursor).toEqual({ fastId: "solo-fast" });
  });

  test("an extra-high id maps to the xhigh effort", () => {
    const out = parseCursorModelList("zed-extra-high - Zed Extra High\nzed-low - Zed Low");
    expect(out[0]?.cursor?.effortIds).toEqual({ xhigh: "zed-extra-high", low: "zed-low" });
  });

  test("garbage input yields an empty list", () => {
    expect(parseCursorModelList("")).toEqual([]);
    expect(parseCursorModelList("\u0000\u0001 - -")).toEqual([]);
  });
});

describe("cursorVariantOf", () => {
  test("resolves a discovered variant, its fast twin, a fastId and a curated spec variant", () => {
    const rows = parseCursorModelList("gpt-7-low - GPT-7 Low\ngpt-7-high - GPT-7 High\ngpt-7-high-fast - GPT-7 High Fast\nsolo - Solo\nsolo-fast - Solo Fast");
    expect(cursorVariantOf("gpt-7-high-fast", rows)).toEqual({ base: "gpt-7", effort: "high", fast: true, label: "GPT-7" });
    expect(cursorVariantOf("gpt-7-low", rows)).toEqual({ base: "gpt-7", effort: "low", fast: false, label: "GPT-7" });
    expect(cursorVariantOf("solo-fast", rows)).toEqual({ base: "solo", effort: null, fast: true, label: "Solo" });
    expect(cursorVariantOf("grok-4.7-high", [])?.base).toBe("grok-4.7");
    expect(cursorVariantOf("nope-1", rows)).toBeNull();
  });
});
