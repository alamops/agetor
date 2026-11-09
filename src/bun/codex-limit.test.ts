import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexMapSeq } from "./codex-tmux.ts";

// codex-tmux.ts imports db.ts, which opens its database on first import: the
// data dir must be a temp dir before that import (CLAUDE.md, Tests).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-codex-limit-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;

const { mapCodexEvent, pinCodexHome, spawnCodexViaTmux, __settleCodexLogAfterExitForTest } = await import("./codex-tmux.ts");
const { HARNESS_LIMIT_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX } = await import("../shared/types.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

// Refuses (and keeps the dir) when this file's dir is the one db.ts opened.
afterAll(() => rmTestDataDir(DATA_DIR));

/**
 * Codex limit detection (docs/architecture/harness-stacks.md, contract C1).
 * Event lines are shaped exactly like codex-cli 0.166 `exec --json` output: a
 * top-level `{"type":"error","message":…}` followed by the terminal
 * `{"type":"turn.failed","error":{"message":…}}`, and the prose verified with
 * `strings` on the 0.166.0 binary.
 */

const PLUS_LIMIT =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:00 PM.";
const CREDITS_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 10th, 2026 3:00 PM.";
const QUOTA_EXCEEDED = "Quota exceeded. Check your plan and billing details.";

type Chunk = { stream: string; data: string; lineUuid?: string };

/** A fixed "now" (Nov 1 2026, 9am local) so every reset parse is exact on
 *  any day the suite runs. */
const NOW = new Date(2026, 10, 1, 9, 0, 0, 0).getTime();

/** Map a sequence of events through one shared per-run seq box, as the
 *  tailer does for a whole log. */
function run(events: Record<string, unknown>[]): { chunks: Chunk[]; done: number | undefined } {
  const chunks: Chunk[] = [];
  const seq: CodexMapSeq = { n: 0, now: () => NOW };
  let done: number | undefined;
  for (const evt of events) {
    const result = mapCodexEvent(evt as never, (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }), seq);
    if (typeof result.done === "number") done = result.done;
  }
  return { chunks, done };
}

function signals(chunks: Chunk[]): Record<string, unknown>[] {
  return chunks
    .filter((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))
    .map((c) => JSON.parse(c.data.slice(HARNESS_LIMIT_STATUS_PREFIX.length)) as Record<string, unknown>);
}

describe("codex limit detection", () => {
  test("the real usage-limit prose: error → turn.failed emits exactly one quota signal, before the stderr line", () => {
    const { chunks, done } = run([
      { type: "thread.started", thread_id: "0199-thread" },
      { type: "turn.started" },
      { type: "error", message: PLUS_LIMIT },
      { type: "turn.failed", error: { message: PLUS_LIMIT } },
    ]);
    const found = signals(chunks);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("quota");
    expect(found[0]!.source).toBe("codex-error");
    // "try again at 3:00 PM" is parsed as the reset instant.
    const resetAt = found[0]!.resetAtMs as number;
    expect(typeof resetAt).toBe("number");
    expect(new Date(resetAt).getHours()).toBe(15);
    expect(new Date(resetAt).getMinutes()).toBe(0);
    const signalIndex = chunks.findIndex((c) => c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX));
    const failedIndex = chunks.findIndex((c) => c.stream === "stderr" && c.lineUuid?.startsWith("turn.failed:"));
    expect(signalIndex).toBeGreaterThanOrEqual(0);
    expect(signalIndex).toBeLessThan(failedIndex);
    expect(chunks[signalIndex]!.lineUuid).toBe(`${chunks[failedIndex]!.lineUuid}:limit`);
    expect(done).toBe(1);
  });

  test("the fake driver's real-text variant classifies as quota with a reset", () => {
    const { chunks } = run([{ type: "turn.failed", error: { message: PLUS_LIMIT } }]);
    const found = signals(chunks);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("quota");
    expect(found[0]!.resetAtMs).not.toBeNull();
  });

  test("a dated 'try again at' reset keeps its date", () => {
    const { chunks } = run([{ type: "turn.failed", error: { message: CREDITS_LIMIT } }]);
    const found = signals(chunks);
    expect(found[0]!.reason).toBe("quota");
    // `now` is pinned before Nov 10 2026, so the dated reset is that exact
    // instant on any day the suite runs.
    expect(found[0]!.resetAtMs).toBe(new Date(2026, 10, 10, 15, 0, 0, 0).getTime());
  });

  test("'Quota exceeded' (API-key quota) classifies as insufficient credits", () => {
    const { chunks } = run([
      { type: "error", message: QUOTA_EXCEEDED },
      { type: "turn.failed", error: { message: QUOTA_EXCEEDED } },
    ]);
    const found = signals(chunks);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("insufficient_credits");
  });

  test("a top-level error that the turn survives emits NO signal (M1)", () => {
    // codex logs a retried 429 as a top-level error, then the turn completes.
    const { chunks, done } = run([
      { type: "turn.started" },
      { type: "error", message: "stream error: 429 Too Many Requests; retrying 1/5 in 2s" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(signals(chunks)).toHaveLength(0);
    // The message is still shown.
    expect(chunks.some((c) => c.stream === "stderr" && c.data.includes("429"))).toBe(true);
    expect(done).toBe(0);
  });

  test("a top-level error alone never emits a signal, even with quota prose", () => {
    const { chunks, done } = run([{ type: "error", message: PLUS_LIMIT }]);
    expect(signals(chunks)).toHaveLength(0);
    expect(done).toBeUndefined();
  });

  test("an item-level error (tool failure) never emits a signal", () => {
    const { chunks } = run([
      { type: "item.completed", item: { id: "item_3", type: "error", message: "github: 429 Too Many Requests" } },
      { type: "turn.failed", error: { message: "turn aborted" } },
    ]);
    expect(signals(chunks)).toHaveLength(0);
  });

  test("turn.failed falls back to the remembered top-level error's classification", () => {
    const { chunks } = run([
      { type: "error", message: PLUS_LIMIT },
      { type: "turn.failed", error: { message: "codex turn failed" } },
    ]);
    const found = signals(chunks);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("quota");
  });

  test("a remembered limit is not attached to a turn that failed for an outage", () => {
    const { chunks } = run([
      { type: "error", message: "429 Too Many Requests" },
      { type: "turn.failed", error: { message: "503 Service Unavailable: server_overloaded" } },
    ]);
    expect(signals(chunks)).toHaveLength(0);
  });

  test("turn.completed discards the remembered signal", () => {
    // Two turns through one box (defensive: exec runs one turn per process).
    const { chunks } = run([
      { type: "error", message: PLUS_LIMIT },
      { type: "turn.completed" },
      { type: "turn.failed", error: { message: "codex turn failed" } },
    ]);
    expect(signals(chunks)).toHaveLength(0);
  });

  test("a remembered limit is forgotten once codex carries on with item events (R-S9)", () => {
    // A retried 429, then work, then a turn that fails for an unrelated cause
    // that names no negative: the 429 must not be attached to it.
    for (const itemType of ["item.started", "item.completed", "item.updated"]) {
      const { chunks, done } = run([
        { type: "turn.started" },
        { type: "error", message: "429 Too Many Requests" },
        { type: itemType, item: { id: "item_1", type: "agent_message", text: "Continuing." } },
        { type: "turn.failed", error: { message: "context window exceeded for this conversation" } },
      ]);
      expect(signals(chunks), itemType).toHaveLength(0);
      expect(done).toBe(1);
    }
    // Directly followed by the terminal failure, it is still inherited.
    const direct = run([
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Working." } },
      { type: "error", message: "429 Too Many Requests" },
      { type: "turn.failed", error: { message: "codex turn failed" } },
    ]);
    expect(signals(direct.chunks).map((s) => s.reason)).toEqual(["rate_limit"]);
  });

  test("a structured codex_error_info decides the reason when present", () => {
    const quota = run([
      { type: "turn.failed", error: { message: "turn failed", codex_error_info: "usage_limit_exceeded" } },
    ]);
    expect(signals(quota.chunks)[0]?.reason).toBe("quota");
    const camel = run([{ type: "turn.failed", error: { message: "turn failed", codexErrorInfo: "usageLimitExceeded" } }]);
    expect(signals(camel.chunks)[0]?.reason).toBe("quota");
    // A definitive non-limit code wins over limit-shaped prose.
    const overloaded = run([
      { type: "turn.failed", error: { message: PLUS_LIMIT, codex_error_info: "server_overloaded" } },
    ]);
    expect(signals(overloaded.chunks)).toHaveLength(0);
  });

  test("snake_case codes as text still classify", () => {
    expect(signals(run([{ type: "turn.failed", error: { message: "usage_limit_exceeded" } }]).chunks)[0]?.reason).toBe("quota");
    expect(signals(run([{ type: "turn.failed", error: { message: "rate_limit_exceeded" } }]).chunks)[0]?.reason).toBe("rate_limit");
    expect(signals(run([{ type: "turn.failed", error: { message: "insufficient_quota" } }]).chunks)[0]?.reason).toBe("insufficient_credits");
  });

  test("server_overloaded / model_not_found / 5xx / auth never emit a signal", () => {
    for (const message of ["server_overloaded", "model_not_found", "HTTP 529 overloaded", "401 unauthorized", "ECONNRESET"]) {
      const { chunks } = run([{ type: "error", message }, { type: "turn.failed", error: { message } }]);
      expect(signals(chunks), message).toHaveLength(0);
    }
  });
});

/** Write a codex `--json` log the way `codex exec --json … > log` would. */
function writeLog(events: Record<string, unknown>[]): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "agetor-codex-exit-")), "run.jsonl");
  writeFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return file;
}

describe("codex exit without a terminal event (CR3)", () => {
  test("an `error`-then-exit build emits the remembered limit before done resolves", async () => {
    const chunks: Chunk[] = [];
    const file = writeLog([
      { type: "thread.started", thread_id: "0199-thread" },
      { type: "turn.started" },
      { type: "error", message: PLUS_LIMIT },
    ]);
    const code = await __settleCodexLogAfterExitForTest(
      file,
      (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }),
      { n: 0, now: () => NOW },
    );
    expect(code).toBe(1);
    const found = signals(chunks);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("quota");
    expect(found[0]!.resetAtMs).toBe(new Date(2026, 10, 1, 15, 0, 0, 0).getTime());
    // The cause is known: no "ended unexpectedly" sentinel.
    expect(chunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(false);
  });

  test("a crash with no remembered limit keeps the session-died sentinel and no signal", async () => {
    const chunks: Chunk[] = [];
    const file = writeLog([
      { type: "turn.started" },
      { type: "error", message: "429 Too Many Requests" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Retrying worked." } },
    ]);
    const code = await __settleCodexLogAfterExitForTest(file, (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }));
    expect(code).toBe(1);
    expect(signals(chunks)).toHaveLength(0);
    expect(chunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(true);
  });

  test("a terminal event in the final flush settles normally (no duplicate signal)", async () => {
    const chunks: Chunk[] = [];
    const file = writeLog([
      { type: "error", message: PLUS_LIMIT },
      { type: "turn.failed", error: { message: PLUS_LIMIT } },
    ]);
    const code = await __settleCodexLogAfterExitForTest(file, (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }));
    expect(code).toBe(1);
    expect(signals(chunks)).toHaveLength(1);
    expect(chunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(false);
  });
});

describe("pinCodexHome", () => {
  test("a harness pin wins; otherwise this process's CODEX_HOME is passed, else unset", () => {
    expect(pinCodexHome({ CODEX_HOME: "/pin", HOME: "/eh" }, { CODEX_HOME: "/proc" }))
      .toEqual({ env: { CODEX_HOME: "/pin", HOME: "/eh" }, unset: false });
    expect(pinCodexHome({ HOME: "/eh" }, { CODEX_HOME: "/proc" }))
      .toEqual({ env: { HOME: "/eh", CODEX_HOME: "/proc" }, unset: false });
    // No value anywhere: unset, so a tmux server's stale CODEX_HOME can't
    // send codex to another account's root; codex falls back to <HOME>/.codex.
    expect(pinCodexHome({ HOME: "/eh" }, {})).toEqual({ env: { HOME: "/eh" }, unset: true });
    expect(pinCodexHome({ CODEX_HOME: " " }, { CODEX_HOME: "" })).toEqual({ env: {}, unset: true });
  });
});

test("spawnCodexViaTmux hands an unpinned turn this process's CODEX_HOME, or unsets it", async () => {
  // A fake tmux that logs its argv and fails new-session, so the spawn bails
  // out synchronously (same trick as codex-tmux.test.ts).
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-codex-home-tmux-"));
  const bin = path.join(dir, "tmux");
  const log = path.join(dir, "argv.jsonl");
  writeFileSync(
    bin,
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\n`
      + `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(1);\n`,
  );
  chmodSync(bin, 0o755);
  const prevBin = process.env.AGETOR_TMUX_BIN;
  const prevHome = process.env.CODEX_HOME;
  process.env.AGETOR_TMUX_BIN = bin;
  const spawnOnce = async (env: Record<string, string>): Promise<string[]> => {
    writeFileSync(log, "");
    await spawnCodexViaTmux({
      taskId: `codex-home-${Math.random()}`,
      runId: `codex-home-run-${Math.random()}`,
      argv: ["codex", "exec", "-"],
      env,
      cwd: "/tmp",
      promptText: "hi",
      onChunk: () => {},
    });
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return lines.find((a) => a.includes("new-session"))!;
  };
  try {
    process.env.CODEX_HOME = "/proc-codex-home";
    let argv = await spawnOnce({ HOME: "/eh" });
    expect(argv).toContain("CODEX_HOME=/proc-codex-home");
    expect(argv[argv.length - 1]!.startsWith("unset CODEX_HOME;")).toBe(false);

    argv = await spawnOnce({ CODEX_HOME: "/pin" });
    expect(argv).toContain("CODEX_HOME=/pin");
    expect(argv).not.toContain("CODEX_HOME=/proc-codex-home");

    delete process.env.CODEX_HOME;
    argv = await spawnOnce({ HOME: "/eh" });
    expect(argv.some((a) => a.startsWith("CODEX_HOME="))).toBe(false);
    expect(argv[argv.length - 1]!.startsWith("unset CODEX_HOME; exec ")).toBe(true);
  } finally {
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});
