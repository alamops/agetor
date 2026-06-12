import { test, expect } from "bun:test";
import { persistPrefs } from "./commands/add.ts";
import type { AgetorClient } from "./api-client.ts";

function recordingClient(calls: Array<[string, string]>): AgetorClient {
  return {
    setPreference: async (key: string, value: string) => {
      calls.push([key, value]);
    },
  } as unknown as AgetorClient;
}

test("persistPrefs writes lastModel/lastMode/lastEffort for the kind", async () => {
  const calls: Array<[string, string]> = [];
  await persistPrefs(recordingClient(calls), "claude-code", { model: "opus-4.7", mode: "auto", effort: "high" });
  expect(calls).toEqual([
    ["lastModel:claude-code", "opus-4.7"],
    ["lastMode:claude-code", "auto"],
    ["lastEffort:claude-code", "high"],
  ]);
});

test("persistPrefs skips picks that weren't chosen", async () => {
  const calls: Array<[string, string]> = [];
  await persistPrefs(recordingClient(calls), "codex", { model: "gpt-5.5" });
  expect(calls).toEqual([["lastModel:codex", "gpt-5.5"]]);
});
