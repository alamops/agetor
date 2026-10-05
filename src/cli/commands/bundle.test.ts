import { test, expect, mock, afterAll, beforeEach, describe } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import { type BundleExportResponse, parseBundleText } from "../../shared/bundle.ts";
import type { BundleImportPlan, BundleImportResponse, PlannedAgent } from "../../shared/bundle-import.ts";
import { makeAgentProfile, makePipelineFixture } from "../test-fixtures.ts";

/**
 * `agetor export` / `agetor import` (and the profile/pipeline shortcuts) —
 * docs/plans/agents-pipelines-import-export.md K15. Same mocking idiom as
 * `pipeline.test.ts`: `../context.ts` for `getClient`, `../output.ts` to
 * capture `out()`/`errln()`/`printJson()` with an identity palette.
 */

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errors: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

const id = (s: string) => s;
mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
  c: { dim: id, bold: id, red: id, green: id, yellow: id, cyan: id, gray: id, magenta: id, blue: id },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: (msg = "") => {
    errors.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const {
  cmdExport,
  cmdExportOne,
  cmdImport,
  askImport,
  cmdImportAs,
  expandTabs,
  importPlanLines,
  interactiveImport,
  readCappedText,
  readStreamText,
  textBlockLines,
  importResultLines,
  parseExportFlags,
  parseHarnessMap,
  parseImportFlags,
  unknownHarnessMapError,
  splitPositional,
  THIRD_PARTY_NOTE,
} = await import("./bundle.ts");
const { cmdAgentProfile } = await import("./agent-profile.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdExport>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdExport>[1];

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  jsonOutputs.length = 0;
  currentClient = null;
});

const TEXT = '{\n  "format": "agetor-bundle"\n}\n';

function exportResponse(over: Partial<BundleExportResponse> = {}): BundleExportResponse {
  return {
    text: TEXT,
    filename: "x.agetor.json",
    warnings: [],
    counts: { agents: 1, pipelines: 0 },
    ...over,
  };
}

function plannedAgent(over: Partial<PlannedAgent> = {}): PlannedAgent {
  return {
    key: "worker",
    sourceName: "Worker",
    name: "Worker",
    renamed: false,
    fileHarness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
    resolution: "fallback",
    harnessId: "claude-code",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    candidateHarnessIds: ["claude-code"],
    model: "opus-5.5",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    warnings: [],
    errors: [],
    ...over,
  };
}

function plan(over: Partial<BundleImportPlan> = {}): BundleImportPlan {
  return {
    legacy: false,
    agents: [],
    pipelines: [],
    harnesses: [],
    localHarnesses: [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true, enabled: true, available: true, loggedIn: null, reason: null, installHint: null },
      { id: "codex", kind: "codex", label: "Codex", isBuiltin: true, enabled: false, available: true, loggedIn: null, reason: null, installHint: null },
    ],
    warnings: [],
    blocking: [],
    canImport: true,
    fingerprint: "fp-1",
    ...over,
  };
}

const VALID_BUNDLE = JSON.stringify({
  format: "agetor-bundle",
  version: 1,
  agents: [
    { key: "worker", name: "Worker", harness: { id: "secondary-claude-code", kind: "claude-code", label: "L" }, model: "opus-5.5" },
  ],
});

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-bundle-cli-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("flag parsers", () => {
  test("parseExportFlags: repeatable selectors, --agent alias, --all, --out, --force", () => {
    expect(
      parseExportFlags(["--profile", "a", "--agent", "b", "--pipeline", "p", "--out", "-", "--force"]),
    ).toEqual({ profiles: ["a", "b"], pipelines: ["p"], all: false, out: "-", force: true });
    expect(parseExportFlags(["--all"])).toEqual({ profiles: [], pipelines: [], all: true, force: false });
  });

  test("parseExportFlags: unknown flags, positionals and missing values throw", () => {
    expect(() => parseExportFlags(["--nope"])).toThrow(/usage: agetor export/);
    expect(() => parseExportFlags(["stray"])).toThrow(/usage: agetor export/);
    expect(() => parseExportFlags(["--profile"])).toThrow(/needs a value/);
    // An empty value is no value: --out "" must not fall back to stdout.
    expect(() => parseExportFlags(["--all", "--out", ""])).toThrow("'--out' needs a value");
    expect(() => parseExportFlags(["--pipeline", " "])).toThrow("'--pipeline' needs a value");
    expect(() => parseExportFlags(["--profile", ""])).toThrow("'--profile' needs a value");
    expect(() => parseExportFlags(["--agent", " "])).toThrow("'--agent' needs a value");
    expect(() => parseExportFlags(["--x"], "profile export")).toThrow(/usage: agetor profile export/);
  });

  test("parseImportFlags: every flag, repeatable --harness-map", () => {
    expect(
      parseImportFlags(["--dry-run", "--harness-map", "a=b", "--harness-map", "c = d", "--name", "N", "--enable-harnesses"]),
    ).toEqual({ dryRun: true, harnessMap: { a: "b", c: "d" }, name: "N", enableHarnesses: true, yes: false });
    expect(parseImportFlags([])).toEqual({ dryRun: false, harnessMap: {}, enableHarnesses: false, yes: false });
    expect(parseImportFlags(["--yes"]).yes).toBe(true);
    expect(parseImportFlags(["-y"]).yes).toBe(true);
    expect(() => parseImportFlags(["--force"])).toThrow(/usage: agetor import/);
    expect(() => parseImportFlags(["--name", ""])).toThrow("'--name' needs a value");
    expect(() => parseImportFlags(["--harness-map", "  "])).toThrow("'--harness-map' needs a value");
    // A file harness id may start with a dash; the printed hint pastes back.
    expect(parseImportFlags(["--harness-map", "-work=claude-code", "--dry-run"])).toEqual({
      dryRun: true,
      harnessMap: { "-work": "claude-code" },
      enableHarnesses: false,
      yes: false,
    });
    // Without an "=", a dash value is still another flag swallowed by mistake.
    expect(() => parseImportFlags(["--harness-map", "--dry-run"])).toThrow("'--harness-map' needs a value");
  });

  test("unknownHarnessMapError: only keys no Agent uses are reported", () => {
    const parsed = parseBundleText(VALID_BUNDLE);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(unknownHarnessMapError({}, parsed.bundle)).toBeNull();
    expect(unknownHarnessMapError({ "secondary-claude-code": "claude-2" }, parsed.bundle)).toBeNull();
    expect(unknownHarnessMapError({ "secondary-claude-code": "claude-2", a: "b", "x\u001b": "y" }, parsed.bundle)).toBe(
      '--harness-map names harnesses this file doesn\'t use: "a", "x\\u001b" — its Agents use: "secondary-claude-code"',
    );
    const legacy = parseBundleText(JSON.stringify({ name: "P", graph: { steps: [], edges: [], startStepId: null } }));
    if (!legacy.ok) throw new Error(legacy.error);
    expect(unknownHarnessMapError({ a: "b" }, legacy.bundle)).toBe(
      '--harness-map names a harness this file doesn\'t use: "a" — the file has no Agents, so there is nothing to map',
    );
  });

  test("the --harness-map hint for a dash-leading file id parses back", () => {
    const unknownKind = { code: "unknown-kind", message: "grok" };
    const text = importPlanLines(
      plan({
        agents: [
          plannedAgent({
            fileHarness: { id: "-work", kind: "grok-next" as never, label: "Grok" },
            resolution: "unresolved",
            harnessId: null,
            harnessKind: null,
            harnessLabel: null,
            candidateHarnessIds: ["claude-code"],
            errors: [unknownKind],
          }),
        ],
        blocking: [unknownKind],
        canImport: false,
      }),
    ).join("\n");
    const flag = /--harness-map (\S+)<localHarnessId>/.exec(text)?.[1];
    expect(flag).toBe("-work=");
    expect(parseImportFlags(["--harness-map", `${flag}claude-code`]).harnessMap).toEqual({ "-work": "claude-code" });
  });

  test("splitPositional: the one positional wherever it sits, skipping flag values", () => {
    const values = new Set(["--name", "--out"]);
    expect(splitPositional(["f.json", "--dry-run"], values)).toEqual({ positional: "f.json", rest: ["--dry-run"] });
    expect(splitPositional(["--dry-run", "f.json"], values)).toEqual({ positional: "f.json", rest: ["--dry-run"] });
    // A value flag's value is never the positional.
    expect(splitPositional(["--name", "N", "f.json"], values)).toEqual({ positional: "f.json", rest: ["--name", "N"] });
    expect(splitPositional(["--out", "-", "Ref"], values)).toEqual({ positional: "Ref", rest: ["--out", "-"] });
    // "-" is stdin, a positional.
    expect(splitPositional(["--yes", "-"], values)).toEqual({ positional: "-", rest: ["--yes"] });
    expect(splitPositional(["--yes"], values)).toEqual({ positional: undefined, rest: ["--yes"] });
    // A second positional stays in `rest`, where the flag parser refuses it.
    expect(splitPositional(["a", "b"], values)).toEqual({ positional: "a", rest: ["b"] });
  });

  test("parseHarnessMap: <fileId>=<localId>, later wins, malformed throws", () => {
    // Split on the last "=": a local id never has one, a file's id may.
    expect(parseHarnessMap(["x=y", "x=z", "a=b=c"])).toEqual({ x: "z", "a=b": "c" });
    expect(parseHarnessMap(["acct=work=claude-code"])).toEqual({ "acct=work": "claude-code" });
    expect(() => parseHarnessMap(["nope"])).toThrow(/expects <fileHarnessId>=<localHarnessId>/);
    expect(() => parseHarnessMap(["=y"])).toThrow();
    expect(() => parseHarnessMap(["x="])).toThrow();
    // An own property, not the prototype setter — the mapping survives.
    const proto = parseHarnessMap(["__proto__=claude-code"]);
    expect(Object.keys(proto)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(proto, "__proto__")?.value).toBe("claude-code");
    expect(JSON.parse(JSON.stringify(proto))).toEqual(JSON.parse('{"__proto__":"claude-code"}'));
  });
});

describe("printers", () => {
  test("importPlanLines: agents with their bound harness and resolution, pipelines, warnings", () => {
    const lines = importPlanLines(
      plan({
        agents: [plannedAgent(), plannedAgent({ key: "b", name: "Bee (imported)", sourceName: "Bee", renamed: true, resolution: "exact" })],
        pipelines: [
          { index: 0, sourceName: "P", name: "P", renamed: false, description: "", maxSteps: 25, steps: [], graph: { steps: [], edges: [], startStepId: null }, warnings: [], errors: [] },
        ],
        harnesses: [{ id: "codex", kind: "codex", label: "Codex", enabled: false, canEnable: true, willEnable: false, enableRequested: false, warnings: [] }],
        warnings: [{ code: "harness-fallback", message: "falls back" }],
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("2 Agents to create:");
    expect(text).toContain("+ Worker → Claude Code (claude-code) — fallback for Claude Code (secondary) (secondary-claude-code)");
    expect(text).toContain('+ Bee (imported) (was "Bee") → Claude Code (claude-code)');
    expect(text).toContain("1 Pipeline to create:");
    expect(text).toContain("+ P — 0 steps");
    expect(text).toContain("! falls back");
    expect(text).toContain("pass --enable-harnesses to enable codex");
  });

  test("importPlanLines: the third-party note, then skills, instructions and step instructions for review", () => {
    const text = importPlanLines(
      plan({
        agents: [
          plannedAgent({ skills: ["review"], instructions: "Be terse.\nNever\u202e push." }),
          plannedAgent({ key: "b", name: "Long", instructions: Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n") }),
        ],
        pipelines: [
          {
            index: 0,
            sourceName: "P",
            name: "P",
            renamed: false,
            description: "What P does",
            maxSteps: 25,
            steps: [
              { id: "s1", name: "Plan", instructions: "Write the plan.", agentKey: "worker", agentName: "Worker", legacy: null },
              { id: "s2", name: "Quiet", instructions: "", agentKey: null, agentName: null, legacy: null },
            ],
            graph: { steps: [], edges: [], startStepId: null },
            warnings: [],
            errors: [],
          },
        ],
      }),
    ).join("\n");
    expect(text.startsWith(THIRD_PARTY_NOTE)).toBe(true);
    expect(text).toContain("      skills: /review");
    expect(text).toContain("      instructions:\n      │ Be terse.\n      │ Never\\u202e push.");
    expect(text).toContain("      │ line 40\n      │ … 5 more lines — read them in the file");
    expect(text).not.toContain("line 41");
    expect(text).toContain("      description:\n      │ What P does");
    expect(text).toContain('      step "Plan" instructions:\n      │ Write the plan.');
    expect(text).not.toContain('step "Quiet"');
  });

  test("importPlanLines: blocking issues carry hints; legacy files are labelled", () => {
    const unknownKind = { code: "unknown-kind", message: "grok" };
    const harness = importPlanLines(
      plan({
        legacy: true,
        agents: [
          plannedAgent({
            fileHarness: { id: "grok-2", kind: "grok-next" as never, label: "Grok" },
            resolution: "unresolved",
            harnessId: null,
            harnessKind: null,
            harnessLabel: null,
            candidateHarnessIds: ["claude-code", "codex"],
            errors: [unknownKind],
          }),
        ],
        blocking: [unknownKind],
        canImport: false,
      }),
    ).join("\n");
    expect(harness).toContain("legacy file");
    expect(harness).toContain("1 blocking issue:");
    expect(harness).toContain("✗ grok");
    expect(harness).toContain("hint: map grok-2 to a local harness with --harness-map grok-2=<localHarnessId> — it can use: claude-code (claude-code), codex (codex)");
    // A file harness id is third-party text: shell-quoted inside the
    // pasteable flag, so copying the hint can't run it.
    const hostileId = "$(touch /tmp/pwned)";
    const hostile = importPlanLines(
      plan({
        agents: [
          plannedAgent({
            fileHarness: { id: hostileId, kind: "grok-next" as never, label: "Grok" },
            resolution: "unresolved",
            harnessId: null,
            harnessKind: null,
            harnessLabel: null,
            candidateHarnessIds: ["claude-code"],
            errors: [unknownKind],
          }),
        ],
        blocking: [unknownKind],
        canImport: false,
      }),
    ).join("\n");
    expect(hostile).toContain("--harness-map '$(touch /tmp/pwned)='<localHarnessId>");
    expect(hostile).not.toContain("--harness-map $(");
    const name = importPlanLines(plan({ blocking: [{ code: "name-in-use", message: "taken" }] }), { singleNameFlag: true }).join("\n");
    expect(name).toContain("hint: pick another --name");
    const notApplicable = importPlanLines(plan({ blocking: [{ code: "name-not-applicable", message: "x" }] })).join("\n");
    expect(notApplicable).toContain("--name only applies");
  });

  test("importPlanLines: the --harness-map hint names only harnesses the blocked Agent can bind to", () => {
    const retired = { id: "kimi", kind: "kimi" as never, label: "Kimi", isBuiltin: true, enabled: true, available: true, loggedIn: null, reason: null, installHint: null };
    const localHarnesses = [...plan().localHarnesses, retired];
    const mismatch = { code: "harness-kind-mismatch", message: "wrong kind" };
    const unsupported = { code: "unsupported-local-harness", message: "kimi can't run" };
    const text = importPlanLines(
      plan({
        localHarnesses,
        agents: [
          // An override to a wrong-kind harness: only same-kind candidates.
          plannedAgent({ resolution: "unresolved", harnessId: null, candidateHarnessIds: ["claude-code"], errors: [mismatch] }),
          // A second Agent on the same file harness shares one hint line.
          plannedAgent({ key: "b", resolution: "unresolved", harnessId: null, candidateHarnessIds: ["claude-code"], errors: [mismatch] }),
          // An unknown kind mapped onto a retired-kind harness: the retired one is never suggested.
          plannedAgent({
            key: "c",
            fileHarness: { id: "future-1", kind: "future" as never, label: "Future" },
            resolution: "unresolved",
            harnessId: null,
            candidateHarnessIds: ["claude-code", "codex"],
            errors: [unsupported],
          }),
          // No candidate at all.
          plannedAgent({
            key: "d",
            fileHarness: { id: "codex-2", kind: "codex", label: "Codex 2" },
            resolution: "unresolved",
            harnessId: null,
            candidateHarnessIds: [],
            errors: [{ code: "no-fallback-harness", message: "none" }],
          }),
          // An Agent with no harness issue gets no hint.
          plannedAgent({ key: "e", fileHarness: { id: "ok-1", kind: "claude-code", label: "OK" } }),
        ],
        blocking: [mismatch, mismatch, unsupported, { code: "no-fallback-harness", message: "none" }],
        canImport: false,
      }),
    ).join("\n");
    const hints = text.split("\n").filter((l) => l.includes("hint:"));
    expect(hints).toEqual([
      "  hint: map secondary-claude-code to a local harness with --harness-map secondary-claude-code=<localHarnessId> — it can use: claude-code (claude-code)",
      "  hint: map future-1 to a local harness with --harness-map future-1=<localHarnessId> — it can use: claude-code (claude-code), codex (codex)",
      "  hint: no harness on this machine can run codex-2 (codex) — add one in Settings → Harnesses, or remove the Agent from the file",
    ]);
    expect(text).not.toContain("kimi (kimi)");
    expect(text).not.toContain("ok-1=");
  });

  test("importPlanLines: a disabled harness that will be enabled is listed", () => {
    const text = importPlanLines(
      plan({ harnesses: [{ id: "codex", kind: "codex", label: "Codex", enabled: false, canEnable: true, willEnable: true, enableRequested: true, warnings: [] }] }),
    ).join("\n");
    expect(text).toContain("~ harness Codex (codex) will be enabled");
  });

  test("importResultLines: counts, created items, enabled harnesses, warnings", () => {
    const result: BundleImportResponse = {
      agents: [makeAgentProfile({ id: "a1", name: "Worker" })],
      pipelines: [makePipelineFixture({ id: "p1", name: "Flow" })],
      enabledHarnesses: ["codex"],
      warnings: [{ code: "harness-fallback", message: "falls back" }],
      plan: plan({ agents: [plannedAgent()] }),
    };
    expect(importResultLines(result)).toEqual([
      "✓ imported 1 Agent, 1 Pipeline",
      "  + Agent Worker → Claude Code (claude-code) (a1)",
      "  + Pipeline Flow (p1)",
      "  ✓ enabled harness codex",
      "  ! falls back",
    ]);
  });

  // The parser refuses C1 controls and bidi overrides, but a plan's issue
  // messages and local harness labels don't come from it, and a terminal
  // would act on them: every printed string is escaped, as defense in depth.
  test("printers escape C1 controls and bidi overrides from the file", () => {
    const csi = "\u009b31m";
    const rlo = "\u202e";
    const text = importPlanLines(
      plan({
        agents: [
          plannedAgent({
            name: `Evil${csi}`,
            sourceName: `Src${rlo}`,
            renamed: true,
            fileHarness: { id: "secondary-claude-code", kind: "claude-code", label: `Label${rlo}` },
          }),
        ],
        pipelines: [
          { index: 0, sourceName: `P${csi}`, name: `P${rlo}`, renamed: true, description: "", maxSteps: 25, steps: [], graph: { steps: [], edges: [], startStepId: null }, warnings: [], errors: [] },
        ],
        warnings: [{ code: "unknown-model", message: `model ${csi} unknown` }],
        blocking: [{ code: "name-in-use", message: `name ${rlo} taken` }],
        canImport: false,
      }),
    ).join("\n");
    expect(text).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
    expect(text).toContain("Evil\\u009b31m");
    expect(text).toContain('(was "Src\\u202e")');
    expect(text).toContain("fallback for Label\\u202e (secondary-claude-code)");
    expect(text).toContain("+ P\\u202e (was \"P\\u009b31m\")");
    expect(text).toContain("! model \\u009b31m unknown");
    expect(text).toContain("✗ name \\u202e taken");

    const result: BundleImportResponse = {
      agents: [makeAgentProfile({ id: "a1", name: `W${csi}` })],
      pipelines: [makePipelineFixture({ id: "p1", name: `F${rlo}` })],
      enabledHarnesses: [],
      warnings: [{ code: "harness-fallback", message: `w${rlo}` }],
      plan: plan({ agents: [plannedAgent({ name: `W${csi}`, harnessLabel: `H${rlo}` })] }),
    };
    const printed = importResultLines(result).join("\n");
    expect(printed).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
    expect(printed).toContain("+ Agent W\\u009b31m → H\\u202e (claude-code) (a1)");
    expect(printed).toContain("+ Pipeline F\\u202e (p1)");
    expect(printed).toContain("! w\\u202e");
  });
});

describe("prompt and input helpers", () => {
  test("expandTabs pads to the next 4-column stop; textBlockLines never prints \\u0009", () => {
    expect(expandTabs("a\tb")).toBe("a   b");
    expect(expandTabs("\tx\tyy\t")).toBe("    x   yy  ");
    expect(expandTabs("plain")).toBe("plain");
    const lines = textBlockLines("instructions", "step:\n\tdo it");
    expect(lines.join("\n")).not.toContain("\\u0009");
    expect(lines[2]).toContain("    do it");
  });

  test("textBlockLines keeps the joiners multi-line text allows and escapes the rest", () => {
    // ZWNJ between Persian letters is allowed in instructions, so it prints
    // as text; a bidi override and an ESC never do.
    const persian = "می\u200cخواهم";
    const text = textBlockLines("instructions", `${persian}\nx\u202ey\n\u001b[31mred`).join("\n");
    expect(text).toContain(persian);
    expect(text).not.toContain("\\u200c");
    expect(text).toContain("x\\u202ey");
    expect(text).toContain("\\u001b[31mred");
    expect(text).not.toContain("\u001b[31m");
  });

  test("readCappedText reads a stream up to 2 MB and refuses past it", async () => {
    const stream = (chunks: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const ch of chunks) controller.enqueue(new TextEncoder().encode(ch));
          controller.close();
        },
      });
    expect(await readCappedText(stream(["{", "}"]), "stdin")).toBe("{}");
    const big = "x".repeat(1024 * 1024);
    await expect(readCappedText(stream([big, big, "x"]), "stdin")).rejects.toThrow("stdin is too large — the limit is 2 MB");
    // A multibyte character split across two chunks decodes whole.
    const bytes = new TextEncoder().encode('{"n":"é✓"}');
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const cut of [[0, 7], [7, 9], [9, bytes.length]]) controller.enqueue(bytes.slice(cut[0], cut[1]));
        controller.close();
      },
    });
    expect(await readCappedText(split, "stdin")).toBe('{"n":"é✓"}');
  });

  test("readStreamText: a failing read is a plain sentence, the cap's refusal passes through", async () => {
    const failing = (error: unknown) => () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      });
    await expect(readStreamText(failing(new Error("internal stream state")), "stdin")).rejects.toThrow(
      /^can't read stdin$/,
    );
    const eio = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    await expect(readStreamText(failing(eio), "stdin")).rejects.toThrow(/^can't read stdin \(EIO\)$/);
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    await expect(readStreamText(failing(eacces), "stdin")).rejects.toThrow("can't read stdin — permission denied");
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    await expect(readStreamText(() => big, "stdin")).rejects.toThrow("stdin is too large — the limit is 2 MB");
  });

  test("interactiveImport asks only for a file, in a terminal on both ends, without --json or --yes", () => {
    const tty = { stdout: true, stdin: true };
    expect(interactiveImport("b.json", { json: false }, { yes: false }, tty)).toBe(true);
    expect(interactiveImport("-", { json: false }, { yes: false }, tty)).toBe(false);
    expect(interactiveImport("b.json", { json: true }, { yes: false }, tty)).toBe(false);
    expect(interactiveImport("b.json", { json: false }, { yes: true }, tty)).toBe(false);
    expect(interactiveImport("b.json", { json: false }, { yes: false }, { stdout: false, stdin: true })).toBe(false);
    expect(interactiveImport("b.json", { json: false }, { yes: false }, { stdout: true, stdin: false })).toBe(false);
  });

  test("askImport: yes imports, No and Esc decline, only Ctrl+C is an interrupt", async () => {
    const { EventEmitter } = await import("node:events");
    const CANCEL = Symbol("cancel");
    const run = async (keys: string, answer: boolean | symbol) => {
      const stdin = new EventEmitter();
      const messages: string[] = [];
      const result = await askImport(plan({ agents: [plannedAgent()] }), {
        confirm: async (opts) => {
          messages.push(opts.message);
          expect(opts.initialValue).toBe(false);
          stdin.emit("data", Buffer.from(keys));
          return answer;
        },
        isCancel: (v): v is symbol => v === CANCEL,
        stdin: stdin as unknown as NodeJS.ReadStream,
      });
      expect(messages).toEqual(["Import 1 Agent?"]);
      expect(stdin.listenerCount("data")).toBe(0);
      return result;
    };
    expect(await run("y", true)).toBe(true);
    expect(await run("n", false)).toBe(false);
    expect(await run("\u001b", CANCEL)).toBe(false);
    expect(await run("\u0003", CANCEL)).toBeNull();
  });
});

describe("cmdExport", () => {
  test("resolves --profile/--pipeline refs to ids client-side and prints the text", async () => {
    const sent: unknown[] = [];
    currentClient = {
      listAgentProfiles: async () => [makeAgentProfile({ id: "a1", name: "Worker" })],
      listPipelines: async () => [makePipelineFixture({ id: "p1", name: "Flow" })],
      exportBundle: async (sel: unknown) => {
        sent.push(sel);
        return exportResponse({ warnings: ["left something out"] });
      },
    } as unknown as AgetorClient;
    await cmdExport(["--profile", "worker", "--pipeline", "p1"], flags);
    expect(sent).toEqual([{ agentIds: ["a1"], pipelineIds: ["p1"] }]);
    expect(outputs).toEqual([TEXT.replace(/\n$/, "")]);
    // Warnings never pollute stdout.
    expect(errors).toEqual(["! left something out"]);
  });

  test("--all sends all:true and never lists anything", async () => {
    const sent: unknown[] = [];
    currentClient = { exportBundle: async (sel: unknown) => (sent.push(sel), exportResponse()) } as unknown as AgetorClient;
    await cmdExport(["--all"], flags);
    expect(sent).toEqual([{ all: true }]);
  });

  test("no selector is a usage error; --all with a selector is an error", async () => {
    await expect(cmdExport([], flags)).rejects.toThrow(/usage: agetor export/);
    await expect(cmdExport(["--all", "--profile", "x"], flags)).rejects.toThrow(/can't be combined/);
  });

  test("an unknown ref fails with the profile vocabulary", async () => {
    currentClient = { listAgentProfiles: async () => [] } as unknown as AgetorClient;
    await expect(cmdExport(["--profile", "ghost"], flags)).rejects.toThrow(/unknown profile "ghost"/);
  });

  test("--out writes the file, refuses an existing one without --force, and --json reports it", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "out.agetor.json");
      currentClient = { exportBundle: async () => exportResponse() } as unknown as AgetorClient;
      await cmdExport(["--all", "--out", file], jsonFlags);
      expect(readFileSync(file, "utf8")).toBe(TEXT);
      expect(jsonOutputs).toEqual([{ written: file, counts: { agents: 1, pipelines: 0 }, warnings: [] }]);
      await expect(cmdExport(["--all", "--out", file], flags)).rejects.toThrow(/refusing to overwrite/);
    });
  });

  test("--json without --out prints the bundle with what was exported; plain stdout is the file", async () => {
    currentClient = { exportBundle: async () => exportResponse({ warnings: ["w"] }) } as unknown as AgetorClient;
    await cmdExport(["--all"], jsonFlags);
    expect(jsonOutputs).toEqual([
      { filename: "x.agetor.json", counts: { agents: 1, pipelines: 0 }, warnings: ["w"], bundle: { format: "agetor-bundle" } },
    ]);
    expect(outputs).toEqual([]);
    // Under --json the warnings ride in the result, not on stderr too.
    expect(errors).toEqual([]);
    await cmdExport(["--all"], flags);
    expect(outputs).toEqual([TEXT.replace(/\n$/, "")]);
    expect(errors).toEqual(["! w"]);
  });

  test("--out naming a folder or a missing folder fails with a plain message, before any fetch", async () => {
    await inTempDir(async (dir) => {
      let fetched = false;
      currentClient = { exportBundle: async () => ((fetched = true), exportResponse()) } as unknown as AgetorClient;
      await expect(cmdExport(["--all", "--out", dir], flags)).rejects.toThrow(/it is a folder — give a file name/);
      await expect(cmdExport(["--all", "--out", dir, "--force"], flags)).rejects.toThrow(/it is a folder/);
      expect(fetched).toBe(false);
      await expect(cmdExport(["--all", "--out", path.join(dir, "nope", "x.json")], flags)).rejects.toThrow(
        /its folder doesn't exist/,
      );
    });
  });

  test("--out under a file or in a read-only folder fails with a plain message, not an errno", async () => {
    await inTempDir(async (dir) => {
      currentClient = { exportBundle: async () => exportResponse() } as unknown as AgetorClient;
      const file = path.join(dir, "plain.txt");
      writeFileSync(file, "x");
      const underFile = path.join(file, "x.json");
      await expect(cmdExport(["--all", "--out", underFile], flags)).rejects.toThrow(
        `can't write to ${underFile}: its parent isn't a folder`,
      );
      // Root writes anywhere; the check only means something otherwise.
      if (process.getuid?.() !== 0) {
        const locked = path.join(dir, "locked");
        mkdirSync(locked, { mode: 0o500 });
        try {
          const target = path.join(locked, "x.json");
          await expect(cmdExport(["--all", "--out", target], flags)).rejects.toThrow(
            `can't write to ${target} — permission denied`,
          );
        } finally {
          chmodSync(locked, 0o700);
        }
      }
    });
  });

  test("--out never overwrites a file that appears while the export is fetched; --force does", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "late.agetor.json");
      currentClient = {
        exportBundle: async () => {
          writeFileSync(file, "someone else's file");
          return exportResponse();
        },
      } as unknown as AgetorClient;
      await expect(cmdExport(["--all", "--out", file], flags)).rejects.toThrow(/refusing to overwrite .*--force/);
      expect(readFileSync(file, "utf8")).toBe("someone else's file");

      await cmdExport(["--all", "--out", file, "--force"], flags);
      expect(readFileSync(file, "utf8")).toBe(TEXT);
    });
  });

  test("profile export <ref> is the same bundle selected by one Agent", async () => {
    const sent: unknown[] = [];
    const client = {
      listAgentProfiles: async () => [makeAgentProfile({ id: "a1", name: "Worker" })],
      exportBundle: async (sel: unknown) => (sent.push(sel), exportResponse()),
    } as unknown as AgetorClient;
    await cmdExportOne("profile", ["Worker"], flags, client);
    expect(sent).toEqual([{ agentIds: ["a1"], pipelineIds: [] }]);
    // The ref may follow the flags.
    await cmdExportOne("profile", ["--out", "-", "Worker"], flags, client);
    expect(sent).toEqual([
      { agentIds: ["a1"], pipelineIds: [] },
      { agentIds: ["a1"], pipelineIds: [] },
    ]);
    await expect(cmdExportOne("profile", ["--out", "-"], flags, client)).rejects.toThrow(/usage: agetor profile export/);
    await expect(cmdExportOne("profile", [], flags, client)).rejects.toThrow(/usage: agetor profile export/);
    await expect(cmdExportOne("profile", ["Worker", "--pipeline", "p"], flags, client)).rejects.toThrow(
      /usage: agetor profile export/,
    );
  });
});

describe("cmdImport", () => {
  test("sends --harness-map, --name and --enable-harnesses as import options", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const sent: unknown[] = [];
      currentClient = {
        importBundle: async (text: string, options: unknown) => {
          sent.push({ text, options });
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImport([file, "--harness-map", "secondary-claude-code=claude-2", "--name", "Solo", "--enable-harnesses"], flags);
      expect(sent).toEqual([
        {
          text: VALID_BUNDLE,
          options: { harnessMap: { "secondary-claude-code": "claude-2" }, singleName: "Solo", enableHarnesses: "all" },
        },
      ]);
    });
  });

  test("refuses a --harness-map key no Agent in the file uses, before any request", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      let called = false;
      currentClient = {
        importBundle: async () => {
          called = true;
          throw new Error("must not be called");
        },
        previewBundleImport: async () => {
          called = true;
          throw new Error("must not be called");
        },
      } as unknown as AgetorClient;
      await expect(cmdImport([file, "--harness-map", "secondary-claud-code=claude-2"], flags)).rejects.toThrow(
        '--harness-map names a harness this file doesn\'t use: "secondary-claud-code" — its Agents use: "secondary-claude-code"',
      );
      // `--harness-map --name=x` reads as a map whose key is "--name".
      await expect(cmdImport([file, "--dry-run", "--harness-map", "--name=Solo"], flags)).rejects.toThrow(
        '--harness-map names a harness this file doesn\'t use: "--name"',
      );
      expect(called).toBe(false);
    });
  });

  test("asks before importing, and commits with the previewed plan's fingerprint", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const committed: unknown[] = [];
      const previewed = plan({ agents: [plannedAgent({ instructions: "Do the thing." })], fingerprint: "fp-preview" });
      const client = {
        previewBundleImport: async () => previewed,
        importBundle: async (_text: string, _options: unknown, fingerprint?: string) => {
          committed.push(fingerprint);
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: previewed } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;

      const asked: BundleImportPlan[] = [];
      await cmdImport([file], flags, client, {
        confirm: async (p) => {
          asked.push(p);
          return false;
        },
      });
      expect(asked).toEqual([previewed]);
      expect(committed).toEqual([]);
      const declined = outputs.join("\n");
      expect(declined).toContain(THIRD_PARTY_NOTE);
      expect(declined).toContain("│ Do the thing.");
      expect(declined).toContain("nothing was imported");

      outputs.length = 0;
      await cmdImport([file], flags, client, { confirm: async () => true });
      expect(committed).toEqual(["fp-preview"]);
      expect(outputs.join("\n")).toContain("imported nothing");

      // A blocked preview never asks.
      const blocked = plan({ blocking: [{ code: "unknown-kind", message: "x" }], canImport: false });
      const ask = { previewBundleImport: async () => blocked } as unknown as AgetorClient;
      let prompted = false;
      await expect(
        cmdImport([file], flags, ask, {
          confirm: async () => {
            prompted = true;
            return true;
          },
        }),
      ).rejects.toThrow(/nothing was imported — 1 blocking issue/);
      expect(prompted).toBe(false);
    });
  });

  test("Ctrl+C at the prompt imports nothing and exits 130; No exits 0", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      let committed = false;
      const client = {
        previewBundleImport: async () => plan(),
        importBundle: async () => {
          committed = true;
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      const before = process.exitCode;
      try {
        await cmdImport([file], flags, client, { confirm: async () => false });
        expect(process.exitCode ?? 0).toBe(before ?? 0);
        await cmdImport([file], flags, client, { confirm: async () => null });
        expect(process.exitCode).toBe(130);
        expect(committed).toBe(false);
      } finally {
        // Bun keeps a non-zero code when it is set back to undefined.
        process.exitCode = before ?? 0;
      }
    });
  });

  test("pipeline import and profile import ask the same way, and --yes skips the question", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const calls: string[] = [];
      const client = {
        previewBundleImport: async () => (calls.push("preview"), plan({ fingerprint: "fp" })),
        importBundle: async (_t: string, _o: unknown, fingerprint?: string) => {
          calls.push(`import:${fingerprint ?? "none"}`);
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      for (const kind of ["pipeline", "profile"] as const) {
        calls.length = 0;
        let asked = 0;
        await cmdImportAs(kind, [file], flags, client, { confirm: async () => (asked++, true) });
        expect(asked).toBe(1);
        expect(calls).toEqual(["preview", "import:fp"]);
        calls.length = 0;
        // --yes outside the seam: no preview, no question.
        await cmdImportAs(kind, [file, "--yes"], flags, client);
        expect(calls).toEqual(["import:none"]);
      }
    });
  });

  test("outside a terminal it imports without asking or previewing", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const calls: string[] = [];
      currentClient = {
        previewBundleImport: async () => {
          calls.push("preview");
          return plan();
        },
        importBundle: async (_t: string, _o: unknown, fingerprint?: string) => {
          calls.push(`import:${fingerprint ?? "none"}`);
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImport([file, "--yes"], flags);
      expect(calls).toEqual(["import:none"]);
    });
  });

  test("profile export|import handle the file before connecting to the core", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "out.json");
      writeFileSync(file, "{}");
      // No client: reaching getClient would fail with "no fake client".
      await expect(cmdAgentProfile(["export", "Worker", "--out", file], flags)).rejects.toThrow(/refusing to overwrite/);
      await expect(cmdAgentProfile(["import", path.join(dir, "missing.json")], flags)).rejects.toThrow(/no such file/);
      writeFileSync(file, "not json");
      await expect(cmdAgentProfile(["import", file], flags)).rejects.toThrow(/can't import/);
    });
  });

  test("flags may come before the file", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const committed: unknown[] = [];
      currentClient = {
        previewBundleImport: async () => plan(),
        importBundle: async (_text: string, options: unknown) => {
          committed.push(options);
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImport(["--dry-run", file], jsonFlags);
      expect(jsonOutputs).toEqual([plan()]);
      expect(committed).toEqual([]);
      await cmdImport(["--yes", "--name", "Solo", file], flags);
      expect(committed).toEqual([{ singleName: "Solo" }]);
      await expect(cmdImport(["--yes", file, "other.json"], flags)).rejects.toThrow(/usage: agetor import/);
      await expect(cmdImport(["--yes"], flags)).rejects.toThrow(/usage: agetor import/);
    });
  });

  test("--dry-run --json prints the plan; a blocked dry run fails", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      currentClient = { previewBundleImport: async () => plan() } as unknown as AgetorClient;
      await cmdImport([file, "--dry-run"], jsonFlags);
      expect(jsonOutputs).toEqual([plan()]);

      const blocked = plan({ blocking: [{ code: "unknown-kind", message: "x" }], canImport: false });
      currentClient = { previewBundleImport: async () => blocked } as unknown as AgetorClient;
      await expect(cmdImport([file, "--dry-run"], flags)).rejects.toThrow(/would be blocked by 1 issue/);
    });
  });

  test("a blocked import under --json prints the core's error body", async () => {
    const { ApiError } = await import("../api-client.ts");
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const body = { error: "blocked", plan: plan({ blocking: [{ code: "unknown-kind", message: "x" }], canImport: false }) };
      currentClient = {
        importBundle: async () => {
          throw new ApiError(409, body, "blocked");
        },
      } as unknown as AgetorClient;
      await expect(cmdImport([file], jsonFlags)).rejects.toThrow(/nothing was imported/);
      expect(jsonOutputs).toEqual([body]);
    });
  });

  test("a 409 whose plan lists no blocking issue (a name race) reports the core's message", async () => {
    const { ApiError } = await import("../api-client.ts");
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const message = 'an agent named "Worker" already exists — preview the import again';
      currentClient = {
        importBundle: async () => {
          throw new ApiError(409, { error: message, plan: plan() }, message);
        },
      } as unknown as AgetorClient;
      const err = await cmdImport([file], flags).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBe(`nothing was imported — ${message}`);
      expect(err?.message).not.toContain("0 blocking");
    });
  });

  test("a 400 from the core propagates; a 404 explains an older core", async () => {
    const { ApiError } = await import("../api-client.ts");
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      currentClient = {
        importBundle: async () => {
          throw new ApiError(404, null, "not found");
        },
      } as unknown as AgetorClient;
      await expect(cmdImport([file], flags)).rejects.toThrow(/older than this CLI/);
    });
  });

  test("missing or oversized files fail before any network call", async () => {
    await inTempDir(async (dir) => {
      await expect(cmdImport([], flags)).rejects.toThrow(/usage: agetor import/);
      await expect(cmdImport([path.join(dir, "nope.json")], flags)).rejects.toThrow(/no such file/);
      const big = path.join(dir, "big.json");
      writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 1));
      await expect(cmdImport([big], flags)).rejects.toThrow(/too large/);
    });
  });

  test("a folder, an unreadable file and an oversized FIFO fail with plain messages", async () => {
    await inTempDir(async (dir) => {
      await expect(cmdImport([dir], flags)).rejects.toThrow(`${dir} is a folder — pass a bundle file`);
      const locked = path.join(dir, "locked.json");
      writeFileSync(locked, "{}");
      chmodSync(locked, 0o000);
      try {
        // Root reads anything; the check only means something otherwise.
        if (process.getuid?.() !== 0) {
          await expect(cmdImport([locked], flags)).rejects.toThrow(`can't read ${locked} — permission denied`);
        }
      } finally {
        chmodSync(locked, 0o644);
      }
      // A FIFO reports size 0, so the 2 MB cap must apply while reading it.
      const fifo = path.join(dir, "pipe.json");
      Bun.spawnSync(["mkfifo", fifo]);
      const writer = Bun.spawn(["sh", "-c", `head -c ${2 * 1024 * 1024 + 10} /dev/zero > "${fifo}"`], {
        stderr: "ignore",
      });
      try {
        await expect(cmdImport([fifo], flags)).rejects.toThrow(`${fifo} is too large — the limit is 2 MB`);
      } finally {
        writer.kill();
        await writer.exited;
      }
    });
  });

  test("a FIFO delivering a valid bundle under the cap imports its text unchanged", async () => {
    await inTempDir(async (dir) => {
      const text = VALID_BUNDLE.replace('"Worker"', '"Wörker ✓"');
      const source = path.join(dir, "src.json");
      writeFileSync(source, text);
      const fifo = path.join(dir, "pipe.json");
      Bun.spawnSync(["mkfifo", fifo]);
      const writer = Bun.spawn(["sh", "-c", `cat "${source}" > "${fifo}"`], { stderr: "ignore" });
      const sent: string[] = [];
      currentClient = {
        importBundle: async (t: string) => {
          sent.push(t);
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      try {
        await cmdImport([fifo, "--yes"], flags);
      } finally {
        writer.kill();
        await writer.exited;
      }
      expect(sent).toEqual([text]);
    });
  });

  test("a file whose text would be quoted in the error can't send terminal escapes", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "evil.json");
      writeFileSync(file, JSON.stringify({ format: "\u001b]0;pwned\u0007\u001b[2J", version: 1 }));
      currentClient = {} as AgetorClient;
      const err = await cmdImport([file], flags).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toContain("not an agetor bundle");
      expect(err?.message).toContain("\\u001b]0;pwned");
      expect(err?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });
  });

  test("profile import / pipeline import run the same import", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      let calls = 0;
      const client = {
        importBundle: async () => {
          calls++;
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImportAs("profile", [file], flags, client);
      await cmdImportAs("pipeline", [file], flags, client);
      expect(calls).toBe(2);
      await expect(cmdImportAs("profile", [file, "--bad"], flags, client)).rejects.toThrow(/usage: agetor profile import/);
    });
  });
});

describe("printableLines", () => {
  test("splits on CRLF, LF and a bare CR, expands tabs and escapes by the multi-line rule", async () => {
    const { printableLines } = await import("./bundle.ts");
    expect(printableLines("run evil\rbenign\r\nnext\nlast\t!")).toEqual(["run evil", "benign", "next", "last    !"]);
    expect(printableLines("a\u001b[2Jb")).toEqual(["a\\u001b[2Jb"]);
    // A Persian half-space is allowed in multi-line text and prints as text.
    expect(printableLines("می\u200cخ")).toEqual(["می\u200cخ"]);
  });
});
