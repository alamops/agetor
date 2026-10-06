import { describe, expect, test } from "bun:test";
import { shellQuote, shellWord } from "./shell-quote.ts";

describe("shellQuote", () => {
  test("single-quotes, escaping embedded single quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("shellWord", () => {
  test("leaves an ordinary id bare", () => {
    expect(shellWord("secondary-claude-code")).toBe("secondary-claude-code");
    expect(shellWord("acct=work")).toBe("acct=work");
  });

  test("quotes anything a shell would act on", () => {
    expect(shellWord("$(touch /tmp/pwned)")).toBe("'$(touch /tmp/pwned)'");
    expect(shellWord("a b")).toBe("'a b'");
    expect(shellWord("`id`")).toBe("'`id`'");
    expect(shellWord("x;rm -rf ~")).toBe("'x;rm -rf ~'");
    expect(shellWord("o'clock")).toBe("'o'\\''clock'");
    expect(shellWord("")).toBe("''");
  });

  test("quotes a leading '=', which zsh expands as a command lookup", () => {
    expect(shellWord("=ls")).toBe("'=ls'");
    expect(shellWord("=")).toBe("'='");
    // An '=' anywhere else stays bare.
    expect(shellWord("a=b=c")).toBe("a=b=c");
  });
});
