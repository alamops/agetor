import { describe, expect, test } from "bun:test";
import {
  AT_TOKEN_MAX_LEN,
  expandAtTokens,
  findActiveAtQuery,
  findAtTokens,
  formatAtToken,
} from "./at-refs.ts";

describe("findAtTokens — trigger guard", () => {
  test("matches at BOF", () => {
    const tokens = findAtTokens("@README.md");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      start: 0,
      end: 10,
      raw: "@README.md",
      path: "README.md",
      quoted: false,
      isDirectory: false,
    });
  });

  test("matches immediately after whitespace", () => {
    const tokens = findAtTokens("see @README.md now");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("README.md");
    expect(tokens[0]!.start).toBe(4);
  });

  test("does not match user@host", () => {
    expect(findAtTokens("email me at user@host")).toHaveLength(0);
  });

  test("does not match a@b", () => {
    expect(findAtTokens("a@b")).toHaveLength(0);
  });

  test("does not match @ preceded by a non-whitespace closer", () => {
    // The guard fails regardless of what would otherwise be valid trailing
    // punctuation handling — `(` isn't whitespace.
    expect(findAtTokens("(@src/x.ts)")).toHaveLength(0);
  });
});

describe("findAtTokens — bare form trailing punctuation", () => {
  test("strips a trailing period", () => {
    const tokens = findAtTokens("see @README.md.");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("README.md");
    expect(tokens[0]!.raw).toBe("@README.md");
  });

  test("strips multiple trailing closers", () => {
    const tokens = findAtTokens("wrap it: @src/x.ts),");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("src/x.ts");
  });

  test("keeps a trailing slash (directory marker)", () => {
    const tokens = findAtTokens("look at @src/bun/, then");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("src/bun/");
    expect(tokens[0]!.isDirectory).toBe(true);
  });

  test("bare @ alone (nothing but whitespace after) is not a token", () => {
    expect(findAtTokens("hey @ you")).toHaveLength(0);
  });

  test("bare @ alone at end of string is not a token", () => {
    expect(findAtTokens("hey @")).toHaveLength(0);
  });

  test("stripping to nothing yields no token", () => {
    expect(findAtTokens("weird @.")).toHaveLength(0);
  });
});

describe("findAtTokens — quoted form", () => {
  test("parses a quoted path with spaces", () => {
    const tokens = findAtTokens('open @"docs/my file.md" please');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      start: 5,
      end: 23,
      raw: '@"docs/my file.md"',
      path: "docs/my file.md",
      quoted: true,
      isDirectory: false,
    });
  });

  test("quoted directory path keeps trailing slash and isDirectory", () => {
    const tokens = findAtTokens('@"docs/my folder/"');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("docs/my folder/");
    expect(tokens[0]!.isDirectory).toBe(true);
  });

  test("empty quoted contents is not a token", () => {
    expect(findAtTokens('@"" rest')).toHaveLength(0);
  });

  test("unterminated quote is not a token", () => {
    expect(findAtTokens('@"docs/my file.md rest of the line')).toHaveLength(0);
  });

  test("quote unterminated before a newline is not a token", () => {
    expect(findAtTokens('@"docs/my file.md\nmore text"')).toHaveLength(0);
  });

  test("@\" alone at end of string is not a token", () => {
    expect(findAtTokens('look @"')).toHaveLength(0);
  });
});

describe("findAtTokens — multiple tokens and lines", () => {
  test("two tokens on one line, non-overlapping and in order", () => {
    const tokens = findAtTokens("compare @a.ts and @b.ts please");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.path).toBe("a.ts");
    expect(tokens[1]!.path).toBe("b.ts");
    expect(tokens[0]!.end).toBeLessThanOrEqual(tokens[1]!.start);
  });

  test("tokens never span lines (LF)", () => {
    const tokens = findAtTokens("first @a.ts\nsecond @b.ts");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.path).toBe("a.ts");
    expect(tokens[1]!.path).toBe("b.ts");
  });

  test("CRLF behaves like LF", () => {
    const tokens = findAtTokens("first @a.ts\r\nsecond @b.ts");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.path).toBe("a.ts");
    expect(tokens[1]!.path).toBe("b.ts");
  });

  test("a bare \\r right after @ yields no token", () => {
    expect(findAtTokens("weird @\r\nrest")).toHaveLength(0);
  });
});

describe("AT_TOKEN_MAX_LEN", () => {
  test("a path exactly at the cap is a token", () => {
    const path = "a".repeat(AT_TOKEN_MAX_LEN);
    const tokens = findAtTokens(`@${path}`);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe(path);
  });

  test("a path over the cap is not a token", () => {
    const path = "a".repeat(AT_TOKEN_MAX_LEN + 1);
    expect(findAtTokens(`@${path}`)).toHaveLength(0);
  });

  test("an over-cap quoted path is not a token", () => {
    const path = "a".repeat(AT_TOKEN_MAX_LEN + 1);
    expect(findAtTokens(`@"${path}"`)).toHaveLength(0);
  });
});

describe("formatAtToken", () => {
  test("bare form for a path with no whitespace", () => {
    expect(formatAtToken("src/bun/db.ts")).toBe("@src/bun/db.ts");
  });

  test("quoted form for a path containing whitespace", () => {
    expect(formatAtToken("docs/my file.md")).toBe('@"docs/my file.md"');
  });
});

describe("findActiveAtQuery — bare", () => {
  test("returns the in-progress bare query", () => {
    const text = "see @src/bun";
    const result = findActiveAtQuery(text, text.length);
    expect(result).toEqual({ start: 4, end: text.length, query: "src/bun", quoted: false });
  });

  test("returns empty query right after a bare @", () => {
    const text = "hey @";
    const result = findActiveAtQuery(text, text.length);
    expect(result).toEqual({ start: 4, end: text.length, query: "", quoted: false });
  });

  test("caret 0 is always null", () => {
    expect(findActiveAtQuery("@foo", 0)).toBeNull();
  });

  test("caret in whitespace after a finished bare token is null", () => {
    const text = "@src/bun/ ";
    expect(findActiveAtQuery(text, text.length)).toBeNull();
  });

  test("@ preceded by non-whitespace fails the guard", () => {
    const text = "user@host";
    expect(findActiveAtQuery(text, text.length)).toBeNull();
  });

  test("a `/` inside the query is ordinary", () => {
    const text = "@src/";
    const result = findActiveAtQuery(text, text.length);
    expect(result).toEqual({ start: 0, end: text.length, query: "src/", quoted: false });
  });
});

describe("findActiveAtQuery — quoted", () => {
  test("quoted-in-progress query may contain spaces", () => {
    const text = 'open @"docs/my fi';
    const result = findActiveAtQuery(text, text.length);
    expect(result).toEqual({ start: 5, end: text.length, query: "docs/my fi", quoted: true });
  });

  test("caret right after a finished quoted token is null", () => {
    const text = 'before @"docs/a.md" after';
    const caretAfterQuote = text.indexOf('"', text.indexOf('"') + 1) + 1;
    expect(findActiveAtQuery(text, caretAfterQuote)).toBeNull();
  });

  test("caret further into trailing text after a finished quoted token is null", () => {
    const text = 'before @"docs/a.md" after';
    expect(findActiveAtQuery(text, text.length)).toBeNull();
  });

  test("a newline before the closing quote makes it null", () => {
    const text = 'open @"docs/my file\nmore';
    expect(findActiveAtQuery(text, text.length)).toBeNull();
  });
});

describe("expandAtTokens", () => {
  test("replaces resolvable tokens and preserves surrounding text", () => {
    const out = expandAtTokens("see @README.md please", (path) =>
      path === "README.md" ? "/abs/README.md" : null);
    expect(out).toBe("see /abs/README.md please");
  });

  test("leaves an unresolved token (resolver returns null) untouched", () => {
    const out = expandAtTokens("ping @github for status", () => null);
    expect(out).toBe("ping @github for status");
  });

  test("leaves a non-token @ (like an email) untouched", () => {
    const out = expandAtTokens("email user@host about @README.md", (path) =>
      path === "README.md" ? "/abs/README.md" : null);
    expect(out).toBe("email user@host about /abs/README.md");
  });

  test("replaces some tokens, leaves others, in one pass", () => {
    const out = expandAtTokens("@a.ts and @b.ts and @c.ts", (path) => {
      if (path === "a.ts") return "/abs/a.ts";
      if (path === "c.ts") return "/abs/c.ts";
      return null;
    });
    expect(out).toBe("/abs/a.ts and @b.ts and /abs/c.ts");
  });

  test("preserves a directory token's trailing slash context via resolver input", () => {
    let sawDirectory = false;
    const out = expandAtTokens("see @src/bun/ files", (path, isDirectory) => {
      sawDirectory = isDirectory;
      return path === "src/bun/" ? "/abs/src/bun" : null;
    });
    expect(sawDirectory).toBe(true);
    expect(out).toBe("see /abs/src/bun files");
  });

  test("text without @ returns the same string instance (fast path)", () => {
    const text = "no tokens here";
    expect(expandAtTokens(text, () => "unused")).toBe(text);
  });
});

describe("a `/` inside an @ query does not trigger the slash menu", () => {
  // Replicates SlashAutocomplete.tsx's `findActiveQuery` guard (BOF or
  // preceded by whitespace) to pin that `@src/bun` never opens the slash
  // popover — the `/` inside it is preceded by non-whitespace ("src"), so
  // the slash trigger's own guard already rejects it.
  function findActiveSlashQuery(
    text: string,
    caret: number,
  ): { start: number; end: number; query: string } | null {
    if (caret === 0) return null;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i]!;
      if (ch === "/") {
        const before = i === 0 ? "" : text[i - 1]!;
        if (i !== 0 && !/\s/.test(before)) return null;
        const query = text.slice(i + 1, caret);
        if (/\s/.test(query)) return null;
        return { start: i, end: caret, query };
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }

  test("@src/bun with caret at the end does not trigger the slash menu", () => {
    const text = "@src/bun";
    expect(findActiveSlashQuery(text, text.length)).toBeNull();
  });
});
