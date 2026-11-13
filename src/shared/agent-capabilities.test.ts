import { describe, expect, test } from "bun:test";
import { mergeAgentCapabilities, type CapabilityLists } from "./agent-capabilities.ts";

// Structural fixtures: the merge is generic over each process's own copy of
// the discovery types and only reads `name` / `insert`.
type Command = { name: string; description: string; source: string; kind: string };
type Extension = { name: string; insert: string; description: string; source: string; kind: string };

const command = (name: string, source = "/a"): Command => ({
  name,
  description: `${name} from ${source}`,
  source: "project",
  kind: "command",
});

const extension = (name: string, insert: string, source = "/a"): Extension => ({
  name,
  insert,
  description: `${name} from ${source}`,
  source: "project",
  kind: "mcp",
});

function capabilities(commands: Command[], extensions: Extension[]): CapabilityLists<Command, Extension> {
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

  test("entries come back as the same objects, extra fields intact", () => {
    // The CLI prints `--json` straight from the merge, so a field only one
    // side's type declares must survive it.
    const rich = { ...command("rich"), argumentHint: "<file>" };
    const ext = { ...extension("Rich", "@rich"), server: "local" };
    const merged = mergeAgentCapabilities([{ commands: [rich], extensions: [ext] }]);
    expect(merged.commands[0]).toBe(rich);
    expect(merged.extensions[0]).toBe(ext);
    expect(merged.commands[0]!.argumentHint).toBe("<file>");
  });
});
