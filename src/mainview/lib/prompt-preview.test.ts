import { describe, expect, test } from "bun:test";
import { promptPreview } from "./prompt-preview.ts";

describe("promptPreview", () => {
  test("skips a heading and a table, keeps the first prose paragraph, strips inline syntax", () => {
    const prompt = "# Spec — X\n| Field | Value |\n| --- | --- |\n\nKeep the **inbox** watched. See [docs](https://x).";
    expect(promptPreview(prompt)).toBe("Keep the inbox watched. See docs.");
  });

  test("drops front matter", () => {
    expect(promptPreview("---\ntitle: x\nstatus: draft\n---\n\nFix the login redirect.")).toBe("Fix the login redirect.");
  });

  test("drops ``` and ~~~ fences, and an unclosed fence drops the rest", () => {
    expect(promptPreview("```bash\nrm -rf /\n```\n\nThen explain it.")).toBe("Then explain it.");
    expect(promptPreview("~~~\ncode\n~~~\n\nAfter the tilde fence.")).toBe("After the tilde fence.");
    expect(promptPreview("Intro line.\n\n```\nnever closed\nstill code")).toBe("Intro line.");
    expect(promptPreview("```\nnever closed\nstill code")).toBe("");
  });

  test("drops horizontal rules and HTML comments", () => {
    expect(promptPreview("<!-- note to self -->\n---\n***\n\nReal ask.")).toBe("Real ask.");
  });

  test("image → alt, inline code → text, list marker and quote marker stripped", () => {
    expect(promptPreview("![diagram](a.png) shows `foo()`")).toBe("diagram shows foo()");
    expect(promptPreview("- first item\n- second item")).toBe("first item second item");
    expect(promptPreview("1. do this\n2) then that")).toBe("do this then that");
    expect(promptPreview("> quoted words")).toBe("quoted words");
  });

  test("a hyphen inside a sentence survives", () => {
    expect(promptPreview("Use a read-only token - not admin.")).toBe("Use a read-only token - not admin.");
  });

  test("a prompt of only a heading and a table falls back to stripped text", () => {
    const out = promptPreview("# Title\n| a | b |\n| --- | --- |");
    expect(out).not.toBe("");
    expect(out).toContain("Title");
    expect(out).not.toContain("#");
    expect(out).not.toContain("|");
  });

  test("empty or whitespace input returns an empty string", () => {
    expect(promptPreview("")).toBe("");
    expect(promptPreview("   \n\t\n")).toBe("");
  });

  test("long prompts cap at 280 chars ending with an ellipsis", () => {
    const out = promptPreview("word ".repeat(2000));
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
  });

  test("never generates markup it did not receive", () => {
    expect(promptPreview("Plain sentence.")).not.toMatch(/</);
  });

  test("normalises CRLF and collapses whitespace", () => {
    expect(promptPreview("line one\r\nline   two")).toBe("line one line two");
  });
});
