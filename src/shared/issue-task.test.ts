import { describe, expect, test } from "bun:test";
import {
  buildIssueTaskPrompt,
  issueTaskTitle,
  normalizeIssueUrl,
  parseIssueUrl,
  renderIssueThreadMarkdown,
} from "./issue-task.ts";
import type { GitHubComment, GitHubIssueThreadResult, GitHubListItem } from "./types.ts";

function makeItem(overrides: Partial<GitHubListItem> = {}): GitHubListItem {
  return {
    kind: "issues",
    number: 7,
    title: "Something is broken",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/acme/widgets/issues/7",
    author: { login: "reporter", avatarUrl: null, htmlUrl: null },
    assignees: [],
    milestone: null,
    body: "Steps to reproduce the bug.",
    labels: [],
    comments: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: "/tmp/repo",
    ...overrides,
  };
}

function makeComment(overrides: Partial<GitHubComment> = {}): GitHubComment {
  return {
    id: 1,
    body: "A comment body.",
    htmlUrl: "https://github.com/acme/widgets/issues/7#issuecomment-1",
    author: { login: "commenter", avatarUrl: null, htmlUrl: null },
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-03T00:00:00Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<GitHubIssueThreadResult> = {}): GitHubIssueThreadResult {
  return {
    repo: "acme/widgets",
    item: makeItem(),
    comments: [],
    truncated: false,
    refetchCommand: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseIssueUrl
// ---------------------------------------------------------------------------

describe("parseIssueUrl", () => {
  describe("GitHub", () => {
    test("plain URL", () => {
      expect(parseIssueUrl("https://github.com/acme/widgets/issues/7")).toEqual({
        provider: "github",
        number: 7,
        owner: "acme",
        repo: "widgets",
        host: "github.com",
      });
    });

    test("trailing slash", () => {
      expect(parseIssueUrl("https://github.com/acme/widgets/issues/7/")).toEqual({
        provider: "github",
        number: 7,
        owner: "acme",
        repo: "widgets",
        host: "github.com",
      });
    });

    test("#issuecomment-N fragment", () => {
      expect(parseIssueUrl("https://github.com/acme/widgets/issues/7#issuecomment-1")).toEqual({
        provider: "github",
        number: 7,
        owner: "acme",
        repo: "widgets",
        host: "github.com",
      });
    });

    test("query string", () => {
      expect(parseIssueUrl("https://github.com/acme/widgets/issues/7?foo=1")).toEqual({
        provider: "github",
        number: 7,
        owner: "acme",
        repo: "widgets",
        host: "github.com",
      });
    });

    test("self-hosted GHES host", () => {
      expect(parseIssueUrl("https://ghe.corp.example/org/repo/issues/12")).toEqual({
        provider: "github",
        number: 12,
        owner: "org",
        repo: "repo",
        host: "ghe.corp.example",
      });
    });
  });

  describe("GitLab", () => {
    test("nested groups form (/-/issues/N), owner is the joined group path", () => {
      expect(parseIssueUrl("https://gitlab.com/g/sub/proj/-/issues/5")).toEqual({
        provider: "gitlab",
        number: 5,
        owner: "g/sub",
        repo: "proj",
        host: "gitlab.com",
      });
    });

    test("self-hosted host with /-/issues/N", () => {
      expect(parseIssueUrl("https://git.corp.example/g/proj/-/issues/9")).toEqual({
        provider: "gitlab",
        number: 9,
        owner: "g",
        repo: "proj",
        host: "git.corp.example",
      });
    });

    test("legacy form (no /-/) on a gitlab-ish host", () => {
      expect(parseIssueUrl("https://gitlab.com/owner/repo/issues/5")).toEqual({
        provider: "gitlab",
        number: 5,
        owner: "owner",
        repo: "repo",
        host: "gitlab.com",
      });
    });
  });

  describe("Bitbucket", () => {
    test("with a trailing title slug", () => {
      expect(parseIssueUrl("https://bitbucket.org/ws/slug/issues/9/some-title")).toEqual({
        provider: "bitbucket",
        number: 9,
        owner: "ws",
        repo: "slug",
        host: "bitbucket.org",
      });
    });
  });

  describe("rejections", () => {
    test("GitHub pull request URL", () => {
      expect(parseIssueUrl("https://github.com/o/r/pull/7")).toBeNull();
    });

    test("GitLab merge request URL under /-/", () => {
      expect(parseIssueUrl("https://gitlab.com/g/p/-/merge_requests/3")).toBeNull();
    });

    test("Bitbucket pull-requests URL", () => {
      expect(parseIssueUrl("https://bitbucket.org/w/r/pull-requests/2")).toBeNull();
    });

    test("GitHub discussions URL", () => {
      expect(parseIssueUrl("https://github.com/o/r/discussions/4")).toBeNull();
    });

    test("non-canonical issue number (exponential notation)", () => {
      expect(parseIssueUrl("https://github.com/o/r/issues/1e3")).toBeNull();
    });

    test("issue number 0", () => {
      expect(parseIssueUrl("https://github.com/o/r/issues/0")).toBeNull();
    });

    test("non-http(s) scheme (ssh)", () => {
      expect(parseIssueUrl("ssh://git@github.com/o/r/issues/1")).toBeNull();
    });

    test("non-http(s) scheme (agetor)", () => {
      expect(parseIssueUrl("agetor://o/r/issues/1")).toBeNull();
    });

    test("empty string", () => {
      expect(parseIssueUrl("")).toBeNull();
    });

    test("null", () => {
      expect(parseIssueUrl(null)).toBeNull();
    });

    test("undefined", () => {
      expect(parseIssueUrl(undefined)).toBeNull();
    });

    test("garbage string", () => {
      expect(parseIssueUrl("not a url")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeIssueUrl
// ---------------------------------------------------------------------------

describe("normalizeIssueUrl", () => {
  test("host case is normalized so differently-cased hosts compare equal", () => {
    expect(normalizeIssueUrl("https://GitHub.COM/o/r/issues/7")).toBe(
      normalizeIssueUrl("https://github.com/o/r/issues/7"),
    );
  });

  test("query string and fragment are stripped", () => {
    expect(normalizeIssueUrl("https://github.com/o/r/issues/7?foo=1#bar")).toBe(
      "https://github.com/o/r/issues/7",
    );
  });

  test("trailing slash is stripped", () => {
    expect(normalizeIssueUrl("https://github.com/o/r/issues/7/")).toBe("https://github.com/o/r/issues/7");
  });

  test("Bitbucket title slug is dropped so it compares equal to the bare issue URL", () => {
    expect(normalizeIssueUrl("https://bitbucket.org/ws/slug/issues/9/some-title")).toBe(
      normalizeIssueUrl("https://bitbucket.org/ws/slug/issues/9"),
    );
  });
});

// ---------------------------------------------------------------------------
// issueTaskTitle
// ---------------------------------------------------------------------------

test("issueTaskTitle formats as 'Issue #N: title'", () => {
  expect(issueTaskTitle({ number: 7, title: "Something is broken" })).toBe("Issue #7: Something is broken");
});

// ---------------------------------------------------------------------------
// renderIssueThreadMarkdown
// ---------------------------------------------------------------------------

describe("renderIssueThreadMarkdown", () => {
  test("heading and metadata bullets", () => {
    const md = renderIssueThreadMarkdown(
      makeThread({
        item: makeItem({
          labels: [
            { name: "bug", color: "red" },
            { name: "P1", color: null },
          ],
        }),
      }),
    );

    expect(md).toContain("# Issue #7: Something is broken");
    expect(md).toContain("- Repo: acme/widgets");
    expect(md).toContain("- URL: https://github.com/acme/widgets/issues/7");
    expect(md).toContain("- State: open");
    expect(md).toContain("- Author: @reporter");
    expect(md).toContain("- Labels: bug, P1");
    expect(md).toContain("- Created: 2026-01-01T00:00:00Z");
    expect(md).toContain("- Updated: 2026-01-02T00:00:00Z");
    expect(md).toContain("- Comments: 0");
  });

  test("no labels renders '(none)'", () => {
    const md = renderIssueThreadMarkdown(makeThread());
    expect(md).toContain("- Labels: (none)");
  });

  test("description section renders the body", () => {
    const md = renderIssueThreadMarkdown(makeThread({ item: makeItem({ body: "Actual repro steps." }) }));
    expect(md).toContain("## Description");
    expect(md).toContain("Actual repro steps.");
  });

  test("empty/whitespace-only body renders the placeholder", () => {
    const md = renderIssueThreadMarkdown(makeThread({ item: makeItem({ body: "   " }) }));
    expect(md).toContain("_(no description)_");
  });

  test("comments header includes the count, and each comment renders its own heading + body", () => {
    const comments = [
      makeComment({
        id: 1,
        author: { login: "alice", avatarUrl: null, htmlUrl: null },
        createdAt: "2026-01-03T00:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/issues/7#issuecomment-1",
        body: "First comment.",
      }),
      makeComment({
        id: 2,
        author: { login: "bob", avatarUrl: null, htmlUrl: null },
        createdAt: "2026-01-04T00:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/issues/7#issuecomment-2",
        body: "Second comment.",
      }),
    ];
    const md = renderIssueThreadMarkdown(makeThread({ comments }));

    expect(md).toContain("## Comments (2)");
    expect(md).toContain(
      "### @alice — 2026-01-03T00:00:00Z — https://github.com/acme/widgets/issues/7#issuecomment-1",
    );
    expect(md).toContain("First comment.");
    expect(md).toContain(
      "### @bob — 2026-01-04T00:00:00Z — https://github.com/acme/widgets/issues/7#issuecomment-2",
    );
    expect(md).toContain("Second comment.");
  });

  test("null item author renders 'unknown' with no @ prefix", () => {
    const md = renderIssueThreadMarkdown(makeThread({ item: makeItem({ author: null }) }));
    expect(md).toContain("- Author: unknown");
    expect(md).not.toContain("- Author: @unknown");
  });

  test("null comment author renders '@unknown' in its heading", () => {
    const md = renderIssueThreadMarkdown(makeThread({ comments: [makeComment({ author: null })] }));
    expect(md).toContain("### @unknown —");
  });

  test("truncated note is present when truncated", () => {
    const md = renderIssueThreadMarkdown(makeThread({ truncated: true }));
    expect(md).toContain("Thread truncated at the fetch cap");
  });

  test("truncated note is absent when not truncated", () => {
    const md = renderIssueThreadMarkdown(makeThread({ truncated: false }));
    expect(md).not.toContain("Thread truncated at the fetch cap");
  });
});

// ---------------------------------------------------------------------------
// buildIssueTaskPrompt
// ---------------------------------------------------------------------------

describe("buildIssueTaskPrompt", () => {
  test("github thread, 2 comments, refetchCommand set, snapshot attached", () => {
    const comments = [
      makeComment({
        id: 1,
        author: { login: "alice", avatarUrl: null, htmlUrl: null },
        body: "First comment.",
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makeComment({
        id: 2,
        author: { login: "bob", avatarUrl: null, htmlUrl: null },
        body: "Second comment.",
        createdAt: "2026-01-04T00:00:00Z",
      }),
    ];
    const t = makeThread({ comments, refetchCommand: "gh issue view 7 --repo acme/widgets --comments" });
    const { prompt, inlinedComments } = buildIssueTaskPrompt({ ...t, snapshotAttached: true });

    const firstLine = prompt.split("\n")[0];
    expect(firstLine).toBe(
      'Work on acme/widgets issue #7 — "Something is broken" (https://github.com/acme/widgets/issues/7).',
    );
    expect(prompt).toContain("Investigate the issue and its comment thread");
    expect(prompt).toContain("reproduce it");
    expect(prompt).toContain("Implement the fix or change the issue asks for, add or adjust tests");
    expect(prompt).toContain("Fixes #7");
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("saved as `issue-7-thread.md`");
    expect(prompt).toContain(
      "To re-fetch the live thread later, run: `gh issue view 7 --repo acme/widgets --comments`",
    );
    expect(prompt).toContain("## Issue #7: Something is broken");
    expect(prompt).toContain("Steps to reproduce the bug.");
    expect(prompt).toContain("## Thread");
    expect(prompt).toContain("First comment.");
    expect(prompt).toContain("Second comment.");
    expect(inlinedComments).toBe(2);
  });

  test("provider keyword: 'Closes #N' for a GitLab htmlUrl", () => {
    const t = makeThread({ item: makeItem({ htmlUrl: "https://gitlab.com/g/p/-/issues/9", number: 9 }) });
    const { prompt } = buildIssueTaskPrompt({ ...t, snapshotAttached: true });

    expect(prompt).toContain("Closes #9");
    expect(prompt).not.toContain("Fixes #9");
  });

  test("provider keyword: plain 'issue #N' for Bitbucket (no magic-word convention)", () => {
    const t = makeThread({ item: makeItem({ htmlUrl: "https://bitbucket.org/w/r/issues/9", number: 9 }) });
    const { prompt } = buildIssueTaskPrompt({ ...t, snapshotAttached: true });

    expect(prompt).toContain("issue #9");
    expect(prompt).not.toContain("Fixes #9");
    expect(prompt).not.toContain("Closes #9");
  });

  test("snapshotAttached: false omits the snapshot sentence", () => {
    const { prompt } = buildIssueTaskPrompt({ ...makeThread(), snapshotAttached: false });
    expect(prompt).not.toContain("issue-7-thread.md");
  });

  test("refetchCommand: null omits the re-fetch line", () => {
    const t = makeThread({ refetchCommand: null });
    const { prompt } = buildIssueTaskPrompt({ ...t, snapshotAttached: true });
    expect(prompt).not.toContain("To re-fetch the live thread later");
  });

  test("truncated: true adds the truncation note", () => {
    const t = makeThread({ truncated: true });
    const { prompt } = buildIssueTaskPrompt({ ...t, snapshotAttached: true });
    expect(prompt).toContain("thread truncated at the fetch cap");
  });

  describe("byte cap", () => {
    test("50 ~1KB comments with inlineMaxBytes: 5_000 stops well short of inlining all of them", () => {
      const comments = Array.from({ length: 50 }, (_, i) =>
        makeComment({ id: i, body: `${"x".repeat(1_000)} comment ${i}` }));
      const t = makeThread({ comments });
      const { prompt, inlinedComments } = buildIssueTaskPrompt(
        { ...t, snapshotAttached: true },
        { inlineMaxBytes: 5_000 },
      );

      expect(inlinedComments).toBeLessThan(50);
      expect(prompt).toContain("more comments — see the snapshot file");
      // The loop bounds the *accepted* thread content to the cap; the trailing
      // "N more comments" marker (added after the loop breaks) can push the
      // final prompt slightly past it. Pin that as a small, bounded overage
      // rather than an exact cap — read `buildIssueTaskPrompt`'s thread-
      // section loop before loosening this further.
      const bytes = new TextEncoder().encode(prompt).length;
      expect(bytes).toBeLessThan(5_000 + 200);
    });
  });
});
