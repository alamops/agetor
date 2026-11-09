import { expect, test } from "bun:test";
import { agentSwitchPatch } from "./agent-switch.ts";

const DEFAULTS = { mode: "auto", model: "default", effort: null, speed: "off" as const, maxMode: false };

test("a same-kind switch (e.g. inside a stack) sends only the account (S22)", () => {
  let computed = 0;
  const patch = agentSwitchPatch({
    nextId: "backup",
    currentKind: "claude-code",
    nextKind: "claude-code",
    kindDefaults: () => {
      computed++;
      return DEFAULTS;
    },
  });
  expect(patch).toEqual({ agent: "backup" });
  expect(computed).toBe(0);
});

test("a cross-kind switch resets to the new kind's defaults", () => {
  expect(agentSwitchPatch({ nextId: "codex", currentKind: "claude-code", nextKind: "codex", kindDefaults: () => DEFAULTS }))
    .toEqual({ agent: "codex", ...DEFAULTS });
});

test("an unknown kind on either side is never treated as the same kind", () => {
  expect(agentSwitchPatch({ nextId: "x", currentKind: null, nextKind: "claude-code", kindDefaults: () => DEFAULTS }))
    .toEqual({ agent: "x", ...DEFAULTS });
  expect(agentSwitchPatch({ nextId: "x", currentKind: "claude-code", nextKind: null, kindDefaults: () => DEFAULTS }))
    .toEqual({ agent: "x", ...DEFAULTS });
});
