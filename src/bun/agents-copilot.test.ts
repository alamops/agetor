import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness, RunEventStream } from "../shared/types.ts";

// agents.ts pulls in db.ts, which opens its sqlite connection at module load,
// so AGETOR_DATA_DIR must be set before the dynamic import.
const dataDirForTest = mkdtempSync(path.join(tmpdir(), "agetor-agents-copilot-db-"));
process.env.AGETOR_DATA_DIR = dataDirForTest;
const { buildCommand, buildHarnessTerminalCommand, harnessEnv, resolveBin, spawnAgent } = await import("./agents.ts");
const { copilotUsagePath } = await import("./copilot-tmux.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

afterAll(() => {
  rmTestDataDir(dataDirForTest);
});

const SAVED_KEYS = [
  "AGETOR_COPILOT_BIN",
  "AGETOR_COPILOT_ARGS",
  "AGETOR_COPILOT_DRIVER",
  "COPILOT_HOME",
] as const;
const saved: Partial<Record<(typeof SAVED_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  process.env.AGETOR_COPILOT_BIN = "copilot";
  delete process.env.AGETOR_COPILOT_ARGS;
  delete process.env.AGETOR_COPILOT_DRIVER;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function copilot(over: Partial<Harness> = {}): Harness {
  return {
    id: "copilot",
    kind: "copilot",
    label: "GitHub Copilot",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
    ...over,
  };
}

function retired(kind: string): Harness {
  return {
    id: kind,
    kind: kind as AgentKind,
    label: kind,
    isBuiltin: false,
    home: null,
    bin: null,
    env: {},
    enabled: true,
  };
}

const RUN_ID = "run-copilot-1";
const SESSION = "11111111-2222-3333-4444-555555555555";
const base = { model: "auto", effort: null, mode: "auto", runId: RUN_ID, sessionId: SESSION };

function argAfter(cmd: string[], flag: string): string | undefined {
  const i = cmd.indexOf(flag);
  return i === -1 ? undefined : cmd[i + 1];
}

describe("buildCommand — copilot argv", () => {
  test("Auto, no effort, fresh session", () => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base });
    expect(cmd).toEqual([
      "copilot",
      "--output-format", "json",
      "--no-color",
      "--no-ask-user",
      "--session-id", SESSION,
      "--model", "auto",
      "--mode", "interactive",
      "--allow-all",
      "--usage-output-file", copilotUsagePath(RUN_ID),
    ]);
  });

  test("the prompt never rides argv", () => {
    const { cmd } = buildCommand(copilot(), "SECRET-PROMPT", { ...base });
    expect(cmd.join(" ")).not.toContain("SECRET-PROMPT");
  });

  test("usage path lives under the data dir's copilot-logs", () => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base });
    const usage = argAfter(cmd, "--usage-output-file")!;
    expect(usage).toBe(copilotUsagePath(RUN_ID));
    expect(usage).toContain("copilot-logs");
    expect(usage).toContain(RUN_ID);
  });

  test.each([
    ["auto", "interactive", true],
    ["plan", "plan", false],
    ["ask", "interactive", false],
  ])("mode %s -> --mode %s, --allow-all %p", (mode, flag, allowAll) => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base, mode });
    expect(argAfter(cmd, "--mode")).toBe(flag);
    expect(cmd.includes("--allow-all")).toBe(allowAll);
  });

  test("a null mode resolves to the kind default (Auto)", () => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base, mode: null });
    expect(argAfter(cmd, "--mode")).toBe("interactive");
    expect(cmd).toContain("--allow-all");
  });

  test.each([
    ["auto", false],
    [null, false],
    ["low", true],
    ["medium", true],
    ["high", true],
    ["xhigh", true],
  ])("effort %p -> --reasoning-effort present: %p", (effort, present) => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base, effort });
    expect(cmd.includes("--reasoning-effort")).toBe(present);
    if (present) expect(argAfter(cmd, "--reasoning-effort")).toBe(effort as string);
  });

  test("resume reuses the prior session id with --session-id", () => {
    const { cmd } = buildCommand(copilot(), "hi", {
      ...base,
      sessionId: null,
      resumeSessionId: "prior-session",
    });
    expect(argAfter(cmd, "--session-id")).toBe("prior-session");
    expect(cmd).not.toContain("--resume");
  });

  test("resumeSessionId wins over sessionId", () => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base, resumeSessionId: "prior-session" });
    expect(argAfter(cmd, "--session-id")).toBe("prior-session");
  });

  test("--model carries the task's model verbatim", () => {
    const { cmd } = buildCommand(copilot(), "hi", { ...base, model: "claude-sonnet-5.5" });
    expect(argAfter(cmd, "--model")).toBe("claude-sonnet-5.5");
  });

  test("AGETOR_COPILOT_ARGS are split and appended", () => {
    process.env.AGETOR_COPILOT_ARGS = "--foo  --bar=baz";
    const { cmd } = buildCommand(copilot(), "hi", { ...base });
    expect(cmd.slice(-2)).toEqual(["--foo", "--bar=baz"]);
    expect(cmd.indexOf("--usage-output-file")).toBeLessThan(cmd.indexOf("--foo"));
  });

  test("a missing model, runId or session id throws a clear error", () => {
    expect(() => buildCommand(copilot(), "hi", { ...base, model: null })).toThrow("model is required for copilot");
    expect(() => buildCommand(copilot(), "hi", { ...base, runId: null })).toThrow("runId is required for copilot");
    expect(() => buildCommand(copilot(), "hi", { ...base, sessionId: null })).toThrow("sessionId or resumeSessionId");
  });

  test("a harness bin overrides the binary", () => {
    const { cmd } = buildCommand(copilot({ bin: "/opt/bin/copilot-x" }), "hi", { ...base });
    expect(cmd[0]).toBe("/opt/bin/copilot-x");
  });
});

describe("buildCommand — copilot env", () => {
  const fakeHome = path.join(os.homedir(), ".copilot");

  test("COPILOT_HOME is pinned to ~/.copilot when nothing else names a home", () => {
    const { env } = buildCommand(copilot(), "hi", { ...base });
    expect(env?.COPILOT_HOME).toBe(fakeHome);
  });

  test("precedence: harness env > harness home > process > ~/.copilot", () => {
    process.env.COPILOT_HOME = "/proc/home";
    expect(buildCommand(copilot(), "hi", { ...base }).env?.COPILOT_HOME).toBe("/proc/home");
    expect(buildCommand(copilot({ home: "/acct/home" }), "hi", { ...base }).env?.COPILOT_HOME).toBe("/acct/home");
    expect(
      buildCommand(copilot({ home: "/acct/home", env: { COPILOT_HOME: "/env/home" } }), "hi", { ...base }).env
        ?.COPILOT_HOME,
    ).toBe("/env/home");
  });

  test("COPILOT_ALLOW_ALL=true only in Auto", () => {
    expect(buildCommand(copilot(), "hi", { ...base, mode: "auto" }).env?.COPILOT_ALLOW_ALL).toBe("true");
    expect(buildCommand(copilot(), "hi", { ...base, mode: "plan" }).env).not.toHaveProperty("COPILOT_ALLOW_ALL");
    expect(buildCommand(copilot(), "hi", { ...base, mode: "ask" }).env).not.toHaveProperty("COPILOT_ALLOW_ALL");
  });

  test("a harness env COPILOT_ALLOW_ALL is never overridden, in any mode", () => {
    for (const mode of ["auto", "plan", "ask"]) {
      const { env } = buildCommand(copilot({ env: { COPILOT_ALLOW_ALL: "false" } }), "hi", { ...base, mode });
      expect(env?.COPILOT_ALLOW_ALL).toBe("false");
    }
  });

  test("stripClassicTokens covers both token vars by default", () => {
    expect(buildCommand(copilot(), "hi", { ...base }).stripClassicTokens).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
  });

  test("stripClassicTokens excludes variables the harness env sets", () => {
    expect(
      buildCommand(copilot({ env: { GH_TOKEN: "x" } }), "hi", { ...base }).stripClassicTokens,
    ).toEqual(["GITHUB_TOKEN"]);
    expect(
      buildCommand(copilot({ env: { GH_TOKEN: "x", GITHUB_TOKEN: "y" } }), "hi", { ...base }).stripClassicTokens,
    ).toEqual([]);
  });

  test("other kinds do not get stripClassicTokens", () => {
    process.env.AGETOR_CODEX_BIN = "codex";
    const out = buildCommand(
      { ...copilot(), id: "codex", kind: "codex", label: "codex" },
      "hi",
      { model: "gpt-6.1-sol", effort: "high", mode: "auto" },
    );
    expect(out.stripClassicTokens).toBeUndefined();
  });
});

describe("harnessEnv / resolveBin / terminal command", () => {
  test("copilot: COPILOT_HOME=<home> when the harness has a home, nothing otherwise", () => {
    expect(harnessEnv(copilot({ home: "/acct/home" }))).toEqual({ COPILOT_HOME: "/acct/home" });
    expect(harnessEnv(copilot())).toEqual({});
  });

  test("copilot: the harness env map wins over the home-derived var", () => {
    expect(harnessEnv(copilot({ home: "/a", env: { COPILOT_HOME: "/b" } }))).toEqual({ COPILOT_HOME: "/b" });
  });

  test("gemini keeps GEMINI_CLI_HOME", () => {
    expect(harnessEnv({ ...copilot({ home: "/g" }), kind: "gemini" })).toEqual({ GEMINI_CLI_HOME: "/g" });
  });

  test("an unknown (retired) kind sets no home var, does not throw, and warns once per kind", () => {
    const warn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...a: unknown[]) => {
      calls.push(a);
    };
    try {
      const h = { ...retired("grok-warn-test"), home: "/x", env: { A: "1" } };
      expect(harnessEnv(h)).toEqual({ A: "1" });
      expect(harnessEnv(h)).toEqual({ A: "1" });
      expect(calls.length).toBe(1);
      expect(String(calls[0]![0])).toContain("grok-warn-test");
    } finally {
      console.warn = warn;
    }
  });

  test("resolveBin: AGETOR_COPILOT_BIN, harness bin, then PATH name", () => {
    expect(resolveBin(copilot())).toBe("copilot");
    process.env.AGETOR_COPILOT_BIN = "/custom/copilot";
    expect(resolveBin(copilot())).toBe("/custom/copilot");
    expect(resolveBin(copilot({ bin: "/harness/copilot" }))).toBe("/harness/copilot");
    delete process.env.AGETOR_COPILOT_BIN;
    expect(path.basename(resolveBin(copilot()))).toBe("copilot");
  });

  test("resolveBin does not throw for a retired kind", () => {
    expect(() => resolveBin(retired("grok"))).not.toThrow();
  });

  test("buildHarnessTerminalCommand pins COPILOT_HOME for an additional account", () => {
    const cmd = buildHarnessTerminalCommand(copilot({ home: "/acct/home" }));
    expect(cmd).toBe("COPILOT_HOME='/acct/home' copilot");
  });

  test("buildHarnessTerminalCommand for the default account is just the binary", () => {
    expect(buildHarnessTerminalCommand(copilot())).toBe("copilot");
  });
});

describe("exhaustive dispatch", () => {
  test.each(["grok", "kimi"])("buildCommand throws for a retired %s row instead of building codex", (kind) => {
    expect(() => buildCommand(retired(kind), "hi", { model: "m", mode: "auto", effort: null })).toThrow(
      `unknown harness kind: ${kind}`,
    );
  });

  test("spawnAgent throws for a retired grok row instead of launching codex", async () => {
    await expect(
      spawnAgent({
        taskId: "t-grok",
        runId: "r-grok",
        harness: retired("grok"),
        prompt: "hi",
        cwd: process.cwd(),
        onChunk: () => {},
        opts: { model: "m", mode: "auto", effort: null },
      }),
    ).rejects.toThrow("unknown harness kind: grok");
  });
});

describe("AGETOR_COPILOT_DRIVER=fake", () => {
  test("fires onSessionId with the fake id and streams assistant text through the real mapper", async () => {
    process.env.AGETOR_COPILOT_DRIVER = "fake";
    const ids: string[] = [];
    const chunks: Array<{ stream: RunEventStream; data: string }> = [];
    const agent = await spawnAgent({
      taskId: "task-fake",
      runId: "run-fake",
      harness: copilot(),
      prompt: "say hi",
      cwd: process.cwd(),
      onChunk: (stream, data) => {
        chunks.push({ stream, data });
      },
      onSessionId: (id) => ids.push(id),
      opts: { model: "auto", mode: "auto", effort: null },
    });
    expect(ids).toEqual(["fake-copilot-session-task-fake"]);
    const code = await agent.done;
    expect(code).toBe(0);
    expect(chunks.some((c) => c.stream === "assistant" && c.data.includes("fake GitHub Copilot"))).toBe(true);
  });

  test("a resumed turn reports the prior session id", async () => {
    process.env.AGETOR_COPILOT_DRIVER = "fake";
    const ids: string[] = [];
    const agent = await spawnAgent({
      taskId: "task-fake-2",
      runId: "run-fake-2",
      harness: copilot(),
      prompt: "again",
      cwd: process.cwd(),
      onChunk: () => {},
      onSessionId: (id) => ids.push(id),
      opts: { model: "auto", mode: "auto", effort: null, resumeSessionId: "prior-id" },
    });
    expect(ids).toEqual(["prior-id"]);
    await agent.done;
  });
});
