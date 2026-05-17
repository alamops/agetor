import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-queue-"));

const { __forTest } = await import("./claude-tmux.ts");

// Each test gets its own taskId + JSONL file so they can't trample each
// other. The dispatch logic is purely synchronous on flushSync (we don't
// touch the watcher or poll timer), so we drive the file forward with
// plain appendFileSync.

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: (stream: string, data: string) => out.push({ stream, data }),
  };
}

function freshSession(): { taskId: string; jsonlPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-queue-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  return { taskId: randomUUID(), jsonlPath };
}

function endTurnLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: "end_turn" },
  }) + "\n";
}

function midTurnLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: "tool_use" },
  }) + "\n";
}

test("single-turn dispatch: end_turn pops the slot and resolves its promise", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const { out, onChunk } = recorder();
    const done = __forTest.pushTurnSlot(state, onChunk);

    appendFileSync(jsonlPath, midTurnLine("working…"));
    appendFileSync(jsonlPath, endTurnLine("all done"));
    __forTest.flushSync(state);

    expect(state.turnQueue.length).toBe(0);
    await expect(done).resolves.toBe(0);
    expect(out.map((r) => r.data)).toContain("working…");
    expect(out.map((r) => r.data)).toContain("all done");
    // "turn complete" status is emitted alongside the end_turn text.
    expect(out.some((r) => r.stream === "status" && r.data === "turn complete")).toBe(true);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("pipelined sends: queued slots resolve in FIFO order on successive end_turns", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const a = recorder();
    const b = recorder();
    const c = recorder();
    const doneA = __forTest.pushTurnSlot(state, a.onChunk);
    const doneB = __forTest.pushTurnSlot(state, b.onChunk);
    const doneC = __forTest.pushTurnSlot(state, c.onChunk);

    // First turn finishes.
    appendFileSync(jsonlPath, midTurnLine("A-mid"));
    appendFileSync(jsonlPath, endTurnLine("A-done"));
    __forTest.flushSync(state);
    await expect(doneA).resolves.toBe(0);

    // Second turn finishes.
    appendFileSync(jsonlPath, midTurnLine("B-mid"));
    appendFileSync(jsonlPath, endTurnLine("B-done"));
    __forTest.flushSync(state);
    await expect(doneB).resolves.toBe(0);

    // Third turn finishes.
    appendFileSync(jsonlPath, endTurnLine("C-done"));
    __forTest.flushSync(state);
    await expect(doneC).resolves.toBe(0);

    // Each slot's recorder saw only its own turn's content — no leaks.
    expect(a.out.map((r) => r.data)).toEqual(expect.arrayContaining(["A-mid", "A-done"]));
    expect(a.out.map((r) => r.data)).not.toContain("B-mid");
    expect(b.out.map((r) => r.data)).toEqual(expect.arrayContaining(["B-mid", "B-done"]));
    expect(b.out.map((r) => r.data)).not.toContain("C-done");
    expect(c.out.map((r) => r.data)).toContain("C-done");
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("multiple events including end_turn in one flush dispatch correctly", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const a = recorder();
    const b = recorder();
    const doneA = __forTest.pushTurnSlot(state, a.onChunk);
    const doneB = __forTest.pushTurnSlot(state, b.onChunk);

    // Write A's content + end_turn AND B's content in one batch.
    appendFileSync(jsonlPath, midTurnLine("A-1"));
    appendFileSync(jsonlPath, endTurnLine("A-done"));
    appendFileSync(jsonlPath, midTurnLine("B-1"));
    __forTest.flushSync(state);

    await expect(doneA).resolves.toBe(0);
    // B's slot is still active, doneB is pending; its handler saw B-1.
    expect(state.turnQueue.length).toBe(1);
    expect(b.out.map((r) => r.data)).toContain("B-1");
    expect(a.out.map((r) => r.data)).not.toContain("B-1");

    appendFileSync(jsonlPath, endTurnLine("B-done"));
    __forTest.flushSync(state);
    await expect(doneB).resolves.toBe(0);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("between-turn metadata hangs over onto the previously popped slot", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const a = recorder();
    const doneA = __forTest.pushTurnSlot(state, a.onChunk);

    appendFileSync(jsonlPath, endTurnLine("A-done"));
    __forTest.flushSync(state);
    await expect(doneA).resolves.toBe(0);

    // Queue is empty. A trailing `summary` event should still route onto
    // A's handler via the lastChunk hangover rather than be dropped.
    appendFileSync(jsonlPath, JSON.stringify({ type: "summary", summary: "compacted" }) + "\n");
    __forTest.flushSync(state);

    expect(a.out.some((r) => r.stream === "status" && r.data.includes("compacted"))).toBe(true);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("async flush guards against a sync flush that advanced the offset", async () => {
  // Simulates the watcher-vs-sendTurn race: the watcher fires and starts
  // an async flush; before its `await readAppended` settles, sendTurn's
  // flushSync runs and dispatches all the lines + pushes a NEW slot. The
  // async flush must NOT re-dispatch those same lines (which would pop
  // the new slot prematurely).
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const prev = recorder();
    const next = recorder();
    const donePrev = __forTest.pushTurnSlot(state, prev.onChunk);

    appendFileSync(jsonlPath, endTurnLine("prev-done"));

    // Kick off the async flush, then immediately run flushSync. The
    // async flush is now blocked on `await open(...)`; flushSync runs
    // synchronously and consumes the end_turn line, popping prev.
    const flushPromise = __forTest.flush(state);
    __forTest.flushSync(state);
    await expect(donePrev).resolves.toBe(0);

    // Now push a new slot, the way sendTurn would post-flushSync.
    const doneNext = __forTest.pushTurnSlot(state, next.onChunk);

    // The async flush eventually resumes. Without the offset-guard, it
    // would re-read the same bytes and dispatch the end_turn a second
    // time → pop the brand-new slot. The guard should make it a no-op.
    await flushPromise;

    expect(state.turnQueue.length).toBe(1);
    // The new slot has not been resolved.
    let resolved = false;
    void doneNext.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    // And the new run's handler saw nothing.
    expect(next.out).toEqual([]);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("session-killed rejection settles every queued slot", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const a = recorder();
    const b = recorder();
    const doneA = __forTest.pushTurnSlot(state, a.onChunk);
    const doneB = __forTest.pushTurnSlot(state, b.onChunk);

    const err = new Error("cancelled");
    for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);

    await expect(doneA).rejects.toThrow("cancelled");
    await expect(doneB).rejects.toThrow("cancelled");
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("partial trailing line is left for the next flush", async () => {
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  try {
    const a = recorder();
    const doneA = __forTest.pushTurnSlot(state, a.onChunk);

    // Write a complete line plus a partial trailing one (no \n).
    const complete = midTurnLine("first");
    const partial = '{"type":"assistant","mess';
    const fd = openSync(jsonlPath, "a");
    writeSync(fd, complete + partial);
    closeSync(fd);
    __forTest.flushSync(state);

    expect(a.out.some((r) => r.data === "first")).toBe(true);
    // Partial line must NOT have produced a stderr parse error.
    expect(a.out.some((r) => r.stream === "stderr")).toBe(false);

    // Complete the partial line — should now parse + dispatch.
    const remainder = 'age":{"content":[{"type":"text","text":"second"}],"stop_reason":"end_turn"}}\n';
    appendFileSync(jsonlPath, remainder);
    __forTest.flushSync(state);

    expect(a.out.some((r) => r.data === "second")).toBe(true);
    await expect(doneA).resolves.toBe(0);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});
