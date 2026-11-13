import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// A Stop on a FAILED turn whose background agents still run (the card is
// `blocked`, the run `failed`) normally interrupts the REPL and ends the agent
// rows (`stopHeldTask`). When a start already holds the task's claim and has
// not minted its run yet (a Run's pre-flight; codex awaits its per-model CLI
// floor probe there), the Stop is meant for the turn that start is about to
// launch: it must be recorded against the claim so that turn is cancelled,
// not spent on an interrupt the new turn then runs past.

// db.ts captures AGETOR_DATA_DIR at first import: set it (and the fake-driver
// env) before any dynamic import touches db.ts/orchestrator.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-hold-scope-claim-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_CODEX_DRIVER", "AGETOR_CODEX_BIN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_DRIVER = "fake";

// `codex --version` sleeps first: that sleep is the claim window under test.
const BIN_DIR = mkdtempSync(path.join(tmpdir(), "agetor-hold-scope-claim-bin-"));
const PROBE_SLEEP_S = 0.8;
writeFileSync(
  path.join(BIN_DIR, "codex"),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then sleep ${PROBE_SLEEP_S}; echo "codex-cli 0.200.0"; fi\nexit 0\n`,
  { mode: 0o755 },
);
process.env.AGETOR_CODEX_BIN = path.join(BIN_DIR, "codex");

const MODEL = "gpt-5.6-sol";
const FLOOR = "0.150.0";
let previousFloor: string | undefined;
let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");
let restoreHarnesses: () => void;

beforeAll(async () => {
  db = await import("./db.ts");
  restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  // codex ships disabled by default (migration 016).
  db.harnesses.setEnabled("codex", true);
  const { MODEL_MIN_CLI_VERSION } = await import("../shared/types.ts");
  const codexFloors = MODEL_MIN_CLI_VERSION.codex as Record<string, string>;
  previousFloor = codexFloors[MODEL];
  codexFloors[MODEL] = FLOOR;
});

afterAll(async () => {
  const { MODEL_MIN_CLI_VERSION } = await import("../shared/types.ts");
  const codexFloors = MODEL_MIN_CLI_VERSION.codex as Record<string, string>;
  if (previousFloor === undefined) delete codexFloors[MODEL];
  else codexFloors[MODEL] = previousFloor;
  for (const t of db.tasks.list()) await orch.deleteTask(t.id).catch(() => {});
  await Bun.sleep(150);
  restoreHarnesses();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(BIN_DIR, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await Bun.sleep(10);
  }
  return fn();
}

test("Stop on a failed card with running background agents, while a Run holds the start claim, cancels the turn that start mints (A2)", async () => {
  const taskId = randomUUID();
  const workdir = mkdtempSync(path.join(DATA_DIR, "wd-"));
  db.tasks.insert({
    id: taskId, title: "hold scope claim", prompt: "work", agent: "codex", workdir, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: MODEL, effort: "high", speed: "off", maxMode: false,
    opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null,
    column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
  } as never);
  // The turn failed (card blocked) while a background agent kept running.
  const failedRunId = randomUUID();
  db.runs.insert({
    id: failedRunId, taskId, agent: "codex", status: "failed", startedAt: Date.now() - 1000, endedAt: Date.now() - 900,
    exitCode: 1, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null, antigravitySessionId: null,
  } as never);
  db.tasks.update(taskId, { runId: failedRunId, column: "blocked" });
  const subagentId = `agent-${randomUUID()}`;
  db.subagents.insertIfAbsent({
    id: subagentId, taskId, runId: failedRunId, parentKind: "subagent", agentType: "general-purpose",
    description: "background review", spawnDepth: 1, sourcePath: path.join(DATA_DIR, `${subagentId}.jsonl`),
    status: "running", startedAt: Date.now() - 1000, endedAt: null,
  } as never);
  expect(orch.backgroundAgentsHoldTask(taskId)).toBe(true);

  // Retry on the blocked card: the start holds the claim through the floor
  // probe, before any run row exists.
  const started = orch.startTask(taskId);
  expect(await waitFor(() => orch.isTaskRunLive(taskId) && db.runs.listForTask(taskId).length === 1)).toBe(true);
  expect(orch.backgroundAgentsHoldTask(taskId)).toBe(true);

  // The UI's Stop names the card's current (failed) run.
  expect(await orch.cancelRun(failedRunId)).toBe(true);
  // Not spent on the REPL: the agents were not interrupted ahead of the turn.
  expect(db.subagents.hasRunning(taskId)).toBe(true);

  const result = await started;
  expect(result).not.toHaveProperty("error");
  expect(await waitFor(() => {
    const minted = db.runs.listForTask(taskId).find((r) => r.id !== failedRunId);
    return minted != null && minted.status !== "running";
  })).toBe(true);
  const minted = db.runs.listForTask(taskId).find((r) => r.id !== failedRunId)!;
  expect(minted.status).toBe("cancelled");
  expect(db.tasks.get(taskId)!.column).toBe("ready");

  db.subagents.setStatus(subagentId, "completed", Date.now());
}, 30_000);
