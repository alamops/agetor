import { describe, expect, test } from "bun:test";
import { composeRunPrompt, repositoriesPromptBlock } from "./launch-prompt.ts";
import { composeLaunchPrompt } from "./agent-profile.ts";
import type { TaskRepository } from "./types.ts";

const repo = (name: string, branch: string | null = `agetor/abc-${name}`): TaskRepository => ({
  path: `/src/${name}`,
  name,
  branch,
  branchSource: "created",
  worktreePath: `/ws/${name}`,
  baseRef: null,
  checkoutBranch: null,
  prUrl: null,
});

const profile = { instructions: "Be terse.", skills: ["review"] };

describe("repositoriesPromptBlock", () => {
  test("no block for zero or one repository", () => {
    expect(repositoriesPromptBlock(undefined)).toBeNull();
    expect(repositoriesPromptBlock(null)).toBeNull();
    expect(repositoriesPromptBlock([])).toBeNull();
    expect(repositoriesPromptBlock([repo("app")])).toBeNull();
  });

  test("two or more repositories get the block, one line each", () => {
    expect(repositoriesPromptBlock([repo("app"), repo("api", null)])).toBe(
      "Repositories:\n- app: /ws/app (branch agetor/abc-app)\n- api: /ws/api (branch none yet)",
    );
  });
});

describe("composeRunPrompt", () => {
  test("a single-repository launch is exactly the profile-composed prompt", () => {
    expect(composeRunPrompt(profile, "do it", [repo("app")])).toBe(composeLaunchPrompt(profile, "do it"));
    expect(composeRunPrompt(null, "do it", undefined)).toBe("do it");
  });

  test("a multi-repository launch appends the block after a blank line", () => {
    const repos = [repo("app"), repo("api")];
    expect(composeRunPrompt(profile, "do it", repos)).toBe(
      `${composeLaunchPrompt(profile, "do it")}\n\n${repositoriesPromptBlock(repos)}`,
    );
    expect(composeRunPrompt(null, "do it", repos)).toBe(
      "do it\n\nRepositories:\n- app: /ws/app (branch agetor/abc-app)\n- api: /ws/api (branch agetor/abc-api)",
    );
  });
});
