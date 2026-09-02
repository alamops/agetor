import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import type { Task } from "../shared/types.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-death-"));

const {
  __forTest,
  sessionLiveness,
  fileWrittenWithin,
  deathTickOutcome,
  reattachSession,
  jsonlPathFor,
  dropSession,
  setHeldSessionProbe,
} = await import("./claude-tmux.ts");
// Dynamic import (not a static top-level one) so it resolves AFTER the
// AGETOR_DATA_DIR assignment above — a static import would be hoisted and
// run before that assignment, capturing the wrong data dir (db.ts reads the
// env var at module load).
const { db, tasks, subagents } = await import("./db.ts");

/** Write an executable fake `tmux` that emits `stderr` and exits `code`, then
 *  point AGETOR_TMUX_BIN at it. Returns a restore fn. */
function fakeTmux(code: number, stderr: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-faketmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(bin, `#!/bin/sh\n>&2 printf '%s' ${JSON.stringify(stderr)}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: (stream: string, data: string) => out.push({ stream, data }),
  };
}

function freshSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-death-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, jsonlPath, state };
}

test("signalSessionDeath settles the in-flight turn and emits the session-died sentinel", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    // A turn is in flight: push a slot whose `done` promise the driver awaits.
    const done = __forTest.pushTurnSlot(state, rec.onChunk);
    expect(__forTest.turnInFlight(state)).toBe(true);

    __forTest.signalSessionDeath(state);

    // The turn's promise resolves (with 0 — the orchestrator distinguishes a
    // death from success via the handle flag, not the exit code).
    const code = await done;
    expect(code).toBe(0);

    // A sentinel status chunk was emitted so the orchestrator flips to
    // `blocked` and the user sees why the run stopped.
    const sentinel = rec.out.find(
      (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
    );
    expect(sentinel).toBeDefined();

    // The slot was consumed — no longer in flight.
    expect(__forTest.turnInFlight(state)).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("signalSessionDeath is a no-op when no turn is in flight (idle session death)", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    // No slot pushed and no reattach onEndOfTurn → not in flight.
    expect(__forTest.turnInFlight(state)).toBe(false);

    __forTest.signalSessionDeath(state);

    // Nothing emitted — an idle session dying between turns isn't a "running
    // task" problem, so we don't surface a spurious blocked event.
    expect(rec.out.length).toBe(0);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("F5: a throwing heldSessionProbe is treated as not-held (no crash, no emission)", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  const prevProbe = setHeldSessionProbe(() => { throw new Error("boom: SQLite busy"); });
  try {
    // No slot pushed and no reattach onEndOfTurn → not in flight — the only
    // way this call reaches the probe at all is the `!turnInFlight` guard.
    expect(__forTest.turnInFlight(state)).toBe(false);

    // Must not throw out of signalSessionDeath even though the probe does.
    expect(() => __forTest.signalSessionDeath(state)).not.toThrow();

    // Treated as "not held" (same as the probe returning false / being unset)
    // → the no-op idle-death path, nothing emitted.
    expect(rec.out.length).toBe(0);
  } finally {
    setHeldSessionProbe(prevProbe);
    __forTest.uninstallSession(taskId);
  }
});

test("sessionLiveness: exit 0 is alive", async () => {
  const restore = fakeTmux(0, "");
  try { expect(await sessionLiveness("agetor-x")).toBe("alive"); } finally { restore(); }
});

test("sessionLiveness: 'can't find session' with a responsive server is gone", async () => {
  const restore = fakeTmux(1, "can't find session: agetor-x");
  try { expect(await sessionLiveness("agetor-x")).toBe("gone"); } finally { restore(); }
});

test("sessionLiveness: any ambiguous / unknown failure is unreachable, never a death", async () => {
  // The regression: a busy shared tmux server too swamped to answer, an ambiguous
  // connect error, or ANY string we don't recognize must never be read as a dead
  // session — that's what abandoned live, working sessions. We don't know the
  // incident's exact transient string, so the unknown case must be conservative.
  for (const stderr of [
    "error connecting to /tmp/tmux-501/default (Resource temporarily unavailable)",
    "resource temporarily unavailable",
    "error connecting to /tmp/tmux-501/default (No such file or directory)", // ambiguous
    "some unrecognized tmux error", // unknown → conservative
    "", // a torn-down client can exit non-zero with no diagnostics
  ]) {
    const restore = fakeTmux(1, stderr);
    try { expect(await sessionLiveness("agetor-x")).toBe("unreachable"); } finally { restore(); }
  }
});

test("sessionLiveness: only an UNAMBIGUOUS dead session or dead server is gone", async () => {
  // During an in-flight turn our own session keeps the shared server alive, so
  // "no server running"/"lost server" means the server died WITH our session — a
  // real death. "session not found" is the server saying our session is absent.
  // These strings are never emitted spuriously, so they're safe to fire on.
  for (const stderr of [
    "can't find session: agetor-x",
    "session not found: agetor-x",
    "no such session: agetor-x",
    "no server running on /tmp/tmux-501/default",
    "lost server",
  ]) {
    const restore = fakeTmux(1, stderr);
    try { expect(await sessionLiveness("agetor-x")).toBe("gone"); } finally { restore(); }
  }
});

test("deathTickOutcome: only consecutive gone+stale ticks fire; alive/unreachable/fresh-log reset", () => {
  const t = 4;
  // A live or merely-unreachable probe always resets, regardless of accumulated misses.
  expect(deathTickOutcome({ liveness: "alive", logFresh: false, misses: 3, threshold: t })).toBe("reset");
  expect(deathTickOutcome({ liveness: "unreachable", logFresh: false, misses: 3, threshold: t })).toBe("reset");
  // A `gone` probe is vetoed by a freshly-written log (agent provably alive).
  expect(deathTickOutcome({ liveness: "gone", logFresh: true, misses: 3, threshold: t })).toBe("reset");
  // `gone` + stale log accumulates, then fires on the threshold-th consecutive tick.
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 0, threshold: t })).toBe("wait");
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 2, threshold: t })).toBe("wait");
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 3, threshold: t })).toBe("fire");
});

test("fileWrittenWithin: true for a just-written file, false once it ages out, false when missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-recency-"));
  const f = path.join(dir, "log.jsonl");
  writeFileSync(f, "x");
  expect(fileWrittenWithin(f, 3_000)).toBe(true);
  // Backdate the mtime well past the window.
  const old = Date.now() / 1000 - 60;
  utimesSync(f, old, old);
  expect(fileWrittenWithin(f, 3_000)).toBe(false);
  expect(fileWrittenWithin(path.join(dir, "nope.jsonl"), 3_000)).toBe(false);
});

test("signalSessionDeath fires the reattach onEndOfTurn hook when there's no slot", async () => {
  const { taskId, state } = freshSession();
  try {
    // Reattached in-flight run: no in-process slot, but an onEndOfTurn hook the
    // orchestrator installed so it can flip the run row on completion.
    let fired = false;
    state.onEndOfTurn = () => { fired = true; };
    expect(__forTest.turnInFlight(state)).toBe(true);

    __forTest.signalSessionDeath(state);

    expect(fired).toBe(true);
    // Fire-once: the hook is cleared so a stray later tick can't double-fire.
    expect(state.onEndOfTurn).toBeNull();
    expect(__forTest.turnInFlight(state)).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * #93/wave-1 — `setHeldSessionProbe` widened BOTH `startDeathWatch`'s
 * poll-reset guard and `signalSessionDeath`'s early-return guard from
 * `!turnInFlight(state)` to `!turnInFlight(state) && !heldSessionProbe?.(taskId)`
 * (see docs/plans/fix-stream-list-stalls-with-bg-agents.md §4/T2b). The tests
 * above exercise `signalSessionDeath` directly against a synthetic
 * `installSession` state (no live timers) — that's the right tool for the
 * early-return guard alone, but proving the *poll loop* actually stays armed
 * (misses accumulating tick over tick) requires a REAL `setInterval`, which
 * only `attachTailer` (private, armed via the public `reattachSession`/
 * `spawnClaudeViaTmux` entry points) creates. The cases below drive that real
 * timer end-to-end through `reattachSession` + a scripted, stateful fake tmux
 * binary, rather than reimplementing the guard's boolean logic in the test.
 * ────────────────────────────────────────────────────────────────────────── */

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Write an executable fake `tmux` whose `has-session` answer is controlled at
 * runtime via a flag file re-read on every invocation, so a test can flip a
 * "live" session to "gone" (or back) mid-poll without restarting the real
 * `setInterval` the death watch runs on. Every other subcommand
 * (capture-pane from the pane-scraper backstop, kill-session from
 * `dropSession`, send-keys, …) succeeds silently — none of those side
 * channels matter for what this suite asserts.
 */
function controllableTmux() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-ctrltmux-"));
  const bin = path.join(dir, "tmux");
  const stateFile = path.join(dir, "state");
  writeFileSync(stateFile, "alive");
  writeFileSync(
    bin,
    "#!/bin/sh\n"
    + "for a in \"$@\"; do\n"
    + "  if [ \"$a\" = \"has-session\" ]; then\n"
    + `    v=$(cat ${JSON.stringify(stateFile)} 2>/dev/null)\n`
    + "    if [ \"$v\" = \"gone\" ]; then\n"
    + "      printf \"can't find session: fake\" 1>&2\n"
    + "      exit 1\n"
    + "    fi\n"
    + "    exit 0\n"
    + "  fi\n"
    + "done\n"
    + "exit 0\n",
  );
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return {
    setGone(gone: boolean) { writeFileSync(stateFile, gone ? "gone" : "alive"); },
    restore() {
      if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
      else process.env.AGETOR_TMUX_BIN = prev;
    },
  };
}

/** Minimal `tasks` row so `subagents.insertIfAbsent`'s `task_id` FK (and
 *  `reattachSession`'s bookkeeping) has something real to point at. Field
 *  values mostly don't matter for this suite — only `id`/`agent` do. */
function baseTask(id: string): Task {
  return {
    id,
    title: "death-watch held test",
    prompt: "p",
    column: "running",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [], backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Pre-seed a reattach-able JSONL with one `end_turn` line followed by a
 * benign, unrelated line, so the tailer's initial replay-from-offset-0
 * stages then immediately fires the end_turn (no need to wait on the 800ms
 * idle-fire) — `turnInFlight(state)` goes false as soon as the returned
 * agent's `done` promise resolves, deterministically (no sleep needed to
 * reach the "no turn in flight" state these cases are about).
 *
 * The file's mtime is backdated well past `DEATH_JSONL_QUIET_MS` (3s) so the
 * death-watch's "was the log just written?" veto can never mask the `gone`
 * probes the test drives afterward — without this, every `gone` tick within
 * the first 3s after the file's real creation time would be vetoed back to
 * "reset" and misses would never accumulate.
 */
function seedReattachableJsonl(jsonlPath: string) {
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "assistant",
      uuid: "et-1",
      message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    }),
    JSON.stringify({ type: "system", uuid: "et-2", permissionMode: "default" }),
  ];
  writeFileSync(jsonlPath, lines.join("\n") + "\n");
  const old = Date.now() / 1000 - 60;
  utimesSync(jsonlPath, old, old);
}

/** Real end-to-end wait past the death watch's threshold: DEATH_POLL_MS(400)
 *  * DEATH_MISS_THRESHOLD(4) consecutive `gone` ticks + DEATH_GRACE_MS(250),
 *  plus generous scheduling slack. */
const DEATH_WINDOW_MS = 2_500;

async function setupHeldReattach() {
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-death-cwd-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-death-config-"));
  const jsonlPath = jsonlPathFor(cwd, sessionId, configDir);
  seedReattachableJsonl(jsonlPath);
  tasks.insert(baseTask(taskId));

  const rec = recorder();
  const agent = await reattachSession({
    taskId,
    cwd,
    sessionId,
    configDir,
    onChunk: rec.onChunk,
    seenLineUuids: new Set(),
  });
  expect(agent).not.toBeNull();
  await agent!.done; // the pre-seeded end_turn fired — turnInFlight(state) is now false

  return { taskId, rec };
}

async function cleanupHeldReattach(taskId: string) {
  await dropSession(taskId); // clears any still-armed timers, kills the (fake) tmux session
  db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]); // cascades subagents/runs/run_events
}

test(
  "startDeathWatch stays armed (misses accumulate) when idle but heldSessionProbe is true, "
  + "and fires the sentinel + orphans subagents after the threshold",
  async () => {
    const ctrlTmux = controllableTmux();
    let taskId = "";
    const prevProbe = setHeldSessionProbe((id) => id === taskId);
    try {
      const setup = await setupHeldReattach();
      taskId = setup.taskId;
      const { rec } = setup;

      // A running subagent row for this task — the death path's unconditional
      // `orphanRunningSubagents` call at the bottom of `signalSessionDeath`
      // should flip this to `orphaned` when death fires.
      subagents.insertIfAbsent({
        id: "agent-1",
        taskId,
        runId: null,
        parentKind: "subagent",
        agentType: "Explore",
        description: "held probe test",
        spawnDepth: 1,
        sourcePath: "/tmp/fake-agent-1.jsonl",
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
      });

      // No turn in flight (asserted implicitly by `setupHeldReattach` having
      // awaited `agent.done`) and the session is `gone` from tick one — before
      // #93/wave-1 this would reset `misses` to 0 forever (`!turnInFlight` was
      // the whole gate). With `heldSessionProbe` wired to return true for this
      // task, the poll stays armed and should accumulate to the fire threshold.
      ctrlTmux.setGone(true);

      await wait(DEATH_WINDOW_MS);

      // Held-death case (no turn in flight, task held for background agents):
      // the sentinel prefix would falsely imply the orchestrator flips the
      // card to `blocked`, but a held task actually releases to `review` —
      // so this path emits the honest, prefix-free held-death wording instead
      // (see F3: `signalSessionDeath`'s `inFlight` branch).
      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
      );
      expect(sentinel).toBeUndefined();
      const heldDeath = rec.out.find(
        (c) => c.stream === "status"
          && c.data.includes("ended while background agents were running — releasing task"),
      );
      expect(heldDeath).toBeDefined();

      expect(subagents.get("agent-1")?.status).toBe("orphaned");
    } finally {
      setHeldSessionProbe(prevProbe);
      ctrlTmux.restore();
      if (taskId) await cleanupHeldReattach(taskId);
    }
  },
);

test(
  "startDeathWatch resets misses (never fires) when idle and heldSessionProbe returns false "
  + "— pre-#93 behavior preserved",
  async () => {
    const ctrlTmux = controllableTmux();
    const prevProbe = setHeldSessionProbe(() => false);
    let taskId = "";
    try {
      const setup = await setupHeldReattach();
      taskId = setup.taskId;
      const { rec } = setup;

      // Session reports `gone` the whole time too — the ONLY thing keeping
      // this idle task from being polled to death should be the probe
      // returning false (mirroring the original `!turnInFlight` gate with no
      // held-task carve-out at all).
      ctrlTmux.setGone(true);

      await wait(DEATH_WINDOW_MS);

      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
      );
      expect(sentinel).toBeUndefined();
    } finally {
      setHeldSessionProbe(prevProbe);
      ctrlTmux.restore();
      if (taskId) await cleanupHeldReattach(taskId);
    }
  },
);

test(
  "startDeathWatch resumes probing once heldSessionProbe flips false→true mid-watch",
  async () => {
    const ctrlTmux = controllableTmux();
    let held = false;
    let taskId = "";
    const prevProbe = setHeldSessionProbe((id) => held && id === taskId);
    try {
      const setup = await setupHeldReattach();
      taskId = setup.taskId;
      const { rec } = setup;

      // Session already reports `gone`, but the probe is false — the poll
      // should keep resetting `misses` to 0 every tick, so waiting almost the
      // full fire window must NOT produce a sentinel yet.
      ctrlTmux.setGone(true);
      await wait(1_000);
      expect(
        rec.out.some((c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX)),
      ).toBe(false);

      // Engage the hold — probing should resume/arm from a clean slate and
      // fire again within one full threshold window from THIS point.
      held = true;
      await wait(DEATH_WINDOW_MS);

      // Held-death case — see the wording note in the "stays armed" test above.
      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
      );
      expect(sentinel).toBeUndefined();
      const heldDeath = rec.out.find(
        (c) => c.stream === "status"
          && c.data.includes("ended while background agents were running — releasing task"),
      );
      expect(heldDeath).toBeDefined();
    } finally {
      setHeldSessionProbe(prevProbe);
      ctrlTmux.restore();
      if (taskId) await cleanupHeldReattach(taskId);
    }
  },
);

test(
  "intentional teardown (dropSession) clears the death timer even while heldSessionProbe is true "
  + "— no zombie timer, no false death after a legit kill",
  async () => {
    const ctrlTmux = controllableTmux();
    let taskId = "";
    const prevProbe = setHeldSessionProbe((id) => id === taskId);
    try {
      const setup = await setupHeldReattach();
      taskId = setup.taskId;
      const { rec } = setup;

      // Session is already `gone` and the task is held — left alone, this is
      // EXACTLY the setup that fires death in the first test above. Instead,
      // tear the session down intentionally right away (mirrors delete/
      // archive/agent-switch calling `dropSession` on a held task).
      ctrlTmux.setGone(true);
      dropSession(taskId);

      // Wait a full fire window past the teardown. If `dropSession` failed to
      // clear the real `deathTimer` (a "zombie" interval left running against
      // a disposed/half-torn-down state), this would still emit the sentinel.
      await wait(DEATH_WINDOW_MS);

      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
      );
      expect(sentinel).toBeUndefined();
    } finally {
      setHeldSessionProbe(prevProbe);
      ctrlTmux.restore();
      if (taskId) await cleanupHeldReattach(taskId);
    }
  },
);

test(
  "F5: a throwing heldSessionProbe on the real poll interval never crashes the tick and behaves as not-held",
  async () => {
    const ctrlTmux = controllableTmux();
    let taskId = "";
    const prevProbe = setHeldSessionProbe(() => { throw new Error("boom: SQLite busy"); });
    try {
      const setup = await setupHeldReattach();
      taskId = setup.taskId;
      const { rec } = setup;

      // Session reports `gone` the whole window — with a healthy probe
      // returning true this would fire (per the "stays armed" test above).
      // With a throwing probe, `heldProbeSafe` swallows the throw and
      // returns false, so the poll behaves exactly like the "probe returns
      // false" case: `misses` resets every tick and nothing ever fires. The
      // real assertion here is that the process is still alive to check —
      // an unguarded probe would have thrown inside the `setInterval`
      // callback and (depending on the runtime) could abort the tick chain
      // or surface as an unhandled error.
      ctrlTmux.setGone(true);
      await wait(DEATH_WINDOW_MS);

      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
      );
      expect(sentinel).toBeUndefined();
      const heldDeath = rec.out.find(
        (c) => c.stream === "status"
          && c.data.includes("ended while background agents were running — releasing task"),
      );
      expect(heldDeath).toBeUndefined();
    } finally {
      setHeldSessionProbe(prevProbe);
      ctrlTmux.restore();
      if (taskId) await cleanupHeldReattach(taskId);
    }
  },
);
