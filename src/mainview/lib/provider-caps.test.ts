import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPS } from "../../shared/types.ts";
import {
  displayCaps,
  itemProvider,
  providerForTarget,
  providerSupports,
  providerTargetKey,
  type ProviderCapFlag,
} from "./provider-caps.ts";

/** Flags whose fetches hit GitHub-only backend routes (`/github/repo-permissions`,
 *  `/github/milestones`, `/github/assignees`, `/github/releases`,
 *  `/github/pull-commits`, `/github/pull-linked-issues`,
 *  `/github/pull-review-threads`, `/github/commit-status`). */
const GITHUB_ONLY_FETCH_FLAGS: ProviderCapFlag[] = [
  "repoPermissions",
  "milestones",
  "assigneeList",
  "releases",
  "pullCommits",
  "linkedIssues",
  "reviewThreads",
  "commitStatusPanel",
];

describe("providerSupports", () => {
  test("GitHub supports every GitHub-only fetch", () => {
    for (const flag of GITHUB_ONLY_FETCH_FLAGS) expect(providerSupports("github", flag)).toBe(true);
  });

  test("GitLab and Bitbucket never issue GitHub-only fetches", () => {
    for (const provider of ["gitlab", "bitbucket"] as const) {
      for (const flag of GITHUB_ONLY_FETCH_FLAGS) expect(providerSupports(provider, flag)).toBe(false);
    }
  });

  test("an unresolved or mixed provider never fetches, even for flags GitHub supports", () => {
    for (const provider of [null, undefined, "mixed"] as const) {
      for (const flag of GITHUB_ONLY_FETCH_FLAGS) expect(providerSupports(provider, flag)).toBe(false);
    }
  });

  test("follows PROVIDER_CAPS for provider-aware flags", () => {
    expect(providerSupports("gitlab", "labels")).toBe(true);
    expect(providerSupports("bitbucket", "labels")).toBe(false);
    expect(providerSupports("gitlab", "checks")).toBe(PROVIDER_CAPS.gitlab.checks);
  });
});

describe("displayCaps", () => {
  test("defaults to GitHub while unresolved or mixed", () => {
    expect(displayCaps(null)).toBe(PROVIDER_CAPS.github);
    expect(displayCaps("mixed")).toBe(PROVIDER_CAPS.github);
  });

  test("uses the resolved provider's caps", () => {
    expect(displayCaps("gitlab")).toBe(PROVIDER_CAPS.gitlab);
    expect(displayCaps("bitbucket")).toBe(PROVIDER_CAPS.bitbucket);
  });
});

describe("itemProvider", () => {
  test("single-repo mode uses the dialog provider", () => {
    expect(itemProvider("gitlab", false, "github")).toBe("gitlab");
    expect(itemProvider(null, false, undefined)).toBeNull();
  });

  test("aggregate mode uses the item's own repo provider", () => {
    expect(itemProvider("mixed", true, "gitlab")).toBe("gitlab");
    expect(itemProvider("mixed", true, "github")).toBe("github");
    expect(itemProvider("mixed", true, undefined)).toBeNull();
    expect(itemProvider("mixed", true, null)).toBeNull();
  });
});

describe("providerForTarget", () => {
  const githubKey = providerTargetKey("/repos/hub", "");
  const gitlabKey = providerTargetKey("/repos/lab", "");

  test("nothing resolved yet reads as unresolved", () => {
    expect(providerForTarget(null, githubKey)).toEqual({ provider: null, settled: false });
  });

  test("a result for the current target applies", () => {
    expect(providerForTarget({ targetKey: githubKey, provider: "github", settled: true }, githubKey)).toEqual({
      provider: "github",
      settled: true,
    });
    // A settled failure stays distinguishable from an in-flight lookup.
    expect(providerForTarget({ targetKey: gitlabKey, provider: null, settled: true }, gitlabKey)).toEqual({
      provider: null,
      settled: true,
    });
  });

  test("a result bound to another target reads as unresolved", () => {
    const stale = { targetKey: githubKey, provider: "github" as const, settled: true };
    expect(providerForTarget(stale, gitlabKey)).toEqual({ provider: null, settled: false });
    expect(providerSupports(providerForTarget(stale, gitlabKey).provider, "milestones")).toBe(false);
  });

  test("aggregate mode is keyed on the candidate set", () => {
    const aggregate = "__agetor_all_repositories__";
    const twoRepos = providerTargetKey(aggregate, "/repos/hub\n/repos/hub2");
    const threeRepos = providerTargetKey(aggregate, "/repos/hub\n/repos/hub2\n/repos/lab");
    const bound = { targetKey: twoRepos, provider: "github" as const, settled: true };
    expect(providerForTarget(bound, twoRepos)).toEqual({ provider: "github", settled: true });
    expect(providerForTarget(bound, threeRepos)).toEqual({ provider: null, settled: false });
    // Aggregate and single-repo targets never collide.
    expect(providerTargetKey(aggregate, "")).not.toBe(providerTargetKey("", ""));
    expect(providerForTarget(bound, githubKey)).toEqual({ provider: null, settled: false });
  });
});
