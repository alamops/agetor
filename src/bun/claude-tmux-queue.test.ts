import { test, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-queue-"));

const { __forTest, dismissTmuxPrompt, pasteFollowUp, cycleToMode, sendTurn, sendModalKeys } =
  await import("./claude-tmux.ts");

// Real type for a withheld-paste outcome, derived from `pasteFollowUp`'s own
// `onPasteFailure` parameter — `PasteOutcome` itself isn't exported, so this
// is the only way to get the literal `phase` union (and the rest of the
// shape) without an `as any` cast at every push site.
type PasteFailureOutcome = Parameters<
  NonNullable<NonNullable<Parameters<typeof pasteFollowUp>[2]>["onPasteFailure"]>
>[0];
type ModalGuardFailure = Extract<PasteFailureOutcome, { op: "modal-guard" }>;

/** Narrow a captured `onPasteFailure` outcome to the `modal-guard` member so
 *  `.phase` is accessible without a cast — every guard test here expects
 *  exactly this member; a mismatch is a real assertion failure, not a type
 *  hole to paper over. */
function assertModalGuard(outcome: PasteFailureOutcome): asserts outcome is ModalGuardFailure {
  if (outcome.op !== "modal-guard") {
    throw new Error(`expected a modal-guard failure, got op=${outcome.op}`);
  }
}

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

// A pane fixture showing a live claude modal — same numbered-picker shape as
// claude-tmux-local-command.test.ts's PICKER_PANE (duplicated here, not
// cross-imported, per this task's file-ownership boundary). Used by the
// `queuePaste` modal-guard tests below (`pasteFollowUp`, `cycleToMode`).
const BLOCKING_MODAL_PANE = [
  "Do you want to make this edit to foo.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all",
  "  3. No",
].join("\n");

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

// id-carrying variants: the turn-end staging keys continuations on
// `message.id`, so distinct ids make one assistant message clearly a *new*
// turn rather than a same-message split.
function endTurnLineId(text: string, id: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  }) + "\n";
}

function assistantLineId(text: string, id: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { id, content: [{ type: "text", text }], stop_reason: "tool_use" },
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
  // Low-level turnQueue mechanism. NOTE: the orchestrator no longer pushes a
  // slot per rapid follow-up — a message sent while a turn is in flight folds
  // into the active run via `pasteFollowUp` (no new slot). This FIFO behavior
  // still backs genuinely-sequential turns (idle between sends, each via
  // `sendTurn`) and the reattach path, so it stays pinned here.
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

test("pasteFollowUp: folds into the active turn without pushing a new slot", async () => {
  // The fold-while-busy path: a follow-up sent mid-turn pastes into the live
  // session but does NOT open a second turn slot. This is what prevents the
  // stranding bug — claude can coalesce queued messages into fewer end_turn
  // events than messages, so one-slot-per-message would leave the surplus
  // slots (and their run rows) stuck "running" forever.
  await withFakeTmuxBin(async () => {
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    const prevGap = __forTest.setBracketedEnterGapMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      const a = recorder();
      const doneA = __forTest.pushTurnSlot(state, a.onChunk);

      // Fold a message in while the turn is live.
      expect(pasteFollowUp(taskId, "second message while busy")).toMatchObject({ delivered: true });
      // No second slot — the queue stays at one in-flight turn (synchronous;
      // pasteFollowUp never touches turnQueue).
      expect(state.turnQueue.length).toBe(1);
      // Let the background paste chain drain so it can't outlive the test.
      await new Promise((r) => setTimeout(r, 20));

      // The paste did not prematurely resolve the active turn.
      let resolved = false;
      void doneA.then(() => { resolved = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // flushSync (the sendTurn path) force-resolves any staged end_turn, so
      // here the single turn resolves immediately. The *live tailer* instead
      // holds the run open until idle — see the next test.
      appendFileSync(jsonlPath, endTurnLine("done"));
      __forTest.flushSync(state);
      await expect(doneA).resolves.toBe(0);
      expect(state.turnQueue.length).toBe(0);

      // A surplus end_turn (claude coalesced the folded reply into one
      // response, emitting an extra marker) must be a clean no-op — nothing
      // to strand.
      appendFileSync(jsonlPath, endTurnLine("extra"));
      expect(() => __forTest.flushSync(state)).not.toThrow();
      expect(state.turnQueue.length).toBe(0);
    } finally {
      __forTest.uninstallSession(taskId);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("pasteFollowUp: returns false when no live session exists", () => {
  expect(pasteFollowUp(randomUUID(), "msg")).toBe(false);
});

// ─── pasteFollowUp({ onPasteFailure }) honors queuePaste's modal guard
// (docs/plans/model-effort-local-command-turns.md §10, finding #4): a
// follow-up folded in while a live claude modal is up must not silently
// vanish — it's withheld, and the caller (the orchestrator, in production)
// finds out via `onPasteFailure` so it can re-stash the message instead of
// losing it. ───

test("pasteFollowUp({onPasteFailure}): a blocked pane fires the callback once (phase 'pre-paste') and pastes nothing", async () => {
  await withRecordingTmuxBin(async (logPath) => {
    // Shrink the modal guard's grace/poll so a persistently-blocked pane
    // withholds in milliseconds instead of paying the real
    // PASTE_MODAL_GRACE_MS (1.5s) + PASTE_MODAL_POLL_MS (250ms) window.
    const prevGrace = __forTest.setPasteModalGraceMs(20);
    const prevPoll = __forTest.setPasteModalPollMs(5);
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    const prevCapture = __forTest.setCapturePastePane(() => BLOCKING_MODAL_PANE);
    const failures: PasteFailureOutcome[] = [];
    try {
      const result = pasteFollowUp(taskId, "a follow-up message", {
        onPasteFailure: (outcome) => failures.push(outcome),
      });
      expect(result).toMatchObject({ delivered: true });
      if (result === false) throw new Error("expected delivered");

      await __forTest.pasteChains.get(taskId);

      expect(failures.length).toBe(1);
      const failure = failures[0]!;
      assertModalGuard(failure);
      // This is the pre-any-tmux-call guard site — never the TOCTOU re-check
      // (there's no bracketed Enter gap to race here) or the composer-dirty
      // branch (composerHoldsText starts false on a fresh session).
      expect(failure.phase).toBe("pre-paste");
      expect(readTmuxLog(logPath)).toEqual([]);

      // `pasteOutcome` is the awaitable twin of `onPasteFailure` — same
      // outcome object, never hangs, never rejects.
      const outcome = await result.pasteOutcome;
      expect(outcome).toBe(failure);
    } finally {
      __forTest.setCapturePastePane(prevCapture);
      __forTest.setPasteModalPollMs(prevPoll);
      __forTest.setPasteModalGraceMs(prevGrace);
      __forTest.uninstallSession(taskId);
    }
  });
});

test("pasteFollowUp without {onPasteFailure}: a blocked pane withholds silently — nothing throws", async () => {
  await withFakeTmuxBin(async () => {
    const prevGrace = __forTest.setPasteModalGraceMs(20);
    const prevPoll = __forTest.setPasteModalPollMs(5);
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    const prevCapture = __forTest.setCapturePastePane(() => BLOCKING_MODAL_PANE);
    try {
      const result = pasteFollowUp(taskId, "a follow-up message");
      expect(result).toMatchObject({ delivered: true });
      if (result === false) throw new Error("expected delivered");
      await expect(__forTest.pasteChains.get(taskId)).resolves.toBeUndefined();
      // Silent withhold still settles pasteOutcome — never hangs, and the
      // caller can inspect it even without passing onPasteFailure.
      const outcome = await result.pasteOutcome;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.op).toBe("modal-guard");
        assertModalGuard(outcome);
        expect(outcome.phase).toBe("pre-paste");
      }
    } finally {
      __forTest.setCapturePastePane(prevCapture);
      __forTest.setPasteModalPollMs(prevPoll);
      __forTest.setPasteModalGraceMs(prevGrace);
      __forTest.uninstallSession(taskId);
    }
  });
});

test("pasteFollowUp: holds the run open across folded turns until the session goes idle", async () => {
  // The fix for the review's medium finding: a single mid-turn follow-up must
  // NOT bounce the run to "succeeded" (task → review) on the intermediate
  // end_turn while claude is still answering the folded message. The run stays
  // open (slot held) until the live tailer (`flush`) sees the session go idle.
  await withFakeTmuxBin(async () => {
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    const prevGap = __forTest.setBracketedEnterGapMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      const a = recorder();
      const doneA = __forTest.pushTurnSlot(state, a.onChunk);

      const foldResult = pasteFollowUp(taskId, "do another thing");
      expect(foldResult).toMatchObject({ delivered: true });
      expect(state.holdUntilIdle).toBe(true);
      await new Promise((r) => setTimeout(r, 20)); // drain the paste chain

      // The fold's paste actually landed — pasteOutcome resolves { ok: true }
      // for a successful bracketed paste, same contract as sendTurn's.
      if (foldResult === false) throw new Error("expected delivered");
      await expect(foldResult.pasteOutcome).resolves.toEqual({ ok: true });

      // R1's response ends, then claude immediately starts answering the
      // folded message (a NEW assistant message id). Driven through the async
      // `flush` (the live path) — NOT flushSync, which would force-resolve.
      appendFileSync(jsonlPath, endTurnLineId("R1 reply done", "msg-r1"));
      appendFileSync(jsonlPath, assistantLineId("on it — the folded ask", "msg-m2"));
      await __forTest.flush(state);
      // Held: the intermediate end_turn did not pop the slot.
      expect(state.turnQueue.length).toBe(1);
      let resolved = false;
      void doneA.then(() => { resolved = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // The folded message's own end_turn arrives — still held (a trailing
      // line keeps re-staging, never popping, while holdUntilIdle is set).
      appendFileSync(jsonlPath, endTurnLineId("folded reply done", "msg-m2"));
      await __forTest.flush(state);
      expect(state.turnQueue.length).toBe(1);
      expect(resolved).toBe(false);

      // Session goes idle: force the staged end_turn past the idle threshold,
      // then a no-new-data flush fires it → the run resolves exactly once and
      // the hold clears.
      expect(state.pendingEndTurn).not.toBeNull();
      if (state.pendingEndTurn) state.pendingEndTurn.stagedAt = 0;
      await __forTest.flush(state);
      await expect(doneA).resolves.toBe(0);
      expect(state.turnQueue.length).toBe(0);
      expect(state.holdUntilIdle).toBe(false);
    } finally {
      __forTest.uninstallSession(taskId);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
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

// ─── pasteChain ordering (regression for the "Turn Ended Bug" — model
// change races a follow-up user paste, the user's message lands during
// claude's transient slash-command processing and vanishes silently).
// The fix is `queueTmuxOp` (and its `queuePaste` wrapper), which
// serializes all tmux ops for a task behind a single chain and holds
// the slot for the slash command's settle window so the next op lands
// on a ready prompt. These tests drive the chain directly and assert
// ordering + timing. ───

/**
 * Snapshot + restore the `AGETOR_TMUX_BIN` env var around a test body.
 * The chain calls `pastePrompt` → `tmux()` → `Bun.spawnSync(bin, …)`;
 * pointing the bin at a no-op `true` lets the chain advance without
 * needing a real tmux. Restoring on exit keeps the env clean for later
 * tests in the same process (tmux probes elsewhere read this var).
 *
 * `/usr/bin/true` works on both macOS (where `/bin/true` doesn't exist)
 * and most Linux distros. Choosing the path matters — a missing binary
 * makes `Bun.spawnSync` throw `ENOENT`, which the `tmux()` helper catches
 * and surfaces as `{ok: false}`. That silently degrades tests that need
 * the tmux calls to "succeed" (e.g. `dismissTmuxPrompt` returning true).
 */
const FAKE_TMUX_BIN = "/usr/bin/true";

function withFakeTmuxBin<T>(fn: () => Promise<T>): Promise<T> {
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = FAKE_TMUX_BIN;
  return fn().finally(() => {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  });
}

/**
 * Recording variant of `withFakeTmuxBin`: writes a small bun script as the
 * tmux bin that appends one `{ ns, argv }` JSON line per invocation to a
 * log file. Lets tests assert both the *order* of tmux calls (load-buffer
 * → paste-buffer → delete-buffer → send-keys Enter) AND the wall-clock
 * gap between them (e.g. the bracketed-paste → Enter gap inserted by
 * `queuePaste`). The shebang points at `process.execPath` — the bun
 * binary that's running the suite — so the script works without `bun`
 * being on `PATH`.
 *
 * `ms` is `Date.now()` (wall clock) sampled at the start of each
 * invocation — NOT `Bun.nanoseconds()`, which is process-local and
 * resets per sub-bun spawn. Subtract two log lines' `ms` for the gap.
 * Cold-start of the sub-bun process is included in the delta, so use
 * only for `>= GAP` lower bounds; the cold start can easily widen the
 * observed delta past any tight upper bound.
 */
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
  // The log may not exist if no tmux calls ran (e.g. a chain that
  // short-circuited on stillCurrent before the first invocation).
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((entry) => {
    // Every tmux spawn now leads with `tmuxSocketArgs()` (["-L", <name>]
    // under bun test); strip that pair so command-name assertions here don't
    // have to know about socket isolation.
    const [a, , ...rest] = entry.argv;
    return a === "-L" ? { ...entry, argv: rest } : entry;
  });
}

test("queuePaste: chained pastes run in FIFO order", async () => {
  await withFakeTmuxBin(async () => {
    const prev = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      const log: string[] = [];

      // Resolve order observed via the .then chain on each returned promise.
      const a = __forTest.queuePaste(taskId, "sess-x", "first", 0).then(() => log.push("a"));
      const b = __forTest.queuePaste(taskId, "sess-x", "second", 0).then(() => log.push("b"));
      const c = __forTest.queuePaste(taskId, "sess-x", "third", 0).then(() => log.push("c"));

      await Promise.all([a, b, c]);
      expect(log).toEqual(["a", "b", "c"]);
      // Chain self-evicts when no follow-ups are pending.
      expect(__forTest.pasteChains.has(taskId)).toBe(false);
    } finally {
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

test("queuePaste: settle window holds the next paste for slash commands", async () => {
  // Settle window chosen large enough that a 30ms scheduling tolerance
  // still keeps the assertion meaningful (settle MUST add ≥ SETTLE−TOLERANCE
  // vs. the 0ms baseline). Loose enough that a busy CI runner that wakes
  // the timer a few ms early won't flake the test.
  const SETTLE = 120;
  const TOLERANCE = 30;
  await withFakeTmuxBin(async () => {
    const prev = __forTest.setSlashCommandSettleMs(SETTLE);
    try {
      const taskId = randomUUID();
      const t0 = performance.now();
      // First paste claims the slash-command settle window.
      const slash = __forTest.queuePaste(
        taskId,
        "sess-x",
        "/model claude-opus-4-7",
        __forTest.getSlashCommandSettleMs(),
      );
      // Follow-up user paste: zero settle, but must wait behind the slash
      // command's window before it runs.
      const userPaste = __forTest.queuePaste(taskId, "sess-x", "real user msg", 0);

      let slashResolvedAt: number | null = null;
      let userResolvedAt: number | null = null;
      void slash.then(() => { slashResolvedAt = performance.now() - t0; });
      void userPaste.then(() => { userResolvedAt = performance.now() - t0; });

      await userPaste;

      // The slash paste resolves first, after ~SETTLE ms (the settle window).
      expect(slashResolvedAt).not.toBeNull();
      expect(slashResolvedAt!).toBeGreaterThanOrEqual(SETTLE - TOLERANCE);
      // The user paste resolves AFTER the slash paste — never before.
      expect(userResolvedAt).not.toBeNull();
      expect(userResolvedAt!).toBeGreaterThanOrEqual(slashResolvedAt!);
    } finally {
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

test("queuePaste: pastes for different taskIds don't block each other", async () => {
  await withFakeTmuxBin(async () => {
    // Settle chosen large: task-B's elapsed includes a fake-tmux process
    // spawn whose cost under a loaded full-suite run has been observed at
    // 70ms+, so the bound must dwarf spawn latency while staying well
    // under SETTLE. 400/2 = 200ms gives ~3x headroom over the worst
    // observed spawn without weakening the serialization signal.
    const SETTLE = 400;
    const prev = __forTest.setSlashCommandSettleMs(SETTLE);
    try {
      const taskA = randomUUID();
      const taskB = randomUUID();

      // Task A's slash command holds a SETTLE ms settle window.
      const slashA = __forTest.queuePaste(taskA, "sess-a", "/model X", SETTLE);
      let aResolved = false;
      void slashA.then(() => { aResolved = true; });
      const t0 = performance.now();
      // Task B's paste should be able to run immediately — independent
      // chain. If we accidentally globalized the lock, this would wait
      // ~SETTLE ms.
      await __forTest.queuePaste(taskB, "sess-b", "user msg", 0);
      const elapsed = performance.now() - t0;

      // Clock-free serialization detector: were the chains shared, B could
      // only complete after A's settle window — i.e. after slashA resolved.
      // A still pending here proves B never waited on A.
      expect(aResolved).toBe(false);
      // Belt-and-braces upper bound — on a healthy run elapsed is ~0–5ms.
      expect(elapsed).toBeLessThan(SETTLE / 2);
      await slashA;
    } finally {
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

test("queueTmuxOp: dismissTmuxPrompt-style op serializes behind a queued paste", async () => {
  // Regression for the dismiss/paste interleave: a modal click's `"1"`
  // + Enter must not land between an in-flight paste's `paste-buffer`
  // and its `Enter`. Both operations share the same chain, so the
  // dismissal can only run after the paste's chain slot has settled.
  await withFakeTmuxBin(async () => {
    const prev = __forTest.setSlashCommandSettleMs(60);
    try {
      const taskId = randomUUID();
      const order: string[] = [];

      // A slash paste with settle holds the chain briefly.
      const slash = __forTest.queuePaste(taskId, "sess-x", "/model X", 60)
        .then(() => order.push("paste-done"));
      // Dismissal queued behind it via the generic op primitive.
      const dismiss = __forTest.queueTmuxOp(taskId, async () => {
        // Sentinel inside the op body so we can confirm it ran after
        // the paste's chain slot settled, not interleaved with it.
        order.push("dismiss-body");
      }).then(() => order.push("dismiss-done"));

      await Promise.all([slash, dismiss]);
      // The dismissal body MUST run after the paste's chain slot
      // resolved — never between paste-buffer and Enter.
      expect(order).toEqual(["paste-done", "dismiss-body", "dismiss-done"]);
    } finally {
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

test("dismissTmuxPrompt waits behind an in-flight paste on the same task", async () => {
  // Direct test of the user-facing function (not just the underlying
  // queueTmuxOp primitive): a modal click that lands while a slash
  // command is mid-settle must be held by the chain. This is what
  // prevents the original "Turn Ended Bug" race from re-opening at the
  // dismissal path.
  await withFakeTmuxBin(async () => {
    const SETTLE = 100;
    const TOLERANCE = 30;
    const prev = __forTest.setSlashCommandSettleMs(SETTLE);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      const t0 = performance.now();
      // Slash command holds the chain for SETTLE ms.
      const pastePromise = __forTest.queuePaste(
        taskId,
        state.sessionName,
        "/model X",
        SETTLE,
        state,
      );
      // Modal dismissal queued behind it. With the chain wired up
      // through dismissTmuxPrompt, this can only resolve after the
      // paste's settle window has elapsed.
      const dismissedAtPromise = dismissTmuxPrompt(taskId, "1", {
        choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
        cursorIndex: 0,
      }).then((ok) => ({
        elapsed: performance.now() - t0,
        ok,
      }));
      await pastePromise;
      const { elapsed, ok } = await dismissedAtPromise;
      // Assert the body actually ran — a silently identity-gated body
      // would still satisfy the timing bound below, so we need this
      // first. `ok` is only set inside the body, after the second
      // `send-keys`, so `true` proves the dismissal reached completion.
      expect(ok).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(SETTLE - TOLERANCE);
    } finally {
      __forTest.setSlashCommandSettleMs(prev);
      __forTest.uninstallSession(taskId);
    }
  });
});

test("dismissTmuxPrompt mid-body re-gate (key '2', one Down + Enter): trailing Enter skipped on dispose mid-gap", async () => {
  // Covers the residual race the entry-only identity gate left open:
  // a `dropSession` lands during the gap between the navigation arrow
  // and the trailing Enter, and `send-keys Enter` would otherwise leak
  // into the respawned pane as a stray confirmation. The thunk's
  // `stillCurrent()` re-check before the Enter call closes it.
  //
  // Uses key "2" with cursorIndex=0 (delta = 1 → one Down) so there's a
  // real inter-keystroke gap to test. Key "1" with cursorIndex=0 maps
  // to "no navigation, just Enter" and would skip the gap entirely.
  await withFakeTmuxBin(async () => {
    const prev = __forTest.setSlashCommandSettleMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      // Kick off the dismissal — its first send-keys (a Down) runs
      // synchronously before the 30ms sleep starts.
      const dismissPromise = dismissTmuxPrompt(taskId, "2", {
        choices: [
          { key: "1", label: "Yes" },
          { key: "2", label: "Yes, allow all" },
          { key: "3", label: "No" },
        ],
        cursorIndex: 0,
      });
      // After the Down is on the wire but during the gap, drop and
      // respawn the session for the same taskId. ~15ms lands squarely
      // inside the dismissal's 30ms internal sleep.
      await Bun.sleep(15);
      __forTest.uninstallSession(taskId);
      __forTest.installSession(taskId, jsonlPath);

      const ok = await dismissPromise;
      // With the mid-body re-gate, the trailing Enter is skipped, so
      // `ok` (set only on the trailing send-keys success) stays false.
      // Without the re-gate this test would observe `ok === true` AND
      // the new session's pane would have received a stray Enter.
      expect(ok).toBe(false);
    } finally {
      __forTest.uninstallSession(taskId);
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

test("queueTmuxOp: skips its body if the session was disposed between scheduling and execution", async () => {
  // Closes the race where `sessionNameFor(taskId)` is deterministic, so
  // a same-taskId respawn reuses the tmux session name — a previously-
  // queued op would otherwise send keystrokes into the *new* session.
  // The `expectedState` identity guard inside queueTmuxOp prevents that.
  await withFakeTmuxBin(async () => {
    const prev = __forTest.setSlashCommandSettleMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      let ranOldChainOp = false;
      // Schedule an op against the ORIGINAL state. Use a microtask gap
      // (Promise.resolve()) so the dispose below lands before the
      // thunk would otherwise run.
      const gated = __forTest.queueTmuxOp(taskId, async () => {
        ranOldChainOp = true;
      }, state);
      // Dispose the original session and install a fresh one for the
      // same taskId — simulates dropSession + a follow-up
      // spawnClaudeViaTmux reusing the task.
      __forTest.uninstallSession(taskId);
      __forTest.installSession(taskId, jsonlPath);

      await gated;
      // The thunk MUST have been skipped — the session it was queued
      // against is gone.
      expect(ranOldChainOp).toBe(false);
    } finally {
      __forTest.uninstallSession(taskId);
      __forTest.setSlashCommandSettleMs(prev);
    }
  });
});

// ─── cycleToMode's `/plan` branch honors queuePaste's modal guard
// (docs/plans/model-effort-local-command-turns.md §10, finding #3): a
// withheld `/plan` paste must be visible to the caller as
// `{ ok: false, reason: "paste withheld" }` rather than silently reporting
// `{ ok: true, via: "slash-plan" }` as though it landed — the exact deadlock
// `reconcileTaskSession`'s post-cycle `ensureInstalledForCwd(cwd, "plan")`
// call would otherwise walk into. ───

test("cycleToMode('plan'): a blocked pane withholds the /plan paste — result is { ok: false, reason: 'paste withheld' }", async () => {
  await withFakeTmuxBin(async () => {
    const prevGrace = __forTest.setPasteModalGraceMs(20);
    const prevPoll = __forTest.setPasteModalPollMs(5);
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    const prevCapture = __forTest.setCapturePastePane(() => BLOCKING_MODAL_PANE);
    try {
      const result = await cycleToMode(taskId, "plan");
      expect(result).toEqual({ ok: false, reason: "paste withheld" });
    } finally {
      __forTest.setCapturePastePane(prevCapture);
      __forTest.setPasteModalPollMs(prevPoll);
      __forTest.setPasteModalGraceMs(prevGrace);
      __forTest.uninstallSession(taskId);
    }
  });
});

test("cycleToMode('plan'): a clear pane still returns { ok: true, via: 'slash-plan' } (modal guard is a no-op when nothing is blocking)", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    const idlePane = [
      "─".repeat(80),
      "❯ ",
      "─".repeat(80),
      "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    const prevCapture = __forTest.setCapturePastePane(() => idlePane);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const result = await cycleToMode(taskId, "plan");
      expect(result).toEqual({ ok: true, presses: 0, via: "slash-plan" });
    } finally {
      __forTest.setCapturePastePane(prevCapture);
      __forTest.setSlashCommandSettleMs(prevSettle);
      __forTest.uninstallSession(taskId);
    }
  });
});

// ─── pasteContainsImagePath / countImagePaths detection rules ──────────
// The image-aware long gap inside `queuePaste` only fires when these
// helpers signal an image path in the paste. Get the rule wrong in
// either direction and either every bracketed paste pays 600 ms+ of
// latency for nothing, or the image-attach race re-opens.
test("pasteContainsImagePath: matches absolute file paths with image extensions", () => {
  // Real prompt shape — `appendReferences` writes `- /abs/path` bullets.
  const prompt =
    "fix the bug\n\nReferenced files/folders:\n- /Users/me/.agetor/screenshots/screenshot-2026-06-02_17-47-49-b51759d7.png";
  expect(__forTest.pasteContainsImagePath(prompt)).toBe(true);
});

test("pasteContainsImagePath: matches each supported extension", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]) {
    expect(__forTest.pasteContainsImagePath(`see /tmp/foo.${ext}`)).toBe(true);
  }
});

test("pasteContainsImagePath: case-insensitive on the extension", () => {
  expect(__forTest.pasteContainsImagePath("attached: /tmp/Foo.PNG")).toBe(true);
  expect(__forTest.pasteContainsImagePath("attached: /tmp/bar.JPEG")).toBe(true);
});

test("pasteContainsImagePath: a bare `.png` token (no word before the dot) does NOT match", () => {
  // The regex requires a `\w` immediately before the extension dot so
  // prose mentioning the extension doesn't trip the long gap. Likewise
  // edge inputs like `..png` (consecutive dots) and `,png` (non-word
  // prefix) are rejected.
  expect(__forTest.pasteContainsImagePath(".png")).toBe(false);
  expect(__forTest.pasteContainsImagePath("save as .png next")).toBe(false);
  expect(__forTest.pasteContainsImagePath("see ..png file")).toBe(false);
});

test("pasteContainsImagePath: non-image extensions do not match", () => {
  expect(__forTest.pasteContainsImagePath("see /tmp/foo.ts")).toBe(false);
  expect(__forTest.pasteContainsImagePath("/Users/me/notes.md")).toBe(false);
  expect(__forTest.pasteContainsImagePath("hello world")).toBe(false);
});

test("pasteContainsImagePath: is stateless across repeated calls (global regex regression)", () => {
  // `IMAGE_PATH_RE` carries the /g flag so `.match()` can count occurrences
  // for the scaled settle. Without an explicit `lastIndex = 0` reset, a
  // repeat `.test()` on the same string alternates true/false — a footgun
  // worth pinning so a future refactor doesn't quietly re-introduce it.
  const s = "/tmp/foo.png";
  expect(__forTest.pasteContainsImagePath(s)).toBe(true);
  expect(__forTest.pasteContainsImagePath(s)).toBe(true);
  expect(__forTest.pasteContainsImagePath(s)).toBe(true);
});

test("countImagePaths: counts each image reference for settle-window scaling", () => {
  expect(__forTest.countImagePaths("no images here")).toBe(0);
  expect(__forTest.countImagePaths("- /tmp/a.png")).toBe(1);
  expect(__forTest.countImagePaths("- /tmp/a.png\n- /tmp/b.jpg\n- /tmp/c.webp")).toBe(3);
  // Mixed image + non-image refs only counts images.
  expect(__forTest.countImagePaths("- /tmp/a.png\n- /tmp/notes.md\n- /tmp/b.jpeg")).toBe(2);
});

// ─── bracketed-paste → Enter gap (regression for "[Pasted text +N lines]
// renders but never submits" — the Enter that follows `paste-buffer -p`
// gets absorbed as part of the bracketed paste event if it arrives in the
// same input read). The fix splits the trailing Enter out of
// `pastePromptSync` and inserts a gap inside `queuePaste`'s bracketed
// branch, re-gating the Enter through `stillCurrent()` so a dispose during
// the gap can't leak the keystroke into a respawned pane. ───

test("queuePaste(bracketed): emits load-buffer → paste-buffer -p → delete-buffer → (gap) → send-keys Enter", async () => {
  // Order proves the bracketed split was wired correctly; the timing
  // floor on the send-keys Enter proves the gap was honored. Cold-start
  // of the sub-bun tmux process is additive on top of the gap, so the
  // delta-ms assertion is a lower bound — tolerance only guards against
  // a slow timer wake-up, never against the sleep being skipped.
  const GAP = 60;
  const TOLERANCE = 30;
  await withRecordingTmuxBin(async (logPath) => {
    const prevGap = __forTest.setBracketedEnterGapMs(GAP);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(
        taskId,
        "sess-x",
        "hello\nworld",
        0,
        undefined,
        { bracketed: true },
      );
      const entries = readTmuxLog(logPath);
      const cmds = entries.map((e) => e.argv[0]);
      expect(cmds).toEqual([
        "load-buffer",
        "paste-buffer",
        "delete-buffer",
        "send-keys",
      ]);
      // paste-buffer carries the `-p` (bracketed-paste) flag.
      const pasteBuffer = entries[1]!;
      const deleteBuffer = entries[2]!;
      const sendKeys = entries[3]!;
      expect(pasteBuffer.argv).toContain("-p");
      // The trailing send-keys is the Enter, not a stray modal keystroke.
      expect(sendKeys.argv[sendKeys.argv.length - 1]).toBe("Enter");
      // Gap floor: delete-buffer → send-keys Enter spans at least
      // `GAP - TOLERANCE` ms. The actual delta also includes one
      // sub-bun cold start, which only widens the gap.
      const deltaMs = sendKeys.ms - deleteBuffer.ms;
      expect(deltaMs).toBeGreaterThanOrEqual(GAP - TOLERANCE);
    } finally {
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("queuePaste(bracketed): trailing Enter is skipped when the session is disposed mid-gap", async () => {
  // Mid-body re-gate symmetry with the dismissTmuxPrompt test above:
  // `dropSession` lands during the post-paste sleep, the bracketed
  // branch's `stillCurrent()` check fires false, and the trailing
  // send-keys Enter never spawns. Without the re-gate, the new session
  // installed under the same taskId would inherit a stray Enter.
  const GAP = 120;
  await withRecordingTmuxBin(async (logPath) => {
    const prevGap = __forTest.setBracketedEnterGapMs(GAP);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      const paste = __forTest.queuePaste(
        taskId,
        state.sessionName,
        "msg",
        0,
        state,
        { bracketed: true },
      );
      // Land squarely inside the gap — late enough that the paste body's
      // three sync tmux calls have written, early enough that the Enter
      // is still pending.
      await Bun.sleep(GAP / 3);
      __forTest.uninstallSession(taskId);
      __forTest.installSession(taskId, jsonlPath);
      await paste;
      const cmds = readTmuxLog(logPath).map((e) => e.argv[0]);
      // Paste body landed; Enter was dropped by the re-gate. One or more
      // leading "capture-pane" calls are expected: `queuePaste`'s modal guard
      // (docs/plans/model-effort-local-command-turns.md §10) reads the pane
      // via `capturePastePane` (default `captureTail`, which shells out to
      // this same recording tmux stub) before every guarded paste — AND
      // again via its own unconditional pre-paste re-check right before
      // dispatch (§10 re-review finding #2). The stub prints nothing, so
      // every captured tail is `""` — `paneShowsBlockingPrompt("")` is false,
      // each guard stage falls through immediately, and the paste proceeds
      // exactly as before. The exact capture-pane COUNT is a race between
      // real subprocess spawn timing and this test's own mid-gap teardown
      // (each stillBlocking-style check is itself a real, variable-latency
      // tmux spawn) — not a stable invariant — so this asserts the shape
      // (all-captures-then-the-paste-body) rather than a fixed length.
      const firstNonCapture = cmds.findIndex((c) => c !== "capture-pane");
      expect(firstNonCapture).toBeGreaterThan(0);
      expect(cmds.slice(0, firstNonCapture).every((c) => c === "capture-pane")).toBe(true);
      expect(cmds.slice(firstNonCapture)).toEqual(["load-buffer", "paste-buffer", "delete-buffer"]);
      expect(cmds).not.toContain("send-keys");
    } finally {
      __forTest.uninstallSession(taskId);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("queuePaste(non-bracketed): keeps the original synchronous load-buffer → paste-buffer → delete-buffer → send-keys Enter shape (no gap)", async () => {
  // Slash-command path must NOT regress to the split-Enter form — the
  // gap is bracketed-only. This pins the non-bracketed argv ordering
  // AND confirms paste-buffer has no `-p` flag. A separate timing test
  // would be brittle here — sub-bun cold start × 4 invocations can
  // dominate wall-clock and mask any actual gap difference — so the
  // structural assertion stands on its own.
  await withRecordingTmuxBin(async (logPath) => {
    const prevGap = __forTest.setBracketedEnterGapMs(200);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(taskId, "sess-x", "/model X", 0);
      const entries = readTmuxLog(logPath);
      expect(entries.map((e) => e.argv[0])).toEqual([
        "load-buffer",
        "paste-buffer",
        "delete-buffer",
        "send-keys",
      ]);
      // No `-p`: this is a typed-input slash command, not a paste event.
      expect(entries[1]!.argv).not.toContain("-p");
      // The trailing send-keys is the Enter, just as in bracketed mode.
      const sendKeys = entries[3]!;
      expect(sendKeys.argv[sendKeys.argv.length - 1]).toBe("Enter");
    } finally {
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

// ─── image-attach gap (regression for "[Image #N] stuck in input,
// message never sent" — the bracketed-paste handler reads + base64-
// encodes images asynchronously, and the trailing Enter sent immediately
// after the paste was consumed by the attach flow instead of submitting
// the message). The image-aware long gap replaces the base
// `bracketedEnterGapMs` inside `queuePaste` and scales by image count up
// to `IMAGE_ATTACH_SETTLE_MAX_MS`. Enter count is unchanged — exactly
// one per paste, image or not — so a second Enter can't cause a stray
// empty submit or interrupt against an idle pane. ───

test("queuePaste(image): single-image paste replaces the base gap with the longer image-attach window", async () => {
  // The structural assertion (one Enter, gap floor) mirrors the bracketed
  // test above; the timing floor uses `imageAttachSettleMs * 1` instead
  // of `bracketedEnterGapMs`. We pin the base gap to 0 so any observed
  // delay must come from the image branch.
  const IMG = 100;
  const TOLERANCE = 30;
  await withRecordingTmuxBin(async (logPath) => {
    const prevImg = __forTest.setImageAttachSettleMs(IMG);
    const prevGap = __forTest.setBracketedEnterGapMs(0);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(
        taskId,
        "sess-img",
        "fix this\n\nReferenced files/folders:\n- /tmp/screenshot.png",
        0,
        undefined,
        { bracketed: true },
      );
      const entries = readTmuxLog(logPath);
      const cmds = entries.map((e) => e.argv[0]);
      expect(cmds).toEqual(["load-buffer", "paste-buffer", "delete-buffer", "send-keys"]);
      const deleteBuffer = entries[2]!;
      const sendKeys = entries[3]!;
      expect(sendKeys.argv[sendKeys.argv.length - 1]).toBe("Enter");
      const deltaMs = sendKeys.ms - deleteBuffer.ms;
      expect(deltaMs).toBeGreaterThanOrEqual(IMG - TOLERANCE);
    } finally {
      __forTest.setImageAttachSettleMs(prevImg);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("queuePaste(image): gap scales linearly with the number of image paths", async () => {
  // 3 images × per-image settle, capped at IMAGE_ATTACH_SETTLE_MAX_MS.
  // Lower bound `2.5 * IMG` is generous against scheduler slop while
  // still proving the multiplication wasn't dropped.
  const IMG = 100;
  await withRecordingTmuxBin(async (logPath) => {
    const prevImg = __forTest.setImageAttachSettleMs(IMG);
    const prevGap = __forTest.setBracketedEnterGapMs(0);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(
        taskId,
        "sess-multi",
        "compare these\n\nReferenced files/folders:\n- /tmp/a.png\n- /tmp/b.jpg\n- /tmp/c.webp",
        0,
        undefined,
        { bracketed: true },
      );
      const entries = readTmuxLog(logPath);
      const deleteBuffer = entries[2]!;
      const sendKeys = entries[3]!;
      const deltaMs = sendKeys.ms - deleteBuffer.ms;
      expect(deltaMs).toBeGreaterThanOrEqual(IMG * 2.5);
    } finally {
      __forTest.setImageAttachSettleMs(prevImg);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("queuePaste(image): non-image bracketed paste does NOT take the long gap (uses base bracketed gap instead)", async () => {
  // Bloat the image settle to a value the detector must NOT pick, and set
  // the base bracketed gap to a distinctive small value. Two independent
  // assertions then pin which path `queuePaste` chose: the recorded
  // `lastBracketedGapMs` (deterministic), plus the delete-buffer → Enter
  // delta from the tmux log (log-derived, NOT total wall clock — the old
  // `elapsed < 500` bound flaked at 500–880 ms under scheduler load because
  // it also absorbed several recording-tmux-stub spawns).
  const IMG = 20_000;
  await withRecordingTmuxBin(async (logPath) => {
    const prevImg = __forTest.setImageAttachSettleMs(IMG);
    const prevGap = __forTest.setBracketedEnterGapMs(20);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(
        taskId,
        "sess-txt",
        "no images here, just a follow-up\n\nReferenced files/folders:\n- /tmp/notes.md",
        0,
        undefined,
        { bracketed: true },
      );
      // The non-image paste must have taken the base bracketed gap (20),
      // not the IMG image settle — the recorded gap deterministically
      // pins which path `queuePaste` chose.
      expect(__forTest.getLastBracketedGapMs()).toBe(20);
      // Belt-and-braces on the *observed* timing: the delete-buffer → Enter
      // gap from the tmux log stays orders of magnitude under a misfired
      // image settle (>= IMG - tolerance). Locate the calls by predicate
      // rather than fixed index — pinning to entries[2]/entries[3] silently
      // breaks if an earlier step ever grows an extra tmux call.
      const entries = readTmuxLog(logPath);
      const deleteBufferIdx = entries.findIndex((e) => e.argv[0] === "delete-buffer");
      const deleteBuffer = entries[deleteBufferIdx]!;
      const sendKeys = entries
        .slice(deleteBufferIdx + 1)
        .find((e) => e.argv[0] === "send-keys" && e.argv[e.argv.length - 1] === "Enter")!;
      expect(deleteBuffer.argv[0]).toBe("delete-buffer");
      expect(sendKeys.argv[sendKeys.argv.length - 1]).toBe("Enter");
      expect(sendKeys.ms - deleteBuffer.ms).toBeLessThan(IMG / 2);
      // Trailing send-keys Enter still fires exactly once.
      const enterCalls = entries
        .filter((e) => e.argv[0] === "send-keys" && e.argv[e.argv.length - 1] === "Enter");
      expect(enterCalls.length).toBe(1);
    } finally {
      __forTest.setImageAttachSettleMs(prevImg);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

test("queuePaste(image): sends exactly ONE Enter (no stray empty submit / pane interrupt)", async () => {
  // Earlier iterations of the image fix sent two Enters on image paths;
  // the second was a guess at dismissing a suspected attach-confirm
  // modal that there's no evidence of in the bracketed-paste flow. The
  // JSONL repro already showed a single-Enter image submit succeeding
  // once claude was idle, so a second Enter would risk a stray empty
  // submit or pane interrupt. Lock in the contract.
  await withRecordingTmuxBin(async (logPath) => {
    const prevImg = __forTest.setImageAttachSettleMs(20);
    const prevGap = __forTest.setBracketedEnterGapMs(0);
    const prevSettle = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      await __forTest.queuePaste(
        taskId,
        "sess-once",
        "fix this\n\nReferenced files/folders:\n- /tmp/screenshot.png",
        0,
        undefined,
        { bracketed: true },
      );
      const enterCalls = readTmuxLog(logPath)
        .filter((e) => e.argv[0] === "send-keys" && e.argv[e.argv.length - 1] === "Enter");
      expect(enterCalls.length).toBe(1);
    } finally {
      __forTest.setImageAttachSettleMs(prevImg);
      __forTest.setBracketedEnterGapMs(prevGap);
      __forTest.setSlashCommandSettleMs(prevSettle);
    }
  });
});

// ─── lastKeystrokeAt: the "agetor last touched this pane" clock (wave 5) ───
//
// `bumpKeystroke` is the single write site (see its doc comment in
// claude-tmux.ts) — every path that delivers keystrokes or a paste to the
// pane calls it, immediately before the tmux dispatch. `bumpActivity` is a
// SEPARATE clock (`lastActivityAt`) bumped by claude's own JSONL activity
// (a turn resolving, a fresh line arriving) — it must never be conflated
// with `lastKeystrokeAt`, since the whole point of splitting them was that
// a status-bar hint flickering inside claude's own output kept
// `lastActivityAt` pinned "now" forever (see `VOLATILE_PANE_LINE_RE`'s doc)
// while agetor genuinely hadn't touched the pane in a while.

/** Stamp `state.lastKeystrokeAt` far in the past so a bump is unambiguous
 *  (never a same-millisecond false negative under a fast test run). */
function staleKeystrokeAt(): number {
  return Date.now() - 100_000;
}

test("sendTurn bumps state.lastKeystrokeAt via queuePaste's pre-dispatch write site", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    const stale = staleKeystrokeAt();
    state.lastKeystrokeAt = stale;
    try {
      const agent = sendTurn(taskId, "hello agent", () => {});
      await agent.pasteOutcome;
      expect(state.lastKeystrokeAt).toBeGreaterThan(stale);
    } finally {
      __forTest.uninstallSession(taskId);
    }
  });
});

test("pasteFollowUp bumps state.lastKeystrokeAt via queuePaste's pre-dispatch write site", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    const stale = staleKeystrokeAt();
    state.lastKeystrokeAt = stale;
    try {
      const result = pasteFollowUp(taskId, "a follow-up");
      expect(result).toMatchObject({ delivered: true });
      if (result === false) throw new Error("expected delivered");
      await result.pasteOutcome;
      expect(state.lastKeystrokeAt).toBeGreaterThan(stale);
    } finally {
      __forTest.uninstallSession(taskId);
    }
  });
});

test("dismissTmuxPrompt bumps state.lastKeystrokeAt (walkCursor / literal-key / confirm keystrokes)", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    const stale = staleKeystrokeAt();
    state.lastKeystrokeAt = stale;
    try {
      const ok = await dismissTmuxPrompt(taskId, "1", {
        choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
        cursorIndex: 0,
      });
      expect(ok).toBe(true);
      expect(state.lastKeystrokeAt).toBeGreaterThan(stale);
    } finally {
      __forTest.uninstallSession(taskId);
    }
  });
});

test("sendModalKeys bumps state.lastKeystrokeAt", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    const stale = staleKeystrokeAt();
    state.lastKeystrokeAt = stale;
    try {
      const ok = await sendModalKeys(taskId, ["Down", "Enter"]);
      expect(ok).toBe(true);
      expect(state.lastKeystrokeAt).toBeGreaterThan(stale);
    } finally {
      __forTest.uninstallSession(taskId);
    }
  });
});

test("bumpActivity alone (a turn resolving purely from claude's own JSONL content, no agetor keystroke) does NOT touch lastKeystrokeAt", () => {
  // Drives popEndOfTurn -> bumpActivity with no tmux call anywhere in the
  // path (flushSync's end_turn staging + force-fire is pure JSONL/queue
  // bookkeeping) — isolates bumpActivity's write site from bumpKeystroke's.
  const { taskId, jsonlPath } = freshSession();
  const state = __forTest.installSession(taskId, jsonlPath);
  const staleKeystroke = staleKeystrokeAt();
  state.lastKeystrokeAt = staleKeystroke;
  state.lastActivityAt = 0;
  try {
    __forTest.pushTurnSlot(state, () => {});
    appendFileSync(jsonlPath, endTurnLine("done"));
    __forTest.flushSync(state);

    // bumpActivity DID fire (popEndOfTurn's own life-signal bump)...
    expect(state.lastActivityAt).toBeGreaterThan(0);
    // ...but lastKeystrokeAt is untouched — no keystroke went out.
    expect(state.lastKeystrokeAt).toBe(staleKeystroke);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

// ─── pasteOutcome (wave 5): sendTurn / pasteFollowUp's awaitable paste-landed
// signal, and the PASTE_DROPPED_OUTCOME backstop for a session torn down
// before the queued paste ever runs. The pasteFollowUp success/failure cases
// are also pinned inline above (the "holds the run open" and
// "{onPasteFailure}"/"without {onPasteFailure}" tests) since those already
// set up the exact landed/withheld scenarios this contract cares about. ───

test("sendTurn(...).pasteOutcome resolves { ok: true } once the bracketed paste (paste-buffer + Enter) actually lands", async () => {
  await withFakeTmuxBin(async () => {
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    try {
      const agent = sendTurn(taskId, "hello agent", () => {});
      await expect(agent.pasteOutcome).resolves.toEqual({ ok: true });
    } finally {
      __forTest.uninstallSession(taskId);
    }
  });
});

test("sendTurn(...).pasteOutcome resolves the modal-guard failure (with phase) when a live modal withholds the opening paste, and the turn's done() rejects", async () => {
  await withRecordingTmuxBin(async (logPath) => {
    const prevGrace = __forTest.setPasteModalGraceMs(20);
    const prevPoll = __forTest.setPasteModalPollMs(5);
    const { taskId, jsonlPath } = freshSession();
    __forTest.installSession(taskId, jsonlPath);
    const prevCapture = __forTest.setCapturePastePane(() => BLOCKING_MODAL_PANE);
    try {
      const agent = sendTurn(taskId, "hello agent", () => {});
      const outcome = await agent.pasteOutcome!;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        assertModalGuard(outcome);
        expect(outcome.phase).toBe("pre-paste");
      }
      // The withheld paste never reached paste-buffer at all.
      expect(readTmuxLog(logPath).some((e) => e.argv[0] === "paste-buffer")).toBe(false);
      // sendTurn's own onPasteFailure wiring settles the turn slot too —
      // the run must not hang "running" forever on a withheld paste.
      await expect(agent.done).rejects.toThrow();
    } finally {
      __forTest.setCapturePastePane(prevCapture);
      __forTest.setPasteModalPollMs(prevPoll);
      __forTest.setPasteModalGraceMs(prevGrace);
      __forTest.uninstallSession(taskId);
    }
  });
});

test("sendTurn(...).pasteOutcome resolves a PASTE_DROPPED_OUTCOME-shaped failure (never hangs) when the session is torn down before the queued paste runs", async () => {
  const { taskId, jsonlPath } = freshSession();
  __forTest.installSession(taskId, jsonlPath);
  const agent = sendTurn(taskId, "hello agent", () => {});
  // The dropped paste also rejects the turn slot's `done` — expected (the
  // run must settle failed, not hang), but left unhandled here it would
  // otherwise surface as an unhandled-rejection failure unrelated to this
  // test's actual assertion (pasteOutcome, below).
  agent.done.catch(() => {});
  // Tear down the session SYNCHRONOUSLY, before the queued tmux op's
  // microtask gets a chance to run — queueTmuxOp's identity gate
  // (`sessions.get(taskId) === expectedState`) then drops the op body
  // entirely, so no tmux call (and no fake tmux bin) is needed here.
  __forTest.uninstallSession(taskId);

  const outcome = await Promise.race([
    agent.pasteOutcome!,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("pasteOutcome never settled")), 2000);
    }),
  ]);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.op).toBe("send-keys");
    expect(outcome.stderr).toContain("paste dropped");
  }
});
