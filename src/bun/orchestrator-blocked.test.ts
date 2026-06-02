import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalEvent } from "../shared/types.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-blk-"));
// The approval-prompt heuristic now only runs for codex — interactive
// claude's permission prompts surface inside the TUI, not in the JSONL
// stream, so the orchestrator's chunk handler skips the check for the
// claude branch. Use codex's stub binary to exercise the flip.
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_ARGS = "Do you want me to apply this patch?";
// Point claude + tmux at /bin/echo so the availability probe in startTask
// passes on hosts where neither binary is installed (CI). The claude fake
// driver bypasses the real binary anyway — this just satisfies the
// preflight check.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

test("orchestrator flips codex task to 'blocked' on approval-prompt output", async () => {
  const { createTask, startTask, subscribe } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  // Codex is shipped disabled-by-default (see migration 016); this test
  // exercises the codex branch, so flip it back on for the test database.
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "needs approval",
    prompt: "ignored",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    // Detection only fires for non-auto modes where the agent can actually
    // prompt — otherwise narrative output would false-positive.
    mode: "ask",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const statuses: string[] = [];
  const unsub = subscribe((e) => {
    if (e.stream === "status") statuses.push(e.data);
  });

  const res = await startTask(task.id);
  expect("runId" in res).toBe(true);

  // Echo exits quickly; the column flip happens synchronously inside the
  // stdout chunk handler, so a short wait is enough.
  await new Promise((r) => setTimeout(r, 250));
  unsub();

  const after = tasks.get(task.id);
  // The exit handler later flips column to 'review' (echo returns 0). We just
  // assert that a blocked status was emitted during the run — that's the
  // user-visible signal. If we wanted to keep the card in 'blocked' through
  // exit we'd need extra logic; the current contract is: blocked is
  // surfaced via the status event + a transient column change.
  expect(statuses.some((s) => s.startsWith("blocked"))).toBe(true);
  expect(after).not.toBeNull();
});

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
