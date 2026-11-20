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

/** Wait until the task has `count` run rows and none of them is still
 *  running. A fake codex turn usually settles in ~30 ms, but a process's
 *  first turn and a loaded machine can take several hundred, so a fixed
 *  sleep races it. */
async function settledRuns(taskId: string, count: number, timeoutMs = 10_000) {
  const { runs } = await import("./db.ts");
  const start = Date.now();
  for (;;) {
    const listed = runs.listForTask(taskId);
    if (listed.length === count && listed.every((r) => r.status !== "running")) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} settled run(s); have ${listed.map((r) => r.status).join(", ") || "none"}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
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

// PR #243 review: the floor is checked BEFORE `sendInput`'s side effects —
// a refused follow-up must not un-archive the task (nor restore its worktree)
// on the way to the refusal.
test("a refused follow-up on an archived codex task leaves it archived (floor checked before the archivedAt clear)", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const { startTask, sendInput, archiveTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-5.6-sol");
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settledRuns(taskId, 1);
  expect(runs.listForTask(taskId).length).toBe(1);

  const archived = await archiveTask(taskId, { force: true }); // column gate only; the run already settled
  if ("error" in archived) throw new Error(archived.error);
  expect(tasks.get(taskId)?.archivedAt).not.toBeNull();

  tasks.update(taskId, { model: "gpt-6-sol" });
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const res = await sendInput(started.runId, "follow up on an archived task");
  expect(res.delivered).toBe(false);
  if (!res.delivered) expect(res.reason).toContain("0.155.0");
  // Still archived, still one run row.
  expect(tasks.get(taskId)?.archivedAt).not.toBeNull();
  expect(runs.listForTask(taskId).length).toBe(1);
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

test("a null task.model resolves through DEFAULT_MODEL.codex (gpt-6.1-sol) and is gated the same way", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { DEFAULT_MODEL } = await import("../shared/types.ts");

  const taskId = await createCodexTask(null);
  // createTask itself substitutes DEFAULT_MODEL[kind] for a null model at
  // create time (unlike task.mode, which stays null until spawn) — the
  // stored row already carries "gpt-6.1-sol", not null. Assert that directly
  // rather than the raw-null shape the T7 spec sketch assumed.
  expect(DEFAULT_MODEL.codex).toBe("gpt-6.1-sol");
  const stored = tasks.get(taskId);
  expect(stored!.model).toBe("gpt-6.1-sol");

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("GPT-6.1 Sol");
    expect(started.error).toContain("0.159.0");
  }
});

// docs/plans/add-gpt-6-1-sol.md (2026-09-30): GPT-6.1 Sol's floor is 0.159.0.
test("codex 0.158.0 + gpt-6.1-sol is refused before any run row is created", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.158.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6.1-sol");
  const beforeColumn = tasks.get(taskId)!.column;

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("0.158.0");
    expect(started.error).toContain("0.159.0");
  }

  const after = tasks.get(taskId);
  expect(after!.column).toBe(beforeColumn);
  expect(after!.runId).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("codex 0.159.0 + gpt-6.1-sol is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.159.0";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6.1-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});

// docs/plans/add-gpt-6-1-terra.md (2026-10-26): GPT-6.1 Terra's floor is 0.159.0.
test("codex 0.158.0 + gpt-6.1-terra is refused before any run row is created", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.158.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6.1-terra");
  const beforeColumn = tasks.get(taskId)!.column;

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toContain("0.158.0");
    expect(started.error).toContain("0.159.0");
  }

  const after = tasks.get(taskId);
  expect(after!.column).toBe(beforeColumn);
  expect(after!.runId).toBeNull();
  expect(runs.listForTask(taskId).length).toBe(0);
});

test("codex 0.159.0 + gpt-6.1-terra is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.159.0";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6.1-terra");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
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

// --- Pre-flight 1b review fixes ---------------------------------------------
// §8b findings 2, 3, 4: the follow-up spawn path (spawnCodexTurnNow, reached
// by every sendInput) is gated the same way the first run is, the escape
// hatch disables the whole check, and a pre-release build sitting exactly AT
// the floor fails open rather than being treated as "the release".

test("follow-up gate: a codex task started on a satisfying version, then switched to a too-old version + a GPT-6 model, is refused on sendInput with no new run row or user event — then re-probing on a satisfying version delivers and mints a second run", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const { startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-5.6-sol"); // no floor, starts cleanly
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = started.runId;

  await settledRuns(taskId, 1);
  expect(runs.listForTask(taskId).length).toBe(1);

  // Now move the task onto a floored model and drop the installed CLI below
  // the floor — codex is one-shot per turn and PATCH-able between turns, so
  // this must be re-checked on the follow-up, not just at first-run time.
  tasks.update(taskId, { model: "gpt-6-sol" });
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";

  const userEventsBefore = runs.eventsForTask(taskId).filter((e) => e.stream === "user").length;

  const result = await sendInput(firstRunId, "follow up");
  expect(result.delivered).toBe(false);
  if (!result.delivered) {
    expect(result.reason).toContain("0.147.0");
    expect(result.reason).toContain("GPT-6 Sol");
    expect(result.reason).toContain("0.155.0");
    expect(result.reason).toContain("npm i -g @openai/codex");
  }

  // No run row minted for the refused follow-up.
  expect(runs.listForTask(taskId).length).toBe(1);
  // No new `user` event recorded anywhere for this task — the decline
  // happens before any state mutation, so the follow-up text is dropped
  // rather than landing as an orphaned bubble (count unchanged from before
  // the refused sendInput — the original prompt's own user event is
  // already there).
  const userEventsAfterRefusal = runs.eventsForTask(taskId).filter((e) => e.stream === "user").length;
  expect(userEventsAfterRefusal).toBe(userEventsBefore);

  // Fix the version and resend the same follow-up — the gate re-probes per
  // turn, so this now succeeds and mints a second run row.
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.1";
  const retried = await sendInput(firstRunId, "follow up");
  expect(retried.delivered).toBe(true);

  await settledRuns(taskId, 2);
  expect(runs.listForTask(taskId).length).toBe(2);
});

test("escape hatch: AGETOR_SKIP_CLI_VERSION_FLOOR=1 disables Pre-flight 1b even on a too-old CLI + GPT-6 model", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";
  try {
    const { startTask } = await import("./orchestrator.ts");
    const { runs } = await import("./db.ts");

    const taskId = await createCodexTask("gpt-6-sol");
    const started = await startTask(taskId);
    expect("error" in started).toBe(false);

    await settle();
    expect(runs.listForTask(taskId).length).toBe(1);
  } finally {
    delete process.env.AGETOR_SKIP_CLI_VERSION_FLOOR;
  }
});

test("escape hatch: AGETOR_SKIP_CLI_VERSION_FLOOR='off' does NOT disable the check (only the recognized truthy spellings do)", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "off";
  try {
    const { startTask } = await import("./orchestrator.ts");

    const taskId = await createCodexTask("gpt-6-sol");
    const started = await startTask(taskId);
    expect("error" in started).toBe(true);
    if ("error" in started) {
      expect(started.error).toContain("0.155.0");
    }
  } finally {
    delete process.env.AGETOR_SKIP_CLI_VERSION_FLOOR;
  }
});

test("a pre-release build sitting exactly AT the floor ('0.155.0-alpha.3' vs the 0.155.0 floor) fails open and is allowed to start", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.155.0-alpha.3";
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const taskId = await createCodexTask("gpt-6-sol");
  const started = await startTask(taskId);
  expect("error" in started).toBe(false);

  await settle();
  expect(runs.listForTask(taskId).length).toBe(1);
});

// Queued-drain case (a follow-up sent WHILE a codex turn is in flight, so it
// goes through codexTurnQueue/drainCodexQueue rather than spawnCodexTurnNow
// directly) lives in orchestrator-codex-queue-floor.test.ts, which holds the
// fake turn open via the AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS seam and pins
// `drainCodexQueue`'s stranded-message handling (every queued line behind a
// refused one restashed to the backlog tray, raw text, send order).

/* ── discovery first (dynamic-model-catalog #14) ───────────────────────────── */

/** Seed the built-in codex harness's discovered catalog, run, and always reset. */
async function withCodexCatalog(rows: { id: string; cliDefault?: true }[], run: () => Promise<void>): Promise<void> {
  const discovery = await import("./agent-discovery.ts");
  discovery.__testing.resetForTests();
  discovery.seedDiscoveryCache({ scope: "harness", kind: "codex", harnessId: "codex" }, rows);
  try {
    await run();
  } finally {
    discovery.__testing.resetForTests();
  }
}

test("a codex model missing from a non-empty trusted catalog is refused with the upgrade message, even with no table floor", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.166.0";
  const { startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  await withCodexCatalog([{ id: "gpt-6.2-sol" }], async () => {
    const taskId = await createCodexTask("gpt-5.6-sol"); // no MODEL_MIN_CLI_VERSION entry
    const started = await startTask(taskId);
    expect("error" in started).toBe(true);
    if ("error" in started) {
      expect(started.error).toContain("isn't in Codex's model list");
      expect(started.error).toContain("0.166.0");
      expect(started.error).toContain("update the CLI (npm i -g @openai/codex)");
    }
    expect(tasks.get(taskId)!.runId).toBeNull();
    expect(runs.listForTask(taskId).length).toBe(0);
  });
});

test("a model the CLI's catalog lists is allowed even when the frozen table floor would refuse it", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0"; // below gpt-6-sol's 0.155.0 floor
  const { startTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  await withCodexCatalog([{ id: "gpt-6-sol" }, { id: "gpt-6.2-sol" }], async () => {
    const taskId = await createCodexTask("gpt-6-sol");
    const started = await startTask(taskId);
    expect("error" in started).toBe(false);
    await settle();
    expect(runs.listForTask(taskId).length).toBe(1);
  });
});

test("an empty catalog leaves the table behavior untouched, and the skip env wins over a missing-model verdict", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const { startTask } = await import("./orchestrator.ts");
  // Empty discovery: the table still refuses gpt-6-sol on 0.147.0.
  const refused = await startTask(await createCodexTask("gpt-6-sol"));
  expect("error" in refused).toBe(true);
  if ("error" in refused) expect(refused.error).toContain("0.155.0");

  process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";
  try {
    await withCodexCatalog([{ id: "gpt-6.2-sol" }], async () => {
      const started = await startTask(await createCodexTask("gpt-5.6-sol"));
      expect("error" in started).toBe(false);
      await settle();
    });
  } finally {
    delete process.env.AGETOR_SKIP_CLI_VERSION_FLOOR;
  }
});

test("a stored catalog judges a start only under the CLI version it was probed with: after an upgrade the old list refuses nothing (review S-B)", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.166.0";
  const { startTask } = await import("./orchestrator.ts");
  const { harnesses, preferences, runs } = await import("./db.ts");
  const discovery = await import("./agent-discovery.ts");
  const scheduler = await import("./model-discovery.ts");
  harnesses.setEnabled("codex", true);
  const prefKey = "modelCatalog:harness:codex";
  // The catalog persisted by an earlier run, hydrated the way a boot does.
  const restoreCatalog = async (cliVersion: string) => {
    discovery.__testing.resetForTests();
    scheduler.__testing.resetForTests();
    preferences.set(prefKey, JSON.stringify({ v: 1, cliVersion, savedAt: 1, models: [{ id: "gpt-6.2-sol" }] }));
    await scheduler.__testing.hydrateFromStore();
    expect(discovery.getHarnessDiscoveredModels("codex").map((m) => m.id)).toEqual(["gpt-6.2-sol"]);
  };
  try {
    // Probed under the CLI installed now: it lacks gpt-5.6-sol, which is refused.
    await restoreCatalog("codex-cli 0.166.0");
    const refused = await startTask(await createCodexTask("gpt-5.6-sol"));
    expect("error" in refused).toBe(true);
    if ("error" in refused) expect(refused.error).toContain("isn't in Codex's model list");

    // Probed under the CLI before an upgrade (its refresh hasn't landed): the
    // same list says nothing, and gpt-5.6-sol (no table floor) starts.
    await restoreCatalog("codex-cli 0.160.0");
    const taskId = await createCodexTask("gpt-5.6-sol");
    const started = await startTask(taskId);
    expect("error" in started).toBe(false);
    await settledRuns(taskId, 1);
    expect(runs.listForTask(taskId).length).toBe(1);
  } finally {
    preferences.delete(prefKey);
    scheduler.__testing.resetForTests();
    discovery.__testing.resetForTests();
  }
});

test("createTask with no model: the owner's default unless a trusted catalog lacks it, then the CLI's own default row", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("codex", true);
  const make = async () => {
    const created = await createTask({ title: "default model", prompt: "x", agent: "codex", workdir: process.cwd(), isolation: "none", taskType: "task" });
    if ("error" in created) throw new Error(created.error);
    return created.task;
  };
  expect((await make()).model).toBe("gpt-6.1-sol"); // no catalog: DEFAULT_MODEL.codex
  await withCodexCatalog([{ id: "gpt-6.2-sol", cliDefault: true }, { id: "gpt-6.2-astra" }], async () => {
    expect((await make()).model).toBe("gpt-6.2-sol");
  });
  await withCodexCatalog([{ id: "gpt-6.1-sol" }, { id: "gpt-6.2-sol", cliDefault: true }], async () => {
    expect((await make()).model).toBe("gpt-6.1-sol");
  });
  await withCodexCatalog([{ id: "gpt-6.2-sol" }], async () => {
    expect((await make()).model).toBe("gpt-6.1-sol"); // trusted catalog without a CLI default: keep the owner's pick
  });
});
