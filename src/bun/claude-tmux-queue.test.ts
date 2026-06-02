import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-queue-"));

const { __forTest, dismissTmuxPrompt } = await import("./claude-tmux.ts");

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
    const SETTLE = 120;
    const prev = __forTest.setSlashCommandSettleMs(SETTLE);
    try {
      const taskA = randomUUID();
      const taskB = randomUUID();

      // Task A's slash command holds a 120ms settle window.
      const slashA = __forTest.queuePaste(taskA, "sess-a", "/model X", SETTLE);
      const t0 = performance.now();
      // Task B's paste should be able to run immediately — independent
      // chain. If we accidentally globalized the lock, this would wait
      // ~SETTLE ms.
      await __forTest.queuePaste(taskB, "sess-b", "user msg", 0);
      const elapsed = performance.now() - t0;

      // Generous upper bound — proves task-B is NOT serialized behind
      // task-A's settle. On a healthy run elapsed is ~0–5ms.
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

// ─── pasteContainsImagePath / countImagePaths detection rules ──────────
// The slow path (post-paste settle, scaled by image count) inside
// `pastePrompt` only fires when these helpers signal an image. Get the
// rule wrong in either direction and either every paste pays 600 ms of
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
  // prose mentioning the extension doesn't trip the slow path. Likewise
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

// ─── pastePrompt slow path: image-bearing paste delays before Enter ────
// Regression for "Image #1 stuck in input, message never sent" — the
// trailing Enter we used to send immediately after the bracketed paste
// landed mid-flight in claude's image-attach flow and was consumed
// instead of submitting the message. The fix is a settle delay scaled by
// the number of image paths; the Enter count is unchanged (one per
// paste, image or not) so we can't accidentally cause a stray empty
// submit or interrupt an idle pane.

/**
 * Drop-in tmux binary that records every argv it was called with to a
 * file. Lets tests assert the exact sequence of `send-keys`, `paste-
 * buffer`, etc. — the `/usr/bin/true` shim used elsewhere only signals
 * exit-code success, which is enough for ordering tests but not for
 * "did we send Enter once or twice?" assertions.
 *
 * `$@` in /bin/sh is whitespace-joined verbatim. We can't faithfully
 * recover an argv with embedded whitespace from that, but tmux argv here
 * is always single-token flags + session names — no whitespace inside any
 * single arg — so a per-line `echo "$@"` is unambiguous.
 */
function withRecordingTmuxBin<T>(fn: (readCalls: () => string[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-rec-"));
  const binPath = path.join(dir, "tmux-recorder.sh");
  const logPath = path.join(dir, "calls.log");
  writeFileSync(binPath, `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  // Recorder must be executable for spawnSync to invoke it. 0o755 is the
  // standard "owner all, others read+exec" mode for a script.
  chmodSync(binPath, 0o755);
  // Pre-create the log so a 0-call test can readFileSync without ENOENT.
  writeFileSync(logPath, "");
  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = binPath;
  const readCalls = () => readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
  return fn(readCalls).finally(() => {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  });
}

test("queuePaste: image-bearing bracketed paste waits for the attach-settle window", async () => {
  await withFakeTmuxBin(async () => {
    const SETTLE = 80; // shrunk for the test; production default is 600 ms / image
    const prevSettle = __forTest.setImageAttachSettleMs(SETTLE);
    const prevSlash = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      const promptWithImage =
        "fix this\n\nReferenced files/folders:\n- /tmp/screenshot.png";
      const t0 = performance.now();
      await __forTest.queuePaste(
        taskId,
        "sess-img",
        promptWithImage,
        0,
        undefined,
        { bracketed: true },
      );
      const elapsed = performance.now() - t0;
      // 1 image × SETTLE per image. Tolerance covers scheduler jitter on
      // a loaded CI box.
      expect(elapsed).toBeGreaterThanOrEqual(SETTLE - 20);
    } finally {
      __forTest.setImageAttachSettleMs(prevSettle);
      __forTest.setSlashCommandSettleMs(prevSlash);
    }
  });
});

test("queuePaste: settle scales with the number of image paths", async () => {
  await withFakeTmuxBin(async () => {
    const SETTLE = 80; // per image
    const prevSettle = __forTest.setImageAttachSettleMs(SETTLE);
    const prevSlash = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      const promptWithThreeImages =
        "compare these\n\nReferenced files/folders:\n- /tmp/a.png\n- /tmp/b.jpg\n- /tmp/c.webp";
      const t0 = performance.now();
      await __forTest.queuePaste(
        taskId,
        "sess-multi",
        promptWithThreeImages,
        0,
        undefined,
        { bracketed: true },
      );
      const elapsed = performance.now() - t0;
      // 3 images × SETTLE. Generous lower bound (≥ 2.5 × SETTLE) accounts
      // for sub-ms scheduler slop without making the test trivial.
      expect(elapsed).toBeGreaterThanOrEqual(SETTLE * 2.5);
    } finally {
      __forTest.setImageAttachSettleMs(prevSettle);
      __forTest.setSlashCommandSettleMs(prevSlash);
    }
  });
});

test("queuePaste: text-only bracketed paste skips the slow path (resolves promptly)", async () => {
  await withFakeTmuxBin(async () => {
    // Slow path is set to a *very* long delay so a failure to detect
    // "no image" would blow this test's wall clock budget visibly.
    const prevSettle = __forTest.setImageAttachSettleMs(5_000);
    const prevSlash = __forTest.setSlashCommandSettleMs(0);
    try {
      const taskId = randomUUID();
      const t0 = performance.now();
      await __forTest.queuePaste(
        taskId,
        "sess-txt",
        "no images here, just a follow-up\n\nReferenced files/folders:\n- /tmp/notes.md",
        0,
        undefined,
        { bracketed: true },
      );
      const elapsed = performance.now() - t0;
      // No image extension in the paste → fast path. Should finish well
      // under the (intentionally bloated) image-settle window. 500 ms is
      // generous against CI scheduler noise while still being orders of
      // magnitude below the 5_000 ms slow-path bound.
      expect(elapsed).toBeLessThan(500);
    } finally {
      __forTest.setImageAttachSettleMs(prevSettle);
      __forTest.setSlashCommandSettleMs(prevSlash);
    }
  });
});

test("queuePaste: image-bearing paste sends exactly ONE Enter (no stray empty submit)", async () => {
  // Earlier iterations of this fix sent two Enters on image paths; the
  // second was a guess at dismissing an attach-confirm modal that may
  // not exist in the bracketed-paste flow. The JSONL repro already
  // showed a single-Enter image submit succeeding once claude was idle,
  // so a second Enter would risk a stray empty submit or pane interrupt.
  // Lock in the contract: exactly one `send-keys Enter` per image paste.
  await withRecordingTmuxBin(async (readCalls) => {
    const prevSettle = __forTest.setImageAttachSettleMs(20);
    const prevSlash = __forTest.setSlashCommandSettleMs(0);
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
      const enterCalls = readCalls().filter((line) =>
        line.includes("send-keys") && line.endsWith(" Enter"));
      expect(enterCalls.length).toBe(1);
    } finally {
      __forTest.setImageAttachSettleMs(prevSettle);
      __forTest.setSlashCommandSettleMs(prevSlash);
    }
  });
});

test("queuePaste: image-bearing paste skips the trailing Enter when session disposes during settle", async () => {
  // Closes the same dispose-during-gap race the modal-dismissal path
  // protects against (see "dismissTmuxPrompt mid-body re-gate" above).
  // The image slow path awaits between paste-buffer and Enter; if the
  // session is uninstalled during the sleep, the trailing Enter must
  // NOT fire — otherwise it leaks into whatever pane reuses the tmux
  // session name on a respawn.
  await withRecordingTmuxBin(async (readCalls) => {
    const SETTLE = 120;
    const prevSettle = __forTest.setImageAttachSettleMs(SETTLE);
    const prevSlash = __forTest.setSlashCommandSettleMs(0);
    const { taskId, jsonlPath } = freshSession();
    const state = __forTest.installSession(taskId, jsonlPath);
    try {
      const pasted = __forTest.queuePaste(
        taskId,
        state.sessionName,
        "fix this\n\nReferenced files/folders:\n- /tmp/screenshot.png",
        0,
        state, // expectedState — gates the re-check on this identity
        { bracketed: true },
      );
      // Dispose mid-sleep so `stillCurrent()` flips to false before the
      // trailing Enter would fire.
      await new Promise((r) => setTimeout(r, SETTLE / 2));
      __forTest.uninstallSession(taskId);
      await pasted;
      const enterCalls = readCalls().filter((line) =>
        line.includes("send-keys") && line.endsWith(" Enter"));
      // load-buffer + paste-buffer + delete-buffer fire pre-await, so
      // some tmux calls are recorded — but the Enter must be skipped.
      expect(enterCalls.length).toBe(0);
    } finally {
      // Session already uninstalled above. Restore tunables.
      __forTest.setImageAttachSettleMs(prevSettle);
      __forTest.setSlashCommandSettleMs(prevSlash);
    }
  });
});
