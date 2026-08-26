import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import —
// same convention as claude-tmux-queue.test.ts / claude-tmux-death.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-continuation-"));

const { __forTest, setContinuationRunFactory, setBackgroundTaskSettledHandler, setContinuationWatchdogMs } =
  await import("./claude-tmux.ts");
import type { ContinuationHooks, SpawnedAgent, ChunkHandler } from "./claude-tmux.ts";

// Safety net for the whole file: several tests below arm a REAL
// notification-triggered watchdog (a real `setTimeout`, per
// `armContinuationWatchdog` — see claude-tmux.ts). Every such test cancels
// its own timer explicitly (see `clearArmedWatchdog` below), but shrinking
// the default window here too means a test that forgets can't leave a real
// ~10-minute timer pending past this file's run — which would otherwise
// block `bun test`'s process exit rather than just failing an assertion.
// Restored in `afterAll` so it can't leak into a sibling test file.
const prevWatchdogMs = setContinuationWatchdogMs(50);
afterAll(() => {
  setContinuationWatchdogMs(prevWatchdogMs);
});

// ─── fixtures ───────────────────────────────────────────────────────────

interface Recorded { stream: string; data: string; uuid?: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: ((stream, data, uuid) => out.push({ stream, data, uuid })) as ChunkHandler,
  };
}

function freshSession(): { taskId: string; jsonlPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-continuation-sess-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  return { taskId: randomUUID(), jsonlPath };
}

/** An assistant line that claims to end the turn (`stop_reason: "end_turn"`). */
function endTurnLineId(text: string, id: string, uuid?: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  }) + "\n";
}

/** An assistant line still mid-turn (`stop_reason: "tool_use"`) — this is the
 *  shape `isContinuationContentEvent` treats as genuine new content regardless
 *  of stop_reason (it checks `evt.type === "assistant"` unconditionally), so
 *  it can't itself be mistaken for a turn resolution in the same dispatch. */
function assistantLineId(text: string, id: string, uuid?: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: { id, content: [{ type: "text", text }], stop_reason: "tool_use" },
  }) + "\n";
}

/** Synthetic `<task-notification>` breadcrumb claude injects as a `user` line
 *  after a background agent/command finishes. `isContinuationContentEvent`
 *  filters this out (`origin.kind === "task-notification"`) so it must never
 *  itself trigger continuation adoption — only the real content line that
 *  follows should. */
function taskNotificationLine(taskTag: string, uuid?: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    origin: { kind: "task-notification" },
    message: { content: `<task-notification><task-id>${taskTag}</task-id></task-notification>` },
  }) + "\n";
}

/** The `queue-operation` shape claude also uses to report a background
 *  command/agent's completion. `isContinuationContentEvent` returns false for
 *  any non-assistant/non-user event type, so this must not trigger adoption
 *  either. */
function queueOperationLine(content: string, uuid?: string): string {
  return JSON.stringify({ type: "queue-operation", operation: "enqueue", uuid, content }) + "\n";
}

/** Resolve a fresh session's first turn via a normal end_turn, leaving the
 *  session idle (empty turnQueue, no pending) — the state a post-end_turn
 *  background-task auto-resume finds the session in. */
async function resolveFirstTurn(
  state: ReturnType<typeof __forTest.installSession>,
  jsonlPath: string,
): Promise<Recorded[]> {
  const first = recorder();
  const done = __forTest.pushTurnSlot(state, first.onChunk);
  appendFileSync(jsonlPath, endTurnLineId("first turn done", "msg-1", "uuid-1"));
  __forTest.flushSync(state);
  await expect(done).resolves.toBe(0);
  expect(state.turnQueue.length).toBe(0);
  return first.out;
}

/** Install a factory for the duration of `body`, always restoring whatever
 *  was previously installed — required so a leaked factory can't strand
 *  every later test file in the shared bun test process (the file's own doc
 *  comment on `setContinuationRunFactory` calls this out explicitly). */
async function withContinuationFactory<T>(
  factory: (taskId: string) => ContinuationHooks | null,
  body: () => Promise<T> | T,
): Promise<T> {
  const prev = setContinuationRunFactory(factory);
  try {
    return await body();
  } finally {
    setContinuationRunFactory(prev);
  }
}

/** Cancel any real (armed) watchdog timer on `state` directly, bypassing the
 *  normal SUT clear path. A per-test cleanup companion to the module-level
 *  `setContinuationWatchdogMs` shrink above — call this in a `finally` for
 *  any test that arms a notification-triggered watchdog and doesn't already
 *  let it resolve/clear itself (via content arriving, a real end_turn, or an
 *  explicit `__forTest.fireContinuationWatchdog` call), so no real timer
 *  outlives the test. */
function clearArmedWatchdog(state: ReturnType<typeof __forTest.installSession>): void {
  const wd = __forTest.getContinuationWatchdog(state);
  if (wd) clearTimeout(wd.timer);
}

// ─── tests ──────────────────────────────────────────────────────────────

test("a genuinely-new assistant content line after a resolved turn adopts a continuation exactly once, onAdopted before the first chunk", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const order: string[] = [];
    const calls: string[] = [];
    const cont = recorder();
    let adoptedHandle: SpawnedAgent | null = null;

    await withContinuationFactory(
      (tid) => {
        calls.push(tid);
        return {
          onChunk: (stream, data, uuid) => {
            order.push("chunk");
            cont.onChunk(stream, data, uuid);
          },
          onAdopted: (handle) => {
            order.push("adopted");
            adoptedHandle = handle;
          },
        };
      },
      () => {
        // The auto-resume: no turn in flight, queue empty, genuinely new content.
        appendFileSync(jsonlPath, assistantLineId("continuing after background task", "msg-2", "uuid-2"));
        __forTest.flushSync(state);
      },
    );

    expect(calls).toEqual([taskId]); // factory called exactly once for this taskId
    expect(order[0]).toBe("adopted"); // onAdopted fires before the first chunk
    expect(order).toContain("chunk");
    expect(cont.out.some((r) => r.data === "continuing after background task")).toBe(true);
    expect(adoptedHandle).not.toBeNull();
    // The adopted slot is now the live turn.
    expect(state.turnQueue.length).toBe(1);
    // Content-triggered adoption needs no watchdog — real content already
    // arrived, so there's nothing to wait for (contrast with the
    // notification-triggered adoption tests below, which DO arm one).
    expect(__forTest.getContinuationWatchdog(state)).toBeNull();
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("the adopted continuation resolves via the normal end_turn path", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const cont = recorder();
    let handle: SpawnedAgent | null = null;

    const prev = setContinuationRunFactory(() => ({
      onChunk: cont.onChunk,
      onAdopted: (h) => { handle = h; },
    }));
    try {
      appendFileSync(jsonlPath, assistantLineId("continuing after background task", "msg-2", "uuid-2"));
      __forTest.flushSync(state);
      expect(handle).not.toBeNull();
      expect(state.turnQueue.length).toBe(1);

      // The continuation's own end_turn resolves it — same staging/idle-fire
      // semantics as any other turn (flushSync force-resolves the staged
      // end_turn immediately, as in the existing queue-test conventions).
      appendFileSync(jsonlPath, endTurnLineId("continuation done", "msg-2", "uuid-3"));
      __forTest.flushSync(state);

      await expect(handle!.done).resolves.toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(cont.out.some((r) => r.data === "continuation done")).toBe(true);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("replayed (deduped) lines do not trigger the factory even when they'd otherwise qualify as new content", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    // Simulate this line having already been dispatched in a prior process —
    // pre-seed the dedup set the way reattach does.
    state.seenLineUuids.add("uuid-2");

    let calls = 0;
    const prev = setContinuationRunFactory(() => {
      calls++;
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    try {
      appendFileSync(jsonlPath, assistantLineId("this looks new but isn't", "msg-2", "uuid-2"));
      __forTest.flushSync(state);

      expect(calls).toBe(0);
      // No slot was pushed — the dedup path returns before continuation
      // adoption is even considered.
      expect(state.turnQueue.length).toBe(0);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a /effort local-command's <command-name> line and its <local-command-stdout> twin do NOT adopt a continuation, even with an empty turnQueue and a factory installed — both chunks still reach lastChunk", async () => {
  // wave-5 regression pin: isContinuationContentEvent excludes BOTH
  // local-command twins (parseLocalCommandLine / isLocalCommandStdoutEvent),
  // specifically so the orchestrator's dropdown mirror (sendSlashCommand,
  // which pushes no turn slot) can flip /model or /effort on an IDLE task
  // without maybeAdoptContinuation mistaking claude's own command-echo lines
  // for genuine new content and adopting a phantom run that can never settle
  // (see this function's doc comment in claude-tmux.ts — the observed bug
  // sat `running` for 6 minutes). Contrast the assistant-content adoption
  // test above, which pins the positive case this negative case guards.
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const firstOut = await resolveFirstTurn(state, jsonlPath);

    let calls = 0;
    const prev = setContinuationRunFactory((tid) => {
      calls++;
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    try {
      appendFileSync(
        jsonlPath,
        JSON.stringify({
          type: "user",
          uuid: "cont-cmd-1",
          message: {
            role: "user",
            content:
              "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>",
          },
        }) + "\n",
      );
      __forTest.flushSync(state);

      expect(calls).toBe(0);
      expect(state.turnQueue.length).toBe(0);

      appendFileSync(
        jsonlPath,
        JSON.stringify({
          type: "user",
          uuid: "cont-cmd-2",
          message: {
            role: "user",
            content:
              "<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>",
          },
        }) + "\n",
      );
      __forTest.flushSync(state);

      expect(calls).toBe(0); // still never adopted — no slot was ever pushed
      expect(state.turnQueue.length).toBe(0);
      // Both lines still reach the session — routed via the hangover
      // lastChunk (the first turn's own recorder), exactly like the ordinary
      // "factory returning null" / "no factory installed" cases below.
      expect(firstOut.some((r) => r.data.includes("<command-name>/effort</command-name>"))).toBe(true);
      expect(firstOut.some((r) => r.data.includes("<local-command-stdout>Set effort level to high"))).toBe(true);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

// ─── notification-triggered adoption (docs/plans/adopt-continuation-on-task-notification.md §3) ──
//
// `maybeAdoptContinuation`'s eligibility is now `isContinuationContentEvent(evt)
// || taskNotificationContent(evt) !== null` — a task-notification line is
// itself an adoption trigger (not just a precursor the model must "confirm"
// with real content), specifically so the card snaps to `running` for the
// whole extended-thinking window that can precede the first content line.
// Adoption on a notification also arms `CONTINUATION_WATCHDOG_MS` — see the
// watchdog section further below.

test("a provably-new task-notification line with no turn in flight adopts a continuation, arms the watchdog, and routes both the breadcrumb and subsequent content through the adopted slot", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    let calls = 0;
    const cont = recorder();
    let adoptedHandle: SpawnedAgent | null = null;
    const prev = setContinuationRunFactory((tid) => {
      calls++;
      expect(tid).toBe(taskId);
      return { onChunk: cont.onChunk, onAdopted: (h) => { adoptedHandle = h; } };
    });
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-123", "uuid-notif"));
      __forTest.flushSync(state);

      expect(calls).toBe(1);
      expect(adoptedHandle).not.toBeNull();
      expect(state.turnQueue.length).toBe(1); // adopted slot pushed, no turn resolved yet

      // The notification line itself is not silent — it routes through the
      // now-adopted slot as a status breadcrumb (mapParsedEventToChunks'
      // `user`/`origin.kind=task-notification` case: no `<summary>` tag in
      // this fixture, so it falls back to the generic message).
      expect(cont.out.some((r) => r.stream === "status" && r.data === "background task completed")).toBe(true);

      // Notification-triggered adoption is a bet that claude will keep
      // talking — unlike content-triggered adoption, it arms a watchdog.
      const armed = __forTest.getContinuationWatchdog(state);
      expect(armed).not.toBeNull();
      expect(armed!.slot).toBe(state.turnQueue[0]!);

      // Genuine content then arrives on the adopted slot...
      appendFileSync(jsonlPath, assistantLineId("continuing after background task", "msg-2", "uuid-2"));
      __forTest.flushSync(state);

      expect(calls).toBe(1); // still exactly one adoption — no re-adopt on content
      expect(cont.out.some((r) => r.data === "continuing after background task")).toBe(true);
      // ...which proves the continuation is real and clears the watchdog.
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a queue-operation breadcrumb — the other task-notification shape — also adopts a continuation with a watchdog armed, exactly like the user/origin shape", async () => {
  // `taskNotificationContent` treats `queue-operation`/`enqueue` and
  // `user`/`origin.kind=task-notification` as the SAME signal (see its
  // doc comment: "one of the two shapes claude uses to report a background
  // command/agent's completion") — both are meant to arm the watchdog and
  // pull the card to `running` for the extended-thinking window. This
  // supersedes an earlier assumption (encoded in this file's previous
  // version) that queue-operation breadcrumbs never adopt; empirically,
  // `maybeAdoptContinuation`'s eligibility check
  // (`isContinuationContentEvent(evt) || taskNotificationContent(evt) !== null`)
  // is satisfied by a queue-operation/enqueue line with string `content`,
  // and this test pins that down against the real implementation rather
  // than the earlier assumption.
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    let calls = 0;
    let adoptedHandle: SpawnedAgent | null = null;
    const prev = setContinuationRunFactory((tid) => {
      calls++;
      expect(tid).toBe(taskId);
      return { onChunk: () => {}, onAdopted: (h) => { adoptedHandle = h; } };
    });
    try {
      appendFileSync(
        jsonlPath,
        queueOperationLine("<task-notification><task-id>agent-456</task-id></task-notification>", "uuid-qop"),
      );
      __forTest.flushSync(state);

      expect(calls).toBe(1);
      expect(adoptedHandle).not.toBeNull();
      expect(state.turnQueue.length).toBe(1);
      expect(__forTest.getContinuationWatchdog(state)).not.toBeNull();
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a task-notification line whose uuid was already seen (reattach replay) does not trigger the factory", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    // Simulate this notification line having already been dispatched in a
    // prior process — pre-seed the dedup set the way reattach does (same
    // technique the existing content-line replay test above uses).
    state.seenLineUuids.add("uuid-replayed-notif");

    let calls = 0;
    const prev = setContinuationRunFactory(() => {
      calls++;
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-replayed", "uuid-replayed-notif"));
      __forTest.flushSync(state);

      expect(calls).toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a second task-notification line while the watchdog is already armed resets it (same slot, fresh timer) instead of re-adopting", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    let calls = 0;
    const prev = setContinuationRunFactory(() => {
      calls++;
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-first", "uuid-notif-a"));
      __forTest.flushSync(state);
      expect(calls).toBe(1);
      const wd1 = __forTest.getContinuationWatchdog(state);
      expect(wd1).not.toBeNull();

      appendFileSync(jsonlPath, taskNotificationLine("agent-second", "uuid-notif-b"));
      __forTest.flushSync(state);

      expect(calls).toBe(1); // no re-adoption — the eligibility guard rejects
      // it anyway (turnQueue is non-empty), so maybeAdoptContinuation's
      // early "reset, don't re-adopt" branch is what actually runs.
      const wd2 = __forTest.getContinuationWatchdog(state);
      expect(wd2).not.toBeNull();
      expect(wd2!.slot).toBe(wd1!.slot); // still guarding the SAME continuation
      expect(wd2!.timer).not.toBe(wd1!.timer); // but a fresh timer — the window restarted
      expect(state.turnQueue.length).toBe(1);
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

// ─── continuation watchdog: fire + stale-fire guards ───────────────────────

test("the continuation watchdog firing settles the adopted turn as succeeded, emitting the settle-status chunk through the normal end-turn path", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const cont = recorder();
    let handle: SpawnedAgent | null = null;
    const prev = setContinuationRunFactory(() => ({
      onChunk: cont.onChunk,
      onAdopted: (h) => { handle = h; },
    }));
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-watchdog", "uuid-notif-wd"));
      __forTest.flushSync(state);
      expect(handle).not.toBeNull();
      expect(__forTest.getContinuationWatchdog(state)).not.toBeNull();

      // Drive the destructive branch directly instead of waiting out
      // CONTINUATION_WATCHDOG_MS (real minutes, even at this file's shrunk
      // override) — __forTest exposes fireContinuationWatchdog exactly for
      // deterministic tests like this one.
      __forTest.fireContinuationWatchdog(state);

      expect(cont.out.some((r) =>
        r.stream === "status" && r.data === "no continuation followed the background task; settling",
      )).toBe(true);
      // Resolves through the normal end-turn path (firePendingEndTurn ->
      // popEndOfTurn), same as any other turn completion.
      await expect(handle!.done).resolves.toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("firing the watchdog again after it already settled the turn is a clean no-op (no double resolution)", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    let handle: SpawnedAgent | null = null;
    const prev = setContinuationRunFactory(() => ({
      onChunk: () => {},
      onAdopted: (h) => { handle = h; },
    }));
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-refire", "uuid-notif-refire"));
      __forTest.flushSync(state);
      expect(handle).not.toBeNull();

      __forTest.fireContinuationWatchdog(state);
      await expect(handle!.done).resolves.toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();

      // Re-fire: `state.continuationWatchdog` is already null (one-shot),
      // so this must be inert — no throw, no further queue mutation.
      expect(() => __forTest.fireContinuationWatchdog(state)).not.toThrow();
      expect(state.turnQueue.length).toBe(0);
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("firing a watchdog whose armed slot is no longer the active turn is a no-op that leaves the new turn untouched", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const prev = setContinuationRunFactory(() => ({ onChunk: () => {}, onAdopted: () => {} }));
    try {
      appendFileSync(jsonlPath, taskNotificationLine("agent-stale-slot", "uuid-notif-stale"));
      __forTest.flushSync(state);
      const armed = __forTest.getContinuationWatchdog(state);
      expect(armed).not.toBeNull();
      expect(state.turnQueue[0]).toBe(armed!.slot);

      // Reproduce the race `fireContinuationWatchdog`'s own doc comment
      // calls out: a timer callback already queued on the event loop when
      // something else advanced the turn queue past the guarded slot, a
      // beat before the timer's own clear could run. Displace the adopted
      // slot and put a DIFFERENT slot at the head WITHOUT going through the
      // normal clear path (which would have nulled `continuationWatchdog`),
      // so the stale reference survives to be fired against a slot that's
      // no longer current.
      const displaced = state.turnQueue.shift();
      expect(displaced).toBe(armed!.slot);
      let bResolved = false;
      const bSlot = { onChunk: () => {}, resolve: () => { bResolved = true; }, reject: () => {}, slashCommand: null };
      state.turnQueue.push(bSlot as unknown as (typeof state.turnQueue)[number]);

      __forTest.fireContinuationWatchdog(state);

      // Guard tripped on slot identity (`state.turnQueue[0] !== armed.slot`):
      // bSlot is untouched, no double resolution of anything.
      expect(bResolved).toBe(false);
      expect(state.turnQueue.length).toBe(1);
      expect(state.turnQueue[0]).toBe(bSlot);
      // One-shot regardless of outcome: the stale reference is gone either way.
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

// ─── old-run vs adoption interleaving (docs/plans §3 "must verify, not assume") ──
//
// A task-notification line can, in the same dispatch, both (a) confirm a
// staged `pendingEndTurn` from the turn that just ended — the OLD run's
// slot.resolve() runs synchronously, but anything chained on that `done`
// promise via `.then()` only runs as a queued MICROTASK — and (b) itself be
// the adoption trigger for the continuation, whose `onAdopted` hook fires
// synchronously inside the very same `dispatchLine` call. This test pins
// down that ordering guarantee at the claude-tmux level: `onAdopted` (and
// the background-task settle handler) provably complete before the OLD
// run's `.then()` ever gets a turn, which is exactly the property
// `dispatchLine`'s own comment relies on ("adopting first means the
// orchestrator's release check sees task.runId already pointing at a
// running continuation run and bails — no `review` flicker").
//
// NOTE: the deeper orchestrator-level assertion — that `attachDoneHandler`'s
// `.then()` on the OLD run actually reads `task.runId` and bails because it
// already points at the new continuation run — needs the real orchestrator
// (DB-backed task.runId, attachDoneHandler), not this file's synthetic
// SessionState harness. Checked `src/bun/orchestrator-continuation.test.ts`
// for overlap: it covers the factory's DB effects (new run row, column
// pull-back, the #92 hold, fold-while-busy) but has no test that races an
// OLD run's done-resolution microtask against a notification-triggered
// adoption on the same line. That combination is NOT covered anywhere
// today — flagged in this file's owning task's summary as a gap for a
// follow-up in orchestrator-continuation.test.ts (out of this file's
// boundary).
test("notification-triggered adoption (onAdopted, settle handler) runs synchronously ahead of the OLD run's done-promise microtask", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    // Stage (but do not fire) an OLD turn's end_turn — driving dispatchLine
    // directly (not flushSync, which unconditionally fires any staged
    // pendingEndTurn after its batch on the assumption a new prompt is about
    // to be queued) reproduces the state a background-task auto-resume
    // finds: the previous line ended the turn, but nothing has confirmed
    // that yet, so the OLD slot is still the turnQueue head.
    const old = recorder();
    const oldDone = __forTest.pushTurnSlot(state, old.onChunk);
    const order: string[] = [];
    oldDone.then(() => order.push("old-run-then"));

    __forTest.dispatchLine(state, endTurnLineId("old run's last line", "msg-old", "uuid-old"));
    expect(state.turnQueue.length).toBe(1); // staged, not fired

    const settleCalls: string[] = [];
    const prevSettle = setBackgroundTaskSettledHandler((_tid, agentId) => {
      settleCalls.push(agentId);
      order.push("settle-handler");
    });
    const prevFactory = setContinuationRunFactory(() => ({
      onChunk: () => {},
      onAdopted: () => { order.push("adopted"); },
    }));
    try {
      // ONE line both confirms the staged end_turn (staging block, fires
      // synchronously, popping the OLD slot and scheduling its resolve as a
      // microtask) AND is itself a fresh task-notification (adoption
      // trigger, which dispatchLine runs BEFORE the settle block). All of
      // that happens synchronously inside this single call.
      __forTest.dispatchLine(state, taskNotificationLine("agent-interleave", "uuid-notif-interleave"));

      // Synchronous work is done; the OLD run's .then() has NOT run yet —
      // it's still sitting in the microtask queue behind this call.
      expect(order).toEqual(["adopted", "settle-handler"]);
      expect(settleCalls).toEqual(["agent-interleave"]);

      // Now let microtasks drain.
      await Promise.resolve();
      await Promise.resolve();

      expect(order).toEqual(["adopted", "settle-handler", "old-run-then"]);
      await expect(oldDone).resolves.toBe(0);
    } finally {
      setContinuationRunFactory(prevFactory);
      setBackgroundTaskSettledHandler(prevSettle);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a task-notification breadcrumb immediately followed by genuine content in the same batch: adoption happens on the breadcrumb, the content line does not re-adopt", async () => {
  // Previously (pre adopt-on-notification) this scenario adopted on the
  // content line, since the breadcrumb alone wasn't eligible. Now the
  // breadcrumb itself adopts — this test pins down that a content line
  // arriving in the SAME flushSync batch right behind it is a no-op for the
  // factory (maybeAdoptContinuation's `state.turnQueue.length !== 0` guard
  // rejects it — the queue is already non-empty from the breadcrumb's
  // adoption) while still delivering the content to the adopted slot and
  // clearing its watchdog.
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const calls: string[] = [];
    const cont = recorder();
    const prev = setContinuationRunFactory((tid) => {
      calls.push(tid);
      return { onChunk: cont.onChunk, onAdopted: () => {} };
    });
    try {
      // Notification breadcrumb, then the real auto-resumed content, in one batch.
      appendFileSync(jsonlPath, taskNotificationLine("agent-789", "uuid-notif-2"));
      appendFileSync(jsonlPath, assistantLineId("resuming after the background task", "msg-3", "uuid-4"));
      __forTest.flushSync(state);

      expect(calls).toEqual([taskId]); // adopted exactly once, not twice
      expect(cont.out.some((r) => r.stream === "status" && r.data === "background task completed")).toBe(true);
      expect(cont.out.some((r) => r.data === "resuming after the background task")).toBe(true);
      // The content line (dispatched to the same, already-adopted slot in
      // this same batch) clears the watchdog the breadcrumb armed.
      expect(__forTest.getContinuationWatchdog(state)).toBeNull();
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("factory returning null falls back to legacy lastChunk routing — no throw, chunks still delivered", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const firstOut = await resolveFirstTurn(state, jsonlPath);

    let calls = 0;
    const prev = setContinuationRunFactory((_tid) => {
      calls++;
      return null;
    });
    try {
      expect(() => {
        appendFileSync(jsonlPath, assistantLineId("no factory adoption here", "msg-2", "uuid-2"));
        __forTest.flushSync(state);
      }).not.toThrow();

      expect(calls).toBe(1); // factory WAS consulted...
      expect(state.turnQueue.length).toBe(0); // ...but declined, so no slot was pushed
      // ...and the line still routed through the pre-existing lastChunk
      // hangover (the first turn's own recorder, per popEndOfTurn).
      expect(firstOut.some((r) => r.data === "no factory adoption here")).toBe(true);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

// ─── F1: __rebuild__ settle-block guard ────────────────────────────────
//
// `rebuildEventsFromJsonl` drives `dispatchLine` against a synthetic
// SessionState keyed `taskId: "__rebuild__"` to re-emit a finished session's
// JSONL for a UI replay — a read-only operation. The background-task/agent
// settle block in `dispatchLine` (which calls
// `setBackgroundTaskSettledHandler`'s installed hook) must not run for that
// synthetic state: `markSettledById` keys on agentId alone with no taskId
// scoping, so firing it from a rebuild would settle a REAL subagent row.

test("dispatchLine's background-task settle block is skipped for the synthetic __rebuild__ state", () => {
  const { jsonlPath } = freshSession();
  const rebuildState = __forTest.installSession("__rebuild__", jsonlPath);
  const calls: Array<{ taskId: string; agentId: string }> = [];
  const prev = setBackgroundTaskSettledHandler((tid, agentId) => {
    calls.push({ taskId: tid, agentId });
  });
  try {
    __forTest.dispatchLine(rebuildState, taskNotificationLine("agent-rebuild"));
    expect(calls).toEqual([]);
  } finally {
    setBackgroundTaskSettledHandler(prev);
    __forTest.uninstallSession("__rebuild__");
  }
});

test("dispatchLine's background-task settle block still fires for a normal (non-rebuild) session state", () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  const calls: Array<{ taskId: string; agentId: string }> = [];
  const prev = setBackgroundTaskSettledHandler((tid, agentId) => {
    calls.push({ taskId: tid, agentId });
  });
  try {
    __forTest.dispatchLine(state, taskNotificationLine("agent-normal"));
    expect(calls).toEqual([{ taskId, agentId: "agent-normal" }]);
  } finally {
    setBackgroundTaskSettledHandler(prev);
    __forTest.uninstallSession(taskId);
  }
});

// ─── Phase 8: uuid-less queue-operation notifications (verified latent bug) ──
//
// `queue-operation` lines carry `uuid: null` by design — the PRIMARY shape
// current claude uses for background-task completion. Before this fix,
// `maybeAdoptContinuation`'s replay guard (`if (uuid && state.seenLineUuids
// .has(uuid)) return;`) never blocked a falsy uuid, so a REPLAYED
// queue-operation line (boot reattach re-reads the JSONL from offset 0)
// dispatched onto an idle queue re-triggered the continuation factory —
// spawning a phantom continuation run for activity that already happened.
// `syntheticNotificationUuid` closes the hole by deriving a deterministic
// key from the notification's own content.

test("a replayed queue-operation notification line (uuid: null) adopts a continuation exactly once, not twice", () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    let calls = 0;
    const prev = setContinuationRunFactory((tid) => {
      calls++;
      expect(tid).toBe(taskId);
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    try {
      // No uuid arg — reproduces the real claude 2.1.x shape (`uuid: null`),
      // not the earlier tests' explicit "uuid-qop" fixture uuid.
      const line = queueOperationLine(
        "<task-notification><task-id>agent-replay-dup</task-id></task-notification>",
      );

      __forTest.dispatchLine(state, line);
      expect(calls).toBe(1);
      expect(state.turnQueue.length).toBe(1);

      // Boot reattach re-reads the JSONL from offset 0 — the exact same
      // bytes are dispatched a second time. Without a synthetic uuid
      // standing in for the null real uuid, this looked like a brand-new
      // line and adopted a second, phantom continuation run.
      __forTest.dispatchLine(state, line);

      expect(calls).toBe(1); // still exactly one — the replay is a no-op
      expect(state.turnQueue.length).toBe(1);
    } finally {
      setContinuationRunFactory(prev);
      clearArmedWatchdog(state);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("reattach-style: pre-seeding seenLineUuids with a queue-operation line's synthetic uuid suppresses adoption but the settle signal still fires", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    await resolveFirstTurn(state, jsonlPath);

    const content = "<task-notification><task-id>agent-reattach-seed</task-id></task-notification>";
    // Mirrors how reattach seeds seenLineUuids from run_events.line_uuid —
    // the synthetic key computed the same way `dispatchLine` derives it.
    state.seenLineUuids.add(__forTest.syntheticNotificationUuid(content));

    let calls = 0;
    const prevFactory = setContinuationRunFactory(() => {
      calls++;
      return { onChunk: () => {}, onAdopted: () => {} };
    });
    const settleCalls: string[] = [];
    const prevSettle = setBackgroundTaskSettledHandler((_tid, agentId) => {
      settleCalls.push(agentId);
    });
    try {
      __forTest.dispatchLine(state, queueOperationLine(content));

      expect(calls).toBe(0); // adoption suppressed — this key is already "seen"
      expect(state.turnQueue.length).toBe(0);
      // The settle block runs BEFORE the dedup early-return by design (see
      // dispatchLine's comment) — a reattach replay may be the only chance
      // to learn a background agent settled while the process was down, and
      // markSettledById is idempotent — so it must still fire here.
      expect(settleCalls).toEqual(["agent-reattach-seed"]);
    } finally {
      setContinuationRunFactory(prevFactory);
      setBackgroundTaskSettledHandler(prevSettle);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("the status breadcrumb for a uuid-less queue-operation notification carries the synthetic uuid as its lineUuid", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    // No factory installed → falls back to lastChunk routing (the first
    // turn's own recorder), same convention as the "factory returning null"
    // / "no factory installed" tests above.
    const firstOut = await resolveFirstTurn(state, jsonlPath);

    const content = "<task-notification><task-id>agent-breadcrumb</task-id></task-notification>";
    const expectedUuid = __forTest.syntheticNotificationUuid(content);

    appendFileSync(jsonlPath, queueOperationLine(content));
    __forTest.flushSync(state);

    const breadcrumb = firstOut.find((r) => r.stream === "status" && r.data === "background task completed");
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb!.uuid).toBe(expectedUuid);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("with no factory installed at all, behavior is identical to pre-change: no calls, routes via lastChunk", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const firstOut = await resolveFirstTurn(state, jsonlPath);

    // Deliberately do NOT install a factory — confirms the module-level
    // default (null, unset by any earlier test) leaves dispatch unchanged.
    appendFileSync(jsonlPath, assistantLineId("plain trailing content, no adoption seam active", "msg-2", "uuid-2"));
    __forTest.flushSync(state);

    expect(state.turnQueue.length).toBe(0);
    expect(firstOut.some((r) => r.data === "plain trailing content, no adoption seam active")).toBe(true);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});
