import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Only AGETOR_DATA_DIR belongs at module top level: db.ts captures it at first
// import, `beforeAll` would race a sibling that already imported db.ts, and the
// value is unique per file so nobody inherits it harmfully. Same convention as
// subagent-hold.test.ts / subagent-settle.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));

// Every OTHER override is scoped to this file and restored afterwards — see
// subagent-hold.test.ts's header comment for why a top-level `process.env.X =`
// would leak into sibling test files sharing this one `bun test` process.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake", // in-process fake instead of tmux + the real CLI
  AGETOR_CLAUDE_BIN: "/bin/echo", // agent-status preflight passes without claude
  AGETOR_TMUX_BIN: "/bin/echo", // tmux probe in agent-status passes
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_CODEX_DRIVER: "fake", // only the codex-inert regression test needs this
  AGETOR_CODEX_BIN: "/bin/echo",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // Importing orchestrator.ts is what installs the REAL
  // `setSubagentSettleHook(maybeReleaseHeldTask)`,
  // `setParkedDiscoveryHandler(pullBackParkedTask)`, and
  // `setBackgroundTaskSettledHandler((_taskId, agentId) =>
  // settleSubagentById(agentId, "completed"))` wiring at module load — the
  // seams every scenario below drives through rather than importing any
  // orchestrator-private function directly.
  await import("./orchestrator.ts");
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

/*
 * Covers TT2 (docs/plans/claude-code-workflows-as-running-bg-agents.md, §5
 * TT2): the orchestrator-level hold/release behavior for Claude Code Workflow
 * (`/workflow`) container rows — `parentKind: "workflow"` — and their
 * `workflow_agent` children, as implemented in claude-subagents.ts by
 * commits 186a156 / 897ef10.
 *
 * A workflow is modeled as a CONTAINER row (holds the task in `running` for
 * the workflow's whole lifetime) plus per-agent `workflow_agent` rows (read-
 * only tab streams). This file seeds both kinds directly via
 * `subagents.insertIfAbsent` — exactly like subagent-hold.test.ts seeds a
 * plain `subagent` row — rather than materializing real workflow transcript
 * files, since the hold/release/cascade/notification logic under test here
 * never reads file contents for a container (it's directory-backed, never
 * tailed) and only path-compares `sourcePath` for the cascade.
 *
 * IMPORTANT — shared-DB hygiene (see the module CLAUDE.md and
 * subagent-hold.test.ts's header): `bun test` runs every `*.test.ts` in one
 * process against one SQLite DB, and boot-style reconciliation sweeps scan
 * globally. Every task created here is tracked and hard-deleted in
 * `afterEach` (FK ON DELETE CASCADE covers runs/subagents/run_events), and
 * every run row this file seeds (via the real `startTask` + fake driver) is
 * terminal by the time each test's assertions run.
 */

const createdTaskIds: string[] = [];

afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createClaudeTask(title: string): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo during tests
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

/** Seed a `parentKind: "workflow"` CONTAINER row, `running`, the way
 *  `registerWorkflowContainer` would (minus the file-backed transcript dir
 *  actually existing on disk — nothing here reads it). `sourcePath` is a real
 *  temp directory so `isInsideDir` path-comparisons in the cascade behave
 *  exactly as they would for a genuine workflow. */
async function insertRunningContainer(taskId: string, dir: string, id?: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const containerId = id ?? `wtask-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: containerId,
    taskId,
    runId: null, // the gate only keys off task_id — see subagents.hasRunning
    parentKind: "workflow",
    agentType: "workflow",
    description: "test workflow",
    spawnDepth: 1,
    sourcePath: dir,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return containerId;
}

/** Seed a `parentKind: "workflow_agent"` row whose `sourcePath` lives INSIDE
 *  `dir` (the container's transcript dir), matching the real on-disk layout
 *  (`<transcriptDir>/agent-<agentId>.jsonl`) that `cascadeWorkflowAgents`'s
 *  `isInsideDir` containment check relies on. */
async function insertRunningWorkflowAgent(taskId: string, dir: string, id?: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const agentId = id ?? `wagent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: agentId,
    taskId,
    runId: null,
    parentKind: "workflow_agent",
    agentType: "workflow-subagent",
    description: "test workflow agent",
    spawnDepth: 1,
    sourcePath: path.join(dir, `agent-${agentId}.jsonl`),
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return agentId;
}

function mkWorkflowDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-wf-"));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Basic hold + settle
 * ────────────────────────────────────────────────────────────────────────── */

test("hold: a running workflow container row keeps the task in running after its terminal run succeeds; settling it releases to review", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("wf-hold-basic");
  const dir = mkWorkflowDir();
  const containerId = await insertRunningContainer(taskId, dir);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  // Held shape: column running, terminal run succeeded, a running background
  // (container) row — exactly what isHeldByBackgroundAgents requires.
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  const changed = settleSubagentById(containerId, "completed");
  expect(changed).toBe(true);

  expect(subagents.get(containerId)?.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Cascade: container settle takes its running agents with it, one hook fire
 * ────────────────────────────────────────────────────────────────────────── */

test("cascade: settling the container settles both running workflow_agent rows, and the settle hook fires exactly once, after everything is already settled", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById, setSubagentSettleHook } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("wf-cascade");
  const dir = mkWorkflowDir();
  const containerId = await insertRunningContainer(taskId, dir);
  const agentA = await insertRunningWorkflowAgent(taskId, dir);
  const agentB = await insertRunningWorkflowAgent(taskId, dir);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Wrap the real hook (read-modify-restore, same idiom as
  // setSubagentEmitter/setSubagentSettleHook elsewhere) to observe what the
  // orchestrator's release predicate sees at the moment it fires.
  let hookCallsForTask = 0;
  let hookSawFullySettled: boolean | undefined;
  const prevHook = setSubagentSettleHook((tid) => {
    if (tid === taskId) {
      hookCallsForTask++;
      hookSawFullySettled = !subagents.hasRunning(taskId);
    }
    prevHook?.(tid);
  });
  try {
    const changed = settleSubagentById(containerId, "completed");
    expect(changed).toBe(true);
  } finally {
    setSubagentSettleHook(prevHook);
  }

  expect(subagents.get(containerId)?.status).toBe("completed");
  expect(subagents.get(agentA)?.status).toBe("completed");
  expect(subagents.get(agentB)?.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);

  // The cascade settles both agent rows at depth 1 (no hook fire each); only
  // the outermost, depth-0 settle of the container fires the hook — once —
  // and by the time it does, nothing is left running.
  expect(hookCallsForTask).toBe(1);
  expect(hookSawFullySettled).toBe(true);

  expect(tasks.get(taskId)?.column).toBe("review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Parked-discovery: a freshly-registered container pulls a review card back
 * ────────────────────────────────────────────────────────────────────────── */

test("parked-discovery: a container registered while the card is parked in review pulls it back to running", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { setParkedDiscoveryHandler, settleSubagentById } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("wf-parked");

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  // No container yet — the run settles straight to review, the "parked"
  // shape pullBackParkedTask requires (column review, latest run succeeded).
  expect(tasks.get(taskId)?.column).toBe("review");

  const dir = mkWorkflowDir();
  const containerId = await insertRunningContainer(taskId, dir);

  // `pullBackParkedTask` isn't exported from orchestrator.ts — it's installed
  // once, at module load, via `setParkedDiscoveryHandler`. Capture the
  // currently-registered (real) handler through that seam — read-modify-
  // restore, same idiom subagent-settle.test.ts uses for the same handler —
  // then call it directly with taskId, exactly what
  // `registerWorkflowContainer` does (via `fireParkedDiscovery`) right after
  // inserting a fresh container row.
  const real = setParkedDiscoveryHandler(() => {});
  setParkedDiscoveryHandler(real);
  if (!real) throw new Error("expected orchestrator.ts to have installed a real parked-discovery handler");

  real(taskId);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Hygiene: leave nothing running for this task.
  settleSubagentById(containerId, "completed");
  expect(tasks.get(taskId)?.column).toBe("review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. orphanRunningSubagents releases the hold and orphans container + agents
 * ────────────────────────────────────────────────────────────────────────── */

test("orphan: orphanRunningSubagents flips the container and its agent rows to orphaned and releases the hold", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { orphanRunningSubagents } = await import("./claude-subagents.ts");

  const taskId = await createClaudeTask("wf-orphan");
  const dir = mkWorkflowDir();
  const containerId = await insertRunningContainer(taskId, dir);
  const agentA = await insertRunningWorkflowAgent(taskId, dir);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  orphanRunningSubagents(taskId);

  const container = subagents.get(containerId);
  const agent = subagents.get(agentA);
  expect(container?.status).toBe("orphaned");
  expect(container?.endedAt).not.toBeNull();
  expect(agent?.status).toBe("orphaned");
  expect(agent?.endedAt).not.toBeNull();

  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. Regression guard: codex is completely unaffected by the workflow gate
 * ────────────────────────────────────────────────────────────────────────── */

test("regression guard: a codex task with no subagent rows settles straight to review — the workflow gate is inert for codex", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");

  // Fresh test DBs ship codex disabled by default (migration
  // 016_disable_codex.sql) — enable it for this test only and restore.
  const prevEnabled = harnesses.get("codex")?.enabled ?? false;
  harnesses.setEnabled("codex", true);
  try {
    const created = await createTask({
      title: "wf-codex-inert",
      prompt: "hello",
      agent: "codex",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    createdTaskIds.push(created.task.id);
    const taskId = created.task.id;

    // Codex never writes subagent rows and launches no workflows, so the
    // hold gate is inert by construction — no need to seed anything.
    const res = await startTask(taskId);
    if (!("runId" in res)) throw new Error("expected the run to start");
    await wait(250);

    expect(tasks.get(taskId)?.column).toBe("review");
  } finally {
    harnesses.setEnabled("codex", prevEnabled);
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. The live notification seam end-to-end
 * ────────────────────────────────────────────────────────────────────────── */

test("notification: the real setBackgroundTaskSettledHandler wiring settles a container and releases the hold, exactly like a live <task-notification> line would", async () => {
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, subagents } = await import("./db.ts");
  const { setBackgroundTaskSettledHandler } = await import("./claude-tmux.ts");

  const taskId = await createClaudeTask("wf-notification");
  const dir = mkWorkflowDir();
  const containerId = await insertRunningContainer(taskId, dir);

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the run to start");
  await wait(250);

  expect(tasks.get(taskId)?.column).toBe("running");
  expect(subagents.hasRunning(taskId)).toBe(true);

  // Grab the REAL handler orchestrator.ts wired at module load —
  //   (taskId, agentId, body) => handleBackgroundTaskNotification(taskId, agentId, body)
  // — through the setBackgroundTaskSettledHandler seam (read-modify-restore),
  // then invoke it with (taskId, containerId, payload): this is exactly what
  // claude-tmux's dispatchLine does when it parses a live
  // `<task-notification><task-id>…</task-id></task-notification>` line whose
  // id matches the workflow's container row. For a non-monitor row any
  // notification naming the id is the completion receipt, so the body's
  // contents don't gate the settle — it's passed for shape fidelity.
  const real = setBackgroundTaskSettledHandler(() => {});
  setBackgroundTaskSettledHandler(real);
  if (!real) throw new Error("expected orchestrator.ts to have installed a real background-task-settled handler");

  real(
    taskId,
    containerId,
    `<task-notification>\n<task-id>${containerId}</task-id>\n<status>completed</status>\n<summary>Workflow finished</summary>\n</task-notification>`,
  );

  expect(subagents.get(containerId)?.status).toBe("completed");
  expect(subagents.hasRunning(taskId)).toBe(false);
  expect(tasks.get(taskId)?.column).toBe("review");
});
