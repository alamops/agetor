import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProbeArgv, parseClaudeInitModels, probeClaudeModels } from "./claude-probe.ts";

const FIXTURES = new URL("../fixtures/model-discovery/", import.meta.url);
const current = JSON.parse(readFileSync(new URL("claude-init-2.1.326.json", FIXTURES), "utf8")) as { models: unknown[] };
const old = JSON.parse(readFileSync(new URL("claude-init-old.json", FIXTURES), "utf8")) as { models: unknown[] };

// Fake bins live under /tmp (not $TMPDIR, which accumulates thousands of leaked dirs).
const dir = path.join("/tmp", `agetor-claude-probe-${process.pid}-${Date.now()}`);
const cwd = path.join(dir, "cwd");

beforeAll(() => {
  mkdirSync(cwd, { recursive: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stub `claude` that logs its argv and answers one control request. */
function writeStub(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("parseClaudeInitModels", () => {
  test("current CLI: 13 rows by rule, default row dropped and marks cliDefault", () => {
    const rows = parseClaudeInitModels(current);
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ id: "opus-5.5", alias: "opus", cliId: "claude-opus-5-5", cliDefault: true, label: "Opus 5.5" });
    expect(rows.filter((r) => r.cliDefault)).toHaveLength(1);
    expect(rows.map((r) => r.id)).toEqual([
      "opus-5.5", "fable-5.2", "sonnet-5.5", "haiku-5.5", "fable-5.1", "haiku-4.5", "sonnet-5", "opus-5",
      "fable-5", "opus-4.8", "opus-4.7", "opus-4.6", "sonnet-4.6",
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.find((r) => r.id === "haiku-4.5")).toMatchObject({ cliId: "claude-haiku-4-5-20251001", label: "Haiku 4.5" });
  });

  test("efforts keep CLI order and exist only when the model supports them", () => {
    const rows = parseClaudeInitModels(current);
    expect(rows.find((r) => r.id === "opus-4.6")?.efforts).toEqual(["low", "medium", "high", "max"]);
    expect(rows.find((r) => r.id === "opus-5.5")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(rows.find((r) => r.id === "haiku-4.5")?.efforts).toBeUndefined();
  });

  test("fast only when supportsFastMode is true; never attached as false", () => {
    const rows = parseClaudeInitModels(current);
    expect(rows.find((r) => r.id === "opus-5.5")?.fast).toBe(true);
    expect(rows.find((r) => r.id === "sonnet-5.5")).not.toHaveProperty("fast");
  });

  test("pre-2.1.49 shape: aliases without a resolvedModel are skipped, full ids keep a label and no efforts", () => {
    const rows = parseClaudeInitModels(old);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.label).toBeTruthy();
      expect(r.efforts).toBeUndefined();
      expect(r.fast).toBeUndefined();
    }
  });

  test("a model the CLI invents derives its id and keeps an unknown effort", () => {
    const rows = parseClaudeInitModels({
      models: [{ value: "claude-opus-6", resolvedModel: "claude-opus-6", displayName: "Opus 6", supportsEffort: true, supportedEffortLevels: ["low", "turbo", "max"] }],
    });
    expect(rows).toEqual([{ id: "opus-6", cliId: "claude-opus-6", label: "Opus 6", efforts: ["low", "turbo", "max"] }]);
  });

  test("labels are sanitized", () => {
    const rows = parseClaudeInitModels({ models: [{ value: "claude-opus-6", resolvedModel: "claude-opus-6", displayName: "Opus​ 6\u0007" }] });
    expect(rows[0]?.label).toBe("Opus 6");
  });

  test("malformed input yields []", () => {
    for (const bad of [null, undefined, 5, "x", {}, { models: "no" }, { models: [null, 3, {}] }]) {
      expect(parseClaudeInitModels(bad)).toEqual([]);
    }
  });
});

describe("claudeProbeArgv", () => {
  test("carries the isolation flags and never AGETOR_CLAUDE_ARGS", () => {
    process.env.AGETOR_CLAUDE_ARGS = "--dangerously-skip-permissions";
    try {
      const argv = claudeProbeArgv("/x/claude");
      expect(argv[0]).toBe("/x/claude");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).toContain("--no-session-persistence");
      expect(argv[argv.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
      expect(argv).not.toContain("--dangerously-skip-permissions");
    } finally {
      delete process.env.AGETOR_CLAUDE_ARGS;
    }
  });
});

describe("probeClaudeModels", () => {
  test("a stub answers the initialize request: models parsed, argv recorded, account never surfaces", async () => {
    const argvLog = path.join(dir, "argv.log");
    const response = path.join(dir, "init.json");
    writeFileSync(response, JSON.stringify({ models: current.models, account: { email: "leak@example.com", organization: "Leaky Org" } }));
    const bin = writeStub("claude-ok", `printf '%s\\n' "$@" > "${argvLog}"\nread line\nprintf '{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":%s}}\\n' "$(cat "${response}")"\nsleep 5`);
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const started = Date.now();
      const rows = await probeClaudeModels({ bin, cwd, timeoutMs: 4000 });
      expect(Date.now() - started).toBeLessThan(4000); // answered, did not wait out the stub's sleep
      expect(rows).toHaveLength(13);
      expect(JSON.stringify(rows)).not.toContain("leak@example.com");
      expect(JSON.stringify(rows)).not.toContain("Leaky Org");
      for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain("leak@example.com");
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const argv = readFileSync(argvLog, "utf8").split("\n");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain('{"disableAllHooks":true}');
  });

  test("a stub that never answers is killed at the budget and yields []", async () => {
    const pidFile = path.join(dir, "silent.pid");
    const bin = writeStub("claude-silent", `echo $$ > "${pidFile}"\nsleep 30`);
    const started = Date.now();
    expect(await probeClaudeModels({ bin, cwd, timeoutMs: 300 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await Bun.sleep(100);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  test("garbage, an error reply, a missing binary and a non-zero exit all yield []", async () => {
    const garbage = writeStub("claude-garbage", "read line\necho 'not json'\necho '{\"type\":\"other\"}'");
    expect(await probeClaudeModels({ bin: garbage, cwd, timeoutMs: 2000 })).toEqual([]);
    const err = writeStub("claude-err", `read line\nprintf '{"type":"control_response","response":{"subtype":"error","request_id":"init-1","error":"nope"}}\\n'`);
    expect(await probeClaudeModels({ bin: err, cwd, timeoutMs: 2000 })).toEqual([]);
    expect(await probeClaudeModels({ bin: path.join(dir, "does-not-exist"), cwd, timeoutMs: 2000 })).toEqual([]);
    const fail = writeStub("claude-fail", "exit 3");
    expect(await probeClaudeModels({ bin: fail, cwd, timeoutMs: 2000 })).toEqual([]);
  });
});
