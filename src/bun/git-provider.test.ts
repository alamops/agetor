import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  providerForHost,
  providerRepoForDir,
  remoteHostsForDirs,
  clearRemoteHostsCache,
  gitlabToken,
  bitbucketCreds,
} from "./git-provider.ts";
import { setGitHubToken, tokenForHost } from "./github-tokens.ts";
import { makeAliasGitHubRepo } from "./github-test-util.ts";

// git-provider.ts resolves AGETOR_DATA_DIR lazily at call time (via
// github-tokens.ts's resolveDataDir), so — like github-tokens.test.ts — it's
// safe to swap the env var per-test. Each test gets its own mkdtemp token
// store dir; GITLAB_TOKEN/BITBUCKET_TOKEN/BITBUCKET_EMAIL are saved/cleared
// before every test and restored after so no test can leak env into another,
// and so gitlabToken/bitbucketCreds's env-fallback tier only ever sees what a
// given test explicitly sets.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ENV_KEYS = ["GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_EMAIL"] as const;
let dataDir: string;
let savedEnv: Record<string, string | undefined> = {};
let createdDirs: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-git-provider-tokens-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // remoteHostsForDirs caches by sorted-dirs key; each test below uses its own
  // fresh mkdtemp dirs so cross-test collisions can't happen in practice, but
  // clearing up front keeps every test's cache behavior self-contained and
  // independent of suite run order.
  clearRemoteHostsCache();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs = [];
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
});

// ---------------------------------------------------------------------------
// providerForHost
// ---------------------------------------------------------------------------

test("providerForHost maps canonical provider hosts, null for anything else", () => {
  expect(providerForHost("github.com")).toBe("github");
  expect(providerForHost("gitlab.com")).toBe("gitlab");
  expect(providerForHost("bitbucket.org")).toBe("bitbucket");
  expect(providerForHost("git.internal.corp")).toBeNull();
  expect(providerForHost("")).toBeNull();
});

// ---------------------------------------------------------------------------
// providerRepoForDir
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo with the given named remotes (added in the given
 *  order — `providerRepoForDir` is expected to always try `origin` first
 *  regardless of add/listing order, which some of the tests below rely on). */
async function makeRepoWithRemotes(remotes: { name: string; url: string }[]): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-provider-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  for (const r of remotes) {
    await git(["remote", "add", r.name, r.url], dir);
  }
  return dir;
}

test("providerRepoForDir resolves a GitLab ssh-alias remote, keeping the raw alias as remoteHost", async () => {
  const dir = await makeRepoWithRemotes([{ name: "origin", url: "git@gitlab-work.io:acme/app.git" }]);
  expect(await providerRepoForDir(dir)).toEqual({
    provider: "gitlab",
    host: "gitlab.com",
    remoteHost: "gitlab-work.io",
    owner: "acme",
    name: "app",
  });
});

test("providerRepoForDir resolves a plain Bitbucket https remote", async () => {
  const dir = await makeRepoWithRemotes([{ name: "origin", url: "https://bitbucket.org/acme/app.git" }]);
  expect(await providerRepoForDir(dir)).toEqual({
    provider: "bitbucket",
    host: "bitbucket.org",
    remoteHost: "bitbucket.org",
    owner: "acme",
    name: "app",
  });
});

test("providerRepoForDir resolves a GitHub ssh-alias remote", async () => {
  const dir = await makeAliasGitHubRepo("acme", "widgets", "github-alias.com");
  createdDirs.push(dir);
  expect(await providerRepoForDir(dir)).toEqual({
    provider: "github",
    host: "github.com",
    remoteHost: "github-alias.com",
    owner: "acme",
    name: "widgets",
  });
});

test("providerRepoForDir returns null for an unsupported git host", async () => {
  const dir = await makeRepoWithRemotes([{ name: "origin", url: "git@example.com:x/y.git" }]);
  expect(await providerRepoForDir(dir)).toBeNull();
});

test("providerRepoForDir returns null for a directory that isn't a git repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-provider-nonrepo-"));
  createdDirs.push(dir);
  expect(await providerRepoForDir(dir)).toBeNull();
});

test("providerRepoForDir returns null for a nonexistent directory", async () => {
  expect(await providerRepoForDir(path.join(tmpdir(), "agetor-does-not-exist-xyz"))).toBeNull();
});

test("providerRepoForDir prefers origin over other remotes regardless of add order", async () => {
  // "aaa-upstream" sorts before "origin" alphabetically, so without the
  // explicit origin-first reordering this would resolve to the gitlab
  // upstream remote instead of the github origin.
  const dir = await makeRepoWithRemotes([
    { name: "aaa-upstream", url: "git@gitlab-work.io:acme/other.git" },
    { name: "origin", url: "https://github.com/acme/main.git" },
  ]);
  expect(await providerRepoForDir(dir)).toEqual({
    provider: "github",
    host: "github.com",
    remoteHost: "github.com",
    owner: "acme",
    name: "main",
  });
});

test("providerRepoForDir falls through to another remote when origin is unsupported", async () => {
  const dir = await makeRepoWithRemotes([
    { name: "origin", url: "git@example.com:x/y.git" },
    { name: "upstream", url: "https://gitlab.com/acme/app.git" },
  ]);
  expect(await providerRepoForDir(dir)).toEqual({
    provider: "gitlab",
    host: "gitlab.com",
    remoteHost: "gitlab.com",
    owner: "acme",
    name: "app",
  });
});

// ---------------------------------------------------------------------------
// remoteHostsForDirs (moved from github.ts — reimplemented over
// providerRepoForDir, docs/plans/consolidate-git-host-discovery.md)
// ---------------------------------------------------------------------------

test("remoteHostsForDirs returns the sorted alias hosts of every supported provider (github/gitlab/bitbucket), excluding an unsupported host, and tolerates a dir that isn't a repo", async () => {
  const githubDir = await makeRepoWithRemotes([{ name: "origin", url: "git@github-work.com:a/b.git" }]);
  const bitbucketDir = await makeRepoWithRemotes([{ name: "origin", url: "git@bitbucket-work.com:w/r.git" }]);
  const gitlabDir = await makeRepoWithRemotes([{ name: "origin", url: "git@gitlab-work.io:g/p.git" }]);
  const unsupportedDir = await makeRepoWithRemotes([{ name: "origin", url: "git@example.com:x/y.git" }]);
  // A dir that isn't a git repo at all (but does exist) — must be tolerated
  // silently, same as providerRepoForDir returning null for it.
  const notARepoDir = mkdtempSync(path.join(tmpdir(), "agetor-remote-hosts-plain-"));
  createdDirs.push(notARepoDir);

  const hosts = await remoteHostsForDirs([githubDir, bitbucketDir, gitlabDir, unsupportedDir, notARepoDir]);
  expect(hosts).toEqual(["bitbucket-work.com", "github-work.com", "gitlab-work.io"]);
});

test("remoteHostsForDirs caches within the TTL: a second call for the same dirs reuses the first scan even after the repo's remote changes, and clearRemoteHostsCache() bypasses it", async () => {
  const dir = await makeRepoWithRemotes([{ name: "origin", url: "git@github-host-one.example:a/b.git" }]);

  const first = await remoteHostsForDirs([dir]);
  expect(first).toEqual(["github-host-one.example"]);

  // Mutate the remote after the first scan. Within the TTL, a second call for
  // the exact same dir list must reuse the cached promise/result rather than
  // re-scanning — this is the GET-then-PUT /github/tokens back-to-back-scan
  // case the cache exists for.
  await git(["remote", "set-url", "origin", "git@github-host-two.example:a/b.git"], dir);
  const second = await remoteHostsForDirs([dir]);
  expect(second).toEqual(["github-host-one.example"]);

  // Bypassing the cache observes the mutation immediately.
  clearRemoteHostsCache();
  const third = await remoteHostsForDirs([dir]);
  expect(third).toEqual(["github-host-two.example"]);
});

test("remoteHostsForDirs processes every dir even when the dir count exceeds the concurrency pool size", async () => {
  const hosts = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const dirs = await Promise.all(
    hosts.map((h) => makeRepoWithRemotes([{ name: "origin", url: `git@github-pool-${h}.example:x/y.git` }])),
  );
  const result = await remoteHostsForDirs(dirs);
  expect(result).toEqual(hosts.map((h) => `github-pool-${h}.example`).sort());
});

// ---------------------------------------------------------------------------
// gitlabToken
// ---------------------------------------------------------------------------

test("gitlabToken: a stored exact alias-host token wins", async () => {
  setGitHubToken("gitlab-work.io", "alias-tok");
  setGitHubToken("gitlab.com", "default-tok");
  expect(await gitlabToken("gitlab-work.io")).toBe("alias-tok");
});

test("gitlabToken: falls back to a stored gitlab.com entry when there's no exact match", async () => {
  setGitHubToken("gitlab.com", "default-tok");
  expect(await gitlabToken("gitlab-other-alias.io")).toBe("default-tok");
});

test("gitlabToken: a stored github.com entry is not leaked to a gitlab host (cross-provider leak guard)", async () => {
  setGitHubToken("github.com", "gh-tok");
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path";
  try {
    expect(await gitlabToken("gitlab-work.io")).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("gitlabToken: GITLAB_TOKEN env is used when the store is empty", async () => {
  process.env.GITLAB_TOKEN = "env-tok";
  expect(await gitlabToken("gitlab-work.io")).toBe("env-tok");
});

test("gitlabToken: a stored token beats GITLAB_TOKEN env", async () => {
  setGitHubToken("gitlab-work.io", "stored-tok");
  process.env.GITLAB_TOKEN = "env-tok";
  expect(await gitlabToken("gitlab-work.io")).toBe("stored-tok");
});

test("gitlabToken: null when nothing is stored, no env, and the glab CLI is unavailable", async () => {
  // Force the `glab` shellout to fail deterministically (ENOENT) rather than
  // depending on whether the real `glab` CLI happens to be installed and
  // authenticated on the machine running this test.
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path";
  try {
    expect(await gitlabToken("gitlab-work.io")).toBeNull();
    expect(await gitlabToken(null)).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

// ---------------------------------------------------------------------------
// bitbucketCreds
// ---------------------------------------------------------------------------

test("bitbucketCreds: stored 'email:token' resolves to basic auth", async () => {
  setGitHubToken("bitbucket-work.org", "user@example.com:abc123");
  expect(await bitbucketCreds("bitbucket-work.org")).toEqual({
    kind: "basic",
    username: "user@example.com",
    password: "abc123",
  });
});

test("bitbucketCreds: a stored bare token (no colon) resolves to bearer auth", async () => {
  setGitHubToken("bitbucket-work.org", "plain-bearer-token");
  expect(await bitbucketCreds("bitbucket-work.org")).toEqual({ kind: "bearer", token: "plain-bearer-token" });
});

test("bitbucketCreds: a colon inside the secret splits on the FIRST colon only", async () => {
  setGitHubToken("bitbucket-work.org", "user@example.com:abc:123:xyz");
  expect(await bitbucketCreds("bitbucket-work.org")).toEqual({
    kind: "basic",
    username: "user@example.com",
    password: "abc:123:xyz",
  });
});

test("bitbucketCreds: BITBUCKET_TOKEN + BITBUCKET_EMAIL env combo yields basic auth", async () => {
  process.env.BITBUCKET_TOKEN = "tok-no-colon";
  process.env.BITBUCKET_EMAIL = "me@example.com";
  expect(await bitbucketCreds("bitbucket-work.org")).toEqual({
    kind: "basic",
    username: "me@example.com",
    password: "tok-no-colon",
  });
});

test("bitbucketCreds: BITBUCKET_TOKEN containing a colon is parsed as basic auth even without BITBUCKET_EMAIL", async () => {
  process.env.BITBUCKET_TOKEN = "env@example.com:env-tok";
  expect(await bitbucketCreds(null)).toEqual({
    kind: "basic",
    username: "env@example.com",
    password: "env-tok",
  });
});

test("bitbucketCreds: BITBUCKET_TOKEN alone (no email, no colon) yields bearer auth", async () => {
  process.env.BITBUCKET_TOKEN = "bare-env-token";
  expect(await bitbucketCreds(null)).toEqual({ kind: "bearer", token: "bare-env-token" });
});

test("bitbucketCreds: falls back to a stored bitbucket.org entry when there's no exact remoteHost match", async () => {
  setGitHubToken("bitbucket.org", "fallback-tok");
  expect(await bitbucketCreds("some-other-alias.org")).toEqual({ kind: "bearer", token: "fallback-tok" });
});

test("bitbucketCreds: a stored github.com entry is not leaked to a bitbucket host (cross-provider leak guard)", async () => {
  setGitHubToken("github.com", "gh-tok");
  expect(await bitbucketCreds("bitbucket-work.org")).toBeNull();
});

test("bitbucketCreds: null when nothing is stored and no env is set", async () => {
  expect(await bitbucketCreds("bitbucket-work.org")).toBeNull();
  expect(await bitbucketCreds(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// tokenForHost (github-tokens.ts) — regression guard for existing github
// callers, since git-provider.ts's gitlabToken/bitbucketCreds share this same
// resolution primitive with a non-default fallbackHost.
// ---------------------------------------------------------------------------

test("tokenForHost: default fallbackHost is still github.com", () => {
  setGitHubToken("github.com", "gh-default-tok");
  expect(tokenForHost("some-unrelated-host.example.com")).toBe("gh-default-tok");
  expect(tokenForHost(null)).toBe("gh-default-tok");
});
