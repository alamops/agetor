import { expect, test } from "bun:test";
import { mergeAgentCapabilities, type AgentCapabilities } from "./agent-capabilities";
import { mergeAgentCapabilities as sharedMerge } from "../../shared/agent-capabilities";
import type { AvailableCommand, AvailableExtension } from "./api";

// The merge's behavior is pinned in `src/shared/agent-capabilities.test.ts`;
// this file only pins that the webview uses that one implementation (the CLI
// does too), so the composer and `agetor commands` can't drift apart.
test("the webview re-exports the shared merge rather than a copy", () => {
  expect(mergeAgentCapabilities).toBe(sharedMerge);
});

test("the webview alias types the merge with the webview's discovery types", () => {
  const command: AvailableCommand = { name: "review", description: "", source: "project", kind: "command" };
  const extension: AvailableExtension = { name: "GitHub", insert: "@github", description: "", source: "project", kind: "mcp" };
  const caps: AgentCapabilities = { commands: [command], extensions: [extension] };
  const merged: AgentCapabilities = mergeAgentCapabilities([caps, null]);
  expect(merged).toEqual(caps);
});
