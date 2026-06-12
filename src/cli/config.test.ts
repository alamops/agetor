import { test, expect } from "bun:test";
import { persistPrefs, mergeModels } from "./commands/add.ts";
import type { AgetorClient } from "./api-client.ts";
import type { AgentOption } from "../shared/types.ts";

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

test("mergeModels appends discovered ids not already curated, tagged 'discovered'", () => {
  const curated: AgentOption[] = [
    { id: "opus-4.8", label: "Opus 4.8", hint: "" },
    { id: "sonnet-4.6", label: "Sonnet 4.6", hint: "" },
  ];
  const merged = mergeModels(curated, ["opus-4.8", "new-model-9"]);
  expect(merged.map((m) => m.id)).toEqual(["opus-4.8", "sonnet-4.6", "new-model-9"]); // opus-4.8 deduped
  expect(merged.find((m) => m.id === "new-model-9")).toEqual({
    id: "new-model-9",
    label: "new-model-9",
    hint: "discovered",
  });
});

test("mergeModels with no discovered ids returns the curated list unchanged", () => {
  const curated: AgentOption[] = [{ id: "a", label: "A", hint: "" }];
  expect(mergeModels(curated, [])).toEqual(curated);
});
