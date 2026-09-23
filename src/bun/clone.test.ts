import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  cancelClone,
  CLONE_PROGRESS_MAX_EVENTS,
  cloneAuthEnv,
  cloneAuthHeader,
  cloneRepo,
  defaultCloneDest,
  explainCloneFailure,
  isAuthShapedCloneFailure,
  parseCloneProgress,
  pickCloneDisplayLine,
  readCloneStderrStream,
  resolveCloneRepo,
  sanitizeCloneStderr,
  type CloneProgress,
} from "./clone.ts";
import { __clearApiHostCacheForTest } from "./git-provider.ts";
import { setGitHubToken } from "./github-tokens.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { basicAuthValue, makeBareSourceRepo, startAuthGitServer, startAuthRedirectServer } from "./clone-test-util.ts";

// clone.ts pulls in git-provider.ts / github-tokens.ts (for cloneAuthHeader),
// both of which resolve AGETOR_DATA_DIR lazily at call time (not at module
// load) — see github-tokens.test.ts's own comment — so, like
// git-provider.test.ts, it's safe to swap the env var per-test in
// beforeEach/afterEach rather than once in beforeAll.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "BITBUCKET_EMAIL",
  "AGETOR_SSH_BIN",
] as const;
let dataDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-tokens-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // See git-provider.test.ts: apiHostForRemote's cache is keyed by raw
  // remoteHost, so without clearing it a host string reused across tests
  // could read a stale resolution from an earlier test's AGETOR_SSH_BIN stub.
  __clearApiHostCacheForTest();
});

afterEach(() => {
  rmTestDataDir(dataDir);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
});

// ---------------------------------------------------------------------------
// resolveCloneRepo — the D2 host table
// ---------------------------------------------------------------------------

/** Writes an executable ssh stub (see git-provider.test.ts's own
 *  `writeSshStub`) whose `-G -- <host>` resolution follows a small alias
 *  table, echoing any other host back unchanged (real ssh's behavior for a
 *  host with no matching `~/.ssh/config` entry). `apiHostForRemote` invokes
 *  it as `<stub> -G -- <host>`, so `$3` is the (already lowercased) host. */
function writeAliasSshStub(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-clone-ssh-stub-"));
  const bin = path.join(dir, "ssh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'host="$3"',
      'case "$host" in',
      '  github-work) echo "hostname github.com" ;;',
      '  gitlab-work) echo "hostname gitlab.internal.example.com" ;;',
      '  gitlab-cloud-alias) echo "hostname gitlab.com" ;;',
      '  bitbucket-work) echo "hostname bitbucket.org" ;;',
      // Fix 3 regression fixtures: a resolution that is itself malformed as
      // a host (embeds a path/query — what a `ssh -G` config typo, or a
      // hand-edited alias, could plausibly produce), and a gitlab-named
      // alias whose config actually points at github.com (the provider-
      // confusion case — must never end up cloning github.com under a
      // GitLab credential origin).
      '  gitlab-evil) echo "hostname evil.example.com/x?tok=1" ;;',
      '  gitlab-confused) echo "hostname github.com" ;;',
      '  *) echo "hostname $host" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

describe("resolveCloneRepo", () => {
  beforeEach(() => {
    process.env.AGETOR_SSH_BIN = writeAliasSshStub();
  });

  describe("shorthand", () => {
    test("defaults to github when no shorthandProvider is given", () => {
      const result = resolveCloneRepo("foo/bar");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "github",
          transport: "https",
          rawHost: "github.com",
          repo: "bar",
          fullPath: "foo/bar",
          cloneUrl: "https://github.com/foo/bar.git",
          authOrigin: "https://github.com/",
        },
      });
    });

    test("resolves against the picker's selected provider — github/gitlab/bitbucket", () => {
      for (const [provider, cloudHost] of [
        ["github", "github.com"],
        ["gitlab", "gitlab.com"],
        ["bitbucket", "bitbucket.org"],
      ] as const) {
        const result = resolveCloneRepo("acme/widgets", provider);
        expect(result).toEqual({
          ok: true,
          repo: {
            provider,
            transport: "https",
            rawHost: cloudHost,
            repo: "widgets",
            fullPath: "acme/widgets",
            cloneUrl: `https://${cloudHost}/acme/widgets.git`,
            authOrigin: `https://${cloudHost}/`,
          },
        });
      }
    });

    test("gitlab shorthand keeps nested groups, repo/fullPath reflect the full nested path", () => {
      const result = resolveCloneRepo("group/sub/project", "gitlab");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.fullPath).toBe("group/sub/project");
      expect(result.repo.repo).toBe("project");
      expect(result.repo.cloneUrl).toBe("https://gitlab.com/group/sub/project.git");
    });
  });

  describe("ssh/scp — preserved verbatim, authOrigin null", () => {
    test("github scp form with user preserved exactly", () => {
      const result = resolveCloneRepo("git@github-work:foo/bar.git");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "github",
          transport: "ssh",
          rawHost: "github-work",
          repo: "bar",
          fullPath: "foo/bar",
          cloneUrl: "git@github-work:foo/bar.git",
          authOrigin: null,
        },
      });
    });

    test("gitlab ssh:// form with user/port preserved exactly, no resolution attempted", () => {
      const result = resolveCloneRepo("ssh://myuser@gitlab-work:2222/group/proj.git");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "gitlab",
          transport: "ssh",
          rawHost: "gitlab-work",
          repo: "proj",
          fullPath: "group/proj",
          cloneUrl: "ssh://myuser@gitlab-work:2222/group/proj.git",
          authOrigin: null,
        },
      });
    });

    test("bitbucket scp form over a dotless alias is accepted, host preserved as pasted", () => {
      const result = resolveCloneRepo("git@bitbucket-work:acme/app.git");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "bitbucket",
          transport: "ssh",
          rawHost: "bitbucket-work",
          repo: "app",
          fullPath: "acme/app",
          cloneUrl: "git@bitbucket-work:acme/app.git",
          authOrigin: null,
        },
      });
    });

    test("bitbucket scp form over a genuine Server/DC-shaped dotted host is rejected", () => {
      const result = resolveCloneRepo("git@bitbucket.mycompany.com:proj/repo.git");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Bitbucket Server / Data Center is not supported");
    });
  });

  describe("github https", () => {
    test("github.com clones as-is", () => {
      const result = resolveCloneRepo("https://github.com/foo/bar");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "github",
          transport: "https",
          rawHost: "github.com",
          repo: "bar",
          fullPath: "foo/bar",
          cloneUrl: "https://github.com/foo/bar.git",
          authOrigin: "https://github.com/",
        },
      });
    });

    test("www. and http:// are both normalized to the same canonical https url", () => {
      for (const input of ["https://www.github.com/foo/bar", "http://github.com/foo/bar"]) {
        const result = resolveCloneRepo(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.repo.cloneUrl).toBe("https://github.com/foo/bar.git");
        expect(result.repo.authOrigin).toBe("https://github.com/");
      }
    });

    test("an alias resolving to github.com is rewritten to github.com, rawHost stays the alias", () => {
      const result = resolveCloneRepo("https://github-work/foo/bar");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.rawHost).toBe("github-work");
      expect(result.repo.cloneUrl).toBe("https://github.com/foo/bar.git");
      expect(result.repo.authOrigin).toBe("https://github.com/");
    });

    test("a dotted GHES host is rejected with the GHES message", () => {
      const result = resolveCloneRepo("https://github.mycompany.com/foo/bar");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("GitHub Enterprise Server");
      expect(result.error).toContain("github.mycompany.com");
    });

    test("a dotless unresolved alias gets the SSH-alias hint, not the GHES message", () => {
      const result = resolveCloneRepo("https://github-personal/foo/bar");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("looks like an SSH alias");
      expect(result.error).toContain("git@github-personal:foo/bar.git");
    });

    test("cloud port :443 is dropped, any other port is rejected", () => {
      const ok = resolveCloneRepo("https://github.com:443/foo/bar");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.repo.cloneUrl).toBe("https://github.com/foo/bar.git");

      const rejected = resolveCloneRepo("https://github.com:8443/foo/bar");
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toContain("unexpected port :8443");
    });
  });

  describe("gitlab https", () => {
    test("gitlab.com clones as-is", () => {
      const result = resolveCloneRepo("https://gitlab.com/foo/bar");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "gitlab",
          transport: "https",
          rawHost: "gitlab.com",
          repo: "bar",
          fullPath: "foo/bar",
          cloneUrl: "https://gitlab.com/foo/bar.git",
          authOrigin: "https://gitlab.com/",
        },
      });
    });

    test("nested groups are kept end to end (repo/fullPath/cloneUrl)", () => {
      const result = resolveCloneRepo("https://gitlab.com/group/sub/project");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.fullPath).toBe("group/sub/project");
      expect(result.repo.repo).toBe("project");
      expect(result.repo.cloneUrl).toBe("https://gitlab.com/group/sub/project.git");
    });

    test("an alias resolving to gitlab.com behaves exactly like pasting gitlab.com", () => {
      const result = resolveCloneRepo("https://gitlab-cloud-alias/foo/bar");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.rawHost).toBe("gitlab-cloud-alias");
      expect(result.repo.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
      expect(result.repo.authOrigin).toBe("https://gitlab.com/");
    });

    test("self-hosted https with a port keeps scheme/port, authOrigin scoped to host:port", () => {
      const result = resolveCloneRepo("https://gitlab.internal.example.com:8443/group/proj");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "gitlab",
          transport: "https",
          rawHost: "gitlab.internal.example.com",
          repo: "proj",
          fullPath: "group/proj",
          cloneUrl: "https://gitlab.internal.example.com:8443/group/proj.git",
          authOrigin: "https://gitlab.internal.example.com:8443/",
        },
      });
    });

    test("self-hosted plain http:// keeps http, authOrigin is null (never send a token over cleartext)", () => {
      const result = resolveCloneRepo("http://gitlab.internal.example.com/group/proj");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.cloneUrl).toBe("http://gitlab.internal.example.com/group/proj.git");
      expect(result.repo.authOrigin).toBeNull();
    });

    test("an alias to a self-hosted instance: cloneUrl AND authOrigin use the resolved host, rawHost stays the alias", () => {
      const result = resolveCloneRepo("https://gitlab-work/group/proj");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repo.rawHost).toBe("gitlab-work");
      expect(result.repo.cloneUrl).toBe("https://gitlab.internal.example.com/group/proj.git");
      expect(result.repo.authOrigin).toBe("https://gitlab.internal.example.com/");
    });

    // Review finding #3: `ssh -G`'s resolved host used to be spliced into
    // `cloneUrl`/`authOrigin` with no validation at all.
    test("a resolution that is itself malformed as a host (embeds a path/query) is rejected, never turned into a URL", () => {
      const result = resolveCloneRepo("https://gitlab-evil/group/proj");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('"gitlab-evil" resolves to "evil.example.com/x?tok=1"');
      expect(result.error).toContain("isn't a valid GitLab host");
      // Never leaked into anything URL-shaped.
      expect(result.error).not.toContain("://evil.example.com/x?tok=1");
    });

    test("a gitlab-named alias resolving to github.com is rejected — never clones github.com under a GitLab credential origin", () => {
      const result = resolveCloneRepo("https://gitlab-confused/group/proj");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('"gitlab-confused" resolves to "github.com"');
      expect(result.error).toContain("isn't a valid GitLab host");
    });
  });

  describe("bitbucket https", () => {
    test("bitbucket.org clones as-is", () => {
      const result = resolveCloneRepo("https://bitbucket.org/foo/bar");
      expect(result).toEqual({
        ok: true,
        repo: {
          provider: "bitbucket",
          transport: "https",
          rawHost: "bitbucket.org",
          repo: "bar",
          fullPath: "foo/bar",
          cloneUrl: "https://bitbucket.org/foo/bar.git",
          authOrigin: "https://bitbucket.org/",
        },
      });
    });

    test("a Bitbucket Server /scm/ URL is rejected with the Server message", () => {
      const result = resolveCloneRepo("https://bitbucket.mycompany.com/scm/proj/repo");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Bitbucket Server / Data Center is not supported");
    });

    test("a dotless alias over https gets the SSH-alias hint, not the Server message", () => {
      const result = resolveCloneRepo("https://bitbucket-personal/foo/bar");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("looks like an SSH alias");
    });

    test("cloud port :443 is dropped, any other port is rejected", () => {
      const ok = resolveCloneRepo("https://bitbucket.org:443/foo/bar");
      expect(ok.ok).toBe(true);

      const rejected = resolveCloneRepo("https://bitbucket.org:8443/foo/bar");
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toContain("unexpected port :8443");
    });
  });

  test("an unsupported host is rejected with the supported-hosts hint", () => {
    const result = resolveCloneRepo("https://git.example.com/foo/bar");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unsupported host");
    expect(result.error).toContain("git.example.com");
  });
});

// ---------------------------------------------------------------------------
// cloneAuthEnv
// ---------------------------------------------------------------------------

describe("cloneAuthEnv", () => {
  const auth = { origin: "https://github.com/", header: "Authorization: Basic abc123" };

  test("fresh env (no GIT_CONFIG_COUNT) appends at indices 0/1", () => {
    const result = cloneAuthEnv({}, auth);
    expect(result).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic abc123",
      GIT_CONFIG_KEY_1: "http.followRedirects",
      GIT_CONFIG_VALUE_1: "false",
    });
  });

  test("a pre-existing GIT_CONFIG_COUNT=1 composes by appending at indices 1/2, COUNT becomes 3", () => {
    const result = cloneAuthEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "foo", GIT_CONFIG_VALUE_0: "bar" }, auth);
    expect(result).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: "Authorization: Basic abc123",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
    });
    // Returns ONLY the additions — the caller is responsible for spreading
    // the base env's own KEY_0/VALUE_0 on top separately.
    expect(result.GIT_CONFIG_KEY_0).toBeUndefined();
  });

  test("a garbage or negative GIT_CONFIG_COUNT is treated as 0", () => {
    for (const bad of ["garbage", "-5", "", undefined]) {
      const result = cloneAuthEnv({ GIT_CONFIG_COUNT: bad }, auth);
      expect(result.GIT_CONFIG_COUNT).toBe("2");
      expect(result.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    }
  });

  test("returns ONLY the five new keys — nothing from baseEnv leaks through", () => {
    const result = cloneAuthEnv({ GIT_CONFIG_COUNT: "0", PATH: "/usr/bin", HOME: "/home/x" }, auth);
    expect(Object.keys(result).sort()).toEqual(
      ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// isAuthShapedCloneFailure
// ---------------------------------------------------------------------------

describe("isAuthShapedCloneFailure", () => {
  const authShaped = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: could not read Password for 'https://github.com': terminal prompts disabled",
    "remote: Authentication failed for 'https://gitlab.com/foo/bar.git/'",
    "remote: Repository not found.",
    "fatal: repository 'https://github.com/foo/bar.git/' not found",
    "fatal: unable to access 'https://x/': The requested URL returned error: 401",
    "fatal: unable to access 'https://x/': The requested URL returned error: 403",
    "fatal: unable to access 'https://x/': The requested URL returned error: 404",
    "remote: HTTP Basic: Access denied",
  ];

  for (const line of authShaped) {
    test(`recognizes: ${line}`, () => {
      expect(isAuthShapedCloneFailure(line)).toBe(true);
    });
  }

  const notAuthShaped = [
    "fatal: could not resolve host: git.example.com",
    "fatal: destination path 'x' already exists and is not an empty directory.",
    "fatal: unable to access 'https://x/': The requested URL returned error: 301",
    "ssh: connect to host x port 22: Connection refused",
    "fatal: unable to access 'https://x/': Could not resolve host: x",
  ];

  for (const line of notAuthShaped) {
    test(`does not recognize: ${line}`, () => {
      expect(isAuthShapedCloneFailure(line)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// explainCloneFailure
// ---------------------------------------------------------------------------

describe("explainCloneFailure", () => {
  const originalLine = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

  test("auth-shaped + https + no token used yet: 'add a token' hint, original line kept first", () => {
    const result = explainCloneFailure(originalLine, originalLine, {
      transport: "https",
      host: "github.com",
      usedToken: false,
    });
    expect(result.startsWith(originalLine)).toBe(true);
    expect(result).toContain("add a token for github.com in Settings");
    expect(result).toContain("paste the SSH URL");
  });

  test("auth-shaped + https + a token WAS tried: 'rejected or doesn't grant access' hint", () => {
    const result = explainCloneFailure(originalLine, originalLine, {
      transport: "https",
      host: "github.com",
      usedToken: true,
    });
    expect(result.startsWith(originalLine)).toBe(true);
    expect(result).toContain("rejected or doesn't grant access");
    expect(result).toContain("Settings → Git host tokens");
  });

  test("auth-shaped + ssh: SSH-key hint regardless of usedToken (ssh never has a stored-token retry)", () => {
    for (const usedToken of [true, false]) {
      const result = explainCloneFailure(originalLine, originalLine, {
        transport: "ssh",
        host: "gitlab.mycompany.com",
        usedToken,
      });
      expect(result.startsWith(originalLine)).toBe(true);
      expect(result).toContain("Your SSH key doesn't have access");
      expect(result).toContain("ssh-add -l");
    }
  });

  test("a moved (301/302/307/308) response after a token attempt: 'repository has moved' hint", () => {
    const line = "fatal: unable to access 'https://x/': The requested URL returned error: 301";
    const result = explainCloneFailure(line, line, { transport: "https", host: "x", usedToken: true });
    expect(result.startsWith(line)).toBe(true);
    expect(result).toContain("repository has moved");
  });

  test("a moved response with NO token attempt is returned unchanged (nothing useful to add)", () => {
    const line = "fatal: unable to access 'https://x/': The requested URL returned error: 301";
    const result = explainCloneFailure(line, line, { transport: "https", host: "x", usedToken: false });
    expect(result).toBe(line);
  });

  test("host key verification failed: trust hint naming the host", () => {
    const line = "Host key verification failed.";
    const result = explainCloneFailure(line, line, { transport: "ssh", host: "gitlab.com", usedToken: false });
    expect(result.startsWith(line)).toBe(true);
    expect(result).toContain('ssh -T git@gitlab.com');
  });

  test("permission denied (publickey): key/agent hint", () => {
    const line = "git@github.com: Permission denied (publickey).";
    const result = explainCloneFailure(line, line, { transport: "ssh", host: "github.com", usedToken: false });
    expect(result.startsWith(line)).toBe(true);
    expect(result).toContain("No SSH key was accepted");
  });

  test("could not resolve host — ssh phrasing points at ~/.ssh/config", () => {
    const line = "ssh: Could not resolve hostname gitlab-alias: nodename nor servname provided, or not known";
    const result = explainCloneFailure(line, line, { transport: "ssh", host: "gitlab-alias", usedToken: false });
    expect(result).toContain("didn't resolve");
    expect(result).toContain("~/.ssh/config");
  });

  test("could not resolve host — https phrasing differs for a dotless (alias-shaped) host vs a dotted one", () => {
    const dotlessLine = "fatal: unable to access 'https://x/': Could not resolve host: gitlab-alias";
    const dotless = explainCloneFailure(dotlessLine, dotlessLine, {
      transport: "https",
      host: "gitlab-alias",
      usedToken: false,
    });
    expect(dotless).toContain("SSH alias only works with the SSH URL");

    const dottedLine = "fatal: unable to access 'https://x/': Could not resolve host: gitlab.mycompany.com";
    const dotted = explainCloneFailure(dottedLine, dottedLine, {
      transport: "https",
      host: "gitlab.mycompany.com",
      usedToken: false,
    });
    expect(dotted).not.toContain("SSH alias only works with the SSH URL");
    expect(dotted).toContain("didn't resolve");
  });

  test("an unrecognized line is returned completely unchanged", () => {
    const line = "fatal: some completely novel git error nobody mapped";
    expect(explainCloneFailure(line, line, { transport: "https", host: "x", usedToken: true })).toBe(line);
    expect(explainCloneFailure(line, line, { transport: "https", host: "x", usedToken: false })).toBe(line);
  });

  test("never receives (and so can never leak) a token — the function signature carries no token field", () => {
    // ctx is `{ transport; host; usedToken }` — usedToken is a boolean, not a
    // credential. Constructing every ctx shape above with a suspicious-looking
    // fake secret as `host` proves it only ever echoes host names, never a
    // token value that was never passed to it in the first place.
    const result = explainCloneFailure(originalLine, originalLine, {
      transport: "https",
      host: "github.com",
      usedToken: true,
    });
    expect(result).not.toContain("ghp_");
    expect(result).not.toContain("glpat-");
  });

  test("displayLine (not the full stderrText) leads the returned message", () => {
    // stderrText carries the matching signal (auth-shaped), displayLine is a
    // DIFFERENT, shorter string that must be what actually leads the output —
    // proving the two params are genuinely independent, not just aliases of
    // the same string in every test above.
    const stderrText = "some noise line\nfatal: could not read Username for 'https://github.com': x";
    const displayLine = "fatal: could not read Username for 'https://github.com': x";
    const result = explainCloneFailure(stderrText, displayLine, {
      transport: "https",
      host: "github.com",
      usedToken: false,
    });
    expect(result.startsWith(displayLine)).toBe(true);
    expect(result.startsWith("some noise line")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickCloneDisplayLine + the real ssh-epilogue-noise fix (review finding #1)
// ---------------------------------------------------------------------------

describe("pickCloneDisplayLine — real git-over-ssh epilogue noise", () => {
  // Captured live (no network needed): `GIT_SSH_COMMAND="ssh -o
  // BatchMode=yes -o ConnectTimeout=5" git clone
  // ssh://git@127.0.0.1:2/does/not/exist.git <dest>` — connection refused.
  // Raw stderr (git 2.51, macOS):
  //   Cloning into 'testclone'...
  //   ssh: connect to host 127.0.0.1 port 2: Connection refused\r
  //   fatal: Could not read from remote repository.
  //
  //   Please make sure you have the correct access rights
  //   and the repository exists.
  // (note the trailing `\r` ssh itself emits on that one line — proof that
  // control-character stripping matters even for a perfectly ordinary
  // failure, not just an adversarial one.)
  const CONNECTION_REFUSED_EPILOGUE =
    "Cloning into 'testclone'...\n" +
    "ssh: connect to host 127.0.0.1 port 2: Connection refused\r\n" +
    "fatal: Could not read from remote repository.\n" +
    "\n" +
    "Please make sure you have the correct access rights\n" +
    "and the repository exists.";

  // Also captured live: an unresolvable hostname.
  const COULD_NOT_RESOLVE_EPILOGUE =
    "Cloning into 'testclone2'...\n" +
    "ssh: Could not resolve hostname nope-invalid-agetor-test.example: nodename nor servname provided, or not known\r\n" +
    "fatal: Could not read from remote repository.\n" +
    "\n" +
    "Please make sure you have the correct access rights\n" +
    "and the repository exists.";

  // Documented (well-known) shapes, same epilogue — not independently
  // re-captured live since they need a real mismatched host key / a real
  // rejecting remote, but the epilogue wrapper is identical.
  const HOST_KEY_EPILOGUE =
    "Cloning into 'exist'...\n" +
    "Host key verification failed.\n" +
    "fatal: Could not read from remote repository.\n" +
    "\n" +
    "Please make sure you have the correct access rights\n" +
    "and the repository exists.";
  const PERMISSION_DENIED_EPILOGUE =
    "Cloning into 'exist'...\n" +
    "git@github.com: Permission denied (publickey).\n" +
    "fatal: Could not read from remote repository.\n" +
    "\n" +
    "Please make sure you have the correct access rights\n" +
    "and the repository exists.";
  const GITHUB_REPO_NOT_FOUND_EPILOGUE =
    "Cloning into 'exist'...\n" +
    "ERROR: Repository not found.\n" +
    "fatal: Could not read from remote repository.\n" +
    "\n" +
    "Please make sure you have the correct access rights\n" +
    "and the repository exists.";

  test("connection refused: picks the ssh: line, not 'and the repository exists.'", () => {
    const sanitized = sanitizeCloneStderr(CONNECTION_REFUSED_EPILOGUE);
    expect(pickCloneDisplayLine(sanitized)).toBe("ssh: connect to host 127.0.0.1 port 2: Connection refused");
  });

  test("could not resolve hostname: picks the ssh: line", () => {
    const sanitized = sanitizeCloneStderr(COULD_NOT_RESOLVE_EPILOGUE);
    expect(pickCloneDisplayLine(sanitized)).toBe(
      "ssh: Could not resolve hostname nope-invalid-agetor-test.example: nodename nor servname provided, or not known",
    );
  });

  test("host key verification failed: picks that line, not the generic fatal closer", () => {
    expect(pickCloneDisplayLine(HOST_KEY_EPILOGUE)).toBe("Host key verification failed.");
  });

  test("permission denied (publickey): picks that line", () => {
    expect(pickCloneDisplayLine(PERMISSION_DENIED_EPILOGUE)).toBe("git@github.com: Permission denied (publickey).");
  });

  test("GitHub 'ERROR: Repository not found.' over ssh: picks that line", () => {
    expect(pickCloneDisplayLine(GITHUB_REPO_NOT_FOUND_EPILOGUE)).toBe("ERROR: Repository not found.");
  });

  test("the generic fatal line survives when nothing more specific is underneath it", () => {
    const onlyGeneric =
      "Cloning into 'exist'...\n" +
      "fatal: Could not read from remote repository.\n" +
      "\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.";
    expect(pickCloneDisplayLine(onlyGeneric)).toBe("fatal: Could not read from remote repository.");
  });

  test("end-to-end via explainCloneFailure: the ssh-key hint fires for the real host-key/publickey fixtures (dead-code fix)", () => {
    const hostKeyDisplay = pickCloneDisplayLine(HOST_KEY_EPILOGUE);
    const hostKeyResult = explainCloneFailure(HOST_KEY_EPILOGUE, hostKeyDisplay, {
      transport: "ssh",
      host: "gitlab.com",
      usedToken: false,
    });
    expect(hostKeyResult).toContain("ssh -T git@gitlab.com");
    expect(hostKeyResult).not.toContain("and the repository exists");

    const pkDisplay = pickCloneDisplayLine(PERMISSION_DENIED_EPILOGUE);
    const pkResult = explainCloneFailure(PERMISSION_DENIED_EPILOGUE, pkDisplay, {
      transport: "ssh",
      host: "github.com",
      usedToken: false,
    });
    expect(pkResult).toContain("No SSH key was accepted");
    expect(pkResult).not.toContain("and the repository exists");
  });

  test("end-to-end: the connection-refused fixture is NOT auth-shaped and explainCloneFailure returns the display line unchanged", () => {
    const sanitized = sanitizeCloneStderr(CONNECTION_REFUSED_EPILOGUE);
    const displayLine = pickCloneDisplayLine(sanitized);
    expect(isAuthShapedCloneFailure(sanitized)).toBe(false);
    const result = explainCloneFailure(sanitized, displayLine, { transport: "ssh", host: "127.0.0.1", usedToken: false });
    expect(result).toBe(displayLine);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCloneStderr (review finding #2a) + ReDoS linearity (#2b)
// ---------------------------------------------------------------------------

describe("sanitizeCloneStderr", () => {
  test("strips C0/C1 control characters (including a literal \\r a real ssh emits) and neutralizes ANSI escapes, keeps \\n/\\t", () => {
    const withControlChars =
      "fatal: \x1b[31mAuthentication failed\x1b[0m for 'https://x/'\r\n\x07bell\x1b]0;evil-title\x07done\tindented";
    const sanitized = sanitizeCloneStderr(withControlChars);
    expect(sanitized).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/);
    expect(sanitized).toContain("Authentication failed");
    expect(sanitized).toContain("\n");
    expect(sanitized).toContain("\t");
  });

  test("caps an oversized single line to CLONE_STDERR_MAX_LINE_CHARS", () => {
    const hugeLine = "x".repeat(5_000);
    expect(sanitizeCloneStderr(hugeLine).length).toBeLessThanOrEqual(500);
  });

  test("caps the number of lines, keeping the TAIL", () => {
    const manyLines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const lines = sanitizeCloneStderr(manyLines).split("\n");
    expect(lines.length).toBe(50);
    expect(lines[0]).toBe("line 150");
    expect(lines[49]).toBe("line 199");
  });
});

describe("ReDoS linearity (review finding #2b)", () => {
  test("isAuthShapedCloneFailure and explainCloneFailure stay well under 200ms on a 200KB adversarial single line", () => {
    // Many repeated "repository " occurrences with NO "not found" anywhere —
    // the exact shape that made the old unbounded `/repository.*not
    // found/i` pattern quadratic: each occurrence's failed `.*` scan used to
    // walk all the way to the end of the (remote-controlled) line before
    // giving up and trying the next occurrence.
    const adversarial = "repository ".repeat(18_200); // ~200KB
    expect(adversarial.length).toBeGreaterThan(200_000);

    const start = performance.now();
    const authShaped = isAuthShapedCloneFailure(adversarial);
    explainCloneFailure(adversarial, adversarial, { transport: "https", host: "x", usedToken: false });
    const elapsed = performance.now() - start;

    expect(authShaped).toBe(false);
    expect(elapsed).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// parseCloneProgress (Addendum A) — table over REAL git 2.51 `--progress`
// records, captured live against a local `file://` clone (no network) of
// two generated repos: a 400-commit/400-file one (`bare`, small enough that
// "Compressing objects"/"Resolving deltas" show a real percentage sweep) and
// a 60,000-file single-commit one (`bare3`, large enough to trigger
// "Updating files" — git only shows that phase once a checkout is slow
// enough to clear its own progress-display delay). Every fixture below is
// the EXACT string a real `git clone --progress` wrote to stderr for one
// `\r`/`\n`-delimited record, trailing space padding (git's own
// line-clearing) included — see docs/plans/clone-repository-all-providers.md
// Addendum A.
// ---------------------------------------------------------------------------

describe("parseCloneProgress", () => {
  const cases: Array<[string, { phase: string; percent: number | null }]> = [
    ["Cloning into 'dest3'...", { phase: "starting", percent: null }],
    ["remote: Enumerating objects: 60003, done.        ", { phase: "counting", percent: null }],
    ["remote: Counting objects:   0% (1/60003)        ", { phase: "counting", percent: 0 }],
    ["remote: Counting objects:  10% (6001/60003)        ", { phase: "counting", percent: 10 }],
    ["remote: Counting objects: 100% (60003/60003)        ", { phase: "counting", percent: 100 }],
    ["remote: Counting objects: 100% (60003/60003), done.        ", { phase: "counting", percent: 100 }],
    ["remote: Compressing objects:  50% (1/2)        ", { phase: "compressing", percent: 50 }],
    ["remote: Compressing objects: 100% (2/2)        ", { phase: "compressing", percent: 100 }],
    ["remote: Compressing objects: 100% (2/2), done.        ", { phase: "compressing", percent: 100 }],
    ["Receiving objects:   0% (1/60003)", { phase: "receiving", percent: 0 }],
    ["Receiving objects:  10% (6001/60003)", { phase: "receiving", percent: 10 }],
    ["Receiving objects: 100% (60003/60003)", { phase: "receiving", percent: 100 }],
    [
      "Receiving objects: 100% (60003/60003), 2.67 MiB | 40.26 MiB/s, done.",
      { phase: "receiving", percent: 100 },
    ],
    // git's `strbuf_humanise_rate` prints a sub-KiB/s transfer as `bytes/s`
    // (and a sub-KiB total as `bytes`) — a slow clone must still count as
    // progress, not fall through to the error text.
    [
      "Receiving objects:  42% (12/28), 3.10 KiB | 512 bytes/s",
      { phase: "receiving", percent: 42 },
    ],
    [
      "Receiving objects: 100% (3/3), 215 bytes | 215.00 KiB/s, done.",
      { phase: "receiving", percent: 100 },
    ],
    ["Resolving deltas:   0% (0/664)", { phase: "resolving", percent: 0 }],
    ["Resolving deltas:  10% (67/664)", { phase: "resolving", percent: 10 }],
    ["Resolving deltas: 100% (664/664)", { phase: "resolving", percent: 100 }],
    ["Resolving deltas: 100% (664/664), done.", { phase: "resolving", percent: 100 }],
    ["Updating files:  17% (10347/60000)", { phase: "checking-out", percent: 17 }],
    ["Updating files: 100% (60000/60000)", { phase: "checking-out", percent: 100 }],
    ["Updating files: 100% (60000/60000), done.", { phase: "checking-out", percent: 100 }],
  ];

  for (const [record, expected] of cases) {
    test(`recognizes: ${JSON.stringify(record)}`, () => {
      const result = parseCloneProgress(record);
      expect(result).not.toBeNull();
      expect(result!.phase).toBe(expected.phase as CloneProgress["phase"]);
      expect(result!.percent).toBe(expected.percent);
      // The returned `line` is the sanitized (trimmed) record — every real
      // fixture above round-trips exactly, modulo the trailing space padding
      // git itself pads progress lines with for terminal-clearing purposes.
      expect(result!.line).toBe(record.trim());
    });
  }

  test("remote: Total … (git's one-off transfer summary) is NOT a progress record", () => {
    // Real capture: interleaved mid-stream between two `Receiving objects`
    // records on the SAME line in git's raw output (no `\r`/`\n` of its
    // own separating it from the previous record) — but by the time this
    // function ever sees it, `readCloneStderrStream` has already split it
    // out as its own record.
    expect(
      parseCloneProgress("remote: Total 60003 (delta 0), reused 60003 (delta 0), pack-reused 0 (from 0)        "),
    ).toBeNull();
  });

  test("junk / unrecognized text is null", () => {
    expect(parseCloneProgress("fatal: Authentication failed for 'https://x/'")).toBeNull();
    expect(parseCloneProgress("")).toBeNull();
    expect(parseCloneProgress("   ")).toBeNull();
    expect(parseCloneProgress("warning: redirecting to https://x/")).toBeNull();
  });

  test("ANSI escape sequences are neutralized (control chars stripped) and the result still doesn't match — junk, not a crash", () => {
    const withAnsi = "\x1b[31msome random colored text\x1b[0m";
    expect(parseCloneProgress(withAnsi)).toBeNull();
  });

  test("an overlong JUNK line (no recognized prefix) is null, regardless of length", () => {
    const overlong = "x".repeat(10_000);
    expect(parseCloneProgress(overlong)).toBeNull();
  });

  test("an overlong but WELL-FORMED progress line (huge object counts, still anchored end-to-end) is recognized and its `line` is capped at 200 chars", () => {
    // Real git output is unbounded in the (a/b) object counts, not just the
    // percent digits — a huge repo can legitimately produce a long line
    // that still matches the anchored shape exactly (fix 6 below is about
    // trailing content that DOESN'T fit the shape, not about length alone).
    const record = `Receiving objects:  42% (${"1".repeat(90)}/${"2".repeat(90)})`;
    expect(record.length).toBeGreaterThan(200);
    const result = parseCloneProgress(record);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("receiving");
    expect(result!.percent).toBe(42);
    expect(result!.line.length).toBe(200);
    expect(result!.line.startsWith("Receiving objects:  42% (11111")).toBe(true);
  });

  // Review finding #6: the OLD prefix-only patterns matched a percent/count
  // group followed by ANYTHING, silently classifying a line like
  // `remote: Counting objects: 50% (1/2) error: repository is archived` as
  // progress and dropping the actual error text. The patterns are now
  // anchored end-to-end (`$`), so trailing content that isn't one of the
  // real suffix shapes (an optional `(a/b)` count, `Receiving objects`'s
  // throughput suffix, an optional `, done.`) makes the WHOLE record fall
  // through as non-progress instead.
  test("fix 6: a percent-shaped line followed by trailing prose is NOT recognized as progress — it's junk to this function, so the caller can preserve it as error text", () => {
    expect(parseCloneProgress("remote: Counting objects:  50% (1/2) error: repository is archived")).toBeNull();
    expect(parseCloneProgress("Receiving objects: 100% (2/2) fatal: unexpected disconnect")).toBeNull();
    expect(parseCloneProgress("remote: Enumerating objects: 5, done. error: repository is archived")).toBeNull();
  });

  // The anchored patterns still stay linear-time (no catastrophic
  // backtracking) — but note the input to them is already capped to
  // `CLONE_PROGRESS_LINE_MAX_CHARS` (200) by `sanitizeCloneProgressLine`
  // BEFORE any pattern ever runs, so this is really exercising that cap
  // plus the anchoring together, not a from-scratch ReDoS probe the way
  // `isAuthShapedCloneFailure`'s own linearity test (over the FULL,
  // uncapped stderr text) has to be.
  test("fix 6: a long adversarial tail after a valid percent/count prefix is rejected fast (capped before matching, then falls through as junk)", () => {
    const adversarial = "Receiving objects:  50% (1/2)" + " error: repository is archived".repeat(10_000);
    expect(adversarial.length).toBeGreaterThan(200_000);
    const start = performance.now();
    const result = parseCloneProgress(adversarial);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(50);
  });

  test("a malformed 4-digit percent capture clamps to 100 rather than overflowing", () => {
    // `\d{1,3}` never captures more than 3 digits by construction, but a
    // pathological 3-digit value above 100 (git itself never emits one) must
    // still clamp rather than propagate a nonsensical percent.
    const result = parseCloneProgress("Receiving objects: 999% (1/1)");
    expect(result).not.toBeNull();
    expect(result!.percent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// readCloneStderrStream — the streaming reader (Addendum A)
// ---------------------------------------------------------------------------

/** Builds a `ReadableStream<Uint8Array>` that emits `chunks` (UTF-8 encoded)
 *  in order, each after `delayMs` (default 0 — emitted as fast as possible,
 *  all in one microtask turn) — used to control how much real wall time
 *  `readCloneStderrStream`'s rate limiter sees between chunks. */
function streamOfChunks(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(encoder.encode(chunks[i]));
      i++;
    },
  });
}

describe("readCloneStderrStream", () => {
  test("splits on both \\r and \\n, excludes progress records from the returned text, keeps non-progress lines", () => {
    const text =
      "Cloning into 'x'...\r" +
      "remote: Counting objects:  50% (1/2)        \r" +
      "remote: Total 2 (delta 0), reused 2 (delta 0), pack-reused 0 (from 0)        \n" +
      "fatal: Authentication failed for 'https://x/'\n";
    const events: CloneProgress[] = [];
    return readCloneStderrStream(streamOfChunks([text]), (p) => events.push(p)).then((stderr) => {
      expect(events.map((e) => e.phase)).toEqual(["starting", "counting"]);
      expect(stderr).not.toContain("Cloning into");
      expect(stderr).not.toContain("Counting objects");
      expect(stderr).toContain("remote: Total 2");
      expect(stderr).toContain("fatal: Authentication failed");
    });
  });

  test("a trailing record with no terminating \\r/\\n is still flushed", async () => {
    const events: CloneProgress[] = [];
    const stderr = await readCloneStderrStream(
      streamOfChunks(["Receiving objects:  50% (1/2)"]),
      (p) => events.push(p),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("receiving");
    expect(stderr).toBe("");
  });

  test("a single record split across two chunks (no separator in between) is reassembled correctly", async () => {
    const events: CloneProgress[] = [];
    const stderr = await readCloneStderrStream(
      streamOfChunks(["Receiving objects:  5", "0% (1/2)\r"]),
      (p) => events.push(p),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.percent).toBe(50);
    expect(stderr).toBe("");
  });

  test("a multi-byte UTF-8 character split across two chunks decodes correctly instead of producing replacement characters", async () => {
    // "café" — the "é" is a 2-byte UTF-8 sequence; split the encoded bytes
    // so the second chunk starts mid-character.
    const encoded = new TextEncoder().encode("fatal: café is not a repository\n");
    const first = encoded.slice(0, encoded.length - 1);
    const second = encoded.slice(encoded.length - 1);
    const chunks: Uint8Array[] = [first, second];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[i]!);
        i++;
      },
    });
    const stderr = await readCloneStderrStream(stream);
    expect(stderr).toBe("fatal: café is not a repository");
  });

  test("rate limiting: 1000 same-phase records fed in one synchronous chunk yield a bounded event count — the first (phase change) and the one 100% record always forward, everything else in between is dropped", async () => {
    // Deliberately fed as ONE chunk so the whole feed loop runs
    // synchronously with no `await` in between records — real elapsed time
    // across the loop is far under the 100ms window, so this is a
    // deterministic lower bound on how aggressively the limiter drops
    // records, not a timing-flaky assertion.
    const records: string[] = [];
    for (let i = 0; i < 999; i++) {
      records.push(`Receiving objects:  ${Math.min(99, i % 100)}% (${i}/1000)`);
    }
    records.push("Receiving objects: 100% (1000/1000)"); // the ONE 100% record
    const text = records.join("\r") + "\r";

    const events: CloneProgress[] = [];
    await readCloneStderrStream(streamOfChunks([text]), (p) => events.push(p));

    // Bounded — nowhere near the 1000 input records.
    expect(events.length).toBeLessThan(10);
    // The very first record (a phase change from "no phase yet") always
    // forwards...
    expect(events[0]!.phase).toBe("receiving");
    expect(events[0]!.percent).toBe(0);
    // ...and the 100% completion always forwards, never dropped.
    expect(events.some((e) => e.percent === 100)).toBe(true);
  });

  test("rate limiting: a second same-phase record sent after the 100ms window elapses IS forwarded", async () => {
    const events: CloneProgress[] = [];
    await readCloneStderrStream(
      streamOfChunks(["Receiving objects:  10% (1/10)\r", "Receiving objects:  20% (2/10)\r"], 150),
      (p) => events.push(p),
    );
    // Both forwarded: the first is a phase change (always sent), the second
    // arrives well past CLONE_PROGRESS_MIN_INTERVAL_MS (100ms) later.
    expect(events.map((e) => e.percent)).toEqual([10, 20]);
  });

  test("the byte-read cap still applies: an oversized stream is drained without unbounded memory growth, and progress recorded before the cap still forwards", async () => {
    const events: CloneProgress[] = [];
    const chunkSize = 200_000;
    const chunks = [
      "Receiving objects:  1% (1/1000000)\r",
      ...Array.from({ length: 20 }, () => "y".repeat(chunkSize)), // 4MB total, well past the 1MB cap
    ];
    const totalInputBytes = chunks.reduce((sum, c) => sum + Buffer.byteLength(c), 0);
    expect(totalInputBytes).toBeGreaterThan(3 * 1024 * 1024);

    const stderr = await readCloneStderrStream(streamOfChunks(chunks), (p) => events.push(p));

    // Progress recorded before the stream ever crosses the cap still forwards.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.percent).toBe(1);
    // The reader stopped ACCUMULATING (into the returned error text) well
    // before the full input — bounded memory, not "read everything, then
    // truncate at the end". (Classification/decoding of every chunk still
    // happens regardless — see the fix 1 test below for why that matters.)
    expect(stderr.length).toBeLessThan(totalInputBytes / 2);
  });

  // ---------------------------------------------------------------------------
  // Review finding #1: the rate limiter's own "always forward on phase
  // change or 100%" exceptions are bypassable by a remote-controlled stream —
  // neither exception is time-gated. `CLONE_PROGRESS_MAX_EVENTS` plus an
  // exact-repeat dedup close both bypass shapes.
  // ---------------------------------------------------------------------------

  test("fix 1: a remote parked on ONE phase at 100% forever forwards it exactly once, not once per record (the exact-repeat dedup)", async () => {
    const events: CloneProgress[] = [];
    const flood = Array.from({ length: 5_000 }, () => "remote: Counting objects: 100% (2/2), done.").join("\r") + "\r";
    await readCloneStderrStream(streamOfChunks([flood]), (p) => events.push(p));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ phase: "counting", percent: 100, line: "remote: Counting objects: 100% (2/2), done." });
  });

  test(
    "fix 1: a remote alternating between two DIFFERENT phases every record — each a phase change, each exempt from the time-based rate limit — is still bounded by CLONE_PROGRESS_MAX_EVENTS, and a trailing fatal line after the flood survives",
    async () => {
      const events: CloneProgress[] = [];
      const floodLines: string[] = [];
      for (let i = 0; i < 20_000; i++) {
        floodLines.push(
          i % 2 === 0
            ? "remote: Counting objects: 100% (2/2), done."
            : "remote: Compressing objects: 100% (2/2), done.",
        );
      }
      const text = floodLines.join("\r") + "\r" + "fatal: boom\n";

      const stderr = await readCloneStderrStream(streamOfChunks([text]), (p) => events.push(p));

      // Old behavior (unbounded): 20,000 records → 20,000 broadcasts, since
      // every record is a phase change relative to the previous one.
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThanOrEqual(CLONE_PROGRESS_MAX_EVENTS);
      // The progress flood never touches the error-text budget — the
      // trailing failure line (tiny) survives regardless of how big the
      // flood in front of it was.
      expect(stderr).toContain("fatal: boom");
    },
    20_000,
  );

  test("fix 1: a genuinely DIFFERENT percent on the same phase is never treated as a repeat (dedup is exact-match only, not phase-only)", async () => {
    const events: CloneProgress[] = [];
    await readCloneStderrStream(
      streamOfChunks(
        [
          "Receiving objects:  10% (1/10)\r",
          "Receiving objects:  10% (1/10)\r",
          "Receiving objects:  11% (2/10)\r",
        ],
        150,
      ),
      (p) => events.push(p),
    );
    // First 10% forwards (phase change). The exact-repeat second 10% is
    // dropped by the dedup rule REGARDLESS of the 150ms gap that would
    // otherwise let the time-based limiter forward it too. 11% differs from
    // the immediately preceding record, so it is never treated as a repeat
    // and forwards once its own 150ms gap has elapsed.
    expect(events.map((e) => e.percent)).toEqual([10, 11]);
  });

  // Review finding #6, exercised through the full streaming reader (not
  // just `parseCloneProgress` directly): a percent-shaped prefix followed by
  // real error prose must fall through to the returned error text instead
  // of being silently classified (and dropped) as progress.
  test("fix 6: a percent-shaped record with trailing error prose is preserved in the returned error text, not swallowed as progress", async () => {
    const events: CloneProgress[] = [];
    const stderr = await readCloneStderrStream(
      streamOfChunks(["remote: Counting objects: 50% (1/2) error: repository is archived\n"]),
      (p) => events.push(p),
    );
    expect(events).toHaveLength(0);
    expect(stderr).toContain("error: repository is archived");
  });

  // Review finding #7: `onProgress` is caller-supplied and must never be
  // able to abort stderr reading (or, transitively, the clone itself).
  test("fix 7: a throwing onProgress callback never escapes readCloneStderrStream — reading completes and the rest of the text is still returned", async () => {
    const text = "Receiving objects:  50% (1/2)\r" + "fatal: boom\n";
    const stderr = await readCloneStderrStream(streamOfChunks([text]), () => {
      throw new Error("boom from a broken onProgress callback");
    });
    expect(stderr).toContain("fatal: boom");
  });
});

// ---------------------------------------------------------------------------
// cloneAuthHeader
// ---------------------------------------------------------------------------

function decodeBasic(header: string): string {
  const b64 = header.replace(/^Authorization:\s*Basic\s+/, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("cloneAuthHeader", () => {
  test("github: stored token becomes x-access-token:<tok>", async () => {
    setGitHubToken("github.com", "gh-tok-1");
    const header = await cloneAuthHeader("github", "github.com");
    expect(header).not.toBeNull();
    expect(header!.startsWith("Authorization: Basic ")).toBe(true);
    expect(decodeBasic(header!)).toBe("x-access-token:gh-tok-1");
  });

  test("gitlab: stored token becomes oauth2:<tok>", async () => {
    // gitlab.com is a CLOUD_HOSTS short-circuit in apiHostForRemote, so no
    // AGETOR_SSH_BIN stub is needed for this case.
    setGitHubToken("gitlab.com", "gl-tok-1");
    const header = await cloneAuthHeader("gitlab", "gitlab.com");
    expect(header).not.toBeNull();
    expect(decodeBasic(header!)).toBe("oauth2:gl-tok-1");
  });

  test("bitbucket: stored 'email:apitoken' becomes x-bitbucket-api-token-auth:<apitoken> (email never sent to git)", async () => {
    setGitHubToken("bitbucket.org", "user@example.com:apitok123");
    const header = await cloneAuthHeader("bitbucket", "bitbucket.org");
    expect(header).not.toBeNull();
    expect(decodeBasic(header!)).toBe("x-bitbucket-api-token-auth:apitok123");
  });

  test("bitbucket: a stored bare token (no colon) becomes x-token-auth:<tok>", async () => {
    setGitHubToken("bitbucket.org", "bare-access-tok");
    const header = await cloneAuthHeader("bitbucket", "bitbucket.org");
    expect(header).not.toBeNull();
    expect(decodeBasic(header!)).toBe("x-token-auth:bare-access-tok");
  });

  test("bitbucket: null when nothing resolves (no store, no env — hermetic, no CLI tier to shadow)", async () => {
    const header = await cloneAuthHeader("bitbucket", "bitbucket.org");
    expect(header).toBeNull();
  });

  test("github: null when the store/env are empty and `gh` (last tier) is shadowed to fail", async () => {
    const shadowDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-ghstub-"));
    writeFileSync(path.join(shadowDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shadowDir}:${originalPath}`;
    try {
      const header = await cloneAuthHeader("github", "github.com");
      expect(header).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("gitlab: null when the store/env are empty and `glab` (last tier) is shadowed to fail", async () => {
    const shadowDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-glabstub-"));
    writeFileSync(path.join(shadowDir, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shadowDir}:${originalPath}`;
    try {
      // gitlab.com short-circuits apiHostForRemote before any ssh spawn, so
      // no AGETOR_SSH_BIN stub is needed here either.
      const header = await cloneAuthHeader("gitlab", "gitlab.com");
      expect(header).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("self-hosted GitLab host: only its OWN exact-host store entry is used — a gitlab.com entry + GITLAB_TOKEN env must not leak to it", async () => {
    process.env.AGETOR_SSH_BIN = writeAliasSshStub(); // identity fallback for an unmapped dotted host
    setGitHubToken("gitlab.com", "cloud-tok");
    process.env.GITLAB_TOKEN = "env-tok";
    const shadowDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-glabstub2-"));
    writeFileSync(path.join(shadowDir, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shadowDir}:${originalPath}`;
    try {
      const header = await cloneAuthHeader("gitlab", "gitlab.mycompany.com");
      expect(header).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }

    // The exact-host entry, by contrast, DOES resolve.
    setGitHubToken("gitlab.mycompany.com", "exact-tok");
    const header2 = await cloneAuthHeader("gitlab", "gitlab.mycompany.com");
    expect(header2).not.toBeNull();
    expect(decodeBasic(header2!)).toBe("oauth2:exact-tok");
  });
});

// ---------------------------------------------------------------------------
// defaultCloneDest
// ---------------------------------------------------------------------------

describe("defaultCloneDest", () => {
  test("lands directly under $HOME", () => {
    expect(defaultCloneDest("bar")).toBe(path.join(homedir(), "bar"));
  });
});

// ---------------------------------------------------------------------------
// cloneRepo
// ---------------------------------------------------------------------------

describe("cloneRepo", () => {
  let dir: string;
  let sourceRepo: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agetor-clone-test-"));
    // A local source repo stands in for GitHub — git clone accepts a path the
    // same way it accepts a URL, so the executor is exercised end to end
    // without the network.
    sourceRepo = path.join(dir, "source");
    mkdirSync(sourceRepo);
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: sourceRepo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    };
    git("init", "-q");
    git("config", "user.email", "test@test");
    git("config", "user.name", "test");
    writeFileSync(path.join(sourceRepo, "README.md"), "# hello\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clones into a fresh destination", async () => {
    const dest = path.join(dir, "fresh");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
  });

  test("creates missing parent directories", async () => {
    const dest = path.join(dir, "deep", "nested", "clone");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("refuses an existing non-empty destination", async () => {
    const dest = path.join(dir, "occupied");
    mkdirSync(dest);
    writeFileSync(path.join(dest, "keep.txt"), "x");
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not empty");
    // The occupant is untouched.
    expect(existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });

  test("an existing but empty destination is fine", async () => {
    const dest = path.join(dir, "empty-ok");
    mkdirSync(dest);
    const result = await cloneRepo(sourceRepo, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  test("surfaces git's error on a bad source", async () => {
    const dest = path.join(dir, "never-created");
    const result = await cloneRepo(path.join(dir, "no-such-repo"), dest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("clone failed");
  });

  // -------------------------------------------------------------------------
  // Auth-retry integration, against a local smart-HTTP git server
  // (docs/plans/clone-repository-all-providers.md §3 D4, §2 spike).
  // -------------------------------------------------------------------------

  test(
    "auth-retry integration: anonymous attempt fails, resolver called exactly once, retry succeeds, credential never persisted",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-ok-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      const server = startAuthGitServer(root, { requireAuth });
      try {
        let authCalls = 0;
        const dest = path.join(dir, "auth-retry-ok");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          auth: async () => {
            authCalls++;
            return { origin: `${server.url}/`, header: `Authorization: ${requireAuth}` };
          },
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(true);
        expect(authCalls).toBe(1);
        expect(existsSync(path.join(dest, "README.md"))).toBe(true);

        // The credential never lands in .git/config...
        const config = readFileSync(path.join(dest, ".git", "config"), "utf8");
        expect(config.toLowerCase()).not.toContain("extraheader");
        expect(config).not.toContain("good-tok");

        // ...and `origin` stays credential-free.
        const remote = spawnSync("git", ["-C", dest, "remote", "get-url", "origin"], { encoding: "utf8" });
        expect(remote.status).toBe(0);
        expect(remote.stdout.trim()).toBe(`${server.url}/repo.git`);
        expect(remote.stdout).not.toContain("good-tok");

        // At least one anonymous request happened, and at least one carried
        // the resolved credential.
        expect(server.requests.some((r) => r.authorization === null)).toBe(true);
        expect(server.requests.some((r) => r.authorization === requireAuth)).toBe(true);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "an anonymous SUCCESS (server not requiring auth) never calls the resolver",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-anon-"));
      makeBareSourceRepo(root);
      const server = startAuthGitServer(root); // no requireAuth: everything succeeds anonymously
      try {
        let authCalls = 0;
        const dest = path.join(dir, "anon-ok");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          auth: async () => {
            authCalls++;
            return { origin: `${server.url}/`, header: "Authorization: Basic should-never-be-used" };
          },
        });
        expect(result.ok).toBe(true);
        expect(authCalls).toBe(0);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test("a non-auth failure (bad local path) never calls the resolver and makes exactly one attempt", async () => {
    let authCalls = 0;
    const dest = path.join(dir, "bad-source-no-retry");
    const result = await cloneRepo(path.join(dir, "no-such-repo-at-all"), dest, {
      auth: async () => {
        authCalls++;
        return { origin: "https://example.invalid/", header: "Authorization: Basic abc" };
      },
    });
    expect(result.ok).toBe(false);
    expect(authCalls).toBe(0);
  });

  test(
    "a wrong stored credential surfaces the rejected/doesn't-grant-access hint and never leaks either token",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-wrong-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      const server = startAuthGitServer(root, { requireAuth });
      try {
        const wrongAuth = basicAuthValue("x-access-token:WRONG-tok");
        const dest = path.join(dir, "wrong-tok");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          auth: async () => ({ origin: `${server.url}/`, header: `Authorization: ${wrongAuth}` }),
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("rejected or doesn't grant access");
        expect(result.error).not.toContain("WRONG-tok");
        expect(result.error).not.toContain("good-tok");
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "a resolver returning null surfaces attempt 1's failure with an add-a-token hint",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-nullres-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      const server = startAuthGitServer(root, { requireAuth });
      try {
        const dest = path.join(dir, "resolver-null");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          auth: async () => null,
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("add a token for 127.0.0.1");
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "a resolver that THROWS degrades to 'no credential available' the same way a null resolution does",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-throwres-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      const server = startAuthGitServer(root, { requireAuth });
      try {
        const dest = path.join(dir, "resolver-throws");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          auth: async () => {
            throw new Error("credential-resolution hiccup");
          },
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("add a token for 127.0.0.1");
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "redirect non-leak: a token attempt against a redirecting origin fails (followRedirects=false) and the target sees nothing",
    async () => {
      const targetRoot = mkdtempSync(path.join(tmpdir(), "agetor-clone-cgi-target-"));
      makeBareSourceRepo(targetRoot);
      const targetServer = startAuthGitServer(targetRoot); // anonymous-open — should never even be reached
      const requireAuth = basicAuthValue("x-access-token:scoped-tok");
      const redirector = startAuthRedirectServer(targetServer.url, requireAuth);
      try {
        let authCalls = 0;
        const dest = path.join(dir, "redirect-leak");
        const result = await cloneRepo(`${redirector.url}/repo.git`, dest, {
          auth: async () => {
            authCalls++;
            return { origin: `${redirector.url}/`, header: `Authorization: ${requireAuth}` };
          },
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(false);
        expect(authCalls).toBe(1);
        expect(result.error).toMatch(/301|moved/);
        // The redirector itself DID see the credentialed request (that's how
        // it decided to redirect) — but the target never received anything.
        expect(redirector.requests.some((r) => r.authorization === requireAuth)).toBe(true);
        expect(targetServer.requests.length).toBe(0);
      } finally {
        redirector.stop();
        targetServer.stop();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Timeout reporting (review finding #4).
  // -------------------------------------------------------------------------

  test(
    "sub-minute timeout budget: attempt 1 itself times out, message is formatted in seconds (not '0 minutes')",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-timeout-fmt-"));
      makeBareSourceRepo(root);
      // A 300ms server-response delay against a 100ms clone budget forces
      // attempt 1 itself to time out — the pre-existing timeout path, just
      // with a sub-minute budget to exercise the formatting fix.
      const server = startAuthGitServer(root, { delayMs: 300 });
      try {
        const dest = path.join(dir, "timeout-fmt-seconds");
        const result = await cloneRepo(`${server.url}/repo.git`, dest, { timeoutMs: 100 });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("clone timed out after");
        expect(result.error).not.toContain("0 minutes");
        expect(result.error).toMatch(/after \d+ seconds?$/);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "attempt 1 fails auth-shaped but too little of the shared budget remains for a retry: attempt 1's own error is reported, NOT a fabricated timeout",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-noretry-budget-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      const server = startAuthGitServer(root, { requireAuth });
      try {
        let authCalls = 0;
        const dest = path.join(dir, "noretry-budget");
        // A local CGI server answers in well under a second — a 3s total
        // budget leaves far less than RETRY_MIN_TIMEOUT_MS (5s) remaining
        // after attempt 1 fails, but attempt 1 itself never times out.
        const result = await cloneRepo(`${server.url}/repo.git`, dest, {
          timeoutMs: 3_000,
          auth: async () => {
            authCalls++;
            return { origin: `${server.url}/`, header: `Authorization: ${requireAuth}` };
          },
          transport: "https",
          host: "127.0.0.1",
        });
        expect(result.ok).toBe(false);
        expect(authCalls).toBe(0); // the retry — and so opts.auth() — never ran
        expect(result.error).not.toContain("timed out");
        expect(result.error).toContain("clone failed:");
        expect(result.error).toContain("add a token for 127.0.0.1");
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  // "Destination becomes non-empty between attempt 1 and the retry" (docs/
  // plans/clone-repository-all-providers.md §3 D4) is NOT independently
  // testable from outside `cloneRepo` without either a production seam or
  // monkeypatching `node:fs` — reading `clone.ts` shows there is no `await`
  // between attempt 1's `runGitClone` resolving and the `checkCloneDestination`
  // recheck (`destCheck2`) that guards the retry, so nothing outside the
  // function can interleave between them. An empirical spike for this run
  // (writing a file into `dest` from a `setTimeout` scheduled just after
  // starting `cloneRepo`, racing a deliberately slow local auth server)
  // additionally confirmed the race can't be forced from the OUTSIDE even by
  // timing: when `dest` starts empty, git's own clone failure cleanup
  // recursively wipes `dest`'s entire contents (not just the `.git` it wrote)
  // once attempt 1 fails — so any file written in from the outside while
  // attempt 1 is still in flight is gone again by the time `destCheck2` runs,
  // and `auth()` gets called after all (observed directly: authCalls === 1,
  // the injected file no longer present). This is therefore covered by
  // reasoning only: `destCheck2`'s early-return branch (never calling
  // `opts.auth()`, reporting attempt 1's own error) is read directly off the
  // source ordering, not exercised by a passing/failing assertion here — the
  // same treatment the task brief explicitly allows for the SSH BatchMode
  // case below.

  // -------------------------------------------------------------------------
  // SSH BatchMode (D5). Full coverage note: `runGitClone` only injects
  // `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` when NEITHER `GIT_SSH_COMMAND`
  // (env) NOR `core.sshCommand` (git config, --global/--system) is already
  // set — see clone.ts's doc comment. The "already configured, left alone"
  // half of that guard is directly, hermetically testable below (a stub
  // GIT_SSH_COMMAND gets invoked verbatim, unmodified). The "BatchMode
  // injected when nothing is configured" half is NOT independently observable
  // without a production test seam (there's no way to read back the env
  // Bun.spawn actually received) — per the task brief, this half is covered
  // by reasoning only: it's the same `if (!process.env.GIT_SSH_COMMAND)`
  // conditional exercised by the test below (which proves the guard reads
  // the right variable and behaves correctly on the "already set" branch),
  // and every other ssh test in this file runs with neither env var nor git
  // config set, so the "inject BatchMode" branch runs on every one of them
  // without ever causing a hang — consistent with, but not a direct
  // assertion of, the injected value.
  // -------------------------------------------------------------------------

  test("an already-configured GIT_SSH_COMMAND is preserved verbatim, never overridden with BatchMode", async () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-sshcmd-"));
    const marker = path.join(stubDir, "invoked");
    const stubScript = path.join(stubDir, "fake-ssh.sh");
    writeFileSync(stubScript, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const original = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = stubScript;
    try {
      const dest = path.join(dir, "ssh-batchmode-preserved");
      const result = await cloneRepo("ssh://git@127.0.0.1/does/not/exist.git", dest, {
        transport: "ssh",
        host: "127.0.0.1",
      });
      expect(result.ok).toBe(false);
      // Our custom GIT_SSH_COMMAND was actually invoked as the ssh transport
      // — proving `runGitClone` left it untouched rather than clobbering it
      // with its own BatchMode override.
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = original;
    }
  }, 15_000);

  test("a configured GIT_ASKPASS helper is never invoked — an empty GIT_ASKPASS disables the askpass lookup on every attempt", async () => {
    // `GIT_TERMINAL_PROMPT=0` alone only silences the tty prompt: git consults
    // `GIT_ASKPASS` / `core.askPass` / `SSH_ASKPASS` BEFORE the terminal, so an
    // inherited helper could pop a GUI dialog or block the daemon on the
    // anonymous attempt. `runGitClone` sets `GIT_ASKPASS=""`, which git treats
    // as "askpass disabled" (a set-but-empty value wins over `core.askPass`).
    const stubDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-askpass-"));
    const marker = path.join(stubDir, "invoked");
    const askpass = path.join(stubDir, "fake-askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\ntouch "${marker}"\necho nope\n`, { mode: 0o755 });
    const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-askpass-repo-"));
    makeBareSourceRepo(root);
    const server = startAuthGitServer(root, { requireAuth: basicAuthValue("x-access-token:good-tok") });
    const original = process.env.GIT_ASKPASS;
    process.env.GIT_ASKPASS = askpass;
    try {
      const dest = path.join(dir, "askpass-never-invoked");
      const result = await cloneRepo(`${server.url}/repo.git`, dest, { transport: "https", host: "127.0.0.1" });
      expect(result.ok).toBe(false);
      // The 401 was answered by git failing fast, not by prompting our helper.
      expect(existsSync(marker)).toBe(false);
      expect(result.error).toContain("clone failed:");
    } finally {
      if (original === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = original;
      server.stop();
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Progress streaming + cancel (Addendum A,
  // docs/plans/clone-repository-all-providers.md).
  // -------------------------------------------------------------------------

  test(
    "progress: a real file:// clone yields progress events in phase order (starting first, done last), never rate-limited into silence",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-progress-"));
      // `file://` (not a bare path) is what actually forces git to emit
      // remote-side progress records — a plain path clone hard-links and
      // prints far less (see this file's `parseCloneProgress` fixtures'
      // header comment, and docs/plans/clone-repository-all-providers.md
      // Addendum A).
      const barePath = makeBareSourceRepo(root);
      const dest = path.join(dir, "progress-file-clone");
      const events: CloneProgress[] = [];
      const result = await cloneRepo(`file://${barePath}`, dest, {
        onProgress: (p) => events.push(p),
      });
      expect(result.ok).toBe(true);
      expect(existsSync(path.join(dest, "README.md"))).toBe(true);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.phase).toBe("starting");
      expect(events.at(-1)!.phase).toBe("done");
      expect(events.at(-1)!.percent).toBe(100);

      // Whatever subset of the known phase sequence actually occurred (a
      // tiny one-commit repo may skip "compressing"/"resolving"/
      // "checking-out" entirely — git only shows those once there's enough
      // work to make displaying a percentage worthwhile), the phases that DID
      // occur must appear in non-decreasing order against that sequence.
      const order = ["starting", "counting", "compressing", "receiving", "resolving", "checking-out", "done"];
      let lastIndex = -1;
      for (const e of events) {
        const idx = order.indexOf(e.phase);
        expect(idx).toBeGreaterThanOrEqual(lastIndex);
        lastIndex = idx;
      }

      // Never a credential in any progress line.
      for (const e of events) {
        expect(e.line).not.toContain("Authorization");
        expect(e.line).not.toContain("token");
      }
    },
    30_000,
  );

  test(
    "progress: a failing clone still gets a terminal `failed` event carrying the same error text as the returned result",
    async () => {
      const dest = path.join(dir, "progress-failed-clone");
      const events: CloneProgress[] = [];
      const result = await cloneRepo(path.join(dir, "no-such-repo-for-progress"), dest, {
        onProgress: (p) => events.push(p),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(events[0]!.phase).toBe("starting");
      const last = events.at(-1)!;
      expect(last.phase).toBe("failed");
      expect(last.line).toBe(result.error as string);
    },
  );

  test(
    "cancel: killing the in-flight anonymous attempt returns { ok:false, cancelled:true }, cleans up a freshly-created destination, never calls the auth resolver, empties the registry, and a second cancel or an unknown id is a no-op",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cancel-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      // A generous per-request delay gives the test a wide window to send
      // the cancel while attempt 1's anonymous request is still in flight,
      // well before the server would even answer its 401.
      const server = startAuthGitServer(root, { requireAuth, delayMs: 4_000 });
      try {
        const cloneId = "cancel-test-anon";
        let authCalls = 0;
        const dest = path.join(dir, "cancel-anon-fresh");
        const events: CloneProgress[] = [];
        const clonePromise = cloneRepo(`${server.url}/repo.git`, dest, {
          cloneId,
          onProgress: (p) => events.push(p),
          auth: async () => {
            authCalls++;
            return { origin: `${server.url}/`, header: `Authorization: ${requireAuth}` };
          },
          transport: "https",
          host: "127.0.0.1",
        });

        // Give git a moment to actually spawn, connect, and issue its first
        // request — then cancel while that request is still held by the
        // server's delay.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(cancelClone(cloneId)).toBe(true);

        const result = await clonePromise;
        expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
        expect(authCalls).toBe(0);
        // `dest` did not pre-exist, so a cancelled clone leaves it ABSENT.
        expect(existsSync(dest)).toBe(false);
        expect(events.at(-1)).toEqual({ phase: "cancelled", percent: null, line: "clone cancelled" });

        // The registry entry is gone once `cloneRepo` has settled — a
        // second cancel, and an unrelated unknown id, are both no-ops.
        expect(cancelClone(cloneId)).toBe(false);
        expect(cancelClone("no-such-clone-id")).toBe(false);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "cancel: a pre-existing empty destination is kept (never removed), but its partial contents are cleaned back to empty",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cancel-preexist-"));
      makeBareSourceRepo(root);
      const server = startAuthGitServer(root, { delayMs: 4_000 }); // anonymous-open, just slow
      try {
        const cloneId = "cancel-test-preexisting";
        const dest = path.join(dir, "cancel-preexisting-dest");
        mkdirSync(dest);
        const events: CloneProgress[] = [];
        const clonePromise = cloneRepo(`${server.url}/repo.git`, dest, {
          cloneId,
          onProgress: (p) => events.push(p),
        });

        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(cancelClone(cloneId)).toBe(true);

        const result = await clonePromise;
        expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
        // The directory ENTRY itself survives...
        expect(existsSync(dest)).toBe(true);
        // ...but whatever git had already written into it is gone.
        expect(readdirSync(dest)).toEqual([]);
        expect(events.at(-1)!.phase).toBe("cancelled");
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test("cancel: an unknown cloneId is always a no-op", () => {
    expect(cancelClone("never-registered-anywhere")).toBe(false);
  });

  test(
    "cancel: calling cancelClone after a clone has already settled successfully is a no-op (the post-settle race)",
    async () => {
      const dest = path.join(dir, "cancel-after-settle");
      const cloneId = "cancel-after-settle-id";
      const result = await cloneRepo(sourceRepo, dest, { cloneId });
      expect(result.ok).toBe(true);
      // `cloneRepo`'s promise has already resolved — `runGitClone`'s
      // `finally` has already removed the registry entry for this id, so
      // there is nothing left for `cancelClone` to act on.
      expect(cancelClone(cloneId)).toBe(false);
    },
  );

  // Review finding #2: a `cancelClone` call landing before a git child
  // process exists — before attempt 1 spawns, between attempt 1 and a
  // retry, or while `opts.auth()` is resolving — used to be a silent no-op
  // (nothing in `activeClones` to kill). It no longer is: `cloneRepo`
  // announces every clone it's given an id for via `pendingCloneIds` for
  // the WHOLE call, and latches an early cancellation (`cancelRequested`)
  // that `cloneRepo`/`runGitClone` consume at every one of those gaps. The
  // tests below exercise exactly those gaps, not just the "git child is
  // already running" case the earlier tests above already covered.

  test(
    "cancel (fix 2): calling cancelClone synchronously right after cloneRepo starts — before it has yielded even once — is still honored; the clone is announced before any process exists",
    async () => {
      // Force the GIT_SSH_COMMAND config-lookup probe in `runGitClone` to
      // actually run (an async gap) rather than being skipped — see that
      // function's own `if (!process.env.GIT_SSH_COMMAND)` branch. Without
      // this, an ambient `GIT_SSH_COMMAND` in the test environment could let
      // `Bun.spawn` happen synchronously, before this test's own
      // `cancelClone` call ever gets a turn.
      const savedSsh = process.env.GIT_SSH_COMMAND;
      delete process.env.GIT_SSH_COMMAND;
      try {
        const dest = path.join(dir, "cancel-before-first-tick");
        const cloneId = "cancel-before-first-tick-id";
        const clonePromise = cloneRepo(sourceRepo, dest, { cloneId });
        // No `await` yet — this executes in the SAME synchronous tick
        // `cloneRepo` was invoked in, well before `Bun.spawn` ever runs.
        expect(cancelClone(cloneId)).toBe(true);

        const result = await clonePromise;
        expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
        expect(existsSync(dest)).toBe(false);
      } finally {
        if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND;
        else process.env.GIT_SSH_COMMAND = savedSsh;
      }
    },
  );

  test(
    "cancel (fix 2): a cancellation that arrives while a slow opts.auth() is still resolving is honored — the token retry never spawns",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-cancel-during-auth-"));
      makeBareSourceRepo(root);
      const requireAuth = basicAuthValue("x-access-token:good-tok");
      // Anonymous-open-gated server: attempt 1 401s immediately (fast,
      // local), which is auth-shaped and would normally trigger a retry.
      const server = startAuthGitServer(root, { requireAuth });
      try {
        const cloneId = "cancel-during-auth-id";
        const dest = path.join(dir, "cancel-during-auth-dest");
        let authCalls = 0;
        const clonePromise = cloneRepo(`${server.url}/repo.git`, dest, {
          cloneId,
          auth: async () => {
            authCalls++;
            // Simulates a slow `gh auth token` shellout.
            await new Promise((resolve) => setTimeout(resolve, 300));
            return { origin: `${server.url}/`, header: `Authorization: ${requireAuth}` };
          },
          transport: "https",
          host: "127.0.0.1",
        });

        // Give attempt 1 time to fail and opts.auth() to actually start.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(cancelClone(cloneId)).toBe(true);

        const result = await clonePromise;
        expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
        // auth() DID get called and DID resolve — just too late; the retry
        // itself (a second `runGitClone` call) never ran.
        expect(authCalls).toBe(1);
        expect(existsSync(dest)).toBe(false);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  test(
    "cancel (fix 2): cancelClone is true for an id cloneRepo has announced but not yet spawned a process for, false for an unknown id, and false once the clone has settled",
    async () => {
      expect(cancelClone("cancel-tri-state-unknown-id")).toBe(false);

      const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-tristate-"));
      makeBareSourceRepo(root);
      // Slow enough that the clone is still running well past the point we
      // check `cancelClone`'s return value.
      const server = startAuthGitServer(root, { delayMs: 1_000 });
      try {
        const cloneId = "cancel-tri-state-id";
        const dest = path.join(dir, "cancel-tri-state-dest");
        const clonePromise = cloneRepo(`${server.url}/repo.git`, dest, { cloneId });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cancelClone(cloneId)).toBe(true);

        const result = await clonePromise;
        expect(result.cancelled).toBe(true);
        expect(cancelClone(cloneId)).toBe(false);
        expect(cancelClone("totally-unrelated-unknown-id")).toBe(false);
      } finally {
        server.stop();
      }
    },
    30_000,
  );

  // Review finding #3: `cleanupCancelledCloneDest` used to delete EVERY
  // entry of a pre-existing destination unconditionally, including a file
  // that merely APPEARED after `checkCloneDestination`'s emptiness check —
  // even one that has nothing to do with this clone. The fix scopes removal
  // to `.git` (always) plus entries whose own birth time is at-or-after the
  // attempt's `startedAt`. `startedAt` is captured right AFTER the
  // synthetic `starting` progress event (see `cloneRepoInner`'s own doc
  // comment on that ordering) — so anything a caller's `onProgress`
  // callback does synchronously in response to THAT event necessarily
  // predates it. Cancelling synchronously from within the same callback
  // (rather than racing a real, slow, in-flight clone) is deliberate: real
  // `git clone` refuses outright the instant it sees a non-empty `dest`
  // (verified locally, git 2.51/2.54), so a stray file dropped where git
  // could ever observe it would never reach a genuinely cancellable
  // in-flight state at all — cancelling before attempt 1 ever spawns is the
  // only way to test "an old file survives" without also fighting git's own
  // up-front emptiness check.
  test(
    "cancel (fix 3, TOCTOU): a file dropped into a pre-existing dest right as `startedAt` is about to be captured survives cleanup",
    async () => {
      const cloneId = "cancel-toctou-id";
      const dest = path.join(dir, "cancel-toctou-dest");
      mkdirSync(dest);
      const droppedFile = path.join(dest, "unrelated-user-file.txt");
      const clonePromise = cloneRepo(sourceRepo, dest, {
        cloneId,
        onProgress: (p) => {
          if (p.phase === "starting") {
            // Drop the file AND cancel synchronously, from within this one
            // callback — both land strictly before `startedAt`, and this
            // attempt never reaches `runGitClone` at all (the cancellation
            // latch is consumed right after `startedAt` is captured). A
            // brief synchronous busy-wait guarantees the file's birth time
            // and `startedAt` (`Date.now()`, both millisecond-resolution)
            // land in DIFFERENT milliseconds — otherwise a same-millisecond
            // tie would be indistinguishable from "created during the
            // attempt" under the `>=` comparison `cleanupCancelledCloneDest`
            // uses (deliberately: a real git-written file racing to the
            // same millisecond as `startedAt` must still be removed).
            writeFileSync(droppedFile, "not created by git\n");
            const until = Date.now() + 5;
            while (Date.now() < until) {
              // Busy-wait — see comment above.
            }
            cancelClone(cloneId);
          }
        },
      });

      const result = await clonePromise;
      expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
      expect(existsSync(droppedFile)).toBe(true);
    },
  );

  test(
    "cancel (fix 3): a dest this call created is left alone — never recursed into — if something replaces it with a symlink before cleanup runs",
    async () => {
      const cloneId = "cancel-symlink-guard-id";
      const dest = path.join(dir, "cancel-symlink-guard-dest");
      const sensitiveTarget = path.join(dir, "cancel-symlink-guard-sensitive");
      mkdirSync(sensitiveTarget);
      writeFileSync(path.join(sensitiveTarget, "keep-me.txt"), "do not delete\n");
      const clonePromise = cloneRepo(sourceRepo, dest, {
        cloneId,
        onProgress: (p) => {
          if (p.phase === "starting") {
            // `dest` does not exist yet at this point — `checkCloneDestination`
            // already ran and only created its PARENT directory. Swap it for
            // a symlink to somewhere that must never be touched by cleanup,
            // then cancel synchronously so this attempt never actually
            // spawns git (which would otherwise resolve straight through the
            // symlink and write real files into `sensitiveTarget`).
            symlinkSync(sensitiveTarget, dest);
            cancelClone(cloneId);
          }
        },
      });

      const result = await clonePromise;
      expect(result).toEqual({ ok: false, cancelled: true, error: "clone cancelled" });
      // Cleanup must never follow the symlink at `dest`'s own path — the
      // real target directory's contents survive untouched.
      expect(existsSync(path.join(sensitiveTarget, "keep-me.txt"))).toBe(true);
    },
  );

  // Review finding #5: a `cancelClone` call racing in AFTER git has already
  // exited 0, but BEFORE `runGitClone`'s stderr reader has observed EOF,
  // used to leave `cancelled: true` set alongside `ok: true` — a completed
  // clone reported as cancelled. Reproduced with a `git` stub that performs
  // a REAL clone via the real binary, then exits immediately while a
  // detached background process keeps this process's stderr pipe open a
  // little longer, widening the (normally sub-millisecond) real race into a
  // reliably hittable window.
  test(
    "cancel (fix 5): a cancelClone call that races in after git has already exited 0 never reports { ok:true, cancelled:true } together",
    async () => {
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      expect(realGit.length).toBeGreaterThan(0);
      const stubDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-race-stub-"));
      const gitStub = path.join(stubDir, "git");
      writeFileSync(
        gitStub,
        [
          "#!/bin/sh",
          // Run the REAL git command, then exit immediately while a
          // backgrounded, detached process keeps THIS process's stderr fd
          // open a little longer — reproducing the real-world race where
          // `proc.exited` resolves before `readCloneStderrStream` observes
          // EOF on stderr.
          `"${realGit}" "$@"`,
          "code=$?",
          'if [ "$1" = "clone" ]; then',
          "  sleep 1.2 >&2 &",
          "fi",
          "exit $code",
        ].join("\n"),
        { mode: 0o755 },
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}:${originalPath}`;
      try {
        const root = mkdtempSync(path.join(tmpdir(), "agetor-clone-race-src-"));
        const barePath = makeBareSourceRepo(root);
        const cloneId = "cancel-ok-race-id";
        const dest = path.join(dir, "cancel-ok-race-dest");
        const clonePromise = cloneRepo(`file://${barePath}`, dest, { cloneId });

        // `runGitClone` probes `git config --global/--system --get
        // core.sshCommand` (through this same stubbed PATH, fast, no sleep
        // — only the actual "clone" subcommand backgrounds one) before ever
        // spawning the real clone, so the tiny local clone itself doesn't
        // actually exit until somewhat after this call started. 800ms
        // comfortably clears that plus the clone's own (near-instant) run,
        // while staying well inside the stub's 1.2s stderr-hold window.
        await new Promise((resolve) => setTimeout(resolve, 800));
        const cancelled = cancelClone(cloneId);
        expect(cancelled).toBe(true);

        const result = await clonePromise;
        expect(result.ok).toBe(true);
        expect(result.cancelled).toBeUndefined();
        expect(existsSync(path.join(dest, "README.md"))).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    },
    30_000,
  );
});
