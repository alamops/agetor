import { test, expect } from "bun:test";
import { mergeIssueTemplate, parseIssueTemplateFlags } from "./projects.ts";

/**
 * `cmdProjects` obtains its client via `getClient(flags)` (see
 * `add.test.ts`'s header comment), so this suite covers the pure pieces of
 * `agetor projects issue-template`: the flag parser and the edit merge. The
 * client round trip is in `../manage.test.ts`.
 */

// ── parseIssueTemplateFlags ──────────────────────────────────────────────

test("parseIssueTemplateFlags: no flags means show", () => {
  expect(parseIssueTemplateFlags([])).toEqual({});
});

test("parseIssueTemplateFlags: --prompt and --profile", () => {
  expect(parseIssueTemplateFlags(["--prompt", "/acme:cards {number}", "--profile", "Cards"])).toEqual({
    prompt: "/acme:cards {number}",
    profile: "Cards",
  });
});

test("parseIssueTemplateFlags: --prompt-file accepts - for stdin", () => {
  expect(parseIssueTemplateFlags(["--prompt-file", "-"])).toEqual({ promptFile: "-" });
  expect(parseIssueTemplateFlags(["--prompt-file", "/tmp/p.md"])).toEqual({ promptFile: "/tmp/p.md" });
});

test("parseIssueTemplateFlags: --no-profile and --clear", () => {
  expect(parseIssueTemplateFlags(["--no-profile"])).toEqual({ noProfile: true });
  expect(parseIssueTemplateFlags(["--clear"])).toEqual({ clear: true });
});

test("parseIssueTemplateFlags: a missing value throws", () => {
  expect(() => parseIssueTemplateFlags(["--prompt"])).toThrow("'--prompt' needs a value");
  expect(() => parseIssueTemplateFlags(["--profile", "--clear"])).toThrow("'--profile' needs a value");
});

test("parseIssueTemplateFlags: an unknown flag throws the usage line", () => {
  expect(() => parseIssueTemplateFlags(["--promt", "x"])).toThrow("usage: agetor projects issue-template");
});

test("parseIssueTemplateFlags: contradictory pairs throw", () => {
  expect(() => parseIssueTemplateFlags(["--prompt", "x", "--prompt-file", "f"])).toThrow("not both");
  expect(() => parseIssueTemplateFlags(["--profile", "p", "--no-profile"])).toThrow("not both");
  expect(() => parseIssueTemplateFlags(["--clear", "--prompt", "x"])).toThrow("--clear cannot be combined");
  expect(() => parseIssueTemplateFlags(["--no-profile", "--clear"])).toThrow("--clear cannot be combined");
});

// ── mergeIssueTemplate ───────────────────────────────────────────────────

const stored = { prompt: "/acme:cards {number}", agentProfileId: "p1" };

test("mergeIssueTemplate: a new template from a prompt alone has no profile", () => {
  expect(mergeIssueTemplate(null, { prompt: "  go {url}\n" })).toEqual({ prompt: "go {url}", agentProfileId: null });
});

test("mergeIssueTemplate: unset fields keep their stored values", () => {
  expect(mergeIssueTemplate(stored, { prompt: "new" })).toEqual({ prompt: "new", agentProfileId: "p1" });
  expect(mergeIssueTemplate(stored, { agentProfileId: "p2" })).toEqual({ prompt: stored.prompt, agentProfileId: "p2" });
});

test("mergeIssueTemplate: null removes the profile", () => {
  expect(mergeIssueTemplate(stored, { agentProfileId: null })).toEqual({ prompt: stored.prompt, agentProfileId: null });
});

test("mergeIssueTemplate: a profile without any prompt is an error", () => {
  expect(() => mergeIssueTemplate(null, { agentProfileId: "p1" })).toThrow("no issue template yet");
});

test("mergeIssueTemplate: an empty prompt is an error", () => {
  expect(() => mergeIssueTemplate(stored, { prompt: "   " })).toThrow("prompt is empty");
});
