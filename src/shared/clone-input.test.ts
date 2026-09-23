import { describe, expect, test } from "bun:test";
import {
  cloneProviderForHost,
  CLONE_CLOUD_HOST,
  CLONE_INPUT_MAX_LEN,
  CLONE_PROVIDERS,
  CLONE_SUPPORTED_HINT,
  detectCloneProvider,
  isGitProvider,
  isValidCloneHost,
  parseCloneInput,
  type ParsedCloneInput,
} from "./clone-input.ts";
import type { GitProvider } from "./types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function expectOk(input: string, shorthandProvider?: GitProvider): ParsedCloneInput {
  const result = parseCloneInput(input, shorthandProvider);
  if (!result.ok) {
    throw new Error(
      `expected ok for ${JSON.stringify(input)}, got error: "${result.error}" (${result.code})`,
    );
  }
  return result.value;
}

function expectErr(
  input: string,
  shorthandProvider?: GitProvider,
): { ok: false; error: string; code: string } {
  const result = parseCloneInput(input, shorthandProvider);
  if (result.ok) {
    throw new Error(`expected error for ${JSON.stringify(input)}, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// constants / type guard
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("CLONE_PROVIDERS lists exactly github, gitlab, bitbucket in that order", () => {
    expect(CLONE_PROVIDERS).toEqual(["github", "gitlab", "bitbucket"]);
  });

  test("CLONE_CLOUD_HOST maps each provider to its cloud domain", () => {
    expect(CLONE_CLOUD_HOST).toEqual({
      github: "github.com",
      gitlab: "gitlab.com",
      bitbucket: "bitbucket.org",
    });
  });

  test("CLONE_INPUT_MAX_LEN is 2048", () => {
    expect(CLONE_INPUT_MAX_LEN).toBe(2048);
  });

  test("CLONE_SUPPORTED_HINT names all four accepted shapes", () => {
    expect(CLONE_SUPPORTED_HINT).toContain("https://");
    expect(CLONE_SUPPORTED_HINT).toContain("owner/repo");
    expect(CLONE_SUPPORTED_HINT.toLowerCase()).toContain("github");
    expect(CLONE_SUPPORTED_HINT.toLowerCase()).toContain("gitlab");
    expect(CLONE_SUPPORTED_HINT.toLowerCase()).toContain("bitbucket");
  });
});

describe("isGitProvider", () => {
  test("true for each supported provider id", () => {
    expect(isGitProvider("github")).toBe(true);
    expect(isGitProvider("gitlab")).toBe(true);
    expect(isGitProvider("bitbucket")).toBe(true);
  });

  test("false for unsupported strings", () => {
    for (const v of ["Github", "GITLAB", "bitbucket ", " github", "gogs", "gitea", ""]) {
      expect(isGitProvider(v)).toBe(false);
    }
  });

  test("false for non-string values", () => {
    for (const v of [null, undefined, 123, {}, ["github"], true, Symbol("x")]) {
      expect(isGitProvider(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// https form
// ---------------------------------------------------------------------------

describe("parseCloneInput — https form", () => {
  test("plain github https", () => {
    const v = expectOk("https://github.com/owner/repo");
    expect(v).toEqual({
      provider: "github",
      form: "https",
      transport: "https",
      scheme: "https",
      rawHost: "github.com",
      port: null,
      user: null,
      segments: ["owner", "repo"],
      fullPath: "owner/repo",
      repo: "repo",
    });
  });

  test("strips a trailing .git suffix", () => {
    const v = expectOk("https://github.com/owner/repo.git");
    expect(v.segments).toEqual(["owner", "repo"]);
    expect(v.repo).toBe("repo");
  });

  test("trailing .git is case-insensitive", () => {
    const v = expectOk("https://github.com/owner/repo.GIT");
    expect(v.repo).toBe("repo");
  });

  test("trailing slash after repo is tolerated", () => {
    const v = expectOk("https://github.com/owner/repo/");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("plain http:// scheme is accepted and recorded", () => {
    const v = expectOk("http://github.com/owner/repo");
    expect(v.scheme).toBe("http");
    expect(v.transport).toBe("https");
  });

  test("leading www. is stripped for https form", () => {
    const v = expectOk("https://www.github.com/owner/repo");
    expect(v.rawHost).toBe("github.com");
  });

  test("query string is dropped from the path", () => {
    const v = expectOk("https://github.com/owner/repo?foo=1&bar=2");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("hash fragment is dropped from the path", () => {
    const v = expectOk("https://github.com/owner/repo#readme");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("query and hash together are both dropped", () => {
    const v = expectOk("https://github.com/owner/repo.git?foo=1#bar");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("uppercase host is lowercased", () => {
    const v = expectOk("https://GitHub.COM/owner/repo");
    expect(v.rawHost).toBe("github.com");
    expect(v.provider).toBe("github");
  });

  test("port is captured", () => {
    const v = expectOk("https://gitlab.com:8443/owner/repo");
    expect(v.port).toBe("8443");
    expect(v.provider).toBe("gitlab");
  });

  test("trailing FQDN dot on the host is stripped", () => {
    const v = expectOk("https://github.com./owner/repo");
    expect(v.rawHost).toBe("github.com");
  });

  test("bitbucket https", () => {
    const v = expectOk("https://bitbucket.org/owner/repo");
    expect(v.provider).toBe("bitbucket");
    expect(v.transport).toBe("https");
    expect(v.form).toBe("https");
  });

  test("gitlab https", () => {
    const v = expectOk("https://gitlab.com/owner/repo");
    expect(v.provider).toBe("gitlab");
  });
});

// ---------------------------------------------------------------------------
// scp form
// ---------------------------------------------------------------------------

describe("parseCloneInput — scp form", () => {
  test("standard git@host:owner/repo.git", () => {
    const v = expectOk("git@github.com:owner/repo.git");
    expect(v).toEqual({
      provider: "github",
      form: "scp",
      transport: "ssh",
      scheme: null,
      rawHost: "github.com",
      port: null,
      user: "git",
      segments: ["owner", "repo"],
      fullPath: "owner/repo",
      repo: "repo",
    });
  });

  test("no user — bare host:path", () => {
    const v = expectOk("github.com:owner/repo.git");
    expect(v.user).toBeNull();
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("custom user", () => {
    const v = expectOk("alice@gitlab.com:group/repo.git");
    expect(v.user).toBe("alice");
    expect(v.provider).toBe("gitlab");
  });

  test("absolute remote path (single leading slash after colon)", () => {
    const v = expectOk("git@github.com:/owner/repo.git");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("scp form never carries a port", () => {
    const v = expectOk("git@bitbucket.org:owner/repo.git");
    expect(v.port).toBeNull();
    expect(v.transport).toBe("ssh");
  });
});

// ---------------------------------------------------------------------------
// ssh-url form
// ---------------------------------------------------------------------------

describe("parseCloneInput — ssh-url form", () => {
  test("with user, no port", () => {
    const v = expectOk("ssh://git@github.com/owner/repo.git");
    expect(v).toEqual({
      provider: "github",
      form: "ssh-url",
      transport: "ssh",
      scheme: null,
      rawHost: "github.com",
      port: null,
      user: "git",
      segments: ["owner", "repo"],
      fullPath: "owner/repo",
      repo: "repo",
    });
  });

  test("without user or port", () => {
    const v = expectOk("ssh://gitlab.com/group/project.git");
    expect(v.user).toBeNull();
    expect(v.port).toBeNull();
    expect(v.provider).toBe("gitlab");
    expect(v.segments).toEqual(["group", "project"]);
  });

  test("with user and port", () => {
    const v = expectOk("ssh://git@github.com:2222/owner/repo.git");
    expect(v.user).toBe("git");
    expect(v.port).toBe("2222");
    expect(v.segments).toEqual(["owner", "repo"]);
  });

  test("bitbucket ssh-url", () => {
    const v = expectOk("ssh://git@bitbucket.org/owner/repo.git");
    expect(v.provider).toBe("bitbucket");
    expect(v.transport).toBe("ssh");
  });
});

// ---------------------------------------------------------------------------
// shorthand form
// ---------------------------------------------------------------------------

describe("parseCloneInput — shorthand form", () => {
  test("defaults to github when no provider given", () => {
    const v = expectOk("owner/repo");
    expect(v).toEqual({
      provider: "github",
      form: "shorthand",
      transport: "https",
      scheme: null,
      rawHost: null,
      port: null,
      user: null,
      segments: ["owner", "repo"],
      fullPath: "owner/repo",
      repo: "repo",
    });
  });

  test("explicit gitlab provider", () => {
    const v = expectOk("owner/repo", "gitlab");
    expect(v.provider).toBe("gitlab");
  });

  test("explicit bitbucket provider", () => {
    const v = expectOk("owner/repo", "bitbucket");
    expect(v.provider).toBe("bitbucket");
  });

  test("explicit github provider (redundant with default, still honored)", () => {
    const v = expectOk("owner/repo", "github");
    expect(v.provider).toBe("github");
  });

  test("shorthand carries no host, port, user or scheme regardless of provider", () => {
    for (const provider of CLONE_PROVIDERS) {
      const v = expectOk("owner/repo", provider);
      expect(v.rawHost).toBeNull();
      expect(v.port).toBeNull();
      expect(v.user).toBeNull();
      expect(v.scheme).toBeNull();
      expect(v.transport).toBe("https");
    }
  });
});

// ---------------------------------------------------------------------------
// deep-link trimming (https form only)
// ---------------------------------------------------------------------------

describe("parseCloneInput — deep links (https only)", () => {
  test("github tree/main/src deep link resolves to the repo", () => {
    const v = expectOk("https://github.com/owner/repo/tree/main/src");
    expect(v.segments).toEqual(["owner", "repo"]);
    expect(v.fullPath).toBe("owner/repo");
  });

  test("bitbucket /src/main/x deep link resolves to the repo", () => {
    const v = expectOk("https://bitbucket.org/proj/repo/src/main/x");
    expect(v.segments).toEqual(["proj", "repo"]);
  });

  test("bitbucket leading scm marker is dropped before the 2-segment cut", () => {
    const v = expectOk("https://bitbucket.org/scm/proj/repo.git");
    expect(v.segments).toEqual(["proj", "repo"]);
  });

  test("bitbucket server scm + deep path", () => {
    const v = expectOk("https://bitbucket.company.com/scm/proj/repo/browse/x");
    expect(v.segments).toEqual(["proj", "repo"]);
    expect(v.provider).toBe("bitbucket");
  });

  test("gitlab /-/tree/main deep link cuts at the dash separator", () => {
    const v = expectOk("https://gitlab.com/group/project/-/tree/main");
    expect(v.segments).toEqual(["group", "project"]);
  });

  const reservedWords = ["tree", "blob", "raw", "commits", "blame", "wikis"];
  for (const word of reservedWords) {
    test(`gitlab reserved word "${word}" at index >= 2 cuts the path`, () => {
      const v = expectOk(`https://gitlab.com/group/project/${word}/extra`);
      expect(v.segments).toEqual(["group", "project"]);
    });
  }

  test("gitlab reserved word at index < 2 is NOT treated as reserved", () => {
    // "blob" sits in the group/project position (indices 0-1), so it's a
    // literal path segment, not the reserved page-view marker — the
    // cutting loop only inspects index >= 2.
    const v = expectOk("https://gitlab.com/blob/main/extra");
    expect(v.segments).toEqual(["blob", "main", "extra"]);
    expect(v.repo).toBe("extra");
  });

  test("github deep link with no reserved structure still cuts to 2 segments", () => {
    const v = expectOk("https://github.com/owner/repo/pull/42");
    expect(v.segments).toEqual(["owner", "repo"]);
  });
});

// ---------------------------------------------------------------------------
// scp / ssh-url are NOT deep-link-trimmed
// ---------------------------------------------------------------------------

describe("parseCloneInput — scp/ssh-url paths are never deep-link-trimmed", () => {
  test("gitlab scp form keeps a literal 'tree' segment verbatim", () => {
    const v = expectOk("git@gitlab.com:group/tree/project.git");
    expect(v.segments).toEqual(["group", "tree", "project"]);
    expect(v.fullPath).toBe("group/tree/project");
  });

  test("gitlab ssh-url form keeps nested groups verbatim, no cut", () => {
    const v = expectOk("ssh://git@gitlab.com/group/sub/project.git");
    expect(v.segments).toEqual(["group", "sub", "project"]);
  });

  test("github scp form with more than 2 segments is invalid, not truncated", () => {
    const r = expectErr("git@github.com:2222/owner/repo");
    expect(r.code).toBe("invalid");
  });

  test("github ssh-url form with more than 2 segments is invalid, not truncated", () => {
    const r = expectErr("ssh://git@github.com/2222/owner/repo");
    expect(r.code).toBe("invalid");
  });

  test("bitbucket scp form with more than 2 segments is invalid", () => {
    const r = expectErr("git@bitbucket.org:2222/owner/repo");
    expect(r.code).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// GitLab nested groups across every form
// ---------------------------------------------------------------------------

describe("parseCloneInput — GitLab nested groups (all forms)", () => {
  test("https form keeps nested groups when there's no dash/reserved cut", () => {
    const v = expectOk("https://gitlab.com/group/sub/project");
    expect(v.segments).toEqual(["group", "sub", "project"]);
    expect(v.repo).toBe("project");
  });

  test("shorthand form keeps nested groups", () => {
    const v = expectOk("group/sub/project", "gitlab");
    expect(v.segments).toEqual(["group", "sub", "project"]);
  });

  test("scp form keeps nested groups", () => {
    const v = expectOk("git@gitlab.com:group/sub/project.git");
    expect(v.segments).toEqual(["group", "sub", "project"]);
  });

  test("ssh-url form keeps nested groups", () => {
    const v = expectOk("ssh://git@gitlab.com/group/sub/project.git");
    expect(v.segments).toEqual(["group", "sub", "project"]);
  });
});

describe("parseCloneInput — github/bitbucket shorthand rejects more than 2 segments", () => {
  test("github shorthand with 3 segments is invalid", () => {
    const r = expectErr("owner/middle/repo", "github");
    expect(r.code).toBe("invalid");
  });

  test("bitbucket shorthand with 3 segments is invalid", () => {
    const r = expectErr("owner/middle/repo", "bitbucket");
    expect(r.code).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// ssh aliases (per-identity ~/.ssh/config Host entries)
// ---------------------------------------------------------------------------

describe("parseCloneInput — ssh aliases resolve by substring", () => {
  test("gitlab-work alias", () => {
    const v = expectOk("git@gitlab-work:group/app.git");
    expect(v.provider).toBe("gitlab");
    expect(v.rawHost).toBe("gitlab-work");
  });

  test("github-work.com alias", () => {
    const v = expectOk("git@github-work.com:o/r.git");
    expect(v.provider).toBe("github");
  });

  test("bitbucket-x.org alias", () => {
    const v = expectOk("git@bitbucket-x.org:proj/repo.git");
    expect(v.provider).toBe("bitbucket");
  });
});

// ---------------------------------------------------------------------------
// self-hosted
// ---------------------------------------------------------------------------

describe("parseCloneInput — self-hosted instances", () => {
  test("self-hosted gitlab with a custom port", () => {
    const v = expectOk("https://gitlab.mycompany.com:8443/team/app.git");
    expect(v.provider).toBe("gitlab");
    expect(v.rawHost).toBe("gitlab.mycompany.com");
    expect(v.port).toBe("8443");
    expect(v.segments).toEqual(["team", "app"]);
  });

  test("bitbucket server ssh-url shape (no scm segment)", () => {
    const v = expectOk("ssh://git@bitbucket.company.com:7999/proj/repo.git");
    expect(v.provider).toBe("bitbucket");
    expect(v.port).toBe("7999");
    expect(v.segments).toEqual(["proj", "repo"]);
  });

  test("bitbucket server https shape (with scm segment)", () => {
    const v = expectOk("https://bitbucket.company.com/scm/proj/repo.git");
    expect(v.provider).toBe("bitbucket");
    expect(v.segments).toEqual(["proj", "repo"]);
  });
});

// ---------------------------------------------------------------------------
// security: credentials, host spoofing, injection-shaped input
// ---------------------------------------------------------------------------

describe("parseCloneInput — security", () => {
  test("https userinfo (user:password) is discarded, never stored or echoed", () => {
    const result = parseCloneInput("https://user:secret@github.com/o/r");
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user:secret");
    if (result.ok) {
      expect(result.value.rawHost).toBe("github.com");
      expect(result.value.user).toBeNull();
    }
  });

  test("https userinfo on an unsupported host is discarded from the error too", () => {
    const result = parseCloneInput("https://admin:hunter2@evil.example.com/o/r");
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("admin:hunter2");
    if (!result.ok) {
      expect(result.code).toBe("unsupported-host");
      expect(result.error).toContain("evil.example.com");
    }
  });

  test("a fake provider-name-as-userinfo doesn't spoof host detection", () => {
    // "gitlab.com" here is USERINFO (before the last @), not the host — the
    // real host is "evil.example.com" and must be what's reported.
    const result = parseCloneInput("https://gitlab.com@evil.example.com/o/r");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported-host");
      expect(result.error).toContain("evil.example.com");
      expect(result.error).not.toContain("gitlab.com@");
    }
  });

  test("leading-dash shorthand owner segment is rejected", () => {
    expect(expectErr("-flag/repo").code).toBe("invalid");
  });

  test("leading-dash shorthand repo segment is rejected", () => {
    expect(expectErr("owner/-repo").code).toBe("invalid");
  });

  test("leading-dash scp host (option-injection shaped) is rejected", () => {
    const r = expectErr("git@-oProxyCommand=x:o/r");
    expect(r.code).toBe("invalid");
  });

  test("leading-dash ssh-url host (option-injection shaped) is rejected", () => {
    const r = expectErr("ssh://-oProxyCommand=x/o/r");
    expect(r.code).toBe("invalid");
  });

  test("leading-dash scp user is rejected", () => {
    const r = expectErr("-x@github.com:o/r");
    expect(r.code).toBe("invalid");
  });

  test("'.' and '..' path segments are rejected", () => {
    expect(expectErr("owner/..").code).toBe("invalid");
    expect(expectErr("owner/.").code).toBe("invalid");
  });

  test("a literal newline inside the input is never bridged into a valid parse", () => {
    const result = parseCloneInput("owner/repo\nrm -rf /");
    expect(result.ok).toBe(false);
  });

  test("a literal space inside a shorthand segment is rejected", () => {
    const result = parseCloneInput("owner/repo extra");
    expect(result.ok).toBe(false);
  });

  test("a literal %0a sequence in a path segment is rejected as an invalid segment", () => {
    const result = parseCloneInput("https://github.com/owner/repo%0ax");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid");
  });

  test("ext:: git transport (command-injection shaped) never resolves to a supported host", () => {
    const result = parseCloneInput("ext::sh -c touch /tmp/pwned");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Whatever shape this is classified as, it must never come back "ok" —
      // the ext:: transport must not be treated as a legitimate clone host.
      expect(["unsupported-host", "unrecognized", "invalid"]).toContain(result.code);
    }
  });

  test(".github as a repo name is accepted", () => {
    const v = expectOk("https://github.com/owner/.github");
    expect(v.repo).toBe(".github");
  });

  test("a repo that is only '.git' is rejected (empty after stripping)", () => {
    const r = expectErr("https://github.com/owner/.git");
    expect(r.code).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

describe("parseCloneInput — port validation", () => {
  test("port 0 is invalid", () => {
    expect(expectErr("https://github.com:0/owner/repo").code).toBe("invalid");
  });

  test("port 99999 is invalid (out of range)", () => {
    expect(expectErr("https://github.com:99999/owner/repo").code).toBe("invalid");
  });

  test("port 0080 is invalid (leading zero)", () => {
    expect(expectErr("https://github.com:0080/owner/repo").code).toBe("invalid");
  });

  test("port 65535 is valid (upper bound)", () => {
    const v = expectOk("https://github.com:65535/owner/repo");
    expect(v.port).toBe("65535");
  });

  test("port 1 is valid (lower bound)", () => {
    const v = expectOk("https://github.com:1/owner/repo");
    expect(v.port).toBe("1");
  });

  test("port validation also applies to ssh-url form", () => {
    expect(expectErr("ssh://git@github.com:0/owner/repo").code).toBe("invalid");
    const v = expectOk("ssh://git@github.com:65535/owner/repo");
    expect(v.port).toBe("65535");
  });
});

// ---------------------------------------------------------------------------
// error codes
// ---------------------------------------------------------------------------

describe("parseCloneInput — error codes", () => {
  test("empty / whitespace-only input", () => {
    for (const input of ["", "   ", "\t\n"]) {
      const r = expectErr(input);
      expect(r.code).toBe("empty");
    }
  });

  test("unrecognized: plain word with no path separator", () => {
    expect(expectErr("garbage").code).toBe("unrecognized");
  });

  test("unrecognized: empty segment between slashes", () => {
    expect(expectErr("o//r").code).toBe("unrecognized");
  });

  test("unrecognized: scp host followed by a URL-shaped '//' path", () => {
    expect(expectErr("git@gitlab.com://g/p").code).toBe("unrecognized");
  });

  test("unsupported-host: https URL to an unrecognized host", () => {
    const r = expectErr("https://example.com/o/r");
    expect(r.code).toBe("unsupported-host");
    expect(r.error).toContain("example.com");
    expect(r.error).toContain(CLONE_SUPPORTED_HINT);
  });

  test("unsupported-host: scp form to an unrecognized host", () => {
    const r = expectErr("git@example.com:o/r");
    expect(r.code).toBe("unsupported-host");
    expect(r.error).toContain("example.com");
    expect(r.error).toContain(CLONE_SUPPORTED_HINT);
  });

  test("unrecognized error message also carries the supported-shapes hint", () => {
    const r = expectErr("garbage");
    expect(r.error).toContain(CLONE_SUPPORTED_HINT);
  });

  test("invalid: malformed path, malformed port, malformed host, over-length input all classify as invalid", () => {
    expect(expectErr("https://github.com/owner/..").code).toBe("invalid");
    expect(expectErr("https://github.com:0/owner/repo").code).toBe("invalid");
    expect(expectErr("git@-oProxyCommand=x:o/r").code).toBe("invalid");
    const overlong = "https://github.com/owner/" + "a".repeat(CLONE_INPUT_MAX_LEN);
    expect(expectErr(overlong).code).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// length cap
// ---------------------------------------------------------------------------

describe("parseCloneInput — CLONE_INPUT_MAX_LEN boundary", () => {
  const prefix = "https://github.com/owner/";

  test("exactly CLONE_INPUT_MAX_LEN chars still parses normally", () => {
    const padLen = CLONE_INPUT_MAX_LEN - prefix.length;
    const input = prefix + "a".repeat(padLen);
    expect(input.length).toBe(CLONE_INPUT_MAX_LEN);
    const v = expectOk(input);
    expect(v.provider).toBe("github");
  });

  test("one character over CLONE_INPUT_MAX_LEN is rejected as invalid, before any parsing", () => {
    const padLen = CLONE_INPUT_MAX_LEN - prefix.length + 1;
    const input = prefix + "a".repeat(padLen);
    expect(input.length).toBe(CLONE_INPUT_MAX_LEN + 1);
    const r = expectErr(input);
    expect(r.code).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// performance regression — no catastrophic backtracking
// ---------------------------------------------------------------------------

describe("performance — pathological 'a/'-repeated input completes quickly", () => {
  // Regression coverage for the fixed SHORTHAND_RE: the old pattern let a
  // segment and the `/` separator share an overlapping charset, so an input
  // with no closing match (ending in "a@", which can never complete a
  // shorthand segment because "@" is excluded from the charset) forced the
  // engine to try every possible way of partitioning the string on "/"
  // before giving up — ~470ms on a 30-repetition input with the old regex.
  // The fixed, disjoint-charset regex is linear regardless of shape. The
  // bound below (100ms) is deliberately generous so a loaded CI box can't
  // flake on it while still being far below the old pathological cost.
  const PERF_BOUND_MS = 100;

  for (const n of [30, 1000]) {
    test(`parseCloneInput on "a/".repeat(${n}) + "a@" completes in well under ${PERF_BOUND_MS}ms`, () => {
      const input = "a/".repeat(n) + "a@";
      const start = Date.now();
      const result = parseCloneInput(input);
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      expect(elapsed).toBeLessThan(PERF_BOUND_MS);
    });

    test(`detectCloneProvider on "a/".repeat(${n}) + "a@" completes in well under ${PERF_BOUND_MS}ms`, () => {
      const input = "a/".repeat(n) + "a@";
      const start = Date.now();
      const result = detectCloneProvider(input);
      const elapsed = Date.now() - start;
      expect(result).toBeNull();
      expect(elapsed).toBeLessThan(PERF_BOUND_MS);
    });
  }
});

// ---------------------------------------------------------------------------
// detectCloneProvider
// ---------------------------------------------------------------------------

describe("detectCloneProvider", () => {
  test("full https URLs for every provider", () => {
    expect(detectCloneProvider("https://github.com/owner/repo")).toBe("github");
    expect(detectCloneProvider("https://gitlab.com/owner/repo")).toBe("gitlab");
    expect(detectCloneProvider("https://bitbucket.org/owner/repo")).toBe("bitbucket");
  });

  test("full scp inputs for every provider", () => {
    expect(detectCloneProvider("git@github.com:owner/repo.git")).toBe("github");
    expect(detectCloneProvider("git@gitlab.com:owner/repo.git")).toBe("gitlab");
    expect(detectCloneProvider("git@bitbucket.org:owner/repo.git")).toBe("bitbucket");
  });

  test("full ssh-url inputs for every provider", () => {
    expect(detectCloneProvider("ssh://git@github.com/owner/repo.git")).toBe("github");
    expect(detectCloneProvider("ssh://git@gitlab.com/owner/repo.git")).toBe("gitlab");
    expect(detectCloneProvider("ssh://git@bitbucket.org/owner/repo.git")).toBe("bitbucket");
  });

  test("incomplete/mid-paste https path still resolves from the host alone", () => {
    expect(detectCloneProvider("https://gitlab.com/")).toBe("gitlab");
  });

  test("incomplete/mid-paste scp path (trailing colon, no path) still resolves", () => {
    expect(detectCloneProvider("git@bitbucket.org:")).toBe("bitbucket");
  });

  test("ssh aliases resolve by substring", () => {
    expect(detectCloneProvider("git@gitlab-work:group/app.git")).toBe("gitlab");
    expect(detectCloneProvider("git@github-work.com:o/r.git")).toBe("github");
    expect(detectCloneProvider("git@bitbucket-x.org:proj/repo.git")).toBe("bitbucket");
  });

  test("shorthand input returns null (no host to detect from)", () => {
    expect(detectCloneProvider("owner/repo")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(detectCloneProvider("")).toBeNull();
    expect(detectCloneProvider("   ")).toBeNull();
  });

  test("unsupported host returns null", () => {
    expect(detectCloneProvider("https://example.com/o/r")).toBeNull();
    expect(detectCloneProvider("git@example.com:o/r")).toBeNull();
  });

  test("unparseable input returns null", () => {
    expect(detectCloneProvider("garbage")).toBeNull();
    expect(detectCloneProvider("o//r")).toBeNull();
  });

  test("input over CLONE_INPUT_MAX_LEN returns null", () => {
    const overlong = "https://github.com/owner/" + "a".repeat(CLONE_INPUT_MAX_LEN);
    expect(detectCloneProvider(overlong)).toBeNull();
  });

  test("uppercase host is detected case-insensitively", () => {
    expect(detectCloneProvider("https://GITHUB.com/owner/repo")).toBe("github");
    expect(detectCloneProvider("HTTPS://GitLab.COM/owner/repo")).toBe("gitlab");
  });
});

// ---------------------------------------------------------------------------
// exported host helpers (isValidCloneHost / cloneProviderForHost)
// ---------------------------------------------------------------------------

describe("isValidCloneHost", () => {
  test("true for ordinary hosts", () => {
    expect(isValidCloneHost("github.com")).toBe(true);
    expect(isValidCloneHost("gitlab.mycompany.com")).toBe(true);
    expect(isValidCloneHost("gitlab-work")).toBe(true);
    expect(isValidCloneHost("a")).toBe(true);
  });

  test("false for a leading dash or dot, a trailing dot, or a disallowed character", () => {
    expect(isValidCloneHost("-oProxyCommand=x")).toBe(false);
    expect(isValidCloneHost(".github.com")).toBe(false);
    expect(isValidCloneHost("github.com.")).toBe(false);
    expect(isValidCloneHost("git_hub.com")).toBe(false);
    expect(isValidCloneHost("")).toBe(false);
  });
});

describe("cloneProviderForHost", () => {
  test("substring match for each provider, checked GitHub then GitLab then Bitbucket", () => {
    expect(cloneProviderForHost("github.com")).toBe("github");
    expect(cloneProviderForHost("gitlab.com")).toBe("gitlab");
    expect(cloneProviderForHost("bitbucket.org")).toBe("bitbucket");
    expect(cloneProviderForHost("gitlab-work")).toBe("gitlab");
    expect(cloneProviderForHost("github-work.internal.example.com")).toBe("github");
  });

  test("case-insensitive", () => {
    expect(cloneProviderForHost("GitHub.COM")).toBe("github");
  });

  test("null for a host naming no supported provider", () => {
    expect(cloneProviderForHost("example.com")).toBeNull();
    expect(cloneProviderForHost("gogs.example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ssh userinfo password is dropped, never validated, never echoed
// ---------------------------------------------------------------------------

describe("parseCloneInput — ssh userinfo password is dropped", () => {
  test("ssh-url: user:password parses ok with the password silently dropped", () => {
    const v = expectOk("ssh://oauth2:s3cr3t-token@gitlab.com/g/p.git");
    expect(v.user).toBe("oauth2");
    expect(v.provider).toBe("gitlab");
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("s3cr3t-token");
  });

  test("scp: user:password parses ok with the password silently dropped", () => {
    const v = expectOk("oauth2:s3cr3t-token@gitlab.com:g/p.git");
    expect(v.user).toBe("oauth2");
    expect(v.provider).toBe("gitlab");
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("s3cr3t-token");
  });

  test("an invalid user (password present) is reported with no value interpolated", () => {
    const r = expectErr("ssh://-x:s3cr3t-token@github.com/o/r");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("invalid ssh user in the URL");
    expect(r.error).not.toContain("s3cr3t-token");
    expect(r.error).not.toContain("-x");
  });

  test("an invalid scp user (password present) is reported with no value interpolated", () => {
    const r = expectErr("-x:s3cr3t-token@github.com:o/r");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("invalid ssh user in the URL");
    expect(r.error).not.toContain("s3cr3t-token");
    expect(r.error).not.toContain("-x");
  });

  test("a user with no password is unaffected (no colon to split on)", () => {
    const v = expectOk("ssh://git@github.com/o/r");
    expect(v.user).toBe("git");
  });

  test("https userinfo (already covered) is unaffected by the ssh-user split", () => {
    const v = expectOk("https://user:pass@github.com/o/r");
    expect(v.user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// no path typed yet reports "invalid", never "unsupported-host"
// ---------------------------------------------------------------------------

describe("parseCloneInput — no path typed yet is 'invalid', not 'unsupported-host'", () => {
  test("https host fragment with no path at all (unsupported host)", () => {
    const r = expectErr("https://gith");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("repository path required");
  });

  test("https full unsupported host, no path, no trailing slash", () => {
    const r = expectErr("https://example.com");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("repository path required");
  });

  test("https full unsupported host, trailing slash, no path", () => {
    const r = expectErr("https://example.com/");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("repository path required");
  });

  test("scp unsupported host with a trailing colon and no path", () => {
    const r = expectErr("git@example.com:");
    expect(r.code).toBe("invalid");
    expect(r.error).toBe("repository path required");
  });

  test("the same 'no path yet' shapes against a SUPPORTED host are equally 'invalid'", () => {
    for (const input of ["https://github.com", "https://github.com/", "git@github.com:", "ssh://git@github.com"]) {
      const r = expectErr(input);
      expect(r.code).toBe("invalid");
      expect(r.error).toBe("repository path required");
    }
  });

  test("once a path segment exists, an unsupported host reports 'unsupported-host' as before", () => {
    const r = expectErr("https://gith/o");
    expect(r.code).toBe("unsupported-host");
  });

  test("keystroke progression: every prefix of a full github https URL never reports 'unsupported-host'", () => {
    const full = "https://github.com/owner/repo";
    for (let i = 1; i <= full.length; i++) {
      const prefix = full.slice(0, i);
      const result = parseCloneInput(prefix);
      if (!result.ok) expect(result.code).not.toBe("unsupported-host");
    }
  });

  test("keystroke progression: every prefix of a full gitlab scp URL never reports 'unsupported-host'", () => {
    const full = "git@gitlab.com:group/project.git";
    for (let i = 1; i <= full.length; i++) {
      const prefix = full.slice(0, i);
      const result = parseCloneInput(prefix);
      if (!result.ok) expect(result.code).not.toBe("unsupported-host");
    }
  });

  test("keystroke progression against an UNSUPPORTED host only flips to 'unsupported-host' once a path segment exists", () => {
    // Typing "https://example.com/o" one character at a time: every prefix
    // before the first non-empty path segment must be "invalid" (mid-typing
    // neutral), never "unsupported-host" — the flip happens only once a `/`
    // is followed by at least one path character.
    const full = "https://example.com/o";
    let sawUnsupported = false;
    for (let i = 1; i <= full.length; i++) {
      const prefix = full.slice(0, i);
      const result = parseCloneInput(prefix);
      if (!result.ok && result.code === "unsupported-host") sawUnsupported = true;
      if (!result.ok && !sawUnsupported) expect(result.code).not.toBe("unsupported-host");
    }
    expect(sawUnsupported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// property-style: a secret in the userinfo/password position never leaks,
// across every form and every reachable error code (plus the ok path).
// ---------------------------------------------------------------------------

describe("parseCloneInput — userinfo/password never leaks (property-style)", () => {
  const SECRET = "s3cr3t-t0ken-9f8e7d";

  function assertNoLeak(input: string, expectedCode?: CloneInputErrorCodeLike) {
    const result = parseCloneInput(input);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    if (expectedCode === "ok") {
      expect(result.ok).toBe(true);
    } else if (expectedCode && !result.ok) {
      expect(result.code).toBe(expectedCode);
    }
    return result;
  }

  type CloneInputErrorCodeLike = "ok" | "empty" | "unrecognized" | "unsupported-host" | "invalid";

  test("https — ok, unsupported-host, invalid (bad path), unrecognized (malformed authority)", () => {
    assertNoLeak(`https://user:${SECRET}@github.com/o/r`, "ok");
    assertNoLeak(`https://user:${SECRET}@evil.example.com/o/r`, "unsupported-host");
    assertNoLeak(`https://user:${SECRET}@github.com/owner/..`, "invalid");
    assertNoLeak(`https://user:${SECRET}@host:1:2/o/r`, "unrecognized");
  });

  test("ssh-url — ok, unsupported-host, invalid (bad user), invalid (too many segments), unrecognized", () => {
    assertNoLeak(`ssh://user:${SECRET}@github.com/o/r`, "ok");
    assertNoLeak(`ssh://user:${SECRET}@evil.example.com/o/r`, "unsupported-host");
    assertNoLeak(`ssh://-x:${SECRET}@github.com/o/r`, "invalid");
    assertNoLeak(`ssh://user:${SECRET}@github.com/owner/middle/repo`, "invalid");
    assertNoLeak(`ssh://user:${SECRET}@host:1:2/o/r`, "unrecognized");
  });

  test("scp — ok, unsupported-host, invalid (bad user), invalid (too many segments), unrecognized", () => {
    assertNoLeak(`user:${SECRET}@github.com:o/r`, "ok");
    assertNoLeak(`user:${SECRET}@evil.example.com:o/r`, "unsupported-host");
    assertNoLeak(`-x:${SECRET}@github.com:o/r`, "invalid");
    assertNoLeak(`user:${SECRET}@github.com:owner/middle/repo`, "invalid");
    assertNoLeak(`user:${SECRET}@mailto:x`, "unrecognized");
  });

  test("a stray second '@' after the authority (malformed) never leaks either", () => {
    // `ssh://a@github:SECRET@evil.com/o/r` would, without the
    // stray-second-`@` guard in `parseAuthorityAndPath`, misattribute
    // "SECRET@evil.com" into the `port` field and echo it via "invalid port
    // \"…\"". The guard rejects the whole authority instead (unrecognized).
    const r = assertNoLeak(`ssh://a@github:${SECRET}@evil.com/o/r`, "unrecognized");
    expect(r.ok).toBe(false);
  });
});
