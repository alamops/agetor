import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  providerForHost,
  providerRepoForDir,
  remoteHostsForDirs,
  __clearRemoteHostsCacheForTest,
  gitlabToken,
  bitbucketCreds,
  apiHostForRemote,
  __clearApiHostCacheForTest,
} from "./git-provider.ts";
import { setGitHubToken, tokenForHost } from "./github-tokens.ts";
import { makeAliasGitHubRepo } from "./github-test-util.ts";

// git-provider.ts resolves AGETOR_DATA_DIR lazily at call time (via
// github-tokens.ts's resolveDataDir), so — like github-tokens.test.ts — it's
// safe to swap the env var per-test. Each test gets its own mkdtemp token
// store dir; GITLAB_TOKEN/BITBUCKET_TOKEN/BITBUCKET_EMAIL/AGETOR_SSH_BIN are
// saved/cleared before every test and restored after so no test can leak env
// into another, and so gitlabToken/bitbucketCreds's env-fallback tier and
// apiHostForRemote's binary override only ever see what a given test
// explicitly sets.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ENV_KEYS = ["GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_EMAIL", "AGETOR_SSH_BIN"] as const;
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
  __clearRemoteHostsCacheForTest();
  // Same reasoning for apiHostForRemote's cache, keyed by raw remoteHost —
  // without this, a host string reused across tests (unlikely but not
  // guaranteed unique) could read a stale resolution from an earlier test's
  // stub instead of exercising the current test's.
  __clearApiHostCacheForTest();
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

test("remoteHostsForDirs caches within the TTL: a second call for the same dirs reuses the first scan even after the repo's remote changes, and __clearRemoteHostsCacheForTest() bypasses it", async () => {
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
  __clearRemoteHostsCacheForTest();
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
//
// gitlabToken now resolves credentials against `apiHostForRemote(remoteHost)`
// (MF-2, docs/plans/per-host-git-api-bases.md §8.1b) rather than the raw
// host, and scopes the resolution tiers differently for cloud vs
// self-hosted. Every test below installs a deterministic `AGETOR_SSH_BIN`
// stub (an identity stub unless the test specifically wants an
// alias-resolves-to-gitlab.com scenario) so results never depend on the real
// `ssh` binary or the machine's actual ~/.ssh/config — without this,
// `apiHostForRemote`'s internal ssh spawn would make these tests
// nondeterministic across machines the way they weren't before MF-2.
// ---------------------------------------------------------------------------

/** Identity ssh stub: echoes the input host back unchanged, matching real
 *  ssh's default behavior for a host with no matching ~/.ssh/config entry —
 *  i.e. simulates a genuine (non-aliased) self-hosted domain. */
function identitySshStub(): string {
  return writeSshStub('#!/bin/sh\necho "hostname $3"\n');
}

test("gitlabToken: a stored exact host-keyed token wins (self-hosted path)", async () => {
  process.env.AGETOR_SSH_BIN = identitySshStub();
  setGitHubToken("gitlab-work.io", "alias-tok");
  setGitHubToken("gitlab.com", "default-tok");
  expect(await gitlabToken("gitlab-work.io")).toBe("alias-tok");
});

test("gitlabToken: cloud (resolves to gitlab.com) — falls back to a stored gitlab.com entry when there's no exact match; gitlab.com behavior is unchanged from before MF-2", async () => {
  // Stub resolves any input to gitlab.com, simulating a real ssh-config
  // alias whose HostName is gitlab.com — the cloud path, where the
  // pre-MF-2 three-tier fallback still applies.
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname gitlab.com'\n");
  setGitHubToken("gitlab.com", "default-tok");
  expect(await gitlabToken("gitlab-other-alias.io")).toBe("default-tok");
});

test("gitlabToken: self-hosted resolved host does NOT fall back to a stored gitlab.com entry (credential-scoping guard, MF-2)", async () => {
  process.env.AGETOR_SSH_BIN = identitySshStub();
  setGitHubToken("gitlab.com", "default-tok");
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path"; // deny the glab last-tier shellout too
  try {
    expect(await gitlabToken("gitlab-other-alias.io")).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("gitlabToken: a stored github.com entry is not leaked to a gitlab host (cross-provider leak guard)", async () => {
  process.env.AGETOR_SSH_BIN = identitySshStub();
  setGitHubToken("github.com", "gh-tok");
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path";
  try {
    expect(await gitlabToken("gitlab-work.io")).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("gitlabToken: cloud (resolves to gitlab.com) — GITLAB_TOKEN env is used when the store is empty", async () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname gitlab.com'\n");
  process.env.GITLAB_TOKEN = "env-tok";
  expect(await gitlabToken("gitlab-work.io")).toBe("env-tok");
});

test("gitlabToken: self-hosted resolved host does NOT use GITLAB_TOKEN env (credential-scoping guard, MF-2)", async () => {
  process.env.AGETOR_SSH_BIN = identitySshStub();
  process.env.GITLAB_TOKEN = "env-tok";
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path"; // deny the glab last-tier shellout too
  try {
    expect(await gitlabToken("gitlab-work.io")).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("gitlabToken: a stored token beats GITLAB_TOKEN env", async () => {
  process.env.AGETOR_SSH_BIN = identitySshStub();
  setGitHubToken("gitlab-work.io", "stored-tok");
  process.env.GITLAB_TOKEN = "env-tok";
  expect(await gitlabToken("gitlab-work.io")).toBe("stored-tok");
});

test("gitlabToken: self-hosted also accepts a token stored under the RESOLVED host when it differs from the raw alias", async () => {
  // The raw alias resolves (via the stub) to a genuine self-hosted domain
  // distinct from the alias string itself; the token is stored under the
  // resolved host, not the raw one, and must still be found (MF-2's second
  // exact-match tier).
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname gitlab.selfhosted.example'\n");
  setGitHubToken("gitlab.selfhosted.example", "resolved-host-tok");
  expect(await gitlabToken("gitlab-alias")).toBe("resolved-host-tok");
});

test("gitlabToken: null when nothing is stored, no env, and the glab CLI is unavailable (self-hosted host and no remote in scope)", async () => {
  // Force the `glab` shellout to fail deterministically (ENOENT) rather than
  // depending on whether the real `glab` CLI happens to be installed and
  // authenticated on the machine running this test.
  process.env.AGETOR_SSH_BIN = identitySshStub();
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
// apiHostForRemote — ssh-config-aware hostname resolution
// (docs/plans/per-host-git-api-bases.md). Every test below points
// AGETOR_SSH_BIN at a throwaway stub script instead of touching the real
// `ssh` or any real ~/.ssh/config, so these are deterministic regardless of
// the machine running them.
// ---------------------------------------------------------------------------

/** Writes an executable stub standing in for `ssh` and returns its path.
 *  `apiHostForRemote` invokes it as `<stub> -G -- <host>`, so `$3` is the
 *  (lowercase-trimmed) host argument when a stub cares to inspect it. */
function writeSshStub(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-provider-ssh-stub-"));
  createdDirs.push(dir);
  const binPath = path.join(dir, "ssh");
  writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

/** Writes an ssh stub that also touches a marker file on every invocation
 *  (before running `body`), so a test can assert ssh was never spawned at
 *  all — needed by the cloud-short-circuit and charset-guard tests below,
 *  which must prove NO spawn happened, not just that the result matches. */
function writeSshSpawnMarkerStub(body: string): { bin: string; marker: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-provider-ssh-stub-"));
  createdDirs.push(dir);
  const marker = path.join(dir, "invoked");
  const bin = path.join(dir, "ssh");
  writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\n${body}`, { mode: 0o755 });
  return { bin, marker };
}

test("apiHostForRemote: a host with no ssh-config alias echoes the input (identity)", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub('#!/bin/sh\necho "hostname $3"\n');
  expect(apiHostForRemote("gitlab.mycompany.com")).toBe("gitlab.mycompany.com");
});

test("apiHostForRemote: an ssh-config alias resolves to the aliased HostName, regardless of the raw input", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname gitlab.com'\n");
  expect(apiHostForRemote("gitlab-work")).toBe("gitlab.com");
  expect(apiHostForRemote("some-other-alias.example")).toBe("gitlab.com");
});

test("apiHostForRemote: falls back to the input on ssh failure (non-zero exit)", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\nexit 1\n");
  expect(apiHostForRemote("gitlab-work.io")).toBe("gitlab-work.io");
});

test("apiHostForRemote: falls back to the input when the ssh binary itself can't be spawned", () => {
  process.env.AGETOR_SSH_BIN = path.join(tmpdir(), "agetor-does-not-exist-ssh-binary-xyz");
  expect(apiHostForRemote("gitlab-work.io")).toBe("gitlab-work.io");
});

test("apiHostForRemote: falls back to the input when ssh's output has no parseable hostname line", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'user someone'\n");
  expect(apiHostForRemote("gitlab-work.io")).toBe("gitlab-work.io");
});

test("apiHostForRemote: normalizes mixed-case input to lowercase, including on ssh failure (NTH-6)", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\nexit 1\n");
  expect(apiHostForRemote("GitLab-Work.IO")).toBe("gitlab-work.io");
});

test("apiHostForRemote caches by normalized input: a second call for the same host, OR a different-case spelling of it, reuses the first resolution even after the stub changes, and __clearApiHostCacheForTest() bypasses it (NTH-6)", () => {
  const stub = writeSshStub("#!/bin/sh\necho 'hostname first-resolved.example'\n");
  process.env.AGETOR_SSH_BIN = stub;

  const first = apiHostForRemote("gitlab-cache-test.example");
  expect(first).toBe("first-resolved.example");

  // Flip the stub's resolution after the first call. Within the cache, a
  // second call for the exact same raw host must reuse the first result
  // rather than re-spawning ssh — and so must a *different-case spelling*
  // of the same host, since the cache is keyed by the normalized form.
  writeFileSync(stub, "#!/bin/sh\necho 'hostname second-resolved.example'\n", { mode: 0o755 });
  const second = apiHostForRemote("gitlab-cache-test.example");
  expect(second).toBe("first-resolved.example");
  const secondMixedCase = apiHostForRemote("Gitlab-Cache-Test.EXAMPLE");
  expect(secondMixedCase).toBe("first-resolved.example");

  // Bypassing the cache observes the stub's new resolution immediately.
  __clearApiHostCacheForTest();
  const third = apiHostForRemote("gitlab-cache-test.example");
  expect(third).toBe("second-resolved.example");
});

test("apiHostForRemote: empty, whitespace-only, or option-injecting (leading '-') input returns the normalized (trimmed+lowercased) form without ever spawning ssh (NTH-6)", () => {
  const { bin, marker } = writeSshSpawnMarkerStub("echo 'hostname should-not-be-used.example'\n");
  process.env.AGETOR_SSH_BIN = bin;

  expect(apiHostForRemote("")).toBe("");
  // The guard fires on the *normalized* (trimmed) form, so a whitespace-only
  // raw input is NOT echoed back verbatim — it comes back as "".
  expect(apiHostForRemote("   ")).toBe("");
  // Likewise, a leading-dash input comes back lowercased, not raw-cased.
  expect(apiHostForRemote("-oProxyCommand=touch /tmp/pwned")).toBe("-oproxycommand=touch /tmp/pwned");
  expect(existsSync(marker)).toBe(false);
});

test("apiHostForRemote: a hostname charset violation (embedded whitespace or a newline) returns the normalized form without ever spawning ssh (NTH-6)", () => {
  const { bin, marker } = writeSshSpawnMarkerStub("echo 'hostname should-not-be-used.example'\n");
  process.env.AGETOR_SSH_BIN = bin;

  expect(apiHostForRemote("gitlab .com")).toBe("gitlab .com");
  expect(apiHostForRemote("gitlab.com\nx")).toBe("gitlab.com\nx");
  expect(existsSync(marker)).toBe(false);
});

test("apiHostForRemote: the three cloud hosts (github.com/gitlab.com/bitbucket.org) short-circuit to themselves before ever spawning ssh (MF-1)", () => {
  // Stub would resolve EVERY input to a made-up host — if the short-circuit
  // didn't fire before the spawn, a cloud host would come back wrong. This
  // is exactly the altssh-workaround scenario MF-1 exists for: a user's real
  // ~/.ssh/config for `Host gitlab.com` could plausibly set `HostName
  // altssh.gitlab.com` for the SSH-over-443 workaround.
  const { bin, marker } = writeSshSpawnMarkerStub("echo 'hostname altssh.gitlab.com'\n");
  process.env.AGETOR_SSH_BIN = bin;

  expect(apiHostForRemote("github.com")).toBe("github.com");
  expect(apiHostForRemote("gitlab.com")).toBe("gitlab.com");
  expect(apiHostForRemote("bitbucket.org")).toBe("bitbucket.org");
  // Mixed-case cloud host input still short-circuits (post-normalization).
  expect(apiHostForRemote("GitLab.COM")).toBe("gitlab.com");
  expect(existsSync(marker)).toBe(false);
});

test("apiHostForRemote: an ssh alias resolving to the altssh.<cloud> SSH-over-443 transport endpoint maps to the real cloud API host (MF-1)", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname altssh.gitlab.com'\n");
  expect(apiHostForRemote("gitlab-work")).toBe("gitlab.com");
});

test("apiHostForRemote: an ssh alias resolving to the ssh.<cloud> transport endpoint also maps to the real cloud API host (MF-1)", () => {
  process.env.AGETOR_SSH_BIN = writeSshStub("#!/bin/sh\necho 'hostname ssh.github.com'\n");
  expect(apiHostForRemote("github-work")).toBe("github.com");
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
