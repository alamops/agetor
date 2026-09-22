import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import — mkdtemp BEFORE any
// import that could pull db.ts in transitively.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-min-cli-"));

// Drive codex through the in-process fake so a run that's allowed to start
// actually completes without tmux/the real CLI — same as
// orchestrator-codex.test.ts. The pre-flight under test runs BEFORE the
// driver is ever chosen, so this only matters for the "starts" assertions.
process.env.AGETOR_CODEX_DRIVER = "fake";

// Plant a fake codex binary whose `--version` echoes back whatever
// `FAKE_CODEX_VERSION` is currently set to, and exits 0 for anything else
// (mirrors `plantFakeFxBin` in agent-status.test.ts:156-175). `resolveBin`
// (src/bun/agents.ts) reads `process.env.AGETOR_CODEX_BIN` on every call —
// not cached — and `probeVersion` (agent-status.ts) spawns with
// `{ ...process.env, ...env }`, so the *current* value of
// `FAKE_CODEX_VERSION` at spawn time is what the child sees. Setting the
// bin path once here and varying `FAKE_CODEX_VERSION` per test is enough;
// no per-test binary needed.
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-min-cli-bin-"));
const fakeCodexBin = path.join(binDir, "codex");
writeFileSync(
  fakeCodexBin,
  `#!/bin/sh\n`
    + `if [ "$1" = "--version" ]; then echo "$FAKE_CODEX_VERSION"; exit 0; fi\n`
    + `exit 0\n`,
  { mode: 0o755 },
);
process.env.AGETOR_CODEX_BIN = fakeCodexBin;

beforeAll(async () => {
  await import("./db.ts");
});

async function settle(ms = 100) {
  await new Promise((r) => setTimeout(r, ms));
}

async function createCodexTask(model: string | null) {
  const { createTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "min-cli-version probe",
    prompt: "do a thing",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
    ...(model !== null ? { model } : {}),
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("codex 0.147.0 + gpt-6-sol is refused before any run row is created", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6-sol");
  const before = tasks.get(taskId);
  expect(before).not.toBeNull();
  const beforeColumn = before!.column;
  expect(before!.runId).toBeNull();

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("0.147.0");
    expect(started.error).toContain("GPT-6 Sol");
    expect(started.error).toContain("0.155.0");
    // The upgrade hint: `status.installHint` is null once the availability
    // gate passed, so the pre-flight falls back to INSTALL_HINTS[kind].
    expect(started.error).toContain("Upgrade with: npm i -g @openai/codex");
  }

  const after = tasks.get(taskId);
  expect(after!.column).toBe(beforeColumn);
  expect(after!.runId).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("codex 0.155.1 + gpt-6-sol is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});

test("an unparseable version fails open and allows the start (gpt-6-sol)", async () => {
  // What /bin/echo-style test overrides would answer for `--version` when
  // no recognizable version string is present.
  process.env.FAKE_CODEX_VERSION = "--version";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});

test("codex 0.147.0 + gpt-5.6-sol (no floor for this model) is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-5.6-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});

test("codex 0.152.0 + gpt-6-astra is refused, naming the 0.153.0 floor", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.152.0";
  const { startTask } = await import("./orchestrator.ts");

  const taskId = await createCodexTask("gpt-6-astra");
  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("0.153.0");
    expect(started.error).toContain("GPT-6 Astra");
    expect(started.error).not.toContain("GPT-6 Astra Aeon");
  }
});

test("a null task.model resolves through DEFAULT_MODEL.codex (gpt-6-sol) and is gated the same way", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { DEFAULT_MODEL } = await import("../shared/types.ts");

  const taskId = await createCodexTask(null);
  // createTask itself substitutes DEFAULT_MODEL[kind] for a null model at
  // create time (unlike task.mode, which stays null until spawn) — the
  // stored row already carries "gpt-6-sol", not null. Assert that directly
  // rather than the raw-null shape the T7 spec sketch assumed.
  expect(DEFAULT_MODEL.codex).toBe("gpt-6-sol");
  const stored = tasks.get(taskId);
  expect(stored!.model).toBe("gpt-6-sol");

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("GPT-6 Sol");
    expect(started.error).toContain("0.155.0");
  }
});

test("boundary: codex exactly at the 0.155.0 floor + gpt-6-luna is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.0";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6-luna");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});
