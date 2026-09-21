import { describe, expect, test } from "bun:test";
import { ELI5_FILENAME, buildEli5Prompt, eli5TaskTitle } from "./clone-eli5.ts";

describe("buildEli5Prompt / eli5TaskTitle", () => {
  test("prompt names the file, the repo, and forbids commits", () => {
    const prompt = buildEli5Prompt("myrepo");
    expect(prompt).toContain(ELI5_FILENAME);
    expect(prompt).toContain("myrepo");
    expect(prompt).toContain("do not commit");
  });

  test("title is stable and carries the repo name", () => {
    expect(eli5TaskTitle("myrepo")).toBe("ELI5: myrepo");
  });
});
