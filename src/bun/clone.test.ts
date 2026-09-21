import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  cloneAuthEnv,
  cloneAuthHeader,
  cloneRepo,
  defaultCloneDest,
  explainCloneFailure,
  isAuthShapedCloneFailure,
  pickCloneDisplayLine,
  resolveCloneRepo,
  sanitizeCloneStderr,
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
});
