import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness } from "../shared/types.ts";
import { cliVersionSatisfies, parseCliVersion } from "../shared/cli-version.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// agent-status.ts imports db.ts, which opens (and migrates) its sqlite file at
// module load, so the data dir must be set before a *dynamic* import.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-copilot-status-db-"));
process.env.AGETOR_DATA_DIR = dataDir;
const { checkHarness, upgradeHintFor, INSTALL_HINTS, __testing: statusTesting } = await import("./agent-status.ts");
const { __testing: discoveryTesting, getDiscoveredModels, refreshKindModels } = await import("./agent-discovery.ts");

afterAll(() => {
  rmTestDataDir(dataDir);
});

function builtin(kind: AgentKind): Harness {
  return { id: kind, kind, label: kind, isBuiltin: true, home: null, bin: null, env: {}, enabled: true };
}

/** `copilot help config`, shaped like 1.0.104's output: several config keys,
 * each with its own `- "value"` list, the `model` block in the middle. */
const HELP_CONFIG = [
  "Configuration Settings:",
  "",
  "  `effortLevel`: Reasoning effort level.",
  '    - "low"',
  '    - "medium"',
  '    - "high"',
  "",
  "  `model`: AI model to use for Copilot CLI; can be changed with /model",
  "    command or --model flag option.",
  '    - "claude-sonnet-5.5"',
  '    - "gpt-6.1-sol"',
  '    - "claude-sonnet-5.5"',
  '    - "gemini-4-argon"',
  "",
  "  `theme`: UI theme.",
  '    - "auto"',
  '    - "dark"',
  "",
].join("\n");

let sandbox: string;
const ORIGINAL_PATH = process.env.PATH;

function stub(name: string, body: string): string {
  const file = path.join(sandbox, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const GITHUB_BODY = [
  'if [ "$1" = "--version" ]; then echo "GitHub Copilot CLI 1.0.104."; echo "Run copilot update to check for updates."; exit 0; fi',
  'if [ "$1" = "help" ] && [ "$2" = "config" ]; then',
  '  [ "$COPILOT_OFFLINE" = "true" ] || { echo "offline flag missing" >&2; exit 3; }',
  `  cat <<'EOT'\n${HELP_CONFIG}\nEOT`,
  "  exit 0",
  "fi",
  "exit 1",
].join("\n");

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "agetor-copilot-stub-"));
  delete process.env.AGETOR_COPILOT_BIN;
  statusTesting.clearStatusCache();
  discoveryTesting.resetForTests();
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.AGETOR_COPILOT_BIN;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("checkHarness (copilot identity gate)", () => {
  test("GitHub Copilot CLI: available, version parsed, loggedIn null", async () => {
    process.env.AGETOR_COPILOT_BIN = stub("copilot", GITHUB_BODY);
    const status = await checkHarness(builtin("copilot"));
    expect(status.available).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.installHint).toBeNull();
    expect(status.loggedIn).toBeNull();
    expect(status.authHelp).toBeNull();
    expect(status.version).toBe("GitHub Copilot CLI 1.0.104.");
    expect(parseCliVersion(status.version)).toEqual({ major: 1, minor: 0, patch: 104 });
    expect(cliVersionSatisfies(status.version, "1.0.104")).toBe(true);
    expect(cliVersionSatisfies(status.version, "1.0.105")).toBe(false);
  });

  test("AWS Copilot (same binary name): unavailable with the reason and the cask install hint", async () => {
    process.env.AGETOR_COPILOT_BIN = stub("copilot", 'echo "copilot version: v1.34.0"');
    const status = await checkHarness(builtin("copilot"));
    expect(status.available).toBe(false);
    expect(status.reason).toBe(
      "`copilot` isn't GitHub Copilot CLI (AWS Copilot ships a binary of the same name)",
    );
    expect(status.installHint).toBe("brew install --cask copilot-cli");
    expect(status.loggedIn).toBeNull();
    expect(status.path).toBe(process.env.AGETOR_COPILOT_BIN!);
  });

  test("a missing binary reports the cask install hint", async () => {
    process.env.AGETOR_COPILOT_BIN = path.join(sandbox, "nope");
    const status = await checkHarness(builtin("copilot"));
    expect(status.available).toBe(false);
    expect(status.installHint).toBe(INSTALL_HINTS.copilot);
    expect(INSTALL_HINTS.copilot).toBe("brew install --cask copilot-cli");
  });
});

describe("upgradeHintFor (copilot)", () => {
  test("Homebrew cask install -> brew upgrade --cask", () => {
    expect(upgradeHintFor("copilot", "/opt/homebrew/bin/copilot")).toBe("brew upgrade --cask copilot-cli");
    expect(upgradeHintFor("copilot", "/opt/homebrew/Caskroom/copilot-cli/1.0.104/copilot")).toBe(
      "brew upgrade --cask copilot-cli",
    );
  });

  test("non-Homebrew, npm-under-Homebrew and unknown path -> copilot update", () => {
    expect(upgradeHintFor("copilot", "/Users/me/.local/bin/copilot")).toBe("copilot update");
    expect(upgradeHintFor("copilot", null)).toBe("copilot update");
    const npmRoot = mkdtempSync(path.join(tmpdir(), "agetor-copilot-npm-"));
    try {
      // Not under a Homebrew prefix, so this is the plain non-brew path too.
      expect(upgradeHintFor("copilot", path.join(npmRoot, "node_modules", ".bin", "copilot"))).toBe("copilot update");
    } finally {
      rmSync(npmRoot, { recursive: true, force: true });
    }
  });
});

describe("parseCopilotModels", () => {
  test("reads only the model block, dedupes, stops at the next key", () => {
    expect(discoveryTesting.parseCopilotModels(HELP_CONFIG)).toEqual([
      { id: "claude-sonnet-5.5" },
      { id: "gpt-6.1-sol" },
      { id: "gemini-4-argon" },
    ]);
  });

  test("ignores other blocks' value lists and tolerates a model block at end of input", () => {
    const text = ['  `theme`: x', '    - "dark"', '  `model`: y', '    - "kimi-k3"'].join("\n");
    expect(discoveryTesting.parseCopilotModels(text)).toEqual([{ id: "kimi-k3" }]);
  });

  test("strips ANSI and CRLF, drops non-id items, returns [] with no model block", () => {
    const text = '\x1b[1m  `model`:\x1b[0m desc\r\n    - "gpt-5.5"\r\n    - "not an id"\r\n';
    expect(discoveryTesting.parseCopilotModels(text)).toEqual([{ id: "gpt-5.5" }]);
    expect(discoveryTesting.parseCopilotModels('  `theme`: x\n    - "dark"\n')).toEqual([]);
    expect(discoveryTesting.parseCopilotModels("")).toEqual([]);
  });
});

describe("discoverCopilot / runRefreshKind", () => {
  test("discoverCopilot runs `help config` offline via the stub", async () => {
    const bin = stub("copilot", GITHUB_BODY);
    const models = await discoveryTesting.discoverCopilot({}, bin);
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5.5", "gpt-6.1-sol", "gemini-4-argon"]);
  });

  test("a failing or missing binary degrades to []", async () => {
    expect(await discoveryTesting.discoverCopilot({}, stub("bad", "exit 2"))).toEqual([]);
    expect(await discoveryTesting.discoverCopilot({}, path.join(sandbox, "missing"))).toEqual([]);
  });

  test("refreshKindModels('copilot') fills the kind-level cache from AGETOR_COPILOT_BIN", async () => {
    process.env.AGETOR_COPILOT_BIN = stub("copilot", GITHUB_BODY);
    await refreshKindModels("copilot");
    expect(getDiscoveredModels("copilot").map((m) => m.id)).toEqual([
      "claude-sonnet-5.5",
      "gpt-6.1-sol",
      "gemini-4-argon",
    ]);
  });
});
