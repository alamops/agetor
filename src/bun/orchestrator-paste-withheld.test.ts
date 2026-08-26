import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — mirrors
// orchestrator.test.ts's own preamble. Must run before any dynamic import of
// db.ts/orchestrator.ts/claude-tmux.ts below.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-paste-withheld-"));
// Drive claude's INITIAL spawn through the in-process fake (agents.ts) so
// `startTask` doesn't need a real tmux server / claude binary to get a task
// into "running" with an active run — mirrors orchestrator.test.ts. This does
// NOT affect `sendTurn`/`pasteFollowUp`/`sendSlashCommand`/`cycleToMode`
// (claude-tmux.ts's own follow-up/mirror paths), which always run for real
// against whatever SessionState is installed — that's the surface this file
// actually exercises.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // has-session / send-keys probes all exit 0
process.env.AGETOR_CLAUDE_ARGS = "";
// Dedicated port for the one test in this file that starts a real HTTP
// server (nav end-to-end) — distinct from every other server*.test.ts file's
// port so a full `bun test` run never fights over a bind.
process.env.AGETOR_API_PORT = "4427";

/** Poll `check` until it returns true or `timeoutMs` elapses. Used instead of
 *  fixed sleeps for every async settle in this file (paste-withhold chains,
 *  run-status transitions) so re-runs under CI load don't flake on a sleep
 *  that was tuned for a quiet machine. */
async function waitFor(check: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A numbered permission-style modal — recognised by `matchNumberedModal`
 *  and therefore `paneShowsBlockingPrompt`. Used wherever a test needs
 *  `queuePaste`'s modal guard to withhold. */
const BLOCKING_PANE = [
  "Do you want to make this edit to foo.ts?",
  "\u276F 1. Yes",
  "  2. Yes, allow all",
  "  3. No",
].join("\n");

function freshJsonl(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-paste-withheld-session-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  return jsonlPath;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1 — Withheld folded follow-up is re-stashed to the backlog
 * ────────────────────────────────────────────────────────────────────────── */

test("withheld folded follow-up: re-stashed to backlog with a status breadcrumb, and a repeat send doesn't duplicate it", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, runs, tasks } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "withheld-fold",
    prompt: "first message",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const res = await startTask(taskId);
  expect("runId" in res).toBe(true);
  if (!("runId" in res)) return;
  const r1 = res.runId;

  // Install a REAL session so `sendClaudeTurn` takes the existing-session
  // (fold-capable) path — mirrors orchestrator.test.ts's own fold test.
  claudeTmux.__forTest.installSession(taskId, freshJsonl());

  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(() => BLOCKING_PANE);

  try {
    // TIMING INVARIANT (mirrors orchestrator.test.ts): no await between
    // `startTask` above and this call — R1 must still be in `active` when
    // `sendInput` reads it, so this folds instead of spawning a new turn.
    const sent = await sendInput(r1, "hello again");
    expect(sent.delivered).toBe(true); // optimistic — pasteFollowUp returns synchronously
    if (sent.delivered) expect(sent.runId).toBe(r1);

    // The optimistic "user" bubble landed even though the paste itself will
    // be withheld a moment later.
    let events = runs.eventsForTask(taskId);
    expect(events.some((e) => e.stream === "user" && e.data.includes("hello again"))).toBe(true);

    // Let the fold's queuePaste chain (pre-paste modal guard) run to
    // completion — this is where handlePasteWithheld actually fires.
    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => (tasks.get(taskId)?.backlog.length ?? 0) >= 1);

    const afterFirst = tasks.get(taskId);
    expect(afterFirst?.backlog.length).toBe(1);
    expect(afterFirst?.backlog[0]?.text).toBe("hello again");

    events = runs.eventsForTask(taskId);
    const statusTexts = events.filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts.some((t) => t.startsWith("paste withheld") || t.includes("backlog"))).toBe(true);

    // Let R1's fake turn resolve on its own (it's independent of the fold),
    // so the second send below takes the idle path deterministically rather
    // than racing the same fold window.
    await waitFor(() => tasks.get(taskId)?.column !== "running");

    // Second identical send — dedupe: the backlog must not grow past 1.
    const sent2 = await sendInput(r1, "hello again");
    expect(sent2.delivered).toBe(true);
    await claudeTmux.__forTest.pasteChains.get(taskId);
    // Give the (now idle-path) run row a moment to settle to failed too.
    await waitFor(() => {
      const rows = runs.listForTask(taskId);
      return rows.some((r) => r.status === "failed");
    });

    const afterSecond = tasks.get(taskId);
    expect(afterSecond?.backlog.length).toBe(1);
    expect(afterSecond?.backlog[0]?.text).toBe("hello again");
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevCapture);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 2 — Withheld idle send (no active run)
 * ────────────────────────────────────────────────────────────────────────── */

test("withheld idle send: the fresh run ends failed, the task returns to ready, and the message lands in the backlog", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, runs, tasks } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "withheld-idle",
    prompt: "first message",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const res = await startTask(taskId);
  if (!("runId" in res)) throw new Error("expected the fake driver to start a run");
  const r1 = res.runId;

  // Let the fake driver's turn resolve fully so no run is active — this is
  // the "idle" send path, not the fold path covered above.
  await waitFor(() => tasks.get(taskId)?.column !== "running");

  claudeTmux.__forTest.installSession(taskId, freshJsonl());
  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(() => BLOCKING_PANE);

  try {
    const sent = await sendInput(r1, "are you there");
    expect(sent.delivered).toBe(true);
    if (!sent.delivered) return;
    const newRunId = sent.runId;
    // A genuinely new run row was created for the idle send (not folded).
    expect(newRunId).not.toBe(r1);

    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => runs.get(newRunId)?.status === "failed");

    expect(runs.get(newRunId)?.status).toBe("failed");
    expect(tasks.get(taskId)?.column).toBe("ready");

    const backlog = tasks.get(taskId)?.backlog ?? [];
    expect(backlog.length).toBe(1);
    expect(backlog[0]?.text).toBe("are you there");

    const events = runs.eventsForTask(taskId);
    const statusTexts = events.filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts.some((t) => t.startsWith("paste withheld") || t.includes("backlog"))).toBe(true);
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevCapture);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 3 — Mirror withheld breadcrumb (reconcileTaskSession /model mirror)
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: a withheld /model mirror leaves a '\u26a0\ufe0f model change not applied' breadcrumb on the latest run", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-withheld",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "opus-4.7",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  claudeTmux.__forTest.installSession(taskId, freshJsonl());

  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: `agetor-test-${taskId}`,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });

  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(() => BLOCKING_PANE);
  const prevConfirmPane = claudeTmux.__forTest.setCaptureConfirmPane(() => BLOCKING_PANE);

  try {
    const before = tasks.get(taskId)!;
    const after = { ...before, model: "sonnet-5" };
    await reconcileTaskSession(taskId, before, after);
    // reconcileTaskSession fires sendSlashCommand fire-and-forget for the
    // model mirror — wait its (chained) op out.
    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => {
      const texts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
      return texts.some((t) => t.startsWith("\u26a0\ufe0f model change not applied"));
    });

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts.some((t) => t.startsWith("\u26a0\ufe0f model change not applied"))).toBe(true);
    expect(statusTexts.some((t) => t.includes("sonnet-5"))).toBe(true);
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevPastePane);
    claudeTmux.__forTest.setCaptureConfirmPane(prevConfirmPane);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 4 — /plan withheld (cycleToMode's paste-withheld path via reconcileTaskSession)
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: a withheld /plan mirror leaves a '\u26a0\ufe0f plan mode not applied' breadcrumb", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-plan-withheld",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  claudeTmux.__forTest.installSession(taskId, freshJsonl());

  const runId = randomUUID();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: `agetor-test-${taskId}`,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });

  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(() => BLOCKING_PANE);

  try {
    const before = tasks.get(taskId)!;
    const after = { ...before, mode: "plan" };
    // cycleToMode's /plan branch is AWAITED end-to-end by reconcileTaskSession
    // (unlike the model/effort mirror), so the breadcrumb is already
    // recorded by the time this resolves.
    await reconcileTaskSession(taskId, before, after);

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts.some((t) => t.startsWith("\u26a0\ufe0f plan mode not applied"))).toBe(true);
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevPastePane);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 5 — nav end-to-end: POST /tmux-prompts/:id/answer drives the recorded
 * arrow-key sequence exactly the way the route calls dismissTmuxPrompt.
 * ────────────────────────────────────────────────────────────────────────── */

/** Recording variant of a fake tmux bin — same recipe as
 *  claude-tmux-local-command.test.ts's own helper (duplicated here per this
 *  task's "no cross-test-file imports" convention). Appends one
 *  `{ ms, argv }` JSON line per invocation. */
function withRecordingTmuxBin<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-rec-"));
  const binPath = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  writeFileSync(
    binPath,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ ms: Date.now(), argv: process.argv.slice(2) }) + "\\n");\n`,
  );
  chmodSync(binPath, 0o755);
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = binPath;
  return fn(logPath).finally(() => {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  });
}

function readTmuxLog(logPath: string): Array<{ ms: number; argv: string[] }> {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((entry) => {
    // Every tmux spawn leads with tmuxSocketArgs() (["-L", <name>]) under
    // `bun test` — strip that pair so send-keys assertions don't have to
    // know about socket isolation.
    const [a, , ...rest] = entry.argv;
    return a === "-L" ? { ...entry, argv: rest } : entry;
  });
}

describe("nav end-to-end via POST /tmux-prompts/:id/answer", () => {
  test("nav:'horizontal' choices send Right,Right,Enter", async () => {
    await withRecordingTmuxBin(async (logPath) => {
      const { startApiServer, API_TOKEN } = await import("./server.ts");
      const claudeTmux = await import("./claude-tmux.ts");
      const { registerTmuxPrompt } = await import("./interactions.ts");

      const server = startApiServer() as unknown as { stop: () => void };
      const taskId = randomUUID();
      claudeTmux.__forTest.installSession(taskId, freshJsonl());

      try {
        const choices = ["1", "2", "3", "4"].map((key) => ({ key, label: `choice ${key}` }));
        // cursorIndex 0 (currently on key "1") → target key "3" is index 2 →
        // delta +2 → two Right presses before the confirming Enter.
        const { req } = registerTmuxPrompt({
          taskId,
          runId: "r-nav-h",
          paneText: "\u2190/\u2192 to adjust",
          choices,
          cursorIndex: 0,
          nav: "horizontal",
          fingerprint: "fp-nav-e2e-horizontal",
        });

        const res = await fetch(`http://127.0.0.1:4427/tmux-prompts/${req.id}/answer`, {
          method: "POST",
          headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ key: "3" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        const keys = readTmuxLog(logPath)
          .filter((e) => e.argv[0] === "send-keys")
          .map((e) => e.argv[e.argv.length - 1]);
        expect(keys).toEqual(["Right", "Right", "Enter"]);
      } finally {
        claudeTmux.__forTest.uninstallSession(taskId);
        server.stop();
      }
    });
  }, 10_000);

  test("no nav (vertical default) sends Down,Down,Enter", async () => {
    await withRecordingTmuxBin(async (logPath) => {
      const { startApiServer, API_TOKEN } = await import("./server.ts");
      const claudeTmux = await import("./claude-tmux.ts");
      const { registerTmuxPrompt } = await import("./interactions.ts");

      const server = startApiServer() as unknown as { stop: () => void };
      const taskId = randomUUID();
      claudeTmux.__forTest.installSession(taskId, freshJsonl());

      try {
        const choices = ["1", "2", "3", "4"].map((key) => ({ key, label: `choice ${key}` }));
        const { req } = registerTmuxPrompt({
          taskId,
          runId: "r-nav-v",
          paneText: "Choose an option:",
          choices,
          cursorIndex: 0,
          // nav omitted — dismissal path treats this as vertical.
          fingerprint: "fp-nav-e2e-vertical",
        });

        const res = await fetch(`http://127.0.0.1:4427/tmux-prompts/${req.id}/answer`, {
          method: "POST",
          headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ key: "3" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        const keys = readTmuxLog(logPath)
          .filter((e) => e.argv[0] === "send-keys")
          .map((e) => e.argv[e.argv.length - 1]);
        expect(keys).toEqual(["Down", "Down", "Enter"]);
      } finally {
        claudeTmux.__forTest.uninstallSession(taskId);
        server.stop();
      }
    });
  }, 10_000);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6 — Late-rendering confirm: sendSlashCommand's auto-confirm poll keeps
 * polling through a couple of non-idle, non-blocking (still-working) frames
 * before the real confirm renders, fires exactly one auto-confirm Enter, and
 * resolves a tmux_prompt already registered under the confirm's own
 * fingerprint.
 * ────────────────────────────────────────────────────────────────────────── */

// claude actively working — not blocking, not idle. Used for the first two
// confirm-pane polls to prove the loop keeps polling instead of giving up
// (it would ONLY give up early on two CONSECUTIVE *idle* sightings — see
// SLASH_CONFIRM_IDLE_BREAK_TICKS — which a genuinely idle pane would trigger
// after just 2 ticks and never reach the confirm at all).
const STILL_WORKING_PANE = "\u2733 Working\u2026 (esc to interrupt \u00b7 3s \u00b7 240 tokens)";

// Verbatim claude 2.1.245 mid-conversation "Change effort level?" confirm,
// cursor on option 1 ("Yes, switch to ...").
const EFFORT_CONFIRM_PANE = [
  "Change effort level?",
  "Your next response will be slower and use more tokens",
  "",
  "This conversation is cached for the current effort level. Switching to low means the full history gets re-read on your next message.",
  "",
  "\u276F 1. Yes, switch to low",
  "  2. No, go back",
].join("\n");

test("sendSlashCommand({autoConfirm}): a confirm that only renders after two still-working polls auto-accepts exactly once and resolves a pre-registered tmux_prompt sharing its fingerprint", async () => {
  const claudeTmux = await import("./claude-tmux.ts");
  const { registerTmuxPrompt, listPendingForTask } = await import("./interactions.ts");
  const { __forTest, sendSlashCommand } = claudeTmux;

  const prevSettle = __forTest.setSlashCommandSettleMs(0);
  const taskId = randomUUID();
  __forTest.installSession(taskId, freshJsonl());

  let confirmCalls = 0;
  const prevConfirmPane = __forTest.setCaptureConfirmPane(() => {
    confirmCalls++;
    return confirmCalls <= 2 ? STILL_WORKING_PANE : EFFORT_CONFIRM_PANE;
  });
  // Keep the paste's OWN modal guard from ever seeing a blocking pane — this
  // test is about the auto-confirm poll, not the paste guard.
  const prevPastePane = __forTest.setCapturePastePane(() => "");

  const match = __forTest.matchSlashConfirmModal(EFFORT_CONFIRM_PANE, "effort");
  expect(match).not.toBeNull();

  const { id: promptId, answer } = registerTmuxPrompt({
    taskId,
    runId: "r-confirm",
    paneText: EFFORT_CONFIRM_PANE,
    choices: [{ key: "1", label: "Yes, switch to low" }, { key: "2", label: "No, go back" }],
    cursorIndex: 0,
    fingerprint: match!.fingerprint,
  });
  expect(listPendingForTask(taskId)).toHaveLength(1);

  try {
    const ok = sendSlashCommand(taskId, "/effort low", { autoConfirm: "effort" });
    expect(ok).toBe(true);

    await __forTest.pasteChains.get(taskId);

    // At least the 2 still-working polls plus the one that finally matched.
    expect(confirmCalls).toBeGreaterThanOrEqual(3);

    expect(listPendingForTask(taskId)).toHaveLength(0);
    await expect(answer).resolves.toEqual({ key: "__external__" });
  } finally {
    __forTest.setCaptureConfirmPane(prevConfirmPane);
    __forTest.setCapturePastePane(prevPastePane);
    __forTest.setSlashCommandSettleMs(prevSettle);
    __forTest.uninstallSession(taskId);
    void promptId;
  }
}, 10_000);
