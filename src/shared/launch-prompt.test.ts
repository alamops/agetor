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
  test("no block for a missing set or no entries", () => {
    expect(repositoriesPromptBlock(undefined)).toBeNull();
    expect(repositoriesPromptBlock(null)).toBeNull();
    expect(repositoriesPromptBlock({ multiRepo: true, repositories: [] })).toBeNull();
    expect(repositoriesPromptBlock({ multiRepo: true, repositories: null })).toBeNull();
  });

  test("a single-repository task gets no block (its derived entry included)", () => {
    expect(repositoriesPromptBlock({ multiRepo: false, repositories: [repo("app")] })).toBeNull();
    // An older core's JSON with no `multiRepo` falls back to the count.
    expect(repositoriesPromptBlock({ repositories: [repo("app")] })).toBeNull();
  });

  test("a multi task gets the block, one line each", () => {
    expect(repositoriesPromptBlock({ multiRepo: true, repositories: [repo("app"), repo("api", null)] })).toBe(
      "Repositories:\n- app: /ws/app (branch agetor/abc-app)\n- api: /ws/api (branch none yet)",
    );
    expect(repositoriesPromptBlock({ repositories: [repo("app"), repo("api")] })).toBe(
      "Repositories:\n- app: /ws/app (branch agetor/abc-app)\n- api: /ws/api (branch agetor/abc-api)",
    );
  });

  test("a one-repository multi task still gets the block (decided by the task, not the count)", () => {
    expect(repositoriesPromptBlock({ multiRepo: true, repositories: [repo("app")] })).toBe(
      "Repositories:\n- app: /ws/app (branch agetor/abc-app)",
    );
  });
});

describe("composeRunPrompt", () => {
  test("a single-repository launch is exactly the profile-composed prompt", () => {
    expect(composeRunPrompt(profile, "do it", { multiRepo: false, repositories: [repo("app")] })).toBe(
      composeLaunchPrompt(profile, "do it"),
    );
    expect(composeRunPrompt(null, "do it", undefined)).toBe("do it");
  });

  test("a multi-repository launch appends the block after a blank line", () => {
    const set = { multiRepo: true, repositories: [repo("app"), repo("api")] };
    expect(composeRunPrompt(profile, "do it", set)).toBe(
      `${composeLaunchPrompt(profile, "do it")}\n\n${repositoriesPromptBlock(set)}`,
    );
    expect(composeRunPrompt(null, "do it", set)).toBe(
      "do it\n\nRepositories:\n- app: /ws/app (branch agetor/abc-app)\n- api: /ws/api (branch agetor/abc-api)",
    );
  });

  test("a one-repository multi launch appends the block too", () => {
    expect(composeRunPrompt(null, "do it", { multiRepo: true, repositories: [repo("app")] })).toBe(
      "do it\n\nRepositories:\n- app: /ws/app (branch agetor/abc-app)",
    );
  });
});
