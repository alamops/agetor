import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent } from "../shared/types.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-blk-"));
// Point claude + tmux at /bin/echo so the availability probe in startTask
// passes on hosts where neither binary is installed (CI). The claude fake
// driver bypasses the real binary anyway — this just satisfies the
// preflight check.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

// Note: codex no longer has an approval-prompt → `blocked` heuristic. It runs
// non-interactively via `codex exec --json` (auto-approves under --full-auto,
// read-only under `ask`), so it emits no interactive approval prompt to match.
// The `blocked` column is now exclusively the claude API-error signal, covered
// by the tests below.

test("orchestrator leaves claude task in 'blocked' column when the run hits an API error", async () => {
  const { createTask, startTask, subscribeGlobal } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // Use the fake claude driver and ask it to simulate an API error mid-turn.
  // The driver emits the same sentinel status chunk claude-tmux emits on a
  // real `isApiErrorMessage` JSONL line, then resolves done(0). The
  // orchestrator's chunk handler should flip the column to `blocked`, and
  // the done handler should keep it there (not bounce back to `ready`).
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";

  // Subscribe to global events so we can also assert the column transition
  // carried `reason: "api-error"` — that's what selects the new
  // `toastApiError` over the generic `toastPending` in the webview.
  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));

  try {
    const created = await createTask({
      title: "api error",
      prompt: "anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    // Driver resolves done(0) at ~5ms; allow plenty of slack so the done
    // handler has run and applied its column transition.
    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    expect(after?.column).toBe("blocked");

    const runRow = runs.get(runId);
    // Even though the driver resolved with exit 0, the api-error path forces
    // status=failed so the badge and history are honest.
    expect(runRow?.status).toBe("failed");

    // The `reason` on the column event is what routes the UI to the
    // red "API error — retry" toast. A regression that silently dropped
    // the 4th arg from updateColumn would still leave the column at
    // `blocked` (other findings cover that) but would land on the
    // generic "Waiting on you" toast — which is exactly the UX the
    // user complained about. Assert the field explicitly.
    const apiErrorCol = globals.find(
      (e) => e.kind === "column" && e.taskId === task.id && e.column === "blocked",
    );
    expect(apiErrorCol).toBeDefined();
    if (apiErrorCol?.kind !== "column") throw new Error("expected column event");
    expect(apiErrorCol.reason).toBe("api-error");
  } finally {
    unsub();
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_API_ERROR;
  }
});

test("orchestrator: cancellation wins over api-error in column resolution (cancelled task → 'ready', not 'blocked')", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // Same fake-api-error path as above, but with a resolve delay so we can
  // fire `cancelRun` before the synthetic api-error done(0) lands. Both
  // `handle.apiError` and `handle.cancelled` will be true when the done
  // handler runs — it must defer to the cancellation, mirroring the
  // newStatus resolution.
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_API_ERROR = "1";
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "120";

  try {
    const created = await createTask({
      title: "api error then cancel",
      prompt: "anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    // Wait long enough for the api-error chunk to land (it flips the
    // column to `blocked` immediately) but well before the delayed
    // done(0) resolves — that's the window where cancellation has to
    // take precedence.
    await new Promise((r) => setTimeout(r, 30));
    expect(tasks.get(task.id)?.column).toBe("blocked");

    cancelRun(runId);

    // Now wait past the resolve delay so the done handler runs.
    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    // Cancellation routes the column to `ready` (mirroring the
    // pre-api-error contract for cancelled runs), NOT `blocked`.
    expect(after?.column).toBe("ready");

    const runRow = runs.get(runId);
    expect(runRow?.status).toBe("cancelled");
  } finally {
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_API_ERROR;
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("orchestrator moves task to 'blocked' when a running tmux session dies mid-run", async () => {
  const { createTask, startTask, subscribeGlobal } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // The fake driver emits the same `SESSION_DIED_STATUS_PREFIX` sentinel the
  // real claude/codex death watch emits when the tmux session vanishes, then
  // resolves done(0). The orchestrator's chunk handler should flip the column
  // to `blocked` (reason `session-died`), and the done handler should keep it
  // there and record the run `failed` — the previous blind spot left it stuck
  // in `running` until the next boot.
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED = "1";

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));

  try {
    const created = await createTask({
      title: "session died",
      prompt: "anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    expect(after?.column).toBe("blocked");

    const runRow = runs.get(runId);
    expect(runRow?.status).toBe("failed");

    // The `session-died` reason on the column event is what routes the UI to
    // the "Session ended" toast (not the generic "Waiting on you"). Assert it
    // explicitly so a dropped 4th arg to updateColumn is caught.
    const diedCol = globals.find(
      (e) => e.kind === "column" && e.taskId === task.id && e.column === "blocked",
    );
    expect(diedCol).toBeDefined();
    if (diedCol?.kind !== "column") throw new Error("expected column event");
    expect(diedCol.reason).toBe("session-died");
  } finally {
    unsub();
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED;
  }
});

test("orchestrator moves task to 'blocked' when claude's TUI rejects the message as an unknown slash command", async () => {
  const { createTask, startTask, subscribeGlobal } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX } = await import("./claude-tmux.ts");

  // The fake driver emits the same `CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX`
  // sentinel the real pane scraper emits when claude's TUI rejects a
  // slash-leading message with "Unknown command: /…", then resolves
  // done(0). The orchestrator's chunk handler should flip the column to
  // `blocked` (reason `unknown-command`), and the done handler should keep
  // it there and record the run `failed` — mirroring the api-error and
  // session-died contracts above.
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND = "1";

  const globals: GlobalEvent[] = [];
  const unsub = subscribeGlobal((e) => globals.push(e));

  try {
    const created = await createTask({
      title: "unknown command",
      prompt: "/fake-command anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    expect(after?.column).toBe("blocked");

    const runRow = runs.get(runId);
    expect(runRow?.status).toBe("failed");

    // The `unknown-command` reason on the column event is what routes the UI
    // to the dedicated toast (not the generic "Waiting on you"). Assert it
    // explicitly so a dropped 4th arg to updateColumn is caught.
    const unknownCommandCol = globals.find(
      (e) => e.kind === "column" && e.taskId === task.id && e.column === "blocked",
    );
    expect(unknownCommandCol).toBeDefined();
    if (unknownCommandCol?.kind !== "column") throw new Error("expected column event");
    expect(unknownCommandCol.reason).toBe("unknown-command");

    // The sentinel status chunk must actually be persisted to run_events —
    // it's the only record of *why* the run failed once the in-memory
    // ActiveRun handle is gone (e.g. after a restart), and it's what the
    // reattach/history views render back to the user.
    const events = runs.events(runId);
    const sentinelEvent = events.find(
      (e) => e.stream === "status" && e.data.startsWith(CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX),
    );
    expect(sentinelEvent).toBeDefined();
  } finally {
    unsub();
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND;
  }
});

test("orchestrator: cancellation wins over unknown-command (cancelled task → 'ready', not 'blocked')", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // Unknown-command flips the column to `blocked` immediately, but a user
  // cancel arriving before the delayed done(0) must still win — a cancelled
  // run lands in `ready`/`cancelled`, matching the api-error and
  // session-death precedence tests above.
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND = "1";
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "120";

  try {
    const created = await createTask({
      title: "unknown command then cancel",
      prompt: "/fake-command anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    await new Promise((r) => setTimeout(r, 30));
    expect(tasks.get(task.id)?.column).toBe("blocked");

    cancelRun(runId);

    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    expect(after?.column).toBe("ready");

    const runRow = runs.get(runId);
    expect(runRow?.status).toBe("cancelled");
  } finally {
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND;
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("orchestrator: cancellation wins over session-death (cancelled task → 'ready', not 'blocked')", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  // Session-death flips the column to `blocked` immediately, but a user cancel
  // arriving before the delayed done(0) must still win — a cancelled run lands
  // in `ready`/`cancelled`, matching the api-error precedence above.
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED = "1";
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "120";

  try {
    const created = await createTask({
      title: "session died then cancel",
      prompt: "anything",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in created) throw new Error(created.error);
    const task = created.task;

    const res = await startTask(task.id);
    if ("error" in res) throw new Error(`startTask failed: ${res.error}`);
    const runId = res.runId;

    await new Promise((r) => setTimeout(r, 30));
    expect(tasks.get(task.id)?.column).toBe("blocked");

    cancelRun(runId);

    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(task.id);
    expect(after?.column).toBe("ready");

    const runRow = runs.get(runId);
    expect(runRow?.status).toBe("cancelled");
  } finally {
    delete process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED;
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});
