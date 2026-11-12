import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentProfileSnapshot, Task, TaskRepository } from "../shared/types.ts";
import { repositoriesForTask } from "../shared/multi-repo.ts";
import { GEMINI_PROMPT_ARGV_MAX_BYTES } from "../shared/prompt-limits.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-repos-fixes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const { db, tasks } = await import("./db.ts");

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp/frontend",
    isolation: "worktree",
    taskType: "task",
    branch: "feature/x",
    branchSource: "created",
    worktreePath: null,
    baseRef: "abc",
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

const repo = (name: string, over: Partial<TaskRepository> = {}): TaskRepository => ({
  path: `/tmp/${name}`,
  name,
  branch: "feature/x",
  branchSource: "created",
  worktreePath: `/data/worktrees/t/${name}`,
  baseRef: "abc",
  checkoutBranch: "feature/x",
  prUrl: null,
  ...over,
});

const updatedAt = (id: string): number =>
  db.query<{ updated_at: number }, [string]>(`SELECT updated_at FROM tasks WHERE id = ?`).get(id)!.updated_at;

const checkoutOf = (id: string, name: string): string | null | undefined =>
  tasks.get(id)?.repositories?.find((r) => r.name === name)?.checkoutBranch;

describe("S7: setRepositoryCheckout mirrors a step's observation to its pipeline parent", () => {
  test("a step write lands on the parent's entry of the same name, without bumping updated_at", () => {
    const parent = makeTask({ repositories: [repo("frontend"), repo("backend")] });
    tasks.insert(parent);
    const step = makeTask({ repositories: [repo("frontend"), repo("backend")], pipelineParentId: parent.id });
    tasks.insert(step);
    const parentStamp = updatedAt(parent.id);
    const stepStamp = updatedAt(step.id);

    const got = tasks.setRepositoryCheckout(step.id, "backend", "hotfix/y");
    expect(got?.repositories?.find((r) => r.name === "backend")?.checkoutBranch).toBe("hotfix/y");
    expect(checkoutOf(parent.id, "backend")).toBe("hotfix/y");
    // The other entry is untouched on both rows.
    expect(checkoutOf(step.id, "frontend")).toBe("feature/x");
    expect(checkoutOf(parent.id, "frontend")).toBe("feature/x");
    // Server-managed column: neither row's updated_at moves.
    expect(updatedAt(parent.id)).toBe(parentStamp);
    expect(updatedAt(step.id)).toBe(stepStamp);

    // A detached observation (null) mirrors too, same as setCheckoutBranch.
    tasks.setRepositoryCheckout(step.id, "backend", null);
    expect(checkoutOf(parent.id, "backend")).toBeNull();

    tasks.delete(step.id);
    tasks.delete(parent.id);
  });

  test("an unchanged value writes nothing, and a parent without that entry is left alone", () => {
    const parent = makeTask({ repositories: [repo("frontend"), repo("backend")] });
    tasks.insert(parent);
    const step = makeTask({
      repositories: [repo("frontend"), repo("backend"), repo("docs")],
      pipelineParentId: parent.id,
    });
    tasks.insert(step);
    const before = db
      .query<{ repositories: string }, [string]>(`SELECT repositories FROM tasks WHERE id = ?`)
      .get(parent.id)!.repositories;

    tasks.setRepositoryCheckout(step.id, "docs", "docs/z");
    expect(checkoutOf(step.id, "docs")).toBe("docs/z");
    const after = db
      .query<{ repositories: string }, [string]>(`SELECT repositories FROM tasks WHERE id = ?`)
      .get(parent.id)!.repositories;
    expect(after).toBe(before);

    tasks.delete(step.id);
    tasks.delete(parent.id);
  });

  test("a task that is not a pipeline step only writes its own row", () => {
    const other = makeTask({ repositories: [repo("frontend"), repo("backend")] });
    tasks.insert(other);
    const lone = makeTask({ repositories: [repo("frontend"), repo("backend")] });
    tasks.insert(lone);
    tasks.setRepositoryCheckout(lone.id, "frontend", "spike/q");
    expect(checkoutOf(lone.id, "frontend")).toBe("spike/q");
    expect(checkoutOf(other.id, "frontend")).toBe("feature/x");
    expect(tasks.setRepositoryCheckout(randomUUID(), "frontend", "x")).toBeNull();
    tasks.delete(lone.id);
    tasks.delete(other.id);
  });
});

describe("S22: a single-repository row derives its entry through repositoriesForTask", () => {
  test("the stored row and the shared helper agree field for field", () => {
    const t = makeTask({
      workdir: "/tmp/My Repo",
      worktreePath: "/data/worktrees/x",
      branchSource: "existing",
      checkoutBranch: "drifted/b",
      prUrl: "https://gh/pr/9",
    });
    tasks.insert(t);
    const got = tasks.get(t.id)!;
    expect(got.repositories).toEqual(repositoriesForTask({ ...got, repositories: [] }));
    expect(got.repositories?.[0]).toEqual({
      path: "/tmp/My Repo",
      name: "my-repo",
      branch: "feature/x",
      branchSource: "existing",
      worktreePath: "/data/worktrees/x",
      baseRef: "abc",
      checkoutBranch: "drifted/b",
      prUrl: "https://gh/pr/9",
    });
    tasks.delete(t.id);
  });

  test("db.ts carries no copy of the derivation", async () => {
    const src = await Bun.file(new URL("./db.ts", import.meta.url)).text();
    expect(src).toContain("repositoriesForTask(");
    expect(src).not.toContain("repoNameForPath(");
  });
});

describe("N8: a pipeline step's argv budget includes the Repositories: block", () => {
  const profile = {
    harnessKind: "gemini",
    instructions: "",
    skills: [],
  } as unknown as AgentProfileSnapshot;
  const repos = [repo("frontend"), repo("backend")];

  test("a prompt that fits alone but not with the block is over budget for a multi-repository step", async () => {
    const { stepLaunchPromptOverage } = await import("./pipeline-runner.ts");
    // Exactly at the cap on its own: no overage without the block.
    const prompt = "x".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES);
    expect(stepLaunchPromptOverage(profile, prompt, [], { multiRepo: false, repositories: [repos[0]!] })).toBeNull();
    expect(stepLaunchPromptOverage(profile, prompt, [], undefined)).toBeNull();
    const over = stepLaunchPromptOverage(profile, prompt, [], { multiRepo: true, repositories: repos });
    expect(over).not.toBeNull();
    expect(over!.limit).toBe(GEMINI_PROMPT_ARGV_MAX_BYTES);
    expect(over!.bytes).toBeGreaterThan(GEMINI_PROMPT_ARGV_MAX_BYTES);
    // A one-repository multi step carries the block too (decided by the task).
    expect(stepLaunchPromptOverage(profile, prompt, [], { multiRepo: true, repositories: [repos[0]!] })).not.toBeNull();
  });

  test("an uncapped harness is never over budget", async () => {
    const { stepLaunchPromptOverage } = await import("./pipeline-runner.ts");
    const claude = { ...profile, harnessKind: "claude-code" } as AgentProfileSnapshot;
    expect(stepLaunchPromptOverage(claude, "x".repeat(100_000), [], { multiRepo: true, repositories: repos })).toBeNull();
  });
});
