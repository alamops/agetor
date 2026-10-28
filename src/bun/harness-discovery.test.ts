import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR BEFORE importing anything that transitively reaches
// db.ts (harness-discovery → commands → worktree).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-disc-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let mod: typeof import("./harness-discovery.ts");
beforeAll(async () => {
  mod = await import("./harness-discovery.ts");
});

/** Build a fake $HOME with the standard two-account layout:
 *  - `.claude/` + sibling `~/.claude.json` (default account)
 *  - `.claude-adevinta/` with an in-dir `.claude.json` (override account)
 *  - `.claude-cache/` — a glob-matching decoy with no account blob
 *  - `.claude-bad/` — malformed JSON blob
 *  - `.claude-loggedout/` — blob present but no oauthAccount
 */
function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-disc-home-"));
  const blob = (email: string) =>
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: "D " + email, billingType: "max", accountUuid: "u-1" }, other: 1 });

  mkdirSync(path.join(home, ".claude"));
  writeFileSync(path.join(home, ".claude.json"), blob("default@example.com"));

  mkdirSync(path.join(home, ".claude-adevinta"));
  writeFileSync(path.join(home, ".claude-adevinta", ".claude.json"), blob("work@adevinta.com"));

  mkdirSync(path.join(home, ".claude-cache"));

  mkdirSync(path.join(home, ".claude-bad"));
  writeFileSync(path.join(home, ".claude-bad", ".claude.json"), "{not json");

  mkdirSync(path.join(home, ".claude-loggedout"));
  writeFileSync(path.join(home, ".claude-loggedout", ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));

  return home;
}

// --- effectiveClaudeConfigDir ------------------------------------------------

test("effectiveClaudeConfigDir: home override wins, then env, then ~/.claude", () => {
  const opts = { homeDir: "/fake/home", env: {} };
  expect(mod.effectiveClaudeConfigDir("/x/.claude-work", opts)).toBe("/x/.claude-work");
  expect(mod.effectiveClaudeConfigDir(null, { homeDir: "/fake/home", env: { CLAUDE_CONFIG_DIR: "/env/dir" } })).toBe("/env/dir");
  expect(mod.effectiveClaudeConfigDir(null, opts)).toBe(path.join("/fake/home", ".claude"));
});

// --- readClaudeAccount --------------------------------------------------------

test("readClaudeAccount reads an override dir's in-dir blob", () => {
  const home = makeHome();
  const acc = mod.readClaudeAccount(path.join(home, ".claude-adevinta"), { homeDir: home, env: {} });
  expect(acc).toEqual({ email: "work@adevinta.com", displayName: "D work@adevinta.com", billingType: "max" });
});

test("readClaudeAccount falls back to the ~/.claude.json sibling for the default dir", () => {
  const home = makeHome();
  const acc = mod.readClaudeAccount(path.join(home, ".claude"), { homeDir: home, env: {} });
  expect(acc?.email).toBe("default@example.com");
});

test("readClaudeAccount returns null for missing, malformed, or logged-out blobs", () => {
  const home = makeHome();
  const opts = { homeDir: home, env: {} };
  expect(mod.readClaudeAccount(path.join(home, ".claude-cache"), opts)).toBeNull();
  expect(mod.readClaudeAccount(path.join(home, ".claude-bad"), opts)).toBeNull();
  expect(mod.readClaudeAccount(path.join(home, ".claude-loggedout"), opts)).toBeNull();
  expect(mod.readClaudeAccount(path.join(home, ".claude-nonexistent"), opts)).toBeNull();
});

// While disclaiming, the blob is an agent-writable account file: never opened
// through a symlink (it could point into a protected folder) and never allowed
// to block on a FIFO. With the switch off a user's own symlinked blob reads.
const savedDisclaimBin = process.env.AGETOR_DISCLAIM_BIN;
let savedDisclaimSwitch: boolean | null = null;
afterEach(async () => {
  if (savedDisclaimSwitch === null) return;
  const { setDisclaimSwitch } = await import("./disclaim.ts");
  setDisclaimSwitch(savedDisclaimSwitch);
  savedDisclaimSwitch = null;
  if (savedDisclaimBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = savedDisclaimBin;
});
async function useDisclaim(on: boolean, home: string): Promise<void> {
  const { getDisclaimSwitch, setDisclaimSwitch } = await import("./disclaim.ts");
  savedDisclaimSwitch ??= getDisclaimSwitch();
  const stub = path.join(home, "disclaim-stub");
  writeFileSync(stub, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  process.env.AGETOR_DISCLAIM_BIN = stub;
  setDisclaimSwitch(on);
}

test.skipIf(process.platform !== "darwin")("readClaudeAccount refuses a symlinked blob only while disclaiming", async () => {
  const home = makeHome();
  const opts = { homeDir: home, env: {} };
  mkdirSync(path.join(home, ".claude-link"));
  symlinkSync(path.join(home, ".claude-adevinta", ".claude.json"), path.join(home, ".claude-link", ".claude.json"));
  await useDisclaim(true, home);
  expect(mod.readClaudeAccount(path.join(home, ".claude-link"), opts)).toBeNull();
  await useDisclaim(false, home);
  expect(mod.readClaudeAccount(path.join(home, ".claude-link"), opts)?.email).toBe("work@adevinta.com");
});

test.skipIf(process.platform === "win32")("readClaudeAccount answers null for a FIFO blob without blocking, switch on or off", async () => {
  const home = makeHome();
  const opts = { homeDir: home, env: {} };
  mkdirSync(path.join(home, ".claude-fifo"));
  expect(Bun.spawnSync(["/usr/bin/mkfifo", path.join(home, ".claude-fifo", ".claude.json")]).exitCode).toBe(0);
  for (const on of [false, true]) {
    await useDisclaim(on, home);
    // A blocking open/read would hang the test (and the core) here.
    expect(mod.readClaudeAccount(path.join(home, ".claude-fifo"), opts)).toBeNull();
  }
});

// --- suggestHarnessId ---------------------------------------------------------

test("suggestHarnessId derives a claude-flavored slug from the dir name", () => {
  expect(mod.suggestHarnessId("/home/u/.claude-adevinta")).toBe("claude-adevinta");
  expect(mod.suggestHarnessId("/opt/Work Profile!")).toBe("claude-work-profile");
});

// --- discoverClaudeAccounts ---------------------------------------------------

test("discovery finds the override account, skips decoys, and excludes the built-in default", () => {
  const home = makeHome();
  const accounts = mod.discoverClaudeAccounts([], { homeDir: home, env: {} });
  expect(accounts.map((a) => a.email)).toEqual(["work@adevinta.com"]);
  expect(accounts[0]!.configDir).toBe(path.join(home, ".claude-adevinta"));
  expect(accounts[0]!.suggestedHarnessId).toBe("claude-adevinta");
});

test("discovery output carries identity fields only — no tokens, no accountUuid", () => {
  const home = makeHome();
  const [a] = mod.discoverClaudeAccounts([], { homeDir: home, env: {} });
  expect(Object.keys(a!).sort()).toEqual(
    ["billingType", "configDir", "displayName", "email", "suggestedHarnessId"],
  );
});

test("a dir claimed by a registered harness is excluded", () => {
  const home = makeHome();
  const accounts = mod.discoverClaudeAccounts(
    [path.join(home, ".claude-adevinta"), null],
    { homeDir: home, env: {} },
  );
  expect(accounts).toEqual([]);
});

test("when agetor itself runs under CLAUDE_CONFIG_DIR, that dir is the built-in's and ~/.claude becomes discoverable", () => {
  const home = makeHome();
  const env = { CLAUDE_CONFIG_DIR: path.join(home, ".claude-adevinta") };
  const accounts = mod.discoverClaudeAccounts([], { homeDir: home, env });
  expect(accounts.map((a) => a.email)).toEqual(["default@example.com"]);
  expect(accounts[0]!.configDir).toBe(path.join(home, ".claude"));
});

test("a symlinked duplicate of an account dir is deduped by realpath", () => {
  const home = makeHome();
  symlinkSync(path.join(home, ".claude-adevinta"), path.join(home, ".claude-link"), "dir");
  const accounts = mod.discoverClaudeAccounts([], { homeDir: home, env: {} });
  expect(accounts.filter((a) => a.email === "work@adevinta.com")).toHaveLength(1);
});

test("an unreadable HOME degrades to no discoveries, never throws", () => {
  expect(mod.discoverClaudeAccounts([], { homeDir: "/nonexistent-agetor-home", env: {} })).toEqual([]);
});
