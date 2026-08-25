import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import —
// same convention as claude-tmux-death.test.ts / claude-turn-routing.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-subagent-apierror-"));

const {
  __forTest,
  CLAUDE_API_ERROR_STATUS_PREFIX,
  formatApiErrorDetail,
  setActiveRunProbe,
  setHeldSessionProbe,
} = await import("./claude-tmux.ts");

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: (stream: string, data: string) => out.push({ stream, data }),
  };
}

/** Fresh synthetic session, same shape as claude-tmux-death.test.ts's
 *  `freshSession` — `installSession` builds a full `SessionState` via
 *  `makeSessionState` with no live tmux/timers, so `signalSubagentApiError`
 *  can be driven directly against it. */
function freshSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-subagent-apierror-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, jsonlPath, state };
}

/** Minimal `info` argument `signalSubagentApiError` expects. */
function apiErrorInfo(overrides: Partial<{ subagentId: string; detail: string; runId: string }> = {}) {
  return {
    subagentId: overrides.subagentId ?? "agent-1",
    detail: overrides.detail ?? formatApiErrorDetail(529),
    runId: overrides.runId ?? "run-1",
  };
}

test(
  "signalSubagentApiError: in-flight turn settles — sentinel emitted once, slot resolved 0, "
  + "queue drained, staged-turn latches cleared, continuation watchdog cleared",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    // Stage everything an in-flight turn could plausibly be carrying so the
    // settle path's clearing behavior is actually exercised, not vacuously
    // true because these fields were already null/false.
    state.pendingSlashToken = "/some-command";
    state.pendingEndTurn = { messageId: "m1", uuid: "u1", emitBanner: true, stagedAt: Date.now() };
    state.holdUntilIdle = true;
    const watchdogTimer = setTimeout(() => {}, 60_000);
    state.continuationWatchdog = { timer: watchdogTimer, slot: { onChunk: () => {}, resolve: null, reject: null, slashCommand: null } };
    // Run association is exercised here too — don't rely on the probe being
    // unset (a leaked orchestrator-installed probe from another test file in
    // the shared `bun test` process would otherwise report "no active run"
    // for this synthetic taskId and make the gate no-op forever). Install an
    // explicit matching probe, same as the "matching activeRunProbe" test
    // below, and restore whatever was there before.
    const prevProbe = setActiveRunProbe((id) => (id === taskId ? "run-1" : null));
    try {
      const done = __forTest.pushTurnSlot(state, rec.onChunk);
      expect(__forTest.turnInFlight(state)).toBe(true);

      const info = apiErrorInfo({ detail: "HTTP 529 — turn aborted; blocked for manual retry" });
      __forTest.signalSubagentApiError(state, info);

      const code = await done;
      expect(code).toBe(0);

      // Exactly one status chunk, carrying the shared sentinel prefix and the
      // background-agent-specific wording + detail.
      const sentinels = rec.out.filter(
        (c) => c.stream === "status" && c.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX),
      );
      expect(sentinels.length).toBe(1);
      expect(sentinels[0]!.data).toContain("background agent aborted:");
      expect(sentinels[0]!.data).toContain(info.detail);
      expect(rec.out.length).toBe(1);

      // Queue drained, slot resolved — no longer in flight.
      expect(state.turnQueue.length).toBe(0);
      expect(__forTest.turnInFlight(state)).toBe(false);

      // Staged-turn / follow-up latches all cleared so nothing stale can
      // mis-resolve a later, unrelated turn.
      expect(state.pendingEndTurn).toBeNull();
      expect(state.pendingSlashToken).toBeNull();
      expect(state.holdUntilIdle).toBe(false);

      // The continuation watchdog (if armed) is cancelled — nothing will end
      // this turn naturally anymore, so a stale timer must not fire later.
      expect(state.continuationWatchdog).toBeNull();
    } finally {
      setActiveRunProbe(prevProbe);
      clearTimeout(watchdogTimer);
      __forTest.uninstallSession(taskId);
    }
  },
);

test(
  "signalSubagentApiError: matching activeRunProbe runId also settles the in-flight turn",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    const prevProbe = setActiveRunProbe((id) => (id === taskId ? "run-42" : null));
    try {
      const done = __forTest.pushTurnSlot(state, rec.onChunk);

      __forTest.signalSubagentApiError(state, apiErrorInfo({ runId: "run-42" }));

      const code = await done;
      expect(code).toBe(0);
      expect(
        rec.out.some((c) => c.stream === "status" && c.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX)),
      ).toBe(true);
      expect(__forTest.turnInFlight(state)).toBe(false);
    } finally {
      setActiveRunProbe(prevProbe);
      __forTest.uninstallSession(taskId);
    }
  },
);

test(
  "signalSubagentApiError: onEndOfTurn fallback fires when there's no queued slot (reattach shape)",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    // Same run-association gate as above — install an explicit matching
    // probe rather than relying on "unset" (see comment on the first test).
    const prevProbe = setActiveRunProbe((id) => (id === taskId ? "run-1" : null));
    try {
      // Reattached in-flight run: no in-process turn slot, but an
      // onEndOfTurn hook the orchestrator installed so it can flip the run
      // row on completion. lastChunk stands in for the slot's onChunk.
      state.lastChunk = rec.onChunk;
      let fired = false;
      state.onEndOfTurn = () => { fired = true; };
      expect(__forTest.turnInFlight(state)).toBe(true);

      __forTest.signalSubagentApiError(state, apiErrorInfo());

      expect(fired).toBe(true);
      // Fire-once: cleared so a stray later call can't double-fire it.
      expect(state.onEndOfTurn).toBeNull();
      expect(__forTest.turnInFlight(state)).toBe(false);

      const sentinel = rec.out.find(
        (c) => c.stream === "status" && c.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX),
      );
      expect(sentinel).toBeDefined();
    } finally {
      setActiveRunProbe(prevProbe);
      __forTest.uninstallSession(taskId);
    }
  },
);

test(
  "signalSubagentApiError: runId mismatch is a no-op — a stale subagent from an OLDER run "
  + "can't abort a NEWER in-flight run on the same session",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    const prevProbe = setActiveRunProbe((id) => (id === taskId ? "run-new" : null));
    try {
      const donePromise = __forTest.pushTurnSlot(state, rec.onChunk);
      let settled = false;
      void donePromise.then(() => { settled = true; });

      __forTest.signalSubagentApiError(state, apiErrorInfo({ runId: "run-old" }));

      // Give any (incorrect) resolution a tick to land before asserting.
      await new Promise((r) => setTimeout(r, 0));

      expect(rec.out.length).toBe(0);
      expect(settled).toBe(false);
      expect(state.turnQueue.length).toBe(1);
      expect(__forTest.turnInFlight(state)).toBe(true);
    } finally {
      setActiveRunProbe(prevProbe);
      __forTest.uninstallSession(taskId);
      // Resolve the still-pending slot so the leftover promise doesn't
      // linger unresolved past the test.
      const slot = state.turnQueue[0];
      slot?.resolve?.(0);
    }
  },
);

test(
  "signalSubagentApiError: held branch (no turn in flight, task held for background agents) "
  + "emits a plain, non-sentinel status — nothing resolved",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    state.lastChunk = rec.onChunk;
    const prevProbe = setHeldSessionProbe((id) => id === taskId);
    try {
      expect(__forTest.turnInFlight(state)).toBe(false);

      __forTest.signalSubagentApiError(state, apiErrorInfo({ detail: "HTTP 529 — turn aborted; blocked for manual retry" }));

      expect(rec.out.length).toBe(1);
      expect(rec.out[0]!.stream).toBe("status");
      // Must NOT carry the sentinel prefix — there's no in-flight handle for
      // the orchestrator to flip to `blocked`; a sentinel here would lie.
      expect(rec.out[0]!.data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX)).toBe(false);
      expect(rec.out[0]!.data).toContain("background agent hit an API error");

      // Nothing to resolve — no slot existed and onEndOfTurn was never set.
      expect(state.turnQueue.length).toBe(0);
      expect(state.onEndOfTurn).toBeNull();
    } finally {
      setHeldSessionProbe(prevProbe);
      __forTest.uninstallSession(taskId);
    }
  },
);

test(
  "signalSubagentApiError: neither in flight nor held — silent no-op",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    state.lastChunk = rec.onChunk;
    // heldSessionProbe left at whatever the module default is (unset/null
    // unless a leaked probe from a prior file — restore-in-afterEach
    // discipline elsewhere is what keeps this true); force it explicitly so
    // this test can't pass by accident of ordering.
    const prevProbe = setHeldSessionProbe(() => false);
    try {
      expect(__forTest.turnInFlight(state)).toBe(false);

      __forTest.signalSubagentApiError(state, apiErrorInfo());

      expect(rec.out.length).toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(state.onEndOfTurn).toBeNull();
      expect(state.lastChunk).toBe(rec.onChunk); // untouched
    } finally {
      setHeldSessionProbe(prevProbe);
      __forTest.uninstallSession(taskId);
    }
  },
);

test(
  "signalSubagentApiError: no session teardown — unlike signalSessionDeath, the JSONL "
  + "watcher/timers and subagent watcher are left completely alone (tmux session is alive; "
  + "only the turn aborted)",
  async () => {
    const { taskId, state } = freshSession();
    const rec = recorder();
    let detachCalls = 0;
    const fakeSubagentWatcher = {
      detach: () => { detachCalls += 1; },
      pump: () => {},
      reflectExternalSettle: () => {},
    };
    // Sentinel (non-null, distinguishable) stand-ins for the fields
    // `signalSessionDeath` nulls out on teardown, so we can assert they're
    // byte-for-byte untouched here.
    const fakeWatcher = {} as unknown as typeof state.watcher;
    const fakePollTimer = setTimeout(() => {}, 60_000);
    const fakeScrapeTimer = setInterval(() => {}, 60_000);
    state.watcher = fakeWatcher;
    state.pollTimer = fakePollTimer;
    state.scrapeTimer = fakeScrapeTimer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.subagentWatcher = fakeSubagentWatcher as any;
    // Same run-association gate as the other in-flight-turn tests above —
    // install an explicit matching probe rather than relying on "unset".
    const prevProbe = setActiveRunProbe((id) => (id === taskId ? "run-1" : null));
    try {
      const done = __forTest.pushTurnSlot(state, rec.onChunk);

      __forTest.signalSubagentApiError(state, apiErrorInfo());

      await done;

      expect(detachCalls).toBe(0);
      expect(state.subagentWatcher).toBe(fakeSubagentWatcher as unknown as typeof state.subagentWatcher);
      expect(state.watcher).toBe(fakeWatcher);
      expect(state.pollTimer).toBe(fakePollTimer);
      expect(state.scrapeTimer).toBe(fakeScrapeTimer);
    } finally {
      setActiveRunProbe(prevProbe);
      clearTimeout(fakePollTimer);
      clearInterval(fakeScrapeTimer);
      __forTest.uninstallSession(taskId);
    }
  },
);

test("formatApiErrorDetail: known HTTP status vs. unknown status wording", () => {
  expect(formatApiErrorDetail(529)).toBe("HTTP 529 — turn aborted; blocked for manual retry");
  expect(formatApiErrorDetail(undefined)).toBe("turn aborted; blocked for manual retry");
});
