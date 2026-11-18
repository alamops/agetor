import { describe, expect, test } from "bun:test";
import { AGENT_OPTIONS } from "./types.ts";
import { claudeCliModelFor, claudeIdFromCliModel, CLAUDE_CLI_MODEL_EXCEPTIONS } from "./claude-model-id.ts";

// Today's `CLAUDE_MODEL_FLAG` table, frozen: the rule must reproduce every pair.
const LEGACY: Record<string, string> = {
  "mythos-5.2": "claude-mythos-5-2",
  "mythos-5.1": "claude-mythos-5-1",
  "fable-5.2": "claude-fable-5-2",
  "fable-5.1": "claude-fable-5-1",
  "mythos-5": "claude-mythos-5",
  "fable-5": "claude-fable-5",
  "opus-5.5": "claude-opus-5-5",
  "opus-5": "claude-opus-5",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-5.5": "claude-sonnet-5-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "haiku-5.5": "claude-haiku-5-5",
  "haiku-4.5": "claude-haiku-4-5",
};

describe("claude model id rule", () => {
  test("all 16 legacy pairs round-trip", () => {
    expect(Object.keys(LEGACY)).toHaveLength(16);
    for (const [id, cli] of Object.entries(LEGACY)) {
      expect(claudeCliModelFor(id), id).toBe(cli);
      expect(claudeIdFromCliModel(cli), cli).toBe(id);
    }
  });

  test("every curated claude row follows the rule", () => {
    for (const m of AGENT_OPTIONS["claude-code"].models) {
      expect(claudeIdFromCliModel(claudeCliModelFor(m.id)), m.id).toBe(m.id);
    }
  });

  test("dated, new-family, alias and default ids", () => {
    expect(claudeIdFromCliModel("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
    expect(claudeIdFromCliModel("claude-opus-6")).toBe("opus-6");
    expect(claudeIdFromCliModel("claude-opus-5-5")).toBe("opus-5.5");
    expect(claudeIdFromCliModel("default")).toBeNull();
    expect(claudeIdFromCliModel("opus")).toBeNull();
    expect(claudeIdFromCliModel("claude-3-5-sonnet-20241022")).toBeNull();
    expect(claudeCliModelFor("opus-6")).toBe("claude-opus-6");
  });

  test("a discovered cliId wins over the rule; unfriendly ids pass verbatim", () => {
    expect(claudeCliModelFor("haiku-4.5", [{ id: "haiku-4.5", cliId: "claude-haiku-4-5-20251001" }])).toBe("claude-haiku-4-5-20251001");
    expect(claudeCliModelFor("my_custom/model")).toBe("my_custom/model");
    expect(claudeCliModelFor("opus")).toBe("opus");
  });

  test("the exception table starts empty", () => {
    expect(Object.keys(CLAUDE_CLI_MODEL_EXCEPTIONS)).toEqual([]);
  });
});
