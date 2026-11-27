import { describe, expect, test } from "bun:test";
import { AGENT_OPTIONS } from "../../shared/types.ts";
import { AUTONOMY, effectiveMode, runsWithoutAsking } from "./autonomy.ts";

describe("which tasks run without asking", () => {
  test("every mode of every harness in AGENT_OPTIONS has an explicit entry (no mode falls through to the fail-closed default)", () => {
    for (const [kind, opt] of Object.entries(AGENT_OPTIONS)) {
      const table = AUTONOMY[kind];
      expect(table, `no autonomy table for ${kind}`).toBeDefined();
      for (const m of (opt as { modes: Array<{ id: string }> }).modes) {
        expect(Object.prototype.hasOwnProperty.call(table!, m.id), `${kind}/${m.id} is not pinned`).toBe(true);
      }
    }
    // and the table names no mode AGENT_OPTIONS lacks
    for (const [kind, table] of Object.entries(AUTONOMY)) {
      const ids = new Set(((AGENT_OPTIONS as Record<string, { modes: Array<{ id: string }> }>)[kind]?.modes ?? []).map((m) => m.id));
      for (const id of Object.keys(table)) expect(ids.has(id), `${kind}/${id} is pinned but unknown`).toBe(true);
    }
  });

  test("the pinned values", () => {
    const yes = [["claude-code", "auto"], ["claude-code", "bypass"], ["claude-code", "acceptEdits"], ["codex", "auto"], ["cursor", "auto"], ["gemini", "auto"], ["fx", "yolo"], ["fx", "auto"], ["antigravity", "auto"], ["antigravity", "ask"], ["opencode", "auto"], ["copilot", "auto"]];
    const no = [["claude-code", "plan"], ["claude-code", "ask"], ["codex", "ask"], ["cursor", "plan"], ["cursor", "ask"], ["gemini", "ask"], ["fx", "ask"], ["antigravity", "plan"], ["opencode", "ask"], ["opencode", "plan"], ["copilot", "plan"], ["copilot", "ask"]];
    for (const [agent, mode] of yes) expect(runsWithoutAsking({ agent: agent!, mode }), `${agent}/${mode}`).toBe(true);
    for (const [agent, mode] of no) expect(runsWithoutAsking({ agent: agent!, mode }), `${agent}/${mode}`).toBe(false);
  });

  test("a task with no mode uses its harness's default: fx is yolo (without asking), claude-code is auto", () => {
    expect(effectiveMode({ agent: "fx", mode: null })).toBe("yolo");
    expect(effectiveMode({ agent: "claude-code", mode: undefined })).toBe("auto");
    expect(runsWithoutAsking({ agent: "fx", mode: null })).toBe(true);
    expect(runsWithoutAsking({ agent: "codex", mode: null })).toBe(true);
  });

  test("FAIL CLOSED: an unknown mode, an unknown harness kind and a prototype key all count as running without asking", () => {
    expect(runsWithoutAsking({ agent: "claude-code", mode: "turbo" })).toBe(true);
    expect(runsWithoutAsking({ agent: "brand-new-harness", mode: "ask" })).toBe(true);
    expect(runsWithoutAsking({ agent: "brand-new-harness", mode: null })).toBe(true);
    expect(runsWithoutAsking({ agent: "constructor", mode: "ask" })).toBe(true);
    expect(runsWithoutAsking({ agent: "claude-code", mode: "constructor" })).toBe(true);
    expect(runsWithoutAsking({ agent: "claude-code", mode: "__proto__" })).toBe(true);
  });
});
