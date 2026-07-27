import { expect, test } from "bun:test";
import { buildResolveConflictsPrompt, type ResolveConflictsPromptInput } from "./resolve-conflicts-prompt.ts";

function input(overrides: Partial<ResolveConflictsPromptInput> = {}): ResolveConflictsPromptInput {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Add widget resizing",
    headRef: "feature/resize",
    baseRef: "main",
    ...overrides,
  };
}

test("prompt includes the head branch as the checked-out branch", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("`feature/resize`");
});

test("prompt includes the base branch as a merge source via origin/<base>", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("origin/main");
});

test("prompt includes the PR number", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("PR #42");
});

test("prompt includes the repo", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("acme/widgets");
});

test("prompt instructs that both branches' changes matter", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("Both branches' changes matter here");
});

test("prompt explicitly instructs not to push", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("Do not push");
});

test("prompt includes a commit instruction referencing the PR number", () => {
  const prompt = buildResolveConflictsPrompt(input());
  expect(prompt).toContain("Commit the merge locally");
  expect(prompt).toContain("references PR #42");
});

test("different inputs produce correspondingly different output", () => {
  const a = buildResolveConflictsPrompt(input());
  const b = buildResolveConflictsPrompt(
    input({
      repo: "other/repo",
      number: 7,
      title: "Fix login bug",
      headRef: "fix/login",
      baseRef: "develop",
    }),
  );

  expect(a).not.toBe(b);
  expect(b).toContain("other/repo");
  expect(b).toContain("PR #7");
  expect(b).toContain("`fix/login`");
  expect(b).toContain("origin/develop");
  expect(b).not.toContain("acme/widgets");
  expect(b).not.toContain("`feature/resize`");
  expect(b).not.toContain("origin/main");
});

test("special characters in title don't break the prompt and core instructions survive", () => {
  const prompt = buildResolveConflictsPrompt(
    input({ title: `Fix "quotes" & <tags> \` backticks \${injection} 100%` }),
  );

  expect(prompt).toContain('Fix "quotes" & <tags> ` backticks ${injection} 100%');
  expect(prompt).toContain("PR #42");
  expect(prompt).toContain("Both branches' changes matter here");
  expect(prompt).toContain("Do not push");
  expect(prompt).toContain("Commit the merge locally");
});
