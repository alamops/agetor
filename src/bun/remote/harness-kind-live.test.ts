// S4, the production wiring: a task's `agent` is a harness id, and every live read the phone side makes resolves it to its KIND before the
// kind-keyed rules run. The router's task lookup (autonomy, the unlock window), the terminal's task lookup and the content behind a terminal
// challenge all go through the real task store here; harness-kind.test.ts covers the resolver itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `bun test` runs every file in one process: what this file sets is put back after it (the data dir is the exception, `db.ts` keeps the first
// one it opened).
const ENV_KEYS = ["AGETOR_DATA_DIR", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_CLAUDE_ARGS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const DATA = mkdtempSync(path.join(tmpdir(), "agetor-harness-kind-live-"));
process.env.AGETOR_DATA_DIR = DATA;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
// `tmux has-session` through /bin/echo exits 0: every derived session name counts as alive, so only the kind decides.
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

const SECOND_CLAUDE = "claude-live-second";
const SECOND_CURSOR = "cursor-live-second";
let restoreHarnesses: () => void = () => undefined;

beforeAll(async () => {
  const dbm = await import("../db.ts");
  const { snapshotHarnessState } = await import("../test-harness-state.ts");
  restoreHarnesses = snapshotHarnessState();
  dbm.harnesses.insert({ id: SECOND_CLAUDE, kind: "claude-code", label: "Claude (second account)" });
  dbm.harnesses.insert({ id: SECOND_CURSOR, kind: "cursor", label: "Cursor (second account)" });
});
afterAll(async () => {
  restoreHarnesses();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  const { rmTestDataDir } = await import("../test-data-dir.ts");
  rmTestDataDir(DATA);
});

/** A task created on the built-in Claude row, then moved to `harnessId` (a second account), as a harness switch does. */
async function taskOn(harnessId: string, mode: string | null = null): Promise<string> {
  const { createTask } = await import("../orchestrator.ts");
  const { tasks } = await import("../db.ts");
  const created = await createTask({ title: `on ${harnessId}`, prompt: "p", agent: "claude-code", workdir: mkdtempSync(path.join(tmpdir(), "agetor-hk-wd-")), isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  tasks.update(created.task.id, { agent: harnessId, ...(mode ? { mode } : {}) });
  expect(tasks.get(created.task.id)!.agent).toBe(harnessId);
  return created.task.id;
}

describe("the live reads resolve a second account to its kind", () => {
  test("the router's task lookup: a second Claude account in Plan mode reads as claude-code, so content sent into it asks first", async () => {
    const { createLiveLookups } = await import("./router.ts");
    const { runsWithoutAsking } = await import("./autonomy.ts");
    const lookups = createLiveLookups();
    const plan = await taskOn(SECOND_CLAUDE, "plan");
    const t = await lookups.task(plan);
    expect(t).toMatchObject({ agent: "claude-code", mode: "plan" });
    expect(runsWithoutAsking(t!)).toBe(false);
    // the same account in Auto mode runs without asking (the unlock window applies)
    const auto = await taskOn(SECOND_CLAUDE, "auto");
    expect(runsWithoutAsking((await lookups.task(auto))!)).toBe(true);
    expect(await lookups.task("no-such-task")).toBeNull();
  });

  test("the terminal's task lookup answers the kind, and nothing for an unknown task", async () => {
    const { createLiveTerminalDeps } = await import("./terminal.ts");
    const deps = createLiveTerminalDeps();
    expect(await deps.task(await taskOn(SECOND_CLAUDE))).toEqual({ agent: "claude-code" });
    expect(await deps.task(await taskOn(SECOND_CURSOR))).toEqual({ agent: "cursor" });
    expect(await deps.task("no-such-task")).toBeNull();
  });

  test("the content behind a terminal challenge: a second Claude account's own session is offered; a Cursor account (no tmux) and another task's session are not", async () => {
    const { createLiveContentSources } = await import("./content-hash.ts");
    const { sessionNameFor } = await import("../claude-tmux.ts");
    const sources = createLiveContentSources();
    const claude = await taskOn(SECOND_CLAUDE);
    const cursor = await taskOn(SECOND_CURSOR);
    expect(await sources.terminal(claude, sessionNameFor(claude))).toEqual({ ok: true });
    expect(await sources.terminal(cursor, sessionNameFor(cursor))).toBeNull();
    expect(await sources.terminal(claude, sessionNameFor(cursor))).toBeNull();
    expect(await sources.terminal("no-such-task", sessionNameFor("no-such-task"))).toBeNull();
  });
});
