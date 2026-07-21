import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-unknown-cmd-"));

const { __forTest, CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX } = await import("./claude-tmux.ts");
// Dynamic import (not a static top-level one) so it resolves AFTER the
// AGETOR_DATA_DIR assignment above — a static import would be hoisted and
// run before that assignment, capturing the wrong data dir (db.ts reads the
// env var at module load). Mirrors claude-tmux-death.test.ts exactly.

const { signalUnknownCommand, matchUnknownCommand, slashTokenOf, dispatchLine, turnInFlight } = __forTest;

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: (stream: string, data: string) => out.push({ stream, data }),
  };
}

function freshSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-unknown-cmd-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, jsonlPath, state };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * slashTokenOf
 * ────────────────────────────────────────────────────────────────────────── */

test("slashTokenOf: extracts the leading slash token, ignoring the rest of the line", () => {
  expect(slashTokenOf("/skill-creator do X")).toBe("/skill-creator");
});

test("slashTokenOf: only the FIRST line is considered", () => {
  // First line is a real slash command — the rest of the prompt is ignored.
  expect(slashTokenOf("/skill-creator arg1 arg2\nsecond line ignored\nthird line")).toBe(
    "/skill-creator",
  );
  // First line is plain text — a slash on a LATER line must not arm anything,
  // since claude's TUI only ever interprets the first line as a command.
  expect(slashTokenOf("hello there\n/not-a-command")).toBeNull();
});

test("slashTokenOf: plain text (no leading slash) returns null", () => {
  expect(slashTokenOf("hello world")).toBeNull();
  expect(slashTokenOf("please run /compact for me")).toBeNull();
});

test("slashTokenOf: leading whitespace before the slash means the line does not 'start with /'", () => {
  // firstLine.startsWith("/") is a strict check — a space-indented slash is
  // not treated as a command token by this function (whatever claude's TUI
  // itself does with leading whitespace is a separate concern).
  expect(slashTokenOf(" /skill-creator do X")).toBeNull();
  expect(slashTokenOf("\t/skill-creator")).toBeNull();
});

test("slashTokenOf: a bare '/' is its own token", () => {
  expect(slashTokenOf("/")).toBe("/");
});

test("slashTokenOf: empty string returns null", () => {
  expect(slashTokenOf("")).toBeNull();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * matchUnknownCommand — positives
 * ────────────────────────────────────────────────────────────────────────── */

test("matchUnknownCommand: matches claude's bulleted status line", () => {
  const tail = ["some earlier output", "● Unknown command: /skill-creator", "more output"];
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(true);
});

test("matchUnknownCommand: matches without the '●' bullet prefix", () => {
  const tail = ["Unknown command: /skill-creator"];
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(true);
});

test("matchUnknownCommand: still matches when an 'Args from unknown skill:' line follows", () => {
  const tail = [
    "● Unknown command: /skill-creator",
    "  Args from unknown skill: do the thing",
  ];
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(true);
});

test("matchUnknownCommand: matches when the error line is among (not necessarily last of) the last 12 non-blank lines", () => {
  const before = Array.from({ length: 15 }, (_, i) => `filler before ${i}`);
  const after = ["trailing note 1", "trailing note 2", "trailing note 3"];
  const tail = [...before, "● Unknown command: /skill-creator", ...after];
  // 15 + 1 + 3 = 19 non-blank lines; the error sits at index 15, well inside
  // the last 12 (indices 7..18), but is not itself the final line.
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(true);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * matchUnknownCommand — negatives
 * ────────────────────────────────────────────────────────────────────────── */

test("matchUnknownCommand: word-boundary — a shorter armed token does not match a longer one in the pane", () => {
  const tail = ["● Unknown command: /skill-creator"];
  // Armed "/skill" must NOT match "/skill-creator" (it's a prefix, not the
  // whole token — "-creator" isn't whitespace/end-of-line).
  expect(matchUnknownCommand(tail, "/skill")).toBe(false);
});

test("matchUnknownCommand: word-boundary — a longer armed token does not match a shorter one in the pane", () => {
  const tail = ["● Unknown command: /skill"];
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(false);
});

test("matchUnknownCommand: a match ONLY above the last-12-non-blank window is not seen", () => {
  const after = Array.from({ length: 12 }, (_, i) => `filler after ${i}`);
  const tail = ["● Unknown command: /skill-creator", ...after];
  // 1 + 12 = 13 non-blank lines; slice(-12) drops the error line entirely.
  expect(matchUnknownCommand(tail, "/skill-creator")).toBe(false);
});

test("matchUnknownCommand: regex metacharacters in the token don't crash and aren't treated as wildcards", () => {
  const token = "/skill+creator.v2";
  const literalMatch = ["● Unknown command: /skill+creator.v2"];
  expect(() => matchUnknownCommand(literalMatch, token)).not.toThrow();
  expect(matchUnknownCommand(literalMatch, token)).toBe(true);

  // If '+' / '.' were interpreted as regex metacharacters instead of literal
  // characters, this substituted pane line would spuriously match too. It
  // must not.
  const wouldFalselyMatchIfUnescaped = ["● Unknown command: /skillXcreatorXv2"];
  expect(matchUnknownCommand(wouldFalselyMatchIfUnescaped, token)).toBe(false);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * signalUnknownCommand
 * ────────────────────────────────────────────────────────────────────────── */

test("signalUnknownCommand: settles an in-flight slot, emits the sentinel, and clears armed state", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    const done = __forTest.pushTurnSlot(state, rec.onChunk);
    state.pendingSlashToken = "/skill-creator";
    state.pendingEndTurn = { messageId: null, uuid: undefined, emitBanner: true, stagedAt: Date.now() };
    state.holdUntilIdle = true;
    expect(turnInFlight(state)).toBe(true);

    signalUnknownCommand(state);

    const code = await done;
    expect(code).toBe(0);

    const sentinel = rec.out.find(
      (c) => c.stream === "status" && c.data.startsWith(CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX),
    );
    expect(sentinel).toBeDefined();
    expect(sentinel!.data).toContain("/skill-creator");

    expect(state.pendingSlashToken).toBeNull();
    expect(state.pendingEndTurn).toBeNull();
    expect(state.holdUntilIdle).toBe(false);
    expect(turnInFlight(state)).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("signalUnknownCommand: does NOT clear scrape/death timers (session stays alive, unlike signalSessionDeath)", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  // Sentinel live timers standing in for the real scrape/death watchers —
  // signalUnknownCommand must leave them untouched so the session keeps
  // being polled/scraped for the NEXT turn.
  const scrapeTimer = setInterval(() => {}, 1_000_000);
  const deathTimer = setInterval(() => {}, 1_000_000);
  state.scrapeTimer = scrapeTimer;
  state.deathTimer = deathTimer;
  try {
    __forTest.pushTurnSlot(state, rec.onChunk);
    state.pendingSlashToken = "/skill-creator";

    signalUnknownCommand(state);

    expect(state.scrapeTimer).toBe(scrapeTimer);
    expect(state.deathTimer).toBe(deathTimer);
  } finally {
    clearInterval(scrapeTimer);
    clearInterval(deathTimer);
    __forTest.uninstallSession(taskId);
  }
});

test("signalUnknownCommand: second call is a no-op (one-shot)", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    const done = __forTest.pushTurnSlot(state, rec.onChunk);
    state.pendingSlashToken = "/skill-creator";

    signalUnknownCommand(state);
    await done;
    const firstEmitCount = rec.out.length;
    expect(firstEmitCount).toBeGreaterThan(0);

    // pendingSlashToken is already null and the slot already consumed — a
    // stray second call (e.g. a late scrapeOnce tick) must not emit again or
    // throw.
    expect(() => signalUnknownCommand(state)).not.toThrow();
    expect(rec.out.length).toBe(firstEmitCount);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("signalUnknownCommand: no-op when there's no in-flight turn and no armed token", () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  state.lastChunk = rec.onChunk;
  try {
    expect(turnInFlight(state)).toBe(false);
    expect(state.pendingSlashToken).toBeNull();

    signalUnknownCommand(state);

    expect(rec.out.length).toBe(0);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("signalUnknownCommand: reattach path fires the onEndOfTurn hook when there's no in-process slot", () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    // Reattached in-flight run: no in-process slot, but an onEndOfTurn hook
    // the orchestrator installed so it can flip the run row on completion.
    // The sentinel routes through state.lastChunk (the last known handler)
    // since there's no live slot.onChunk on this path.
    let fired = false;
    state.onEndOfTurn = () => { fired = true; };
    state.lastChunk = rec.onChunk;
    state.pendingSlashToken = "/skill-creator";
    expect(turnInFlight(state)).toBe(true);

    signalUnknownCommand(state);

    expect(fired).toBe(true);
    // Fire-once: the hook is cleared so a stray later tick can't double-fire.
    expect(state.onEndOfTurn).toBeNull();
    expect(state.pendingSlashToken).toBeNull();
    expect(turnInFlight(state)).toBe(false);

    const sentinel = rec.out.find(
      (c) => c.stream === "status" && c.data.startsWith(CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX),
    );
    expect(sentinel).toBeDefined();
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Arming / disarm through dispatchLine
 * ────────────────────────────────────────────────────────────────────────── */

test("dispatchLine disarms pendingSlashToken — any real JSONL line proves the message was delivered", () => {
  const { taskId, state } = freshSession();
  try {
    state.pendingSlashToken = "/skill-creator";
    expect(state.pendingSlashToken).toBe("/skill-creator");

    const uuid = randomUUID();
    dispatchLine(state, JSON.stringify({
      type: "system", uuid, permissionMode: "default",
    }));

    expect(state.pendingSlashToken).toBeNull();
  } finally {
    __forTest.uninstallSession(taskId);
  }
});
