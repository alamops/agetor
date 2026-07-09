import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import —
// same convention as claude-tmux-queue.test.ts / claude-tmux-death.test.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-continuation-"));

const { __forTest, setContinuationRunFactory } = await import("./claude-tmux.ts");
import type { ContinuationHooks, SpawnedAgent, ChunkHandler } from "./claude-tmux.ts";

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

test("a task-notification breadcrumb (user, origin.kind=task-notification) does not trigger the factory", async () => {
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
      appendFileSync(jsonlPath, taskNotificationLine("agent-123", "uuid-notif"));
      __forTest.flushSync(state);

      expect(calls).toBe(0);
      expect(state.turnQueue.length).toBe(0);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a queue-operation breadcrumb does not trigger the factory", async () => {
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
      appendFileSync(
        jsonlPath,
        queueOperationLine("<task-notification><task-id>agent-456</task-id></task-notification>", "uuid-qop"),
      );
      __forTest.flushSync(state);

      expect(calls).toBe(0);
      expect(state.turnQueue.length).toBe(0);
    } finally {
      setContinuationRunFactory(prev);
    }
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("a status-only breadcrumb followed by genuine content still adopts on the content line, not the breadcrumb", async () => {
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

      expect(calls).toEqual([taskId]); // adopted exactly once, on the content line
      expect(cont.out.some((r) => r.data === "resuming after the background task")).toBe(true);
    } finally {
      setContinuationRunFactory(prev);
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
