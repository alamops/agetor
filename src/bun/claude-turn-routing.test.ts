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

function readLog(logPath: string): Array<{ argv: string[] }> {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
      branch: null,
      worktreePath: null,
      baseRef: null,
      mode: null,
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [],
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
      branch: null,
      worktreePath: null,
      baseRef: null,
      mode: null,
      // buildCommand requires a model + effort for claude-code even on this
      // stub-bin path — see claude-followup-restart.test.ts's identical note.
      model: "claude-opus-4-7",
      effort: "medium",
      references: [], backlog: [],
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
