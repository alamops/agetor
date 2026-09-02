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
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);

  try {
    // TIMING INVARIANT (mirrors orchestrator.test.ts): no await between
    // `startTask` above and this call — R1 must still be in `active` when
    // `sendInput` reads it, so this folds instead of spawning a new turn.
    const sent = await sendInput(r1, "hello again");
    // `sendInput` now AWAITS the paste's real outcome before resolving (§10
    // "withheld sends surface at the HTTP layer") — a modal-guard withhold
    // reports delivered:false, not the old optimistic true.
    if (sent.delivered) throw new Error(`expected the withheld send to report delivered:false, got ${JSON.stringify(sent)}`);
    expect(sent.withheld).toBe(true);
    expect(sent.savedToBacklog).toBe(true);
    expect(sent.reason).toContain("backlog");

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

    // Second identical send — dedupe: the backlog must not grow past 1. This
    // resend takes the idle path (R1 already resolved above) and is withheld
    // by the same blocking pane, so it too reports delivered:false now.
    const sent2 = await sendInput(r1, "hello again");
    if (sent2.delivered) throw new Error(`expected the withheld resend to report delivered:false, got ${JSON.stringify(sent2)}`);
    expect(sent2.withheld).toBe(true);
    expect(sent2.savedToBacklog).toBe(true);
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
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);

  try {
    const sent = await sendInput(r1, "are you there");
    // `sendInput` now awaits the paste's real outcome before resolving — a
    // withheld modal-guard paste reports delivered:false (and, unlike the
    // internal `ClaudeTurnResult`, the public `SendInputResult` shape carries
    // no `runId` on that branch), so the fresh run row is found by process
    // of elimination below instead.
    if (sent.delivered) throw new Error(`expected the withheld send to report delivered:false, got ${JSON.stringify(sent)}`);
    expect(sent.withheld).toBe(true);
    expect(sent.savedToBacklog).toBe(true);
    expect(sent.reason).toContain("backlog");

    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => runs.listForTask(taskId).some((r) => r.id !== r1 && r.status === "failed"));

    // A genuinely new run row was created for the idle send (not folded).
    const newRun = runs.listForTask(taskId).find((r) => r.id !== r1);
    expect(newRun).toBeTruthy();
    expect(newRun?.status).toBe("failed");
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
    fxSessionId: null,
  });

  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);
  const prevConfirmPane = claudeTmux.__forTest.setCaptureConfirmPane(async () => BLOCKING_PANE);

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
    fxSessionId: null,
  });

  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);

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
 *  `{ ms, argv, stdin }` JSON line per invocation. `stdin` is captured
 *  best-effort (empty string on any read failure) — `load-buffer -` reads the
 *  pasted text from stdin, so recording it lets a test assert on the EXACT
 *  text that went into the buffer (e.g. a bare `/model` vs. `/model
 *  claude-opus-5`), not just the argv shape. Reading fd 0 synchronously is
 *  safe even for calls where the real caller passed `stdin: "ignore"`
 *  (`Bun.spawnSync` maps that to `/dev/null`, which reads as immediate EOF). */
function withRecordingTmuxBin<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-rec-"));
  const binPath = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  writeFileSync(
    binPath,
    `#!${process.execPath}\n` +
      `import { appendFileSync, readFileSync } from "node:fs";\n` +
      `let stdin = ""; try { stdin = readFileSync(0, "utf8"); } catch {}\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ ms: Date.now(), argv: process.argv.slice(2), stdin }) + "\\n");\n`,
  );
  chmodSync(binPath, 0o755);
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = binPath;
  return fn(logPath).finally(() => {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  });
}

function readTmuxLog(logPath: string): Array<{ ms: number; argv: string[]; stdin: string }> {
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
  const prevConfirmPane = __forTest.setCaptureConfirmPane(async () => {
    confirmCalls++;
    return confirmCalls <= 2 ? STILL_WORKING_PANE : EFFORT_CONFIRM_PANE;
  });
  // Keep the paste's OWN modal guard from ever seeing a blocking pane — this
  // test is about the auto-confirm poll, not the paste guard.
  const prevPastePane = __forTest.setCapturePastePane(async () => "");

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
    const ok = await sendSlashCommand(taskId, "/effort low", { autoConfirm: "effort" });
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

/* ────────────────────────────────────────────────────────────────────────── *
 * 7 — Non-withheld send resolves promptly: `resolveClaudeTurnOutcome`'s
 * `PASTE_OUTCOME_TIMEOUT_MS` (15s — widened from 5s to give a queued
 * `/model` picker mirror ahead of the paste on the same per-task tmux chain
 * enough headroom, per its own doc comment in orchestrator.ts) race must not
 * delay an ordinary (non-withheld) send — it should settle off the paste's
 * real, fast outcome.
 *
 * RESTRUCTURED for the async tmux conversion (docs/plans/
 * fix-task-details-load-delay.md T1/T5): this test's "fold, not a fresh
 * spawn" proof (`sent.runId === r1`) depends on R1 still being in the
 * orchestrator's in-memory `active` set at the moment `sendInput` checks it —
 * true only while R1's fake turn hasn't resolved yet. Under the OLD sync
 * `tmux()`, `sessionLiveness`'s `has-session` probe blocked the event loop,
 * so the fake driver's own 20ms completion `setTimeout` could never fire
 * mid-probe; the "no await between startTask and sendInput" comment that used
 * to live here was sufficient on that guarantee alone. `sessionLiveness` (called from
 * `sendClaudeTurn` before the fold check) is now a genuine `await Bun.spawn`,
 * which yields the event loop — so a slow `AGETOR_TMUX_BIN` stub can now lose
 * the race against that 20ms timer where it never could before. This file's
 * `withRecordingTmuxBin` helper writes a FRESH `#!bun` script per call, and a
 * freshly-written executable pays a one-time macOS exec/Gatekeeper penalty on
 * first spawn (measured 130–350ms here) — nowhere near production's
 * already-cached real `tmux` binary, and enough alone to blow the fake's 20ms
 * budget across the several sequential tmux calls a fold does (liveness probe
 * + load-buffer/paste-buffer/send-keys). Using the file-scope `/bin/echo`
 * (already resident, no cold-start tax — much closer to a real installed
 * `tmux` binary's spawn cost) keeps the whole fold well under that budget, so
 * this test no longer needs a recording stub to prove the same guarantee: a
 * `delivered:true` + `runId === r1` result is only reachable through
 * `sendTurnInExistingSession`'s `pasteFollowUp` → `resolveClaudeTurnOutcome`
 * path, which itself only reports `delivered:true` once `pasteOutcome.ok` —
 * i.e. the real tmux paste calls already succeeded — so that pairing already
 * proves "a real tmux paste landed" without a separate call log. What's
 * dropped is only the redundant cross-check against recorded call
 * timestamps; the "not the 15s race" guarantee stays intact via `elapsed`.
 * ────────────────────────────────────────────────────────────────────────── */

test("non-withheld send: delivered:true resolves promptly, driven by the paste's real outcome, not the 15s race timeout", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "non-withheld-fold",
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

  // Install a REAL session so this takes the fold-capable path, same as
  // test 1 above — but the pane is a plain idle composer this time, so the
  // modal guard never engages and the paste lands immediately. Deliberately
  // NOT wrapped in `withRecordingTmuxBin` — see the restructuring note above.
  claudeTmux.__forTest.installSession(taskId, freshJsonl());
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(async () => "");

  try {
    // TIMING INVARIANT (mirrors test 1): no await between `startTask` above
    // and this call — R1 must still be in `active` when `sendInput` reads
    // it, so this folds instead of spawning a new turn. Holds here because
    // every tmux call the fold makes (liveness probe + load-buffer/
    // paste-buffer/send-keys) goes through the already-resident `/bin/echo`,
    // comfortably faster than the fake driver's 20ms completion timer.
    const start = Date.now();
    const sent = await sendInput(r1, "hello again");
    const elapsed = Date.now() - start;

    if (!sent.delivered) throw new Error(`expected delivered:true, got ${JSON.stringify(sent)}`);
    // Only reachable via the fold path (`sendTurnInExistingSession` →
    // `pasteFollowUp` → `resolveClaudeTurnOutcome`) — which is itself proof
    // the real tmux paste calls landed (see restructuring note above), so no
    // separate recorded-call cross-check is needed.
    expect(sent.runId).toBe(r1);

    // The 15s race (`PASTE_OUTCOME_TIMEOUT_MS`) must not be what resolved
    // this — a real, non-withheld paste lands almost immediately. The bound
    // here is generous (~30x the typical ~90-100ms observed against
    // `/bin/echo`) for a loaded machine while still catching a regression
    // that waits out anywhere near the full 15s race.
    expect(elapsed).toBeLessThan(3000);
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevCapture);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 8 — Model mirror success: the full 2.1.246 `/model` picker walk — open the
 * bare picker, arrow from the in-effect row to the target family, confirm
 * session-only ("s"), and auto-accept the resulting "Switch model?" confirm.
 * Never a typed `/model <id>` (that rewrites claude's GLOBAL default).
 * ────────────────────────────────────────────────────────────────────────── */

/** Verbatim-shaped claude 2.1.246 bare `/model` picker (5 rows, `✔` marks the
 *  row currently in effect, a run of ≥2 spaces gaps the name from its
 *  description) — copied from `mirrorModelViaPicker`'s own doc comment.
 *  Cursor starts on the Sonnet row (index 3), matching `before.model:
 *  "sonnet-5"` below. */
const MODEL_PICKER_PANE_CURSOR_ON_SONNET = [
  "  1. Default (recommended)  Opus 5 with 1M context, best for complex work",
  "  2. Opus (1M context)      Opus 5 with 1M context, cheaper for simple tasks",
  "  3. Fable                  Fable 5 — balanced speed and capability",
  "❯ 4. Sonnet ✔               Sonnet 5 — fast and cost-effective",
  "  5. Haiku                  Haiku 4.5 — fastest, most economical",
  "Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

/** Verbatim-shaped mid-conversation "Switch model?" confirm that follows
 *  pressing `s` on a row other than the one currently in effect. */
const SWITCH_MODEL_CONFIRM_PANE = [
  "Switch model?",
  "",
  "❯ 1. Yes, switch to Opus 5 (1M context)",
  "  2. No, go back",
].join("\n");

test("reconcileTaskSession: a full /model picker mirror walks the cursor, confirms session-only ('s'), and auto-accepts the resulting 'Switch model?' confirm — never a typed /model <id>", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-picker-success",
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

  const prevSettle = claudeTmux.__forTest.setSlashCommandSettleMs(0);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(async () => ""); // idle — guard passes
  let confirmPaneCalls = 0;
  const prevConfirmPane = claudeTmux.__forTest.setCaptureConfirmPane(async () => {
    confirmPaneCalls++;
    // `mirrorModelViaPicker`'s picker-detection poll registers on its very
    // FIRST sighting (no stability-gate, unlike the scraper's own matcher
    // chain), so exactly one call sees the picker; every call after the
    // arrow-walk + "s" keystroke belongs to the SEPARATE
    // `autoConfirmSlashModal` poll, which must see the "Switch model?"
    // confirm instead.
    return confirmPaneCalls <= 1 ? MODEL_PICKER_PANE_CURSOR_ON_SONNET : SWITCH_MODEL_CONFIRM_PANE;
  });

  try {
    await withRecordingTmuxBin(async (logPath) => {
      const before = tasks.get(taskId)!;
      const after = { ...before, model: "opus-5" };
      await reconcileTaskSession(taskId, before, after);
      // Belt-and-suspenders against any lingering chained op, mirroring this
      // file's other reconcileTaskSession tests, before reading the log.
      await claudeTmux.__forTest.pasteChains.get(taskId);

      const log = readTmuxLog(logPath);
      const loadBufferStdins = log.filter((e) => e.argv[0] === "load-buffer").map((e) => e.stdin);
      // Only ever a BARE "/model" paste — never the user's global-default
      // form `/model claude-opus-5`.
      expect(loadBufferStdins).toEqual(["/model"]);

      const sendKeys = log.filter((e) => e.argv[0] === "send-keys").map((e) => e.argv[e.argv.length - 1]);
      // The trailing 4 keys: the arrow walk from index 3 (Sonnet) to index 1
      // (Opus), the session-only confirm, and the auto-accepted "Switch
      // model?" Enter. (The very first Enter in the full log submits the
      // bare `/model` line itself, opening the picker.)
      expect(sendKeys.slice(-4)).toEqual(["Up", "Up", "s", "Enter"]);
    });
  } finally {
    claudeTmux.__forTest.setCaptureConfirmPane(prevConfirmPane);
    claudeTmux.__forTest.setCapturePastePane(prevPastePane);
    claudeTmux.__forTest.setSlashCommandSettleMs(prevSettle);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 9 — Model mirror: an id whose family the 2.1.246 picker can't select
 * exactly (`claudeModelPickerFamily` → null) skips the live mirror entirely.
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: a model id the picker can't select exactly (opus-4.8) skips the live mirror entirely — no paste at all, just an 'applies on the next run' breadcrumb", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-unsupported-family",
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
    fxSessionId: null,
  });

  try {
    await withRecordingTmuxBin(async (logPath) => {
      const before = tasks.get(taskId)!;
      const after = { ...before, model: "opus-4.8" };
      await reconcileTaskSession(taskId, before, after);

      const log = readTmuxLog(logPath);
      // `claudeModelPickerFamily("opus-4.8")` is null — reconcileTaskSession
      // must never even open the picker for an id it can't select exactly.
      expect(log.some((e) => e.argv[0] === "load-buffer")).toBe(false);
      expect(log.filter((e) => e.argv[0] === "send-keys")).toHaveLength(0);
    });

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts).toContain(
      "model opus-4.8 applies on the next run — claude's picker can't select it for this session",
    );
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 10 — Model mirror: the picker never renders (idle pane throughout) → poll
 * timeout → "picker not shown" breadcrumb, with no keystroke ever sent.
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: model mirror poll timeout when the picker never renders yields a 'picker not shown' breadcrumb", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-picker-not-shown",
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
    fxSessionId: null,
  });

  const prevSettle = claudeTmux.__forTest.setSlashCommandSettleMs(0);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(async () => "");
  // Idle throughout — the picker never renders on the pane at all.
  const prevConfirmPane = claudeTmux.__forTest.setCaptureConfirmPane(async () => "");

  try {
    const before = tasks.get(taskId)!;
    const after = { ...before, model: "opus-5" };
    await reconcileTaskSession(taskId, before, after);

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts).toContain(
      "⚠️ model change not applied — picker not shown; the task's model is opus-5 but the session kept its previous one",
    );
  } finally {
    claudeTmux.__forTest.setCaptureConfirmPane(prevConfirmPane);
    claudeTmux.__forTest.setCapturePastePane(prevPastePane);
    claudeTmux.__forTest.setSlashCommandSettleMs(prevSettle);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 11 — Model mirror: the picker is up but doesn't offer the target family
 * (claude renamed/dropped its row) → Escape closes it, "target not offered".
 * ────────────────────────────────────────────────────────────────────────── */

/** Same picker shape as `MODEL_PICKER_PANE_CURSOR_ON_SONNET` but WITHOUT the
 *  Fable row — used to drive `mirrorModelViaPicker`'s "target not offered"
 *  branch for `targetFamily: "Fable"`. */
const MODEL_PICKER_PANE_NO_FABLE = [
  "  1. Default (recommended)  Opus 5 with 1M context, best for complex work",
  "  2. Opus (1M context)      Opus 5 with 1M context, cheaper for simple tasks",
  "❯ 3. Sonnet ✔               Sonnet 5 — fast and cost-effective",
  "  4. Haiku                  Haiku 4.5 — fastest, most economical",
  "Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

test("reconcileTaskSession: model mirror closes the picker with Escape when the target family isn't offered, leaving a 'target not offered' breadcrumb", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-target-not-offered",
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
    fxSessionId: null,
  });

  const prevSettle = claudeTmux.__forTest.setSlashCommandSettleMs(0);
  const prevPastePane = claudeTmux.__forTest.setCapturePastePane(async () => "");
  const prevConfirmPane = claudeTmux.__forTest.setCaptureConfirmPane(async () => MODEL_PICKER_PANE_NO_FABLE);

  try {
    await withRecordingTmuxBin(async (logPath) => {
      const before = tasks.get(taskId)!;
      const after = { ...before, model: "fable-5" };
      await reconcileTaskSession(taskId, before, after);
      await claudeTmux.__forTest.pasteChains.get(taskId);

      const sendKeys = readTmuxLog(logPath)
        .filter((e) => e.argv[0] === "send-keys")
        .map((e) => e.argv[e.argv.length - 1]);
      expect(sendKeys).toContain("Escape");
      // No arrow walk and no confirm — the picker was closed, not driven.
      expect(sendKeys).not.toContain("s");
    });

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts.some((t) => t.startsWith("⚠️ model change not applied — target not offered"))).toBe(true);
    expect(statusTexts.some((t) => t.includes("fable-5"))).toBe(true);
  } finally {
    claudeTmux.__forTest.setCaptureConfirmPane(prevConfirmPane);
    claudeTmux.__forTest.setCapturePastePane(prevPastePane);
    claudeTmux.__forTest.setSlashCommandSettleMs(prevSettle);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 12 — Effort is NEVER mirrored into a live session (unlike model): no tmux
 * paste at all, just a breadcrumb naming the pinned launch effort.
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: an effort change is never mirrored into the live session — no tmux paste at all, just an 'applies on the next run' breadcrumb naming the pinned launch effort", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-effort-pinned",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const state = claudeTmux.__forTest.installSession(taskId, freshJsonl());
  // Pin a launch effort distinct from both before.effort and after.effort so
  // the assertion can only pass if the breadcrumb read THIS value, not a
  // fallback.
  state.launchEffort = "medium";

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
    fxSessionId: null,
  });

  try {
    await withRecordingTmuxBin(async (logPath) => {
      const before = tasks.get(taskId)!;
      const after = { ...before, effort: "xhigh" };
      await reconcileTaskSession(taskId, before, after);

      const log = readTmuxLog(logPath);
      expect(log.some((e) => e.argv[0] === "load-buffer")).toBe(false);
      expect(log.some((e) => e.argv[0] === "paste-buffer")).toBe(false);
      expect(log.some((e) => e.argv[0] === "send-keys")).toBe(false);
    });

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts).toContain(
      "effort xhigh applies on the next run — this session is pinned to medium by CLAUDE_CODE_EFFORT_LEVEL",
    );
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 13 — Effort breadcrumb fallback: no in-memory launch-effort pin recorded →
 * falls back to `before.effort` (see `emitEffortPinnedStatus`'s `?? beforeEffort`).
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: effort breadcrumb falls back to before.effort when the live session recorded no launch-effort pin", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-effort-fallback",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // No `state.launchEffort` override — stays null (default), so
  // `getSessionLaunchEffort` returns null and the breadcrumb must fall back
  // to `before.effort` ("high", from createTask above).
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
    fxSessionId: null,
  });

  try {
    const before = tasks.get(taskId)!;
    const after = { ...before, effort: "low" };
    await reconcileTaskSession(taskId, before, after);

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts).toContain(
      "effort low applies on the next run — this session is pinned to high by CLAUDE_CODE_EFFORT_LEVEL",
    );
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 14 — Model mirror: NO in-memory session state at all (`mirrorModelViaPicker`
 * only ever consults the in-memory `sessions` map — never `sessionExists`, a
 * REAL tmux `has-session` probe) reports "no live session" on the next-run
 * breadcrumb, never the ⚠️ failure framing. This file's top-level
 * `AGETOR_TMUX_BIN=/bin/echo` makes every tmux invocation exit 0 by default,
 * so `sessionExists(taskId)` is ambient-true here with no extra stubbing —
 * pinning that the mirror still correctly reports "no live session" (rather
 * than crashing, or treating the real tmux session as drivable) is exactly
 * the boot-reconciliation gap CLAUDE.md documents: a tmux session can outlive
 * agetor's process with no SessionState to paste into.
 * ────────────────────────────────────────────────────────────────────────── */

test("reconcileTaskSession: a model change with NO in-memory session state (even though the real tmux session still exists) reports 'no live session' on the next-run breadcrumb, never the ⚠️ failure framing", async () => {
  const { createTask, reconcileTaskSession } = await import("./orchestrator.ts");
  const { db, tasks, runs } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "reconcile-model-no-session-state",
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model: "sonnet-5",
    effort: "high",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // Deliberately NO claudeTmux.__forTest.installSession call.
  expect(claudeTmux.hasSessionState(taskId)).toBe(false);
  expect(await claudeTmux.sessionExists(taskId)).toBe(true);

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
    fxSessionId: null,
  });

  try {
    const before = tasks.get(taskId)!;
    const after = { ...before, model: "opus-5" };
    await reconcileTaskSession(taskId, before, after);

    const statusTexts = runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statusTexts).toContain("model opus-5 applies on the next run — no live session");
    expect(statusTexts.some((t) => t.startsWith("⚠️"))).toBe(false);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 15 — Whole-backlog dedupe: `restashPasteWithheldText` scans the WHOLE
 * backlog (not just index 0) — a repeated withhold of a message that's since
 * been pushed off the front by another draft must still dedupe.
 * ────────────────────────────────────────────────────────────────────────── */

test("withheld send: whole-backlog dedupe — a withheld message whose matching text already sits at backlog index 1 (not index 0) is not duplicated", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { db, runs, tasks, backlog } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");

  const created = await createTask({
    title: "withheld-dedupe-whole-backlog",
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
  await waitFor(() => tasks.get(taskId)?.column !== "running");

  // `backlog.add` unshifts (newest draft on top) — adding "are you there"
  // FIRST, then "already saved for later" SECOND, leaves "are you there" at
  // index 1, not index 0. A dedupe keyed only on `task.backlog[0]` would miss
  // this and add a THIRD (duplicate) item below.
  backlog.add(taskId, { text: "are you there" });
  backlog.add(taskId, { text: "already saved for later" });
  const seeded = tasks.get(taskId)!;
  expect(seeded.backlog.map((m) => m.text)).toEqual(["already saved for later", "are you there"]);

  claudeTmux.__forTest.installSession(taskId, freshJsonl());
  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);

  try {
    const sent = await sendInput(r1, "are you there");
    if (sent.delivered) throw new Error(`expected the withheld send to report delivered:false, got ${JSON.stringify(sent)}`);
    expect(sent.withheld).toBe(true);

    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => runs.listForTask(taskId).some((r) => r.id !== r1 && r.status === "failed"));

    const after = tasks.get(taskId)!;
    // Still exactly 2 items — the whole-backlog scan found the match at
    // index 1 (not just index 0) and skipped adding a third.
    expect(after.backlog.length).toBe(2);
    expect(after.backlog.map((m) => m.text).sort()).toEqual(
      ["already saved for later", "are you there"].sort(),
    );
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevCapture);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);

/* ────────────────────────────────────────────────────────────────────────── *
 * 16 — Ask-card free-text route: POST /ask-questions/:id/answer's custom/
 * free-text branch routes through `sendInput` (the ONLY ask-answer path that
 * can withhold — the "drive" path types keys straight into an already-open
 * modal, with no composer paste for a blocking modal to hold up), so a
 * blocking modal on the pane withholds it exactly like any other send and
 * threads the full { withheld, savedToBacklog, reason } shape into the HTTP
 * response.
 * ────────────────────────────────────────────────────────────────────────── */

test("POST /ask-questions/:id/answer: a custom free-text answer while a blocking modal is on the pane reports { ok:false, withheld:true, savedToBacklog:true } and stashes the answer text in the task's backlog", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { db, tasks } = await import("./db.ts");
  const claudeTmux = await import("./claude-tmux.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { registerScrapedAskQuestions } = await import("./interactions.ts");
  const { formatAnswersMessage } = await import("./claude-questions.ts");

  const created = await createTask({
    title: "ask-answer-withheld",
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
  // Idle before answering, same as the other ask-driven scenarios in this
  // file — the answer route's `sendInput` call takes the idle (new-run) path
  // rather than folding into a still-active run.
  await waitFor(() => tasks.get(taskId)?.column !== "running");

  claudeTmux.__forTest.installSession(taskId, freshJsonl());
  const prevGrace = claudeTmux.__forTest.setPasteModalGraceMs(20);
  const prevPoll = claudeTmux.__forTest.setPasteModalPollMs(10);
  const prevCapture = claudeTmux.__forTest.setCapturePastePane(async () => BLOCKING_PANE);

  const specs = [{ question: "Which approach?", multiSelect: false, options: ["A", "B"] }];
  const expectedText = formatAnswersMessage(specs, [{ selected: [], custom: "my own answer" }]);

  const askReq = registerScrapedAskQuestions({
    taskId,
    runId: r1,
    questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }],
    fingerprint: "fp-ask-answer-withheld",
  });

  const server = startApiServer() as unknown as { stop: () => void };
  try {
    const httpRes = await fetch(`http://127.0.0.1:4427/ask-questions/${askReq.id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ selected: [], custom: "my own answer" }] }),
    });
    expect(httpRes.status).toBe(200);
    const body = await httpRes.json();
    expect(body.ok).toBe(false);
    expect(body.withheld).toBe(true);
    expect(body.savedToBacklog).toBe(true);
    expect(typeof body.reason).toBe("string");
    expect(body.reason as string).toContain("backlog");

    await claudeTmux.__forTest.pasteChains.get(taskId);
    await waitFor(() => (tasks.get(taskId)?.backlog.length ?? 0) >= 1);
    const backlog = tasks.get(taskId)?.backlog ?? [];
    expect(backlog.some((m) => m.text === expectedText)).toBe(true);
  } finally {
    claudeTmux.__forTest.setCapturePastePane(prevCapture);
    claudeTmux.__forTest.setPasteModalGraceMs(prevGrace);
    claudeTmux.__forTest.setPasteModalPollMs(prevPoll);
    claudeTmux.__forTest.uninstallSession(taskId);
    server.stop();
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
}, 10_000);
