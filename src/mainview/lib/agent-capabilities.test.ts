import { describe, expect, test } from "bun:test";
import { mergeAgentCapabilities, type AgentCapabilities } from "./agent-capabilities";
import type { AvailableCommand, AvailableExtension } from "./api";

const command = (name: string, source = "/a"): AvailableCommand => ({
  name,
  description: `${name} from ${source}`,
  source: "project",
  kind: "command",
});

const extension = (name: string, insert: string, source = "/a"): AvailableExtension => ({
  name,
  insert,
  description: `${name} from ${source}`,
  source: "project",
  kind: "mcp",
});

function capabilities(
  commands: AvailableCommand[],
  extensions: AvailableExtension[],
): AgentCapabilities {
  return { commands, extensions };
}

describe("mergeAgentCapabilities", () => {
  test("empty and all-failed inputs settle to empty lists", () => {
    expect(mergeAgentCapabilities([])).toEqual({ commands: [], extensions: [] });
    expect(mergeAgentCapabilities([null, undefined])).toEqual({ commands: [], extensions: [] });
  });

  test("unions every repository in scope order", () => {
    const merged = mergeAgentCapabilities([
      capabilities([command("front")], [extension("GitHub", "@github")]),
      capabilities([command("back")], [extension("Sentry", "@sentry")]),
    ]);
    expect(merged.commands.map((c) => c.name)).toEqual(["front", "back"]);
    expect(merged.extensions.map((e) => e.insert)).toEqual(["@github", "@sentry"]);
  });

  test("a name declared in two repositories appears once, first occurrence wins", () => {
    const merged = mergeAgentCapabilities([
      capabilities([command("shared", "/front")], [extension("Docs", "@docs", "/front")]),
      capabilities([command("shared", "/back")], [extension("Docs", "@docs", "/back")]),
    ]);
    expect(merged.commands).toEqual([command("shared", "/front")]);
    expect(merged.extensions).toEqual([extension("Docs", "@docs", "/front")]);
  });

  test("a failed scope contributes nothing but keeps the others", () => {
    const merged = mergeAgentCapabilities([
      null,
      capabilities([command("only")], [extension("Only", "@only")]),
      undefined,
    ]);
    expect(merged.commands.map((c) => c.name)).toEqual(["only"]);
    expect(merged.extensions.map((e) => e.insert)).toEqual(["@only"]);
  });

  test("extensions dedupe by insert token, not by display name", () => {
    const merged = mergeAgentCapabilities([
      capabilities([], [extension("Same display", "@a")]),
      capabilities([], [extension("Same display", "@b")]),
    ]);
    expect(merged.extensions.map((e) => e.insert)).toEqual(["@a", "@b"]);
  });
});
