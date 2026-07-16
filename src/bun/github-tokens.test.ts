import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listGitHubTokens,
  setGitHubToken,
  deleteGitHubToken,
  tokenForHost,
  githubTokensPath,
} from "./github-tokens.ts";

// github-tokens.ts resolves AGETOR_DATA_DIR lazily at call time (not at module
// load), so — unlike db.ts/orchestrator.ts tests — it's safe to swap the env
// var per-test rather than once in beforeAll. Each test gets its own mkdtemp
// dir so parallel-file test isolation holds and nothing leaks into a real
// ~/.agetor or ~/.agetor-dev store.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-gh-tokens-"));
  process.env.AGETOR_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
});

test("setGitHubToken then listGitHubTokens round-trips, host lowercased/trimmed", () => {
  setGitHubToken("  GitHub-Work.COM  ", "tok_1", "work");
  expect(listGitHubTokens()).toEqual([
    { host: "github-work.com", token: "tok_1", label: "work" },
  ]);
});

test("setGitHubToken upserts by host — same host twice yields one entry, latest wins", () => {
  setGitHubToken("github-work.com", "tok_1", "first label");
  setGitHubToken("GitHub-Work.com", "tok_2", "second label");
  const tokens = listGitHubTokens();
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toEqual({ host: "github-work.com", token: "tok_2", label: "second label" });
});

test("deleteGitHubToken returns true when an entry was removed, false otherwise", () => {
  setGitHubToken("github.com", "tok_1");
  expect(deleteGitHubToken("github.com")).toBe(true);
  expect(listGitHubTokens()).toEqual([]);
  expect(deleteGitHubToken("github.com")).toBe(false);
  expect(deleteGitHubToken("never-stored.example.com")).toBe(false);
});

test("malformed file content degrades to an empty list", () => {
  writeFileSync(githubTokensPath(), "{ not valid json ][");
  expect(listGitHubTokens()).toEqual([]);
});

test("missing file degrades to an empty list", () => {
  expect(existsSync(githubTokensPath())).toBe(false);
  expect(listGitHubTokens()).toEqual([]);
});

test("entries with non-string/empty host or token are dropped on read", () => {
  writeFileSync(
    githubTokensPath(),
    JSON.stringify({
      tokens: [
        { host: "github.com", token: "good" },
        { host: "", token: "bad-empty-host" },
        { host: 42, token: "bad-nonstring-host" },
        { host: "github-work.com", token: "" },
        { host: "github-other.com", token: 42 },
        { host: "github-null-label.com", token: "ok", label: null },
        "not-an-object",
        null,
      ],
    }),
  );
  expect(listGitHubTokens()).toEqual([
    { host: "github.com", token: "good", label: null },
    { host: "github-null-label.com", token: "ok", label: null },
  ]);
});

test("tokenForHost: exact alias match beats the github.com fallback entry", () => {
  setGitHubToken("github.com", "default-tok");
  setGitHubToken("github-work.com", "alias-tok");
  expect(tokenForHost("github-work.com")).toBe("alias-tok");
  expect(tokenForHost("GitHub-Work.com")).toBe("alias-tok");
});

test("tokenForHost: falls back to the github.com entry for an unknown host", () => {
  setGitHubToken("github.com", "default-tok");
  expect(tokenForHost("gitlab-work.io")).toBe("default-tok");
});

test("tokenForHost: null when nothing is stored", () => {
  expect(tokenForHost("github.com")).toBeNull();
  expect(tokenForHost(null)).toBeNull();
});

test("tokenForHost: null host still resolves to the github.com entry", () => {
  setGitHubToken("github.com", "default-tok");
  expect(tokenForHost(null)).toBe("default-tok");
});

test("setGitHubToken throws on empty host or empty token", () => {
  expect(() => setGitHubToken("", "tok")).toThrow();
  expect(() => setGitHubToken("   ", "tok")).toThrow();
  expect(() => setGitHubToken("github.com", "")).toThrow();
});

test("token file is written with mode 0600", () => {
  setGitHubToken("github.com", "tok_1");
  const mode = statSync(githubTokensPath()).mode & 0o777;
  expect(mode).toBe(0o600);
});
