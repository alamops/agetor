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

  test("the cap never splits an emoji's surrogate pair", () => {
    // 278 ASCII characters put the emoji's high surrogate at index 278, the
    // last code unit a 279-unit cut keeps.
    const out = promptPreview(`${"a".repeat(278)}😀 more words after the emoji`);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.length).toBeLessThanOrEqual(280);
  });

  test("a huge unbroken paragraph stays fast and still previews its start", () => {
    for (const unit of ["word ", "*a ", "_b ", "[x](y "]) {
      const start = performance.now();
      const out = promptPreview(unit.repeat(100_000));
      expect(performance.now() - start).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(280);
      expect(out.endsWith("…")).toBe(true);
    }
  });

  test("a paragraph of long links still fills the preview", () => {
    const link = `[label](https://example.com/${"p".repeat(120)}) `;
    const out = promptPreview(link.repeat(200));
    expect(out.startsWith("label label label")).toBe(true);
    expect(out.length).toBeGreaterThan(200);
  });

  test("a link, image or code span longer than the prefix is not cut open", () => {
    const url = `https://example.com/${"p".repeat(2500)}`;
    expect(promptPreview(`See [the log](${url}) and [the trace](${url}) for details.`)).toBe("See the log and the trace for details.");
    expect(promptPreview(`See ![the chart](${url}) for details.`)).toBe("See the chart for details.");
    expect(promptPreview(`Run \`${"x ".repeat(1200)}\` then stop.`)).toStartWith("Run x x x");
    expect(promptPreview(`Run \`${"x ".repeat(1200)}\` then stop.`)).not.toContain("`");
    // The 2,240-char cut falls in the URL (a short label, a long URL).
    for (let n = 2215; n <= 2245; n++) {
      expect(promptPreview(`[label](https://e.com/${"p".repeat(n)}) tail`)).toBe("label tail");
    }
  });

  test("a link whose text is longer than the prefix is not cut open", () => {
    // The 2,240-char cut falls inside the link text, on `]` (n = 2238 puts `]` at
    // index 2239) and between `]` and `(`. A cut link would show as `[aaa…`.
    for (let n = 2230; n <= 2245; n++) {
      const out = promptPreview(`[${"a".repeat(n)}](https://e.com/x) tail`);
      expect(out).toBe(`${"a".repeat(279)}…`);
    }
    const spaced = promptPreview(`[${"a ".repeat(1500)}](https://e.com/x) tail`);
    expect(spaced).not.toMatch(/[[\]()]/);
    expect(spaced.startsWith("a a a")).toBe(true);
  });

  test("a code span that closes far past the prefix stays bounded, emphasis-heavy or not", () => {
    // The closer is beyond the lookahead, so the cut stays; the emphasis pattern
    // is quadratic, so chasing a closer 150 KB away would take seconds.
    for (const unit of ["*a ", "_b ", "p"]) {
      const start = performance.now();
      const out = promptPreview(`Run \`${unit.repeat(50_000)}\` tail`);
      expect(performance.now() - start).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(280);
    }
  });

  test("an unclosed link or code span far past the prefix stays bounded", () => {
    for (const unit of ["[a](", "`"]) {
      const start = performance.now();
      const out = promptPreview(`${unit}${"p".repeat(400_000)}`);
      expect(performance.now() - start).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(280);
    }
  });

  test("never generates markup it did not receive", () => {
    expect(promptPreview("Plain sentence.")).not.toMatch(/</);
  });

  test("normalises CRLF and collapses whitespace", () => {
    expect(promptPreview("line one\r\nline   two")).toBe("line one line two");
  });
});
