import { describe, expect, test } from "bun:test";
import {
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_SERVER_INPUT_ERROR,
  OPENCODE_SESSION_ID_RE,
  OPENCODE_VERSION_RE,
  effectiveOpencodeServer,
  opencodeMajor,
  opencodeModelArgs,
  parseOpencodeServerInput,
} from "./opencode.ts";
import { importedSessionOf } from "./imported-session.ts";
import {
  AGENT_OPTIONS,
  AUTO_ENABLE_KINDS,
  DEFAULT_MODEL,
  HARNESS_TEMPLATES,
  OPENCODE_SERVER_MODES,
  type ImportedClaudeSession,
  type ImportedOpencodeSession,
} from "./types.ts";

describe("opencodeMajor", () => {
  test("v2's `opencode v2.1.3` output is major 2", () => {
    expect(opencodeMajor("opencode v2.1.3")).toBe(2);
  });

  test("v1's bare `1.19.4` output is major 1", () => {
    expect(opencodeMajor("1.19.4")).toBe(1);
  });

  test("any major at or above 2 is 2; below 2 is 1", () => {
    expect(opencodeMajor("2.0.0")).toBe(2);
    expect(opencodeMajor("3.4.5")).toBe(2);
    expect(opencodeMajor("10.0.1")).toBe(2);
    expect(opencodeMajor("0.9.9")).toBe(1);
    expect(opencodeMajor("1.0.0")).toBe(1);
  });

  test("the triple is found anywhere in the string, including after a newline", () => {
    expect(opencodeMajor("opencode version:\n  1.19.4\n")).toBe(1);
    expect(opencodeMajor("v1.2.3-beta")).toBe(1);
  });

  test("unparseable, empty, null and undefined versions are 2", () => {
    expect(opencodeMajor("garbage")).toBe(2);
    expect(opencodeMajor("1.2")).toBe(2);
    expect(opencodeMajor("")).toBe(2);
    expect(opencodeMajor(null)).toBe(2);
    expect(opencodeMajor(undefined)).toBe(2);
  });

  test("OPENCODE_VERSION_RE is unanchored (A2)", () => {
    expect(OPENCODE_VERSION_RE.exec("opencode v2.1.3")?.slice(1)).toEqual(["2", "1", "3"]);
  });
});

describe("effectiveOpencodeServer", () => {
  test("v1 always yields null, whatever the mode or home", () => {
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: null, major: 1 })).toBeNull();
    expect(effectiveOpencodeServer({ mode: "standalone", harnessHome: null, major: 1 })).toBeNull();
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: "/h", major: 1 })).toBeNull();
    expect(effectiveOpencodeServer({ mode: "standalone", harnessHome: "/h", major: 1 })).toBeNull();
  });

  test("v2 with a harness home is always standalone", () => {
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: "/h", major: 2 })).toBe("standalone");
    expect(effectiveOpencodeServer({ mode: "standalone", harnessHome: "/h", major: 2 })).toBe("standalone");
  });

  test("v2 without a home follows the task's mode", () => {
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: null, major: 2 })).toBe("shared");
    expect(effectiveOpencodeServer({ mode: "standalone", harnessHome: null, major: 2 })).toBe("standalone");
  });

  test("an empty or blank home counts as no home", () => {
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: "", major: 2 })).toBe("shared");
    expect(effectiveOpencodeServer({ mode: "shared", harnessHome: "  ", major: 2 })).toBe("shared");
  });
});

describe("opencodeModelArgs", () => {
  for (const major of [1, 2] as const) {
    test(`v${major}: the sentinel and a null model pass no -m, whatever the effort`, () => {
      for (const effort of [null, "auto", "high"]) {
        expect(opencodeModelArgs({ model: OPENCODE_DEFAULT_MODEL, effort, major })).toEqual([]);
        expect(opencodeModelArgs({ model: null, effort, major })).toEqual([]);
        expect(opencodeModelArgs({ model: "", effort, major })).toEqual([]);
      }
    });

    test(`v${major}: a null or auto effort passes only -m`, () => {
      expect(opencodeModelArgs({ model: "opencode/big-pickle", effort: null, major })).toEqual(["-m", "opencode/big-pickle"]);
      expect(opencodeModelArgs({ model: "opencode/big-pickle", effort: "auto", major })).toEqual(["-m", "opencode/big-pickle"]);
      expect(opencodeModelArgs({ model: "opencode/big-pickle", effort: "", major })).toEqual(["-m", "opencode/big-pickle"]);
    });
  }

  test("v2 carries the variant in the model id", () => {
    expect(opencodeModelArgs({ model: "opencode/deepseek-v4.1-flash-free", effort: "high", major: 2 }))
      .toEqual(["-m", "opencode/deepseek-v4.1-flash-free#high"]);
    expect(opencodeModelArgs({ model: "anthropic/claude-x", effort: "thinking", major: 2 }))
      .toEqual(["-m", "anthropic/claude-x#thinking"]);
  });

  test("v1 passes the variant as --variant", () => {
    expect(opencodeModelArgs({ model: "opencode/deepseek-v4.1-flash-free", effort: "high", major: 1 }))
      .toEqual(["-m", "opencode/deepseek-v4.1-flash-free", "--variant", "high"]);
  });
});

describe("parseOpencodeServerInput", () => {
  test("absent passes through as undefined", () => {
    expect(parseOpencodeServerInput(undefined)).toBeUndefined();
  });

  test("valid values pass as themselves", () => {
    expect(parseOpencodeServerInput("shared")).toBe("shared");
    expect(parseOpencodeServerInput("standalone")).toBe("standalone");
  });

  test("anything else is the route's 400 error", () => {
    for (const v of [null, "", "Shared", "private", 1, true, {}, []]) {
      expect(parseOpencodeServerInput(v)).toEqual({ error: OPENCODE_SERVER_INPUT_ERROR });
    }
    expect(OPENCODE_SERVER_INPUT_ERROR).toBe("opencodeServer must be one of shared, standalone");
  });
});

describe("opencode constants and tables", () => {
  test("the sentinel is the default model, the only curated row, pinned, and slash-free", () => {
    expect(OPENCODE_DEFAULT_MODEL).toBe("opencode-default");
    expect(DEFAULT_MODEL.opencode).toBe(OPENCODE_DEFAULT_MODEL);
    expect(AGENT_OPTIONS.opencode.models).toHaveLength(1);
    expect(AGENT_OPTIONS.opencode.models[0]).toMatchObject({ id: OPENCODE_DEFAULT_MODEL, label: "OpenCode default", pinned: true });
    expect(OPENCODE_DEFAULT_MODEL).not.toContain("/");
    expect(OPENCODE_DEFAULT_MODEL).not.toBe("default");
  });

  test("modes are Auto then Plan; efforts are just Model default", () => {
    expect(AGENT_OPTIONS.opencode.modes.map((m) => m.id)).toEqual(["auto", "plan"]);
    expect(AGENT_OPTIONS.opencode.efforts.map((e) => e.id)).toEqual(["auto"]);
  });

  test("OPENCODE_SERVER_MODES lists both modes, shared first", () => {
    expect([...OPENCODE_SERVER_MODES]).toEqual(["shared", "standalone"]);
  });

  test("AUTO_ENABLE_KINDS is exactly codex, cursor, gemini, fx and opencode", () => {
    expect([...AUTO_ENABLE_KINDS].sort()).toEqual(["codex", "cursor", "fx", "gemini", "opencode"]);
  });

  test("the additional-OpenCode template suggests opencode-2 under the data dir", () => {
    const t = HARNESS_TEMPLATES.find((x) => x.id === "opencode-additional");
    expect(t).toMatchObject({
      kind: "opencode",
      label: "Additional OpenCode",
      suggestedHarnessId: "opencode-2",
      home: "{dataDir}/harnesses/opencode-2",
      bin: null,
      env: {},
    });
  });

  test("OPENCODE_SESSION_ID_RE matches OpenCode ids and not Claude uuids", () => {
    expect(OPENCODE_SESSION_ID_RE.test("ses_2a1b3c4dFFee")).toBe(true);
    expect(OPENCODE_SESSION_ID_RE.test("0f8c2a4e-1b2c-4d5e-8f9a-0b1c2d3e4f5a")).toBe(false);
  });
});

describe("importedSessionOf", () => {
  const claude: ImportedClaudeSession = {
    sessionId: "0f8c2a4e-1b2c-4d5e-8f9a-0b1c2d3e4f5a",
    gitBranch: null,
    importedAt: 1,
    configDir: "/c",
    status: "ready",
    backfillOffset: 0,
    error: null,
  };
  const opencode: ImportedOpencodeSession = {
    sessionId: "ses_abc",
    harnessId: "opencode",
    directory: "/repo",
    importedAt: 2,
    status: "failed",
    error: "export failed",
  };

  test("null when neither is set (absent, null or undefined)", () => {
    expect(importedSessionOf({})).toBeNull();
    expect(importedSessionOf({ importedClaude: null, importedOpencode: null })).toBeNull();
  });

  test("a Claude import", () => {
    expect(importedSessionOf({ importedClaude: claude })).toEqual({
      kind: "claude-code",
      sessionId: claude.sessionId,
      status: "ready",
      error: null,
    });
  });

  test("an OpenCode import", () => {
    expect(importedSessionOf({ importedClaude: null, importedOpencode: opencode })).toEqual({
      kind: "opencode",
      sessionId: "ses_abc",
      status: "failed",
      error: "export failed",
    });
  });

  test("Claude wins if both are set", () => {
    expect(importedSessionOf({ importedClaude: claude, importedOpencode: opencode })?.kind).toBe("claude-code");
  });
});
