import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COPILOT_ACP_PROBE_ENV,
  copilotAcpProbeEnabled,
  parseCopilotSessionNew,
  probeCopilotAcp,
} from "./copilot-acp-probe.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/model-discovery/copilot-acp-session-new.json", import.meta.url), "utf8"));
const dir = path.join("/tmp", `agetor-copilot-acp-${process.pid}-${Date.now()}`);

beforeAll(() => mkdirSync(dir, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stub ACP server: records every JSON-RPC method it receives, answers initialize and session/new. */
function writeServer(name: string, sessionNewReply: string): { bin: string; methods: string } {
  const methods = path.join(dir, `${name}.methods`);
  const reply = path.join(dir, `${name}.reply.json`);
  writeFileSync(reply, `${sessionNewReply}\n`);
  const bin = path.join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh
while read line; do
  case "$line" in
    *'"method":"initialize"'*) echo initialize >> "${methods}"; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}';;
    *'"method":"session/new"'*) echo session/new >> "${methods}"; cat "${reply}";;
    *'"method"'*) echo "$line" | sed 's/.*"method":"\\([^"]*\\)".*/\\1/' >> "${methods}";;
  esac
done
`,
  );
  chmodSync(bin, 0o755);
  return { bin, methods };
}

describe("parseCopilotSessionNew", () => {
  test("models from the model config option; efforts only on the current model, with CLI labels", () => {
    const rows = parseCopilotSessionNew(fixture);
    expect(rows.map((r) => r.id)).toEqual(["claude-sonnet-4.5", "gpt-5", "gpt-5-mini"]);
    expect(rows[0]).toMatchObject({
      label: "Claude Sonnet 4.5",
      efforts: ["low", "medium", "high", "turbo"],
      effortLabels: { turbo: "Turbo Think" },
    });
    expect(rows[1]?.efforts).toBeUndefined();
    expect(rows[2]?.efforts).toBeUndefined();
  });

  test("falls back to models.availableModels", () => {
    const rows = parseCopilotSessionNew({ models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M One" }, { modelId: "m2" }] } });
    expect(rows).toEqual([{ id: "m1", label: "M One" }, { id: "m2" }]);
  });

  test("grouped options flatten; garbage yields []", () => {
    const rows = parseCopilotSessionNew({ configOptions: [{ category: "model", options: [{ group: "g", options: [{ value: "a" }, { value: "b" }] }] }] });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    for (const bad of [null, 3, "x", {}, { configOptions: [] }, { configOptions: [{ category: "model", options: [] }] }]) {
      expect(parseCopilotSessionNew(bad)).toEqual([]);
    }
  });
});

describe("kill switch", () => {
  test("AGETOR_COPILOT_ACP_PROBE off values disable the probe", () => {
    for (const v of ["0", "false", "off", "no", " OFF "]) expect(copilotAcpProbeEnabled({ [COPILOT_ACP_PROBE_ENV]: v }), v).toBe(false);
    for (const v of [undefined, "", "1", "true"]) expect(copilotAcpProbeEnabled({ [COPILOT_ACP_PROBE_ENV]: v }), String(v)).toBe(true);
  });

  test("a disabled probe spawns nothing", async () => {
    const { bin, methods } = writeServer("acp-disabled", JSON.stringify({ jsonrpc: "2.0", id: 2, result: fixture }));
    process.env[COPILOT_ACP_PROBE_ENV] = "0";
    try {
      expect(await probeCopilotAcp({ bin, cwd: dir })).toEqual([]);
    } finally {
      delete process.env[COPILOT_ACP_PROBE_ENV];
    }
    expect(existsSync(methods)).toBe(false);
  });
});

describe("probeCopilotAcp", () => {
  test("speaks initialize then session/new only — never prompt, set_config_option, set_model or set_mode", async () => {
    const { bin, methods } = writeServer("acp-ok", JSON.stringify({ jsonrpc: "2.0", id: 2, result: fixture }));
    const rows = await probeCopilotAcp({ bin, cwd: dir, timeoutMs: 4000 });
    expect(rows).toHaveLength(3);
    const seen = readFileSync(methods, "utf8").trim().split("\n");
    expect(seen).toEqual(["initialize", "session/new"]);
    for (const forbidden of ["session/prompt", "session/set_config_option", "session/set_model", "session/set_mode"]) {
      expect(seen).not.toContain(forbidden);
    }
  });

  test("an error reply, garbage and a silent server yield []", async () => {
    const err = writeServer("acp-err", JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -1, message: "nope" } }));
    expect(await probeCopilotAcp({ bin: err.bin, cwd: dir, timeoutMs: 2000 })).toEqual([]);
    const garbage = writeServer("acp-garbage", "not json");
    expect(await probeCopilotAcp({ bin: garbage.bin, cwd: dir, timeoutMs: 600 })).toEqual([]);
    const silent = path.join(dir, "acp-silent");
    writeFileSync(silent, "#!/bin/sh\nsleep 30\n");
    chmodSync(silent, 0o755);
    const started = Date.now();
    expect(await probeCopilotAcp({ bin: silent, cwd: dir, timeoutMs: 300 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await probeCopilotAcp({ bin: path.join(dir, "missing"), cwd: dir, timeoutMs: 500 })).toEqual([]);
  });
});
