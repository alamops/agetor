import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import type { Harness } from "../../shared/types.ts";
import { withDisclaimOn } from "../test-disclaim-on.ts";
import {
  claudeCredentialsPath,
  claudeDotJsonPath,
  readClaudeToken,
} from "./creds.ts";

const mkHarness = (home: string | null): Harness => ({
  id: home ? "claude-alias" : "claude-code",
  kind: "claude-code",
  label: "test",
  isBuiltin: home === null,
  home,
  bin: null,
  env: {},
  enabled: true,
});

describe("claudeDotJsonPath", () => {
  test("main account (home=null) resolves to ~/.claude.json", () => {
    expect(claudeDotJsonPath(mkHarness(null))).toBe(
      path.join(homedir(), ".claude.json"),
    );
  });

  test("alias resolves to <home>/.claude.json", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
    expect(claudeDotJsonPath(mkHarness(home))).toBe(
      path.join(home, ".claude.json"),
    );
  });
});

describe("claudeCredentialsPath", () => {
  test("main account (home=null) returns null (keychain signal)", () => {
    expect(claudeCredentialsPath(mkHarness(null))).toBeNull();
  });

  test("alias prefers <home>/.credentials.json, falls back to legacy <home>/.claude/.credentials.json", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
    // Neither exists: defaults to the fresh path.
    expect(claudeCredentialsPath(mkHarness(home))).toBe(
      path.join(home, ".credentials.json"),
    );
    // Legacy exists, fresh doesn't: picks legacy.
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
    expect(claudeCredentialsPath(mkHarness(home))).toBe(
      path.join(home, ".claude", ".credentials.json"),
    );
    // Fresh exists: wins over legacy.
    writeFileSync(path.join(home, ".credentials.json"), "{}");
    expect(claudeCredentialsPath(mkHarness(home))).toBe(
      path.join(home, ".credentials.json"),
    );
  });
});

describe("readClaudeToken — alias/keychain isolation", () => {
  test("alias with an on-disk creds file returns that file's token + scopes", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
    writeFileSync(
      path.join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat-test-alias-token",
          scopes: ["user:profile", "user:inference"],
        },
      }),
    );
    const { token, scopes } = await readClaudeToken(mkHarness(home));
    expect(token).toBe("sk-ant-oat-test-alias-token");
    expect(scopes).toContain("user:profile");
  });

  test("REGRESSION (cross-account leak): alias with NO creds file must NOT fall back to the keychain", async () => {
    // The macOS Keychain item holds the MAIN account's token. If an alias
    // ever falls back to it, its meters silently show a different account's
    // usage — observed live before the fix (three accounts, identical
    // numbers). On a machine with a real keychain token this test fails if
    // the early-return regresses; elsewhere it passes trivially, which is
    // still the correct contract.
    const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
    const { token, scopes } = await readClaudeToken(mkHarness(home));
    expect(token).toBeNull();
    expect(scopes).toEqual([]);
  });
});

describe("readClaudeToken — agent-writable creds file", () => {
  const writeCreds = (file: string) =>
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test-linked", scopes: ["user:profile"] } }));

  test.skipIf(process.platform !== "darwin")(
    "a .credentials.json swapped for a symlink is not read while disclaiming (but is with the switch off)",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
      const elsewhere = mkdtempSync(path.join(tmpdir(), "agetor-creds-target-"));
      writeCreds(path.join(elsewhere, "creds.json"));
      symlinkSync(path.join(elsewhere, "creds.json"), path.join(home, ".credentials.json"));

      expect((await readClaudeToken(mkHarness(home))).token).toBe("sk-ant-oat-test-linked");
      const disclaimed = await withDisclaimOn(() => readClaudeToken(mkHarness(home)));
      expect(disclaimed).toEqual({ token: null, scopes: [] });
    },
  );

  test("a .credentials.json that is a named pipe resolves at once to no token", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
    expect(spawnSync("/usr/bin/mkfifo", [path.join(home, ".credentials.json")]).status).toBe(0);
    const started = Date.now();
    expect(await readClaudeToken(mkHarness(home))).toEqual({ token: null, scopes: [] });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
