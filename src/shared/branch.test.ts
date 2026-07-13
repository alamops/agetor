import { test, expect, describe } from "bun:test";
import {
  DEFAULT_BRANCH_CONFIG,
  branchCommitType,
  buildBranchName,
  conventionalCommitType,
  slugifyBranch,
  validateBranchConfig,
  validateBranchName,
  type BranchNamingConfig,
} from "./types.ts";

describe("slugifyBranch", () => {
  test("kebab-cases and lowercases", () => {
    expect(slugifyBranch("Add Login Page")).toBe("add-login-page");
  });
  test("collapses runs of symbols and trims edges", () => {
    expect(slugifyBranch("  Fix!! the __thing__  ")).toBe("fix-the-thing");
  });
  test("returns empty for symbol-only input (caller supplies fallback)", () => {
    expect(slugifyBranch("!!!")).toBe("");
    expect(slugifyBranch("")).toBe("");
  });
  test("caps length and never leaves a trailing dash", () => {
    const s = slugifyBranch("a".repeat(30) + " " + "b".repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("buildBranchName", () => {
  test("prefix + title slug by task type", () => {
    expect(buildBranchName(DEFAULT_BRANCH_CONFIG, "task", "Add login")).toBe("feature/add-login");
    expect(buildBranchName(DEFAULT_BRANCH_CONFIG, "bug", "Broken nav")).toBe("fix/broken-nav");
    expect(buildBranchName(DEFAULT_BRANCH_CONFIG, "spike", "Try SSE")).toBe("spike/try-sse");
  });
  test("falls back to the token when the slug is empty", () => {
    expect(buildBranchName(DEFAULT_BRANCH_CONFIG, "task", "!!!", { token: "abc123" }))
      .toBe("feature/abc123");
  });
  test("uses the token as body when includeSlug is off", () => {
    const cfg: BranchNamingConfig = { ...DEFAULT_BRANCH_CONFIG, includeSlug: false };
    expect(buildBranchName(cfg, "task", "Add login", { token: "abc123" })).toBe("feature/abc123");
  });
  test("honors a custom prefix", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "features/" }, bug: { prefix: "hotfix/" }, spike: { prefix: "poc/" } },
    };
    expect(buildBranchName(cfg, "task", "Add login")).toBe("features/add-login");
    expect(buildBranchName(cfg, "bug", "Broken nav")).toBe("hotfix/broken-nav");
  });
});

describe("validateBranchName", () => {
  test("accepts legal names", () => {
    for (const n of ["feature/add-login", "fix/nav_bug", "spike/poc.v2", "a/b/c", "feature/abc123"]) {
      expect(validateBranchName(n).ok).toBe(true);
    }
  });
  test("rejects trailing separator (feature/name/)", () => {
    const r = validateBranchName("feature/name/");
    expect(r.ok).toBe(false);
  });
  test("rejects trailing dot, leading slash, empty", () => {
    expect(validateBranchName("feature/name.").ok).toBe(false);
    expect(validateBranchName("/feature/name").ok).toBe(false);
    expect(validateBranchName("").ok).toBe(false);
  });
  test("rejects disallowed characters and sequences", () => {
    for (const n of ["feature/na me", "feature/na~me", "feature/na:me", "feature/na?me",
      "feature/na*me", "feature/na[me", "feature/na\\me", "feature/na..me", "feature/na@{me",
      "feature//name", "@"]) {
      expect(validateBranchName(n).ok).toBe(false);
    }
  });
  test("rejects a segment starting with dot or ending with .lock", () => {
    expect(validateBranchName("feature/.hidden").ok).toBe(false);
    expect(validateBranchName("feature/name.lock").ok).toBe(false);
  });
  test("allows underscore (git-legal)", () => {
    expect(validateBranchName("feature/my_branch").ok).toBe(true);
  });
});

describe("validateBranchConfig", () => {
  test("accepts the defaults", () => {
    expect(validateBranchConfig(DEFAULT_BRANCH_CONFIG).ok).toBe(true);
  });
  test("accepts an empty prefix (bare slug branch)", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "" }, bug: { prefix: "" }, spike: { prefix: "" } },
    };
    expect(validateBranchConfig(cfg).ok).toBe(true);
  });
  test("rejects a prefix that yields an illegal branch", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "bad prefix/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(validateBranchConfig(cfg).ok).toBe(false);
  });
});

describe("conventionalCommitType", () => {
  test("maps task types to conventional prefixes", () => {
    expect(conventionalCommitType("task")).toBe("feat");
    expect(conventionalCommitType("bug")).toBe("fix");
    expect(conventionalCommitType("spike")).toBe("chore");
    expect(conventionalCommitType(null)).toBe("feat");
  });
});

describe("branchCommitType", () => {
  test("derives the type from the branch prefix (trailing slash removed)", () => {
    expect(branchCommitType("feature/add-login", "task")).toBe("feature");
    expect(branchCommitType("hotfix/nav", "bug")).toBe("hotfix");
    expect(branchCommitType("features/add-login-2", "task")).toBe("features");
  });
  test("keeps a multi-segment prefix intact (minus trailing slash)", () => {
    expect(branchCommitType("team/hotfix/broken-nav", "bug")).toBe("team/hotfix");
  });
  test("falls back to the conventional type when the branch has no prefix", () => {
    // Slash-less manual override.
    expect(branchCommitType("myfoo", "bug")).toBe("fix");
    // Isolation off — no branch at all.
    expect(branchCommitType(null, "spike")).toBe("chore");
    expect(branchCommitType(undefined, "task")).toBe("feat");
  });
  test("ignores the legacy agetor/ prefix (an internal detail, not a commit type)", () => {
    expect(branchCommitType("agetor/abc123def456-fix-the-thing", "bug")).toBe("fix");
    expect(branchCommitType("agetor/abc123def456-add-login", "task")).toBe("feat");
    expect(branchCommitType("agetor/abc123def456-try-sse", "spike")).toBe("chore");
  });
});
