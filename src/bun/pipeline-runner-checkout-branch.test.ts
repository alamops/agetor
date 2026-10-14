import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { PipelineRunState } from "../shared/types.ts";

// The pipeline parent carries the shared worktree's last-seen checkout; step
// rows mirror it (docs/plans/codex-terminal-worktree-error.md T6/U6, D14).

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-checkout-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const parents: string[] = [];

beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

afterAll(async () => {
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of parents) await deleteTask(id).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-checkout-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A one-step worktree pipeline task (not started). */
async function onePipelineTask(stepInstructions: string) {
  const { createTask } = await import("./orchestrator.ts");
  const { agentProfiles, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const profile = agentProfiles.insert({
    name: `checkout-${randomUUID()}`, harness: "claude-code", model: "fake-model", effort: null, mode: null,
    fast: false, maxMode: false, instructions: "", skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: stepInstructions });
  const pipeline = pipelines.insert({
    name: `checkout-pipeline-${randomUUID()}`,
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: "checkout pipeline", prompt: "goal", workdir: await makeRepo(), isolation: "worktree", pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  parents.push(created.task.id);
  return created.task.id;
}

test("a step's run start/settle writes the parent; refresh on a drifted worktree records it without a checkout; steps mirror it", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const parentId = await onePipelineTask(`${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  const [step] = tasks.stepsForParent(parentId);
  expect(step).toBeDefined();
  // The step's own run start recorded the checkout, mirrored onto the parent.
  expect(done.checkoutBranch).toBe(done.branch);
  expect(step!.checkoutBranch).toBe(done.branch);

  const wt = done.worktreePath!;
  await git(["checkout", "-b", "implement/x"], wt);
  writeFileSync(path.join(wt, "README"), "uncommitted conflicting edit\n");

  // Nothing live → the full prepare path runs. It must reuse in place (no
  // checkout) and record the live branch on the parent.
  const refreshed = await __forTest.refreshParentWorktree(done, done.pipelineRun!);
  if ("error" in refreshed) throw new Error(refreshed.error);
  expect(await git(["symbolic-ref", "--short", "HEAD"], wt)).toBe("implement/x");
  expect(refreshed.parent.branch).toBe(done.branch);
  expect(refreshed.parent.checkoutBranch).toBe("implement/x");

  // Steps still active get the parent's value copied down.
  const runWithActive = {
    ...done.pipelineRun!,
    active: [{ taskId: step!.id, stepId: step!.pipelineStepId!, seq: 1 }],
  } as unknown as PipelineRunState;
  __forTest.propagateWorktreeToActiveSteps(refreshed.parent, runWithActive);
  expect(tasks.get(step!.id)?.checkoutBranch).toBe("implement/x");
});

test("a step settle observes a branch switched mid-turn and mirrors it onto the parent", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const parentId = await onePipelineTask(`${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`);
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "1500";
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const step = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.column === "running"));
    const parent = tasks.get(parentId)!;
    expect(parent.checkoutBranch).toBe(parent.branch);
    await git(["checkout", "-b", "implement/mid-turn"], step.worktreePath!);
    await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
    await waitFor(() => tasks.get(parentId)?.checkoutBranch === "implement/mid-turn");
    expect(tasks.get(step.id)?.checkoutBranch).toBe("implement/mid-turn");
    expect(tasks.get(parentId)?.branch).toBe(parent.branch);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});
