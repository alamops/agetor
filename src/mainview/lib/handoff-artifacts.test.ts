import { describe, expect, test } from "bun:test";
import {
  type HandoffArtifact,
  type HandoffArtifactContext,
  cardArtifacts,
  classifyHandoffArtifact,
} from "./handoff-artifacts";

const WORKTREE = "/work/trees/task-1";
const WORKDIR = "/work/repo";
const CTX: HandoffArtifactContext = { roots: [WORKTREE, WORKDIR], homeDir: "/Users/example" };

const classify = (entry: string, ctx = CTX) => classifyHandoffArtifact(entry, ctx);

function asPath(a: HandoffArtifact) {
  expect(a.kind).toBe("path");
  if (a.kind !== "path") throw new Error("not a path");
  return a;
}
function asUrl(a: HandoffArtifact) {
  expect(a.kind).toBe("url");
  if (a.kind !== "url") throw new Error("not a url");
  return a;
}
function asText(a: HandoffArtifact) {
  expect(a.kind).toBe("text");
  if (a.kind !== "text") throw new Error("not text");
  return a;
}

describe("classifyHandoffArtifact — the 9 spike shapes", () => {
  test("relative path", () => {
    const a = asPath(classify("docs/plans/x.md"));
    expect(a.display).toBe("docs/plans/x.md");
    expect(a.candidates).toEqual([
      `${WORKTREE}/docs/plans/x.md`,
      `${WORKDIR}/docs/plans/x.md`,
    ]);
    expect(a.line).toBeNull();
    expect(a.note).toBeNull();
  });

  test("absolute path", () => {
    const a = asPath(classify("/private/tmp/scratch/report.txt"));
    expect(a.display).toBe("/private/tmp/scratch/report.txt");
    expect(a.candidates).toEqual(["/private/tmp/scratch/report.txt"]);
  });

  test("absolute path with a note", () => {
    const a = asPath(classify("/private/tmp/scratch/report.txt (the report)"));
    expect(a.display).toBe("/private/tmp/scratch/report.txt");
    expect(a.note).toBe("the report");
    expect(a.candidates).toEqual(["/private/tmp/scratch/report.txt"]);
  });

  test("relative path with a parenthesised note", () => {
    const a = asPath(classify("src/foo.ts (new helper)"));
    expect(a.display).toBe("src/foo.ts");
    expect(a.note).toBe("new helper");
  });

  test("relative path with an em-dash note", () => {
    const a = asPath(classify("src/foo.ts — new helper"));
    expect(a.display).toBe("src/foo.ts");
    expect(a.note).toBe("new helper");
  });

  test("relative path with a hyphen note", () => {
    const a = asPath(classify("src/foo.ts - new helper"));
    expect(a.display).toBe("src/foo.ts");
    expect(a.note).toBe("new helper");
  });

  test("relative path with a colon note", () => {
    const a = asPath(classify("src/foo.ts: new helper"));
    expect(a.display).toBe("src/foo.ts");
    expect(a.note).toBe("new helper");
  });

  test("path:line anchor", () => {
    const a = asPath(classify("src/foo.ts:12"));
    expect(a.display).toBe("src/foo.ts");
    expect(a.line).toBe("12");
    expect(a.candidates[0]).toBe(`${WORKTREE}/src/foo.ts`);
  });

  test("URL", () => {
    const a = asUrl(classify("https://example.invalid/pr/1"));
    expect(a.url).toBe("https://example.invalid/pr/1");
    expect(a.note).toBeNull();
  });

  test("URL with a note", () => {
    const a = asUrl(classify("https://example.invalid/pr/1 (the PR)"));
    expect(a.url).toBe("https://example.invalid/pr/1");
    expect(a.note).toBe("the PR");
  });

  test("free text: a commit sentence", () => {
    const a = asText(classify("commit 1234abc on feature/example"));
    expect(a.text).toBe("commit 1234abc on feature/example");
  });

  test("free text: a scheme token with no slash", () => {
    const a = asText(
      classify("jubarteai:00000000-0000-4000-8000-000000000000 (note)"),
    );
    expect(a.text).toBe("jubarteai:00000000-0000-4000-8000-000000000000 (note)");
  });

  test("free text: prose", () => {
    asText(classify("Local Docker images were rebuilt"));
  });
});

describe("classifyHandoffArtifact — path rules", () => {
  test("a bare file with an extension is a path", () => {
    const a = asPath(classify("package.json"));
    expect(a.candidates).toEqual([`${WORKTREE}/package.json`, `${WORKDIR}/package.json`]);
  });

  test("a version-like token is text", () => {
    asText(classify("v1.2"));
    asText(classify("3.14"));
  });

  test("a bare word is text", () => {
    asText(classify("done"));
  });

  test("a head with spaces and no explicit prefix is text", () => {
    asText(classify("see docs/plans/x.md for details"));
  });

  test("./ and @ are stripped before joining", () => {
    const dot = asPath(classify("./src/a.ts"));
    expect(dot.display).toBe("./src/a.ts");
    expect(dot.candidates).toEqual([`${WORKTREE}/src/a.ts`, `${WORKDIR}/src/a.ts`]);
    const at = asPath(classify("@src/a.ts"));
    expect(at.candidates).toEqual([`${WORKTREE}/src/a.ts`, `${WORKDIR}/src/a.ts`]);
  });

  test("../ is normalized against the roots", () => {
    const a = asPath(classify("../shared/a.ts"));
    expect(a.candidates).toEqual(["/work/trees/shared/a.ts", "/work/shared/a.ts"]);
  });

  test("duplicate roots collapse; blank roots are skipped", () => {
    const a = asPath(
      classify("a/b.md", { roots: [WORKDIR, null, "", undefined, WORKDIR], homeDir: null }),
    );
    expect(a.candidates).toEqual([`${WORKDIR}/a/b.md`]);
  });

  test("no usable roots → a path with no candidates", () => {
    const a = asPath(classify("a/b.md", { roots: [], homeDir: null }));
    expect(a.candidates).toEqual([]);
    expect(a.display).toBe("a/b.md");
  });

  test("a trailing slash (directory) is preserved", () => {
    const a = asPath(classify("src/bun/"));
    expect(a.candidates[0]).toBe(`${WORKTREE}/src/bun/`);
  });

  test("an absolute path with spaces stays whole", () => {
    const a = asPath(classify("/Users/example/My Docs/plan.md"));
    expect(a.display).toBe("/Users/example/My Docs/plan.md");
  });

  test("absolute paths are normalized for the candidate, not the display", () => {
    const a = asPath(classify("/a//b/../c.txt"));
    expect(a.display).toBe("/a//b/../c.txt");
    expect(a.candidates).toEqual(["/a/c.txt"]);
  });

  test("ssh:// style URLs are not paths", () => {
    asText(classify("ssh://host/repo.git"));
  });
});

describe("classifyHandoffArtifact — line anchors", () => {
  test(":N-M", () => {
    const a = asPath(classify("src/a.ts:10-20"));
    expect(a.line).toBe("10-20");
    expect(a.display).toBe("src/a.ts");
  });

  test("#LN", () => {
    const a = asPath(classify("src/a.ts#L7"));
    expect(a.line).toBe("7");
    expect(a.display).toBe("src/a.ts");
  });

  test("#LN-LM", () => {
    const a = asPath(classify("src/a.ts#L7-L9"));
    expect(a.line).toBe("7-9");
  });

  test(":N:col drops the column", () => {
    const a = asPath(classify("src/a.ts:12:5"));
    expect(a.line).toBe("12");
  });

  test("line anchor plus note", () => {
    const a = asPath(classify("src/a.ts:12 (the bug)"));
    expect(a.line).toBe("12");
    expect(a.note).toBe("the bug");
  });

  test("a bare :12 is text", () => {
    asText(classify(":12"));
  });
});

describe("classifyHandoffArtifact — notes", () => {
  test("a nested paren keeps everything but one trailing )", () => {
    const a = asPath(classify("a/b.md (see (also) c)"));
    expect(a.note).toBe("see (also) c");
  });

  test("an empty note reads as no note", () => {
    const a = asPath(classify("a/b.md ()"));
    expect(a.note).toBeNull();
  });

  test("the earliest separator wins", () => {
    const a = asPath(classify("a/b.md — one (two) - three"));
    expect(a.note).toBe("one (two) - three");
  });
});

describe("classifyHandoffArtifact — ~/", () => {
  test("expands against homeDir; display stays as written", () => {
    const a = asPath(classify("~/.agetor/notes.md"));
    expect(a.display).toBe("~/.agetor/notes.md");
    expect(a.candidates).toEqual(["/Users/example/.agetor/notes.md"]);
  });

  test("a homeDir with a trailing slash joins cleanly", () => {
    const a = asPath(classify("~/a.md", { roots: [], homeDir: "/Users/example/" }));
    expect(a.candidates).toEqual(["/Users/example/a.md"]);
  });

  test("no homeDir → text", () => {
    asText(classify("~/a.md", { roots: [WORKDIR], homeDir: null }));
    asText(classify("~/a.md", { roots: [WORKDIR], homeDir: "  " }));
  });
});

describe("classifyHandoffArtifact — file://", () => {
  test("is percent-decoded", () => {
    const a = asPath(classify("file:///tmp/my%20file.png"));
    expect(a.display).toBe("/tmp/my file.png");
    expect(a.candidates).toEqual(["/tmp/my file.png"]);
  });

  test("accepts the localhost host", () => {
    const a = asPath(classify("file://localhost/tmp/a.png"));
    expect(a.candidates).toEqual(["/tmp/a.png"]);
  });

  test("a foreign host is text", () => {
    asText(classify("file://other-host/tmp/a.png"));
  });

  test("a malformed escape is text", () => {
    asText(classify("file:///tmp/%E0%A4%A.png"));
  });

  test("carries a line anchor and a note", () => {
    const a = asPath(classify("file:///tmp/a.ts#L3 (entry)"));
    expect(a.line).toBe("3");
    expect(a.note).toBe("entry");
    expect(a.candidates).toEqual(["/tmp/a.ts"]);
  });
});

describe("classifyHandoffArtifact — URLs", () => {
  test("mailto:", () => {
    const a = asUrl(classify("mailto:someone@example.invalid"));
    expect(a.url).toBe("mailto:someone@example.invalid");
  });

  test("a bare scheme is text", () => {
    asText(classify("https://"));
    asText(classify("mailto:"));
  });

  test("a trailing unbalanced ) is stripped", () => {
    const a = asUrl(classify("https://example.invalid/y)"));
    expect(a.url).toBe("https://example.invalid/y");
  });

  test("balanced parens inside the URL are kept", () => {
    const a = asUrl(classify("https://example.invalid/wiki/Foo_(bar)"));
    expect(a.url).toBe("https://example.invalid/wiki/Foo_(bar)");
  });

  test("balanced parens plus an unbalanced one", () => {
    const a = asUrl(classify("https://example.invalid/wiki/Foo_(bar))"));
    expect(a.url).toBe("https://example.invalid/wiki/Foo_(bar)");
  });

  test("thousands of trailing ) strip in linear time (agent-controlled input)", () => {
    // 50 artifacts at the 8,000-char field cap, each `https://x/` + `)`s: the
    // per-paren recount took ~9 s here.
    const raw = `https://example.invalid/${")".repeat(7_970)}`;
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      expect(asUrl(classify(raw)).url).toBe("https://example.invalid/");
    }
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test("balanced parens survive a long unbalanced tail", () => {
    const a = asUrl(classify(`https://example.invalid/wiki/Foo_(bar)${")".repeat(1000)}`));
    expect(a.url).toBe("https://example.invalid/wiki/Foo_(bar)");
  });

  test("notes after ( , — and -", () => {
    expect(asUrl(classify("https://example.invalid/a (the doc)")).note).toBe("the doc");
    expect(asUrl(classify("https://example.invalid/a — the doc")).note).toBe("the doc");
    expect(asUrl(classify("https://example.invalid/a - the doc")).note).toBe("the doc");
  });

  test("a URL followed by an empty note", () => {
    expect(asUrl(classify("https://example.invalid/a ()")).note).toBeNull();
  });

  test("a URL inside prose is text", () => {
    asText(classify("see https://example.invalid/a"));
  });
});

describe("classifyHandoffArtifact — empty and degenerate entries", () => {
  test("empty", () => {
    const a = asText(classify(""));
    expect(a.text).toBe("");
  });

  test("whitespace only", () => {
    const a = asText(classify("   \t "));
    expect(a.text).toBe("");
    expect(a.raw).toBe("   \t ");
  });

  test("text is trimmed; raw is untouched", () => {
    const a = asText(classify("  hello world  "));
    expect(a.text).toBe("hello world");
    expect(a.raw).toBe("  hello world  ");
  });

  test("raw is preserved on paths and URLs", () => {
    expect(classify("  a/b.md ").raw).toBe("  a/b.md ");
    expect(classify(" https://example.invalid/a").raw).toBe(" https://example.invalid/a");
  });

  test("a leading separator leaves no head → text", () => {
    asText(classify(" - just a note"));
  });
});

describe("cardArtifacts", () => {
  // The canonical rich handoff's artifacts, in order.
  const canonical = [
    "agetor-handoff/notes.md",
    "/work/repo/agetor-handoff/report.txt",
    "https://example.invalid/pr/1",
    "agetor-handoff/notes.md (the plan)",
    "agetor-handoff/notes.md:12",
    "agetor-handoff/missing.md",
    "jubarteai:00000000-0000-4000-8000-000000000000 (note)",
    "commit 1234abc on feature/example",
  ];

  test("classifies the canonical list as path, path, url, path, path, path, text, text", () => {
    const kinds = canonical.map((e) => classify(e).kind);
    expect(kinds).toEqual(["path", "path", "url", "path", "path", "path", "text", "text"]);
    const list = canonical.map((e) => classify(e));
    expect(asPath(list[3]!).note).toBe("the plan");
    expect(asPath(list[4]!).line).toBe("12");
  });

  test("8 entries → 6 chips, hiddenCount 2", () => {
    const list = canonical.map((e) => classify(e));
    const { chips, hiddenCount } = cardArtifacts(list);
    expect(chips).toHaveLength(6);
    expect(chips.every((c) => c.kind !== "text")).toBe(true);
    expect(chips).toEqual(list.slice(0, 6));
    expect(hiddenCount).toBe(2);
  });

  test("fewer than 6 entries → all non-text entries, text still counted as hidden", () => {
    const list = ["a/b.md", "https://example.invalid/x", "some prose"].map((e) => classify(e));
    const { chips, hiddenCount } = cardArtifacts(list);
    expect(chips).toHaveLength(2);
    expect(hiddenCount).toBe(1);
  });

  test("text entries never take a chip slot", () => {
    const list = ["prose one", "prose two", "a/b.md"].map((e) => classify(e));
    const { chips, hiddenCount } = cardArtifacts(list, 1);
    expect(chips).toEqual([list[2]!]);
    expect(hiddenCount).toBe(2);
  });

  test("an empty list", () => {
    expect(cardArtifacts([])).toEqual({ chips: [], hiddenCount: 0 });
  });

  test("a custom limit, and a zero or negative limit", () => {
    const list = canonical.map((e) => classify(e));
    expect(cardArtifacts(list, 2).chips).toHaveLength(2);
    expect(cardArtifacts(list, 2).hiddenCount).toBe(6);
    expect(cardArtifacts(list, 0)).toEqual({ chips: [], hiddenCount: 8 });
    expect(cardArtifacts(list, -3)).toEqual({ chips: [], hiddenCount: 8 });
  });
});
