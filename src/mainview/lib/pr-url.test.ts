import { describe, expect, test } from "bun:test";
import { canOfferResolveConflicts, parsePrUrl, parsePullNumber } from "./pr-url.ts";
import type { GitHubPullMergeability } from "../../shared/types.ts";

function m(overrides: Partial<GitHubPullMergeability> = {}): GitHubPullMergeability {
  return {
    repo: "o/r",
    pullNumber: 42,
    mergeable: false,
    mergeableState: "dirty",
    rebaseable: false,
    merged: false,
    draft: false,
    state: "open",
    headRef: "feature",
    baseRef: "main",
    headSha: "abc",
    autoMerge: false,
    headRepo: "o/r",
    crossRepo: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePrUrl — accepted shapes
// ---------------------------------------------------------------------------

test("parses a plain github.com PR URL", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/42")).toEqual({ provider: "github", number: 42 });
});

test("parses a self-hosted GitHub-Enterprise-style host with the same path shape", () => {
  expect(parsePrUrl("https://github.mycorp.internal/o/r/pull/42")).toEqual({ provider: "github", number: 42 });
});

test("parses a github PR URL with a trailing path segment", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/42/files")).toEqual({ provider: "github", number: 42 });
});

test("parses a github PR URL with a query string", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/42?diff=unified")).toEqual({ provider: "github", number: 42 });
});

test("parses a github PR URL with a fragment", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/42#discussion_r1")).toEqual({ provider: "github", number: 42 });
});

test("parses a gitlab merge request URL", () => {
  expect(parsePrUrl("https://gitlab.example.com/g/p/-/merge_requests/7")).toEqual({ provider: "gitlab", number: 7 });
});

test("parses a gitlab merge request URL with a nested group path", () => {
  expect(parsePrUrl("https://gitlab.example.com/g/subgroup/p/-/merge_requests/7")).toEqual({
    provider: "gitlab",
    number: 7,
  });
});

test("parses a bitbucket pull request URL", () => {
  expect(parsePrUrl("https://bitbucket.org/w/r/pull-requests/11")).toEqual({ provider: "bitbucket", number: 11 });
});

test("parses a bitbucket pull request URL with a trailing /diff segment", () => {
  expect(parsePrUrl("https://bitbucket.org/w/r/pull-requests/11/diff")).toEqual({
    provider: "bitbucket",
    number: 11,
  });
});

// ---------------------------------------------------------------------------
// parsePrUrl — rejections
// ---------------------------------------------------------------------------

test("rejects null, undefined, and empty string", () => {
  expect(parsePrUrl(null)).toBeNull();
  expect(parsePrUrl(undefined)).toBeNull();
  expect(parsePrUrl("")).toBeNull();
});

test("rejects a non-URL garbage string", () => {
  expect(parsePrUrl("not a url")).toBeNull();
});

test("rejects a GitHub compare/new-PR URL (no PR number in the path)", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/new/branch")).toBeNull();
});

test("rejects a GitHub issue URL", () => {
  expect(parsePrUrl("https://github.com/o/r/issues/42")).toBeNull();
});

test("rejects PR number 0", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/0")).toBeNull();
});

test("rejects a negative PR number", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/-3")).toBeNull();
});

test("rejects a PR number with trailing non-digit characters glued on", () => {
  expect(parsePrUrl("https://github.com/o/r/pull/12abc")).toBeNull();
});

test("rejects a URL whose path doesn't match any known PR/MR shape", () => {
  expect(parsePrUrl("https://github.com/o/r/commits/main")).toBeNull();
});

// ---------------------------------------------------------------------------
// canOfferResolveConflicts — passing case
// ---------------------------------------------------------------------------

test("offers resolve-conflicts when parsed ok, dirty, open, not merged, same-repo, refs non-empty", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m())).toBe(true);
});

// ---------------------------------------------------------------------------
// canOfferResolveConflicts — failing cases
// ---------------------------------------------------------------------------

test("does not offer when the URL failed to parse", () => {
  expect(canOfferResolveConflicts(null, m())).toBe(false);
});

test("does not offer when mergeability is null", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, null)).toBe(false);
});

test("does not offer when mergeableState is clean", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ mergeableState: "clean" }))).toBe(false);
});

test("does not offer when mergeableState is unknown", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ mergeableState: "unknown" }))).toBe(false);
});

test("does not offer when mergeableState is behind", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ mergeableState: "behind" }))).toBe(false);
});

test("does not offer when the PR is already merged", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ merged: true }))).toBe(false);
});

test("does not offer when the PR is cross-repo", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ crossRepo: true }))).toBe(false);
});

test("does not offer when state is closed", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ state: "closed" }))).toBe(false);
});

test("does not offer when state is merged", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ state: "merged" }))).toBe(false);
});

test("does not offer when state is an unrecognized value", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ state: "unknown" }))).toBe(false);
});

test("does not offer when headRef is empty", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ headRef: "" }))).toBe(false);
});

test("does not offer when baseRef is empty", () => {
  expect(canOfferResolveConflicts({ provider: "github", number: 42 }, m({ baseRef: "" }))).toBe(false);
});

// ---------------------------------------------------------------------------
// parsePullNumber (View PR subpage routing)
// ---------------------------------------------------------------------------

describe("parsePullNumber — GitHub", () => {
  test("parses a plain GitHub pull URL", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12")).toBe(12);
  });

  test("tolerates an extra tail segment (.../pull/12/files)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12/files")).toBe(12);
  });

  test("tolerates a trailing slash", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12/")).toBe(12);
  });

  test("tolerates a query string", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12?diff=split")).toBe(12);
  });

  test("tolerates a fragment", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12#discussion_r123")).toBe(12);
  });
});

describe("parsePullNumber — GitLab", () => {
  test("parses a merge_requests URL", () => {
    expect(parsePullNumber("https://gitlab.com/o/r/merge_requests/7")).toBe(7);
  });

  test("parses a merge_requests URL nested under /-/", () => {
    expect(parsePullNumber("https://gitlab.com/o/r/-/merge_requests/7")).toBe(7);
  });
});

describe("parsePullNumber — Bitbucket", () => {
  test("parses a pull-requests URL", () => {
    expect(parsePullNumber("https://bitbucket.org/o/r/pull-requests/3")).toBe(3);
  });
});

describe("parsePullNumber — rejections", () => {
  test("rejects a file: scheme", () => {
    expect(parsePullNumber("file:///pull/12")).toBeNull();
  });

  test("rejects a custom (non-http/https) scheme", () => {
    expect(parsePullNumber("myapp://host/pull/12")).toBeNull();
  });

  test("rejects a malformed URL", () => {
    expect(parsePullNumber("not a url")).toBeNull();
  });

  test("rejects a URL with no marker segment", () => {
    expect(parsePullNumber("https://github.com/o/r/issues/12")).toBeNull();
  });

  test("rejects a marker followed by a non-numeric segment", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/abc")).toBeNull();
  });

  test('rejects exponential notation ("1e3")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/1e3")).toBeNull();
  });

  test('rejects hex notation ("0x10")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0x10")).toBeNull();
  });

  test('rejects decimal notation ("12.0")', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/12.0")).toBeNull();
  });

  test('accepts a leading-zero decimal ("0012") since it is all digits, parsing to 12', () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0012")).toBe(12);
  });

  test("rejects zero (.../pull/0)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull/0")).toBeNull();
  });

  test("rejects the marker as the last path segment (no number follows)", () => {
    expect(parsePullNumber("https://github.com/o/r/pull")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(parsePullNumber("")).toBeNull();
  });

  test("is case-sensitive about the marker segment", () => {
    expect(parsePullNumber("https://github.com/o/r/Pull/12")).toBeNull();
  });
});
