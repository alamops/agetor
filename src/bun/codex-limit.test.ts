import { describe, expect, test } from "bun:test";
import { mapCodexEvent, type CodexMapSeq } from "./codex-tmux.ts";
import { HARNESS_LIMIT_STATUS_PREFIX } from "../shared/types.ts";

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

/** Map a sequence of events through one shared per-run seq box, as the
 *  tailer does for a whole log. */
function run(events: Record<string, unknown>[]): { chunks: Chunk[]; done: number | undefined } {
  const chunks: Chunk[] = [];
  const seq: CodexMapSeq = { n: 0 };
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
    const reset = found[0]!.resetAtMs as number | null;
    const expected = new Date(2026, 10, 10, 15, 0, 0, 0).getTime();
    // A date already in the past is a stale notice and reads as null; on any
    // day before Nov 10 2026 3pm it is that exact instant.
    expect(reset === null ? Date.now() >= expected : reset === expected).toBe(true);
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
