import { test, expect, describe } from "bun:test";
import {
  BRANCH_TEMPLATE_TAGS,
  DEFAULT_BRANCH_CONFIG,
  branchCommitType,
  branchPattern,
  conventionalCommitType,
  hasBranchTemplateTags,
  renderBranchTemplate,
  slugifyBranch,
  validateBranchConfig,
  validateBranchName,
  type BranchNamingConfig,
  type BranchTemplateContext,
} from "./types.ts";

const FIXED_NOW = new Date(2026, 6, 13, 4, 15, 2); // 2026-07-13 04:15:02 local

function ctx(overrides: Partial<BranchTemplateContext> = {}): BranchTemplateContext {
  return {
    title: "Add login page",
    projectName: "my-cool-app",
    taskType: "task",
    token: "abc123",
    now: FIXED_NOW,
    ...overrides,
  };
}

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

// `buildBranchName` was removed — branch composition now always flows through
// `branchPattern` (resolve the per-type template) + `renderBranchTemplate`
// (substitute it against a context). These tests re-express the same
// behavioral coverage the old direct-composition helper had.
describe("branch composition (via branchPattern + renderBranchTemplate)", () => {
  test("default config composes prefix + title slug by task type", () => {
    expect(renderBranchTemplate(branchPattern(DEFAULT_BRANCH_CONFIG, "task"), ctx({ title: "Add login" })))
      .toBe("feature/add-login");
    expect(
      renderBranchTemplate(branchPattern(DEFAULT_BRANCH_CONFIG, "bug"), ctx({ title: "Broken nav", taskType: "bug" })),
    ).toBe("fix/broken-nav");
    expect(
      renderBranchTemplate(branchPattern(DEFAULT_BRANCH_CONFIG, "spike"), ctx({ title: "Try SSE", taskType: "spike" })),
    ).toBe("spike/try-sse");
  });
  test("falls back to the token when the slug is empty", () => {
    expect(
      renderBranchTemplate(branchPattern(DEFAULT_BRANCH_CONFIG, "task"), ctx({ title: "!!!", token: "abc123" })),
    ).toBe("feature/abc123");
  });
  test("uses the token as body when includeSlug is off", () => {
    const cfg: BranchNamingConfig = { ...DEFAULT_BRANCH_CONFIG, includeSlug: false };
    expect(renderBranchTemplate(branchPattern(cfg, "task"), ctx({ title: "Add login", token: "abc123" })))
      .toBe("feature/abc123");
  });
  test("honors a custom plain prefix", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "features/" }, bug: { prefix: "hotfix/" }, spike: { prefix: "poc/" } },
    };
    expect(renderBranchTemplate(branchPattern(cfg, "task"), ctx({ title: "Add login" })))
      .toBe("features/add-login");
    expect(renderBranchTemplate(branchPattern(cfg, "bug"), ctx({ title: "Broken nav", taskType: "bug" })))
      .toBe("hotfix/broken-nav");
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
  test("accepts a bare prefix with no explicit tag (implicit <slug>/<token> append)", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "feature/" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(validateBranchConfig(cfg).ok).toBe(true);
  });
  test("accepts a rule whose prefix is already a full <slug> template", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "feature/<slug>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(validateBranchConfig(cfg).ok).toBe(true);
  });
  test("rejects a <slug> template prefix containing an illegal character (rendered form is checked)", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "feat ure/<slug>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
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

describe("renderBranchTemplate", () => {
  test("substitutes <slug>", () => {
    expect(renderBranchTemplate("feature/<slug>", ctx())).toBe("feature/add-login-page");
  });
  test("falls back to the token when the title slugifies to empty", () => {
    expect(renderBranchTemplate("feature/<slug>", ctx({ title: "!!!" }))).toBe("feature/abc123");
  });
  test("substitutes <project_name>", () => {
    expect(renderBranchTemplate("<project_name>/<slug>", ctx())).toBe("my-cool-app/add-login-page");
  });
  test("falls back to 'project' when the project name slugifies to empty", () => {
    expect(renderBranchTemplate("<project_name>/<slug>", ctx({ projectName: "###" })))
      .toBe("project/add-login-page");
  });
  test("substitutes <type>", () => {
    expect(renderBranchTemplate("<type>/<slug>", ctx({ taskType: "bug" }))).toBe("bug/add-login-page");
    expect(renderBranchTemplate("<type>/<slug>", ctx({ taskType: "spike" }))).toBe("spike/add-login-page");
  });
  test("substitutes <date> with local-time YYYY-MM-DD", () => {
    expect(renderBranchTemplate("archive/<date>", ctx())).toBe("archive/2026-07-13");
  });
  test("substitutes <timestamp> with local-time YYYYMMDD-HHmmss, zero-padded", () => {
    expect(renderBranchTemplate("archive/<timestamp>", ctx())).toBe("archive/20260713-041502");
  });
  test("substitutes <token>", () => {
    expect(renderBranchTemplate("wip/<token>", ctx())).toBe("wip/abc123");
  });
  test("handles multiple and repeated tags in one template", () => {
    expect(renderBranchTemplate("<type>/<date>-<slug>-<token>-<slug>", ctx()))
      .toBe("task/2026-07-13-add-login-page-abc123-add-login-page");
  });
  test("passes unknown tags through literally", () => {
    expect(renderBranchTemplate("feature/<slug>/<unknown>", ctx()))
      .toBe("feature/add-login-page/<unknown>");
  });
  test("is the identity on a tag-free string (back-compat for literal overrides)", () => {
    expect(renderBranchTemplate("feature/my-manual-branch", ctx())).toBe("feature/my-manual-branch");
  });
});

describe("hasBranchTemplateTags", () => {
  test("true for each known tag", () => {
    for (const { tag } of BRANCH_TEMPLATE_TAGS) {
      expect(hasBranchTemplateTags(`feature/${tag}`)).toBe(true);
    }
  });
  test("false for a tag-free literal", () => {
    expect(hasBranchTemplateTags("feature/my-manual-branch")).toBe(false);
  });
  test("false for an unknown angle-bracket sequence", () => {
    expect(hasBranchTemplateTags("feature/<unknown>")).toBe(false);
  });
});

describe("branchPattern", () => {
  test("uses <slug> when includeSlug is true", () => {
    expect(branchPattern(DEFAULT_BRANCH_CONFIG, "task")).toBe("feature/<slug>");
    expect(branchPattern(DEFAULT_BRANCH_CONFIG, "bug")).toBe("fix/<slug>");
    expect(branchPattern(DEFAULT_BRANCH_CONFIG, "spike")).toBe("spike/<slug>");
  });
  test("uses <token> when includeSlug is false", () => {
    const cfg: BranchNamingConfig = { ...DEFAULT_BRANCH_CONFIG, includeSlug: false };
    expect(branchPattern(cfg, "task")).toBe("feature/<token>");
  });
  test("falls back to DEFAULT_BRANCH_CONFIG's rule for a task type missing from the config", () => {
    const cfg = {
      includeSlug: true,
      rules: { task: { prefix: "features/" } },
    } as unknown as BranchNamingConfig;
    expect(branchPattern(cfg, "bug")).toBe("fix/<slug>");
  });

  // Target spec: a prefix that already contains a body tag (<slug> or <token>)
  // is returned verbatim — nothing is appended on top of it. This is the fix
  // for the reported bug where a prefix like "feature/<slug>" rendered as
  // "feature/<slug><slug>"-equivalent (double-appended body).
  test("a prefix already containing <slug> is returned verbatim — no second <slug> appended (regression for the reported bug)", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "feature/<slug>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(branchPattern(cfg, "task")).toBe("feature/<slug>");
  });
  test("a prefix already containing <token> is returned verbatim", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "wip/<token>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(branchPattern(cfg, "task")).toBe("wip/<token>");
  });
  test("an explicit <slug> tag wins even when includeSlug is false", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: false,
      rules: { task: { prefix: "feature/<slug>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(branchPattern(cfg, "task")).toBe("feature/<slug>");
    expect(renderBranchTemplate(branchPattern(cfg, "task"), ctx({ title: "Add login page" })))
      .toBe("feature/add-login-page");
  });
  test("a non-body tag (<date>) does not suppress the appended body tag", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "archive/<date>-" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(branchPattern(cfg, "task")).toBe("archive/<date>-<slug>");
  });
  test("end-to-end: a <slug> template prefix renders with exactly one slug substitution", () => {
    const cfg: BranchNamingConfig = {
      includeSlug: true,
      rules: { task: { prefix: "feature/<slug>" }, bug: { prefix: "fix/" }, spike: { prefix: "spike/" } },
    };
    expect(renderBranchTemplate(branchPattern(cfg, "task"), ctx({ title: "Add login page" })))
      .toBe("feature/add-login-page");
  });
});
