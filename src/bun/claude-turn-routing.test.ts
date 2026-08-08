import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Regression tests for the liveness-aware follow-up gate added to
// orchestrator.ts's `sendClaudeTurn` (see docs/plans/tmux-sessions-killed-
// unexpectedly.md §3.3). The gate used to key off a raw boolean
// `sessionExists()`, so a transient tmux probe hiccup (busy shared server,
// ambiguous "error connecting" message) was indistinguishable from a
// genuinely dead session — routing a *live, possibly mid-turn* session into
// `spawnResumedSession`'s unconditional pre-kill and tearing it down. The fix
// gates on `hasSessionState(taskId) && sessionLiveness(name) !== "gone"`:
// only an UNAMBIGUOUS "gone" (or no in-memory state at all) may reach the
// destructive respawn path; anything else — including "unreachable" — takes
// the non-destructive existing-session (paste) path.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-turn-routing-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const saved: Record<string, string | undefined> = {};
function restoreEnv(key: string) {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
}

beforeAll(async () => {
  for (const k of ["AGETOR_TMUX_BIN", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN"]) {
    saved[k] = process.env[k];
  }
  await import("./db.ts");
});

afterAll(() => {
  restoreEnv("AGETOR_TMUX_BIN");
  restoreEnv("AGETOR_CLAUDE_DRIVER");
  restoreEnv("AGETOR_CLAUDE_BIN");
});

/**
 * Write an executable fake tmux that:
 *  - logs every invocation's full argv (including the leading
 *    `tmuxSocketArgs()` pair, e.g. `-L agetor-test` — irrelevant to these
 *    assertions since we only check for subcommand *presence*, not position)
 *    as one JSON line to `logPath`.
 *  - for a `has-session` probe specifically, exits `probeCode` with
 *    `probeStderr` — this is the liveness signal under test.
 *  - for anything else (kill-session, new-session, capture-pane, ...), exits
 *    0 so the caller's happy path proceeds and the call still gets recorded.
 */
function fakeRoutingTmuxBin(probeCode: number, probeStderr: string): { bin: string; logPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-routing-tmux-"));
  const bin = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `const argv = process.argv.slice(2);\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv }) + "\\n");\n` +
      `if (argv.includes("has-session")) {\n` +
      `  process.stderr.write(${JSON.stringify(probeStderr)});\n` +
      `  process.exit(${probeCode});\n` +
      `}\n` +
      `process.exit(0);\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, logPath };
}

function readLog(logPath: string): Array<{ argv: string[]; stdin?: string }> {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Write an executable fake tmux for the deferred-large-prompt regression
 * tests below. Unlike `fakeRoutingTmuxBin` (a single fixed `has-session`
 * verdict for the whole test), this stub needs to answer `has-session`
 * differently *before* vs *after* the session is actually created: the
 * routing gate in `sendClaudeTurn` must see "gone" (so the follow-up takes
 * the respawn path), while `spawnClaudeViaTmux`'s post-launch deferred-paste
 * loop — which polls the SAME deterministic session name — must see the
 * session as alive once `new-session` has run, or it bails out without
 * pasting.
 *
 * Session existence is tracked with marker files (one per session name,
 * created on `new-session`, removed on `kill-session`) rather than a fixed
 * verdict, so `has-session` reports real create/kill order like actual tmux
 * would.
 *
 * Every invocation also drains and records stdin (`readFileSync(0)`) — this
 * is how `load-buffer -b <buf> -` receives the pasted prompt in the real
 * paste path (`pastePromptSync`), and the stub must consume it rather than
 * leave it unread so the parent's `Bun.spawnSync` write can't block/fail on
 * a bigger-than-pipe-buffer payload.
 */
function fakeDeferredPasteTmuxBin(): { bin: string; logPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-deferred-tmux-"));
  const bin = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  const markerDir = path.join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n` +
      `import path from "node:path";\n` +
      `const argv = process.argv.slice(2);\n` +
      `let stdin = "";\n` +
      `try { stdin = readFileSync(0, "utf8"); } catch {}\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, stdin }) + "\\n");\n` +
      `function sessionArg() {\n` +
      `  const sIdx = argv.indexOf("-s");\n` +
      `  if (sIdx !== -1) return argv[sIdx + 1];\n` +
      `  const tIdx = argv.indexOf("-t");\n` +
      `  if (tIdx !== -1) { let v = argv[tIdx + 1]; if (v && v.startsWith("=")) v = v.slice(1); return v; }\n` +
      `  return null;\n` +
      `}\n` +
      `const markerDir = ${JSON.stringify(markerDir)};\n` +
      `if (argv.includes("new-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name) writeFileSync(path.join(markerDir, name), "1");\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (argv.includes("kill-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name) { try { rmSync(path.join(markerDir, name)); } catch {} }\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (argv.includes("has-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name && existsSync(path.join(markerDir, name))) process.exit(0);\n` +
      `  process.stderr.write("can't find session: =" + (name ?? "unknown"));\n` +
      `  process.exit(1);\n` +
      `}\n` +
      `process.exit(0);\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, logPath };
}

test("a transient/unreachable tmux probe routes a follow-up through the existing-session path, never the resume pre-kill", async () => {
  // Fake bin: has-session fails with the ambiguous "resource temporarily
  // unavailable" connect error the incident report couldn't rule out —
  // `sessionLiveness` must classify this as `unreachable`, never `gone`.
  const { bin, logPath } = fakeRoutingTmuxBin(
    1,
    "error connecting to /tmp/x (resource temporarily unavailable)",
  );
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER;
  delete process.env.AGETOR_CLAUDE_BIN;

  const { tasks, runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { __forTest } = await import("./claude-tmux.ts");

  const taskId = `task-transient-${randomUUID()}`;
  const priorRunId = `run-transient-${randomUUID()}`;
  const now = Date.now();
  const jsonlDir = mkdtempSync(path.join(tmpdir(), "agetor-routing-jsonl-"));
  const jsonlPath = path.join(jsonlDir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");

  // In-memory SessionState present (the gate's other precondition).
  const state = __forTest.installSession(taskId, jsonlPath);
  const prevGap = __forTest.setBracketedEnterGapMs(0);
  const prevSettle = __forTest.setSlashCommandSettleMs(0);
  try {
    tasks.insert({
      id: taskId,
      title: "transient",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir: "/tmp",
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: null, // idle — no in-flight run to fold this follow-up into
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: state.sessionName,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, "still there?");
    expect(result.delivered).toBe(true);

    // Let the fire-and-forget paste chain (queuePaste) run its course.
    await new Promise((r) => setTimeout(r, 100));

    const entries = readLog(logPath);
    // The probe (and the paste's tmux calls) actually ran.
    expect(entries.length).toBeGreaterThan(0);
    // The whole point of the gate: an unreachable probe must never reach
    // the destructive respawn path's pre-kill or the fresh session it
    // would otherwise create.
    expect(entries.some((e) => e.argv.includes("kill-session"))).toBe(false);
    expect(entries.some((e) => e.argv.includes("new-session"))).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
    __forTest.setBracketedEnterGapMs(prevGap);
    __forTest.setSlashCommandSettleMs(prevSettle);
  }
});

test("an unambiguous 'gone' probe routes a follow-up through the resume path (kill-session then new-session, in order)", async () => {
  // Fake bin: has-session fails with tmux's unambiguous "session not found"
  // string — sessionLiveness must classify this as `gone`, which is the ONLY
  // outcome (short of missing SessionState entirely) allowed to reach
  // spawnResumedSession's pre-kill.
  const { bin, logPath } = fakeRoutingTmuxBin(1, "can't find session: =agetor-x");
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless stub launch command

  const { tasks, runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { __forTest, dropSession, jsonlPathFor } = await import("./claude-tmux.ts");

  const taskId = `task-gone-${randomUUID()}`;
  const priorRunId = `run-gone-${randomUUID()}`;
  const priorClaudeSessionId = "prior-claude-session-id";
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-routing-wd-"));
  const jsonlDir = mkdtempSync(path.join(tmpdir(), "agetor-routing-jsonl-"));
  const jsonlPath = path.join(jsonlDir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");

  // The resume path (spawnResumedSession -> spawnAgent) resumes via
  // `--resume <priorClaudeSessionId>`, so `spawnClaudeViaTmux`'s async
  // boot-wait looks for the JSONL at the deterministic path derived from
  // (workdir, priorClaudeSessionId, configDir=null for the built-in
  // claude-code harness). Pre-creating it here means that wait resolves
  // synchronously (`existsSync` at the top of `waitForJsonlAt`) instead of
  // spinning for up to 30s — without this, the dangling background poller
  // keeps re-resolving `AGETOR_TMUX_BIN` (which is process-global) and can
  // fire stray `has-session`/`capture-pane` calls into whichever OTHER test
  // file happens to be running by then, since bun runs all files given on
  // one `bun test` invocation in a single process.
  const expectedJsonlPath = jsonlPathFor(workdir, priorClaudeSessionId, null);
  mkdirSync(path.dirname(expectedJsonlPath), { recursive: true });
  writeFileSync(expectedJsonlPath, "");

  // SessionState IS present — proves the "gone" classification overrides
  // hasSessionState rather than merely substituting for its absence (the
  // other legitimate reason to take this path, covered by
  // claude-followup-restart.test.ts).
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    tasks.insert({
      id: taskId,
      title: "gone",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      // buildCommand requires a model + effort for claude-code even on this
      // stub-bin path — see claude-followup-restart.test.ts's identical note.
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: state.sessionName,
      claudeSessionId: priorClaudeSessionId,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, "please continue");
    expect(result.delivered).toBe(true);

    const entries = readLog(logPath);
    const killIdx = entries.findIndex((e) => e.argv.includes("kill-session"));
    const newIdx = entries.findIndex((e) => e.argv.includes("new-session"));
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeLessThan(newIdx);

    // Give the background boot-wait a beat to observe the pre-created JSONL
    // and settle (bootSettled=true) before this test — and the dangling
    // AGETOR_TMUX_BIN it keeps re-resolving — hands off to the next test.
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    // Dispose in-memory state + kill whatever (fake) session is now named
    // for this task, mirroring claude-followup-restart.test.ts's cleanup.
    dropSession(taskId);
    rmSync(path.dirname(expectedJsonlPath), { recursive: true, force: true });
  }
});

// Regression tests for the fix in commit de27191 (see
// docs/plans/fix-claude-resume-large-prompt-tmux-argv.md): a follow-up whose
// prompt is bigger than `CLAUDE_PROMPT_ARGV_MAX_BYTES` used to ride the
// entire way to `tmux new-session`'s argv, and tmux 3.6a rejects any client
// command past its ~16KB imsg cap with a literal `command too long` — so a
// large paste sent to a task whose session had ended failed the spawn
// outright, before claude ever started. `buildCommand` now omits an
// oversized prompt from argv and hands it back as `deferredPrompt`;
// `spawnClaudeViaTmux` boots a bare claude and pastes the prompt in once the
// composer is confirmed idle via the same load-buffer/paste-buffer machinery
// live-session follow-ups use.

test("a large (>4KB) follow-up resume never embeds the prompt in new-session argv — it's delivered via load-buffer/paste-buffer instead", async () => {
  const { bin, logPath } = fakeDeferredPasteTmuxBin();
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless stub launch command

  const { db, tasks, runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { __forTest, dropSession, jsonlPathFor } = await import("./claude-tmux.ts");
  const { CLAUDE_PROMPT_ARGV_MAX_BYTES } = await import("./agents.ts");

  const taskId = `task-large-${randomUUID()}`;
  const priorRunId = `run-large-${randomUUID()}`;
  const priorClaudeSessionId = "prior-claude-session-id-large";
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-large-wd-"));

  // Same rationale as the "gone" test above: pre-create the JSONL the resume
  // spawn will look for at the deterministic (workdir, sessionId) path so the
  // boot-wait resolves synchronously instead of spinning.
  const expectedJsonlPath = jsonlPathFor(workdir, priorClaudeSessionId, null);
  mkdirSync(path.dirname(expectedJsonlPath), { recursive: true });
  writeFileSync(expectedJsonlPath, "");

  // Make claude's composer look immediately idle so the deferred-paste
  // readiness gate (`readPaneMode`, which reads via this seam) fires on its
  // first poll instead of spinning toward DEFERRED_PROMPT_TIMEOUT_MS (30s).
  const prevCapture = __forTest.setCaptureModePane(() => "? for shortcuts");
  const prevGap = __forTest.setBracketedEnterGapMs(0);
  const prevSettle = __forTest.setSlashCommandSettleMs(0);

  // Comfortably over the threshold regardless of its exact value.
  const largePrompt = "x".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES + 500);
  expect(Buffer.byteLength(largePrompt, "utf8")).toBeGreaterThan(CLAUDE_PROMPT_ARGV_MAX_BYTES);

  try {
    tasks.insert({
      id: taskId,
      title: "large-prompt-resume",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: "agetor-stale-name",
      claudeSessionId: priorClaudeSessionId,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, largePrompt);
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error(result.reason);
    const newRunId = result.runId;

    // Let the spawn + the fire-and-forget deferred-paste chain run their
    // course (readiness is immediate given the captureModePane stub above,
    // so this only needs to cover a handful of synchronous tmux round-trips,
    // not the real 30s timeout).
    await new Promise((r) => setTimeout(r, 800));

    const entries = readLog(logPath);

    const newSessionEntries = entries.filter((e) => e.argv.includes("new-session"));
    expect(newSessionEntries.length).toBeGreaterThan(0);
    // The whole point of the fix: the large prompt must never appear inside
    // a `new-session` invocation's argv.
    for (const e of newSessionEntries) {
      expect(e.argv.some((a) => a.includes(largePrompt))).toBe(false);
    }

    // It must instead have been delivered over stdin via `load-buffer`.
    const loadBufferEntries = entries.filter((e) => e.argv.includes("load-buffer"));
    expect(loadBufferEntries.length).toBeGreaterThan(0);
    expect(loadBufferEntries.some((e) => e.stdin === largePrompt)).toBe(true);

    // ...followed by a paste-buffer + Enter to actually submit it.
    const pasteBufferEntries = entries.filter((e) => e.argv.includes("paste-buffer"));
    expect(pasteBufferEntries.length).toBeGreaterThan(0);
    const sendKeysEnterEntries = entries.filter(
      (e) => e.argv.includes("send-keys") && e.argv.includes("Enter"),
    );
    expect(sendKeysEnterEntries.length).toBeGreaterThan(0);

    // The run must not have failed with the "command too long" symptom the
    // fix addresses — since `new-session` never got the oversized argv from
    // this fake tmux, it always exits 0, but assert the negative directly so
    // this test would also catch a regression that reintroduced the
    // embed-in-argv behavior against a real tmux binary's failure text.
    const runEvents = db
      .query<{ stream: string; data: string }, [string]>(
        `SELECT stream, data FROM run_events WHERE run_id = ?`,
      )
      .all(newRunId);
    expect(runEvents.some((e) => e.data.includes("tmux new-session failed"))).toBe(false);
    expect(runEvents.some((e) => e.data.includes("command too long"))).toBe(false);
  } finally {
    __forTest.setCaptureModePane(prevCapture);
    __forTest.setBracketedEnterGapMs(prevGap);
    __forTest.setSlashCommandSettleMs(prevSettle);
    dropSession(taskId);
    rmSync(path.dirname(expectedJsonlPath), { recursive: true, force: true });
  }
});

// Regression tests for the opus code-review findings on the deferred-paste
// fix above (commits de27191 + c6242ae): cancel-during-wait must abort the
// deferred paste instead of pasting a prompt the user already cancelled, and
// a failed paste must settle the run instead of leaving it `running` forever.

test("cancelling a run while its large prompt is deferred (composer never confirmed idle) never pastes it — the run settles cancelled", async () => {
  const { bin, logPath } = fakeDeferredPasteTmuxBin();
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless stub launch command

  const { tasks, runs } = await import("./db.ts");
  const { sendInput, cancelRun } = await import("./orchestrator.ts");
  const { __forTest, dropSession, jsonlPathFor } = await import("./claude-tmux.ts");
  const { CLAUDE_PROMPT_ARGV_MAX_BYTES } = await import("./agents.ts");

  const taskId = `task-cancel-deferred-${randomUUID()}`;
  const priorRunId = `run-cancel-deferred-${randomUUID()}`;
  const priorClaudeSessionId = "prior-claude-session-id-cancel";
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-cancel-wd-"));

  const expectedJsonlPath = jsonlPathFor(workdir, priorClaudeSessionId, null);
  mkdirSync(path.dirname(expectedJsonlPath), { recursive: true });
  writeFileSync(expectedJsonlPath, "");

  // Keep the composer looking perpetually NOT ready — the deferred-paste
  // loop's readiness gate (`readPaneMode`) never fires, so it sits in its
  // poll loop exactly like a launch whose claude session is slow to boot.
  // This is the window a Stop click needs to land in for the bug to repro.
  const prevCapture = __forTest.setCaptureModePane(() => "");
  const prevGap = __forTest.setBracketedEnterGapMs(0);
  const prevSettle = __forTest.setSlashCommandSettleMs(0);

  const largePrompt = "y".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES + 500);

  try {
    tasks.insert({
      id: taskId,
      title: "cancel-deferred-resume",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: "agetor-stale-name",
      claudeSessionId: priorClaudeSessionId,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, largePrompt);
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error(result.reason);
    const newRunId = result.runId;

    // Give the spawn a moment to run `new-session` and let the deferred-paste
    // IIFE reach its poll loop (composer stays "" so it never breaks out).
    await new Promise((r) => setTimeout(r, 150));

    expect(cancelRun(newRunId)).toBe(true);

    // Let the poll loop wake at least once (DEFERRED_PROMPT_POLL_MS = 400ms)
    // after the cancel and observe the slot is gone.
    await new Promise((r) => setTimeout(r, 700));

    // Now flip the composer to "ready" — if the abort check were missing,
    // the very next poll tick would go ahead and paste. Give it another
    // full poll interval to prove it doesn't.
    __forTest.setCaptureModePane(() => "? for shortcuts");
    await new Promise((r) => setTimeout(r, 700));

    const entries = readLog(logPath);
    // The whole point of the fix: a cancelled launch must never paste the
    // deferred prompt, no matter how long the wait or how the composer
    // eventually looks.
    expect(entries.some((e) => e.argv.includes("load-buffer"))).toBe(false);
    expect(entries.some((e) => e.argv.includes("paste-buffer"))).toBe(false);

    const list = runs.listForTask(taskId);
    const settled = list.find((r) => r.id === newRunId);
    expect(settled?.status).toBe("cancelled");
  } finally {
    __forTest.setCaptureModePane(prevCapture);
    __forTest.setBracketedEnterGapMs(prevGap);
    __forTest.setSlashCommandSettleMs(prevSettle);
    dropSession(taskId);
    rmSync(path.dirname(expectedJsonlPath), { recursive: true, force: true });
  }
});

test("a failed deferred paste (load-buffer errors) settles the run instead of leaving it running forever", async () => {
  // Same fake tmux as the happy-path deferred test, except `load-buffer`
  // always fails — simulates a dead socket / vanished pane mid-paste.
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-deferred-fail-tmux-"));
  const bin = path.join(dir, "tmux");
  const logPath = path.join(dir, "log.jsonl");
  const markerDir = path.join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n` +
      `import path from "node:path";\n` +
      `const argv = process.argv.slice(2);\n` +
      `let stdin = "";\n` +
      `try { stdin = readFileSync(0, "utf8"); } catch {}\n` +
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, stdin }) + "\\n");\n` +
      `function sessionArg() {\n` +
      `  const sIdx = argv.indexOf("-s");\n` +
      `  if (sIdx !== -1) return argv[sIdx + 1];\n` +
      `  const tIdx = argv.indexOf("-t");\n` +
      `  if (tIdx !== -1) { let v = argv[tIdx + 1]; if (v && v.startsWith("=")) v = v.slice(1); return v; }\n` +
      `  return null;\n` +
      `}\n` +
      `const markerDir = ${JSON.stringify(markerDir)};\n` +
      `if (argv.includes("new-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name) writeFileSync(path.join(markerDir, name), "1");\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (argv.includes("kill-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name) { try { rmSync(path.join(markerDir, name)); } catch {} }\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `if (argv.includes("has-session")) {\n` +
      `  const name = sessionArg();\n` +
      `  if (name && existsSync(path.join(markerDir, name))) process.exit(0);\n` +
      `  process.stderr.write("can't find session: =" + (name ?? "unknown"));\n` +
      `  process.exit(1);\n` +
      `}\n` +
      // The failure under test: load-buffer (the first step of the deferred
      // paste) always errors.
      `if (argv.includes("load-buffer")) {\n` +
      `  process.stderr.write("no such file or directory");\n` +
      `  process.exit(1);\n` +
      `}\n` +
      `process.exit(0);\n`,
  );
  chmodSync(bin, 0o755);

  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless stub launch command

  const { tasks, runs } = await import("./db.ts");
  const { sendInput } = await import("./orchestrator.ts");
  const { __forTest, dropSession, jsonlPathFor } = await import("./claude-tmux.ts");
  const { CLAUDE_PROMPT_ARGV_MAX_BYTES } = await import("./agents.ts");

  const taskId = `task-paste-fail-${randomUUID()}`;
  const priorRunId = `run-paste-fail-${randomUUID()}`;
  const priorClaudeSessionId = "prior-claude-session-id-fail";
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-paste-fail-wd-"));

  const expectedJsonlPath = jsonlPathFor(workdir, priorClaudeSessionId, null);
  mkdirSync(path.dirname(expectedJsonlPath), { recursive: true });
  writeFileSync(expectedJsonlPath, "");

  // Make the composer look immediately idle so the deferred-paste loop fires
  // its (doomed) paste attempt right away instead of spinning toward the
  // 30s timeout.
  const prevCapture = __forTest.setCaptureModePane(() => "? for shortcuts");
  const prevGap = __forTest.setBracketedEnterGapMs(0);
  const prevSettle = __forTest.setSlashCommandSettleMs(0);

  const largePrompt = "z".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES + 500);

  try {
    tasks.insert({
      id: taskId,
      title: "paste-fail-resume",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: "agetor-stale-name",
      claudeSessionId: priorClaudeSessionId,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, largePrompt);
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error(result.reason);
    const newRunId = result.runId;

    // Let the spawn + the fire-and-forget deferred-paste chain run their
    // course, including the doomed load-buffer call and its failure
    // handling.
    await new Promise((r) => setTimeout(r, 800));

    const entries = readLog(logPath);
    expect(entries.some((e) => e.argv.includes("load-buffer"))).toBe(true);
    // paste-buffer must never have been reached — load-buffer failed first.
    expect(entries.some((e) => e.argv.includes("paste-buffer"))).toBe(false);

    // The whole point of the fix: a failed deferred paste must settle the
    // run (not leave it stuck `running` forever waiting on an end_turn that
    // will never arrive, since claude never received the prompt).
    const list = runs.listForTask(taskId);
    const settled = list.find((r) => r.id === newRunId);
    expect(settled?.status).not.toBe("running");
    expect(settled?.status).toBe("failed");
  } finally {
    __forTest.setCaptureModePane(prevCapture);
    __forTest.setBracketedEnterGapMs(prevGap);
    __forTest.setSlashCommandSettleMs(prevSettle);
    dropSession(taskId);
    rmSync(path.dirname(expectedJsonlPath), { recursive: true, force: true });
  }
});

test("a small (<=4KB) follow-up resume still embeds the prompt in new-session argv — deferral doesn't fire for the common case", async () => {
  // Reuse the fixed-verdict stub (uniform "gone" so the routing gate always
  // takes the respawn path) — this test only cares about the argv shape of
  // the resulting `new-session`, not post-launch readiness polling, so the
  // simpler stub from the "gone" test above is sufficient.
  const { bin, logPath } = fakeRoutingTmuxBin(1, "can't find session: =agetor-x");
  process.env.AGETOR_TMUX_BIN = bin;
  delete process.env.AGETOR_CLAUDE_DRIVER; // force the real spawnClaudeViaTmux path
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo"; // harmless stub launch command

  const { tasks, runs } = await import("./db.ts");
  const { __forTest, dropSession, jsonlPathFor } = await import("./claude-tmux.ts");
  const { sendInput } = await import("./orchestrator.ts");

  const taskId = `task-small-${randomUUID()}`;
  const priorRunId = `run-small-${randomUUID()}`;
  const priorClaudeSessionId = "prior-claude-session-id-small";
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-small-wd-"));

  const expectedJsonlPath = jsonlPathFor(workdir, priorClaudeSessionId, null);
  mkdirSync(path.dirname(expectedJsonlPath), { recursive: true });
  writeFileSync(expectedJsonlPath, "");

  const smallPrompt = "please continue with the small change";

  try {
    tasks.insert({
      id: taskId,
      title: "small-prompt-resume",
      prompt: "p",
      column: "review",
      agent: "claude-code",
      workdir,
      isolation: "none",
      taskType: "task",
      fast: false,
      branch: null,
      branchSource: "created",
      worktreePath: null,
      baseRef: null,
      prUrl: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [], draft: null,
      runId: priorRunId,
      hasOpenableRun: false,
      pendingInteractionCount: 0,
      openTerminalCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    runs.insert({
      id: priorRunId,
      taskId,
      agent: "claude-code",
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: "agetor-stale-name",
      claudeSessionId: priorClaudeSessionId,
      codexSessionId: null,
      cursorSessionId: null,
    });

    const result = await sendInput(priorRunId, smallPrompt);
    expect(result.delivered).toBe(true);

    await new Promise((r) => setTimeout(r, 300));

    const entries = readLog(logPath);
    const newSessionEntries = entries.filter((e) => e.argv.includes("new-session"));
    expect(newSessionEntries.length).toBeGreaterThan(0);
    // Guards against accidentally deferring everything: a short prompt must
    // still ride inside the `new-session` argv, exactly as before the fix.
    expect(newSessionEntries.some((e) => e.argv.includes(smallPrompt))).toBe(true);

    // And, precisely because it wasn't deferred, no paste machinery should
    // have fired for it at all.
    expect(entries.some((e) => e.argv.includes("load-buffer"))).toBe(false);
  } finally {
    dropSession(taskId);
    rmSync(path.dirname(expectedJsonlPath), { recursive: true, force: true });
  }
});
